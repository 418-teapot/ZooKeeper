//! List — `zwiki list` subcommand.
//!
//! Field-based structural browsing of wiki pages.  Supports optional
//! `--type`, `--tag`, and `--domain` filters (AND semantics).  No text
//! search — this is purely a discovery / browsing tool.

use std::path::Path;

use serde::Serialize;

use crate::wiki;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A single list entry.
#[derive(Debug, Clone, Serialize)]
pub struct ListEntry {
    /// Wiki-relative path.
    pub path: String,
    /// Page title.
    pub title: String,
    /// Page type.
    #[serde(rename = "type")]
    pub page_type: String,
    /// Page tags.
    pub tags: Vec<String>,
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// List all pages under `wiki_dir`, optionally filtered.
///
/// All filters are optional.  When none are provided, all pages are listed.
/// When multiple filters are given, pages must match **all** of them (AND).
///
/// # Errors
///
/// Fails when any page cannot be loaded, naming its path.
pub fn list_pages(
    wiki_dir: &Path,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    bundles: &wiki::BundleSet,
) -> Result<Vec<ListEntry>, String> {
    let set = wiki::PageSet::load(wiki_dir);
    let pages = set.require_all()?;

    let mut entries: Vec<ListEntry> = pages
        .iter()
        .filter(|page| {
            wiki::page_matches_slice(
                page,
                type_filter,
                tag_filter,
                domain_filter,
                bundles,
            )
        })
        .map(|page| {
            let metadata = &page.document.metadata;
            ListEntry {
                path: page.rel.clone(),
                title: metadata.title.clone(),
                page_type: metadata.page_type.clone(),
                tags: metadata.tags.clone(),
            }
        })
        .collect();

    // Sort by path ascending.
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/// Format list entries for human-readable output.
///
/// Uses `"  {path} — {title}"` format per line (matching the search output
/// style but without the `[score: N]` suffix).
pub fn format_list(entries: &[ListEntry]) -> String {
    if entries.is_empty() {
        return "未找到匹配的页面".to_string();
    }
    let mut lines: Vec<String> = Vec::with_capacity(entries.len());
    for e in entries {
        lines.push(format!("  {} — {}", e.path, e.title));
    }
    lines.join("\n")
}

/// Format list entries as a 2-space pretty-printed JSON array.
pub fn format_list_json(entries: &[ListEntry]) -> String {
    serde_json::to_string_pretty(entries).unwrap_or_else(|_| "[]".to_string())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::{temp_dir, write_page};

    /// An empty bundle set for a plain (non-aggregated) root.
    fn no_bundles() -> wiki::BundleSet {
        wiki::BundleSet::default()
    }
    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Empty wiki
    // -------------------------------------------------------------------

    #[test]
    fn test_empty_wiki() {
        let dir = temp_dir("empty");
        let entries = list_pages(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert!(entries.is_empty());
    }

    // -------------------------------------------------------------------
    // List all pages
    // -------------------------------------------------------------------

    #[test]
    fn test_list_all_pages() {
        let dir = temp_dir("all");
        write_page(
            &dir,
            "concepts/npc.md",
            "---\ntitle: NPC\ntype: concept\ntags: [rpg]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n# NPC\n",
        );
        write_page(
            &dir,
            "entities/weapon.md",
            "---\ntitle: Weapon\ntype: entity\ntags: [item]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n# Weapon\n",
        );
        write_page(
            &dir,
            "shared/overview.md",
            "---\ntitle: Shared\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n# Shared\n",
        );

        let entries = list_pages(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(entries.len(), 3);
        // Sorted by path.
        assert_eq!(entries[0].path, "concepts/npc.md");
        assert_eq!(entries[1].path, "entities/weapon.md");
        assert_eq!(entries[2].path, "shared/overview.md");
    }

    // -------------------------------------------------------------------
    // --type filter
    // -------------------------------------------------------------------

    #[test]
    fn test_list_type_filter() {
        let dir = temp_dir("type");
        write_page(
            &dir,
            "concepts/one.md",
            "---\ntitle: One\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "entities/one.md",
            "---\ntitle: Entity One\ntype: entity\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );

        let entries =
            list_pages(&dir, Some("concept"), None, None, &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].page_type, "concept");
    }

    #[test]
    fn test_list_type_filter_case_insensitive() {
        let dir = temp_dir("type_ci");
        write_page(
            &dir,
            "concepts/one.md",
            "---\ntitle: One\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries =
            list_pages(&dir, Some("Concept"), None, None, &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_list_type_filter_substring() {
        let dir = temp_dir("type_sub");
        write_page(
            &dir,
            "concepts/one.md",
            "---\ntitle: One\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "analysis/two.md",
            "---\ntitle: Two\ntype: analysis\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries = list_pages(&dir, Some("ana"), None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].page_type, "analysis");
    }

    // -------------------------------------------------------------------
    // --tag filter
    // -------------------------------------------------------------------

    #[test]
    fn test_list_tag_filter() {
        let dir = temp_dir("tag");
        write_page(
            &dir,
            "concepts/auth.md",
            "---\ntitle: Auth\ntype: concept\ntags: [access-control]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "concepts/misc.md",
            "---\ntitle: Misc\ntype: concept\ntags: [other]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );

        let entries =
            list_pages(&dir, None, Some("access"), None, &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_list_tag_filter_substring() {
        let dir = temp_dir("tag_sub");
        write_page(
            &dir,
            "concepts/auth.md",
            "---\ntitle: Auth\ntype: concept\ntags: [access-control]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries =
            list_pages(&dir, None, Some("control"), None, &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_list_tag_filter_case_insensitive() {
        let dir = temp_dir("tag_ci");
        write_page(
            &dir,
            "concepts/auth.md",
            "---\ntitle: Auth\ntype: concept\ntags: [Access]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries =
            list_pages(&dir, None, Some("access"), None, &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
    }

    // -------------------------------------------------------------------
    // --domain filter
    // -------------------------------------------------------------------

    #[test]
    fn test_list_domain_filter() {
        let dir = temp_dir("domain");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/concepts/b.md",
            "---\ntitle: B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );

        let entries =
            list_pages(&dir, None, None, Some("shared"), &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].path.starts_with("shared/"));
    }

    #[test]
    fn test_list_domain_filter_case_insensitive() {
        let dir = temp_dir("domain_ci");
        write_page(
            &dir,
            "Shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries =
            list_pages(&dir, None, None, Some("shared"), &no_bundles())
                .expect("valid pages");
        assert_eq!(entries.len(), 1);
    }

    // -------------------------------------------------------------------
    // Combined filters (AND)
    // -------------------------------------------------------------------

    #[test]
    fn test_list_combined_filters() {
        let dir = temp_dir("combined");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: [access]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/b.md",
            "---\ntitle: B\ntype: entity\ntags: [access]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "shared/concepts/c.md",
            "---\ntitle: C\ntype: concept\ntags: [misc]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );

        // Only concept pages in shared domain with "access" tag.
        let entries = list_pages(
            &dir,
            Some("concept"),
            Some("access"),
            Some("shared"),
            &no_bundles(),
        )
        .expect("valid pages");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "shared/concepts/a.md");
    }

    // -------------------------------------------------------------------
    // No match
    // -------------------------------------------------------------------

    #[test]
    fn test_list_no_match() {
        let dir = temp_dir("no_match");
        write_page(
            &dir,
            "concepts/one.md",
            "---\ntitle: One\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        let entries =
            list_pages(&dir, Some("entity"), None, None, &no_bundles())
                .expect("valid pages");
        assert!(entries.is_empty());
    }

    // -------------------------------------------------------------------
    // ListEntry fields
    // -------------------------------------------------------------------

    #[test]
    fn test_list_entry_fields() {
        let dir = temp_dir("fields");
        write_page(
            &dir,
            "concepts/test.md",
            "---\ntitle: My Page\ntype: analysis\ntags: [tag1, tag2]\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\nBody.",
        );
        let entries = list_pages(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].path.ends_with("concepts/test.md"));
        assert_eq!(entries[0].title, "My Page");
        assert_eq!(entries[0].page_type, "analysis");
        assert_eq!(entries[0].tags, vec!["tag1", "tag2"]);
    }

    #[test]
    fn test_list_invalid_page_fails() {
        let dir = temp_dir("invalid_page");
        write_page(&dir, "concepts/nofrontmatter.md", "# No Frontmatter\n");
        let error = list_pages(&dir, None, None, None, &no_bundles())
            .expect_err("invalid page must fail the listing");
        assert!(
            error.contains("concepts/nofrontmatter.md"),
            "error must name the page: {error}"
        );
    }

    // -------------------------------------------------------------------
    // format_list
    // -------------------------------------------------------------------

    #[test]
    fn test_format_list_empty() {
        let entries: Vec<ListEntry> = Vec::new();
        let output = format_list(&entries);
        assert_eq!(output, "未找到匹配的页面");
    }

    #[test]
    fn test_format_list_results() {
        let entries = vec![ListEntry {
            path: "concepts/test.md".to_string(),
            title: "Test Page".to_string(),
            page_type: "concept".to_string(),
            tags: vec![],
        }];
        let output = format_list(&entries);
        assert!(output.contains("concepts/test.md"));
        assert!(output.contains("Test Page"));
        // Should NOT contain score.
        assert!(!output.contains("[score:"));
    }

    // -------------------------------------------------------------------
    // format_list_json
    // -------------------------------------------------------------------

    #[test]
    fn test_format_list_json_empty() {
        let entries: Vec<ListEntry> = Vec::new();
        let output = format_list_json(&entries);
        assert_eq!(output, "[]");
    }

    #[test]
    fn test_format_list_json_structure() {
        let entries = vec![ListEntry {
            path: "concepts/test.md".to_string(),
            title: "Test".to_string(),
            page_type: "concept".to_string(),
            tags: vec!["a".to_string(), "b".to_string()],
        }];
        let output = format_list_json(&entries);
        assert!(output.contains("\"path\": \"concepts/test.md\""));
        assert!(output.contains("\"title\": \"Test\""));
        assert!(output.contains("\"type\": \"concept\""));
        assert!(output.contains("\"tags\": ["));
        assert!(output.contains("\"a\""));
        assert!(output.contains("\"b\""));
    }

    // -------------------------------------------------------------------
    // Sorting
    // -------------------------------------------------------------------

    #[test]
    fn test_list_sorted_by_path() {
        let dir = temp_dir("sort");
        write_page(
            &dir,
            "z/concepts/a.md",
            "---\ntitle: Z-A\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "a/concepts/b.md",
            "---\ntitle: A-B\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );
        write_page(
            &dir,
            "m/concepts/c.md",
            "---\ntitle: M-C\ntype: concept\ntags: []\nstatus: draft\nlast_validated: 2026-01-01\ntimeliness: current\n---\n",
        );

        let entries = list_pages(&dir, None, None, None, &no_bundles())
            .expect("valid pages");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "a/concepts/b.md");
        assert_eq!(entries[1].path, "m/concepts/c.md");
        assert_eq!(entries[2].path, "z/concepts/a.md");
    }
}
