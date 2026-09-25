//! Append-only event storage for a Case.
//!
//! A Case is a single `case.jsonl` file holding one canonical-JSON event
//! envelope per line. Events are appended under an exclusive non-blocking
//! lock and `fsync`ed immediately, so a crash can leave at most a
//! truncated final line. [`EventStore::read_events`] validates the whole
//! envelope chain, and [`EventStore::recover_truncated_tail`] quarantines a
//! damaged tail before truncating the log back to its last complete event.
//!
//! The store mirrors the reference Python `EventStore` but serializes with
//! this crate's [`canonical_json`]; byte compatibility with the Python
//! encoding is not required.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::util::{
    ZdebugError, canonical_json, relative_case_path, resolve_path, utc_now,
    validate_id,
};

/// The only event envelope format version this store understands.
pub const FORMAT_VERSION: u64 = 1;

/// The name of the append-only event log inside a Case directory.
const EVENTS_FILE: &str = "case.jsonl";

/// The name of the exclusive operation lock file inside a Case directory.
const LOCK_FILE: &str = "operation.lock";

// ── Event store ──────────────────────────────────────────────────────────────

/// Append-only event log rooted at a Case directory.
#[derive(Debug)]
pub struct EventStore {
    case_dir: PathBuf,
    events_path: PathBuf,
    lock_path: PathBuf,
}

impl EventStore {
    /// Open the store rooted at `case_dir`.
    ///
    /// The path is resolved (following symlinks where possible) but the
    /// directory itself is not created until a lock is taken.
    #[must_use]
    pub fn new(case_dir: &Path) -> Self {
        let case_dir = resolve_path(case_dir);
        let events_path = case_dir.join(EVENTS_FILE);
        let lock_path = case_dir.join(LOCK_FILE);
        Self { case_dir, events_path, lock_path }
    }

    /// Acquire the Case's exclusive operation lock without blocking.
    ///
    /// The Case directory is created if missing, and the returned guard
    /// releases the advisory lock when it is dropped.
    ///
    /// # Errors
    ///
    /// Returns [`ZdebugError`] with code `CASE_BUSY` when another operation
    /// already holds the lock, or `IO_ERROR` when the lock file cannot be
    /// opened or created.
    pub fn lock(&self) -> Result<CaseLock, ZdebugError> {
        fs::create_dir_all(&self.case_dir)?;
        let file = zutil::fileio::try_acquire_file_lock(&self.lock_path)
            .map_err(|err| {
                if err.kind() == io::ErrorKind::WouldBlock {
                    ZdebugError::new(
                        "CASE_BUSY",
                        format!(
                            "Case has another active operation: {}",
                            self.case_dir.display()
                        ),
                    )
                } else {
                    ZdebugError::from(err)
                }
            })?;
        Ok(CaseLock { _file: file })
    }

    /// Read and validate every event in the log.
    ///
    /// Returns the parsed events plus any unconsumed trailing bytes. When
    /// `allow_truncated_tail` is set, a final line that is not
    /// newline-terminated or is not valid JSON is returned as the tail
    /// instead of raising an error.
    ///
    /// # Errors
    ///
    /// Returns [`ZdebugError`] with code `CASE_NOT_FOUND` when the log is
    /// missing, `TRUNCATED_EVENT` when a line lacks its terminating newline,
    /// `INVALID_EVENT_JSON` when a line is not valid JSON, or one of the
    /// envelope codes (`UNSUPPORTED_FORMAT`, `BROKEN_EVENT_SEQUENCE`,
    /// `INVALID_EVENT_ID`, `INVALID_EVENT`, `INVALID_ID`).
    pub fn read_events(
        &self,
        allow_truncated_tail: bool,
    ) -> Result<(Vec<Value>, Vec<u8>), ZdebugError> {
        if !self.events_path.exists() {
            return Err(ZdebugError::new(
                "CASE_NOT_FOUND",
                format!("Case not found: {}", self.case_dir.display()),
            ));
        }
        let raw = fs::read(&self.events_path)?;
        let mut events: Vec<Value> = Vec::new();
        let mut seen_ids: BTreeSet<String> = BTreeSet::new();
        let mut expected_seq = 1_u64;
        let mut valid_bytes = 0_usize;
        let mut start = 0_usize;
        while start < raw.len() {
            let line_number = events.len() + 1;
            let Some(offset) = raw[start..].iter().position(|&b| b == b'\n')
            else {
                // No terminating newline: the remainder is a partial line.
                if allow_truncated_tail {
                    return Ok((events, raw[valid_bytes..].to_vec()));
                }
                return Err(ZdebugError::new(
                    "TRUNCATED_EVENT",
                    format!(
                        "Event line {line_number} is not newline-terminated"
                    ),
                ));
            };
            let end = start + offset + 1;
            let line = &raw[start..end];
            match serde_json::from_slice::<Value>(line) {
                Ok(event) => {
                    validate_envelope(&event, expected_seq, &seen_ids)?;
                    if let Some(id) =
                        event.get("event_id").and_then(Value::as_str)
                    {
                        seen_ids.insert(id.to_owned());
                    }
                    events.push(event);
                    expected_seq += 1;
                    valid_bytes = end;
                    start = end;
                }
                Err(err) => {
                    // A corrupt last line is tolerated as a truncated tail;
                    // corruption in the middle of the log is fatal.
                    if allow_truncated_tail && end == raw.len() {
                        return Ok((events, raw[valid_bytes..].to_vec()));
                    }
                    return Err(ZdebugError::new(
                        "INVALID_EVENT_JSON",
                        format!("Invalid event line {line_number}: {err}"),
                    ));
                }
            }
        }
        Ok((events, Vec::new()))
    }

    /// Append an event while the caller already holds the Case lock.
    ///
    /// # Errors
    ///
    /// Returns `TRUNCATED_EVENT` when the log has a damaged tail that must
    /// be recovered first, `CASE_NOT_FOUND` when the log holds no events, or
    /// an I/O error when the write or `fsync` fails.
    pub fn append_locked(
        &self,
        event_type: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        let (events, tail) = self.read_events(false)?;
        if !tail.is_empty() {
            return Err(ZdebugError::new(
                "TRUNCATED_EVENT",
                "Recover the Case before appending",
            ));
        }
        let case_id = events
            .first()
            .and_then(|event| event.get("case_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ZdebugError::new(
                    "CASE_NOT_FOUND",
                    format!("Case has no events: {}", self.case_dir.display()),
                )
            })?
            .to_owned();
        let seq = events.len() as u64 + 1;
        let event = build_event(&case_id, seq, event_type, payload);
        self.write_event(&event, false)?;
        Ok(event)
    }

    /// Create a new Case with its `case-created` event while the caller
    /// holds the Case lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_EXISTS` when the log already exists, `INVALID_ID` when
    /// `case_id` is malformed, or an I/O error when the write or `fsync`
    /// fails.
    pub fn initialize_locked(
        &self,
        case_id: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        if self.events_path.exists() {
            return Err(ZdebugError::new(
                "CASE_EXISTS",
                format!("Case already exists: {}", self.case_dir.display()),
            ));
        }
        validate_id(case_id, "case id")?;
        let event = build_event(case_id, 1, "case-created", payload);
        self.write_event(&event, true)?;
        Ok(event)
    }

    /// Quarantine a damaged tail and truncate the log back to its last
    /// complete event, while the caller holds the Case lock.
    ///
    /// The damaged bytes are saved to
    /// `artifacts/recovery/truncated-tail-<seq>.bin`, where `<seq>` is the
    /// next event sequence number, the log is truncated to the last valid
    /// line boundary, and a `case-recovered` event is appended recording
    /// the artifact. Returns that recovery event, or `None` when the log
    /// has no damaged tail.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the tail cannot be saved or the log cannot
    /// be truncated, or any code produced by [`Self::append_locked`].
    pub fn recover_truncated_tail_locked(
        &self,
    ) -> Result<Option<Value>, ZdebugError> {
        let (events, tail) = self.read_events(true)?;
        if tail.is_empty() {
            return Ok(None);
        }
        let recovery_dir = self.case_dir.join("artifacts").join("recovery");
        fs::create_dir_all(&recovery_dir)?;
        // Name the artifact after the next event sequence number so two
        // recoveries cannot overwrite each other's evidence; a completed
        // recovery appends a `case-recovered` event, which advances the
        // number for the next one.
        let tail_path = recovery_tail_path(&recovery_dir, events.len() + 1);
        fs::write(&tail_path, &tail)?;

        let valid_size: usize =
            events.iter().map(|event| canonical_json(event).len() + 1).sum();
        let log = OpenOptions::new().write(true).open(&self.events_path)?;
        log.set_len(valid_size as u64)?;
        log.sync_all()?;

        let artifact = relative_case_path(&tail_path, &self.case_dir)?;
        let event = self.append_locked(
            "case-recovered",
            &json!({"reason": "truncated-tail", "artifact": artifact}),
        )?;
        Ok(Some(event))
    }

    /// Append an event under the Case lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, or the
    /// same codes as [`Self::append_locked`].
    pub fn append(
        &self,
        event_type: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        let _lock = self.lock()?;
        self.append_locked(event_type, payload)
    }

    /// Create a new Case under the Case lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, or the
    /// same codes as [`Self::initialize_locked`].
    pub fn initialize(
        &self,
        case_id: &str,
        payload: &Value,
    ) -> Result<Value, ZdebugError> {
        let _lock = self.lock()?;
        self.initialize_locked(case_id, payload)
    }

    /// Recover a damaged tail under the Case lock.
    ///
    /// # Errors
    ///
    /// Returns `CASE_BUSY` when another operation holds the lock, or the
    /// same codes as [`Self::recover_truncated_tail_locked`].
    pub fn recover_truncated_tail(&self) -> Result<Option<Value>, ZdebugError> {
        let _lock = self.lock()?;
        self.recover_truncated_tail_locked()
    }

    /// Append `event` to the log, flushing it to stable storage.
    ///
    /// When `create` is set the log is created exclusively and must not
    /// already exist; otherwise it must already exist and is opened for
    /// append. The write is unbuffered and followed by an `fsync`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the log cannot be opened, written, or
    /// `fsync`ed.
    fn write_event(
        &self,
        event: &Value,
        create: bool,
    ) -> Result<(), ZdebugError> {
        let mut options = OpenOptions::new();
        options.write(true);
        if create {
            options.create_new(true);
        } else {
            options.append(true);
        }
        let mut file = options.open(&self.events_path)?;
        let encoded = format!("{}\n", canonical_json(event));
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
        Ok(())
    }
}

// ── Recovery artifacts ───────────────────────────────────────────────────────

/// Pick a free `truncated-tail-<seq>.bin` path under `recovery_dir`.
///
/// The starting `seq` follows the reference Python naming (the next event
/// sequence number). Because every completed recovery appends a
/// `case-recovered` event, consecutive recoveries start from increasing
/// numbers; the existence check additionally covers a recovery that was
/// interrupted after saving its artifact but before appending its event.
#[must_use]
fn recovery_tail_path(recovery_dir: &Path, seq: usize) -> PathBuf {
    let mut index = seq;
    loop {
        let candidate =
            recovery_dir.join(format!("truncated-tail-{index:06}.bin"));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

// ── Lock guard ───────────────────────────────────────────────────────────────

/// Exclusive lock guard on a Case's operation lock file.
///
/// The underlying advisory lock is released when the guard is dropped.
#[derive(Debug)]
pub struct CaseLock {
    _file: File,
}

// ── Envelope ─────────────────────────────────────────────────────────────────

/// Build a canonical event envelope at `seq`.
fn build_event(
    case_id: &str,
    seq: u64,
    event_type: &str,
    payload: &Value,
) -> Value {
    let mut map = Map::new();
    map.insert("format_version".to_owned(), json!(FORMAT_VERSION));
    map.insert("case_id".to_owned(), Value::String(case_id.to_owned()));
    map.insert("seq".to_owned(), json!(seq));
    map.insert("event_id".to_owned(), Value::String(format!("EVT-{seq:06}")));
    map.insert("timestamp".to_owned(), Value::String(utc_now()));
    map.insert("type".to_owned(), Value::String(event_type.to_owned()));
    map.insert("payload".to_owned(), payload.clone());
    Value::Object(map)
}

/// Validate one event envelope at `expected_seq`, given the ids already
/// seen earlier in the log.
///
/// # Errors
///
/// Returns [`ZdebugError`] with the envelope-specific code `INVALID_EVENT`,
/// `UNSUPPORTED_FORMAT`, `BROKEN_EVENT_SEQUENCE`, `INVALID_EVENT_ID`, or
/// `INVALID_ID`.
fn validate_envelope(
    event: &Value,
    expected_seq: u64,
    seen_ids: &BTreeSet<String>,
) -> Result<(), ZdebugError> {
    let Value::Object(map) = event else {
        return Err(ZdebugError::new(
            "INVALID_EVENT",
            "Event must be a JSON object",
        ));
    };
    if map.get("format_version").and_then(Value::as_u64) != Some(FORMAT_VERSION)
    {
        let found = map
            .get("format_version")
            .map_or_else(|| "missing".to_owned(), Value::to_string);
        return Err(ZdebugError::new(
            "UNSUPPORTED_FORMAT",
            format!("Unsupported event format: {found}"),
        ));
    }
    if map.get("seq").and_then(Value::as_u64) != Some(expected_seq) {
        let found = map
            .get("seq")
            .map_or_else(|| "missing".to_owned(), Value::to_string);
        return Err(ZdebugError::new(
            "BROKEN_EVENT_SEQUENCE",
            format!("Expected event sequence {expected_seq}, found {found}"),
        ));
    }
    let expected_id = format!("EVT-{expected_seq:06}");
    let Some(event_id) = map.get("event_id").and_then(Value::as_str) else {
        return Err(ZdebugError::new(
            "INVALID_EVENT_ID",
            format!("Expected event id {expected_id}"),
        ));
    };
    // The id must match the sequence position and must not repeat an id
    // already claimed by an earlier event.
    if event_id != expected_id || seen_ids.contains(event_id) {
        return Err(ZdebugError::new(
            "INVALID_EVENT_ID",
            format!("Expected event id {expected_id}"),
        ));
    }
    let case_id = map.get("case_id").and_then(Value::as_str).unwrap_or("");
    validate_id(case_id, "case id")?;
    if !map.get("timestamp").is_some_and(Value::is_string)
        || !map.get("type").is_some_and(Value::is_string)
    {
        return Err(ZdebugError::new(
            "INVALID_EVENT",
            "Event timestamp and type must be strings",
        ));
    }
    if !map.get("payload").is_some_and(Value::is_object) {
        return Err(ZdebugError::new(
            "INVALID_EVENT",
            "Event payload must be an object",
        ));
    }
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests that take the Case lock.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_guard()
    }

    /// Build a store over `dir`.
    fn store(dir: &Path) -> EventStore {
        EventStore::new(dir)
    }

    /// A representative Case payload.
    fn sample_payload() -> Value {
        json!({"title": "t", "objective": "o"})
    }

    /// Write `events` (one canonical line each) plus a raw `tail` to the log.
    fn write_log(dir: &Path, events: &[Value], tail: &[u8]) {
        let mut bytes: Vec<u8> = events
            .iter()
            .flat_map(|event| {
                format!("{}\n", canonical_json(event)).into_bytes()
            })
            .collect();
        bytes.extend_from_slice(tail);
        fs::write(dir.join(EVENTS_FILE), bytes).unwrap();
    }

    /// Read the raw bytes of the Case log.
    fn log_bytes(dir: &Path) -> Vec<u8> {
        fs::read(dir.join(EVENTS_FILE)).unwrap()
    }

    #[test]
    fn test_read_events_missing_case() {
        let dir = tempfile::tempdir().unwrap();
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "CASE_NOT_FOUND");
    }

    #[test]
    fn test_initialize_then_read_roundtrip() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let created = store.initialize("case-1", &sample_payload()).unwrap();
        assert_eq!(created["seq"], 1);
        assert_eq!(created["event_id"], "EVT-000001");
        assert_eq!(created["type"], "case-created");
        assert_eq!(created["format_version"], FORMAT_VERSION);

        let (events, tail) = store.read_events(false).unwrap();
        assert_eq!(events, vec![created]);
        assert!(tail.is_empty());
    }

    #[test]
    fn test_initialize_existing_case_rejected() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();
        let err = store.initialize("case-1", &sample_payload()).unwrap_err();
        assert_eq!(err.code(), "CASE_EXISTS");
    }

    #[test]
    fn test_initialize_rejects_bad_case_id() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let err = store.initialize("bad id", &sample_payload()).unwrap_err();
        assert_eq!(err.code(), "INVALID_ID");
    }

    #[test]
    fn test_append_reads_back_byte_identical() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let created = store.initialize("case-1", &sample_payload()).unwrap();
        let appended = store.append("note-added", &json!({"n": 1})).unwrap();
        assert_eq!(appended["seq"], 2);
        assert_eq!(appended["event_id"], "EVT-000002");

        // On disk the log is exactly the canonical encoding of both events.
        let expected = format!(
            "{}\n{}\n",
            canonical_json(&created),
            canonical_json(&appended)
        );
        assert_eq!(String::from_utf8(log_bytes(dir.path())).unwrap(), expected);

        // Both events parse back to the values that were returned.
        let (events, tail) = store.read_events(false).unwrap();
        assert_eq!(events, vec![created, appended]);
        assert!(tail.is_empty());
    }

    #[test]
    fn test_read_rejects_non_object_line() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(EVENTS_FILE), b"[1,2,3]\n").unwrap();
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT");
    }

    #[test]
    fn test_read_rejects_unsupported_format() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event["format_version"] = json!(2);
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "UNSUPPORTED_FORMAT");
    }

    #[test]
    fn test_read_rejects_missing_format_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event.as_object_mut().unwrap().remove("format_version");
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "UNSUPPORTED_FORMAT");
    }

    #[test]
    fn test_read_rejects_broken_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let first = build_event("case-1", 1, "case-created", &sample_payload());
        let mut second =
            build_event("case-1", 2, "note-added", &sample_payload());
        second["seq"] = json!(3);
        write_log(dir.path(), &[first, second], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "BROKEN_EVENT_SEQUENCE");
    }

    #[test]
    fn test_read_rejects_duplicate_event_id() {
        let dir = tempfile::tempdir().unwrap();
        let first = build_event("case-1", 1, "case-created", &sample_payload());
        let mut second =
            build_event("case-1", 2, "note-added", &sample_payload());
        second["event_id"] = json!("EVT-000001");
        write_log(dir.path(), &[first, second], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT_ID");
    }

    #[test]
    fn test_read_rejects_missing_event_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event.as_object_mut().unwrap().remove("event_id");
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT_ID");
    }

    #[test]
    fn test_read_rejects_invalid_case_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event["case_id"] = json!("bad id");
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_ID");
    }

    #[test]
    fn test_read_rejects_non_string_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event["timestamp"] = json!(7);
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT");
    }

    #[test]
    fn test_read_rejects_non_object_payload() {
        let dir = tempfile::tempdir().unwrap();
        let mut event =
            build_event("case-1", 1, "case-created", &sample_payload());
        event["payload"] = json!("not-an-object");
        write_log(dir.path(), &[event], b"");
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT");
    }

    #[test]
    fn test_read_truncated_without_newline() {
        let dir = tempfile::tempdir().unwrap();
        let event = build_event("case-1", 1, "case-created", &sample_payload());
        let mut bytes = format!("{}\n", canonical_json(&event)).into_bytes();
        bytes.extend_from_slice(b"{\"partial\":");
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();

        // Without tolerance the missing newline is an error.
        let err = store(dir.path()).read_events(false).unwrap_err();
        assert_eq!(err.code(), "TRUNCATED_EVENT");

        // With tolerance the partial bytes surface as the tail.
        let (events, tail) = store(dir.path()).read_events(true).unwrap();
        assert_eq!(events, vec![event]);
        assert_eq!(tail, b"{\"partial\":".to_vec());
    }

    #[test]
    fn test_read_corrupt_middle_line_is_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let event = build_event("case-1", 1, "case-created", &sample_payload());
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{not json}\n");
        bytes.extend_from_slice(
            format!("{}\n", canonical_json(&event)).as_bytes(),
        );
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();
        // Even in tolerant mode a corrupt non-final line is fatal.
        let err = store(dir.path()).read_events(true).unwrap_err();
        assert_eq!(err.code(), "INVALID_EVENT_JSON");
    }

    #[test]
    fn test_recover_truncated_tail_quarantines_and_truncates() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let created = store.initialize("case-1", &sample_payload()).unwrap();
        let appended = store.append("note-added", &json!({"n": 1})).unwrap();
        let valid = format!(
            "{}\n{}\n",
            canonical_json(&created),
            canonical_json(&appended)
        );

        // Simulate a crash mid-append: a half-written JSON line.
        let partial = b"{\"format_version\":1,\"case_id\":\"case-1\",\"seq\":3";
        let mut bytes = valid.clone().into_bytes();
        bytes.extend_from_slice(partial);
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();

        let recovered = store.recover_truncated_tail().unwrap().unwrap();
        assert_eq!(recovered["type"], "case-recovered");
        assert_eq!(recovered["seq"], 3);
        assert_eq!(recovered["payload"]["reason"], "truncated-tail");
        let artifact = recovered["payload"]["artifact"].as_str().unwrap();
        assert!(artifact.starts_with("artifacts/recovery/truncated-tail-"));

        // The log now holds only complete events.
        let expected = format!("{valid}{}\n", canonical_json(&recovered));
        assert_eq!(String::from_utf8(log_bytes(dir.path())).unwrap(), expected);

        // The damaged bytes were saved to the recovery artifact.
        let quarantined = dir.path().join(artifact);
        assert_eq!(fs::read(&quarantined).unwrap(), partial.to_vec());
        let name = quarantined.file_name().unwrap().to_string_lossy();
        assert!(name.ends_with(".bin"), "artifact name: {name}");

        // Appending continues from the recovery event.
        let third = store.append("note-added", &json!({"n": 2})).unwrap();
        assert_eq!(third["seq"], 4);
        let (events, tail) = store.read_events(false).unwrap();
        assert_eq!(events.len(), 4);
        assert!(tail.is_empty());
    }

    #[test]
    fn test_recover_twice_keeps_distinct_artifacts() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();

        let first_tail = b"{\"partial\":1";
        let mut bytes = log_bytes(dir.path());
        bytes.extend_from_slice(first_tail);
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();
        let first = store.recover_truncated_tail().unwrap().unwrap();
        let first_artifact =
            first["payload"]["artifact"].as_str().unwrap().to_owned();

        // A second truncation after the recovery event was appended must
        // not overwrite the first quarantine.
        let second_tail = b"{\"partial\":2";
        let mut bytes = log_bytes(dir.path());
        bytes.extend_from_slice(second_tail);
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();
        let second = store.recover_truncated_tail().unwrap().unwrap();
        let second_artifact =
            second["payload"]["artifact"].as_str().unwrap().to_owned();

        assert_ne!(first_artifact, second_artifact);
        assert_eq!(
            fs::read(dir.path().join(&first_artifact)).unwrap(),
            first_tail.to_vec()
        );
        assert_eq!(
            fs::read(dir.path().join(&second_artifact)).unwrap(),
            second_tail.to_vec()
        );
    }

    #[test]
    fn test_recovery_artifact_avoids_existing_file() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();

        // Simulate a recovery that saved its artifact but crashed before
        // appending the `case-recovered` event: the next sequence number is
        // still 2, yet its file already exists.
        let recovery_dir = dir.path().join("artifacts").join("recovery");
        fs::create_dir_all(&recovery_dir).unwrap();
        let occupied = recovery_dir.join("truncated-tail-000002.bin");
        fs::write(&occupied, b"stale").unwrap();

        let mut bytes = log_bytes(dir.path());
        bytes.extend_from_slice(b"{\"partial\":");
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();
        let recovered = store.recover_truncated_tail().unwrap().unwrap();
        let artifact =
            recovered["payload"]["artifact"].as_str().unwrap().to_owned();

        assert_ne!(artifact, "artifacts/recovery/truncated-tail-000002.bin");
        assert_eq!(fs::read(&occupied).unwrap(), b"stale".to_vec());
        assert_eq!(
            fs::read(dir.path().join(&artifact)).unwrap(),
            b"{\"partial\":".to_vec()
        );
    }

    #[test]
    fn test_recover_without_tail_is_noop() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();
        assert!(store.recover_truncated_tail().unwrap().is_none());
    }

    #[test]
    fn test_append_requires_recovery_after_tail() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();
        let mut bytes = log_bytes(dir.path());
        bytes.extend_from_slice(b"{\"partial\":");
        fs::write(dir.path().join(EVENTS_FILE), &bytes).unwrap();

        let err = store.append("note-added", &json!({})).unwrap_err();
        assert_eq!(err.code(), "TRUNCATED_EVENT");
    }

    #[test]
    fn test_lock_conflict_reports_case_busy() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store.initialize("case-1", &sample_payload()).unwrap();

        // Hold the lock; a second acquisition in the same process must
        // still conflict immediately with `CASE_BUSY`.
        let held = store.lock().unwrap();
        let err = store.append("note-added", &json!({"n": 1})).unwrap_err();
        assert_eq!(err.code(), "CASE_BUSY");
        drop(held);

        // Releasing the lock lets the append proceed.
        let event = store.append("note-added", &json!({"n": 1})).unwrap();
        assert_eq!(event["seq"], 2);
    }
}
