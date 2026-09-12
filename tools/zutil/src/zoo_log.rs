//! `ZooKeeper` JSONL log parsing.
//!
//! Reads the hook-event files written under `~/.zoo/log/*.log` (one JSON
//! object per line) into `serde_json::Value` trees. Emoji variation
//! selector-16 (VS16) is stripped from every string so terminal display
//! width stays consistent across hosts. Stripping happens at parse time,
//! so exported JSON (e.g. `ztrace export`, `show --json`) is likewise
//! VS16-free.

use std::fs;

use serde_json::Value;

/// Strip emoji variation selector-16 (VS16, U+FE0F) from a string.
///
/// VS16 causes terminal display width mismatches: the terminal renders it
/// as 0-width but some Unicode width libraries count it as 1 cell.
#[must_use]
pub fn strip_vs16(s: &str) -> String {
    s.replace('\u{fe0f}', "")
}

/// Recursively strip VS16 from all string values in a JSON tree.
pub fn strip_vs16_from_value(value: &mut Value) {
    match value {
        Value::String(s) => {
            *s = strip_vs16(s);
        }
        Value::Object(obj) => {
            for v in obj.values_mut() {
                strip_vs16_from_value(v);
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                strip_vs16_from_value(v);
            }
        }
        _ => {}
    }
}

/// Parse a `ZooKeeper` JSONL log file into one `Value` per non-empty line.
///
/// Invalid JSON lines are silently skipped. Returns an empty `Vec` when the
/// file does not exist or cannot be read. VS16 is stripped from every
/// string value (see [`strip_vs16`]).
#[must_use]
pub fn parse_zoo_log(path: &str) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut events: Vec<Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    for event in &mut events {
        strip_vs16_from_value(event);
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_strip_vs16_removes_variation_selector() {
        let input = "hello\u{fe0f}world\u{fe0f}";
        assert_eq!(strip_vs16(input), "helloworld");
    }

    #[test]
    fn test_strip_vs16_no_change_without_vs16() {
        assert_eq!(strip_vs16("hello world"), "hello world");
    }

    #[test]
    fn test_strip_vs16_empty_string() {
        assert_eq!(strip_vs16(""), "");
    }

    #[test]
    fn test_strip_vs16_from_value_recursive() {
        let vs16 = '\u{fe0f}';
        let mut value = json!({
            "outer": {
                "inner": format!("text{vs16}end"),
                "list": [format!("a{vs16}"), "b"],
            },
            "other": "plain",
        });
        strip_vs16_from_value(&mut value);
        assert_eq!(value["outer"]["inner"], "textend");
        assert_eq!(value["outer"]["list"][0], "a");
        assert_eq!(value["outer"]["list"][1], "b");
        assert_eq!(value["other"], "plain");
    }

    #[test]
    fn test_parse_zoo_log_nonexistent() {
        let result = parse_zoo_log("/tmp/nonexistent-zoo-test-xxxxx.log");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_zoo_log_from_temp_file() {
        let tmp = std::env::temp_dir().join(format!(
            "zutil-test-parse-zoo-log-{}.jsonl",
            std::process::id()
        ));
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

    #[test]
    fn test_parse_zoo_log_strips_vs16_from_values() {
        let vs16 = '\u{fe0f}';
        let line = format!(
            r#"{{"hook": "subagent-prompt", "event": "validate", "msg": "hello{vs16}world"}}"#
        );
        let tmp = std::env::temp_dir().join(format!(
            "zutil-test-parse-vs16-{}.jsonl",
            std::process::id()
        ));
        std::fs::write(&tmp, line).unwrap();

        let result = parse_zoo_log(tmp.to_str().unwrap());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["msg"], "helloworld");

        let _ = std::fs::remove_file(&tmp);
    }
}
