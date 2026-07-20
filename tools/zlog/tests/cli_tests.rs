//! Integration tests for the `zlog` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Fixture-based tests
//! use a temporary home directory to exercise `cmd_show`'s raw file
//! read path and the jq-filter pipeline, as well as the log-directory
//! check in `main()`.
//!
//! The `--help` tests inject a fake `HOME` so they never depend on a
//! real `~/.zoo/log` directory.  With the directory check moved after
//! `Cli::parse()`, clap handles `--help` before any I/O check runs.

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tempfile::TempDir;

/// Path to the `zlog` binary, set by `cargo test`.
const ZLOG_BIN: &str = env!("CARGO_BIN_EXE_zlog");

// ── Test Fixture ──────────────────────────────────────────────────────────────

/// A test fixture that provisions a temporary home directory with a
/// `~/.zoo/log/` folder containing mock JSONL log files.
///
/// The fixture is alive for the duration of the test (drop = cleanup).
struct TestFixture {
    /// Keeps the fake HOME alive until the test ends.
    _home_dir: TempDir,
    /// Absolute path to the fake HOME directory.
    home_path: String,
}

impl TestFixture {
    /// Create a new fixture with a populated `~/.zoo/log/` directory.
    fn new() -> Self {
        let home_dir = TempDir::new().expect("create temp dir");
        let log_dir = home_dir.path().join(".zoo").join("log");
        fs::create_dir_all(&log_dir).expect("create log dir");

        // ses-001: 4 log entries with different hook/level combinations
        let data_001 = concat!(
            r#"{"hook":"task-prompt-validate","level":"info","event":"trigger","ts":"2025-01-09T12:00:00Z","sessionId":"ses-001"}"#,
            "\n",
            r#"{"hook":"json-error-nudge","level":"warn","event":"trigger","ts":"2025-01-09T12:01:00Z","sessionId":"ses-001","tool":"webfetch","pattern":"SyntaxError"}"#,
            "\n",
            r#"{"hook":"direct-work-nudge","level":"info","event":"trigger","ts":"2025-01-09T12:02:00Z","sessionId":"ses-001","tool":"edit"}"#,
            "\n",
            r#"{"hook":"post-task-nudge","level":"info","event":"trigger","ts":"2025-01-09T12:03:00Z","sessionId":"ses-001","todo_state":"pending","nudge":"beaver"}"#,
            "\n",
        );
        fs::write(log_dir.join("opencode-ses-001.log"), data_001)
            .expect("write ses-001 log");

        // ses-002: single entry for prefix-uniqueness
        let data_002 = concat!(
            r#"{"hook":"task-prompt-validate","level":"info","event":"trigger","ts":"2025-01-09T14:00:00Z","sessionId":"ses-002"}"#,
            "\n",
        );
        fs::write(log_dir.join("opencode-ses-002.log"), data_002)
            .expect("write ses-002 log");

        Self {
            home_path: home_dir.path().to_string_lossy().to_string(),
            _home_dir: home_dir,
        }
    }

    /// Build a `Command` that runs `zlog` with HOME pointing at the
    /// fixture's temp home directory and `--no-color` (no ANSI escapes).
    fn zlog(&self) -> Command {
        let mut cmd = Command::new(ZLOG_BIN);
        cmd.env("HOME", &self.home_path).arg("--no-color");
        cmd
    }
}

// ── Basic CLI tests ──────────────────────────────────────────────────────────

#[test]
fn test_help_exits_0() {
    let home_dir = TempDir::new().expect("create temp dir");
    let output = Command::new(ZLOG_BIN)
        .arg("--help")
        .env("HOME", home_dir.path())
        .output()
        .expect("failed to run zlog --help");
    assert!(
        output.status.success(),
        "zlog --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
}

#[test]
fn test_show_help_exits_0() {
    let home_dir = TempDir::new().expect("create temp dir");
    let output = Command::new(ZLOG_BIN)
        .args(["show", "--help"])
        .env("HOME", home_dir.path())
        .output()
        .expect("failed to run zlog show --help");
    assert!(
        output.status.success(),
        "zlog show --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_tail_help_exits_0() {
    let home_dir = TempDir::new().expect("create temp dir");
    let output = Command::new(ZLOG_BIN)
        .args(["tail", "--help"])
        .env("HOME", home_dir.path())
        .output()
        .expect("failed to run zlog tail --help");
    assert!(
        output.status.success(),
        "zlog tail --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_show_invalid_exits_2() {
    let output = Command::new(ZLOG_BIN)
        .args(["show", "nonexistent-session-xyz"])
        .output()
        .expect("failed to run zlog show <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zlog show <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

#[test]
fn test_tail_invalid_exits_2() {
    let output = Command::new(ZLOG_BIN)
        .args(["tail", "nonexistent-session-xyz"])
        .output()
        .expect("failed to run zlog tail <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zlog tail <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

#[test]
fn test_no_subcommand_exits_1() {
    let output = Command::new(ZLOG_BIN)
        .output()
        .expect("failed to run zlog with no subcommand");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zlog with no subcommand should exit 1"
    );
}

// ── Log-directory checks ──────────────────────────────────────────────────────

#[test]
fn test_log_dir_missing_exits_2() {
    let home_dir = TempDir::new().expect("create temp dir");
    // Intentionally do NOT create ~/.zoo/log/ — main() should catch it
    let output = Command::new(ZLOG_BIN)
        .args(["show", "ses-001"])
        .env("HOME", home_dir.path())
        .output()
        .expect("failed to run zlog with missing log dir");
    assert_eq!(
        output.status.code(),
        Some(2),
        "missing log dir should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("log directory"),
        "stderr should mention 'log directory', got: {stderr}"
    );
}

#[test]
fn test_show_invalid_with_fixture_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "nonexistent-xyz"])
        .output()
        .expect("failed to run zlog show <invalid> with fixture");
    assert_eq!(
        output.status.code(),
        Some(2),
        "should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

// ── cmd_show: raw (cat) path ─────────────────────────────────────────────────

#[test]
fn test_show_raw_all_lines() {
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--raw"])
        .output()
        .expect("failed to run zlog show ses-001 --raw");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("task-prompt-validate"),
        "raw output should contain first entry"
    );
    assert!(
        stdout.contains("json-error-nudge"),
        "raw output should contain second entry"
    );
    assert!(
        stdout.contains("direct-work-nudge"),
        "raw output should contain third entry"
    );
    assert!(
        stdout.contains("post-task-nudge"),
        "raw output should contain fourth entry"
    );
    assert_eq!(stdout.lines().count(), 4, "should have exactly 4 lines");
}

#[test]
fn test_show_raw_prefix_matches() {
    let fix = TestFixture::new();
    // "ses-001" is a prefix of itself → should match exactly
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--raw"])
        .output()
        .expect("failed to run zlog show ses-001 --raw");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("task-prompt-validate"));
}

#[test]
fn test_show_raw_json_flag_disables_raw() {
    // --json takes precedence over --raw: outcome should be jq output.
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--raw", "--json"])
        .output()
        .expect("failed to run zlog show ses-001 --raw --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // jq output is JSON, not raw — each line should parse as JSON
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let parsed: Result<serde_json::Value, _> =
                serde_json::from_str(trimmed);
            assert!(
                parsed.is_ok(),
                "jq output should be valid JSON per line, got: {trimmed}"
            );
        }
    }
}

// ── cmd_show: jq pipeline ────────────────────────────────────────────────────

/// Returns `true` if `jq` is available on `PATH` or at `/usr/bin/jq`.
fn jq_installed() -> bool {
    Command::new(zutil::jq_path())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn test_show_jq_no_filter() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "ses-001"])
        .output()
        .expect("failed to run zlog show ses-001");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Without a filter, jq -c '.' outputs every JSON line
    assert_eq!(stdout.lines().count(), 4, "should output all 4 lines");
}

#[test]
fn test_show_jq_with_hook_filter() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--hook", "json-error-nudge"])
        .output()
        .expect("failed to run zlog show ses-001 --hook json-error-nudge");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("json-error-nudge"),
        "output should contain the matching hook"
    );
    assert!(
        !stdout.contains("task-prompt-validate"),
        "output should NOT contain other hooks"
    );
    assert!(
        !stdout.contains("direct-work-nudge"),
        "output should NOT contain other hooks"
    );
    assert_eq!(
        stdout.lines().count(),
        1,
        "should have exactly 1 matching line"
    );
}

#[test]
fn test_show_jq_with_level_filter() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--level", "warn"])
        .output()
        .expect("failed to run zlog show ses-001 --level warn");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("json-error-nudge"),
        "output should contain the warn entry"
    );
    assert!(
        !stdout.contains("task-prompt-validate"),
        "output should NOT contain info entries"
    );
    assert_eq!(stdout.lines().count(), 1, "should have exactly 1 warn line");
}

#[test]
fn test_show_jq_with_hook_and_level_filter() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args([
            "show",
            "ses-001",
            "--hook",
            "direct-work-nudge",
            "--level",
            "info",
        ])
        .output()
        .expect(
            "failed to run zlog show ses-001 --hook direct-work-nudge --level info",
        );
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("direct-work-nudge"),
        "output should contain the matching entry"
    );
    assert!(
        !stdout.contains("task-prompt-validate"),
        "output should NOT contain other hooks"
    );
    assert_eq!(
        stdout.lines().count(),
        1,
        "should have exactly 1 matching line"
    );
}

#[test]
fn test_show_jq_with_event_filter() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    // All 4 entries have event=="trigger"
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--event", "trigger"])
        .output()
        .expect("failed to run zlog show ses-001 --event trigger");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.lines().count(), 4, "all 4 lines have event=trigger");
}

#[test]
fn test_show_jq_no_match_exits_0() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    // No entry has level=="error"
    let output = fix
        .zlog()
        .args(["show", "ses-001", "--level", "error"])
        .output()
        .expect("failed to run zlog show ses-001 --level error");
    assert!(
        output.status.success(),
        "no-match should still exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.trim().is_empty(), "output should be empty, got: {stdout}");
}

// ── cmd_show: resolve_session_path edge cases ────────────────────────────────

#[test]
fn test_show_ambiguous_prefix_exits_2() {
    let fix = TestFixture::new();
    // "ses-" matches both ses-001 and ses-002 → ambiguous
    let output = fix
        .zlog()
        .args(["show", "ses-"])
        .output()
        .expect("failed to run zlog show ses-");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ambiguous prefix should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

#[test]
fn test_show_absolute_path_resolved() {
    // Passing a path with directory components: resolve_session_path
    // strips directories via `Path::file_name`.
    let fix = TestFixture::new();
    let output = fix
        .zlog()
        .args(["show", "/some/dir/ses-001", "--raw"])
        .output()
        .expect("failed to run zlog show /some/dir/ses-001 --raw");
    assert!(
        output.status.success(),
        "directory-stripped path should resolve, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("task-prompt-validate"));
}

// ── cmd_show: error paths ──────────────────────────────────────────────────

#[test]
fn test_show_raw_unreadable_file_exits_1() {
    let fix = TestFixture::new();
    let log_path = fix
        ._home_dir
        .path()
        .join(".zoo")
        .join("log")
        .join("opencode-ses-001.log");

    // Make the file unreadable so fs::read_to_string fails.
    fs::set_permissions(&log_path, fs::Permissions::from_mode(0o000))
        .expect("set perms to 000");

    let output =
        fix.zlog().args(["show", "ses-001", "--raw"]).output().expect(
            "failed to run zlog show ses-001 --raw with unreadable file",
        );
    assert_eq!(
        output.status.code(),
        Some(1),
        "unreadable file should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Error: reading file"),
        "stderr should mention 'reading file', got: {stderr}"
    );

    // Restore permissions so TempDir cleanup does not fail.
    fs::set_permissions(&log_path, fs::Permissions::from_mode(0o644))
        .expect("restore perms");
}

#[test]
fn test_show_jq_unreadable_file_exits_1() {
    if !jq_installed() {
        eprintln!("[SKIP] jq not installed");
        return;
    }
    let fix = TestFixture::new();
    let log_path = fix
        ._home_dir
        .path()
        .join(".zoo")
        .join("log")
        .join("opencode-ses-001.log");

    // Make the file unreadable so fs::File::open (jq path) fails.
    fs::set_permissions(&log_path, fs::Permissions::from_mode(0o000))
        .expect("set perms to 000");

    let output = fix
        .zlog()
        .args(["show", "ses-001"])
        .output()
        .expect("failed to run zlog show ses-001 with unreadable file");
    assert_eq!(
        output.status.code(),
        Some(1),
        "unreadable file should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Error: opening file"),
        "stderr should mention 'opening file', got: {stderr}"
    );

    // Restore permissions so TempDir cleanup does not fail.
    fs::set_permissions(&log_path, fs::Permissions::from_mode(0o644))
        .expect("restore perms");
}

// ── cmd_tail: spawn-error paths (PATH="" forces tail/grep lookup failure) ────
//
// These tests exercise the `cmd_tail` error branches where `tail` or `grep`
// cannot be spawned.  By setting PATH to an empty string we force execvp to
// fail when looking up "tail" (or "grep") without an absolute path.

#[test]
fn test_tail_raw_spawn_error_exits_1() {
    let fix = TestFixture::new();
    // Override PATH to empty so Command::new("tail") fails to find tail.
    let output = fix
        .zlog()
        .env("PATH", "")
        .args(["tail", "ses-001", "--raw"])
        .output()
        .expect("failed to run zlog tail ses-001 --raw with empty PATH");
    assert_eq!(
        output.status.code(),
        Some(1),
        "tail spawn error should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to spawn tail"),
        "stderr should mention 'failed to spawn tail', got: {stderr}"
    );
}

#[test]
fn test_tail_jq_tail_spawn_error_exits_1() {
    let fix = TestFixture::new();
    // Non-raw path also uses `tail` (first in the pipeline).
    let output = fix
        .zlog()
        .env("PATH", "")
        .args(["tail", "ses-001"])
        .output()
        .expect("failed to run zlog tail ses-001 with empty PATH");
    assert_eq!(
        output.status.code(),
        Some(1),
        "tail spawn error (jq path) should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to spawn tail"),
        "stderr should mention 'failed to spawn tail', got: {stderr}"
    );
}

// ── cmd_tail: raw path (spawn + write + kill, process-group managed) ────────
//
// These tests exercise the `cmd_tail` function's raw mode.  Since tail -f
// blocks indefinitely, we spawn zlog, append a line to the watched log file,
// verify the new line appears in zlog's stdout, then kill the process group
// to prevent leaking the tail child.
//
// Process-group management uses safe `CommandExt::process_group(0)` (no
// unsafe/libc) and `kill -TERM -<PGID>` via `Command`.  A Drop guard
// ensures cleanup even if the test panics between spawn and kill.

/// Drop guard that kills a process group on drop (panic-safe cleanup).
struct ProcessGroupGuard {
    pgid: i32,
    killed: bool,
}

impl ProcessGroupGuard {
    fn new(pgid: i32) -> Self {
        Self { pgid, killed: false }
    }

    /// Mark the guard as disarmed — the kill has already been performed.
    fn disarm(&mut self) {
        self.killed = true;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if !self.killed {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{}", self.pgid)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Kill a process group by PGID using the safe `kill` command.
fn kill_process_group(pgid: i32) {
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{}", pgid)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[test]
fn test_tail_raw_new_line_appended() {
    let fix = TestFixture::new();

    // Build the command with piped stdout/stderr so we can capture output.
    // `process_group(0)` creates a new process group for the child (and
    // any grandchildren like tail -f inherit it).  This is the safe
    // equivalent of `setpgid(0, 0)` in a pre_exec hook.
    let mut cmd = fix.zlog();
    cmd.args(["tail", "ses-001", "--raw"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.process_group(0);

    let mut child = cmd.spawn().expect("spawn zlog tail --raw");
    let pgid = child.id() as i32;

    // Drop guard ensures cleanup if the test panics between here and
    // the explicit kill below.
    let mut guard = ProcessGroupGuard::new(pgid);

    // Spawn a reader thread that forwards stdout data through a channel
    // so the main thread can poll with timeouts instead of fixed sleeps.
    let mut child_stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            match child_stdout.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // receiver dropped
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Brief pause for tail -f to start and register inotify before we
    // append.  This is much smaller than the original 300ms sleep and is
    // bounded (milliseconds only); the main wait below uses polling.
    std::thread::sleep(Duration::from_millis(50));

    // Append a new JSONL line to the watched log file.
    let new_line = concat!(
        r#"{"hook":"new-event","level":"info","event":"test","#,
        r#""ts":"2025-01-09T13:00:00Z","sessionId":"ses-001"}"#,
        "\n",
    );
    let log_path = fix
        ._home_dir
        .path()
        .join(".zoo")
        .join("log")
        .join("opencode-ses-001.log");
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&log_path)
        .expect("open log for append");
    use std::io::Write;
    f.write_all(new_line.as_bytes()).expect("append new line to log");
    drop(f);

    // Poll stdout for expected content (bounded, no fixed sleep).
    let start = Instant::now();
    let timeout = Duration::from_secs(5);
    let poll_interval = Duration::from_millis(50);
    let mut accumulated = Vec::new();
    let found = loop {
        match rx.recv_timeout(poll_interval) {
            Ok(data) => {
                accumulated.extend_from_slice(&data);
                if accumulated
                    .windows(b"new-event".len())
                    .any(|w| w == b"new-event")
                {
                    break true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if start.elapsed() > timeout {
                    break false;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break false;
            }
        }
    };

    // Kill the entire process group to stop both zlog and its tail child.
    kill_process_group(pgid);
    guard.disarm();

    // Wait for child to exit (stdout already consumed via channel).
    let _ = child.wait();

    let stdout_content = String::from_utf8_lossy(&accumulated);

    assert!(
        found || stdout_content.contains("new-event"),
        "tail --raw should have emitted the appended line, got stdout: {stdout_content}",
    );
    // The original 4 lines should NOT appear (tail -n 0 suppresses history).
    assert!(
        !stdout_content.contains("task-prompt-validate"),
        "tail -n 0 should NOT output existing lines, got: {stdout_content}"
    );
}
