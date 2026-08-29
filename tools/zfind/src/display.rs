use std::collections::HashMap;

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::text::{JustifyMethod, OverflowMethod, Text};
use zutil::get_terminal_width;

use serde_json::Value;

use zutil::{estimate_tokens, format_number, ts_display};

use zutil::color::{render_segments_to_ansi, style_text};

use zutil::color::msg_print;

/// Print session title + header based on format.
fn print_session_header(
    results: &[Value],
    is_all: bool,
    include_sub_sessions: bool,
    keyword: Option<&str>,
) {
    let bold = Style::new().bold();
    if is_all {
        let title = if include_sub_sessions {
            "All sessions (including sub-sessions, most recent first):"
        } else {
            "All main sessions (most recent first):"
        };
        println!("\n{}", style_text(title, &bold));
    } else if let Some(kw) = keyword {
        println!(
            "\n{}",
            style_text(
                &format!(
                    "Found {} sessions matching \"{}\":",
                    results.len(),
                    kw
                ),
                &bold
            )
        );
    } else {
        println!(
            "\n{}",
            style_text(&format!("Found {} sessions:", results.len()), &bold)
        );
    }
    println!();
}

/// Populate the session table: title, host, session id, and updated time.
fn populate_table(
    table: &mut Table,
    results: &[Value],
    cyan: &Style,
    green: &Style,
) {
    table.add_column(
        Column::new("Host").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Session ID").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Updated").no_wrap().overflow(OverflowMethod::Ellipsis),
    );

    for s in results {
        let title =
            s.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let host = s.get("host").and_then(|v| v.as_str()).unwrap_or("");
        let session_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let updated = s
            .get("time_updated")
            .and_then(|v| v.as_str())
            .map(ts_display)
            .unwrap_or_default();

        table.add_row(Row::new(vec![
            Cell::new(Text::from(title)),
            Cell::new(Text::styled(host.to_string(), cyan.clone())),
            Cell::new(Text::styled(session_id.to_string(), cyan.clone())),
            Cell::new(Text::styled(updated, green.clone())),
        ]));
    }
}

/// Print a table of session results.
///
/// Single match + non-JSON -> print only the session ID (pipe-friendly).
/// Multiple matches -> render a styled table.
pub fn print_session_table(
    results: &[Value],
    is_all: bool,
    include_sub_sessions: bool,
    keyword: Option<&str>,
) {
    if results.is_empty() {
        return;
    }

    if results.len() == 1 {
        // Single match: output only the session ID
        if let Some(id) = results[0].get("id").and_then(|v| v.as_str()) {
            println!("{id}");
        }
        return;
    }

    // Multiple matches: render a table
    print_session_header(results, is_all, include_sub_sessions, keyword);

    let cyan = Style::new().color(Color::from_ansi(6));
    let green = Style::new().color(Color::from_ansi(2));
    let width = get_terminal_width();

    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);

    table.add_column(
        Column::new("Title").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    populate_table(&mut table, results, &cyan, &green);

    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
    println!();
}

/// Print session metadata (non-JSON `show` header block).
///
/// The agent and session-level model (from the session store's first
/// assistant message) render only when the host recorded them.
pub fn print_session_meta(
    session_id: &str,
    host: &str,
    meta: &zutil::session::SessionMeta,
) {
    let bold = Style::new().bold();
    println!("\n{}", style_text(&format!("Session: {session_id}"), &bold));
    if let Some(label) = &meta.label {
        println!("  Title: {label}");
    }
    println!("  Host: {host}");
    if let Some(agent) = &meta.agent {
        println!("  Agent: {agent}");
    }
    if let Some(model) = &meta.model {
        println!("  Model: {model}");
    }
    println!("  Cwd: {}", meta.cwd);
    if let Some(parent) = &meta.parent_id {
        println!("  Parent: {parent}");
    }
    println!("  Started: {}", zutil::epoch_ms_to_iso(meta.started_at));
    println!();
}

/// Print session results as a JSON envelope with a keyword.
pub fn print_json_sessions(results: &[Value], keyword: &str) {
    let envelope = serde_json::json!({
        "keyword": keyword,
        "matches": results.len(),
        "sessions": results,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).expect("JSON serialization")
    );
}

/// Print message results as a JSON envelope with IDs.
pub fn print_json_messages(results: &[Value], ids: &[String]) {
    let kw = ids.join(" ");
    let envelope = serde_json::json!({
        "keyword": kw,
        "matches": results.len(),
        "messages": results,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).expect("JSON serialization")
    );
}

/// Print session messages as a JSON envelope.
pub fn print_json_session_messages(
    rows: &[HashMap<String, Value>],
    session_id: &str,
) {
    let envelope = serde_json::json!({
        "keyword": session_id,
        "matches": rows.len(),
        "messages": rows,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).expect("JSON serialization")
    );
}

/// Print a text or reasoning part.
fn print_text_part(part: &Value, visible_idx: &mut usize, label: &str) {
    *visible_idx += 1;
    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
    msg_print(&format!("  [bold]Part {visible_idx} ({label}):[/bold]"));
    for line in text.split('\n') {
        msg_print(&format!("    {line}"));
    }
}

/// Print a tool part (with input/output).
fn print_tool_part(part: &Value, visible_idx: &mut usize) {
    *visible_idx += 1;
    let tool_name = part.get("tool").and_then(|v| v.as_str()).unwrap_or("?");
    let state = part.get("state");
    let inp = state.and_then(|s| s.get("input")).cloned();
    let out = state.and_then(|s| s.get("output")).cloned();

    msg_print(&format!(
        "  [bold]Part {visible_idx} (tool: {tool_name}):[/bold]"
    ));

    if let Some(Value::Object(ref obj)) = inp {
        if !obj.is_empty() {
            let inp_str = serde_json::to_string(obj).unwrap_or_default();
            msg_print(&format!("    Input: {inp_str}"));
        }
    } else if let Some(ref v) = inp {
        msg_print(&format!("    Input: {v}"));
    }

    if let Some(Value::Object(ref obj)) = out {
        if !obj.is_empty() {
            let mut out_str = serde_json::to_string(obj).unwrap_or_default();
            if out_str.len() > 500 {
                out_str = format!("{}...", &out_str[..497]);
            }
            msg_print(&format!("    Output: {out_str}"));
        }
    } else if let Some(ref v) = out {
        let out_str = v.to_string();
        if out_str.len() > 500 {
            msg_print(&format!("    Output: {}...", &out_str[..497]));
        } else {
            msg_print(&format!("    Output: {out_str}"));
        }
    }
}

/// Print an unknown part type as raw JSON.
fn print_unknown_part(part: &Value, visible_idx: &mut usize, ptype: &str) {
    *visible_idx += 1;
    msg_print(&format!("  [bold]Part {visible_idx} ({ptype}):[/bold]"));
    let json_str = serde_json::to_string(part).unwrap_or_default();
    msg_print(&format!("  {json_str}"));
}

/// Print detailed message output with parts content.
pub fn print_message_detail(results: &[Value]) {
    for msg in results {
        let role =
            msg.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let parts = msg
            .get("parts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let tokens = estimate_tokens(&parts);
        let timestamp =
            msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");

        msg_print("");
        msg_print(&format!("[bold]Message:[/bold] {msg_id}"));
        msg_print(&format!("  Role: {role}"));
        if !timestamp.is_empty() {
            msg_print(&format!("  Timestamp: {timestamp}"));
        }
        msg_print(&format!("  Tokens: {}", format_number(tokens)));

        // Parts content
        let mut visible_idx = 0;
        for part in &parts {
            let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match ptype {
                "text" => print_text_part(part, &mut visible_idx, "text"),
                "reasoning" => {
                    print_text_part(part, &mut visible_idx, "reasoning");
                }
                "tool" => print_tool_part(part, &mut visible_idx),
                "step-finish" => {
                    // Skip step-finish parts in display
                }
                _ => print_unknown_part(part, &mut visible_idx, ptype),
            }
        }
    }
}

/// Print a table of events for a session.
///
/// Rows are the precomputed show rows (`{index, role, tokens, id,
/// preview}`) built by the session adapter.
pub fn print_session_messages_table(
    rows: &[HashMap<String, Value>],
    session_id: &str,
) {
    let cyan = Style::new().color(Color::from_ansi(6));
    let green = Style::new().color(Color::from_ansi(2));
    let bold = Style::new().bold();
    let role_colors: HashMap<&str, Style> = [
        ("user", Style::new().color(Color::from_ansi(2))),
        ("assistant", Style::new().color(Color::from_ansi(4))),
        ("tool_use", Style::new().color(Color::from_ansi(5))),
        ("tool_result", Style::new().color(Color::from_ansi(3))),
    ]
    .iter()
    .cloned()
    .collect();
    let default_color = Style::new();

    println!(
        "\n{} {} ({})\n",
        style_text("Events for session:", &bold),
        style_text(session_id, &bold),
        style_text(&rows.len().to_string(), &green),
    );

    let width = get_terminal_width();

    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);

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
        Column::new("ID").no_wrap().overflow(OverflowMethod::Ellipsis),
    );
    table.add_column(
        Column::new("Preview").no_wrap().overflow(OverflowMethod::Ellipsis),
    );

    for (idx, msg) in rows.iter().enumerate() {
        let role =
            msg.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let tokens = msg
            .get("tokens")
            .and_then(Value::as_i64)
            .map_or(0, |t| usize::try_from(t.max(0)).unwrap_or(0));
        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let preview = msg.get("preview").and_then(|v| v.as_str()).unwrap_or("");

        let role_color = role_colors.get(role).unwrap_or(&default_color);

        table.add_row(Row::new(vec![
            Cell::new((idx + 1).to_string()),
            Cell::new(Text::styled(role.to_string(), role_color.clone())),
            Cell::new(format_number(tokens)),
            Cell::new(Text::styled(msg_id.to_string(), cyan.clone())),
            Cell::new(preview.to_string()),
        ]));
    }

    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
    println!();
}
