//! Deep structural checks for broken links, orphans, sparse and stale pages.
//!
//! Each check scans wiki pages and returns issues.  Results are aggregated
//! by `run_all()` into a `LintResults` for display.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use regex::Regex;
use serde_json::Value;

use crate::backlinks;
use crate::display::{Issue, LintResults};
use crate::wiki::{self, Page};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum body character count (after stripping frontmatter) before a page
/// is considered non-sparse.
const SPARSE_BODY_CHARS: usize = 50;

/// Number of days since last update before a page is considered stale.
const STALE_DAYS: i64 = 90;

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

/// Extract wiki-page links from the frontmatter `relations` field.
///
/// Only returns targets ending in `.md`.
fn extract_related_links(frontmatter: &HashMap<String, Value>) -> Vec<String> {
    let mut links = Vec::new();
    if let Some(related) = frontmatter.get("relations") {
        match related {
            Value::String(s)
                if Path::new(s)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md")) =>
            {
                links.push(s.clone());
            }
            Value::Array(arr) => {
                for v in arr {
                    if let Some(s) = v.as_str()
                        && Path::new(s)
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                    {
                        links.push(s.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    links
}

// ---------------------------------------------------------------------------
// 1. check_broken_links
// ---------------------------------------------------------------------------

/// Scan each page's body for markdown links `[text](target.md)` and
/// frontmatter `relations` links.  For each resolved target that does not
/// exist in the page cache, report an issue.
///
/// Skips external URLs (http/https) and anchor-only links (`#fragment`).
pub fn check_broken_links(
    pages: &[Page],
    cache: &HashMap<String, Page>,
) -> Vec<Issue> {
    let mut issues = Vec::new();

    for page in pages {
        // 1a. Markdown links in body.
        for (link_text, raw_target) in extract_markdown_links(&page.body) {
            if let Some(resolved) = resolve_target(&raw_target)
                && !cache.contains_key(&resolved)
            {
                issues.push(Issue {
                    page: page.rel.clone(),
                    kind: "target_not_found".to_string(),
                    details: serde_json::json!({
                        "link_text": link_text,
                        "target_path": resolved,
                    })
                    .to_string(),
                });
            }
        }

        // 1b. Frontmatter `relations` links.
        for related_target in extract_related_links(&page.frontmatter) {
            if let Some(resolved) = resolve_target(&related_target)
                && !cache.contains_key(&resolved)
            {
                issues.push(Issue {
                    page: page.rel.clone(),
                    kind: "target_not_found".to_string(),
                    details: serde_json::json!({
                        "link_text": "relations",
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

/// Find pages with zero inbound links that are also not listed in
/// `wiki/index.md`.
///
/// Inbound links are counted from:
/// - Markdown body links (`[text](target.md)`)
/// - Frontmatter `relations` links
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
        // Frontmatter relations links.
        for related_target in extract_related_links(&page.frontmatter) {
            if let Some(resolved) = resolve_target(&related_target)
                && resolved != page.rel
            {
                *inbound.entry(resolved).or_insert(0) += 1;
            }
        }
    }

    // Parse index.md for listed page paths.
    let index_content = wiki::read_file(&wiki_dir.join("index.md"));
    let index_links = wiki::parse_index_links(&index_content);

    // Resolve index links to wiki-relative paths.
    let index_rel_paths: HashSet<String> = index_links
        .iter()
        .map(|link| {
            // Index links are wiki-root-relative; resolve from root.
            let normalized = normalize_path(Path::new(link));
            normalized.to_string_lossy().to_string()
        })
        .collect();

    // Identify orphans.
    let mut issues: Vec<Issue> = Vec::new();
    for page in pages {
        let inbound_count = inbound.get(&page.rel).copied().unwrap_or(0);
        let in_index = index_rel_paths.contains(&page.rel);

        if inbound_count == 0 && !in_index {
            issues.push(Issue {
                page: page.rel.clone(),
                kind: "orphan".to_string(),
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
                kind: "sparse".to_string(),
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
// 4. check_stale_pages
// ---------------------------------------------------------------------------

/// Find pages whose `timestamp` field is more than `STALE_DAYS` (90) days
/// before `reference_date` and whose `status` is not `"deprecated"`.
///
/// Pages without a `timestamp` or with an invalid/unparseable date are
/// silently skipped.
pub fn check_stale_pages(
    pages: &[Page],
    reference_date: NaiveDate,
) -> Vec<Issue> {
    let mut issues = Vec::new();

    for page in pages {
        // Extract timestamp — skip if missing.
        let timestamp_str = match page.frontmatter.get("timestamp") {
            Some(Value::String(s)) => s.clone(),
            _ => continue,
        };

        // Parse timestamp — skip if invalid.
        let Some(timestamp_date) = wiki::parse_date(&timestamp_str) else {
            continue;
        };

        // Skip deprecated pages.
        let status = page
            .frontmatter
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if status == "deprecated" {
            continue;
        }

        let days_since = (reference_date - timestamp_date).num_days();
        if days_since > STALE_DAYS {
            issues.push(Issue {
                page: page.rel.clone(),
                kind: "stale".to_string(),
                details: serde_json::json!({
                    "timestamp": timestamp_str,
                    "status": status,
                    "days_since_update": days_since,
                })
                .to_string(),
            });
        }
    }

    issues.sort_by(|a, b| a.page.cmp(&b.page));
    issues
}

// ---------------------------------------------------------------------------
// 5. check_cascade_stale
// ---------------------------------------------------------------------------

/// Find pages that reference a superseded page but have not been reviewed
/// (i.e. their `last_validated` is older than or equal to the superseded
/// page's `last_validated`).
///
/// Uses the backlinks reverse index to discover referrers.  Pages whose
/// `last_validated` is *newer* than the superseded page's `last_validated`
/// are considered already reviewed and are NOT flagged.
///
/// The superseding page itself (linked via `superseded_by`) is always
/// excluded from results — its backlink to the old page is expected.
pub fn check_cascade_stale(pages: &[Page], wiki_dir: &Path) -> Vec<Issue> {
    let reverse_index = backlinks::build_reverse_index(wiki_dir, pages);

    // Map rel → page for quick lookup.
    let page_map: HashMap<String, &Page> =
        pages.iter().map(|p| (p.rel.clone(), p)).collect();

    let mut issues = Vec::new();

    for page in pages {
        // Find pages that have been superseded (superseded_by field).
        let superseded_by_paths: Vec<String> =
            match page.frontmatter.get("superseded_by") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|item| {
                        // Try object format first: {"path": "..."}
                        item.as_object()
                            .and_then(|obj| {
                                obj.get("path").and_then(|v| v.as_str())
                            })
                            .map(str::to_string)
                            // Fallback to string format: "path: <value>"
                            .or_else(|| {
                                item.as_str()
                                    .and_then(|s| s.strip_prefix("path: "))
                                    .map(str::to_string)
                            })
                    })
                    .collect(),
                _ => continue,
            };

        if superseded_by_paths.is_empty() {
            continue;
        }

        // Collect all superseding-page paths for exclusion.
        let superseding_paths: HashSet<&str> =
            superseded_by_paths.iter().map(String::as_str).collect();

        // Reference timestamp: the superseded page's last_validated
        // string.  Compared as raw ISO 8601 strings (which sort
        // correctly) because NaiveDate would lose time-of-day
        // precision — two timestamps on the same calendar day would
        // compare equal.
        let sup_lv_str =
            page.frontmatter.get("last_validated").and_then(|v| v.as_str());

        // Look up referrers in the reverse index.
        if let Some(referrers) = reverse_index.get(&page.rel) {
            'referrer: for referrer_rel in referrers {
                // Skip the superseding pages themselves.
                if superseding_paths.contains(referrer_rel.as_str()) {
                    continue;
                }

                // If the superseded page has a known last_validated,
                // check whether the referrer was reviewed after that
                // timestamp.
                if let Some(sup_lv) = sup_lv_str
                    && let Some(referrer_page) = page_map.get(referrer_rel)
                    && let Some(r_lv) = referrer_page
                        .frontmatter
                        .get("last_validated")
                        .and_then(|v| v.as_str())
                    && r_lv > sup_lv
                {
                    // Referrer was already reviewed post-
                    // supersedure — do not flag.
                    continue 'referrer;
                }

                issues.push(Issue {
                    page: referrer_rel.clone(),
                    kind: "cascade_stale".to_string(),
                    details: serde_json::json!({
                        "superseded_page": page.rel,
                        "superseded_by": superseded_by_paths.join(", "),
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
// Orchestrator
// ---------------------------------------------------------------------------

/// Run all lint checks against a given root directory.
pub fn run_all(root: &Path) -> LintResults {
    let paths = wiki::all_wiki_pages_at(root);
    let cache = wiki::page_cache_at(&paths, root);
    let pages: Vec<Page> = cache.values().cloned().collect();

    let reference_date = chrono::Local::now().date_naive();

    LintResults {
        broken_links: check_broken_links(&pages, &cache),
        orphan_pages: check_orphan_pages(&pages, root),
        sparse_pages: check_sparse_pages(&pages),
        stale_pages: check_stale_pages(&pages, reference_date),
        cascade_stale: check_cascade_stale(&pages, root),
    }
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
        assert_eq!(issues[0].kind, "target_not_found");
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
                     [upstream](@upstream/bar.md).\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert!(
            issues.is_empty(),
            "@name/path cross-bundle references should be skipped"
        );
    }

    #[test]
    fn test_broken_links_related_broken() {
        // Frontmatter `relations` pointing to non-existent page.
        let (_, pages, cache) = setup_wiki(
            "broken_related",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\nrelations: [nonexistent.md]\n---\nBody.\n",
            )],
        );
        let issues = check_broken_links(&pages, &cache);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "target_not_found");
        let details: Value = serde_json::from_str(&issues[0].details).unwrap();
        assert_eq!(details["link_text"], "relations");
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
        assert_eq!(issues[0].kind, "orphan");
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
        assert_eq!(issues[0].kind, "sparse");
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
    // 4. check_stale_pages
    // =======================================================================

    #[test]
    fn test_stale_pages_old_timestamp_flagged() {
        let reference =
            NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap();
        let pages = vec![make_page(
            "concepts/old.md",
            "---\ntitle: Old\ntimestamp: 2024-06-01\nstatus: stable\n---\nBody.\n",
        )];
        let issues = check_stale_pages(&pages, reference);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "concepts/old.md");
        assert_eq!(issues[0].kind, "stale");
    }

    #[test]
    fn test_stale_pages_deprecated_exempt() {
        let reference =
            NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap();
        let pages = vec![make_page(
            "concepts/deprecated.md",
            "---\ntitle: Dep\ntimestamp: 2024-01-01\nstatus: deprecated\n---\nBody.\n",
        )];
        let issues = check_stale_pages(&pages, reference);
        assert!(issues.is_empty(), "deprecated pages should be exempt");
    }

    #[test]
    fn test_stale_pages_recent_not_flagged() {
        let reference =
            NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap();
        let pages = vec![make_page(
            "concepts/recent.md",
            "---\ntitle: Recent\ntimestamp: 2024-12-15\nstatus: stable\n---\nBody.\n",
        )];
        let issues = check_stale_pages(&pages, reference);
        assert!(issues.is_empty(), "recent page should not be flagged");
    }

    #[test]
    fn test_stale_pages_no_timestamp_skipped() {
        let reference =
            NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap();
        let pages = vec![make_page(
            "concepts/notsure.md",
            "---\ntitle: No TS\nstatus: draft\n---\nBody.\n",
        )];
        let issues = check_stale_pages(&pages, reference);
        assert!(issues.is_empty(), "page without timestamp should be skipped");
    }

    #[test]
    fn test_stale_pages_invalid_date_skipped() {
        let reference =
            NaiveDate::parse_from_str("2025-01-01", "%Y-%m-%d").unwrap();
        let pages = vec![make_page(
            "concepts/baddate.md",
            "---\ntitle: Bad Date\ntimestamp: not-a-date\nstatus: draft\n---\nBody.\n",
        )];
        let issues = check_stale_pages(&pages, reference);
        assert!(issues.is_empty(), "page with invalid date should be skipped");
    }

    // =======================================================================
    // 5. check_cascade_stale
    // =======================================================================

    #[test]
    fn test_cascade_stale_referrer_flagged() {
        // Superseded page with `last_validated`, referrer with older
        // `last_validated` → 1 issue.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_flagged",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\n\
                     last_validated: 2023-12-01T00:00:00Z\n---\n\
                     # Referrer\n\nSee [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let issues = check_cascade_stale(&pages, &wiki_dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "shared/concepts/referrer.md");
        assert_eq!(issues[0].kind, "cascade_stale");
        let details: Value = serde_json::from_str(&issues[0].details).unwrap();
        assert_eq!(details["superseded_page"], "shared/concepts/old.md");
        assert_eq!(details["superseded_by"], "shared/concepts/new.md");
    }

    #[test]
    fn test_cascade_stale_reviewed_not_flagged() {
        // Superseded page with `last_validated`, referrer with newer
        // `last_validated` → 0 issues.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_reviewed",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\n\
                     last_validated: 2024-06-01T00:00:00Z\n---\n\
                     # Referrer\n\nSee [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let issues = check_cascade_stale(&pages, &wiki_dir);
        assert!(
            issues.is_empty(),
            "referrer with newer last_validated should not be flagged"
        );
    }

    #[test]
    fn test_cascade_stale_superseding_page_excluded() {
        // Superseding page itself references the old page → 0 issues
        // (superseding page is always excluded from results).
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_excluded",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\n---\n# New\n\n\
                     See [old](shared/concepts/old.md).\n",
                ),
            ],
        );
        let issues = check_cascade_stale(&pages, &wiki_dir);
        assert!(
            issues.is_empty(),
            "superseding page itself should be excluded"
        );
    }

    #[test]
    fn test_cascade_stale_no_last_validated_fallback() {
        // Superseded page without `last_validated` → referrer still
        // flagged (no timestamp to compare against).
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_no_lv",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\n\
                     superseded_by: [path: shared/concepts/new.md]\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/referrer.md",
                    "---\ntitle: Referrer\n---\n# Referrer\n\n\
                     See [old](shared/concepts/old.md).\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let issues = check_cascade_stale(&pages, &wiki_dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "cascade_stale");
    }

    #[test]
    fn test_cascade_stale_no_referrers() {
        // No pages reference the superseded page → 0 issues.
        let (wiki_dir, pages, _) = setup_wiki(
            "cascade_no_refs",
            &[
                (
                    "shared/concepts/old.md",
                    "---\ntitle: Old\n\
                     superseded_by: [path: shared/concepts/new.md]\n\
                     last_validated: 2024-01-01T00:00:00Z\n---\n\
                     # Old\n\nContent.\n",
                ),
                (
                    "shared/concepts/new.md",
                    "---\ntitle: New\n---\n# New\n\nContent.\n",
                ),
            ],
        );
        let issues = check_cascade_stale(&pages, &wiki_dir);
        assert!(issues.is_empty(), "no referrers should produce no issues");
    }
}
