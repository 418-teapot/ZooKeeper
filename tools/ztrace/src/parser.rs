// Parser module for ZooKeeper log parsing.
//
// Maps tool IDs to (event_type, icon), normalizes timestamps, reads JSONL
// zoo logs, and resolves session log paths. The opencode `key=value`
// parser now lives in `zutil::session::opencode` (migrated), so only the
// zoo-side parsing remains here.

use std::fs;

use serde_json::Value;

use zutil::get_zoo_log_dir;
use zutil::resolve_session_path;

/// Map a tool identifier string to a trace event type and icon.
///
/// Accepts both permission and tool name fields.
///
/// # Returns
///
/// Tuple of (`event_type`, `icon`).
#[must_use]
pub fn tool_type_and_icon(tool_id: &str) -> (String, String) {
    match tool_id {
        "read" | "grep" | "glob" => ("tool_read".to_string(), "▶".to_string()),
        "edit" | "write" => ("tool_write".to_string(), "◀".to_string()),
        "bash" => ("tool_exec".to_string(), "⚙".to_string()),
        "task" => ("tool_orch".to_string(), "◈".to_string()),
        _ => ("tool_other".to_string(), "◆".to_string()),
    }
}

/// Normalize a timestamp to ISO 8601 format with `Z` suffix.
///
/// Shared implementation lives in `zutil`; re-exported here so the
/// timeline builder keeps its `parser::normalize_timestamp` call site.
pub use zutil::normalize_timestamp;

/// Parse a `ZooKeeper` JSONL log file.
///
/// Reads each non-empty line and parses as JSON. Silently skips invalid JSON
/// lines. Returns an empty `Vec` if the file does not exist or cannot be read.
#[must_use]
pub fn parse_zoo_log(path: &str) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut events: Vec<Value> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<Value>(trimmed) {
            events.push(json);
        }
    }
    events
}

/// Resolve the zoo log path for a given session ID.
///
/// Delegates to `zutil::resolve_session_path`, which finds
/// `<host>-<session_id>.log` (host ∈ {opencode, pi}) in the zoo log dir.
/// Returns `None` when no unique log file exists for the session.
#[must_use]
pub fn resolve_log_path(session_id: &str) -> Option<String> {
    let dir = get_zoo_log_dir();
    resolve_session_path(session_id, &dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── tool_type_and_icon ─────────────────────────────────────────────────

    #[test]
    fn test_tool_type_and_icon_read() {
        for tool in &["read", "grep", "glob"] {
            let (ty, icon) = tool_type_and_icon(tool);
            assert_eq!(ty, "tool_read");
            assert_eq!(icon, "▶");
        }
    }

    #[test]
    fn test_tool_type_and_icon_write() {
        for tool in &["edit", "write"] {
            let (ty, icon) = tool_type_and_icon(tool);
            assert_eq!(ty, "tool_write");
            assert_eq!(icon, "◀");
        }
    }

    #[test]
    fn test_tool_type_and_icon_exec() {
        let (ty, icon) = tool_type_and_icon("bash");
        assert_eq!(ty, "tool_exec");
        assert_eq!(icon, "⚙");
    }

    #[test]
    fn test_tool_type_and_icon_orch() {
        let (ty, icon) = tool_type_and_icon("task");
        assert_eq!(ty, "tool_orch");
        assert_eq!(icon, "◈");
    }

    #[test]
    fn test_tool_type_and_icon_other() {
        let (ty, icon) = tool_type_and_icon("unknown_tool");
        assert_eq!(ty, "tool_other");
        assert_eq!(icon, "◆");

        let (ty2, icon2) = tool_type_and_icon("webfetch");
        assert_eq!(ty2, "tool_other");
        assert_eq!(icon2, "◆");
    }

    // ── parse_zoo_log ──────────────────────────────────────────────────────

    #[test]
    fn test_parse_zoo_log_nonexistent() {
        let result = parse_zoo_log("/tmp/nonexistent-zoo-test-xxxxx.log");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_zoo_log_from_temp_file() {
        let tmp = std::env::temp_dir().join("ztrace-test-parse-zoo-log.jsonl");
        let content = r#"{"a":1,"b":"two"}
{"x":true}
not valid json
{"y":null}"#;
        std::fs::write(&tmp, content).unwrap();

        let result = parse_zoo_log(tmp.to_str().unwrap());
        assert_eq!(result.len(), 3);
        assert_eq!(
            result[0].get("a").and_then(serde_json::Value::as_i64),
            Some(1)
        );
        assert_eq!(
            result[1].get("x").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            result[2].get("y").and_then(serde_json::Value::as_null),
            Some(())
        );

        let _ = std::fs::remove_file(&tmp);
    }

    // ── resolve_log_path ───────────────────────────────────────────────────

    #[test]
    fn test_resolve_log_path_format() {
        // Resolves against the real ~/.zoo/log dir, which is absent in the
        // test environment → the lookup returns None (no unique match).
        let path = resolve_log_path("ses-001");
        assert_eq!(path, None);
    }
}
