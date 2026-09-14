//! Integration test: verify `zwiki page` commands (show, set, unset, create,
//! move), path normalization, and read-only root rejection.
//!
//! Uses `env!("CARGO_BIN_EXE_zwiki")` which cargo sets for integration
//! tests, guaranteeing a freshly-built binary (no stale-binary flakiness).

use std::path::{Path, PathBuf};
use std::process::Command;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

/// Create a minimal writable wiki root at `dir` with a few pages.
fn make_wiki(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    // Bundle manifest marks this as a writable bundle source.
    std::fs::write(
        dir.join("bundle.toml"),
        "[package]\nname = \"test-wiki\"\nversion = \"0.1.0\"\n\n[export]\ninclude = [\"**/*\"]\n",
    )
    .unwrap();
    // Domain subdirectories.
    for sub in &["concepts", "entities", "sources/adr", "analysis", "syntheses"]
    {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    // A page for set/unset/show tests.
    std::fs::write(
        dir.join("concepts").join("test-page.md"),
        "---\ntitle: Test Page\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\nstatus: draft\ntags: []\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Test Page\n\nContent here.\n",
    )
    .unwrap();
    // A second page that links to test-page (for backlinks).
    std::fs::write(
        dir.join("concepts").join("linker.md"),
        "---\ntitle: Linker\ntype: concept\n---\n\n# Linker\n\nSee [Test Page](concepts/test-page.md).\n",
    )
    .unwrap();
}

/// Create a minimal tar.gz bundle (read-only root).
fn make_readonly_bundle(dir: &Path) -> PathBuf {
    std::fs::write(
        dir.join("bundle.toml"),
        r#"[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"

[export]
include = ["*.md"]
"#,
    )
    .unwrap();
    std::fs::write(dir.join("index.md"), "---\ntitle: Index\n---\n# Index\n")
        .unwrap();
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();
    std::fs::write(
        dir.join("doc.md"),
        "---\ntitle: Doc\ntype: concept\n---\n\n# Doc\n",
    )
    .unwrap();

    let tar_path = dir.join("test-bundle.tar.gz");
    let file = std::fs::File::create(&tar_path).unwrap();
    let gz =
        flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(gz);
    archive
        .append_path_with_name(dir.join("bundle.toml"), "bundle.toml")
        .unwrap();
    archive.append_path_with_name(dir.join("index.md"), "index.md").unwrap();
    archive.append_path_with_name(dir.join("doc.md"), "doc.md").unwrap();
    archive.append_dir("logs", dir.join("logs")).unwrap();
    let gz = archive.into_inner().unwrap();
    gz.finish().unwrap();
    tar_path
}

/// Assert that a zwiki command succeeds (exit 0).
fn assert_ok(bin: &Path, args: &[&str], label: &str) {
    let output = Command::new(bin)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("{label} should run: {e}"));
    assert!(
        output.status.success(),
        "{label} should succeed.\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

/// Assert that a zwiki command fails with exit != 0 and stderr contains
/// the Chinese rejection message (for read-only root).
fn assert_rejected(bin: &Path, args: &[&str], label: &str) {
    let output = Command::new(bin)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("{label} should run: {e}"));
    assert!(!output.status.success(), "{label} should fail on readonly root");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("不支持"),
        "stderr for {label} should contain Chinese rejection: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

#[test]
fn test_page_show_reads_full_content() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_show_reads");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "page show should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("title: Test Page"), "should show frontmatter");
    assert!(stdout.contains("# Test Page"), "should show body");
}

#[test]
fn test_page_show_with_property() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_show_prop");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "status",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "page show --property should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "draft");
}

#[test]
fn test_page_show_with_outline() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_show_outline");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--outline",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "page show --outline should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    // The test page has only an H1, so outline should be empty.
    assert_eq!(stdout.trim(), "");
}

#[test]
fn test_page_show_with_backlinks() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_show_bl");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--backlinks",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "page show --backlinks should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Test Page"), "should mention the target page");
    assert!(stdout.contains("Linker"), "should mention the linker page");
}

#[test]
fn test_page_set_and_get() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_set_get");
    make_wiki(&wiki);

    // Set timeliness → stale.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "set",
            "concepts/test-page.md",
            "timeliness",
            "stale",
        ],
        "page set timeliness",
    );

    // Verify via page show --property.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "timeliness",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "stale", "timeliness should be stale");
}

#[test]
fn test_page_set_downgrade() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_set_downgrade");
    make_wiki(&wiki);

    // Downgrade status from draft → draft (downgrade is idempotent at bottom).
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "set",
            "concepts/test-page.md",
            "status",
            "--downgrade",
        ],
        "page set --downgrade",
    );

    // Verify status stayed draft.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "status",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "draft");
}

#[test]
fn test_page_unset() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_unset");
    make_wiki(&wiki);

    // Verify timeliness exists first.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "timeliness",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "current");

    // Unset timeliness.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "unset",
            "concepts/test-page.md",
            "timeliness",
        ],
        "page unset timeliness",
    );

    // Verify timeliness is gone.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "timeliness",
        ])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "page show --property timeliness should fail after unset"
    );
}

#[test]
fn test_page_create_and_move() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_create_move");
    make_wiki(&wiki);

    // Create a page: domain "concepts" + type "concept" → concepts/concepts/<slug>.md.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "create",
            "--domain",
            "concepts",
            "--type",
            "concept",
            "--title",
            "New Concept",
        ],
        "page create",
    );

    let page_path =
        wiki.join("concepts").join("concepts").join("new-concept.md");
    assert!(
        page_path.exists(),
        "created page should exist at {}",
        page_path.display()
    );

    // Move the page within the same domain.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "move",
            "concepts/concepts/new-concept.md",
            "concepts/concepts/moved-concept.md",
        ],
        "page move",
    );

    assert!(!page_path.exists(), "old path should not exist after move");
    let moved_path =
        wiki.join("concepts").join("concepts").join("moved-concept.md");
    assert!(
        moved_path.exists(),
        "new path should exist after move at {}",
        moved_path.display()
    );
}

#[test]
fn test_page_show_path_normalization_dot_prefix() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("norm_dot");
    make_wiki(&wiki);

    // `page show ./concepts/test-page.md` should work (strip ./ prefix).
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "./concepts/test-page.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "normalized ./ prefix should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");
}

#[test]
fn test_page_show_path_normalization_missing_md() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("norm_md");
    make_wiki(&wiki);

    // Without .md extension.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "normalized missing .md should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");
}

#[test]
fn test_page_set_path_normalization() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("norm_set");
    make_wiki(&wiki);

    // Set with ./ prefix.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "set",
            "./concepts/test-page",
            "status",
            "review",
        ],
        "page set with normalized path",
    );

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--property",
            "status",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "review");
}

#[test]
fn test_page_show_nonexistent_page_error() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("nonexistent");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/no-such-page.md",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success(), "nonexistent page should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("不存在"),
        "should mention page not found: {stderr}"
    );
}

#[test]
fn test_readonly_root_rejects_page_set() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("ro_page_set");
    let tar_path = make_readonly_bundle(&tmp);

    assert_rejected(
        &bin,
        &[
            "--root",
            &tar_path.to_string_lossy(),
            "page",
            "set",
            "doc.md",
            "status",
            "draft",
        ],
        "readonly page set",
    );
}

#[test]
fn test_readonly_root_rejects_page_unset() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("ro_page_unset");
    let tar_path = make_readonly_bundle(&tmp);

    assert_rejected(
        &bin,
        &[
            "--root",
            &tar_path.to_string_lossy(),
            "page",
            "unset",
            "doc.md",
            "status",
        ],
        "readonly page unset",
    );
}

#[test]
fn test_readonly_root_rejects_page_create() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("ro_page_create");
    let tar_path = make_readonly_bundle(&tmp);

    assert_rejected(
        &bin,
        &[
            "--root",
            &tar_path.to_string_lossy(),
            "page",
            "create",
            "--domain",
            "test",
            "--type",
            "concept",
            "--title",
            "New",
        ],
        "readonly page create",
    );
}

#[test]
fn test_readonly_root_rejects_page_move() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("ro_page_move");
    let tar_path = make_readonly_bundle(&tmp);

    assert_rejected(
        &bin,
        &[
            "--root",
            &tar_path.to_string_lossy(),
            "page",
            "move",
            "doc.md",
            "doc-moved.md",
        ],
        "readonly page move",
    );
}

#[test]
fn test_page_show_exact_after_md_append() {
    // Exercises step 4 of normalize_page_path: "concepts/test-page" (no .md)
    // gets .md appended then matches via exact file existence.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("exact_after_md");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "exact after .md append should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");
}

#[test]
fn test_page_show_suffix_step5() {
    // Exercises step 5 (unique-suffix fallback): a page at a nested path
    // is found by querying only its filename suffix.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("suffix_step5");
    make_wiki(&wiki);

    // Create a deeply nested page.
    std::fs::create_dir_all(wiki.join("concepts").join("deep")).unwrap();
    std::fs::write(
        wiki.join("concepts").join("deep").join("nested-page.md"),
        "---\ntitle: Nested Page\ntype: concept\n---\n\n# Nested\n",
    )
    .unwrap();

    // Query bare "nested-page.md" — step 4 fails (no exact match under root),
    // step 5 should find concepts/deep/nested-page.md as the unique suffix.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "nested-page.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "step-5 suffix match should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Nested Page");
}

#[test]
fn test_page_show_ambiguous_suffix_error() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("ambig_suffix");
    make_wiki(&wiki);

    // Create two pages with the same filename suffix "test-page.md"
    // in different directories.
    std::fs::create_dir_all(wiki.join("entities")).unwrap();
    std::fs::write(
        wiki.join("entities").join("test-page.md"),
        "---\ntitle: Entity Page\n---\n\n# Entity\n",
    )
    .unwrap();

    // Also write a page in a subdir of concepts.
    std::fs::create_dir_all(wiki.join("concepts").join("sub")).unwrap();
    std::fs::write(
        wiki.join("concepts").join("sub").join("test-page.md"),
        "---\ntitle: Sub Page\n---\n\n# Sub\n",
    )
    .unwrap();

    // Now "test-page.md" should be ambiguous (matches concepts/test-page.md
    // and entities/test-page.md and concepts/sub/test-page.md).
    // Use just "test-page.md" as the path → should be ambiguous.
    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "test-page.md",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success(), "ambiguous suffix should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("不明确") || stderr.contains("多个匹配"),
        "ambiguous error should mention multiple matches: {stderr}"
    );
}

#[test]
fn test_page_show_rejects_dotdot() {
    // Paths containing `..` must be rejected to prevent directory traversal.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("reject_dotdot");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "../secret.txt",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success(), ".. path should be rejected");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(".."),
        "stderr should mention the rejected '..': {stderr}"
    );
}

#[test]
fn test_page_show_component_boundary_suffix() {
    // "page.md" must NOT match "otherpage.md" (component-boundary suffix).
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("comp_boundary");
    make_wiki(&wiki);

    // Create a page named "otherpage.md" alongside "test-page.md".
    std::fs::write(
        wiki.join("concepts").join("otherpage.md"),
        "---\ntitle: Other Page\ntype: concept\n---\n\n# Other\n",
    )
    .unwrap();

    // Query "page.md" — should NOT match "otherpage.md".
    let output = Command::new(&bin)
        .args(["--root", &wiki.to_string_lossy(), "page", "show", "page.md"])
        .output()
        .unwrap();
    assert!(!output.status.success(), "page.md should not match otherpage.md");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("不存在"),
        "should report page not found: {stderr}"
    );
}

#[test]
fn test_page_show_repeated_dot_slash() {
    // "././x.md" must strip both ./ prefixes and resolve correctly.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("repeated_dot");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "././concepts/test-page.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "repeated ./ should be stripped");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");
}

#[test]
fn test_page_show_backlinks_json() {
    // --backlinks --json must produce valid JSON containing "backlinks" key.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("bl_json");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "show",
            "concepts/test-page.md",
            "--backlinks",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "page show --backlinks --json should succeed"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("output must be valid JSON");
    assert!(
        parsed.get("backlinks").is_some(),
        "JSON output must contain 'backlinks' key"
    );
    let backlinks = parsed["backlinks"].as_object().unwrap();
    // The test-page.md should be a key in backlinks, with at least one source.
    assert!(!backlinks.is_empty(), "backlinks should have at least one entry");
    // Verify that the linker page appears as a source.
    let has_linker = backlinks.values().any(|v| {
        v.get("sources").and_then(|s| s.as_array()).is_some_and(|arr| {
            arr.iter().any(|src| {
                src.get("path")
                    .and_then(|p| p.as_str())
                    .is_some_and(|p| p.contains("linker"))
            })
        })
    });
    assert!(has_linker, "backlinks should include the linker page source");
}

#[test]
fn test_page_show_cwd_relative_path_with_root_dir_component() {
    // When --root is a relative path (e.g. ./wiki/) and the page path
    // includes the root directory component (e.g. ./wiki/concepts/test-page.md
    // or wiki/concepts/test-page.md), step 2 of normalize_page_path must
    // resolve the path relative to cwd and strip the root prefix.
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let base = temp_dir("cwd_rel");
    let wiki_root = base.join("wiki");
    make_wiki(&wiki_root);

    // Test with ./ prefix: ./wiki/concepts/test-page.md
    let output = Command::new(&bin)
        .current_dir(&base)
        .args([
            "--root",
            "./wiki/",
            "page",
            "show",
            "./wiki/concepts/test-page.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cwd-relative with ./ prefix should resolve.\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");

    // Test without ./ prefix: wiki/concepts/test-page.md
    let output = Command::new(&bin)
        .current_dir(&base)
        .args([
            "--root",
            "./wiki/",
            "page",
            "show",
            "wiki/concepts/test-page.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cwd-relative without ./ prefix should resolve.\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Test Page");
}

#[test]
fn test_readonly_root_allows_page_show() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let tmp = temp_dir("ro_page_show");
    let tar_path = make_readonly_bundle(&tmp);

    // page show is read-only and should work on readonly root.
    let output = Command::new(&bin)
        .args([
            "--root",
            &tar_path.to_string_lossy(),
            "page",
            "show",
            "doc.md",
            "--property",
            "title",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "page show on readonly root should succeed"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Doc");
}

// ---------------------------------------------------------------------------
// Automatic change-log entries
// ---------------------------------------------------------------------------

/// Read the single monthly log file under `<wiki>/logs`.
fn read_monthly_log(wiki: &Path) -> String {
    let log_file = std::fs::read_dir(wiki.join("logs"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "md"))
        .expect("monthly log file should exist");
    std::fs::read_to_string(&log_file).unwrap()
}

#[test]
fn test_page_create_writes_create_log_with_note() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_create_log");
    make_wiki(&wiki);

    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "create",
            "--domain",
            "research",
            "--type",
            "concept",
            "--title",
            "New Page",
            "--slug",
            "new-page",
            "--note",
            "首次录入",
        ],
        "page create with note",
    );

    let content = read_monthly_log(&wiki);
    assert!(
        content
            .contains("* **创建**: research/concepts/new-page.md — 首次录入"),
        "page create should auto-log with the note:\n{content}"
    );
}

#[test]
fn test_page_set_writes_edit_log_with_note() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_set_log");
    make_wiki(&wiki);

    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "set",
            "concepts/test-page.md",
            "status",
            "stable",
            "--note",
            "评审通过",
        ],
        "page set with note",
    );

    let content = read_monthly_log(&wiki);
    assert!(
        content.contains("* **编辑**: concepts/test-page.md — 评审通过"),
        "page set should auto-log an edit entry with the note:\n{content}"
    );
}

#[test]
fn test_page_unset_writes_edit_log_with_note() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_unset_log");
    make_wiki(&wiki);

    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "unset",
            "concepts/test-page.md",
            "timeliness",
            "--note",
            "清理属性",
        ],
        "page unset with note",
    );

    let content = read_monthly_log(&wiki);
    assert!(
        content.contains("* **编辑**: concepts/test-page.md — 清理属性"),
        "page unset should auto-log an edit entry with the note:\n{content}"
    );
}

#[test]
fn test_page_move_writes_move_log_with_note() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_move_log");
    make_wiki(&wiki);

    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "move",
            "concepts/test-page.md",
            "concepts/renamed-page.md",
            "--note",
            "重命名",
        ],
        "page move with note",
    );

    let content = read_monthly_log(&wiki);
    assert!(
        content.contains(
            "* **移动**: concepts/test-page.md → concepts/renamed-page.md — 重命名"
        ),
        "page move should auto-log a structured move entry with the note:\n{content}"
    );
}

#[test]
fn test_log_subcommand_rejected() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("log_removed");
    make_wiki(&wiki);

    let output = Command::new(&bin)
        .args([
            "--root",
            &wiki.to_string_lossy(),
            "log",
            "--path",
            "concepts/test-page.md",
            "--action",
            "create",
        ])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "zwiki log must no longer be a recognized subcommand"
    );
}

/// Run `check --json` and return the pages listed under `log_coverage`.
fn coverage_pages(bin: &Path, wiki: &Path) -> Vec<String> {
    let output = Command::new(bin)
        .args(["--root", &wiki.to_string_lossy(), "check", "--json"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| {
            panic!("check --json output is not JSON: {e}\n{stdout}")
        });
    value["health"]["log_coverage"]
        .as_array()
        .expect("log_coverage array")
        .iter()
        .filter_map(|i| i["page"].as_str().map(ToString::to_string))
        .collect()
}

#[test]
fn test_log_coverage_tracks_tool_created_sources() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("log_coverage_auto");
    make_wiki(&wiki);

    // A tool-created source page is auto-logged, so coverage must pass.
    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "create",
            "--domain",
            "research",
            "--type",
            "source",
            "--title",
            "ADR One",
            "--slug",
            "adr-001",
            "--source-type",
            "adr",
            "--note",
            "tool created",
        ],
        "page create source",
    );

    let created = "research/sources/adr/adr-001.md";
    assert!(
        !coverage_pages(&bin, &wiki).contains(&created.to_string()),
        "tool-created source page must not be flagged as missing coverage"
    );

    // A hand-dropped source page has no log entry and must be flagged.
    let hand = "research/sources/adr/hand-dropped.md";
    std::fs::write(
        wiki.join(hand),
        "---\ntitle: Hand Dropped\ntype: source\n---\nBody.\n",
    )
    .unwrap();

    assert!(
        coverage_pages(&bin, &wiki).contains(&hand.to_string()),
        "hand-dropped source page must be flagged as missing coverage"
    );
}

#[test]
fn test_page_create_new_domain_creates_index() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let wiki = temp_dir("page_create_new_domain_index");
    make_wiki(&wiki);

    assert_ok(
        &bin,
        &[
            "--root",
            &wiki.to_string_lossy(),
            "page",
            "create",
            "--domain",
            "freshdomain",
            "--type",
            "concept",
            "--title",
            "Fresh",
        ],
        "page create in new domain",
    );

    let index = wiki.join("freshdomain").join("index.md");
    assert!(
        index.is_file(),
        "page create into a new domain should write index.md"
    );
    let content = std::fs::read_to_string(&index).unwrap();
    assert!(
        content.starts_with("---\ntitle: freshdomain\n---"),
        "index.md should be generated with seeded frontmatter:\n{content}"
    );
    assert!(
        content.contains("- [Fresh](concepts/fresh.md)"),
        "index.md should list the created page:\n{content}"
    );
}

#[test]
fn test_template_command_prints_embedded_template() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let output =
        Command::new(&bin).args(["template", "concept"]).output().unwrap();
    assert!(output.status.success(), "template command should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("type: concept"), "should be the concept template");
    assert!(stdout.contains("<概念名称>"), "should contain the placeholder");
}

#[test]
fn test_template_command_unknown_type_fails() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let output =
        Command::new(&bin).args(["template", "bogus"]).output().unwrap();
    assert!(!output.status.success(), "unknown type should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("未知的模板类型") && stderr.contains("concept"),
        "error should list valid types: {stderr}"
    );
}

#[test]
fn test_schema_command_prints_embedded_schema() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_zwiki"));
    let output = Command::new(&bin).args(["schema"]).output().unwrap();
    assert!(output.status.success(), "schema command should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.starts_with("# Wiki Schema"), "should print SCHEMA.md");
}
