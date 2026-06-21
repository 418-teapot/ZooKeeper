// ztrace display — session panel rendering.

use rich_rust::color::Color;
use rich_rust::markup;
use rich_rust::renderables::panel::Panel;
use rich_rust::style::Style;
use rich_rust::terminal;
use serde_json::Value;

use crate::helpers::find_session_info;

use super::common::render_panel;

// ── A. Session Panel ──────────────────────────────────────────────────────────

/// Build verbose detail panel lines for session info.
fn build_verbose_session_lines(
    session_id: &str,
    timeline: &[Value],
    stats: &Value,
) -> Vec<String> {
    let info = find_session_info(timeline);
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Session ID: [cyan]{session_id}[/cyan]"));

    if let Some(ref info) = info {
        if let Some(slug) =
            info.get("slug").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        {
            lines.push(format!("Slug:       [bold]{slug}[/bold]"));
        }
        if let Some(agent) =
            info.get("agent").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        {
            lines.push(format!("Agent:      [green]{agent}[/green]"));
        }
        if let Some(model) =
            info.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        {
            lines.push(format!("Model:      [blue]{model}[/blue]"));
        }
        if let Some(provider) = info
            .get("provider")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            lines.push(format!("Provider:   {provider}"));
        }
        if let Some(pid) = info
            .get("project_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            lines.push(format!("Project ID: [dim]{pid}[/dim]"));
        }
    }

    if let Some(ts) = stats.get("time_span")
        && let Some(secs) =
            ts.get("seconds").and_then(serde_json::Value::as_i64)
    {
        let dur_str = if secs >= 60 {
            format!("{}m {}s", secs / 60, secs % 60)
        } else {
            format!("{secs}s")
        };
        lines.push(format!("Duration:   [yellow]{dur_str}[/yellow]"));
    }

    // Child session summary
    if let Some(child_sessions) =
        stats.get("child_sessions").and_then(|v| v.as_array())
        && !child_sessions.is_empty()
    {
        let total = child_sessions.len();
        lines.push(format!("子 sessions: [cyan]{total}[/cyan]"));
        for cs in child_sessions {
            let agent = cs.get("agent").and_then(|v| v.as_str()).unwrap_or("?");
            let sid_short = {
                let sid =
                    cs.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                if sid.len() > 12 {
                    format!("{}...", &sid[..12])
                } else {
                    sid.to_string()
                }
            };
            let count = cs
                .get("event_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            lines.push(format!(
                "  ├ [dim]{sid_short}[/dim] [green]{agent}[/green] [yellow]{count}[/yellow] events"
            ));
        }
        lines.push(String::new());
    }

    lines
}

/// Build compact single-line session panel content.
fn build_compact_session_panel(
    session_id: &str,
    timeline: &[Value],
    stats: &Value,
) {
    let width = terminal::get_terminal_width();
    let info = find_session_info(timeline);
    let slug = info
        .as_ref()
        .and_then(|v| v.get("slug").and_then(|s| s.as_str()))
        .unwrap_or("");
    let agent = info
        .as_ref()
        .and_then(|v| v.get("agent").and_then(|s| s.as_str()))
        .unwrap_or("");
    let model = info
        .as_ref()
        .and_then(|v| v.get("model").and_then(|s| s.as_str()))
        .unwrap_or("");

    let dur_str = stats
        .get("time_span")
        .and_then(|ts| ts.get("seconds").and_then(serde_json::Value::as_i64))
        .map(|secs| {
            if secs >= 60 {
                format!("{}m {}s", secs / 60, secs % 60)
            } else {
                format!("{secs}s")
            }
        })
        .unwrap_or_default();

    let sid_short = if session_id.len() > 20 {
        format!("{}…", &session_id[..20])
    } else {
        session_id.to_string()
    };

    let title_str = if slug.is_empty() {
        format!("Session ({sid_short})")
    } else {
        format!("Session: {slug} ({sid_short})")
    };

    let mut content_parts: Vec<String> = Vec::new();
    if !agent.is_empty() {
        content_parts.push(format!("Agent: [green]{agent}[/green]"));
    }
    if !model.is_empty() {
        content_parts.push(format!("Model: [blue]{model}[/blue]"));
    }
    if !dur_str.is_empty() {
        content_parts.push(format!("Duration: [yellow]{dur_str}[/yellow]"));
    }

    let mut panel_content = content_parts.join("  ");

    if let Some(child_total) = stats
        .get("total_child_sessions")
        .and_then(serde_json::Value::as_u64)
        .filter(|&n| n > 0)
    {
        let child_line = format!("子 sessions: [cyan]{child_total}[/cyan]");
        if panel_content.is_empty() {
            panel_content = child_line;
        } else {
            panel_content = format!("{panel_content}\n{child_line}");
        }
    }

    let content_text = markup::render_or_plain(&panel_content);
    let panel = Panel::from_rich_text(&content_text, width)
        .title_from_markup(&format!("[bold]{title_str}[/bold]"))
        .border_style(Style::new().color(Color::from_ansi(6)));
    render_panel(width, &panel);
    println!();
}

/// Build the stats line for verbose session panel.
fn build_verbose_stats_line(timeline: &[Value], stats: &Value) -> String {
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
    let llm_dur_str = if total_llm_dur > 0.0 {
        format!(" ({total_llm_dur:.1}s)")
    } else {
        String::new()
    };

    let total_events = stats
        .get("total_events")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let llm_calls =
        stats.get("llm_calls").and_then(serde_json::Value::as_u64).unwrap_or(0);
    format!(
        "Stats: [bold]{total_events}[/bold] events | [bold]{llm_calls}[/bold] LLM{llm_dur_str} | {tool_str} | {} permissions | {} zoo",
        stats
            .get("permission_checks")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        stats
            .get("zoo_interventions")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    )
}

/// Render session summary panel.
///
/// In compact mode: single-line header with slug, agent, model, duration,
/// child sessions count.  In verbose/full mode: complete detail panel.
pub fn render_session_panel(
    session_id: &str,
    timeline: &[Value],
    stats: &Value,
    compact: bool,
) {
    let width = terminal::get_terminal_width();

    if compact {
        build_compact_session_panel(session_id, timeline, stats);
        return;
    }

    // ── Full detail panel (verbose mode) ──
    let mut lines = build_verbose_session_lines(session_id, timeline, stats);

    lines.push(String::new());
    lines.push(build_verbose_stats_line(timeline, stats));

    // Build panel content with markup
    let content_str = lines.join("\n");
    let content_text = markup::render_or_plain(&content_str);
    let panel = Panel::from_rich_text(&content_text, width)
        .title_from_markup("[bold]Session Summary[/bold]")
        .border_style(Style::new().color(Color::from_ansi(6)));
    render_panel(width, &panel);
    println!();
}
