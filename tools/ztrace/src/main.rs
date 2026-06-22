#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::collections::HashMap;

use clap::{Parser, Subcommand};
use serde_json::{Map, Number, Value};
use std::sync::atomic::Ordering;

use zutil::color::COLOR;
use zutil::color::msg_print;
use zutil::db_helpers::resolve_session_id;

mod db;
mod display;
mod helpers;
mod jaeger;
mod parser;
mod trace_builder;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(clap::ValueEnum, Clone, Debug)]
enum ExportFormat {
    Jaeger,
    Chrome,
}

#[derive(Parser, Debug)]
#[command(
    name = "ztrace",
    about = "ZooKeeper trace -- full orchestration trace with timeline \
             merging for OpenCode sessions.",
    disable_help_subcommand = true
)]
struct Args {
    /// Output results in JSON format
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
    /// Message-level token distribution
    Tokens {
        /// Session ID
        session_id: String,
    },
}

// ── Command Handlers ─────────────────────────────────────────────────────

fn cmd_show(args: &Args, session_id: &str, all: bool, verbose: bool) {
    let opencode_path =
        zutil::expand_tilde("~/.local/share/opencode/log/opencode.log");
    let db_path = zutil::expand_tilde(&args.db);

    let resolved = match resolve_session_id(session_id, &db_path) {
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

    let mut timeline = match trace_builder::build_timeline(
        session_id,
        &opencode_path,
        &db_path,
        all,
    ) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(2);
        }
    };

    if timeline.is_empty() {
        msg_print("[yellow]No events found[/yellow]");
        return;
    }

    let child_sessions_info =
        helpers::collect_child_sessions_info(&timeline, session_id);

    let stats =
        trace_builder::build_stats(&timeline, Some(&child_sessions_info));

    let all_sids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        timeline
            .iter()
            .filter_map(|ev| ev.get("session_id").and_then(|v| v.as_str()))
            .filter(|sid| seen.insert(*sid))
            .map(std::string::ToString::to_string)
            .collect()
    };
    let all_sids_refs: Vec<&str> =
        all_sids.iter().map(std::string::String::as_str).collect();
    helpers::attach_durations(&mut timeline, &all_sids_refs, &db_path);

    // --json output
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&timeline)
                .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
        );
        return;
    }

    if verbose {
        display::render_session_panel(session_id, &timeline, &stats, false);
        display::render_timeline_rich(&timeline);
    } else {
        display::render_session_panel(session_id, &timeline, &stats, true);
        display::render_ops_summary(&timeline, &stats, false);
    }
}

fn cmd_export(
    args: &Args,
    session_id: &str,
    all: bool,
    format: &ExportFormat,
    output: &str,
) {
    let opencode_path =
        zutil::expand_tilde("~/.local/share/opencode/log/opencode.log");
    let db_path = zutil::expand_tilde(&args.db);
    let output_path = zutil::expand_tilde(output);

    let resolved = match resolve_session_id(session_id, &db_path) {
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

    let timeline = match trace_builder::build_timeline(
        session_id,
        &opencode_path,
        &db_path,
        all,
    ) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(2);
        }
    };

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

    // --json output: print JSON envelope
    if args.json {
        let envelope = serde_json::json!({
            "status": "ok",
            "format": format!("{format:?}").to_lowercase(),
            "output": output_path,
            "events": timeline.len(),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&envelope)
                .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
        );
    }
}

fn discover_and_merge_child_steps(
    session_id: &str,
    db_path: &str,
    steps: &mut Vec<Value>,
) {
    let child_results = helpers::discover_child_steps(session_id, db_path);
    for (child_sid, _depth, child_steps) in child_results {
        for mut step in child_steps {
            if let Some(obj) = step.as_object_mut() {
                obj.insert(
                    "_session_id".to_string(),
                    Value::String(child_sid.clone()),
                );
            }
            steps.push(step);
        }
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

/// Parse ISO timestamp to seconds as f64, avoiding i64→f64 `as` casts.
///
/// Uses `i32::try_from` + `f64::from` so clippy does not emit
/// `cast_precision_loss`.
fn iso_to_epoch_secs_f64(ts: &str) -> f64 {
    /// Convert an i64 timestamp to f64 seconds, handling values
    /// beyond `i32::MAX` (post-2038) by decomposing into high/low parts.
    fn timestamp_to_secs(timestamp: i64) -> f64 {
        if let Ok(s) = i32::try_from(timestamp) {
            return f64::from(s);
        }
        let high = i32::try_from(timestamp / 1_000_000).unwrap_or(0);
        let low = i32::try_from(timestamp % 1_000_000).unwrap_or(0);
        f64::from(high) * 1_000_000.0 + f64::from(low)
    }

    if ts.is_empty() {
        return 0.0;
    }
    let cleaned = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&cleaned) {
        let secs = timestamp_to_secs(dt.timestamp());
        let subsec_ms = dt.timestamp_subsec_millis();
        return secs + f64::from(subsec_ms) / 1000.0;
    }
    let bare = ts.trim_end_matches('Z');
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S%.f")
    {
        let secs = timestamp_to_secs(nd.and_utc().timestamp());
        let subsec_ms = nd.and_utc().timestamp_subsec_millis();
        return secs + f64::from(subsec_ms) / 1000.0;
    }
    if let Ok(nd) =
        chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S")
    {
        let secs = timestamp_to_secs(nd.and_utc().timestamp());
        let subsec_ms = nd.and_utc().timestamp_subsec_millis();
        return secs + f64::from(subsec_ms) / 1000.0;
    }
    0.0
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

            let time_created =
                obj.get("time_created").and_then(|v| v.as_str()).unwrap_or("");
            let time_updated =
                obj.get("time_updated").and_then(|v| v.as_str()).unwrap_or("");
            let msg_created =
                obj.get("msg_time_created").and_then(serde_json::Value::as_f64);
            let msg_completed = obj
                .get("msg_time_completed")
                .and_then(serde_json::Value::as_f64);

            let dur =
                if let (Some(mc), Some(mcr)) = (msg_completed, msg_created) {
                    (mc - mcr) / 1000.0
                } else {
                    let c_s = iso_to_epoch_secs_f64(time_created);
                    let u_s = iso_to_epoch_secs_f64(time_updated);
                    if u_s > c_s { u_s - c_s } else { 0.0 }
                };
            obj.insert(
                "duration".to_string(),
                Value::Number(
                    Number::from_f64(dur)
                        .unwrap_or_else(|| Number::from_f64(0.0).unwrap()),
                ),
            );
        }
    }
}

fn apply_filter(
    all_steps: &mut Vec<Value>,
    hook_map: &mut HashMap<i64, Vec<String>>,
    drop_threshold: i64,
    session_id: &str,
    hook_overlays: bool,
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
    if hook_overlays {
        let log_path = parser::resolve_log_path(session_id);
        let zoo_events = parser::parse_zoo_log(&log_path);
        *hook_map = helpers::match_hooks_to_steps(all_steps, &zoo_events);
    }
}

fn cmd_steps(
    args: &Args,
    session_id: &str,
    hook_overlays: bool,
    all: bool,
    min_cache_drop: Option<i64>,
) {
    let db_path = zutil::expand_tilde(&args.db);

    let resolved = match resolve_session_id(session_id, &db_path) {
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

    // 1. Query steps from DB
    let mut all_steps = db::query_step_data_batch(&[session_id], &db_path);

    // 2. Child steps (stub — returns empty for now)
    if all {
        discover_and_merge_child_steps(session_id, &db_path, &mut all_steps);
    }

    // 3. Sort and index
    sort_and_index_steps(&mut all_steps, session_id);

    // 4. Hook overlays
    let mut hook_map: HashMap<i64, Vec<String>> = if hook_overlays {
        let log_path = parser::resolve_log_path(session_id);
        let zoo_events = parser::parse_zoo_log(&log_path);
        helpers::match_hooks_to_steps(&all_steps, &zoo_events)
    } else {
        HashMap::new()
    };

    // 5. Compute per-step metrics
    compute_step_metrics(&mut all_steps);

    // 6. Filter by --min-cache-drop
    if let Some(drop_threshold) = min_cache_drop {
        apply_filter(
            &mut all_steps,
            &mut hook_map,
            drop_threshold,
            session_id,
            hook_overlays,
        );
    }

    // 7. Output
    if args.json {
        display::output_steps_json(&all_steps, &hook_map);
    } else {
        display::render_steps_table(&all_steps, &hook_map);
    }
}

fn cmd_tokens(args: &Args, session_id: &str) {
    let db_path = zutil::expand_tilde(&args.db);

    let resolved = match resolve_session_id(session_id, &db_path) {
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

    let messages = db::query_message_parts(session_id, &db_path);

    let mut rows: Vec<Value> = Vec::new();
    for msg in &messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let parts = msg
            .get("parts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let msg_id =
            msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let segments = parts
            .iter()
            .filter(|p| {
                p.get("type").and_then(|v| v.as_str()) != Some("step-finish")
            })
            .count();

        let tokens = zutil::estimate_tokens(&parts);

        // Classify role
        let role_class = match role {
            "user" => "user",
            "assistant" => {
                let has_tool = parts.iter().any(|p| {
                    p.get("type").and_then(|v| v.as_str()) == Some("tool")
                });
                if has_tool { "tool_use" } else { "assistant" }
            }
            "tool" => "tool_result",
            _ => role,
        };

        // Extract first text content as preview
        let preview = parts
            .iter()
            .find(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
            .and_then(|p| p.get("text").and_then(|v| v.as_str()))
            .map(|t| {
                let collapsed = t.replace('\n', " ").trim().to_string();
                zutil::truncate_width(&collapsed, 40)
            })
            .unwrap_or_default();

        let mut row = Map::new();
        row.insert("id".to_string(), Value::String(msg_id));
        row.insert("role".to_string(), Value::String(role_class.to_string()));
        row.insert(
            "tokens".to_string(),
            Value::Number(Number::from(tokens as u64)),
        );
        row.insert(
            "segments".to_string(),
            Value::Number(Number::from(segments as u64)),
        );
        row.insert("preview".to_string(), Value::String(preview));
        rows.push(Value::Object(row));
    }

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
            cmd_export(&args, session_id, *all, format, output);
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
}
