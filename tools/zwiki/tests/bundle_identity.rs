//! Integration tests: one bundle behaves the same from its own source root
//! and from an aggregate root, and the page identity of a bundle stays
//! private to that bundle.
//!
//! Each fixture keeps the link and `sources` text bundle-relative, which is
//! how pages are authored.  A source root holds the manifest at the root; an
//! aggregate root holds the same bundle below a directory named after it.

use std::path::Path;
use std::process::Command;

use ztest::temp_dir;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Page text with the required frontmatter plus `extra` lines, and a body
/// long enough to stay clear of the stub threshold.
fn page(
    title: &str,
    page_type: &str,
    last_validated: &str,
    extra: &str,
) -> String {
    format!(
        "---\ntitle: {title}\ntype: {page_type}\ntags: []\nstatus: draft\n\
         last_validated: {last_validated}\ntimeliness: current\n{extra}---\n\n\
         # {title}\n\nThis fixture page carries enough body text to describe \
         the scenario in one full sentence.\n"
    )
}

/// Source page text carrying a `timestamp`.
fn source_page(title: &str, timestamp: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: source\ntimestamp: {timestamp}\ntags: []\n\
         status: draft\nlast_validated: {timestamp}\ntimeliness: current\n\
         ---\n\n# {title}\n\nThis fixture source carries a timestamp and \
         enough body text to describe the scenario.\n"
    )
}

/// Write `text` at `rel` below `root`.
fn write_page(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Mark `dir` as the root of the bundle named `name`.
fn write_manifest(dir: &Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("bundle.toml"),
        format!(
            "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n"
        ),
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/// Run `zwiki --root <root> --json <args>` and parse its JSON report.
fn report(root: &Path, args: &[&str]) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .arg("--root")
        .arg(root)
        .arg("--json")
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("zwiki {args:?} should run: {e}"));
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).unwrap_or_else(|e| {
        panic!(
            "zwiki {args:?} should print JSON: {e}\nstdout: {stdout}\n\
             stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

/// Run `zwiki --root <root> check` and return its output.
fn check(root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .arg("--root")
        .arg(root)
        .arg("check")
        .output()
        .unwrap_or_else(|e| panic!("zwiki check should run: {e}"))
}

/// The text of the page stored at `rel` below `root`.
fn read_page(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel))
        .unwrap_or_else(|e| panic!("page {rel} should read: {e}"))
}

/// The `(page, target_path)` pairs `check` reports as broken links.
fn broken_links(root: &Path) -> Vec<(String, String)> {
    let report = report(root, &["check"]);
    report["issues"]
        .as_array()
        .expect("issues is an array")
        .iter()
        .filter(|issue| issue["rule"] == "broken_link")
        .map(|issue| {
            (
                issue["path"].as_str().expect("path").to_string(),
                issue["details"]["target_path"]
                    .as_str()
                    .expect("target_path")
                    .to_string(),
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Broken links
// ---------------------------------------------------------------------------

#[test]
fn test_source_and_aggregate_roots_agree_on_local_links() {
    // One bundle, authored once: `concepts/b.md` exists, `concepts/gone.md`
    // does not.  The link text is bundle-relative in both roots.
    let pages: &[(&str, String)] = &[
        (
            "concepts/a.md",
            page("A", "concept", "2026-01-01", "")
                + "\nSee [b](concepts/b.md) and [gone](concepts/gone.md).\n",
        ),
        ("concepts/b.md", page("B", "concept", "2026-01-01", "")),
    ];

    let source = temp_dir("identity_source_links");
    write_manifest(&source, "core");
    for (rel, text) in pages {
        write_page(&source, rel, text);
    }

    let aggregate = temp_dir("identity_aggregate_links");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    for (rel, text) in pages {
        write_page(&aggregate.join("core"), rel, text);
    }

    assert_eq!(
        broken_links(&source),
        vec![("concepts/a.md".to_string(), "concepts/gone.md".to_string())],
        "a source root resolves local links inside the bundle"
    );
    assert_eq!(
        broken_links(&aggregate),
        vec![(
            "core/concepts/a.md".to_string(),
            "concepts/gone.md".to_string()
        )],
        "an aggregate root resolves local links inside the bundle"
    );
}

#[test]
fn test_aggregate_root_keeps_bundles_apart() {
    // `core` and `vendor` hold different pages behind one shared path.  A
    // bare link from `core` must never reach `vendor`.
    let aggregate = temp_dir("identity_two_bundles");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_manifest(&aggregate.join("vendor"), "vendor");
    write_page(
        &aggregate,
        "core/concepts/note.md",
        &(page("Core Note", "concept", "2026-01-01", "")
            + "\nSee [sibling](concepts/sibling.md), \
           [vendor](concepts/vendor.md) and [local](concepts/note.md).\n"),
    );
    write_page(
        &aggregate,
        "core/concepts/sibling.md",
        &page("Core Sibling", "concept", "2026-01-01", ""),
    );
    write_page(
        &aggregate,
        "vendor/concepts/note.md",
        &page("Vendor Note", "concept", "2026-01-01", ""),
    );
    write_page(
        &aggregate,
        "vendor/concepts/vendor.md",
        &page("Vendor Page", "concept", "2026-01-01", ""),
    );

    assert_eq!(
        broken_links(&aggregate),
        vec![(
            "core/concepts/note.md".to_string(),
            "concepts/vendor.md".to_string()
        )],
        "only the link naming no page of the referrer's bundle is broken"
    );
}

#[test]
fn test_missing_bundle_reference_is_not_a_local_dead_link() {
    // A reference to a bundle the root does not hold stays unreported.
    let aggregate = temp_dir("identity_missing_bundle");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_page(
        &aggregate,
        "core/concepts/a.md",
        &(page("A", "concept", "2026-01-01", "")
            + "\nSee [absent](@absent/concepts/a.md).\n"),
    );

    assert!(
        broken_links(&aggregate).is_empty(),
        "an absent bundle is not reported as a broken local link"
    );
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

#[test]
fn test_local_backlinks_are_written_once() {
    // A local reference enters the generated region of its target, and a
    // second check leaves the page untouched.
    let root = temp_dir("identity_backlinks_local");
    write_manifest(&root, "core");
    write_page(
        &root,
        "concepts/target.md",
        &page("Target", "concept", "2099-01-01", ""),
    );
    write_page(
        &root,
        "concepts/linker.md",
        &(page("Linker", "concept", "2099-01-01", "")
            + "\nSee [Target](concepts/target.md).\n"),
    );

    let first = check(&root);
    assert!(
        String::from_utf8_lossy(&first.stdout).contains("反向链接"),
        "the first check reports the backlinks write: {}",
        String::from_utf8_lossy(&first.stdout)
    );
    let after_first = read_page(&root, "concepts/target.md");
    assert!(
        after_first.contains("\n- [Linker](concepts/linker.md)\n"),
        "the region lists the local referrer: {after_first}"
    );
    assert_eq!(after_first.matches("## Backlinks").count(), 1);

    let second = check(&root);
    assert!(
        !String::from_utf8_lossy(&second.stdout).contains("变更（"),
        "a second check must not rewrite: {}",
        String::from_utf8_lossy(&second.stdout)
    );
    assert_eq!(read_page(&root, "concepts/target.md"), after_first);
}

#[test]
fn test_cross_bundle_reference_links_only_the_named_target() {
    // The target is a writable page of the root bundle.  Its single
    // referrer lives in `core`, so the generated link names that bundle.
    // `vendor` holds the same page path and stays untouched.
    let aggregate = temp_dir("identity_backlinks_explicit");
    write_manifest(&aggregate, "root");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_manifest(&aggregate.join("vendor"), "vendor");
    write_page(
        &aggregate,
        "notes/target.md",
        &page("Root Target", "concept", "2099-01-01", ""),
    );
    write_page(
        &aggregate,
        "vendor/notes/target.md",
        &page("Vendor Target", "concept", "2099-01-01", ""),
    );
    write_page(
        &aggregate,
        "core/concepts/linker.md",
        &(page("Linker", "concept", "2099-01-01", "")
            + "\nSee [Root Target](@root/notes/target.md).\n"),
    );

    check(&aggregate);

    let root_target = read_page(&aggregate, "notes/target.md");
    assert!(
        root_target.contains("\n- [Linker](@core/concepts/linker.md)\n"),
        "the named target lists the referrer with its bundle: {root_target}"
    );
    let vendor_target = read_page(&aggregate, "vendor/notes/target.md");
    assert!(
        !vendor_target.contains("## Backlinks"),
        "the sibling page must not share the backlink: {vendor_target}"
    );
}

#[test]
fn test_bare_reference_selects_the_referrer_bundle() {
    // Both bundles hold `concepts/note.md`; the bare reference of `core`
    // names the page of `core` only.
    let aggregate = temp_dir("identity_backlinks_bare");
    write_manifest(&aggregate, "root");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_manifest(&aggregate.join("vendor"), "vendor");
    write_page(
        &aggregate,
        "core/concepts/note.md",
        &page("Core Note", "concept", "2099-01-01", ""),
    );
    write_page(
        &aggregate,
        "vendor/concepts/note.md",
        &page("Vendor Note", "concept", "2099-01-01", ""),
    );
    write_page(
        &aggregate,
        "core/concepts/linker.md",
        &(page("Linker", "concept", "2099-01-01", "")
            + "\nSee [Note](concepts/note.md).\n"),
    );

    let core = report(
        &aggregate,
        &["page", "show", "core/concepts/note.md", "--backlinks"],
    );
    assert_eq!(
        core["backlinks"]["core/concepts/note.md"]["sources"],
        serde_json::json!([
            {"path": "core/concepts/linker.md", "title": "Linker"}
        ]),
        "the page of the referrer's bundle holds the backlink"
    );
    let vendor = report(
        &aggregate,
        &["page", "show", "vendor/concepts/note.md", "--backlinks"],
    );
    assert_eq!(
        vendor["backlinks"],
        serde_json::json!({}),
        "a bare reference never reaches a sibling bundle"
    );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[test]
fn test_status_domain_uses_the_page_domain() {
    // A page of `core` belongs to the domain below the bundle root, not to
    // the bundle directory.
    let aggregate = temp_dir("identity_status_domain");
    write_manifest(&aggregate, "root");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_page(
        &aggregate,
        "core/concepts/a.md",
        &page("A", "concept", "2099-01-01", ""),
    );
    write_page(
        &aggregate,
        "core/analysis/b.md",
        &page("B", "analysis", "2099-01-01", ""),
    );

    assert_eq!(
        report(&aggregate, &["status"])["by_domain"],
        serde_json::json!({"analysis": 1, "concepts": 1}),
        "the domain distribution names the page domain"
    );
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

#[test]
fn test_verify_domain_filter_uses_the_page_domain() {
    // `--domain concepts` selects the page by its domain below the bundle
    // root, not by the bundle directory.
    let aggregate = temp_dir("identity_verify_domain");
    write_manifest(&aggregate, "root");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_page(
        &aggregate,
        "core/concepts/derived.md",
        &page(
            "Derived",
            "analysis",
            "2024-01-01",
            "sources: [concepts/source.md]\n",
        ),
    );
    write_page(
        &aggregate,
        "core/concepts/source.md",
        &source_page("Source", "2024-06-01"),
    );

    assert_eq!(
        report(&aggregate, &["verify", "--domain", "concepts"]),
        serde_json::json!([{
            "derived_page": "core/concepts/derived.md",
            "source_page": "core/concepts/source.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "the domain filter selects the page by its bundle-relative domain"
    );
}

/// The stale pairs `zwiki verify` reports.
fn stale_pairs(root: &Path) -> serde_json::Value {
    report(root, &["verify"])
}

#[test]
fn test_verify_reports_the_same_stale_source_in_both_roots() {
    // The `sources` entry is bundle-relative and omits the extension, as
    // pages author it.  Both roots hold the same bundle, so both report the
    // same stale relation under their own page paths.
    let analysis =
        page("Foo", "analysis", "2024-01-01", "sources: [sources/bar.md]\n");
    let source = source_page("Bar", "2024-06-01");

    let source_root = temp_dir("identity_verify_source");
    write_manifest(&source_root, "core");
    write_page(&source_root, "analysis/foo.md", &analysis);
    write_page(&source_root, "sources/bar.md", &source);

    let aggregate = temp_dir("identity_verify_aggregate");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_page(&aggregate.join("core"), "analysis/foo.md", &analysis);
    write_page(&aggregate.join("core"), "sources/bar.md", &source);

    assert_eq!(
        stale_pairs(&source_root),
        serde_json::json!([{
            "derived_page": "analysis/foo.md",
            "source_page": "sources/bar.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "a source root finds the source beside the derived page"
    );
    assert_eq!(
        stale_pairs(&aggregate),
        serde_json::json!([{
            "derived_page": "core/analysis/foo.md",
            "source_page": "core/sources/bar.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "an aggregate root finds the source inside the same bundle"
    );
}

#[test]
fn test_verify_follows_an_explicit_source_only_when_the_bundle_is_visible() {
    // `@bundle/path` names one bundle: a visible bundle joins the stale
    // judgment and an absent one stays unreported.
    let aggregate = temp_dir("identity_verify_explicit");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_manifest(&aggregate.join("vendor"), "vendor");
    write_page(
        &aggregate,
        "core/analysis/visible.md",
        &page(
            "Visible",
            "analysis",
            "2024-01-01",
            "sources: ['@core/sources/bar.md']\n",
        ),
    );
    write_page(
        &aggregate,
        "core/analysis/absent.md",
        &page(
            "Absent",
            "analysis",
            "2024-01-01",
            "sources: ['@absent/sources/bar.md']\n",
        ),
    );
    write_page(
        &aggregate,
        "core/sources/bar.md",
        &source_page("Bar", "2024-06-01"),
    );

    assert_eq!(
        stale_pairs(&aggregate),
        serde_json::json!([{
            "derived_page": "core/analysis/visible.md",
            "source_page": "core/sources/bar.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "only the explicit source of the visible bundle is judged"
    );
}

#[test]
fn test_verify_does_not_lend_a_source_from_another_bundle() {
    // Only `vendor` holds `sources/bar.md`; the bare entry of `core` names
    // no page, so no stale pair is reported.
    let aggregate = temp_dir("identity_verify_isolation");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_manifest(&aggregate.join("vendor"), "vendor");
    write_page(
        &aggregate,
        "core/analysis/foo.md",
        &page("Foo", "analysis", "2024-01-01", "sources: [sources/bar.md]\n"),
    );
    write_page(
        &aggregate,
        "vendor/sources/bar.md",
        &source_page("Bar", "2024-06-01"),
    );

    assert_eq!(
        stale_pairs(&aggregate),
        serde_json::json!([]),
        "a bare source entry never reaches another bundle"
    );
}

// ---------------------------------------------------------------------------
// Root scope
// ---------------------------------------------------------------------------

#[test]
fn test_root_without_manifest_serves_read_only_commands() {
    // A directory without a root manifest is a read-only wiki root: it
    // holds loose pages beside a nested bundle.  `check`, `status` and
    // `verify` report on it, and `check` writes no derived metadata.
    let root = temp_dir("identity_root_scope");
    write_manifest(&root.join("core"), "core");
    write_page(
        &root,
        "core/concepts/note.md",
        &page("Note", "concept", "2099-01-01", ""),
    );
    write_page(
        &root,
        "concepts/derived.md",
        &page(
            "Derived",
            "analysis",
            "2024-01-01",
            "sources: [concepts/source.md]\n",
        ),
    );
    write_page(
        &root,
        "concepts/source.md",
        &source_page("Source", "2024-06-01"),
    );
    write_page(
        &root,
        "concepts/referrer.md",
        &(page("Referrer", "concept", "2099-01-01", "")
            + "\nSee [derived](concepts/derived.md), \
               [gone](concepts/gone.md) and [note](@core/concepts/note.md).\n"),
    );

    let before = read_page(&root, "concepts/derived.md");
    let checked = check(&root);
    assert!(
        String::from_utf8_lossy(&checked.stderr).contains("只读根"),
        "the root scope is read-only for check: {}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert_eq!(
        read_page(&root, "concepts/derived.md"),
        before,
        "check writes no derived metadata on a root scope"
    );
    assert_eq!(
        broken_links(&root),
        vec![(
            "concepts/referrer.md".to_string(),
            "concepts/gone.md".to_string()
        )],
        "a loose link resolves in the root scope and the explicit one its bundle"
    );

    assert_eq!(
        report(&root, &["status"])["total"],
        serde_json::json!(4),
        "status counts the loose pages and the bundle page"
    );
    assert_eq!(
        stale_pairs(&root),
        serde_json::json!([{
            "derived_page": "concepts/derived.md",
            "source_page": "concepts/source.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "verify pairs the loose source in the root scope"
    );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

#[test]
fn test_aggregate_root_reads_a_link_source_in_verify_and_backlinks() {
    // The derived page names its source through a markdown link with an
    // explicit bundle.  `verify` must pair it with that source, and the
    // generated backlinks region of the source must list the derived page.
    let aggregate = temp_dir("identity_source_link");
    write_manifest(&aggregate, "root");
    write_page(&aggregate, "index.md", "# Index\n");
    write_manifest(&aggregate.join("core"), "core");
    write_page(&aggregate, "sources/bar.md", &source_page("Bar", "2024-06-01"));
    write_page(
        &aggregate,
        "core/analysis/foo.md",
        &page(
            "Foo",
            "analysis",
            "2024-01-01",
            "sources: ['[Bar](@root/sources/bar.md)']\n",
        ),
    );

    assert_eq!(
        stale_pairs(&aggregate),
        serde_json::json!([{
            "derived_page": "core/analysis/foo.md",
            "source_page": "sources/bar.md",
            "source_timestamp": "2024-06-01",
            "derived_last_validated": "2024-01-01",
        }]),
        "verify reads the target of the markdown link"
    );

    check(&aggregate);
    let source = read_page(&aggregate, "sources/bar.md");
    assert!(
        source.contains("\n- [Foo](@core/analysis/foo.md)\n"),
        "the source page lists the derived page: {source}"
    );
}
