// ztrace display — timeline views (show command).

use std::collections::HashMap;

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::text::{OverflowMethod, Text};
use serde_json::{Map, Number, Value};
use zutil::color::{msg_print, style_text};
use zutil::display_width;
use zutil::get_terminal_width;

use crate::helpers::build_model_map;
use crate::trace_builder::{mark_block_boundaries, sort_ops_by_session};

use super::common::{
    agent_style, pad, render_table, truncate_display, type_color, type_style,
};

// ── B. Show Command — Timeline Views ──────────────────────────────────────────

/// Create the timeline table with column definitions.
fn create_timeline_table() -> Table {
    let mut table = Table::new()
        .show_header(false)
        .box_style(&rich_rust::r#box::ASCII)
        .padding(0, 1);

    table.add_column(
        Column::new("Time")
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis)
            .width(9),
    );
    table.add_column(
        Column::new("Icon")
            .no_wrap()
            .overflow(OverflowMethod::Ellipsis)
            .width(2),
    );
    table.add_column(Column::new("Summary"));
    table
}

/// Build a timeline table row for a single event.
fn build_timeline_row(e: &Value) -> Row {
    let ts = e.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let time_str = if ts.len() >= 19 {
        &ts[11..19]
    } else if ts.len() >= 8 {
        &ts[ts.len().saturating_sub(8)..]
    } else {
        ts
    };

    let icon = e.get("icon").and_then(|v| v.as_str()).unwrap_or("●");
    let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("hook");
    let source = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let depth = e.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);

    let icon_style = type_style(etype);
    let icon_str = Text::styled(icon.to_string(), icon_style);

    let summary_str = e.get("summary").and_then(|v| v.as_str()).unwrap_or("");

    // Duration prefix for LLM/tool events
    if let Some(dur) = e.get("duration_sec").and_then(serde_json::Value::as_f64)
    {
        let dur_prefix = format!("[{dur:.1}s] ");
        let assembled = Text::assemble(&[
            (&dur_prefix, Some(Style::new().dim())),
            (summary_str, None),
        ]);
        // Child session prefix + indentation
        if depth > 0 {
            let agent =
                e.get("session_agent").and_then(|v| v.as_str()).unwrap_or("");
            let prefix = if agent.is_empty() {
                "[子session] "
            } else {
                &format!("[子:{agent}] ")
            };
            let indent =
                "  ".repeat(usize::try_from(depth.max(0)).unwrap_or(0));
            let mut child_text = Text::new("");
            child_text.append_styled(&indent, Style::new());
            child_text.append_styled(prefix, Style::new().dim());
            child_text.append_text(&assembled);
            return Row::new(vec![
                Cell::new(time_str.to_string()),
                Cell::new(icon_str),
                Cell::new(child_text),
            ]);
        } else if source == "zoo" {
            let mut zoo_text = Text::new("");
            zoo_text.append_styled(
                "[zoo] ",
                Style::new().color(Color::from_ansi(6)),
            );
            zoo_text.append_text(&assembled);
            return Row::new(vec![
                Cell::new(time_str.to_string()),
                Cell::new(icon_str),
                Cell::new(zoo_text),
            ]);
        }
        return Row::new(vec![
            Cell::new(time_str.to_string()),
            Cell::new(icon_str),
            Cell::new(assembled),
        ]);
    }

    // No duration prefix
    if depth > 0 {
        let agent =
            e.get("session_agent").and_then(|v| v.as_str()).unwrap_or("");
        let prefix = if agent.is_empty() {
            "[子session] "
        } else {
            &format!("[子:{agent}] ")
        };
        let indent = "  ".repeat(usize::try_from(depth.max(0)).unwrap_or(0));
        let mut child_text = Text::new("");
        child_text.append_styled(&indent, Style::new());
        child_text.append_styled(prefix, Style::new().dim());
        child_text.append(summary_str);
        Row::new(vec![
            Cell::new(time_str.to_string()),
            Cell::new(icon_str),
            Cell::new(child_text),
        ])
    } else if source == "zoo" {
        let zoo_text = Text::assemble(&[
            ("[zoo] ", Some(Style::new().color(Color::from_ansi(6)))),
            (summary_str, Some(Style::new().dim())),
        ]);
        Row::new(vec![
            Cell::new(time_str.to_string()),
            Cell::new(icon_str),
            Cell::new(zoo_text),
        ])
    } else {
        let summary_text = Text::new(summary_str);
        Row::new(vec![
            Cell::new(time_str.to_string()),
            Cell::new(icon_str),
            Cell::new(summary_text),
        ])
    }
}

/// Render full per-event timeline using rich Table.
///
/// Columns: Time(9), Icon(2), Summary.
/// Icons colored by type. Duration prefix for tool/LLM events.
/// Child sessions show `[子:agent]` prefix with depth indentation.
pub fn render_timeline_rich(timeline: &[Value]) {
    if timeline.is_empty() {
        msg_print("[yellow]No events in timeline.[/yellow]");
        return;
    }

    let width = get_terminal_width();
    let mut table = create_timeline_table();

    for e in timeline {
        let row = build_timeline_row(e);
        table.add_row(row);
    }

    render_table(width, &table);
}

// ── Ops Summary ───────────────────────────────────────────────────────────────

/// `OP_LABELS`: tool event type → Chinese label.
fn op_label(etype: &str) -> &str {
    match etype {
        "tool_read" => "读",
        "tool_write" => "写",
        "tool_exec" => "执行",
        "tool_orch" => "编排",
        _ => "其他",
    }
}

/// Collect ops from timeline for the summary view.
fn collect_sorted_ops(timeline: &[Value], verbose: bool) -> Vec<Value> {
    let mut ops: Vec<Value> = Vec::new();
    for (i, e) in timeline.iter().enumerate() {
        let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let source = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let include = etype.starts_with("tool_")
            || source == "zoo"
            || source == "db"
            || source == "pi"
            || ((etype == "llm" || etype == "llm_stream") && verbose);
        if include {
            let mut op = Map::new();
            op.insert(
                "index".to_string(),
                Value::Number(Number::from(i as u64)),
            );
            op.insert("event".to_string(), e.clone());
            ops.push(Value::Object(op));
        }
    }
    sort_ops_by_session(&ops)
}

/// Build tag labels for each op.
fn build_op_tag_labels(ops: &[Value], verbose: bool) -> Vec<String> {
    ops.iter()
        .map(|op| {
            let Some(event) = op.get("event").and_then(|v| v.as_object())
            else {
                return String::new();
            };
            let etype =
                event.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let source =
                event.get("source").and_then(|v| v.as_str()).unwrap_or("");
            if etype == "llm" {
                "🤖 LLM call".to_string()
            } else if etype == "llm_stream" {
                "🤖 LLM stream".to_string()
            } else if source == "zoo" {
                "zoo".to_string()
            } else if (source == "db" || source == "pi")
                && !etype.starts_with("tool_")
            {
                match etype {
                    "user_msg" => "User".to_string(),
                    "assistant_reply" => {
                        let agent = event
                            .get("agent")
                            .and_then(|v| v.as_str())
                            .unwrap_or("assistant");
                        format!("{agent}:")
                    }
                    "assistant_reasoning" if verbose => {
                        "🧠 Reasoning".to_string()
                    }
                    _ => String::new(),
                }
            } else {
                let icon =
                    event.get("icon").and_then(|v| v.as_str()).unwrap_or("●");
                format!("{icon} {}", op_label(etype))
            }
        })
        .collect()
}

/// Build a small border bottom line.
fn ops_bottom_line(
    depth: i64,
    color: &Style,
    col_prefix: &str,
    prefix_width: usize,
    term_width: usize,
    s_dim: &Style,
) -> String {
    let indent_width = 1 + usize::try_from(depth).unwrap_or(0) * 2; // "│" + "  ".repeat(depth)
    let bw = term_width.saturating_sub(prefix_width + indent_width).max(20);
    let border_line = format!("╰─{}", "─".repeat(bw.saturating_sub(2)));
    let indent_str =
        format!("│{}", "  ".repeat(usize::try_from(depth).unwrap_or(0)));
    format!(
        "{}{}{}",
        col_prefix,
        style_text(&indent_str, s_dim),
        style_text(&border_line, color),
    )
}

/// Build a small border top line.
fn ops_top_line(
    depth: i64,
    session_agent_str: &str,
    color: &Style,
    col_prefix: &str,
    prefix_width: usize,
    term_width: usize,
    s_dim: &Style,
) -> String {
    let indent_width = 1 + usize::try_from(depth).unwrap_or(0) * 2; // "│" + "  ".repeat(depth)
    let bw = term_width.saturating_sub(prefix_width + indent_width).max(20);
    let label = if session_agent_str.is_empty() {
        " [session] ".to_string()
    } else {
        format!(" [session:{session_agent_str}] ")
    };
    let max_label = 4_usize.max(bw.saturating_sub(3));
    let label = truncate_display(&label, max_label);
    let label_width = display_width(&label);
    let fill = 1_usize.max(bw.saturating_sub(2).saturating_sub(label_width));
    let border_top = format!("╭─{label}{}", "─".repeat(fill));
    let indent_str =
        format!("│{}", "  ".repeat(usize::try_from(depth).unwrap_or(0)));
    format!(
        "{}{}{}",
        col_prefix,
        style_text(&indent_str, s_dim),
        style_text(&border_top, color),
    )
}

/// Configuration for ops summary line rendering, grouping styles and dimensions.
struct OpsRenderConfig<'a> {
    tag_width: usize,
    content_width: usize,
    verbose: bool,
    s_dim: &'a Style,
    s_blue: &'a Style,
    s_green: &'a Style,
    s_cyan: &'a Style,
    col_prefix: &'a str,
    prefix_width: usize,
    term_width: usize,
}

// ── Per-event-type line format helpers ──

fn format_llm_op_line(
    cfg: &OpsRenderConfig,
    event: &serde_json::Map<String, Value>,
    time_seg: &str,
    model_seg: &str,
    sep_seg: &str,
) -> String {
    let detail = event.get("detail").and_then(|v| v.as_object());
    let agent_name = detail
        .and_then(|d| d.get("agent").and_then(|v| v.as_str()))
        .unwrap_or("");
    let agent_suffix = if !agent_name.is_empty() && agent_name != "?" {
        format!("({agent_name}) ")
    } else {
        String::new()
    };
    let dur = event.get("duration_sec").and_then(serde_json::Value::as_f64);
    let dur_seg = dur
        .map(|d| format!("{} ", style_text(&format!("[{d:.1}s]"), cfg.s_dim)))
        .unwrap_or_default();
    let is_stream =
        event.get("type").and_then(|v| v.as_str()) == Some("llm_stream");
    let label = if is_stream { "🤖 LLM stream" } else { "🤖 LLM call" };
    let tag_padded = pad(label, cfg.tag_width);
    let tag_seg = style_text(&tag_padded, cfg.s_blue);
    format!(
        "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {dur_seg}{agent_suffix}"
    )
}

fn format_zoo_op_line(
    cfg: &OpsRenderConfig,
    event: &serde_json::Map<String, Value>,
    time_seg: &str,
    model_seg: &str,
    sep_seg: &str,
    depth_content_offset: usize,
) -> String {
    let summary = event.get("summary").and_then(|v| v.as_str()).unwrap_or("");
    let tag_padded = pad("zoo", cfg.tag_width);
    let tag_seg = style_text(&tag_padded, cfg.s_cyan);
    let avail =
        20_usize.max(cfg.content_width.saturating_sub(depth_content_offset));
    let summary = truncate_display(summary, avail);
    format!(
        "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {}",
        style_text(&summary, cfg.s_dim)
    )
}

fn format_user_msg_op_line(
    cfg: &OpsRenderConfig,
    event: &serde_json::Map<String, Value>,
    time_seg: &str,
    model_seg: &str,
    sep_seg: &str,
    depth_content_offset: usize,
) -> String {
    let tag_padded = pad("User", cfg.tag_width);
    let tag_seg = style_text(&tag_padded, cfg.s_green);
    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if cfg.verbose {
        format!("{time_seg}  {model_seg}  {tag_seg} {sep_seg} {content}")
    } else {
        let one_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
        let content = truncate_display(
            &one_line,
            cfg.content_width.saturating_sub(depth_content_offset),
        );
        format!("{time_seg}  {model_seg}  {tag_seg} {sep_seg} {content}")
    }
}

fn format_assistant_reply_op_line(
    cfg: &OpsRenderConfig,
    event: &serde_json::Map<String, Value>,
    time_seg: &str,
    model_seg: &str,
    sep_seg: &str,
    depth_content_offset: usize,
) -> String {
    let agent =
        event.get("agent").and_then(|v| v.as_str()).unwrap_or("assistant");
    let tag_plain = format!("{agent}:");
    let tag_padded = pad(&tag_plain, cfg.tag_width);
    let tag_seg = style_text(&tag_padded, cfg.s_blue);
    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
    // The duration is attached by the helpers duration pass from the
    // provider-reported usage duration (OpenCode); pi records none, so no
    // `[x.xs]` prefix is shown there.
    let dur = event.get("duration_sec").and_then(serde_json::Value::as_f64);
    let dur_prefix = dur
        .map(|d| format!("{} ", style_text(&format!("[{d:.1}s]"), cfg.s_dim)))
        .unwrap_or_default();
    let dur_visible = dur.map_or(0, |d| format!("[{d:.1}s] ").len());
    if cfg.verbose {
        format!(
            "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {dur_prefix}{content}"
        )
    } else {
        let one_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
        let avail = 20_usize.max(
            cfg.content_width
                .saturating_sub(dur_visible)
                .saturating_sub(depth_content_offset),
        );
        let content = truncate_display(&one_line, avail);
        format!(
            "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {dur_prefix}{content}"
        )
    }
}

fn format_tool_op_line(
    cfg: &OpsRenderConfig,
    event: &serde_json::Map<String, Value>,
    time_seg: &str,
    model_seg: &str,
    sep_seg: &str,
    depth_content_offset: usize,
) -> String {
    let summary = event.get("summary").and_then(|v| v.as_str()).unwrap_or("");
    let (tool_name, arg) = summary.find(": ").map_or((summary, ""), |pos| {
        let (name, rest) = summary.split_at(pos);
        (name, &rest[2..])
    });

    let icon = event.get("icon").and_then(|v| v.as_str()).unwrap_or("●");
    let color_name = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let tag_plain = format!("{icon} {}", op_label(color_name));
    let tag_padded = pad(&tag_plain, cfg.tag_width);
    let tag_color = type_color(color_name);
    let tag_style_obj = Style::new().color(tag_color);
    let tag_seg = style_text(&tag_padded, &tag_style_obj);

    let dur = event.get("duration_sec").and_then(serde_json::Value::as_f64);
    let dur_seg = dur
        .map(|d| format!("{} ", style_text(&format!("[{d:.1}s]"), cfg.s_dim)))
        .unwrap_or_default();

    let mut line_content = format!("{tool_name} {arg}");
    line_content =
        line_content.split_whitespace().collect::<Vec<_>>().join(" ");
    let dur_visible = dur.map_or(0, |d| format!("[{d:.1}s] ").len());
    let avail = 20_usize.max(
        cfg.content_width
            .saturating_sub(dur_visible)
            .saturating_sub(depth_content_offset),
    );
    line_content = truncate_display(&line_content, avail);

    format!(
        "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {dur_seg}{line_content}"
    )
}

/// Render borders (top/bottom lines) for the current ops position.
/// Appends to `lines` and updates `depth_color` as blocks open and close.
fn render_op_borders(
    pos: usize,
    bottoms: &HashMap<usize, Vec<i64>>,
    tops: &HashMap<usize, Vec<(i64, String)>>,
    agent_map: &HashMap<String, String>,
    depth_color: &mut HashMap<i64, Style>,
    lines: &mut Vec<String>,
    cfg: &OpsRenderConfig,
) {
    if let Some(bot_depths) = bottoms.get(&pos) {
        for dep in bot_depths {
            let style = depth_color
                .get(dep)
                .cloned()
                .unwrap_or_else(|| Style::new().color(Color::from_ansi(2)));
            lines.push(ops_bottom_line(
                *dep,
                &style,
                cfg.col_prefix,
                cfg.prefix_width,
                cfg.term_width,
                cfg.s_dim,
            ));
            depth_color.remove(dep);
        }
    }
    if let Some(top_entries) = tops.get(&pos) {
        for (dep, bsid) in top_entries {
            let session_agent_str = agent_map
                .get(bsid.as_str())
                .map_or("", std::string::String::as_str);
            let color = agent_style(session_agent_str);
            depth_color.insert(*dep, color.clone());
            lines.push(ops_top_line(
                *dep,
                session_agent_str,
                &color,
                cfg.col_prefix,
                cfg.prefix_width,
                cfg.term_width,
                cfg.s_dim,
            ));
        }
    }
}

/// Pre-computed display segments for an ops summary line.
struct OpsLineSegments {
    time: String,
    model: String,
    sep: String,
}

/// Build the shared time/model/separator segments for an ops line.
fn build_ops_segments(
    index: usize,
    depth: i64,
    indent: &str,
    time_padded: &str,
    model_map: &[String],
    cfg: &OpsRenderConfig,
    depth_color: &HashMap<i64, Style>,
) -> OpsLineSegments {
    let model_raw =
        model_map.get(index).map_or("", std::string::String::as_str);
    let model_plain = if model_raw.is_empty() { "—" } else { model_raw };
    let model_display =
        if model_raw.len() > 18 { &model_raw[..18] } else { model_plain };
    let model_padded = pad(model_display, 18);
    let model_style_obj =
        if model_raw.is_empty() { cfg.s_dim } else { cfg.s_blue };

    let time_seg = style_text(time_padded, cfg.s_dim);
    let model_seg = style_text(&model_padded, model_style_obj);
    let default_depth_color = Style::new().color(Color::from_ansi(2));
    let depth_col = depth_color.get(&depth).unwrap_or(&default_depth_color);
    let sep_seg = if depth > 0 {
        let indent_str = format!("│{indent}");
        let indent_styled = style_text(&indent_str, cfg.s_dim);
        let separator = style_text("│", depth_col);
        format!("{indent_styled}{separator}")
    } else {
        style_text(&format!("{indent}│"), cfg.s_dim)
    };

    OpsLineSegments { time: time_seg, model: model_seg, sep: sep_seg }
}

/// Push a single formatted line for an ops event into `lines`.
fn push_op_line(
    lines: &mut Vec<String>,
    cfg: &OpsRenderConfig,
    event: &Map<String, Value>,
    etype: &str,
    source: &str,
    segs: &OpsLineSegments,
    depth_content_offset: usize,
) {
    if etype == "llm" || etype == "llm_stream" {
        lines.push(format_llm_op_line(
            cfg,
            event,
            &segs.time,
            &segs.model,
            &segs.sep,
        ));
    } else if source == "zoo" {
        lines.push(format_zoo_op_line(
            cfg,
            event,
            &segs.time,
            &segs.model,
            &segs.sep,
            depth_content_offset,
        ));
    } else if (source == "db" || source == "pi") && !etype.starts_with("tool_")
    {
        match etype {
            "user_msg" => lines.push(format_user_msg_op_line(
                cfg,
                event,
                &segs.time,
                &segs.model,
                &segs.sep,
                depth_content_offset,
            )),
            "assistant_reply" => {
                lines.push(format_assistant_reply_op_line(
                    cfg,
                    event,
                    &segs.time,
                    &segs.model,
                    &segs.sep,
                    depth_content_offset,
                ));
            }
            "assistant_reasoning" if cfg.verbose => {
                let tag_padded = pad("🧠 Reasoning", cfg.tag_width);
                let tag_seg = style_text(&tag_padded, cfg.s_dim);
                let content =
                    event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                lines.push(format!(
                    "{time_seg}  {model_seg}  {tag_seg} {sep_seg} {content}",
                    time_seg = segs.time,
                    model_seg = segs.model,
                    sep_seg = segs.sep,
                ));
            }
            _ => {}
        }
    } else {
        lines.push(format_tool_op_line(
            cfg,
            event,
            &segs.time,
            &segs.model,
            &segs.sep,
            depth_content_offset,
        ));
    }
}

/// Render per-event lines for ops summary.
fn render_ops_lines(
    ops: &[Value],
    tops: &HashMap<usize, Vec<(i64, String)>>,
    bottoms: &HashMap<usize, Vec<i64>>,
    agent_map: &HashMap<String, String>,
    model_map: &[String],
    cfg: &OpsRenderConfig,
) -> (Vec<String>, HashMap<i64, Style>) {
    let mut lines: Vec<String> = Vec::new();
    let mut depth_color: HashMap<i64, Style> = HashMap::new();

    for (pos, op) in ops.iter().enumerate() {
        let Some(event) = op.get("event").and_then(|v| v.as_object()) else {
            continue;
        };
        let ts = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let time_str = if ts.len() >= 19 {
            &ts[11..19]
        } else if ts.len() >= 8 {
            &ts[ts.len().saturating_sub(8)..]
        } else {
            ts
        };
        let index: usize = op
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            .try_into()
            .unwrap_or(0);
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let depth =
            event.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
        let depth_u = usize::try_from(depth.max(0)).unwrap_or(0);

        let time_padded = pad(time_str, 8);
        let indent = if depth > 0 {
            "  ".repeat(usize::try_from(depth.max(0)).unwrap_or(0))
        } else {
            String::new()
        };
        let depth_content_offset = if depth == 0 { 0 } else { 1 + depth_u * 2 };

        render_op_borders(
            pos,
            bottoms,
            tops,
            agent_map,
            &mut depth_color,
            &mut lines,
            cfg,
        );

        let segs = build_ops_segments(
            index,
            depth,
            &indent,
            &time_padded,
            model_map,
            cfg,
            &depth_color,
        );

        push_op_line(
            &mut lines,
            cfg,
            event,
            etype,
            source,
            &segs,
            depth_content_offset,
        );
    }

    (lines, depth_color)
}

/// Format the ops summary stats line.
fn format_ops_stats_line(stats: &Value) -> String {
    let tools = stats.get("tools").and_then(|v| v.as_object());
    let mut tool_parts: Vec<String> = Vec::new();
    if let Some(t) = tools {
        if let Some(n) =
            t.get("read").and_then(serde_json::Value::as_u64).filter(|&n| n > 0)
        {
            tool_parts.push(format!("读{n}"));
        }
        if let Some(n) = t
            .get("write")
            .and_then(serde_json::Value::as_u64)
            .filter(|&n| n > 0)
        {
            tool_parts.push(format!("写{n}"));
        }
        if let Some(n) =
            t.get("exec").and_then(serde_json::Value::as_u64).filter(|&n| n > 0)
        {
            tool_parts.push(format!("执行{n}"));
        }
        if let Some(n) =
            t.get("orch").and_then(serde_json::Value::as_u64).filter(|&n| n > 0)
        {
            tool_parts.push(format!("编排{n}"));
        }
        if let Some(n) = t
            .get("other")
            .and_then(serde_json::Value::as_u64)
            .filter(|&n| n > 0)
        {
            tool_parts.push(format!("其他{n}"));
        }
    }
    let tool_total = tools
        .and_then(|t| t.get("total").and_then(serde_json::Value::as_u64))
        .unwrap_or(0);
    let tool_str = if tool_parts.is_empty() {
        format!("tools: {tool_total}")
    } else {
        format!("tools: {tool_total}({})", tool_parts.join("/"))
    };
    let total_events = stats
        .get("total_events")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let llm_calls =
        stats.get("llm_calls").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let zoo_total = stats
        .get("zoo_interventions")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    format!(
        "[bold]总计: {total_events}[/bold] events | [bold]{llm_calls}[/bold] LLM | {tool_str} | {zoo_total} zoo"
    )
}

/// Print the ops summary footer stats.
fn print_ops_summary_footer(timeline: &[Value], stats: &Value) {
    let total_llm_dur: f64 = timeline
        .iter()
        .filter(|e| {
            let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
            etype == "llm" || etype == "llm_stream"
        })
        .filter_map(|e| {
            e.get("duration_sec").and_then(serde_json::Value::as_f64)
        })
        .sum();
    if total_llm_dur > 0.0 {
        let zoo_total = stats
            .get("zoo_interventions")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let total_events = stats
            .get("total_events")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let llm_calls = stats
            .get("llm_calls")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        msg_print(&format!(
            "[bold]总计: {total_events}[/bold] events | [bold]{llm_calls}[/bold] LLM ({total_llm_dur:.1}s) | {zoo_total} zoo"
        ));
    }
}

/// Chronological operations summary with fixed-width columns.
///
/// This is the MOST COMPLEX display function.
///
/// Time column: 8 chars, HH:MM:SS.
/// Model column: 18 chars, right-padded/truncated.
/// Tag column: dynamic width (max 14), with icon + Chinese label.
/// Separator `│` with depth-based indentation.
/// Content column: remaining terminal width.
/// Child session events: indented + `[子:agent]` prefix.
/// Block borders: `╭─ [session:agent] ───` and `╰─────────────`.
/// Colors by agent: lynx=cyan, beaver=magenta, dolphin=blue, default=green.
pub fn render_ops_summary(timeline: &[Value], stats: &Value, verbose: bool) {
    if timeline.is_empty() {
        msg_print("[yellow]No events in timeline.[/yellow]");
        return;
    }

    let model_map = build_model_map(timeline);
    let ops = collect_sorted_ops(timeline, verbose);
    let (tops, bottoms) = mark_block_boundaries(&ops);

    // Build agent map from ops
    let mut agent_map: HashMap<String, String> = HashMap::new();
    for op in &ops {
        let event = op.get("event").and_then(|v| v.as_object());
        if let Some(e) = event {
            let sid = e
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !sid.is_empty() && !agent_map.contains_key(&sid) {
                let agent = e
                    .get("session_agent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                agent_map.insert(sid, agent);
            }
        }
    }

    let tag_labels = build_op_tag_labels(&ops, verbose);
    let tag_width =
        tag_labels.iter().map(|t| display_width(t)).max().unwrap_or(8).min(14);

    let term_width = get_terminal_width();
    let content_width = term_width.saturating_sub(33 + tag_width).max(20);

    let s_dim = Style::new().dim();
    let s_blue = Style::new().color(Color::from_ansi(4));
    let s_green = Style::new().color(Color::from_ansi(2));
    let s_cyan = Style::new().color(Color::from_ansi(6));

    let empty_time = style_text(&pad("", 8), &s_dim);
    let empty_model = style_text(&pad("", 18), &s_dim);
    let empty_tag = style_text(&pad("", tag_width), &s_dim);
    let col_prefix = format!("{empty_time}  {empty_model}  {empty_tag} ");
    let prefix_width = 8 + 2 + 18 + 2 + tag_width + 1;

    let ops_cfg = OpsRenderConfig {
        tag_width,
        content_width,
        verbose,
        s_dim: &s_dim,
        s_blue: &s_blue,
        s_green: &s_green,
        s_cyan: &s_cyan,
        col_prefix: &col_prefix,
        prefix_width,
        term_width,
    };
    let (mut lines, depth_color) = render_ops_lines(
        &ops, &tops, &bottoms, &agent_map, &model_map, &ops_cfg,
    );

    // Close any open child blocks
    if let Some(bot_depths) = bottoms.get(&ops.len()) {
        for dep in bot_depths {
            let style = depth_color
                .get(dep)
                .cloned()
                .unwrap_or_else(|| Style::new().color(Color::from_ansi(2)));
            lines.push(ops_bottom_line(
                *dep,
                &style,
                &col_prefix,
                prefix_width,
                term_width,
                &s_dim,
            ));
        }
    }

    println!("{}", lines.join("\n"));

    // Bottom stats
    print_ops_summary_footer(timeline, stats);
    println!();
    msg_print(&format_ops_stats_line(stats));
}
