#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use clap::{Parser, Subcommand};

use zutil::color::COLOR;
use zutil::session::{Host, HostFilter, ResolveError, Session, SessionMeta};

mod display;
mod helpers;
mod session;

use crate::display::{
    print_json_messages, print_json_session_messages, print_json_sessions,
    print_message_detail, print_session_messages_table, print_session_meta,
    print_session_table,
};
use crate::session::HostArg;

/// Default limit for `list` (not configurable on that subcommand).
const DEFAULT_LIST_LIMIT: usize = 5000;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "zfind",
    about = "ZooKeeper session finder -- search OpenCode and pi sessions \
             and messages.",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Output results as a JSON envelope
    #[arg(short = 'j', long, global = true)]
    json: bool,

    /// Path to the `OpenCode` `SQLite` database. When omitted, every
    /// `opencode*.db` file in the opencode data directory
    /// (`~/.local/share/opencode`, or `$ZOO_OPENCODE_DATA_DIR` when set)
    /// is aggregated into one view. Implies `--host opencode`.
    #[arg(long, global = true)]
    db: Option<String>,

    /// Restrict the session lookup to a single host. Defaults to
    /// auto-detection (`ses_` ids come from `OpenCode`, UUIDs from pi);
    /// an explicit `--db` implies `opencode`.
    #[arg(long, global = true, value_enum)]
    host: Option<HostArg>,

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

    /// List events of a session
    Show {
        /// Session ID
        session_id: String,
    },

    /// Retrieve one or more messages by ID (supports prefix matching
    /// across both hosts)
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

// ── Error exits ──────────────────────────────────────────────────────────────

/// Print `Error: {msg}` and exit 2 (not-found style failure).
fn fail(msg: &str) -> ! {
    eprintln!("Error: {msg}");
    std::process::exit(2);
}

/// Print the ambiguous-prefix error and exit 2.
fn fail_ambiguous(prefix: &str, matches: &[String]) -> ! {
    eprintln!(
        "Error: ambiguous session ID prefix '{prefix}' matches \
         multiple sessions:"
    );
    for m in matches {
        eprintln!("  {m}");
    }
    std::process::exit(2);
}

/// Open a session, translating resolve errors into CLI-style exits.
fn open_or_die(
    filter: HostFilter,
    db: Option<&str>,
    id_or_prefix: &str,
) -> (Host, Session) {
    match session::open_session(filter, db, id_or_prefix) {
        Ok(ok) => ok,
        Err(ResolveError::NotFound { .. }) => {
            fail(&format!("no session found matching '{id_or_prefix}'"));
        }
        Err(ResolveError::Ambiguous { matches, .. }) => {
            fail_ambiguous(id_or_prefix, &matches);
        }
        Err(ResolveError::Io(e)) => fail(&e.to_string()),
    }
}

// ── Command Handlers ─────────────────────────────────────────────────────────

/// Convert session pairs into display rows, keeping root sessions only
/// unless `all` is set.
fn session_rows(
    sessions: Vec<(Host, SessionMeta)>,
    all: bool,
) -> Vec<serde_json::Value> {
    sessions
        .into_iter()
        .filter(|(_, meta)| all || meta.parent_id.is_none())
        .map(|(host, meta)| session::meta_to_value(host, &meta))
        .collect()
}

fn cmd_search(
    keyword: Option<&str>,
    exact: Option<&str>,
    filter: HostFilter,
    db: Option<&str>,
    json: bool,
    session_list_limit: usize,
) {
    let (hits, label) = match (exact, keyword) {
        (Some(title), _) => {
            let mut hits = session::search_sessions(filter, db, title)
                .unwrap_or_else(|e| fail(&format!("search failed: {e}")));
            hits.retain(|(_, meta)| {
                // Compare the full, untruncated title: hosts may shorten
                // the display label (pi truncates long first messages),
                // which must not affect exact matching.
                meta.parent_id.is_none() && meta.title.as_deref() == Some(title)
            });
            (hits, title)
        }
        (None, Some(kw)) => {
            let hits = session::search_sessions(filter, db, kw)
                .unwrap_or_else(|e| fail(&format!("search failed: {e}")));
            // Search keeps the root-session semantics of the old title query.
            (hits, kw)
        }
        (None, None) => {
            eprintln!("Error: either a keyword or --exact must be provided.");
            std::process::exit(1);
        }
    };

    let mut hits = session::sort_newest_first(hits);
    hits.truncate(session_list_limit);

    if hits.is_empty() {
        if exact.is_some() {
            fail(&format!("no session found with exact title \"{label}\""));
        }
        fail(&format!("no sessions found matching \"{label}\""));
    }

    let rows = session_rows(hits, false);
    if json {
        print_json_sessions(&rows, label);
    } else {
        print_session_table(&rows, false, false, Some(label));
    }
}

fn cmd_list(filter: HostFilter, db: Option<&str>, json: bool, all: bool) {
    let sessions = session::list_sessions(filter, db)
        .unwrap_or_else(|e| fail(&format!("list failed: {e}")));
    let mut sessions = session::sort_newest_first(sessions);
    sessions.truncate(DEFAULT_LIST_LIMIT);

    let rows = session_rows(sessions, all);
    if rows.is_empty() {
        fail("no sessions found in database.");
    }

    if json {
        print_json_sessions(&rows, "");
    } else {
        print_session_table(&rows, true, all, None);
    }
}

fn cmd_show(
    session_id: &str,
    filter: HostFilter,
    db: Option<&str>,
    json: bool,
) {
    let (host, session) = open_or_die(filter, db, session_id);
    let session_id = &session.meta.id;

    if session.events.is_empty() {
        fail(&format!("no messages found for session: {session_id}"));
    }

    let rows: Vec<HashMap<String, serde_json::Value>> = session
        .events
        .iter()
        .enumerate()
        .map(|(idx, event)| session::show_row(host, idx, event))
        .collect();

    if json {
        print_json_session_messages(&rows, session_id);
    } else {
        print_session_meta(session_id, host.name(), &session.meta);
        print_session_messages_table(&rows, session_id);
    }
}

fn cmd_message(
    ids: &[String],
    session_id: Option<&str>,
    filter: HostFilter,
    db: Option<&str>,
    json: bool,
    scan: usize,
) {
    let mut results: Vec<serde_json::Value> = Vec::new();
    if let Some(sid) = session_id {
        let (host, session) = open_or_die(filter, db, sid);
        results.extend(session::message_rows(host, &session, ids));
    } else {
        // Batch lookup across the hosts: each provider scans its recent
        // sessions for matching event ids without fully opening them.
        let found = session::find_events_across(filter, db, ids, scan)
            .unwrap_or_else(|e| fail(&format!("search failed: {e}")));
        for (host, meta, events) in found {
            let session = Session { meta, events };
            results.extend(session::message_rows(host, &session, ids));
        }
    }

    // Deterministic ordering: by timestamp, then id (stable within a
    // session keeps use/result stream order).
    results.sort_by(|a, b| {
        let ta = a.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let tb = b.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let ia = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let ib = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        (ta, ia).cmp(&(tb, ib))
    });

    if results.is_empty() {
        fail(&format!("no messages found matching IDs: {}", ids.join(" ")));
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

    let filter = session::host_filter(args.host, args.db.as_deref());
    let db = args.db.as_deref();

    match &args.command {
        Some(Command::Search { keyword, exact, session_list_limit }) => {
            cmd_search(
                keyword.as_deref(),
                exact.as_deref(),
                filter,
                db,
                args.json,
                *session_list_limit,
            );
        }
        Some(Command::List { all }) => cmd_list(filter, db, args.json, *all),
        Some(Command::Show { session_id }) => {
            cmd_show(session_id, filter, db, args.json);
        }
        Some(Command::Message { ids, session, scan }) => {
            cmd_message(ids, session.as_deref(), filter, db, args.json, *scan);
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
