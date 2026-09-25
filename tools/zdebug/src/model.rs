//! Event-sourced Case state model.
//!
//! A Case is the fold of its append-only event log: [`apply_event`]
//! validates one event against the current [`State`] and advances it,
//! [`replay`] rebuilds the state from a whole stream, and
//! [`validate_close`] enforces the delivery gate that a Case may only be
//! closed once its required deliverables are settled.
//!
//! The layer is a pure function of JSON values: it never touches the
//! filesystem, so events can be validated before they are persisted and
//! replayed without any I/O. The rules mirror the Python reference
//! `model.py` one-for-one, including the anti-self-deception checks that
//! keep claims and criteria tied to actually available evidence.
//!
//! Two increments extend the reference event vocabulary: a `case-created`
//! event may carry a user-declared verification criterion, and the new
//! `case-verify-updated` event replaces that criterion with a recorded
//! reason (the append-only log is the audit trail).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::util::ZdebugError;

/// Allowed Claim assessments.
const CLAIM_ASSESSMENTS: [&str; 4] =
    ["open", "supported", "established", "rejected"];

/// Allowed relations between Claims.
const CLAIM_RELATIONS: [&str; 3] = ["refines", "contradicts", "supersedes"];

/// Allowed relations between Evidence and a Claim.
const EVIDENCE_RELATIONS: [&str; 2] = ["supports", "challenges"];

/// Allowed dispositions for a Deliverable criterion.
const CRITERION_DISPOSITIONS: [&str; 3] = ["satisfied", "blocked", "waived"];

/// Allowed Case close reasons.
const CLOSE_REASONS: [&str; 3] =
    ["completed", "partially-blocked", "cancelled"];

/// Allowed origins for a verification criterion.
const VERIFY_SOURCES: [&str; 2] = ["user", "agent"];

// ── State ────────────────────────────────────────────────────────────────────

/// The materialized state of one Case.
///
/// Records are stored as their event payload plus the bookkeeping fields
/// the model adds (criterion dispositions, claim assessments, invalidation
/// flags); keeping them as JSON objects preserves any extra payload fields
/// the CLI attaches without the model having to know them.
#[derive(Debug, Clone)]
pub struct State {
    /// Case identifier assigned by `case-created`.
    pub case_id: String,
    /// Lifecycle flag, `OPEN` or `CLOSED`.
    pub lifecycle: String,
    /// Human-readable Case title.
    pub title: String,
    /// The debugging objective.
    pub objective: String,
    /// Interpreter used when an Experiment does not specify one.
    pub default_interpreter: Option<String>,
    /// Absolute workspace paths being debugged.
    pub workspaces: Vec<Value>,
    /// Git/environment snapshots captured at creation time.
    pub baseline: Vec<Value>,
    /// Workspace snapshots captured by `workspace-finalized`.
    pub final_snapshot: Option<Vec<Value>>,
    /// Deliverables keyed by identifier.
    pub deliverables: Map<String, Value>,
    /// Claims keyed by identifier.
    pub claims: Map<String, Value>,
    /// Experiments keyed by identifier.
    pub experiments: Map<String, Value>,
    /// Evidence keyed by identifier.
    pub evidence: Map<String, Value>,
    /// Artifacts keyed by identifier.
    pub artifacts: Map<String, Value>,
    /// Evidence-to-Claim relations, in append order.
    pub evidence_relations: Vec<Value>,
    /// Claim-to-Claim relations, in append order.
    pub claim_relations: Vec<Value>,
    /// Recovery records, in append order.
    pub recoveries: Vec<Value>,
    /// Current verification criterion, if the Case declares one.
    pub verify: Option<Map<String, Value>>,
    /// Reason recorded by `case-closed`, if the Case was ever closed.
    pub close_reason: Option<String>,
    /// Sequence number of the last applied event.
    pub last_seq: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            case_id: String::new(),
            lifecycle: "OPEN".to_owned(),
            title: String::new(),
            objective: String::new(),
            default_interpreter: None,
            workspaces: Vec::new(),
            baseline: Vec::new(),
            final_snapshot: None,
            deliverables: Map::new(),
            claims: Map::new(),
            experiments: Map::new(),
            evidence: Map::new(),
            artifacts: Map::new(),
            evidence_relations: Vec::new(),
            claim_relations: Vec::new(),
            recoveries: Vec::new(),
            verify: None,
            close_reason: None,
            last_seq: 0,
        }
    }
}

impl State {
    /// Render the state as the JSON object the CLI reports.
    ///
    /// The fields mirror the reference Python `State.to_dict`, plus the
    /// `verify` criterion and `close_reason` this crate tracks as
    /// increments, so a consumer can serialize a status or verify result
    /// without reaching into the struct.
    #[must_use]
    pub fn to_dict(&self) -> Value {
        json!({
            "case_id": self.case_id,
            "lifecycle": self.lifecycle,
            "title": self.title,
            "objective": self.objective,
            "default_interpreter": self.default_interpreter,
            "workspaces": self.workspaces,
            "baseline": self.baseline,
            "final_snapshot": self.final_snapshot,
            "deliverables": self.deliverables,
            "claims": self.claims,
            "experiments": self.experiments,
            "evidence": self.evidence,
            "artifacts": self.artifacts,
            "evidence_relations": self.evidence_relations,
            "claim_relations": self.claim_relations,
            "recoveries": self.recoveries,
            "verify": self.verify,
            "close_reason": self.close_reason,
            "last_seq": self.last_seq,
        })
    }
}

// ── Entry points ─────────────────────────────────────────────────────────────

/// Fold one event into `state`, validating it against the current state.
///
/// The event must be an object with an integer `seq`, a string `type`, and
/// an object `payload`. `case-created` must be the first event of a stream;
/// every other event type requires the Case to already exist.
///
/// # Errors
///
/// Returns [`ZdebugError`] with code `INVALID_EVENT` when `seq` is missing
/// or not a non-negative integer, or the event-specific business code for
/// any validation failure (`DUPLICATE_CASE`, `MISSING_CASE_EVENT`,
/// `UNADDRESSED_CHALLENGE`, `INVALID_PROVENANCE`, `UNKNOWN_EVENT_TYPE`,
/// and the rest of the model vocabulary).
pub fn apply_event(
    state: &mut State,
    event: &Value,
) -> Result<(), ZdebugError> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_event("Event type must be a string"))?;
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_event("Event payload must be an object"))?;
    let seq = event
        .get("seq")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_event("Event sequence must be an integer"))?;
    state.last_seq = seq;

    if event_type == "case-created" {
        return handle_case_created(state, event, payload);
    }
    if state.case_id.is_empty() {
        return Err(ZdebugError::new(
            "MISSING_CASE_EVENT",
            "First event must create the Case",
        ));
    }
    match event_type {
        "deliverable-created" => handle_deliverable_created(state, payload),
        "deliverable-criterion-disposed" => {
            handle_deliverable_criterion_disposed(state, payload)
        }
        "deliverable-content-attached" => {
            handle_deliverable_content_attached(state, payload)
        }
        "claim-created" => handle_claim_created(state, payload),
        "claim-related" => handle_claim_related(state, payload),
        "claim-assessed" => handle_claim_assessed(state, payload),
        "experiment-planned" => handle_experiment_planned(state, payload),
        "experiment-attempt-started" => {
            handle_experiment_attempt_started(state, payload)
        }
        "experiment-attempt-finished" => {
            handle_experiment_attempt_finished(state, payload)
        }
        "experiment-attempt-recovered" => {
            handle_experiment_attempt_recovered(state, payload)
        }
        "artifact-created" => handle_artifact_created(state, payload),
        "artifact-invalidated" => handle_artifact_invalidated(state, payload),
        "evidence-created" => handle_evidence_created(state, payload),
        "evidence-invalidated" => handle_evidence_invalidated(state, payload),
        "evidence-related" => handle_evidence_related(state, payload),
        "workspace-finalized" => handle_workspace_finalized(state, payload),
        "case-closed" => handle_case_closed(state, payload),
        "case-reopened" => handle_case_reopened(state, payload),
        "case-recovered" => {
            handle_case_recovered(state, payload);
            Ok(())
        }
        "case-verify-updated" => handle_case_verify_updated(state, payload),
        _ => Err(ZdebugError::new(
            "UNKNOWN_EVENT_TYPE",
            format!("Unknown event type: {event_type}"),
        )),
    }
}

/// Rebuild the [`State`] of a Case from its complete event stream.
///
/// # Errors
///
/// Returns `MISSING_CASE_EVENT` when the stream is empty or does not begin
/// with `case-created`, or any error produced by [`apply_event`].
pub fn replay(events: &[Value]) -> Result<State, ZdebugError> {
    if events.is_empty() {
        return Err(ZdebugError::new(
            "MISSING_CASE_EVENT",
            "First event must create the Case",
        ));
    }
    let mut state = State::default();
    for event in events {
        apply_event(&mut state, event)?;
    }
    Ok(state)
}

/// Enforce the delivery gate that guards `case-closed`.
///
/// A Case may close only while open, with a known `reason`, with no
/// running Experiment attempt, with every required Deliverable fully
/// settled and carrying valid content, and with a final workspace
/// snapshot recorded.
///
/// # Errors
///
/// Returns `CASE_NOT_OPEN`, `INVALID_CLOSE_REASON`, `ATTEMPT_RUNNING`,
/// `INCOMPLETE_DELIVERABLE`, `MISSING_DELIVERABLE_CONTENT`,
/// `MISSING_FINAL_SNAPSHOT`, or a reference error for the content
/// references.
pub fn validate_close(state: &State, reason: &str) -> Result<(), ZdebugError> {
    if state.lifecycle != "OPEN" {
        return Err(ZdebugError::new("CASE_NOT_OPEN", "Case is not open"));
    }
    if !CLOSE_REASONS.contains(&reason) {
        return Err(ZdebugError::new(
            "INVALID_CLOSE_REASON",
            format!("Invalid close reason: {reason}"),
        ));
    }
    if any_attempt_running(state) {
        return Err(ZdebugError::new(
            "ATTEMPT_RUNNING",
            "Cannot close a Case with a running Experiment",
        ));
    }
    for deliverable in state.deliverables.values() {
        let Some(deliverable) = deliverable.as_object() else {
            continue;
        };
        let required = deliverable
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !required {
            continue;
        }
        let incomplete = incomplete_criteria(deliverable);
        if !incomplete.is_empty() {
            let id = deliverable
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(ZdebugError::with_details(
                "INCOMPLETE_DELIVERABLE",
                format!("Required Deliverable {id} has incomplete criteria"),
                BTreeMap::from([(
                    "criteria".to_owned(),
                    Value::Array(incomplete),
                )]),
            ));
        }
        if !is_truthy(deliverable.get("content_artifact")) {
            let id = deliverable
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(ZdebugError::new(
                "MISSING_DELIVERABLE_CONTENT",
                format!("Deliverable content is missing: {id}"),
            ));
        }
        references_valid(
            state,
            optional_array(deliverable, "content_references"),
        )?;
    }
    if state.final_snapshot.is_none() {
        return Err(ZdebugError::new(
            "MISSING_FINAL_SNAPSHOT",
            "Final workspace snapshot is required before closing",
        ));
    }
    Ok(())
}

// ── Event handlers ───────────────────────────────────────────────────────────

/// Create the Case, optionally recording a verification criterion.
fn handle_case_created(
    state: &mut State,
    event: &Value,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    if !state.case_id.is_empty() {
        return Err(ZdebugError::new(
            "DUPLICATE_CASE",
            "Case has multiple case-created events",
        ));
    }
    let case_id = event
        .get("case_id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_event("Event case_id must be a string"))?;
    let title = str_field(payload, "title")?.to_owned();
    let objective = str_field(payload, "objective")?.to_owned();
    let default_interpreter = payload
        .get("default_interpreter")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let workspaces = required_array(payload, "workspaces")?.to_vec();
    let baseline = required_array(payload, "baseline")?.to_vec();
    let verify = optional_verify(payload)?;

    case_id.clone_into(&mut state.case_id);
    state.title = title;
    state.objective = objective;
    state.default_interpreter = default_interpreter;
    state.workspaces = workspaces;
    state.baseline = baseline;
    state.verify = verify;
    Ok(())
}

/// Register a Deliverable and index its criteria with empty dispositions.
fn handle_deliverable_created(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let id = str_field(payload, "id")?;
    if state.deliverables.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_DELIVERABLE",
            format!("Duplicate Deliverable: {id}"),
        ));
    }
    let mut criteria = Map::new();
    for entry in required_array(payload, "criteria")? {
        let criterion = entry
            .as_object()
            .ok_or_else(|| invalid_event("criterion must be an object"))?;
        let criterion_id = str_field(criterion, "id")?.to_owned();
        let description = str_field(criterion, "description")?.to_owned();
        let mut record = Map::new();
        record.insert("id".to_owned(), Value::String(criterion_id.clone()));
        record.insert("description".to_owned(), Value::String(description));
        record.insert("disposition".to_owned(), Value::Null);
        record.insert("references".to_owned(), Value::Array(Vec::new()));
        record.insert("reason".to_owned(), Value::Null);
        criteria.insert(criterion_id, Value::Object(record));
    }
    let mut record = payload.clone();
    record.insert("criteria".to_owned(), Value::Object(criteria));
    record.insert("content_artifact".to_owned(), Value::Null);
    state.deliverables.insert(id.to_owned(), Value::Object(record));
    Ok(())
}

/// Dispose a single Deliverable criterion.
fn handle_deliverable_criterion_disposed(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let deliverable_id = str_field(payload, "deliverable_id")?;
    let criterion_id = str_field(payload, "criterion_id")?;
    let deliverable = require(
        state.deliverables.get(deliverable_id),
        "deliverable",
        deliverable_id,
    )?;
    let criteria = deliverable
        .get("criteria")
        .and_then(Value::as_object)
        .ok_or_else(|| not_found("criterion", criterion_id))?;
    require(criteria.get(criterion_id), "criterion", criterion_id)?;

    let disposition = str_field(payload, "disposition")?;
    if !CRITERION_DISPOSITIONS.contains(&disposition) {
        return Err(ZdebugError::new(
            "INVALID_DISPOSITION",
            format!("Invalid criterion disposition: {disposition}"),
        ));
    }
    let references = optional_array(payload, "references");
    references_valid(state, references)?;
    if disposition == "satisfied" && !is_truthy(payload.get("references")) {
        return Err(ZdebugError::new(
            "MISSING_REFERENCES",
            "Satisfied criteria require Claim or Evidence references",
        ));
    }
    if matches!(disposition, "blocked" | "waived")
        && !is_truthy(payload.get("reason"))
    {
        return Err(ZdebugError::new(
            "MISSING_REASON",
            format!("{disposition} criteria require a reason"),
        ));
    }

    let deliverable = state
        .deliverables
        .get_mut(deliverable_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("deliverable", deliverable_id))?;
    let criteria = deliverable
        .get_mut("criteria")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("criterion", criterion_id))?;
    let criterion = criteria
        .get_mut(criterion_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("criterion", criterion_id))?;
    criterion.insert(
        "disposition".to_owned(),
        Value::String(disposition.to_owned()),
    );
    criterion
        .insert("references".to_owned(), Value::Array(references.to_vec()));
    criterion.insert(
        "reason".to_owned(),
        payload.get("reason").cloned().unwrap_or(Value::Null),
    );
    Ok(())
}

/// Attach the content artifact and its references to a Deliverable.
fn handle_deliverable_content_attached(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let deliverable_id = str_field(payload, "deliverable_id")?;
    let artifact_id = str_field(payload, "artifact_id")?;
    let references = required_array(payload, "references")?.to_vec();
    require(
        state.deliverables.get(deliverable_id),
        "deliverable",
        deliverable_id,
    )?;
    references_valid(state, &references)?;

    let deliverable = state
        .deliverables
        .get_mut(deliverable_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("deliverable", deliverable_id))?;
    deliverable.insert(
        "content_artifact".to_owned(),
        Value::String(artifact_id.to_owned()),
    );
    deliverable
        .insert("content_references".to_owned(), Value::Array(references));
    Ok(())
}

/// Register a Claim in the open state.
fn handle_claim_created(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let id = str_field(payload, "id")?;
    if state.claims.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_CLAIM",
            format!("Duplicate Claim: {id}"),
        ));
    }
    let mut record = payload.clone();
    record.insert("assessment".to_owned(), Value::String("open".to_owned()));
    record.insert("assessment_reason".to_owned(), Value::Null);
    record.insert("invalidated".to_owned(), Value::Bool(false));
    state.claims.insert(id.to_owned(), Value::Object(record));
    Ok(())
}

/// Record a relation between two Claims.
fn handle_claim_related(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let relation = str_field(payload, "relation")?;
    if !CLAIM_RELATIONS.contains(&relation) {
        return Err(ZdebugError::new(
            "INVALID_CLAIM_RELATION",
            format!("Invalid Claim relation: {relation}"),
        ));
    }
    let source = str_field(payload, "source")?;
    let target = str_field(payload, "target")?;
    require(state.claims.get(source), "claim", source)?;
    require(state.claims.get(target), "claim", target)?;
    if source == target {
        return Err(ZdebugError::new(
            "SELF_RELATION",
            "A Claim cannot relate to itself",
        ));
    }
    state.claim_relations.push(Value::Object(payload.clone()));
    Ok(())
}

/// Assess a Claim against its supporting and challenging Evidence.
fn handle_claim_assessed(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let claim_id = str_field(payload, "claim_id")?;
    require(state.claims.get(claim_id), "claim", claim_id)?;
    let assessment = str_field(payload, "assessment")?;
    if !CLAIM_ASSESSMENTS.contains(&assessment) {
        return Err(ZdebugError::new(
            "INVALID_ASSESSMENT",
            format!("Invalid Claim assessment: {assessment}"),
        ));
    }
    let evidence_refs = optional_array(payload, "evidence");
    references_valid(state, evidence_refs)?;
    let addressed_refs = optional_array(payload, "addressed_challenges");
    let supporting = related_evidence(state, claim_id, "supports");
    let challenges = related_evidence(state, claim_id, "challenges");
    let cited: BTreeSet<String> = evidence_refs
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let addressed: BTreeSet<String> = addressed_refs
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();

    if matches!(assessment, "supported" | "established")
        && supporting.is_disjoint(&cited)
    {
        return Err(ZdebugError::new(
            "MISSING_SUPPORT",
            format!("Assessment {assessment} requires supporting Evidence"),
        ));
    }
    if assessment == "established" {
        let missing: Vec<Value> = challenges
            .difference(&addressed)
            .cloned()
            .map(Value::String)
            .collect();
        if !missing.is_empty() {
            return Err(ZdebugError::with_details(
                "UNADDRESSED_CHALLENGE",
                "Established Claim has unaddressed challenges",
                BTreeMap::from([("missing".to_owned(), Value::Array(missing))]),
            ));
        }
    }
    if assessment == "rejected" && challenges.is_disjoint(&cited) {
        return Err(ZdebugError::new(
            "MISSING_CHALLENGE",
            "Rejected Claim requires challenging Evidence",
        ));
    }

    let claim = state
        .claims
        .get_mut(claim_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("claim", claim_id))?;
    claim.insert("assessment".to_owned(), Value::String(assessment.to_owned()));
    claim.insert(
        "assessment_reason".to_owned(),
        payload.get("reason").cloned().unwrap_or(Value::Null),
    );
    claim.insert(
        "assessment_evidence".to_owned(),
        Value::Array(evidence_refs.to_vec()),
    );
    claim.insert(
        "addressed_challenges".to_owned(),
        Value::Array(addressed_refs.to_vec()),
    );
    Ok(())
}

/// Register a planned Experiment with an empty attempt list.
fn handle_experiment_planned(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let id = str_field(payload, "id")?;
    if state.experiments.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_EXPERIMENT",
            format!("Duplicate Experiment: {id}"),
        ));
    }
    for claim_id in optional_array(payload, "related_claims") {
        let claim_id = claim_id
            .as_str()
            .ok_or_else(|| invalid_event("claim id must be a string"))?;
        require(state.claims.get(claim_id), "claim", claim_id)?;
    }
    let mut record = payload.clone();
    record.insert("attempts".to_owned(), Value::Array(Vec::new()));
    state.experiments.insert(id.to_owned(), Value::Object(record));
    Ok(())
}

/// Start an Experiment attempt, enforcing the single-runner gate.
fn handle_experiment_attempt_started(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let experiment_id = str_field(payload, "experiment_id")?;
    require(state.experiments.get(experiment_id), "experiment", experiment_id)?;
    if any_attempt_running(state) {
        return Err(ZdebugError::new(
            "ATTEMPT_RUNNING",
            "Another Experiment attempt is already running",
        ));
    }
    let experiment = state
        .experiments
        .get_mut(experiment_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let attempts = experiment
        .get_mut("attempts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let mut record = payload.clone();
    record.insert("status".to_owned(), Value::String("running".to_owned()));
    attempts.push(Value::Object(record));
    Ok(())
}

/// Merge a finishing attempt's results.
fn handle_experiment_attempt_finished(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let experiment_id = str_field(payload, "experiment_id")?;
    let attempt_id = str_field(payload, "attempt_id")?;
    require(state.experiments.get(experiment_id), "experiment", experiment_id)?;
    let experiment = state
        .experiments
        .get_mut(experiment_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let attempts = experiment
        .get_mut("attempts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let attempt = attempts
        .iter_mut()
        .find(|attempt| {
            attempt.get("attempt_id").and_then(Value::as_str)
                == Some(attempt_id)
        })
        .ok_or_else(|| {
            ZdebugError::new(
                "ATTEMPT_NOT_FOUND",
                format!("Attempt not found: {attempt_id}"),
            )
        })?;
    let record = attempt
        .as_object_mut()
        .ok_or_else(|| invalid_event("attempt must be an object"))?;
    if record.get("status").and_then(Value::as_str) != Some("running") {
        return Err(ZdebugError::new(
            "ATTEMPT_NOT_RUNNING",
            format!("Attempt is not running: {attempt_id}"),
        ));
    }
    for (key, value) in payload {
        record.insert(key.clone(), value.clone());
    }
    Ok(())
}

/// Mark a crashed attempt as interrupted.
fn handle_experiment_attempt_recovered(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let experiment_id = str_field(payload, "experiment_id")?;
    let attempt_id = str_field(payload, "attempt_id")?;
    require(state.experiments.get(experiment_id), "experiment", experiment_id)?;
    let experiment = state
        .experiments
        .get_mut(experiment_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let attempts = experiment
        .get_mut("attempts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| not_found("experiment", experiment_id))?;
    let attempt = attempts
        .iter_mut()
        .find(|attempt| {
            attempt.get("attempt_id").and_then(Value::as_str)
                == Some(attempt_id)
        })
        .ok_or_else(|| {
            ZdebugError::new(
                "ATTEMPT_NOT_RUNNING",
                format!("Attempt is not recoverable: {attempt_id}"),
            )
        })?;
    let record = attempt
        .as_object_mut()
        .ok_or_else(|| invalid_event("attempt must be an object"))?;
    if record.get("status").and_then(Value::as_str) != Some("running") {
        return Err(ZdebugError::new(
            "ATTEMPT_NOT_RUNNING",
            format!("Attempt is not recoverable: {attempt_id}"),
        ));
    }
    let reason = payload
        .get("reason")
        .cloned()
        .ok_or_else(|| invalid_event("Missing field: reason"))?;
    let finished_at = payload
        .get("finished_at")
        .cloned()
        .ok_or_else(|| invalid_event("Missing field: finished_at"))?;
    record.insert("status".to_owned(), Value::String("interrupted".to_owned()));
    record.insert("recovery_reason".to_owned(), reason);
    record.insert("finished_at".to_owned(), finished_at);
    Ok(())
}

/// Register an Artifact.
fn handle_artifact_created(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let id = str_field(payload, "id")?;
    if state.artifacts.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_ARTIFACT",
            format!("Duplicate Artifact: {id}"),
        ));
    }
    let mut record = payload.clone();
    record.insert("invalidated".to_owned(), Value::Bool(false));
    state.artifacts.insert(id.to_owned(), Value::Object(record));
    Ok(())
}

/// Invalidate an Artifact.
fn handle_artifact_invalidated(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let artifact_id = str_field(payload, "artifact_id")?;
    let reason = payload
        .get("reason")
        .cloned()
        .ok_or_else(|| invalid_event("Missing field: reason"))?;
    let artifact = state
        .artifacts
        .get_mut(artifact_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("artifact", artifact_id))?;
    artifact.insert("invalidated".to_owned(), Value::Bool(true));
    artifact.insert("invalidation_reason".to_owned(), reason);
    Ok(())
}

/// Register Evidence, validating its provenance and attachments.
fn handle_evidence_created(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let id = str_field(payload, "id")?;
    if state.evidence.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_EVIDENCE",
            format!("Duplicate Evidence: {id}"),
        ));
    }
    let provenance = payload
        .get("provenance")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_event("Missing or invalid field: provenance"))?;
    if str_field(provenance, "kind")? == "experiment" {
        let experiment_id = str_field(provenance, "experiment_id")?;
        let attempt_id = str_field(provenance, "attempt_id")?;
        let experiment = require(
            state.experiments.get(experiment_id),
            "experiment",
            experiment_id,
        )?;
        let available = experiment
            .get("attempts")
            .and_then(Value::as_array)
            .is_some_and(|attempts| {
                attempts.iter().any(|attempt| {
                    attempt.get("attempt_id").and_then(Value::as_str)
                        == Some(attempt_id)
                        && attempt.get("status").and_then(Value::as_str)
                            != Some("running")
                })
            });
        if !available {
            return Err(ZdebugError::new(
                "INVALID_PROVENANCE",
                format!(
                    "Attempt is unavailable or still running: {attempt_id}"
                ),
            ));
        }
    }
    for attachment in optional_array(payload, "attachments") {
        let artifact_id = attachment
            .as_str()
            .ok_or_else(|| invalid_event("artifact id must be a string"))?;
        let artifact =
            require(state.artifacts.get(artifact_id), "artifact", artifact_id)?;
        if artifact.get("invalidated").and_then(Value::as_bool) == Some(true) {
            return Err(ZdebugError::new(
                "INVALIDATED_ARTIFACT",
                format!("Artifact is invalidated: {artifact_id}"),
            ));
        }
    }
    let mut record = payload.clone();
    record.insert("invalidated".to_owned(), Value::Bool(false));
    state.evidence.insert(id.to_owned(), Value::Object(record));
    Ok(())
}

/// Invalidate Evidence.
fn handle_evidence_invalidated(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let evidence_id = str_field(payload, "evidence_id")?;
    let reason = payload
        .get("reason")
        .cloned()
        .ok_or_else(|| invalid_event("Missing field: reason"))?;
    let evidence = state
        .evidence
        .get_mut(evidence_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| not_found("evidence", evidence_id))?;
    evidence.insert("invalidated".to_owned(), Value::Bool(true));
    evidence.insert("invalidation_reason".to_owned(), reason);
    Ok(())
}

/// Relate valid Evidence to a Claim.
fn handle_evidence_related(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let relation = str_field(payload, "relation")?;
    if !EVIDENCE_RELATIONS.contains(&relation) {
        return Err(ZdebugError::new(
            "INVALID_EVIDENCE_RELATION",
            format!("Invalid Evidence relation: {relation}"),
        ));
    }
    let evidence_id = str_field(payload, "evidence_id")?;
    let evidence =
        require(state.evidence.get(evidence_id), "evidence", evidence_id)?;
    if evidence.get("invalidated").and_then(Value::as_bool) == Some(true) {
        return Err(ZdebugError::new(
            "INVALIDATED_EVIDENCE",
            format!("Evidence is invalidated: {evidence_id}"),
        ));
    }
    let claim_id = str_field(payload, "claim_id")?;
    require(state.claims.get(claim_id), "claim", claim_id)?;
    state.evidence_relations.push(Value::Object(payload.clone()));
    Ok(())
}

/// Record the final workspace snapshot.
fn handle_workspace_finalized(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    state.final_snapshot = Some(required_array(payload, "snapshots")?.to_vec());
    Ok(())
}

/// Close the Case after passing the delivery gate.
fn handle_case_closed(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let reason = str_field(payload, "reason")?;
    validate_close(state, reason)?;
    "CLOSED".clone_into(&mut state.lifecycle);
    state.close_reason = Some(reason.to_owned());
    Ok(())
}

/// Reopen a closed Case.
fn handle_case_reopened(
    state: &mut State,
    _payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    if state.lifecycle != "CLOSED" {
        return Err(ZdebugError::new(
            "CASE_NOT_CLOSED",
            "Only a closed Case can be reopened",
        ));
    }
    "OPEN".clone_into(&mut state.lifecycle);
    Ok(())
}

/// Record a recovery note.
fn handle_case_recovered(state: &mut State, payload: &Map<String, Value>) {
    state.recoveries.push(Value::Object(payload.clone()));
}

/// Replace the verification criterion, requiring a recorded reason.
fn handle_case_verify_updated(
    state: &mut State,
    payload: &Map<String, Value>,
) -> Result<(), ZdebugError> {
    let verify = payload
        .get("verify")
        .ok_or_else(|| invalid_event("Missing field: verify"))?;
    let criterion = parse_verify(verify)?;
    if !is_truthy(payload.get("reason")) {
        return Err(ZdebugError::new(
            "MISSING_REASON",
            "verify update requires a reason",
        ));
    }
    state.verify = Some(criterion);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Build an `INVALID_EVENT` error for a malformed payload.
fn invalid_event(message: impl Into<String>) -> ZdebugError {
    ZdebugError::new("INVALID_EVENT", message)
}

/// Read a required string field.
fn str_field<'a>(
    map: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ZdebugError> {
    map.get(key).and_then(Value::as_str).ok_or_else(|| {
        invalid_event(format!("Missing or non-string field: {key}"))
    })
}

/// Read a required array field.
fn required_array<'a>(
    map: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a [Value], ZdebugError> {
    map.get(key).and_then(Value::as_array).map(Vec::as_slice).ok_or_else(|| {
        invalid_event(format!("Missing or non-array field: {key}"))
    })
}

/// Read an optional array field, defaulting to empty.
fn optional_array<'a>(map: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    map.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Report whether a JSON value is truthy in the Python sense.
fn is_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(is_truthy_value)
}

/// Report whether a JSON value is truthy when it is present.
fn is_truthy_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        Value::Number(number) => number.as_u64().is_none_or(|n| n != 0),
    }
}

/// Build a `*_NOT_FOUND` error for a missing record.
fn not_found(kind: &str, id: &str) -> ZdebugError {
    let mut chars = kind.chars();
    let label = chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    });
    ZdebugError::new(
        format!("{}_NOT_FOUND", kind.to_uppercase()),
        format!("{label} not found: {id}"),
    )
}

/// Look up a required record, reporting `*_NOT_FOUND` when absent.
fn require<'a>(
    value: Option<&'a Value>,
    kind: &str,
    id: &str,
) -> Result<&'a Map<String, Value>, ZdebugError> {
    value.and_then(Value::as_object).ok_or_else(|| not_found(kind, id))
}

/// Validate that every reference names an existing, selectable record.
fn references_valid(
    state: &State,
    references: &[Value],
) -> Result<(), ZdebugError> {
    for item in references {
        let reference = item.as_str().ok_or_else(|| {
            ZdebugError::new(
                "INVALID_REFERENCE",
                format!("Unsupported reference: {item}"),
            )
        })?;
        if reference.starts_with("CL-") {
            require(state.claims.get(reference), "claim", reference)?;
        } else if reference.starts_with("EV-") {
            let evidence =
                require(state.evidence.get(reference), "evidence", reference)?;
            if evidence.get("invalidated").and_then(Value::as_bool)
                == Some(true)
            {
                return Err(ZdebugError::new(
                    "INVALIDATED_EVIDENCE",
                    format!("Evidence is invalidated: {reference}"),
                ));
            }
        } else {
            return Err(ZdebugError::new(
                "INVALID_REFERENCE",
                format!("Unsupported reference: {reference}"),
            ));
        }
    }
    Ok(())
}

/// Collect valid Evidence ids related to `claim_id` by `relation`.
fn related_evidence(
    state: &State,
    claim_id: &str,
    relation: &str,
) -> BTreeSet<String> {
    state
        .evidence_relations
        .iter()
        .filter_map(|value| {
            let record = value.as_object()?;
            if record.get("claim_id").and_then(Value::as_str) != Some(claim_id)
            {
                return None;
            }
            if record.get("relation").and_then(Value::as_str) != Some(relation)
            {
                return None;
            }
            let evidence_id =
                record.get("evidence_id").and_then(Value::as_str)?;
            let invalidated = state
                .evidence
                .get(evidence_id)
                .and_then(Value::as_object)
                .and_then(|evidence| evidence.get("invalidated"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if invalidated { None } else { Some(evidence_id.to_owned()) }
        })
        .collect()
}

/// Report whether any Experiment attempt is still running.
fn any_attempt_running(state: &State) -> bool {
    state.experiments.values().any(|experiment| {
        experiment.get("attempts").and_then(Value::as_array).is_some_and(
            |attempts| {
                attempts.iter().any(|attempt| {
                    attempt.get("status").and_then(Value::as_str)
                        == Some("running")
                })
            },
        )
    })
}

/// List the ids of a Deliverable's undisposed criteria.
fn incomplete_criteria(deliverable: &Map<String, Value>) -> Vec<Value> {
    deliverable
        .get("criteria")
        .and_then(Value::as_object)
        .map(|criteria| {
            criteria
                .values()
                .filter(|criterion| {
                    criterion.get("disposition").is_none_or(Value::is_null)
                })
                .filter_map(|criterion| criterion.get("id").cloned())
                .collect()
        })
        .unwrap_or_default()
}

/// Validate and clone a verification criterion object.
fn parse_verify(value: &Value) -> Result<Map<String, Value>, ZdebugError> {
    let object = value.as_object().ok_or_else(|| {
        ZdebugError::new("INVALID_VERIFY", "verify must be an object")
    })?;
    let has_command = object
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| !command.is_empty());
    if !has_command {
        return Err(ZdebugError::new(
            "INVALID_VERIFY",
            "verify requires a non-empty command",
        ));
    }
    let source =
        object.get("source").and_then(Value::as_str).ok_or_else(|| {
            ZdebugError::new("INVALID_VERIFY", "verify requires a source")
        })?;
    if !VERIFY_SOURCES.contains(&source) {
        return Err(ZdebugError::new(
            "INVALID_VERIFY_SOURCE",
            format!("Invalid verify source: {source}"),
        ));
    }
    Ok(object.clone())
}

/// Read an optional verification criterion from a `case-created` payload.
fn optional_verify(
    payload: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, ZdebugError> {
    payload
        .get("verify")
        .filter(|value| !value.is_null())
        .map_or(Ok(None), |value| parse_verify(value).map(Some))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build an event envelope at `seq`.
    fn event(event_type: &str, seq: u64, payload: Value) -> Value {
        let mut envelope = Map::new();
        envelope.insert("format_version".to_owned(), json!(1));
        envelope.insert("case_id".to_owned(), json!("case-1"));
        envelope.insert("seq".to_owned(), json!(seq));
        envelope.insert(
            "event_id".to_owned(),
            Value::String(format!("EVT-{seq:06}")),
        );
        envelope
            .insert("timestamp".to_owned(), json!("2026-01-01T00:00:00.000Z"));
        envelope
            .insert("type".to_owned(), Value::String(event_type.to_owned()));
        envelope.insert("payload".to_owned(), payload);
        Value::Object(envelope)
    }

    /// Build a state that has just handled `case-created`.
    fn created() -> State {
        let mut state = State::default();
        let payload = json!({
            "title": "t",
            "objective": "o",
            "workspaces": [],
            "baseline": [],
        });
        apply_event(&mut state, &event("case-created", 1, payload)).unwrap();
        state
    }

    /// Apply an event to a state at the next sequence number.
    fn apply(
        state: &mut State,
        event_type: &str,
        payload: Value,
    ) -> Result<(), ZdebugError> {
        let seq = state.last_seq + 1;
        apply_event(state, &event(event_type, seq, payload))
    }

    /// Add an open Claim.
    fn with_claim(state: &mut State, id: &str) {
        apply(
            state,
            "claim-created",
            json!({"id": id, "statement": "s", "scope": {}}),
        )
        .unwrap();
    }

    /// Add Evidence with a non-experiment provenance.
    fn with_evidence(state: &mut State, id: &str) {
        apply(
            state,
            "evidence-created",
            json!({
                "id": id,
                "statement": "s",
                "provenance": {"kind": "observation"},
            }),
        )
        .unwrap();
    }

    /// Add an Artifact.
    fn with_artifact(state: &mut State, id: &str) {
        apply(state, "artifact-created", json!({"id": id, "storage": "copy"}))
            .unwrap();
    }

    /// Add a required Deliverable with one criterion.
    fn with_deliverable(state: &mut State) {
        apply(
            state,
            "deliverable-created",
            json!({
                "id": "DL-001",
                "title": "fix",
                "contract": "c",
                "required": true,
                "criteria": [{"id": "CR-001", "description": "tests pass"}],
            }),
        )
        .unwrap();
    }

    /// Relate `evidence_id` to `claim_id`.
    fn relate(
        state: &mut State,
        evidence_id: &str,
        relation: &str,
        claim_id: &str,
    ) {
        apply(
            state,
            "evidence-related",
            json!({
                "evidence_id": evidence_id,
                "relation": relation,
                "claim_id": claim_id,
                "reason": "r",
            }),
        )
        .unwrap();
    }

    /// Build a state whose delivery gate is satisfied.
    fn closeable() -> State {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_deliverable(&mut state);
        with_artifact(&mut state, "AR-001");
        apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        apply(
            &mut state,
            "deliverable-content-attached",
            json!({
                "deliverable_id": "DL-001",
                "artifact_id": "AR-001",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        apply(
            &mut state,
            "workspace-finalized",
            json!({"snapshots": [{"kind": "git"}]}),
        )
        .unwrap();
        state
    }

    // ── case-created ────────────────────────────────────────────────────────

    #[test]
    fn test_event_without_sequence_is_invalid() {
        let mut state = State::default();
        let mut missing = event(
            "case-created",
            1,
            json!({"title": "t", "objective": "o", "workspaces": []}),
        );
        missing.as_object_mut().unwrap().remove("seq");
        let err = apply_event(&mut state, &missing).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT");
        assert_eq!(state.last_seq, 0);

        let mut non_integer = event(
            "case-created",
            1,
            json!({"title": "t", "objective": "o", "workspaces": []}),
        );
        non_integer["seq"] = json!("one");
        let err = apply_event(&mut state, &non_integer).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT");
        assert_eq!(state.last_seq, 0);
    }

    #[test]
    fn test_case_created_initializes_state() {
        let mut state = State::default();
        apply_event(
            &mut state,
            &event(
                "case-created",
                1,
                json!({
                    "title": "bug",
                    "objective": "fix it",
                    "workspaces": ["/ws"],
                    "baseline": [{"kind": "git"}],
                    "default_interpreter": "bash",
                }),
            ),
        )
        .unwrap();
        assert_eq!(state.case_id, "case-1");
        assert_eq!(state.lifecycle, "OPEN");
        assert_eq!(state.title, "bug");
        assert_eq!(state.objective, "fix it");
        assert_eq!(state.default_interpreter.as_deref(), Some("bash"));
        assert_eq!(state.workspaces, vec![json!("/ws")]);
        assert_eq!(state.baseline, vec![json!({"kind": "git"})]);
        assert!(state.verify.is_none());
        assert_eq!(state.last_seq, 1);
    }

    #[test]
    fn test_case_created_parses_verify() {
        let mut state = State::default();
        apply_event(
            &mut state,
            &event(
                "case-created",
                1,
                json!({
                    "title": "t",
                    "objective": "o",
                    "workspaces": [],
                    "baseline": [],
                    "verify": {"command": "pytest -q", "source": "user"},
                }),
            ),
        )
        .unwrap();
        let verify = state.verify.as_ref().unwrap();
        assert_eq!(verify["command"], "pytest -q");
        assert_eq!(verify["source"], "user");
    }

    #[test]
    fn test_case_created_verify_requires_command() {
        let mut state = State::default();
        let err = apply_event(
            &mut state,
            &event(
                "case-created",
                1,
                json!({
                    "title": "t",
                    "objective": "o",
                    "workspaces": [],
                    "baseline": [],
                    "verify": {"source": "user"},
                }),
            ),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_VERIFY");
    }

    #[test]
    fn test_case_created_verify_rejects_bad_source() {
        let mut state = State::default();
        let err = apply_event(
            &mut state,
            &event(
                "case-created",
                1,
                json!({
                    "title": "t",
                    "objective": "o",
                    "workspaces": [],
                    "baseline": [],
                    "verify": {"command": "true", "source": "robot"},
                }),
            ),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_VERIFY_SOURCE");
    }

    #[test]
    fn test_duplicate_case_rejected() {
        let mut state = created();
        let err = apply(
            &mut state,
            "case-created",
            json!({
                "title": "t",
                "objective": "o",
                "workspaces": [],
                "baseline": [],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_CASE");
    }

    #[test]
    fn test_event_before_case_created_rejected() {
        let mut state = State::default();
        let err = apply_event(
            &mut state,
            &event("claim-created", 1, json!({"id": "CL-001"})),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_CASE_EVENT");
    }

    #[test]
    fn test_unknown_event_type_rejected() {
        let mut state = created();
        let err = apply(&mut state, "note-added", json!({})).unwrap_err();
        assert_eq!(err.code(), "UNKNOWN_EVENT_TYPE");
    }

    // ── replay ──────────────────────────────────────────────────────────────

    #[test]
    fn test_replay_rejects_empty_stream() {
        assert_eq!(replay(&[]).unwrap_err().code(), "MISSING_CASE_EVENT");
    }

    #[test]
    fn test_replay_requires_case_created_first() {
        let stream = vec![event("claim-created", 1, json!({"id": "CL-001"}))];
        assert_eq!(replay(&stream).unwrap_err().code(), "MISSING_CASE_EVENT");
    }

    /// Events 1-9 of the canonical happy path.
    fn discovery_events() -> Vec<Value> {
        vec![
            event(
                "case-created",
                1,
                json!({
                    "title": "bug",
                    "objective": "fix",
                    "workspaces": [],
                    "baseline": [],
                    "verify": {"command": "true", "source": "user"},
                }),
            ),
            event(
                "claim-created",
                2,
                json!({"id": "CL-001", "statement": "s", "scope": {}}),
            ),
            event(
                "artifact-created",
                3,
                json!({"id": "AR-001", "storage": "copy"}),
            ),
            event(
                "experiment-planned",
                4,
                json!({
                    "id": "EX-001",
                    "question": "q",
                    "procedure_artifact": "AR-001",
                    "related_claims": ["CL-001"],
                }),
            ),
            event(
                "experiment-attempt-started",
                5,
                json!({
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                }),
            ),
            event(
                "experiment-attempt-finished",
                6,
                json!({
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                    "status": "finished",
                    "exit_code": 0,
                }),
            ),
            event(
                "evidence-created",
                7,
                json!({
                    "id": "EV-001",
                    "statement": "s",
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
                8,
                json!({
                    "evidence_id": "EV-001",
                    "relation": "supports",
                    "claim_id": "CL-001",
                    "reason": "r",
                }),
            ),
            event(
                "claim-assessed",
                9,
                json!({
                    "claim_id": "CL-001",
                    "assessment": "established",
                    "reason": "r",
                    "evidence": ["EV-001"],
                    "addressed_challenges": [],
                }),
            ),
        ]
    }

    /// Events 10-14: Deliverable through Case close.
    fn delivery_events() -> Vec<Value> {
        vec![
            event(
                "deliverable-created",
                10,
                json!({
                    "id": "DL-001",
                    "title": "t",
                    "contract": "c",
                    "required": true,
                    "criteria": [{"id": "CR-001", "description": "d"}],
                }),
            ),
            event(
                "deliverable-criterion-disposed",
                11,
                json!({
                    "deliverable_id": "DL-001",
                    "criterion_id": "CR-001",
                    "disposition": "satisfied",
                    "references": ["CL-001"],
                }),
            ),
            event(
                "deliverable-content-attached",
                12,
                json!({
                    "deliverable_id": "DL-001",
                    "artifact_id": "AR-001",
                    "references": ["CL-001"],
                }),
            ),
            event(
                "workspace-finalized",
                13,
                json!({"snapshots": [{"kind": "git"}]}),
            ),
            event("case-closed", 14, json!({"reason": "completed"})),
        ]
    }

    #[test]
    fn test_replay_rebuilds_state_from_full_stream() {
        let mut stream = discovery_events();
        stream.extend(delivery_events());
        let state = replay(&stream).unwrap();
        assert_eq!(state.case_id, "case-1");
        assert_eq!(state.lifecycle, "CLOSED");
        assert_eq!(state.close_reason.as_deref(), Some("completed"));
        assert_eq!(state.last_seq, 14);
        assert_eq!(state.verify.as_ref().unwrap()["command"], "true");
        assert_eq!(state.claims["CL-001"]["assessment"], "established");
        assert_eq!(
            state.deliverables["DL-001"]["criteria"]["CR-001"]["disposition"],
            "satisfied"
        );
        assert_eq!(state.deliverables["DL-001"]["content_artifact"], "AR-001");
        assert!(state.final_snapshot.is_some());
        assert_eq!(state.evidence_relations.len(), 1);
    }

    // ── deliverable ─────────────────────────────────────────────────────────

    #[test]
    fn test_deliverable_created_indexes_criteria() {
        let mut state = created();
        with_deliverable(&mut state);
        let deliverable = &state.deliverables["DL-001"];
        assert_eq!(deliverable["required"], json!(true));
        assert_eq!(
            deliverable["criteria"]["CR-001"]["description"],
            "tests pass"
        );
        assert_eq!(
            deliverable["criteria"]["CR-001"]["disposition"],
            Value::Null
        );
        assert_eq!(deliverable["content_artifact"], Value::Null);
    }

    #[test]
    fn test_duplicate_deliverable_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-created",
            json!({
                "id": "DL-001",
                "title": "t",
                "contract": "c",
                "required": true,
                "criteria": [],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_DELIVERABLE");
    }

    #[test]
    fn test_criterion_disposed_satisfied() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_deliverable(&mut state);
        apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        let criterion = &state.deliverables["DL-001"]["criteria"]["CR-001"];
        assert_eq!(criterion["disposition"], "satisfied");
        assert_eq!(criterion["references"], json!(["CL-001"]));
    }

    #[test]
    fn test_satisfied_criterion_requires_references() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_REFERENCES");
    }

    #[test]
    fn test_invalid_disposition_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "done",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_DISPOSITION");
    }

    #[test]
    fn test_blocked_criterion_requires_reason() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "blocked",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_REASON");
        apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "waived",
                "reason": "out of scope",
            }),
        )
        .unwrap();
        assert_eq!(
            state.deliverables["DL-001"]["criteria"]["CR-001"]["disposition"],
            "waived"
        );
    }

    #[test]
    fn test_criterion_disposed_missing_deliverable() {
        let mut state = created();
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-404",
                "criterion_id": "CR-001",
                "disposition": "waived",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DELIVERABLE_NOT_FOUND");
    }

    #[test]
    fn test_criterion_disposed_missing_criterion() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-404",
                "disposition": "waived",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "CRITERION_NOT_FOUND");
    }

    #[test]
    fn test_reference_unknown_prefix_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["XX-001"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_REFERENCE");
    }

    #[test]
    fn test_reference_missing_claim_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["CL-404"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "CLAIM_NOT_FOUND");
    }

    #[test]
    fn test_satisfied_reference_invalidated_evidence_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        with_evidence(&mut state, "EV-001");
        apply(
            &mut state,
            "evidence-invalidated",
            json!({"evidence_id": "EV-001", "reason": "stale"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["EV-001"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALIDATED_EVIDENCE");
    }

    #[test]
    fn test_content_attached() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_deliverable(&mut state);
        apply(
            &mut state,
            "deliverable-content-attached",
            json!({
                "deliverable_id": "DL-001",
                "artifact_id": "AR-001",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        let deliverable = &state.deliverables["DL-001"];
        assert_eq!(deliverable["content_artifact"], "AR-001");
        assert_eq!(deliverable["content_references"], json!(["CL-001"]));
    }

    #[test]
    fn test_content_attached_missing_deliverable() {
        let mut state = created();
        let err = apply(
            &mut state,
            "deliverable-content-attached",
            json!({
                "deliverable_id": "DL-404",
                "artifact_id": "AR-001",
                "references": [],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DELIVERABLE_NOT_FOUND");
    }

    // ── claim ───────────────────────────────────────────────────────────────

    #[test]
    fn test_claim_created_defaults() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let claim = &state.claims["CL-001"];
        assert_eq!(claim["assessment"], "open");
        assert_eq!(claim["assessment_reason"], Value::Null);
        assert_eq!(claim["invalidated"], json!(false));
    }

    #[test]
    fn test_duplicate_claim_rejected() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-created",
            json!({"id": "CL-001", "statement": "s", "scope": {}}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_CLAIM");
    }

    #[test]
    fn test_claim_related_recorded() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_claim(&mut state, "CL-002");
        apply(
            &mut state,
            "claim-related",
            json!({
                "source": "CL-001",
                "relation": "refines",
                "target": "CL-002",
                "reason": "r",
            }),
        )
        .unwrap();
        assert_eq!(state.claim_relations.len(), 1);
    }

    #[test]
    fn test_invalid_claim_relation_rejected() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_claim(&mut state, "CL-002");
        let err = apply(
            &mut state,
            "claim-related",
            json!({
                "source": "CL-001",
                "relation": "supports",
                "target": "CL-002",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_CLAIM_RELATION");
    }

    #[test]
    fn test_self_relation_rejected() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-related",
            json!({
                "source": "CL-001",
                "relation": "refines",
                "target": "CL-001",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "SELF_RELATION");
    }

    #[test]
    fn test_claim_related_missing_target() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-related",
            json!({
                "source": "CL-001",
                "relation": "refines",
                "target": "CL-404",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "CLAIM_NOT_FOUND");
    }

    #[test]
    fn test_invalid_assessment_rejected() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "maybe",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_ASSESSMENT");
    }

    #[test]
    fn test_supported_assessment_requires_support() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "supported",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_SUPPORT");

        with_evidence(&mut state, "EV-001");
        relate(&mut state, "EV-001", "supports", "CL-001");
        apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "supported",
                "reason": "r",
                "evidence": ["EV-001"],
            }),
        )
        .unwrap();
        assert_eq!(state.claims["CL-001"]["assessment"], "supported");
    }

    #[test]
    fn test_established_requires_addressed_challenges() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_evidence(&mut state, "EV-001");
        with_evidence(&mut state, "EV-002");
        relate(&mut state, "EV-001", "supports", "CL-001");
        relate(&mut state, "EV-002", "challenges", "CL-001");
        let err = apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "established",
                "reason": "r",
                "evidence": ["EV-001"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "UNADDRESSED_CHALLENGE");
        assert_eq!(err.details()["missing"], json!(["EV-002"]));

        apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "established",
                "reason": "r",
                "evidence": ["EV-001"],
                "addressed_challenges": ["EV-002"],
            }),
        )
        .unwrap();
        assert_eq!(state.claims["CL-001"]["assessment"], "established");
        assert_eq!(
            state.claims["CL-001"]["addressed_challenges"],
            json!(["EV-002"])
        );
    }

    #[test]
    fn test_invalidated_challenge_not_required() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_evidence(&mut state, "EV-001");
        with_evidence(&mut state, "EV-002");
        relate(&mut state, "EV-001", "supports", "CL-001");
        relate(&mut state, "EV-002", "challenges", "CL-001");
        apply(
            &mut state,
            "evidence-invalidated",
            json!({"evidence_id": "EV-002", "reason": "stale"}),
        )
        .unwrap();
        apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "established",
                "reason": "r",
                "evidence": ["EV-001"],
            }),
        )
        .unwrap();
        assert_eq!(state.claims["CL-001"]["assessment"], "established");
    }

    #[test]
    fn test_rejected_assessment_requires_challenge() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        let err = apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "rejected",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_CHALLENGE");

        with_evidence(&mut state, "EV-001");
        relate(&mut state, "EV-001", "challenges", "CL-001");
        apply(
            &mut state,
            "claim-assessed",
            json!({
                "claim_id": "CL-001",
                "assessment": "rejected",
                "reason": "r",
                "evidence": ["EV-001"],
            }),
        )
        .unwrap();
        assert_eq!(state.claims["CL-001"]["assessment"], "rejected");
    }

    // ── experiment ──────────────────────────────────────────────────────────

    #[test]
    fn test_experiment_planned_records_attempts() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        apply(
            &mut state,
            "experiment-planned",
            json!({
                "id": "EX-001",
                "question": "q",
                "procedure_artifact": "AR-001",
                "related_claims": ["CL-001"],
            }),
        )
        .unwrap();
        assert_eq!(state.experiments["EX-001"]["attempts"], json!([]));
    }

    #[test]
    fn test_duplicate_experiment_rejected() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_EXPERIMENT");
    }

    #[test]
    fn test_experiment_related_claim_missing() {
        let mut state = created();
        let err = apply(
            &mut state,
            "experiment-planned",
            json!({
                "id": "EX-001",
                "question": "q",
                "related_claims": ["CL-404"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "CLAIM_NOT_FOUND");
    }

    #[test]
    fn test_attempt_started_and_finished() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        assert_eq!(
            state.experiments["EX-001"]["attempts"][0]["status"],
            "running"
        );
        apply(
            &mut state,
            "experiment-attempt-finished",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "status": "finished",
                "exit_code": 0,
            }),
        )
        .unwrap();
        let attempt = &state.experiments["EX-001"]["attempts"][0];
        assert_eq!(attempt["status"], "finished");
        assert_eq!(attempt["exit_code"], 0);
    }

    #[test]
    fn test_second_attempt_running_rejected() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A002"}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_RUNNING");
    }

    #[test]
    fn test_attempt_finished_not_found() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "experiment-attempt-finished",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "status": "finished",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_NOT_FOUND");
    }

    #[test]
    fn test_attempt_finished_not_running() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-finished",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "status": "finished",
            }),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "experiment-attempt-finished",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "status": "finished",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_NOT_RUNNING");
    }

    #[test]
    fn test_attempt_recovered() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-recovered",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "reason": "crashed",
                "finished_at": "2026-01-01T00:00:01.000Z",
            }),
        )
        .unwrap();
        let attempt = &state.experiments["EX-001"]["attempts"][0];
        assert_eq!(attempt["status"], "interrupted");
        assert_eq!(attempt["recovery_reason"], "crashed");
    }

    #[test]
    fn test_attempt_recovered_not_running() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "experiment-attempt-recovered",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "reason": "crashed",
                "finished_at": "2026-01-01T00:00:01.000Z",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_NOT_RUNNING");
    }

    // ── artifact ────────────────────────────────────────────────────────────

    #[test]
    fn test_artifact_created_and_duplicate() {
        let mut state = created();
        with_artifact(&mut state, "AR-001");
        assert_eq!(state.artifacts["AR-001"]["invalidated"], json!(false));
        let err = apply(
            &mut state,
            "artifact-created",
            json!({"id": "AR-001", "storage": "copy"}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_ARTIFACT");
    }

    #[test]
    fn test_artifact_invalidated() {
        let mut state = created();
        with_artifact(&mut state, "AR-001");
        apply(
            &mut state,
            "artifact-invalidated",
            json!({"artifact_id": "AR-001", "reason": "stale"}),
        )
        .unwrap();
        let artifact = &state.artifacts["AR-001"];
        assert_eq!(artifact["invalidated"], json!(true));
        assert_eq!(artifact["invalidation_reason"], "stale");
    }

    #[test]
    fn test_artifact_invalidated_not_found() {
        let mut state = created();
        let err = apply(
            &mut state,
            "artifact-invalidated",
            json!({"artifact_id": "AR-404", "reason": "stale"}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ARTIFACT_NOT_FOUND");
    }

    // ── evidence ────────────────────────────────────────────────────────────

    #[test]
    fn test_evidence_created_and_duplicate() {
        let mut state = created();
        with_evidence(&mut state, "EV-001");
        assert_eq!(state.evidence["EV-001"]["invalidated"], json!(false));
        let err = apply(
            &mut state,
            "evidence-created",
            json!({
                "id": "EV-001",
                "statement": "s",
                "provenance": {"kind": "observation"},
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_EVIDENCE");
    }

    #[test]
    fn test_evidence_related_requires_valid_evidence() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_evidence(&mut state, "EV-001");
        relate(&mut state, "EV-001", "supports", "CL-001");
        assert_eq!(state.evidence_relations.len(), 1);

        let err = apply(
            &mut state,
            "evidence-related",
            json!({
                "evidence_id": "EV-001",
                "relation": "references",
                "claim_id": "CL-001",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_EVIDENCE_RELATION");
    }

    #[test]
    fn test_evidence_related_rejects_invalidated_evidence() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_evidence(&mut state, "EV-001");
        apply(
            &mut state,
            "evidence-invalidated",
            json!({"evidence_id": "EV-001", "reason": "stale"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "evidence-related",
            json!({
                "evidence_id": "EV-001",
                "relation": "supports",
                "claim_id": "CL-001",
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALIDATED_EVIDENCE");
    }

    #[test]
    fn test_evidence_provenance_requires_finished_attempt() {
        let mut state = created();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "evidence-created",
            json!({
                "id": "EV-001",
                "statement": "s",
                "provenance": {
                    "kind": "experiment",
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                },
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_PROVENANCE");

        apply(
            &mut state,
            "experiment-attempt-finished",
            json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "status": "finished",
            }),
        )
        .unwrap();
        apply(
            &mut state,
            "evidence-created",
            json!({
                "id": "EV-001",
                "statement": "s",
                "provenance": {
                    "kind": "experiment",
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                },
            }),
        )
        .unwrap();
        assert_eq!(state.evidence["EV-001"]["invalidated"], json!(false));
    }

    #[test]
    fn test_evidence_attachment_invalidated_artifact_rejected() {
        let mut state = created();
        with_artifact(&mut state, "AR-001");
        apply(
            &mut state,
            "artifact-invalidated",
            json!({"artifact_id": "AR-001", "reason": "stale"}),
        )
        .unwrap();
        let err = apply(
            &mut state,
            "evidence-created",
            json!({
                "id": "EV-001",
                "statement": "s",
                "provenance": {"kind": "observation"},
                "attachments": ["AR-001"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALIDATED_ARTIFACT");
    }

    #[test]
    fn test_evidence_attachment_missing_artifact_rejected() {
        let mut state = created();
        let err = apply(
            &mut state,
            "evidence-created",
            json!({
                "id": "EV-001",
                "statement": "s",
                "provenance": {"kind": "observation"},
                "attachments": ["AR-404"],
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ARTIFACT_NOT_FOUND");
    }

    #[test]
    fn test_evidence_invalidated_not_found() {
        let mut state = created();
        let err = apply(
            &mut state,
            "evidence-invalidated",
            json!({"evidence_id": "EV-404", "reason": "stale"}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "EVIDENCE_NOT_FOUND");
    }

    // ── workspace, recovery, verify ─────────────────────────────────────────

    #[test]
    fn test_workspace_finalized_sets_snapshot() {
        let mut state = created();
        apply(
            &mut state,
            "workspace-finalized",
            json!({"snapshots": [{"kind": "git"}]}),
        )
        .unwrap();
        assert_eq!(state.final_snapshot, Some(vec![json!({"kind": "git"})]));
    }

    #[test]
    fn test_case_recovered_appends() {
        let mut state = created();
        apply(
            &mut state,
            "case-recovered",
            json!({"reason": "truncated-tail", "artifact": "a.bin"}),
        )
        .unwrap();
        assert_eq!(state.recoveries.len(), 1);
        assert_eq!(state.recoveries[0]["reason"], "truncated-tail");
    }

    #[test]
    fn test_case_verify_updated() {
        let mut state = created();
        apply(
            &mut state,
            "case-verify-updated",
            json!({
                "verify": {"command": "pytest -x", "source": "agent"},
                "reason": "narrower reproduction",
            }),
        )
        .unwrap();
        let verify = state.verify.as_ref().unwrap();
        assert_eq!(verify["command"], "pytest -x");
        assert_eq!(verify["source"], "agent");
    }

    #[test]
    fn test_case_verify_updated_requires_reason() {
        let mut state = created();
        let err = apply(
            &mut state,
            "case-verify-updated",
            json!({"verify": {"command": "true", "source": "agent"}}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "MISSING_REASON");
    }

    #[test]
    fn test_case_verify_updated_rejects_bad_source() {
        let mut state = created();
        let err = apply(
            &mut state,
            "case-verify-updated",
            json!({
                "verify": {"command": "true", "source": "robot"},
                "reason": "r",
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_VERIFY_SOURCE");
    }

    // ── close gate ──────────────────────────────────────────────────────────

    #[test]
    fn test_close_happy_path() {
        let mut state = closeable();
        apply(&mut state, "case-closed", json!({"reason": "completed"}))
            .unwrap();
        assert_eq!(state.lifecycle, "CLOSED");
        assert_eq!(state.close_reason.as_deref(), Some("completed"));
    }

    #[test]
    fn test_close_not_open_rejected() {
        let mut state = closeable();
        apply(&mut state, "case-closed", json!({"reason": "completed"}))
            .unwrap();
        let err =
            apply(&mut state, "case-closed", json!({"reason": "completed"}))
                .unwrap_err();
        assert_eq!(err.code(), "CASE_NOT_OPEN");
    }

    #[test]
    fn test_close_invalid_reason_rejected() {
        let mut state = closeable();
        let err = apply(&mut state, "case-closed", json!({"reason": "nope"}))
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_CLOSE_REASON");
    }

    #[test]
    fn test_close_incomplete_deliverable_rejected() {
        let mut state = created();
        with_deliverable(&mut state);
        apply(
            &mut state,
            "deliverable-content-attached",
            json!({
                "deliverable_id": "DL-001",
                "artifact_id": "AR-001",
                "references": [],
            }),
        )
        .unwrap();
        apply(&mut state, "workspace-finalized", json!({"snapshots": []}))
            .unwrap();
        let err =
            apply(&mut state, "case-closed", json!({"reason": "completed"}))
                .unwrap_err();
        assert_eq!(err.code(), "INCOMPLETE_DELIVERABLE");
        assert_eq!(err.details()["criteria"], json!(["CR-001"]));
    }

    #[test]
    fn test_close_missing_deliverable_content_rejected() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_deliverable(&mut state);
        apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        apply(&mut state, "workspace-finalized", json!({"snapshots": []}))
            .unwrap();
        let err =
            apply(&mut state, "case-closed", json!({"reason": "completed"}))
                .unwrap_err();
        assert_eq!(err.code(), "MISSING_DELIVERABLE_CONTENT");
    }

    #[test]
    fn test_close_requires_final_snapshot() {
        let mut state = created();
        with_claim(&mut state, "CL-001");
        with_deliverable(&mut state);
        with_artifact(&mut state, "AR-001");
        apply(
            &mut state,
            "deliverable-criterion-disposed",
            json!({
                "deliverable_id": "DL-001",
                "criterion_id": "CR-001",
                "disposition": "satisfied",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        apply(
            &mut state,
            "deliverable-content-attached",
            json!({
                "deliverable_id": "DL-001",
                "artifact_id": "AR-001",
                "references": ["CL-001"],
            }),
        )
        .unwrap();
        let err =
            apply(&mut state, "case-closed", json!({"reason": "completed"}))
                .unwrap_err();
        assert_eq!(err.code(), "MISSING_FINAL_SNAPSHOT");
    }

    #[test]
    fn test_close_with_running_attempt_rejected() {
        let mut state = closeable();
        apply(
            &mut state,
            "experiment-planned",
            json!({"id": "EX-001", "question": "q"}),
        )
        .unwrap();
        apply(
            &mut state,
            "experiment-attempt-started",
            json!({"experiment_id": "EX-001", "attempt_id": "EX-001-A001"}),
        )
        .unwrap();
        let err =
            apply(&mut state, "case-closed", json!({"reason": "completed"}))
                .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_RUNNING");
    }

    #[test]
    fn test_close_skips_optional_deliverable() {
        let mut state = closeable();
        apply(
            &mut state,
            "deliverable-created",
            json!({
                "id": "DL-002",
                "title": "extra",
                "contract": "c",
                "required": false,
                "criteria": [{"id": "CR-001", "description": "d"}],
            }),
        )
        .unwrap();
        apply(&mut state, "case-closed", json!({"reason": "completed"}))
            .unwrap();
        assert_eq!(state.lifecycle, "CLOSED");
    }

    #[test]
    fn test_reopen_after_close() {
        let mut state = closeable();
        apply(&mut state, "case-closed", json!({"reason": "completed"}))
            .unwrap();
        apply(&mut state, "case-reopened", json!({})).unwrap();
        assert_eq!(state.lifecycle, "OPEN");
    }

    #[test]
    fn test_reopen_not_closed_rejected() {
        let mut state = created();
        let err = apply(&mut state, "case-reopened", json!({})).unwrap_err();
        assert_eq!(err.code(), "CASE_NOT_CLOSED");
    }

    #[test]
    fn test_validate_close_directly() {
        let state = closeable();
        assert!(validate_close(&state, "cancelled").is_ok());
        assert_eq!(
            validate_close(&state, "bogus").unwrap_err().code(),
            "INVALID_CLOSE_REASON"
        );
    }
}
