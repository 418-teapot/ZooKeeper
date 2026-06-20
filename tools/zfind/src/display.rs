use std::collections::HashMap;

use rich_rust::color::Color;
use rich_rust::renderables::table::{Cell, Column, Row, Table};
use rich_rust::style::Style;
use rich_rust::terminal;
use rich_rust::text::{JustifyMethod, Text};

use serde_json::Value;

use zutil::{estimate_tokens, format_number, ts_display};

use crate::helpers::{
    classify_role, msg_print, preview_text, render_segments_to_ansi, style_text,
};

/// Print a table of session results.
///
/// Single match + non-JSON -> print only the session ID (pipe-friendly).
/// Multiple matches -> render a styled table.
pub fn print_session_table(
    results: &[Value],
    is_all: bool,
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
    let bold = Style::new().bold();
    if is_all {
        println!(
            "\n{}",
            style_text("All main sessions (most recent first):", &bold)
        );
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

    let cyan = Style::new().color(Color::from_ansi(6));
    let green = Style::new().color(Color::from_ansi(2));
    let width = terminal::get_terminal_width();

    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);

    table.add_column(Column::new("Title"));
    if is_all {
        table.add_column(Column::new("Agent"));
        table.add_column(Column::new("Session ID"));
        table.add_column(Column::new("Updated"));

        for s in results {
            let title = s
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let agent = s.get("agent").and_then(|v| v.as_str()).unwrap_or("");
            let session_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let updated = s
                .get("time_updated")
                .and_then(|v| v.as_str())
                .map(ts_display)
                .unwrap_or_default();

            table.add_row(Row::new(vec![
                Cell::new(Text::from(title)),
                Cell::new(Text::styled(agent.to_string(), cyan.clone())),
                Cell::new(Text::styled(session_id.to_string(), cyan.clone())),
                Cell::new(Text::styled(updated, green.clone())),
            ]));
        }
    } else {
        table.add_column(Column::new("Session ID"));
        table.add_column(Column::new("Updated"));

        for s in results {
            let title = s
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let session_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let updated = s
                .get("time_updated")
                .and_then(|v| v.as_str())
                .map(ts_display)
                .unwrap_or_default();

            table.add_row(Row::new(vec![
                Cell::new(Text::from(title)),
                Cell::new(Text::styled(session_id.to_string(), cyan.clone())),
                Cell::new(Text::styled(updated, green.clone())),
            ]));
        }
    }

    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
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

/// Print detailed message output with parts content.
#[allow(clippy::too_many_lines)]
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
        let agent = msg.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp =
            msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");

        msg_print("");
        msg_print(&format!("[bold]Message:[/bold] {msg_id}"));
        msg_print(&format!("  Role: {role}"));
        if !agent.is_empty() {
            msg_print(&format!("  Agent: {agent}"));
        }
        if !timestamp.is_empty() {
            msg_print(&format!("  Timestamp: {timestamp}"));
        }
        msg_print(&format!("  Tokens: {}", format_number(tokens)));

        // Parts content
        let mut visible_idx = 0;
        for part in &parts {
            let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match ptype {
                "text" => {
                    visible_idx += 1;
                    let text =
                        part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    msg_print(&format!(
                        "  [bold]Part {visible_idx} (text):[/bold]"
                    ));
                    for line in text.split('\n') {
                        msg_print(&format!("    {line}"));
                    }
                }
                "reasoning" => {
                    visible_idx += 1;
                    let text =
                        part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    msg_print(&format!(
                        "  [bold]Part {visible_idx} (reasoning):[/bold]"
                    ));
                    for line in text.split('\n') {
                        msg_print(&format!("    {line}"));
                    }
                }
                "tool" => {
                    visible_idx += 1;
                    let tool_name = part
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?");
                    let state = part.get("state");
                    let inp = state.and_then(|s| s.get("input")).cloned();
                    let out = state.and_then(|s| s.get("output")).cloned();

                    msg_print(&format!(
                        "  [bold]Part {visible_idx} (tool: {tool_name}):[/bold]"
                    ));

                    if let Some(Value::Object(ref obj)) = inp {
                        if !obj.is_empty() {
                            let inp_str =
                                serde_json::to_string(obj).unwrap_or_default();
                            msg_print(&format!("    Input: {inp_str}"));
                        }
                    } else if let Some(ref v) = inp {
                        msg_print(&format!("    Input: {v}"));
                    }

                    if let Some(Value::Object(ref obj)) = out {
                        if !obj.is_empty() {
                            let mut out_str =
                                serde_json::to_string(obj).unwrap_or_default();
                            if out_str.len() > 500 {
                                out_str = format!("{}...", &out_str[..497]);
                            }
                            msg_print(&format!("    Output: {out_str}"));
                        }
                    } else if let Some(ref v) = out {
                        let out_str = v.to_string();
                        if out_str.len() > 500 {
                            msg_print(&format!(
                                "    Output: {}...",
                                &out_str[..497]
                            ));
                        } else {
                            msg_print(&format!("    Output: {out_str}"));
                        }
                    }
                }
                "step-finish" => {
                    // Skip step-finish parts in display
                }
                _ => {
                    visible_idx += 1;
                    msg_print(&format!(
                        "  [bold]Part {visible_idx} ({ptype}):[/bold]"
                    ));
                    let json_str =
                        serde_json::to_string(part).unwrap_or_default();
                    msg_print(&format!("  {json_str}"));
                }
            }
        }
    }
}

/// Print a table of messages for a session.
pub fn print_session_messages_table(messages: &[Value], session_id: &str) {
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
        style_text("Messages for session:", &bold),
        style_text(session_id, &bold),
        style_text(&messages.len().to_string(), &green),
    );

    let width = terminal::get_terminal_width();

    let mut table =
        Table::new().show_header(true).show_edge(true).show_lines(false);

    table.add_column(
        Column::new("#").justify(JustifyMethod::Right).min_width(3),
    );
    table.add_column(Column::new("Role"));
    table.add_column(
        Column::new("Tokens").justify(JustifyMethod::Right).min_width(6),
    );
    table.add_column(Column::new("ID"));
    table.add_column(Column::new("Preview"));

    for (idx, msg) in messages.iter().enumerate() {
        let role =
            msg.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let parts = msg
            .get("parts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");

        let total_tokens = estimate_tokens(&parts);
        let display_role = classify_role(role, &parts);
        let preview = preview_text(&parts);

        let role_color =
            role_colors.get(display_role.as_str()).unwrap_or(&default_color);

        table.add_row(Row::new(vec![
            Cell::new((idx + 1).to_string()),
            Cell::new(Text::styled(display_role, role_color.clone())),
            Cell::new(format_number(total_tokens)),
            Cell::new(Text::styled(msg_id.to_string(), cyan.clone())),
            Cell::new(preview),
        ]));
    }

    let segments = table.render(width);
    println!("{}", render_segments_to_ansi(&segments));
    println!();
}
