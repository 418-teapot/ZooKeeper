#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use std::fs;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use clap::{CommandFactory, Parser, Subcommand};
use zutil::color::COLOR;
use zutil::{get_zoo_log_dir, jq_path, resolve_session_path};

// ── jq helpers -------------------------------------------------------------

/// Escape a string for use inside a jq string literal (`"…"`).
/// Escapes backslashes and double-quotes.
fn escape_jq_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn build_jq_filter(
    hook: Option<&str>,
    level: Option<&str>,
    event: Option<&str>,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(h) = hook {
        parts.push(format!(".hook == \"{}\"", escape_jq_string(h)));
    }
    if let Some(l) = level {
        parts.push(format!(".level == \"{}\"", escape_jq_string(l)));
    }
    if let Some(e) = event {
        parts.push(format!(".event == \"{}\"", escape_jq_string(e)));
    }
    if parts.is_empty() { None } else { Some(parts.join(" and ")) }
}

/// Build the full jq argument list (including the program path as first element).
fn run_jq_pipeline(filter_str: Option<&str>, unbuffered: bool) -> Vec<String> {
    let mut args = vec![jq_path(), "-c".to_string()];
    if unbuffered {
        args.push("--unbuffered".to_string());
    }
    match filter_str {
        Some(f) => args.push(format!("select({f})")),
        None => args.push(".".to_string()),
    }
    args
}

// ── Commands ---------------------------------------------------------------

fn cmd_show(
    session_id: &str,
    raw: bool,
    json: bool,
    hook: Option<&str>,
    level: Option<&str>,
    event: Option<&str>,
    log_dir: &str,
) {
    let Some(path) = resolve_session_path(session_id, log_dir) else {
        eprintln!("Error: no unique log file found for session '{session_id}'");
        std::process::exit(2);
    };

    // --json takes precedence over --raw
    let raw = raw && !json;

    if raw {
        // Cat the file — output raw content to stdout
        match fs::read_to_string(&path) {
            Ok(content) => print!("{content}"),
            Err(e) => {
                eprintln!("Error: reading file: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    let filter_str = build_jq_filter(hook, level, event);
    let jq_args =
        run_jq_pipeline(filter_str.as_deref(), false /* unbuffered */);

    let file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Error: opening file: {e}");
            std::process::exit(1);
        }
    };

    let mut child = match Command::new(&jq_args[0])
        .args(&jq_args[1..])
        .stdin(Stdio::from(file))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: failed to spawn jq: {e}");
            std::process::exit(1);
        }
    };

    // Exit code is deliberately not checked.
    let _ = child.wait();
}

fn cmd_tail(
    session_id: &str,
    raw: bool,
    json: bool,
    hook: Option<&str>,
    level: Option<&str>,
    event: Option<&str>,
    log_dir: &str,
) {
    let Some(path) = resolve_session_path(session_id, log_dir) else {
        eprintln!("Error: no unique log file found for session '{session_id}'");
        std::process::exit(2);
    };

    // --json takes precedence over --raw
    let raw = raw && !json;

    if raw {
        // Bypass jq entirely — tail -f directly
        let mut child = match Command::new("tail")
            .args(["-n", "0", "-f", &path])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Error: failed to spawn tail: {e}");
                std::process::exit(1);
            }
        };
        let _ = child.wait();
        return;
    }

    let filter_str = build_jq_filter(hook, level, event);
    let jq_args =
        run_jq_pipeline(filter_str.as_deref(), true /* unbuffered */);

    // Build grep pre-filter patterns (order: event, hook, level)
    let mut grep_patterns: Vec<String> = Vec::new();
    if let Some(e) = event {
        grep_patterns.push(format!("\"event\":\"{e}\""));
    }
    if let Some(h) = hook {
        grep_patterns.push(format!("\"hook\":\"{h}\""));
    }
    if let Some(l) = level {
        grep_patterns.push(format!("\"level\":\"{l}\""));
    }

    let mut children: Vec<Child> = Vec::new();

    // ── Pipeline: tail -n 0 -f | grep -F pattern(s) | /usr/bin/jq -c ──────

    // Take stdout before pushing to vec to avoid borrow conflicts.
    let mut tail_proc = match Command::new("tail")
        .args(["-n", "0", "-f", &path])
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // devnull
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: failed to spawn tail: {e}");
            std::process::exit(1);
        }
    };
    let mut prev_pipe = tail_proc.stdout.take();
    children.push(tail_proc);

    // Chain grep pre-filters (AND semantics — each pipe narrows further)
    for pattern in &grep_patterns {
        let mut cmd = Command::new("grep");
        cmd.args(["-F", pattern]);
        cmd.stdin(prev_pipe.take().map_or_else(Stdio::null, Stdio::from));
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null()); // devnull

        let mut grep_proc = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Error: failed to spawn grep: {e}");
                for mut c in std::mem::take(&mut children) {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                std::process::exit(1);
            }
        };
        prev_pipe = grep_proc.stdout.take();
        children.push(grep_proc);
    }

    // Final jq process
    let mut cmd = Command::new(&jq_args[0]);
    cmd.args(&jq_args[1..]);
    cmd.stdin(prev_pipe.take().map_or_else(Stdio::null, Stdio::from));
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit()); // inherit parent stderr so jq errors are visible

    let jq_proc = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: failed to spawn jq: {e}");
            for mut c in std::mem::take(&mut children) {
                let _ = c.kill();
                let _ = c.wait();
            }
            std::process::exit(1);
        }
    };
    children.push(jq_proc);

    // Wait for jq (last in pipeline); if the user presses Ctrl-C, both the
    // parent and all children receive SIGINT.  Children with default
    // disposition die; the parent's ctrlc handler sets a flag but does not
    // exit, allowing wait() to return normally and cleanup to run.
    let last_idx = children.len() - 1;
    let _ = children[last_idx].wait();

    // Finally: terminate all processes (unconditionally — reachable both
    // on normal exit and after Ctrl-C).
    for c in &mut children {
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ── CLI ────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "zlog",
    about = "ZooKeeper log filter — real-time JSON log viewer",
    disable_help_subcommand = true
)]
struct Cli {
    /// Output results in JSON format
    #[arg(short = 'j', long, global = true)]
    json: bool,

    /// Disable colored output
    #[arg(long, global = true)]
    no_color: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Tail -f a log file in real-time
    Tail {
        /// Session ID (full or prefix)
        session_id: String,

        /// Filter by hook name
        #[arg(long)]
        hook: Option<String>,

        /// Filter by level (e.g. info, warn, error)
        #[arg(long)]
        level: Option<String>,

        /// Filter by event name
        #[arg(long)]
        event: Option<String>,

        /// Skip jq filtering, output raw lines
        #[arg(long)]
        raw: bool,
    },
    /// Read and filter an entire log file
    Show {
        /// Session ID (full or prefix)
        session_id: String,

        /// Filter by hook name
        #[arg(long)]
        hook: Option<String>,

        /// Filter by level (e.g. info, warn, error)
        #[arg(long)]
        level: Option<String>,

        /// Filter by event name
        #[arg(long)]
        event: Option<String>,

        /// Skip jq filtering, output raw lines
        #[arg(long)]
        raw: bool,
    },
}

fn main() {
    // Set up Ctrl-C handler: the flag is set but the process keeps running so
    // we can clean up child processes (SIGINT is caught, cleanup runs).
    let interrupted = Arc::new(AtomicBool::new(false));
    let r = Arc::clone(&interrupted);
    if ctrlc::set_handler(move || {
        r.store(true, Ordering::SeqCst);
    })
    .is_err()
    {
        eprintln!("Warning: could not set Ctrl-C handler");
    }

    let cli = Cli::parse();

    let log_dir = get_zoo_log_dir();

    let colors_enabled = !cli.no_color;
    COLOR.store(colors_enabled, Ordering::SeqCst);

    match &cli.command {
        Some(Commands::Tail { session_id, hook, level, event, raw }) => {
            if !Path::new(&log_dir).is_dir() {
                eprintln!("Error: log directory {log_dir} does not exist");
                std::process::exit(2);
            }
            cmd_tail(
                session_id,
                *raw,
                cli.json,
                hook.as_deref(),
                level.as_deref(),
                event.as_deref(),
                &log_dir,
            );
        }
        Some(Commands::Show { session_id, hook, level, event, raw }) => {
            if !Path::new(&log_dir).is_dir() {
                eprintln!("Error: log directory {log_dir} does not exist");
                std::process::exit(2);
            }
            cmd_show(
                session_id,
                *raw,
                cli.json,
                hook.as_deref(),
                level.as_deref(),
                event.as_deref(),
                &log_dir,
            );
        }
        None => {
            // No subcommand given — print help and exit 1
            let mut cmd = Cli::command();
            let _ = cmd.print_help();
            println!();
            std::process::exit(1);
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_jq_filter ──────────────────────────────────────────────

    #[test]
    fn test_jq_filter_none() {
        assert_eq!(build_jq_filter(None, None, None), None);
    }

    #[test]
    fn test_jq_filter_hook_only() {
        let f = build_jq_filter(Some("zoo"), None, None);
        assert_eq!(f.unwrap(), ".hook == \"zoo\"");
    }

    #[test]
    fn test_jq_filter_level_only() {
        let f = build_jq_filter(None, Some("error"), None);
        assert_eq!(f.unwrap(), ".level == \"error\"");
    }

    #[test]
    fn test_jq_filter_event_only() {
        let f = build_jq_filter(None, None, Some("trigger"));
        assert_eq!(f.unwrap(), ".event == \"trigger\"");
    }

    #[test]
    fn test_jq_filter_hook_and_level() {
        let f = build_jq_filter(Some("zoo"), Some("info"), None);
        assert_eq!(f.unwrap(), ".hook == \"zoo\" and .level == \"info\"");
    }

    #[test]
    fn test_jq_filter_all_three() {
        let f = build_jq_filter(Some("zoo"), Some("warn"), Some("trigger"));
        assert_eq!(
            f.unwrap(),
            ".hook == \"zoo\" and .level == \"warn\" and .event == \"trigger\""
        );
    }

    // ── run_jq_pipeline ──────────────────────────────────────────────

    #[test]
    fn test_jq_pipeline_no_filter() {
        let args = run_jq_pipeline(None, false);
        assert_eq!(args[0], jq_path(), "first arg should be jq path");
        assert_eq!(&args[1..], &["-c", "."]);
    }

    #[test]
    fn test_jq_pipeline_no_filter_unbuffered() {
        let args = run_jq_pipeline(None, true);
        assert_eq!(args[0], jq_path(), "first arg should be jq path");
        assert_eq!(&args[1..], &["-c", "--unbuffered", "."]);
    }

    #[test]
    fn test_jq_pipeline_with_filter() {
        let args = run_jq_pipeline(Some(".hook == \"zoo\""), false);
        assert_eq!(args[0], jq_path(), "first arg should be jq path");
        assert_eq!(&args[1..], &["-c", "select(.hook == \"zoo\")"]);
    }

    #[test]
    fn test_jq_pipeline_with_filter_unbuffered() {
        let args = run_jq_pipeline(Some(".hook == \"zoo\""), true);
        assert_eq!(args[0], jq_path(), "first arg should be jq path");
        assert_eq!(
            &args[1..],
            &["-c", "--unbuffered", "select(.hook == \"zoo\")"]
        );
    }

    // ── escape_jq_string ────────────────────────────────────────────

    #[test]
    fn test_escape_jq_string_no_escape() {
        assert_eq!(escape_jq_string("hello"), "hello");
    }

    #[test]
    fn test_escape_jq_string_backslash() {
        assert_eq!(escape_jq_string("a\\b"), "a\\\\b");
    }

    #[test]
    fn test_escape_jq_string_double_quote() {
        assert_eq!(escape_jq_string("say \"hello\""), "say \\\"hello\\\"");
    }

    #[test]
    fn test_escape_jq_string_both() {
        assert_eq!(
            escape_jq_string("path\\to\\\"file\""),
            "path\\\\to\\\\\\\"file\\\""
        );
    }

    // ── build_jq_filter with special characters ─────────────────────

    #[test]
    fn test_jq_filter_with_quotes_in_value() {
        let f = build_jq_filter(Some("say \"hello\""), None, None);
        assert_eq!(f.unwrap(), ".hook == \"say \\\"hello\\\"\"");
    }

    #[test]
    fn test_jq_filter_with_backslash_in_value() {
        let f = build_jq_filter(Some("path\\to"), None, None);
        assert_eq!(f.unwrap(), ".hook == \"path\\\\to\"");
    }

    // ── Integration tests with mock log files ────────────────────────

    use std::fs;
    use std::process::{Command, Stdio};

    /// Create a temporary JSONL log file with sample `ZooKeeper` log
    /// entries. Returns the file path.
    use std::sync::atomic::{AtomicUsize, Ordering};

    static LOG_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn create_mock_log() -> String {
        let dir = std::env::temp_dir();
        let n = LOG_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            dir.join(format!("zlog_test_{}_{}.log", std::process::id(), n));
        let _ = fs::remove_file(&path);
        let content = r#"
{"hook":"task-prompt-validate","level":"info","event":"trigger","ts":"2025-01-09T12:00:00Z"}
{"hook":"json-error-nudge","level":"warn","event":"trigger","ts":"2025-01-09T12:01:00Z"}
{"hook":"direct-work-nudge","level":"info","event":"trigger","ts":"2025-01-09T12:02:00Z"}
{"hook":"post-task-nudge","level":"info","event":"trigger","ts":"2025-01-09T12:03:00Z"}
"#.trim();
        fs::write(&path, content).expect("write mock log");
        path.to_str().unwrap().to_string()
    }

    /// Returns true if jq is installed and executable.
    fn jq_installed() -> bool {
        Command::new(jq_path())
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn test_integration_raw_log_read() {
        let log_path = create_mock_log();
        let content = fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("task-prompt-validate"));
        assert!(content.contains("json-error-nudge"));
        assert_eq!(content.lines().count(), 4);
        let _ = fs::remove_file(&log_path);
    }

    #[test]
    fn test_integration_jq_filter_by_hook() {
        if !jq_installed() {
            eprintln!("[SKIP] jq not installed");
            return;
        }
        let log_path = create_mock_log();
        let filter =
            build_jq_filter(Some("json-error-nudge"), None, None).unwrap();
        let jq_args = run_jq_pipeline(Some(&filter), false);

        let file = fs::File::open(&log_path).unwrap();
        let output = Command::new(&jq_args[0])
            .args(&jq_args[1..])
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn jq");

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("json-error-nudge"),
            "should match hook filter, got: {stdout}"
        );
        assert!(
            !stdout.contains("task-prompt-validate"),
            "should filter out other hooks, got: {stdout}"
        );
        assert_eq!(
            stdout.lines().count(),
            1,
            "expected 1 match, got: {stdout}"
        );

        let _ = fs::remove_file(&log_path);
    }

    #[test]
    fn test_integration_jq_filter_by_hook_and_level() {
        if !jq_installed() {
            eprintln!("[SKIP] jq not installed");
            return;
        }
        let log_path = create_mock_log();
        let filter =
            build_jq_filter(Some("direct-work-nudge"), Some("info"), None)
                .unwrap();
        let jq_args = run_jq_pipeline(Some(&filter), false);

        let file = fs::File::open(&log_path).unwrap();
        let output = Command::new(&jq_args[0])
            .args(&jq_args[1..])
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn jq");

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("direct-work-nudge"), "got: {stdout}");
        assert!(!stdout.contains("task-prompt-validate"), "got: {stdout}");
        assert_eq!(stdout.lines().count(), 1);

        let _ = fs::remove_file(&log_path);
    }

    #[test]
    fn test_integration_jq_filter_by_event() {
        if !jq_installed() {
            eprintln!("[SKIP] jq not installed");
            return;
        }
        let log_path = create_mock_log();
        let filter = build_jq_filter(None, None, Some("trigger")).unwrap();
        let jq_args = run_jq_pipeline(Some(&filter), false);

        let file = fs::File::open(&log_path).unwrap();
        let output = Command::new(&jq_args[0])
            .args(&jq_args[1..])
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn jq");

        let stdout = String::from_utf8_lossy(&output.stdout);
        // All 4 entries have event==trigger
        assert_eq!(stdout.lines().count(), 4);

        let _ = fs::remove_file(&log_path);
    }

    #[test]
    fn test_integration_jq_no_filter() {
        if !jq_installed() {
            eprintln!("[SKIP] jq not installed");
            return;
        }
        let log_path = create_mock_log();
        let jq_args = run_jq_pipeline(None, false);

        let file = fs::File::open(&log_path).unwrap();
        let output = Command::new(&jq_args[0])
            .args(&jq_args[1..])
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn jq");

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(stdout.lines().count(), 4);

        let _ = fs::remove_file(&log_path);
    }

    // ── Global flags ─────────────────────────────────────────────────

    #[test]
    fn test_args_global_json() {
        let args = Cli::try_parse_from(["zlog", "--json", "show", "ses-001"])
            .expect("--json should parse");
        assert!(args.json);
    }

    #[test]
    fn test_args_global_no_color() {
        let args =
            Cli::try_parse_from(["zlog", "--no-color", "show", "ses-001"])
                .expect("--no-color should parse");
        assert!(args.no_color);
    }

    #[test]
    fn test_args_global_json_tail() {
        let args = Cli::try_parse_from(["zlog", "--json", "tail", "ses-001"])
            .expect("--json with tail should parse");
        assert!(args.json);
    }
}
