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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

/// Build a tar.gz at `tar_path` containing only the given `entries`.
/// Each entry is a `(archive_name, bytes)` pair.
fn write_tar(tar_path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(tar_path).unwrap();
    let gz =
        flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(gz);
    for (name, data) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(data.len() as u64);
        archive.append_data(&mut header, name, *data).unwrap();
    }
    let gz = archive.into_inner().unwrap();
    gz.finish().unwrap();
}

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
    write_tar(
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
    write_tar(
        &tar,
        &[
            (
                "bundle.toml",
                b"[package]\nname = \"\"\nversion = \"0.1\"\nkind = \"unknown\"\n",
            ),
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
    write_tar(
        &tar,
        &[(
            "bundle.toml",
            br#"[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#,
        )],
    );

    assert_check_fails(&bin, &tar, "index.md");
}
