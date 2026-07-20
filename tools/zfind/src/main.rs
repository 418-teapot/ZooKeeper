#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use clap::{Parser, Subcommand};

use serde_json::Value;

use zutil::db_helpers::resolve_session_id;
use zutil::estimate_tokens;

mod db;
mod display;
mod helpers;

use crate::db::{
    query_message_by_ids, query_message_parts, query_sessions,
    query_sessions_all, query_sessions_all_including_children,
    query_sessions_exact,
};
use crate::display::{
    print_json_messages, print_json_session_messages, print_json_sessions,
    print_message_detail, print_session_messages_table, print_session_table,
};
use crate::helpers::{classify_role, preview_text};
use zutil::color::COLOR;

/// Default limit for `list` (not configurable on that subcommand).
const DEFAULT_LIST_LIMIT: usize = 5000;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "zfind",
    about = "ZooKeeper session finder -- search OpenCode sessions \
             and messages in SQLite.",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Output results as a JSON envelope
    #[arg(short = 'j', long, global = true)]
    json: bool,

    /// Path to the `OpenCode` `SQLite` database
    #[arg(
        long,
        default_value = "~/.local/share/opencode/opencode.db",
        global = true
    )]
    db: String,

    /// Disable colored output
    #[arg(long, global = true)]
    no_color: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Fuzzy search session titles by keyword, or exact title match with
    /// --exact
    Search {
        /// Keyword to search for in session titles
        keyword: Option<String>,

        /// Search sessions with exact title match
        #[arg(long, value_name = "TITLE")]
        exact: Option<String>,

        /// Maximum number of sessions to return
        #[arg(long, default_value_t = 5000)]
        session_list_limit: usize,
    },

    /// List sessions, most recent first (root sessions by default; use --all
    /// to include sub-sessions)
    List {
        /// Include sub-sessions in the listing
        #[arg(short = 'a', long)]
        all: bool,
    },

    /// List messages of a session
    Show {
        /// Session ID
        session_id: String,
    },

    /// Retrieve one or more messages by ID (supports prefix matching)
    Message {
        /// Message ID(s) to retrieve
        #[arg(required = true, num_args = 1.., value_name = "ID")]
        ids: Vec<String>,

        /// Session ID to scope the search (speeds up lookup)
        #[arg(long, value_name = "SID")]
        session: Option<String>,

        /// Number of recent sessions to scan when --session not given
        #[arg(long, default_value_t = 200)]
        scan: usize,
    },
}

// ── Command Handlers ─────────────────────────────────────────────────────────

fn cmd_search(
    keyword: Option<&str>,
    exact: Option<&str>,
    db: &str,
    json: bool,
    session_list_limit: usize,
) {
    if let Some(title) = exact {
        let results = query_sessions_exact(title, db, session_list_limit)
            .unwrap_or_else(|e| {
                eprintln!("Error: database query failed: {e}");
                std::process::exit(1);
            });

        if results.is_empty() {
            eprintln!("Error: no session found with exact title \"{title}\"");
            std::process::exit(2);
        }

        if json {
            print_json_sessions(&results, title);
        } else {
            print_session_table(&results, false, false, Some(title));
        }
    } else if let Some(kw) = keyword {
        let results = query_sessions(kw, db, session_list_limit)
            .unwrap_or_else(|e| {
                eprintln!("Error: database query failed: {e}");
                std::process::exit(1);
            });

        if results.is_empty() {
            eprintln!("Error: no sessions found matching \"{kw}\"");
            std::process::exit(2);
        }

        if json {
            print_json_sessions(&results, kw);
        } else {
            print_session_table(&results, false, false, Some(kw));
        }
    } else {
        eprintln!("Error: either a keyword or --exact must be provided.");
        std::process::exit(1);
    }
}

fn cmd_list(db: &str, json: bool, all: bool) {
    let results = if all {
        query_sessions_all_including_children(db, DEFAULT_LIST_LIMIT)
    } else {
        query_sessions_all(db, DEFAULT_LIST_LIMIT)
    }
    .unwrap_or_else(|e| {
        eprintln!("Error: database query failed: {e}");
        std::process::exit(1);
    });

    if results.is_empty() {
        eprintln!("Error: no sessions found in database.");
        std::process::exit(2);
    }

    if json {
        print_json_sessions(&results, "");
    } else {
        print_session_table(&results, true, all, None);
    }
}

fn cmd_show(session_id: &str, db: &str, json: bool) {
    let resolved = match resolve_session_id(session_id, db) {
        Ok(Some(id)) => id,
        Ok(None) => {
            eprintln!("Error: no session found matching '{session_id}'");
            std::process::exit(2);
        }
        Err(amb) => {
            eprintln!(
                "Error: ambiguous session ID prefix '{}' matches \
                 multiple sessions:",
                amb.prefix
            );
            for m in &amb.matches {
                eprintln!("  {m}");
            }
            std::process::exit(2);
        }
    };
    let session_id = &resolved;

    let messages = query_message_parts(session_id, db);

    if messages.is_empty() {
        eprintln!("Error: no messages found for session: {session_id}");
        std::process::exit(2);
    }

    if json {
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

fn cmd_message(
    ids: &[String],
    session: Option<&str>,
    db: &str,
    json: bool,
    scan: usize,
) {
    let session = session.map(|s| match resolve_session_id(s, db) {
        Ok(Some(id)) => id,
        Ok(None) => {
            eprintln!("Error: no session found matching '{s}'");
            std::process::exit(2);
        }
        Err(amb) => {
            eprintln!(
                "Error: ambiguous session ID prefix '{}' matches \
                     multiple sessions:",
                amb.prefix
            );
            for m in &amb.matches {
                eprintln!("  {m}");
            }
            std::process::exit(2);
        }
    });

    let results = query_message_by_ids(ids, session.as_deref(), db, scan);

    if results.is_empty() {
        eprintln!("Error: no messages found matching IDs: {}", ids.join(" "));
        std::process::exit(2);
    }

    if json {
        print_json_messages(&results, ids);
    } else {
        print_message_detail(&results);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let args = Cli::parse();

    let colors_enabled = !args.no_color;
    COLOR.store(colors_enabled, Ordering::SeqCst);

    match &args.command {
        Some(Command::Search { keyword, exact, session_list_limit }) => {
            cmd_search(
                keyword.as_deref(),
                exact.as_deref(),
                &args.db,
                args.json,
                *session_list_limit,
            );
        }
        Some(Command::List { all }) => cmd_list(&args.db, args.json, *all),
        Some(Command::Show { session_id }) => {
            cmd_show(session_id, &args.db, args.json);
        }
        Some(Command::Message { ids, session, scan }) => {
            cmd_message(ids, session.as_deref(), &args.db, args.json, *scan);
        }
        None => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            let _ = cmd.print_help();
            println!();
            std::process::exit(1);
        }
    }
}
