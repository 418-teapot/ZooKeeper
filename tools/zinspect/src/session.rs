//! Host-agnostic session access for `zinspect`, built on `zutil::session`.
//!
//! Wraps zutil's providers so an explicit `--db <path>` keeps targeting
//! exactly that database while every other lookup runs through zutil's
//! id-shape auto-detection. Also translates the shared [`SessionEvent`]
//! stream into the step rows and tool-usage summaries the stats and impact
//! subcommands render.

use std::collections::{BTreeMap, HashSet};
use std::io;

use serde_json::{Number, Value, json};

use zutil::session::{
    Host, HostFilter, OpenCodeSessionProvider, ResolveError, Session,
    SessionEvent, SessionMeta, SessionProvider,
    list_sessions as zutil_list_sessions, open_session as zutil_open_session,
};

/// CLI `--host` selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum HostArg {
    /// `OpenCode` sessions (`ses_...` ids)
    #[value(name = "opencode")]
    OpenCode,
    /// pi sessions (UUID ids)
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
/// An explicit `--db` flag implies `OpenCode` (`SQLite` is `OpenCode`'s
/// storage); otherwise `--host` selects one host; neither flag means
/// auto-detection by session id shape.
#[must_use]
pub fn host_filter(host: Option<HostArg>, db: Option<&str>) -> HostFilter {
    if db.is_some() {
        return HostFilter::Only(Host::OpenCode);
    }
    host.map_or(HostFilter::Auto, |h| HostFilter::Only(h.to_host()))
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

/// Keep the `n` most recently started sessions, newest first.
///
/// Child sessions (those with a `parent_id`) are dropped unless `all` is
/// set. Ordering is by `started_at` (epoch milliseconds) descending with
/// id descending as the tie-breaker, so the result is deterministic.
#[must_use]
pub fn take_recent(
    mut sessions: Vec<(Host, SessionMeta)>,
    n: usize,
    all: bool,
) -> Vec<(Host, SessionMeta)> {
    sessions.retain(|(_, meta)| all || meta.parent_id.is_none());
    sessions.sort_by(|(_, a), (_, b)| {
        (b.started_at, &b.id).cmp(&(a.started_at, &a.id))
    });
    sessions.truncate(n);
    sessions
}

// ── step mapping ─────────────────────────────────────────────────────────────

/// Convert a token count to `f64` without triggering `cast_precision_loss`.
fn tokens_to_f64(v: i64) -> f64 {
    f64::from(u32::try_from(v.max(0)).unwrap_or(0))
}

/// Convert an `f64` to a JSON number or `Null` for non-finite values.
fn f64_to_json(v: f64) -> Value {
    Number::from_f64(v).map_or(Value::Null, Value::Number)
}

/// Build the step row shape the stats and impact subcommands consume.
///
/// Mirrors the previous DB extraction's field set so `OpenCode` numbers
/// stay identical: token totals, reasoning count, reason and message id
/// come from [`SessionEvent::Usage`] (which the `OpenCode` provider
/// fills from `step-finish` parts) and timestamps are ISO-8601. The
/// message duration surfaces as `duration_ms`; the absolute
/// `msg_time_created`/`msg_time_completed` endpoints the old
/// message-table lookup produced are not recorded in the event model, so
/// they stay `Null`.
fn usage_to_step(step_index: usize, usage: &SessionEvent) -> Value {
    let SessionEvent::Usage {
        input,
        output,
        cache_read,
        cache_write,
        cost,
        timestamp,
        reasoning,
        reason,
        message_id,
        duration_ms,
        model,
    } = usage
    else {
        return Value::Null;
    };
    let iso = zutil::epoch_ms_to_iso(*timestamp);
    json!({
        "step_index": step_index,
        "message_id": message_id.clone().unwrap_or_default(),
        "time_created": iso,
        "time_updated": iso,
        "cache_read": f64_to_json(tokens_to_f64(*cache_read)),
        "cache_write": f64_to_json(tokens_to_f64(*cache_write)),
        "input_tokens": f64_to_json(tokens_to_f64(*input)),
        "output_tokens": f64_to_json(tokens_to_f64(*output)),
        "reasoning_tokens": f64_to_json(tokens_to_f64(*reasoning)),
        "cost": f64_to_json(cost.unwrap_or(0.0)),
        "reason": reason.clone().unwrap_or_default(),
        "duration_ms": duration_ms.map_or(Value::Null, |ms| {
            Value::Number(Number::from(ms))
        }),
        "model": model.clone().unwrap_or_default(),
        "tools": [],
        "msg_time_created": Value::Null,
        "msg_time_completed": Value::Null,
    })
}

/// Extract the token-usage sequence of a session as step rows.
///
/// One row per [`SessionEvent::Usage`] in event order, numbered from
/// [`1`]. Sessions without usage events yield an empty list — both hosts
/// present their usage stream as-is (pi reports per assistant message,
/// `OpenCode` per step-finish).
#[must_use]
pub fn steps_from_session(session: &Session) -> Vec<Value> {
    let mut steps = Vec::new();
    for event in &session.events {
        if matches!(event, SessionEvent::Usage { .. }) {
            steps.push(usage_to_step(steps.len() + 1, event));
        }
    }
    steps
}

// ── tool usage ───────────────────────────────────────────────────────────────

/// Accumulated call count and total duration for one tool name.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ToolAccum {
    calls: i64,
    duration_ms: i64,
}

/// Summarize a session's tool invocations.
///
/// Each [`SessionEvent::ToolUse`] is paired with the next unconsumed
/// [`SessionEvent::ToolResult`] of the same name; the duration is the
/// result timestamp minus the use timestamp (0 when no result follows).
/// Returns a JSON map keyed by tool name with `calls` and `duration_ms`.
#[must_use]
pub fn tool_usage(session: &Session) -> Value {
    let events = &session.events;
    let mut consumed: HashSet<usize> = HashSet::new();
    let mut accum: BTreeMap<String, ToolAccum> = BTreeMap::new();

    for (i, event) in events.iter().enumerate() {
        let SessionEvent::ToolUse { name, timestamp, .. } = event else {
            continue;
        };
        let mut duration_ms = 0_i64;
        for (j, candidate) in events.iter().enumerate().skip(i + 1) {
            if consumed.contains(&j) {
                continue;
            }
            if let SessionEvent::ToolResult {
                name: result_name,
                timestamp: result_ts,
                ..
            } = candidate
                && result_name == name
            {
                duration_ms = (result_ts - timestamp).max(0);
                consumed.insert(j);
                break;
            }
        }
        let entry = accum.entry(name.clone()).or_default();
        entry.calls += 1;
        entry.duration_ms += duration_ms;
    }

    let mut tools = serde_json::Map::new();
    for (name, stats) in accum {
        tools.insert(
            name,
            json!({ "calls": stats.calls, "duration_ms": stats.duration_ms }),
        );
    }
    Value::Object(tools)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A session built from raw events, without touching any provider.
    fn session_with(events: Vec<SessionEvent>) -> Session {
        Session {
            meta: SessionMeta {
                id: "ses-test".to_string(),
                parent_id: None,
                cwd: "/w".to_string(),
                started_at: 0,
                label: None,
                title: None,
                updated_at: None,
                model: None,
                agent: None,
            },
            events,
        }
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
    fn take_recent_orders_newest_first_and_filters_children() {
        let meta = |id: &str, at: i64, parent: Option<&str>| {
            (
                (if at % 2 == 0 { Host::OpenCode } else { Host::Pi }),
                SessionMeta {
                    id: id.to_string(),
                    parent_id: parent.map(ToString::to_string),
                    cwd: String::new(),
                    started_at: at,
                    label: None,
                    title: None,
                    updated_at: None,
                    model: None,
                    agent: None,
                },
            )
        };
        let sessions = vec![
            meta("old-root", 100, None),
            meta("child-1", 400, Some("old-root")),
            meta("mid-root", 200, None),
            meta("new-root", 300, None),
        ];
        let roots = take_recent(sessions.clone(), 10, false);
        let ids: Vec<&str> = roots.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["new-root", "mid-root", "old-root"]);

        let with_children = take_recent(sessions, 10, true);
        let ids: Vec<&str> =
            with_children.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["child-1", "new-root", "mid-root", "old-root"]);
    }

    #[test]
    fn take_recent_truncates_to_n() {
        let meta = |id: &str, at: i64| {
            (
                Host::OpenCode,
                SessionMeta {
                    id: id.to_string(),
                    parent_id: None,
                    cwd: String::new(),
                    started_at: at,
                    label: None,
                    title: None,
                    updated_at: None,
                    model: None,
                    agent: None,
                },
            )
        };
        let sessions = vec![
            meta("a", 100),
            meta("b", 200),
            meta("c", 300),
            meta("d", 400),
        ];
        let recent = take_recent(sessions, 2, false);
        let ids: Vec<&str> =
            recent.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, vec!["d", "c"]);
    }

    #[test]
    fn steps_from_session_maps_usage_fields_exactly() {
        let session = session_with(vec![
            SessionEvent::Usage {
                input: 100,
                output: 50,
                cache_read: 30,
                cache_write: 10,
                cost: Some(0.005),
                timestamp: 1_715_000_020_000,
                reasoning: 5,
                reason: Some("completed".to_string()),
                message_id: Some("msg-002".to_string()),
                duration_ms: Some(70_000),
                model: Some("openai/gpt-4".to_string()),
            },
            SessionEvent::Message {
                id: None,
                role: "assistant".to_string(),
                text: "ignored".to_string(),
                timestamp: 1_715_000_021_000,
            },
            SessionEvent::Usage {
                input: 200,
                output: 100,
                cache_read: 80,
                cache_write: 20,
                cost: None,
                timestamp: 1_715_000_022_000,
                reasoning: 12,
                reason: None,
                message_id: Some("msg-003".to_string()),
                duration_ms: None,
                model: None,
            },
        ]);
        let steps = steps_from_session(&session);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["step_index"], 1);
        assert_eq!(steps[0]["time_created"], "2024-05-06T12:53:40.000000Z");
        assert_eq!(steps[0]["input_tokens"], 100.0);
        assert_eq!(steps[0]["output_tokens"], 50.0);
        assert_eq!(steps[0]["cache_read"], 30.0);
        assert_eq!(steps[0]["cache_write"], 10.0);
        assert_eq!(steps[0]["cost"], 0.005);
        assert_eq!(steps[0]["message_id"], "msg-002");
        assert_eq!(steps[0]["reasoning_tokens"], 5.0);
        assert_eq!(steps[0]["reason"], "completed");
        assert_eq!(steps[0]["duration_ms"], 70_000);
        assert_eq!(steps[0]["model"], "openai/gpt-4");
        // A usage without a provider model renders an empty model string.
        assert_eq!(steps[1]["model"], "");
        assert_eq!(steps[1]["step_index"], 2);
        // missing cost renders as 0.0, like the DB extraction did
        assert_eq!(steps[1]["cost"], 0.0);
        assert_eq!(steps[1]["message_id"], "msg-003");
        assert_eq!(steps[1]["reasoning_tokens"], 12.0);
        // missing reason renders as "", like the DB extraction did
        assert_eq!(steps[1]["reason"], "");
        // missing duration renders as null
        assert!(steps[1]["duration_ms"].is_null());
    }

    #[test]
    fn steps_from_session_empty_without_usage() {
        let session = session_with(vec![
            SessionEvent::Message {
                id: None,
                role: "user".to_string(),
                text: "hi".to_string(),
                timestamp: 1,
            },
            SessionEvent::ToolUse {
                id: None,
                name: "bash".to_string(),
                input: json!({}),
                timestamp: 2,
            },
        ]);
        assert!(steps_from_session(&session).is_empty());
    }

    #[test]
    fn tool_usage_pairs_use_and_result_by_name() {
        let session = session_with(vec![
            SessionEvent::ToolUse {
                id: None,
                name: "bash".to_string(),
                input: json!({}),
                timestamp: 1_000,
            },
            SessionEvent::ToolResult {
                id: None,
                name: "read".to_string(),
                output: "a".to_string(),
                is_error: false,
                timestamp: 1_100,
            },
            SessionEvent::ToolResult {
                id: None,
                name: "bash".to_string(),
                output: "ok".to_string(),
                is_error: false,
                timestamp: 1_250,
            },
            SessionEvent::ToolUse {
                id: None,
                name: "bash".to_string(),
                input: json!({}),
                timestamp: 1_300,
            },
            SessionEvent::ToolResult {
                id: None,
                name: "bash".to_string(),
                output: "again".to_string(),
                is_error: true,
                timestamp: 1_400,
            },
        ]);
        let usage = tool_usage(&session);
        assert_eq!(usage["bash"]["calls"], 2);
        assert_eq!(usage["bash"]["duration_ms"], 350);
        // `read` had a result but no matching use before it: nothing counted.
        assert!(usage.get("read").is_none());
    }

    #[test]
    fn tool_usage_unmatched_use_has_zero_duration() {
        let session = session_with(vec![SessionEvent::ToolUse {
            id: None,
            name: "bash".to_string(),
            input: json!({}),
            timestamp: 1_000,
        }]);
        let usage = tool_usage(&session);
        assert_eq!(usage["bash"]["calls"], 1);
        assert_eq!(usage["bash"]["duration_ms"], 0);
    }

    #[test]
    fn tool_usage_empty_session() {
        assert_eq!(tool_usage(&session_with(vec![])), json!({}));
    }
}
