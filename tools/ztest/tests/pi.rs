//! Contract tests for the [`ztest::pi`] session-JSONL builders.

use std::fs;

use serde_json::{Value, json};
use ztest::TestEnv;
use ztest::pi;

/// The header timestamp shared by the pi fixtures, in epoch milliseconds.
const TS: i64 = 1_715_000_000_000;

/// `TS` rendered the way `zutil::epoch_ms_to_iso` writes it.
const TS_ISO: &str = "2024-05-06T12:53:20.000000Z";

#[test]
fn session_lines_start_with_a_parsable_header() {
    let lines = pi::session_lines("s1", TS, &[]);
    assert_eq!(lines.len(), 1);
    let header: Value = serde_json::from_str(&lines[0]).expect("header JSON");
    assert_eq!(header["type"], "session");
    assert_eq!(header["version"], 3);
    assert_eq!(header["id"], "s1");
    assert_eq!(header["timestamp"], TS_ISO);
    assert_eq!(header["cwd"], "/w");
}

#[test]
fn session_lines_append_messages_in_order() {
    let lines = pi::session_lines(
        "s1",
        TS,
        &[pi::user_message("m1", TS + 1_000, "hello")],
    );
    assert_eq!(lines.len(), 2);
    let message: Value = serde_json::from_str(&lines[1]).expect("message JSON");
    assert_eq!(message["id"], "m1");
}

#[test]
fn user_message_has_a_text_content_part() {
    let msg = pi::user_message("m1", TS + 1_000, "hello");
    assert_eq!(msg["type"], "message");
    assert_eq!(msg["id"], "m1");
    assert_eq!(msg["timestamp"], "2024-05-06T12:53:21.000000Z");
    assert_eq!(msg["message"]["role"], "user");
    assert_eq!(msg["message"]["content"][0]["type"], "text");
    assert_eq!(msg["message"]["content"][0]["text"], "hello");
}

#[test]
fn assistant_message_carries_usage_only_when_given() {
    let without = pi::assistant_message("m1", TS, "hi", None, None);
    assert!(without["message"].get("usage").is_none());
    let with = pi::assistant_message(
        "m1",
        TS,
        "hi",
        Some(json!({"input": 3, "output": 4})),
        None,
    );
    assert_eq!(with["message"]["usage"]["input"], 3);
    assert_eq!(with["message"]["usage"]["output"], 4);
}

#[test]
fn assistant_message_appends_a_tool_call_part() {
    let msg = pi::assistant_message(
        "m1",
        TS,
        "calling",
        None,
        Some(("call-1", "bash")),
    );
    let content = msg["message"]["content"].as_array().expect("content array");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "toolCall");
    assert_eq!(content[1]["id"], "call-1");
    assert_eq!(content[1]["name"], "bash");
}

#[test]
fn tool_result_message_references_the_call() {
    let msg = pi::tool_result_message("m1", TS, "call-1", "bash", "done");
    assert_eq!(msg["message"]["role"], "toolResult");
    assert_eq!(msg["message"]["toolCallId"], "call-1");
    assert_eq!(msg["message"]["toolName"], "bash");
    assert_eq!(msg["message"]["content"][0]["text"], "done");
}

#[test]
fn data_dir_writes_one_parsable_jsonl_file_per_session() {
    let env = TestEnv::new();
    let lines =
        pi::session_lines("s1", TS, &[pi::user_message("m1", TS, "hi")]);
    pi::data_dir(env.pi_data(), &[("s1", &lines)]);

    let path = env.pi_data().join("sessions").join("--cwd--").join("s1.jsonl");
    let written = fs::read_to_string(&path).expect("session file");
    assert_eq!(written, lines.join("\n"));

    let parsed: Vec<Value> = written
        .lines()
        .map(|line| serde_json::from_str(line).expect("jsonl line"))
        .collect();
    assert_eq!(parsed.len(), 2);
}
