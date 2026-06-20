#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::path::Path;

use chrono::TimeZone;
use serde_json::Value;

pub mod color;

#[cfg(feature = "db-helpers")]
pub mod db_helpers;

/// Return the `ZooKeeper` log directory, expanding `~` to the user home.
#[must_use]
pub fn get_zoo_log_dir() -> String {
    expand_tilde("~/.zoo/log")
}

/// Expand a leading `~` or `~/` to the user's home directory.
#[must_use]
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
        return path.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest).to_string_lossy().to_string();
    }
    path.to_string()
}

/// Resolve a session ID (or prefix) to the full log file path.
///
/// Globs for `opencode-<session_id>*.log` in `log_dir`. Returns the path
/// if exactly one match is found, `None` otherwise.
#[must_use]
pub fn resolve_session_path(session_id: &str, log_dir: &str) -> Option<String> {
    // os.path.basename: strip any directory components from the argument
    let session_id = Path::new(session_id)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(session_id);

    let dir_path = expand_tilde(log_dir);
    let dir = Path::new(&dir_path);
    if !dir.is_dir() {
        return None;
    }

    let pattern = dir.join(format!("opencode-{session_id}*.log"));
    let pattern_str = pattern.to_string_lossy().to_string();

    let matches: Vec<_> =
        glob::glob(&pattern_str).ok()?.filter_map(Result::ok).collect();

    if matches.len() == 1 {
        matches[0].to_str().map(ToString::to_string)
    } else {
        None
    }
}

/// Convert epoch milliseconds to ISO 8601 with microsecond precision.
///
/// Returns a string like `2025-01-09T12:34:56.123456Z`.
/// Returns `"invalid-timestamp"` when the timestamp is out of range.
#[must_use]
pub fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::Utc.timestamp_millis_opt(ms).single().map_or_else(
        || "invalid-timestamp".to_string(),
        |dt| dt.format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string(),
    )
}

/// Estimate token count from message parts.
///
/// Text/reasoning parts: `char_count / 4`.
/// Tool parts: `json(input).char_count / 4 + json(output).char_count / 4`.
/// Step-finish parts are excluded.
#[must_use]
pub fn estimate_tokens(parts: &[Value]) -> usize {
    let mut total = 0;
    for part in parts {
        let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ptype == "step-finish" {
            continue;
        }
        if ptype == "text" || ptype == "reasoning" {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            total += text.chars().count() / 4;
        } else if ptype == "tool" {
            let state = part.get("state").unwrap_or(&Value::Null);
            let inp = state.get("input").unwrap_or(&Value::Null);
            let out = state.get("output").unwrap_or(&Value::Null);
            total += inp.to_string().chars().count() / 4;
            total += out.to_string().chars().count() / 4;
        }
    }
    total
}

/// Safely parse a JSON string, returning `None` on failure.
#[must_use]
pub fn safe_json_loads(data: &str) -> Option<Value> {
    serde_json::from_str(data).ok()
}

/// Format an integer with comma separators (e.g. 1234 → "1,234").
#[must_use]
pub fn format_number(n: usize) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

/// Truncate ISO timestamp for display: replace T with space, take 19 chars.
#[must_use]
pub fn ts_display(ts: &str) -> String {
    if ts.is_empty() {
        return String::new();
    }
    ts.replace('T', " ")[..19.min(ts.len())].to_string()
}

/// Return the terminal display width (columns) of a string.
///
/// Delegates to `rich_rust::cells::cell_len` which uses the `unicode_width`
/// crate for correct East-Asian-Width and emoji handling.
#[must_use]
pub fn display_width(s: &str) -> usize {
    rich_rust::cells::cell_len(s)
}

/// Truncate a string to at most `max_width` terminal columns,
/// appending `"..."` when truncation occurs.
///
/// Uses `display_width` (delegating to `rich_rust::cells`) for accurate
/// column measurement.
#[must_use]
pub fn truncate_width(s: &str, max_width: usize) -> String {
    if display_width(s) <= max_width {
        return s.to_string();
    }
    let suffix = "...";
    let suffix_width = display_width(suffix);
    if max_width <= suffix_width {
        return suffix[..max_width.min(suffix.len())].to_string();
    }
    let target = max_width - suffix_width;
    let mut w = 0;
    let truncated: String = s
        .chars()
        .take_while(|c| {
            let cw = rich_rust::cells::cell_len(&c.to_string());
            if w + cw > target {
                false
            } else {
                w += cw;
                true
            }
        })
        .collect();
    format!("{truncated}{suffix}")
}

/// Truncate a string to at most `max_chars` Unicode characters,
/// appending "..." when truncation occurs.
///
/// Despite the name, this counts Unicode scalar values (characters),
/// not UTF-8 bytes.
#[must_use]
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_number() {
        assert_eq!(format_number(0), "0");
        assert_eq!(format_number(1), "1");
        assert_eq!(format_number(123), "123");
        assert_eq!(format_number(1234), "1,234");
        assert_eq!(format_number(1234567), "1,234,567");
        assert_eq!(format_number(1000000), "1,000,000");
    }

    #[test]
    fn test_ts_display() {
        assert_eq!(
            ts_display("2025-01-09T12:34:56.123456Z"),
            "2025-01-09 12:34:56"
        );
        assert_eq!(ts_display(""), "");
        assert_eq!(ts_display("2025-01-09"), "2025-01-09");
    }

    #[test]
    fn test_display_width_ascii() {
        assert_eq!(display_width("hello"), 5);
        assert_eq!(display_width(""), 0);
        assert_eq!(display_width(" "), 1);
    }

    #[test]
    fn test_display_width_cjk() {
        assert_eq!(display_width("你好"), 4);
        assert_eq!(display_width("a你好b"), 6);
        assert_eq!(display_width("😀"), 2);
    }

    #[test]
    fn test_display_width_mixed() {
        assert_eq!(display_width("Hello 你好"), 10);
        assert_eq!(display_width("a你b"), 4);
    }

    #[test]
    fn test_truncate_width_no_truncation() {
        assert_eq!(truncate_width("hello", 10), "hello");
        assert_eq!(truncate_width("你好", 10), "你好");
        assert_eq!(truncate_width("", 5), "");
    }

    #[test]
    fn test_truncate_width_with_truncation() {
        assert_eq!(truncate_width("hello world", 5), "he...");
        assert_eq!(truncate_width("hello world", 8), "hello...");
        // "你好世界" = 8 cols, max=4 -> suffix(3 cols) + 0 chars fits = "..."
        assert_eq!(truncate_width("你好世界", 4), "...");
        // max=6 -> suffix(3) + "你"(2) = 5 cols, "世"(2) would overflow
        assert_eq!(truncate_width("你好世界", 6), "你...");
        // max=7 -> suffix(3) + "你"(2) + "好"(2) would be 7, fits exactly
        assert_eq!(truncate_width("你好世界", 7), "你好...");
    }

    #[test]
    fn test_truncate_width_suffix_fits() {
        assert_eq!(truncate_width("hello", 1), ".");
        assert_eq!(truncate_width("hello", 2), "..");
        assert_eq!(truncate_width("hello", 3), "...");
    }

    #[test]
    fn test_truncate_width_cjk_vs_ascii() {
        // "ab" = 2 width, "你好" = 4 width
        // max=3 equals suffix_width=3 -> only suffix fits
        assert_eq!(truncate_width("ab你好", 3), "...");
        // max=4 -> suffix(3) + "a"(1) = 4
        assert_eq!(truncate_width("a你好", 4), "a...");
        // max=5 -> "a你好" = 1+2+2 = 5, fits exactly
        assert_eq!(truncate_width("a你好", 5), "a你好");
        // max=6 -> suffix(3) + "a"(1) + "你"(2) = 6
        assert_eq!(truncate_width("a你好世界", 6), "a你...");
    }

    #[test]
    fn test_truncate_chars() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello world", 5), "hello...");
        assert_eq!(truncate_chars("你好世界", 4), "你好世界");
        assert_eq!(truncate_chars("你好世界！", 4), "你好世界...");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn test_epoch_ms_to_iso_invalid() {
        assert_eq!(epoch_ms_to_iso(i64::MAX), "invalid-timestamp");
    }

    #[test]
    fn test_safe_json_loads() {
        assert!(safe_json_loads("{\"a\":1}").is_some());
        assert!(safe_json_loads("not json").is_none());
        assert!(safe_json_loads("").is_none());
    }
}
