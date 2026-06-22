//! Integration tests for the `zfind` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  A nonexistent `--db`
//! path is used to avoid real database dependencies.

use std::process::Command;

/// Path to the `zfind` binary, set by `cargo test`.
const ZFIND_BIN: &str = env!("CARGO_BIN_EXE_zfind");

/// A DB path that is guaranteed not to exist.
const NO_DB: &str = "/tmp/zfind-test-nonexistent.db";

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZFIND_BIN)
        .arg("--help")
        .output()
        .expect("failed to run zfind --help");
    assert!(
        output.status.success(),
        "zfind --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
    assert!(stdout.contains("search"), "help should show 'search' subcommand");
    assert!(stdout.contains("list"), "help should show 'list' subcommand");
    assert!(stdout.contains("show"), "help should show 'show' subcommand");
    assert!(
        stdout.contains("message"),
        "help should show 'message' subcommand"
    );
}

#[test]
fn test_list_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "list"])
        .output()
        .expect("failed to run zfind --db <no-db> list");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind list with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found"),
        "stderr should mention 'no sessions found', got: {stderr}"
    );
}

#[test]
fn test_show_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "show", "nonexistent-session-xyz"])
        .output()
        .expect("failed to run zfind show <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind show with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_message_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "message", "invalid-msg-id"])
        .output()
        .expect("failed to run zfind message <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind message with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found"),
        "stderr should mention 'no messages found', got: {stderr}"
    );
}

#[test]
fn test_json_list_with_nonexistent_db_exits_2() {
    // With no DB, list exits 2 before producing any output.
    // If there were output (e.g. on a system with a real DB), it
    // should be valid JSON — we guard with the empty check.
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--json", "list"])
        .output()
        .expect("failed to run zfind --json list");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --json list with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        let parsed: Result<serde_json::Value, _> =
            serde_json::from_str(stdout.trim());
        assert!(parsed.is_ok(), "JSON output should be valid, got: {stdout}");
    }
}

#[test]
fn test_list_help_shows_all_flag() {
    let output = Command::new(ZFIND_BIN)
        .args(["list", "--help"])
        .output()
        .expect("failed to run zfind list --help");
    assert!(
        output.status.success(),
        "zfind list --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("-a, --all"),
        "list --help should show '-a, --all' flag, got: {stdout}"
    );
}

#[test]
fn test_list_all_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "list", "--all"])
        .output()
        .expect("failed to run zfind --db <no-db> list --all");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind list --all with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found"),
        "stderr should mention 'no sessions found', got: {stderr}"
    );
}

#[test]
fn test_no_args_exits_1() {
    // No subcommand given → print help and exit 1
    // (consistent with zlog, zinspect, ztrace)
    let output = Command::new(ZFIND_BIN)
        .output()
        .expect("failed to run zfind with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zfind with no args should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.is_empty(),
        "stderr should be empty (help goes to stdout), got: {stderr}"
    );
}

#[test]
fn test_search_help_shows_search_specific_flags() {
    let output = Command::new(ZFIND_BIN)
        .args(["search", "--help"])
        .output()
        .expect("failed to run zfind search --help");
    assert!(
        output.status.success(),
        "zfind search --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--exact"),
        "search --help should show --exact flag"
    );
    assert!(
        stdout.contains("--session-list-limit"),
        "search --help should show --session-list-limit flag"
    );
}

#[test]
fn test_show_help_shows_show_specific_usage() {
    let output = Command::new(ZFIND_BIN)
        .args(["show", "--help"])
        .output()
        .expect("failed to run zfind show --help");
    assert!(
        output.status.success(),
        "zfind show --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SESSION_ID"),
        "show --help should mention SESSION_ID positional arg"
    );
}

#[test]
fn test_message_help_shows_message_specific_flags() {
    let output = Command::new(ZFIND_BIN)
        .args(["message", "--help"])
        .output()
        .expect("failed to run zfind message --help");
    assert!(
        output.status.success(),
        "zfind message --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--session"),
        "message --help should show --session flag"
    );
    assert!(
        stdout.contains("--scan"),
        "message --help should show --scan flag"
    );
}
