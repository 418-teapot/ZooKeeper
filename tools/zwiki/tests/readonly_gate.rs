//! Integration test: verify that `zwiki --root <tar.gz>` rejects write
//! commands with exit code 1 and a Chinese error message on stderr, and
//! does NOT modify the extracted tar contents.
//!
//! Uses `env!("CARGO_BIN_EXE_zwiki")` which cargo sets for integration
//! tests, guaranteeing a freshly-built binary (no stale-binary flakiness).

use std::path::Path;
use std::process::Command;
use ztest::temp_dir;

pub mod common;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run `zwiki --root <tar>` with `extra_args`; assert exit != 0 and
/// stderr contains Chinese rejection message.
fn assert_write_rejected(
    bin: &Path,
    tar: &Path,
    extra_args: &[&str],
    label: &str,
) {
    let mut cmd = Command::new(bin);
    cmd.arg("--root");
    cmd.arg(tar.to_string_lossy().as_ref());
    for a in extra_args {
        cmd.arg(a);
    }
    let output =
        cmd.output().unwrap_or_else(|e| panic!("{label} should run: {e}"));
    assert!(
        !output.status.success(),
        "{label} on readonly root should succeed (expected failure)"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("不支持"),
        "stderr for {label} should contain Chinese rejection: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_readonly_root_rejects_write_commands() {
    let bin = std::path::PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    assert!(
        bin.exists(),
        "CARGO_BIN_EXE_zwiki does not exist: {}",
        bin.display()
    );

    let tar_path = common::make_bundle_tar("ro_write_gate", "# Doc\n");

    // --- page set ---
    assert_write_rejected(
        &bin,
        &tar_path,
        &["page", "set", "doc.md", "status", "draft"],
        "page set",
    );

    // --- page unset ---
    assert_write_rejected(
        &bin,
        &tar_path,
        &["page", "unset", "doc.md", "status"],
        "page unset",
    );

    // --- page create ---
    assert_write_rejected(
        &bin,
        &tar_path,
        &[
            "page", "create", "--domain", "test", "--type", "concept",
            "--title", "New Page",
        ],
        "page create",
    );

    // --- page move ---
    assert_write_rejected(
        &bin,
        &tar_path,
        &["page", "move", "doc.md", "doc-moved.md"],
        "page move",
    );

    // --- verify tar content was NOT modified ---
    let verify = temp_dir("ro_verify");
    let extract = Command::new("tar")
        .args([
            "-xzf",
            &tar_path.to_string_lossy(),
            "-C",
            &verify.to_string_lossy(),
        ])
        .output()
        .expect("tar extract");
    assert!(extract.status.success(), "tar extract should succeed");
    let doc = std::fs::read_to_string(verify.join("doc.md")).unwrap();
    assert_eq!(doc.trim(), "# Doc", "doc.md should be unchanged");
    assert!(
        !doc.contains("Backlinks"),
        "readonly root should not write backlinks"
    );
}
