// ztrace display — steps command table rendering.

use std::collections::HashMap;

use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::text::{JustifyMethod, OverflowMethod};
use serde_json::Value;
use zutil::color::msg_print;
use zutil::get_terminal_width;

use crate::helpers::cache_bar;

use super::common::{
    fmt_float_int, format_dur, render_table, truncate_display,
};

// ── D. Steps Command ──────────────────────────────────────────────────────────

/// Create the steps table with column definitions.
fn create_steps_table(show_session: bool) -> Table {
    let mut table = Table::new()
        .title("Step Token Timeline")
        .box_style(&rich_rust::r#box::ROUNDED);

    table.add_column(
        Column::new("Step")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    if show_session {
        table.add_column(
            Column::new("Session").no_wrap().overflow(OverflowMethod::Ellipsis),
        );
    }
    for name in
        ["Cache Read", "Δ Cache", "Input", "Output", "Cache%", "Duration"]
    {
        table.add_column(
            Column::new(name)
                .justify(JustifyMethod::Right)
                .no_wrap()
                .overflow(OverflowMethod::Ellipsis),
        );
    }
    for name in ["Hook Events", "Tools", "Reason"] {
        table.add_column(
            Column::new(name).no_wrap().overflow(OverflowMethod::Ellipsis),
        );
    }
    table
}

/// Format the comma-separated tool list for a step row.
fn format_tools_for_step(s: &Value) -> String {
    s.get("tools")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let names: Vec<&str> =
                arr.iter().filter_map(|v| v.as_str()).collect();
            let mut display = names
                .iter()
                .take(4)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            if names.len() > 4 {
                use std::fmt::Write;
                let _ = write!(display, " +{}", names.len() - 4);
            }
            display
        })
        .unwrap_or_default()
}

/// Build a single row for the steps table from one step value.
fn build_step_row(
    s: &Value,
    show_session: bool,
    hook_overlays: &HashMap<i64, Vec<String>>,
) -> Row {
    let di = s
        .get("_display_index")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let sid_label = s.get("_session_id").and_then(|v| v.as_str()).unwrap_or("");
    let sid_short = if show_session && !sid_label.is_empty() {
        if sid_label.len() > 14 {
            format!("{}..", &sid_label[..12])
        } else {
            sid_label.to_string()
        }
    } else {
        String::new()
    };

    let cache_read =
        s.get("cache_read").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let delta =
        s.get("delta_cache").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let input_tokens = s
        .get("input_tokens")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let output_tokens = s
        .get("output_tokens")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let cache_pct =
        s.get("cache_pct").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let duration =
        s.get("duration").and_then(serde_json::Value::as_f64).unwrap_or(0.0);

    let delta_text = if delta > 0.0 {
        Cell::from_markup(&format!("[green]{delta:+.0}[/green]"))
    } else if delta < 0.0 {
        Cell::from_markup(&format!("[red]{delta:.0}[/red]"))
    } else {
        Cell::new("0".to_string())
    };

    let pct_color = if cache_pct >= 80.0 {
        "green"
    } else if cache_pct >= 50.0 {
        "yellow"
    } else {
        "red"
    };
    let pct_str = format!("{cache_pct:>7.2}%");
    let bar = cache_bar(cache_pct, 20);
    let pct_display = Cell::from_markup(&format!(
        "[{pct_color}]{pct_str} {bar}[/{pct_color}]"
    ));

    let dur_str = format_dur(duration);

    let hooks = hook_overlays.get(&di);
    let hook_str = hooks
        .map(|v| {
            let mut seen: Vec<&str> = Vec::new();
            for h in v {
                if !seen.contains(&h.as_str()) {
                    seen.push(h);
                }
            }
            truncate_display(&seen.join(", "), 20)
        })
        .unwrap_or_default();

    let tools = format_tools_for_step(s);

    let reason = s.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    let reason_str = if reason.is_empty() {
        String::new()
    } else {
        truncate_display(reason, 16)
    };

    let mut row_cells: Vec<Cell> = vec![Cell::new(di.to_string())];
    if show_session {
        row_cells.push(Cell::new(sid_short));
    }
    row_cells.extend(vec![
        Cell::new(fmt_float_int(cache_read)),
        delta_text,
        Cell::new(fmt_float_int(input_tokens)),
        Cell::new(fmt_float_int(output_tokens)),
        pct_display,
        Cell::new(dur_str),
        Cell::new(hook_str),
        Cell::new(tools),
        Cell::new(reason_str),
    ]);
    Row::new(row_cells)
}

/// Build the summary row for the steps table.
fn build_steps_summary_row(
    steps: &[Value],
    hook_overlays: &HashMap<i64, Vec<String>>,
    show_session: bool,
) -> Row {
    let total_input: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("input_tokens").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_output: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("output_tokens").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_cache_delta: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("delta_cache").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let step_count = f64::from(u32::try_from(steps.len()).unwrap_or(0));
    let avg_hit: f64 = if steps.is_empty() {
        0.0
    } else {
        steps
            .iter()
            .filter_map(|s| {
                s.get("cache_pct").and_then(serde_json::Value::as_f64)
            })
            .sum::<f64>()
            / step_count
    };
    let total_dur: f64 = steps
        .iter()
        .filter_map(|s| s.get("duration").and_then(serde_json::Value::as_f64))
        .sum();
    let total_hooks: usize =
        hook_overlays.values().map(std::vec::Vec::len).sum();
    let total_tools: usize = steps
        .iter()
        .filter_map(|s| s.get("tools").and_then(|v| v.as_array()))
        .map(std::vec::Vec::len)
        .sum();

    let total_dur_str = format_dur(total_dur);

    let delta_summary = if total_cache_delta > 0.0 {
        Cell::from_markup(&format!("[green]{total_cache_delta:+.0}[/green]"))
    } else if total_cache_delta < 0.0 {
        Cell::from_markup(&format!("[red]{total_cache_delta:.0}[/red]"))
    } else {
        Cell::new("0".to_string())
    };

    let mut summary_cells: Vec<Cell> =
        vec![Cell::from_markup("[bold]Total[/bold]")];
    if show_session {
        summary_cells.push(Cell::new(String::new()));
    }
    summary_cells.extend(vec![
        Cell::new(String::new()),
        delta_summary,
        Cell::new(format!("{total_input:.0}")),
        Cell::new(format!("{total_output:.0}")),
        Cell::new(format!("{avg_hit:.2}%")),
        Cell::new(total_dur_str),
        Cell::new(total_hooks.to_string()),
        Cell::new(total_tools.to_string()),
        Cell::new(String::new()),
    ]);
    Row::new(summary_cells)
}

/// Render steps data as a rich table.
///
/// Columns: Step, Session (if multiple), Cache Read, Δ Cache, Input, Output,
/// Cache%, Duration, Hook Events, Tools, Reason.
/// Cache% includes a visual bar. Δ Cache colored green/red.
/// Summary row at bottom.
pub fn render_steps_table(
    steps: &[Value],
    hook_overlays: &HashMap<i64, Vec<String>>,
) {
    if steps.is_empty() {
        msg_print("[yellow]No steps to display after filtering.[/yellow]");
        return;
    }

    let unique_sids: std::collections::HashSet<&str> = steps
        .iter()
        .filter_map(|s| s.get("_session_id").and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .collect();
    let show_session = unique_sids.len() > 1;

    let width = get_terminal_width();
    let mut table = create_steps_table(show_session);

    for s in steps {
        table.add_row(build_step_row(s, show_session, hook_overlays));
    }

    table.add_row(build_steps_summary_row(steps, hook_overlays, show_session));
    render_table(width, &table);
}
