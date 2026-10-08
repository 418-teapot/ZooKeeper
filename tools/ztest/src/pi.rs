//! Builders for pi session JSONL fixtures.
//!
//! The pi provider scans `<root>/sessions/<cwd-dir>/<name>.jsonl`, one
//! JSON object per line: a session header followed by message records in
//! stream order.  [`data_dir`] writes such a file tree; the other helpers
//! build the individual records.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};

/// Write one session file per `(name, lines)` pair under
/// `<root>/sessions/<cwd-dir>/<name>.jsonl`, the layout the pi provider
/// scans.
///
/// # Panics
///
/// Panics if the sessions directory or a session file cannot be created
/// (test-only — indicates broken fixture setup).
pub fn data_dir(root: &Path, sessions: &[(&str, &[String])]) {
    for (name, lines) in sessions {
        let cwd = root.join("sessions").join("--cwd--");
        fs::create_dir_all(&cwd).expect("create pi cwd dir");
        fs::write(cwd.join(format!("{name}.jsonl")), lines.join("\n"))
            .expect("write pi session file");
    }
}

/// One session file's JSONL lines: the session header (`id`, dated
/// `header_ts` in epoch milliseconds) plus `messages` in stream order.
#[must_use]
pub fn session_lines(
    id: &str,
    header_ts: i64,
    messages: &[Value],
) -> Vec<String> {
    let mut lines = vec![
        json!({
            "type": "session", "version": 3, "id": id,
            "timestamp": zutil::epoch_ms_to_iso(header_ts), "cwd": "/w",
        })
        .to_string(),
    ];
    for msg in messages {
        lines.push(msg.to_string());
    }
    lines
}

/// A pi `message` record with a user role.
#[must_use]
pub fn user_message(id: &str, ts: i64, text: &str) -> Value {
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": text}],
        },
    })
}

/// A pi `message` record with an assistant role.
///
/// `usage` becomes the record's `usage` object when `Some`, and is
/// omitted otherwise.  `tool` appends a `toolCall` content part after the
/// text part when `Some((call_id, name))`.
#[must_use]
pub fn assistant_message(
    id: &str,
    ts: i64,
    text: &str,
    usage: Option<Value>,
    tool: Option<(&str, &str)>,
) -> Value {
    let mut body = json!({
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "timestamp": ts,
    });
    if let Some(usage) = usage {
        body["usage"] = usage;
    }
    if let Some((call_id, name)) = tool {
        body["content"] = json!([
            {"type": "text", "text": text},
            {"type": "toolCall", "id": call_id, "name": name,
             "arguments": {"command": "ls"}},
        ]);
    }
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": body,
    })
}

/// A pi `message` record with a toolResult role.
#[must_use]
pub fn tool_result_message(
    id: &str,
    ts: i64,
    call_id: &str,
    name: &str,
    text: &str,
) -> Value {
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": {
            "role": "toolResult", "toolCallId": call_id, "toolName": name,
            "content": [{"type": "text", "text": text}],
            "isError": false, "timestamp": ts,
        },
    })
}
