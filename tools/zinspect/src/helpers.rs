use chrono::NaiveDateTime;
use serde_json::Value;

use zutil::resolve_session_path;

// Note: sub-tick characters for the histogram bar (▏..▉) are emitted
// directly in `hit_rate_bar` to satisfy single_char_add_str as `bar.push()`.

/// Convert an ISO timestamp to `HH:MM:SS`.
///
/// Returns `""` for empty input. On parse failure, returns the last
/// 12 characters (or the whole string if shorter).
pub fn shorten_timestamp(ts: &str) -> String {
    if ts.is_empty() {
        return String::new();
    }
    // Try parsing ISO (handles Z and +00:00 by stripping suffix)
    let clean = ts.replace('Z', "").replace("+00:00", "");
    // Take up to the decimal point or end
    let clean = clean.split('.').next().unwrap_or(&clean);
    if let Ok(dt) = NaiveDateTime::parse_from_str(clean, "%Y-%m-%dT%H:%M:%S") {
        return dt.format("%H:%M:%S").to_string();
    }
    // Fallback: last 12 chars
    if ts.len() > 12 { ts[ts.len() - 12..].to_string() } else { ts.to_string() }
}

/// Format a duration in seconds as a human-readable string
/// like `"1h 23m 45s"`.
pub fn format_duration(total_seconds: i64) -> String {
    let hours = total_seconds / 3600;
    let remainder = total_seconds % 3600;
    let minutes = remainder / 60;
    let seconds = remainder % 60;
    let mut parts: Vec<String> = Vec::new();
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    parts.push(format!("{seconds}s"));
    parts.join(" ")
}

/// Compute cache hit rate as a percentage.
///
/// `denom = input_tokens + cache_read`. Returns 0.0 when denom is 0.
pub fn cache_hit_rate(cache_read: f64, input_tokens: f64) -> f64 {
    let denom = input_tokens + cache_read;
    if denom == 0.0 {
        return 0.0;
    }
    cache_read / denom * 100.0
}

/// Render a hit rate as a histogram bar.
///
/// Each `█` represents 10 percentage points; sub-steps (▉▊▋▌▍▎▏)
/// represent 1.25 pp each.
///
/// Uses bounded for-loop and direct string emission to avoid
/// integer-cast and float-comparison lints.
pub fn hit_rate_bar(rate: f64) -> String {
    let clamped = rate.clamp(0.0, 100.0);
    let mut bar = String::new();

    // At most 10 full blocks (100 %)
    let mut remaining = clamped;
    for _ in 0..10 {
        if remaining >= 10.0 {
            bar.push('█');
            remaining -= 10.0;
        } else {
            break;
        }
    }

    // remaining is 0.0..10.0 — append the sub-tick character
    if remaining >= 1.25 {
        if remaining >= 8.75 {
            bar.push('▉');
        } else if remaining >= 7.50 {
            bar.push('▊');
        } else if remaining >= 6.25 {
            bar.push('▋');
        } else if remaining >= 5.00 {
            bar.push('▌');
        } else if remaining >= 3.75 {
            bar.push('▍');
        } else if remaining >= 2.50 {
            bar.push('▎');
        } else {
            bar.push('▏');
        }
    }

    bar
}

/// Extract the session ID from an `opencode-<id>.log` path.
pub fn session_id_from_path(path: &str) -> String {
    // os.path.basename equivalent
    let basename = path.rsplit('/').next().unwrap_or(path);
    if let Some(stripped) =
        basename.strip_prefix("opencode-").and_then(|s| s.strip_suffix(".log"))
    {
        return stripped.to_string();
    }
    basename.to_string()
}

/// Strip emoji variation selector-16 (VS16, U+FE0F) from a string.
///
/// VS16 causes terminal display width mismatches: the terminal renders it
/// as 0-width but some Unicode width libraries count it as 1 cell.
pub fn strip_vs16(s: &str) -> String {
    s.replace('\u{fe0f}', "")
}

/// Recursively strip VS16 from all string values in a JSON tree.
fn strip_vs16_from_value(value: &mut Value) {
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

/// Format the context-metrics hook details.
fn format_context_metrics(event: &Value) -> String {
    let Some(estimated_tokens) =
        event.get("estimated_tokens").and_then(serde_json::Value::as_i64)
    else {
        return String::new();
    };
    let message_count = event
        .get("message_count")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let exact_tokens = event
        .get("exact_tokens")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let estimated_new_tokens = event
        .get("estimated_new_tokens")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if let Some(agent) = event.get("agent").and_then(|v| v.as_str())
        && !agent.is_empty()
    {
        format!(
            "{agent}: estimated={estimated_tokens} tokens, \
             {message_count} msgs \
             (exact={exact_tokens} + est={estimated_new_tokens})"
        )
    } else {
        format!(
            "estimated={estimated_tokens} tokens, \
             {message_count} msgs \
             (exact={exact_tokens} + est={estimated_new_tokens})"
        )
    }
}

/// Format key details for a timeline row based on hook type.
pub fn format_details(event: &Value) -> String {
    let hook = event.get("hook").and_then(|v| v.as_str()).unwrap_or("");

    let result = match hook {
        "task-prompt" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(warnings) =
                event.get("warnings").and_then(serde_json::Value::as_i64)
            {
                parts.push(format!("warnings={warnings}"));
            }
            if let Some(errors) =
                event.get("errors").and_then(serde_json::Value::as_i64)
            {
                parts.push(format!("errors={errors}"));
            }
            parts.join(", ")
        }
        "json-error-nudge" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(tool) = event.get("tool").and_then(|v| v.as_str()) {
                parts.push(format!("tool={tool}"));
            }
            if let Some(pattern) = event.get("pattern").and_then(|v| v.as_str())
            {
                parts.push(format!("pattern={pattern}"));
            }
            parts.join(", ")
        }
        "direct-work-nudge" => event
            .get("tool")
            .and_then(|v| v.as_str())
            .map(|tool| format!("tool={tool}"))
            .unwrap_or_default(),
        "post-task-nudge" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(todo_state) =
                event.get("todo_state").and_then(|v| v.as_str())
            {
                parts.push(format!("todo={todo_state}"));
            }
            if let Some(nudge) = event.get("nudge").and_then(|v| v.as_str()) {
                parts.push(format!("nudge={nudge}"));
            }
            parts.join(", ")
        }
        "plugin" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(agents) = event.get("agents").and_then(|v| v.as_array())
            {
                let joined: Vec<String> = agents
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                if !joined.is_empty() {
                    parts.push(format!("agents={}", joined.join(",")));
                }
            }
            if let Some(skills) = event.get("skills").and_then(|v| v.as_array())
            {
                let joined: Vec<String> = skills
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                if !joined.is_empty() {
                    parts.push(format!("skills={}", joined.join(",")));
                }
            }
            parts.join(", ")
        }
        "context-metrics" => format_context_metrics(event),
        _ => String::new(),
    }
    .trim()
    .to_string();
    // Strip VS16 from the final formatted string to avoid terminal display
    // width mismatches in table cells.
    strip_vs16(&result)
}

/// Read a JSONL file and parse each non-empty line as JSON.
///
/// Returns an empty `Vec` if the file does not exist or cannot be read.
/// Invalid JSON lines are silently skipped.
pub fn parse_zoo_log(path: &str) -> Vec<Value> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let mut events: Vec<Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Strip VS16 from all string values to avoid terminal display width
    // mismatches in table cells (e.g. timeline Details column).
    for event in &mut events {
        strip_vs16_from_value(event);
    }
    events
}

/// Resolve a session ID (full or prefix) to an absolute log path.
///
/// Wrapper around `zutil::resolve_session_path` that exits with code 2
/// when no unique match is found (printing error to stderr).
///
/// # Panics
///
/// When the session cannot be uniquely resolved (exits process).
pub fn resolve_session(session_id: &str, log_dir: &str) -> String {
    resolve_session_path(session_id, log_dir).unwrap_or_else(|| {
        eprintln!(
            "Error: no unique log file found for session \
             '{session_id}'"
        );
        std::process::exit(2);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_shorten_timestamp_empty() {
        assert_eq!(shorten_timestamp(""), "");
    }

    #[test]
    fn test_shorten_timestamp_iso() {
        let ts = "2025-01-09T12:34:56.123456Z";
        let result = shorten_timestamp(ts);
        assert_eq!(result, "12:34:56");
    }

    #[test]
    fn test_shorten_timestamp_iso_without_suffix() {
        // Valid ISO without trailing Z/+00:00
        let ts = "2025-01-09T12:34:56";
        let result = shorten_timestamp(ts);
        assert_eq!(result, "12:34:56");
    }

    #[test]
    fn test_shorten_timestamp_fallback() {
        // Non-parseable but long enough
        let ts = "not-a-timestamp-abcdefgh";
        let result = shorten_timestamp(ts);
        assert!(result.len() <= 12);
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(5), "5s");
        assert_eq!(format_duration(65), "1m 5s");
        assert_eq!(format_duration(3661), "1h 1m 1s");
        assert_eq!(format_duration(7200), "2h 0s");
    }

    #[test]
    fn test_cache_hit_rate() {
        assert!((cache_hit_rate(30.0, 100.0) - 23.076).abs() < 0.01);
        assert!((cache_hit_rate(0.0, 0.0) - 0.0).abs() < f64::EPSILON);
        assert!((cache_hit_rate(0.0, 100.0) - 0.0).abs() < f64::EPSILON);
        assert!((cache_hit_rate(100.0, 0.0) - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_hit_rate_bar() {
        // 0% -> empty
        assert_eq!(hit_rate_bar(0.0), "");
        // 10% -> one full block
        assert_eq!(hit_rate_bar(10.0), "█");
        // 100% -> ten full blocks
        assert_eq!(hit_rate_bar(100.0), "██████████");
        // 15% -> 1 full + remainder tick
        let bar = hit_rate_bar(15.0);
        assert!(bar.starts_with('█'));
        assert_eq!(bar.chars().count(), 2);
    }

    #[test]
    fn test_session_id_from_path() {
        let path = "/home/user/.zoo/log/opencode-ses-001.log";
        assert_eq!(session_id_from_path(path), "ses-001");
    }

    #[test]
    fn test_session_id_from_path_no_match() {
        let path = "some_random_file.log";
        assert_eq!(session_id_from_path(path), "some_random_file.log");
    }

    #[test]
    fn test_format_details_task_prompt() {
        let event = json!({
            "hook": "task-prompt",
            "warnings": 2,
            "errors": 1
        });
        let details = format_details(&event);
        assert!(details.contains("warnings=2"));
        assert!(details.contains("errors=1"));
    }

    #[test]
    fn test_format_details_json_error_nudge() {
        let event = json!({
            "hook": "json-error-nudge",
            "tool": "webfetch",
            "pattern": "SyntaxError"
        });
        let details = format_details(&event);
        assert!(details.contains("tool=webfetch"));
        assert!(details.contains("pattern=SyntaxError"));
    }

    #[test]
    fn test_format_details_direct_work_nudge() {
        let event = json!({
            "hook": "direct-work-nudge",
            "tool": "edit"
        });
        let details = format_details(&event);
        assert_eq!(details, "tool=edit");
    }

    #[test]
    fn test_format_details_post_task_nudge() {
        let event = json!({
            "hook": "post-task-nudge",
            "todo_state": "pending",
            "nudge": "beaver"
        });
        let details = format_details(&event);
        assert!(details.contains("todo=pending"));
        assert!(details.contains("nudge=beaver"));
    }

    #[test]
    fn test_format_details_plugin() {
        let event = json!({
            "hook": "plugin",
            "agents": ["beaver", "lynx"],
            "skills": ["git-commit"]
        });
        let details = format_details(&event);
        assert!(details.contains("agents=beaver,lynx"));
        assert!(details.contains("skills=git-commit"));
    }

    #[test]
    fn test_format_details_context_metrics() {
        let event = json!({
            "hook": "context-metrics",
            "estimated_tokens": 1500,
            "message_count": 3,
            "exact_tokens": 1200,
            "estimated_new_tokens": 300
        });
        let details = format_details(&event);
        assert!(details.contains("estimated=1500"));
        assert!(details.contains("3 msgs"));
    }

    #[test]
    fn test_format_details_context_metrics_with_agent() {
        let event = json!({
            "hook": "context-metrics",
            "estimated_tokens": 1500,
            "message_count": 3,
            "exact_tokens": 1200,
            "estimated_new_tokens": 300,
            "agent": "beaver"
        });
        let details = format_details(&event);
        assert!(details.contains("beaver:"));
    }

    #[test]
    fn test_format_details_unknown_hook() {
        let event = json!({"hook": "some-unknown-hook"});
        assert_eq!(format_details(&event), "");
    }

    // ── VS16 stripping ─────────────────────────────────────────────────────

    #[test]
    fn test_strip_vs16_removes_variation_selector() {
        let input = "hello\u{fe0f}world\u{fe0f}";
        let result = strip_vs16(input);
        assert_eq!(result, "helloworld");
    }

    #[test]
    fn test_strip_vs16_no_change_without_vs16() {
        let input = "hello world";
        assert_eq!(strip_vs16(input), "hello world");
    }

    #[test]
    fn test_strip_vs16_empty_string() {
        assert_eq!(strip_vs16(""), "");
    }

    #[test]
    fn test_format_details_strips_vs16() {
        let event = json!({
            "hook": "task-prompt",
            "warnings": 2,
            "errors": 1,
            "msg": "hello\u{fe0f}world"
        });
        let details = format_details(&event);
        assert!(!details.contains('\u{fe0f}'));
    }

    #[test]
    fn test_format_details_context_metrics_strips_vs16() {
        let event = json!({
            "hook": "context-metrics",
            "estimated_tokens": 1500,
            "message_count": 3,
            "exact_tokens": 1200,
            "estimated_new_tokens": 300,
            "agent": "general\u{fe0f}"
        });
        let details = format_details(&event);
        assert!(!details.contains('\u{fe0f}'));
    }

    #[test]
    fn test_parse_zoo_log_strips_vs16_from_values() {
        // Embed the actual VS16 character via Rust's string literal escape.
        let vs16 = '\u{fe0f}';
        let line = format!(
            r#"{{"hook": "task-prompt", "event": "validate", "msg": "hello{vs16}world"}}"#
        );
        let mut value: Value = serde_json::from_str(&line).unwrap();
        strip_vs16_from_value(&mut value);
        assert_eq!(value["msg"], "helloworld");
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
}
