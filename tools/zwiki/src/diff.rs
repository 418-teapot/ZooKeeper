//! Incremental diff link checking — parse `git diff` output and run
//! anchor-text link checking on newly added lines.
//!
//! Usage: `zwiki check --diff [--cached] [--commit <ref>]`

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use crate::display::Issue;
use crate::health;
use crate::wiki;
use crate::wiki::Page;

/// Meta files whose diffs are skipped.
const META_FILES: &[&str] = &[
    "index.md",
    "lint-report.md",
    "health-report.md",
    "overview.md",
    "SCHEMA.md",
];

/// Directory name prefixes whose diffs are skipped.
const SKIP_DIRS: &[&str] = &["raw", "templates", "tools", "logs"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Should a wiki-relative path be skipped for diff checking?
fn should_skip(rel_path: &str) -> bool {
    // Check file name against meta list
    let fname =
        Path::new(rel_path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if META_FILES.contains(&fname) {
        return true;
    }
    // Check each path component against skip dirs
    for component in Path::new(rel_path).components() {
        if let std::path::Component::Normal(name) = component
            && SKIP_DIRS.contains(&name.to_str().unwrap_or(""))
        {
            return true;
        }
    }
    false
}

/// Discover all `.md` files under `base` (including meta files — filtering is
/// done elsewhere).
fn discover_pages_at(base: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(base)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Read a page from a given wiki base.
fn read_page_at(path: &Path, wiki_base: &Path) -> Option<Page> {
    let content = wiki::read_file(path);
    if content.is_empty() {
        return None;
    }
    let rel = path
        .strip_prefix(wiki_base)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let frontmatter = wiki::parse_frontmatter(&content);
    let body = wiki::strip_frontmatter(&content);
    Some(Page {
        path: path.to_path_buf(),
        rel,
        frontmatter,
        body,
        raw: content,
    })
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/// A single file's added lines from a unified diff.
#[derive(Debug)]
struct DiffFile {
    /// Wiki-relative path (e.g. `concepts/foo.md`)
    rel_path: String,
    /// Lines prefixed with `+` (excluding the `+++` header)
    added_lines: Vec<String>,
}

/// Parse unified diff text (produced by `git diff --unified=0`) into files.
fn parse_diff_output(diff_text: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current: Option<DiffFile> = None;

    for line in diff_text.lines() {
        if let Some(raw_path) = line.strip_prefix("+++ b/") {
            // File boundary — flush previous
            flush_current(&mut current, &mut files);
            // Strip `wiki/` prefix to get wiki-relative path
            let rel_path = raw_path.strip_prefix("wiki/").unwrap_or(raw_path);
            current = Some(DiffFile {
                rel_path: rel_path.to_string(),
                added_lines: Vec::new(),
            });
        } else if line.starts_with('+') && !line.starts_with("+++") {
            // Added line: strip leading '+'
            if let Some(ref mut file) = current {
                file.added_lines.push(line[1..].to_string());
            }
        }
    }

    flush_current(&mut current, &mut files);
    files
}

fn flush_current(current: &mut Option<DiffFile>, files: &mut Vec<DiffFile>) {
    if let Some(file) = current.take()
        && !file.added_lines.is_empty()
        && !should_skip(&file.rel_path)
    {
        files.push(file);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run `git diff` on the wiki directory and check added lines for missing
/// inline links.
///
/// Returns `Ok(vec![])` when git fails or there are no changes (not an error).
pub fn run_diff(
    cached: bool,
    commit: Option<&str>,
) -> Result<Vec<Issue>, String> {
    run_diff_at(&wiki::wiki_dir(), cached, commit)
}

/// Internal implementation that accepts an explicit wiki directory (for
/// testing).
fn run_diff_at(
    wiki_dir: &Path,
    cached: bool,
    commit: Option<&str>,
) -> Result<Vec<Issue>, String> {
    // 1. Build git diff command, running from the wiki directory
    let mut cmd = Command::new("git");
    cmd.current_dir(wiki_dir);
    cmd.arg("diff").arg("--unified=0");
    if cached {
        cmd.arg("--cached");
    }
    if let Some(commit_ref) = commit {
        cmd.arg(commit_ref);
    }

    // 2. Run git
    let output =
        cmd.output().map_err(|e| format!("failed to run git diff: {e}"))?;
    if !output.status.success() {
        // Not a git repo, no changes, or other error → empty results
        return Ok(Vec::new());
    }
    let diff_text = String::from_utf8_lossy(&output.stdout).to_string();
    if diff_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    // 3. Parse diff into files
    let files = parse_diff_output(&diff_text);
    if files.is_empty() {
        return Ok(Vec::new());
    }

    // 4. Build anchor map from all wiki pages (once before iterating files).
    //    Use local page discovery that respects the given wiki_dir.
    let paths = discover_pages_at(wiki_dir);
    let pages: Vec<Page> =
        paths.iter().filter_map(|p| read_page_at(p, wiki_dir)).collect();
    let mut anchor_map = health::extract_anchor_map(&pages, wiki_dir);

    // Register each page's own title as an anchor text pointing to itself
    for page in &pages {
        if let Some(title) =
            page.frontmatter.get("title").and_then(|v| v.as_str())
            && title.len() >= 3
        {
            anchor_map
                .entry(title.to_string())
                .or_default()
                .insert(page.rel.clone());
        }
    }
    health::expand_anchor_prefixes(&mut anchor_map);

    // 5. Check each file's added lines
    let mut all_issues: Vec<Issue> = Vec::new();
    for file in &files {
        let body = file.added_lines.join("\n");
        // Strip frontmatter in case the diff includes the full file
        let body = wiki::strip_frontmatter(&body);
        if body.trim().is_empty() {
            continue;
        }
        let mut issues = health::check_body_for_missing_links(
            &body,
            &file.rel_path,
            &anchor_map,
            wiki_dir,
        );
        all_issues.append(&mut issues);
    }

    // 6. Deduplicate prefix matches
    health::deduplicate_prefix_matches(&mut all_issues);

    Ok(all_issues)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test-diff").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Init a git repo at `dir`.
    fn init_git(dir: &Path) {
        let _ = Command::new("git").args(["init"]).arg(dir).output();
        let _ = Command::new("git")
            .args([
                "-C",
                &dir.to_string_lossy(),
                "config",
                "user.email",
                "test@test",
            ])
            .output();
        let _ = Command::new("git")
            .args(["-C", &dir.to_string_lossy(), "config", "user.name", "Test"])
            .output();
    }

    /// Git add + commit all files in `dir`.
    fn git_commit_all(dir: &Path, msg: &str) {
        let _ = Command::new("git")
            .args(["-C", &dir.to_string_lossy(), "add", "."])
            .output();
        let _ = Command::new("git")
            .args(["-C", &dir.to_string_lossy(), "commit", "-m", msg])
            .output();
    }

    /// Create a standard test wiki page with frontmatter and content.
    fn wiki_page(rel: &str, body_content: &str) -> String {
        format!(
            "---\ntitle: {}\ntype: concept\ntimestamp: 2024-01-01\n\
             tags: [test]\nstatus: draft\n---\n{}",
            Path::new(rel)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Page"),
            body_content
        )
    }

    // -------------------------------------------------------------------
    // parse_diff_output tests
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_diff_single_file() {
        let diff = "\
diff --git a/concepts/foo.md b/concepts/foo.md
--- a/concepts/foo.md
+++ b/concepts/foo.md
@@ -1 +1,2 @@
-Hello
+Hello World
+New line
";
        let files = parse_diff_output(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel_path, "concepts/foo.md");
        assert_eq!(files[0].added_lines, vec!["Hello World", "New line"]);
    }

    #[test]
    fn test_parse_diff_multiple_files() {
        let diff = "\
diff --git a/concepts/a.md b/concepts/a.md
--- a/concepts/a.md
+++ b/concepts/a.md
@@ -1 +1,2 @@
+Line A1
+Line A2
diff --git a/concepts/b.md b/concepts/b.md
--- a/concepts/b.md
+++ b/concepts/b.md
@@ -1 +1 @@
+Line B1
";
        let files = parse_diff_output(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].rel_path, "concepts/a.md");
        assert_eq!(files[0].added_lines, vec!["Line A1", "Line A2"]);
        assert_eq!(files[1].rel_path, "concepts/b.md");
        assert_eq!(files[1].added_lines, vec!["Line B1"]);
    }

    #[test]
    fn test_parse_diff_skips_meta_files() {
        let diff = "\
diff --git a/index.md b/index.md
--- a/index.md
+++ b/index.md
@@ -1 +1,2 @@
+Added to index
+More index
diff --git a/concepts/foo.md b/concepts/foo.md
--- a/concepts/foo.md
+++ b/concepts/foo.md
@@ -1 +1 @@
+Real content
";
        let files = parse_diff_output(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel_path, "concepts/foo.md");
    }

    #[test]
    fn test_parse_diff_skips_raw_templates_tools() {
        let diff = "\
diff --git a/raw/notes.md b/raw/notes.md
--- a/raw/notes.md
+++ b/raw/notes.md
@@ -1 +1 @@
+raw content
diff --git a/templates/concept.md b/templates/concept.md
--- a/templates/concept.md
+++ b/templates/concept.md
@@ -1 +1 @@
+template content
diff --git a/tools/helper.md b/tools/helper.md
--- a/tools/helper.md
+++ b/tools/helper.md
@@ -1 +1 @@
+tool content
diff --git a/logs/2026-07.md b/logs/2026-07.md
--- a/logs/2026-07.md
+++ b/logs/2026-07.md
@@ -1 +1 @@
+log content
diff --git a/concepts/foo.md b/concepts/foo.md
--- a/concepts/foo.md
+++ b/concepts/foo.md
@@ -1 +1 @@
+Real content
";
        let files = parse_diff_output(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel_path, "concepts/foo.md");
    }

    #[test]
    fn test_parse_diff_strips_wiki_prefix() {
        let diff = "\
diff --git a/wiki/concepts/foo.md b/wiki/concepts/foo.md
--- a/wiki/concepts/foo.md
+++ b/wiki/concepts/foo.md
@@ -1 +1 @@
+Content under wiki/
";
        let files = parse_diff_output(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel_path, "concepts/foo.md");
    }

    #[test]
    fn test_no_changes_returns_empty() {
        let files = parse_diff_output("");
        assert!(files.is_empty());
    }

    #[test]
    fn test_parse_diff_only_deletions() {
        // Only `-` lines, no `+` lines → file has no added lines and is
        // filtered out by flush_current.
        let diff = "\
diff --git a/concepts/foo.md b/concepts/foo.md
--- a/concepts/foo.md
+++ b/concepts/foo.md
@@ -1 +1 @@
-Old line
";
        let files = parse_diff_output(diff);
        assert!(
            files.is_empty(),
            "files with only deletions should be skipped"
        );
    }

    // -------------------------------------------------------------------
    // Integration test: create wiki pages, commit, modify, check diff
    // -------------------------------------------------------------------

    #[test]
    fn test_detects_missing_link() {
        let wiki = temp_dir("detects_missing_link");
        let wiki_str = wiki.to_string_lossy().to_string();

        // Two pages: page-a links to page-b with anchor text "target page"
        write(
            &wiki.join("page-a.md"),
            &wiki_page(
                "page-a.md",
                "See [target page](page-b.md) for details.\n",
            ),
        );
        write(
            &wiki.join("page-b.md"),
            &wiki_page("page-b.md", "Content about something.\n"),
        );

        // Init git and commit initial state
        init_git(&wiki);
        git_commit_all(&wiki, "initial");

        // Modify page-a: add text mentioning "target page" without a link
        let updated = wiki_page(
            "page-a.md",
            "See [target page](page-b.md) for details.\n\
             Also see target page in this new context.\n",
        );
        write(&wiki.join("page-a.md"), &updated);

        // Stage the change (--cached)
        let _ =
            Command::new("git").args(["-C", &wiki_str, "add", "."]).output();

        let issues =
            run_diff_at(&wiki, true, None).expect("run_diff should succeed");
        assert!(
            !issues.is_empty(),
            "should find at least one missing link issue"
        );

        // The issue should reference page-a.md and mention "target page"
        let has_page_a = issues.iter().any(|i| i.page == "page-a.md");
        assert!(has_page_a, "issue should be for page-a.md");

        // The details JSON should contain the term "target page"
        let has_target_term = issues.iter().any(|i| {
            serde_json::from_str::<serde_json::Value>(&i.details)
                .is_ok_and(|val| val["term"].as_str() == Some("target page"))
        });
        assert!(has_target_term, "should flag 'target page' as missing link");
    }
}
