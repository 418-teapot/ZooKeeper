//! Integration tests: `zwiki check` reports derived-metadata failures instead
//! of leaving a partial sync that looks successful, and a page the document
//! model rejects is reported by path instead of disappearing.  The JSON
//! report keeps its shape, the failure goes to stderr, and the exit code is
//! non-zero.

use std::process::Command;
use ztest::temp_dir;

pub mod common;

fn page(title: &str, body: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntimestamp: 2026-01-01T00:00:00Z\n\
         tags: []\nstatus: draft\nlast_validated: 2026-01-01T00:00:00Z\n\
         timeliness: current\n---\n\n# {title}\n\n{body}\n"
    )
}

#[test]
fn test_check_reports_page_the_model_rejects() {
    let root = temp_dir("check_sync_parse_error");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs").join(".gitkeep"), "").unwrap();
    std::fs::write(root.join("valid.md"), page("Valid", "Some body text."))
        .unwrap();
    // No frontmatter: the document model rejects this page.
    std::fs::write(root.join("broken.md"), "# Broken page\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", root.to_string_lossy().as_ref(), "check", "--json"])
        .output()
        .expect("run zwiki check --json");

    assert!(
        !output.status.success(),
        "check must fail when the derived-metadata sync fails"
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout keeps the JSON contract");
    assert_eq!(report["status"], "error");
    assert_eq!(report["derived_metadata_sync"], "failed");
    assert_eq!(
        report["health"]["total_pages"], 2,
        "the rejected page keeps its place in the page count: {stdout}"
    );

    let frontmatter = report["health"]["frontmatter"]
        .as_array()
        .expect("frontmatter issues stay in the payload");
    let invalid: Vec<&serde_json::Value> = frontmatter
        .iter()
        .filter(|issue| issue["category"] == "invalid_document")
        .collect();
    assert_eq!(invalid.len(), 1, "one explicit invalid_document issue");
    assert_eq!(invalid[0]["page"], "broken.md");
    assert!(
        invalid[0]["details"].as_str().is_some_and(|d| !d.is_empty()),
        "the issue carries the load error: {stdout}"
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("broken.md"),
        "the failure must name the page: {stderr}"
    );
}

#[test]
fn test_list_names_invalid_page() {
    let root = temp_dir("list_invalid_page");
    std::fs::write(root.join("valid.md"), page("Valid", "Some body text."))
        .unwrap();
    std::fs::write(root.join("broken.md"), "# Broken page\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", root.to_string_lossy().as_ref(), "list"])
        .output()
        .expect("run zwiki list");

    assert!(
        !output.status.success(),
        "a query command must fail on an invalid page"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("broken.md"),
        "the failure must name the page: {stderr}"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.trim().is_empty(),
        "a failed listing prints no entries: {stdout}"
    );
}

#[test]
fn test_check_reports_write_failure() {
    let root = temp_dir("check_sync_write_error");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs").join(".gitkeep"), "").unwrap();
    std::fs::write(
        root.join("linker.md"),
        page("Linker", "See [Target](target.md)."),
    )
    .unwrap();
    std::fs::write(root.join("target.md"), page("Target", "Some body text."))
        .unwrap();
    // The atomic writer stores through a `target.md.tmp` sibling; a
    // directory at that path rejects the write of the backlinks region.
    std::fs::create_dir(root.join("target.md.tmp")).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", root.to_string_lossy().as_ref(), "check", "--json"])
        .output()
        .expect("run zwiki check --json");

    assert!(!output.status.success(), "a rejected write must fail check");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("target.md"),
        "the failure must name the page: {stderr}"
    );
}
