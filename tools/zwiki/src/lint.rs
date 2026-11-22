//! Deep structural checks for broken links, orphans, sparse and stale pages.
//!
//! Each check scans wiki pages and returns issues.  Results are aggregated
//! by `run_all()` into a `LintResults` for display.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::NaiveDate;
use regex::Regex;
use zwiki::identity::Reference;

use crate::backlinks;
use crate::catalog::{Catalog, Resolution};
use crate::display::{Issue, LintResults};
use crate::freshness::{self, StaleReason};
use crate::wiki::{self, Page, PageSet};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum body character count (after stripping frontmatter) before a page
/// is considered non-sparse.
const SPARSE_BODY_CHARS: usize = 50;

/// The page reference a markdown link target carries.
///
/// Returns `None` for external URLs, anchor-only links and empty targets.
/// Every other target keeps its text and is a bundle-relative path:
/// `Reference::parse` decides whether the text names a page.
fn page_reference(target: &str) -> Option<&str> {
    let target = target.trim();
    if target.is_empty()
        || target.starts_with("http://")
        || target.starts_with("https://")
        || target.starts_with('#')
    {
        return None;
    }
    Some(target)
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

/// Scan each page body for markdown links `[text](target.md)`.  For each
/// link that names no page, report an issue.
///
/// A bare target stays in the referrer's bundle and a `@bundle/path`
/// reference names one bundle; neither is searched across bundles.  Skips
/// external URLs (http/https) and anchor-only links (`#fragment`).  An
/// explicit reference keeps its bundle in `target_path`, so two bundles
/// holding one page path stay distinguishable.
pub fn check_broken_links(set: &PageSet, catalog: &Catalog) -> Vec<Issue> {
    let mut issues = Vec::new();

    for page in set.pages() {
        let Some(referrer) = catalog.id_of(&page.rel) else {
            continue;
        };
        let body = page.document.body.author();
        for (link_text, raw_target) in extract_markdown_links(body) {
            let Some(reference) = page_reference(&raw_target) else {
                continue;
            };
            let Resolution::MissingPage(id) =
                catalog.resolve(referrer, reference)
            else {
                continue;
            };
            let explicit = Reference::parse(reference)
                .is_some_and(|parsed| parsed.bundle().is_some());
            let target_path = if explicit {
                id.to_string()
            } else {
                id.path().as_str().to_string()
            };
            issues.push(Issue {
                page: page.rel.clone(),
                category: "target_not_found".to_string(),
                details: serde_json::json!({
                    "link_text": link_text,
                    "target_path": target_path,
                })
                .to_string(),
            });
        }
    }

    issues
}

// ---------------------------------------------------------------------------
// 2. check_orphan_pages
// ---------------------------------------------------------------------------

/// Find pages with zero inbound links that are also not listed in any
/// `index.md` (bundle root or domain index).
///
/// Inbound links are counted from markdown body links (`[text](target.md)`).
/// Each body target resolves through `catalog` from the referrer's bundle, so
/// a bundle-relative link reaches its page whether the root is the bundle
/// itself or an aggregate above it.
///
/// Self-references are excluded from the inbound count.  Links from meta
/// files (index.md, SCHEMA.md, etc.) are naturally excluded because they are
/// not part of the `pages` slice.
pub fn check_orphan_pages(
    pages: &[Page],
    catalog: &Catalog,
    wiki_dir: &Path,
) -> Vec<Issue> {
    // Build inbound link count (excluding self-references).
    let mut inbound: HashMap<String, usize> = HashMap::new();

    for page in pages {
        let Some(referrer) = catalog.id_of(&page.rel) else {
            continue;
        };
        // Markdown links.
        for (_, raw_target) in
            extract_markdown_links(page.document.body.author())
        {
            let Some(reference) = page_reference(&raw_target) else {
                continue;
            };
            let Some(target) = catalog.resolve_rel(referrer, reference) else {
                continue;
            };
            if target != page.rel.as_str() {
                *inbound.entry(target.to_string()).or_insert(0) += 1;
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
        let body_len = page.document.body.author().trim().chars().count();
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
    catalog: &Catalog,
    reference_date: NaiveDate,
) -> FreshnessIssues {
    // Cascade detection needs the reverse index built from the same
    // snapshot; a rejected page never reaches the lint rules.
    let reverse_index = backlinks::build_reverse_index(catalog, pages);
    let ctx = freshness::FreshnessContext::new(pages, catalog, reference_date)
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
            let last_validated = page.document.metadata.last_validated.as_str();
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
///
/// `set` is the shared page snapshot; a page the document model rejected is
/// absent here and already reported by the health check.
///
/// # Errors
///
/// Fails when the pages carry no bundle identity, as the link and freshness
/// rules resolve every reference through the catalog.
pub fn run_all(root: &Path, set: &PageSet) -> Result<LintResults, String> {
    let pages = set.pages();
    let catalog = Catalog::new(root, set)?;

    let reference_date = chrono::Utc::now().date_naive();
    let freshness_issues = check_freshness(pages, &catalog, reference_date);

    Ok(LintResults {
        broken_links: check_broken_links(set, &catalog),
        orphan_pages: check_orphan_pages(pages, &catalog, root),
        sparse_pages: check_sparse_pages(pages),
        stale_pages: freshness_issues.stale,
        cascade_stale: freshness_issues.cascade_stale,
    })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::{setup_wiki, temp_dir};

    use serde_json::Value;

    /// Project the freshness verdict of pages a test holds in memory.
    fn freshness_at(
        pages: &[Page],
        reference_date: NaiveDate,
    ) -> FreshnessIssues {
        check_freshness(pages, &Catalog::flat(pages), reference_date)
    }
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Build a `Page` from complete page text.
    fn make_page(rel: &str, content: &str) -> Page {
        let document = zwiki::document::PageDocument::parse(content)
            .unwrap_or_else(|e| panic!("invalid fixture {rel}: {e}"));
        Page {
            path: wiki::wiki_dir().join(rel),
            rel: rel.to_string(),
            document,
        }
    }

    /// Mark `dir` as the root of the bundle named `name`.
    fn mark_bundle(dir: &Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("bundle.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n\n\
                 [export]\ninclude = [\"**/*.md\"]\n"
            ),
        )
        .unwrap();
    }

    /// Run the broken-link rule over `dir`.
    fn broken_links_at(dir: &Path) -> Vec<Issue> {
        let set = PageSet::load(dir);
        let catalog = Catalog::new(dir, &set).expect("catalog");
        check_broken_links(&set, &catalog)
    }

    /// Run the orphan rule over pages held in memory.
    fn orphans(pages: &[Page], wiki_dir: &Path) -> Vec<Issue> {
        check_orphan_pages(pages, &Catalog::flat(pages), wiki_dir)
    }

    // =======================================================================
    // 1. check_broken_links
    // =======================================================================

    #[test]
    fn test_broken_links_detects_missing_target() {
        // Page A links to page B (non-existent) — should flag.
        let (dir, _) = setup_wiki(
            "broken_missing_target",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md) for details.\n",
            )],
        );
        mark_bundle(&dir, "wiki");
        let issues = broken_links_at(&dir);
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
        let (dir, _) = setup_wiki(
            "broken_valid",
            &[
                (
                    "concepts/page-a.md",
                    "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](concepts/page-b.md).\n",
                ),
                (
                    "concepts/page-b.md",
                    "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody content.\n",
                ),
            ],
        );
        mark_bundle(&dir, "wiki");
        let issues = broken_links_at(&dir);
        assert!(issues.is_empty(), "expected no broken links for valid target");
    }

    #[test]
    fn test_broken_links_external_urls_ignored() {
        let (dir, _) = setup_wiki(
            "broken_external",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [example](https://example.com).\n",
            )],
        );
        mark_bundle(&dir, "wiki");
        let issues = broken_links_at(&dir);
        assert!(issues.is_empty(), "external URLs should be ignored");
    }

    #[test]
    fn test_broken_links_anchor_only_ignored() {
        let (dir, _) = setup_wiki(
            "broken_anchor",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [section](#intro).\n",
            )],
        );
        mark_bundle(&dir, "wiki");
        let issues = broken_links_at(&dir);
        assert!(issues.is_empty(), "anchor-only links should be ignored");
    }

    #[test]
    fn test_broken_links_absent_bundle_not_reported() {
        // A reference to a bundle the root does not hold is not a local
        // dead link.
        let (dir, _) = setup_wiki(
            "broken_cross_bundle",
            &[(
                "concepts/page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n\
                     See [core](@core/concepts/foo.md) and \
                     [vendor](@vendor/bar.md).\n",
            )],
        );
        mark_bundle(&dir, "wiki");
        let issues = broken_links_at(&dir);
        assert!(
            issues.is_empty(),
            "an absent bundle is not a broken local link"
        );
    }

    #[test]
    fn test_broken_links_explicit_reference_keeps_its_bundle() {
        // An explicit reference to a held bundle that lacks the page is
        // broken; `target_path` keeps the bundle so it cannot be mistaken
        // for a local path.  A bare reference stays bundle-relative.
        let dir = temp_dir("broken_explicit_bundle");
        mark_bundle(&dir, "core");
        mark_bundle(&dir, "vendor");
        write(
            &dir.join("core/concepts/page-a.md"),
            &page(
                "Page A",
                "concept",
                "draft",
                "2026-01-01",
                "",
                "See [gone](@vendor/concepts/gone.md) and \
                 [local](concepts/gone.md).",
            ),
        );

        let issues = broken_links_at(&dir);
        let target_paths: Vec<String> = issues
            .iter()
            .map(|issue| {
                let details: Value =
                    serde_json::from_str(&issue.details).unwrap();
                details["target_path"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(
            target_paths,
            vec![
                "@vendor/concepts/gone.md".to_string(),
                "concepts/gone.md".to_string()
            ],
            "an explicit reference keeps its bundle in target_path"
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
            "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
        );
        write(
            &dir.join("page-b.md"),
            "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
        );
        write(
            &dir.join("page-c.md"),
            "---\ntitle: Page C\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nOrphan content.\n",
        );

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
            ),
            (
                "page-b.md",
                "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
            ),
            (
                "page-c.md",
                "---\ntitle: Page C\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nOrphan content.\n",
            ),
        ];
        let (_, pages) = setup_wiki("orphan_detected_inner", all_files);
        // Use the dir we created manually with index.md.
        let issues = orphans(&pages, &dir);
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
            "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
        );
        write(
            &dir.join("page-b.md"),
            "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
        );

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
            ),
            (
                "page-b.md",
                "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
            ),
        ];
        let (_, pages) = setup_wiki("orphan_non_orphan_inner", all_files);
        let issues = orphans(&pages, &dir);
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
            "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
        );
        write(
            &dir.join("page-b.md"),
            "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
        );
        write(
            &dir.join("page-c.md"),
            "---\ntitle: Page C\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nContent.\n",
        );

        let all_files = &[
            (
                "page-a.md",
                "---\ntitle: Page A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nSee [page b](page-b.md).\n",
            ),
            (
                "page-b.md",
                "---\ntitle: Page B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.\n",
            ),
            (
                "page-c.md",
                "---\ntitle: Page C\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nContent.\n",
            ),
        ];
        let (_, pages) = setup_wiki("orphan_in_index_inner", all_files);
        let issues = orphans(&pages, &dir);
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
            "---\ntitle: Foo\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody content.\n",
        );

        let files = &[(
            "alpha/foo.md",
            "---\ntitle: Foo\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody content.\n",
        )];
        let (_, pages) = setup_wiki("orphan_domain_index_inner", files);
        let issues = orphans(&pages, &dir);
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
            "---\ntitle: Foo\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody content.\n",
        );
        write(
            &dir.join("alpha/bar.md"),
            "---\ntitle: Bar\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nUnowned content.\n",
        );

        let files = &[
            (
                "alpha/foo.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody content.\n",
            ),
            (
                "alpha/bar.md",
                "---\ntitle: Bar\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nUnowned content.\n",
            ),
        ];
        let (_, pages) = setup_wiki("orphan_unindexed_inner", files);
        let issues = orphans(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "alpha/bar.md");
        assert_eq!(issues[0].category, "orphan");
    }

    #[test]
    fn test_orphan_pages_of_an_aggregate_root() {
        // A bundle-relative body link reaches the page inside the bundle,
        // and an explicit reference counts for the bundle it names.
        let dir = temp_dir("orphan_aggregate");
        mark_bundle(&dir.join("core"), "core");
        mark_bundle(&dir.join("vendor"), "vendor");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Alpha](core/concepts/alpha.md)\n\
             [Gamma](vendor/concepts/gamma.md)\n",
        );
        write(
            &dir.join("core/concepts/alpha.md"),
            &page(
                "Alpha",
                "concept",
                "draft",
                "2026-01-01",
                "",
                "See [beta](concepts/beta.md).",
            ),
        );
        write(
            &dir.join("core/concepts/beta.md"),
            &page("Beta", "concept", "draft", "2026-01-01", "", "Body."),
        );
        write(
            &dir.join("vendor/concepts/gamma.md"),
            &page(
                "Gamma",
                "concept",
                "draft",
                "2026-01-01",
                "",
                "See [beta](@core/concepts/beta.md).",
            ),
        );
        write(
            &dir.join("core/concepts/delta.md"),
            &page("Delta", "concept", "draft", "2026-01-01", "", "Body."),
        );

        let set = PageSet::load(&dir);
        let catalog = Catalog::new(&dir, &set).expect("catalog");
        let issues = check_orphan_pages(set.pages(), &catalog, &dir);
        assert_eq!(issues.len(), 1, "only delta stays unlinked: {issues:?}");
        assert_eq!(issues[0].page, "core/concepts/delta.md");
    }

    // =======================================================================
    // 3. check_sparse_pages
    // =======================================================================

    #[test]
    fn test_sparse_pages_below_threshold_flagged() {
        let pages = vec![make_page(
            "concepts/sparse.md",
            "---\ntitle: Sparse\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nShort.\n",
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
            &format!(
                "---\ntitle: OK\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n{body}"
            ),
        )];
        let issues = check_sparse_pages(&pages);
        assert!(issues.is_empty(), "exactly 50 chars should pass threshold");
    }

    #[test]
    fn test_sparse_pages_empty_body_flagged() {
        let pages = vec![make_page(
            "concepts/empty.md",
            "---\ntitle: Empty\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---",
        )];
        let issues = check_sparse_pages(&pages);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "concepts/empty.md");
    }

    #[test]
    fn test_sparse_pages_long_body_not_flagged() {
        let body = "A".repeat(200);
        let pages = vec![make_page(
            "concepts/long.md",
            &format!(
                "---\ntitle: Long\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n{body}"
            ),
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

    /// Page text with every required field, plus `extra` frontmatter lines.
    fn page(
        title: &str,
        page_type: &str,
        status: &str,
        last_validated: &str,
        extra: &str,
        body: &str,
    ) -> String {
        format!(
            "---\ntitle: {title}\ntype: {page_type}\ntags: []\nstatus: {status}\n\
             last_validated: {last_validated}\ntimeliness: current\n{extra}---\n\n{body}\n"
        )
    }

    #[test]
    fn test_freshness_time_expired_flagged() {
        let old = page("Old", "concept", "stable", "2024-06-01", "", "Body.");
        let (_, pages) =
            setup_wiki("freshness_stale", &[("concepts/old.md", &old)]);
        let result = freshness_at(&pages, reference_date());
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
        let deprecated =
            page("Dep", "concept", "deprecated", "2020-01-01", "", "Body.");
        let (_, pages) = setup_wiki(
            "freshness_deprecated",
            &[("concepts/deprecated.md", &deprecated)],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(result.stale.is_empty(), "deprecated pages should be exempt");
    }

    #[test]
    fn test_freshness_recent_not_flagged() {
        let recent =
            page("Recent", "concept", "stable", "2024-12-15", "", "Body.");
        let (_, pages) =
            setup_wiki("freshness_recent", &[("concepts/recent.md", &recent)]);
        let result = freshness_at(&pages, reference_date());
        assert!(result.stale.is_empty(), "recent page should pass");
    }

    #[test]
    fn test_freshness_invalid_last_validated_skipped() {
        let baddate =
            page("Bad Date", "concept", "draft", "not-a-date", "", "Body.");
        let (_, pages) = setup_wiki(
            "freshness_bad_lv",
            &[("concepts/baddate.md", &baddate)],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(result.stale.is_empty(), "invalid date should be skipped");
    }

    #[test]
    fn test_freshness_old_timestamp_new_validation_is_fresh() {
        // Core regression: an old `timestamp` must not stale a page whose
        // `last_validated` is recent.
        let validated = page(
            "Validated",
            "concept",
            "stable",
            "2024-12-30",
            "timestamp: 2020-01-01\n",
            "Body.",
        );
        let (_, pages) = setup_wiki(
            "freshness_old_ts",
            &[("concepts/validated.md", &validated)],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(
            result.stale.is_empty(),
            "recent validation must keep the page fresh"
        );
    }

    #[test]
    fn test_freshness_source_newer_flags_analysis() {
        let reference =
            NaiveDate::parse_from_str("2025-06-01", "%Y-%m-%d").unwrap();
        let source = page(
            "Bar",
            "source",
            "stable",
            "2025-06-01",
            "timestamp: 2025-05-01\n",
            "Body.",
        );
        let analysis = page(
            "Foo",
            "analysis",
            "draft",
            "2025-04-01",
            "sources: [shared/sources/bar.md]\n",
            "Body.",
        );
        let (_, pages) = setup_wiki(
            "freshness_source_newer",
            &[
                ("shared/sources/bar.md", &source),
                ("shared/analysis/foo.md", &analysis),
            ],
        );
        let result = freshness_at(&pages, reference);
        assert_eq!(result.stale.len(), 1);
        assert_eq!(result.stale[0].page, "shared/analysis/foo.md");
        let details: Value =
            serde_json::from_str(&result.stale[0].details).unwrap();
        assert_eq!(details["reasons"][0], "source_newer");
    }

    #[test]
    fn test_freshness_source_resolved_inside_the_bundle() {
        // The `sources` entry is bundle-relative, so an aggregate root finds
        // the source inside the derived page's bundle.
        let dir = temp_dir("freshness_source_bundle");
        mark_bundle(&dir.join("core"), "core");
        write(
            &dir.join("core/sources/bar.md"),
            &page(
                "Bar",
                "source",
                "stable",
                "2025-06-01",
                "timestamp: 2025-05-01\n",
                "Body.",
            ),
        );
        write(
            &dir.join("core/analysis/foo.md"),
            &page(
                "Foo",
                "analysis",
                "draft",
                "2025-04-01",
                "sources: [sources/bar.md]\n",
                "Body.",
            ),
        );

        let set = PageSet::load(&dir);
        let catalog = Catalog::new(&dir, &set).expect("catalog");
        let result = check_freshness(set.pages(), &catalog, reference_date());
        assert_eq!(result.stale.len(), 1);
        assert_eq!(result.stale[0].page, "core/analysis/foo.md");
        let details: Value =
            serde_json::from_str(&result.stale[0].details).unwrap();
        assert_eq!(details["reasons"][0], "source_newer");
    }

    // =======================================================================
    // 5. check_freshness — cascade_stale projection
    // =======================================================================

    /// `superseded_by` frontmatter that points at `shared/concepts/new.md`.
    const SUPERSEDED_BY: &str = "\
superseded_by:
  - path: shared/concepts/new.md
    reason: replaced
";

    #[test]
    fn test_cascade_stale_referrer_flagged() {
        // Superseded page with `last_validated`, referrer with older
        // `last_validated` → 1 cascade issue.
        let old = page(
            "Old",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            SUPERSEDED_BY,
            "# Old\n\nContent.",
        );
        let referrer = page(
            "Referrer",
            "concept",
            "stable",
            "2023-12-01T00:00:00Z",
            "",
            "# Referrer\n\nSee [old](shared/concepts/old.md).",
        );
        let new = page(
            "New",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            "",
            "# New\n\nContent.",
        );
        let (_, pages) = setup_wiki(
            "cascade_flagged",
            &[
                ("shared/concepts/old.md", &old),
                ("shared/concepts/referrer.md", &referrer),
                ("shared/concepts/new.md", &new),
            ],
        );
        let result = freshness_at(&pages, reference_date());
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
        let old = page(
            "Old",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            SUPERSEDED_BY,
            "# Old\n\nContent.",
        );
        let referrer = page(
            "Referrer",
            "concept",
            "stable",
            "2024-06-01T00:00:00Z",
            "",
            "# Referrer\n\nSee [old](shared/concepts/old.md).",
        );
        let new = page(
            "New",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            "",
            "# New\n\nContent.",
        );
        let (_, pages) = setup_wiki(
            "cascade_reviewed",
            &[
                ("shared/concepts/old.md", &old),
                ("shared/concepts/referrer.md", &referrer),
                ("shared/concepts/new.md", &new),
            ],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "referrer reviewed after supersedure should not be flagged"
        );
    }

    #[test]
    fn test_cascade_stale_superseding_page_excluded() {
        // Superseding page itself references the old page → excluded.
        let old = page(
            "Old",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            SUPERSEDED_BY,
            "# Old\n\nContent.",
        );
        let new = page(
            "New",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            "",
            "# New\n\nSee [old](shared/concepts/old.md).",
        );
        let (_, pages) = setup_wiki(
            "cascade_excluded",
            &[
                ("shared/concepts/old.md", &old),
                ("shared/concepts/new.md", &new),
            ],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "superseding page itself should be excluded"
        );
    }

    #[test]
    fn test_invalid_page_surfaces_in_snapshot() {
        // A page the document model rejects never reaches the lint rules;
        // the snapshot reports it so no command skips it silently.
        let dir = temp_dir("lint_invalid_doc");
        write(
            &dir.join("shared/concepts/old.md"),
            "---\ntitle: Old\ntype: concept\n---\n\n# Old\n",
        );

        let set = PageSet::load(&dir);
        assert!(set.pages().is_empty());
        let error = set.require_all().expect_err("invalid page");
        assert!(error.contains("shared/concepts/old.md"), "{error}");
    }

    #[test]
    fn test_cascade_stale_uncomparable_referrer_skipped() {
        // A referrer whose `last_validated` cannot be compared is skipped.
        let old = page(
            "Old",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            SUPERSEDED_BY,
            "# Old\n\nContent.",
        );
        let referrer = page(
            "Referrer",
            "concept",
            "stable",
            "unknown",
            "",
            "# Referrer\n\nSee [old](shared/concepts/old.md).",
        );
        let (_, pages) = setup_wiki(
            "cascade_no_ref_lv",
            &[
                ("shared/concepts/old.md", &old),
                ("shared/concepts/referrer.md", &referrer),
            ],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "an uncomparable referrer is skipped"
        );
    }

    #[test]
    fn test_cascade_stale_no_referrers() {
        // No pages reference the superseded page → no cascade issue.
        let old = page(
            "Old",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            SUPERSEDED_BY,
            "# Old\n\nContent.",
        );
        let new = page(
            "New",
            "concept",
            "stable",
            "2024-01-01T00:00:00Z",
            "",
            "# New\n\nContent.",
        );
        let (_, pages) = setup_wiki(
            "cascade_no_refs",
            &[
                ("shared/concepts/old.md", &old),
                ("shared/concepts/new.md", &new),
            ],
        );
        let result = freshness_at(&pages, reference_date());
        assert!(
            result.cascade_stale.is_empty(),
            "no referrers should produce no issues"
        );
    }
}
