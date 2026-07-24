//! Verify — `zwiki verify` subcommand.
//!
//! Scans analysis/synthesis pages with non-empty `sources` frontmatter,
//! and identifies pairs where a source page's `timestamp` is newer than
//! the derived page's `last_validated` — indicating the derived page
//! may need re-validation against updated source material.

use std::collections::HashMap;
use std::path::Path;

use crate::wiki;

/// A stale source–derived page pair.
#[derive(Debug, Clone)]
pub struct StalePair {
    pub(crate) derived_page: String,
    pub(crate) source_page: String,
    pub(crate) source_timestamp: String,
    pub(crate) derived_last_validated: String,
}

/// Run the verify command.
///
/// Scans all wiki pages and outputs stale source–derived pairs.
/// When `domain` is `Some`, only pages within that top-level directory are
/// checked.
pub fn cmd_verify(root: &Path, json: bool, domain: Option<&str>) {
    let stale = collect_stale_pairs(root, domain);

    if json {
        let output: Vec<serde_json::Value> = stale
            .iter()
            .map(|s| {
                serde_json::json!({
                    "derived_page": s.derived_page,
                    "source_page": s.source_page,
                    "source_timestamp": s.source_timestamp,
                    "derived_last_validated": s.derived_last_validated,
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else if stale.is_empty() {
        println!("所有 analysis/synthesis 页面均基于最新来源");
    } else {
        for s in &stale {
            println!(
                "  {} ← {} (source changed {}, validated {})",
                s.derived_page,
                s.source_page,
                s.source_timestamp,
                s.derived_last_validated,
            );
        }
    }
}

/// Collect stale source–derived pairs for a given wiki root and optional
/// domain filter.
///
/// This is the domain-filter + sort + output logic extracted from
/// `cmd_verify` so tests can exercise it without capturing stdout.
/// The per-page stale-source scan is delegated to
/// [`wiki::stale_sources`].
pub fn collect_stale_pairs(
    root: &Path,
    domain: Option<&str>,
) -> Vec<StalePair> {
    let paths = wiki::discover_pages(root);
    let cache = wiki::page_cache_at(&paths, root);
    let by_rel: HashMap<&str, &wiki::Page> =
        cache.iter().map(|(k, v)| (k.as_str(), v)).collect();

    let mut stale: Vec<StalePair> = Vec::new();

    for page in cache.values() {
        // Domain filter: skip pages whose top-level directory doesn't match.
        if let Some(df) = domain {
            let df_lower = df.to_lowercase();
            let page_domain = page.rel.split('/').next().unwrap_or("");
            if page_domain.to_lowercase() != df_lower {
                continue;
            }
        }

        let pairs = wiki::stale_sources(page, &by_rel);
        for (source_rel, _) in pairs {
            let lv_str = page
                .frontmatter
                .get("last_validated")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ts_str = by_rel
                .get(source_rel.as_str())
                .and_then(|p| p.frontmatter.get("timestamp"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            stale.push(StalePair {
                derived_page: page.rel.clone(),
                source_page: source_rel,
                source_timestamp: ts_str,
                derived_last_validated: lv_str,
            });
        }
    }

    // Sort for deterministic output.
    stale.sort_by(|a, b| {
        a.derived_page
            .cmp(&b.derived_page)
            .then_with(|| a.source_page.cmp(&b.source_page))
    });

    stale
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::health;
    use crate::wiki;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test-verify").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &PathBuf, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent");
        }
        fs::write(path, text).expect("failed to write file");
    }

    // -------------------------------------------------------------------
    // 1. Stale detection via invalidate_by_source (preserved behavior)
    // -------------------------------------------------------------------

    #[test]
    fn test_cmd_verify_stale_detected() {
        // Source page has a newer timestamp than the analysis page's
        // last_validated → should report the stale pair.
        let dir = temp_dir("stale_detected");
        write(
            &dir.join("shared/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-06-01\n---\nBody.\n",
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );

        let paths = wiki::discover_pages(&dir);
        let cache = wiki::page_cache_at(&paths, &dir);
        let pages: Vec<wiki::Page> = cache.into_values().collect();

        let updates = health::invalidate_by_source(&pages);
        assert_eq!(updates.len(), 1, "should detect one stale pair");
        assert_eq!(updates[0].rel, "shared/analysis/foo.md");
        assert_eq!(updates[0].new_last_validated, "2024-06-01");
    }

    #[test]
    fn test_cmd_verify_no_stale_when_timestamps_match() {
        // When source timestamp equals derived last_validated → no stale.
        let dir = temp_dir("no_stale_match");
        write(
            &dir.join("shared/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-01-01\n---\nBody.\n",
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );

        let paths = wiki::discover_pages(&dir);
        let cache = wiki::page_cache_at(&paths, &dir);
        let pages: Vec<wiki::Page> = cache.into_values().collect();

        let updates = health::invalidate_by_source(&pages);
        assert!(
            updates.is_empty(),
            "matching timestamps should not produce stale pair"
        );
    }

    // -------------------------------------------------------------------
    // 2. collect_stale_pairs — domain filter + output shape
    // -------------------------------------------------------------------

    #[test]
    fn test_collect_stale_pairs_basic() {
        // Source newer than derived last_validated → one stale pair.
        let dir = temp_dir("collect_basic");
        write(
            &dir.join("shared/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-06-01\n---\nBody.\n",
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );

        let stale = collect_stale_pairs(&dir, None);
        assert_eq!(stale.len(), 1, "should detect one stale pair");
        assert_eq!(stale[0].derived_page, "shared/analysis/foo.md");
        assert_eq!(stale[0].source_page, "shared/sources/bar.md");
        assert_eq!(stale[0].source_timestamp, "2024-06-01");
        assert_eq!(stale[0].derived_last_validated, "2024-01-01");
    }

    #[test]
    fn test_collect_stale_pairs_domain_filter() {
        // Pages in different domains; filter should exclude out-of-domain.
        let dir = temp_dir("collect_domain");
        write(
            &dir.join("domain1/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-06-01\n---\nBody.\n",
        );
        write(
            &dir.join("domain1/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [domain1/sources/bar.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );
        write(
            &dir.join("domain2/sources/baz.md"),
            "---\ntitle: Baz\ntype: source\ntimestamp: 2024-06-01\n---\nBody.\n",
        );
        write(
            &dir.join("domain2/analysis/qux.md"),
            "---\ntitle: Qux\ntype: analysis\n\
             sources: [domain2/sources/baz.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );

        // Only domain1 should be included.
        let stale = collect_stale_pairs(&dir, Some("domain1"));
        assert_eq!(stale.len(), 1, "domain filter should exclude domain2");
        assert_eq!(stale[0].derived_page, "domain1/analysis/foo.md");

        // No domain filter → both domains.
        let stale_all = collect_stale_pairs(&dir, None);
        assert_eq!(stale_all.len(), 2, "no domain filter should include both");
    }

    #[test]
    fn test_collect_stale_pairs_no_stale() {
        // Source timestamp equals derived last_validated → no stale.
        let dir = temp_dir("collect_none");
        write(
            &dir.join("shared/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-01-01\n---\nBody.\n",
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2024-06-01\n---\nBody.\n",
        );

        let stale = collect_stale_pairs(&dir, None);
        assert!(stale.is_empty(), "no stale when source is older");
    }

    #[test]
    fn test_collect_stale_pairs_json_shape() {
        // Verify the JSON output structure is correct.
        let dir = temp_dir("collect_json");
        write(
            &dir.join("shared/sources/bar.md"),
            "---\ntitle: Bar\ntype: source\ntimestamp: 2024-06-01\n---\nBody.\n",
        );
        write(
            &dir.join("shared/analysis/foo.md"),
            "---\ntitle: Foo\ntype: analysis\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2024-01-01\n---\nBody.\n",
        );

        let stale = collect_stale_pairs(&dir, None);
        let json_output: Vec<serde_json::Value> = stale
            .iter()
            .map(|s| {
                serde_json::json!({
                    "derived_page": s.derived_page,
                    "source_page": s.source_page,
                    "source_timestamp": s.source_timestamp,
                    "derived_last_validated": s.derived_last_validated,
                })
            })
            .collect();

        assert_eq!(json_output.len(), 1);
        let obj = &json_output[0];
        assert_eq!(obj["derived_page"], "shared/analysis/foo.md");
        assert_eq!(obj["source_page"], "shared/sources/bar.md");
        assert_eq!(obj["source_timestamp"], "2024-06-01");
        assert_eq!(obj["derived_last_validated"], "2024-01-01");

        // Verify pretty-print produces valid JSON.
        let pretty = serde_json::to_string_pretty(&json_output).unwrap();
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&pretty).unwrap();
        assert_eq!(parsed.len(), 1);
    }
}
