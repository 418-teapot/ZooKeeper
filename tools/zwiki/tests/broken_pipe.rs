//! Integration test: commands that print large output must exit cleanly when
//! the reader closes the pipe early (EPIPE) instead of panicking.

use std::process::{Command, Stdio};
use ztest::temp_dir;

pub mod common;

/// Run `zwiki` with `args`, close the stdout read end immediately, and assert
/// the process exits cleanly without a panic on stderr.
fn assert_clean_broken_pipe(args: &[&str]) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn zwiki");

    // Drop the read end so the child's stdout writes fail with EPIPE.
    drop(child.stdout.take());

    let output = child.wait_with_output().expect("wait for zwiki");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("panicked") && !stderr.contains("Broken pipe"),
        "stderr must be clean for {args:?}, got: {stderr}"
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "expected exit 0 for {args:?}, got {:?} (stderr: {stderr})",
        output.status
    );
}

#[test]
fn schema_exits_cleanly_on_broken_pipe() {
    assert_clean_broken_pipe(&["schema"]);
}

#[test]
fn template_exits_cleanly_on_broken_pipe() {
    assert_clean_broken_pipe(&["template", "concept"]);
}

#[test]
fn check_exits_cleanly_on_broken_pipe() {
    let root = temp_dir("check");
    common::write_bundle_manifest(&root);
    assert_clean_broken_pipe(&[
        "--root",
        root.to_string_lossy().as_ref(),
        "check",
    ]);
}

#[test]
fn page_show_exits_cleanly_on_broken_pipe() {
    let root = temp_dir("page_show");
    common::write_bundle_manifest(&root);
    let concepts = root.join("concepts");
    std::fs::create_dir_all(&concepts).unwrap();
    std::fs::write(
        concepts.join("foo.md"),
        "---\ntitle: Foo\ntype: concept\n---\n\n# Foo\n",
    )
    .unwrap();
    assert_clean_broken_pipe(&[
        "--root",
        root.to_string_lossy().as_ref(),
        "page",
        "show",
        "concepts/foo.md",
        "--backlinks",
    ]);
}
