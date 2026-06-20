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
}

#[test]
fn test_all_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--all"])
        .output()
        .expect("failed to run zfind --db <no-db> --all");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --all with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found"),
        "stderr should mention 'no sessions found', got: {stderr}"
    );
}

#[test]
fn test_session_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--session", "nonexistent-session-xyz"])
        .output()
        .expect("failed to run zfind --session <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --session with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found"),
        "stderr should mention 'no messages found', got: {stderr}"
    );
}

#[test]
fn test_message_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--message", "invalid-msg-id"])
        .output()
        .expect("failed to run zfind --message <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --message with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found"),
        "stderr should mention 'no messages found', got: {stderr}"
    );
}

#[test]
fn test_json_all_with_nonexistent_db_exits_2() {
    // With no DB, --all exits 2 before producing any output.
    // If there were output (e.g. on a system with a real DB), it
    // should be valid JSON — we guard with the empty check.
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--json", "--all"])
        .output()
        .expect("failed to run zfind --json --all");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --json --all with nonexistent DB should exit 2, got {:?}",
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
fn test_no_args_exits_1() {
    let output = Command::new(ZFIND_BIN)
        .output()
        .expect("failed to run zfind with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zfind with no args should exit 1"
    );
}
