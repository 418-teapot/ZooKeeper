//! Aggregate — shared field-value aggregation for `zwiki tags`, `zwiki
//! types`, `zwiki domains`.
//!
//! Provides a single `aggregate_field` function that iterates wiki pages,
//! applies optional slice filters, and counts occurrences of a specific
//! frontmatter or structural field.  Results are returned as a
//! `BTreeMap<String, usize>` (sorted by key).

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::wiki;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A single value-count pair for aggregate output.
#[derive(Debug, Clone, Serialize)]
pub struct ValueCount {
    /// The field value (tag name, type string, or domain name).
    pub value: String,
    /// Number of pages having this value.
    pub count: usize,
}

/// Which field to aggregate over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregateField {
    /// Aggregate the `tags` frontmatter field (each tag individually).
    Tags,
    /// Aggregate the `type` frontmatter field.
    Types,
    /// Aggregate the domain (first path component of `rel`).
    Domains,
}

impl AggregateField {
    /// Human-readable "not found" message for this field.
    #[must_use]
    pub const fn not_found_msg(self) -> &'static str {
        match self {
            Self::Tags => "未找到匹配的标签",
            Self::Types => "未找到匹配的类型",
            Self::Domains => "未找到匹配的领域",
        }
    }
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/// Aggregate field values across wiki pages with optional slice filters.
///
/// All filters are optional and use AND semantics.  When a filter is
/// provided, only pages matching that filter contribute to the counts.
pub fn aggregate_field(
    wiki_dir: &Path,
    field: AggregateField,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
) -> BTreeMap<String, usize> {
    let pages = wiki::discover_pages(wiki_dir);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();

    for path in &pages {
        let Some(page) = wiki::read_page_at(path, wiki_dir) else {
            continue;
        };

        // Apply slice filters (AND semantics).
        if !wiki::page_matches_slice(
            &page,
            type_filter,
            tag_filter,
            domain_filter,
        ) {
            continue;
        }

        // --- Aggregate target field ---

        match field {
            AggregateField::Tags => {
                let tags = wiki::extract_tags(&page.frontmatter);
                for tag in tags {
                    *counts.entry(tag).or_insert(0) += 1;
                }
            }
            AggregateField::Types => {
                // Skip pages without a type (consistent with status
                // by_type skip-empty rule).
                if let Some(t) =
                    page.frontmatter.get("type").and_then(|v| v.as_str())
                    && !t.is_empty()
                {
                    *counts.entry(t.to_string()).or_insert(0) += 1;
                }
            }
            AggregateField::Domains => {
                // Only count pages with a directory component (exclude
                // root-level files like overview.md).
                if page.rel.contains('/') {
                    let domain =
                        page.rel.split('/').next().unwrap_or("").to_string();
                    *counts.entry(domain).or_insert(0) += 1;
                }
            }
        }
    }

    counts
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/// Convert a `BTreeMap` of counts into a sorted `Vec<ValueCount>`.
fn sorted_counts(counts: &BTreeMap<String, usize>) -> Vec<ValueCount> {
    counts
        .iter()
        .map(|(value, count)| ValueCount {
            value: value.clone(),
            count: *count,
        })
        .collect()
}

/// Format aggregated counts for human-readable output.
///
/// Uses `"  {value} — {count} 页"` format per line, sorted by value
/// ascending.  When no counts, emits a field-specific "not found" message.
pub fn format_aggregate_human(
    counts: &BTreeMap<String, usize>,
    field: AggregateField,
) -> String {
    if counts.is_empty() {
        return field.not_found_msg().to_string();
    }
    let items = sorted_counts(counts);
    let mut lines: Vec<String> = Vec::with_capacity(items.len());
    for item in &items {
        lines.push(crate::display::count_line(&item.value, item.count));
    }
    lines.join("\n")
}

/// Format aggregated counts as a 2-space pretty-printed JSON array.
pub fn format_aggregate_json(counts: &BTreeMap<String, usize>) -> String {
    let items = sorted_counts(counts);
    serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".to_string())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("zwiki-test")
            .join("aggregate")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write_page(wiki_root: &Path, rel: &str, content: &str) {
        let path = wiki_root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(&path, content).expect("failed to write page");
    }

    // -------------------------------------------------------------------
    // Tags: empty wiki
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_empty_wiki() {
        let dir = temp_dir("tags_empty");
        let counts =
            aggregate_field(&dir, AggregateField::Tags, None, None, None);
        assert!(counts.is_empty());
    }

    // -------------------------------------------------------------------
    // Tags: all pages
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_all_pages() {
        let dir = temp_dir("tags_all");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "shared/concepts/b.md",
            "---\ntitle: B\ntype: concept\ntags: [auth, access]\n---\n",
        );
        write_page(
            &dir,
            "shared/concepts/c.md",
            "---\ntitle: C\ntype: entity\ntags: [database, access]\n---\n",
        );

        let counts =
            aggregate_field(&dir, AggregateField::Tags, None, None, None);
        assert_eq!(counts.len(), 3);
        assert_eq!(counts.get("auth"), Some(&2_usize));
        assert_eq!(counts.get("access"), Some(&2_usize));
        assert_eq!(counts.get("database"), Some(&1_usize));
        // Sorted by key (BTreeMap).
        let keys: Vec<&String> = counts.keys().collect();
        assert_eq!(keys, vec!["access", "auth", "database"]);
    }

    // -------------------------------------------------------------------
    // Tags: single-string tag
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_single_string_field() {
        let dir = temp_dir("tags_single_str");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: single-tag\n---\n",
        );
        write_page(
            &dir,
            "shared/b.md",
            "---\ntitle: B\ntype: concept\ntags: [multi, tags]\n---\n",
        );

        let counts =
            aggregate_field(&dir, AggregateField::Tags, None, None, None);
        assert_eq!(counts.len(), 3);
        assert_eq!(counts.get("single-tag"), Some(&1_usize));
        assert_eq!(counts.get("multi"), Some(&1_usize));
        assert_eq!(counts.get("tags"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Tags: empty / missing tags field
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_empty_field() {
        let dir = temp_dir("tags_empty_field");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "shared/b.md",
            "---\ntitle: B\ntype: entity\n---\n", // no tags field
        );

        let counts =
            aggregate_field(&dir, AggregateField::Tags, None, None, None);
        assert!(counts.is_empty());
    }

    // -------------------------------------------------------------------
    // Tags: type filter
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_type_filter() {
        let dir = temp_dir("tags_type_filter");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/b.md",
            "---\ntitle: B\ntype: entity\ntags: [auth]\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Tags,
            Some("concept"),
            None,
            None,
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("auth"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Tags: domain filter
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_domain_filter() {
        let dir = temp_dir("tags_domain_filter");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/concepts/b.md",
            "---\ntitle: B\ntype: concept\ntags: [auth]\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Tags,
            None,
            None,
            Some("shared"),
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("auth"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Tags: combined filters
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_combined_filters() {
        let dir = temp_dir("tags_combined");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/b.md",
            "---\ntitle: B\ntype: entity\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/concepts/c.md",
            "---\ntitle: C\ntype: concept\ntags: [auth]\n---\n",
        );

        // concept + shared: only page a should match.
        let counts = aggregate_field(
            &dir,
            AggregateField::Tags,
            Some("concept"),
            None,
            Some("shared"),
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("auth"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Tags: case-insensitive filters
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_type_filter_case_insensitive() {
        let dir = temp_dir("tags_type_ci");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: Concept\ntags: [auth]\n---\n",
        );
        let counts = aggregate_field(
            &dir,
            AggregateField::Tags,
            Some("concept"),
            None,
            None,
        );
        assert_eq!(counts.len(), 1);
    }

    #[test]
    fn test_tags_tag_filter_case_insensitive() {
        let dir = temp_dir("tags_tag_ci");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: [Auth]\n---\n",
        );
        let counts = aggregate_field(
            &dir,
            AggregateField::Tags,
            None,
            Some("auth"),
            None,
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("Auth"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Types: all pages
    // -------------------------------------------------------------------

    #[test]
    fn test_types_all_pages() {
        let dir = temp_dir("types_all");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "shared/concepts/b.md",
            "---\ntitle: B\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/c.md",
            "---\ntitle: C\ntype: entity\ntags: []\n---\n",
        );

        let counts =
            aggregate_field(&dir, AggregateField::Types, None, None, None);
        assert_eq!(counts.len(), 2);
        assert_eq!(counts.get("concept"), Some(&2_usize));
        assert_eq!(counts.get("entity"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Types: missing type field
    // -------------------------------------------------------------------

    #[test]
    fn test_types_no_type_field() {
        let dir = temp_dir("types_no_type");
        write_page(&dir, "shared/a.md", "---\ntitle: A\ntags: []\n---\n");
        let counts =
            aggregate_field(&dir, AggregateField::Types, None, None, None);
        // Missing type is skipped (consistent with status by_type).
        assert!(counts.is_empty());
    }

    // -------------------------------------------------------------------
    // Types: tag filter
    // -------------------------------------------------------------------

    #[test]
    fn test_types_tag_filter() {
        let dir = temp_dir("types_tag_filter");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "shared/b.md",
            "---\ntitle: B\ntype: concept\ntags: [misc]\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Types,
            None,
            Some("auth"),
            None,
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("concept"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Types: domain filter
    // -------------------------------------------------------------------

    #[test]
    fn test_types_domain_filter() {
        let dir = temp_dir("types_domain_filter");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/b.md",
            "---\ntitle: B\ntype: entity\ntags: []\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Types,
            None,
            None,
            Some("shared"),
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("concept"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Domains: all pages
    // -------------------------------------------------------------------

    #[test]
    fn test_domains_all_pages() {
        let dir = temp_dir("domains_all");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/b.md",
            "---\ntitle: B\ntype: entity\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/concepts/c.md",
            "---\ntitle: C\ntype: concept\ntags: []\n---\n",
        );

        let counts =
            aggregate_field(&dir, AggregateField::Domains, None, None, None);
        assert_eq!(counts.len(), 2);
        assert_eq!(counts.get("shared"), Some(&2_usize));
        assert_eq!(counts.get("autoresearch"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Domains: root-level file excluded
    // -------------------------------------------------------------------

    #[test]
    fn test_domains_root_files_excluded() {
        let dir = temp_dir("domains_root_excl");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        // Root-level file (no directory component).
        write_page(
            &dir,
            "overview.md",
            "---\ntitle: Overview\ntype: synthesis\ntags: []\n---\n",
        );

        let counts =
            aggregate_field(&dir, AggregateField::Domains, None, None, None);
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("shared"), Some(&1_usize));
        assert!(!counts.contains_key("overview"));
    }

    // -------------------------------------------------------------------
    // Domains: type and tag filters
    // -------------------------------------------------------------------

    #[test]
    fn test_domains_type_filter() {
        let dir = temp_dir("domains_type_filter");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "shared/entities/b.md",
            "---\ntitle: B\ntype: entity\ntags: []\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/concepts/c.md",
            "---\ntitle: C\ntype: concept\ntags: []\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Domains,
            Some("entity"),
            None,
            None,
        );
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("shared"), Some(&1_usize));
    }

    #[test]
    fn test_domains_tag_filter() {
        let dir = temp_dir("domains_tag_filter");
        write_page(
            &dir,
            "shared/a.md",
            "---\ntitle: A\ntype: concept\ntags: [auth]\n---\n",
        );
        write_page(
            &dir,
            "shared/b.md",
            "---\ntitle: B\ntype: concept\ntags: [misc]\n---\n",
        );
        write_page(
            &dir,
            "autoresearch/c.md",
            "---\ntitle: C\ntype: concept\ntags: [auth]\n---\n",
        );

        let counts = aggregate_field(
            &dir,
            AggregateField::Domains,
            None,
            Some("auth"),
            None,
        );
        assert_eq!(counts.len(), 2);
        assert_eq!(counts.get("shared"), Some(&1_usize));
        assert_eq!(counts.get("autoresearch"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // format_aggregate_human
    // -------------------------------------------------------------------

    #[test]
    fn test_format_human_empty_tags() {
        let counts = BTreeMap::new();
        let output = format_aggregate_human(&counts, AggregateField::Tags);
        assert_eq!(output, "未找到匹配的标签");
    }

    #[test]
    fn test_format_human_empty_types() {
        let counts = BTreeMap::new();
        let output = format_aggregate_human(&counts, AggregateField::Types);
        assert_eq!(output, "未找到匹配的类型");
    }

    #[test]
    fn test_format_human_empty_domains() {
        let counts = BTreeMap::new();
        let output = format_aggregate_human(&counts, AggregateField::Domains);
        assert_eq!(output, "未找到匹配的领域");
    }

    #[test]
    fn test_format_human_tags() {
        let mut counts = BTreeMap::new();
        counts.insert("auth".to_string(), 3);
        counts.insert("database".to_string(), 1);
        let output = format_aggregate_human(&counts, AggregateField::Tags);
        assert!(output.contains("  auth — 3 页"));
        assert!(output.contains("  database — 1 页"));
        // Sorted by value ascending.
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines[0], "  auth — 3 页");
        assert_eq!(lines[1], "  database — 1 页");
    }

    #[test]
    fn test_format_human_types() {
        let mut counts = BTreeMap::new();
        counts.insert("concept".to_string(), 5);
        counts.insert("entity".to_string(), 2);
        let output = format_aggregate_human(&counts, AggregateField::Types);
        assert!(output.contains("  concept — 5 页"));
        assert!(output.contains("  entity — 2 页"));
    }

    #[test]
    fn test_format_human_domains() {
        let mut counts = BTreeMap::new();
        counts.insert("autoresearch".to_string(), 3);
        counts.insert("shared".to_string(), 7);
        let output = format_aggregate_human(&counts, AggregateField::Domains);
        assert!(output.contains("  autoresearch — 3 页"));
        assert!(output.contains("  shared — 7 页"));
    }

    // -------------------------------------------------------------------
    // format_aggregate_json
    // -------------------------------------------------------------------

    #[test]
    fn test_format_json_empty() {
        let counts = BTreeMap::new();
        let output = format_aggregate_json(&counts);
        assert_eq!(output, "[]");
    }

    #[test]
    fn test_format_json_structure() {
        let mut counts = BTreeMap::new();
        counts.insert("auth".to_string(), 2);
        counts.insert("database".to_string(), 1);
        let output = format_aggregate_json(&counts);
        assert!(output.contains(r#""value": "auth""#));
        assert!(output.contains(r#""count": 2"#));
        assert!(output.contains(r#""value": "database""#));
        assert!(output.contains(r#""count": 1"#));
    }

    // -------------------------------------------------------------------
    // sorted_counts ordering
    // -------------------------------------------------------------------

    #[test]
    fn test_sorted_counts_order() {
        let mut counts = BTreeMap::new();
        counts.insert("z".to_string(), 1);
        counts.insert("a".to_string(), 2);
        counts.insert("m".to_string(), 3);
        let items = sorted_counts(&counts);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].value, "a");
        assert_eq!(items[1].value, "m");
        assert_eq!(items[2].value, "z");
    }
}
