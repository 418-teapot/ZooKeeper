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
fn create_tokens_table(wide: bool) -> Table {
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

    let segs =
        r.get("segments").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let msg_id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let preview = r.get("preview").and_then(|v| v.as_str()).unwrap_or("");

    if wide {
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
    let mut table = create_tokens_table(wide);

    for (idx, r) in rows.iter().enumerate() {
        table.add_row(build_token_row(idx, r, max_tokens, wide, &role_colors));
    }

    render_table(width, &table);
    msg_print(&build_token_stats_summary(rows));
}
