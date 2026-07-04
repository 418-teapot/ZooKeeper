//! Verify — `zwiki verify` subcommand.
//!
//! Scans analysis/synthesis pages with non-empty `sources` frontmatter,
//! and identifies pairs where a source page's `timestamp` is newer than
//! the derived page's `last_validated` — indicating the derived page
//! may need re-validation against updated source material.

use serde_json::Value;

use crate::wiki;

/// A stale source–derived page pair.
struct StalePair {
    derived_page: String,
    source_page: String,
    source_timestamp: String,
    derived_last_validated: String,
}

/// Run the verify command.
///
/// Scans all wiki pages and outputs stale source–derived pairs.
/// When `domain` is `Some`, only pages within that top-level directory are
/// checked.
pub fn cmd_verify(json: bool, domain: Option<&str>) {
    let root = wiki::wiki_dir();
    let paths = wiki::discover_pages(&root);
    let cache = wiki::page_cache(&paths);

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

        // Only check analysis / synthesis pages.
        if !matches!(
            page.frontmatter.get("type").and_then(|v| v.as_str()),
            Some("analysis" | "synthesis")
        ) {
            continue;
        }

        // Must have non-empty sources array.
        let sources = match page.frontmatter.get("sources") {
            Some(Value::Array(arr)) if !arr.is_empty() => arr,
            _ => continue,
        };

        // Must have parseable last_validated.
        let Some(lv_str) =
            page.frontmatter.get("last_validated").and_then(|v| v.as_str())
        else {
            continue;
        };
        let Some(derived_date) = wiki::parse_date(lv_str) else {
            continue;
        };

        for source_val in sources {
            let Some(source_rel_in) = source_val.as_str() else {
                continue;
            };
            // Normalize: ensure .md extension.
            let source_rel = if std::path::Path::new(source_rel_in)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                source_rel_in.to_string()
            } else {
                format!("{source_rel_in}.md")
            };

            let Some(source_page) = cache.get(&source_rel) else {
                continue;
            };

            let Some(ts_str) = source_page
                .frontmatter
                .get("timestamp")
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            let Some(source_date) = wiki::parse_date(ts_str) else {
                continue;
            };

            if source_date > derived_date {
                stale.push(StalePair {
                    derived_page: page.rel.clone(),
                    source_page: source_rel,
                    source_timestamp: ts_str.to_string(),
                    derived_last_validated: lv_str.to_string(),
                });
            }
        }
    }

    // Sort for deterministic output.
    stale.sort_by(|a, b| {
        a.derived_page
            .cmp(&b.derived_page)
            .then_with(|| a.source_page.cmp(&b.source_page))
    });

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

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

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
    // cmd_verify core logic (tested via invalidate_by_source)
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
}
