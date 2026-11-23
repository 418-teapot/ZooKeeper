//! Integration test: `zwiki check` never rewrites `timestamp`.
//!
//! A derived page keeps its stored timestamp across repeated checks, so the
//! source relation stays detectable by `verify`.  Check also leaves no
//! derived staleness field behind; its writes stay the index, the backlinks
//! region and the page layout.

use std::path::Path;
use std::process::Command;

use ztest::temp_dir;

pub mod common;

/// Run `zwiki --root <root> <args>` and return the stdout text.
fn run(root: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .arg("--root")
        .arg(root.to_string_lossy().as_ref())
        .args(args)
        .output()
        .expect("run zwiki");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The timestamp the derived page stores before any check runs.
const DERIVED: &str = "2026-01-01T00:00:00Z";
/// The timestamp of its source, later than the derived one.
const SOURCE: &str = "2026-02-01T00:00:00Z";

#[test]
fn test_repeated_check_keeps_timestamp_and_the_source_relation() {
    let root = temp_dir("check_timestamp");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();

    std::fs::write(
        root.join("source_bar.md"),
        format!(
            "---\ntitle: Bar\ntype: source\ntimestamp: {SOURCE}\n\
             tags: []\n---\n\n# Bar\n\nSource body.\n"
        ),
    )
    .unwrap();

    std::fs::write(
        root.join("analysis_foo.md"),
        format!(
            "---\ntitle: Foo\ntype: analysis\nsources: [source_bar.md]\n\
             tags: []\ntimestamp: {DERIVED}\n---\n\n# Foo\n\n\
             Analysis of [Bar](source_bar.md).\n"
        ),
    )
    .unwrap();

    let derived = root.join("analysis_foo.md");
    let source = root.join("source_bar.md");

    run(&root, &["check"]);
    let first = std::fs::read_to_string(&derived).unwrap();
    assert!(
        first.contains(&format!("timestamp: {DERIVED}")),
        "check must not rewrite the timestamp: {first}"
    );
    assert!(
        !first.contains("timeliness:"),
        "check writes no timeliness field: {first}"
    );

    let verify = run(&root, &["--json", "verify"]);
    assert!(
        verify.contains("\"derived_page\": \"analysis_foo.md\""),
        "verify reports the stale pair: {verify}"
    );

    run(&root, &["check"]);
    let second = std::fs::read_to_string(&derived).unwrap();
    assert!(
        second.contains(&format!("timestamp: {DERIVED}")),
        "repeated check keeps the timestamp: {second}"
    );

    let verify_again = run(&root, &["--json", "verify"]);
    assert!(
        verify_again.contains("\"derived_page\": \"analysis_foo.md\""),
        "the source relation survives repeated checks: {verify_again}"
    );

    let source_text = std::fs::read_to_string(&source).unwrap();
    assert!(
        source_text.contains("## Backlinks"),
        "check still syncs backlinks: {source_text}"
    );
}
