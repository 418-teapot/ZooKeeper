//! Deep structural checks for broken links, orphans, sparse and stale pages.
//!
//! Each check scans wiki pages and returns issues.  Results are aggregated
//! by `run_all()` into a `LintResults` for display.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use regex::Regex;

use crate::backlinks;
use crate::display::{Issue, LintResults};
use crate::freshness::{self, StaleReason};
use crate::wiki::{self, Page};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum body character count (after stripping frontmatter) before a page
/// is considered non-sparse.
const SPARSE_BODY_CHARS: usize = 50;

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/// Normalize a path by resolving `.` and `..` components (without requiring
/// the file to exist on disk).
fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {
                result = PathBuf::from("/");
            }
            std::path::Component::Normal(c) => result.push(c),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                let has_normal = result
                    .components()
                    .any(|c| matches!(c, std::path::Component::Normal(_)));
                if has_normal {
                    result.pop();
                }
            }
            std::path::Component::Prefix(_) => {
                result.push(component.as_os_str());
            }
        }
    }
    result
}

/// Resolve a markdown link target to a canonical wiki-relative path.
///
/// Returns `None` for external URLs, anchor-only links, non-`.md` links,
/// or targets that escape the wiki directory.
fn resolve_target(target: &str) -> Option<String> {
    // Skip external URLs.
    if target.starts_with("http://") || target.starts_with("https://") {
        return None;
    }
    // Skip anchor-only links.
    if target.starts_with('#') {
        return None;
    }

    // Cross-bundle @name/path references resolve to other installed bundles;
    // the local linter cannot verify them so they are skipped.
    if target.starts_with('@') {
        return None;
    }

    // Strip anchor fragment (e.g. `foo.md#section` → `foo.md`).
    let target = target.split('#').next().unwrap_or(target);

    // Check for wiki-root-relative link (starts with `wiki/`).
    // These are resolved from the wiki root, not relative to source dir.
    if let Some(stripped) = target.strip_prefix("wiki/") {
        let resolved = normalize_path(Path::new(stripped));
        return Some(resolved.to_string_lossy().to_string());
    }

    // Only resolve `.md` targets.
    if !Path::new(target)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return None;
    }

    // Resolve relative to wiki root (wiki links are wiki-relative, not
    // page-directory-relative).
    let resolved = normalize_path(Path::new(target));

    Some(resolved.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Link extraction helpers
// ---------------------------------------------------------------------------

/// Extract markdown links from body text.
///
/// Returns `(link_text, raw_target)` pairs.
fn extract_markdown_links(body: &str) -> Vec<(String, String)> {
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    link_re
        .captures_iter(body)
        .map(|c| (c[1].trim().to_string(), c[2].trim().to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// 1. check_broken_links
// ---------------------------------------------------------------------------

/// Scan each page's body for markdown links `[text](target.md)`.  For each
/// resolved target that does not exist in the page cache, report an issue.
///
/// Skips external URLs (http/https) and anchor-only links (`#fragment`).
pub fn check_broken_links(
    pages: &[Page],
    cache: &HashMap<String, Page>,
) -> Vec<Issue> {
    let mut issues = Vec::new();

    for page in pages {
        // Markdown links in body.
        for (link_text, raw_target) in extract_markdown_links(&page.body) {
            if let Some(resolved) = resolve_target(&raw_target)
                && !cache.contains_key(&resolved)
            {
                issues.push(Issue {
                    page: page.rel.clone(),
                    category: "target_not_found".to_string(),
                    details: serde_json::json!({
                        "link_text": link_text,
                        "target_path": resolved,
                    })
                    .to_string(),
                });
            }
        }
    }

    issues.sort_by(|a, b| a.page.cmp(&b.page));
    issues
}

// ---------------------------------------------------------------------------
// 2. check_orphan_pages
// ---------------------------------------------------------------------------

/// Find pages with zero inbound links that are also not listed in any
/// `index.md` (bundle root or domain index).
///
/// Inbound links are counted from markdown body links (`[text](target.md)`).
///
/// Self-references are excluded from the inbound count.  Links from meta
/// files (index.md, SCHEMA.md, etc.) are naturally excluded because they are
/// not part of the `pages` slice.
pub fn check_orphan_pages(pages: &[Page], wiki_dir: &Path) -> Vec<Issue> {
    // Build inbound link count (excluding self-references).
    let mut inbound: HashMap<String, usize> = HashMap::new();

    for page in pages {
        // Markdown links.
        for (_, raw_target) in extract_markdown_links(&page.body) {
            if let Some(resolved) = resolve_target(&raw_target)
                && resolved != page.rel
            {
                *inbound.entry(resolved).or_insert(0) += 1;
            }
        }
    }

    // A page counts as indexed when listed by any index.md.  Each index
    // resolves its links relative to its own directory, so a domain index
    // covers its pages even though the bundle root index lists only the
    // domain (progressive disclosure).
    let indexed: HashSet<String> =
        wiki::collect_index_entries(wiki_dir).into_iter().flatten().collect();

    // Identify orphans.
    let mut issues: Vec<Issue> = Vec::new();
    for page in pages {
        let inbound_count = inbound.get(&page.rel).copied().unwrap_or(0);
        let in_index = indexed.contains(&page.rel);

        if inbound_count == 0 && !in_index {
            issues.push(Issue {
                page: page.rel.clone(),
                category: "orphan".to_string(),
                details: serde_json::json!({
                    "inbound_links": inbound_count,
                    "in_index": in_index,
                })
                .to_string(),
            });
        }
    }

    issues.sort_by(|a, b| a.page.cmp(&b.page));
    issues
}

// ---------------------------------------------------------------------------
// 3. check_sparse_pages
// ---------------------------------------------------------------------------

/// Flag pages whose body (after stripping frontmatter) has fewer than
/// `SPARSE_BODY_CHARS` (50) characters.
///
/// This includes completely empty pages (`body_length == 0`).
pub fn check_sparse_pages(pages: &[Page]) -> Vec<Issue> {
    let mut issues = Vec::new();

    for page in pages {
        let body_len = page.body.trim().chars().count();
        if body_len < SPARSE_BODY_CHARS {
            issues.push(Issue {
                page: page.rel.clone(),
                category: "sparse".to_string(),
                details: serde_json::json!({
                    "body_length": body_len,
                    "threshold": SPARSE_BODY_CHARS,
                })
                .to_string(),
            });
        }
    }

    issues.sort_by(|a, b| a.page.cmp(&b.page));
    issues
}

// ---------------------------------------------------------------------------
// 4. check_freshness
// ---------------------------------------------------------------------------

/// Freshness lint issues, split by report category.
///
/// A page judged stale for time decay or a newer source lands in `stale`;
/// an unreviewed supersede lands in `cascade_stale`.  A page can appear in
/// both when several reasons apply.
#[derive(Debug, Default)]
pub struct FreshnessIssues {
    pub stale: Vec<Issue>,
    pub cascade_stale: Vec<Issue>,
}

/// Project the unified freshness judgment onto lint issues.
///
/// Thresholds, exemptions, and reason semantics live in
/// [`crate::freshness`]; this function only turns the verdict into the
/// report categories the CLI gates on.
pub fn check_freshness(
    pages: &[Page],
    wiki_dir: &Path,
    bundles: &wiki::BundleSet,
    reference_date: NaiveDate,
) -> FreshnessIssues {
    let reverse_index =
        backlinks::build_reverse_index(wiki_dir, pages, bundles);
    let ctx = freshness::FreshnessContext::new(pages, reference_date)
        .with_reverse_index(&reverse_index);

    let mut result = FreshnessIssues::default();

    for page in pages {
        let Some(verdict) = ctx.judge(page) else {
            continue;
        };
        if !verdict.is_stale() {
            continue;
        }

        let reasons: Vec<&str> =
            verdict.reasons().iter().map(|r| r.as_str()).collect();

        let time_or_source = verdict.reasons().iter().any(|r| {
            matches!(r, StaleReason::TimeExpired | StaleReason::SourceNewer)
        });
        if time_or_source {
            let last_validated = page
                .frontmatter
                .get("last_validated")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            result.stale.push(Issue {
                page: page.rel.clone(),
                category: "stale".to_string(),
                details: serde_json::json!({
                    "last_validated": last_validated,
                    "reasons": &reasons,
                })
                .to_string(),
            });
        }

        if verdict.reasons().contains(&StaleReason::UnreviewedSupersede) {
            result.cascade_stale.push(Issue {
                page: page.rel.clone(),
                category: "cascade_stale".to_string(),
                details: serde_json::json!({
                    "reasons": &reasons,
                    "superseded_pages": ctx.cited_superseded(&page.rel),
                })
                .to_string(),
            });
        }
    }

    result.stale.sort_by(|a, b| a.page.cmp(&b.page));
    result.cascade_stale.sort_by(|a, b| a.page.cmp(&b.page));
    result
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/// Run all lint checks against a given root directory.
pub fn run_all(root: &Path) -> LintResults {
    let paths = wiki::all_wiki_pages_at(root);
    let cache = wiki::page_cache_at(&paths, root);
    let pages: Vec<Page> = cache.values().cloned().collect();
    let bundles = wiki::BundleSet::discover(root);

    let reference_date = chrono::Local::now().date_naive();
    let freshness_issues =
        check_freshness(&pages, root, &bundles, reference_date);

    LintResults {
        broken_links: check_broken_links(&pages, &cache),
        orphan_pages: check_orphan_pages(&pages, root),
        sparse_pages: check_sparse_pages(&pages),
        stale_pages: freshness_issues.stale,
        cascade_stale: freshness_issues.cascade_stale,
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::Value;

    /// An empty bundle set for a plain (non-aggregated) root.
    fn no_bundles() -> wiki::BundleSet {
        wiki::BundleSet::default()
    }
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test-lint").join(name);
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

    /// Build a `Page` from content with frontmatter.
    fn make_page(rel: &str, content: &str) -> Page {
        let wiki_dir = wiki::wiki_dir();
        let path = wiki_dir.join(rel);
        let frontmatter = wiki::parse_frontmatter(content);
        let body = wiki::strip_frontmatter(content);
        Page {
            path,
            rel: rel.to_string(),
            frontmatter,
            body,
            raw: content.to_string(),
        }
    }

    /// Create a temp wiki directory and return (`wiki_dir`, pages, cache).
    fn setup_wiki(
        dir_name: &str,
        files: &[(&str, &str)],
    ) -> (PathBuf, Vec<Page>, HashMap<String, Page>) {
        let dir = temp_dir(dir_name);
        for (rel_path, content) in files {
            let path = dir.join(rel_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(&path, content).unwrap();
        }

        // Build pages and cache from discovered files.
        let mut pages: Vec<Page> = Vec::new();
        let mut cache: HashMap<String, Page> = HashMap::new();

        for (rel_path, content) in files {
            let path = dir.join(rel_path);
            let frontmatter = wiki::parse_frontmatter(content);
            let body = wiki::strip_frontmatter(content);
            let rel = rel_path.to_string();
            let page = Page {
                path,
                rel: rel.clone(),
                frontmatter,
                body,
                raw: content.to_string(),
            };
            cache.insert(rel.clone(), page.clone());
            pages.push(page);
        }

        (dir, pages, cache)
    }

    // =======================================================================
    // 1. check_broken_links
    // =======================================================================

    #[test]
    fn test_broken_links_detects_missing_target() {
        // Page A links to page B (non-existent) — should flag.
        let (_, pages, cache) = setup_wiki(
            "broken_missing_target",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\n---\nSee [page b](page-b.md) for details.\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "concepts/page-a.md");
        assert_eq!(issues[0].category, "target_not_found");
        let details: Value = serde_json::from_str(&issues[0].details).unwrap();
        assert_eq!(details["link_text"], "page b");
        assert!(details["target_path"].as_str().unwrap().contains("page-b.md"));
    }

    #[test]
    fn test_broken_links_valid_link_passes() {
        // Page A links to page B with wiki-root-relative path — no issue.
        let (_, pages, cache) = setup_wiki(
            "broken_valid",
            &[
                (
                    "concepts/page-a.md",
                    "---\ntitle: Page A\n---\nSee [page b](concepts/page-b.md).\n",
                ),
                (
                    "concepts/page-b.md",
                    "---\ntitle: Page B\n---\nBody content.\n",
                ),
            ],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(issues.is_empty(), "expected no broken links for valid target");
    }

    #[test]
    fn test_broken_links_wiki_prefix_stripped() {
        // Link with `wiki/` prefix should be stripped.
        let (_, pages, cache) = setup_wiki(
            "broken_wiki_prefix",
            &[
                (
                    "concepts/page-a.md",
                    "---\ntitle: Page A\n---\nSee [page b](wiki/concepts/page-b.md).\n",
                ),
                ("concepts/page-b.md", "---\ntitle: Page B\n---\nBody.\n"),
            ],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(
            issues.is_empty(),
            "wiki/ prefix should be stripped and link resolved"
        );
    }

    #[test]
    fn test_broken_links_external_urls_ignored() {
        let (_, pages, cache) = setup_wiki(
            "broken_external",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\n---\nSee [example](https://example.com).\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(issues.is_empty(), "external URLs should be ignored");
    }

    #[test]
    fn test_broken_links_anchor_only_ignored() {
        let (_, pages, cache) = setup_wiki(
            "broken_anchor",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\n---\nSee [section](#intro).\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(issues.is_empty(), "anchor-only links should be ignored");
    }

    #[test]
    fn test_broken_links_cross_bundle_skipped() {
        // @name/path cross-bundle references should not be flagged.
        let (_, pages, cache) = setup_wiki(
            "broken_cross_bundle",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\n---\n\
                     See [core](@core/concepts/foo.md) and \
                     [vendor](@vendor/bar.md).\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(
            issues.is_empty(),
            "@name/path cross-bundle references should be skipped"
        );
    }

    // =======================================================================
    // 2. check_orphan_pages
    // =======================================================================

    #[test]
    fn test_orphan_pages_detected() {
        // Page C exists but no page links to it and it is not in index.md.
        let dir = temp_dir("orphan_detected");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Page A](page-a.md)\n[Page B](page-b.md)\n",
        );
        write(
            &dir.join("page-a.md"),
            "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
        );
        write(&dir.join("page-b.md"), "---\ntitle: Page B\n---\nBody.\n");
        write(
            &dir.join("page-c.md"),
            "---\ntitle: Page C\n---\nOrphan content.\n",
        );

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
            ),
            ("page-b.md", "---\ntitle: Page B\n---\nBody.\n"),
            ("page-c.md", "---\ntitle: Page C\n---\nOrphan content.\n"),
        ];
        let (_, pages, _) = setup_wiki("orphan_detected_inner", all_files);
        // Use the dir we created manually with index.md.
        let issues = check_orphan_pages(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "page-c.md");
        assert_eq!(issues[0].category, "orphan");
    }

    #[test]
    fn test_orphan_pages_non_orphan_passes() {
        // Page B has inbound link from page A — not orphan.
        let dir = temp_dir("orphan_non_orphan");
        write(&dir.join("index.md"), "# Index\n\n[Page A](page-a.md)\n");
        write(
            &dir.join("page-a.md"),
            "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
        );
        write(&dir.join("page-b.md"), "---\ntitle: Page B\n---\nBody.\n");

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
            ),
            ("page-b.md", "---\ntitle: Page B\n---\nBody.\n"),
        ];
        let (_, pages, _) = setup_wiki("orphan_non_orphan_inner", all_files);
        let issues = check_orphan_pages(&pages, &dir);
        assert!(
            issues.is_empty(),
            "page-b has inbound link, should not be orphan"
        );
    }

    #[test]
    fn test_orphan_pages_in_index_exempt() {
        // Page C has no inbound links but is listed in index.md — exempt.
        let dir = temp_dir("orphan_in_index");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Page A](page-a.md)\n[Page C](page-c.md)\n",
        );
        write(
            &dir.join("page-a.md"),
            "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
        );
        write(&dir.join("page-b.md"), "---\ntitle: Page B\n---\nBody.\n");
        write(&dir.join("page-c.md"), "---\ntitle: Page C\n---\nContent.\n");

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\n---\nSee [page b](page-b.md).\n",
            ),
            ("page-b.md", "---\ntitle: Page B\n---\nBody.\n"),
            ("page-c.md", "---\ntitle: Page C\n---\nContent.\n"),
        ];
        let (_, pages, _) = setup_wiki("orphan_in_index_inner", all_files);
        let issues = check_orphan_pages(&pages, &dir);
        assert!(
            issues.is_empty(),
            "page-c is in index.md so should not be orphan"
        );
    }

    #[test]
    fn test_orphan_pages_domain_index_exempt() {
        // A page listed only in its domain index.md is covered even though
        // the bundle root index lists just the domain.
        let dir = temp_dir("orphan_domain_index");
        write(&dir.join("index.md"), "# Index\n\n[Alpha](alpha/index.md)\n");
        write(&dir.join("alpha/index.md"), "# Alpha\n\n[Foo](foo.md)\n");
        write(
            &dir.join("alpha/foo.md"),
            "---\ntitle: Foo\n---\nBody content.\n",
        );

        let files =
            &[("alpha/foo.md", "---\ntitle: Foo\n---\nBody content.\n")];
        let (_, pages, _) = setup_wiki("orphan_domain_index_inner", files);
        let issues = check_orphan_pages(&pages, &dir);
        assert!(
            issues.is_empty(),
            "page listed in its domain index should not be orphan: {issues:?}"
        );
    }

    #[test]
    fn test_orphan_pages_unindexed_still_flagged() {
        // A page absent from every index.md and without inbound links is
        // still an orphan, even when a sibling is listed in the domain
        // index.
        let dir = temp_dir("orphan_unindexed");
        write(&dir.join("index.md"), "# Index\n\n[Alpha](alpha/index.md)\n");
        write(&dir.join("alpha/index.md"), "# Alpha\n\n[Foo](foo.md)\n");
        write(
            &dir.join("alpha/foo.md"),
            "---\ntitle: Foo\n---\nBody content.\n",
        );
        write(
            &dir.join("alpha/bar.md"),
            "---\ntitle: Bar\n---\nUnowned content.\n",
        );

        let files = &[
            ("alpha/foo.md", "---\ntitle: Foo\n---\nBody content.\n"),
            ("alpha/bar.md", "---\ntitle: Bar\n---\nUnowned content.\n"),
        ];
        let (_, pages, _) = setup_wiki("orphan_unindexed_inner", files);
        let issues = check_orphan_pages(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "alpha/bar.md");
        assert_eq!(issues[0].category, "orphan");
    }

    // =======================================================================
    // 3. check_sparse_pages
    // =======================================================================

    #[test]
    fn test_sparse_pages_below_threshold_flagged() {
        let pages = vec![make_page(
            "concepts/sparse.md",
            "---\ntitle: Sparse\n---\nShort.\n",
        )];
        let issues = check_sparse_pages(&pages);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "concepts/sparse.md");
        assert_eq!(issues[0].category, "sparse");
    }

    #[test]
    fn test_sparse_pages_at_threshold_passes() {
        // Exactly 50 characters after frontmatter.
        let body = "A".repeat(50);
        let pages = vec![make_page(
            "concepts/ok.md",
            &format!("---\ntitle: OK\n---\n{body}"),
        )];
        let issues = check_sparse_pages(&pages);
        assert!(issues.is_empty(), "exactly 50 chars should pass threshold");
    }

    #[test]
    fn test_sparse_pages_empty_body_flagged() {
        let pages =
            vec![make_page("concepts/empty.md", "---\ntitle: Empty\n---")];
        let issues = check_sparse_pages(&pages);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "concepts/empty.md");
    }

    #[test]
    fn test_sparse_pages_long_body_not_flagged() {
        let body = "A".repeat(200);
        let pages = vec![make_page(
            "concepts/long.md",
            &format!("---\ntitle: Long\n---\n{body}"),
        )];
        let issues = check_sparse_pages(&pages);
        assert!(issues.is_empty(), "long body should pass");
    }

    // =======================================================================
    // 4. check_freshness — stale projection
    // =======================================================================

    fn reference_date() -> NaiveDate {
        NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap()
    }

    #[test]
    fn test_freshness_time_expired_flagged() {
        let (dir, pages, _) = setup_wiki(
            "freshness_stale",
            &[(
                "concepts/old.md",
                "---\ntitle: Old\ntype: concept\nstatus: stable\n\
                 last_validated: 2024-06-01\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert_eq!(result.stale.len(), 1);
        assert_eq!(result.stale[0].page, "concepts/old.md");
        assert_eq!(result.stale[0].category, "stale");
        let details: Value =
            serde_json::from_str(&result.stale[0].details).unwrap();
        assert_eq!(details["last_validated"], "2024-06-01");
        assert_eq!(details["reasons"][0], "time_expired");
    }

    #[test]
    fn test_freshness_deprecated_exempt() {
        let (dir, pages, _) = setup_wiki(
            "freshness_deprecated",
            &[(
                "concepts/deprecated.md",
                "---\ntitle: Dep\ntype: concept\nstatus: deprecated\n\
                 last_validated: 2020-01-01\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert!(result.stale.is_empty(), "deprecated pages should be exempt");
    }

    #[test]
    fn test_freshness_recent_not_flagged() {
        let (dir, pages, _) = setup_wiki(
            "freshness_recent",
            &[(
                "concepts/recent.md",
                "---\ntitle: Recent\ntype: concept\nstatus: stable\n\
                 last_validated: 2024-12-15\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert!(result.stale.is_empty(), "recent page should pass");
    }

    #[test]
    fn test_freshness_missing_last_validated_skipped() {
        let (dir, pages, _) = setup_wiki(
            "freshness_no_lv",
            &[(
                "concepts/notsure.md",
                "---\ntitle: No LV\ntype: concept\nstatus: draft\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert!(result.stale.is_empty(), "page without last_validated skips");
    }

    #[test]
    fn test_freshness_invalid_last_validated_skipped() {
        let (dir, pages, _) = setup_wiki(
            "freshness_bad_lv",
            &[(
                "concepts/baddate.md",
                "---\ntitle: Bad Date\ntype: concept\nstatus: draft\n\
                 last_validated: not-a-date\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert!(result.stale.is_empty(), "invalid date should be skipped");
    }

    #[test]
    fn test_freshness_old_timestamp_new_validation_is_fresh() {
        // Core regression: an old `timestamp` must not stale a page whose
        // `last_validated` is recent.
        let (dir, pages, _) = setup_wiki(
            "freshness_old_ts",
            &[(
                "concepts/validated.md",
                "---\ntitle: Validated\ntype: concept\nstatus: stable\n\
                 timestamp: 2020-01-01\n\
                 last_validated: 2024-12-30\n---\nBody.\n",
            )],
        );
        let result =
            check_freshness(&pages, &dir, &no_bundles(), reference_date());
        assert!(
            result.stale.is_empty(),
            "recent validation must keep the page fresh"
        );
    }

    #[test]
    fn test_freshness_source_newer_flags_analysis() {
        let reference =
            NaiveDate::parse_from_str("2025-06-01", "%Y-%m-%d").unwrap();
        let (dir, pages, _) = setup_wiki(
            "freshness_source_newer",
            &[
                (
                    "shared/sources/bar.md",
                    "---\ntitle: Bar\ntype: source\ntimestamp: 2025-05-01\n---\nBody.\n",
                ),
                (
                    "shared/analysis/foo.md",
                    "---\ntitle: Foo\ntype: analysis\nstatus: draft\n\
                     sources: [shared/sources/bar.md]\n\
                     last_validated: 2025-04-01\n---\nBody.\n",
                ),
            ],
        );
        let result = check_freshness(&pages, &dir, &no_bundles(), reference);
        assert_eq!(result.stale.len(), 1);
        assert_eq!(result.stale[0].page, "shared/analysis/foo.md");
        let details: Value =
            serde_json::from_str(&result.stale[0].details).unwrap();
        assert_eq!(details["reasons"][0], "source_newer");
    }

    // =======================================================================
    // 5. check_freshness — cascade_stale projection
    // =======================================================================

    #[test]
    fn test_cascade_stale_referrer_flagged() {
        // Superseded page with `last_validated`, referrer with older
        // `last_validated` → 1 cascade issue.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_flagged",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\nstatus: stable\n\
                     last_validated: 2023-12-01T00:00:00Z\n---\n\
                     # Referrer\n\nSee [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\nstatus: stable\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert_eq!(result.cascade_stale.len(), 1);
        assert_eq!(result.cascade_stale[0].page, "shared/concepts/referrer.md");
        assert_eq!(result.cascade_stale[0].category, "cascade_stale");
        let details: Value =
            serde_json::from_str(&result.cascade_stale[0].details).unwrap();
        assert_eq!(details["superseded_pages"][0], "shared/concepts/old.md");
        let reasons = details["reasons"].as_array().unwrap();
        assert!(
            reasons.iter().any(|r| r == "unreviewed_supersede"),
            "cascade issue must carry the unreviewed_supersede reason"
        );
    }

    #[test]
    fn test_cascade_stale_reviewed_not_flagged() {
        // Superseded page with `last_validated`, referrer reviewed after it
        // → no cascade issue.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_reviewed",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\nstatus: stable\n\
                     last_validated: 2024-06-01T00:00:00Z\n---\n\
                     # Referrer\n\nSee [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\nstatus: stable\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "referrer reviewed after supersedure should not be flagged"
        );
    }

    #[test]
    fn test_cascade_stale_superseding_page_excluded() {
        // Superseding page itself references the old page → excluded.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_excluded",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\nstatus: stable\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n# New\n\n\
                     See [old](shared/concepts/old.md).\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "superseding page itself should be excluded"
        );
    }

    #[test]
    fn test_cascade_stale_superseded_without_lv_still_flags() {
        // Superseded page without `last_validated` cannot be compared, so a
        // validated referrer is still flagged.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_no_lv",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\nstatus: stable\n\
                     last_validated: 2023-12-01T00:00:00Z\n---\n\
                     # Referrer\n\nSee [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\nstatus: stable\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert_eq!(result.cascade_stale.len(), 1);
        assert_eq!(result.cascade_stale[0].category, "cascade_stale");
    }

    #[test]
    fn test_cascade_stale_unvalidated_referrer_skipped() {
        // A referrer without `last_validated` does not participate at all.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_no_ref_lv",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\nstatus: stable\n---\n# Referrer\n\n\
                     See [old](shared/concepts/old.md).\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "referrer without last_validated is skipped"
        );
    }

    #[test]
    fn test_cascade_stale_no_referrers() {
        // No pages reference the superseded page → no cascade issue.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_no_refs",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\nstatus: stable\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\nstatus: stable\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let result =
            check_freshness(&pages, &wiki_dir, &no_bundles(), reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "no referrers should produce no issues"
        );
    }
}
