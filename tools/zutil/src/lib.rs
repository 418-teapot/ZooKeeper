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

pub mod fileio;

pub mod session;

/// Return the `ZooKeeper` log directory, expanding `~` to the user home.
#[must_use]
pub fn get_zoo_log_dir() -> String {
    expand_tilde("~/.zoo/log")
}

/// Return the path to the `jq` executable, preferring `/usr/bin/jq`
/// when it exists (common on macOS) and falling back to `"jq"`.
#[must_use]
pub fn jq_path() -> String {
    if Path::new("/usr/bin/jq").exists() {
        "/usr/bin/jq".to_string()
    } else {
        "jq".to_string()
    }
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

/// Host prefixes for session log files, in deterministic precedence order.
///
/// Session log files are named `<host>-<session_id>.log` where host is one
/// of these values. Host-level files (`opencode.log` / `pi.log`) are not
/// session files and are never matched by session lookups.
const SESSION_HOST_PREFIXES: &[&str] = &["opencode", "pi"];

/// Extract the session ID from a `<host>-<session_id>.log` file name.
///
/// Returns `None` when the name does not carry a known host prefix.  A
/// trailing `.N` rotation backup suffix after `.log` (e.g. `.log.1`) is
/// also stripped, so a rotated backup parses to the bare session id.
///
/// Note: session lookups glob `<host>-<session_id>*.log`, so a `.log.N`
/// backup is never matched in practice — this extraction only strips the
/// suffix defensively for callers that hand over backup file names.
fn session_id_from_filename(name: &str) -> Option<&str> {
    for prefix in SESSION_HOST_PREFIXES {
        if let Some(stripped) = name.strip_prefix(&format!("{prefix}-")) {
            // A rotated backup is `<base>.log.N`: split off the numeric tail
            // first so the `.log` marker is at the end.  Session ids that
            // legitimately end in digits (e.g. `ses-001.2.log`) are
            // unaffected because their `.log` marker is already at the end.
            let no_rotation = match stripped.rsplit_once('.') {
                Some((stem, tail))
                    if !tail.is_empty()
                        && tail.chars().all(|c| c.is_ascii_digit()) =>
                {
                    stem
                }
                _ => stripped,
            };
            if let Some(sid) = no_rotation.strip_suffix(".log") {
                return Some(sid);
            }
        }
    }
    None
}

/// Resolve a session ID (or prefix) to the full log file path.
///
/// Globs for `<host>-<session_id>*.log` (host ∈ {opencode, pi}) in
/// `log_dir`. Host-level files (`opencode.log` / `pi.log`) never match.
/// Returns the path when exactly one distinct session file matches, `None`
/// otherwise.
///
/// When a concrete session ID exists under multiple hosts (e.g. both
/// `opencode-<sid>.log` and `pi-<sid>.log`), the `opencode` file wins per
/// the deterministic ordering of [`SESSION_HOST_PREFIXES`]. When the
/// session ID is a prefix matching multiple distinct sessions (across any
/// host), the lookup is ambiguous and `None` is returned.
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

    // Glob each host prefix separately (the glob crate does not support
    // brace alternation), collecting every session-file match.
    let mut matches: Vec<std::path::PathBuf> = Vec::new();
    for prefix in SESSION_HOST_PREFIXES {
        let pattern = dir.join(format!("{prefix}-{session_id}*.log"));
        let pattern_str = pattern.to_string_lossy().to_string();
        if let Ok(glob_matches) = glob::glob(&pattern_str) {
            matches.extend(glob_matches.filter_map(Result::ok));
        }
    }

    // Distinct session IDs among the matches. More than one distinct ID
    // means the argument is a prefix matching multiple sessions → ambiguous.
    let mut distinct: Vec<&str> = Vec::new();
    for path in &matches {
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(sid) = session_id_from_filename(name)
            && !distinct.contains(&sid)
        {
            distinct.push(sid);
        }
    }
    if distinct.len() > 1 {
        return None;
    }

    match matches.len() {
        0 => None,
        1 => matches[0].to_str().map(ToString::to_string),
        // Multiple files, all the same session ID → host collision. Pick
        // the highest-precedence host prefix.
        _ => SESSION_HOST_PREFIXES.iter().find_map(|prefix| {
            matches.iter().find_map(|path| {
                let name =
                    path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name.starts_with(&format!("{prefix}-")) {
                    path.to_str().map(ToString::to_string)
                } else {
                    None
                }
            })
        }),
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

/// Convert ISO 8601 timestamp to epoch milliseconds with full precision.
///
/// Uses integer arithmetic to avoid floating-point rounding errors.
/// Returns `0` on parse failure or empty input.
#[must_use]
pub fn iso_to_epoch_ms(ts: &str) -> i64 {
    if ts.is_empty() {
        return 0;
    }
    // Normalize Z suffix to +00:00 for RFC 3339 parser
    let cleaned = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&cleaned) {
        return dt.timestamp_millis();
    }
    // Try NaiveDateTime formats (no timezone)
    let bare = ts.trim_end_matches('Z');
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S%.f")
    {
        return nd.and_utc().timestamp_millis();
    }
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S")
    {
        return nd.and_utc().timestamp_millis();
    }
    0
}

/// Normalize a timestamp to ISO 8601 with `Z` suffix.
///
/// Returns an empty string for empty input. Input already ending in `Z`
/// is returned as-is; other parseable values are reformatted with `Z` and
/// six-digit microseconds; unparseable input is returned unchanged.
///
/// Shared by the `OpenCode` log parser (`zutil::session::opencode`) and
/// the `ztrace` zoo-log parser.
#[must_use]
pub fn normalize_timestamp(ts: &str) -> String {
    if ts.is_empty() {
        return String::new();
    }
    if ts.ends_with('Z') {
        return ts.to_string();
    }

    // Try RFC 3339 parsing (covers +00:00 style offsets).
    let cleaned = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&cleaned) {
        return dt.format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    // Try NaiveDateTime with fractional seconds.
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f")
    {
        return nd.and_utc().format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    // Try NaiveDateTime without fractional seconds.
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S")
    {
        return nd.and_utc().format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string();
    }

    ts.to_string()
}

/// Convert a `serde_json::Value` to a string for token estimation.
///
/// Objects and arrays are serialized to JSON; strings are kept bare (no quotes);
/// everything else uses `Display` (numbers, booleans, null).
fn value_to_estimate_string(v: &Value) -> String {
    match v {
        Value::Object(_) | Value::Array(_) => {
            serde_json::to_string(v).unwrap_or_default()
        }
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
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

            // Serialize dict/list as JSON, scalar via Display.
            // serde_json::Value::to_string() adds JSON quotes around
            // strings — avoid that by serializing only objects/arrays.
            let input_text = value_to_estimate_string(inp);
            let output_text = value_to_estimate_string(out);
            total += input_text.chars().count() / 4;
            total += output_text.chars().count() / 4;
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

#[cfg(feature = "db-helpers")]
pub mod test_db;

/// Resolve the terminal display width from a `COLUMNS` env value and the
/// measured terminal width.
///
/// `columns` wins when it parses to a positive `u16`; otherwise
/// `tty_width` is returned unchanged. A value of `0` for either is
/// treated as "unknown" (no terminal size available).
#[must_use]
pub fn resolve_width(columns: Option<&str>, tty_width: u16) -> u16 {
    columns
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|w| *w > 0)
        .unwrap_or(tty_width)
}

/// Get the terminal display width in columns.
///
/// Prefers the `COLUMNS` environment variable (conventional CLI behavior,
/// as respected by `less` etc.) and falls back to the controlling
/// terminal's size reported by crossterm.
#[must_use]
pub fn get_terminal_width() -> usize {
    let columns = std::env::var("COLUMNS").ok();
    let tty_width = rich_rust::terminal::get_terminal_width();
    let tty = u16::try_from(tty_width).unwrap_or(u16::MAX);
    usize::from(resolve_width(columns.as_deref(), tty))
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
        assert_eq!(format_number(1_234_567), "1,234,567");
        assert_eq!(format_number(1_000_000), "1,000,000");
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
    fn test_resolve_width_columns_honored() {
        // COLUMNS set to a valid positive width wins over the tty size.
        assert_eq!(resolve_width(Some("200"), 122), 200);
        assert_eq!(resolve_width(Some("1"), 122), 1);
    }

    #[test]
    fn test_resolve_width_unset_falls_back() {
        // COLUMNS unset: fall back to the measured terminal width.
        assert_eq!(resolve_width(None, 122), 122);
        assert_eq!(resolve_width(None, 80), 80);
    }

    #[test]
    fn test_resolve_width_invalid_columns_falls_back() {
        // Non-numeric, zero, or negative COLUMNS are invalid → tty width.
        assert_eq!(resolve_width(Some("abc"), 122), 122);
        assert_eq!(resolve_width(Some(""), 122), 122);
        assert_eq!(resolve_width(Some("0"), 122), 122);
        assert_eq!(resolve_width(Some("-5"), 122), 122);
        assert_eq!(resolve_width(Some("200.5"), 122), 122);
    }

    #[test]
    fn test_resolve_width_trims_whitespace() {
        assert_eq!(resolve_width(Some(" 200 "), 122), 200);
        assert_eq!(resolve_width(Some("\t200\n"), 122), 200);
    }

    #[test]
    fn test_epoch_ms_to_iso_invalid() {
        assert_eq!(epoch_ms_to_iso(i64::MAX), "invalid-timestamp");
    }

    #[test]
    fn test_iso_to_epoch_ms_empty() {
        assert_eq!(iso_to_epoch_ms(""), 0);
    }

    #[test]
    fn test_iso_to_epoch_ms_z_suffix() {
        // 2024-01-01T00:00:00Z = 1704067200000 ms
        let ms = iso_to_epoch_ms("2024-01-01T00:00:00Z");
        assert!(ms > 0, "got {ms}");
    }

    #[test]
    fn test_iso_to_epoch_ms_microseconds() {
        // 0.123456s → truncates to 123ms (not floor, not round)
        let ms = iso_to_epoch_ms("2024-01-01T00:00:00.123456Z");
        let base = iso_to_epoch_ms("2024-01-01T00:00:00Z");
        assert_eq!(ms - base, 123, "123456µs → 123ms");
    }

    #[test]
    fn test_iso_to_epoch_ms_no_timezone() {
        let ms = iso_to_epoch_ms("2024-01-01T00:00:00");
        assert!(ms > 0, "got {ms}");
    }

    #[test]
    fn test_iso_to_epoch_ms_invalid() {
        assert_eq!(iso_to_epoch_ms("not-a-date"), 0);
        assert_eq!(iso_to_epoch_ms("garbage"), 0);
    }

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

    #[test]
    fn test_estimate_tokens_tool_string_no_quotes() {
        // Bugfix: string tool input should NOT be JSON-quoted in estimation.
        // str("hello world") = 11 chars (bare, not JSON-quoted)
        // Bug (old): Value::String.to_string() = "\"hello world\"" (15 chars)
        let parts = vec![serde_json::json!({
            "type": "tool",
            "state": {"input": "hello world", "output": "ok"}
        })];
        let tokens = estimate_tokens(&parts);
        // 11/4 + 2/4 = 2 + 0 = 2
        assert_eq!(tokens, 2);
    }

    #[test]
    fn test_estimate_tokens_tool_object() {
        // Object input should be JSON-serialized
        let parts = vec![serde_json::json!({
            "type": "tool",
            "state": {"input": {"key": "val"}, "output": {}}
        })];
        let tokens = estimate_tokens(&parts);
        // {"key":"val"} = 13 chars / 4 = 3, {} = 2 chars / 4 = 0
        assert_eq!(tokens, 3);
    }

    #[test]
    fn test_safe_json_loads() {
        assert!(safe_json_loads("{\"a\":1}").is_some());
        assert!(safe_json_loads("not json").is_none());
        assert!(safe_json_loads("").is_none());
    }

    // ── resolve_session_path ──────────────────────────────────────────

    /// Create a fresh temp dir for `resolve_session_path` tests.
    fn session_resolve_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zutil-resolve-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_resolve_session_path_opencode_prefix() {
        let dir = session_resolve_dir("opencode");
        std::fs::write(dir.join("opencode-ses-001.log"), "x").unwrap();
        // Host-level file must never match a session lookup.
        std::fs::write(dir.join("opencode.log"), "x").unwrap();

        let result = resolve_session_path("ses-001", dir.to_str().unwrap());
        assert_eq!(
            result.as_deref(),
            Some(dir.join("opencode-ses-001.log").to_str().unwrap())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_session_path_pi_prefix() {
        let dir = session_resolve_dir("pi");
        std::fs::write(dir.join("pi-ses-002.log"), "x").unwrap();
        // Host-level file must never match a session lookup.
        std::fs::write(dir.join("pi.log"), "x").unwrap();

        let result = resolve_session_path("ses-002", dir.to_str().unwrap());
        assert_eq!(
            result.as_deref(),
            Some(dir.join("pi-ses-002.log").to_str().unwrap())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_session_path_host_level_never_matches() {
        let dir = session_resolve_dir("host-level");
        std::fs::write(dir.join("opencode.log"), "x").unwrap();
        std::fs::write(dir.join("pi.log"), "x").unwrap();

        assert_eq!(
            resolve_session_path("ses-001", dir.to_str().unwrap()),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_session_path_prefers_opencode_on_collision() {
        let dir = session_resolve_dir("collision");
        std::fs::write(dir.join("opencode-ses-003.log"), "oc").unwrap();
        std::fs::write(dir.join("pi-ses-003.log"), "pi").unwrap();

        let result = resolve_session_path("ses-003", dir.to_str().unwrap());
        assert_eq!(
            result.as_deref(),
            Some(dir.join("opencode-ses-003.log").to_str().unwrap())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_session_path_ambiguous_prefix_returns_none() {
        let dir = session_resolve_dir("ambiguous");
        std::fs::write(dir.join("opencode-ses-001.log"), "x").unwrap();
        std::fs::write(dir.join("opencode-ses-002.log"), "x").unwrap();

        // "ses-" matches both ses-001 and ses-002 → ambiguous.
        assert_eq!(resolve_session_path("ses-", dir.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_session_path_no_match_returns_none() {
        let dir = session_resolve_dir("nomatch");
        assert_eq!(
            resolve_session_path("ses-999", dir.to_str().unwrap()),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── jq_path ─────────────────────────────────────────────────────

    #[test]
    fn test_session_id_from_filename_rotation_backup() {
        // A rotated backup (`opencode-<sid>.log.1`) must parse to the bare
        // session id, not carry the `.log.1` tail.
        assert_eq!(
            session_id_from_filename("opencode-ses-001.log.1"),
            Some("ses-001")
        );
        assert_eq!(
            session_id_from_filename("pi-ses-002.log.12"),
            Some("ses-002")
        );
        // A session id that itself ends in digits is preserved.
        assert_eq!(
            session_id_from_filename("opencode-ses-001.log"),
            Some("ses-001")
        );
        // Host-level files never match a session lookup.
        assert_eq!(session_id_from_filename("opencode.log"), None);
        assert_eq!(session_id_from_filename("pi.log"), None);
    }

    #[test]
    fn test_jq_path_non_empty() {
        let path = jq_path();
        assert!(!path.is_empty(), "jq_path should never be empty");
    }

    #[test]
    fn test_jq_path_returns_existing_or_fallback() {
        let path = jq_path();
        if Path::new("/usr/bin/jq").exists() {
            assert_eq!(path, "/usr/bin/jq");
        } else {
            assert_eq!(path, "jq");
        }
    }
}
