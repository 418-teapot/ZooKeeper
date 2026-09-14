//! Integration test: `zwiki check` on an installed store (a root carrying
//! `zwiki.lock`) or on an aggregate root containing an installed bundle
//! skips derived-metadata writes inside bundles (relations and backlinks)
//! and notes the skip.  A writable root check would instead rewrite
//! `page_a.md` (add a `relations` field and a `## Backlinks` section), so
//! the two behaviors are distinguishable.

use std::path::PathBuf;
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

fn page(title: &str, body: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntimestamp: 2026-01-01T00:00:00Z\n\
         tags: []\nstatus: draft\nlast_validated: 2026-01-01T00:00:00Z\n\
         timeliness: current\n---\n\n# {title}\n\n{body}\n"
    )
}

/// Mark `dir` as a bundle by writing a minimal `bundle.toml`.
fn write_bundle_manifest(dir: &std::path::Path) {
    std::fs::write(dir.join("bundle.toml"), ".").unwrap();
}

#[test]
fn test_check_on_store_root_skips_derived_sync() {
    let base = temp_dir("check_bundles_readonly");
    std::fs::write(base.join("zwiki.lock"), "bundles = []\n").unwrap();
    let bundle = base.join("core");
    std::fs::create_dir_all(&bundle).unwrap();
    write_bundle_manifest(&bundle);

    let page_b = page("Page B", "Body of page B.");
    std::fs::write(bundle.join("page_b.md"), &page_b).unwrap();

    // page_a links to page_b; a writable check would derive `relations` and
    // add a `## Backlinks` section to page_b.
    let page_a =
        page("Page A", "See [Page B](page_b.md) for related information.");
    let page_a_path = bundle.join("page_a.md");
    std::fs::write(&page_a_path, &page_a).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", base.to_string_lossy().as_ref(), "check"])
        .output()
        .expect("run zwiki check");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("只读根"),
        "check should note the read-only root: {stderr}"
    );

    let after_a = std::fs::read_to_string(&page_a_path).unwrap();
    assert_eq!(after_a, page_a, "read-only check must not rewrite page_a");
    assert!(!after_a.contains("relations:"), "no derived relations written");

    let after_b = std::fs::read_to_string(bundle.join("page_b.md")).unwrap();
    assert_eq!(after_b, page_b, "read-only check must not rewrite page_b");
    assert!(!after_b.contains("## Backlinks"), "no derived backlinks written");
}

#[test]
fn test_check_on_store_root_json_marks_sync_skipped() {
    let base = temp_dir("check_bundles_readonly_json");
    std::fs::write(base.join("zwiki.lock"), "bundles = []\n").unwrap();
    let bundle = base.join("core");
    std::fs::create_dir_all(&bundle).unwrap();
    write_bundle_manifest(&bundle);
    std::fs::write(bundle.join("page.md"), page("P", "Some body text."))
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", base.to_string_lossy().as_ref(), "check", "--json"])
        .output()
        .expect("run zwiki check --json");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("\"read_only_root\": true"),
        "json should flag a read-only root: {stdout}"
    );
    assert!(
        stdout.contains("\"derived_metadata_sync\": \"skipped\""),
        "json should report skipped sync: {stdout}"
    );
}

#[test]
fn test_aggregate_root_check_skips_bundle_pages() {
    let base = temp_dir("aggregate_readonly_pages");
    let bundle = base.join("core").join("concepts");
    std::fs::create_dir_all(&bundle).unwrap();
    write_bundle_manifest(&base.join("core"));

    // Both bundle pages are link targets/sources the derived-metadata sync
    // would rewrite on a writable root.
    let page_b = page("Page B", "Body of page B with enough text.");
    let page_b_path = bundle.join("page_b.md");
    std::fs::write(&page_b_path, &page_b).unwrap();

    let page_a = page(
        "Page A",
        "See [Page B](concepts/page_b.md) for related information.",
    );
    let page_a_path = bundle.join("page_a.md");
    std::fs::write(&page_a_path, &page_a).unwrap();

    // A writable page outside the bundle that links into it.
    let notes_dir = base.join("notes").join("concepts");
    std::fs::create_dir_all(&notes_dir).unwrap();
    std::fs::write(
        notes_dir.join("notes.md"),
        page("Notes", "See [Page B](concepts/page_b.md)."),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", base.to_string_lossy().as_ref(), "check"])
        .output()
        .expect("run zwiki check");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("已跳过"),
        "check should report skipped bundle pages: {stderr}"
    );

    let after_a = std::fs::read_to_string(&page_a_path).unwrap();
    assert_eq!(after_a, page_a, "bundle page_a must not be rewritten");
    let after_b = std::fs::read_to_string(&page_b_path).unwrap();
    assert_eq!(after_b, page_b, "bundle page_b must not be rewritten");
    assert!(!after_a.contains("relations:"), "no derived relations");
    assert!(!after_b.contains("## Backlinks"), "no derived backlinks");
}

#[test]
fn test_check_on_store_root_skips_all_writes() {
    // A store root carries `zwiki.lock`, so `check` must never write derived
    // metadata or regenerate indexes for stray non-hidden directories.
    let store = temp_dir("check_store_readonly");
    std::fs::create_dir_all(store.join("concepts")).unwrap();
    std::fs::write(
        store.join("concepts/linker.md"),
        page("Linker", "See [Target](concepts/target.md)."),
    )
    .unwrap();
    std::fs::write(
        store.join("concepts/target.md"),
        page("Target", "Body of target page."),
    )
    .unwrap();
    std::fs::write(store.join("zwiki.lock"), "bundles = []\n").unwrap();

    let before = snapshot(&store);

    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", store.to_string_lossy().as_ref(), "check", "--json"])
        .output()
        .expect("run zwiki check");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("\"read_only_root\": true"),
        "store root must be reported read-only: {stdout}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("只读根"),
        "check should note the read-only store root: {stderr}"
    );

    assert_eq!(snapshot(&store), before, "store root must not be written");
    assert!(
        !store.join("concepts/index.md").exists(),
        "no index should be generated in a store root"
    );
}

/// Snapshot every file under `dir` as `(relative path, contents)` pairs.
fn snapshot(dir: &std::path::Path) -> Vec<(PathBuf, String)> {
    let mut files: Vec<(PathBuf, String)> = walk(dir, dir);
    files.sort();
    files
}

fn walk(
    root: &std::path::Path,
    dir: &std::path::Path,
) -> Vec<(PathBuf, String)> {
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

#[test]
fn test_check_json_suppresses_sync_warnings() {
    let root = temp_dir("check_json_no_warnings");
    write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("concepts")).unwrap();
    // The link target has no `## Details` / `## References` anchor, so a
    // plain check warns that the Backlinks section cannot be inserted.
    std::fs::write(
        root.join("concepts/target.md"),
        page("Target", "Some body text."),
    )
    .unwrap();
    std::fs::write(
        root.join("concepts/linker.md"),
        page("Linker", "See [Target](concepts/target.md)."),
    )
    .unwrap();

    // Plain run surfaces the warning on stderr.
    let plain = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", root.to_string_lossy().as_ref(), "check"])
        .output()
        .expect("run zwiki check");
    let plain_stderr = String::from_utf8_lossy(&plain.stderr);
    assert!(
        plain_stderr.contains("警告"),
        "plain check should warn about the missing anchor: {plain_stderr}"
    );

    // JSON run suppresses the warning on stderr.
    let json = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", root.to_string_lossy().as_ref(), "check", "--json"])
        .output()
        .expect("run zwiki check --json");
    let json_stderr = String::from_utf8_lossy(&json.stderr);
    assert!(
        !json_stderr.contains("警告"),
        "json check must not emit warnings on stderr: {json_stderr}"
    );
}
