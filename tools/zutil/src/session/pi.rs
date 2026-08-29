//! Session provider reading pi's `JSONL` session storage.
//!
//! Session files live under
//! `<data dir>/sessions/<cwd-dir>/<timestamp>_<uuid>.jsonl`. The first
//! JSON line holds the session header; following lines are message
//! records. Unknown record types (e.g. `model_change`) are skipped,
//! never treated as errors, so newer pi versions stay forward
//! compatible.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session::model::{
    Session, SessionEvent, SessionMeta, event_id, event_matches_any_prefix,
};
use crate::session::provider::SessionProvider;
use crate::session::resolve::ResolveError;
use crate::{expand_tilde, iso_to_epoch_ms, truncate_chars};

/// Environment variable overriding the pi data directory.
pub const ZOO_PI_DATA_DIR: &str = "ZOO_PI_DATA_DIR";

/// Default pi data directory; session files live under its `sessions`
/// subdirectory.
const DEFAULT_DATA_DIR: &str = "~/.pi/agent";

/// Maximum number of lines scanned past the header to find the first
/// user message used as a session label.
const LABEL_SCAN_LINES: usize = 200;

/// Maximum label length in characters.
const LABEL_MAX_CHARS: usize = 60;

/// Resolve the pi data directory: `ZOO_PI_DATA_DIR` when set, otherwise
/// the default `~/.pi/agent` (tilde-expanded).
#[must_use]
pub fn pi_data_dir() -> String {
    std::env::var(ZOO_PI_DATA_DIR)
        .unwrap_or_else(|_| expand_tilde(DEFAULT_DATA_DIR))
}

/// Provider reading sessions from pi's `JSONL` storage.
///
/// Construct with [`PiSessionProvider::new`] to honor the
/// `ZOO_PI_DATA_DIR` override, or [`PiSessionProvider::with_data_dir`]
/// for an explicit root (used by tests and by callers that already know
/// the location).
#[derive(Debug, Clone)]
pub struct PiSessionProvider {
    data_dir: String,
}

impl PiSessionProvider {
    /// Create a provider rooted at the pi data directory resolved from
    /// `ZOO_PI_DATA_DIR` (default `~/.pi/agent`).
    #[must_use]
    pub fn new() -> Self {
        Self { data_dir: pi_data_dir() }
    }

    /// Create a provider rooted at an explicit data directory.
    ///
    /// A leading `~` is expanded like elsewhere in this crate.
    #[must_use]
    pub fn with_data_dir(data_dir: impl Into<String>) -> Self {
        Self { data_dir: data_dir.into() }
    }

    /// Absolute path of the sessions directory (`<data>/sessions`).
    fn sessions_dir(&self) -> String {
        format!("{}/sessions", expand_tilde(&self.data_dir))
    }

    /// Collect every `*.jsonl` session file under the sessions root,
    /// one level deep (the cwd directories), sorted by file name.
    ///
    /// File names start with the session creation timestamp (ISO with
    /// `:` → `-`), so file-name order is time order. Sorting by the file
    /// name only — not the full path — keeps that order valid across cwd
    /// directories, whose names would otherwise dominate the sort key;
    /// the reverse order is therefore newest-first for `find_events`.
    fn session_files(&self) -> Vec<PathBuf> {
        let sessions = self.sessions_dir();
        let root = Path::new(&sessions);
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Ok(inner) = fs::read_dir(&path) {
                    files.extend(inner.flatten().map(|e| e.path()).filter(
                        |p| {
                            p.is_file()
                                && p.extension().is_some_and(|e| e == "jsonl")
                        },
                    ));
                }
            }
        }
        files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        files
    }

    /// Resolve an id or unique prefix to exactly one session file.
    ///
    /// An exact id match wins even when it is also a prefix of other
    /// ids. A prefix matching several sessions is an
    /// [`ResolveError::Ambiguous`] error; no match is
    /// [`ResolveError::NotFound`].
    fn resolve_file(
        &self,
        id_or_prefix: &str,
    ) -> Result<PathBuf, ResolveError> {
        if id_or_prefix.is_empty() {
            return Err(ResolveError::NotFound {
                id: String::new(),
                tried_hosts: vec!["pi".to_string()],
            });
        }
        let mut matches: Vec<(String, PathBuf)> = Vec::new();
        for path in self.session_files() {
            let Some(id) = read_id(&path) else {
                continue;
            };
            if id.starts_with(id_or_prefix) {
                matches.push((id, path));
            }
        }
        if let Some((_, path)) =
            matches.iter().find(|(id, _)| id == id_or_prefix)
        {
            return Ok(path.clone());
        }
        match matches.len() {
            0 => Err(ResolveError::NotFound {
                id: id_or_prefix.to_string(),
                tried_hosts: vec!["pi".to_string()],
            }),
            1 => Ok(matches[0].1.clone()),
            _ => {
                let ids: Vec<String> =
                    matches.iter().map(|(id, _)| id.clone()).collect();
                Err(ResolveError::Ambiguous {
                    prefix: id_or_prefix.to_string(),
                    matches: ids,
                })
            }
        }
    }
}

/// Parse the session id from a file's first line. Returns `None` when
/// the file has no parseable `session` header.
fn read_id(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let header = BufReader::new(file).lines().next()?.ok()?;
    let value: Value = serde_json::from_str(&header).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    value.get("id").and_then(Value::as_str).map(ToString::to_string)
}

/// Read session metadata from a file: the header line, the bounded label
/// scan, and the last message record's timestamp.
fn read_meta(path: &Path) -> Option<SessionMeta> {
    let content = fs::read_to_string(path).ok()?;
    meta_from_content(&content)
}

/// Build metadata from a session file's content: the header line, the
/// `title` (and its display-truncated `label`) synthesized from the first
/// user message, and the last message record's timestamp. Returns `None`
/// when the first line is not a `session` record.
fn meta_from_content(content: &str) -> Option<SessionMeta> {
    let header = serde_json::from_str::<Value>(content.lines().next()?).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let mut meta = meta_from_header(&header)?;
    meta.title = first_user_text(content.lines().skip(1));
    meta.label = meta.title.as_deref().map(summarize);
    meta.updated_at = last_message_time(content);
    meta.model = first_assistant_model(content);
    Some(meta)
}

/// Extract the fixed metadata fields from a parsed session header.
fn meta_from_header(header: &Value) -> Option<SessionMeta> {
    let id = header.get("id")?.as_str()?.to_string();
    let cwd =
        header.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let parent_id = header
        .get("parentSession")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let started_at = header
        .get("timestamp")
        .and_then(Value::as_str)
        .map_or(0, iso_to_epoch_ms);
    Some(SessionMeta {
        id,
        parent_id,
        cwd,
        started_at,
        label: None,
        title: None,
        updated_at: None,
        model: None,
        agent: None,
    })
}

/// Timestamp of the last `message` record in the content, if any.
///
/// `updated_at` is derived from the most recent message record because
/// pi records do not carry an explicit session update time.
fn last_message_time(content: &str) -> Option<i64> {
    let mut last: Option<i64> = None;
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        last = Some(message_timestamp(&record, message));
    }
    last
}

/// Scan lines for the first user message and return its text as the
/// untruncated session title (whitespace collapsed, never length
/// truncated).
fn first_user_text<'a>(lines: impl Iterator<Item = &'a str>) -> Option<String> {
    for line in lines.take(LABEL_SCAN_LINES) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = extract_text(message.get("content").unwrap_or(&Value::Null));
        if !text.is_empty() {
            return Some(collapse_whitespace(&text));
        }
    }
    None
}

/// Collapse whitespace runs to single spaces, trimming the ends.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate a whitespace-collapsed title for label display.
fn summarize(text: &str) -> String {
    truncate_chars(text, LABEL_MAX_CHARS)
}

/// Model of one assistant message: `Provider/modelId`, or the bare
/// `modelId` when the record stores no provider.
///
/// pi stores the model id in the `model` field of an assistant message
/// (e.g. `"model": "k3-256k"`); the legacy `modelId` key is accepted as a
/// fallback.
fn assistant_model(message: &Value) -> Option<String> {
    let model_id = message
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            message
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })?;
    let provider = message
        .get("provider")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    Some(provider.map_or_else(
        || model_id.to_string(),
        |provider| format!("{provider}/{model_id}"),
    ))
}

/// Model of the first assistant message in the file content, if any.
///
/// Sessions may switch models over their lifetime; the session-level model
/// is the one that produced the first assistant turn.
fn first_assistant_model(content: &str) -> Option<String> {
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        return assistant_model(message);
    }
    None
}

/// Concatenate the text blocks of a content value.
///
/// Handles both a bare string and an array of
/// `{"type":"text","text":...}` parts; non-text parts are skipped.
fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Synthesize the title from the first non-empty user message event.
///
/// The text is whitespace-collapsed but not length-truncated; the
/// display label derives from it via [`summarize`].
fn title_from_events(events: &[SessionEvent]) -> Option<String> {
    events.iter().find_map(|event| match event {
        SessionEvent::Message { role, text, .. } if role == "user" => {
            let title = collapse_whitespace(text);
            (!title.is_empty()).then_some(title)
        }
        _ => None,
    })
}

/// Append the events of one `message` record to `events`.
///
/// Unknown roles and content-part types are skipped. Thinking parts
/// become `Reasoning` events; the assistant `usage` reports token counts
/// plus the message's `stopReason`.
fn parse_message_record(record: &Value, events: &mut Vec<SessionEvent>) {
    let Some(message) = record.get("message") else {
        return;
    };
    let timestamp = message_timestamp(record, message);
    // The record-level id is the pi message id (`Message` events carry it;
    // tool events carry their own call ids instead).
    let record_id =
        record.get("id").and_then(Value::as_str).map(ToString::to_string);
    match message.get("role").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let text =
                extract_text(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                events.push(SessionEvent::Message {
                    id: record_id,
                    role: "user".to_string(),
                    text,
                    timestamp,
                });
            }
        }
        "assistant" => {
            parse_assistant_message(message, timestamp, record_id, events);
        }
        "toolResult" => {
            let id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let output =
                extract_text(message.get("content").unwrap_or(&Value::Null));
            let is_error = message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            events.push(SessionEvent::ToolResult {
                id,
                name,
                output,
                is_error,
                timestamp,
            });
        }
        _ => {}
    }
}

/// Append the events of one assistant `message` to `events`.
///
/// Content parts map as: `text` → `Message`, `thinking` → `Reasoning`
/// (empty text skipped), `toolCall` → `ToolUse`. The assistant `usage`
/// object becomes a `Usage` event carrying the message's `stopReason`
/// and record id.
fn parse_assistant_message(
    message: &Value,
    timestamp: i64,
    record_id: Option<String>,
    events: &mut Vec<SessionEvent>,
) {
    if let Some(parts) = message.get("content").and_then(Value::as_array) {
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !text.is_empty() {
                        events.push(SessionEvent::Message {
                            id: record_id.clone(),
                            role: "assistant".to_string(),
                            text,
                            timestamp,
                        });
                    }
                }
                Some("thinking") => {
                    let text = part
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !text.is_empty() {
                        events.push(SessionEvent::Reasoning {
                            text,
                            timestamp,
                            id: None,
                        });
                    }
                }
                Some("toolCall") => {
                    let id = part
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                    let name = part
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let input =
                        part.get("arguments").cloned().unwrap_or(Value::Null);
                    events.push(SessionEvent::ToolUse {
                        id,
                        name,
                        input,
                        timestamp,
                    });
                }
                // unknown part types are skipped
                _ => {}
            }
        }
    }
    if let Some(usage) = message.get("usage") {
        let reason = message
            .get("stopReason")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        events.push(usage_event(
            usage,
            timestamp,
            reason,
            record_id,
            assistant_model(message),
        ));
    }
}

/// Event timestamp for a message record: the message's own epoch-ms
/// timestamp when present, otherwise the record-level ISO timestamp.
fn message_timestamp(record: &Value, message: &Value) -> i64 {
    message
        .get("timestamp")
        .and_then(Value::as_i64)
        .or_else(|| {
            record.get("timestamp").and_then(Value::as_str).map(iso_to_epoch_ms)
        })
        .unwrap_or(0)
}

/// Convert an assistant `usage` object into a [`SessionEvent::Usage`].
///
/// All-zero numbers are recorded as-is; the cost comes from
/// `cost.total` and stays `None` when the provider reports none. The
/// reasoning count comes from `usage.reasoning` (missing = 0), the reason
/// from the assistant message's `stopReason`, the message id from the
/// record id, and the model from the assistant message's
/// `provider`/`modelId` pair; pi reports no per-message duration.
#[must_use]
fn usage_event(
    usage: &Value,
    timestamp: i64,
    reason: Option<String>,
    message_id: Option<String>,
    model: Option<String>,
) -> SessionEvent {
    SessionEvent::Usage {
        input: usage.get("input").and_then(Value::as_i64).unwrap_or(0),
        output: usage.get("output").and_then(Value::as_i64).unwrap_or(0),
        cache_read: usage.get("cacheRead").and_then(Value::as_i64).unwrap_or(0),
        cache_write: usage
            .get("cacheWrite")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cost: usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64),
        timestamp,
        reasoning: usage.get("reasoning").and_then(Value::as_i64).unwrap_or(0),
        reason,
        message_id,
        duration_ms: None,
        model,
    }
}

/// Parse a session file into a [`Session`].
///
/// Lines that are not valid JSON or whose record type is unknown are
/// skipped. The label is synthesized from the first user message found
/// in the event stream.
///
/// # Errors
///
/// Returns [`ErrorKind::InvalidData`] when the file has no `session`
/// header, and propagates file I/O errors.
fn parse_session(path: &Path) -> io::Result<Session> {
    let content = fs::read_to_string(path)?;
    let mut meta: Option<SessionMeta> = None;
    let mut events: Vec<SessionEvent> = Vec::new();
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("session") if meta.is_none() => {
                meta = meta_from_header(&record);
            }
            Some("message") => parse_message_record(&record, &mut events),
            // model_change, thinking_level_change, future types: skip
            _ => {}
        }
    }
    let Some(mut meta) = meta else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("not a pi session file: {}", path.display()),
        ));
    };
    meta.title = title_from_events(&events);
    meta.label = meta.title.as_deref().map(summarize);
    meta.updated_at = last_message_time(&content);
    meta.model = first_assistant_model(&content);
    Ok(Session { meta, events })
}

/// True when any message text or tool-result output in the file content
/// contains the lowercased needle (case-insensitive match).
fn text_matches(content: &str, needle: &str) -> bool {
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let haystack = match role {
            "user" | "assistant" | "toolResult" => {
                extract_text(message.get("content").unwrap_or(&Value::Null))
                    .to_lowercase()
            }
            _ => continue,
        };
        if haystack.contains(needle) {
            return true;
        }
    }
    false
}

/// Sort session metadata deterministically: by start time, then id.
fn sort_metas(metas: &mut [SessionMeta]) {
    metas.sort_by(|a, b| (a.started_at, &a.id).cmp(&(b.started_at, &b.id)));
}

impl SessionProvider for PiSessionProvider {
    fn list(&self) -> io::Result<Vec<SessionMeta>> {
        let mut metas = Vec::new();
        for path in self.session_files() {
            if let Some(meta) = read_meta(&path) {
                metas.push(meta);
            }
        }
        sort_metas(&mut metas);
        Ok(metas)
    }

    fn open(&self, id_or_prefix: &str) -> Result<Session, ResolveError> {
        let path = self.resolve_file(id_or_prefix)?;
        parse_session(&path).map_err(ResolveError::Io)
    }

    fn search(&self, query: &str) -> io::Result<Vec<SessionMeta>> {
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let needle = query.to_lowercase();
        let mut hits = Vec::new();
        for path in self.session_files() {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Some(meta) = meta_from_content(&content) else {
                continue;
            };
            if text_matches(&content, &needle) {
                hits.push(meta);
            }
        }
        sort_metas(&mut hits);
        Ok(hits)
    }

    fn find_events(
        &self,
        ids: &[String],
        max_sessions: usize,
    ) -> io::Result<Vec<(SessionMeta, Vec<SessionEvent>)>> {
        if ids.is_empty() || max_sessions == 0 {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut found: Vec<bool> = vec![false; ids.len()];
        // Session files embed their creation timestamp in the file name, so
        // the reverse file-name order is newest-first (valid across cwd
        // directories, unlike path order). `scanned` counts the files
        // observed so far, newest first.
        for (scanned, path) in
            self.session_files().into_iter().rev().enumerate()
        {
            if scanned >= max_sessions || found.iter().all(|hit| *hit) {
                break;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let mut events = Vec::new();
            for line in content.lines() {
                // Cheap pre-filter: a line that cannot contain any wanted
                // id is skipped without parsing or translating it.
                if !ids.iter().any(|id| line.contains(id.as_str())) {
                    continue;
                }
                let Ok(record) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let mut candidate = Vec::new();
                parse_message_record(&record, &mut candidate);
                for ev in candidate {
                    if event_matches_any_prefix(&ev, ids) {
                        events.push(ev);
                    }
                }
            }
            if events.is_empty() {
                continue;
            }
            // Metadata follows the `list` semantics: header fields, the
            // synthesized label, and the last message timestamp.
            let Some(meta) = meta_from_content(&content) else {
                continue;
            };
            for (i, id) in ids.iter().enumerate() {
                if !found[i]
                    && events.iter().any(|ev| {
                        event_id(ev).is_some_and(|eid| eid.starts_with(id))
                    })
                {
                    found[i] = true;
                }
            }
            out.push((meta, events));
        }
        Ok(out)
    }
}

impl Default for PiSessionProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::model::{DetectedHost, Host, detect_host};

    /// Create a fresh temp root with a `sessions` subdirectory.
    fn fixture_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zutil-pi-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions dir");
        dir
    }

    /// Write one session file under `<root>/sessions/<cwd_dir>/<name>`.
    fn write_session(root: &Path, cwd_dir: &str, name: &str, lines: &[String]) {
        let dir = root.join("sessions").join(cwd_dir);
        std::fs::create_dir_all(&dir).expect("create cwd dir");
        std::fs::write(dir.join(format!("{name}.jsonl")), lines.join("\n"))
            .expect("write session file");
    }

    /// Serialize a JSON value as one `JSONL` line.
    fn line(value: &Value) -> String {
        value.to_string()
    }

    /// A full session fixture covering every record kind and mapping.
    fn full_session_lines() -> Vec<String> {
        vec![
            line(&serde_json::json!({
                "type": "session", "version": 3,
                "id": "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
                "timestamp": "2026-08-29T04:22:13.268Z",
                "cwd": "/Users/teapot/Code/ZooKeeper",
                "parentSession": "01a04bbd-92be-7cec-9b0b-63c0f35f3555",
            })),
            line(&serde_json::json!({
                "type": "model_change", "id": "mc1", "parentId": null,
                "timestamp": "2026-08-29T04:22:13.280Z",
                "provider": "MoonShot", "modelId": "k3-256k",
            })),
            line(&serde_json::json!({
                "type": "thinking_level_change", "id": "tl1",
                "parentId": "mc1", "timestamp": "2026-08-29T04:22:13.285Z",
                "thinkingLevel": "high",
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m1", "parentId": "tl1",
                "timestamp": "2026-08-29T04:22:13.289Z",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "refactor the parser and run tests"},
                ]},
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m2", "parentId": "m1",
                "timestamp": "2026-08-29T04:22:17.861Z",
                "message": {
                    "role": "assistant",
                    "provider": "MoonShot",
                    "model": "k3-256k",
                    "content": [
                        {"type": "thinking", "thinking": "inspect the structure first"},
                        {"type": "text", "text": "Let me inspect the code."},
                        {"type": "toolCall", "id": "call-1", "name": "bash",
                         "arguments": {"command": "ls"}},
                    ],
                    "usage": {
                        "input": 7725, "output": 141, "reasoning": 50,
                        "cacheRead": 0, "cacheWrite": 0, "totalTokens": 7866,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                 "cacheWrite": 0, "total": 0},
                    },
                    "timestamp": 1_787_977_340_524_i64,
                    "stopReason": "toolUse",
                },
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m3", "parentId": "m2",
                "timestamp": "2026-08-29T04:22:20.781Z",
                "message": {
                    "role": "toolResult", "toolCallId": "call-1",
                    "toolName": "bash",
                    "content": [{"type": "text", "text": "src/parser.rs\n"}],
                    "isError": false, "timestamp": 1_787_977_340_781_i64,
                },
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m4", "parentId": "m3",
                "timestamp": "2026-08-29T04:22:21.500Z",
                "message": {
                    "role": "assistant",
                    "provider": "MoonShot",
                    "modelId": "legacy-k3",
                    "content": [
                        {"type": "text", "text": "Check the tests directory."},
                    ],
                    "usage": {
                        "input": 10, "output": 20, "cacheRead": 30,
                        "cacheWrite": 40, "totalTokens": 100,
                        "cost": {"total": 0.00123},
                    },
                    "timestamp": 1_787_977_341_100_i64,
                },
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m5", "parentId": "m4",
                "timestamp": "2026-08-29T04:22:22.000Z",
                "message": {
                    "role": "toolResult", "toolCallId": "call-9",
                    "toolName": "bash",
                    "content": [{"type": "text", "text": "command failed"}],
                    "isError": true, "timestamp": 1_787_977_341_200_i64,
                },
            })),
        ]
    }

    /// The events `open` must produce for [`full_session_lines`].
    fn full_session_expected_events() -> Vec<SessionEvent> {
        vec![
            SessionEvent::Message {
                id: Some("m1".to_string()),
                role: "user".to_string(),
                text: "refactor the parser and run tests".to_string(),
                timestamp: iso_to_epoch_ms("2026-08-29T04:22:13.289Z"),
            },
            SessionEvent::Reasoning {
                text: "inspect the structure first".to_string(),
                timestamp: 1_787_977_340_524,
                id: None,
            },
            SessionEvent::Message {
                id: Some("m2".to_string()),
                role: "assistant".to_string(),
                text: "Let me inspect the code.".to_string(),
                timestamp: 1_787_977_340_524,
            },
            SessionEvent::ToolUse {
                id: Some("call-1".to_string()),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "ls"}),
                timestamp: 1_787_977_340_524,
            },
            SessionEvent::Usage {
                input: 7725,
                output: 141,
                cache_read: 0,
                cache_write: 0,
                cost: Some(0.0),
                timestamp: 1_787_977_340_524,
                reasoning: 50,
                reason: Some("toolUse".to_string()),
                message_id: Some("m2".to_string()),
                duration_ms: None,
                model: Some("MoonShot/k3-256k".to_string()),
            },
            SessionEvent::ToolResult {
                id: Some("call-1".to_string()),
                name: "bash".to_string(),
                output: "src/parser.rs\n".to_string(),
                is_error: false,
                timestamp: 1_787_977_340_781,
            },
            SessionEvent::Message {
                id: Some("m4".to_string()),
                role: "assistant".to_string(),
                text: "Check the tests directory.".to_string(),
                timestamp: 1_787_977_341_100,
            },
            SessionEvent::Usage {
                input: 10,
                output: 20,
                cache_read: 30,
                cache_write: 40,
                cost: Some(0.00123),
                timestamp: 1_787_977_341_100,
                reasoning: 0,
                reason: None,
                message_id: Some("m4".to_string()),
                duration_ms: None,
                model: Some("MoonShot/legacy-k3".to_string()),
            },
            SessionEvent::ToolResult {
                id: Some("call-9".to_string()),
                name: "bash".to_string(),
                output: "command failed".to_string(),
                is_error: true,
                timestamp: 1_787_977_341_200,
            },
        ]
    }

    #[test]
    fn test_parse_full_session_with_tool_usage_result() {
        let root = fixture_root("full");
        write_session(
            &root,
            "--Users-teapot-Code-ZooKeeper--",
            "2026-08-29T04-22-13-268Z_01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
            &full_session_lines(),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        let session = provider
            .open("01a04bc0-fa14-76d5-95ec-a8d5ee80f706")
            .expect("open full fixture");
        assert_eq!(session.meta.id, "01a04bc0-fa14-76d5-95ec-a8d5ee80f706");
        assert_eq!(
            session.meta.parent_id.as_deref(),
            Some("01a04bbd-92be-7cec-9b0b-63c0f35f3555")
        );
        assert_eq!(session.meta.cwd, "/Users/teapot/Code/ZooKeeper");
        assert_eq!(
            session.meta.started_at,
            iso_to_epoch_ms("2026-08-29T04:22:13.268Z")
        );
        assert_eq!(
            session.meta.label.as_deref(),
            Some("refactor the parser and run tests")
        );
        assert_eq!(
            session.meta.updated_at,
            Some(1_787_977_341_200),
            "last message record timestamp"
        );
        assert_eq!(
            session.meta.model.as_deref(),
            Some("MoonShot/k3-256k"),
            "model comes from the first assistant message"
        );
        assert_eq!(session.meta.agent, None, "pi has no agent concept");
        assert_eq!(session.events, full_session_expected_events());

        // Pin the provider mapping: reasoning and stopReason come from the
        // fixture JSONL fields, duration is unreported for pi.
        let usages: Vec<&SessionEvent> = session
            .events
            .iter()
            .filter(|e| matches!(e, SessionEvent::Usage { .. }))
            .collect();
        match usages[0] {
            SessionEvent::Usage {
                reasoning,
                reason,
                message_id,
                duration_ms,
                model,
                ..
            } => {
                assert_eq!(*reasoning, 50, "usage.reasoning");
                assert_eq!(reason.as_deref(), Some("toolUse"), "stopReason");
                assert_eq!(message_id.as_deref(), Some("m2"), "record id");
                assert_eq!(*duration_ms, None);
                assert_eq!(
                    model.as_deref(),
                    Some("MoonShot/k3-256k"),
                    "provider/model of the assistant message"
                );
            }
            other => panic!("expected usage, got {other:?}"),
        }
        assert_eq!(
            session.events[1],
            SessionEvent::Reasoning {
                text: "inspect the structure first".to_string(),
                timestamp: 1_787_977_340_524,
                id: None,
            },
            "thinking part maps to Reasoning"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_tolerates_unknown_and_malformed_lines() {
        let root = fixture_root("unknown");
        let lines = vec![
            line(&serde_json::json!({
                "type": "session", "version": 3,
                "id": "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
                "timestamp": "2026-08-29T04:22:13.268Z",
                "cwd": "/tmp",
            })),
            line(&serde_json::json!({
                "type": "model_change", "id": "mc1",
                "timestamp": "2026-08-29T04:22:13.280Z",
            })),
            line(&serde_json::json!({
                "type": "thinking_level_change", "id": "tl1",
                "timestamp": "2026-08-29T04:22:13.285Z",
            })),
            line(&serde_json::json!({
                "type": "brand_new_record_kind", "id": "bn1",
                "timestamp": "2026-08-29T04:22:13.290Z",
            })),
            "this line is not valid json at all".to_string(),
            line(&serde_json::json!({
                "type": "message", "id": "m1", "parentId": null,
                "timestamp": "2026-08-29T04:22:13.295Z",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "hello pi"},
                ]},
            })),
            line(&serde_json::json!({
                "type": "message", "id": "m2",
                "timestamp": "2026-08-29T04:22:14.000Z",
                "message": {
                    "role": "toolResult", "toolCallId": "c1",
                    "toolName": "bash",
                    "content": [{"type": "text", "text": "ok"}],
                    "isError": false,
                },
            })),
        ];
        write_session(
            &root,
            "--tmp--",
            "2026-08-29T04-22-13-268Z_01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
            &lines,
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        let session = provider.open("01a04bc0").expect("tolerant parse");
        assert_eq!(session.events.len(), 2);
        assert_eq!(session.meta.cwd, "/tmp");
        assert_eq!(
            session.meta.label.as_deref(),
            Some("hello pi"),
            "label still synthesized past unknown lines"
        );
        match &session.events[0] {
            SessionEvent::Message { role, text, .. } => {
                assert_eq!(role, "user");
                assert_eq!(text, "hello pi");
            }
            other => panic!("expected user message, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_empty_sessions_dir() {
        let root = fixture_root("empty");
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let metas = provider.list().expect("list on empty dir");
        assert!(metas.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_missing_sessions_dir() {
        let dir = std::env::temp_dir()
            .join(format!("zutil-pi-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create root");
        // No `sessions` subdirectory at all.
        let provider = PiSessionProvider::with_data_dir(dir.to_string_lossy());
        let metas = provider.list().expect("list on missing dir");
        assert!(metas.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_sorted_by_started_at() {
        let root = fixture_root("sorted");
        write_session(
            &root,
            "--a--",
            "1",
            &[line(&serde_json::json!({
                "type": "session", "id": "01a04bc0-fa14-76d5-95ec-111111111111",
                "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/a",
            }))],
        );
        write_session(
            &root,
            "--b--",
            "2",
            &[line(&serde_json::json!({
                "type": "session", "id": "01a04bc0-fa14-76d5-95ec-222222222222",
                "timestamp": "2026-08-29T04:10:00.000Z", "cwd": "/b",
            }))],
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let metas = provider.list().expect("list two sessions");
        assert_eq!(metas.len(), 2);
        assert_eq!(
            metas[0].id, "01a04bc0-fa14-76d5-95ec-222222222222",
            "earlier started_at sorts first"
        );
        assert_eq!(metas[1].id, "01a04bc0-fa14-76d5-95ec-111111111111");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Three sessions sharing prefixes, written under one root.
    fn prefix_fixture(root: &Path) {
        for (name, id) in [
            ("a", "01a04bc0-fa14-76d5-95ec-a8d5ee80f706"),
            ("b", "01a04bc0-fa14-76d5-95ec-b9e6f11a2233"),
            ("c", "02a04bc1-fa14-76d5-95ec-c8d5ee80f707"),
        ] {
            write_session(
                root,
                "--dir--",
                name,
                &[line(&serde_json::json!({
                    "type": "session", "id": id,
                    "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/w",
                }))],
            );
        }
    }

    #[test]
    fn test_open_by_exact_id() {
        let root = fixture_root("exact");
        prefix_fixture(&root);
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let session = provider
            .open("02a04bc1-fa14-76d5-95ec-c8d5ee80f707")
            .expect("exact id");
        assert_eq!(session.meta.cwd, "/w");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_open_by_unique_prefix() {
        let root = fixture_root("prefix");
        prefix_fixture(&root);
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let session = provider
            .open("01a04bc0-fa14-76d5-95ec-b9e6")
            .expect("unique prefix");
        assert_eq!(session.meta.id, "01a04bc0-fa14-76d5-95ec-b9e6f11a2233");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_open_ambiguous_prefix_errors() {
        let root = fixture_root("ambiguous");
        prefix_fixture(&root);
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let err = provider
            .open("01a04bc0-fa14-76d5-95ec-")
            .expect_err("shared prefix must be ambiguous");
        match err {
            ResolveError::Ambiguous { matches, .. } => {
                assert!(
                    matches.iter().any(|m| m.contains("a8d5ee80f706")),
                    "{matches:?}"
                );
                assert!(
                    matches.iter().any(|m| m.contains("b9e6f11a2233")),
                    "{matches:?}"
                );
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_open_exact_match_wins_over_prefix() {
        let root = fixture_root("exactwins");
        // One id is a prefix of the other; the exact id must win.
        write_session(
            &root,
            "--dir--",
            "short",
            &[line(&serde_json::json!({
                "type": "session",
                "id": "01a04bc0-fa14-76d5-95ec-111111111111",
                "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/short",
            }))],
        );
        write_session(
            &root,
            "--dir--",
            "long",
            &[line(&serde_json::json!({
                "type": "session",
                "id": "01a04bc0-fa14-76d5-95ec-1111111111112222",
                "timestamp": "2026-08-29T04:21:00.000Z", "cwd": "/long",
            }))],
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let session = provider
            .open("01a04bc0-fa14-76d5-95ec-111111111111")
            .expect("exact match wins");
        assert_eq!(session.meta.cwd, "/short");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_open_not_found_errors() {
        let root = fixture_root("notfound");
        prefix_fixture(&root);
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        for id in ["zzz-no-such-session", ""] {
            let err = provider.open(id).expect_err("must be not found");
            assert!(matches!(err, ResolveError::NotFound { .. }), "id {id:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_search_hits_and_misses() {
        let root = fixture_root("search");
        write_session(
            &root,
            "--dir--",
            "s1",
            &[
                line(&serde_json::json!({
                    "type": "session", "id": "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
                    "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/w",
                })),
                line(&serde_json::json!({
                    "type": "message", "id": "m1",
                    "timestamp": "2026-08-29T04:20:01.000Z",
                    "message": {"role": "user", "content": [
                        {"type": "text", "text": "refactor the parser module"},
                    ]},
                })),
                line(&serde_json::json!({
                    "type": "message", "id": "m2",
                    "timestamp": "2026-08-29T04:20:02.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "toolCall", "id": "c1", "name": "bash",
                             "arguments": {"command": "cargo test"}},
                        ],
                    },
                })),
                line(&serde_json::json!({
                    "type": "message", "id": "m3",
                    "timestamp": "2026-08-29T04:20:03.000Z",
                    "message": {
                        "role": "toolResult", "toolCallId": "c1",
                        "toolName": "bash",
                        "content": [{"type": "text", "text": "PARSER build passed"}],
                        "isError": false,
                    },
                })),
            ],
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        // Case-insensitive hit on user text and on toolResult output.
        for query in ["parser", "PARSER", "build passed"] {
            let hits = provider.search(query).expect("search ok");
            assert_eq!(hits.len(), 1, "query {query:?} must hit");
            assert_eq!(hits[0].id, "01a04bc0-fa14-76d5-95ec-a8d5ee80f706");
        }
        // Misses: no such term, and JSON keys are not searched.
        for query in ["zzz-no-such-term", "toolCall", "arguments"] {
            let hits = provider.search(query).expect("search ok");
            assert!(hits.is_empty(), "query {query:?} must miss");
        }
        // Empty query never matches everything.
        let hits = provider.search("").expect("search ok");
        assert!(hits.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_search_matches_untruncated_first_user_message() {
        let root = fixture_root("longtitle");
        let long_title = "refactor the entire authentication flow and add \
                          integration tests for the new session model";
        assert!(
            long_title.chars().count() > LABEL_MAX_CHARS,
            "fixture title must exceed the label truncation length"
        );
        write_session(
            &root,
            "--dir--",
            "s1",
            &[
                line(&serde_json::json!({
                    "type": "session",
                    "id": "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
                    "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/w",
                })),
                line(&serde_json::json!({
                    "type": "message", "id": "m1",
                    "timestamp": "2026-08-29T04:20:01.000Z",
                    "message": {"role": "user", "content": [
                        {"type": "text", "text": long_title},
                    ]},
                })),
            ],
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let id = "01a04bc0-fa14-76d5-95ec-a8d5ee80f706";

        // Substring search matches the full, untruncated first user
        // message text.
        for query in [long_title, "authentication flow", "new session model"] {
            let hits = provider.search(query).expect("search ok");
            assert_eq!(hits.len(), 1, "query {query:?} must hit");
            assert_eq!(hits[0].id, id);
            assert_eq!(
                hits[0].title.as_deref(),
                Some(long_title),
                "title keeps the full text for exact matching"
            );
            assert_eq!(
                hits[0].label.as_deref().map(|l| l.chars().count()),
                Some(LABEL_MAX_CHARS + 3),
                "label stays truncated for display (60 chars + \"...\")"
            );
        }

        // The open() path derives the same untruncated title.
        let session = provider.open("01a04bc0").expect("open");
        assert_eq!(session.meta.title.as_deref(), Some(long_title));
        assert_eq!(
            session.meta.label.as_deref().map(|l| l.chars().count()),
            Some(LABEL_MAX_CHARS + 3)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_populates_labels_and_parents() {
        let root = fixture_root("labels");
        write_session(&root, "--dir--", "s1", &full_session_lines());
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        let metas = provider.list().expect("list");
        assert_eq!(metas.len(), 1);
        assert_eq!(
            metas[0].label.as_deref(),
            Some("refactor the parser and run tests")
        );
        assert_eq!(
            metas[0].parent_id.as_deref(),
            Some("01a04bbd-92be-7cec-9b0b-63c0f35f3555")
        );
        assert_eq!(metas[0].updated_at, Some(1_787_977_341_200));
        assert_eq!(
            metas[0].model.as_deref(),
            Some("MoonShot/k3-256k"),
            "list metadata also carries the session model"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_host_events_defaults_to_none() {
        let root = fixture_root("hostevents");
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());
        assert!(provider.host_events("any-session").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_pi_data_dir_non_empty() {
        assert!(!pi_data_dir().is_empty());
    }

    /// Session file lines: the header plus the given message records.
    fn find_session_lines(id: &str, messages: Vec<Value>) -> Vec<String> {
        let mut lines = vec![line(&serde_json::json!({
            "type": "session", "version": 3, "id": id,
            "timestamp": "2026-08-29T04:20:00.000Z", "cwd": "/w",
        }))];
        lines.extend(messages.into_iter().map(|m| line(&m)));
        lines
    }

    /// A pi `message` record with a user role.
    fn user_msg(id: &str, ts_ms: i64, text: &str) -> Value {
        serde_json::json!({
            "type": "message", "id": id,
            "timestamp": crate::epoch_ms_to_iso(ts_ms),
            "message": {"role": "user", "content": [
                {"type": "text", "text": text},
            ]},
        })
    }

    /// A pi `message` record with an assistant role carrying one tool call.
    fn tool_call_msg(id: &str, ts_ms: i64, call_id: &str, name: &str) -> Value {
        serde_json::json!({
            "type": "message", "id": id,
            "timestamp": crate::epoch_ms_to_iso(ts_ms),
            "message": {"role": "assistant", "content": [
                {"type": "toolCall", "id": call_id, "name": name, "arguments": {}},
            ]},
        })
    }

    /// A pi `message` record with a toolResult role.
    fn tool_result_msg(
        id: &str,
        ts_ms: i64,
        call_id: &str,
        name: &str,
        is_error: bool,
    ) -> Value {
        serde_json::json!({
            "type": "message", "id": id,
            "timestamp": crate::epoch_ms_to_iso(ts_ms),
            "message": {"role": "toolResult", "toolCallId": call_id,
                        "toolName": name,
                        "content": [{"type": "text", "text": "ok"}],
                        "isError": is_error},
        })
    }

    #[test]
    fn test_find_events_matches_ids_and_orders_stream() {
        let root = fixture_root("findevents");
        // Newest file (2.jsonl) holds a user message and a tool call+
        // result; the older file holds its own user message.
        write_session(
            &root,
            "--dir--",
            "2",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-222222222222",
                vec![
                    user_msg("m2a", 1_715_000_100_000, "second"),
                    tool_call_msg("m2b", 1_715_000_101_000, "call-2", "bash"),
                    tool_result_msg(
                        "m2c",
                        1_715_000_102_000,
                        "call-2",
                        "bash",
                        false,
                    ),
                ],
            ),
        );
        write_session(
            &root,
            "--dir--",
            "1",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-111111111111",
                vec![user_msg("m1a", 1_715_000_000_000, "first")],
            ),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        let hits = provider.find_events(&["m2a".into()], 10).expect("find");
        assert_eq!(hits.len(), 1, "only the matching session reports events");
        let (meta, events) = &hits[0];
        assert_eq!(meta.id, "01a04bc0-fa14-76d5-95ec-222222222222");
        assert_eq!(meta.cwd, "/w");
        assert_eq!(meta.label.as_deref(), Some("second"));
        assert_eq!(meta.updated_at, Some(1_715_000_102_000));
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            SessionEvent::Message { id, text, .. }
                if id.as_deref() == Some("m2a") && text == "second"
        ));

        // A tool-call id matches both the use and the result events, in
        // stream order.
        let hits = provider.find_events(&["call-2".into()], 10).expect("find");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1.len(), 2, "ToolUse + ToolResult");
        assert!(matches!(hits[0].1[0], SessionEvent::ToolUse { .. }));
        assert!(matches!(hits[0].1[1], SessionEvent::ToolResult { .. }));

        // Records matching no wanted prefix contribute nothing.
        assert!(
            provider
                .find_events(&["zzz-nope".into()], 10)
                .expect("find")
                .is_empty()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_find_events_scan_picks_newest_across_cwd_dirs() {
        let root = fixture_root("crossdir");
        // The newer session lives in the alphabetically-first cwd
        // directory; a full-path sort would let the older `--z--`
        // session win the first scan slot and `--scan 1` would miss the
        // newer one.  The file name embeds the creation timestamp, so
        // file-name order — not path order — decides recency.
        write_session(
            &root,
            "--a--",
            "2026-08-29T04-22-13-268Z_01a04bc0-fa14-76d5-95ec-222222222222",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-222222222222",
                vec![user_msg("mnew", 1_715_000_100_000, "newest")],
            ),
        );
        write_session(
            &root,
            "--z--",
            "2026-08-01T00-00-00-000Z_01a04bc0-fa14-76d5-95ec-111111111111",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-111111111111",
                vec![user_msg("mold", 1_715_000_000_000, "oldest")],
            ),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        // A scan of one session covers only the newest file — the one in
        // the `--a--` directory — even though `--z--` sorts later by
        // path.
        let hits = provider.find_events(&["mnew".into()], 1).expect("find");
        assert_eq!(hits.len(), 1, "the newer file must win the scan slot");
        assert_eq!(hits[0].0.id, "01a04bc0-fa14-76d5-95ec-222222222222");
        // The older decoy file is not consulted within the scan budget.
        assert!(
            provider.find_events(&["mold".into()], 1).expect("find").is_empty()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_find_events_honors_max_sessions() {
        let root = fixture_root("findlimit");
        // The match lives only in the OLDER file.
        write_session(
            &root,
            "--dir--",
            "2",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-222222222222",
                vec![user_msg("m2a", 1_715_000_100_000, "second")],
            ),
        );
        write_session(
            &root,
            "--dir--",
            "1",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-111111111111",
                vec![user_msg("m1a", 1_715_000_000_000, "first")],
            ),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        // Scanning 1 session covers only the newest file (2.jsonl), which
        // has no match for the old id.
        assert!(
            provider.find_events(&["m1a".into()], 1).expect("find").is_empty()
        );
        // Zero scan and no ids short-circuit.
        assert!(
            provider.find_events(&["m1a".into()], 0).expect("find").is_empty()
        );
        assert!(provider.find_events(&[], 10).expect("find").is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_find_events_stops_early_when_all_ids_found() {
        let root = fixture_root("findsafe");
        // The newest file holds both wanted ids; the older file's
        // duplicate must never be opened once every id is found.
        write_session(
            &root,
            "--dir--",
            "2",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-222222222222",
                vec![
                    tool_call_msg("m2b", 1_715_000_101_000, "call-1", "bash"),
                    tool_call_msg("m2c", 1_715_000_102_000, "call-2", "bash"),
                ],
            ),
        );
        write_session(
            &root,
            "--dir--",
            "1",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-111111111111",
                vec![tool_call_msg("m1x", 1_715_000_000_000, "call-1", "bash")],
            ),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        let hits = provider
            .find_events(&["call-1".into(), "call-2".into()], 10)
            .expect("find");
        assert_eq!(
            hits.len(),
            1,
            "the older duplicate file must not be scanned once all ids \
             are found"
        );
        assert_eq!(hits[0].0.id, "01a04bc0-fa14-76d5-95ec-222222222222");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_find_events_skips_unmatched_large_file() {
        let root = fixture_root("findbig");
        // A large newest file whose lines never carry the wanted id: the
        // line pre-filter skips them without parsing, so only the small
        // matching file contributes.
        write_session(&root, "--dir--", "2", &{
            let mut lines = find_session_lines(
                "01a04bc0-fa14-76d5-95ec-222222222222",
                vec![],
            );
            for i in 0..2_000 {
                lines.push(line(&serde_json::json!({
                        "type": "message", "id": format!("bulk-{i}"),
                        "timestamp": crate::epoch_ms_to_iso(1_715_000_000_000_i64 + i),
                        "message": {"role": "user", "content": [
                            {"type": "text", "text": format!("bulk text {i}")},
                        ]},
                    })));
            }
            lines
        });
        write_session(
            &root,
            "--dir--",
            "1",
            &find_session_lines(
                "01a04bc0-fa14-76d5-95ec-111111111111",
                vec![user_msg("m1a", 1_715_000_000_000, "first")],
            ),
        );
        let provider = PiSessionProvider::with_data_dir(root.to_string_lossy());

        let hits = provider.find_events(&["m1a".into()], 10).expect("find");
        assert_eq!(hits.len(), 1, "only the small matching file contributes");
        assert_eq!(hits[0].0.id, "01a04bc0-fa14-76d5-95ec-111111111111");
        assert_eq!(hits[0].1.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_detect_host_shapes() {
        assert_eq!(detect_host("ses_abc"), DetectedHost::OpenCode);
        assert_eq!(
            detect_host("01a04bc0-fa14-76d5-95ec-a8d5ee80f706"),
            DetectedHost::Pi
        );
        assert_eq!(detect_host("whatever"), DetectedHost::Unknown);
        assert_eq!(Host::Pi.name(), "pi");
    }

    #[test]
    fn test_assistant_model_reads_real_and_legacy_shapes() {
        // Real pi records store the model id in `model` and the provider
        // separately.
        let msg = serde_json::json!({
            "role": "assistant",
            "provider": "MoonShot",
            "model": "k3-256k",
        });
        assert_eq!(
            assistant_model(&msg).as_deref(),
            Some("MoonShot/k3-256k"),
            "provider + model combine as Provider/model"
        );
        // Without a provider the bare model id is returned.
        let bare = serde_json::json!({ "role": "assistant", "model": "x" });
        assert_eq!(assistant_model(&bare).as_deref(), Some("x"));
        // The legacy `modelId` key still parses.
        let legacy = serde_json::json!({
            "role": "assistant",
            "provider": "MoonShot",
            "modelId": "legacy-k3",
        });
        assert_eq!(
            assistant_model(&legacy).as_deref(),
            Some("MoonShot/legacy-k3")
        );
        // Messages without either key yield None.
        assert_eq!(assistant_model(&serde_json::json!({"role": "user"})), None);
        assert_eq!(
            assistant_model(
                &serde_json::json!({"role": "assistant", "model": ""})
            ),
            None
        );
    }
}
