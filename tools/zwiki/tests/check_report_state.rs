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
fn page(title: &str, validated: &str, timeliness: &str, body: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntags: []\nstatus: draft\n\
         last_validated: {validated}\ntimeliness: {timeliness}\n---\n\n\
         # {title}\n\n{body}\n"
    )
}

#[test]
fn test_check_reports_the_stored_pages() {
    let root = temp_dir("check_report_state");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();

    // `archived` is not a valid timeliness value.  The page is fresh, so the
    // sync stores `current` before the report runs.
    let today = chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string();
    std::fs::write(
        root.join("target.md"),
        page("Target", &today, "archived", "Target body."),
    )
    .unwrap();
    std::fs::write(
        root.join("linker.md"),
        page("Linker", &today, "current", "See [Target](target.md)."),
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
        !first.to_string().contains("invalid_timeliness"),
        "the sync replaced the invalid value before the report: {first}"
    );
    let stored = std::fs::read_to_string(root.join("target.md")).unwrap();
    assert!(
        stored.contains("timeliness: current"),
        "the stored page carries the computed timeliness: {stored}"
    );
}
