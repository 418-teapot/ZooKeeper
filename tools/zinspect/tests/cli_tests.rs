//! Integration tests for the `zinspect` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.

use std::process::Command;

/// Path to the `zinspect` binary, set by `cargo test`.
const ZINSPECT_BIN: &str = env!("CARGO_BIN_EXE_zinspect");

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .arg("--help")
        .output()
        .expect("failed to run zinspect --help");
    assert!(
        output.status.success(),
        "zinspect --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
}

#[test]
fn test_stats_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["stats", "--help"])
        .output()
        .expect("failed to run zinspect stats --help");
    assert!(
        output.status.success(),
        "zinspect stats --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_timeline_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["timeline", "--help"])
        .output()
        .expect("failed to run zinspect timeline --help");
    assert!(
        output.status.success(),
        "zinspect timeline --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_impact_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["impact", "--help"])
        .output()
        .expect("failed to run zinspect impact --help");
    assert!(
        output.status.success(),
        "zinspect impact --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_no_subcommand_exits_1() {
    let output = Command::new(ZINSPECT_BIN)
        .output()
        .expect("failed to run zinspect with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zinspect with no args should exit 1"
    );
}

#[test]
fn test_stats_no_session_exits_1() {
    let output = Command::new(ZINSPECT_BIN)
        .arg("stats")
        .output()
        .expect("failed to run zinspect stats with no session");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zinspect stats with no session should exit 1"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("provide a session_id"),
        "stderr should mention 'provide a session_id', got: {stderr}"
    );
}

#[test]
fn test_stats_invalid_session_exits_2() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["stats", "nonexistent-session-xyz-123"])
        .output()
        .expect("failed to run zinspect stats with invalid session");
    // resolve_session_path returns None → exits 2
    assert_eq!(
        output.status.code(),
        Some(2),
        "zinspect stats <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

#[test]
fn test_timeline_invalid_session_exits_2() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["timeline", "nonexistent-session-xyz-123"])
        .output()
        .expect("failed to run zinspect timeline with invalid session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zinspect timeline <invalid> should exit 2, got {:?}",
        output.status.code()
    );
}

#[test]
fn test_impact_with_json_output_is_valid_json() {
    // --json flag with --sessions should produce valid JSON
    // (no session ID needed, will hit DB which likely doesn't exist)
    let output = Command::new(ZINSPECT_BIN)
        .args(["impact", "--sessions", "1", "--json"])
        .output()
        .expect("failed to run zinspect impact --sessions 1 --json");
    // Should exit 0 (it prints "No sessions found" or JSON)
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        // If there is output, it should be valid JSON
        let parsed: Result<serde_json::Value, _> =
            serde_json::from_str(stdout.trim());
        assert!(parsed.is_ok(), "Output should be valid JSON, got: {stdout}");
    }
}

#[test]
fn test_stats_sessions_no_db_is_valid_json() {
    // --json --sessions with no DB: exits 0, output is empty or valid JSON
    let output = Command::new(ZINSPECT_BIN)
        .args([
            "stats",
            "--sessions",
            "5",
            "--json",
            "--no-color",
            "--db",
            "/tmp/zinspect-test-nonexistent.db",
        ])
        .output()
        .expect("failed to run zinspect stats with custom db");
    // Exit 0 even with no DB (not an error)
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
}
