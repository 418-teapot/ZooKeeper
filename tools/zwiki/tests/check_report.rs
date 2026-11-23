//! Integration tests: `zwiki check` prints one result-oriented report.
//!
//! The text and the JSON output come from the same model: the pages
//! checked, the changes an automatic write applied, the issues that remain,
//! and the failure that stopped the run.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use ztest::temp_dir;

pub mod common;

/// Body text long enough to stay clear of the stub and sparse thresholds.
const BODY: &str = "This fixture page carries enough body text to describe \
the scenario in one full sentence, so no stub rule applies to it.";

/// Page text with every required field.
fn page(title: &str, body: &str) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    format!(
        "---\ntitle: {title}\ntype: concept\ntags: []\n\
         timestamp: {today}\n---\n\n\
         # {title}\n\n{body}\n"
    )
}

/// Source page text carrying a `timestamp`.
fn source_page(title: &str, timestamp: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: source\ntimestamp: {timestamp}\n\
         tags: []\n\
         ---\n\n# {title}\n\n{BODY}\n"
    )
}

/// Analysis page text validated at `validated` from `sources`.
fn analysis_page(title: &str, validated: &str, sources: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: analysis\nsources: {sources}\n\
         tags: []\ntimestamp: {validated}\n\
         ---\n\n# {title}\n\n{BODY}\n\n\
         See [Bar](bar.md).\n"
    )
}

/// A writable bundle source root named `name`.
fn source_root(name: &str) -> PathBuf {
    let root = temp_dir(name);
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();
    root
}

/// Run `zwiki --root <root> check` and return its output.
fn check(root: &Path, json: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zwiki"));
    command.arg("--root").arg(root.to_string_lossy().as_ref()).arg("check");
    if json {
        command.arg("--json");
    }
    command.output().expect("run zwiki check")
}

/// Run `check --json` and parse the single document it prints.
fn check_json(root: &Path) -> (serde_json::Value, Option<i32>) {
    let output = check(root, true);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report = serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        panic!("check --json prints one JSON document: {e}\n{stdout}")
    });
    (report, output.status.code())
}

/// Run `verify --json` and parse the stale pairs it reports.
fn verify_json(root: &Path) -> Vec<serde_json::Value> {
    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .arg("--root")
        .arg(root)
        .arg("--json")
        .arg("verify")
        .output()
        .expect("run zwiki verify --json");
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        panic!("verify --json prints one JSON document: {e}\n{stdout}")
    })
}

#[test]
fn test_json_report_describes_one_clean_run() {
    let root = source_root("check_report_clean");
    std::fs::write(root.join("concept.md"), page("Concept", BODY)).unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(0), "a clean root passes: {report}");
    assert_eq!(report["schema_version"], 2, "the layout is versioned");
    assert_eq!(report["status"], "ok");
    assert_eq!(report["read_only"], false);
    assert!(report["error"].is_null(), "a completed run has no error");
    assert_eq!(report["summary"]["pages"], 1, "one page was checked");
    assert_eq!(
        report["summary"]["changes"],
        report["changes"].as_array().expect("changes is an array").len(),
        "the change count comes from the array"
    );
    assert_eq!(report["summary"]["issues"], 0);
    assert_eq!(
        report["issues"].as_array().expect("issues is an array").len(),
        0,
        "a clean root has no issue"
    );
    assert!(
        report["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["path"] == "index.md"
                && change["kind"] == "index"),
        "the generated index is a change, and a change never fails the run: \
         {report}"
    );
}

/// The keys of a JSON object, sorted.
fn keys(value: &serde_json::Value) -> Vec<&str> {
    value.as_object().expect("an object").keys().map(String::as_str).collect()
}

#[test]
fn test_json_report_lists_changes_and_remaining_issues() {
    let root = source_root("check_report_changes");
    let linker = page("Linker", &format!("{BODY}\n\nSee [Target](target.md)."));
    std::fs::write(root.join("linker.md"), linker).unwrap();
    std::fs::write(root.join("target.md"), page("Target", BODY)).unwrap();
    // A body below the sparse threshold stays an issue after the writes.
    std::fs::write(root.join("stub.md"), page("Stub", "Short.")).unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "remaining issues fail the run: {report}");
    assert_eq!(report["status"], "issues");
    assert!(
        report.get("health").is_none() && report.get("lint").is_none(),
        "the report is not grouped by checker: {report}"
    );

    let changes = report["changes"].as_array().expect("changes is an array");
    assert!(
        changes
            .iter()
            .any(|c| c["path"] == "target.md" && c["kind"] == "backlinks"),
        "the backlinks write is reported: {report}"
    );
    for change in changes {
        assert_eq!(keys(change), ["kind", "path"], "a change carries no extra");
        assert!(
            matches!(
                change["kind"].as_str(),
                Some("format" | "index" | "backlinks")
            ),
            "the kind is one of the three updates: {change}"
        );
    }
    assert_eq!(report["summary"]["changes"], changes.len());

    let issues = report["issues"].as_array().expect("issues is an array");
    assert_eq!(report["summary"]["issues"], issues.len());
    assert!(
        issues
            .iter()
            .any(|i| i["rule"] == "sparse_page" && i["path"] == "stub.md"),
        "the remaining sparse page is an issue: {report}"
    );
    for issue in issues {
        assert_eq!(
            keys(issue),
            ["details", "message", "path", "rule"],
            "one issue carries the rule, the page, the message and the details"
        );
        assert!(
            issue["details"].is_object(),
            "details is a structured object: {issue}"
        );
        assert!(
            issue["message"].as_str().is_some_and(|m| !m.is_empty()),
            "every issue carries a message: {issue}"
        );
    }
}

#[test]
fn test_json_report_omits_an_issue_the_run_repaired() {
    let root = source_root("check_report_repaired");
    let today = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    // Flow-style tags are not the stored layout; the automatic write
    // normalizes the page before the checks run.
    std::fs::write(
        root.join("target.md"),
        format!(
            "---\ntitle: Target\ntype: concept\ntags: [a]\n\
             timestamp: {today}\n---\n\n\
             # Target\n\n{BODY}\n"
        ),
    )
    .unwrap();
    let linker = page("Linker", &format!("{BODY}\n\nSee [Target](target.md)."));
    std::fs::write(root.join("linker.md"), linker).unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(0), "the repair leaves no issue: {report}");
    assert_eq!(report["status"], "ok");
    assert_eq!(report["summary"]["issues"], 0, "no issue remains: {report}");
    assert!(
        report["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "target.md" && c["kind"] == "format"),
        "the applied layout normalization is a change: {report}"
    );
    let stored = std::fs::read_to_string(root.join("target.md")).unwrap();
    assert!(
        stored.contains("tags:\n  - a\n"),
        "the stored page carries the normalized list: {stored}"
    );
}

#[test]
fn test_json_report_marks_a_read_only_root() {
    // A root without a manifest accepts no write, so the report lists the
    // updates a write would apply instead of applying them.
    let root = temp_dir("check_report_read_only");
    std::fs::write(root.join("index.md"), "# Index\n").unwrap();
    std::fs::create_dir_all(root.join("core")).unwrap();
    common::write_bundle_manifest(&root.join("core"));
    std::fs::write(root.join("core/concept.md"), page("Concept", BODY))
        .unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(report["read_only"], true, "the root accepts no write");
    assert_eq!(code, Some(1), "an unapplied change fails the run: {report}");
    assert!(
        report["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["path"] == "index.md"
                && change["kind"] == "index"),
        "the index a write would generate stays unapplied: {report}"
    );
}

#[test]
fn test_source_newer_issue_carries_source_and_both_times() {
    let root = source_root("check_report_source_newer");
    // The source changed later on the same day, so only the full
    // timestamp of both pages tells them apart.
    std::fs::write(
        root.join("bar.md"),
        source_page("Bar", "2026-11-20T10:00:00Z"),
    )
    .unwrap();
    std::fs::write(
        root.join("foo.md"),
        analysis_page("Foo", "2026-11-20T09:00:00Z", "[bar.md]"),
    )
    .unwrap();

    let (report, _code) = check_json(&root);

    let issues = report["issues"].as_array().expect("issues is an array");
    let source_newer: Vec<&serde_json::Value> =
        issues.iter().filter(|issue| issue["rule"] == "source_newer").collect();
    assert_eq!(
        source_newer.len(),
        1,
        "one issue per outdated source relation: {report}"
    );
    let issue = source_newer[0];
    assert_eq!(issue["path"], "foo.md");
    assert_eq!(issue["details"]["source"], "bar.md");
    assert_eq!(
        issue["details"]["source_timestamp"], "2026-11-20T10:00:00Z",
        "the report keeps the stored timestamp"
    );
    assert_eq!(issue["details"]["derived_timestamp"], "2026-11-20T09:00:00Z");
}

#[test]
fn test_one_source_spelling_reports_one_source_newer() {
    let root = source_root("check_report_source_spelling");
    std::fs::write(
        root.join("bar.md"),
        source_page("Bar", "2026-11-20T10:00:00Z"),
    )
    .unwrap();
    // Every entry names the same source page: bare, markdown link, and
    // explicit bundle.
    std::fs::write(
        root.join("foo.md"),
        analysis_page(
            "Foo",
            "2026-11-20T09:00:00Z",
            "['[Bar](bar.md)', '[Bar](@test-wiki/bar.md)', bar.md]",
        ),
    )
    .unwrap();

    let (report, _code) = check_json(&root);
    let source_newer: Vec<&serde_json::Value> = report["issues"]
        .as_array()
        .expect("issues is an array")
        .iter()
        .filter(|issue| issue["rule"] == "source_newer")
        .collect();
    assert_eq!(
        source_newer.len(),
        1,
        "one issue per derived page and source: {report}"
    );
    assert_eq!(source_newer[0]["details"]["source"], "bar.md");

    let pairs = verify_json(&root);
    assert_eq!(pairs.len(), 1, "verify pairs the source once: {pairs:?}");
    assert_eq!(pairs[0]["source_page"], "bar.md");
}

#[test]
fn test_text_report_shows_counts_changes_issues_and_result() {
    let root = source_root("check_report_text");
    std::fs::write(
        root.join("bar.md"),
        source_page("Bar", "2026-11-20T10:00:00Z"),
    )
    .unwrap();
    std::fs::write(
        root.join("foo.md"),
        analysis_page("Foo", "2026-11-20T09:00:00Z", "[bar.md]"),
    )
    .unwrap();

    let output = check(&root, false);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert_eq!(output.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("已检查 2 页"), "{stdout}");
    assert!(stdout.contains("变更（"), "the applied writes are listed");
    assert!(stdout.contains("`bar.md`"), "the changed page is named");
    assert!(stdout.contains("问题（"), "the remaining issues are listed");
    assert!(stdout.contains("结果：存在问题"), "{stdout}");
    assert!(
        stdout.contains("`bar.md`") && stdout.contains("2026-11-20T10:00:00Z"),
        "the source issue names the source and its time: {stdout}"
    );
    assert!(
        stdout.contains("本页确认时间 2026-11-20T09:00:00Z"),
        "the source issue names the page timestamp: {stdout}"
    );
}

#[test]
fn test_text_report_shows_a_settled_run() {
    let root = source_root("check_report_text_settled");
    std::fs::write(root.join("concept.md"), page("Concept", BODY)).unwrap();
    check(&root, false);

    let output = check(&root, false);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert_eq!(output.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("已检查 1 页"), "{stdout}");
    assert!(
        !stdout.contains("变更（"),
        "a settled root applies no change: {stdout}"
    );
    assert!(
        !stdout.contains("问题（"),
        "a settled root has no issue: {stdout}"
    );
    assert!(stdout.contains("结果：通过"), "{stdout}");
}

#[test]
fn test_report_marks_a_failed_run() {
    let root = source_root("check_report_failure");
    let linker = page("Linker", &format!("{BODY}\n\nSee [Target](target.md)."));
    std::fs::write(root.join("linker.md"), linker).unwrap();
    std::fs::write(root.join("target.md"), page("Target", BODY)).unwrap();
    // The atomic writer stores through a `target.md.tmp` sibling; a
    // directory at that path rejects the backlinks write.
    std::fs::create_dir(root.join("target.md.tmp")).unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "a failed run fails the exit code: {report}");
    assert_eq!(report["status"], "error");
    assert!(
        report["error"]
            .as_str()
            .is_some_and(|error| error.contains("target.md")),
        "the error names the page it could not write: {report}"
    );

    let output = check(&root, false);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("错误："), "the text shows the error: {stdout}");
    assert!(stdout.contains("结果：执行失败"), "{stdout}");
}
