//! Integration test: `zwiki check` reports the pages it just wrote.
//!
//! The automatic writes settle within one run, so two consecutive runs
//! report the same result.  A repair a run performed never appears as an
//! issue of that same run.

use std::path::Path;
use std::process::Command;

use ztest::temp_dir;

pub mod common;

/// Run `zwiki --root <root> check --json` and return its report.
fn check(root: &Path) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .arg("--root")
        .arg(root.to_string_lossy().as_ref())
        .args(["check", "--json"])
        .output()
        .expect("run zwiki check");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Page text with every required field.
fn page(title: &str, timestamp: &str, tags: &str, body: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntags: {tags}\n\
         timestamp: {timestamp}\n---\n\n\
         # {title}\n\n{body}\n"
    )
}

#[test]
fn test_check_reports_the_stored_pages() {
    let root = temp_dir("check_report_state");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();

    // Flow-style tags are not the stored layout, so the run normalizes the
    // page before the report runs.
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    std::fs::write(
        root.join("target.md"),
        page("Target", &now, "[a]", "Target body."),
    )
    .unwrap();
    std::fs::write(
        root.join("linker.md"),
        page("Linker", &now, "[]", "See [Target](target.md)."),
    )
    .unwrap();

    let first = check(&root);
    let second = check(&root);
    let first: serde_json::Value = serde_json::from_str(&first).unwrap();
    let second: serde_json::Value = serde_json::from_str(&second).unwrap();

    assert_eq!(
        first["issues"], second["issues"],
        "check must report the state it stored, not the state it read"
    );
    assert_eq!(
        second["changes"],
        serde_json::json!([]),
        "the automatic writes settle within one run"
    );
    assert!(
        first["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "target.md" && c["kind"] == "format"),
        "the layout normalization is a change of the same run: {first}"
    );
    let stored = std::fs::read_to_string(root.join("target.md")).unwrap();
    assert!(
        stored.contains("tags:\n  - a\n"),
        "the stored page carries the normalized list: {stored}"
    );
    assert!(
        stored.contains(&format!("timestamp: {now}")),
        "the run never rewrites the timestamp: {stored}"
    );
}
