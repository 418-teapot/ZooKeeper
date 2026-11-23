//! Verify — `zwiki verify` subcommand.
//!
//! Scans analysis/synthesis pages with non-empty `sources` frontmatter,
//! and identifies pairs where a source page's `timestamp` is newer than
//! the derived page's `timestamp` — indicating the derived page may need
//! an update against updated source material.

use std::collections::HashMap;
use std::path::Path;

use crate::catalog::Catalog;
use crate::freshness;
use crate::wiki;
use zwiki::identity::PageId;

/// A stale source–derived page pair.
#[derive(Debug, Clone)]
pub struct StalePair {
    pub(crate) derived_page: String,
    pub(crate) source_page: String,
    pub(crate) source_timestamp: String,
    pub(crate) derived_timestamp: String,
}

/// Run the verify command.
///
/// Scans all wiki pages and outputs stale source–derived pairs.
/// When `domain` is `Some`, only pages within that top-level directory are
/// checked.
pub fn cmd_verify(root: &Path, json: bool, domain: Option<&str>) {
    let stale = match collect_stale_pairs(root, domain) {
        Ok(stale) => stale,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if json {
        let output: Vec<serde_json::Value> = stale
            .iter()
            .map(|s| {
                serde_json::json!({
                    "derived_page": s.derived_page,
                    "source_page": s.source_page,
                    "source_timestamp": s.source_timestamp,
                    "derived_timestamp": s.derived_timestamp,
                })
            })
            .collect();
        crate::print_stdout_line(
            serde_json::to_string_pretty(&output).unwrap(),
        );
    } else if stale.is_empty() {
        crate::print_stdout_line("所有 analysis/synthesis 页面均基于最新来源");
    } else {
        for s in &stale {
            crate::print_stdout_line(format!(
                "  {} ← {} (来源确认于 {}，本页确认于 {})",
                s.derived_page,
                s.source_page,
                s.source_timestamp,
                s.derived_timestamp,
            ));
        }
    }
}

/// Collect stale source–derived pairs for a given wiki root and optional
/// domain filter.
///
/// Applies the optional domain filter, sorts the results, and returns
/// them so tests can exercise the logic without capturing stdout.
/// The per-page stale-source scan is delegated to
/// [`freshness::newer_sources`].
///
/// # Errors
///
/// Fails when any page cannot be loaded, naming its path.
pub fn collect_stale_pairs(
    root: &Path,
    domain: Option<&str>,
) -> Result<Vec<StalePair>, String> {
    let set = wiki::PageSet::load(root);
    let pages = set.require_all()?;
    let by_rel: HashMap<&str, &wiki::Page> =
        pages.iter().map(|page| (page.rel.as_str(), page)).collect();
    // A `sources` entry names a page of the derived page's bundle.
    let catalog = Catalog::new(root, &set)?;

    let mut stale: Vec<StalePair> = Vec::new();

    for page in pages {
        // Domain filter: keep the pages of the requested domain.
        if let Some(df) = domain {
            let df_lower = df.to_lowercase();
            let page_domain = catalog
                .id_of(&page.rel)
                .map(PageId::domain)
                .unwrap_or_default();
            if page_domain.to_lowercase() != df_lower {
                continue;
            }
        }

        for newer in freshness::newer_sources(page, &by_rel, &catalog) {
            stale.push(StalePair {
                derived_page: page.rel.clone(),
                source_page: newer.source,
                source_timestamp: newer.source_timestamp,
                derived_timestamp: newer.derived_timestamp,
            });
        }
    }

    // Sort for deterministic output.
    stale.sort_by(|a, b| {
        a.derived_page
            .cmp(&b.derived_page)
            .then_with(|| a.source_page.cmp(&b.source_page))
    });

    Ok(stale)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /// A temp root holding the bundle named `wiki`.
    fn wiki_root(name: &str) -> PathBuf {
        let dir = crate::bundle::testutil::temp_dir(name);
        fs::write(
            dir.join("bundle.toml"),
            "[package]\nname = \"wiki\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n",
        )
        .unwrap();
        dir
    }

    fn write(path: &PathBuf, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent");
        }
        fs::write(path, text).expect("failed to write file");
    }

    /// Page text with `type`, `timestamp`, and `extra` frontmatter lines.
    fn page_text(page_type: &str, timestamp: &str, extra: &str) -> String {
        format!(
            "---\ntitle: T\ntype: {page_type}\ntimestamp: {timestamp}\n\
             tags: []\n{extra}---\nBody.\n"
        )
    }

    // -------------------------------------------------------------------
    // collect_stale_pairs
    // -------------------------------------------------------------------

    #[test]
    fn test_collect_stale_pairs_basic() {
        // Source newer than the derived page → one stale pair.
        let dir = wiki_root("collect_basic");
        write(
            &dir.join("shared/sources/bar.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-01-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
            ),
        );

        let stale = collect_stale_pairs(&dir, None).expect("valid pages");
        assert_eq!(stale.len(), 1, "should detect one stale pair");
        assert_eq!(stale[0].derived_page, "shared/analysis/foo.md");
        assert_eq!(stale[0].source_page, "shared/sources/bar.md");
        assert_eq!(stale[0].source_timestamp, "2024-06-01T00:00:00Z");
        assert_eq!(stale[0].derived_timestamp, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_collect_stale_pairs_markdown_link_source() {
        // A `sources` entry may carry a markdown link; both the bare and the
        // explicit form name the same source page.
        let dir = wiki_root("collect_markdown_link");
        write(
            &dir.join("shared/sources/bar.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-01-01T00:00:00Z",
                "sources: ['[Bar](shared/sources/bar.md)', \
                 '[Bar](@wiki/shared/sources/bar.md)']\n",
            ),
        );

        let stale = collect_stale_pairs(&dir, None).expect("valid pages");
        assert_eq!(stale.len(), 1, "both spellings name one stale pair");
        assert_eq!(
            stale[0].source_page, "shared/sources/bar.md",
            "the pair names the source page: {stale:?}"
        );
    }

    #[test]
    fn test_collect_stale_pairs_domain_filter() {
        // Pages in different domains; filter should exclude out-of-domain.
        let dir = wiki_root("collect_domain");
        write(
            &dir.join("domain1/sources/bar.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("domain1/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-01-01T00:00:00Z",
                "sources: [domain1/sources/bar.md]\n",
            ),
        );
        write(
            &dir.join("domain2/sources/baz.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("domain2/analysis/qux.md"),
            &page_text(
                "analysis",
                "2024-01-01T00:00:00Z",
                "sources: [domain2/sources/baz.md]\n",
            ),
        );

        // Only domain1 should be included.
        let stale =
            collect_stale_pairs(&dir, Some("domain1")).expect("valid pages");
        assert_eq!(stale.len(), 1, "domain filter should exclude domain2");
        assert_eq!(stale[0].derived_page, "domain1/analysis/foo.md");

        // No domain filter → both domains.
        let stale_all = collect_stale_pairs(&dir, None).expect("valid pages");
        assert_eq!(stale_all.len(), 2, "no domain filter should include both");
    }

    #[test]
    fn test_collect_stale_pairs_no_stale() {
        // Source timestamp equals the derived page timestamp → no stale.
        let dir = wiki_root("collect_none");
        write(
            &dir.join("shared/sources/bar.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-06-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
            ),
        );

        let stale = collect_stale_pairs(&dir, None).expect("valid pages");
        assert!(stale.is_empty(), "no stale when the source is not newer");
    }

    #[test]
    fn test_collect_stale_pairs_same_day_later_time() {
        // The whole timestamp is compared, so a source later on the same
        // day is still newer.
        let dir = wiki_root("collect_same_day");
        write(
            &dir.join("shared/sources/bar.md"),
            &page_text("source", "2024-06-01T12:00:00Z", ""),
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-06-01T11:00:00Z",
                "sources: [shared/sources/bar.md]\n",
            ),
        );

        let stale = collect_stale_pairs(&dir, None).expect("valid pages");
        assert_eq!(stale.len(), 1, "same-day later source counts as newer");
        assert_eq!(stale[0].derived_timestamp, "2024-06-01T11:00:00Z");
    }

    #[test]
    fn test_collect_stale_pairs_json_shape() {
        // Verify the JSON output structure is correct.
        let dir = wiki_root("collect_json");
        write(
            &dir.join("shared/sources/bar.md"),
            &page_text("source", "2024-06-01T00:00:00Z", ""),
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            &page_text(
                "analysis",
                "2024-01-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
            ),
        );

        let stale = collect_stale_pairs(&dir, None).expect("valid pages");
        let json_output: Vec<serde_json::Value> = stale
            .iter()
            .map(|s| {
                serde_json::json!({
                    "derived_page": s.derived_page,
                    "source_page": s.source_page,
                    "source_timestamp": s.source_timestamp,
                    "derived_timestamp": s.derived_timestamp,
                })
            })
            .collect();

        assert_eq!(json_output.len(), 1);
        let obj = &json_output[0];
        assert_eq!(obj["derived_page"], "shared/analysis/foo.md");
        assert_eq!(obj["source_page"], "shared/sources/bar.md");
        assert_eq!(obj["source_timestamp"], "2024-06-01T00:00:00Z");
        assert_eq!(obj["derived_timestamp"], "2024-01-01T00:00:00Z");

        // Verify pretty-print produces valid JSON.
        let pretty = serde_json::to_string_pretty(&json_output).unwrap();
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&pretty).unwrap();
        assert_eq!(parsed.len(), 1);
    }
}
