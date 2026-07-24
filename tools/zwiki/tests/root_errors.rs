//! Integration test: verify that `--json` mode produces JSON error output
//! for invalid --root, and that bundle subcommands on Temp root are rejected
//! with a friendly Chinese message.

use std::path::PathBuf;
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

fn make_bundle_tar() -> PathBuf {
    let dir = temp_dir("root_err_bundle");
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
    std::fs::write(dir.join("index.md"), "---\ntitle: X\n---\n# X\n").unwrap();
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();
    std::fs::write(dir.join("doc.md"), "# Doc\n").unwrap();

    let tar = dir.join("bundle.tar.gz");
    let file = std::fs::File::create(&tar).unwrap();
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
    tar
}

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
    let tar = make_bundle_tar();

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
    let tar = make_bundle_tar();

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
