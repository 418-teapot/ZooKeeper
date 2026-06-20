use std::collections::{BTreeMap, HashMap};

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::terminal;
use rich_rust::text::{JustifyMethod, Text};

use serde_json::{Value, json};

use zutil::color::{msg_print, render_segments_to_ansi};

use crate::helpers::{
    cache_hit_rate, format_details, format_duration, hit_rate_bar,
    shorten_timestamp,
};

// ── Level Styles ───────────────────────────────────────────────────────────────

/// Map level names to `rich_rust` styles.
fn level_style(level: &str) -> Style {
    match level {
        "info" => Style::new().color(Color::from_ansi(2)),
        "debug" => Style::new().dim(),
        "warn" => Style::new().color(Color::from_ansi(3)),
        "error" => Style::new().color(Color::from_ansi(1)),
        "fatal" => Style::new().color(Color::from_ansi(1)).bold(),
        _ => Style::new(),
    }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/// Format a JSON value to stdout with a trailing newline.
fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("JSON serialization")
    );
}

/// Build JSON value for a token summary (pure, no I/O).
#[expect(clippy::cast_precision_loss)]
pub fn build_json_token_summary(steps: &[Value]) -> Value {
    if steps.is_empty() {
        return json!({"error": "No step data found"});
    }

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
    let total_cache_read: f64 = steps
        .iter()
        .filter_map(|s| s.get("cache_read").and_then(serde_json::Value::as_f64))
        .sum();
    let total_cache_write: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("cache_write").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_cost: f64 = steps
        .iter()
        .filter_map(|s| s.get("cost").and_then(serde_json::Value::as_f64))
        .sum();
    let n = steps.len();
    let avg_input = if n > 0 { total_input / n as f64 } else { 0.0 };
    let avg_output = if n > 0 { total_output / n as f64 } else { 0.0 };
    let hit_rate = cache_hit_rate(total_cache_read, total_input);

    json!({
        "total_input": total_input,
        "total_output": total_output,
        "total_cache_read": total_cache_read,
        "total_cache_write": total_cache_write,
        "avg_input_per_turn": (avg_input * 10.0).round() / 10.0,
        "avg_output_per_turn": (avg_output * 10.0).round() / 10.0,
        "cache_hit_rate": (hit_rate * 100.0).round() / 100.0,
        "est_cost": (total_cost * 10_000.0).round() / 10_000.0,
        "num_steps": n,
    })
}

/// Build JSON value for hook breakdown (pure, no I/O).
pub fn build_json_hook_breakdown(events: &[Value], session_id: &str) -> Value {
    let mut hook_counts: HashMap<&str, i64> = HashMap::new();
    let mut hook_event_map: HashMap<&str, HashMap<&str, i64>> = HashMap::new();

    for event in events {
        let hook =
            event.get("hook").and_then(|v| v.as_str()).unwrap_or("unknown");
        let evt =
            event.get("event").and_then(|v| v.as_str()).unwrap_or("unknown");
        *hook_counts.entry(hook).or_insert(0) += 1;
        hook_event_map
            .entry(hook)
            .or_default()
            .entry(evt)
            .and_modify(|c| *c += 1)
            .or_insert(1);
    }

    let mut breakdown = serde_json::Map::new();
    let mut hook_order: Vec<&str> = hook_counts.keys().copied().collect();
    hook_order.sort_by(|a, b| hook_counts[b].cmp(&hook_counts[a]));

    for hook in hook_order {
        let count = hook_counts[hook];
        let events_map = &hook_event_map[hook];
        let mut evt_obj = serde_json::Map::new();
        let mut evt_order: Vec<&str> = events_map.keys().copied().collect();
        evt_order.sort_by(|a, b| events_map[b].cmp(&events_map[a]));
        for evt in evt_order {
            evt_obj.insert(evt.to_string(), json!(events_map[evt]));
        }
        breakdown.insert(
            hook.to_string(),
            json!({
                "count": count,
                "events": evt_obj,
            }),
        );
    }

    json!({
        "session_id": session_id,
        "hook_breakdown": breakdown,
    })
}

/// Build full session stats as a JSON value (pure, no I/O).
#[allow(clippy::too_many_lines, clippy::cast_precision_loss)]
pub fn build_json_full_stats(
    events: &[Value],
    steps: &[Value],
    path: &str,
    session_id: &str,
) -> Value {
    let total = events.len();
    let time_span = compute_time_span(events);

    let mut active_session_ids: Vec<&str> = events
        .iter()
        .filter_map(|e| e.get("sessionId").and_then(|v| v.as_str()))
        .filter(|sid| !sid.is_empty())
        .collect();
    active_session_ids.sort_unstable();
    active_session_ids.dedup();

    // Level counts
    let mut level_counts: HashMap<&str, i64> = HashMap::new();
    for event in events {
        let level =
            event.get("level").and_then(|v| v.as_str()).unwrap_or("unknown");
        *level_counts.entry(level).or_insert(0) += 1;
    }

    // Hook breakdown
    let mut hook_counts: HashMap<&str, i64> = HashMap::new();
    let mut hook_event_map: HashMap<&str, HashMap<&str, i64>> = HashMap::new();
    for event in events {
        let hook =
            event.get("hook").and_then(|v| v.as_str()).unwrap_or("unknown");
        let evt =
            event.get("event").and_then(|v| v.as_str()).unwrap_or("unknown");
        *hook_counts.entry(hook).or_insert(0) += 1;
        hook_event_map
            .entry(hook)
            .or_default()
            .entry(evt)
            .and_modify(|c| *c += 1)
            .or_insert(1);
    }

    // Build breakdown JSON
    let mut breakdown = serde_json::Map::new();
    let mut hook_order: Vec<&str> = hook_counts.keys().copied().collect();
    hook_order.sort_by(|a, b| hook_counts[b].cmp(&hook_counts[a]));
    for hook in hook_order {
        let count = hook_counts[hook];
        let evt_map = &hook_event_map[hook];
        let mut evt_obj = serde_json::Map::new();
        let mut evt_order: Vec<&str> = evt_map.keys().copied().collect();
        evt_order.sort_by(|a, b| evt_map[b].cmp(&evt_map[a]));
        for evt in evt_order {
            evt_obj.insert(evt.to_string(), json!(evt_map[evt]));
        }
        breakdown.insert(
            hook.to_string(),
            json!({
                "count": count,
                "events": evt_obj,
            }),
        );
    }

    // Token summary (if steps exist)
    let token_summary = if steps.is_empty() {
        json!(null)
    } else {
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
        let total_cache_read: f64 = steps
            .iter()
            .filter_map(|s| {
                s.get("cache_read").and_then(serde_json::Value::as_f64)
            })
            .sum();
        let total_cache_write: f64 = steps
            .iter()
            .filter_map(|s| {
                s.get("cache_write").and_then(serde_json::Value::as_f64)
            })
            .sum();
        let total_cost: f64 = steps
            .iter()
            .filter_map(|s| s.get("cost").and_then(serde_json::Value::as_f64))
            .sum();
        let n = steps.len();
        let avg_input = if n > 0 { total_input / n as f64 } else { 0.0 };
        let avg_output = if n > 0 { total_output / n as f64 } else { 0.0 };
        let hit_rate = cache_hit_rate(total_cache_read, total_input);

        json!({
            "total_input": total_input,
            "total_output": total_output,
            "total_cache_read": total_cache_read,
            "total_cache_write": total_cache_write,
            "avg_input_per_turn": (avg_input * 10.0).round() / 10.0,
            "avg_output_per_turn": (avg_output * 10.0).round() / 10.0,
            "cache_hit_rate": (hit_rate * 100.0).round() / 100.0,
            "est_cost": (total_cost * 10_000.0).round() / 10_000.0,
            "num_steps": n,
        })
    };

    let json_levels = json!({
        "info": level_counts.get("info").copied().unwrap_or(0),
        "debug": level_counts.get("debug").copied().unwrap_or(0),
        "warn": level_counts.get("warn").copied().unwrap_or(0),
        "error": level_counts.get("error").copied().unwrap_or(0),
    });

    json!({
        "session_id": session_id,
        "file": path,
        "total_events": total,
        "time_span": if time_span.is_empty() { Value::Null } else { Value::String(time_span) },
        "active_session_ids": if active_session_ids.is_empty() { Value::Null } else { Value::Array(active_session_ids.iter().map(|s| Value::String(s.to_string())).collect()) },
        "level_distribution": json_levels,
        "hook_breakdown": breakdown,
        "token_summary": token_summary,
    })
}

/// Build cross-session token summary as a JSON value (pure, no I/O).
#[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn build_json_multi_stats(
    sessions_data: &[Value],
    totals: &Value,
) -> Value {
    let total_hit_rate = {
        let input = totals
            .get("input")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let cache_read = totals
            .get("cache_read")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        (cache_hit_rate(cache_read, input) * 100.0).round() / 100.0
    };

    json!({
        "sessions": sessions_data,
        "total": {
            "input": totals.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as u64,
            "output": totals.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as u64,
            "cache_read": totals.get("cache_read").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as u64,
            "hit_rate": total_hit_rate,
            "cost": (totals.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0) * 10_000.0).round() / 10_000.0,
            "hook_events": totals.get("hook_events").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as u64,
        },
    })
}

/// Compute the time span string from a sorted slice of events.
fn compute_time_span(events: &[Value]) -> String {
    let timestamps: Vec<&str> = events
        .iter()
        .filter_map(|e| e.get("timestamp").and_then(|v| v.as_str()))
        .filter(|ts| !ts.is_empty())
        .collect();

    if timestamps.len() < 2 {
        return String::new();
    }

    let parse_ts = |ts: &str| -> Option<chrono::NaiveDateTime> {
        let clean = ts.replace('Z', "").replace("+00:00", "");
        let clean = clean.split('.').next().unwrap_or(&clean);
        chrono::NaiveDateTime::parse_from_str(clean, "%Y-%m-%dT%H:%M:%S").ok()
    };

    match (parse_ts(timestamps[0]), parse_ts(timestamps[timestamps.len() - 1]))
    {
        (Some(first), Some(last)) => {
            let duration = last.signed_duration_since(first);
            format!(
                "{} \u{2192} {} ({})",
                first.format("%Y-%m-%d %H:%M:%S"),
                last.format("%Y-%m-%d %H:%M:%S"),
                format_duration(duration.num_seconds()),
            )
        }
        _ => "N/A".to_string(),
    }
}

/// Render a table to stdout using ANSI segments.
fn render_table(width: usize, table: &Table) {
    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
}

// ── Single-session Stats ───────────────────────────────────────────────────────

/// Print token summary as JSON.
pub fn print_json_token_summary(steps: &[Value]) {
    print_json(&build_json_token_summary(steps));
}

/// Print token summary as a rich table.
#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn print_token_summary_table(steps: &[Value]) {
    if steps.is_empty() {
        msg_print("");
        msg_print("[yellow]No step data found for this session.[/yellow]");
        return;
    }

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
    let total_cache_read: f64 = steps
        .iter()
        .filter_map(|s| s.get("cache_read").and_then(serde_json::Value::as_f64))
        .sum();
    let total_cache_write: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("cache_write").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_cost: f64 = steps
        .iter()
        .filter_map(|s| s.get("cost").and_then(serde_json::Value::as_f64))
        .sum();
    let n = steps.len();
    let avg_input = if n > 0 { total_input / n as f64 } else { 0.0 };
    let avg_output = if n > 0 { total_output / n as f64 } else { 0.0 };
    let hit_rate = cache_hit_rate(total_cache_read, total_input);
    let denom = (total_input + total_cache_read) as u64;

    let width = terminal::get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Metric"));
    table.add_column(Column::new("Value").justify(JustifyMethod::Right));
    let rows: [(&str, String); 8] = [
        ("Total input tokens", total_input.to_string()),
        ("Total output tokens", total_output.to_string()),
        ("Total cache read", total_cache_read.to_string()),
        ("Total cache write", total_cache_write.to_string()),
        ("Avg input / turn", format!("{avg_input:.1}")),
        ("Avg output / turn", format!("{avg_output:.1}")),
        (
            "Cache hit rate",
            format!("{hit_rate:.2}% ({total_cache_read} / {denom})"),
        ),
        ("Est. cost", format!("${total_cost:.4}")),
    ];
    for (metric, value) in &rows {
        table.add_row(Row::new(vec![
            Cell::new(*metric),
            Cell::new(value.as_str()),
        ]));
    }

    render_table(width, &table);
}

/// Print hook breakdown as JSON.
pub fn print_json_hook_breakdown(events: &[Value], session_id: &str) {
    print_json(&build_json_hook_breakdown(events, session_id));
}

/// Print hook breakdown as a rich table.
pub fn print_hook_breakdown_table(events: &[Value], _session_id: &str) {
    let mut hook_counts: HashMap<&str, i64> = HashMap::new();
    let mut hook_event_map: HashMap<&str, HashMap<&str, i64>> = HashMap::new();

    for event in events {
        let hook =
            event.get("hook").and_then(|v| v.as_str()).unwrap_or("unknown");
        let evt =
            event.get("event").and_then(|v| v.as_str()).unwrap_or("unknown");
        *hook_counts.entry(hook).or_insert(0) += 1;
        hook_event_map
            .entry(hook)
            .or_default()
            .entry(evt)
            .and_modify(|c| *c += 1)
            .or_insert(1);
    }

    let width = terminal::get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Hook"));
    table.add_column(Column::new("Count").justify(JustifyMethod::Right));
    table.add_column(Column::new("Events"));

    let mut hook_order: Vec<&str> = hook_counts.keys().copied().collect();
    hook_order.sort_by(|a, b| hook_counts[b].cmp(&hook_counts[a]));

    for hook in hook_order {
        let count = hook_counts[hook];
        let evt_map = &hook_event_map[hook];
        let mut evt_order: Vec<&str> = evt_map.keys().copied().collect();
        evt_order.sort_by(|a, b| evt_map[b].cmp(&evt_map[a]));
        let detail: Vec<String> = evt_order
            .iter()
            .map(|evt| format!("{}:{}", evt, evt_map[evt]))
            .collect();
        let detail_str = detail.join(", ");
        table.add_row(Row::new(vec![
            Cell::new(hook),
            Cell::new(count.to_string()),
            Cell::new(detail_str),
        ]));
    }

    render_table(width, &table);
}

/// Print full session stats as JSON.
pub fn print_json_full_stats(
    events: &[Value],
    steps: &[Value],
    path: &str,
    session_id: &str,
) {
    print_json(&build_json_full_stats(events, steps, path, session_id));
}

/// Print full session stats as rich output.
#[allow(
    clippy::too_many_lines,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn print_full_stats(
    events: &[Value],
    steps: &[Value],
    path: &str,
    session_id: &str,
) {
    let total = events.len();
    let time_span = compute_time_span(events);

    let mut active_session_ids: Vec<&str> = events
        .iter()
        .filter_map(|e| e.get("sessionId").and_then(|v| v.as_str()))
        .filter(|sid| !sid.is_empty())
        .collect();
    active_session_ids.sort_unstable();
    active_session_ids.dedup();

    // ── Header ─────────────────────────────────────────────────────────
    msg_print(&format!(
        "\n[bold]Stats for session:[/bold] [cyan]{session_id}[/cyan]"
    ));
    msg_print(&format!("[dim]File: {path}[/dim]"));
    msg_print(&format!("[bold]Total events: {total}[/bold]"));
    if time_span.is_empty() {
        msg_print("Time span: N/A");
    } else {
        msg_print(&format!("Time span: {time_span}"));
    }
    if !active_session_ids.is_empty() {
        let sids = active_session_ids.join(", ");
        msg_print(&format!("Active session IDs: [green]{sids}[/green]"));
    }

    // ── Token Summary ──────────────────────────────────────────────────
    if !steps.is_empty() {
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
        let total_cache_read: f64 = steps
            .iter()
            .filter_map(|s| {
                s.get("cache_read").and_then(serde_json::Value::as_f64)
            })
            .sum();
        let total_cache_write: f64 = steps
            .iter()
            .filter_map(|s| {
                s.get("cache_write").and_then(serde_json::Value::as_f64)
            })
            .sum();
        let total_cost: f64 = steps
            .iter()
            .filter_map(|s| s.get("cost").and_then(serde_json::Value::as_f64))
            .sum();
        let n = steps.len();
        let avg_input = if n > 0 { total_input / n as f64 } else { 0.0 };
        let avg_output = if n > 0 { total_output / n as f64 } else { 0.0 };
        let hit_rate = cache_hit_rate(total_cache_read, total_input);
        let denom = (total_input + total_cache_read) as u64;

        let width = terminal::get_terminal_width();
        let mut tok_table =
            Table::new().show_header(true).show_edge(true).show_lines(false);
        tok_table.add_column(Column::new("Metric"));
        tok_table
            .add_column(Column::new("Value").justify(JustifyMethod::Right));
        let tok_rows: [(&str, String); 8] = [
            ("Total input tokens", total_input.to_string()),
            ("Total output tokens", total_output.to_string()),
            ("Total cache read", total_cache_read.to_string()),
            ("Total cache write", total_cache_write.to_string()),
            ("Avg input / turn", format!("{avg_input:.1}")),
            ("Avg output / turn", format!("{avg_output:.1}")),
            (
                "Cache hit rate",
                format!("{hit_rate:.2}% ({total_cache_read} / {denom})"),
            ),
            ("Est. cost", format!("${total_cost:.4}")),
        ];
        for (metric, value) in &tok_rows {
            tok_table.add_row(Row::new(vec![
                Cell::new(*metric),
                Cell::new(value.as_str()),
            ]));
        }
        render_table(width, &tok_table);
    }

    // ── Level Distribution ─────────────────────────────────────────────
    let mut level_counts: HashMap<&str, i64> = HashMap::new();
    for event in events {
        let level =
            event.get("level").and_then(|v| v.as_str()).unwrap_or("unknown");
        *level_counts.entry(level).or_insert(0) += 1;
    }

    let width = terminal::get_terminal_width();
    let mut level_table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    level_table.add_column(Column::new("Level"));
    level_table.add_column(Column::new("Count").justify(JustifyMethod::Right));

    let level_order = ["info", "debug", "warn", "error", "fatal"];
    for level in &level_order {
        let count = level_counts.get(level).copied().unwrap_or(0);
        let lvl_style = level_style(level);
        level_table.add_row(Row::new(vec![
            Cell::new(Text::styled(level.to_string(), lvl_style)),
            Cell::new(count.to_string()),
        ]));
    }

    render_table(width, &level_table);

    // ── Hook Breakdown ─────────────────────────────────────────────────
    let mut hook_counts: HashMap<&str, i64> = HashMap::new();
    let mut hook_event_map: HashMap<&str, HashMap<&str, i64>> = HashMap::new();
    for event in events {
        let hook =
            event.get("hook").and_then(|v| v.as_str()).unwrap_or("unknown");
        let evt =
            event.get("event").and_then(|v| v.as_str()).unwrap_or("unknown");
        *hook_counts.entry(hook).or_insert(0) += 1;
        hook_event_map
            .entry(hook)
            .or_default()
            .entry(evt)
            .and_modify(|c| *c += 1)
            .or_insert(1);
    }

    let width = terminal::get_terminal_width();
    let mut hook_table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    hook_table.add_column(Column::new("Hook"));
    hook_table.add_column(Column::new("Count").justify(JustifyMethod::Right));
    hook_table.add_column(Column::new("Events"));

    let mut hook_order: Vec<&str> = hook_counts.keys().copied().collect();
    hook_order.sort_by(|a, b| hook_counts[b].cmp(&hook_counts[a]));
    for hook in hook_order {
        let count = hook_counts[hook];
        let evt_map = &hook_event_map[hook];
        let mut evt_order: Vec<&str> = evt_map.keys().copied().collect();
        evt_order.sort_by(|a, b| evt_map[b].cmp(&evt_map[a]));
        let detail: Vec<String> = evt_order
            .iter()
            .map(|evt| format!("{}:{}", evt, evt_map[evt]))
            .collect();
        let detail_str = detail.join(", ");
        hook_table.add_row(Row::new(vec![
            Cell::new(hook),
            Cell::new(count.to_string()),
            Cell::new(detail_str),
        ]));
    }

    render_table(width, &hook_table);
}

// ── Multi-session Stats ────────────────────────────────────────────────────────

/// Print cross-session token summary as JSON.
pub fn print_json_multi_stats(sessions_data: &[Value], totals: &Value) {
    print_json(&build_json_multi_stats(sessions_data, totals));
}

/// Print cross-session token summary as a rich table.
#[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn print_multi_stats_table(
    sessions_data: &[Value],
    totals: &Value,
    n: i64,
) {
    let bold = Style::new().bold();
    let total_hit_rate = {
        let input = totals
            .get("input")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let cache_read = totals
            .get("cache_read")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        cache_hit_rate(cache_read, input)
    };
    let totals_input =
        totals.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
            as u64;
    let totals_output =
        totals.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
            as u64;
    let totals_cost =
        totals.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let totals_hook = totals
        .get("hook_events")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0) as u64;

    let width = terminal::get_terminal_width();
    let mut table = Table::new()
        .title(format!("Cross-Session Token Summary (last {n} sessions)"))
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(Column::new("Session ID").no_wrap().min_width(32));
    table.add_column(
        Column::new("Input").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Output").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Hit Rate").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Cost").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Hook Events").justify(JustifyMethod::Right).no_wrap(),
    );

    for s in sessions_data {
        let sid = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let inp =
            s.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
                as u64;
        let out =
            s.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
                as u64;
        let hr = s
            .get("hit_rate")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let cost =
            s.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let hook = s
            .get("hook_events")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0) as u64;

        table.add_row(Row::new(vec![
            Cell::new(sid),
            Cell::new(inp.to_string()),
            Cell::new(out.to_string()),
            Cell::new(format!("{hr:.2}%")),
            Cell::new(format!("${cost:.4}")),
            Cell::new(hook.to_string()),
        ]));
    }

    // Bold total row
    table.add_row(Row::new(vec![
        Cell::new(Text::styled("Total".to_string(), bold.clone())),
        Cell::new(totals_input.to_string()),
        Cell::new(totals_output.to_string()),
        Cell::new(Text::styled(format!("{total_hit_rate:.2}%"), bold.clone())),
        Cell::new(Text::styled(format!("${totals_cost:.4}"), bold)),
        Cell::new(totals_hook.to_string()),
    ]));

    render_table(width, &table);
}

// ── Timeline ───────────────────────────────────────────────────────────────────

/// Print a timeline table of events for a session.
pub fn print_timeline_table(events: &[Value], session_id: &str, is_all: bool) {
    if events.is_empty() {
        msg_print("");
        msg_print("[yellow]No events found in log file.[/yellow]");
        return;
    }

    let max_rows: usize = 30;
    let total = events.len();
    let display_events: &[Value] = if !is_all && total > max_rows {
        msg_print(&format!(
            "[yellow]Showing first {max_rows} of {total} events \
             (use --all to see all)[/yellow]"
        ));
        &events[..max_rows]
    } else {
        events
    };

    let cyan = Style::new().color(Color::from_ansi(6));

    let width = terminal::get_terminal_width();
    let mut table = Table::new()
        .title(format!("Timeline: {session_id}"))
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(Column::new("Time").no_wrap().min_width(8));
    table.add_column(Column::new("Level").no_wrap().min_width(5));
    table.add_column(Column::new("Hook").no_wrap().min_width(16));
    table.add_column(Column::new("Event").no_wrap().min_width(14));
    table.add_column(Column::new("Details"));

    for event in display_events {
        let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let time_str = shorten_timestamp(ts);

        let level =
            event.get("level").and_then(|v| v.as_str()).unwrap_or("info");
        let level_sty = level_style(level);

        let hook = event.get("hook").and_then(|v| v.as_str()).unwrap_or("");
        let evt = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let details = format_details(event);

        table.add_row(Row::new(vec![
            Cell::new(Text::styled(time_str, cyan.clone())),
            Cell::new(Text::styled(level.to_string(), level_sty)),
            Cell::new(hook.to_string()),
            Cell::new(evt.to_string()),
            Cell::new(details),
        ]));
    }

    render_table(width, &table);
}

// ── Impact ─────────────────────────────────────────────────────────────────────

/// Print impact analysis result as JSON.
pub fn print_json_impact(result: &Value) {
    print_json(result);
}

/// Print the hook-by-hook aggregation table.
///
/// `analysis` maps hook names to per-trigger entries, where each entry contains
/// `session_id`, `timestamp`, `before`, `after`, `n_before`, `n_after`.
#[expect(clippy::cast_precision_loss)]
pub fn print_impact_aggregation(analysis: &HashMap<String, Vec<Value>>) {
    let width = terminal::get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Hook").no_wrap().min_width(16));
    table.add_column(
        Column::new("Triggers").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Avg Before").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Avg After").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("\u{0394}").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Correlated Steps").justify(JustifyMethod::Right).no_wrap(),
    );

    let mut hook_names: Vec<&String> = analysis.keys().collect();
    hook_names.sort();

    for hook_name in &hook_names {
        let triggers = &analysis[*hook_name];
        let n = triggers.len();
        let all_before: f64 = triggers
            .iter()
            .filter_map(|t| t.get("before").and_then(serde_json::Value::as_f64))
            .sum();
        let all_after: f64 = triggers
            .iter()
            .filter_map(|t| t.get("after").and_then(serde_json::Value::as_f64))
            .sum();
        let total_steps: i64 = triggers
            .iter()
            .map(|t| {
                let nb = t
                    .get("n_before")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                let na = t
                    .get("n_after")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                nb + na
            })
            .sum();

        let avg_b = if n > 0 { all_before / n as f64 } else { 0.0 };
        let avg_a = if n > 0 { all_after / n as f64 } else { 0.0 };
        let delta = avg_a - avg_b;

        let delta_str = format!("{delta:+.1}pp");
        let delta_display = if delta > 0.0 {
            Cell::from_markup(&format!("[green]{delta_str}[/green]"))
        } else if delta < 0.0 {
            Cell::from_markup(&format!("[red]{delta_str}[/red]"))
        } else {
            Cell::new(delta_str)
        };

        table.add_row(Row::new(vec![
            Cell::new((*hook_name).clone()),
            Cell::new(n.to_string()),
            Cell::new(format!("{avg_b:.1}%")),
            Cell::new(format!("{avg_a:.1}%")),
            delta_display,
            Cell::new(total_steps.to_string()),
        ]));
    }

    render_table(width, &table);
}

/// Print the cache recovery curve table.
///
/// `data` maps step distance to a list of observed hit rates.
#[expect(clippy::cast_precision_loss)]
pub fn print_recovery_curve(data: &BTreeMap<i64, Vec<f64>>) {
    let width = terminal::get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Distance").justify(JustifyMethod::Right));
    table.add_column(Column::new("Avg Hit Rate").justify(JustifyMethod::Right));
    table.add_column(Column::new("Histogram"));
    table.add_column(Column::new("Samples").justify(JustifyMethod::Right));

    for (dist, rates) in data {
        let avg_rate: f64 = if rates.is_empty() {
            0.0
        } else {
            rates.iter().sum::<f64>() / rates.len() as f64
        };
        let bar = hit_rate_bar(avg_rate);

        table.add_row(Row::new(vec![
            Cell::new(dist.to_string()),
            Cell::new(format!("{avg_rate:.1}%")),
            Cell::new(bar),
            Cell::new(rates.len().to_string()),
        ]));
    }

    render_table(width, &table);
}

/// Cost data for a single hook type.
#[derive(Debug, Clone, Default)]
pub struct CostData {
    /// Total cost before hook triggers.
    pub before: f64,
    /// Total cost after hook triggers.
    pub after: f64,
}

/// Print the cost impact table.
pub fn print_cost_impact(data: &HashMap<String, CostData>) {
    let width = terminal::get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Hook"));
    table.add_column(Column::new("Before Cost").justify(JustifyMethod::Right));
    table.add_column(Column::new("After Cost").justify(JustifyMethod::Right));
    table.add_column(Column::new("Ratio").justify(JustifyMethod::Right));

    let mut hook_names: Vec<&String> = data.keys().collect();
    hook_names.sort();

    for hook_name in &hook_names {
        let cd = &data[*hook_name];
        let ratio = if cd.before > 0.0 {
            format!("{:.2}x", cd.after / cd.before)
        } else {
            "N/A".to_string()
        };

        table.add_row(Row::new(vec![
            Cell::new(hook_name.as_str()),
            Cell::new(format!("${:.4}", cd.before)),
            Cell::new(format!("${:.4}", cd.after)),
            Cell::new(ratio),
        ]));
    }

    render_table(width, &table);
}

/// Print verbose per-trigger impact detail.
///
/// Each row in `rows` is a Value with fields: `session_id`, `hook`,
/// `timestamp`, `avg_before`, `avg_after`, `delta`, `before_steps`,
/// `after_steps`.
#[allow(clippy::too_many_lines)]
pub fn print_impact_verbose(rows: &[Value]) {
    for row in rows {
        let sid = row.get("session_id").and_then(|v| v.as_str()).unwrap_or("?");
        let hook = row.get("hook").and_then(|v| v.as_str()).unwrap_or("");
        let ts = row.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let ts_short = shorten_timestamp(ts);

        let avg_before = row
            .get("avg_before")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let avg_after = row
            .get("avg_after")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let delta =
            row.get("delta").and_then(serde_json::Value::as_f64).unwrap_or(0.0);

        let delta_tag = if delta > 0.0 { "green" } else { "red" };

        // Header line
        msg_print(&format!(
            "\n[bold]Session {sid}[/bold] [cyan]| {hook}[/cyan] [dim]| {ts_short}[/dim]"
        ));

        // Before steps
        let before_steps = row
            .get("before_steps")
            .and_then(|v| v.as_array().map(std::vec::Vec::as_slice))
            .unwrap_or(&[]);
        msg_print(&format!(
            "  [bold]Before ({} steps):[/bold] avg hit rate [yellow]{avg_before:.1}%[/yellow]",
            before_steps.len()
        ));
        for b in before_steps {
            let cr = b
                .get("cache_read")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let inp = b
                .get("input_tokens")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let hr = b
                .get("hit_rate")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let cost = b
                .get("cost")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            msg_print(&format!(
                "    cache_read={cr}, input={inp}, hit_rate={hr:.1}%, cost=${cost:.4}"
            ));
        }

        // After steps
        let after_steps = row
            .get("after_steps")
            .and_then(|v| v.as_array().map(std::vec::Vec::as_slice))
            .unwrap_or(&[]);
        msg_print(&format!(
            "  [bold]After ({} steps):[/bold] avg hit rate [yellow]{avg_after:.1}%[/yellow]",
            after_steps.len()
        ));
        for a in after_steps {
            let cr = a
                .get("cache_read")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let inp = a
                .get("input_tokens")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let hr = a
                .get("hit_rate")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let cost = a
                .get("cost")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            msg_print(&format!(
                "    cache_read={cr}, input={inp}, hit_rate={hr:.1}%, cost=${cost:.4}"
            ));
        }

        // Delta
        msg_print(&format!(
            "  [bold]Delta:[/bold] [{delta_tag}]{delta:+.1}pp[/{delta_tag}]"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── build_json_token_summary ─────────────────────────────────────────────

    fn make_step(
        input: f64,
        output: f64,
        cache_read: f64,
        cache_write: f64,
        cost: f64,
    ) -> Value {
        json!({
            "input_tokens": input,
            "output_tokens": output,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cost": cost,
        })
    }

    #[test]
    fn test_build_json_token_summary_basic() {
        let steps = vec![
            make_step(100.0, 50.0, 30.0, 10.0, 0.005),
            make_step(200.0, 100.0, 50.0, 20.0, 0.003),
        ];
        let result = build_json_token_summary(&steps);
        assert_eq!(result["total_input"], 300.0);
        assert_eq!(result["total_output"], 150.0);
        assert_eq!(result["total_cache_read"], 80.0);
        assert_eq!(result["total_cache_write"], 30.0);
        assert_eq!(result["est_cost"], 0.008);
        assert_eq!(result["num_steps"], 2);
        // avgs
        assert_eq!(result["avg_input_per_turn"], 150.0);
        assert_eq!(result["avg_output_per_turn"], 75.0);
        // hit rate: 80 / (300 + 80) * 100 = 21.05...
        let hr = result["cache_hit_rate"].as_f64().unwrap();
        assert!((hr - 21.05).abs() < 0.01);
    }

    #[test]
    fn test_build_json_token_summary_empty() {
        let result = build_json_token_summary(&[]);
        assert_eq!(result["error"], "No step data found");
    }

    #[test]
    fn test_build_json_token_summary_single_step() {
        let steps = vec![make_step(50.0, 25.0, 10.0, 5.0, 0.001)];
        let result = build_json_token_summary(&steps);
        assert_eq!(result["num_steps"], 1);
        assert_eq!(result["total_input"], 50.0);
        assert_eq!(result["avg_input_per_turn"], 50.0);
    }

    #[test]
    fn test_build_json_token_summary_zero_values() {
        let steps = vec![make_step(0.0, 0.0, 0.0, 0.0, 0.0)];
        let result = build_json_token_summary(&steps);
        assert_eq!(result["total_input"], 0.0);
        assert_eq!(result["cache_hit_rate"], 0.0);
        assert_eq!(result["est_cost"], 0.0);
    }

    // ── build_json_hook_breakdown ────────────────────────────────────────────

    #[test]
    fn test_build_json_hook_breakdown_basic() {
        let events = vec![
            json!({"hook": "task-prompt", "event": "validate"}),
            json!({"hook": "task-prompt", "event": "validate"}),
            json!({"hook": "json-error-nudge", "event": "trigger"}),
        ];
        let result = build_json_hook_breakdown(&events, "ses-001");
        assert_eq!(result["session_id"], "ses-001");
        let bd = result["hook_breakdown"].as_object().unwrap();
        // task-prompt should come first (count 2 > 1)
        assert!(bd.contains_key("task-prompt"));
        assert!(bd.contains_key("json-error-nudge"));
        let tp = &bd["task-prompt"];
        assert_eq!(tp["count"], 2);
        assert_eq!(tp["events"]["validate"], 2);
        let jen = &bd["json-error-nudge"];
        assert_eq!(jen["count"], 1);
        assert_eq!(jen["events"]["trigger"], 1);
    }

    #[test]
    fn test_build_json_hook_breakdown_empty() {
        let result = build_json_hook_breakdown(&[], "ses-empty");
        assert_eq!(result["session_id"], "ses-empty");
        let bd = result["hook_breakdown"].as_object().unwrap();
        assert!(bd.is_empty());
    }

    #[test]
    fn test_build_json_hook_breakdown_multiple_event_types() {
        let events = vec![
            json!({"hook": "task-prompt", "event": "validate"}),
            json!({"hook": "task-prompt", "event": "trigger"}),
        ];
        let result = build_json_hook_breakdown(&events, "ses-002");
        let tp = &result["hook_breakdown"]["task-prompt"];
        assert_eq!(tp["events"]["validate"], 1);
        assert_eq!(tp["events"]["trigger"], 1);
    }

    // ── build_json_full_stats ────────────────────────────────────────────────

    #[test]
    fn test_build_json_full_stats_basic() {
        let events = vec![
            json!({"level": "info", "sessionId": "ses-001", "hook": "task-prompt", "event": "validate", "timestamp": "2025-01-09T12:00:00Z"}),
            json!({"level": "warn", "sessionId": "ses-001", "hook": "json-error-nudge", "event": "trigger", "timestamp": "2025-01-09T14:30:00Z"}),
        ];
        let steps = vec![make_step(100.0, 50.0, 30.0, 10.0, 0.005)];
        let result =
            build_json_full_stats(&events, &steps, "/tmp/test.log", "ses-001");
        assert_eq!(result["session_id"], "ses-001");
        assert_eq!(result["file"], "/tmp/test.log");
        assert_eq!(result["total_events"], 2);
        assert!(result["time_span"].is_string());
        assert!(result["active_session_ids"].is_array());
        assert_eq!(result["active_session_ids"].as_array().unwrap().len(), 1);
        // level distribution
        let ld = result["level_distribution"].as_object().unwrap();
        assert_eq!(ld["info"], 1);
        assert_eq!(ld["warn"], 1);
        assert_eq!(ld["debug"], 0);
        assert_eq!(ld["error"], 0);
        // hook breakdown
        let bd = result["hook_breakdown"].as_object().unwrap();
        assert!(bd.contains_key("task-prompt"));
        assert!(bd.contains_key("json-error-nudge"));
        // token summary
        let ts = result["token_summary"].as_object().unwrap();
        assert_eq!(ts["total_input"], 100.0);
        assert_eq!(ts["num_steps"], 1);
    }

    #[test]
    fn test_build_json_full_stats_empty_events() {
        let result =
            build_json_full_stats(&[], &[], "/tmp/empty.log", "ses-empty");
        assert_eq!(result["total_events"], 0);
        assert_eq!(result["time_span"], Value::Null);
        assert_eq!(result["active_session_ids"], Value::Null);
        assert_eq!(result["token_summary"], Value::Null);
        let ld = result["level_distribution"].as_object().unwrap();
        assert_eq!(ld["info"], 0);
    }

    #[test]
    fn test_build_json_full_stats_no_steps() {
        let events = vec![
            json!({"level": "info", "sessionId": "ses-001", "hook": "task-prompt", "event": "validate", "timestamp": "2025-01-09T12:00:00Z"}),
        ];
        let result =
            build_json_full_stats(&events, &[], "/tmp/test.log", "ses-001");
        assert_eq!(result["token_summary"], Value::Null);
    }

    #[test]
    fn test_build_json_full_stats_multiple_session_ids() {
        let events = vec![
            json!({"level": "info", "sessionId": "ses-001", "timestamp": "2025-01-09T12:00:00Z"}),
            json!({"level": "debug", "sessionId": "ses-002", "timestamp": "2025-01-09T12:01:00Z"}),
        ];
        let result = build_json_full_stats(&events, &[], "", "ses-main");
        let ids = result["active_session_ids"].as_array().unwrap();
        assert_eq!(ids.len(), 2);
    }

    // ── build_json_multi_stats ───────────────────────────────────────────────

    #[test]
    fn test_build_json_multi_stats_basic() {
        let sessions = vec![
            json!({"id": "ses-001", "input": 100.0, "output": 50.0}),
            json!({"id": "ses-002", "input": 200.0, "output": 100.0}),
        ];
        let totals = json!({
            "input": 300.0,
            "output": 150.0,
            "cache_read": 80.0,
            "cost": 0.008,
            "hook_events": 5.0,
        });
        let result = build_json_multi_stats(&sessions, &totals);
        assert!(result["sessions"].is_array());
        assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
        let t = result["total"].as_object().unwrap();
        assert_eq!(t["input"], 300);
        assert_eq!(t["output"], 150);
        assert_eq!(t["cache_read"], 80);
        assert_eq!(t["hook_events"], 5);
    }

    #[test]
    fn test_build_json_multi_stats_empty() {
        let result = build_json_multi_stats(&[], &json!({}));
        assert!(result["sessions"].as_array().unwrap().is_empty());
        let t = result["total"].as_object().unwrap();
        assert_eq!(t["input"], 0);
        assert_eq!(t["hit_rate"], 0.0);
    }

    #[test]
    fn test_build_json_multi_stats_hit_rate() {
        let totals = json!({
            "input": 100.0,
            "cache_read": 100.0,
            "cost": 0.0,
            "hook_events": 0.0,
        });
        let result = build_json_multi_stats(&[], &totals);
        // 100 / (100 + 100) * 100 = 50%
        assert!(
            (result["total"]["hit_rate"].as_f64().unwrap() - 50.0).abs() < 0.01
        );
    }

    // ── compute_time_span ────────────────────────────────────────────────────

    #[test]
    fn test_compute_time_span_valid() {
        let events = vec![
            json!({"timestamp": "2025-01-09T12:00:00Z"}),
            json!({"timestamp": "2025-01-09T14:30:00Z"}),
        ];
        let span = compute_time_span(&events);
        assert!(span.contains("2025-01-09"));
        assert!(span.contains("12:00:00"));
        assert!(span.contains("14:30:00"));
        assert!(span.contains("2h 30m"));
    }

    #[test]
    fn test_compute_time_span_single_event() {
        let events = vec![json!({"timestamp": "2025-01-09T12:00:00Z"})];
        assert_eq!(compute_time_span(&events), "");
    }

    #[test]
    fn test_compute_time_span_empty() {
        assert_eq!(compute_time_span(&[]), "");
    }

    #[test]
    fn test_compute_time_span_no_timestamp() {
        let events = vec![json!({"level": "info"})];
        assert_eq!(compute_time_span(&events), "");
    }

    #[test]
    fn test_compute_time_span_missing_fields() {
        let events = vec![
            json!({"timestamp": "2025-01-09T12:00:00Z"}),
            json!({"level": "info"}), // no timestamp
        ];
        let span = compute_time_span(&events);
        // Only 1 valid timestamp → should return ""
        assert_eq!(span, "");
    }

    // ── build_json roundtrip (verify output is valid JSON) ─────────────────

    /// Verify that the build_json functions produce values that serialize to
    /// valid JSON (same output the print functions would produce).
    #[test]
    fn test_build_json_token_summary_roundtrip() {
        let steps = vec![make_step(10.0, 5.0, 2.0, 1.0, 0.001)];
        let value = build_json_token_summary(&steps);
        let json_str = serde_json::to_string_pretty(&value)
            .expect("build_json_token_summary should serialize");
        let _parsed: Value = serde_json::from_str(&json_str)
            .expect("serialized output must be valid JSON");
    }

    #[test]
    fn test_build_json_hook_breakdown_roundtrip() {
        let events = vec![json!({"hook": "task-prompt", "event": "trigger"})];
        let value = build_json_hook_breakdown(&events, "ses-test");
        let json_str = serde_json::to_string_pretty(&value)
            .expect("build_json_hook_breakdown should serialize");
        let _parsed: Value = serde_json::from_str(&json_str)
            .expect("serialized output must be valid JSON");
    }

    #[test]
    fn test_build_json_full_stats_roundtrip() {
        let value =
            build_json_full_stats(&[], &[], "/tmp/test.log", "ses-test");
        let json_str = serde_json::to_string_pretty(&value)
            .expect("build_json_full_stats should serialize");
        let _parsed: Value = serde_json::from_str(&json_str)
            .expect("serialized output must be valid JSON");
    }

    #[test]
    fn test_build_json_multi_stats_roundtrip() {
        let sessions = vec![json!({"id": "ses-001"})];
        let totals = json!({"input": 0.0, "output": 0.0, "cache_read": 0.0, "cost": 0.0, "hook_events": 0.0});
        let value = build_json_multi_stats(&sessions, &totals);
        let json_str = serde_json::to_string_pretty(&value)
            .expect("build_json_multi_stats should serialize");
        let _parsed: Value = serde_json::from_str(&json_str)
            .expect("serialized output must be valid JSON");
    }
}
