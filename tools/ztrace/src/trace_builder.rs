// Timeline builder — merge the session event stream, zoo hook logs and
// host lifecycle events into a unified trace.
//
// This is the heart of ztrace. It joins three sources:
//   1. the host-agnostic session event stream from a `SessionProvider`
//      (`provider.open`: messages, tool calls, usage),
//   2. the ZooKeeper JSONL hook logs resolved per session, and
//   3. host lifecycle events from `provider.host_events` (OpenCode only;
//      pi does not provide them and is skipped without an error).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};

use zutil::epoch_ms_to_iso;
use zutil::format_number;
use zutil::get_zoo_log_dir;
use zutil::iso_to_epoch_ms;
use zutil::resolve_session_path;
use zutil::session::{Host, Session, SessionEvent, SessionProvider};

use crate::parser::{self, tool_type_and_icon};

// ── event stream → timeline ───────────────────────────────────────────────────

/// Truncate text with ellipsis if it exceeds `max_len` characters.
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.chars().count() > max_len {
        let truncated: String = text.chars().take(max_len).collect();
        format!("{truncated}...")
    } else {
        text.to_string()
    }
}

/// Extract the primary input field of a tool call for summary display.
///
/// Priority: `filePath` > `pattern` > `command` (first 50 chars) >
/// `description` > first non-empty value > `""`.
fn primary_tool_input(input: &Value) -> String {
    let Some(obj) = input.as_object() else {
        return String::new();
    };

    if let Some(fp) =
        obj.get("filePath").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        return fp.to_string();
    }
    if let Some(pattern) =
        obj.get("pattern").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        return pattern.to_string();
    }
    if let Some(cmd) =
        obj.get("command").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        return cmd.chars().take(50).collect();
    }
    if let Some(desc) =
        obj.get("description").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        return desc.to_string();
    }
    for val in obj.values() {
        if let Some(s) = val.as_str().filter(|s| !s.trim().is_empty()) {
            return s.to_string();
        }
    }
    String::new()
}

/// Source label for provider-derived events: `db` on `OpenCode` (historical
/// label), the host name on other hosts.
fn provider_source(host: Host) -> String {
    if host == Host::OpenCode {
        "db".to_string()
    } else {
        host.name().to_string()
    }
}

/// Convert one session event into a timeline entry.
///
/// `Message` becomes a user/assistant message event, `ToolUse` a tool call
/// event (durations are attached later from its `ToolResult`), `Reasoning`
/// an assistant-reasoning row, and `Usage` a step/token event.
/// `ToolResult` alone produces no entry.
fn event_to_timeline(host: Host, ev: &SessionEvent) -> Option<Value> {
    match ev {
        SessionEvent::Message { role, text, timestamp, id, .. } => {
            message_to_timeline(host, role, text, *timestamp, id.as_deref())
        }
        SessionEvent::ToolUse { name, input, timestamp, .. } => {
            Some(tool_use_to_timeline(host, name, input, *timestamp))
        }
        SessionEvent::ToolResult { .. } => None,
        SessionEvent::Reasoning { text, timestamp, .. } => {
            Some(reasoning_to_timeline(host, text, *timestamp))
        }
        SessionEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
            cost,
            timestamp,
            model,
            message_id,
            duration_ms,
            ..
        } => Some(usage_to_timeline(
            host,
            UsageTokens {
                input: *input,
                output: *output,
                cache_read: *cache_read,
                cache_write: *cache_write,
            },
            *cost,
            *timestamp,
            model.as_deref(),
            message_id.as_deref(),
            *duration_ms,
        )),
    }
}

/// Convert a message event into a user/assistant timeline entry.
///
/// The provider message id is carried on the row so the duration pass can
/// match usage durations back to assistant replies.
fn message_to_timeline(
    host: Host,
    role: &str,
    text: &str,
    timestamp: i64,
    id: Option<&str>,
) -> Option<Value> {
    let (etype, icon, summary) = match role {
        "user" => {
            ("user_msg".to_string(), "👤".to_string(), truncate_text(text, 80))
        }
        "assistant" => (
            "assistant_reply".to_string(),
            "🤖".to_string(),
            truncate_text(text, 80),
        ),
        _ => return None,
    };
    let mut ev_map = Map::new();
    ev_map.insert(
        "timestamp".to_string(),
        Value::String(epoch_ms_to_iso(timestamp)),
    );
    ev_map.insert("source".to_string(), Value::String(provider_source(host)));
    ev_map.insert("type".to_string(), Value::String(etype));
    ev_map.insert("icon".to_string(), Value::String(icon));
    ev_map.insert("summary".to_string(), Value::String(summary));
    ev_map.insert("content".to_string(), Value::String(text.to_string()));
    if let Some(id) = id {
        ev_map.insert("message_id".to_string(), Value::String(id.to_string()));
    }
    Some(Value::Object(ev_map))
}

/// Convert a tool-use event into a tool timeline entry (duration is
/// attached later from the matching `ToolResult`).
fn tool_use_to_timeline(
    host: Host,
    name: &str,
    input: &Value,
    timestamp: i64,
) -> Value {
    let (etype, icon) = tool_type_and_icon(name);
    let primary = primary_tool_input(input);
    let summary = if primary.is_empty() {
        name.to_string()
    } else {
        format!("{name}: {primary}")
    };

    let mut detail = Map::new();
    detail.insert("tool_name".to_string(), Value::String(name.to_string()));
    detail.insert("status".to_string(), Value::String(String::new()));
    detail.insert(
        "input_keys".to_string(),
        Value::Array(
            input
                .as_object()
                .map(|obj| {
                    obj.keys().map(|k| Value::String(k.clone())).collect()
                })
                .unwrap_or_default(),
        ),
    );

    let mut ev_map = Map::new();
    ev_map.insert(
        "timestamp".to_string(),
        Value::String(epoch_ms_to_iso(timestamp)),
    );
    ev_map.insert("source".to_string(), Value::String(provider_source(host)));
    ev_map.insert("type".to_string(), Value::String(etype));
    ev_map.insert("icon".to_string(), Value::String(icon));
    ev_map.insert("summary".to_string(), Value::String(summary));
    ev_map.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev_map)
}

/// Convert a reasoning event into an assistant-reasoning timeline entry.
///
/// Mirrors the historical DB row: type `assistant_reasoning`, icon `🧠`,
/// summary prefixed `Reasoning:`. `OpenCode` `reasoning` parts and pi
/// `thinking` blocks both arrive as [`SessionEvent::Reasoning`], so both
/// hosts share this shape. The ops-summary display renders these rows only
/// in verbose mode.
fn reasoning_to_timeline(host: Host, text: &str, timestamp: i64) -> Value {
    let mut ev_map = Map::new();
    ev_map.insert(
        "timestamp".to_string(),
        Value::String(epoch_ms_to_iso(timestamp)),
    );
    ev_map.insert("source".to_string(), Value::String(provider_source(host)));
    ev_map.insert(
        "type".to_string(),
        Value::String("assistant_reasoning".to_string()),
    );
    ev_map.insert("icon".to_string(), Value::String("🧠".to_string()));
    ev_map.insert(
        "summary".to_string(),
        Value::String(format!("Reasoning: {}", truncate_text(text, 72))),
    );
    ev_map.insert("content".to_string(), Value::String(text.to_string()));
    Value::Object(ev_map)
}

/// Token counts of one usage event, grouped so the timeline builder
/// signature stays small.
#[derive(Clone, Copy)]
struct UsageTokens {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
}

/// Convert a usage event into a step/token timeline entry.
///
/// The summary carries the model (when the host recorded one) so both the
/// rich timeline and the ops summary can surface which model produced the
/// turn; the detail keeps the raw token counts plus the provider message
/// id and duration (when the host recorded them) so the duration pass can
/// match the billed turn back to its assistant reply.
fn usage_to_timeline(
    host: Host,
    tokens: UsageTokens,
    cost: Option<f64>,
    timestamp: i64,
    model: Option<&str>,
    message_id: Option<&str>,
    duration_ms: Option<i64>,
) -> Value {
    let mut detail = Map::new();
    detail
        .insert("input".to_string(), Value::Number(Number::from(tokens.input)));
    detail.insert(
        "output".to_string(),
        Value::Number(Number::from(tokens.output)),
    );
    detail.insert(
        "cache_read".to_string(),
        Value::Number(Number::from(tokens.cache_read)),
    );
    detail.insert(
        "cache_write".to_string(),
        Value::Number(Number::from(tokens.cache_write)),
    );
    detail.insert(
        "cost".to_string(),
        cost.map_or(Value::Null, |c| {
            Number::from_f64(c).map_or(Value::Null, Value::Number)
        }),
    );
    if let Some(model) = model {
        detail.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(message_id) = message_id {
        detail.insert(
            "message_id".to_string(),
            Value::String(message_id.to_string()),
        );
    }
    if let Some(duration_ms) = duration_ms {
        detail.insert(
            "duration_ms".to_string(),
            Value::Number(Number::from(duration_ms)),
        );
    }

    let summary = model.map_or_else(
        || {
            format!(
                "usage: {}+{} tokens (cache {}/{})",
                tokens.input,
                tokens.output,
                tokens.cache_read,
                tokens.cache_write
            )
        },
        |model| {
            format!(
                "usage ({model}): {}+{} tokens (cache {}/{})",
                tokens.input,
                tokens.output,
                tokens.cache_read,
                tokens.cache_write
            )
        },
    );

    let mut ev_map = Map::new();
    ev_map.insert(
        "timestamp".to_string(),
        Value::String(epoch_ms_to_iso(timestamp)),
    );
    ev_map.insert("source".to_string(), Value::String(provider_source(host)));
    ev_map.insert("type".to_string(), Value::String("usage".to_string()));
    ev_map.insert("icon".to_string(), Value::String("◈".to_string()));
    ev_map.insert("summary".to_string(), Value::String(summary));
    ev_map.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev_map)
}

/// Tag a timeline entry with its session id, depth and agent.
fn tag_event(
    ev: &mut Value,
    sid: &str,
    depth: i64,
    session_agents: &HashMap<String, String>,
) {
    if let Some(obj) = ev.as_object_mut() {
        obj.insert("session_id".to_string(), Value::String(sid.to_string()));
        obj.insert("depth".to_string(), Value::Number(Number::from(depth)));
        if let Some(agent) = session_agents.get(sid) {
            obj.insert(
                "session_agent".to_string(),
                Value::String(agent.clone()),
            );
        }
    }
}

/// One tool-use recorded while converting a session's event stream.
struct ToolUseInfo {
    name: String,
    timestamp: i64,
    timeline_index: usize,
    /// Tool-call id, when the host recorded one.
    id: Option<String>,
}

/// Convert one session's events, tagging every entry with `sid`/`depth`.
///
/// Tool-use entries are returned alongside so the caller can attach their
/// durations from the matching `ToolResult`.
fn convert_session_events(
    host: Host,
    events: &[SessionEvent],
    sid: &str,
    depth: i64,
    session_agents: &HashMap<String, String>,
) -> (Vec<Value>, Vec<ToolUseInfo>) {
    let mut out: Vec<Value> = Vec::new();
    let mut tool_uses: Vec<ToolUseInfo> = Vec::new();

    for ev in events {
        if let SessionEvent::ToolUse { id, name, timestamp, .. } = ev {
            let index = out.len();
            if let Some(mut value) = event_to_timeline(host, ev) {
                tag_event(&mut value, sid, depth, session_agents);
                out.push(value);
                tool_uses.push(ToolUseInfo {
                    name: name.clone(),
                    timestamp: *timestamp,
                    timeline_index: index,
                    id: id.clone(),
                });
            }
        } else if let Some(mut value) = event_to_timeline(host, ev) {
            tag_event(&mut value, sid, depth, session_agents);
            out.push(value);
        }
    }

    (out, tool_uses)
}

/// Attach `status` and `duration_sec` to tool events using their results.
///
/// Each `ToolResult` is paired with the still-unpaired tool use carrying
/// the same tool-call id, which keeps interleaved same-name calls correct
/// (results may arrive out of order). Results without an id fall back to
/// the historical first-still-unpaired-same-name (FIFO per tool) pairing;
/// results whose id matches no recorded use are dropped rather than
/// risked on a mismatched FIFO pair.
fn attach_tool_results(
    events: &[SessionEvent],
    tool_uses: &[ToolUseInfo],
    out: &mut [Value],
) {
    let mut used = vec![false; tool_uses.len()];
    for ev in events {
        let SessionEvent::ToolResult { id, name, is_error, timestamp, .. } = ev
        else {
            continue;
        };
        let hit = id.as_deref().map_or_else(
            // Legacy results without an id keep the name-FIFO fallback.
            || {
                tool_uses
                    .iter()
                    .enumerate()
                    .find(|(i, info)| !used[*i] && info.name == *name)
            },
            // Results carrying a call id pair exactly by it; an id that
            // matches no recorded use is dropped rather than risked on a
            // mismatched FIFO pair.
            |call_id| {
                tool_uses.iter().enumerate().find(|(i, info)| {
                    !used[*i] && info.id.as_deref() == Some(call_id)
                })
            },
        );
        let Some((index, info)) = hit else {
            continue;
        };
        used[index] = true;
        let Some(obj) =
            out.get_mut(info.timeline_index).and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(detail) = obj.get_mut("detail").and_then(Value::as_object_mut)
        else {
            continue;
        };
        detail.insert(
            "status".to_string(),
            Value::String(
                if *is_error { "error" } else { "completed" }.to_string(),
            ),
        );
        let dur_ms = (*timestamp - info.timestamp).max(0);
        if dur_ms > 0
            && let Some(num) = Number::from_f64(
                f64::from(u32::try_from(dur_ms).unwrap_or(0)) / 1000.0,
            )
        {
            detail.insert("duration_sec".to_string(), Value::Number(num));
        }
    }
}

// ── host lifecycle events ──────────────────────────────────────────────────────

/// Build a `session_id → agent` map from host lifecycle events.
///
/// Uses the `created` event of each session (`OpenCode` only; pi returns
/// `None` from `host_events`, so the map stays empty there).
#[must_use]
pub fn build_session_agents(
    provider: &dyn SessionProvider,
    sids: &HashSet<&str>,
) -> HashMap<String, String> {
    let mut agents: HashMap<String, String> = HashMap::new();
    for sid in sids {
        let Some(events) = provider.host_events(sid) else {
            continue;
        };
        for host_event in events {
            if host_event.kind != "created" {
                continue;
            }
            let agent = host_event
                .data
                .get("detail")
                .and_then(|d| d.get("agent"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    host_event
                        .data
                        .get("detail")
                        .and_then(|d| d.get("slug"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("")
                .to_string();
            agents.insert(sid.to_string(), agent);
            break;
        }
    }
    agents
}

/// Append host lifecycle events for every session to the timeline.
///
/// Returns `false` when the host does not provide lifecycle events (pi),
/// so callers can surface that fact in JSON meta or verbose output.
/// Missing lifecycle events are never an error.
fn add_host_events(
    provider: &dyn SessionProvider,
    sessions: &[(String, i64)],
    session_agents: &HashMap<String, String>,
    timeline: &mut Vec<Value>,
) -> bool {
    let mut seen_any = false;
    for (sid, depth) in sessions {
        let Some(events) = provider.host_events(sid) else {
            continue;
        };
        seen_any = true;
        for host_event in events {
            let mut ev = host_event.data;
            tag_event(&mut ev, sid, *depth, session_agents);
            timeline.push(ev);
        }
    }
    seen_any
}

// ── zoo hook log overlay ──────────────────────────────────────────────────────

/// Convert a `ZooKeeper` log entry to a unified trace event.
///
/// Source is `"zoo"`, type is `"hook"`, icon is `"◈"`. Special summary for
/// `context-metrics` hook events.
#[must_use]
pub fn classify_zoo(entry: &Value) -> Value {
    let hook = entry.get("hook").and_then(Value::as_str).unwrap_or("?");
    let event_ = entry.get("event").and_then(Value::as_str).unwrap_or("?");
    let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");

    let summary = if hook == "context-metrics" && event_ == "context_measured" {
        let tokens = usize::try_from(
            entry.get("estimated_tokens").and_then(Value::as_u64).unwrap_or(0),
        )
        .unwrap_or(0);
        let msgs = usize::try_from(
            entry.get("message_count").and_then(Value::as_u64).unwrap_or(0),
        )
        .unwrap_or(0);
        let agent = entry.get("agent").and_then(Value::as_str).unwrap_or("");

        if agent.is_empty() {
            format!("context: {} tokens ({msgs} msgs)", format_number(tokens))
        } else {
            format!(
                "context [{agent}]: {} tokens ({msgs} msgs)",
                format_number(tokens)
            )
        }
    } else {
        format!("{hook}/{event_}")
    };

    let timestamp = parser::normalize_timestamp(
        entry.get("timestamp").and_then(Value::as_str).unwrap_or(""),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp));
    ev.insert("source".to_string(), Value::String("zoo".to_string()));
    ev.insert("type".to_string(), Value::String("hook".to_string()));
    ev.insert("icon".to_string(), Value::String("◈".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), entry.clone());
    ev.insert("level".to_string(), Value::String(level.to_string()));

    Value::Object(ev)
}

/// Read `ZooKeeper` log events and add them to the timeline.
///
/// The log file is named `<host>-{session_id}.log` (host ∈ {opencode, pi})
/// in the zoo log dir. Each event is tagged with the session it belongs to
/// (by sessionId or agent-name matching) and its depth in the session tree.
fn add_zoo_log_events(
    session_id: &str,
    timeline: &mut Vec<Value>,
    all_sids: &HashSet<String>,
    sessions: &[(String, i64)],
    session_agents: &HashMap<String, String>,
) {
    let zoo_dir = get_zoo_log_dir();
    let Some(root_zoo_path) = resolve_session_path(session_id, &zoo_dir) else {
        return;
    };

    let zoo_events = parser::parse_zoo_log(&root_zoo_path);
    for zoo_ev in &zoo_events {
        // Determine which session this entry belongs to
        let mut target_sid: Option<String> = None;
        let zoo_sid = zoo_ev
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let zoo_agent = zoo_ev
            .get("agent")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        if !zoo_sid.is_empty() && all_sids.contains(&zoo_sid) {
            target_sid = Some(zoo_sid);
        } else if !zoo_agent.is_empty() {
            // Empty or unknown sessionId — match by agent name
            for (sid, _) in sessions {
                if session_agents.get(sid) == Some(&zoo_agent) {
                    target_sid = Some(sid.clone());
                    break;
                }
            }
        } else if zoo_sid.is_empty() && zoo_agent.is_empty() {
            // Both sessionId and agent empty — assign to root
            target_sid = Some(session_id.to_string());
        }

        if let Some(ref sid) = target_sid
            && all_sids.contains(sid)
        {
            let mut ev = classify_zoo(zoo_ev);
            if let Some(obj) = ev.as_object_mut() {
                obj.insert(
                    "session_id".to_string(),
                    Value::String(sid.clone()),
                );
            }
            timeline.push(ev);
        }
    }
}

// ── build_timeline ────────────────────────────────────────────────────────────

/// Result of [`build_timeline`]: the sorted events plus whether the host
/// provided lifecycle events.
pub struct BuiltTimeline {
    /// Unified, timestamp-sorted timeline events.
    pub events: Vec<Value>,
    /// `false` when the host does not provide lifecycle events.
    pub host_events_provided: bool,
}

/// Merge the session event stream, zoo hook logs and host lifecycle events
/// into a sorted timeline.
///
/// `sessions` lists every session to include (root first, then children)
/// with its depth; `session_map` holds the opened [`Session`] for each.
/// Events are tagged with `session_id`, `depth`, and `session_agent`.
#[must_use]
pub fn build_timeline(
    provider: &dyn SessionProvider,
    host: Host,
    sessions: &[(String, i64)],
    session_map: &HashMap<String, Session>,
    session_agents: &HashMap<String, String>,
    root_session_id: &str,
) -> BuiltTimeline {
    let all_sids: HashSet<String> =
        sessions.iter().map(|(sid, _)| sid.clone()).collect();

    let mut timeline: Vec<Value> = Vec::new();

    // ── Session event stream ──
    for (sid, depth) in sessions {
        let Some(session) = session_map.get(sid) else {
            continue;
        };
        let (mut session_events, tool_uses) = convert_session_events(
            host,
            &session.events,
            sid,
            *depth,
            session_agents,
        );
        attach_tool_results(&session.events, &tool_uses, &mut session_events);
        timeline.append(&mut session_events);
    }

    // ── Zoo hook log overlay (existing logic, host-prefixed) ──
    add_zoo_log_events(
        root_session_id,
        &mut timeline,
        &all_sids,
        sessions,
        session_agents,
    );

    // ── Host lifecycle events ──
    let host_events_provided =
        add_host_events(provider, sessions, session_agents, &mut timeline);

    // Sort by timestamp (missing timestamps last)
    timeline.sort_by(|a, b| {
        let ts_a = a.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let ts_b = b.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let src_a = a.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let src_b = b.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let type_a = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let type_b = b.get("type").and_then(|v| v.as_str()).unwrap_or("");

        ts_a.cmp(ts_b).then(src_a.cmp(src_b)).then(type_a.cmp(type_b))
    });

    BuiltTimeline { events: timeline, host_events_provided }
}

// ── sort_ops_by_session ───────────────────────────────────────────────────────

/// Sort ops: root events chronologically, child events grouped by session.
///
/// Root events appear at their own timestamp position.  Child events from
/// the same session form a contiguous block anchored at that session's
/// minimum timestamp, appearing right after any root event at that same
/// timestamp.
///
/// Each op is a dict with keys `"index"` (usize) and `"event"` (dict).
/// The event dict must contain `"depth"`, `"session_id"`, and `"timestamp"`
/// fields.
///
/// Returns a new sorted list.  Does NOT mutate the input.
#[must_use]
pub fn sort_ops_by_session(ops: &[Value]) -> Vec<Value> {
    // Collect timestamps per child session, then compute min
    let mut child_ts: HashMap<String, Vec<String>> = HashMap::new();

    for op in ops {
        if let Some(event) = op.get("event") {
            let depth = event.get("depth").and_then(Value::as_i64).unwrap_or(0);
            if depth > 0
                && let Some(sid) =
                    event.get("session_id").and_then(Value::as_str)
                && !sid.is_empty()
            {
                let ts = event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                child_ts.entry(sid.to_string()).or_default().push(ts);
            }
        }
    }

    let child_session_min_ts: HashMap<String, String> = child_ts
        .into_iter()
        .map(|(sid, ts_list)| {
            let min_ts = ts_list.into_iter().min().unwrap_or_default();
            (sid, min_ts)
        })
        .collect();

    let mut indexed_ops: Vec<(usize, &Value)> =
        ops.iter().enumerate().collect();

    indexed_ops.sort_by(|(idx_a, op_a), (idx_b, op_b)| {
        let event_a = op_a.get("event").and_then(|v| v.as_object());
        let event_b = op_b.get("event").and_then(|v| v.as_object());

        // Extract sort fields from event objects
        let extract =
            |event: Option<&Map<String, Value>>| -> (i64, String, String) {
                event.map_or_else(
                    || (0, String::new(), String::new()),
                    |obj| {
                        let depth = obj
                            .get("depth")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let ts = obj
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let sid = obj
                            .get("session_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        (depth, ts, sid)
                    },
                )
            };

        let (depth_a, ts_a, sid_a) = extract(event_a);
        let (depth_b, ts_b, sid_b) = extract(event_b);

        let group_key_a = if depth_a > 0 {
            child_session_min_ts
                .get(&sid_a)
                .cloned()
                .unwrap_or_else(|| ts_a.clone())
        } else {
            ts_a.clone()
        };

        let group_key_b = if depth_b > 0 {
            child_session_min_ts
                .get(&sid_b)
                .cloned()
                .unwrap_or_else(|| ts_b.clone())
        } else {
            ts_b.clone()
        };

        let depth_priority_a = i32::from(depth_a != 0);
        let depth_priority_b = i32::from(depth_b != 0);

        group_key_a
            .cmp(&group_key_b)
            .then(depth_priority_a.cmp(&depth_priority_b))
            .then(sid_a.cmp(&sid_b))
            .then(ts_a.cmp(&ts_b))
            .then(idx_a.cmp(idx_b))
    });

    indexed_ops.into_iter().map(|(_, op)| op.clone()).collect()
}

// ── mark_block_boundaries ─────────────────────────────────────────────────────

/// Block boundary maps: top events (depth + `session_id`) and bottom events (depth).
pub type BlockBoundaryMap =
    (HashMap<usize, Vec<(i64, String)>>, HashMap<usize, Vec<i64>>);

/// Pre-compute block start/end positions for child session box borders.
///
/// Each op must have `"event"` with `"depth"` and `"session_id"`.
///
/// Returns `(tops, bottoms)`:
/// - `tops`: top border BEFORE `ops[i]`, value is list of `(depth, session_id)`.
/// - `bottoms`: bottom border BEFORE `ops[i]` (or AFTER last event for
///   `index == len(ops)`), value is list of depths.
#[must_use]
pub fn mark_block_boundaries(ops: &[Value]) -> BlockBoundaryMap {
    let mut tops: HashMap<usize, Vec<(i64, String)>> = HashMap::new();
    let mut bottoms: HashMap<usize, Vec<i64>> = HashMap::new();
    // Stack of (depth, session_id)
    let mut stack: Vec<(i64, String)> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        let Some(event) = op.get("event").and_then(Value::as_object) else {
            continue;
        };
        let d = event.get("depth").and_then(Value::as_i64).unwrap_or(0);
        let s = event
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Close blocks whose depth >= current depth AND
        // (depth != current depth OR sid differs).
        // Skip closing when going deeper or continuing the same block.
        while let Some((top_depth, top_sid)) = stack.last() {
            if d > *top_depth {
                break; // going deeper — keep parent open
            }
            if d == *top_depth && s == *top_sid {
                break; // same block continuing
            }
            let closed_depth = stack.pop().unwrap().0;
            bottoms.entry(i).or_default().push(closed_depth);
        }

        // Open new block if depth > 0 and deeper than current deepest
        if d > 0 && (stack.is_empty() || d > stack.last().unwrap().0) {
            stack.push((d, s.clone()));
            tops.entry(i).or_default().push((d, s));
        }
    }

    // Close remaining open blocks at the end
    while let Some((closed_depth, _)) = stack.pop() {
        bottoms.entry(ops.len()).or_default().push(closed_depth);
    }

    (tops, bottoms)
}

// ── build_stats — helpers ────────────────────────────────────────────────────

/// Collect type and source distribution counts from the timeline.
fn collect_type_and_source_distributions(
    timeline: &[Value],
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut type_dist: HashMap<String, usize> = HashMap::new();
    let mut source_dist: HashMap<String, usize> = HashMap::new();

    for ev in timeline {
        let etype =
            ev.get("type").and_then(|v| v.as_str()).unwrap_or("?").to_string();
        let src = ev
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();

        *type_dist.entry(etype).or_insert(0) += 1;
        *source_dist.entry(src).or_insert(0) += 1;
    }

    (type_dist, source_dist)
}

/// Compute the time span (start / end / seconds) from timeline timestamps.
fn compute_stats_time_span(timeline: &[Value]) -> Option<Value> {
    let timestamps: Vec<&str> = timeline
        .iter()
        .filter_map(|ev| ev.get("timestamp").and_then(|v| v.as_str()))
        .filter(|ts| !ts.is_empty())
        .collect();

    if timestamps.len() < 2 {
        return None;
    }

    let first_ts = timestamps[0];
    let last_ts = timestamps[timestamps.len() - 1];

    let first_epoch_ms = iso_to_epoch_ms(first_ts);
    let last_epoch_ms = iso_to_epoch_ms(last_ts);

    if first_epoch_ms == 0 || last_epoch_ms == 0 {
        return None;
    }

    let seconds = (last_epoch_ms - first_epoch_ms) / 1000;
    let mut ts_map = Map::new();
    ts_map.insert("start".to_string(), Value::String(first_ts.to_string()));
    ts_map.insert("end".to_string(), Value::String(last_ts.to_string()));
    ts_map.insert("seconds".to_string(), Value::Number(Number::from(seconds)));
    Some(Value::Object(ts_map))
}

/// Build the tools breakdown map from type distribution.
fn build_tools_breakdown(type_dist: &HashMap<String, usize>) -> Value {
    let total = type_dist.get("tool_read").copied().unwrap_or(0)
        + type_dist.get("tool_write").copied().unwrap_or(0)
        + type_dist.get("tool_exec").copied().unwrap_or(0)
        + type_dist.get("tool_orch").copied().unwrap_or(0)
        + type_dist.get("tool_other").copied().unwrap_or(0);

    let mut tools_map = Map::new();
    tools_map
        .insert("total".to_string(), Value::Number(Number::from(total as u64)));
    tools_map.insert(
        "read".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_read").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "write".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_write").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "exec".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_exec").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "orch".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_orch").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "other".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_other").copied().unwrap_or(0) as u64,
        )),
    );
    Value::Object(tools_map)
}

/// Convert a `HashMap<String, usize>` to a JSON object Value (keys → u64).
fn dist_map_to_value(dist: &HashMap<String, usize>) -> Value {
    let mut m = Map::new();
    for (k, v) in dist {
        m.insert(k.clone(), Value::Number(Number::from(*v as u64)));
    }
    Value::Object(m)
}

// ── build_stats ───────────────────────────────────────────────────────────────

/// Extract statistics from a timeline.
///
/// # Arguments
///
/// * `timeline` — List of unified event dicts from `build_timeline()`.
/// * `child_sessions` — Optional list of child session info dicts
///   (each with keys `"session_id"`, `"depth"`, `"agent"`, `"event_count"`)
///   to include in the returned stats.
///
/// # Returns
///
/// Dict with fields:
/// - `total_events`, `total_turns`, `llm_calls`, `tool_calls`,
///   `permission_checks`, `zoo_interventions`, `session_events`,
///   `file_events`, `type_distribution`, `source_distribution`,
///   `time_span`, `tools` (breakdown)
#[must_use]
pub fn build_stats(
    timeline: &[Value],
    child_sessions: Option<&[Value]>,
) -> Value {
    let total = timeline.len();

    let (type_dist, source_dist) =
        collect_type_and_source_distributions(timeline);

    let time_span = compute_stats_time_span(timeline);

    let llm_calls = type_dist.get("llm").copied().unwrap_or(0)
        + type_dist.get("llm_stream").copied().unwrap_or(0);

    let tool_calls = type_dist.get("tool_read").copied().unwrap_or(0)
        + type_dist.get("tool_write").copied().unwrap_or(0)
        + type_dist.get("tool_exec").copied().unwrap_or(0)
        + type_dist.get("tool_orch").copied().unwrap_or(0)
        + type_dist.get("tool_other").copied().unwrap_or(0);

    let type_dist_val: Value = dist_map_to_value(&type_dist);
    let source_dist_val: Value = dist_map_to_value(&source_dist);

    let mut result = Map::new();
    result.insert(
        "total_events".to_string(),
        Value::Number(Number::from(total as u64)),
    );
    result.insert(
        "total_turns".to_string(),
        Value::Number(Number::from(
            timeline
                .iter()
                .filter(|ev| {
                    ev.get("source").and_then(|v| v.as_str())
                        == Some("opencode")
                        && ev.get("type").and_then(|v| v.as_str())
                            == Some("session")
                })
                .count() as u64,
        )),
    );
    result.insert(
        "llm_calls".to_string(),
        Value::Number(Number::from(llm_calls as u64)),
    );
    result.insert(
        "tool_calls".to_string(),
        Value::Number(Number::from(tool_calls as u64)),
    );
    result.insert(
        "permission_checks".to_string(),
        Value::Number(Number::from(
            type_dist.get("permission").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "zoo_interventions".to_string(),
        Value::Number(Number::from(
            source_dist.get("zoo").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "session_events".to_string(),
        Value::Number(Number::from(
            type_dist.get("session").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "file_events".to_string(),
        Value::Number(Number::from(
            type_dist.get("file").copied().unwrap_or(0) as u64,
        )),
    );

    result.insert("type_distribution".to_string(), type_dist_val);
    result.insert("source_distribution".to_string(), source_dist_val);

    if let Some(ts) = time_span {
        result.insert("time_span".to_string(), ts);
    } else {
        result.insert("time_span".to_string(), Value::Null);
    }

    let tools_map = build_tools_breakdown(&type_dist);
    result.insert("tools".to_string(), tools_map);

    if let Some(children) = child_sessions {
        let child_vec: Vec<Value> = children.to_vec();
        let total_child_events: usize = children
            .iter()
            .filter_map(|cs| {
                cs.get("event_count")
                    .and_then(Value::as_u64)
                    .and_then(|v| usize::try_from(v).ok())
            })
            .sum();

        result.insert("child_sessions".to_string(), Value::Array(child_vec));
        result.insert(
            "total_child_sessions".to_string(),
            Value::Number(Number::from(children.len() as u64)),
        );
        result.insert(
            "total_child_events".to_string(),
            Value::Number(Number::from(total_child_events as u64)),
        );
    }

    Value::Object(result)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use zutil::session::SessionMeta;

    fn meta(id: &str) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            parent_id: None,
            cwd: "/w".to_string(),
            started_at: 0,
            label: None,
            title: None,
            updated_at: None,
            model: None,
            agent: None,
        }
    }

    fn session(id: &str, events: Vec<SessionEvent>) -> Session {
        Session { meta: meta(id), events }
    }

    /// Provider stub that never reports host events.
    struct NoHost;
    impl SessionProvider for NoHost {
        fn list(&self) -> std::io::Result<Vec<zutil::session::SessionMeta>> {
            Ok(vec![])
        }
        fn open(
            &self,
            _: &str,
        ) -> Result<Session, zutil::session::ResolveError> {
            Err(zutil::session::ResolveError::Io(std::io::Error::other("no")))
        }
        fn search(
            &self,
            _: &str,
        ) -> std::io::Result<Vec<zutil::session::SessionMeta>> {
            Ok(vec![])
        }
        fn find_events(
            &self,
            _: &[String],
            _: usize,
        ) -> std::io::Result<
            Vec<(zutil::session::SessionMeta, Vec<SessionEvent>)>,
        > {
            Ok(vec![])
        }
    }

    fn msg_event(role: &str, text: &str, ts: i64) -> SessionEvent {
        SessionEvent::Message {
            id: None,
            role: role.to_string(),
            text: text.to_string(),
            timestamp: ts,
        }
    }

    fn tool_use_event(name: &str, ts: i64) -> SessionEvent {
        SessionEvent::ToolUse {
            id: None,
            name: name.to_string(),
            input: Value::Null,
            timestamp: ts,
        }
    }

    fn tool_result_event(name: &str, ts: i64, is_error: bool) -> SessionEvent {
        SessionEvent::ToolResult {
            id: None,
            name: name.to_string(),
            output: String::new(),
            is_error,
            timestamp: ts,
        }
    }

    fn usage_event(ts: i64) -> SessionEvent {
        SessionEvent::Usage {
            input: 10,
            output: 5,
            cache_read: 2,
            cache_write: 1,
            cost: None,
            timestamp: ts,
            reasoning: 0,
            reason: None,
            message_id: None,
            duration_ms: None,
            model: None,
        }
    }

    // ── event → timeline ──────────────────────────────────────────────────

    #[test]
    fn test_event_to_timeline_message_user_and_assistant() {
        let user = msg_event("user", "hello", 1_000);
        let ev = event_to_timeline(Host::OpenCode, &user).expect("user msg");
        assert_eq!(ev["type"].as_str().unwrap(), "user_msg");
        assert_eq!(ev["source"].as_str().unwrap(), "db");
        assert_eq!(ev["content"].as_str().unwrap(), "hello");
        assert_eq!(
            ev["timestamp"].as_str().unwrap(),
            "1970-01-01T00:00:01.000000Z"
        );

        let asst = msg_event("assistant", "hi", 2_000);
        let ev = event_to_timeline(Host::Pi, &asst).expect("asst msg");
        assert_eq!(ev["type"].as_str().unwrap(), "assistant_reply");
        assert_eq!(ev["source"].as_str().unwrap(), "pi");
    }

    #[test]
    fn test_event_to_timeline_skips_unknown_roles_and_results() {
        let tool_role = msg_event("tool", "text", 1);
        assert!(event_to_timeline(Host::OpenCode, &tool_role).is_none());
        let result = tool_result_event("bash", 2, false);
        assert!(event_to_timeline(Host::OpenCode, &result).is_none());
    }

    #[test]
    fn test_event_to_timeline_tool_and_usage() {
        let tool = tool_use_event("read", 1_000);
        let ev = event_to_timeline(Host::OpenCode, &tool).expect("tool");
        assert_eq!(ev["type"].as_str().unwrap(), "tool_read");
        assert_eq!(ev["summary"].as_str().unwrap(), "read");
        assert_eq!(ev["detail"]["tool_name"].as_str().unwrap(), "read");

        let usage = usage_event(2_000);
        let ev = event_to_timeline(Host::Pi, &usage).expect("usage");
        assert_eq!(ev["type"].as_str().unwrap(), "usage");
        assert_eq!(ev["source"].as_str().unwrap(), "pi");
        assert_eq!(ev["detail"]["input"].as_i64().unwrap(), 10);
    }

    #[test]
    fn test_event_to_timeline_reasoning() {
        // OpenCode `reasoning` parts become an assistant-reasoning row with
        // the historical icon and summary shape.
        let reasoning = SessionEvent::Reasoning {
            text: "let me think about the parser".to_string(),
            timestamp: 2_500,
            id: Some("part-r1".to_string()),
        };
        let ev =
            event_to_timeline(Host::OpenCode, &reasoning).expect("reasoning");
        assert_eq!(ev["type"].as_str().unwrap(), "assistant_reasoning");
        assert_eq!(ev["icon"].as_str().unwrap(), "🧠");
        assert_eq!(ev["source"].as_str().unwrap(), "db");
        assert_eq!(
            ev["summary"].as_str().unwrap(),
            "Reasoning: let me think about the parser"
        );
        assert_eq!(
            ev["content"].as_str().unwrap(),
            "let me think about the parser"
        );

        // pi `thinking` blocks flow through the same event → same row shape.
        let thinking = SessionEvent::Reasoning {
            text: "pi thinking".to_string(),
            timestamp: 2_600,
            id: None,
        };
        let ev = event_to_timeline(Host::Pi, &thinking).expect("thinking");
        assert_eq!(ev["type"].as_str().unwrap(), "assistant_reasoning");
        assert_eq!(ev["icon"].as_str().unwrap(), "🧠");
        assert_eq!(ev["source"].as_str().unwrap(), "pi");
    }

    #[test]
    fn test_primary_tool_input_priority() {
        let input = serde_json::json!({
            "command": "ls -la /very/long/path/that/exceeds/fifty/characters/easily/yes",
            "filePath": "src/a.ts",
        });
        assert_eq!(primary_tool_input(&input), "src/a.ts");
        let input = serde_json::json!({"command": "cargo test"});
        assert_eq!(primary_tool_input(&input), "cargo test");
        assert_eq!(primary_tool_input(&Value::Null), "");
    }

    #[test]
    fn test_attach_tool_results_sets_duration_and_status() {
        let events = vec![
            tool_use_event("read", 1_000),
            tool_result_event("read", 1_500, false),
        ];
        let sid = "ses-001";
        let agents = HashMap::new();
        let (mut out, tools) =
            convert_session_events(Host::OpenCode, &events, sid, 0, &agents);
        assert_eq!(out.len(), 1);
        attach_tool_results(&events, &tools, &mut out);
        let detail = out[0]["detail"].as_object().unwrap();
        assert_eq!(detail["status"].as_str().unwrap(), "completed");
        assert!((detail["duration_sec"].as_f64().unwrap() - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_attach_tool_results_error_status() {
        let events = vec![
            tool_use_event("bash", 1_000),
            tool_result_event("bash", 1_000, true),
        ];
        let agents = HashMap::new();
        let (mut out, tools) = convert_session_events(
            Host::OpenCode,
            &events,
            "ses-001",
            0,
            &agents,
        );
        attach_tool_results(&events, &tools, &mut out);
        let detail = out[0]["detail"].as_object().unwrap();
        assert_eq!(detail["status"].as_str().unwrap(), "error");
        // zero duration → no duration_sec key
        assert!(detail.get("duration_sec").is_none());
    }

    fn tool_use_event_id(name: &str, id: &str, ts: i64) -> SessionEvent {
        SessionEvent::ToolUse {
            id: Some(id.to_string()),
            name: name.to_string(),
            input: Value::Null,
            timestamp: ts,
        }
    }

    fn tool_result_event_id(
        name: &str,
        id: &str,
        ts: i64,
        is_error: bool,
    ) -> SessionEvent {
        SessionEvent::ToolResult {
            id: Some(id.to_string()),
            name: name.to_string(),
            output: String::new(),
            is_error,
            timestamp: ts,
        }
    }

    #[test]
    fn test_attach_tool_results_matches_by_call_id() {
        // Two interleaved same-name calls whose results arrive out of
        // order. FIFO-by-name would pair result call-2 with the first
        // read; id matching must keep each result with its own call.
        let events = vec![
            tool_use_event_id("read", "call-1", 1_000),
            tool_use_event_id("read", "call-2", 1_000),
            tool_result_event_id("read", "call-2", 1_500, false),
            tool_result_event_id("read", "call-1", 2_500, true),
        ];
        let agents = HashMap::new();
        let (mut out, tools) = convert_session_events(
            Host::OpenCode,
            &events,
            "ses-001",
            0,
            &agents,
        );
        assert_eq!(out.len(), 2);
        attach_tool_results(&events, &tools, &mut out);
        // call-1 → error, duration 1.5s (2500 - 1000).
        let d0 = out[0]["detail"].as_object().unwrap();
        assert_eq!(d0["status"].as_str().unwrap(), "error");
        assert!((d0["duration_sec"].as_f64().unwrap() - 1.5).abs() < 0.001);
        // call-2 → completed, duration 0.5s (1500 - 1000).
        let d1 = out[1]["detail"].as_object().unwrap();
        assert_eq!(d1["status"].as_str().unwrap(), "completed");
        assert!((d1["duration_sec"].as_f64().unwrap() - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_attach_tool_results_falls_back_to_name_fifo_without_ids() {
        // Results without a call id keep the historical name-FIFO pairing
        // (the pre-id behavior for hosts that recorded none).
        let events = vec![
            tool_use_event("read", 1_000),
            tool_use_event("read", 1_100),
            tool_result_event("read", 1_500, false),
            tool_result_event("read", 1_600, true),
        ];
        let agents = HashMap::new();
        let (mut out, tools) = convert_session_events(
            Host::OpenCode,
            &events,
            "ses-001",
            0,
            &agents,
        );
        attach_tool_results(&events, &tools, &mut out);
        let d0 = out[0]["detail"].as_object().unwrap();
        assert_eq!(d0["status"].as_str().unwrap(), "completed");
        let d1 = out[1]["detail"].as_object().unwrap();
        assert_eq!(d1["status"].as_str().unwrap(), "error");
    }

    #[test]
    fn test_build_timeline_merges_stream_zoo_and_host() {
        // No zoo log and no host events in this hermetic test: only the
        // provider-derived events must appear, tagged and sorted.
        let events = vec![
            usage_event(3_000),
            tool_use_event("read", 2_000),
            msg_event("user", "hello", 1_000),
        ];
        let root = session("ses-001", events);
        let mut session_map = HashMap::new();
        session_map.insert("ses-001".to_string(), root);
        let sessions = vec![("ses-001".to_string(), 0_i64)];

        let built = build_timeline(
            &NoHost,
            Host::OpenCode,
            &sessions,
            &session_map,
            &HashMap::new(),
            "ses-001",
        );
        assert!(!built.host_events_provided);
        assert_eq!(built.events.len(), 3);
        // Sorted ascending by timestamp: user (1s), tool (2s), usage (3s).
        assert_eq!(built.events[0]["type"].as_str().unwrap(), "user_msg");
        assert_eq!(built.events[1]["type"].as_str().unwrap(), "tool_read");
        assert_eq!(built.events[2]["type"].as_str().unwrap(), "usage");
        for ev in &built.events {
            assert_eq!(ev["session_id"].as_str().unwrap(), "ses-001");
            assert_eq!(ev["depth"].as_i64().unwrap(), 0);
        }
    }

    // ── classify_zoo tests ─────────────────────────────────────────────────

    #[test]
    fn test_classify_zoo_basic() {
        let mut entry = Map::new();
        entry.insert("hook".to_string(), Value::String("tool".to_string()));
        entry.insert(
            "event".to_string(),
            Value::String("bash_exec".to_string()),
        );
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(ev["source"].as_str().unwrap(), "zoo");
        assert_eq!(ev["type"].as_str().unwrap(), "hook");
        assert_eq!(ev["icon"].as_str().unwrap(), "◈");
        assert_eq!(ev["level"].as_str().unwrap(), "info");
        assert_eq!(ev["summary"].as_str().unwrap(), "tool/bash_exec");
    }

    #[test]
    fn test_classify_zoo_context_metrics() {
        let mut entry = Map::new();
        entry.insert(
            "hook".to_string(),
            Value::String("context-metrics".to_string()),
        );
        entry.insert(
            "event".to_string(),
            Value::String("context_measured".to_string()),
        );
        entry.insert(
            "estimated_tokens".to_string(),
            Value::Number(Number::from(1_500_u64)),
        );
        entry.insert(
            "message_count".to_string(),
            Value::Number(Number::from(5_u64)),
        );
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(
            ev["summary"].as_str().unwrap(),
            "context: 1,500 tokens (5 msgs)"
        );
    }

    #[test]
    fn test_classify_zoo_context_metrics_with_agent() {
        let mut entry = Map::new();
        entry.insert(
            "hook".to_string(),
            Value::String("context-metrics".to_string()),
        );
        entry.insert(
            "event".to_string(),
            Value::String("context_measured".to_string()),
        );
        entry.insert(
            "estimated_tokens".to_string(),
            Value::Number(Number::from(2_500_u64)),
        );
        entry.insert(
            "message_count".to_string(),
            Value::Number(Number::from(10_u64)),
        );
        entry.insert("agent".to_string(), Value::String("beaver".to_string()));
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(
            ev["summary"].as_str().unwrap(),
            "context [beaver]: 2,500 tokens (10 msgs)"
        );
    }

    // ── sort_ops_by_session tests ─────────────────────────────────────────

    #[test]
    fn test_sort_ops_by_session_root_only() {
        let mut ev1 = Map::new();
        ev1.insert("depth".to_string(), Value::Number(Number::from(0)));
        ev1.insert(
            "session_id".to_string(),
            Value::String("ses-001".to_string()),
        );
        ev1.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );

        let mut ev2 = Map::new();
        ev2.insert("depth".to_string(), Value::Number(Number::from(0)));
        ev2.insert(
            "session_id".to_string(),
            Value::String("ses-001".to_string()),
        );
        ev2.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:57Z".to_string()),
        );

        let op1 = Value::Object({
            let mut m = Map::new();
            m.insert("index".to_string(), Value::Number(Number::from(0)));
            m.insert("event".to_string(), Value::Object(ev1));
            m
        });
        let op2 = Value::Object({
            let mut m = Map::new();
            m.insert("index".to_string(), Value::Number(Number::from(1)));
            m.insert("event".to_string(), Value::Object(ev2));
            m
        });

        let ops = vec![op2, op1]; // intentionally reversed
        let sorted = sort_ops_by_session(&ops);
        assert_eq!(sorted.len(), 2);
        // Should be sorted by timestamp
        assert_eq!(
            sorted[0]["event"]["timestamp"].as_str().unwrap(),
            "2025-01-09T12:34:56Z"
        );
    }

    // ── mark_block_boundaries tests ────────────────────────────────────────

    #[test]
    fn test_mark_block_boundaries_single_child_block() {
        let mut event = Map::new();
        event.insert("depth".to_string(), Value::Number(Number::from(1)));
        event.insert(
            "session_id".to_string(),
            Value::String("ses-child".to_string()),
        );

        let op = Value::Object({
            let mut m = Map::new();
            m.insert("event".to_string(), Value::Object(event));
            m
        });

        let (tops, bottoms) = mark_block_boundaries(&[op]);
        // Should have a top at index 0 and a bottom at index 1 (end)
        assert!(tops.contains_key(&0));
        assert!(bottoms.contains_key(&1));
    }

    // ── build_stats tests ─────────────────────────────────────────────────

    #[test]
    fn test_build_stats_empty() {
        let timeline = vec![];
        let stats = build_stats(&timeline, None);
        assert_eq!(stats["total_events"].as_u64().unwrap(), 0);
        assert!(stats["time_span"].is_null());
    }

    #[test]
    fn test_build_stats_basic() {
        let mut ev1 = Map::new();
        ev1.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        ev1.insert("source".to_string(), Value::String("opencode".to_string()));
        ev1.insert("type".to_string(), Value::String("session".to_string()));

        let mut ev2 = Map::new();
        ev2.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:35:00Z".to_string()),
        );
        ev2.insert("source".to_string(), Value::String("opencode".to_string()));
        ev2.insert("type".to_string(), Value::String("tool_read".to_string()));

        let timeline = vec![Value::Object(ev1), Value::Object(ev2)];
        let stats = build_stats(&timeline, None);

        assert_eq!(stats["total_events"].as_u64().unwrap(), 2);
        assert_eq!(stats["total_turns"].as_u64().unwrap(), 1);
        assert_eq!(stats["tool_calls"].as_u64().unwrap(), 1);
        assert_eq!(stats["tools"]["read"].as_u64().unwrap(), 1);

        let time_span = stats["time_span"].as_object().unwrap();
        assert_eq!(time_span["seconds"].as_i64().unwrap(), 4);
    }

    #[test]
    fn test_build_stats_with_child_sessions() {
        let timeline = vec![];
        let child = Value::Object({
            let mut m = Map::new();
            m.insert(
                "session_id".to_string(),
                Value::String("child-001".to_string()),
            );
            m.insert("event_count".to_string(), Value::Number(Number::from(5)));
            m
        });
        let children = vec![child];

        let stats = build_stats(&timeline, Some(&children));
        assert_eq!(stats["total_child_sessions"].as_u64().unwrap(), 1);
        assert_eq!(stats["total_child_events"].as_u64().unwrap(), 5);
    }
}
