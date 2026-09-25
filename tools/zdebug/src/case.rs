//! Case facade: the append-only Case as a working object.
//!
//! [`CaseRepository`] composes the lower layers into the mutation API the
//! CLI drives. It owns the [`EventStore`], folds the log through the
//! [`model`], captures Git snapshots for baselines and finals, checks
//! Artifact drift, and keeps `summary.md` projected after state changes.
//!
//! Every write goes through one path: the event is validated against the
//! current state with [`model::apply_event`] *before* it is persisted, so
//! an event the model rejects never leaves a line in `case.jsonl`. Reads
//! ([`CaseRepository::load`], [`CaseRepository::status`], and
//! [`CaseRepository::verify`]) take no lock, matching the reference
//! implementation, while each mutation takes the Case's non-blocking
//! lock.
//!
//! The facade mirrors the reference Python `case.py`; the `status`,
//! `repair-view`, and `update-verify` methods are increments exposing
//! operations the CLI previously composed from primitives.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::artifacts::verify_artifact;
use crate::events::{CaseLock, EventStore};
use crate::git::capture_snapshot;
use crate::model::{self, State};
use crate::projector;
use crate::util::{ZdebugError, resolve_path, utc_now};

/// Event types a closed Case still accepts.
const CLOSED_EXEMPT: [&str; 2] = ["case-reopened", "case-recovered"];

// ── Repository ───────────────────────────────────────────────────────────────

/// A Case directory together with the operations the CLI performs on it.
pub struct CaseRepository {
    case_dir: PathBuf,
    store: EventStore,
}

impl CaseRepository {
    /// Open the Case rooted at `case_dir`.
    ///
    /// The directory is resolved to an absolute path but is not created
    /// until a mutation takes the Case lock.
    #[must_use]
    pub fn new(case_dir: &Path) -> Self {
        let case_dir = resolve_path(case_dir);
        let store = EventStore::new(&case_dir);
        Self { case_dir, store }
    }

    /// Return the resolved Case directory.
    #[must_use]
    pub fn case_dir(&self) -> &Path {
        &self.case_dir
    }

    // ── Reads ────────────────────────────────────────────────────────────

    /// Fold the complete event log into the current [`State`].
    ///
    /// # Errors
    ///
    /// Returns `CASE_NOT_FOUND` when the log is missing, `TRUNCATED_EVENT`
    /// when the log has a damaged tail that must be recovered first, or any
    /// validation error produced while replaying the events.
    pub fn load(&self) -> Result<State, ZdebugError> {
        let (events, tail) = self.store.read_events(false)?;
        if !tail.is_empty() {
            return Err(ZdebugError::new(
                "TRUNCATED_EVENT",
                "Recover the Case before reading",
            ));
        }
        model::replay(&events)
    }

    /// Return the current Case status.
    ///
    /// # Errors
    ///
    /// Returns the same codes as [`Self::load`].
    pub fn status(&self) -> Result<State, ZdebugError> {
        self.load()
    }

    /// Check every Artifact for existence and content drift.
    ///
    /// The report mirrors the reference structure: `ok` is true when no
    /// problem was found, `state` is the folded Case, and each problem
    /// names the drifting Artifact and the human-readable reason.
    ///
    /// # Errors
    ///
    /// Returns the same codes as [`Self::load`].
    pub fn verify(&self) -> Result<VerifyReport, ZdebugError> {
        let state = self.load()?;
        let problems = self.collect_problems(&state);
        Ok(VerifyReport { ok: problems.is_empty(), state, problems })
    }

    /// Rebuild `summary.md` from the event log.
    ///
    /// Returns the path that was written.
    ///
    /// # Errors
    ///
    /// Returns the same codes as [`Self::load`], or an I/O error when the
    /// summary cannot be written.
    pub fn repair_view(&self) -> Result<PathBuf, ZdebugError> {
        let state = self.load()?;
        self.project(&state)?;
        Ok(self.case_dir.join(projector::SUMMARY_FILE))
    }

    // ── Writes ───────────────────────────────────────────────────────────

    /// Create a new Case, its baseline snapshots, and its first projection.
    ///
    /// A `case-created` event is written exclusively: an existing Case is
    /// rejected with `CASE_EXISTS`. A `verify` criterion is recorded only
    /// when `verify` is `Some`.
    ///
    /// # Errors
    ///
    /// Returns `CASE_EXISTS` when the log already exists, `INVALID_ID` for
    /// a malformed `case_id`, `INVALID_VERIFY` when the criterion is
    /// malformed, `CASE_BUSY` when another operation holds the lock, or an
    /// I/O error from the snapshot capture or the write.
    pub fn initialize(
        &self,
        case_id: &str,
        title: &str,
        objective: &str,
        workspaces: &[String],
        default_interpreter: Option<&str>,
        verify: Option<&Value>,
    ) -> Result<State, ZdebugError> {
        let resolved: Vec<String> = workspaces
            .iter()
            .map(|path| {
                resolve_path(Path::new(path)).to_string_lossy().into_owned()
            })
            .collect();
        let exclude = [self.case_dir.clone()];
        let baseline: Vec<Value> = resolved
            .iter()
            .map(|path| capture_snapshot(Path::new(path), &exclude))
            .collect();

        let _lock = self.store.lock()?;
        let mut payload = json!({
            "title": title,
            "objective": objective,
            "workspaces": resolved,
            "baseline": baseline,
            "default_interpreter": default_interpreter,
        });
        if let Some(verify) = verify {
            payload["verify"] = verify.clone();
        }
        self.store.initialize_locked(case_id, &payload)?;
        let state = self.load()?;
        self.project(&state)?;
        Ok(state)
    }

    /// Validate `event_type` and append it under a freshly acquired lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock,
    /// [`ZdebugError`] with the model code when the event is rejected, or
    /// an I/O error from the append or projection.
    pub fn append(
        &self,
        event_type: &str,
        payload: &Value,
    ) -> Result<State, ZdebugError> {
        let _lock = self.store.lock()?;
        let mut state = self.load()?;
        self.append_locked(&mut state, event_type, payload)?;
        Ok(state)
    }

    /// Validate `event_type` and `payload` against `state` without
    /// appending it.
    ///
    /// The caller must hold the Case lock and own `state`. The event is
    /// applied to a clone, so a rejected event leaves both the log and
    /// `state` untouched; this lets a caller reject a plan before it
    /// touches the filesystem.
    ///
    /// # Errors
    ///
    /// Returns `CASE_CLOSED` when the Case is closed and the event is not
    /// exempt, or the model's business code when validation fails.
    pub fn validate_event(
        state: &State,
        event_type: &str,
        payload: &Value,
    ) -> Result<(), ZdebugError> {
        let mut candidate = state.clone();
        apply_candidate(&mut candidate, event_type, payload)
    }

    /// Derive an event from the locked state and append it.
    ///
    /// The callback runs while the Case lock is held and receives the
    /// freshly replayed [`State`], so a caller that allocates an identifier
    /// from the current records cannot race another command. The returned
    /// `(event_type, payload)` pair is validated with
    /// [`model::apply_event`] before it is persisted, so a rejected event
    /// leaves the log untouched.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, whatever
    /// error the callback returns, the model's business code when the event
    /// is rejected, or an I/O error from the append or projection.
    pub fn append_with<F>(&self, build: F) -> Result<State, ZdebugError>
    where
        F: FnOnce(&State) -> Result<(String, Value), ZdebugError>,
    {
        let _lock = self.store.lock()?;
        let mut state = self.load()?;
        let (event_type, payload) = build(&state)?;
        self.append_locked(&mut state, &event_type, &payload)?;
        Ok(state)
    }

    /// Validate `event_type` against `state` and append it.
    ///
    /// The caller must already hold the Case lock (for example via
    /// [`Self::lock`]) and own the in-memory `state`. The event is applied
    /// to a clone first, so a rejected event leaves both the log and
    /// `state` untouched; only a successful write commits the new state and
    /// refreshes `summary.md`. Returns the persisted envelope.
    ///
    /// # Errors
    ///
    /// Returns `CASE_CLOSED` when the Case is closed and the event is not
    /// exempt, the model's business code when validation fails, or an I/O
    /// error from the append or projection.
    pub fn append_locked(
        &self,
        state: &mut State,
        event_type: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        let mut next = state.clone();
        apply_candidate(&mut next, event_type, payload)?;
        let event = self.store.append_locked(event_type, payload)?;
        *state = next;
        self.project(state)?;
        Ok(event)
    }

    /// Take the Case's non-blocking exclusive operation lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, or an
    /// I/O error when the lock file cannot be opened.
    pub fn lock(&self) -> Result<CaseLock, ZdebugError> {
        self.store.lock()
    }

    /// Close the Case after the delivery gate has passed.
    ///
    /// # Errors
    ///
    /// Returns `CASE_NOT_OPEN`, `INVALID_CLOSE_REASON`, `ATTEMPT_RUNNING`,
    /// `INCOMPLETE_DELIVERABLE`, `MISSING_DELIVERABLE_CONTENT`,
    /// `MISSING_FINAL_SNAPSHOT`, or a reference error when the gate fails,
    /// plus [`Self::append`]'s errors.
    pub fn close(&self, reason: &str) -> Result<State, ZdebugError> {
        self.append("case-closed", &json!({"reason": reason}))
    }

    /// Reopen a closed Case.
    ///
    /// # Errors
    ///
    /// Returns `CASE_NOT_CLOSED` when the Case is not closed, plus
    /// [`Self::append`]'s errors.
    pub fn reopen(&self, reason: &str) -> Result<State, ZdebugError> {
        self.append("case-reopened", &json!({"reason": reason}))
    }

    /// Record the final workspace snapshots.
    ///
    /// # Errors
    ///
    /// Returns [`Self::append`]'s errors.
    pub fn finalize(&self) -> Result<State, ZdebugError> {
        let state = self.load()?;
        let exclude = [self.case_dir.clone()];
        let snapshots: Vec<Value> = state
            .workspaces
            .iter()
            .filter_map(Value::as_str)
            .map(|path| capture_snapshot(Path::new(path), &exclude))
            .collect();
        self.append("workspace-finalized", &json!({"snapshots": snapshots}))
    }

    /// Replace the verification criterion, recording why it changed.
    ///
    /// # Errors
    ///
    /// Returns `INVALID_VERIFY` or `INVALID_VERIFY_SOURCE` for a malformed
    /// criterion, `MISSING_REASON` when `reason` is empty, plus
    /// [`Self::append`]'s errors.
    pub fn update_verify(
        &self,
        verify: &Value,
        reason: &str,
    ) -> Result<State, ZdebugError> {
        self.append(
            "case-verify-updated",
            &json!({"verify": verify, "reason": reason}),
        )
    }

    /// Quarantine a damaged tail and mark crashed Attempts interrupted.
    ///
    /// The damaged bytes are saved under `artifacts/recovery/` and the log
    /// is truncated back to its last complete event before any recovery
    /// events are appended.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, or an
    /// I/O error from the recovery write or the append.
    pub fn recover(&self) -> Result<State, ZdebugError> {
        let _lock = self.store.lock()?;
        self.store.recover_truncated_tail_locked()?;
        let mut state = self.load()?;
        let running = running_attempts(&state);
        for (experiment_id, attempt_id) in running {
            let payload = json!({
                "experiment_id": experiment_id,
                "attempt_id": attempt_id,
                "reason": "runner process did not finish",
                "finished_at": utc_now(),
            });
            self.apply_and_append(
                &mut state,
                "experiment-attempt-recovered",
                &payload,
            )?;
        }
        self.project(&state)?;
        Ok(state)
    }

    // ── Internals ────────────────────────────────────────────────────────

    /// Apply `event_type` and append it without re-projecting the summary.
    fn apply_and_append(
        &self,
        state: &mut State,
        event_type: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        apply_candidate(state, event_type, payload)?;
        self.store.append_locked(event_type, payload)
    }

    /// Collect one problem per Artifact that drifted.
    fn collect_problems(&self, state: &State) -> Vec<ArtifactProblem> {
        let mut problems = Vec::new();
        for (artifact_id, artifact) in &state.artifacts {
            for problem in verify_artifact(&self.case_dir, artifact) {
                problems.push(ArtifactProblem {
                    artifact: artifact_id.clone(),
                    problem,
                });
            }
        }
        problems
    }

    /// Write the projected `summary.md` of `state`.
    fn project(&self, state: &State) -> Result<(), ZdebugError> {
        projector::project(&self.case_dir, state).map_err(ZdebugError::from)
    }
}

// ── Verify report ────────────────────────────────────────────────────────────

/// The result of checking every Artifact in a Case.
#[derive(Debug)]
pub struct VerifyReport {
    /// Whether every Artifact is intact.
    pub ok: bool,
    /// The folded Case state at verification time.
    pub state: State,
    /// One entry per detected drift.
    pub problems: Vec<ArtifactProblem>,
}

impl VerifyReport {
    /// Render the report as the JSON object the CLI emits.
    #[must_use]
    pub fn to_dict(&self) -> Value {
        json!({
            "ok": self.ok,
            "state": self.state.to_dict(),
            "problems": self
                .problems
                .iter()
                .map(ArtifactProblem::to_dict)
                .collect::<Vec<_>>(),
        })
    }
}

/// One Artifact that failed verification.
#[derive(Debug)]
pub struct ArtifactProblem {
    /// Identifier of the drifting Artifact.
    pub artifact: String,
    /// Human-readable description of the drift.
    pub problem: String,
}

impl ArtifactProblem {
    /// Render the problem as `{"artifact": ..., "problem": ...}`.
    #[must_use]
    pub fn to_dict(&self) -> Value {
        json!({"artifact": self.artifact, "problem": self.problem})
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Reject a closed-Case write and validate the event against `state`.
fn apply_candidate(
    state: &mut State,
    event_type: &str,
    payload: &Value,
) -> Result<(), ZdebugError> {
    if state.lifecycle == "CLOSED" && !CLOSED_EXEMPT.contains(&event_type) {
        return Err(ZdebugError::new("CASE_CLOSED", "Case is closed"));
    }
    let candidate = json!({
        "seq": state.last_seq + 1,
        "type": event_type,
        "payload": payload,
    });
    model::apply_event(state, &candidate)
}

/// List the `(experiment_id, attempt_id)` pairs still marked running.
fn running_attempts(state: &State) -> Vec<(String, String)> {
    let mut running = Vec::new();
    for (experiment_id, experiment) in &state.experiments {
        let Some(attempts) =
            experiment.get("attempts").and_then(Value::as_array)
        else {
            continue;
        };
        for attempt in attempts {
            let status = attempt.get("status").and_then(Value::as_str);
            let attempt_id = attempt.get("attempt_id").and_then(Value::as_str);
            if status == Some("running")
                && let Some(attempt_id) = attempt_id
            {
                running.push((experiment_id.clone(), attempt_id.to_owned()));
            }
        }
    }
    running
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::artifacts::{ArtifactOptions, Storage, create_artifact_payload};
    use crate::events::EventStore;
    use std::fs;
    use std::io::Write as _;

    use super::*;

    /// Serialize tests that take the Case lock or spawn Git.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_guard()
    }

    /// Open a repository over `<temp>/case`.
    fn repo() -> (tempfile::TempDir, CaseRepository) {
        let dir = tempfile::tempdir().unwrap();
        let repository = CaseRepository::new(&dir.path().join("case"));
        (dir, repository)
    }

    /// Create an empty open Case with no workspaces or baseline.
    fn init(repository: &CaseRepository) {
        repository
            .initialize("CASE-1", "title", "objective", &[], None, None)
            .unwrap();
    }

    /// Read the raw bytes of the Case log.
    fn log_bytes(repository: &CaseRepository) -> Vec<u8> {
        fs::read(repository.case_dir().join("case.jsonl")).unwrap()
    }

    #[test]
    fn test_initialize_is_exclusive() {
        let _guard = guard();
        let (_dir, repository) = repo();
        let state = repository
            .initialize("CASE-1", "title", "objective", &[], None, None)
            .unwrap();
        assert_eq!(state.case_id, "CASE-1");
        assert_eq!(state.lifecycle, "OPEN");
        assert!(repository.case_dir().join("summary.md").is_file());

        let err = repository
            .initialize("CASE-1", "again", "again", &[], None, None)
            .unwrap_err();
        assert_eq!(err.code(), "CASE_EXISTS");
        // The rejected second init did not append a second event.
        assert_eq!(repository.status().unwrap().last_seq, 1);
    }

    #[test]
    fn test_initialize_records_verify_criterion() {
        let _guard = guard();
        let (_dir, repository) = repo();
        let state = repository
            .initialize(
                "CASE-1",
                "title",
                "objective",
                &[],
                Some("bash"),
                Some(&json!({"command": "cargo test", "source": "user"})),
            )
            .unwrap();
        assert_eq!(state.default_interpreter.as_deref(), Some("bash"));
        assert_eq!(state.verify.as_ref().unwrap()["command"], "cargo test");
    }

    #[test]
    fn test_rejected_append_leaves_no_residue() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        repository
            .append(
                "claim-created",
                &json!({"id": "CL-001", "statement": "s", "scope": {}}),
            )
            .unwrap();
        let before = log_bytes(&repository);

        let err = repository
            .append(
                "claim-created",
                &json!({"id": "CL-001", "statement": "s", "scope": {}}),
            )
            .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_CLAIM");
        assert_eq!(log_bytes(&repository), before);
        assert_eq!(repository.status().unwrap().last_seq, 2);
    }

    #[test]
    fn test_append_with_allocates_ids_under_the_lock() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        repository
            .append(
                "claim-created",
                &json!({"id": "CL-004", "statement": "s", "scope": {}}),
            )
            .unwrap();

        let state = repository
            .append_with(|state| {
                let id = crate::util::next_id("CL", &state.claims);
                Ok((
                    "claim-created".to_owned(),
                    json!({"id": id, "statement": "t", "scope": {}}),
                ))
            })
            .unwrap();
        assert!(state.claims.contains_key("CL-005"));
    }

    #[test]
    fn test_append_with_serializes_concurrent_allocation() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let repository = std::sync::Arc::new(repository);

        let handles: Vec<_> = (0..2)
            .map(|index| {
                let repository = std::sync::Arc::clone(&repository);
                std::thread::spawn(move || {
                    loop {
                        let appended = repository.append_with(|state| {
                            let id = crate::util::next_id("CL", &state.claims);
                            Ok((
                                "claim-created".to_owned(),
                                json!({
                                    "id": id,
                                    "statement": format!("claim {index}"),
                                    "scope": {},
                                }),
                            ))
                        });
                        match appended {
                            Ok(_) => return,
                            Err(err) if err.code() == "CASE_BUSY" => {
                                std::thread::sleep(
                                    std::time::Duration::from_millis(1),
                                );
                            }
                            Err(err) => panic!("unexpected error: {err}"),
                        }
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let state = repository.status().unwrap();
        assert_eq!(state.claims.len(), 2);
        assert!(state.claims.contains_key("CL-001"));
        assert!(state.claims.contains_key("CL-002"));
    }

    #[test]
    fn test_append_with_reports_case_busy() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let _held = repository.lock().unwrap();
        let err = repository
            .append_with(|_| {
                Ok(("claim-created".to_owned(), json!({"id": "CL-001"})))
            })
            .unwrap_err();
        assert_eq!(err.code(), "CASE_BUSY");
    }

    #[test]
    fn test_append_with_propagates_builder_error() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let before = log_bytes(&repository);
        let err = repository
            .append_with(|_| Err(ZdebugError::new("INVALID_ID", "nope")))
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_ID");
        assert_eq!(log_bytes(&repository), before);
    }

    #[test]
    fn test_close_rejects_incomplete_deliverable() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        repository
            .append(
                "deliverable-created",
                &json!({
                    "id": "DL-001",
                    "title": "fix",
                    "contract": "c",
                    "required": true,
                    "criteria": [{"id": "CR-001", "description": "tests pass"}],
                }),
            )
            .unwrap();

        let err = repository.close("completed").unwrap_err();
        assert_eq!(err.code(), "INCOMPLETE_DELIVERABLE");
        assert_eq!(repository.status().unwrap().lifecycle, "OPEN");
    }

    #[test]
    fn test_close_succeeds_once_deliverables_are_settled() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        repository
            .append(
                "claim-created",
                &json!({"id": "CL-001", "statement": "s", "scope": {}}),
            )
            .unwrap();
        repository
            .append(
                "artifact-created",
                &json!({
                    "id": "AR-001",
                    "storage": "reference",
                    "path": "/tmp/external.bin",
                    "sha256": "deadbeef",
                }),
            )
            .unwrap();
        repository
            .append(
                "deliverable-created",
                &json!({
                    "id": "DL-001",
                    "title": "fix",
                    "contract": "c",
                    "required": true,
                    "criteria": [{"id": "CR-001", "description": "d"}],
                }),
            )
            .unwrap();
        repository
            .append(
                "deliverable-criterion-disposed",
                &json!({
                    "deliverable_id": "DL-001",
                    "criterion_id": "CR-001",
                    "disposition": "satisfied",
                    "references": ["CL-001"],
                }),
            )
            .unwrap();
        repository
            .append(
                "deliverable-content-attached",
                &json!({
                    "deliverable_id": "DL-001",
                    "artifact_id": "AR-001",
                    "references": ["CL-001"],
                }),
            )
            .unwrap();

        // The missing final snapshot still refuses the close.
        let err = repository.close("completed").unwrap_err();
        assert_eq!(err.code(), "MISSING_FINAL_SNAPSHOT");

        repository.finalize().unwrap();
        let state = repository.close("completed").unwrap();
        assert_eq!(state.lifecycle, "CLOSED");
        assert_eq!(state.close_reason.as_deref(), Some("completed"));
    }

    #[test]
    fn test_recover_repairs_tail_and_marks_interrupted() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        repository
            .append(
                "experiment-planned",
                &json!({
                    "id": "EX-001",
                    "question": "q",
                    "procedure_artifact": "p",
                }),
            )
            .unwrap();
        repository
            .append(
                "experiment-attempt-started",
                &json!({
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                }),
            )
            .unwrap();

        // Simulate a crash mid-append: a half-written JSON line.
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(repository.case_dir().join("case.jsonl"))
            .unwrap();
        file.write_all(
            b"{\"format_version\":1,\"case_id\":\"CASE-1\",\"seq\":4",
        )
        .unwrap();
        drop(file);

        let state = repository.recover().unwrap();
        let attempt = &state.experiments["EX-001"]["attempts"][0];
        assert_eq!(attempt["status"], "interrupted");
        assert_eq!(attempt["recovery_reason"], "runner process did not finish");
        assert!(attempt["finished_at"].is_string());
        assert_eq!(state.recoveries.len(), 1);
        assert_eq!(state.recoveries[0]["reason"], "truncated-tail");

        // The log is complete again and the tail was quarantined.
        let (events, tail) =
            EventStore::new(repository.case_dir()).read_events(false).unwrap();
        assert!(tail.is_empty());
        assert_eq!(
            events.last().unwrap()["type"],
            "experiment-attempt-recovered"
        );
        let recovery_dir = repository.case_dir().join("artifacts/recovery");
        assert!(fs::read_dir(&recovery_dir).unwrap().next().is_some());
    }

    #[test]
    fn test_repair_view_rebuilds_summary() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let summary = repository.case_dir().join("summary.md");
        fs::remove_file(&summary).unwrap();

        let path = repository.repair_view().unwrap();
        assert_eq!(path, summary);
        let rendered = fs::read_to_string(&summary).unwrap();
        assert!(rendered.contains("# Auto Debug Case: CASE-1"));
    }

    #[test]
    fn test_update_verify_records_reason() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let state = repository
            .update_verify(
                &json!({"command": "cargo test", "source": "agent"}),
                "narrowed scope",
            )
            .unwrap();
        assert_eq!(state.verify.as_ref().unwrap()["command"], "cargo test");
        assert_eq!(state.verify.as_ref().unwrap()["source"], "agent");

        let (events, _) =
            EventStore::new(repository.case_dir()).read_events(false).unwrap();
        let last = events.last().unwrap();
        assert_eq!(last["type"], "case-verify-updated");
        assert_eq!(last["payload"]["reason"], "narrowed scope");
    }

    #[test]
    fn test_update_verify_requires_reason() {
        let _guard = guard();
        let (_dir, repository) = repo();
        init(&repository);
        let before = log_bytes(&repository);

        let err = repository
            .update_verify(&json!({"command": "true", "source": "agent"}), "")
            .unwrap_err();
        assert_eq!(err.code(), "MISSING_REASON");
        assert_eq!(log_bytes(&repository), before);
    }

    #[test]
    fn test_verify_reports_artifact_drift() {
        let _guard = guard();
        let (dir, repository) = repo();
        init(&repository);
        let source = dir.path().join("external.bin");
        fs::write(&source, b"payload").unwrap();
        let payload = create_artifact_payload(
            repository.case_dir(),
            "AR-001",
            &source,
            Storage::Reference,
            &ArtifactOptions::default(),
        )
        .unwrap();
        repository.append("artifact-created", &payload).unwrap();

        let report = repository.verify().unwrap();
        assert!(report.ok);
        assert!(report.problems.is_empty());

        fs::remove_file(&source).unwrap();
        let report = repository.verify().unwrap();
        assert!(!report.ok);
        assert_eq!(report.problems.len(), 1);
        assert_eq!(report.problems[0].artifact, "AR-001");
        assert_eq!(report.problems[0].problem, "external artifact is missing");
        let dict = report.to_dict();
        assert_eq!(dict["ok"], false);
        assert_eq!(dict["problems"][0]["artifact"], "AR-001");
        assert_eq!(dict["state"]["case_id"], "CASE-1");
    }
}
