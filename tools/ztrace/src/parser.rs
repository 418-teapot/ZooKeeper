// Parser module for ZooKeeper log parsing.
//
// Maps tool IDs to (event_type, icon), parses opencode key=value log lines,
// normalizes timestamps, reads JSONL zoo logs, and resolves session log paths.

use std::collections::HashMap;
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

/// Parse a single opencode `key=value` log line into a dict.
///
/// Uses `shlex` to split tokens. Returns `None` for empty or unparseable
/// lines.
#[must_use]
pub fn parse_opencode_line(line: &str) -> Option<HashMap<String, String>> {
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

            // Strip surrounding double quotes if present
            if value.len() >= 2
                && value.starts_with('"')
                && value.ends_with('"')
            {
                let new_len = value.len() - 1;
                value = value[1..new_len].to_string();
            }

            // Normalize key names (session.id -> session_id)
            let key = key.replace('.', "_");
            entry.insert(key, value);
        }
    }

    if entry.is_empty() { None } else { Some(entry) }
}

/// Normalize a timestamp to ISO 8601 format with `Z` suffix.
///
/// Returns empty string for empty input. If already ends with `Z`, returns
/// as-is. Otherwise tries to parse as ISO 8601 and formats back with `Z`.
/// On parse failure, returns the original string unchanged.
#[must_use]
pub fn normalize_timestamp(ts: &str) -> String {
    if ts.is_empty() {
        return String::new();
    }
    if ts.ends_with('Z') {
        return ts.to_string();
    }

    // Try RFC 3339 parsing (covers +00:00 style offsets)
    let cleaned = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&cleaned) {
        return dt.format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    // Try NaiveDateTime with fractional seconds
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f")
    {
        return nd.and_utc().format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    // Try NaiveDateTime without fractional seconds
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S")
    {
        return nd.and_utc().format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    ts.to_string()
}

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

    // ── parse_opencode_line ────────────────────────────────────────────────

    #[test]
    fn test_parse_opencode_line_normal() {
        // acceptance criterion: `message="exiting loop" session_id=sess-1`
        let result =
            parse_opencode_line(r#"message="exiting loop" session_id=sess-1"#);
        assert!(result.is_some());
        let map = result.unwrap();
        assert_eq!(map.get("message").unwrap(), "exiting loop");
        assert_eq!(map.get("session_id").unwrap(), "sess-1");
    }

    #[test]
    fn test_parse_opencode_line_quoted_value() {
        let result = parse_opencode_line(r#"tool="bash" cmd="ls -la""#);
        assert!(result.is_some());
        let map = result.unwrap();
        assert_eq!(map.get("tool").unwrap(), "bash");
        assert_eq!(map.get("cmd").unwrap(), "ls -la");
    }

    #[test]
    fn test_parse_opencode_line_empty() {
        assert!(parse_opencode_line("").is_none());
        assert!(parse_opencode_line("   ").is_none());
    }

    #[test]
    fn test_parse_opencode_line_dot_normalization() {
        let result = parse_opencode_line("session.id=ses-001 level=info");
        assert!(result.is_some());
        let map = result.unwrap();
        assert_eq!(map.get("session_id").unwrap(), "ses-001");
        assert_eq!(map.get("level").unwrap(), "info");
    }

    #[test]
    fn test_parse_opencode_line_unparseable() {
        // Unclosed quote causes shlex to return None
        assert!(parse_opencode_line(r#"key="unclosed"#).is_none());
    }

    #[test]
    fn test_parse_opencode_line_no_equals() {
        // Tokens without `=` are skipped
        let result = parse_opencode_line("justaword");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_opencode_line_mixed() {
        let result = parse_opencode_line(
            r#"timestamp=2025-01-09T12:34:56Z level=info msg="hello world" session.id=abc"#,
        );
        assert!(result.is_some());
        let map = result.unwrap();
        assert_eq!(map.get("timestamp").unwrap(), "2025-01-09T12:34:56Z");
        assert_eq!(map.get("level").unwrap(), "info");
        assert_eq!(map.get("msg").unwrap(), "hello world");
        assert_eq!(map.get("session_id").unwrap(), "abc");
    }

    // ── normalize_timestamp ────────────────────────────────────────────────

    #[test]
    fn test_normalize_timestamp_with_z() {
        assert_eq!(
            normalize_timestamp("2025-01-09T12:34:56Z"),
            "2025-01-09T12:34:56Z"
        );
    }

    #[test]
    fn test_normalize_timestamp_with_z_and_micros() {
        assert_eq!(
            normalize_timestamp("2025-01-09T12:34:56.123456Z"),
            "2025-01-09T12:34:56.123456Z"
        );
    }

    #[test]
    fn test_normalize_timestamp_without_z() {
        let result = normalize_timestamp("2025-01-09T12:34:56");
        // Should add Z suffix
        assert!(result.ends_with('Z'));
        assert!(result.starts_with("2025-01-09T12:34:56"));
    }

    #[test]
    fn test_normalize_timestamp_without_z_micros() {
        let result = normalize_timestamp("2025-01-09T12:34:56.123456");
        assert_eq!(result, "2025-01-09T12:34:56.123456Z");
    }

    #[test]
    fn test_normalize_timestamp_empty() {
        assert_eq!(normalize_timestamp(""), "");
    }

    #[test]
    fn test_normalize_timestamp_invalid() {
        assert_eq!(normalize_timestamp("not-a-date"), "not-a-date");
        assert_eq!(normalize_timestamp("garbage"), "garbage");
    }

    #[test]
    fn test_normalize_timestamp_with_offset() {
        // +00:00 offset should be normalized to Z
        let result = normalize_timestamp("2025-01-09T12:34:56.123456+00:00");
        assert_eq!(result, "2025-01-09T12:34:56.123456Z");
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
