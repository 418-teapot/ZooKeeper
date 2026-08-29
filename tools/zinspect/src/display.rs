use std::collections::{BTreeMap, HashMap};

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::text::{JustifyMethod, OverflowMethod, Text};
use zutil::get_terminal_width;

use serde_json::{Number, Value, json};

use zutil::color::{msg_print, render_segments_to_ansi};

use crate::helpers::{
    cache_hit_rate, format_details, format_duration, hit_rate_bar,
    shorten_timestamp,
};

// ── Conversion helpers ─────────────────────────────────────────────────────────

/// Convert a `usize` count to `f64` without triggering `cast_precision_loss`.
///
/// Goes through `u32` first (safe for in-memory counts that never exceed 4B).
fn count_as_f64(n: usize) -> f64 {
    f64::from(u32::try_from(n).unwrap_or(0))
}

/// Convert a finite non-negative `f64` to `u64` without trigger cast lints.
///
/// Uses string formatting instead of `as u64` to satisfy clippy.
fn f64_display_as_u64(v: f64) -> u64 {
    if v.is_finite() && v >= 0.0 {
        format!("{v:.0}").parse().unwrap_or(0)
    } else {
        0
    }
}

/// Convert a finite non-negative `f64` to a JSON integer `Value`.
fn f64_to_json_u64(v: f64) -> Value {
    Value::Number(Number::from(f64_display_as_u64(v)))
}

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
    let n_f64 = count_as_f64(n);
    let avg_input = if n > 0 { total_input / n_f64 } else { 0.0 };
    let avg_output = if n > 0 { total_output / n_f64 } else { 0.0 };
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

// ── Pruning reclamation ───────────────────────────────────────────────────────

/// Convert a JSON number (integer or float) to `i64`.
///
/// Float values are rounded to whole numbers via string formatting to avoid
/// integer-cast lints.
fn value_to_i64(v: &Value) -> i64 {
    v.as_i64().unwrap_or_else(|| {
        v.as_f64().map_or(0, |f| format!("{f:.0}").parse().unwrap_or(0))
    })
}

/// Read a numeric field from an event as `i64` (missing fields → 0).
fn field_i64(event: &Value, key: &str) -> i64 {
    event.get(key).map_or(0, value_to_i64)
}

/// Convert a non-negative `i64` token count to `f64` via `u32`.
///
/// Goes through `u32` first (safe for in-memory token counts that never
/// exceed 4B), matching the `count_as_f64` strategy.
fn tokens_to_f64(v: i64) -> f64 {
    f64::from(u32::try_from(v.max(0)).unwrap_or(0))
}

/// Accumulators for the pruning reclamation summary.
#[derive(Default)]
struct PruningAccum {
    reclaimed_tokens: i64,
    reclaimed_tools: i64,
    marked: BTreeMap<String, (i64, i64)>,
    released_batches: i64,
    released_count: i64,
    released_tokens: i64,
    released_forced: i64,
    block_count: i64,
    block_messages: i64,
    block_in_tokens: i64,
    block_out_tokens: i64,
    found: bool,
}

impl PruningAccum {
    /// Fold a single event into the accumulators.
    fn accumulate(&mut self, event: &Value) {
        let Some(evt) = event.get("event").and_then(serde_json::Value::as_str)
        else {
            return;
        };
        match evt {
            "prune_completed" => {
                self.reclaimed_tokens =
                    field_i64(event, "totalReclaimedTokens");
                self.reclaimed_tools = field_i64(event, "prunedToolCount");
                self.found = true;
            }
            "marks_released" => {
                self.released_batches += 1;
                self.released_count += field_i64(event, "releasedCount");
                self.released_tokens += field_i64(event, "releasedTokens");
                if event.get("forced").is_some() {
                    self.released_forced += 1;
                }
                self.found = true;
            }
            "compress_created" => {
                self.block_count += 1;
                self.block_messages += field_i64(event, "messageCount");
                self.block_in_tokens += field_i64(event, "inTokens");
                self.block_out_tokens += field_i64(event, "outTokens");
                self.found = true;
            }
            _ => {
                let Some(producer) =
                    evt.strip_suffix("_marked").filter(|p| !p.is_empty())
                else {
                    return;
                };
                let count = field_i64(event, "markedCount");
                let tokens = event
                    .get("markedTokens")
                    .or_else(|| event.get("totalEstimatedTokens"))
                    .map_or(0, value_to_i64);
                let entry =
                    self.marked.entry(producer.to_string()).or_default();
                entry.0 += count;
                entry.1 += tokens;
                self.found = true;
            }
        }
    }

    /// Build the final JSON value (only meaningful when `found`).
    fn into_json(self) -> Value {
        let total_marked_count: i64 =
            self.marked.values().map(|(count, _)| *count).sum();
        let total_marked_tokens: i64 =
            self.marked.values().map(|(_, tokens)| *tokens).sum();
        let mut by_producer = serde_json::Map::new();
        for (name, (count, tokens)) in self.marked {
            by_producer
                .insert(name, json!({ "count": count, "tokens": tokens }));
        }

        let ratio = if self.block_out_tokens > 0 {
            (tokens_to_f64(self.block_in_tokens)
                / tokens_to_f64(self.block_out_tokens)
                * 100.0)
                .round()
                / 100.0
        } else {
            0.0
        };
        let reduction_pct = if self.block_in_tokens > 0 {
            let in_f = tokens_to_f64(self.block_in_tokens);
            let out_f = tokens_to_f64(self.block_out_tokens);
            ((1.0 - out_f / in_f) * 100.0 * 10.0).round() / 10.0
        } else {
            0.0
        };

        json!({
            "reclaimed": {
                "tokens": self.reclaimed_tokens,
                "tools": self.reclaimed_tools,
            },
            "marked": {
                "by_producer": Value::Object(by_producer),
                "total_count": total_marked_count,
                "total_tokens": total_marked_tokens,
            },
            "released": {
                "batches": self.released_batches,
                "count": self.released_count,
                "tokens": self.released_tokens,
                "forced": self.released_forced,
            },
            "compress_blocks": {
                "blocks": self.block_count,
                "messages": self.block_messages,
                "in_tokens": self.block_in_tokens,
                "out_tokens": self.block_out_tokens,
                "ratio": ratio,
                "reduction_pct": reduction_pct,
            },
        })
    }
}

/// Build a pruning reclamation summary from zoo log events (pure, no I/O).
///
/// Consumes five event families:
/// - `prune_completed` (sent every transform round): a cumulative snapshot —
///   only the LAST occurrence is kept (`totalReclaimedTokens`/`prunedToolCount`).
/// - `*_marked` (`dedup_marked`/`purge-errors_marked`/`sweep_marked`): grouped
///   by producer (event name minus the `_marked` suffix); the token key is
///   `markedTokens` or `totalEstimatedTokens`, whichever exists.
/// - `marks_released`: accumulates `releasedCount`/`releasedTokens`, counts
///   batches, and counts forced releases (events carrying a `forced` field).
/// - `compress_created`: block count plus accumulated `messageCount`/
///   `inTokens`/`outTokens` and derived compression ratios.
///
/// Unknown events are ignored. The log is time-ordered, so the last
/// `prune_completed` entry is the newest cumulative snapshot.
///
/// Returns `None` when the event stream contains no pruning events.
pub fn build_pruning_summary(events: &[Value]) -> Option<Value> {
    let mut accum = PruningAccum::default();
    for event in events {
        accum.accumulate(event);
    }
    if !accum.found {
        return None;
    }
    Some(accum.into_json())
}

/// Compute token summary JSON (assumes steps is non-empty).
fn compute_token_summary_json(steps: &[Value]) -> Value {
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
    let n_f64 = count_as_f64(n);
    let avg_input = total_input / n_f64;
    let avg_output = total_output / n_f64;
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

/// Build full session stats as a JSON value (pure, no I/O).
///
/// The session-level `model` (from the session store) is emitted as a
/// `model` key only when the host recorded one.
pub fn build_json_full_stats(
    events: &[Value],
    steps: &[Value],
    path: &str,
    session_id: &str,
    model: Option<&str>,
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
        compute_token_summary_json(steps)
    };

    let json_levels = json!({
        "info": level_counts.get("info").copied().unwrap_or(0),
        "debug": level_counts.get("debug").copied().unwrap_or(0),
        "warn": level_counts.get("warn").copied().unwrap_or(0),
        "error": level_counts.get("error").copied().unwrap_or(0),
    });

    let mut result = json!({
        "session_id": session_id,
        "file": path,
        "total_events": total,
        "time_span": if time_span.is_empty() { Value::Null } else { Value::String(time_span) },
        "active_session_ids": if active_session_ids.is_empty() { Value::Null } else { Value::Array(active_session_ids.iter().map(|s| Value::String(s.to_string())).collect()) },
        "level_distribution": json_levels,
        "hook_breakdown": breakdown,
        "token_summary": token_summary,
    });
    if let Some(pruning) = build_pruning_summary(events) {
        result["pruning"] = pruning;
    }
    if let Some(model) = model {
        result["model"] = Value::String(model.to_string());
    }
    result
}

/// Build cross-session token summary as a JSON value (pure, no I/O).
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
            "input": f64_to_json_u64(totals.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0)),
            "output": f64_to_json_u64(totals.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0)),
            "cache_read": f64_to_json_u64(totals.get("cache_read").and_then(serde_json::Value::as_f64).unwrap_or(0.0)),
            "hit_rate": total_hit_rate,
            "cost": (totals.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0) * 10_000.0).round() / 10_000.0,
            "hook_events": f64_to_json_u64(totals.get("hook_events").and_then(serde_json::Value::as_f64).unwrap_or(0.0)),
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

/// Print a token summary as JSON.
///
/// `summary` is the precomputed `build_json_token_summary` value.
pub fn print_json_token_summary(summary: &Value) {
    print_json(summary);
}

/// Print a token summary as a rich table.
///
/// `summary` is the precomputed `build_json_token_summary` value. The
/// caller handles the empty-steps case (the build function returns an
/// error marker for empty input, which this function does not render).
pub fn print_token_summary_table(summary: &Value) {
    let total_input = summary["total_input"].as_f64().unwrap_or(0.0);
    let total_output = summary["total_output"].as_f64().unwrap_or(0.0);
    let total_cache_read = summary["total_cache_read"].as_f64().unwrap_or(0.0);
    let total_cache_write =
        summary["total_cache_write"].as_f64().unwrap_or(0.0);
    let avg_input = summary["avg_input_per_turn"].as_f64().unwrap_or(0.0);
    let avg_output = summary["avg_output_per_turn"].as_f64().unwrap_or(0.0);
    let est_cost = summary["est_cost"].as_f64().unwrap_or(0.0);
    let hit_rate = cache_hit_rate(total_cache_read, total_input);
    let denom = f64_display_as_u64(total_input + total_cache_read);

    let width = get_terminal_width();
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
        ("Est. cost", format!("${est_cost:.4}")),
    ];
    for (metric, value) in &rows {
        table.add_row(Row::new(vec![
            Cell::new(*metric),
            Cell::new(value.as_str()),
        ]));
    }

    render_table(width, &table);
}

/// Print a hook breakdown as JSON.
///
/// `summary` is the precomputed `build_json_hook_breakdown` value.
pub fn print_json_hook_breakdown(summary: &Value) {
    print_json(summary);
}

/// Print a hook breakdown as a rich table.
///
/// `summary` is the precomputed `build_json_hook_breakdown` value. Hooks
/// are ordered by descending event count (ties break by hook name),
/// mirroring the build function's count ordering.
pub fn print_hook_breakdown_table(summary: &Value) {
    let Some(breakdown) = summary["hook_breakdown"].as_object() else {
        return;
    };

    let width = get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Hook"));
    table.add_column(Column::new("Count").justify(JustifyMethod::Right));
    table.add_column(Column::new("Events"));

    let mut hook_order: Vec<(&str, i64)> = breakdown
        .iter()
        .map(|(hook, entry)| {
            (hook.as_str(), entry["count"].as_i64().unwrap_or(0))
        })
        .collect();
    hook_order.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    for (hook, count) in hook_order {
        let detail: Vec<String> = breakdown[hook]["events"]
            .as_object()
            .map_or_else(Vec::new, |evt_map| {
                let mut evt_order: Vec<(&str, i64)> = evt_map
                    .iter()
                    .map(|(evt, count)| {
                        (evt.as_str(), count.as_i64().unwrap_or(0))
                    })
                    .collect();
                evt_order.sort_by_key(|entry| std::cmp::Reverse(entry.1));
                evt_order
                    .iter()
                    .map(|(evt, count)| format!("{evt}:{count}"))
                    .collect()
            });
        let detail_str = detail.join(", ");
        table.add_row(Row::new(vec![
            Cell::new(hook),
            Cell::new(count.to_string()),
            Cell::new(detail_str),
        ]));
    }

    render_table(width, &table);
}

/// Print a pruning reclamation summary as JSON.
///
/// Standalone JSON output for the `stats --pruning --json` CLI branch.
/// `summary` is the precomputed `build_pruning_summary` value; the
/// caller handles the `None` (no pruning events) case.
pub fn print_json_pruning(summary: &Value) {
    print_json(summary);
}

/// Print a pruning reclamation summary as a rich table.
///
/// Four groups mirror the `build_pruning_summary` JSON shape: reclaimed
/// (last cumulative snapshot), marked by producer, released batches
/// (including forced), and compression blocks (including ratio).
/// `summary` is the precomputed `build_pruning_summary` value; the
/// caller only invokes this function when the summary exists.
pub fn print_pruning_table(summary: &Value) {
    let reclaimed = &summary["reclaimed"];
    let marked = &summary["marked"];
    let released = &summary["released"];
    let compress = &summary["compress_blocks"];

    let width = get_terminal_width();
    let mut table = Table::new()
        .title("Pruning Reclamation")
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(Column::new("Metric"));
    table.add_column(Column::new("Value").justify(JustifyMethod::Right));

    let mut rows: Vec<(String, String)> = Vec::new();
    rows.push((
        "Reclaimed tokens".to_string(),
        reclaimed["tokens"].to_string(),
    ));
    rows.push(("Pruned tools".to_string(), reclaimed["tools"].to_string()));

    if let Some(by_producer) = marked["by_producer"].as_object() {
        let mut producer_names: Vec<&String> = by_producer.keys().collect();
        producer_names.sort();
        for name in producer_names {
            let producer = &by_producer[name];
            rows.push((
                format!("Marked count ({name})"),
                producer["count"].to_string(),
            ));
            rows.push((
                format!("Marked tokens ({name})"),
                producer["tokens"].to_string(),
            ));
        }
    }
    rows.push((
        "Marked total count".to_string(),
        marked["total_count"].to_string(),
    ));
    rows.push((
        "Marked total tokens".to_string(),
        marked["total_tokens"].to_string(),
    ));
    rows.push(("Release batches".to_string(), released["batches"].to_string()));
    rows.push(("Released tools".to_string(), released["count"].to_string()));
    rows.push(("Released tokens".to_string(), released["tokens"].to_string()));
    rows.push(("Forced batches".to_string(), released["forced"].to_string()));
    rows.push(("Compress blocks".to_string(), compress["blocks"].to_string()));
    rows.push((
        "Compressed messages".to_string(),
        compress["messages"].to_string(),
    ));
    rows.push((
        "Compressed in tokens".to_string(),
        compress["in_tokens"].to_string(),
    ));
    rows.push((
        "Compressed out tokens".to_string(),
        compress["out_tokens"].to_string(),
    ));
    let ratio = compress["ratio"].as_f64().unwrap_or(0.0);
    let reduction = compress["reduction_pct"].as_f64().unwrap_or(0.0);
    rows.push(("Compression ratio".to_string(), format!("{ratio:.2}x")));
    rows.push((
        "Compression reduction".to_string(),
        format!("{reduction:.1}%"),
    ));

    for (metric, value) in &rows {
        table.add_row(Row::new(vec![
            Cell::new(metric.as_str()),
            Cell::new(value.as_str()),
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
    model: Option<&str>,
) {
    print_json(&build_json_full_stats(events, steps, path, session_id, model));
}

/// Print level distribution table.
fn print_level_distribution_table(events: &[Value]) {
    let mut level_counts: HashMap<&str, i64> = HashMap::new();
    for event in events {
        let level =
            event.get("level").and_then(|v| v.as_str()).unwrap_or("unknown");
        *level_counts.entry(level).or_insert(0) += 1;
    }

    let width = get_terminal_width();
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
}

/// Print full session stats as rich output.
///
/// Each section summary is computed exactly once and passed to the
/// section printers. The session-level `model` (from the session store)
/// renders in the header only when the host recorded one.
pub fn print_full_stats(
    events: &[Value],
    steps: &[Value],
    path: &str,
    session_id: &str,
    model: Option<&str>,
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
    if let Some(model) = model {
        msg_print(&format!("Model: [blue]{model}[/blue]"));
    }
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
        let summary = build_json_token_summary(steps);
        print_token_summary_table(&summary);
    }

    // ── Level Distribution ─────────────────────────────────────────────
    print_level_distribution_table(events);

    // ── Hook Breakdown ─────────────────────────────────────────────────
    let hook_summary = build_json_hook_breakdown(events, session_id);
    print_hook_breakdown_table(&hook_summary);

    // ── Pruning Reclamation ─────────────────────────────────────────────
    // Only rendered when the session contains pruning events.
    if let Some(summary) = build_pruning_summary(events) {
        print_pruning_table(&summary);
    }
}

// ── Multi-session Stats ────────────────────────────────────────────────────────

/// Print cross-session token summary as JSON.
pub fn print_json_multi_stats(sessions_data: &[Value], totals: &Value) {
    print_json(&build_json_multi_stats(sessions_data, totals));
}

/// Print cross-session token summary as a rich table.
/// Compute total metrics from the totals JSON for the multi-stats table.
fn compute_totals(totals: &Value) -> (f64, u64, u64, f64, u64) {
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
    let totals_input = f64_display_as_u64(
        totals.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
    );
    let totals_output = f64_display_as_u64(
        totals.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
    );
    let totals_cost =
        totals.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let totals_hook = f64_display_as_u64(
        totals
            .get("hook_events")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
    );
    (total_hit_rate, totals_input, totals_output, totals_cost, totals_hook)
}

pub fn print_multi_stats_table(
    sessions_data: &[Value],
    totals: &Value,
    n: i64,
) {
    let bold = Style::new().bold();
    let (total_hit_rate, totals_input, totals_output, totals_cost, totals_hook) =
        compute_totals(totals);

    let width = get_terminal_width();
    let mut table = Table::new()
        .title(format!("Cross-Session Token Summary (last {n} sessions)"))
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(
        Column::new("Session ID").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Input")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Output")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Hit Rate")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Cost")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Hook Events")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );

    for s in sessions_data {
        let sid = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let inp = f64_display_as_u64(
            s.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        );
        let out = f64_display_as_u64(
            s.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        );
        let hr = s
            .get("hit_rate")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let cost =
            s.get("cost").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let hook = f64_display_as_u64(
            s.get("hook_events")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0),
        );

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

// ── Multi-session Pruning ─────────────────────────────────────────────────────

/// Aggregate pruning totals across per-session summaries (pure, no I/O).
///
/// Sums the numeric fields of each session's pruning summary across all
/// sessions. Sessions without pruning events (`None`) are skipped.
fn sum_pruning_totals(summaries: &[(String, Option<Value>)]) -> Value {
    let mut reclaimed_tokens: i64 = 0;
    let mut marked_count: i64 = 0;
    let mut marked_tokens: i64 = 0;
    let mut released_count: i64 = 0;
    let mut released_tokens: i64 = 0;
    let mut blocks: i64 = 0;

    for (_, summary) in summaries {
        let Some(s) = summary else {
            continue;
        };
        reclaimed_tokens += s["reclaimed"]["tokens"].as_i64().unwrap_or(0);
        marked_count += s["marked"]["total_count"].as_i64().unwrap_or(0);
        marked_tokens += s["marked"]["total_tokens"].as_i64().unwrap_or(0);
        released_count += s["released"]["count"].as_i64().unwrap_or(0);
        released_tokens += s["released"]["tokens"].as_i64().unwrap_or(0);
        blocks += s["compress_blocks"]["blocks"].as_i64().unwrap_or(0);
    }

    json!({
        "reclaimed_tokens": reclaimed_tokens,
        "marked_count": marked_count,
        "marked_tokens": marked_tokens,
        "released_count": released_count,
        "released_tokens": released_tokens,
        "blocks": blocks,
    })
}

/// Build JSON for multi-session pruning reclamation (pure, no I/O).
///
/// Each session gets its own pruning summary (`null` when the session has
/// no pruning events); a `total` object aggregates numeric fields across
/// all sessions.
pub fn build_json_multi_pruning(
    summaries: &[(String, Option<Value>)],
) -> Value {
    let sessions: Vec<Value> = summaries
        .iter()
        .map(|(sid, summary)| {
            json!({
                "id": sid,
                "summary": summary.clone().unwrap_or(Value::Null),
            })
        })
        .collect();

    json!({
        "pruning": {
            "sessions": sessions,
            "total": sum_pruning_totals(summaries),
        },
    })
}

/// Print multi-session pruning reclamation as JSON.
pub fn print_json_multi_pruning(summaries: &[(String, Option<Value>)]) {
    print_json(&build_json_multi_pruning(summaries));
}

/// Print a multi-session pruning reclamation table.
///
/// `summaries` maps each session ID to its pruning summary (`None` when the
/// session has no pruning events). A bold totals row sums the numeric
/// fields across all sessions.
pub fn print_multi_pruning_table(
    summaries: &[(String, Option<Value>)],
    n: i64,
) {
    let bold = Style::new().bold();
    let totals = sum_pruning_totals(summaries);

    let width = get_terminal_width();
    let mut table = Table::new()
        .title(format!("Cross-Session Pruning Reclamation (last {n} sessions)"))
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(
        Column::new("Session ID").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Reclaimed Tokens")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Marked Count")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Marked Tokens")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Released Tools")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Blocks")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );

    for (sid, summary) in summaries {
        let (reclaimed, marked_count, marked_tokens, released, blocks) =
            summary.as_ref().map_or((0, 0, 0, 0, 0), |s| {
                (
                    s["reclaimed"]["tokens"].as_i64().unwrap_or(0),
                    s["marked"]["total_count"].as_i64().unwrap_or(0),
                    s["marked"]["total_tokens"].as_i64().unwrap_or(0),
                    s["released"]["count"].as_i64().unwrap_or(0),
                    s["compress_blocks"]["blocks"].as_i64().unwrap_or(0),
                )
            });
        table.add_row(Row::new(vec![
            Cell::new(sid.as_str()),
            Cell::new(reclaimed.to_string()),
            Cell::new(marked_count.to_string()),
            Cell::new(marked_tokens.to_string()),
            Cell::new(released.to_string()),
            Cell::new(blocks.to_string()),
        ]));
    }

    table.add_row(Row::new(vec![
        Cell::new(Text::styled("Total".to_string(), bold)),
        Cell::new(totals["reclaimed_tokens"].to_string()),
        Cell::new(totals["marked_count"].to_string()),
        Cell::new(totals["marked_tokens"].to_string()),
        Cell::new(totals["released_count"].to_string()),
        Cell::new(totals["blocks"].to_string()),
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

    let width = get_terminal_width();
    let mut table = Table::new()
        .title(format!("Timeline: {session_id}"))
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(
        Column::new("Time").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Level").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Hook").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Event").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
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
/// `analysis` maps `hook:event` composite keys to per-trigger entries, where
/// each entry contains `session_id`, `timestamp`, `before`, `after`,
/// `n_before`, `n_after`.
pub fn print_impact_aggregation(analysis: &HashMap<String, Vec<Value>>) {
    let width = get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(
        Column::new("Hook:Event").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Triggers")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Avg Before")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Avg After")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("\u{0394}")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Correlated Steps")
            .justify(JustifyMethod::Right)
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis),
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

        let n_f64 = count_as_f64(n);
        let avg_b = if n > 0 { all_before / n_f64 } else { 0.0 };
        let avg_a = if n > 0 { all_after / n_f64 } else { 0.0 };
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
pub fn print_recovery_curve(data: &BTreeMap<i64, Vec<f64>>) {
    let width = get_terminal_width();
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
            rates.iter().sum::<f64>() / count_as_f64(rates.len())
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

/// Print the per-session tool usage table.
///
/// Each row is a `Value` with `session_id` and a `tools` map whose keys
/// are tool names and values carry `calls` and `duration_ms`. Rows are
/// rendered in input order; tool names sort alphabetically.
pub fn print_tool_usage(rows: &[Value]) {
    if rows.is_empty() {
        return;
    }
    let width = get_terminal_width();
    let mut table = Table::new()
        .title("Tool Usage per Session")
        .title_justify(JustifyMethod::Left)
        .show_header(true)
        .show_edge(true)
        .show_lines(false);
    table.add_column(
        Column::new("Session ID").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(Column::new("Tool"));
    table.add_column(
        Column::new("Calls").justify(JustifyMethod::Right).no_wrap(),
    );
    table.add_column(
        Column::new("Duration").justify(JustifyMethod::Right).no_wrap(),
    );

    for row in rows {
        let sid = row.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        let Some(tools) = row.get("tools").and_then(Value::as_object) else {
            continue;
        };
        let mut names: Vec<&str> = tools.keys().map(String::as_str).collect();
        names.sort_unstable();
        for name in names {
            let tool = &tools[name];
            let calls = tool.get("calls").and_then(Value::as_i64).unwrap_or(0);
            let duration_ms =
                tool.get("duration_ms").and_then(Value::as_i64).unwrap_or(0);
            table.add_row(Row::new(vec![
                Cell::new(sid),
                Cell::new(name),
                Cell::new(calls.to_string()),
                Cell::new(format_duration(duration_ms / 1000)),
            ]));
        }
    }

    render_table(width, &table);
}

/// Print the cost impact table.
///
/// Keys are `hook:event` composite keys, mirroring the impact aggregation.
pub fn print_cost_impact(data: &HashMap<String, CostData>) {
    let width = get_terminal_width();
    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);
    table.add_column(Column::new("Hook:Event"));
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
/// Each row in `rows` is a Value with fields: `session_id`, `hook`
/// (a `hook:event` composite key), `timestamp`, `avg_before`, `avg_after`,
/// `delta`, `before_steps`, `after_steps`.
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
        let result = build_json_full_stats(
            &events,
            &steps,
            "/tmp/test.log",
            "ses-001",
            None,
        );
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
        let result = build_json_full_stats(
            &[],
            &[],
            "/tmp/empty.log",
            "ses-empty",
            None,
        );
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
        let result = build_json_full_stats(
            &events,
            &[],
            "/tmp/test.log",
            "ses-001",
            None,
        );
        assert_eq!(result["token_summary"], Value::Null);
    }

    #[test]
    fn test_build_json_full_stats_multiple_session_ids() {
        let events = vec![
            json!({"level": "info", "sessionId": "ses-001", "timestamp": "2025-01-09T12:00:00Z"}),
            json!({"level": "debug", "sessionId": "ses-002", "timestamp": "2025-01-09T12:01:00Z"}),
        ];
        let result = build_json_full_stats(&events, &[], "", "ses-main", None);
        let ids = result["active_session_ids"].as_array().unwrap();
        assert_eq!(ids.len(), 2);
    }

    // ── build_json_multi_pruning ─────────────────────────────────────────────

    #[test]
    fn test_sum_pruning_totals_basic() {
        let summaries = vec![
            (
                "ses-001".to_string(),
                Some(json!({
                    "reclaimed": {"tokens": 1500, "tools": 3},
                    "marked": {"total_count": 6, "total_tokens": 1200},
                    "released": {"count": 8, "tokens": 1500},
                    "compress_blocks": {"blocks": 2},
                })),
            ),
            (
                "ses-002".to_string(),
                Some(json!({
                    "reclaimed": {"tokens": 500, "tools": 1},
                    "marked": {"total_count": 4, "total_tokens": 800},
                    "released": {"count": 3, "tokens": 600},
                    "compress_blocks": {"blocks": 1},
                })),
            ),
            ("ses-003".to_string(), None),
        ];
        let totals = sum_pruning_totals(&summaries);
        assert_eq!(totals["reclaimed_tokens"], 2000);
        assert_eq!(totals["marked_count"], 10);
        assert_eq!(totals["marked_tokens"], 2000);
        assert_eq!(totals["released_count"], 11);
        assert_eq!(totals["released_tokens"], 2100);
        assert_eq!(totals["blocks"], 3);
    }

    #[test]
    fn test_sum_pruning_totals_empty() {
        let totals = sum_pruning_totals(&[]);
        assert_eq!(totals["reclaimed_tokens"], 0);
        assert_eq!(totals["marked_count"], 0);
        assert_eq!(totals["marked_tokens"], 0);
        assert_eq!(totals["released_count"], 0);
        assert_eq!(totals["released_tokens"], 0);
        assert_eq!(totals["blocks"], 0);
    }

    #[test]
    fn test_build_json_multi_pruning_shape() {
        let summaries = vec![
            (
                "ses-001".to_string(),
                Some(json!({"reclaimed": {"tokens": 100}})),
            ),
            ("ses-002".to_string(), None),
        ];
        let result = build_json_multi_pruning(&summaries);
        let pruning = &result["pruning"];
        let sessions = pruning["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["id"], "ses-001");
        assert!(sessions[0]["summary"].is_object());
        assert_eq!(sessions[1]["id"], "ses-002");
        assert_eq!(sessions[1]["summary"], Value::Null);
        assert_eq!(pruning["total"]["reclaimed_tokens"], 100);
    }

    #[test]
    fn test_build_json_multi_pruning_roundtrip() {
        let summaries = vec![(
            "ses-001".to_string(),
            Some(json!({"reclaimed": {"tokens": 100}})),
        )];
        let value = build_json_multi_pruning(&summaries);
        let json_str = serde_json::to_string_pretty(&value)
            .expect("build_json_multi_pruning should serialize");
        let _parsed: Value = serde_json::from_str(&json_str)
            .expect("serialized output must be valid JSON");
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

    // ── build_pruning_summary ─────────────────────────────────────────

    #[test]
    fn test_build_pruning_summary_mixed_stream() {
        let events = vec![
            json!({"event": "prune_completed", "prunedToolCount": 3, "totalReclaimedTokens": 1500}),
            json!({"event": "dedup_marked", "markedCount": 4, "markedTokens": 800}),
            json!({"event": "dedup_marked", "markedCount": 2, "markedTokens": 400}),
            json!({"event": "purge-errors_marked", "markedCount": 3, "markedTokens": 600}),
            json!({"event": "sweep_marked", "markedCount": 5, "totalEstimatedTokens": 1000}),
            json!({"event": "marks_released", "releasedCount": 6, "releasedTokens": 1200}),
            json!({"event": "marks_released", "releasedCount": 2, "releasedTokens": 300, "forced": "view_change"}),
            json!({"event": "compress_created", "blockId": 1, "messageCount": 10, "inTokens": 2000, "outTokens": 500}),
            json!({"event": "compress_created", "blockId": 2, "messageCount": 20, "inTokens": 3000, "outTokens": 1000}),
            json!({"event": "some_unknown_event", "foo": 1}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");

        // Reclaimed: last prune_completed snapshot.
        assert_eq!(summary["reclaimed"]["tokens"], 1500);
        assert_eq!(summary["reclaimed"]["tools"], 3);

        // Marked by producer (dedup = 4+2, purge-errors = 3, sweep = 5).
        let marked = &summary["marked"];
        assert_eq!(marked["by_producer"]["dedup"]["count"], 6);
        assert_eq!(marked["by_producer"]["dedup"]["tokens"], 1200);
        assert_eq!(marked["by_producer"]["purge-errors"]["count"], 3);
        assert_eq!(marked["by_producer"]["purge-errors"]["tokens"], 600);
        assert_eq!(marked["by_producer"]["sweep"]["count"], 5);
        assert_eq!(marked["by_producer"]["sweep"]["tokens"], 1000);
        assert_eq!(marked["total_count"], 14);
        assert_eq!(marked["total_tokens"], 2800);

        // Released: 2 batches, one forced.
        assert_eq!(summary["released"]["batches"], 2);
        assert_eq!(summary["released"]["count"], 8);
        assert_eq!(summary["released"]["tokens"], 1500);
        assert_eq!(summary["released"]["forced"], 1);

        // Compress blocks: 5000 in → 1500 out → ratio ≈ 3.33, reduction 70%.
        let compress = &summary["compress_blocks"];
        assert_eq!(compress["blocks"], 2);
        assert_eq!(compress["messages"], 30);
        assert_eq!(compress["in_tokens"], 5000);
        assert_eq!(compress["out_tokens"], 1500);
        let ratio = compress["ratio"].as_f64().unwrap();
        assert!((ratio - 3.33).abs() < 0.01);
        let reduction = compress["reduction_pct"].as_f64().unwrap();
        assert!((reduction - 70.0).abs() < 0.1);
    }

    #[test]
    fn test_build_pruning_summary_keeps_last_prune_completed() {
        // prune_completed is emitted every transform round; only the last
        // occurrence is the cumulative snapshot.
        let events = vec![
            json!({"event": "prune_completed", "prunedToolCount": 1, "totalReclaimedTokens": 100}),
            json!({"event": "prune_completed", "prunedToolCount": 4, "totalReclaimedTokens": 900}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");
        assert_eq!(summary["reclaimed"]["tokens"], 900);
        assert_eq!(summary["reclaimed"]["tools"], 4);
    }

    #[test]
    fn test_build_pruning_summary_sweep_total_estimated_tokens_only() {
        // sweep_marked writes totalEstimatedTokens instead of markedTokens.
        let events = vec![
            json!({"event": "sweep_marked", "markedCount": 3, "totalEstimatedTokens": 2400}),
            json!({"event": "sweep_marked", "markedCount": 2, "totalEstimatedTokens": 600}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");
        let sweep = &summary["marked"]["by_producer"]["sweep"];
        assert_eq!(sweep["count"], 5);
        assert_eq!(sweep["tokens"], 3000);
        assert_eq!(summary["marked"]["total_tokens"], 3000);
    }

    #[test]
    fn test_build_pruning_summary_none_without_pruning_events() {
        assert!(build_pruning_summary(&[]).is_none());
        let events = vec![
            json!({"event": "validate", "hook": "task-prompt"}),
            json!({"event": "trigger", "hook": "json-error-nudge"}),
        ];
        assert!(build_pruning_summary(&events).is_none());
    }

    #[test]
    fn test_build_pruning_summary_forced_counting() {
        let events = vec![
            json!({"event": "marks_released", "releasedCount": 2, "releasedTokens": 100, "forced": "view_change"}),
            json!({"event": "marks_released", "releasedCount": 1, "releasedTokens": 50}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");
        assert_eq!(summary["released"]["batches"], 2);
        assert_eq!(summary["released"]["count"], 3);
        assert_eq!(summary["released"]["tokens"], 150);
        assert_eq!(summary["released"]["forced"], 1);
    }

    #[test]
    fn test_build_pruning_summary_compress_ratio_fields() {
        let events = vec![
            json!({"event": "compress_created", "blockId": 1, "messageCount": 12, "inTokens": 4000, "outTokens": 1000}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");
        let compress = &summary["compress_blocks"];
        assert_eq!(compress["blocks"], 1);
        assert_eq!(compress["messages"], 12);
        assert_eq!(compress["in_tokens"], 4000);
        assert_eq!(compress["out_tokens"], 1000);
        let ratio = compress["ratio"].as_f64().unwrap();
        assert!((ratio - 4.0).abs() < 0.01);
        let reduction = compress["reduction_pct"].as_f64().unwrap();
        assert!((reduction - 75.0).abs() < 0.1);
    }

    #[test]
    fn test_print_json_pruning_serializes() {
        // Smoke test for the standalone JSON printer: emits valid JSON for
        // a pruning event stream (output is captured by the test harness).
        let events = vec![
            json!({"event": "marks_released", "releasedCount": 2, "releasedTokens": 100}),
        ];
        let summary =
            build_pruning_summary(&events).expect("summary should exist");
        print_json_pruning(&summary);
    }

    #[test]
    fn test_build_json_full_stats_pruning_key_conditional() {
        // No pruning events → no pruning key in full stats.
        let events = vec![
            json!({"level": "info", "hook": "task-prompt", "event": "validate"}),
        ];
        let result =
            build_json_full_stats(&events, &[], "/tmp/t.log", "ses-001", None);
        assert!(result.get("pruning").is_none());

        // With pruning events → conditional pruning key present.
        let events = vec![
            json!({"event": "marks_released", "releasedCount": 2, "releasedTokens": 100}),
        ];
        let result =
            build_json_full_stats(&events, &[], "/tmp/t.log", "ses-001", None);
        assert!(result.get("pruning").is_some());
        assert_eq!(result["pruning"]["released"]["count"], 2);
        assert_eq!(result["pruning"]["released"]["tokens"], 100);
    }

    // ── build_json roundtrip (verify output is valid JSON) ─────────────────

    /// Verify that the `build_json` functions produce values that serialize to
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
            build_json_full_stats(&[], &[], "/tmp/test.log", "ses-test", None);
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
