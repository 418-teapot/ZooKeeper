//! Host-agnostic session access for `zfind`, built on `zutil::session`.
//!
//! Wraps zutil's providers so an explicit `--db <path>` keeps targeting
//! exactly that `OpenCode` database while every other lookup runs through
//! zutil's host auto-selection. Also translates the shared [`SessionEvent`]
//! stream into the row shapes the search / list / show / message
//! subcommands render.

use std::collections::HashMap;
use std::io;

use serde_json::{Value, json};

use zutil::session::{
    Host, HostFilter, OpenCodeSessionProvider, ResolveError, Session,
    SessionEvent, SessionMeta, SessionProvider,
    find_events_across as zutil_find_events_across,
    list_sessions as zutil_list_sessions, open_session as zutil_open_session,
    search_sessions as zutil_search_sessions,
};

/// Preview column width (display columns) for the show / message rows.
const PREVIEW_WIDTH: usize = 120;

/// CLI `--host` selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum HostArg {
    /// `OpenCode` sessions (`ses_...` ids, `SQLite` storage)
    #[value(name = "opencode")]
    OpenCode,
    /// pi sessions (UUID ids, `JSONL` storage)
    #[value(name = "pi")]
    Pi,
}

impl HostArg {
    /// The zutil host this selector maps to.
    #[must_use]
    pub const fn to_host(self) -> Host {
        match self {
            Self::OpenCode => Host::OpenCode,
            Self::Pi => Host::Pi,
        }
    }
}

/// Resolve the host filter from CLI flags.
///
/// An explicit `--db` path is an `OpenCode` database, so it implies
/// `Only(OpenCode)`; otherwise `--host` selects one host; neither flag
/// means auto-detection by session id shape.
#[must_use]
pub fn host_filter(host: Option<HostArg>, db: Option<&str>) -> HostFilter {
    if db.is_some() {
        HostFilter::Only(Host::OpenCode)
    } else {
        host.map_or(HostFilter::Auto, |h| HostFilter::Only(h.to_host()))
    }
}

/// Open a session by id or unique prefix, honoring an explicit `--db`.
///
/// With `--db` the session is read from exactly that database as
/// `OpenCode`; otherwise the lookup is delegated to zutil's host
/// auto-detection selected by `filter`.
///
/// # Errors
///
/// Returns the structured [`ResolveError`]: `NotFound` for misses,
/// `Ambiguous` for ambiguous prefixes, `Io` for storage errors.
pub fn open_session(
    filter: HostFilter,
    db: Option<&str>,
    id_or_prefix: &str,
) -> Result<(Host, Session), ResolveError> {
    if let Some(path) = db {
        let provider = OpenCodeSessionProvider::with_db_path(path.to_string());
        let session = provider.open(id_or_prefix)?;
        return Ok((Host::OpenCode, session));
    }
    zutil_open_session(filter, id_or_prefix)
}

/// List every session across the hosts selected by `filter`, honoring an
/// explicit `--db`.
///
/// # Errors
///
/// Propagates the provider's I/O errors.
pub fn list_sessions(
    filter: HostFilter,
    db: Option<&str>,
) -> io::Result<Vec<(Host, SessionMeta)>> {
    if let Some(path) = db {
        let provider = OpenCodeSessionProvider::with_db_path(path.to_string());
        let metas = provider.list()?;
        return Ok(metas
            .into_iter()
            .map(|meta| (Host::OpenCode, meta))
            .collect());
    }
    zutil_list_sessions(filter)
}

/// Search session content across the hosts selected by `filter`, honoring
/// an explicit `--db`.
///
/// Match semantics come from the providers: session labels and message /
/// tool-result text, case-insensitive — a superset of the old title-only
/// search.
///
/// # Errors
///
/// Propagates the provider's I/O errors.
pub fn search_sessions(
    filter: HostFilter,
    db: Option<&str>,
    query: &str,
) -> io::Result<Vec<(Host, SessionMeta)>> {
    if let Some(path) = db {
        let provider = OpenCodeSessionProvider::with_db_path(path.to_string());
        let metas = provider.search(query)?;
        return Ok(metas
            .into_iter()
            .map(|meta| (Host::OpenCode, meta))
            .collect());
    }
    zutil_search_sessions(filter, query)
}

/// Find events whose id starts with any of `ids`, scanning the
/// `max_sessions` most recent sessions per host, honoring an explicit
/// `--db`.
///
/// Replaces the old scan-and-open-everything message lookup: each host's
/// provider resolves matching events without fully opening unrelated
/// sessions.
///
/// # Errors
///
/// Propagates the provider's I/O errors.
pub fn find_events_across(
    filter: HostFilter,
    db: Option<&str>,
    ids: &[String],
    max_sessions: usize,
) -> io::Result<Vec<(Host, SessionMeta, Vec<SessionEvent>)>> {
    if let Some(path) = db {
        let provider = OpenCodeSessionProvider::with_db_path(path.to_string());
        let hits = provider.find_events(ids, max_sessions)?;
        return Ok(hits
            .into_iter()
            .map(|(meta, events)| (Host::OpenCode, meta, events))
            .collect());
    }
    zutil_find_events_across(filter, ids, max_sessions)
}

/// Sort sessions newest first — by last update time, falling back to the
/// start time when the host records no update time (e.g. an empty pi
/// session), then by id for a stable total order. This matches the
/// previous `ORDER BY time_updated DESC` semantics: the latest activity,
/// not the session start, decides the list order.
#[must_use]
pub fn sort_newest_first(
    mut sessions: Vec<(Host, SessionMeta)>,
) -> Vec<(Host, SessionMeta)> {
    sessions.sort_by(|(_, a), (_, b)| {
        let a_ts = a.updated_at.unwrap_or(a.started_at);
        let b_ts = b.updated_at.unwrap_or(b.started_at);
        (b_ts, &b.id).cmp(&(a_ts, &a.id))
    });
    sessions
}

/// JSON/table row for one session: the shared metadata plus the host tag.
///
/// `time_updated` is the session's last-update time — the same value that
/// drives newest-first ordering — falling back to the start time when the
/// host records no update.
#[must_use]
pub fn meta_to_value(host: Host, meta: &SessionMeta) -> Value {
    json!({
        "id": meta.id,
        "host": host.name(),
        "title": meta.label.clone().unwrap_or_default(),
        "parent_id": meta.parent_id.clone(),
        "cwd": meta.cwd,
        "time_updated": zutil::epoch_ms_to_iso(
            meta.updated_at.unwrap_or(meta.started_at)
        ),
    })
}

/// Build the show row for one event.
///
/// The row shape mirrors the previous message-based output: `index`,
/// `role`, `tokens`, `id`, `preview` — plus the `host` tag. `Message`
/// events carry `user`/`assistant` roles with a text preview; tool events
/// carry `tool_use`/`tool_result` with a tool preview; `Usage` carries the
/// total token count.
#[must_use]
pub fn show_row(
    host: Host,
    index: usize,
    event: &SessionEvent,
) -> HashMap<String, Value> {
    let mut row: HashMap<String, Value> = HashMap::new();
    row.insert("index".to_string(), json!(index + 1));
    row.insert("host".to_string(), json!(host.name()));
    match event {
        SessionEvent::Message { id, role, text, .. } => {
            let preview =
                preview_text(&[json!({ "type": "text", "text": text })]);
            row.insert("role".to_string(), json!(role));
            row.insert("tokens".to_string(), json!(0_u64));
            row.insert("id".to_string(), json!(id.clone().unwrap_or_default()));
            row.insert("preview".to_string(), json!(preview));
        }
        SessionEvent::ToolUse { id, name, input, .. } => {
            let preview = preview_text(&[json!({
                "type": "tool", "tool": name,
                "state": { "input": input },
            })]);
            row.insert("role".to_string(), json!("tool_use"));
            row.insert("tokens".to_string(), json!(0_u64));
            row.insert("id".to_string(), json!(id.clone().unwrap_or_default()));
            row.insert("preview".to_string(), json!(preview));
        }
        SessionEvent::ToolResult { id, name, output, is_error, .. } => {
            let status = if *is_error { "[error] " } else { "" };
            let preview = if output.is_empty() {
                name.clone()
            } else {
                format!("{status}{name}: {output}")
            };
            row.insert("role".to_string(), json!("tool_result"));
            row.insert("tokens".to_string(), json!(0_u64));
            row.insert("id".to_string(), json!(id.clone().unwrap_or_default()));
            row.insert(
                "preview".to_string(),
                json!(zutil::truncate_width(&preview, PREVIEW_WIDTH)),
            );
        }
        SessionEvent::Reasoning { id, text, .. } => {
            let preview =
                preview_text(&[json!({ "type": "text", "text": text })]);
            row.insert("role".to_string(), json!("reasoning"));
            row.insert("tokens".to_string(), json!(0_u64));
            row.insert("id".to_string(), json!(id.clone().unwrap_or_default()));
            row.insert("preview".to_string(), json!(preview));
        }
        SessionEvent::Usage {
            input, output, cache_read, cache_write, ..
        } => {
            let tokens = input + output + cache_read + cache_write;
            row.insert("role".to_string(), json!("usage"));
            row.insert("tokens".to_string(), json!(tokens));
            row.insert("id".to_string(), json!(""));
            row.insert("preview".to_string(), json!(""));
        }
    }
    row
}

/// The event id carried by a [`SessionEvent`], if any.
///
/// `Message` events carry the message id, `ToolUse` the tool-call id, and
/// `ToolResult` the `toolCallId`; `Usage` events carry none.
fn event_id(event: &SessionEvent) -> Option<&str> {
    match event {
        SessionEvent::Message { id, .. }
        | SessionEvent::ToolUse { id, .. }
        | SessionEvent::ToolResult { id, .. }
        | SessionEvent::Reasoning { id, .. } => id.as_deref(),
        SessionEvent::Usage { .. } => None,
    }
}

/// Reconstruct the display `parts` of one event, mirroring the previous
/// part-based rows.
fn event_parts(event: &SessionEvent) -> Vec<Value> {
    match event {
        SessionEvent::Message { text, .. } => {
            vec![json!({ "type": "text", "text": text })]
        }
        SessionEvent::ToolUse { name, input, .. } => vec![json!({
            "type": "tool", "tool": name, "state": { "input": input },
        })],
        SessionEvent::ToolResult { name, output, is_error, .. } => {
            let status = if *is_error { "error" } else { "completed" };
            vec![json!({
                "type": "tool", "tool": name,
                "state": { "output": output, "status": status },
            })]
        }
        SessionEvent::Reasoning { text, .. } => {
            vec![json!({ "type": "reasoning", "text": text })]
        }
        SessionEvent::Usage { .. } => Vec::new(),
    }
}

/// Collect the rows for every event whose id matches one of the requested
/// id prefixes within `session`.
///
/// The old `message` subcommand looked the ids up in the `message` table;
/// the event model keeps per-event ids (`Message` ← message id,
/// `ToolUse`/`ToolResult` ← tool-call id), so a lookup now matches any
/// event id (exact or prefix) across the scanned sessions.
#[must_use]
pub fn message_rows(
    host: Host,
    session: &Session,
    ids: &[String],
) -> Vec<Value> {
    let mut rows = Vec::new();
    for event in &session.events {
        let Some(id) = event_id(event) else {
            continue;
        };
        if !ids.iter().any(|wanted| id.starts_with(wanted)) {
            continue;
        }
        let (role, timestamp) = match event {
            SessionEvent::Message { role, timestamp, .. } => {
                (role.clone(), *timestamp)
            }
            SessionEvent::ToolUse { timestamp, .. }
            | SessionEvent::Reasoning { timestamp, .. } => {
                ("assistant".to_string(), *timestamp)
            }
            SessionEvent::ToolResult { timestamp, .. } => {
                ("tool".to_string(), *timestamp)
            }
            SessionEvent::Usage { .. } => continue,
        };
        rows.push(json!({
            "id": id,
            "session_id": session.meta.id,
            "host": host.name(),
            "role": role,
            "timestamp": zutil::epoch_ms_to_iso(timestamp),
            "tokens": 0_u64,
            "parts": event_parts(event),
        }));
    }
    rows
}

/// Truncate a message text like the previous previews did.
fn preview_text(parts: &[Value]) -> String {
    crate::helpers::preview_text(parts, PREVIEW_WIDTH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(id: &str, at: i64, label: Option<&str>) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            parent_id: None,
            cwd: "/w".to_string(),
            started_at: at,
            label: label.map(ToString::to_string),
            title: None,
            updated_at: None,
            model: None,
            agent: None,
        }
    }

    fn meta_updated(
        id: &str,
        started_at: i64,
        updated_at: Option<i64>,
    ) -> SessionMeta {
        SessionMeta { updated_at, ..meta(id, started_at, None) }
    }

    #[test]
    fn host_filter_db_implies_opencode() {
        assert_eq!(
            host_filter(Some(HostArg::Pi), Some("/tmp/x.db")),
            HostFilter::Only(Host::OpenCode)
        );
    }

    #[test]
    fn host_filter_maps_host_arg() {
        assert_eq!(
            host_filter(Some(HostArg::OpenCode), None),
            HostFilter::Only(Host::OpenCode)
        );
        assert_eq!(
            host_filter(Some(HostArg::Pi), None),
            HostFilter::Only(Host::Pi)
        );
    }

    #[test]
    fn host_filter_defaults_to_auto() {
        assert_eq!(host_filter(None, None), HostFilter::Auto);
    }

    #[test]
    fn sort_newest_first_orders_by_start_then_id() {
        // Without update times the sort falls back to the start time.
        let sessions = vec![
            (Host::OpenCode, meta("a", 100, None)),
            (Host::OpenCode, meta("b", 300, None)),
            (Host::Pi, meta("c", 200, None)),
        ];
        let sorted = sort_newest_first(sessions);
        let ids: Vec<&str> =
            sorted.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn sort_newest_first_prefers_updated_at_over_started_at() {
        // Start and update times disagree: the update time decides order.
        let sessions = vec![
            (Host::OpenCode, meta_updated("older-start", 100, Some(500))),
            (Host::OpenCode, meta_updated("newer-start", 400, Some(200))),
        ];
        let sorted = sort_newest_first(sessions);
        let ids: Vec<&str> =
            sorted.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["older-start", "newer-start"]);
    }

    #[test]
    fn sort_newest_first_mixes_missing_and_present_updates() {
        // A session without an update time still compares via its start
        // time, so it can interleave with sessions that have one.
        let sessions = vec![
            (Host::OpenCode, meta("no-update", 300, None)),
            (Host::OpenCode, meta_updated("updated-late", 100, Some(50))),
        ];
        let sorted = sort_newest_first(sessions);
        let ids: Vec<&str> =
            sorted.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["no-update", "updated-late"]);
    }

    #[test]
    fn meta_to_value_includes_host_and_label() {
        let v = meta_to_value(Host::Pi, &meta("u1", 1_000, Some("hi")));
        assert_eq!(v["id"], "u1");
        assert_eq!(v["host"], "pi");
        assert_eq!(v["title"], "hi");
        // Without an update time the row reports the start time.
        assert_eq!(v["time_updated"], zutil::epoch_ms_to_iso(1_000));
        // With an update time the row reports the last activity.
        let v =
            meta_to_value(Host::Pi, &meta_updated("u2", 1_000, Some(9_000)));
        assert_eq!(v["time_updated"], zutil::epoch_ms_to_iso(9_000));
    }

    #[test]
    fn message_rows_match_id_prefixes() {
        let session = Session {
            meta: meta("ses-1", 0, None),
            events: vec![
                SessionEvent::Message {
                    id: Some("msg-001".to_string()),
                    role: "user".to_string(),
                    text: "hi".to_string(),
                    timestamp: 1,
                },
                SessionEvent::ToolUse {
                    id: Some("call-1".to_string()),
                    name: "bash".to_string(),
                    input: json!({}),
                    timestamp: 2,
                },
                SessionEvent::ToolResult {
                    id: Some("call-1".to_string()),
                    name: "bash".to_string(),
                    output: "ok".to_string(),
                    is_error: false,
                    timestamp: 3,
                },
                SessionEvent::Usage {
                    input: 1,
                    output: 2,
                    cache_read: 3,
                    cache_write: 4,
                    cost: None,
                    timestamp: 4,
                    reasoning: 0,
                    reason: None,
                    message_id: None,
                    duration_ms: None,
                    model: None,
                },
            ],
        };

        let hits = message_rows(Host::OpenCode, &session, &["msg-00".into()]);
        assert_eq!(hits.len(), 1, "message prefix match");
        assert_eq!(hits[0]["id"], "msg-001");
        assert_eq!(hits[0]["role"], "user");

        let hits = message_rows(Host::OpenCode, &session, &["call-1".into()]);
        assert_eq!(hits.len(), 2, "tool-call id matches use and result");
        assert_eq!(hits[0]["id"], "call-1");
        assert_eq!(hits[0]["parts"][0]["type"], "tool");
        assert_eq!(hits[1]["id"], "call-1");
        assert_eq!(hits[1]["parts"][0]["state"]["status"], "completed");

        // Usage events carry no id and never match.
        assert!(
            message_rows(Host::OpenCode, &session, &["zzz-nope".into()],)
                .is_empty()
        );
    }

    #[test]
    fn show_row_carries_event_fields() {
        let row = show_row(
            Host::Pi,
            0,
            &SessionEvent::ToolResult {
                id: Some("c9".to_string()),
                name: "bash".to_string(),
                output: "boom".to_string(),
                is_error: true,
                timestamp: 5,
            },
        );
        assert_eq!(row["role"], "tool_result");
        assert_eq!(row["id"], "c9");
        assert_eq!(row["host"], "pi");
        assert!(row["preview"].as_str().unwrap().contains("[error]"));
        assert!(row["preview"].as_str().unwrap().contains("bash"));
    }
}
