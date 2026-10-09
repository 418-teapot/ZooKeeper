//! Integration tests for the `zlog` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Fixture-based tests
//! use a temporary home directory to exercise `cmd_show`'s raw file
//! read path and the jq-filter pipeline, as well as the log-directory
//! check in `main()`.
//!
//! The `--help` tests inject a fake `HOME` so they never depend on a
//! real `~/.zoo/log` directory: the directory check runs after
//! `Cli::parse()`, so clap handles `--help` before any I/O check runs.

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ztest::TestEnv;

/// Path to the `zlog` binary, set by `cargo test`.
const ZLOG_BIN: &str = env!("CARGO_BIN_EXE_zlog");

// ── Test Fixture ──────────────────────────────────────────────────────────────

/// A test fixture that provisions a temporary home directory with a
/// `~/.zoo/log/` folder containing mock JSONL log files.
///
/// The fixture is alive for the duration of the test (drop = cleanup).
struct TestFixture {
    /// Hermetic environment; its temp HOME backs the fake `~/.zoo/log/`.
    env: TestEnv,
}

impl TestFixture {
    /// Create a new fixture with a populated `~/.zoo/log/` directory.
    fn new() -> Self {
        let env = TestEnv::new();
        let log_dir = env.zoo_log_dir();
        fs::create_dir_all(&log_dir).expect("create log dir");

        // ses-001: 4 log entries with different hook/level combinations
        let data_001 = concat!(
            r#"{"hook":"subagent-prompt","level":"info","event":"trigger","timestamp":"2025-01-09T12:00:00Z","sessionId":"ses-001"}"#,
            "\n",
            r#"{"hook":"json-error-nudge","level":"warn","event":"trigger","timestamp":"2025-01-09T12:01:00Z","sessionId":"ses-001","tool":"webfetch","pattern":"SyntaxError"}"#,
            "\n",
            r#"{"hook":"direct-work-nudge","level":"info","event":"trigger","timestamp":"2025-01-09T12:02:00Z","sessionId":"ses-001","tool":"edit"}"#,
            "\n",
            r#"{"hook":"post-subagent-nudge","level":"info","event":"trigger","timestamp":"2025-01-09T12:03:00Z","sessionId":"ses-001","todo_state":"pending","nudge":"beaver"}"#,
            "\n",
        );
        fs::write(log_dir.join("opencode-ses-001.log"), data_001)
            .expect("write ses-001 log");

        // ses-002: single entry for prefix-uniqueness. Hosted on pi: the
        // log lives in `pi-ses-002.log` and must be resolved via the pi
        // prefix.
        let data_002 = concat!(
            r#"{"hook":"subagent-prompt","level":"info","event":"trigger","timestamp":"2025-01-09T14:00:00Z","sessionId":"ses-002"}"#,
            "\n",
        );
        fs::write(log_dir.join("pi-ses-002.log"), data_002)
            .expect("write ses-002 log");

        Self { env }
    }

    /// Build a `Command` that runs `zlog` inside the fixture's hermetic
    /// environment with `--no-color` (no ANSI escapes).
    fn zlog(&self) -> Command {
        let mut cmd = self.env.command(ZLOG_BIN);
        cmd.arg("--no-color");
        cmd
    }
}

// ── Basic CLI tests ──────────────────────────────────────────────────────────

#[test]
fn test_help_exits_0() {
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
        .arg("--help")
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
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
        .args(["show", "--help"])
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
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
        .args(["tail", "--help"])
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
    // The harness keeps HOME hermetic; seed an empty log dir so the run
    // reaches the "no unique log file" path instead of failing earlier on
    // a missing directory.
    let env = TestEnv::new();
    fs::create_dir_all(env.zoo_log_dir()).expect("create empty zoo log dir");
    let output = env
        .command(ZLOG_BIN)
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
    // The harness keeps HOME hermetic; seed an empty log dir so the run
    // reaches the "no unique log file" path instead of failing earlier on
    // a missing directory.
    let env = TestEnv::new();
    fs::create_dir_all(env.zoo_log_dir()).expect("create empty zoo log dir");
    let output = env
        .command(ZLOG_BIN)
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
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
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
    // The harness HOME stays empty: intentionally do NOT create
    // ~/.zoo/log/ — main() should catch it.
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
        .args(["show", "ses-001"])
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
fn test_tail_log_dir_missing_exits_2() {
    // Same as test_log_dir_missing_exits_2 but for the `tail` subcommand,
    // which performs its own directory check in main().
    let env = TestEnv::new();
    let output = env
        .command(ZLOG_BIN)
        .args(["tail", "ses-001"])
        .output()
        .expect("failed to run zlog tail with missing log dir");
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
        stdout.contains("subagent-prompt"),
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
        stdout.contains("post-subagent-nudge"),
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
    assert!(stdout.contains("subagent-prompt"));
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

/// Thin wrapper over [`zutil::jq_installed`].
fn jq_installed() -> bool {
    zutil::jq_installed()
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
        !stdout.contains("subagent-prompt"),
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
        !stdout.contains("subagent-prompt"),
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
        !stdout.contains("subagent-prompt"),
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
fn test_show_raw_pi_hosted_session() {
    let fix = TestFixture::new();
    // ses-002's log lives in `pi-ses-002.log`; `show` must resolve it
    // through the pi prefix.
    let output = fix
        .zlog()
        .args(["show", "ses-002", "--raw"])
        .output()
        .expect("failed to run zlog show ses-002 --raw");
    assert!(
        output.status.success(),
        "show pi-hosted ses-002 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("subagent-prompt"),
        "raw output should contain the pi-hosted entry"
    );
}

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
    assert!(stdout.contains("subagent-prompt"));
}

// ── cmd_show: error paths ──────────────────────────────────────────────────

#[test]
fn test_show_raw_unreadable_file_exits_1() {
    let fix = TestFixture::new();
    let log_path = fix.env.zoo_log_dir().join("opencode-ses-001.log");

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
    let log_path = fix.env.zoo_log_dir().join("opencode-ses-001.log");

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

/// Send SIGINT to a process group.  Unlike SIGTERM this lets `zlog` catch
/// the signal, run its cleanup and exit normally so its coverage profile
/// is flushed.
fn interrupt_process_group(pgid: i32) {
    let _ = Command::new("kill")
        .args(["-INT", &format!("-{}", pgid)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Wait for a child to exit, polling until `timeout` elapses.  Returns the
/// exit status, or `None` if the child is still running.
fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                if start.elapsed() > timeout {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
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
    // append.  The sleep is bounded to milliseconds; the main wait below
    // uses polling.
    std::thread::sleep(Duration::from_millis(50));

    // Append a new JSONL line to the watched log file.
    let new_line = concat!(
        r#"{"hook":"new-event","level":"info","event":"test","#,
        r#""timestamp":"2025-01-09T13:00:00Z","sessionId":"ses-001"}"#,
        "\n",
    );
    let log_path = fix.env.zoo_log_dir().join("opencode-ses-001.log");
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

    // SIGINT the group: zlog catches it, tail dies, and zlog exits
    // normally (which lets its coverage profile flush).  Fall back to
    // SIGTERM if the graceful path does not finish in time.
    interrupt_process_group(pgid);
    let status = wait_with_timeout(&mut child, Duration::from_secs(5));
    if status.is_none() {
        kill_process_group(pgid);
        let _ = child.wait();
    }
    guard.disarm();

    let stdout_content = String::from_utf8_lossy(&accumulated);

    assert!(
        found || stdout_content.contains("new-event"),
        "tail --raw should have emitted the appended line, got stdout: {stdout_content}",
    );
    assert!(
        status.is_some_and(|s| s.success()),
        "zlog tail --raw should exit cleanly after SIGINT, got {status:?}"
    );
    // The 4 pre-existing lines should NOT appear (tail -n 0 suppresses
    // history).
    assert!(
        !stdout_content.contains("subagent-prompt"),
        "tail -n 0 should NOT output existing lines, got: {stdout_content}"
    );
}

// ── cmd_tail: jq pipeline (spawn + stream + Ctrl-C cleanup) ────────────────
//
// The non-raw path builds `tail -n 0 -f | grep -F (×N) | jq`.  All three
// filter flags are set so every grep pre-filter is exercised.  Since grep
// block-buffers its stdout when writing to a pipe, the test appends enough
// matching data to push a full buffer through each stage, then signals the
// process group with SIGINT so zlog exits normally.

#[test]
fn test_tail_jq_pipeline_streams_filtered_lines() {
    let fix = TestFixture::new();

    let mut cmd = fix.zlog();
    cmd.args([
        "tail",
        "ses-001",
        "--hook",
        "new-event",
        "--level",
        "info",
        "--event",
        "test",
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.process_group(0);

    let mut child = cmd.spawn().expect("spawn zlog tail (jq pipeline)");
    let pgid = child.id() as i32;
    let mut guard = ProcessGroupGuard::new(pgid);

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

    // Let tail -f start and register inotify before appending.
    std::thread::sleep(Duration::from_millis(100));

    // The appended line must contain the same compact substrings the grep
    // pre-filters match on.
    let mut payload = String::new();
    for i in 0..4000 {
        payload.push_str(&format!(
            r#"{{"hook":"new-event","level":"info","event":"test","n":{i}}}"#
        ));
        payload.push('\n');
    }
    let log_path = fix.env.zoo_log_dir().join("opencode-ses-001.log");
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&log_path)
        .expect("open log for append");
    use std::io::Write;
    f.write_all(payload.as_bytes()).expect("append matching lines");
    drop(f);

    let start = Instant::now();
    let timeout = Duration::from_secs(10);
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
            Err(mpsc::RecvTimeoutError::Disconnected) => break false,
        }
    };

    // SIGINT the group so zlog runs its cleanup and exits normally.
    interrupt_process_group(pgid);
    let status = wait_with_timeout(&mut child, Duration::from_secs(5));
    if status.is_none() {
        kill_process_group(pgid);
        let _ = child.wait();
    }
    guard.disarm();

    assert!(found, "tail jq pipeline should stream the appended lines");
    assert!(
        status.is_some_and(|s| s.success()),
        "zlog tail should exit cleanly after SIGINT, got {status:?}"
    );
}
