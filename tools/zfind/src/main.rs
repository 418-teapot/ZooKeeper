#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use clap::Parser;

use serde_json::Value;

use zutil::estimate_tokens;

mod db;
mod display;
mod helpers;

use crate::db::{
    query_message_by_ids, query_message_parts, query_sessions,
    query_sessions_all, query_sessions_exact,
};
use crate::display::{
    print_json_messages, print_json_session_messages, print_json_sessions,
    print_message_detail, print_session_messages_table, print_session_table,
};
use crate::helpers::{classify_role, preview_text};
use zutil::color::COLOR;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "zfind",
    about = "ZooKeeper session finder -- search OpenCode sessions \
             and messages in SQLite.",
    disable_help_subcommand = true
)]
struct Args {
    /// Fuzzy keyword to search session titles
    keyword: Option<String>,

    /// List all main (root) sessions, most recent first
    #[arg(long)]
    all: bool,

    /// Search sessions with exact title match
    #[arg(long, value_name = "TITLE")]
    exact: Option<String>,

    /// Retrieve one or more messages by ID
    #[arg(long, num_args = 1.., value_name = "ID")]
    message: Vec<String>,

    /// Session ID: list all messages when used alone, or scope for
    /// --message search
    #[arg(long, value_name = "SID")]
    session: Option<String>,

    /// Number of recent sessions to scan when --session not given
    #[arg(long, default_value_t = 200)]
    scan: usize,

    /// Output results as a JSON envelope
    #[arg(long)]
    json: bool,

    /// Path to the `OpenCode` `SQLite` database
    #[arg(long, default_value = "~/.local/share/opencode/opencode.db")]
    db: String,

    /// Disable colored output
    #[arg(long)]
    no_color: bool,

    /// Maximum number of sessions to return
    #[arg(long, default_value_t = 5000)]
    session_list_limit: usize,
}

// ── Command Handlers ─────────────────────────────────────────────────────────

fn cmd_keyword(args: &Args) {
    let kw = args.keyword.as_ref().unwrap_or_else(|| unreachable!());
    let results = query_sessions(kw, &args.db, args.session_list_limit);

    if results.is_empty() {
        eprintln!(
            "Error: no sessions found matching \"{}\"",
            args.keyword.as_ref().unwrap()
        );
        std::process::exit(2);
    }

    if args.json {
        print_json_sessions(&results, args.keyword.as_ref().unwrap());
    } else {
        print_session_table(&results, false, args.keyword.as_deref());
    }
}

fn cmd_all(args: &Args) {
    let results = query_sessions_all(&args.db, args.session_list_limit);

    if results.is_empty() {
        eprintln!("Error: no sessions found in database.");
        std::process::exit(2);
    }

    if args.json {
        print_json_sessions(&results, "");
    } else {
        print_session_table(&results, true, None);
    }
}

fn cmd_exact(args: &Args) {
    let title = args.exact.as_ref().unwrap_or_else(|| unreachable!());
    let results =
        query_sessions_exact(title, &args.db, args.session_list_limit);

    if results.is_empty() {
        eprintln!("Error: no session found with exact title \"{title}\"");
        std::process::exit(2);
    }

    if args.json {
        print_json_sessions(&results, title);
    } else {
        print_session_table(&results, false, Some(title));
    }
}

fn cmd_message(args: &Args) {
    let msg_ids = &args.message;
    let results = query_message_by_ids(
        msg_ids,
        args.session.as_deref(),
        &args.db,
        args.scan,
    );

    if results.is_empty() {
        eprintln!(
            "Error: no messages found matching IDs: {}",
            msg_ids.join(" ")
        );
        std::process::exit(2);
    }

    if args.json {
        print_json_messages(&results, msg_ids);
    } else {
        print_message_detail(&results);
    }
}

fn cmd_session_messages(args: &Args) {
    let session_id = args.session.as_ref().expect("session required");
    let messages = query_message_parts(session_id, &args.db);

    if messages.is_empty() {
        eprintln!("Error: no messages found for session: {session_id}");
        std::process::exit(2);
    }

    if args.json {
        // Build the output rows
        let mut json_rows: Vec<HashMap<String, Value>> = Vec::new();
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
            let preview = preview_text(&parts, 40);

            json_rows.push(
                serde_json::from_value(serde_json::json!({
                    "index": idx + 1,
                    "role": display_role,
                    "tokens": total_tokens,
                    "id": msg_id,
                    "preview": preview,
                }))
                .expect("json! to HashMap"),
            );
        }
        print_json_session_messages(&json_rows, session_id);
    } else {
        print_session_messages_table(&messages, session_id);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();

    let colors_enabled = !args.no_color;
    COLOR.store(colors_enabled, Ordering::SeqCst);

    // Warn if both keyword and --session are provided
    if let (Some(kw), Some(_)) = (args.keyword.as_ref(), args.session.as_ref())
    {
        eprintln!(
            "Warning: keyword argument '{kw}' is ignored when \
             --session is specified"
        );
    }

    // Dispatch logic (order matters!)
    if !args.message.is_empty() {
        cmd_message(&args);
    } else if args.session.is_some() {
        cmd_session_messages(&args);
    } else if args.exact.is_some() {
        cmd_exact(&args);
    } else if args.all {
        cmd_all(&args);
    } else if args.keyword.is_some() {
        cmd_keyword(&args);
    } else {
        // Print help and exit 1
        use clap::CommandFactory;
        let mut cmd = Args::command();
        let _ = cmd.print_help();
        println!();
        std::process::exit(1);
    }
}
