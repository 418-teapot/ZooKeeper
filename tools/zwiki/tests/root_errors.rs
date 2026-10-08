//! Integration test: verify that `--json` mode produces JSON error output
//! for invalid --root, and that bundle subcommands on Temp root are rejected
//! with a friendly Chinese message.

use std::path::PathBuf;
use std::process::Command;

pub mod common;

#[test]
fn test_json_mode_invalid_root_outputs_json_error() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));

    // --json with a non-existent path should produce JSON on stdout.
    let output = Command::new(&bin)
        .args([
            "--json",
            "--root",
            "/zwiki-inttest-nonexistent-path-xyzzy",
            "check",
        ])
        .output()
        .expect("zwiki should run");
    assert!(!output.status.success(), "invalid root should fail");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // In json mode the error should be a JSON object on stdout.
    assert!(
        stdout.contains("\"status\""),
        "json mode should produce JSON on stdout, got: {stdout}"
    );
    assert!(
        stdout.contains("\"error\""),
        "json error should contain 'error' field, got: {stdout}"
    );
    // No raw Chinese text on stderr.
    assert!(
        stderr.is_empty(),
        "json mode should not write error text to stderr: {stderr}"
    );
}

#[test]
fn test_bundle_subcommand_on_temp_root_rejected() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tar = common::make_bundle_tar("root_err_list_bundle", "# Doc\n");

    // bundle list on tar root should be rejected.
    let output = Command::new(&bin)
        .args(["--root", &tar.to_string_lossy(), "bundle", "list"])
        .output()
        .expect("zwiki bundle list should run");
    assert!(!output.status.success(), "bundle list on temp root should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bundle"),
        "stderr should mention 'bundle', got: {stderr}"
    );
    assert!(
        stderr.contains("--root"),
        "stderr should guide user to --root, got: {stderr}"
    );
}

#[test]
fn test_bundle_check_on_temp_root_rejected() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tar = common::make_bundle_tar("root_err_check_bundle", "# Doc\n");

    // bundle check on tar root should also be rejected.
    let output = Command::new(&bin)
        .args(["--root", &tar.to_string_lossy(), "bundle", "check"])
        .output()
        .expect("zwiki bundle check should run");
    assert!(!output.status.success(), "bundle check on temp root should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bundle"),
        "stderr should mention 'bundle', got: {stderr}"
    );
}
