//! Integration tests for the `zlog` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Invalid session IDs
//! are used to avoid real log-file dependencies.
//!
//! NOTE: `zlog` checks that `~/.zoo/log` exists before parsing
//! subcommand arguments, so `--help` tests require that directory
//! to be present on the test system.

use std::process::Command;

/// Path to the `zlog` binary, set by `cargo test`.
const ZLOG_BIN: &str = env!("CARGO_BIN_EXE_zlog");

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZLOG_BIN)
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
    let output = Command::new(ZLOG_BIN)
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
    let output = Command::new(ZLOG_BIN)
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
