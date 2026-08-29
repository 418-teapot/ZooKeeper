#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{Number, Value};

use zutil::color::COLOR;
use zutil::color::msg_print;
use zutil::session::{
    Host, HostFilter, OpenCodeSessionProvider, PiSessionProvider, ResolveError,
    Session, SessionProvider, open_with,
};

mod display;
mod events;
mod helpers;
mod jaeger;
mod parser;
mod trace_builder;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
enum ExportFormat {
    Jaeger,
    Chrome,
}

/// Host selection for session lookups.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
enum HostChoice {
    Auto,
    #[value(name = "opencode")]
    OpenCode,
    Pi,
}

impl HostChoice {
    /// Map the CLI choice to a provider filter.
    ///
    /// An explicit `--db` path is an `OpenCode` database, so it always
    /// wins over `--host` — matching `zfind` and `zinspect`.
    const fn filter(self, db: Option<&str>) -> HostFilter {
        if db.is_some() {
            HostFilter::Only(Host::OpenCode)
        } else {
            match self {
                Self::Auto => HostFilter::Auto,
                Self::OpenCode => HostFilter::Only(Host::OpenCode),
                Self::Pi => HostFilter::Only(Host::Pi),
            }
        }
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "ztrace",
    about = "ZooKeeper trace -- full orchestration trace with timeline \
             merging for OpenCode and pi sessions.",
    disable_help_subcommand = true
)]
struct Args {
    /// Output results in JSON format
    #[arg(short = 'j', long, global = true)]
    json: bool,

    /// Path to the `OpenCode` `SQLite` database. When omitted, every
    /// `opencode*.db` file in the opencode data directory
    /// (`~/.local/share/opencode`, or `$ZOO_OPENCODE_DATA_DIR` when set)
    /// is aggregated into one view. An explicit `--db` implies — and
    /// wins over — `--host opencode`.
    #[arg(long, global = true)]
    db: Option<String>,

    /// Restrict the session lookup to a single host
    /// (`auto` detects from the session id shape). Ignored when `--db`
    /// is given, which always targets `OpenCode`.
    #[arg(long, global = true, value_enum, default_value = "auto")]
    host: HostChoice,

    /// Disable colored output
    #[arg(long, global = true)]
    no_color: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Show merged timeline for a session
    Show {
        /// Session ID
        session_id: String,

        /// Include all child sessions in the timeline
        #[arg(short = 'a', long)]
        all: bool,

        /// Show full per-event timeline instead of grouped summary
        #[arg(short, long)]
        verbose: bool,
    },
    /// Export merged timeline as JSON trace (Jaeger or Chrome)
    Export {
        /// Session ID
        session_id: String,

        /// Include all child sessions in the trace
        #[arg(short = 'a', long)]
        all: bool,

        /// Export format (jaeger or chrome)
        #[arg(long, default_value = "jaeger", value_enum)]
        format: ExportFormat,

        /// Output JSON file path
        #[arg(short, long, default_value = "trace.json")]
        output: String,
    },
    /// Step-by-step token timeline
    Steps {
        /// Session ID
        session_id: String,

        /// Overlay zoo hook events on steps (default: enabled).
        /// Use `--hook-overlays false` to disable.
        #[arg(
            long,
            default_missing_value = "true",
            default_value = "true",
            num_args = 0..=1,
            action = clap::ArgAction::Set
        )]
        hook_overlays: bool,

        /// Include all child session steps
        #[arg(short = 'a', long)]
        all: bool,

        /// Only show steps where Δ Cache < -N
        #[arg(long, value_name = "N")]
        min_cache_drop: Option<i64>,
    },
    /// Token distribution per LLM turn (one row per usage event)
    Tokens {
        /// Session ID
        session_id: String,
    },
}

// ── Provider plumbing ────────────────────────────────────────────────────────

/// Build the provider list honoring `--host` and `--db`.
fn build_providers(
    filter: HostFilter,
    db: Option<&str>,
) -> Vec<(Host, Box<dyn SessionProvider>)> {
    let opencode = || -> Box<dyn SessionProvider> {
        db.map_or_else(
            || Box::new(OpenCodeSessionProvider::new()),
            |path| Box::new(OpenCodeSessionProvider::with_db_path(path)),
        )
    };
    match filter {
        HostFilter::Auto => vec![
            (Host::OpenCode, opencode()),
            (Host::Pi, Box::new(PiSessionProvider::new())),
        ],
        HostFilter::Only(Host::OpenCode) => {
            vec![(Host::OpenCode, opencode())]
        }
        HostFilter::Only(Host::Pi) => {
            vec![(Host::Pi, Box::new(PiSessionProvider::new()))]
        }
    }
}

/// Resolve a session, printing a CLI-style error and exiting 2 on failure.
///
/// Delegates the probe — id-shape fast path plus ordered fallback across
/// the provider list — to [`open_with`], then maps its structured errors
/// back to the established CLI wording: `NotFound` keeps the "no session
/// found matching" phrasing and lists the tried hosts, `Ambiguous` lists
/// the matching ids under "ambiguous session ID prefix".
fn resolve_or_die(
    providers: &[(Host, Box<dyn SessionProvider>)],
    filter: HostFilter,
    session_id: &str,
) -> (Host, Session) {
    match open_with(providers, filter, session_id) {
        Ok(ok) => ok,
        Err(ResolveError::Ambiguous { matches, .. }) => {
            eprintln!(
                "Error: ambiguous session ID prefix '{session_id}' matches \
                 multiple sessions:"
            );
            for m in &matches {
                eprintln!("  {m}");
            }
            std::process::exit(2);
        }
        Err(ResolveError::NotFound { tried_hosts, .. }) => {
            let tried = if tried_hosts.is_empty() {
                "none".to_string()
            } else {
                tried_hosts.join(", ")
            };
            eprintln!(
                "Error: no session found matching '{session_id}' \
                 (tried hosts: {tried})"
            );
            std::process::exit(2);
        }
        Err(ResolveError::Io(e)) => {
            eprintln!("Error: {e}");
            std::process::exit(2);
        }
    }
}

/// Provider of the resolved host within `providers`.
fn provider_for(
    providers: &[(Host, Box<dyn SessionProvider>)],
    host: Host,
) -> &dyn SessionProvider {
    providers
        .iter()
        .find(|(h, _)| *h == host)
        .map(|(_, p)| p.as_ref())
        .expect("resolved host must have a provider")
}

/// Root session plus (optionally) its transitive children.
type SessionTree = (Vec<(String, i64)>, HashMap<String, Session>);

/// Open the root session plus (optionally) its transitive children.
///
/// Returns the `(session_id, depth)` list (root first) and the opened
/// sessions by id.
fn open_session_tree(
    provider: &dyn SessionProvider,
    root: &Session,
    include_children: bool,
) -> Result<SessionTree, String> {
    let mut sessions: Vec<(String, i64)> = vec![(root.meta.id.clone(), 0)];
    if include_children {
        let children =
            helpers::discover_child_sessions(provider, &root.meta.id).map_err(
                |e| format!("failed to discover child sessions: {e}"),
            )?;
        sessions.extend(children);
    }

    let mut session_map: HashMap<String, Session> = HashMap::new();
    for (sid, _) in &sessions {
        let opened = provider
            .open(sid)
            .map_err(|e| format!("failed to open session {sid}: {e}"))?;
        session_map.insert(sid.clone(), opened);
    }
    Ok((sessions, session_map))
}

// ── Command Handlers ─────────────────────────────────────────────────────────

fn print_host_events_notice(host: Host) {
    eprintln!(
        "[ztrace] host '{host_name}' does not provide host lifecycle events",
        host_name = host.name()
    );
}

fn cmd_show(args: &Args, session_id: &str, all: bool, verbose: bool) {
    let filter = args.host.filter(args.db.as_deref());
    let providers = build_providers(filter, args.db.as_deref());
    let (host, session) = resolve_or_die(&providers, filter, session_id);
    let provider = provider_for(&providers, host);

    let (sessions, session_map) =
        match open_session_tree(provider, &session, all) {
            Ok(tree) => tree,
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(2);
            }
        };

    let sids: std::collections::HashSet<&str> =
        sessions.iter().map(|(sid, _)| sid.as_str()).collect();
    let session_agents = trace_builder::build_session_agents(provider, &sids);

    let built = trace_builder::build_timeline(
        provider,
        host,
        &sessions,
        &session_map,
        &session_agents,
        session_id,
    );
    let mut timeline = built.events;

    if timeline.is_empty() {
        msg_print("[yellow]No events found[/yellow]");
        return;
    }

    let child_sessions_info =
        helpers::collect_child_sessions_info(&timeline, session_id);

    let stats =
        trace_builder::build_stats(&timeline, Some(&child_sessions_info));

    helpers::attach_durations(&mut timeline);

    // --json output
    if args.json {
        if !built.host_events_provided {
            print_host_events_notice(host);
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&timeline)
                .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
        );
        return;
    }

    if verbose {
        if !built.host_events_provided {
            print_host_events_notice(host);
        }
        display::render_session_panel(
            session_id,
            &timeline,
            &stats,
            false,
            session.meta.model.as_deref(),
            session.meta.agent.as_deref(),
        );
        display::render_timeline_rich(&timeline);
    } else {
        display::render_session_panel(
            session_id,
            &timeline,
            &stats,
            true,
            session.meta.model.as_deref(),
            session.meta.agent.as_deref(),
        );
        display::render_ops_summary(&timeline, &stats, false);
    }
}

fn cmd_export(
    args: &Args,
    session_id: &str,
    all: bool,
    format: ExportFormat,
    output: &str,
) {
    let filter = args.host.filter(args.db.as_deref());
    let providers = build_providers(filter, args.db.as_deref());
    let (host, session) = resolve_or_die(&providers, filter, session_id);
    let provider = provider_for(&providers, host);
    let output_path = zutil::expand_tilde(output);

    let (sessions, session_map) =
        match open_session_tree(provider, &session, all) {
            Ok(tree) => tree,
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(2);
            }
        };

    let sids: std::collections::HashSet<&str> =
        sessions.iter().map(|(sid, _)| sid.as_str()).collect();
    let session_agents = trace_builder::build_session_agents(provider, &sids);

    let built = trace_builder::build_timeline(
        provider,
        host,
        &sessions,
        &session_map,
        &session_agents,
        session_id,
    );
    let timeline = built.events;

    if timeline.is_empty() {
        msg_print("[yellow]No events to export[/yellow]");
        return;
    }

    match format {
        ExportFormat::Chrome => {
            let events = jaeger::build_chrome_trace(&timeline);
            let count = events.len();
            let json =
                serde_json::to_string_pretty(&events).unwrap_or_else(|e| {
                    eprintln!("JSON serialization failed: {e}");
                    std::process::exit(1);
                });
            if let Err(e) = std::fs::write(&output_path, &json) {
                eprintln!("Failed to write {output_path}: {e}");
                std::process::exit(1);
            }
            msg_print(&format!(
                "[green]Exported {count} trace events to {output_path}[/green]"
            ));
        }
        ExportFormat::Jaeger => {
            let doc = jaeger::build_jaeger_doc(session_id, &timeline);
            let count = doc["data"][0]["spans"]
                .as_array()
                .map_or(0, std::vec::Vec::len);
            let json = serde_json::to_string_pretty(&doc).unwrap_or_else(|e| {
                eprintln!("JSON serialization failed: {e}");
                std::process::exit(1);
            });
            if let Err(e) = std::fs::write(&output_path, &json) {
                eprintln!("Failed to write {output_path}: {e}");
                std::process::exit(1);
            }
            msg_print(&format!(
                "[green]Exported {count} spans to {output_path}[/green]"
            ));
        }
    }

    // --json output: print JSON envelope (with host-events metadata)
    if args.json {
        let envelope = serde_json::json!({
            "status": "ok",
            "format": format!("{format:?}").to_lowercase(),
            "output": output_path,
            "events": timeline.len(),
            "host_events": if built.host_events_provided { "provided" } else { "not-provided" },
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&envelope)
                .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
        );
    }
}

fn sort_and_index_steps(steps: &mut [Value], default_sid: &str) {
    steps.sort_by(|a, b| {
        let ta = a.get("time_created").and_then(|v| v.as_str()).unwrap_or("");
        let tb = b.get("time_created").and_then(|v| v.as_str()).unwrap_or("");
        ta.cmp(tb)
    });

    for (i, step) in steps.iter_mut().enumerate() {
        if let Some(obj) = step.as_object_mut() {
            obj.insert(
                "_display_index".to_string(),
                Value::Number(Number::from((i + 1) as u64)),
            );
            let sid = obj
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or(default_sid)
                .to_string();
            obj.insert("_session_id".to_string(), Value::String(sid));
        }
    }
}

fn compute_step_metrics(steps: &mut [Value]) {
    let prev_cache_reads: Vec<f64> = steps
        .iter()
        .map(|s| {
            s.get("cache_read")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0)
        })
        .collect();

    for (i, step) in steps.iter_mut().enumerate() {
        if let Some(obj) = step.as_object_mut() {
            let cache_read = obj
                .get("cache_read")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let cache_write = obj
                .get("cache_write")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let input_tokens = obj
                .get("input_tokens")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);

            let delta = if i == 0 {
                cache_write
            } else {
                let prev = prev_cache_reads[i - 1];
                cache_read - prev
            };
            obj.insert(
                "delta_cache".to_string(),
                Value::Number(
                    Number::from_f64(delta)
                        .unwrap_or_else(|| Number::from_f64(0.0).unwrap()),
                ),
            );

            let denom = input_tokens + cache_read;
            let pct =
                if denom > 0.0 { (cache_read / denom) * 100.0 } else { 0.0 };
            obj.insert(
                "cache_pct".to_string(),
                Value::Number(
                    Number::from_f64(pct)
                        .unwrap_or_else(|| Number::from_f64(0.0).unwrap()),
                ),
            );

            // Keep the provider-reported duration (seconds, derived from
            // `Usage.duration_ms`); when the host records none the
            // duration is unknown and surfaces as `null` — never a
            // misleading 0 (pi's per-step time_created == time_updated).
            let dur = obj
                .get("duration")
                .and_then(serde_json::Value::as_f64)
                .map_or(Value::Null, |d| {
                    Number::from_f64(d).map_or(Value::Null, Value::Number)
                });
            obj.insert("duration".to_string(), dur);
        }
    }
}

fn apply_filter(
    all_steps: &mut Vec<Value>,
    hook_map: &mut HashMap<i64, Vec<String>>,
    drop_threshold: i64,
    zoo_events: &[Value],
) {
    // Use `i32::try_from` + `f64::from` to avoid clippy's cast_precision_loss.
    let threshold =
        f64::from(i32::try_from(drop_threshold).unwrap_or(i32::MAX));
    all_steps.retain(|s| {
        s.get("delta_cache")
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|v| v < -threshold)
    });
    for (i, step) in all_steps.iter_mut().enumerate() {
        if let Some(obj) = step.as_object_mut() {
            obj.insert(
                "_display_index".to_string(),
                Value::Number(Number::from((i + 1) as u64)),
            );
        }
    }
    // Re-match hooks against the surviving steps. `zoo_events` was parsed
    // once in `cmd_steps` and is reused here; an empty slice (overlays
    // disabled) yields an empty map, matching the pre-filter state.
    *hook_map = helpers::match_hooks_to_steps(all_steps, zoo_events);
}

fn cmd_steps(
    args: &Args,
    session_id: &str,
    hook_overlays: bool,
    all: bool,
    min_cache_drop: Option<i64>,
) {
    let filter = args.host.filter(args.db.as_deref());
    let providers = build_providers(filter, args.db.as_deref());
    let (host, session) = resolve_or_die(&providers, filter, session_id);
    let provider = provider_for(&providers, host);

    let (sessions, session_map) =
        match open_session_tree(provider, &session, all) {
            Ok(tree) => tree,
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(2);
            }
        };

    // 1. Derive steps from the usage events of every session
    let mut all_steps = events::build_step_values(&session_map, &sessions);

    // 2. Sort and index
    sort_and_index_steps(&mut all_steps, session_id);

    // 3. Hook overlays. The zoo log is parsed once here; the events are
    // reused by the `--min-cache-drop` filter below so the same log file is
    // never resolved and parsed twice within one invocation.
    let zoo_events: Vec<Value> = if hook_overlays {
        // Resolve the zoo log path first; when no unique log file exists for
        // the session there is nothing to overlay, so skip parsing instead of
        // round-tripping `None` through an empty path.
        parser::resolve_log_path(session_id)
            .map_or_else(Vec::new, |log_path| parser::parse_zoo_log(&log_path))
    } else {
        Vec::new()
    };
    let mut hook_map: HashMap<i64, Vec<String>> = if hook_overlays {
        helpers::match_hooks_to_steps(&all_steps, &zoo_events)
    } else {
        HashMap::new()
    };

    // 4. Compute per-step metrics
    compute_step_metrics(&mut all_steps);

    // 5. Filter by --min-cache-drop
    if let Some(drop_threshold) = min_cache_drop {
        apply_filter(
            &mut all_steps,
            &mut hook_map,
            drop_threshold,
            &zoo_events,
        );
    }

    // 6. Output
    if args.json {
        display::output_steps_json(&all_steps, &hook_map);
    } else {
        display::render_steps_table(&all_steps, &hook_map);
    }
}

fn cmd_tokens(args: &Args, session_id: &str) {
    let filter = args.host.filter(args.db.as_deref());
    let providers = build_providers(filter, args.db.as_deref());
    let (_, session) = resolve_or_die(&providers, filter, session_id);

    let rows = events::build_token_rows(&session);

    if args.json {
        display::output_tokens_json(&rows);
    } else {
        display::render_tokens_table(&rows);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();

    let colors_enabled = !args.no_color;
    COLOR.store(colors_enabled, Ordering::SeqCst);

    match &args.command {
        Some(Command::Show { session_id, all, verbose }) => {
            cmd_show(&args, session_id, *all, *verbose);
        }
        Some(Command::Export { session_id, all, format, output }) => {
            cmd_export(&args, session_id, *all, *format, output);
        }
        Some(Command::Steps {
            session_id,
            hook_overlays,
            all,
            min_cache_drop,
        }) => {
            cmd_steps(&args, session_id, *hook_overlays, *all, *min_cache_drop);
        }
        Some(Command::Tokens { session_id }) => {
            cmd_tokens(&args, session_id);
        }
        None => {
            use clap::CommandFactory;
            let mut cmd = Args::command();
            let _ = cmd.print_help();
            println!();
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    #[test]
    fn test_args_show() {
        let args = Args::try_parse_from(["ztrace", "show", "ses-001"])
            .expect("show should parse");
        assert!(args.command.is_some());
        if let Some(Command::Show { session_id, all, verbose }) = &args.command
        {
            assert_eq!(session_id, "ses-001");
            assert!(!all);
            assert!(!verbose);
        } else {
            panic!("expected Show command");
        }
    }

    #[test]
    fn test_args_show_with_flags() {
        let args =
            Args::try_parse_from(["ztrace", "show", "ses-001", "-a", "-v"])
                .expect("show with -a -v should parse");
        if let Some(Command::Show { session_id: _, all, verbose }) =
            &args.command
        {
            assert!(*all);
            assert!(*verbose);
        } else {
            panic!("expected Show command");
        }
    }

    #[test]
    fn test_args_export_defaults() {
        let args = Args::try_parse_from(["ztrace", "export", "ses-001"])
            .expect("export should parse");
        if let Some(Command::Export { session_id, all, format, output }) =
            &args.command
        {
            assert_eq!(session_id, "ses-001");
            assert!(!all);
            assert!(matches!(format, ExportFormat::Jaeger));
            assert_eq!(output, "trace.json");
        } else {
            panic!("expected Export command");
        }
    }

    #[test]
    fn test_args_export_with_options() {
        let args = Args::try_parse_from([
            "ztrace", "export", "ses-001", "-a", "--format", "chrome", "-o",
            "out.json",
        ])
        .expect("export with options should parse");
        if let Some(Command::Export { session_id: _, all, format, output }) =
            &args.command
        {
            assert!(*all);
            assert!(matches!(format, ExportFormat::Chrome));
            assert_eq!(output, "out.json");
        } else {
            panic!("expected Export command");
        }
    }

    #[test]
    fn test_args_steps_defaults() {
        let args = Args::try_parse_from(["ztrace", "steps", "ses-001"])
            .expect("steps should parse");
        if let Some(Command::Steps {
            session_id,
            hook_overlays,
            all,
            min_cache_drop,
        }) = &args.command
        {
            assert_eq!(session_id, "ses-001");
            assert!(*hook_overlays);
            assert!(!all);
            assert_eq!(*min_cache_drop, None);
        } else {
            panic!("expected Steps command");
        }
    }

    #[test]
    fn test_args_steps_with_flags() {
        let args = Args::try_parse_from([
            "ztrace",
            "steps",
            "ses-001",
            "--hook-overlays",
            "false",
            "--all",
            "--min-cache-drop",
            "500",
        ])
        .expect("steps with flags should parse");
        if let Some(Command::Steps {
            session_id: _,
            hook_overlays,
            all,
            min_cache_drop,
        }) = &args.command
        {
            assert!(!*hook_overlays);
            assert!(*all);
            assert_eq!(*min_cache_drop, Some(500));
        } else {
            panic!("expected Steps command");
        }
    }

    #[test]
    fn test_args_tokens() {
        let args = Args::try_parse_from(["ztrace", "tokens", "ses-001"])
            .expect("tokens should parse");
        if let Some(Command::Tokens { session_id }) = &args.command {
            assert_eq!(session_id, "ses-001");
        } else {
            panic!("expected Tokens command");
        }
    }

    #[test]
    fn test_args_global_json() {
        let args =
            Args::try_parse_from(["ztrace", "--json", "show", "ses-001"])
                .expect("--json should parse");
        assert!(args.json);
    }

    #[test]
    fn test_args_global_no_color() {
        let args =
            Args::try_parse_from(["ztrace", "--no-color", "show", "ses-001"])
                .expect("--no-color should parse");
        assert!(args.no_color);
    }

    #[test]
    fn test_args_global_host_defaults_to_auto() {
        let args = Args::try_parse_from(["ztrace", "show", "ses-001"])
            .expect("show should parse");
        assert_eq!(args.host, HostChoice::Auto);
    }

    #[test]
    fn test_args_global_host_choices() {
        for (value, expected) in [
            ("opencode", HostChoice::OpenCode),
            ("pi", HostChoice::Pi),
            ("auto", HostChoice::Auto),
        ] {
            let args = Args::try_parse_from([
                "ztrace", "--host", value, "show", "ses-001",
            ])
            .expect("host value should parse");
            assert_eq!(args.host, expected, "value {value:?}");
        }
    }

    #[test]
    fn test_host_filter_db_wins_over_host() {
        assert_eq!(
            HostChoice::Auto.filter(Some("x.db")),
            HostFilter::Only(Host::OpenCode)
        );
        assert_eq!(HostChoice::Auto.filter(None), HostFilter::Auto);
        // An explicit `--db` always wins over `--host` (aligned with
        // zfind/zinspect): even `--host pi` must target the database.
        assert_eq!(
            HostChoice::Pi.filter(Some("x.db")),
            HostFilter::Only(Host::OpenCode)
        );
        assert_eq!(
            HostChoice::OpenCode.filter(Some("x.db")),
            HostFilter::Only(Host::OpenCode)
        );
        assert_eq!(HostChoice::Pi.filter(None), HostFilter::Only(Host::Pi));
    }

    #[test]
    fn test_args_help_shows_help() {
        let err = Args::try_parse_from(["ztrace", "--help"])
            .expect_err("--help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_show_help_shows_help() {
        let err = Args::try_parse_from(["ztrace", "show", "--help"])
            .expect_err("show --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_export_help_shows_help() {
        let err = Args::try_parse_from(["ztrace", "export", "--help"])
            .expect_err("export --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_steps_help_shows_help() {
        let err = Args::try_parse_from(["ztrace", "steps", "--help"])
            .expect_err("steps --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_tokens_help_shows_help() {
        let err = Args::try_parse_from(["ztrace", "tokens", "--help"])
            .expect_err("tokens --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_no_subcommand_parses_with_none() {
        let args = Args::try_parse_from(["ztrace"])
            .expect("no subcommand should parse with None command");
        assert!(args.command.is_none());
    }

    // ── apply_filter (zoo events reuse) ─────────────────────────────────────

    #[test]
    fn test_apply_filter_rematches_hooks_to_surviving_steps() {
        // The zoo events parsed once in `cmd_steps` are passed into the
        // filter and re-matched against the surviving steps after the
        // delta_cache retain.
        let mut steps = vec![
            serde_json::json!({
                "_display_index": 1,
                "time_created": "2024-05-06T12:53:30.000000Z",
                "delta_cache": 10.0,
            }),
            serde_json::json!({
                "_display_index": 2,
                "time_created": "2024-05-06T12:53:40.000000Z",
                "delta_cache": -50.0,
            }),
        ];
        let zoo_events = vec![
            serde_json::json!({
                "hook": "task-prompt-validate",
                "timestamp": "2024-05-06T12:53:25Z",
            }),
            serde_json::json!({
                "hook": "json-error-nudge",
                "timestamp": "2024-05-06T12:53:36Z",
            }),
        ];
        let mut hook_map: HashMap<i64, Vec<String>> = HashMap::new();

        apply_filter(&mut steps, &mut hook_map, 1, &zoo_events);

        // Only the step with delta_cache < -1 survives and is re-indexed.
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["_display_index"], 1);
        assert!(
            hook_map.contains_key(&1),
            "surviving step should be re-matched against zoo events"
        );
        assert!(
            !hook_map.contains_key(&2),
            "removed step should not retain hook entries"
        );
    }

    #[test]
    fn test_apply_filter_no_events_yields_empty_hook_map() {
        // Overlays disabled: `cmd_steps` passes an empty slice, and the
        // filter must leave the hook map empty (behavioural equivalent to
        // the previous `hook_overlays` guard).
        let mut steps = vec![serde_json::json!({
            "_display_index": 1,
            "time_created": "2024-05-06T12:53:30.000000Z",
            "delta_cache": -5.0,
        })];
        let mut hook_map: HashMap<i64, Vec<String>> = HashMap::new();

        apply_filter(&mut steps, &mut hook_map, 1, &[]);

        assert_eq!(steps.len(), 1);
        assert!(hook_map.is_empty(), "no zoo events means no hook entries");
    }

    // ── compute_step_metrics (unknown vs provider duration) ───────────────

    #[test]
    fn test_compute_step_metrics_unknown_duration_is_null_not_zero() {
        // pi records no duration_ms, and its per-step time_created equals
        // time_updated (both are the usage timestamp). The metrics pass
        // must surface `null` (unknown) instead of a misleading 0.0 that
        // would look like a real zero-length turn.
        let mut steps = vec![serde_json::json!({
            "time_created": "2025-01-09T12:34:56Z",
            "time_updated": "2025-01-09T12:34:56Z",
            "cache_read": 30.0,
            "cache_write": 10.0,
            "input_tokens": 100.0,
        })];
        compute_step_metrics(&mut steps);
        assert!(steps[0]["duration"].is_null());
    }

    #[test]
    fn test_compute_step_metrics_keeps_provider_duration() {
        // OpenCode derives the step duration from `Usage.duration_ms` in
        // the events layer; the metrics pass must keep that value.
        let mut steps = vec![serde_json::json!({
            "time_created": "2025-01-09T12:34:56Z",
            "time_updated": "2025-01-09T12:34:56Z",
            "cache_read": 30.0,
            "cache_write": 10.0,
            "input_tokens": 100.0,
            "duration": 42.0,
        })];
        compute_step_metrics(&mut steps);
        assert!((steps[0]["duration"].as_f64().unwrap() - 42.0).abs() < 0.01);
    }
}
