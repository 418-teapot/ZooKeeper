use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use rich_rust::color::ColorSystem;
use rich_rust::console::Console;
use rich_rust::segment::Segment;
use rich_rust::style::Style;

use serde_json::Value;

use zutil::truncate_chars;

/// Global flag: whether ANSI color output is enabled.
pub static COLOR: AtomicBool = AtomicBool::new(true);

/// Console instance for `print_message_detail`, configured with `TrueColor`
/// and default markup + `ReprHighlighter` enabled.
pub static MSG_CONSOLE: LazyLock<Console> = LazyLock::new(|| {
    Console::builder().color_system(ColorSystem::TrueColor).build()
});

/// Print a message-detail line with markup syntax when colors are enabled,
/// or with plain text (markup stripped) when `--no-color` is active.
pub fn msg_print(text: &str) {
    if COLOR.load(Ordering::SeqCst) {
        MSG_CONSOLE.print(text);
    } else {
        // Strip markup tags for plain-text output
        let plain = text.replace("[bold]", "").replace("[/bold]", "");
        println!("{plain}");
    }
}

/// Apply a `Style` to text, returning an ANSI-colored string
/// (or plain text when `--no-color` is active).
pub fn style_text(text: &str, style: &Style) -> String {
    if !COLOR.load(Ordering::SeqCst) {
        return text.to_string();
    }
    style.render(text, ColorSystem::TrueColor)
}

/// Convert `rich_rust` segments to an ANSI-colored string.
pub fn render_segments_to_ansi(segments: &[Segment]) -> String {
    if !COLOR.load(Ordering::SeqCst) {
        let total_len: usize = segments.iter().map(|s| s.text.len()).sum();
        let mut output = String::with_capacity(total_len);
        for segment in segments {
            if segment.is_control() {
                continue;
            }
            output.push_str(segment.text.as_ref());
        }
        return output;
    }

    let color_system = ColorSystem::TrueColor;
    let total_text_len: usize = segments.iter().map(|s| s.text.len()).sum();
    let mut output =
        String::with_capacity(total_text_len + segments.len() * 20);

    for segment in segments {
        if segment.is_control() {
            continue;
        }
        if let Some(ref style) = segment.style {
            let ansi = style.render_ansi(color_system);
            output.push_str(&ansi.0);
            output.push_str(segment.text.as_ref());
            output.push_str(&ansi.1);
        } else {
            output.push_str(segment.text.as_ref());
        }
    }

    output
}

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
pub fn preview_text(parts: &[Value]) -> String {
    for part in parts {
        let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ptype == "text" {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let text = text.replace('\n', " ").trim().to_string();
            if text.chars().count() > 40 {
                return truncate_chars(&text, 37);
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
                    if s.chars().count() > 20 {
                        truncate_chars(&s, 17)
                    } else {
                        s
                    }
                }
                None => String::new(),
            };
            let preview = format!("{tool_name}: {key_info}");
            if preview.chars().count() > 40 {
                return truncate_chars(&preview, 37);
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
        assert_eq!(preview_text(&parts), "hello");
    }

    #[test]
    fn test_preview_text_long_truncated() {
        let parts = vec![json!({
            "type": "text",
            "text": "this is a very long text that exceeds forty characters easily"
        })];
        let p = preview_text(&parts);
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
        let p = preview_text(&parts);
        assert!(p.contains("read:"), "got: {p}");
        assert!(p.contains("filePath"), "got: {p}");
    }

    #[test]
    fn test_preview_text_utf8_no_panic() {
        // Chinese text exceeding 40 chars to trigger truncation
        let long_text = "这是一个很长的中文文本用来测试截断功能是否正常工作不会崩溃还需要更多字符";
        let parts = vec![json!({"type": "text", "text": long_text})];
        let p = preview_text(&parts);
        assert!(
            p.chars().count() <= 40,
            "expected ≤ 40, got {}: {p}",
            p.chars().count()
        );
    }

    #[test]
    fn test_preview_text_newline_collapsed() {
        let parts = vec![json!({
            "type": "text",
            "text": "line one\nline two\nline three"
        })];
        let p = preview_text(&parts);
        assert!(!p.contains('\n'), "newlines should be collapsed");
        assert!(p.contains(' '));
    }

    #[test]
    fn test_style_text_bold() {
        COLOR.store(true, Ordering::SeqCst);
        let s = Style::new().bold();
        let result = style_text("test", &s);
        assert!(result.contains("\x1b[1m"), "must contain bold ANSI code");
        assert!(result.contains("\x1b[0m"), "must contain reset code");
        assert!(result.contains("test"), "must contain the text");
    }

    #[test]
    fn test_style_text_no_color() {
        COLOR.store(false, Ordering::SeqCst);
        let s = Style::new().bold();
        let result = style_text("test", &s);
        assert_eq!(result, "test");
        // Restore color for other tests
        COLOR.store(true, Ordering::SeqCst);
    }

    #[test]
    fn test_render_segments_to_ansi_plain() {
        let seg = Segment::new("hello", None);
        COLOR.store(false, Ordering::SeqCst);
        let result = render_segments_to_ansi(&[seg]);
        assert_eq!(result, "hello");
        COLOR.store(true, Ordering::SeqCst);
    }
}
