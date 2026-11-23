//! Status — `zwiki status` subcommand.
//!
//! Computes and displays an overview of the wiki: total page count and the
//! distributions by type and domain.  Supports optional slice filters
//! (`--type`, `--tag`, `--domain`) to scope the report to a subset of
//! pages.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::Path;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::wiki;
use zwiki::identity::PageId;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// Health status report for the wiki.
#[derive(Debug, Clone, Serialize)]
pub struct StatusReport {
    /// Total page count (after slice filter, if any).
    pub total: usize,
    /// Distribution by page type (`type` frontmatter field).
    pub by_type: BTreeMap<String, usize>,
    /// Distribution by domain (first path component).
    pub by_domain: BTreeMap<String, usize>,
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// Compute a status report for the wiki.
///
/// When one or more slice filters are provided, the report is scoped to
/// pages matching **all** filters (AND semantics).  Filters are applied
/// during iteration so the `total` count reflects the filtered set.
///
/// # Errors
///
/// Fails when any page cannot be loaded, naming its path, or when the
/// pages carry no bundle identity.
pub fn compute_status(
    wiki_dir: &Path,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    bundles: &wiki::BundleSet,
) -> Result<StatusReport, String> {
    let set = wiki::PageSet::load(wiki_dir);
    let pages = set.require_all()?;
    let catalog = Catalog::new(wiki_dir, &set)?;

    let mut by_type: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_domain: BTreeMap<String, usize> = BTreeMap::new();
    let mut total: usize = 0;

    for page in pages {
        // Apply slice filters (AND semantics).
        if !wiki::page_matches_slice(
            page,
            type_filter,
            tag_filter,
            domain_filter,
            bundles,
        ) {
            continue;
        }

        let metadata = &page.document.metadata;

        // --- Distribution counts ---

        total += 1;

        if !metadata.page_type.is_empty() {
            *by_type.entry(metadata.page_type.clone()).or_insert(0) += 1;
        }

        // Domain of the page identity; a bundle-root page has none, which
        // matches validate_domain's directory-only rule.
        if let Some(domain) = catalog.id_of(&page.rel).map(PageId::domain)
            && !domain.is_empty()
        {
            *by_domain.entry(domain.to_string()).or_insert(0) += 1;
        }
    }

    Ok(StatusReport { total, by_type, by_domain })
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/// Format a status report for human-readable output.
///
/// When any of `type_filter`/`tag_filter`/`domain_filter` is `Some`,
/// a slice-mode prefix line (e.g. `切片: type=concept, domain=shared`)
/// is emitted before the stats.
pub fn format_status(
    report: &StatusReport,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
) -> String {
    let mut output = String::new();

    // Build slice description from active filters.
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = type_filter {
        parts.push(format!("type={t}"));
    }
    if let Some(t) = tag_filter {
        parts.push(format!("tag={t}"));
    }
    if let Some(d) = domain_filter {
        parts.push(format!("domain={d}"));
    }
    if !parts.is_empty() {
        let _ = write!(output, "切片: {}\n\n", parts.join(", "));
    }

    let _ = writeln!(output, "页面总数: {}", report.total);

    // Type distribution.
    output.push_str("\n类型分布:\n");
    for (k, v) in &report.by_type {
        let _ = writeln!(output, "{}", crate::display::count_line(k, *v));
    }

    // Domain distribution.
    output.push_str("\n领域分布:\n");
    for (k, v) in &report.by_domain {
        let _ = writeln!(output, "{}", crate::display::count_line(k, *v));
    }

    output
}

/// Format a status report as a 2-space pretty-printed JSON object.
pub fn format_status_json(report: &StatusReport) -> String {
    serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".to_string())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::{temp_dir, w, write_page};
    use std::path::PathBuf;

    /// An empty bundle set for a plain (non-aggregated) root.
    fn no_bundles() -> wiki::BundleSet {
        wiki::BundleSet::default()
    }

    /// A temp root holding the bundle named `wiki`.
    fn wiki_root(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        w(
            dir.join("bundle.toml"),
            "[package]\nname = \"wiki\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n",
        );
        dir
    }
    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /// Create a page with the given properties for status testing.
    fn make_page(wiki_root: &Path, rel: &str, page_type: &str, tags: &[&str]) {
        let tags_str = if tags.is_empty() {
            "[]".to_string()
        } else {
            let items: Vec<String> =
                tags.iter().map(|t| format!("\"{t}\"")).collect();
            format!("[{}]", items.join(", "))
        };
        let title = rel.split('/').next_back().unwrap_or("page");
        let content = format!(
            "---\ntitle: {title}\ntype: {page_type}\n\
             timestamp: 2026-01-01T00:00:00Z\ntags: {tags_str}\n---\n# {title}\n",
        );
        write_page(wiki_root, rel, &content);
    }

    // -------------------------------------------------------------------
    // Empty wiki
    // -------------------------------------------------------------------

    #[test]
    fn test_empty_wiki() {
        let dir = wiki_root("empty");
        let report = compute_status(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(report.total, 0);
        assert!(report.by_type.is_empty());
        assert!(report.by_domain.is_empty());
    }

    // -------------------------------------------------------------------
    // Full status (all pages)
    // -------------------------------------------------------------------

    #[test]
    fn test_status_all_pages() {
        let dir = wiki_root("all_pages");
        make_page(&dir, "shared/concepts/foo.md", "concept", &["access"]);
        make_page(&dir, "shared/entities/bar.md", "entity", &["item"]);
        make_page(
            &dir,
            "autoresearch/concepts/baz.md",
            "concept",
            &["research"],
        );

        let report = compute_status(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(report.total, 3);

        // Type distribution: concept: 2, entity: 1
        assert_eq!(report.by_type.get("concept"), Some(&2_usize));
        assert_eq!(report.by_type.get("entity"), Some(&1_usize));

        // Domain distribution.
        assert_eq!(report.by_domain.get("shared"), Some(&2_usize));
        assert_eq!(report.by_domain.get("autoresearch"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Pages the model rejects
    // -------------------------------------------------------------------

    #[test]
    fn test_status_invalid_page_fails() {
        let dir = wiki_root("missing_fields");
        // A page without a timestamp cannot be loaded as a page.
        write_page(
            &dir,
            "shared/concepts/nofields.md",
            "---\ntitle: No Fields\ntype: concept\ntimestamp: 2026-01-01T00:00:00Z\n---\n# No Fields\n",
        );

        let error = compute_status(&dir, None, None, None, &no_bundles())
            .expect_err("a page without required fields is invalid");
        assert!(error.contains("shared/concepts/nofields.md"), "{error}");
    }

    #[test]
    fn test_status_missing_type_fails() {
        let dir = wiki_root("missing_type");
        // A page without a type field cannot be loaded as a page.
        write_page(
            &dir,
            "shared/concepts/notype.md",
            "---\ntitle: No Type\n---\n# No Type\n",
        );

        let error = compute_status(&dir, None, None, None, &no_bundles())
            .expect_err("a page without type is invalid");
        assert!(error.contains("shared/concepts/notype.md"), "{error}");
    }

    #[test]
    fn test_status_type_slice() {
        let dir = wiki_root("type_slice");
        make_page(&dir, "shared/concepts/a.md", "concept", &[]);
        make_page(&dir, "shared/entities/b.md", "entity", &[]);

        let report =
            compute_status(&dir, Some("concept"), None, None, &no_bundles())
                .expect("valid pages");
        assert_eq!(report.total, 1);
        assert_eq!(report.by_type.get("concept"), Some(&1_usize));
        assert!(!report.by_type.contains_key("entity"));
    }

    // -------------------------------------------------------------------
    // Slice: by tag
    // -------------------------------------------------------------------

    #[test]
    fn test_status_tag_slice() {
        let dir = wiki_root("tag_slice");
        make_page(&dir, "shared/concepts/a.md", "concept", &["access"]);
        make_page(&dir, "shared/concepts/b.md", "concept", &["misc"]);

        let report =
            compute_status(&dir, None, Some("access"), None, &no_bundles())
                .expect("valid pages");
        assert_eq!(report.total, 1);
    }

    // -------------------------------------------------------------------
    // Slice: by domain
    // -------------------------------------------------------------------

    #[test]
    fn test_status_domain_slice() {
        let dir = wiki_root("domain_slice");
        make_page(&dir, "shared/concepts/a.md", "concept", &[]);
        make_page(&dir, "autoresearch/concepts/b.md", "concept", &[]);

        let report =
            compute_status(&dir, None, None, Some("shared"), &no_bundles())
                .expect("valid pages");
        assert_eq!(report.total, 1);
        assert!(report.by_domain.contains_key("shared"));
        assert!(!report.by_domain.contains_key("autoresearch"));
    }

    #[test]
    fn test_status_by_domain_excludes_root_files() {
        let dir = wiki_root("root_file_domain");
        make_page(&dir, "shared/concepts/a.md", "concept", &[]);
        // Root-level file (no directory component).
        write_page(
            &dir,
            "overview.md",
            "---\ntitle: Overview\ntype: synthesis\ntags: []\ntimestamp: 2026-01-01T00:00:00Z\n---\n# Overview\n",
        );

        let report = compute_status(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(report.total, 2);
        assert!(report.by_domain.contains_key("shared"));
        // Root-level files must not appear as domains.
        assert!(!report.by_domain.contains_key("overview.md"));
    }

    // -------------------------------------------------------------------
    // format_status
    // -------------------------------------------------------------------

    #[test]
    fn test_format_status_empty() {
        let report = StatusReport {
            total: 0,
            by_type: BTreeMap::new(),
            by_domain: BTreeMap::new(),
        };
        let output = format_status(&report, None, None, None);
        assert!(output.contains("页面总数: 0"));
    }

    #[test]
    fn test_format_status_with_slice() {
        let report = StatusReport {
            total: 2,
            by_type: BTreeMap::from([("concept".to_string(), 2)]),
            by_domain: BTreeMap::from([("shared".to_string(), 2)]),
        };
        let output = format_status(&report, Some("concept"), None, None);
        assert!(output.starts_with("切片: type=concept"));
        assert!(output.contains("页面总数: 2"));
    }

    #[test]
    fn test_format_status_full() {
        let report = StatusReport {
            total: 3,
            by_type: BTreeMap::from([
                ("concept".to_string(), 2),
                ("entity".to_string(), 1),
            ]),
            by_domain: BTreeMap::from([
                ("autoresearch".to_string(), 1),
                ("shared".to_string(), 2),
            ]),
        };
        let output = format_status(&report, None, None, None);
        assert!(output.contains("页面总数: 3"));
        assert!(output.contains("类型分布:"));
        assert!(output.contains("  concept — 2 页"));
        assert!(output.contains("  entity — 1 页"));
        assert!(output.contains("领域分布:"));
        assert!(output.contains("  autoresearch — 1 页"));
        assert!(output.contains("  shared — 2 页"));
    }

    #[test]
    fn test_format_status_multi_filter_slice() {
        let report = StatusReport {
            total: 1,
            by_type: BTreeMap::from([("concept".to_string(), 1)]),
            by_domain: BTreeMap::from([("shared".to_string(), 1)]),
        };
        let output =
            format_status(&report, Some("concept"), Some("auth"), None);
        assert!(output.starts_with("切片: type=concept, tag=auth"));
    }

    // -------------------------------------------------------------------
    // format_status_json
    // -------------------------------------------------------------------

    #[test]
    fn test_format_status_json_empty() {
        let report = StatusReport {
            total: 0,
            by_type: BTreeMap::new(),
            by_domain: BTreeMap::new(),
        };
        let output = format_status_json(&report);
        assert!(output.contains("\"total\": 0"));
        assert!(output.contains("\"by_type\": {}"));
        assert!(output.contains("\"by_domain\": {}"));
    }

    #[test]
    fn test_format_status_json_full() {
        let report = StatusReport {
            total: 2,
            by_type: BTreeMap::from([("concept".to_string(), 2)]),
            by_domain: BTreeMap::from([("shared".to_string(), 2)]),
        };
        let output = format_status_json(&report);
        assert!(output.contains("\"total\": 2"));
        assert!(output.contains("\"concept\": 2"));
        assert!(output.contains("\"shared\": 2"));
    }
}
