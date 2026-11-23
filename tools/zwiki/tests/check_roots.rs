//! Integration tests: `zwiki check` reports every root form the same way.
//!
//! A writable bundle source applies the automatic writes and reports them as
//! changes.  A read-only root (an installed store, a bare directory, or a
//! temporary archive extraction) applies nothing: it reports the same
//! normalization as unapplied changes, judges the remaining issues on the
//! state a write would store, and fails while a change stays unapplied.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use ztest::temp_dir;

pub mod common;

/// Body text long enough to stay clear of the stub and sparse thresholds.
const BODY: &str = "This fixture page carries enough body text to describe \
the scenario in one full sentence, so no stub rule applies to it.";

/// Page text with every required field.
fn page(title: &str, body: &str) -> String {
    page_with(title, "current", body)
}

/// Page text with every required field and an explicit `timeliness`.
fn page_with(title: &str, timeliness: &str, body: &str) -> String {
    let today = chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string();
    format!(
        "---\ntitle: {title}\ntype: concept\ntags: []\nstatus: draft\n\
         last_validated: {today}\ntimeliness: {timeliness}\n---\n\n\
         # {title}\n\n{body}\n"
    )
}

/// Source page text carrying a `timestamp`.
fn source_page(title: &str, timestamp: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: source\ntimestamp: {timestamp}\n\
         tags: []\nstatus: draft\nlast_validated: {timestamp}\n\
         timeliness: current\n---\n\n# {title}\n\n{BODY}\n"
    )
}

/// Analysis page text validated at `validated` from `sources`.
fn analysis_page(title: &str, validated: &str, sources: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: analysis\nsources: {sources}\n\
         tags: []\nstatus: draft\nlast_validated: {validated}\n\
         timeliness: current\n---\n\n# {title}\n\n{BODY}\n"
    )
}

/// Write `text` at `rel` below `root`.
fn write_page(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A writable bundle source root named `name`.
fn writable_root(name: &str) -> PathBuf {
    let root = temp_dir(name);
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();
    root
}

/// The lock text of one installed bundle named `name` at `target`.
fn lock_text(name: &str, target: &str) -> String {
    format!(
        "[[bundles]]\nname = \"{name}\"\nversion = \"0.1.0\"\n\
         target = \"{target}\"\nintegrity = \"sha256-abc\"\n\
         installed_at = \"2026-01-01T00:00:00Z\"\n"
    )
}

/// An installed store root named `name` that holds one bundle named `core`.
fn store_root(name: &str) -> PathBuf {
    let root = temp_dir(name);
    write_page(&root, "index.md", "# Index\n\n- [Core](core/index.md)\n");
    write_page(&root, "core/index.md", "# Core\n");
    std::fs::create_dir_all(root.join("core/logs")).unwrap();
    common::write_bundle_manifest(&root.join("core"));
    std::fs::write(root.join("zwiki.lock"), lock_text("core", "core")).unwrap();
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
    assert_eq!(
        stdout.matches("\"schema_version\"").count(),
        1,
        "check --json prints one document: {stdout}"
    );
    let report = serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        panic!("check --json prints one JSON document: {e}\n{stdout}")
    });
    (report, output.status.code())
}

/// The `(path, kind)` pairs of the report changes, sorted.
fn changes(report: &serde_json::Value) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = report["changes"]
        .as_array()
        .expect("changes is an array")
        .iter()
        .map(|change| {
            (
                change["path"].as_str().expect("path").to_string(),
                change["kind"].as_str().expect("kind").to_string(),
            )
        })
        .collect();
    pairs.sort();
    pairs
}

/// The rule names the report lists, sorted.
fn rules(report: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = report["issues"]
        .as_array()
        .expect("issues is an array")
        .iter()
        .map(|issue| issue["rule"].as_str().expect("rule").to_string())
        .collect();
    names.sort();
    names
}

/// Snapshot every file under `dir` as `(relative path, contents)` pairs.
fn snapshot(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut files: Vec<(PathBuf, String)> = walk(dir, dir);
    files.sort();
    files
}

fn walk(root: &Path, dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(root, &path));
        } else {
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            let contents = std::fs::read_to_string(&path).unwrap_or_default();
            out.push((rel, contents));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Read-only roots
// ---------------------------------------------------------------------------

#[test]
fn test_read_only_root_reports_unapplied_changes() {
    // A bare directory accepts no write.  The pages need backlinks and
    // indexes, so the run reports those as unapplied changes and fails even
    // though no issue remains.
    let root = temp_dir("check_roots_readonly_dir");
    write_page(
        &root,
        "concepts/target.md",
        &page(
            "Target",
            &format!("{BODY}\n\nSee [Linker](concepts/linker.md)."),
        ),
    );
    write_page(
        &root,
        "concepts/linker.md",
        &page(
            "Linker",
            &format!("{BODY}\n\nSee [Target](concepts/target.md)."),
        ),
    );
    let before = snapshot(&root);

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "an unapplied change fails the run: {report}");
    assert_eq!(report["status"], "issues");
    assert_eq!(report["read_only"], true);
    assert!(
        report["issues"].as_array().unwrap().is_empty(),
        "a write would repair every finding, so none remains: {report}"
    );
    assert!(
        !rules(&report).contains(&"index_entry_missing".to_string()),
        "the pending index repair is a change, not an issue: {report}"
    );
    let pending = changes(&report);
    assert!(
        pending.contains(&(
            "concepts/target.md".to_string(),
            "backlinks".to_string()
        )),
        "the missing backlinks stay unapplied: {report}"
    );
    assert!(
        pending
            .contains(&("concepts/index.md".to_string(), "index".to_string())),
        "the generated index stays unapplied: {report}"
    );
    assert_eq!(snapshot(&root), before, "a read-only root is never written");

    let output = check(&root, false);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("未应用变更（"), "{stdout}");
    assert!(stdout.contains("`concepts/target.md` — 反向链接"), "{stdout}");
    assert!(stdout.contains("结果：存在问题"), "{stdout}");
}

#[test]
fn test_read_only_root_keeps_an_issue_no_write_repairs() {
    let root = temp_dir("check_roots_readonly_broken");
    write_page(
        &root,
        "concepts/referrer.md",
        &page("Referrer", &format!("{BODY}\n\nSee [Gone](gone.md).")),
    );

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "a remaining issue fails the run: {report}");
    assert_eq!(report["status"], "issues");
    assert!(
        rules(&report).contains(&"broken_link".to_string()),
        "a broken link is no automatic repair: {report}"
    );
    assert!(
        report["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| { issue["path"] == "concepts/referrer.md" }),
        "the issue names the page: {report}"
    );
    assert!(!changes(&report).is_empty(), "the root still needs a write");
}

#[test]
fn test_read_only_store_root_reports_unapplied_changes() {
    // An installed store accepts no write.  Its bundle pages need the same
    // normalization a bundle source would store, so the run lists it as
    // unapplied and judges the remaining issues on that state.
    let root = store_root("check_roots_store");
    write_page(
        &root,
        "core/concepts/target.md",
        &page_with(
            "Target",
            "archived",
            &format!("{BODY}\n\nSee [Linker](concepts/linker.md)."),
        ),
    );
    write_page(
        &root,
        "core/concepts/linker.md",
        &page(
            "Linker",
            &format!("{BODY}\n\nSee [Target](concepts/target.md)."),
        ),
    );
    write_page(
        &root,
        "core/index.md",
        "# Core\n\n- [Target](concepts/target.md)\n- [Linker](concepts/linker.md)\n",
    );
    let before = snapshot(&root);

    let output = check(&root, true);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("one JSON document: {e}\n{stdout}"));

    assert_eq!(output.status.code(), Some(1), "{report}");
    assert_eq!(report["status"], "issues");
    assert_eq!(report["read_only"], true);
    let pending = changes(&report);
    assert!(
        pending.contains(&(
            "core/concepts/target.md".to_string(),
            "timeliness".to_string()
        )),
        "the invalid timeliness repair stays unapplied: {report}"
    );
    assert!(
        pending.contains(&(
            "core/concepts/target.md".to_string(),
            "backlinks".to_string()
        )),
        "the missing backlinks stay unapplied: {report}"
    );
    assert!(
        !rules(&report).contains(&"invalid_timeliness".to_string()),
        "the pending repair is a change, not an issue: {report}"
    );
    assert!(
        !rules(&report).contains(&"index_entry_missing".to_string()),
        "the bundle index lists both pages: {report}"
    );
    assert_eq!(snapshot(&root), before, "a store root is never written");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("只读根"), "{stderr}");

    let output = check(&root, false);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("未应用变更（"), "{text}");
    assert!(
        text.contains("`core/concepts/target.md` — 时效"),
        "the text names the unapplied update: {text}"
    );
}

// ---------------------------------------------------------------------------
// Store root checks
// ---------------------------------------------------------------------------

#[test]
fn test_store_root_reports_a_missing_bundle() {
    let root = temp_dir("check_roots_missing_bundle");
    write_page(&root, "index.md", "# Index\n\n- [Core](core/index.md)\n");
    std::fs::write(root.join("zwiki.lock"), lock_text("core", "core")).unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "a missing bundle fails the run: {report}");
    assert_eq!(report["status"], "issues");
    let missing: Vec<&serde_json::Value> = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|issue| issue["rule"] == "bundle_missing")
        .collect();
    assert_eq!(missing.len(), 1, "one issue per missing bundle: {report}");
    assert_eq!(missing[0]["path"], "core");
    assert!(
        missing[0]["message"].as_str().is_some_and(|m| !m.is_empty()),
        "the issue carries a message: {report}"
    );

    let output = check(&root, false);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("`core`"), "the text names the bundle: {text}");
}

#[test]
fn test_store_root_reports_an_unlinked_root_index() {
    let root = store_root("check_roots_root_index");
    write_page(&root, "index.md", "# Index\n");

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "an unlinked root index fails: {report}");
    assert_eq!(report["status"], "issues");
    let root_index: Vec<&serde_json::Value> = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|issue| issue["rule"] == "root_index")
        .collect();
    assert_eq!(root_index.len(), 1, "one root index issue: {report}");
    assert_eq!(root_index[0]["path"], "index.md");
    assert!(
        root_index[0]["message"].as_str().is_some_and(|m| m.contains("core")),
        "the issue names the unreferenced bundle: {report}"
    );
}

#[test]
fn test_unreadable_lock_is_one_error_report() {
    let root = temp_dir("check_roots_corrupt_lock");
    write_page(&root, "index.md", "# Index\n");
    std::fs::write(root.join("zwiki.lock"), "bundles = [\n").unwrap();

    let (report, code) = check_json(&root);

    assert_eq!(code, Some(1), "a broken lock stops the run: {report}");
    assert_eq!(report["status"], "error");
    assert!(
        report["error"]
            .as_str()
            .is_some_and(|error| error.contains("zwiki.lock")),
        "the error names the lock: {report}"
    );

    let output = check(&root, false);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("错误："), "{stdout}");
    assert!(stdout.contains("结果：执行失败"), "{stdout}");
}

// ---------------------------------------------------------------------------
// Temporary roots
// ---------------------------------------------------------------------------

#[test]
fn test_temp_root_reports_unapplied_changes() {
    let doc = page("Doc", &format!("{BODY}\n\nSee [Index](index.md)."));
    let tar = common::make_bundle_tar("check_roots_temp", &doc);
    let archive = std::fs::read(&tar).unwrap();

    let (report, code) = check_json(&tar);

    assert_eq!(code, Some(1), "an unapplied change fails the run: {report}");
    assert_eq!(report["status"], "issues");
    assert_eq!(report["read_only"], true);
    assert!(
        changes(&report)
            .contains(&("index.md".to_string(), "index".to_string())),
        "the generated root index stays unapplied: {report}"
    );
    assert_eq!(
        std::fs::read(&tar).unwrap(),
        archive,
        "the archive is never written"
    );

    let output = check(&tar, false);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("未应用变更（"), "{stdout}");
    assert!(stdout.contains("结果：存在问题"), "{stdout}");
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

#[test]
fn test_source_newer_issues_do_not_depend_on_source_order() {
    let first = writable_root("check_roots_source_order_a");
    let second = writable_root("check_roots_source_order_b");
    for root in [&first, &second] {
        write_page(root, "bar.md", &source_page("Bar", "2026-11-20T10:00:00Z"));
        write_page(root, "aaa.md", &source_page("Aaa", "2026-11-21T10:00:00Z"));
    }
    write_page(
        &first,
        "foo.md",
        &analysis_page("Foo", "2026-11-20", "[bar.md, aaa.md]"),
    );
    write_page(
        &second,
        "foo.md",
        &analysis_page("Foo", "2026-11-20", "[aaa.md, bar.md]"),
    );

    let (first_report, _) = check_json(&first);
    let (second_report, _) = check_json(&second);

    assert_eq!(
        first_report["issues"], second_report["issues"],
        "the report never depends on the declared source order"
    );
    let sources: Vec<&str> = first_report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|issue| issue["rule"] == "source_newer")
        .map(|issue| issue["details"]["source"].as_str().expect("source"))
        .collect();
    assert_eq!(
        sources,
        vec!["aaa.md", "bar.md"],
        "the issues are sorted by source: {first_report}"
    );
}

// ---------------------------------------------------------------------------
// One document per run
// ---------------------------------------------------------------------------

#[test]
fn test_every_root_form_prints_one_document() {
    let writable = writable_root("check_roots_forms_writable");
    write_page(&writable, "concept.md", &page("Concept", BODY));

    let readonly = temp_dir("check_roots_forms_readonly");
    write_page(&readonly, "concept.md", &page("Concept", BODY));

    let store = store_root("check_roots_forms_store");
    write_page(&store, "core/concept.md", &page("Concept", BODY));

    let tar =
        common::make_bundle_tar("check_roots_forms_temp", &page("Doc", BODY));

    for root in [&writable, &readonly, &store, &tar] {
        let output = check(root, true);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            stdout.matches("\"schema_version\"").count(),
            1,
            "one document for {}: {stdout}",
            root.display()
        );
        let report: serde_json::Value = serde_json::from_str(stdout.trim())
            .unwrap_or_else(|e| {
                panic!(
                    "one JSON document for {}: {e}\n{stdout}",
                    root.display()
                )
            });
        assert_eq!(
            object_keys(&report),
            [
                "changes",
                "error",
                "issues",
                "read_only",
                "schema_version",
                "status",
                "summary"
            ],
            "every root reports the same layout: {report}"
        );
        assert_eq!(
            object_keys(&report["summary"]),
            ["changes", "issues", "pages"],
            "every root counts the same summary: {report}"
        );
    }
}

/// The keys of a JSON object, sorted.
fn object_keys(value: &serde_json::Value) -> Vec<&str> {
    value.as_object().expect("an object").keys().map(String::as_str).collect()
}
