//! Deterministic `summary.md` projection of a Case.
//!
//! [`render`] folds a [`State`] into the machine-generated view of a Case:
//! lifecycle, objective, Deliverables with their criterion dispositions,
//! Claims and their relations, Experiments and Attempts, Evidence,
//! Artifacts, workspace snapshots, recovery notes, and the verification
//! criterion that decides convergence. The layout mirrors the reference
//! Python `projector.py`; the `## Artifacts`, `### Claim Relations`, and
//! `## Verify` sections expose state the reference keeps in the model but
//! does not print, so the view stays a complete recovery record.
//!
//! The projection is a pure function of the state, so equal states always
//! yield byte-identical output. [`project`] writes that output to
//! `summary.md` through [`atomic_write`]. There is no hand-editable
//! region: the file can always be rebuilt from the event log.

use std::io;
use std::path::Path;

use serde_json::Value;

use crate::artifacts::is_invalidated;
use crate::model::State;
use crate::util::{atomic_write, canonical_json};

/// Summary file name inside a Case directory.
pub const SUMMARY_FILE: &str = "summary.md";

// ── Entry points ─────────────────────────────────────────────────────────────

/// Render the full `summary.md` view of `state`.
#[must_use]
pub fn render(state: &State) -> String {
    let mut lines = Vec::new();
    push_header(&mut lines, state);
    push_workspaces(&mut lines, state);
    push_deliverables(&mut lines, state);
    push_claims(&mut lines, state);
    push_experiments(&mut lines, state);
    push_evidence(&mut lines, state);
    push_artifacts(&mut lines, state);
    push_workspace_state(&mut lines, state);
    push_recoveries(&mut lines, state);
    push_verify(&mut lines, state);
    lines.push(String::new());
    lines.join("\n")
}

/// Write the projected `summary.md` of `state` into `case_dir`.
///
/// # Errors
///
/// Returns an I/O error when the summary file cannot be written.
pub fn project(case_dir: &Path, state: &State) -> io::Result<()> {
    atomic_write(&case_dir.join(SUMMARY_FILE), &render(state))
}

// ── Sections ─────────────────────────────────────────────────────────────────

/// Append the title block with the Case-level attributes.
fn push_header(lines: &mut Vec<String>, state: &State) {
    lines.push(format!("# Auto Debug Case: {}", state.case_id));
    lines.push(String::new());
    lines.push(format!("- Lifecycle: `{}`", state.lifecycle));
    lines.push(format!("- Title: {}", state.title));
    lines.push(format!("- Objective: {}", state.objective));
    lines.push(format!("- Event sequence: {}", state.last_seq));
}

/// Append the list of debugged workspace paths.
fn push_workspaces(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Workspaces".to_owned());
    lines.push(String::new());
    if state.workspaces.is_empty() {
        lines.push("- None".to_owned());
        return;
    }
    for path in &state.workspaces {
        lines.push(format!("- `{}`", path.as_str().unwrap_or_default()));
    }
}

/// Append every Deliverable with its criterion dispositions.
fn push_deliverables(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Deliverables".to_owned());
    lines.push(String::new());
    if state.deliverables.is_empty() {
        lines.push("- None".to_owned());
    }
    for deliverable in state.deliverables.values() {
        push_deliverable(lines, deliverable);
    }
}

/// Append one Deliverable and its criteria.
fn push_deliverable(lines: &mut Vec<String>, deliverable: &Value) {
    lines.push(format!(
        "### {}: {}",
        text(deliverable, "id"),
        text(deliverable, "title")
    ));
    lines.push(String::new());
    lines.push(text(deliverable, "contract").to_owned());
    lines.push(String::new());
    if let Some(criteria) =
        deliverable.get("criteria").and_then(Value::as_object)
    {
        for criterion in criteria.values() {
            push_criterion(lines, criterion);
        }
    }
    if truthy(deliverable.get("content_artifact")) {
        lines.push(format!(
            "- Content artifact: `{}`",
            text(deliverable, "content_artifact")
        ));
    }
    lines.push(String::new());
}

/// Append one criterion in its checkbox form.
fn push_criterion(lines: &mut Vec<String>, criterion: &Value) {
    let done =
        criterion.get("disposition").is_some_and(|value| !value.is_null());
    let mark = if done { "x" } else { " " };
    let suffix = if done {
        format!(" - `{}`", text(criterion, "disposition"))
    } else {
        String::new()
    };
    lines.push(format!(
        "- [{mark}] {}: {}{suffix}",
        text(criterion, "id"),
        text(criterion, "description")
    ));
    if truthy(criterion.get("references")) {
        lines.push(format!(
            "  References: {}",
            join_strings(criterion.get("references"))
        ));
    }
    if truthy(criterion.get("reason")) {
        lines.push(format!("  Reason: {}", text(criterion, "reason")));
    }
}

/// Append the Claims plus their evidence and claim relations.
fn push_claims(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Claims".to_owned());
    lines.push(String::new());
    if state.claims.is_empty() {
        lines.push("- None".to_owned());
    }
    for claim in state.claims.values() {
        lines.push(format!(
            "- **{}** `{}`: {}",
            text(claim, "id"),
            text(claim, "assessment"),
            text(claim, "statement")
        ));
        lines.push(format!(
            "  Scope: {}",
            canonical_json(claim.get("scope").unwrap_or(&Value::Null))
        ));
        if truthy(claim.get("assessment_reason")) {
            lines.push(format!(
                "  Assessment: {}",
                text(claim, "assessment_reason")
            ));
        }
    }
    if !state.evidence_relations.is_empty() {
        lines.push(String::new());
        lines.push("### Evidence Relations".to_owned());
        lines.push(String::new());
        for relation in &state.evidence_relations {
            lines.push(format!(
                "- {} `{}` {}: {}",
                text(relation, "evidence_id"),
                text(relation, "relation"),
                text(relation, "claim_id"),
                text(relation, "reason")
            ));
        }
    }
    if !state.claim_relations.is_empty() {
        lines.push(String::new());
        lines.push("### Claim Relations".to_owned());
        lines.push(String::new());
        for relation in &state.claim_relations {
            lines.push(format!(
                "- {} `{}` {}",
                text(relation, "source"),
                text(relation, "relation"),
                text(relation, "target")
            ));
        }
    }
}

/// Append every Experiment with its Attempts.
fn push_experiments(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Experiments".to_owned());
    lines.push(String::new());
    if state.experiments.is_empty() {
        lines.push("- None".to_owned());
    }
    for experiment in state.experiments.values() {
        lines.push(format!(
            "- **{}**: {}",
            text(experiment, "id"),
            text(experiment, "question")
        ));
        lines.push(format!(
            "  Procedure: `{}`",
            text(experiment, "procedure_artifact")
        ));
        if let Some(attempts) =
            experiment.get("attempts").and_then(Value::as_array)
        {
            for attempt in attempts {
                lines.push(format!(
                    "  - {}: `{}`",
                    text(attempt, "attempt_id"),
                    text(attempt, "status")
                ));
            }
        }
    }
}

/// Append every Evidence record with its validity.
fn push_evidence(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Evidence".to_owned());
    lines.push(String::new());
    if state.evidence.is_empty() {
        lines.push("- None".to_owned());
    }
    for evidence in state.evidence.values() {
        let status = validity(evidence);
        lines.push(format!(
            "- **{}** `{status}`: {}",
            text(evidence, "id"),
            text(evidence, "statement")
        ));
        if truthy(evidence.get("attachments")) {
            lines.push(format!(
                "  Attachments: {}",
                join_strings(evidence.get("attachments"))
            ));
        }
    }
}

/// Append every Artifact with its storage location.
fn push_artifacts(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Artifacts".to_owned());
    lines.push(String::new());
    if state.artifacts.is_empty() {
        lines.push("- None".to_owned());
    }
    for artifact in state.artifacts.values() {
        let status = validity(artifact);
        lines.push(format!(
            "- **{}** `{status}`: storage={}, path=`{}`",
            text(artifact, "id"),
            text(artifact, "storage"),
            text(artifact, "path")
        ));
        if truthy(artifact.get("invalidation_reason")) {
            lines.push(format!(
                "  Reason: {}",
                text(artifact, "invalidation_reason")
            ));
        }
    }
}

/// Append the baseline and final workspace snapshots.
fn push_workspace_state(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Workspace State".to_owned());
    lines.push(String::new());
    for snapshot in &state.baseline {
        lines.push(snapshot_line("Baseline", snapshot));
    }
    match &state.final_snapshot {
        None => lines.push("- Final snapshot: not recorded".to_owned()),
        Some(snapshots) => {
            for snapshot in snapshots {
                lines.push(snapshot_line("Final", snapshot));
            }
        }
    }
}

/// Format one baseline or final snapshot line.
fn snapshot_line(label: &str, snapshot: &Value) -> String {
    let path = text(snapshot, "path");
    if snapshot.get("kind").and_then(Value::as_str) == Some("git") {
        let head = py_scalar(snapshot.pointer("/git/head"));
        let dirty = py_scalar(snapshot.pointer("/git/dirty"));
        format!("- {label} `{path}`: `{head}`, dirty={dirty}")
    } else {
        format!("- {label} `{path}`: non-Git directory")
    }
}

/// Append the recovery notes, when any were recorded.
fn push_recoveries(lines: &mut Vec<String>, state: &State) {
    if state.recoveries.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push("## Recoveries".to_owned());
    lines.push(String::new());
    for recovery in &state.recoveries {
        lines.push(format!("- {}", canonical_json(recovery)));
    }
}

/// Append the verification criterion that decides convergence.
fn push_verify(lines: &mut Vec<String>, state: &State) {
    lines.push(String::new());
    lines.push("## Verify".to_owned());
    lines.push(String::new());
    let Some(verify) = &state.verify else {
        lines.push("- None".to_owned());
        return;
    };
    let command = verify.get("command").and_then(Value::as_str).unwrap_or("");
    let source = verify.get("source").and_then(Value::as_str).unwrap_or("");
    lines.push(format!("- Command: `{command}`"));
    lines.push(format!("- Source: `{source}`"));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Read a string field from a record, defaulting to empty.
fn text<'a>(record: &'a Value, key: &str) -> &'a str {
    record.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Return `invalidated` or `valid` for an Evidence or Artifact record.
fn validity(record: &Value) -> &'static str {
    if is_invalidated(record) { "invalidated" } else { "valid" }
}

/// Report whether an optional JSON value is truthy in the Python sense.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_none_or(|n| n != 0.0),
    }
}

/// Format a JSON scalar the way Python's `str()` would.
fn py_scalar(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".to_owned(),
        Some(Value::Bool(true)) => "True".to_owned(),
        Some(Value::Bool(false)) => "False".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Join a JSON array of strings with `, `.
fn join_strings(value: Option<&Value>) -> String {
    value.and_then(Value::as_array).map_or_else(String::new, |items| {
        items
            .iter()
            .map(|item| py_scalar(Some(item)))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::*;
    use crate::model::replay;

    /// Build an event envelope at `seq` for the sample Case.
    fn event(event_type: &str, seq: u64, payload: Value) -> Value {
        let mut envelope = Map::new();
        envelope.insert("case_id".to_owned(), json!("case-1"));
        envelope.insert("seq".to_owned(), json!(seq));
        envelope
            .insert("type".to_owned(), Value::String(event_type.to_owned()));
        envelope.insert("payload".to_owned(), payload);
        Value::Object(envelope)
    }

    /// Events 1-6: Case creation through the first Artifact.
    fn created_events() -> Vec<Value> {
        vec![
            event(
                "case-created",
                1,
                json!({
                    "title": "bug",
                    "objective": "fix concurrency",
                    "workspaces": ["/ws-a"],
                    "baseline": [
                        {
                            "kind": "git",
                            "path": "/ws-a",
                            "git": {"head": "abc123", "dirty": true},
                        },
                        {"kind": "directory", "path": "/ws-b"},
                    ],
                    "verify": {"command": "pytest -q", "source": "user"},
                    "default_interpreter": "bash",
                }),
            ),
            event(
                "deliverable-created",
                2,
                json!({
                    "id": "DL-001",
                    "title": "fix",
                    "contract": "tests pass and docs updated",
                    "required": true,
                    "criteria": [
                        {"id": "CR-001", "description": "tests pass"},
                        {"id": "CR-002", "description": "docs updated"},
                        {"id": "CR-003", "description": "regression added"},
                    ],
                }),
            ),
            event(
                "claim-created",
                3,
                json!({
                    "id": "CL-001",
                    "statement": "pool reuses uncommitted tx",
                    "scope": {"a": 1, "b": ["x"]},
                }),
            ),
            event(
                "claim-created",
                4,
                json!({"id": "CL-002", "statement": "retry storm", "scope": {}}),
            ),
            event(
                "claim-related",
                5,
                json!({"relation": "refines", "source": "CL-001", "target": "CL-002"}),
            ),
            event(
                "artifact-created",
                6,
                json!({
                    "id": "AR-001",
                    "storage": "copy",
                    "path": "artifacts/imported/AR-001/run.sh",
                }),
            ),
        ]
    }

    /// Events 7-12: Experiment, Attempt, Evidence, and assessment.
    fn investigation_events() -> Vec<Value> {
        vec![
            event(
                "experiment-planned",
                7,
                json!({
                    "id": "EX-001",
                    "question": "does disabling pooling fix it?",
                    "procedure_artifact": "AR-001",
                    "related_claims": ["CL-001"],
                }),
            ),
            event(
                "experiment-attempt-started",
                8,
                json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
            ),
            event(
                "experiment-attempt-finished",
                9,
                json!({
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                    "status": "finished",
                    "exit_code": 0,
                }),
            ),
            event(
                "evidence-created",
                10,
                json!({
                    "id": "EV-001",
                    "statement": "ten green runs",
                    "provenance": {
                        "kind": "experiment",
                        "experiment_id": "EX-001",
                        "attempt_id": "EX-001-A001",
                    },
                    "attachments": ["AR-001"],
                }),
            ),
            event(
                "evidence-related",
                11,
                json!({
                    "evidence_id": "EV-001",
                    "relation": "supports",
                    "claim_id": "CL-001",
                    "reason": "reproducible",
                }),
            ),
            event(
                "claim-assessed",
                12,
                json!({
                    "claim_id": "CL-001",
                    "assessment": "established",
                    "reason": "evidence holds",
                    "evidence": ["EV-001"],
                    "addressed_challenges": [],
                }),
            ),
        ]
    }

    /// Events 13-17: criterion dispositions through recovery.
    fn closure_events() -> Vec<Value> {
        vec![
            event(
                "deliverable-criterion-disposed",
                13,
                json!({
                    "deliverable_id": "DL-001",
                    "criterion_id": "CR-001",
                    "disposition": "satisfied",
                    "references": ["CL-001"],
                }),
            ),
            event(
                "deliverable-criterion-disposed",
                14,
                json!({
                    "deliverable_id": "DL-001",
                    "criterion_id": "CR-002",
                    "disposition": "blocked",
                    "reason": "docs owner unavailable",
                }),
            ),
            event(
                "deliverable-content-attached",
                15,
                json!({
                    "deliverable_id": "DL-001",
                    "artifact_id": "AR-001",
                    "references": ["CL-001"],
                }),
            ),
            event(
                "workspace-finalized",
                16,
                json!({
                    "snapshots": [
                        {
                            "kind": "git",
                            "path": "/ws-a",
                            "git": {"head": "def456", "dirty": false},
                        },
                    ],
                }),
            ),
            event(
                "case-recovered",
                17,
                json!({"reason": "truncated-tail", "artifact": "AR-001"}),
            ),
        ]
    }

    /// The complete sample event stream.
    fn events() -> Vec<Value> {
        let mut all = created_events();
        all.extend(investigation_events());
        all.extend(closure_events());
        all
    }

    /// Replay the sample stream into a State.
    fn sample_state() -> State {
        replay(&events()).expect("sample event stream replays")
    }

    #[test]
    fn test_render_contains_all_sections() {
        let rendered = render(&sample_state());
        let expected = [
            "# Auto Debug Case: case-1",
            "- Lifecycle: `OPEN`",
            "- Title: bug",
            "- Objective: fix concurrency",
            "- Event sequence: 17",
            "## Workspaces",
            "- `/ws-a`",
            "## Deliverables",
            "### DL-001: fix",
            "- [x] CR-001: tests pass - `satisfied`",
            "  References: CL-001",
            "- [x] CR-002: docs updated - `blocked`",
            "  Reason: docs owner unavailable",
            "- [ ] CR-003: regression added",
            "- Content artifact: `AR-001`",
            "## Claims",
            "- **CL-001** `established`: pool reuses uncommitted tx",
            "  Scope: {\"a\":1,\"b\":[\"x\"]}",
            "  Assessment: evidence holds",
            "### Evidence Relations",
            "- EV-001 `supports` CL-001: reproducible",
            "### Claim Relations",
            "- CL-001 `refines` CL-002",
            "## Experiments",
            "- **EX-001**: does disabling pooling fix it?",
            "  Procedure: `AR-001`",
            "  - EX-001-A001: `finished`",
            "## Evidence",
            "- **EV-001** `valid`: ten green runs",
            "  Attachments: AR-001",
            "## Artifacts",
            "- **AR-001** `valid`: storage=copy, path=`artifacts/imported/AR-001/run.sh`",
            "## Workspace State",
            "- Baseline `/ws-a`: `abc123`, dirty=True",
            "- Baseline `/ws-b`: non-Git directory",
            "- Final `/ws-a`: `def456`, dirty=False",
            "## Recoveries",
            "- {\"artifact\":\"AR-001\",\"reason\":\"truncated-tail\"}",
            "## Verify",
            "- Command: `pytest -q`",
            "- Source: `user`",
        ];
        for section in expected {
            assert!(rendered.contains(section), "missing line: {section}");
        }
    }

    #[test]
    fn test_render_is_idempotent_and_project_writes_same() {
        let state = sample_state();
        let first = render(&state);
        assert_eq!(first, render(&state));
        assert_eq!(first, render(&replay(&events()).unwrap()));

        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &state).unwrap();
        let written =
            std::fs::read_to_string(dir.path().join(SUMMARY_FILE)).unwrap();
        assert_eq!(written, first);

        project(dir.path(), &state).unwrap();
        let again =
            std::fs::read_to_string(dir.path().join(SUMMARY_FILE)).unwrap();
        assert_eq!(again, first);
    }
}
