//! Integration test: verify that `zwiki --root <tar.gz> check` fails
//! with exit code 1 and appropriate error messages when the tar.gz
//! is malformed or missing required files.
//!
//! Three error paths:
//! (a) bundle.toml is missing from the tar
//! (b) bundle.toml has invalid content
//! (c) bundle.toml exists but index.md is missing (structure check)

use std::path::{Path, PathBuf};
use std::process::Command;
use ztest::temp_dir;

pub mod common;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run `zwiki --root <tar> check` and assert exit != 0 and stderr or
/// stdout contains `needle`.
fn assert_check_fails(bin: &Path, tar: &Path, needle: &str) {
    let output = Command::new(bin)
        .args(["--root", &tar.to_string_lossy(), "check"])
        .output()
        .expect("zwiki check should run");
    assert!(!output.status.success(), "check on bad tar.gz should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stderr.contains(needle) || stdout.contains(needle),
        "expected needle {needle:?} not in stderr ({stderr}) or stdout ({stdout})"
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_check_missing_bundle_toml() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("check_missing_btoml");

    // Create a tar.gz that has index.md but NO bundle.toml.
    let tar = tmp.join("bundle.tar.gz");
    common::write_tar(
        &tar,
        &[("index.md", b"---\ntitle: X\n---\n# X\n"), ("doc.md", b"# Doc\n")],
    );

    assert_check_fails(&bin, &tar, "bundle.toml");
}

#[test]
fn test_check_invalid_manifest() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("check_invalid_manifest");

    // Create a tar.gz with a bundle.toml that has invalid content.
    let tar = tmp.join("bundle.tar.gz");
    common::write_tar(
        &tar,
        &[
            ("bundle.toml", b"[package]\nname = \"\"\nversion = \"0.1\"\n"),
            ("index.md", b"---\ntitle: X\n---\n# X\n"),
            ("doc.md", b"# Doc\n"),
        ],
    );

    assert_check_fails(&bin, &tar, "bundle.toml");
}

#[test]
fn test_check_missing_index_md() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("check_missing_index");

    // Create a tar.gz with bundle.toml but NO index.md.
    let tar = tmp.join("bundle.tar.gz");
    common::write_tar(
        &tar,
        &[(
            "bundle.toml",
            br#"[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"

[export]
include = ["*.md"]
"#,
        )],
    );

    assert_check_fails(&bin, &tar, "index.md");
}
