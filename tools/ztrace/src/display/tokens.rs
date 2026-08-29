// ztrace display — tokens command table rendering.

use std::collections::HashMap;

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::text::{JustifyMethod, OverflowMethod, Text};
use serde_json::Value;
use zutil::color::msg_print;
use zutil::get_terminal_width;

use super::common::{fmt_float_int, render_table};

// ── E. Tokens Command ─────────────────────────────────────────────────────────

/// Create the tokens table with column definitions.
fn create_tokens_table(wide: bool, show_model: bool) -> Table {
    let mut table = Table::new()
        .title("Message Token Distribution")
        .box_style(&rich_rust::r#box::ROUNDED);

    table.add_column(
        Column::new("#")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Role").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    if show_model {
        table.add_column(
            Column::new("Model").no_wrap().overflow(OverflowMethod::Ellipsis),
        );
    }
    table.add_column(
        Column::new("Tokens")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Size").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    if wide {
        table.add_column(
            Column::new("Segments")
                .justify(JustifyMethod::Right)
                .no_wrap()
                .overflow(OverflowMethod::Ellipsis),
        );
        table.add_column(
            Column::new("ID").no_wrap().overflow(OverflowMethod::Ellipsis),
        );
        table.add_column(Column::new("Preview"));
    } else {
        table.add_column(
            Column::new("ID").no_wrap().overflow(OverflowMethod::Ellipsis),
        );
    }
    table
}

/// Build a visual token-size bar (20 chars wide, step-based).
fn render_token_bar(ratio: f64) -> String {
    if ratio < 0.02 {
        return "░".repeat(20);
    }
    let bar_width = 20u32;
    let step = 1.0 / f64::from(bar_width);
    let mut bar = String::with_capacity(20);
    for pos in 0..bar_width {
        if ratio >= f64::from(pos + 1) * step {
            bar.push('█');
        } else {
            bar.push('░');
        }
    }
    bar
}

/// Build a single token table row.
fn build_token_row(
    idx: usize,
    r: &Value,
    max_tokens: f64,
    wide: bool,
    show_model: bool,
    role_colors: &HashMap<&str, &str>,
) -> Row {
    let role = r.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
    let color = role_colors.get(role).unwrap_or(&"white");
    let role_text = Text::styled(
        role.to_string(),
        Style::new()
            .color(Color::parse(color).unwrap_or_else(|_| Color::from_ansi(7))),
    );

    let tokens =
        r.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let ratio = if max_tokens > 0.0 { tokens / max_tokens } else { 0.0 };
    let bar = render_token_bar(ratio);

    let model = r
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .map(|m| {
            if m.chars().count() > 24 {
                let truncated: String = m.chars().take(24).collect();
                format!("{truncated}...")
            } else {
                m.to_string()
            }
        })
        .unwrap_or_default();

    let segs =
        r.get("segments").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let msg_id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let preview = r.get("preview").and_then(|v| v.as_str()).unwrap_or("");

    if show_model {
        // # Role Model Tokens Size [Segments] ID [Preview]
        let mut cells = vec![
            Cell::new((idx + 1).to_string()),
            Cell::new(role_text),
            Cell::new(model),
            Cell::new(fmt_float_int(tokens)),
            Cell::new(bar),
        ];
        if wide {
            cells.push(Cell::new(segs.to_string()));
        }
        cells.push(Cell::new(msg_id.to_string()));
        if wide {
            cells.push(Cell::new(preview.to_string()));
        }
        Row::new(cells)
    } else if wide {
        Row::new(vec![
            Cell::new((idx + 1).to_string()),
            Cell::new(role_text),
            Cell::new(fmt_float_int(tokens)),
            Cell::new(bar),
            Cell::new(segs.to_string()),
            Cell::new(msg_id.to_string()),
            Cell::new(preview.to_string()),
        ])
    } else {
        Row::new(vec![
            Cell::new((idx + 1).to_string()),
            Cell::new(role_text),
            Cell::new(fmt_float_int(tokens)),
            Cell::new(bar),
            Cell::new(msg_id.to_string()),
        ])
    }
}

/// Build the formatted stats line for the token table footer.
fn build_token_stats_summary(rows: &[Value]) -> String {
    let total: f64 = rows
        .iter()
        .filter_map(|r| r.get("tokens").and_then(serde_json::Value::as_f64))
        .sum();
    let mut by_role: HashMap<&str, f64> = HashMap::new();
    for r in rows {
        let role = r.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let tokens =
            r.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        *by_role.entry(role).or_insert(0.0) += tokens;
    }

    let mut sorted_rows: Vec<&Value> = rows.iter().collect();
    sorted_rows.sort_by(|a, b| {
        let ta =
            a.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let tb =
            b.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    let largest: Vec<&Value> = sorted_rows.iter().take(3).copied().collect();

    let empty_count = rows
        .iter()
        .filter(|r| {
            r.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
                == 0.0
        })
        .count();

    let avg_tokens = if rows.is_empty() {
        0.0
    } else {
        total / f64::from(u32::try_from(rows.len()).unwrap_or(0))
    };
    let max_tok = rows
        .iter()
        .filter_map(|r| r.get("tokens").and_then(serde_json::Value::as_f64))
        .fold(0.0_f64, f64::max);

    let mut stats_parts: Vec<String> =
        vec![format!("{} {total:.0}", "[bold]Total tokens:[/bold]")];

    let mut role_items: Vec<(&str, f64)> = by_role.into_iter().collect();
    role_items.sort_by(|a, b| a.0.cmp(b.0));
    let breakdown: Vec<String> = role_items
        .iter()
        .map(|(role, count)| format!("{role}: {count:.0}"))
        .collect();
    if !breakdown.is_empty() {
        stats_parts.push(breakdown.join(" | "));
    }

    let top3: Vec<String> = largest
        .iter()
        .map(|r| {
            let t = r
                .get("tokens")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let role = r.get("role").and_then(|v| v.as_str()).unwrap_or("?");
            format!("{t:.0} ({role})")
        })
        .collect();
    stats_parts.push(format!(
        "{} {}",
        "[bold]Largest:[/bold]",
        top3.join(", ")
    ));
    stats_parts.push(format!(
        "{} {avg_tokens:.0} {} {max_tok:.0}",
        "[bold]Avg:[/bold]", "[bold]Max:[/bold]"
    ));
    if empty_count > 0 {
        stats_parts.push(format!("{} {empty_count}", "[bold]Empty:[/bold]"));
    }

    format!("  {}", stats_parts.join("  |  "))
}

/// Render token distribution as a rich table.
///
/// Columns: #, Role, Tokens, Size (bar), Segments (wide mode ≥110 cols),
/// ID, Preview (wide mode).  Role colors: user=green, assistant=blue,
/// `tool_use=magenta`, `tool_result=yellow`.  Bottom stats: total tokens,
/// role breakdown, largest messages.
pub fn render_tokens_table(rows: &[Value]) {
    if rows.is_empty() {
        return;
    }

    let wide = get_terminal_width() >= 110;
    // The Model column appears only when at least one row recorded one.
    let show_model = rows.iter().any(|r| {
        r.get("model").and_then(|v| v.as_str()).is_some_and(|m| !m.is_empty())
    });
    let max_tokens = rows
        .iter()
        .filter_map(|r| r.get("tokens").and_then(serde_json::Value::as_f64))
        .fold(0.0_f64, f64::max);

    let role_colors: HashMap<&str, &str> = [
        ("user", "green"),
        ("assistant", "blue"),
        ("tool_use", "magenta"),
        ("tool_result", "yellow"),
    ]
    .iter()
    .copied()
    .collect();

    let width = get_terminal_width();
    let mut table = create_tokens_table(wide, show_model);

    for (idx, r) in rows.iter().enumerate() {
        table.add_row(build_token_row(
            idx,
            r,
            max_tokens,
            wide,
            show_model,
            &role_colors,
        ));
    }

    render_table(width, &table);
    msg_print(&build_token_stats_summary(rows));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, Number};
    use std::collections::HashMap;

    /// Minimal token-row dict matching the `build_token_rows` key set.
    fn row_value() -> Value {
        let mut m = Map::new();
        m.insert("id".to_string(), Value::String("msg-1".to_string()));
        m.insert("role".to_string(), Value::String("assistant".to_string()));
        m.insert("model".to_string(), Value::String("gpt-4".to_string()));
        m.insert("tokens".to_string(), Value::Number(Number::from(150_u64)));
        m.insert("segments".to_string(), Value::Number(Number::from(2_u64)));
        m.insert(
            "preview".to_string(),
            Value::String("preview text".to_string()),
        );
        Value::Object(m)
    }

    fn role_colors() -> HashMap<&'static str, &'static str> {
        HashMap::from([("assistant", "blue")])
    }

    #[test]
    fn test_build_token_row_cell_count_matches_column_layout() {
        // The row must emit exactly as many cells as `create_tokens_table`
        // declares, in every (wide, show_model) combination. The historical
        // bug: the show_model branch sent 8 cells unconditionally, so a
        // narrow terminal (6 columns: # Role Model Tokens Size ID) had
        // Segments land in the ID column and Preview disappear.
        let cases = [
            (false, false, 5),
            (false, true, 6),
            (true, false, 7),
            (true, true, 8),
        ];
        for (wide, show_model, expected) in cases {
            let row = build_token_row(
                0,
                &row_value(),
                150.0,
                wide,
                show_model,
                &role_colors(),
            );
            assert_eq!(
                row.cells.len(),
                expected,
                "wide={wide} show_model={show_model}"
            );
        }
    }

    #[test]
    fn test_build_token_row_narrow_with_model_places_id_last() {
        // Narrow + model columns: # Role Model Tokens Size ID. The ID cell
        // must be the final cell and hold the real message id — not a
        // segment count shifted in from the wide-only layout.
        let row = build_token_row(
            0,
            &row_value(),
            150.0,
            false,
            true,
            &role_colors(),
        );
        assert_eq!(row.cells.len(), 6);
        assert_eq!(row.cells[5].content.plain(), "msg-1");
        // The model cell sits at index 2, right after the role.
        assert_eq!(row.cells[2].content.plain(), "gpt-4");
    }

    #[test]
    fn test_build_token_row_wide_with_model_places_id_and_preview() {
        // Wide + model columns: # Role Model Tokens Size Segments ID Preview.
        let row =
            build_token_row(0, &row_value(), 150.0, true, true, &role_colors());
        assert_eq!(row.cells.len(), 8);
        assert_eq!(row.cells[5].content.plain(), "2");
        assert_eq!(row.cells[6].content.plain(), "msg-1");
        assert_eq!(row.cells[7].content.plain(), "preview text");
    }
}
