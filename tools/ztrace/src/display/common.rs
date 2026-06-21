// ztrace display — shared rendering helpers.

use rich_rust::color::Color;
use rich_rust::renderables::panel::Panel;
use rich_rust::renderables::table::Table;
use rich_rust::style::Style;
use zutil::color::render_segments_to_ansi;
use zutil::display_width;
use zutil::truncate_width;

// ── Formatting ────────────────────────────────────────────────────────────────

/// Format a non-negative f64 as comma-separated integer string.
/// Avoids f64→integer casts by formatting via `{:.0}` then adding commas.
pub fn fmt_float_int(v: f64) -> String {
    if v <= 0.0 {
        return "0".to_string();
    }
    let s = format!("{v:.0}");
    let mut result = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

// ── TYPE_STYLES ───────────────────────────────────────────────────────────────

/// Map event type names to display colors.
/// Uses standard ANSI (0-15) or named 256-color parseable names.
pub fn type_color(etype: &str) -> Color {
    match etype {
        "session" => Color::from_ansi(2), // green
        "llm" | "llm_stream" => Color::from_ansi(4), // blue
        "permission" | "tool_exec" => {
            Color::parse("orange1").unwrap_or_else(|_| Color::from_ansi(3)) // orange1
        }
        "tool_read" => Color::from_ansi(14), // bright_cyan
        "tool_write" | "file" => Color::from_ansi(5), // magenta
        "tool_orch" => Color::from_ansi(10), // bright_green
        "tool_other" => Color::from_ansi(3), // yellow
        "hook" => Color::from_ansi(6),       // cyan
        _ => Color::from_ansi(7),            // white
    }
}

pub fn type_style(etype: &str) -> Style {
    Style::new().color(type_color(etype))
}

// ── Agent color map ───────────────────────────────────────────────────────────

pub fn agent_color(agent: &str) -> Color {
    match agent {
        "explore" => Color::from_ansi(6), // cyan
        "general" => Color::from_ansi(5), // magenta
        "build" => Color::from_ansi(4),   // blue
        _ => Color::from_ansi(2),         // green (default)
    }
}

pub fn agent_style(agent: &str) -> Style {
    Style::new().color(agent_color(agent))
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/// Pad string to exact display width using `display_width`.
pub fn pad(s: &str, width: usize) -> String {
    let current = display_width(s);
    let mut result = s.to_string();
    result.push_str(&" ".repeat(width.saturating_sub(current)));
    result
}

/// Truncate text to fit within `max_cols` display columns.
pub fn truncate_display(text: &str, max_cols: usize) -> String {
    if text.is_empty() || max_cols < 4 {
        return if max_cols > 0 {
            text.chars().take(max_cols).collect()
        } else {
            String::new()
        };
    }
    if display_width(text) <= max_cols {
        return text.to_string();
    }
    // Use zutil's truncate_width
    truncate_width(text, max_cols)
}

/// Format duration seconds to human string.
pub fn format_dur(dur_sec: f64) -> String {
    if dur_sec >= 60.0 {
        let mins = (dur_sec / 60.0).floor();
        let remain = dur_sec - mins * 60.0;
        format!("{mins:.0}m{remain:.0}s")
    } else {
        format!("{dur_sec:.1}s")
    }
}

/// Print a terminal-width table.
pub fn render_table(width: usize, table: &Table) {
    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
}

/// Print a terminal-width panel.
pub fn render_panel(width: usize, panel: &Panel) {
    let segments = panel.render(width);
    println!("{}", render_segments_to_ansi(&segments));
}
