use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use rich_rust::color::ColorSystem;
use rich_rust::console::Console;
use rich_rust::segment::Segment;
use rich_rust::style::Style;

/// Global flag: whether ANSI color output is enabled.
pub static COLOR: AtomicBool = AtomicBool::new(true);

/// Console instance for markup-based printing (`[bold]`, `[green]`, etc.).
pub static MSG_CONSOLE: LazyLock<Console> = LazyLock::new(|| {
    Console::builder().color_system(ColorSystem::TrueColor).build()
});

/// Apply a `Style` to text, returning an ANSI-colored string
/// (or plain text when `--no-color` is active).
#[must_use]
pub fn style_text(text: &str, style: &Style) -> String {
    if !COLOR.load(Ordering::SeqCst) {
        return text.to_string();
    }
    style.render(text, ColorSystem::TrueColor)
}

/// Convert `rich_rust` segments to an ANSI-colored string.
#[must_use]
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

/// Print a line with rich markup syntax, falling back to plain text
/// when `COLOR` is disabled (stripping `[bold]` etc. tags).
pub fn msg_print(text: &str) {
    if COLOR.load(Ordering::SeqCst) {
        MSG_CONSOLE.print(text);
    } else {
        // Strip all rich markup tags: [tag] and [/tag]
        let mut plain = String::with_capacity(text.len());
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '[' {
                let start = i;
                i += 1;
                // Skip '/' if closing tag
                if i < chars.len() && chars[i] == '/' {
                    i += 1;
                }
                let j = i;
                while i < chars.len() && chars[i].is_ascii_alphanumeric() {
                    i += 1;
                }
                if i < chars.len() && chars[i] == ']' && i > j {
                    i += 1; // valid tag, skip entire [tag]
                    continue;
                }
                // Not a valid tag, flush from start
                plain.push('[');
                i = start + 1;
            } else {
                plain.push(chars[i]);
                i += 1;
            }
        }
        println!("{plain}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialize tests that mutate the shared `COLOR` global,
    /// recovering from a poisoned mutex if a prior test panicked.
    static TEST_MUTEX: Mutex<()> = Mutex::new(());

    fn acquire_lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn test_style_text_bold() {
        let _lock = acquire_lock();
        COLOR.store(true, Ordering::SeqCst);
        let s = Style::new().bold();
        let result = style_text("test", &s);
        assert!(result.contains("\x1b[1m"), "must contain bold ANSI code");
        assert!(result.contains("\x1b[0m"), "must contain reset code");
        assert!(result.contains("test"), "must contain the text");
    }

    #[test]
    fn test_style_text_no_color() {
        let _lock = acquire_lock();
        COLOR.store(false, Ordering::SeqCst);
        let s = Style::new().bold();
        let result = style_text("test", &s);
        assert_eq!(result, "test");
        COLOR.store(true, Ordering::SeqCst);
    }

    #[test]
    fn test_render_segments_to_ansi_plain() {
        let _lock = acquire_lock();
        let seg = Segment::new("hello", None);
        COLOR.store(false, Ordering::SeqCst);
        let result = render_segments_to_ansi(&[seg]);
        assert_eq!(result, "hello");
        COLOR.store(true, Ordering::SeqCst);
    }
}
