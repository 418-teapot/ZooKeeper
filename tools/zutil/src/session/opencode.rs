//! Session provider reading `OpenCode`'s `SQLite` store and application
//! log.
//!
//! Sessions, messages and parts live in `opencode*.db` files under the
//! opencode data directory ([`crate::db_helpers::opencode_data_dir`],
//! overridable via `ZOO_OPENCODE_DATA_DIR`). Host lifecycle events are
//! parsed from `<data dir>/log/opencode.log`, the same file `ztrace`
//! reads today.

use std::collections::{HashMap, HashSet};
use std::io;

use rusqlite::Connection;
use serde_json::{Map, Number, Value};

use crate::db_helpers::{
    DbTarget, open_db_target, opencode_data_dir, resolve_session_id,
};
use crate::session::model::{
    HostEvent, Session, SessionEvent, SessionMeta, event_matches_any_prefix,
};
use crate::session::provider::SessionProvider;
use crate::session::resolve::ResolveError;
use crate::{
    expand_tilde, iso_to_epoch_ms, normalize_timestamp, safe_json_loads,
};

/// Provider reading sessions from `OpenCode`'s `SQLite` store.
///
/// Construct with [`OpenCodeSessionProvider::new`] to honor the
/// `ZOO_OPENCODE_DATA_DIR` override, or
/// [`OpenCodeSessionProvider::with_data_dir`] for an explicit root (used
/// by tests and by callers that already know the location).
#[derive(Debug, Clone)]
pub struct OpenCodeSessionProvider {
    /// `SQLite` target: the aggregated data directory or an explicit DB.
    target: DbTarget,
    /// Data directory whose `log/opencode.log` backs `host_events`.
    data_dir: String,
}

impl OpenCodeSessionProvider {
    /// Create a provider rooted at the opencode data directory resolved
    /// from `ZOO_OPENCODE_DATA_DIR` (default `~/.local/share/opencode`).
    #[must_use]
    pub fn new() -> Self {
        let data_dir = opencode_data_dir();
        let target = DbTarget::from_cli(None);
        Self { target, data_dir }
    }

    /// Create a provider rooted at an explicit data directory.
    ///
    /// A leading `~` is expanded like elsewhere in this crate.
    #[must_use]
    pub fn with_data_dir(data_dir: impl Into<String>) -> Self {
        let data_dir = data_dir.into();
        let target = DbTarget::Aggregate(data_dir.clone());
        Self { target, data_dir }
    }

    /// Create a provider bound to one explicit `SQLite` database file.
    ///
    /// Supersedes the aggregate view for callers that already know the
    /// exact database (`--db` in the CLI tools). Host lifecycle events
    /// still come from the env-resolved opencode data directory.
    #[must_use]
    pub fn with_db_path(db_path: impl Into<String>) -> Self {
        let target = DbTarget::Path(db_path.into());
        let data_dir = opencode_data_dir();
        Self { target, data_dir }
    }

    /// Absolute path of the host application log
    /// (`<data dir>/log/opencode.log`).
    fn log_path(&self) -> String {
        format!("{}/log/opencode.log", expand_tilde(&self.data_dir))
    }
}

impl Default for OpenCodeSessionProvider {
    fn default() -> Self {
        Self::new()
    }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/// Map one `session` row to its metadata.
fn session_meta_from_row(row: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
    let id: String = row.get("id")?;
    let parent_id: Option<String> = row.get("parent_id")?;
    let directory: Option<String> = row.get("directory")?;
    let title: Option<String> = row.get("title")?;
    let started_at: Option<i64> = row.get("time_created")?;
    let updated_at: Option<i64> = row.get("time_updated")?;
    // The stored title is never truncated; `label` and `title` share it so
    // exact search behaves identically on both hosts.
    let label = title.filter(|t| !t.is_empty());
    Ok(SessionMeta {
        id,
        parent_id,
        cwd: directory.unwrap_or_default(),
        started_at: started_at.unwrap_or(0),
        label: label.clone(),
        title: label,
        updated_at,
        // `model`/`agent` live in the message data and are resolved only
        // when a session is opened (see `query_first_assistant_meta`);
        // `list`/`search` leave them unset to avoid a per-session message
        // scan.
        model: None,
        agent: None,
    })
}

/// Convert a `rusqlite` error into an I/O error.
fn io_other(e: rusqlite::Error) -> io::Error {
    io::Error::other(e)
}

/// Sort session metadata deterministically: by start time, then id.
fn sort_metas(metas: &mut [SessionMeta]) {
    metas.sort_by(|a, b| (a.started_at, &a.id).cmp(&(b.started_at, &b.id)));
}

/// Query every session row in the target.
fn query_all_session_metas(
    conn: &Connection,
) -> rusqlite::Result<Vec<SessionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, directory, title, time_created, \
         time_updated FROM session",
    )?;
    stmt.query_map([], session_meta_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
}

/// Query one session's message+part rows in stream order and translate
/// them into [`SessionEvent`]s.
///
/// The message and part ids are carried on the events that represent them:
/// `Message` ← `message.id`, `ToolUse`/`ToolResult` ← `part.id` (a tool
/// call is a single part, so both events share its id).
fn query_session_events(
    conn: &Connection,
    session_id: &str,
) -> io::Result<Vec<SessionEvent>> {
    let mut stmt = conn
        .prepare(
            "SELECT m.time_created AS msg_time, m.data AS msg_data, \
             p.time_created AS part_time, p.time_updated AS part_time_updated, \
             p.data AS part_data, m.id AS msg_id, p.id AS part_id \
             FROM message m \
             JOIN part p ON p.message_id = m.id \
             WHERE m.session_id = ?1 \
             ORDER BY m.time_created ASC, p.time_created ASC",
        )
        .map_err(io_other)?;
    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            let msg_time: Option<i64> = row.get("msg_time")?;
            let msg_data: String = row.get("msg_data")?;
            let part_time: Option<i64> = row.get("part_time")?;
            let part_time_updated: Option<i64> =
                row.get("part_time_updated")?;
            let part_data: String = row.get("part_data")?;
            let msg_id: String = row.get("msg_id")?;
            let part_id: String = row.get("part_id")?;
            Ok(PartRow {
                msg_time,
                msg_data: safe_json_loads(&msg_data).unwrap_or(Value::Null),
                part_time,
                part_time_updated,
                part_data: safe_json_loads(&part_data).unwrap_or(Value::Null),
                msg_id,
                part_id,
            })
        })
        .map_err(io_other)?;

    let mut events = Vec::new();
    for row in rows.flatten() {
        append_part_events(row, &mut events);
    }
    Ok(events)
}

/// One `message` × `part` join row.
struct PartRow {
    /// `message.time_created` (milliseconds).
    msg_time: Option<i64>,
    /// Parsed `message.data`.
    msg_data: Value,
    /// `part.time_created` (milliseconds).
    part_time: Option<i64>,
    /// `part.time_updated` (milliseconds).
    part_time_updated: Option<i64>,
    /// Parsed `part.data`.
    part_data: Value,
    /// `message.id`.
    msg_id: String,
    /// `part.id`.
    part_id: String,
}

/// Append the [`SessionEvent`]s that one message+part row represents.
///
/// Text parts become `Message`s, tool parts a `ToolUse`/`ToolResult` pair
/// (timed by `state.time.start`/`end`), reasoning parts a `Reasoning`, and
/// step-finish parts a `Usage` carrying the part's reason, reasoning
/// tokens and the message's recorded duration. Unknown part types are
/// skipped.
fn append_part_events(row: PartRow, events: &mut Vec<SessionEvent>) {
    let msg_time = row.msg_time;
    let msg_data = row.msg_data;
    let part_time = row.part_time;
    let part_time_updated = row.part_time_updated;
    let part_data = row.part_data;
    let role = msg_data.get("role").and_then(Value::as_str).unwrap_or("");
    let part_type = part_data.get("type").and_then(Value::as_str).unwrap_or("");
    let part_ms = part_time.or(msg_time).unwrap_or(0);

    match part_type {
        "text" => {
            let text =
                part_data.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() && (role == "user" || role == "assistant") {
                events.push(SessionEvent::Message {
                    id: Some(row.msg_id),
                    role: role.to_string(),
                    text: text.to_string(),
                    timestamp: part_ms,
                });
            }
        }
        "tool" => {
            let name = part_data
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                return;
            }
            let state = part_data.get("state");
            let input = state
                .and_then(|s| s.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            let output = state
                .and_then(|s| s.get("output"))
                .cloned()
                .unwrap_or(Value::Null);
            let is_error =
                state.and_then(|s| s.get("status")).and_then(Value::as_str)
                    == Some("error");
            let time = state.and_then(|s| s.get("time"));
            let start_ms = time
                .and_then(|t| t.get("start"))
                .and_then(Value::as_i64)
                .or(part_time)
                .unwrap_or(part_ms);
            let end_ms = time
                .and_then(|t| t.get("end"))
                .and_then(Value::as_i64)
                .or(part_time_updated)
                .unwrap_or(part_ms);
            events.push(SessionEvent::ToolUse {
                id: Some(row.part_id.clone()),
                name: name.clone(),
                input,
                timestamp: start_ms,
            });
            events.push(SessionEvent::ToolResult {
                id: Some(row.part_id),
                name,
                output: value_to_output(&output),
                is_error,
                timestamp: end_ms,
            });
        }
        "reasoning" => {
            let text =
                part_data.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                events.push(SessionEvent::Reasoning {
                    text: text.to_string(),
                    timestamp: part_ms,
                    id: Some(row.part_id),
                });
            }
        }
        "step-finish" => {
            events.push(usage_from_step_finish(
                &part_data, &msg_data, part_ms, row.msg_id,
            ));
        }
        // unknown part types are skipped
        _ => {}
    }
}

/// Build the `Usage` event one `step-finish` part represents.
///
/// The reason and reasoning-token count come from the part data; the
/// message id from the owning message; the duration from the message's
/// `time.completed - time.created` when both are recorded; the model from
/// the owning message's `model` field.
#[must_use]
fn usage_from_step_finish(
    part_data: &Value,
    msg_data: &Value,
    timestamp: i64,
    message_id: String,
) -> SessionEvent {
    let tokens = part_data.get("tokens");
    let cache = tokens.and_then(|t| t.get("cache"));
    let input = tokens.and_then(|t| t.get("input")).map_or(0, num_to_i64);
    let output = tokens.and_then(|t| t.get("output")).map_or(0, num_to_i64);
    let cache_read = cache.and_then(|c| c.get("read")).map_or(0, num_to_i64);
    let cache_write = cache.and_then(|c| c.get("write")).map_or(0, num_to_i64);
    let reasoning =
        tokens.and_then(|t| t.get("reasoning")).map_or(0, num_to_i64);
    let cost = part_data.get("cost").and_then(Value::as_f64);
    let reason = part_data
        .get("reason")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let duration_ms = msg_data
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(Value::as_i64)
        .zip(
            msg_data
                .get("time")
                .and_then(|t| t.get("completed"))
                .and_then(Value::as_i64),
        )
        .map(|(created, completed)| (completed - created).max(0));
    SessionEvent::Usage {
        input,
        output,
        cache_read,
        cache_write,
        cost,
        timestamp,
        reasoning,
        reason,
        message_id: Some(message_id),
        duration_ms,
        model: message_model(msg_data),
    }
}

/// Model recorded on an `OpenCode` message, formatted `providerID/modelID`.
///
/// Handles both the structured `model: {providerID, modelID}` object and
/// the legacy flat `modelID` string. Returns `None` when the message
/// records no model id.
#[must_use]
fn message_model(msg_data: &Value) -> Option<String> {
    let (provider, model_id) = match msg_data.get("model") {
        Some(Value::Object(obj)) => (
            obj.get("providerID")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty()),
            obj.get("modelID")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty()),
        ),
        _ => (
            None,
            msg_data
                .get("modelID")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty()),
        ),
    };
    let model_id = model_id?;
    Some(provider.map_or_else(
        || model_id.to_string(),
        |provider| format!("{provider}/{model_id}"),
    ))
}

/// Query the model and agent of the session's first assistant message.
///
/// Walks messages in creation order and stops at the first
/// `role == "assistant"` row. Returns `(model, agent)`; the model is
/// formatted `providerID/modelID`, the agent is the message's `agent`
/// field. Both stay `None` when the session has no assistant message.
fn query_first_assistant_meta(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<(Option<String>, Option<String>)> {
    let mut stmt = conn.prepare(
        "SELECT data FROM message WHERE session_id = ?1 \
         ORDER BY time_created ASC, id ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        let data: String = row.get("data")?;
        Ok(safe_json_loads(&data).unwrap_or(Value::Null))
    })?;
    for row in rows.flatten() {
        if row.get("role").and_then(Value::as_str) == Some("assistant") {
            let model = message_model(&row);
            let agent = row
                .get("agent")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
            return Ok((model, agent));
        }
    }
    Ok((None, None))
}

/// Render a tool output value as a string: bare strings stay unchanged,
/// structured values are serialized to JSON.
fn value_to_output(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Convert a JSON number to an integer: integers pass through, reals are
/// rounded to the nearest integer (some schemas store token counts as
/// reals like `3425.5`). Rounding happens before string conversion so a
/// fractional value never fails the `i64` parse and silently becomes 0.
fn num_to_i64(v: &Value) -> i64 {
    v.as_i64().unwrap_or_else(|| {
        v.as_f64()
            .and_then(|f| f.round().to_string().parse::<i64>().ok())
            .unwrap_or(0)
    })
}

impl SessionProvider for OpenCodeSessionProvider {
    fn list(&self) -> io::Result<Vec<SessionMeta>> {
        let Some(conn) = open_db_target(&self.target) else {
            return Ok(Vec::new());
        };
        let mut metas = query_all_session_metas(&conn).map_err(io_other)?;
        sort_metas(&mut metas);
        Ok(metas)
    }

    fn open(&self, id_or_prefix: &str) -> Result<Session, ResolveError> {
        let id = match resolve_session_id(id_or_prefix, &self.target) {
            Ok(Some(id)) => id,
            Ok(None) => {
                return Err(ResolveError::NotFound {
                    id: id_or_prefix.to_string(),
                    tried_hosts: vec!["opencode".to_string()],
                });
            }
            Err(amb) => {
                return Err(ResolveError::Ambiguous {
                    prefix: amb.prefix,
                    matches: amb.matches,
                });
            }
        };

        let Some(conn) = open_db_target(&self.target) else {
            return Err(ResolveError::NotFound {
                id: id_or_prefix.to_string(),
                tried_hosts: vec!["opencode".to_string()],
            });
        };

        let mut meta = conn
            .query_row(
                "SELECT id, parent_id, directory, title, time_created, \
                 time_updated FROM session WHERE id = ?1",
                rusqlite::params![id],
                session_meta_from_row,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    ResolveError::NotFound {
                        id: id_or_prefix.to_string(),
                        tried_hosts: vec!["opencode".to_string()],
                    }
                }
                other => ResolveError::Io(io_other(other)),
            })?;

        // The session-level model and agent live on the first assistant
        // message's data; opening resolves them so `show`-style views can
        // display them without a per-session scan on `list`/`search`.
        if let Ok((model, agent)) = query_first_assistant_meta(&conn, &meta.id)
        {
            meta.model = model;
            meta.agent = agent;
        }

        let events =
            query_session_events(&conn, &meta.id).map_err(ResolveError::Io)?;
        Ok(Session { meta, events })
    }

    fn search(&self, query: &str) -> io::Result<Vec<SessionMeta>> {
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let Some(conn) = open_db_target(&self.target) else {
            return Ok(Vec::new());
        };
        // Title match, or any message/text / tool-result output match.
        // `json_extract` limits the content match to text fields, so JSON
        // keys and metadata never match.
        let pattern = format!("%{query}%");
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, directory, title, time_created, \
                 time_updated \
                 FROM session \
                 WHERE title LIKE ?1 \
                    OR EXISTS ( \
                        SELECT 1 FROM message m \
                        JOIN part p ON p.message_id = m.id \
                        WHERE m.session_id = session.id \
                          AND (json_extract(p.data, '$.text') LIKE ?1 \
                               OR json_extract(p.data, '$.state.output') \
                                  LIKE ?1) \
                    )",
            )
            .map_err(io_other)?;
        let rows = stmt
            .query_map(rusqlite::params![pattern], session_meta_from_row)
            .map_err(io_other)?;
        let mut metas: Vec<SessionMeta> = rows.flatten().collect();
        sort_metas(&mut metas);
        Ok(metas)
    }

    fn find_events(
        &self,
        ids: &[String],
        max_sessions: usize,
    ) -> io::Result<Vec<(SessionMeta, Vec<SessionEvent>)>> {
        if ids.is_empty() || max_sessions == 0 {
            return Ok(Vec::new());
        }
        let Some(conn) = open_db_target(&self.target) else {
            return Ok(Vec::new());
        };
        let limit = i64::try_from(max_sessions).unwrap_or(i64::MAX);

        // One single query resolves every session at once: the row set is
        // restricted to the target id prefixes and the newest sessions,
        // so no per-session open is needed. `substr` equality is a
        // case-sensitive prefix match mirroring the in-memory event
        // filter; message parts match on either the message id or their
        // own part id.
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(limit)];
        let mut conds: Vec<String> = Vec::new();
        for id in ids {
            conds.push(
                "(substr(m.id, 1, length(?)) = ? \
                 OR substr(p.id, 1, length(?)) = ?)"
                    .to_string(),
            );
            for _ in 0..4 {
                params.push(Box::new(id.clone()));
            }
        }
        let sql = format!(
            "SELECT m.session_id, m.time_created AS msg_time, \
             m.data AS msg_data, p.time_created AS part_time, \
             p.time_updated AS part_time_updated, p.data AS part_data, \
             m.id AS msg_id, p.id AS part_id \
             FROM message m \
             JOIN part p ON p.message_id = m.id \
             WHERE m.session_id IN (SELECT id FROM session \
                                    ORDER BY time_updated DESC LIMIT ?1) \
               AND ({}) \
             ORDER BY m.time_created ASC, p.time_created ASC",
            conds.join(" OR ")
        );
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(std::convert::AsRef::as_ref).collect();
        let mut stmt = conn.prepare(&sql).map_err(io_other)?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                let msg_time: Option<i64> = row.get("msg_time")?;
                let msg_data: String = row.get("msg_data")?;
                let part_time: Option<i64> = row.get("part_time")?;
                let part_time_updated: Option<i64> =
                    row.get("part_time_updated")?;
                let part_data: String = row.get("part_data")?;
                let msg_id: String = row.get("msg_id")?;
                let part_id: String = row.get("part_id")?;
                let session_id: String = row.get("session_id")?;
                Ok((
                    session_id,
                    PartRow {
                        msg_time,
                        msg_data: safe_json_loads(&msg_data)
                            .unwrap_or(Value::Null),
                        part_time,
                        part_time_updated,
                        part_data: safe_json_loads(&part_data)
                            .unwrap_or(Value::Null),
                        msg_id,
                        part_id,
                    },
                ))
            })
            .map_err(io_other)?;

        // Group rows by session in first-appearance (stream) order.
        let mut sids: Vec<String> = Vec::new();
        let mut by_session: HashMap<String, Vec<PartRow>> = HashMap::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (sid, part_row) in rows.flatten() {
            if seen.insert(sid.clone()) {
                sids.push(sid.clone());
            }
            by_session.entry(sid).or_default().push(part_row);
        }

        let mut out = Vec::new();
        for sid in &sids {
            let meta = conn
                .query_row(
                    "SELECT id, parent_id, directory, title, time_created, \
                     time_updated FROM session WHERE id = ?1",
                    rusqlite::params![sid],
                    session_meta_from_row,
                )
                .map_err(io_other)?;
            let mut events = Vec::new();
            let part_rows = by_session.remove(sid).unwrap_or_default();
            for part_row in part_rows {
                append_part_events(part_row, &mut events);
            }
            // A message-id hit pulls in all of its parts; keep only the
            // events whose own id actually matches a wanted prefix.
            events.retain(|ev| event_matches_any_prefix(ev, ids));
            if !events.is_empty() {
                out.push((meta, events));
            }
        }
        Ok(out)
    }

    fn host_events(&self, session_id: &str) -> Option<Vec<HostEvent>> {
        let sid = match resolve_session_id(session_id, &self.target) {
            Ok(Some(id)) => id,
            _ => session_id.to_string(),
        };
        let content = std::fs::read_to_string(self.log_path()).ok()?;
        let mut events = Vec::new();
        for line in content.lines() {
            let Some(entry) = parse_opencode_line(line) else {
                continue;
            };
            let matched = entry
                .get("session_id")
                .or_else(|| entry.get("id"))
                .filter(|s| !s.is_empty())
                .map(String::as_str);
            if matched != Some(sid.as_str()) {
                continue;
            }
            let classified = classify_opencode(&entry);
            events.push(host_event_from_classified(&classified, &entry));
        }
        Some(events)
    }
}

// ── opencode.log parsing (migrated from ztrace) ──────────────────────────────

/// Map a tool identifier string to a trace event type and icon.
///
/// Accepts both permission and tool name fields.
#[must_use]
fn tool_type_and_icon(tool_id: &str) -> (String, String) {
    match tool_id {
        "read" | "grep" | "glob" => ("tool_read".to_string(), "▶".to_string()),
        "edit" | "write" => ("tool_write".to_string(), "◀".to_string()),
        "bash" => ("tool_exec".to_string(), "⚙".to_string()),
        "task" => ("tool_orch".to_string(), "◈".to_string()),
        _ => ("tool_other".to_string(), "◆".to_string()),
    }
}

/// Parse a single opencode `key=value` log line into a map.
///
/// Uses `shlex` to split tokens; `.`-separated keys are normalized to
/// underscores (`session.id` → `session_id`), and surrounding double
/// quotes are stripped. Returns `None` for empty or unparseable lines.
#[must_use]
fn parse_opencode_line(line: &str) -> Option<HashMap<String, String>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let tokens = shlex::split(trimmed)?;
    let mut entry: HashMap<String, String> = HashMap::new();

    for token in &tokens {
        if let Some(pos) = token.find('=') {
            let key = &token[..pos];
            let mut value = token[pos + 1..].to_string();

            // Strip surrounding double quotes if present.
            if value.len() >= 2
                && value.starts_with('"')
                && value.ends_with('"')
            {
                let new_len = value.len() - 1;
                value = value[1..new_len].to_string();
            }

            // Normalize key names (session.id -> session_id).
            let key = key.replace('.', "_");
            entry.insert(key, value);
        }
    }

    if entry.is_empty() { None } else { Some(entry) }
}

/// Build the detail map for a session-created event.
fn build_created_detail(
    entry: &HashMap<String, String>,
    slug: &str,
    agent: &str,
    model_id: &str,
    model_provider: &str,
) -> Map<String, Value> {
    let mut detail = Map::new();
    detail.insert(
        "id".to_string(),
        Value::String(entry.get("id").cloned().unwrap_or_default()),
    );
    detail.insert("slug".to_string(), Value::String(slug.to_string()));
    detail.insert("agent".to_string(), Value::String(agent.to_string()));
    detail.insert("model_id".to_string(), Value::String(model_id.to_string()));
    detail.insert(
        "model_provider".to_string(),
        Value::String(model_provider.to_string()),
    );
    detail.insert(
        "title".to_string(),
        Value::String(entry.get("title").cloned().unwrap_or_default()),
    );
    detail.insert(
        "parent_id".to_string(),
        Value::String(entry.get("parent_id").cloned().unwrap_or_default()),
    );
    detail.insert(
        "project_id".to_string(),
        Value::String(entry.get("projectID").cloned().unwrap_or_default()),
    );
    detail.insert(
        "cost".to_string(),
        Value::String(
            entry.get("cost").cloned().unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail.insert(
        "tokens_input".to_string(),
        Value::String(
            entry
                .get("tokens_input")
                .cloned()
                .unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail.insert(
        "tokens_output".to_string(),
        Value::String(
            entry
                .get("tokens_output")
                .cloned()
                .unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail
}

/// Build a session-created event from an opencode log entry.
#[must_use]
fn classify_opencode_created(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let slug = entry.get("slug").map_or("", std::string::String::as_str);
    let agent = entry.get("agent").map_or("", std::string::String::as_str);
    let model_id =
        entry.get("model_id").map_or("", std::string::String::as_str);
    let model_provider =
        entry.get("model_providerID").map_or("", std::string::String::as_str);
    let title = entry
        .get("title")
        .map(std::string::String::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(slug);

    let mut parts: Vec<String> = Vec::new();
    if !slug.is_empty() {
        parts.push(slug.to_string());
    }
    if !agent.is_empty() {
        parts.push(format!("agent={agent}"));
    }
    if !model_id.is_empty() {
        parts.push(format!("model={model_id}"));
    }
    if !model_provider.is_empty() {
        parts.push(format!("provider={model_provider}"));
    }

    let summary = if parts.is_empty() {
        if title.is_empty() || title == slug {
            format!("Session {slug}")
        } else {
            format!("Session {slug}: {title}")
        }
    } else {
        format!("Session {} ({})", slug, parts.join(", "))
    };

    let detail =
        build_created_detail(entry, slug, agent, model_id, model_provider);

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a loop-step event from an opencode log entry.
#[must_use]
fn classify_opencode_loop(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let step = entry.get("step").cloned().unwrap_or_else(|| "0".to_string());
    let mut detail = Map::new();
    detail.insert("step".to_string(), Value::String(step.clone()));
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("Loop step={step}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a process-message event from an opencode log entry.
#[must_use]
fn classify_opencode_process(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let mut detail = Map::new();
    detail.insert(
        "message_id".to_string(),
        Value::String(entry.get("messageID").cloned().unwrap_or_default()),
    );
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("💬".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String("Process message".to_string()),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an exiting-loop event from an opencode log entry.
#[must_use]
fn classify_opencode_exiting_loop(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let mut detail = Map::new();
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert("summary".to_string(), Value::String("Exiting loop".to_string()));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an LLM-runtime-selected event from an opencode log entry.
#[must_use]
fn classify_opencode_llm_runtime(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let provider =
        entry.get("llm_provider").cloned().unwrap_or_else(|| "?".to_string());
    let model =
        entry.get("llm_model").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("provider".to_string(), Value::String(provider.clone()));
    detail.insert("model".to_string(), Value::String(model.clone()));
    detail.insert(
        "runtime".to_string(),
        Value::String(entry.get("llm_runtime").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("llm".to_string()));
    ev.insert("icon".to_string(), Value::String("▲".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("LLM {provider}/{model}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a stream event from an opencode log entry.
#[must_use]
fn classify_opencode_stream(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let provider =
        entry.get("providerID").cloned().unwrap_or_else(|| "?".to_string());
    let model =
        entry.get("modelID").cloned().unwrap_or_else(|| "?".to_string());
    let agent = entry.get("agent").cloned().unwrap_or_else(|| "?".to_string());
    let mode = entry.get("mode").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("provider".to_string(), Value::String(provider.clone()));
    detail.insert("model".to_string(), Value::String(model.clone()));
    detail.insert("agent".to_string(), Value::String(agent.clone()));
    detail.insert("mode".to_string(), Value::String(mode.clone()));

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("llm_stream".to_string()));
    ev.insert("icon".to_string(), Value::String("▲".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!(
            "Stream {provider}/{model} agent={agent} ({mode})"
        )),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an evaluated event (permission check or tool call).
#[must_use]
fn classify_opencode_evaluated(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let permission =
        entry.get("permission").cloned().unwrap_or_else(|| "?".to_string());
    let pattern = entry.get("pattern").cloned().unwrap_or_default();
    let action =
        entry.get("action_action").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("permission".to_string(), Value::String(permission.clone()));
    detail.insert("pattern".to_string(), Value::String(pattern.clone()));
    detail.insert("action".to_string(), Value::String(action.clone()));

    if action == "deny" {
        // Denied → permission event.
        let mut ev = Map::new();
        ev.insert(
            "timestamp".to_string(),
            Value::String(timestamp.to_string()),
        );
        ev.insert("source".to_string(), Value::String("opencode".to_string()));
        ev.insert("type".to_string(), Value::String("permission".to_string()));
        ev.insert("icon".to_string(), Value::String("▼".to_string()));
        ev.insert(
            "summary".to_string(),
            Value::String(format!("permission=deny {permission} {pattern}")),
        );
        ev.insert("detail".to_string(), Value::Object(detail));
        return Value::Object(ev);
    }

    // Allowed → tool call (classified by permission).
    let (event_type, icon) = tool_type_and_icon(&permission);

    // Parse duration field if present.
    if let Some(dur_str) = entry.get("duration")
        && let Ok(dur) = dur_str.parse::<f64>()
    {
        detail.insert(
            "duration_sec".to_string(),
            Number::from_f64(dur).map_or(Value::Null, Value::Number),
        );
    }

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String(event_type));
    ev.insert("icon".to_string(), Value::String(icon));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("{permission}: {pattern}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a file-touch event from an opencode log entry.
#[must_use]
fn classify_opencode_touching_file(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let file_path = entry.get("file").cloned().unwrap_or_default();
    let action =
        entry.get("action").cloned().unwrap_or_else(|| "edit".to_string());

    let mut detail = Map::new();
    detail.insert("file".to_string(), Value::String(file_path.clone()));
    detail.insert("action".to_string(), Value::String(action.clone()));

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("file".to_string()));
    ev.insert("icon".to_string(), Value::String("■".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("{action}: {file_path}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a fallback hook event for unrecognized opencode messages.
#[must_use]
fn classify_opencode_fallback(
    entry: &HashMap<String, String>,
    timestamp: &str,
    msg: &str,
) -> Value {
    let summary = if msg.is_empty() {
        "opencode event".to_string()
    } else {
        format!("opencode: {msg}")
    };

    // Build detail from the entire entry.
    let mut detail = Map::new();
    for (k, v) in entry {
        detail.insert(k.clone(), Value::String(v.clone()));
    }

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("hook".to_string()));
    ev.insert("icon".to_string(), Value::String("◈".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Convert a parsed opencode log entry to a unified event value.
///
/// Match on `entry["message"]`:
/// - `"created"` → session creation event
/// - `"loop"` → loop step event
/// - `"process"` → process message event
/// - `"exiting loop"` → loop exit event
/// - `"llm runtime selected"` → LLM runtime selection
/// - `"stream"` → LLM stream event
/// - `"evaluated"` → permission check or tool call
/// - `"touching file"` → file touch event
/// - fallback → hook event
#[must_use]
fn classify_opencode(entry: &HashMap<String, String>) -> Value {
    let msg = entry.get("message").map_or("", std::string::String::as_str);
    let timestamp = normalize_timestamp(
        entry.get("timestamp").map_or("", std::string::String::as_str),
    );

    match msg {
        "created" => classify_opencode_created(entry, &timestamp),
        "loop" => classify_opencode_loop(entry, &timestamp),
        "process" => classify_opencode_process(entry, &timestamp),
        "exiting loop" => classify_opencode_exiting_loop(entry, &timestamp),
        "llm runtime selected" => {
            classify_opencode_llm_runtime(entry, &timestamp)
        }
        "stream" => classify_opencode_stream(entry, &timestamp),
        "evaluated" => classify_opencode_evaluated(entry, &timestamp),
        "touching file" => classify_opencode_touching_file(entry, &timestamp),
        _ => classify_opencode_fallback(entry, &timestamp, msg),
    }
}

/// Convert a classified opencode event into a [`HostEvent`].
///
/// The kind is the classification name (`entry["message"]`); the data
/// payload keeps the classified event's native fields (source, type,
/// icon, summary, detail, timestamp).
fn host_event_from_classified(
    ev: &Value,
    entry: &HashMap<String, String>,
) -> HostEvent {
    HostEvent {
        timestamp: ev
            .get("timestamp")
            .and_then(Value::as_str)
            .map_or(0, iso_to_epoch_ms),
        kind: entry.get("message").cloned().unwrap_or_default(),
        summary: ev
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        data: ev.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_db::{create_common_tables, create_part_table};
    use std::fs;
    use std::sync::Mutex;

    /// Mutex to serialize DB-creating tests (they share a temp file name).
    static DB_MUTEX: Mutex<()> = Mutex::new(());

    /// Create a temporary directory holding an `opencode.db` with
    /// session/message/part fixtures for `ses-001` and its child
    /// `ses-002`. Returns the dir path; the caller removes it after the
    /// test.
    fn create_test_db() -> String {
        use crate::test_db::{create_common_tables, create_part_table};
        let dir = std::env::temp_dir()
            .join(format!("zutil_opencode_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");

        let conn =
            Connection::open(dir.join("opencode.db")).expect("open test db");
        create_common_tables(&conn);
        create_part_table(&conn);
        insert_sessions(&conn);
        insert_events(&conn);
        conn.close().expect("close test db");
        dir.to_string_lossy().to_string()
    }

    fn insert_sessions(conn: &Connection) {
        conn.execute(
            "INSERT INTO session (id, parent_id, title, directory, \
             time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "ses-001",
                Option::<&str>::None,
                "refactor parser",
                "/app",
                1_715_000_000_000_i64,
                1_715_000_080_000_i64,
            ],
        )
        .expect("insert ses-001");
        conn.execute(
            "INSERT INTO session (id, parent_id, title, directory, \
             time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "ses-002",
                "ses-001",
                "child run",
                "/app",
                1_715_000_400_000_i64,
                1_715_000_450_000_i64,
            ],
        )
        .expect("insert ses-002");
    }

    fn insert_message(
        conn: &Connection,
        id: &str,
        sid: &str,
        time: i64,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, sid, time, data],
        )
        .expect("insert message");
    }

    fn insert_part(
        conn: &Connection,
        id: &str,
        msg_id: &str,
        sid: &str,
        time: i64,
        updated: i64,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, msg_id, sid, time, updated, data],
        )
        .expect("insert part");
    }

    /// One session's message+part fixture covering every mapping:
    /// user text, tool with start/end, step-finish tokens, error tool.
    fn insert_events(conn: &Connection) {
        insert_message(
            conn,
            "msg-001",
            "ses-001",
            1_715_000_010_000,
            r#"{"role":"user","agent":"beaver"}"#,
        );
        insert_part(
            conn,
            "part-001",
            "msg-001",
            "ses-001",
            1_715_000_010_000,
            1_715_000_010_000,
            r#"{"type":"text","text":"refactor the parser module"}"#,
        );

        insert_message(
            conn,
            "msg-002",
            "ses-001",
            1_715_000_020_000,
            r#"{"role":"assistant","agent":"beaver","modelID":"gpt-4","time":{"created":1715000020000,"completed":1715000090000}}"#,
        );
        insert_part(
            conn,
            "part-002",
            "msg-002",
            "ses-001",
            1_715_000_021_000,
            1_715_000_025_000,
            r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/parser.rs"},"output":"src/parser.rs\n","time":{"start":1715000021000,"end":1715000025000},"status":"completed"}}"#,
        );
        insert_part(
            conn,
            "part-003",
            "msg-002",
            "ses-001",
            1_715_000_022_000,
            1_715_000_022_000,
            r#"{"type":"step-finish","tokens":{"input":100,"output":50,"cache":{"read":30,"write":40},"reasoning":5},"cost":0.005,"reason":"completed"}"#,
        );
        insert_part(
            conn,
            "part-005",
            "msg-002",
            "ses-001",
            1_715_000_021_500,
            1_715_000_021_500,
            r#"{"type":"reasoning","text":"let me think about the parser"}"#,
        );

        insert_message(
            conn,
            "msg-003",
            "ses-001",
            1_715_000_050_000,
            r#"{"role":"assistant","agent":"beaver"}"#,
        );
        insert_part(
            conn,
            "part-004",
            "msg-003",
            "ses-001",
            1_715_000_051_000,
            1_715_000_052_000,
            r#"{"type":"tool","tool":"bash","state":{"input":{"command":"rm -rf /"},"output":"permission denied","time":{"start":1715000051000,"end":1715000052000},"status":"error"}}"#,
        );
    }

    /// The events `open` must produce for [`insert_events`].
    /// Order follows the query's `(message, part)` sort: part-002,
    /// part-005, part-003 within msg-002.
    fn expected_events() -> Vec<SessionEvent> {
        vec![
            SessionEvent::Message {
                id: Some("msg-001".to_string()),
                role: "user".to_string(),
                text: "refactor the parser module".to_string(),
                timestamp: 1_715_000_010_000,
            },
            SessionEvent::ToolUse {
                id: Some("part-002".to_string()),
                name: "read".to_string(),
                input: serde_json::json!({"filePath": "src/parser.rs"}),
                timestamp: 1_715_000_021_000,
            },
            SessionEvent::ToolResult {
                id: Some("part-002".to_string()),
                name: "read".to_string(),
                output: "src/parser.rs\n".to_string(),
                is_error: false,
                timestamp: 1_715_000_025_000,
            },
            SessionEvent::Reasoning {
                text: "let me think about the parser".to_string(),
                timestamp: 1_715_000_021_500,
                id: Some("part-005".to_string()),
            },
            SessionEvent::Usage {
                input: 100,
                output: 50,
                cache_read: 30,
                cache_write: 40,
                cost: Some(0.005),
                timestamp: 1_715_000_022_000,
                reasoning: 5,
                reason: Some("completed".to_string()),
                message_id: Some("msg-002".to_string()),
                duration_ms: Some(70_000),
                model: Some("gpt-4".to_string()),
            },
            SessionEvent::ToolUse {
                id: Some("part-004".to_string()),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "rm -rf /"}),
                timestamp: 1_715_000_051_000,
            },
            SessionEvent::ToolResult {
                id: Some("part-004".to_string()),
                name: "bash".to_string(),
                output: "permission denied".to_string(),
                is_error: true,
                timestamp: 1_715_000_052_000,
            },
        ]
    }

    #[test]
    fn test_list_includes_children() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        let metas = provider.list().expect("list");
        assert_eq!(metas.len(), 2, "root and child session");

        let child =
            metas.iter().find(|m| m.id == "ses-002").expect("child present");
        assert_eq!(child.parent_id.as_deref(), Some("ses-001"));
        assert_eq!(child.label.as_deref(), Some("child run"));
        assert_eq!(child.cwd, "/app");
        assert_eq!(child.started_at, 1_715_000_400_000);
        assert_eq!(child.updated_at, Some(1_715_000_450_000));

        let root =
            metas.iter().find(|m| m.id == "ses-001").expect("root present");
        assert_eq!(root.parent_id, None);
        assert_eq!(root.started_at, 1_715_000_000_000);
        assert_eq!(root.updated_at, Some(1_715_000_080_000));

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_open_translates_message_tool_usage() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        let session = provider.open("ses-001").expect("open session");
        assert_eq!(session.meta.id, "ses-001");
        assert_eq!(session.meta.label.as_deref(), Some("refactor parser"));
        assert_eq!(session.meta.updated_at, Some(1_715_000_080_000));
        assert_eq!(
            session.meta.model.as_deref(),
            Some("gpt-4"),
            "model comes from the first assistant message"
        );
        assert_eq!(
            session.meta.agent.as_deref(),
            Some("beaver"),
            "agent comes from the message data"
        );
        assert_eq!(session.events, expected_events());

        // Pin the provider mapping: reason/reasoning come from the
        // step-finish fixture part, duration from the message time fields.
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
                assert_eq!(*reasoning, 5, "step-finish tokens.reasoning");
                assert_eq!(reason.as_deref(), Some("completed"));
                assert_eq!(message_id.as_deref(), Some("msg-002"));
                assert_eq!(*duration_ms, Some(70_000), "message time diff");
                assert_eq!(
                    model.as_deref(),
                    Some("gpt-4"),
                    "message data model"
                );
            }
            other => panic!("expected usage, got {other:?}"),
        }
        assert_eq!(
            session.events[3],
            SessionEvent::Reasoning {
                text: "let me think about the parser".to_string(),
                timestamp: 1_715_000_021_500,
                id: Some("part-005".to_string()),
            },
            "reasoning part maps to Reasoning"
        );

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_open_child_session_has_empty_events() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        let session = provider.open("ses-002").expect("open child");
        assert_eq!(session.meta.parent_id.as_deref(), Some("ses-001"));
        assert!(session.events.is_empty());

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_open_prefix_resolution_and_errors() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        // Unique prefix resolves to the full session.
        let session = provider.open("ses-002").expect("prefix open");
        assert_eq!(session.meta.id, "ses-002");

        // Shared prefix is ambiguous.
        let err = provider.open("ses-00").expect_err("must be ambiguous");
        match err {
            ResolveError::Ambiguous { prefix, matches } => {
                assert_eq!(prefix, "ses-00");
                assert!(matches.iter().any(|m| m == "ses-001"), "{matches:?}");
                assert!(matches.iter().any(|m| m == "ses-002"), "{matches:?}");
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }

        // Unknown ids and empty input are not found.
        for id in ["zzz-no-such", ""] {
            let err = provider.open(id).expect_err("must be not found");
            assert!(matches!(err, ResolveError::NotFound { .. }), "id {id:?}");
        }

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_search_title_and_content() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        // Title hit and message-text hit, case-insensitive.
        for query in ["parser", "PARSER", "refactor the parser"] {
            let hits = provider.search(query).expect("search ok");
            assert_eq!(hits.len(), 1, "query {query:?} must hit");
            assert_eq!(hits[0].id, "ses-001");
            assert_eq!(hits[0].updated_at, Some(1_715_000_080_000));
        }
        // Tool-result output hit.
        let hits = provider.search("permission denied").expect("search ok");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "ses-001");
        // Misses: no such term, and JSON keys are not searched.
        for query in ["zzz-nowhere", "filePath", "state", "tool"] {
            let hits = provider.search(query).expect("search ok");
            assert!(hits.is_empty(), "query {query:?} must miss, got {hits:?}");
        }
        // Empty query never matches everything.
        assert!(provider.search("").expect("search ok").is_empty());

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_list_missing_db_is_empty() {
        let dir = std::env::temp_dir()
            .join(format!("zutil_opencode_empty_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create empty dir");

        let provider =
            OpenCodeSessionProvider::with_data_dir(dir.to_string_lossy());
        assert!(provider.list().expect("list on empty dir").is_empty());
        assert!(provider.search("x").expect("search on empty dir").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    /// Write a temp `log/opencode.log` fixture under `dir` with lines for
    /// two sessions.
    fn write_log_fixture(dir: &std::path::Path) {
        let log_dir = dir.join("log");
        fs::create_dir_all(&log_dir).expect("create log dir");
        let content = r#"timestamp=2025-01-09T12:34:56Z level=info message="created" session_id=ses-001 id=ses-001 slug=my-session agent=beaver model_id=gpt-4 model_providerID=openai title="Debug auth"
timestamp=2025-01-09T12:35:00Z level=info message="loop" session_id=ses-001 step=1
timestamp=2025-01-09T12:35:10Z level=info message="created" session_id=ses-999 id=ses-999 slug=other
timestamp=2025-01-09T12:36:00Z level=info message="evaluated" session_id=ses-001 permission=read pattern=src/main.rs action_action=allow duration=1.5"#;
        fs::write(log_dir.join("opencode.log"), content).expect("write log");
    }

    #[test]
    fn test_host_events_parses_and_filters_by_session() {
        let dir = std::env::temp_dir()
            .join(format!("zutil_opencode_log_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_log_fixture(&dir);
        let provider =
            OpenCodeSessionProvider::with_data_dir(dir.to_string_lossy());

        let events = provider.host_events("ses-001").expect("events");
        assert_eq!(events.len(), 3, "created, loop, evaluated");
        assert_eq!(events[0].kind, "created");
        assert_eq!(
            events[0].timestamp,
            crate::iso_to_epoch_ms("2025-01-09T12:34:56Z")
        );
        assert!(
            events[0].summary.contains("my-session"),
            "summary: {}",
            events[0].summary
        );
        assert_eq!(events[0].data["type"], "session");
        assert_eq!(events[0].data["detail"]["slug"], "my-session");

        assert_eq!(events[1].kind, "loop");
        assert_eq!(events[1].summary, "Loop step=1");

        assert_eq!(events[2].kind, "evaluated");
        assert_eq!(events[2].data["type"], "tool_read");
        assert!(
            (events[2].data["detail"]["duration_sec"].as_f64().unwrap() - 1.5)
                .abs()
                < 0.001
        );

        // The other session's line is filtered out.
        let other = provider.host_events("ses-999").expect("events");
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].kind, "created");

        // Log exists but no line matches this id.
        assert!(provider.host_events("ses-000").expect("events").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_host_events_missing_log_is_none() {
        let dir = std::env::temp_dir()
            .join(format!("zutil_opencode_nolog_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create empty dir");

        let provider =
            OpenCodeSessionProvider::with_data_dir(dir.to_string_lossy());
        assert!(provider.host_events("ses-001").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_opencode_line_dot_normalization() {
        let entry = parse_opencode_line("session.id=ses-001 message=loop")
            .expect("parse");
        assert_eq!(
            entry.get("session_id").map(String::as_str),
            Some("ses-001")
        );
        assert_eq!(entry.get("message"), Some(&"loop".to_string()));
    }

    #[test]
    fn test_with_db_path_binds_explicit_file_only() {
        // Two databases with different session ids; an explicit-path
        // provider must see only its own file, never the sibling.
        let dir = std::env::temp_dir()
            .join(format!("zutil_opencode_dbpath_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");
        let first = dir.join("first.db");
        let second = dir.join("second.db");
        for (path, id) in [(&first, "ses-first"), (&second, "ses-second")] {
            let conn = Connection::open(path).expect("open fixture db");
            create_common_tables(&conn);
            create_part_table(&conn);
            conn.execute(
                "INSERT INTO session (id) VALUES (?1)",
                rusqlite::params![id],
            )
            .expect("insert session");
            conn.close().expect("close fixture db");
        }

        let provider = OpenCodeSessionProvider::with_db_path(
            first.to_string_lossy().to_string(),
        );
        let metas =
            provider.list().expect("list must read only the bound file");
        assert_eq!(metas.len(), 1, "only the explicit db contributes");
        assert_eq!(metas[0].id, "ses-first");
        assert!(provider.open("ses-second").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_events_matches_message_and_tool_prefixes() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        // A missing DB behaves like an empty scan, not an error.
        let none =
            OpenCodeSessionProvider::with_data_dir(db_path.clone() + "-nope");
        assert!(
            none.find_events(&["msg-001".into()], 10).expect("find").is_empty()
        );

        let hits = provider
            .find_events(&["msg-001".into(), "part-002".into()], 10)
            .expect("find");
        assert_eq!(hits.len(), 1, "only ses-001 matches");
        let (meta, events) = &hits[0];
        assert_eq!(meta.id, "ses-001");
        assert_eq!(meta.label.as_deref(), Some("refactor parser"));
        assert_eq!(
            *events,
            vec![
                SessionEvent::Message {
                    id: Some("msg-001".to_string()),
                    role: "user".to_string(),
                    text: "refactor the parser module".to_string(),
                    timestamp: 1_715_000_010_000,
                },
                SessionEvent::ToolUse {
                    id: Some("part-002".to_string()),
                    name: "read".to_string(),
                    input: serde_json::json!({"filePath": "src/parser.rs"}),
                    timestamp: 1_715_000_021_000,
                },
                SessionEvent::ToolResult {
                    id: Some("part-002".to_string()),
                    name: "read".to_string(),
                    output: "src/parser.rs\n".to_string(),
                    is_error: false,
                    timestamp: 1_715_000_025_000,
                },
            ]
        );

        // A step-finish part id only produces a `Usage` event, which
        // carries no id: the session contributes nothing.
        assert!(
            provider
                .find_events(&["part-003".into()], 10)
                .expect("find")
                .is_empty()
        );

        // Empty ids and a zero scan both short-circuit.
        assert!(provider.find_events(&[], 10).expect("find").is_empty());
        assert!(
            provider
                .find_events(&["msg-001".into()], 0)
                .expect("find")
                .is_empty()
        );

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_find_events_scopes_to_recent_sessions() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        // ses-002 is the newest session (later time_updated) and has no
        // messages; a scan of 1 session must miss ses-001's match.
        assert!(
            provider
                .find_events(&["msg-001".into()], 1)
                .expect("find")
                .is_empty(),
            "scan of 1 covers only the newest (empty) session"
        );

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_num_to_i64_rounds_fractions() {
        // Fractional token counts (some schemas report reals like 3425.5)
        // must round to the nearest integer instead of silently becoming 0.
        assert_eq!(num_to_i64(&serde_json::json!(3425.5)), 3426);
        assert_eq!(num_to_i64(&serde_json::json!(3424.5)), 3425);
        assert_eq!(num_to_i64(&serde_json::json!(-3425.5)), -3426);
        // Integral values and reals with no fractional part pass through.
        assert_eq!(num_to_i64(&serde_json::json!(100)), 100);
        assert_eq!(num_to_i64(&serde_json::json!(100.0)), 100);
        // Small fractions round to 0 / 1 like `f64::round`.
        assert_eq!(num_to_i64(&serde_json::json!(0.4)), 0);
        assert_eq!(num_to_i64(&serde_json::json!(0.6)), 1);
        // Non-numeric values degrade to zero.
        assert_eq!(num_to_i64(&serde_json::json!("nope")), 0);
    }

    #[test]
    fn test_message_model_structured_and_flat() {
        // Structured `model` object → "providerID/modelID".
        let obj = serde_json::json!({
            "model": {"providerID": "openai", "modelID": "gpt-4"},
        });
        assert_eq!(message_model(&obj).as_deref(), Some("openai/gpt-4"));
        // Legacy flat `modelID` string → the bare model id.
        let flat = serde_json::json!({"modelID": "gpt-4"});
        assert_eq!(message_model(&flat).as_deref(), Some("gpt-4"));
        // No model recorded at all.
        assert_eq!(message_model(&serde_json::json!({"role": "user"})), None);
        // A partial structured object with no model id.
        let partial = serde_json::json!({"model": {"providerID": "openai"}});
        assert_eq!(message_model(&partial), None);
    }

    #[test]
    fn test_query_first_assistant_meta_picks_first_assistant() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let provider = OpenCodeSessionProvider::with_data_dir(db_path.clone());

        // ses-001's first assistant message is msg-002 (`modelID: gpt-4`,
        // `agent: beaver`); the earlier msg-001 is a user message and must
        // be skipped.
        let session = provider.open("ses-001").expect("open session");
        assert_eq!(session.meta.model.as_deref(), Some("gpt-4"));
        assert_eq!(session.meta.agent.as_deref(), Some("beaver"));

        // ses-002 has no messages: both stay unset.
        let session = provider.open("ses-002").expect("open empty session");
        assert_eq!(session.meta.model, None);
        assert_eq!(session.meta.agent, None);

        let _ = fs::remove_dir_all(&db_path);
    }

    #[test]
    fn test_host_events_default_kept_for_pi() {
        // The trait default still returns `None`; this just pins the
        // `Option<Vec<HostEvent>>` signature compiles for both hosts.
        let provider = crate::session::PiSessionProvider::with_data_dir(
            std::env::temp_dir().to_string_lossy(),
        );
        assert!(provider.host_events("ses-001").is_none());
    }
}
