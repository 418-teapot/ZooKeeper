//! Integration test: `zwiki check` never rewrites `last_validated`.
//!
//! A derived page whose source is newer stays detectable by `verify` across
//! repeated checks.  The `stale` timeliness the page earns survives the next
//! check, so no run reports the page as `current` without an explicit
//! re-validation.  The same runs keep their automatic writes.

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

#[test]
fn test_repeated_check_keeps_last_validated_and_stale() {
    let root = temp_dir("check_last_validated");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs/.gitkeep"), "").unwrap();

    // The derived page was validated before the source changed.  Both dates
    // sit inside the time-decay threshold, so only the source relation can
    // justify `stale`.
    let today = chrono::Utc::now().date_naive();
    let validated =
        (today - chrono::Duration::days(10)).format("%Y-%m-%d").to_string();
    let source_date =
        (today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();

    std::fs::write(
        root.join("source_bar.md"),
        format!(
            "---\ntitle: Bar\ntype: source\ntimestamp: {source_date}\n\
             tags: []\nstatus: draft\nlast_validated: {validated}\n\
             timeliness: current\n---\n\n# Bar\n\nSource body.\n"
        ),
    )
    .unwrap();

    std::fs::write(
        root.join("analysis_foo.md"),
        format!(
            "---\ntitle: Foo\ntype: analysis\nsources: [source_bar.md]\n\
             tags: []\nstatus: draft\nlast_validated: {validated}\n\
             timeliness: current\n---\n\n# Foo\n\n\
             Analysis of [Bar](source_bar.md).\n"
        ),
    )
    .unwrap();

    let derived = root.join("analysis_foo.md");
    let source = root.join("source_bar.md");

    run(&root, &["check"]);
    let first = std::fs::read_to_string(&derived).unwrap();
    assert!(
        first.contains(&format!("last_validated: {validated}")),
        "check must not rewrite last_validated: {first}"
    );
    assert!(
        first.contains("timeliness: stale"),
        "a newer source marks the derived page stale: {first}"
    );

    run(&root, &["check"]);
    let second = std::fs::read_to_string(&derived).unwrap();
    assert!(
        second.contains(&format!("last_validated: {validated}")),
        "repeated check keeps last_validated: {second}"
    );
    assert!(
        second.contains("timeliness: stale"),
        "repeated check must not restore timeliness to current: {second}"
    );

    let verify = run(&root, &["--json", "verify"]);
    assert!(
        verify.contains("\"derived_page\": \"analysis_foo.md\""),
        "verify still reports the stale pair: {verify}"
    );

    let source_text = std::fs::read_to_string(&source).unwrap();
    assert!(
        source_text.contains("## Backlinks"),
        "check still syncs backlinks: {source_text}"
    );
}
