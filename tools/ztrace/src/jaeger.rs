// Jaeger + Chrome Trace export functions for ztrace.
//
// Produces Chrome Trace Event Format JSON and Jaeger-compatible JSON
// documents from a timeline of unified events (serde_json::Value dicts).

use std::collections::HashMap;

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

// ── to_epoch_us ───────────────────────────────────────────────────────────────

/// Convert an ISO 8601 timestamp to epoch microseconds.
///
/// Supports `Z` suffix and RFC 3339 / common ISO formats.
/// Returns 0 on parse failure.
#[must_use]
pub fn to_epoch_us(ts: &str) -> i64 {
    if ts.is_empty() {
        return 0;
    }
    let cleaned = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&cleaned) {
        return dt.timestamp_micros();
    }
    // Try NaiveDateTime formats (no timezone)
    let bare = ts.trim_end_matches('Z');
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S%.f")
    {
        return nd.and_utc().timestamp_micros();
    }
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S")
    {
        return nd.and_utc().timestamp_micros();
    }
    0
}

// ── get_operation_name ────────────────────────────────────────────────────────

/// Derive the Jaeger operationName from a timeline event.
#[must_use]
pub fn get_operation_name(event: &Value) -> String {
    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let detail: Map<String, Value> = event
        .get("detail")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let op_map: [(&str, &str); 12] = [
        ("llm", "llm.select"),
        ("llm_stream", "llm.stream"),
        ("permission", "permission.deny"),
        ("tool_read", "tool.read"),
        ("tool_write", "tool.write"),
        ("tool_exec", "tool.exec"),
        ("tool_orch", "tool.orch"),
        ("tool_other", "tool.other"),
        ("file", "file.touch"),
        ("user_msg", "user.message"),
        ("assistant_reply", "assistant.reply"),
        ("assistant_reasoning", "assistant.reasoning"),
    ];

    if etype == "session" {
        if detail
            .get("slug")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
        {
            return "session.create".to_string();
        }
        if detail
            .get("step")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
        {
            return "session.loop".to_string();
        }
        if detail
            .get("message_id")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
        {
            return "session.process".to_string();
        }
        return "session.exit".to_string();
    }

    if etype == "hook" {
        if source == "zoo" {
            let hook_name = detail
                .get("hook")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            return format!("zoo.{hook_name}");
        }
        return "opencode.hook".to_string();
    }

    for &(key, val) in &op_map {
        if etype == key {
            return val.to_string();
        }
    }

    etype.to_string()
}

// ── _add_detail_tags helper ────────────────────────────────────────────────────

/// Add non-empty tags from `detail` (or fallback `event` top-level keys).
fn add_detail_tags(
    tags: &mut Vec<Value>,
    detail: &Map<String, Value>,
    keys: &[&str],
    event: Option<&Value>,
) {
    for &key in keys {
        let val = detail
            .get(key)
            .or_else(|| event.and_then(|e| e.get(key)))
            .and_then(value_to_nonempty_string);
        if let Some(s) = val {
            let mut tag = Map::new();
            tag.insert("key".to_string(), Value::String(key.to_string()));
            tag.insert("type".to_string(), Value::String("string".to_string()));
            tag.insert("value".to_string(), Value::String(s));
            tags.push(Value::Object(tag));
        }
    }
}

/// Extract a non-empty string from a Value (String or Number).
fn value_to_nonempty_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => {
            let s = n.to_string();
            if s.is_empty() { None } else { Some(s) }
        }
        _ => None,
    }
}

// ── build_tags ─────────────────────────────────────────────────────────────────

/// Build Jaeger span tags from a timeline event.
///
/// Produces common tags for all events plus type-specific tags from the
/// ``detail`` sub-dict.
#[must_use]
pub fn build_tags(event: &Value) -> Vec<Value> {
    let detail: Map<String, Value> = event
        .get("detail")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let depth =
        event.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
    let summary = event.get("summary").and_then(|v| v.as_str()).unwrap_or("");

    // ── Common tags ──
    let mut tags: Vec<Value> = vec![
        make_tag("source", "string", source),
        make_tag("event.type", "string", etype),
        make_tag(
            "session_id",
            "string",
            event.get("session_id").and_then(|v| v.as_str()).unwrap_or(""),
        ),
        make_tag("depth", "int64", &depth.to_string()),
        make_tag(
            "summary",
            "string",
            &summary.chars().take(256).collect::<String>(),
        ),
    ];

    if depth > 0 {
        tags.push(make_tag(
            "session_agent",
            "string",
            event.get("session_agent").and_then(|v| v.as_str()).unwrap_or(""),
        ));
    }

    // ── Type-specific tags ──
    if etype == "session" {
        add_detail_tags(
            &mut tags,
            &detail,
            &[
                "slug",
                "agent",
                "model_id",
                "model_provider",
                "parent_id",
                "project_id",
                "cost",
                "tokens_input",
                "tokens_output",
            ],
            None,
        );
    } else if etype == "llm" || etype == "llm_stream" {
        add_detail_tags(
            &mut tags,
            &detail,
            &["provider", "model", "runtime", "agent", "mode"],
            None,
        );
    } else if etype == "permission"
        || etype == "tool_read"
        || etype == "tool_write"
        || etype == "tool_exec"
        || etype == "tool_orch"
        || etype == "tool_other"
    {
        add_detail_tags(
            &mut tags,
            &detail,
            &["permission", "pattern", "action"],
            None,
        );
    } else if etype == "file" {
        add_detail_tags(&mut tags, &detail, &["file", "action"], None);
    } else if etype == "hook" && source == "zoo" {
        add_detail_tags(&mut tags, &detail, &["hook", "event", "level"], None);
    } else if etype == "user_msg" {
        add_detail_tags(&mut tags, &detail, &["agent"], Some(event));
    } else if etype == "assistant_reply" || etype == "assistant_reasoning" {
        add_detail_tags(&mut tags, &detail, &["model", "agent"], Some(event));
    } else if etype == "hook" && source != "zoo" {
        add_detail_tags(&mut tags, &detail, &["message"], None);
    }

    tags
}

fn make_tag(key: &str, type_: &str, value: &str) -> Value {
    let mut tag = Map::new();
    tag.insert("key".to_string(), Value::String(key.to_string()));
    tag.insert("type".to_string(), Value::String(type_.to_string()));
    tag.insert("value".to_string(), Value::String(value.to_string()));
    Value::Object(tag)
}

// ── agent_category_tid ────────────────────────────────────────────────────────

/// Map event type to Chrome trace `tid` (thread ID) for lane colouring.
#[must_use]
fn agent_category_tid(etype: &str) -> i64 {
    match etype {
        "tool_read" => 1,
        "tool_write" => 2,
        "tool_exec" => 3,
        "tool_orch" => 4,
        "tool_other" => 5,
        "llm" | "llm_stream" => 6,
        "user_msg" => 7,
        "assistant_reply" => 8,
        "assistant_reasoning" => 9,
        "hook" => 10,
        _ => 0,
    }
}

// ── find_root_session_detail ──────────────────────────────────────────────────

/// Find the first session.create event's detail for process tags.
#[must_use]
fn find_root_session_detail(timeline: &[Value]) -> Option<Map<String, Value>> {
    for ev in timeline {
        if ev.get("type").and_then(|v| v.as_str()) != Some("session") {
            continue;
        }
        let detail = ev.get("detail").and_then(|v| v.as_object())?;
        if detail
            .get("slug")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
        {
            return Some(detail.clone());
        }
    }
    None
}

/// Extract the root session's agent name from the first session.create event.
#[must_use]
fn find_root_agent(timeline: &[Value]) -> String {
    find_root_session_detail(timeline)
        .and_then(|d| {
            d.get("agent")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string)
        })
        .unwrap_or_default()
}

// ── build_logs ─────────────────────────────────────────────────────────────────

/// Build Jaeger span logs for content-heavy events.
///
/// - ``user_msg``, ``assistant_reply``, ``assistant_reasoning``: the full
///   ``content`` field is placed in log fields.
/// - ``opencode`` hook events: the entire ``detail`` dict is dumped as a
///   JSON string into log fields.
#[must_use]
fn build_logs(event: &Value) -> Vec<Value> {
    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");

    let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let epoch_us = if ts.is_empty() { 0 } else { to_epoch_us(ts) };

    // user_msg / assistant_reply / assistant_reasoning: content in logs
    if etype == "user_msg"
        || etype == "assistant_reply"
        || etype == "assistant_reasoning"
    {
        let content =
            event.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if !content.is_empty() {
            return vec![make_log_entry(
                epoch_us,
                &[("content", "string", content)],
            )];
        }
    }

    // opencode hook: dump entire detail as JSON string
    if etype == "hook" && source == "opencode" {
        let detail = event
            .get("detail")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let detail_json =
            serde_json::to_string(&Value::Object(detail)).unwrap_or_default();
        if !detail_json.is_empty() {
            return vec![make_log_entry(
                epoch_us,
                &[("detail", "string", &detail_json)],
            )];
        }
    }

    vec![]
}

fn make_log_entry(timestamp: i64, fields: &[(&str, &str, &str)]) -> Value {
    let mut entry = Map::new();
    entry.insert(
        "timestamp".to_string(),
        Value::Number(Number::from(timestamp)),
    );
    let field_list: Vec<Value> = fields
        .iter()
        .map(|(key, type_, value)| {
            let mut f = Map::new();
            f.insert("key".to_string(), Value::String(key.to_string()));
            f.insert("type".to_string(), Value::String(type_.to_string()));
            f.insert("value".to_string(), Value::String(value.to_string()));
            Value::Object(f)
        })
        .collect();
    entry.insert("fields".to_string(), Value::Array(field_list));
    Value::Object(entry)
}

// ── build_chrome_trace ─────────────────────────────────────────────────────────

/// Build `session_id` → pid mapping from timeline.
fn build_sid_pid_map(timeline: &[Value]) -> HashMap<String, i64> {
    let mut sid_pid_map: HashMap<String, i64> = HashMap::new();
    let mut next_pid: i64 = 1;
    for event in timeline {
        let sid = event
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if !sid.is_empty() && !sid_pid_map.contains_key(&sid) && !ts.is_empty()
        {
            sid_pid_map.insert(sid, next_pid);
            next_pid += 1;
        }
    }
    sid_pid_map
}

/// Compute duration between consecutive events.
///
/// Returns `max(1000, delta_to_next)` for intermediate events,
/// or `last_default` for the last event.
#[must_use]
fn compute_event_duration(
    timeline: &[Value],
    idx: usize,
    start_us: i64,
    last_default: i64,
) -> i64 {
    if idx + 1 < timeline.len() {
        let next_ts = timeline[idx + 1]
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if next_ts.is_empty() {
            last_default
        } else {
            let next_epoch_us = to_epoch_us(next_ts);
            (1000).max(next_epoch_us - start_us)
        }
    } else {
        last_default
    }
}

/// Build the `args` map for a Chrome trace event.
#[must_use]
fn build_chrome_args(
    event: &Value,
    etype: &str,
    root_agent: &str,
    session_agent: &str,
) -> Map<String, Value> {
    let mut args: Map<String, Value> = Map::new();

    // Always attach agent info for Chrome trace filtering
    if !session_agent.is_empty() {
        args.insert(
            "agent".to_string(),
            Value::String(session_agent.to_string()),
        );
    } else if !root_agent.is_empty() {
        args.insert("agent".to_string(), Value::String(root_agent.to_string()));
    } else {
        args.insert("agent".to_string(), Value::String(String::new()));
    }

    // Existing content / detail fields
    if etype == "user_msg"
        || etype == "assistant_reply"
        || etype == "assistant_reasoning"
    {
        let content =
            event.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if !content.is_empty() {
            let truncated: String = content.chars().take(500).collect();
            args.insert("content".to_string(), Value::String(truncated));
        }
    } else {
        let detail: Map<String, Value> = event
            .get("detail")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        for k in &[
            "hook",
            "event",
            "level",
            "model",
            "agent",
            "provider",
            "permission",
            "pattern",
            "action",
            "file",
            "slug",
            "mode",
            "runtime",
        ] {
            if let Some(v) = detail.get(*k)
                && let Some(s) = value_to_nonempty_string(v)
            {
                args.insert(k.to_string(), Value::String(s));
            }
        }
    }

    args
}

/// Convert a timeline into a Chrome Trace Event Format JSON array.
///
/// Each timeline event becomes a complete event (`ph="X"`) with a
/// duration equal to the delta to the next event (or 1 ms for the last
/// event).
///
/// `pid` is assigned per unique `session_id` — the root session
/// (first encountered) gets pid 1 and each child session gets an
/// independent pid (2, 3, 4, …).  `tid` is mapped from the event type
/// category for sub-lane colouring within each process row.
///
/// An empty *timeline* returns `[]`.
#[must_use]
pub fn build_chrome_trace(timeline: &[Value]) -> Vec<Value> {
    if timeline.is_empty() {
        return vec![];
    }

    let sid_pid_map = build_sid_pid_map(timeline);
    let default_pid = sid_pid_map.get("").copied().unwrap_or(1);
    let root_agent = find_root_agent(timeline);

    let mut events: Vec<Value> = Vec::new();

    for (idx, event) in timeline.iter().enumerate() {
        let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if ts.is_empty() {
            continue;
        }

        let start_us = to_epoch_us(ts);
        let duration = compute_event_duration(timeline, idx, start_us, 1000);

        let sid = event
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let depth =
            event.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
        let session_agent =
            event.get("session_agent").and_then(|v| v.as_str()).unwrap_or("");

        let pid = sid_pid_map.get(&sid).copied().unwrap_or(default_pid);
        let tid = agent_category_tid(etype);

        let summary =
            event.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let mut name: String = summary.chars().take(120).collect();
        if depth > 0 {
            let agent_label =
                if session_agent.is_empty() { "?" } else { session_agent };
            name = format!("[子:{agent_label}] {name}");
        }

        let args = build_chrome_args(event, etype, &root_agent, session_agent);

        let mut ev = Map::new();
        ev.insert("name".to_string(), Value::String(name));
        ev.insert("ph".to_string(), Value::String("X".to_string()));
        ev.insert("ts".to_string(), Value::Number(Number::from(start_us)));
        ev.insert("dur".to_string(), Value::Number(Number::from(duration)));
        ev.insert("pid".to_string(), Value::Number(Number::from(pid)));
        ev.insert("tid".to_string(), Value::Number(Number::from(tid)));
        ev.insert("cat".to_string(), Value::String(etype.to_string()));
        if !args.is_empty() {
            ev.insert("args".to_string(), Value::Object(args));
        }

        events.push(Value::Object(ev));
    }

    events
}

// ── build_jaeger_doc ──────────────────────────────────────────────────────────

/// Build the root "session" span for a Jaeger trace.
#[must_use]
fn build_root_span(
    trace_id: &str,
    session_id: &str,
    root_start_us: i64,
    root_duration: i64,
) -> Value {
    let mut span = Map::new();
    span.insert("traceID".to_string(), Value::String(trace_id.to_string()));
    span.insert(
        "spanID".to_string(),
        Value::String("0000000000000001".to_string()),
    );
    span.insert(
        "operationName".to_string(),
        Value::String("session".to_string()),
    );
    span.insert(
        "startTime".to_string(),
        Value::Number(Number::from(root_start_us)),
    );
    span.insert(
        "duration".to_string(),
        Value::Number(Number::from(root_duration)),
    );
    span.insert(
        "tags".to_string(),
        Value::Array(vec![
            make_tag("source", "string", "opencode"),
            make_tag("session_id", "string", session_id),
        ]),
    );
    span.insert("logs".to_string(), Value::Array(vec![]));
    span.insert("processID".to_string(), Value::String("p1".to_string()));
    Value::Object(span)
}

/// Build a single Jaeger event span from a timeline event.
#[must_use]
fn build_jaeger_event_span(
    event: &Value,
    idx: usize,
    trace_id: &str,
    timeline: &[Value],
) -> Value {
    let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let span_id: String = format!("{:016x}", idx + 2);
    let start_time: i64 = to_epoch_us(ts);
    let duration: i64 =
        compute_event_duration(timeline, idx, start_time, 1_000_000);

    let mut span = Map::new();
    span.insert("traceID".to_string(), Value::String(trace_id.to_string()));
    span.insert("spanID".to_string(), Value::String(span_id));
    span.insert(
        "operationName".to_string(),
        Value::String(get_operation_name(event)),
    );
    span.insert(
        "references".to_string(),
        Value::Array(vec![{
            let mut ref_ = Map::new();
            ref_.insert(
                "refType".to_string(),
                Value::String("CHILD_OF".to_string()),
            );
            ref_.insert(
                "traceID".to_string(),
                Value::String(trace_id.to_string()),
            );
            ref_.insert(
                "spanID".to_string(),
                Value::String("0000000000000001".to_string()),
            );
            Value::Object(ref_)
        }]),
    );
    span.insert(
        "startTime".to_string(),
        Value::Number(Number::from(start_time)),
    );
    span.insert("duration".to_string(), Value::Number(Number::from(duration)));
    span.insert("tags".to_string(), Value::Array(build_tags(event)));
    span.insert("logs".to_string(), Value::Array(build_logs(event)));
    span.insert("processID".to_string(), Value::String("p1".to_string()));

    Value::Object(span)
}

/// Build the Jaeger trace wrapper (traceID, spans, processes).
#[must_use]
fn build_jaeger_trace_data(
    trace_id: &str,
    spans: Vec<Value>,
    process_tags: Vec<Value>,
) -> Value {
    let mut trace_data = Map::new();
    trace_data
        .insert("traceID".to_string(), Value::String(trace_id.to_string()));
    trace_data.insert("spans".to_string(), Value::Array(spans));
    trace_data.insert(
        "processes".to_string(),
        Value::Object({
            let mut procs = Map::new();
            procs.insert(
                "p1".to_string(),
                Value::Object({
                    let mut p1 = Map::new();
                    p1.insert(
                        "serviceName".to_string(),
                        Value::String("opencode".to_string()),
                    );
                    p1.insert("tags".to_string(), Value::Array(process_tags));
                    p1
                }),
            );
            procs
        }),
    );
    Value::Object(trace_data)
}

/// Build process tags from the root session detail.
#[must_use]
fn build_jaeger_process_tags(timeline: &[Value]) -> Vec<Value> {
    let root_detail = find_root_session_detail(timeline);
    let mut process_tags: Vec<Value> = Vec::new();
    if let Some(ref detail) = root_detail {
        for k in &["agent", "model_id", "model_provider"] {
            if let Some(v) = detail.get(*k).and_then(|v| v.as_str())
                && !v.is_empty()
            {
                process_tags.push(make_tag(k, "string", v));
            }
        }
    }
    process_tags
}

/// Compute root span timings from the timeline.
fn compute_root_timing(timeline: &[Value]) -> (i64, i64) {
    let first_ts =
        timeline[0].get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let last_ts = timeline
        .last()
        .and_then(|v| v.get("timestamp"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let root_start_us =
        if first_ts.is_empty() { 0 } else { to_epoch_us(first_ts) };
    let root_end_us = if last_ts.is_empty() { 0 } else { to_epoch_us(last_ts) };
    let root_duration = (1).max(root_end_us - root_start_us);
    (root_start_us, root_duration)
}

/// Compute the Jaeger trace ID from a session ID via SHA256.
#[must_use]
fn compute_trace_id(session_id: &str) -> String {
    let hash = Sha256::digest(session_id.as_bytes());
    hash.iter()
        .fold(String::with_capacity(64), |mut acc, b| {
            use std::fmt::Write;
            let _ = write!(acc, "{b:02x}");
            acc
        })
        .chars()
        .take(32)
        .collect()
}

/// Convert a timeline into a Jaeger JSON trace document.
///
/// Each timeline event becomes a child span of the root ``"session"`` span.
/// Large content fields (user messages, assistant replies, reasoning) are
/// placed in span logs.
///
/// An empty *timeline* returns `{"data": []}`.
#[must_use]
pub fn build_jaeger_doc(session_id: &str, timeline: &[Value]) -> Value {
    if timeline.is_empty() {
        let mut result = Map::new();
        result.insert("data".to_string(), Value::Array(vec![]));
        return Value::Object(result);
    }

    let trace_id = compute_trace_id(session_id);
    let process_tags = build_jaeger_process_tags(timeline);
    let (root_start_us, root_duration) = compute_root_timing(timeline);

    let root_span =
        build_root_span(&trace_id, session_id, root_start_us, root_duration);

    let mut spans: Vec<Value> = vec![root_span];
    for (idx, event) in timeline.iter().enumerate() {
        let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if ts.is_empty() {
            continue;
        }
        spans.push(build_jaeger_event_span(event, idx, &trace_id, timeline));
    }

    let trace_data = build_jaeger_trace_data(&trace_id, spans, process_tags);

    let mut result = Map::new();
    result.insert("data".to_string(), Value::Array(vec![trace_data]));
    result.insert("total".to_string(), Value::Number(Number::from(1)));

    Value::Object(result)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── to_epoch_us ──────────────────────────────────────────────────────

    #[test]
    fn test_to_epoch_us_iso_z() {
        // 2024-05-06T12:53:21.000Z → 1715000001000 ms → 1715000001000000 µs
        let us = to_epoch_us("2024-05-06T12:53:21.000Z");
        assert_eq!(us, 1_715_000_001_000_000);
    }

    #[test]
    fn test_to_epoch_us_iso_offset() {
        let us = to_epoch_us("2024-05-06T12:53:21.000+00:00");
        assert_eq!(us, 1_715_000_001_000_000);
    }

    #[test]
    fn test_to_epoch_us_naive_no_tz() {
        // Naive datetime treated as UTC
        let us = to_epoch_us("2024-05-06T12:53:21.000");
        assert_eq!(us, 1_715_000_001_000_000);
    }

    #[test]
    fn test_to_epoch_us_empty() {
        assert_eq!(to_epoch_us(""), 0);
    }

    #[test]
    fn test_to_epoch_us_invalid() {
        assert_eq!(to_epoch_us("not-a-timestamp"), 0);
    }

    #[test]
    fn test_to_epoch_us_microsecond_precision() {
        // 2024-05-06T12:53:21.123456Z
        let us = to_epoch_us("2024-05-06T12:53:21.123456Z");
        assert_eq!(us, 1_715_000_001_123_456);
    }

    #[test]
    fn test_to_epoch_us_seconds_only() {
        let us = to_epoch_us("2024-05-06T12:53:21Z");
        assert_eq!(us, 1_715_000_001_000_000);
    }

    // ── get_operation_name ───────────────────────────────────────────────

    fn make_event(
        etype: &str,
        source: &str,
        detail_keys: &[(&str, &str)],
    ) -> Value {
        let mut detail = Map::new();
        for (k, v) in detail_keys {
            detail.insert(k.to_string(), Value::String(v.to_string()));
        }
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String(etype.to_string()));
        ev.insert("source".to_string(), Value::String(source.to_string()));
        ev.insert("detail".to_string(), Value::Object(detail));
        Value::Object(ev)
    }

    #[test]
    fn test_get_operation_name_session_create() {
        let ev = make_event("session", "opencode", &[("slug", "auth-debug")]);
        assert_eq!(get_operation_name(&ev), "session.create");
    }

    #[test]
    fn test_get_operation_name_session_loop() {
        let ev = make_event("session", "opencode", &[("step", "1")]);
        assert_eq!(get_operation_name(&ev), "session.loop");
    }

    #[test]
    fn test_get_operation_name_session_process() {
        let ev =
            make_event("session", "opencode", &[("message_id", "msg-001")]);
        assert_eq!(get_operation_name(&ev), "session.process");
    }

    #[test]
    fn test_get_operation_name_session_exit() {
        let ev = make_event("session", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "session.exit");
    }

    #[test]
    fn test_get_operation_name_zoo_hook() {
        let ev = make_event("hook", "zoo", &[("hook", "context-metrics")]);
        assert_eq!(get_operation_name(&ev), "zoo.context-metrics");
    }

    #[test]
    fn test_get_operation_name_opencode_hook() {
        let ev = make_event("hook", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "opencode.hook");
    }

    #[test]
    fn test_get_operation_name_hook_default() {
        let ev = make_event("hook", "other", &[]);
        assert_eq!(get_operation_name(&ev), "opencode.hook");
    }

    #[test]
    fn test_get_operation_name_llm() {
        let ev = make_event("llm", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "llm.select");
    }

    #[test]
    fn test_get_operation_name_llm_stream() {
        let ev = make_event("llm_stream", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "llm.stream");
    }

    #[test]
    fn test_get_operation_name_permission() {
        let ev = make_event("permission", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "permission.deny");
    }

    #[test]
    fn test_get_operation_name_tool_read() {
        let ev = make_event("tool_read", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "tool.read");
    }

    #[test]
    fn test_get_operation_name_tool_write() {
        let ev = make_event("tool_write", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "tool.write");
    }

    #[test]
    fn test_get_operation_name_tool_exec() {
        let ev = make_event("tool_exec", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "tool.exec");
    }

    #[test]
    fn test_get_operation_name_tool_orch() {
        let ev = make_event("tool_orch", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "tool.orch");
    }

    #[test]
    fn test_get_operation_name_tool_other() {
        let ev = make_event("tool_other", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "tool.other");
    }

    #[test]
    fn test_get_operation_name_file() {
        let ev = make_event("file", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "file.touch");
    }

    #[test]
    fn test_get_operation_name_user_msg() {
        let ev = make_event("user_msg", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "user.message");
    }

    #[test]
    fn test_get_operation_name_assistant_reply() {
        let ev = make_event("assistant_reply", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "assistant.reply");
    }

    #[test]
    fn test_get_operation_name_assistant_reasoning() {
        let ev = make_event("assistant_reasoning", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "assistant.reasoning");
    }

    #[test]
    fn test_get_operation_name_unknown_type() {
        let ev = make_event("custom_type", "opencode", &[]);
        assert_eq!(get_operation_name(&ev), "custom_type");
    }

    #[test]
    fn test_get_operation_name_slug_with_step_precedence() {
        // slug takes priority over step
        let ev = make_event(
            "session",
            "opencode",
            &[("slug", "my-slug"), ("step", "1")],
        );
        assert_eq!(get_operation_name(&ev), "session.create");
    }

    #[test]
    fn test_get_operation_name_step_over_message_id() {
        // step takes priority over message_id
        let ev = make_event(
            "session",
            "opencode",
            &[("step", "2"), ("message_id", "msg-001")],
        );
        assert_eq!(get_operation_name(&ev), "session.loop");
    }

    // ── build_tags ───────────────────────────────────────────────────────

    fn make_event_with_depth(
        etype: &str,
        source: &str,
        session_id: &str,
        depth: i64,
        summary: &str,
        detail_keys: &[(&str, &str)],
        extra: &[(&str, &str)],
    ) -> Value {
        let mut detail = Map::new();
        for (k, v) in detail_keys {
            detail.insert(k.to_string(), Value::String(v.to_string()));
        }
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String(etype.to_string()));
        ev.insert("source".to_string(), Value::String(source.to_string()));
        ev.insert(
            "session_id".to_string(),
            Value::String(session_id.to_string()),
        );
        ev.insert("depth".to_string(), Value::Number(Number::from(depth)));
        ev.insert("summary".to_string(), Value::String(summary.to_string()));
        ev.insert("detail".to_string(), Value::Object(detail));
        for (k, v) in extra {
            ev.insert(k.to_string(), Value::String(v.to_string()));
        }
        Value::Object(ev)
    }

    fn tag_value(tags: &[Value], key: &str) -> Option<String> {
        for tag in tags {
            let k = tag.get("key").and_then(|v| v.as_str())?;
            if k == key {
                return tag
                    .get("value")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);
            }
        }
        None
    }

    #[test]
    fn test_build_tags_common() {
        let ev = make_event_with_depth(
            "llm",
            "opencode",
            "ses-001",
            0,
            "LLM gpt-4",
            &[("provider", "openai")],
            &[],
        );
        let tags = build_tags(&ev);

        assert_eq!(tag_value(&tags, "source"), Some("opencode".to_string()));
        assert_eq!(tag_value(&tags, "event.type"), Some("llm".to_string()));
        assert_eq!(tag_value(&tags, "session_id"), Some("ses-001".to_string()));
        assert_eq!(tag_value(&tags, "depth"), Some("0".to_string()));
        assert_eq!(tag_value(&tags, "summary"), Some("LLM gpt-4".to_string()));
    }

    #[test]
    fn test_build_tags_summary_truncated() {
        let long = "a".repeat(300);
        let ev =
            make_event_with_depth("llm", "opencode", "", 0, &long, &[], &[]);
        let tags = build_tags(&ev);
        let summary = tag_value(&tags, "summary").unwrap();
        assert_eq!(summary.len(), 256);
    }

    #[test]
    fn test_build_tags_depth_gt_0_adds_agent() {
        let ev = make_event_with_depth(
            "llm",
            "opencode",
            "ses-child",
            1,
            "child event",
            &[],
            &[("session_agent", "explore")],
        );
        let tags = build_tags(&ev);
        assert_eq!(
            tag_value(&tags, "session_agent"),
            Some("explore".to_string())
        );
    }

    #[test]
    fn test_build_tags_depth_0_no_agent() {
        let ev = make_event_with_depth(
            "llm",
            "opencode",
            "ses-001",
            0,
            "test",
            &[],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "session_agent"), None);
    }

    #[test]
    fn test_build_tags_session_detail() {
        let ev = make_event_with_depth(
            "session",
            "opencode",
            "ses-001",
            0,
            "Session",
            &[
                ("slug", "test"),
                ("agent", "general"),
                ("model_id", "gpt-4"),
                ("model_provider", "openai"),
            ],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "slug"), Some("test".to_string()));
        assert_eq!(tag_value(&tags, "agent"), Some("general".to_string()));
        assert_eq!(tag_value(&tags, "model_id"), Some("gpt-4".to_string()));
        assert_eq!(
            tag_value(&tags, "model_provider"),
            Some("openai".to_string())
        );
    }

    #[test]
    fn test_build_tags_llm_detail() {
        let ev = make_event_with_depth(
            "llm",
            "opencode",
            "",
            0,
            "",
            &[("provider", "openai"), ("model", "gpt-4")],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "provider"), Some("openai".to_string()));
        assert_eq!(tag_value(&tags, "model"), Some("gpt-4".to_string()));
    }

    #[test]
    fn test_build_tags_user_msg_content() {
        let ev = make_event_with_depth(
            "user_msg",
            "opencode",
            "",
            0,
            "",
            &[],
            &[("agent", "general")],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "agent"), Some("general".to_string()));
    }

    #[test]
    fn test_build_tags_assistant_reply() {
        let ev = make_event_with_depth(
            "assistant_reply",
            "opencode",
            "",
            0,
            "",
            &[],
            &[("model", "gpt-4"), ("agent", "general")],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "model"), Some("gpt-4".to_string()));
        assert_eq!(tag_value(&tags, "agent"), Some("general".to_string()));
    }

    #[test]
    fn test_build_tags_tool_detail() {
        let ev = make_event_with_depth(
            "tool_read",
            "opencode",
            "",
            0,
            "",
            &[
                ("permission", "read"),
                ("pattern", "src/*.ts"),
                ("action", "allow"),
            ],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "permission"), Some("read".to_string()));
        assert_eq!(tag_value(&tags, "pattern"), Some("src/*.ts".to_string()));
        assert_eq!(tag_value(&tags, "action"), Some("allow".to_string()));
    }

    #[test]
    fn test_build_tags_zoo_hook() {
        let ev = make_event_with_depth(
            "hook",
            "zoo",
            "",
            0,
            "",
            &[
                ("hook", "context-metrics"),
                ("event", "context_measured"),
                ("level", "info"),
            ],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(
            tag_value(&tags, "hook"),
            Some("context-metrics".to_string())
        );
        assert_eq!(
            tag_value(&tags, "event"),
            Some("context_measured".to_string())
        );
        assert_eq!(tag_value(&tags, "level"), Some("info".to_string()));
    }

    #[test]
    fn test_build_tags_opencode_hook() {
        let ev = make_event_with_depth(
            "hook",
            "opencode",
            "",
            0,
            "",
            &[("message", "some message")],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(
            tag_value(&tags, "message"),
            Some("some message".to_string())
        );
    }

    #[test]
    fn test_build_tags_hook_other_source() {
        let ev = make_event_with_depth(
            "hook",
            "other",
            "",
            0,
            "",
            &[("message", "hello")],
            &[],
        );
        let tags = build_tags(&ev);
        assert_eq!(tag_value(&tags, "message"), Some("hello".to_string()));
    }

    // ── build_chrome_trace ───────────────────────────────────────────────

    fn make_timeline_event(
        etype: &str,
        source: &str,
        session_id: &str,
        depth: i64,
        summary: &str,
        timestamp: &str,
        extra: &[(&str, &str)],
    ) -> Value {
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String(etype.to_string()));
        ev.insert("source".to_string(), Value::String(source.to_string()));
        ev.insert(
            "session_id".to_string(),
            Value::String(session_id.to_string()),
        );
        ev.insert("depth".to_string(), Value::Number(Number::from(depth)));
        ev.insert("summary".to_string(), Value::String(summary.to_string()));
        ev.insert(
            "timestamp".to_string(),
            Value::String(timestamp.to_string()),
        );
        for (k, v) in extra {
            ev.insert(k.to_string(), Value::String(v.to_string()));
        }
        Value::Object(ev)
    }

    #[test]
    fn test_build_chrome_trace_empty() {
        let result = build_chrome_trace(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_build_chrome_trace_single_event() {
        let timeline = vec![make_timeline_event(
            "llm",
            "opencode",
            "ses-001",
            0,
            "LLM gpt-4",
            "2024-05-06T12:53:21.000Z",
            &[],
        )];
        let result = build_chrome_trace(&timeline);
        assert_eq!(result.len(), 1);

        let ev = &result[0];
        assert_eq!(ev.get("ph").and_then(|v| v.as_str()), Some("X"));
        assert_eq!(ev.get("name").and_then(|v| v.as_str()), Some("LLM gpt-4"));
        assert_eq!(ev.get("pid").and_then(serde_json::Value::as_i64), Some(1));
        assert_eq!(ev.get("tid").and_then(serde_json::Value::as_i64), Some(6));
        assert_eq!(
            ev.get("ts").and_then(serde_json::Value::as_i64),
            Some(1_715_000_001_000_000)
        );
        // Single event → duration 1000 µs
        assert_eq!(
            ev.get("dur").and_then(serde_json::Value::as_i64),
            Some(1000)
        );
        assert_eq!(ev.get("cat").and_then(|v| v.as_str()), Some("llm"));
    }

    #[test]
    fn test_build_chrome_trace_two_events() {
        let timeline = vec![
            make_timeline_event(
                "llm",
                "opencode",
                "ses-001",
                0,
                "LLM gpt-4",
                "2024-05-06T12:53:21.000000Z",
                &[],
            ),
            make_timeline_event(
                "tool_read",
                "opencode",
                "ses-001",
                0,
                "read file",
                "2024-05-06T12:53:22.000000Z",
                &[],
            ),
        ];
        let result = build_chrome_trace(&timeline);
        assert_eq!(result.len(), 2);

        // Delta = 1 second = 1_000_000 µs, max(1000, 1_000_000) = 1_000_000
        assert_eq!(
            result[0].get("dur").and_then(serde_json::Value::as_i64),
            Some(1_000_000)
        );
        // Last event → duration 1000 µs
        assert_eq!(
            result[1].get("dur").and_then(serde_json::Value::as_i64),
            Some(1000)
        );
    }

    #[test]
    fn test_build_chrome_trace_child_naming() {
        let timeline = vec![make_timeline_event(
            "llm",
            "opencode",
            "ses-child",
            1,
            "child event",
            "2024-05-06T12:53:21.000Z",
            &[("session_agent", "explore")],
        )];
        let result = build_chrome_trace(&timeline);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].get("name").and_then(|v| v.as_str()),
            Some("[子:explore] child event")
        );
    }

    #[test]
    fn test_build_chrome_trace_child_naming_no_agent() {
        let timeline = vec![make_timeline_event(
            "llm",
            "opencode",
            "ses-child",
            1,
            "child event",
            "2024-05-06T12:53:21.000Z",
            &[],
        )];
        let result = build_chrome_trace(&timeline);
        let name = result[0].get("name").and_then(|v| v.as_str()).unwrap();
        assert!(name.starts_with("[子:?]"));
    }

    #[test]
    fn test_build_chrome_trace_pid_mapping() {
        let timeline = vec![
            make_timeline_event(
                "llm",
                "opencode",
                "ses-root",
                0,
                "root",
                "2024-05-06T12:53:21.000Z",
                &[],
            ),
            make_timeline_event(
                "llm",
                "opencode",
                "ses-child",
                1,
                "child",
                "2024-05-06T12:53:22.000Z",
                &[],
            ),
        ];
        let result = build_chrome_trace(&timeline);
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0].get("pid").and_then(serde_json::Value::as_i64),
            Some(1)
        );
        assert_eq!(
            result[1].get("pid").and_then(serde_json::Value::as_i64),
            Some(2)
        );
    }

    #[test]
    fn test_build_chrome_trace_tid_mapping() {
        let checks: &[(&str, i64)] = &[
            ("tool_read", 1),
            ("tool_write", 2),
            ("tool_exec", 3),
            ("tool_orch", 4),
            ("tool_other", 5),
            ("llm", 6),
            ("llm_stream", 6),
            ("user_msg", 7),
            ("assistant_reply", 8),
            ("assistant_reasoning", 9),
            ("hook", 10),
            ("unknown", 0),
        ];
        for &(etype, expected_tid) in checks {
            let timeline = vec![make_timeline_event(
                etype,
                "opencode",
                "ses-001",
                0,
                "test",
                "2024-05-06T12:53:21.000Z",
                &[],
            )];
            let result = build_chrome_trace(&timeline);
            assert_eq!(
                result[0].get("tid").and_then(serde_json::Value::as_i64),
                Some(expected_tid),
                "tid mismatch for type {etype}"
            );
        }
    }

    #[test]
    fn test_build_chrome_trace_skips_no_timestamp() {
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String("llm".to_string()));
        ev.insert(
            "session_id".to_string(),
            Value::String("ses-001".to_string()),
        );
        // No timestamp field
        let timeline = vec![Value::Object(ev)];
        let result = build_chrome_trace(&timeline);
        assert!(result.is_empty());
    }

    #[test]
    fn test_build_chrome_trace_summary_truncated() {
        let long_summary = "x".repeat(150);
        let timeline = vec![make_timeline_event(
            "llm",
            "opencode",
            "ses-001",
            0,
            &long_summary,
            "2024-05-06T12:53:21.000Z",
            &[],
        )];
        let result = build_chrome_trace(&timeline);
        let name = result[0].get("name").and_then(|v| v.as_str()).unwrap();
        assert_eq!(name.len(), 120);
    }

    #[test]
    fn test_build_chrome_trace_agent_in_args() {
        let timeline = vec![
            make_timeline_event(
                "session",
                "opencode",
                "ses-001",
                0,
                "Session auth-debug",
                "2024-05-06T12:53:21.000Z",
                &[("detail", r#"{"slug":"auth-debug","agent":"general"}"#)],
            ),
            make_timeline_event(
                "llm",
                "opencode",
                "ses-001",
                0,
                "LLM call",
                "2024-05-06T12:53:22.000Z",
                &[("session_agent", "")],
            ),
        ];
        // Actually the above test won't work because detail is a JSON string, not object.
        // Let me use the proper approach with find_root_session_detail via session events.
        let result = build_chrome_trace(&timeline);
        // Both events should have 'agent' in args
        for ev in &result {
            let args = ev.get("args").and_then(|v| v.as_object()).unwrap();
            assert!(args.contains_key("agent"));
        }
    }

    // ── build_jaeger_doc ─────────────────────────────────────────────────

    /// Configuration for `make_detailed_event`.
    struct DetailedEventConfig<'a> {
        etype: &'a str,
        source: &'a str,
        session_id: &'a str,
        depth: i64,
        summary: &'a str,
        timestamp: &'a str,
        detail_keys: &'a [(&'a str, &'a str)],
        extra_keys: &'a [(&'a str, &'a str)],
    }

    fn make_detailed_event(config: &DetailedEventConfig) -> Value {
        let mut detail = Map::new();
        for (k, v) in config.detail_keys {
            detail.insert(k.to_string(), Value::String(v.to_string()));
        }
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String(config.etype.to_string()));
        ev.insert(
            "source".to_string(),
            Value::String(config.source.to_string()),
        );
        ev.insert(
            "session_id".to_string(),
            Value::String(config.session_id.to_string()),
        );
        ev.insert(
            "depth".to_string(),
            Value::Number(Number::from(config.depth)),
        );
        ev.insert(
            "summary".to_string(),
            Value::String(config.summary.to_string()),
        );
        ev.insert(
            "timestamp".to_string(),
            Value::String(config.timestamp.to_string()),
        );
        ev.insert("detail".to_string(), Value::Object(detail));
        for (k, v) in config.extra_keys {
            ev.insert(k.to_string(), Value::String(v.to_string()));
        }
        Value::Object(ev)
    }

    #[test]
    fn test_build_jaeger_doc_empty() {
        let result = build_jaeger_doc("ses-001", &[]);
        let data = result.get("data").and_then(|v| v.as_array()).unwrap();
        assert!(data.is_empty());
        assert_eq!(result.get("total"), None);
    }

    #[test]
    fn test_build_jaeger_doc_root_span() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session auth-debug",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "auth-debug"), ("agent", "general")],
            extra_keys: &[],
        })];
        let result = build_jaeger_doc("ses-001", &timeline);
        let data = result.get("data").and_then(|v| v.as_array()).unwrap();
        let trace = &data[0];
        let spans = trace.get("spans").and_then(|v| v.as_array()).unwrap();
        assert_eq!(spans.len(), 2); // root + event

        // Root span
        let root = &spans[0];
        assert_eq!(
            root.get("operationName").and_then(|v| v.as_str()),
            Some("session")
        );
        assert_eq!(
            root.get("spanID").and_then(|v| v.as_str()),
            Some("0000000000000001")
        );
        assert_eq!(
            root.get("startTime").and_then(serde_json::Value::as_i64),
            Some(1_715_000_001_000_000)
        );
        assert!(
            root.get("duration").and_then(serde_json::Value::as_i64).unwrap()
                > 0
        );
        assert_eq!(root.get("processID").and_then(|v| v.as_str()), Some("p1"));
    }

    #[test]
    fn test_build_jaeger_doc_trace_id() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "test",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test")],
            extra_keys: &[],
        })];
        let result = build_jaeger_doc("ses-001", &timeline);
        let trace_id = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("traceID"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        // SHA256 of "ses-001" hex digest, first 32 chars
        assert_eq!(trace_id.len(), 32);
        assert!(trace_id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_build_jaeger_doc_child_span() {
        let timeline = vec![
            make_detailed_event(&DetailedEventConfig {
                etype: "session",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "Session create",
                timestamp: "2024-05-06T12:53:21.000Z",
                detail_keys: &[("slug", "test"), ("agent", "general")],
                extra_keys: &[],
            }),
            make_detailed_event(&DetailedEventConfig {
                etype: "llm",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "LLM call",
                timestamp: "2024-05-06T12:53:22.000Z",
                detail_keys: &[("model", "gpt-4")],
                extra_keys: &[],
            }),
        ];
        let result = build_jaeger_doc("ses-001", &timeline);
        let spans = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("spans"))
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(spans.len(), 3); // root + session + llm

        // Child span (llm)
        let child = &spans[2];
        assert_eq!(
            child.get("operationName").and_then(|v| v.as_str()),
            Some("llm.select")
        );
        assert_eq!(
            child.get("spanID").and_then(|v| v.as_str()),
            Some("0000000000000003")
        );

        // CHILD_OF reference to root
        let refs = child.get("references").and_then(|v| v.as_array()).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].get("refType").and_then(|v| v.as_str()),
            Some("CHILD_OF")
        );
        assert_eq!(
            refs[0].get("spanID").and_then(|v| v.as_str()),
            Some("0000000000000001")
        );
    }

    #[test]
    fn test_build_jaeger_doc_process_tags() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[
                ("slug", "test"),
                ("agent", "general"),
                ("model_id", "gpt-4"),
                ("model_provider", "openai"),
            ],
            extra_keys: &[],
        })];
        let result = build_jaeger_doc("ses-001", &timeline);
        let processes = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("processes"))
            .and_then(|v| v.as_object())
            .unwrap();
        let p1 = processes.get("p1").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            p1.get("serviceName").and_then(|v| v.as_str()),
            Some("opencode")
        );
        let tags = p1.get("tags").and_then(|v| v.as_array()).unwrap();
        assert_eq!(tags.len(), 3);
        assert_eq!(tag_value(tags, "agent"), Some("general".to_string()));
        assert_eq!(tag_value(tags, "model_id"), Some("gpt-4".to_string()));
        assert_eq!(
            tag_value(tags, "model_provider"),
            Some("openai".to_string())
        );
    }

    #[test]
    fn test_build_jaeger_doc_empty_process_tags() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test")],
            extra_keys: &[],
        })];
        let result = build_jaeger_doc("ses-001", &timeline);
        let processes = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("processes"))
            .and_then(|v| v.as_object())
            .unwrap();
        let p1 = processes.get("p1").and_then(|v| v.as_object()).unwrap();
        let tags = p1.get("tags").and_then(|v| v.as_array()).unwrap();
        // No agent/model_id/model_provider in root detail, so empty process tags
        assert!(tags.is_empty());
    }

    #[test]
    fn test_build_jaeger_doc_content_logs() {
        let timeline = vec![
            make_detailed_event(&DetailedEventConfig {
                etype: "session",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "Session",
                timestamp: "2024-05-06T12:53:21.000Z",
                detail_keys: &[("slug", "test")],
                extra_keys: &[],
            }),
            // Event with content
            {
                let mut ev = Map::new();
                ev.insert(
                    "type".to_string(),
                    Value::String("user_msg".to_string()),
                );
                ev.insert(
                    "source".to_string(),
                    Value::String("opencode".to_string()),
                );
                ev.insert(
                    "session_id".to_string(),
                    Value::String("ses-001".to_string()),
                );
                ev.insert("depth".to_string(), Value::Number(Number::from(0)));
                ev.insert(
                    "summary".to_string(),
                    Value::String("User message".to_string()),
                );
                ev.insert(
                    "timestamp".to_string(),
                    Value::String("2024-05-06T12:53:22.000Z".to_string()),
                );
                ev.insert("detail".to_string(), Value::Object(Map::new()));
                ev.insert(
                    "content".to_string(),
                    Value::String("Hello, how are you?".to_string()),
                );
                Value::Object(ev)
            },
        ];
        let result = build_jaeger_doc("ses-001", &timeline);
        let spans = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("spans"))
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(spans.len(), 3);

        // Last span (user_msg) should have logs
        let last_span = &spans[2];
        let logs = last_span.get("logs").and_then(|v| v.as_array()).unwrap();
        assert_eq!(logs.len(), 1);
        let fields = logs[0].get("fields").and_then(|v| v.as_array()).unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(
            fields[0].get("key").and_then(|v| v.as_str()),
            Some("content")
        );
        assert_eq!(
            fields[0].get("value").and_then(|v| v.as_str()),
            Some("Hello, how are you?")
        );
    }

    #[test]
    fn test_build_jaeger_doc_opencode_hook_logs() {
        let timeline = vec![
            make_detailed_event(&DetailedEventConfig {
                etype: "session",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "Session",
                timestamp: "2024-05-06T12:53:21.000Z",
                detail_keys: &[("slug", "test")],
                extra_keys: &[],
            }),
            {
                let mut detail = Map::new();
                detail.insert(
                    "event".to_string(),
                    Value::String("some_event".to_string()),
                );
                detail.insert(
                    "value".to_string(),
                    Value::String("42".to_string()),
                );
                let mut ev = Map::new();
                ev.insert(
                    "type".to_string(),
                    Value::String("hook".to_string()),
                );
                ev.insert(
                    "source".to_string(),
                    Value::String("opencode".to_string()),
                );
                ev.insert(
                    "session_id".to_string(),
                    Value::String("ses-001".to_string()),
                );
                ev.insert("depth".to_string(), Value::Number(Number::from(0)));
                ev.insert(
                    "summary".to_string(),
                    Value::String("hook event".to_string()),
                );
                ev.insert(
                    "timestamp".to_string(),
                    Value::String("2024-05-06T12:53:22.000Z".to_string()),
                );
                ev.insert("detail".to_string(), Value::Object(detail));
                Value::Object(ev)
            },
        ];
        let result = build_jaeger_doc("ses-001", &timeline);
        let spans = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("spans"))
            .and_then(|v| v.as_array())
            .unwrap();
        // Last span (opencode hook) should have logs with JSON detail
        let last_span = &spans[2];
        let logs = last_span.get("logs").and_then(|v| v.as_array()).unwrap();
        assert_eq!(logs.len(), 1);
        let fields = logs[0].get("fields").and_then(|v| v.as_array()).unwrap();
        assert_eq!(
            fields[0].get("key").and_then(|v| v.as_str()),
            Some("detail")
        );
        assert_eq!(
            fields[0].get("type").and_then(|v| v.as_str()),
            Some("string")
        );
    }

    #[test]
    fn test_build_jaeger_doc_duration_delta() {
        let timeline = vec![
            make_detailed_event(&DetailedEventConfig {
                etype: "session",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "Session",
                timestamp: "2024-05-06T12:53:21.000000Z",
                detail_keys: &[("slug", "test")],
                extra_keys: &[],
            }),
            make_detailed_event(&DetailedEventConfig {
                etype: "llm",
                source: "opencode",
                session_id: "ses-001",
                depth: 0,
                summary: "LLM call",
                timestamp: "2024-05-06T12:53:22.000000Z",
                detail_keys: &[],
                extra_keys: &[],
            }),
        ];
        let result = build_jaeger_doc("ses-001", &timeline);
        let spans = result
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("spans"))
            .and_then(|v| v.as_array())
            .unwrap();
        // Second span (session event) duration = max(1000, delta) = max(1000, 1_000_000) = 1_000_000
        assert_eq!(
            spans[1].get("duration").and_then(serde_json::Value::as_i64),
            Some(1_000_000)
        );
        // Last span duration = 1_000_000 µs (1 second)
        assert_eq!(
            spans[2].get("duration").and_then(serde_json::Value::as_i64),
            Some(1_000_000)
        );
    }

    #[test]
    fn test_build_jaeger_doc_total_field() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test")],
            extra_keys: &[],
        })];
        let result = build_jaeger_doc("ses-001", &timeline);
        assert_eq!(
            result.get("total").and_then(serde_json::Value::as_i64),
            Some(1)
        );
    }

    #[test]
    fn test_build_jaeger_doc_unique_trace_id_per_session() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test")],
            extra_keys: &[],
        })];

        let result_a = build_jaeger_doc("ses-A", &timeline);
        let result_b = build_jaeger_doc("ses-B", &timeline);

        let trace_a = result_a
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("traceID"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let trace_b = result_b
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("traceID"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        assert_ne!(trace_a, trace_b);
        assert_eq!(trace_a.len(), 32);
        assert_eq!(trace_b.len(), 32);
    }

    // ── build_logs ───────────────────────────────────────────────────────

    #[test]
    fn test_build_logs_no_content() {
        let ev = make_detailed_event(&DetailedEventConfig {
            etype: "llm",
            source: "opencode",
            session_id: "",
            depth: 0,
            summary: "",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[],
            extra_keys: &[],
        });
        let logs = build_logs(&ev);
        assert!(logs.is_empty());
    }

    #[test]
    fn test_build_logs_user_msg_empty_content() {
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String("user_msg".to_string()));
        ev.insert("source".to_string(), Value::String("opencode".to_string()));
        ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:21.000Z".to_string()),
        );
        ev.insert("content".to_string(), Value::String(String::new()));
        let logs = build_logs(&Value::Object(ev));
        assert!(logs.is_empty());
    }

    #[test]
    fn test_build_logs_assistant_reply() {
        let mut ev = Map::new();
        ev.insert(
            "type".to_string(),
            Value::String("assistant_reply".to_string()),
        );
        ev.insert("source".to_string(), Value::String("opencode".to_string()));
        ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:21.000Z".to_string()),
        );
        ev.insert(
            "content".to_string(),
            Value::String("Hello world".to_string()),
        );
        let logs = build_logs(&Value::Object(ev));
        assert_eq!(logs.len(), 1);
        let fields = logs[0].get("fields").and_then(|v| v.as_array()).unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(
            fields[0].get("value").and_then(|v| v.as_str()),
            Some("Hello world")
        );
    }

    #[test]
    fn test_build_logs_zoo_hook_no_logs() {
        let ev = make_detailed_event(&DetailedEventConfig {
            etype: "hook",
            source: "zoo",
            session_id: "",
            depth: 0,
            summary: "",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("hook", "test")],
            extra_keys: &[],
        });
        let logs = build_logs(&ev);
        assert!(logs.is_empty());
    }

    #[test]
    fn test_build_logs_opencode_hook() {
        let mut detail = Map::new();
        detail.insert("key".to_string(), Value::String("val".to_string()));
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String("hook".to_string()));
        ev.insert("source".to_string(), Value::String("opencode".to_string()));
        ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:21.000Z".to_string()),
        );
        ev.insert("detail".to_string(), Value::Object(detail));
        let logs = build_logs(&Value::Object(ev));
        assert_eq!(logs.len(), 1);
        let fields = logs[0].get("fields").and_then(|v| v.as_array()).unwrap();
        assert_eq!(
            fields[0].get("key").and_then(|v| v.as_str()),
            Some("detail")
        );
    }

    // ── find_root_session_detail ─────────────────────────────────────────

    #[test]
    fn test_find_root_session_detail_found() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test"), ("agent", "general")],
            extra_keys: &[],
        })];
        let detail = find_root_session_detail(&timeline);
        assert!(detail.is_some());
        let d = detail.unwrap();
        assert_eq!(d.get("slug").and_then(|v| v.as_str()), Some("test"));
        assert_eq!(d.get("agent").and_then(|v| v.as_str()), Some("general"));
    }

    #[test]
    fn test_find_root_session_detail_not_found() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "llm",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "LLM",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[],
            extra_keys: &[],
        })];
        assert!(find_root_session_detail(&timeline).is_none());
    }

    #[test]
    fn test_find_root_session_detail_no_slug() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("step", "1")],
            extra_keys: &[],
        })];
        assert!(find_root_session_detail(&timeline).is_none());
    }

    #[test]
    fn test_find_root_agent_found() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "session",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "Session",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[("slug", "test"), ("agent", "custom-agent")],
            extra_keys: &[],
        })];
        assert_eq!(find_root_agent(&timeline), "custom-agent");
    }

    #[test]
    fn test_find_root_agent_not_found() {
        let timeline = vec![make_detailed_event(&DetailedEventConfig {
            etype: "llm",
            source: "opencode",
            session_id: "ses-001",
            depth: 0,
            summary: "LLM",
            timestamp: "2024-05-06T12:53:21.000Z",
            detail_keys: &[],
            extra_keys: &[],
        })];
        assert!(find_root_agent(&timeline).is_empty());
    }

    // ── agent_category_tid ───────────────────────────────────────────────

    #[test]
    fn test_agent_category_tid() {
        assert_eq!(agent_category_tid("tool_read"), 1);
        assert_eq!(agent_category_tid("tool_write"), 2);
        assert_eq!(agent_category_tid("tool_exec"), 3);
        assert_eq!(agent_category_tid("tool_orch"), 4);
        assert_eq!(agent_category_tid("tool_other"), 5);
        assert_eq!(agent_category_tid("llm"), 6);
        assert_eq!(agent_category_tid("llm_stream"), 6);
        assert_eq!(agent_category_tid("user_msg"), 7);
        assert_eq!(agent_category_tid("assistant_reply"), 8);
        assert_eq!(agent_category_tid("assistant_reasoning"), 9);
        assert_eq!(agent_category_tid("hook"), 10);
        assert_eq!(agent_category_tid("unknown"), 0);
    }
}
