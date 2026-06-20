use serde_json::Value;

use zutil::truncate_chars;

/// Classify a message role for display purposes.
pub fn classify_role(role: &str, parts: &[Value]) -> String {
    let has_tool = parts
        .iter()
        .any(|p| p.get("type").and_then(|v| v.as_str()) == Some("tool"));
    match role {
        "user" => "user".to_string(),
        "assistant" => {
            if has_tool {
                "tool_use".to_string()
            } else {
                "assistant".to_string()
            }
        }
        "tool" => "tool_result".to_string(),
        _ => role.to_string(),
    }
}

/// Generate a preview string from message parts.
///
/// The preview is truncated to fit within `max_chars` characters
/// (simple char count — the table engine handles display width).
pub fn preview_text(parts: &[Value], max_chars: usize) -> String {
    for part in parts {
        let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ptype == "text" {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let text = text
                .replace('\n', " ")
                .replace('\u{fe0f}', "") // strip emoji VS16: terminal renders 2 cells,
                .trim() // unicode_width says 1 cell — mismatch avoided
                .to_string();
            if text.chars().count() > max_chars {
                return truncate_chars(&text, max_chars - 3); // room for ...
            }
            return text;
        }
        if ptype == "tool" {
            let tool_name =
                part.get("tool").and_then(|v| v.as_str()).unwrap_or("?");
            let state = part.get("state").and_then(|v| v.as_object()).cloned();
            let inp = state.as_ref().and_then(|s| s.get("input")).cloned();
            let key_info = match inp {
                Some(Value::Object(ref obj)) => {
                    let pairs: Vec<String> = obj
                        .iter()
                        .take(2)
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect();
                    pairs.join("; ")
                }
                Some(ref v) => {
                    let s = v.to_string();
                    if s.chars().count() > max_chars / 2 {
                        truncate_chars(&s, max_chars / 2)
                    } else {
                        s
                    }
                }
                None => String::new(),
            };
            let preview = format!("{tool_name}: {key_info}");
            if preview.chars().count() > max_chars {
                return truncate_chars(&preview, max_chars - 3); // room for ...
            }
            return preview;
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_classify_role() {
        // user stays user
        assert_eq!(classify_role("user", &[]), "user");
        // assistant without tool parts
        assert_eq!(classify_role("assistant", &[]), "assistant");
        // assistant with tool parts -> tool_use
        let parts = vec![json!({"type": "tool", "tool": "read"})];
        assert_eq!(classify_role("assistant", &parts), "tool_use");
        // tool -> tool_result
        assert_eq!(classify_role("tool", &[]), "tool_result");
        // unknown role passes through
        assert_eq!(classify_role("system", &[]), "system");
    }

    #[test]
    fn test_preview_text_short() {
        let parts = vec![json!({"type": "text", "text": "hello"})];
        assert_eq!(preview_text(&parts, 40), "hello");
    }

    #[test]
    fn test_preview_text_long_truncated() {
        let parts = vec![json!({
            "type": "text",
            "text": "this is a very long text that exceeds forty characters easily"
        })];
        let p = preview_text(&parts, 40);
        assert!(p.ends_with("..."), "expected '...' suffix, got: {p}");
        assert!(
            p.chars().count() <= 40,
            "expected ≤ 40 chars, got {}: {p}",
            p.chars().count()
        );
    }

    #[test]
    fn test_preview_text_tool() {
        let parts = vec![json!({
            "type": "tool",
            "tool": "read",
            "state": {
                "input": {"filePath": "/some/path", "limit": 10}
            }
        })];
        let p = preview_text(&parts, 40);
        assert!(p.contains("read:"), "got: {p}");
        assert!(p.contains("filePath"), "got: {p}");
    }

    #[test]
    fn test_preview_text_utf8_no_panic() {
        // Chinese text — truncated by char count now
        let long_text = "这是一个很长的中文文本用来测试截断功能是否正常工作不会崩溃还需要更多字符";
        let parts = vec![json!({"type": "text", "text": long_text})];
        let p = preview_text(&parts, 40);
        assert!(
            p.chars().count() <= 40,
            "expected ≤ 40 chars, got {}: {p}",
            p.chars().count()
        );
    }

    #[test]
    fn test_preview_text_newline_collapsed() {
        let parts = vec![json!({
            "type": "text",
            "text": "line one\nline two\nline three"
        })];
        let p = preview_text(&parts, 40);
        assert!(!p.contains('\n'), "newlines should be collapsed");
        assert!(p.contains(' '));
    }

    #[test]
    fn test_preview_text_terminal_width() {
        // Test with narrow max_chars (10 chars)
        let parts = vec![json!({
            "type": "text",
            "text": "this text is too long for narrow terminal"
        })];
        let p = preview_text(&parts, 10);
        assert!(p.chars().count() <= 10);
        assert!(p.ends_with("..."));
    }

    #[test]
    fn test_preview_text_cjk_terminal_width() {
        // CJK text truncated by char count — preview limits chars,
        // the rich_rust table engine handles actual display width.
        let parts = vec![json!({
            "type": "text",
            "text": "你好世界这是测试"
        })];
        // 8 chars ≤ max, no truncation
        let p = preview_text(&parts, 8);
        assert_eq!(p, "你好世界这是测试");
    }
}
