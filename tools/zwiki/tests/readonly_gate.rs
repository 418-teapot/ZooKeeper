//! Integration test: verify that `zwiki --root <tar.gz>` rejects write
//! commands with exit code 1 and a Chinese error message on stderr, and
//! does NOT modify the extracted tar contents.
//!
//! Uses `env!("CARGO_BIN_EXE_zwiki")` which cargo sets for integration
//! tests, guaranteeing a freshly-built binary (no stale-binary flakiness).

use std::path::{Path, PathBuf};
use std::process::Command;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

/// Create a minimal bundle tar.gz at `dir/test-bundle.tar.gz`.
fn make_test_bundle_tar(dir: &Path) -> PathBuf {
    std::fs::write(
        dir.join("bundle.toml"),
        r#"[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#,
    )
    .unwrap();
    std::fs::write(dir.join("index.md"), "---\ntitle: Index\n---\n# Index\n")
        .unwrap();
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();
    std::fs::write(dir.join("doc.md"), "# Doc\n").unwrap();

    let tar_path = dir.join("test-bundle.tar.gz");
    let file = std::fs::File::create(&tar_path).unwrap();
    let gz =
        flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(gz);
    archive
        .append_path_with_name(dir.join("bundle.toml"), "bundle.toml")
        .unwrap();
    archive.append_path_with_name(dir.join("index.md"), "index.md").unwrap();
    archive.append_path_with_name(dir.join("doc.md"), "doc.md").unwrap();
    archive.append_dir("logs", dir.join("logs")).unwrap();
    let gz = archive.into_inner().unwrap();
    gz.finish().unwrap();
    tar_path
}

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

    let tmp = temp_dir("ro_write_gate");
    let tar_path = make_test_bundle_tar(&tmp);

    // --- log ---
    assert_write_rejected(
        &bin,
        &tar_path,
        &["log", "--op", "test", "--path", "doc.md", "--action", "create"],
        "log",
    );

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
