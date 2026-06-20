#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::{BTreeMap, HashMap};

use clap::{Parser, Subcommand};
use serde_json::{Value, json};

mod db;
mod display;
mod helpers;

use std::sync::atomic::Ordering;

use zutil::color::COLOR;
use zutil::color::msg_print;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(
    name = "zinspect",
    about = "ZooKeeper session inspector -- stats, timeline, \
             and impact analysis for OpenCode sessions.",
    disable_help_subcommand = true
)]
struct Args {
    /// Output results in JSON format
    #[arg(long)]
    json: bool,

    /// Path to the `OpenCode` `SQLite` database
    #[arg(long, default_value = "~/.local/share/opencode/opencode.db")]
    db: String,

    /// Disable colored output
    #[arg(long)]
    no_color: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Show statistics for a session or multiple sessions
    Stats {
        /// Session ID (full or prefix)
        session_id: Option<String>,

        /// Show cross-session token summary for last N sessions
        #[arg(long, value_name = "N")]
        sessions: Option<i64>,

        /// Include child sessions in multi-session mode
        #[arg(long)]
        all: bool,

        /// Show only the token summary section
        #[arg(long)]
        tokens: bool,

        /// Show only the hook breakdown section
        #[arg(long)]
        hooks: bool,
    },
    /// Show event timeline for a session
    Timeline {
        /// Session ID (full or prefix)
        session_id: String,

        /// Show all events (no row limit)
        #[arg(long)]
        all_events: bool,
    },
    /// Analyze how zoo hook triggers affect cache hit rates
    Impact {
        /// Number of recent sessions to analyze (default: 5)
        #[arg(long, default_value_t = 5, value_name = "N")]
        sessions: i64,

        /// Analyze a single session by ID
        #[arg(long, value_name = "ID")]
        session: Option<String>,

        /// Include child sessions
        #[arg(long)]
        all: bool,

        /// Filter to a specific hook type
        #[arg(long, value_name = "NAME")]
        hook: Option<String>,

        /// Observation window steps before/after hook (default: 6)
        #[arg(long, default_value_t = 6, value_name = "N")]
        window: i64,

        /// Show cost estimation table
        #[arg(long)]
        cost: bool,

        /// Show per-event detail
        #[arg(long)]
        verbose: bool,
    },
}

// ── Command Handlers ─────────────────────────────────────────────────────────

#[allow(clippy::cast_precision_loss, clippy::too_many_lines)]
fn cmd_stats(
    args: &Args,
    session_id: Option<&str>,
    sessions_n: Option<i64>,
    all: bool,
    tokens_only: bool,
    hooks_only: bool,
) {
    let log_dir = zutil::get_zoo_log_dir();

    // Validate: must have either session_id or sessions_n
    if session_id.is_none() && sessions_n.is_none() {
        eprintln!("Error: provide a session_id or use --sessions <N>");
        std::process::exit(1);
    }

    // Multi-session mode
    if let Some(n) = sessions_n {
        let sessions = match db::query_recent_sessions(n, &args.db, all) {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("[red]Database query failed: {e}[/red]");
                msg_print(&msg);
                return;
            }
        };
        if sessions.is_empty() {
            msg_print("[yellow]No sessions found in database.[/yellow]");
            return;
        }

        let mut rows: Vec<Value> = Vec::new();
        let mut total_input = 0.0_f64;
        let mut total_output = 0.0_f64;
        let mut total_cache_read = 0.0_f64;
        let mut total_cost = 0.0_f64;
        let mut total_hook_events = 0.0_f64;

        for s in &sessions {
            let sid = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let inp = s
                .get("tokens_input")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let out = s
                .get("tokens_output")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let cache_read = s
                .get("tokens_cache_read")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let cost = s
                .get("cost")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);

            // Hook event count requires parsing the JSONL log — the DB
            // doesn't store hook-level aggregates. Each session is parsed
            // at most once.
            let hook_count = zutil::resolve_session_path(sid, &log_dir).map_or(
                0.0,
                |path| {
                    let events = helpers::parse_zoo_log(&path);
                    events.iter().filter(|e| e.get("hook").is_some()).count()
                        as f64
                },
            );

            let hit_rate = helpers::cache_hit_rate(cache_read, inp);

            rows.push(json!({
                "id": sid,
                "input": inp,
                "output": out,
                "hit_rate": hit_rate,
                "cost": cost,
                "hook_events": hook_count,
            }));

            total_input += inp;
            total_output += out;
            total_cache_read += cache_read;
            total_cost += cost;
            total_hook_events += hook_count;
        }

        let total_hit_rate =
            helpers::cache_hit_rate(total_cache_read, total_input);
        let totals = json!({
            "input": total_input,
            "output": total_output,
            "cache_read": total_cache_read,
            "hit_rate": total_hit_rate,
            "cost": total_cost,
            "hook_events": total_hook_events,
        });

        if args.json {
            display::print_json_multi_stats(&rows, &totals);
        } else {
            display::print_multi_stats_table(&rows, &totals, n);
        }
        return;
    }

    // Single-session mode
    if let Some(sid) = session_id {
        let path = helpers::resolve_session(sid, &log_dir);
        let events = helpers::parse_zoo_log(&path);
        let exact_sid = helpers::session_id_from_path(&path);
        let steps = db::query_step_data(&exact_sid, &args.db);

        if steps.is_empty() && !hooks_only {
            msg_print(
                "[yellow]No step-finish records found in database \
                 for this session. Token summary will be empty.[/yellow]",
            );
        }

        if tokens_only && !hooks_only {
            if args.json {
                display::print_json_token_summary(&steps);
            } else {
                display::print_token_summary_table(&steps);
            }
            return;
        }

        if hooks_only && !tokens_only {
            if args.json {
                display::print_json_hook_breakdown(&events, &exact_sid);
            } else {
                display::print_hook_breakdown_table(&events, &exact_sid);
            }
            return;
        }

        if args.json {
            display::print_json_full_stats(&events, &steps, &path, &exact_sid);
        } else {
            display::print_full_stats(&events, &steps, &path, &exact_sid);
        }
    }
}

fn cmd_timeline(_args: &Args, session_id: &str, all_events: bool) {
    let log_dir = zutil::get_zoo_log_dir();
    let path = helpers::resolve_session(session_id, &log_dir);
    let mut events = helpers::parse_zoo_log(&path);

    events.sort_by(|a, b| {
        a.get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""))
    });

    display::print_timeline_table(&events, session_id, all_events);
}

#[allow(
    clippy::too_many_lines,
    clippy::cast_precision_loss,
    clippy::too_many_arguments,
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn cmd_impact(
    args: &Args,
    sessions_n: i64,
    single_session: Option<&str>,
    include_all: bool,
    hook_filter: Option<&str>,
    window: i64,
    show_cost: bool,
    verbose: bool,
) {
    let log_dir = zutil::get_zoo_log_dir();

    // Resolve session IDs
    let mut session_ids: Vec<String> = Vec::new();
    if let Some(sid) = single_session {
        let path = helpers::resolve_session(sid, &log_dir);
        session_ids.push(helpers::session_id_from_path(&path));
    } else {
        let sessions = match db::query_recent_sessions(
            sessions_n,
            &args.db,
            include_all,
        ) {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("[red]Database query failed: {e}[/red]");
                msg_print(&msg);
                return;
            }
        };
        if sessions.is_empty() {
            msg_print("[yellow]No sessions found in database.[/yellow]");
            return;
        }
        for s in &sessions {
            if let Some(id) = s.get("id").and_then(|v| v.as_str()) {
                session_ids.push(id.to_string());
            }
        }
    }

    // Analysis data structures
    let mut hook_analysis: HashMap<String, Vec<Value>> = HashMap::new();
    let mut recovery_data: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    let mut cost_data: HashMap<String, display::CostData> = HashMap::new();
    let mut verbose_rows: Vec<Value> = Vec::new();
    let mut found_steps = false;

    for sid in &session_ids {
        // Get hook events from JSONL
        let mut hooks: Vec<Value> = Vec::new();
        if let Some(log_path) = zutil::resolve_session_path(sid, &log_dir) {
            let events = helpers::parse_zoo_log(&log_path);
            for e in &events {
                if e.get("hook").is_some()
                    && e.get("timestamp")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                {
                    if let Some(filter) = hook_filter
                        && e.get("hook").and_then(|v| v.as_str())
                            != Some(filter)
                    {
                        continue;
                    }
                    hooks.push(e.clone());
                }
            }
        }

        // Get steps from DB
        let mut steps: Vec<Value> = db::query_step_data(sid, &args.db);
        steps.retain(|s| {
            s.get("time_created")
                .and_then(|v| v.as_str())
                .is_some_and(|t| !t.is_empty())
        });
        steps.sort_by(|a, b| {
            a.get("time_created").and_then(|v| v.as_str()).unwrap_or("").cmp(
                b.get("time_created").and_then(|v| v.as_str()).unwrap_or(""),
            )
        });

        if hooks.is_empty() {
            continue;
        }

        hooks.sort_by(|a, b| {
            a.get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""))
        });

        if !steps.is_empty() {
            found_steps = true;
        }

        // Build step_times for binary search
        let step_times: Vec<String> = steps
            .iter()
            .filter_map(|s| {
                s.get("time_created")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string)
            })
            .collect();

        for hook in &hooks {
            let hook_ts =
                hook.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
            let hook_name = hook
                .get("hook")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            if hook_ts.is_empty() {
                continue;
            }

            // Binary search to find position among steps.
            // `partition_point` returns the first index where step_times[i] >= hook_ts
            // (equivalent to Python's bisect_left). When hook_ts equals a step timestamp
            // exactly, that step at `pos` is the boundary step. The boundary step is
            // included in "after" steps (matching Python behavior at zoo-inspect.py:864).
            let pos = step_times.partition_point(|t| t.as_str() < hook_ts);

            // Steps before (same session only, using step index distance).
            // Distance is positive: pos - k (e.g. distance 1 is 1 step before the boundary).
            let mut before_steps: Vec<(i64, &Value)> = Vec::new();
            let mut k = pos as i64 - 1;
            while k >= 0 && (pos as i64 - k) <= window {
                if let Some(s) = steps.get(k as usize) {
                    let dist = pos as i64 - k;
                    before_steps.push((dist, s));
                }
                k -= 1;
            }

            // Steps after (same session only, using step index distance)
            let mut after_steps: Vec<(i64, &Value)> = Vec::new();
            for k in pos..steps.len().min(pos + window as usize) {
                let dist = (k - pos + 1) as i64;
                if let Some(s) = steps.get(k) {
                    after_steps.push((dist, s));
                }
            }

            let before_rates: Vec<f64> = before_steps
                .iter()
                .map(|(_, s)| {
                    let cr = s
                        .get("cache_read")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0);
                    let inp = s
                        .get("input_tokens")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0);
                    helpers::cache_hit_rate(cr, inp)
                })
                .collect();

            let after_rates: Vec<f64> = after_steps
                .iter()
                .map(|(_, s)| {
                    let cr = s
                        .get("cache_read")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0);
                    let inp = s
                        .get("input_tokens")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0);
                    helpers::cache_hit_rate(cr, inp)
                })
                .collect();

            let avg_before = if before_rates.is_empty() {
                0.0
            } else {
                before_rates.iter().sum::<f64>() / before_rates.len() as f64
            };
            let avg_after = if after_rates.is_empty() {
                0.0
            } else {
                after_rates.iter().sum::<f64>() / after_rates.len() as f64
            };

            hook_analysis.entry(hook_name.clone()).or_default().push(json!({
                "session_id": sid,
                "timestamp": hook_ts,
                "before": avg_before,
                "after": avg_after,
                "n_before": before_steps.len(),
                "n_after": after_steps.len(),
            }));

            // Recovery curve
            for (dist, s) in &before_steps {
                let cr = s
                    .get("cache_read")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                let inp = s
                    .get("input_tokens")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                let hr = helpers::cache_hit_rate(cr, inp);
                recovery_data.entry(-dist).or_default().push(hr);
            }
            for (dist, s) in &after_steps {
                let cr = s
                    .get("cache_read")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                let inp = s
                    .get("input_tokens")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                let hr = helpers::cache_hit_rate(cr, inp);
                recovery_data.entry(*dist).or_default().push(hr);
            }

            // Cost data
            let cd = cost_data.entry(hook_name.clone()).or_default();
            for (_, s) in &before_steps {
                cd.before += s
                    .get("cost")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
            }
            for (_, s) in &after_steps {
                cd.after += s
                    .get("cost")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
            }

            // Verbose detail
            if verbose {
                let before_detail: Vec<Value> = before_steps
                    .iter()
                    .map(|(_, s)| {
                        let cr = s
                            .get("cache_read")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        let inp = s
                            .get("input_tokens")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        let hr = helpers::cache_hit_rate(cr, inp);
                        let cost = s
                            .get("cost")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        json!({
                            "cache_read": cr,
                            "input_tokens": inp,
                            "hit_rate": hr,
                            "cost": cost,
                        })
                    })
                    .collect();

                let after_detail: Vec<Value> = after_steps
                    .iter()
                    .map(|(_, s)| {
                        let cr = s
                            .get("cache_read")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        let inp = s
                            .get("input_tokens")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        let hr = helpers::cache_hit_rate(cr, inp);
                        let cost = s
                            .get("cost")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        json!({
                            "cache_read": cr,
                            "input_tokens": inp,
                            "hit_rate": hr,
                            "cost": cost,
                        })
                    })
                    .collect();

                verbose_rows.push(json!({
                    "session_id": sid,
                    "hook": hook_name,
                    "timestamp": hook_ts,
                    "avg_before": avg_before,
                    "avg_after": avg_after,
                    "delta": avg_after - avg_before,
                    "before_steps": before_detail,
                    "after_steps": after_detail,
                }));
            }
        }
    }

    // Output
    if hook_analysis.is_empty() {
        msg_print(
            "[yellow]No hook events found in session logs \
             matching the filter.[/yellow]",
        );
        return;
    }

    if !found_steps {
        msg_print(
            "[yellow]No step-finish records found in database for \
             any session. Impact analysis will be incomplete.[/yellow]",
        );
    }

    if args.json {
        let mut hook_agg = serde_json::Map::new();
        let mut hook_names: Vec<&String> = hook_analysis.keys().collect();
        hook_names.sort();
        for hook_name in hook_names {
            let triggers = &hook_analysis[hook_name];
            let n = triggers.len();
            let all_before: f64 = triggers
                .iter()
                .filter_map(|t| {
                    t.get("before").and_then(serde_json::Value::as_f64)
                })
                .sum();
            let all_after: f64 = triggers
                .iter()
                .filter_map(|t| {
                    t.get("after").and_then(serde_json::Value::as_f64)
                })
                .sum();
            let avg_b = if n > 0 { all_before / n as f64 } else { 0.0 };
            let avg_a = if n > 0 { all_after / n as f64 } else { 0.0 };
            let delta = avg_a - avg_b;
            let total_steps: i64 = triggers
                .iter()
                .map(|t| {
                    t.get("n_before")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0)
                        + t.get("n_after")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0)
                })
                .sum();

            hook_agg.insert(
                hook_name.clone(),
                json!({
                    "triggers": n,
                    "avg_before": (avg_b * 10.0).round() / 10.0,
                    "avg_after": (avg_a * 10.0).round() / 10.0,
                    "delta": (delta * 10.0).round() / 10.0,
                    "correlated_steps": total_steps,
                }),
            );
        }

        let recovery_curve: Vec<Value> = recovery_data
            .iter()
            .map(|(dist, rates)| {
                let avg_rate = rates.iter().sum::<f64>() / rates.len() as f64;
                json!({
                    "distance": dist,
                    "avg_hit_rate": (avg_rate * 10.0).round() / 10.0,
                    "samples": rates.len(),
                })
            })
            .collect();

        let mut result = json!({
            "sessions_analyzed": session_ids,
            "window": window,
            "hook_aggregation": hook_agg,
            "recovery_curve": recovery_curve,
        });

        if show_cost {
            let mut cost_impact = serde_json::Map::new();
            let mut cost_names: Vec<&String> = cost_data.keys().collect();
            cost_names.sort();
            for hook_name in cost_names {
                let cd = &cost_data[hook_name];
                let ratio = if cd.before > 0.0 {
                    let r = (cd.after / cd.before * 100.0).round() / 100.0;
                    serde_json::Number::from_f64(r)
                        .map_or(Value::Null, Value::Number)
                } else {
                    Value::Null
                };
                cost_impact.insert(
                    hook_name.clone(),
                    json!({
                        "before_cost":
                            (cd.before * 10_000.0).round() / 10_000.0,
                        "after_cost":
                            (cd.after * 10_000.0).round() / 10_000.0,
                        "ratio": ratio,
                    }),
                );
            }
            if let Some(obj) = result.as_object_mut() {
                obj.insert(
                    "cost_impact".to_string(),
                    Value::Object(cost_impact),
                );
            }
        }

        if verbose && let Some(obj) = result.as_object_mut() {
            obj.insert("verbose".to_string(), Value::Array(verbose_rows));
        }

        display::print_json_impact(&result);
    } else {
        display::print_impact_aggregation(&hook_analysis);
        display::print_recovery_curve(&recovery_data);
        if show_cost {
            display::print_cost_impact(&cost_data);
        }
        if verbose {
            display::print_impact_verbose(&verbose_rows);
        }
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();

    let colors_enabled = !args.no_color;
    COLOR.store(colors_enabled, Ordering::SeqCst);

    match &args.command {
        Some(Command::Stats { session_id, sessions, all, tokens, hooks }) => {
            cmd_stats(
                &args,
                session_id.as_deref(),
                *sessions,
                *all,
                *tokens,
                *hooks,
            );
        }
        Some(Command::Timeline { session_id, all_events }) => {
            cmd_timeline(&args, session_id, *all_events);
        }
        Some(Command::Impact {
            sessions,
            session,
            all,
            hook,
            window,
            cost,
            verbose,
        }) => {
            cmd_impact(
                &args,
                *sessions,
                session.as_deref(),
                *all,
                hook.as_deref(),
                *window,
                *cost,
                *verbose,
            );
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
    fn test_args_stats_with_session_id() {
        let args = Args::try_parse_from(["zinspect", "stats", "ses-001"])
            .expect("stats with session should parse");
        assert!(args.command.is_some());
        if let Some(Command::Stats {
            session_id,
            sessions,
            all: _,
            tokens: _,
            hooks: _,
        }) = &args.command
        {
            assert_eq!(session_id.as_deref(), Some("ses-001"));
            assert_eq!(*sessions, None);
        } else {
            panic!("expected Stats command");
        }
    }

    #[test]
    fn test_args_stats_with_sessions() {
        let args =
            Args::try_parse_from(["zinspect", "stats", "--sessions", "5"])
                .expect("stats with --sessions should parse");
        if let Some(Command::Stats { session_id: _, sessions, .. }) =
            &args.command
        {
            assert_eq!(*sessions, Some(5));
        } else {
            panic!("expected Stats command");
        }
    }

    #[test]
    fn test_args_stats_with_flags() {
        let args = Args::try_parse_from([
            "zinspect", "stats", "ses-001", "--tokens", "--hooks",
        ])
        .expect("stats with --tokens --hooks should parse");
        if let Some(Command::Stats { tokens, hooks, .. }) = &args.command {
            assert!(*tokens);
            assert!(*hooks);
        } else {
            panic!("expected Stats command");
        }
    }

    #[test]
    fn test_args_timeline() {
        let args = Args::try_parse_from(["zinspect", "timeline", "ses-001"])
            .expect("timeline should parse");
        if let Some(Command::Timeline { session_id, all_events }) =
            &args.command
        {
            assert_eq!(session_id, "ses-001");
            assert!(!all_events);
        } else {
            panic!("expected Timeline command");
        }
    }

    #[test]
    fn test_args_timeline_with_all() {
        let args = Args::try_parse_from([
            "zinspect",
            "timeline",
            "ses-001",
            "--all-events",
        ])
        .expect("timeline --all-events should parse");
        if let Some(Command::Timeline { session_id, all_events }) =
            &args.command
        {
            assert_eq!(session_id, "ses-001");
            assert!(*all_events);
        } else {
            panic!("expected Timeline command");
        }
    }

    #[test]
    fn test_args_impact_default() {
        let args = Args::try_parse_from(["zinspect", "impact"])
            .expect("impact should parse");
        if let Some(Command::Impact {
            sessions,
            session,
            window,
            cost,
            verbose,
            ..
        }) = &args.command
        {
            assert_eq!(*sessions, 5);
            assert_eq!(*session, None);
            assert_eq!(*window, 6);
            assert!(!*cost);
            assert!(!*verbose);
        } else {
            panic!("expected Impact command");
        }
    }

    #[test]
    fn test_args_impact_with_options() {
        let args = Args::try_parse_from([
            "zinspect",
            "impact",
            "--sessions",
            "10",
            "--window",
            "3",
            "--cost",
            "--verbose",
            "--hook",
            "task-prompt",
        ])
        .expect("impact with options should parse");
        if let Some(Command::Impact {
            sessions,
            window,
            cost,
            verbose,
            hook,
            ..
        }) = &args.command
        {
            assert_eq!(*sessions, 10);
            assert_eq!(*window, 3);
            assert!(*cost);
            assert!(*verbose);
            assert_eq!(hook.as_deref(), Some("task-prompt"));
        } else {
            panic!("expected Impact command");
        }
    }

    #[test]
    fn test_args_global_json() {
        let args =
            Args::try_parse_from(["zinspect", "--json", "stats", "ses-001"])
                .expect("--json should parse");
        assert!(args.json);
    }

    #[test]
    fn test_args_global_no_color() {
        let args = Args::try_parse_from([
            "zinspect",
            "--no-color",
            "stats",
            "ses-001",
        ])
        .expect("--no-color should parse");
        assert!(args.no_color);
    }

    #[test]
    fn test_args_help_shows_help() {
        let err = Args::try_parse_from(["zinspect", "--help"])
            .expect_err("--help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_stats_help_shows_help() {
        let err = Args::try_parse_from(["zinspect", "stats", "--help"])
            .expect_err("stats --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_timeline_help_shows_help() {
        let err = Args::try_parse_from(["zinspect", "timeline", "--help"])
            .expect_err("timeline --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }

    #[test]
    fn test_args_impact_help_shows_help() {
        let err = Args::try_parse_from(["zinspect", "impact", "--help"])
            .expect_err("impact --help should produce error");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
    }
}
