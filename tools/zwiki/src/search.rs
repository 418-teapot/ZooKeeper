//! Search — `zwiki search` subcommand.
//!
//! Uses `rg` (ripgrep) for candidate detection with in-process fallback
//! when `rg` is unavailable.  Scoring: title = 4, tag = 3, heading = 2,
//! body = 1.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};
use std::process;

use std::fmt::Write;

use serde::Serialize;
use serde_json::Value;

use crate::contradictions::{self, ContradictionEntry};
use crate::wiki;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A single search result.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    /// Wiki-relative path.
    pub path: String,
    /// Page title from frontmatter (or filename stem fallback).
    pub title: String,
    /// Accumulated score.
    pub score: usize,
    /// Page type from frontmatter.
    #[serde(rename = "type")]
    pub page_type: String,
    /// Tags from frontmatter.
    pub tags: Vec<String>,
    /// Contradiction entries found on this page.
    pub contradictions: Vec<ContradictionEntry>,
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

/// Search engine that finds and scores wiki pages for a given query.
pub struct SearchEngine {
    wiki_root: PathBuf,
}

impl SearchEngine {
    /// Create a new search engine for the given wiki root.
    #[must_use]
    pub const fn new(wiki_root: PathBuf) -> Self {
        Self { wiki_root }
    }

    /// Run a search across the wiki.
    ///
    /// Attempts to use `rg` (ripgrep) for candidate detection.  Falls back
    /// to in-process scanning if `rg` is unavailable or fails unexpectedly.
    /// rg exit code 1 (no matches) is handled as an empty candidate set,
    /// not an error.
    pub fn search(
        &self,
        query: &str,
        type_filter: Option<&str>,
        tag_filter: Option<&str>,
        domain_filter: Option<&str>,
    ) -> Vec<SearchResult> {
        if query.is_empty() {
            return Vec::new();
        }

        // Attempt rg-based candidate detection.
        let candidates = match self.try_rg_candidates(query) {
            Ok(paths) => paths,
            Err(()) => self.in_process_candidates(query),
        };

        // Score and filter candidates.
        let mut results: Vec<SearchResult> = candidates
            .iter()
            .filter_map(|path| score_page(path, &self.wiki_root, query))
            .filter(|r| r.score > 0)
            .collect();

        // Apply post-score filters (on frontmatter fields that require
        // parsed pages).
        if let Some(tf) = type_filter {
            let tf_lower = tf.to_lowercase();
            results.retain(|r| r.page_type.to_lowercase().contains(&tf_lower));
        }
        if let Some(tf) = tag_filter {
            let tf_lower = tf.to_lowercase();
            results.retain(|r| {
                r.tags.iter().any(|t| t.to_lowercase().contains(&tf_lower))
            });
        }
        if let Some(df) = domain_filter {
            let df_lower = df.to_lowercase();
            results.retain(|r| {
                r.path
                    .split('/')
                    .next()
                    .is_some_and(|d| d.to_lowercase() == df_lower)
            });
        }

        // Sort by score descending.  Stable sort preserves doc-order for
        // ties (alphabetical by rel path from page iteration).
        results.sort_by_key(|r| Reverse(r.score));
        results
    }

    /// Attempt to find candidate files using `rg`.
    ///
    /// Returns `Ok(paths)` on success, `Err(())` if rg is unavailable
    /// or fails unexpectedly (exit codes other than 0 or 1).
    fn try_rg_candidates(&self, query: &str) -> Result<Vec<PathBuf>, ()> {
        let output = process::Command::new("rg")
            .arg("--files-with-matches")
            .arg("--ignore-case")
            .arg("--fixed-strings")
            .arg(query)
            .arg(&self.wiki_root)
            .output()
            .map_err(|_| ())?; // spawn failure -> fallback

        match output.status.code() {
            Some(0) => {
                // Matches found.  Keep only files that are valid wiki
                // pages (apply the same exclusions as page discovery:
                // meta files, templates/, tools/, raw/).
                let known: std::collections::HashSet<PathBuf> =
                    wiki::discover_pages(&self.wiki_root).into_iter().collect();
                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout
                    .lines()
                    .map(PathBuf::from)
                    .filter(|p| known.contains(p))
                    .collect())
            }
            Some(1) => {
                // No matches (rg exits 1 when nothing is found).
                Ok(Vec::new())
            }
            _ => {
                // Other error -> fallback to in-process.
                Err(())
            }
        }
    }

    /// Find candidate files by scanning all wiki pages in-process.
    fn in_process_candidates(&self, query: &str) -> Vec<PathBuf> {
        let query_lower = query.to_lowercase();
        wiki::discover_pages(&self.wiki_root)
            .into_iter()
            .filter(|path| {
                let content = wiki::read_file(path);
                content.to_lowercase().contains(&query_lower)
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Page scoring
// ---------------------------------------------------------------------------

/// Score a single page for the given query.
///
/// Returns `None` if the page cannot be read.
fn score_page(
    path: &Path,
    wiki_root: &Path,
    query: &str,
) -> Option<SearchResult> {
    let page = wiki::read_page_at(path, wiki_root)?;
    let query_lower = query.to_lowercase();

    let mut score: usize = 0;

    // 1. Title match (weight 4).
    if let Some(title_val) =
        page.frontmatter.get("title").and_then(|v| v.as_str())
        && title_val.to_lowercase().contains(&query_lower)
    {
        score += 4;
    }

    // 2. Tags match (weight 3 per matching tag).
    if let Some(tags_val) = page.frontmatter.get("tags") {
        match tags_val {
            Value::Array(arr) => {
                for v in arr {
                    if let Some(tag) = v.as_str()
                        && tag.to_lowercase().contains(&query_lower)
                    {
                        score += 3;
                    }
                }
            }
            Value::String(s) if s.to_lowercase().contains(&query_lower) => {
                score += 3;
            }
            _ => {}
        }
    }

    // 3. Heading match (weight 2 per heading line).
    for line in page.body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#')
            && line.to_lowercase().contains(&query_lower)
        {
            score += 2;
        }
    }

    // 4. Body match (weight 1 per occurrence).
    let body_lower = page.body.to_lowercase();
    let body_count = count_substrings(&body_lower, &query_lower);
    score += body_count;

    // Extract contradiction entries from the already-read raw content.
    let contradictions = contradictions::parse_contradictions(&page.raw);

    // Extract display fields.
    let title =
        page.frontmatter.get("title").and_then(|v| v.as_str()).map_or_else(
            || {
                // Fallback: filename stem.
                page.path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string()
            },
            ToString::to_string,
        );
    let page_type = page
        .frontmatter
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tags = wiki::extract_tags(&page.frontmatter);

    Some(SearchResult {
        path: page.rel,
        title,
        score,
        page_type,
        tags,
        contradictions,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Count non-overlapping occurrences of `needle` in `haystack`.
///
/// Both parameters should already be lowercased for case-insensitive matching.
#[must_use]
fn count_substrings(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        count += 1;
        start += pos + needle.len();
    }
    count
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/// Format search results for human-readable output.
pub fn format_results(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "未找到匹配的页面".to_string();
    }
    let mut lines: Vec<String> = Vec::new();
    for r in results {
        let mut line =
            format!("  {} — {} [score: {}]", r.path, r.title, r.score);
        if !r.contradictions.is_empty() {
            let _ = write!(line, " [!×{}]", r.contradictions.len());
        }
        lines.push(line);
    }
    lines.join("\n")
}

/// Format search results as a 2-space pretty-printed JSON array.
pub fn format_results_json(results: &[SearchResult]) -> String {
    serde_json::to_string_pretty(results).unwrap_or_else(|_| "[]".to_string())
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

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("search").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    /// Write a wiki page file under `wiki_root` with the given relative
    /// path and content.  Creates parent directories as needed.
    fn write_page(wiki_root: &Path, rel: &str, content: &str) -> PathBuf {
        let path = wiki_root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(&path, content).expect("failed to write page");
        path
    }

    /// Create a `SearchEngine` for a temp wiki root, write some pages,
    /// and return the engine + root for test assertions.
    fn setup_engine(
        test_name: &str,
        pages: &[(&str, &str)],
    ) -> (SearchEngine, PathBuf) {
        let root = temp_dir(test_name);
        for (rel, content) in pages {
            write_page(&root, rel, content);
        }
        (SearchEngine::new(root.clone()), root)
    }

    // -------------------------------------------------------------------
    // count_substrings
    // -------------------------------------------------------------------

    #[test]
    fn test_count_substrings_empty_haystack() {
        assert_eq!(count_substrings("", "test"), 0);
    }

    #[test]
    fn test_count_substrings_empty_needle() {
        assert_eq!(count_substrings("hello", ""), 0);
    }

    #[test]
    fn test_count_substrings_no_match() {
        assert_eq!(count_substrings("hello world", "xyz"), 0);
    }

    #[test]
    fn test_count_substrings_single_match() {
        assert_eq!(count_substrings("hello world", "world"), 1);
    }

    #[test]
    fn test_count_substrings_multiple_matches() {
        assert_eq!(count_substrings("aa bb aa cc aa", "aa"), 3);
    }

    #[test]
    fn test_count_substrings_overlap_not_double_counted() {
        // "aaaa" contains "aa" at positions 0 and 2 when non-overlapping.
        assert_eq!(count_substrings("aaaa", "aa"), 2);
    }

    // -------------------------------------------------------------------
    // Scoring: four-tier weights
    // -------------------------------------------------------------------

    #[test]
    fn test_score_title_weight() {
        let (engine, _) = setup_engine(
            "score_title",
            &[(
                "concepts/test.md",
                "---\ntitle: Permission System\ntype: concept\ntags: [auth]\n---\n\n# Test\n\nBody about foo.",
            )],
        );
        // "Permission" matches title -> +4, nothing else.
        let results = engine.search("Permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 4);
    }

    #[test]
    fn test_score_tag_weight() {
        let (engine, _) = setup_engine(
            "score_tag",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: [auth, permission, access]\n---\n\n# Test\n\nBody.",
            )],
        );
        // "mission" matches "permission" tag -> +3.
        let results = engine.search("mission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 3);
    }

    #[test]
    fn test_score_tag_multiple_matches() {
        let (engine, _) = setup_engine(
            "score_tag_multi",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: [auth-tag, perm-tag]\n---\n\n# Test\n\nBody.",
            )],
        );
        // "tag" matches both tags -> +3 +3 = +6.
        let results = engine.search("tag", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 6);
    }

    #[test]
    fn test_score_heading_weight() {
        let (engine, _) = setup_engine(
            "score_heading",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\n# Intro\n\n## Permission Overview\n\nBody.",
            )],
        );
        // "Permission" matches heading -> +2.  The heading text is also
        // part of body, so body count adds +1.  Total: 3.
        let results = engine.search("Permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 3);
    }

    #[test]
    fn test_score_heading_multiple_lines() {
        let (engine, _) = setup_engine(
            "score_heading_multi",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\n# Intro\n\n## Permission One\n\n## Permission Two\n\nBody.",
            )],
        );
        // Two headings match -> +2 +2 = +4.  Each heading line is also
        // in the body, so body count adds +2.  Total: 6.
        let results = engine.search("Permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 6);
    }

    #[test]
    fn test_score_body_weight() {
        let (engine, _) = setup_engine(
            "score_body",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\n# Test\n\nThe permission system handles access control.",
            )],
        );
        // "permission" appears once in body -> +1.
        let results = engine.search("permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 1);
    }

    #[test]
    fn test_score_body_multiple_occurrences() {
        let (engine, _) = setup_engine(
            "score_body_multi",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\n# Test\n\npermission one. permission two. permission three.",
            )],
        );
        // "permission" appears three times -> +3.
        let results = engine.search("permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 3);
    }

    #[test]
    fn test_score_accumulation_all_tiers() {
        let (engine, _) = setup_engine(
            "score_all",
            &[(
                "concepts/test.md",
                "---\ntitle: Permission System\ntype: concept\ntags: [permissions, auth]\n---\n\n# Intro\n\n## Permission Overview\n\nThis page describes the permission system.",
            )],
        );
        // title "Permission" -> +4
        // tags: "permissions" matches "mission" -> +3
        // heading: "## Permission Overview" -> +2
        // body: "permission" appears in heading (1) and body (1) -> +2
        // Total: 4 + 3 + 2 + 2 = 11
        let results = engine.search("mission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 11);
    }

    // -------------------------------------------------------------------
    // Case-insensitivity
    // -------------------------------------------------------------------

    #[test]
    fn test_case_insensitive_title() {
        let (engine, _) = setup_engine(
            "ci_title",
            &[(
                "concepts/test.md",
                "---\ntitle: Permission System\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 4);
    }

    #[test]
    fn test_case_insensitive_tags() {
        let (engine, _) = setup_engine(
            "ci_tags",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: [AuthZ]\n---\n\nBody.",
            )],
        );
        let results = engine.search("authz", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 3);
    }

    #[test]
    fn test_case_insensitive_body() {
        let (engine, _) = setup_engine(
            "ci_body",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\nPERMISSION is IMPORTANT.",
            )],
        );
        let results = engine.search("permission", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 1);
    }

    // -------------------------------------------------------------------
    // Score accumulation across multiple matches
    // -------------------------------------------------------------------

    #[test]
    fn test_score_accumulation_tag_and_body() {
        let (engine, _) = setup_engine(
            "accum_tag_body",
            &[(
                "concepts/test.md",
                "---\ntitle: Foo\ntype: concept\ntags: [test-tag]\n---\n\n# Test\n\ntest-tag is mentioned. Also test-tag again.",
            )],
        );
        // tags: "test-tag" matches "test" -> +3
        // heading: "# Test" matches "test" -> +2
        // body: "test" appears in heading (1) + "test-tag" (2) -> +3
        // Total: 3 + 2 + 3 = 8
        let results = engine.search("test", None, None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].score, 8);
    }

    // -------------------------------------------------------------------
    // --type filter
    // -------------------------------------------------------------------

    #[test]
    fn test_type_filter_exact_match() {
        let (engine, _) = setup_engine(
            "type_exact",
            &[
                (
                    "concepts/perm.md",
                    "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody about permission.",
                ),
                (
                    "entities/perm.md",
                    "---\ntitle: Permission Entity\ntype: entity\ntags: []\n---\n\nBody.",
                ),
            ],
        );
        let results = engine.search("permission", Some("concept"), None, None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_type, "concept");
    }

    #[test]
    fn test_type_filter_case_insensitive() {
        let (engine, _) = setup_engine(
            "type_ci",
            &[(
                "concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", Some("Concept"), None, None);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_type_filter_no_match() {
        let (engine, _) = setup_engine(
            "type_no_match",
            &[(
                "concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", Some("entity"), None, None);
        assert_eq!(results.len(), 0);
    }

    // -------------------------------------------------------------------
    // --tag filter
    // -------------------------------------------------------------------

    #[test]
    fn test_tag_filter_exact_match() {
        let (engine, _) = setup_engine(
            "tag_exact",
            &[
                (
                    "concepts/perm.md",
                    "---\ntitle: Permission\ntype: concept\ntags: [auth, access]\n---\n\nBody.",
                ),
                (
                    "concepts/foo.md",
                    "---\ntitle: Foo\ntype: concept\ntags: [misc]\n---\n\nBody.",
                ),
            ],
        );
        let results = engine.search("permission", None, Some("auth"), None);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_tag_filter_substring() {
        let (engine, _) = setup_engine(
            "tag_substr",
            &[(
                "concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: [access-control]\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", None, Some("access"), None);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_tag_filter_no_match() {
        let (engine, _) = setup_engine(
            "tag_no_match",
            &[(
                "concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: [auth]\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", None, Some("database"), None);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_tag_filter_case_insensitive() {
        let (engine, _) = setup_engine(
            "tag_ci",
            &[(
                "concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: [Access]\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", None, Some("access"), None);
        assert_eq!(results.len(), 1);
    }

    // -------------------------------------------------------------------
    // Combined --type + --tag filter
    // -------------------------------------------------------------------

    #[test]
    fn test_type_and_tag_filter() {
        let (engine, _) = setup_engine(
            "type_and_tag",
            &[
                (
                    "concepts/perm.md",
                    "---\ntitle: Permission\ntype: concept\ntags: [auth]\n---\n\nBody.",
                ),
                (
                    "entities/perm.md",
                    "---\ntitle: Permission Entity\ntype: entity\ntags: [auth]\n---\n\nBody.",
                ),
                (
                    "concepts/noauth.md",
                    "---\ntitle: No Auth\ntype: concept\ntags: [misc]\n---\n\nBody.",
                ),
            ],
        );
        // Only concept pages with auth tag.
        let results =
            engine.search("permission", Some("concept"), Some("auth"), None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_type, "concept");
    }

    // -------------------------------------------------------------------
    // --domain filter
    // -------------------------------------------------------------------

    #[test]
    fn test_domain_filter_match() {
        let (engine, _) = setup_engine(
            "domain_match",
            &[
                (
                    "shared/concepts/perm.md",
                    "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
                ),
                (
                    "autoresearch/concepts/perm.md",
                    "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
                ),
            ],
        );
        let results = engine.search("permission", None, None, Some("shared"));
        assert_eq!(results.len(), 1);
        assert!(results[0].path.starts_with("shared/"));
    }

    #[test]
    fn test_domain_filter_case_insensitive() {
        let (engine, _) = setup_engine(
            "domain_ci",
            &[(
                "Shared/concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results = engine.search("permission", None, None, Some("shared"));
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_domain_filter_no_match() {
        let (engine, _) = setup_engine(
            "domain_no_match",
            &[(
                "shared/concepts/perm.md",
                "---\ntitle: Permission\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results =
            engine.search("permission", None, None, Some("autoresearch"));
        assert_eq!(results.len(), 0);
    }

    // -------------------------------------------------------------------
    // SearchResult fields
    // -------------------------------------------------------------------

    #[test]
    fn test_result_contains_correct_fields() {
        let (engine, _) = setup_engine(
            "result_fields",
            &[(
                "concepts/test.md",
                "---\ntitle: My Page\ntype: analysis\ntags: [tag1, tag2]\n---\n\nBody.",
            )],
        );
        let results = engine.search("Body", None, None, None);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("concepts/test.md"));
        assert_eq!(results[0].title, "My Page");
        assert_eq!(results[0].page_type, "analysis");
        assert_eq!(results[0].tags, vec!["tag1", "tag2"]);
    }

    // -------------------------------------------------------------------
    // No match
    // -------------------------------------------------------------------

    #[test]
    fn test_no_match_returns_empty() {
        let (engine, _) = setup_engine(
            "no_match",
            &[(
                "concepts/foo.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\nNothing here.",
            )],
        );
        let results =
            engine.search("nonexistent_query_xyz123", None, None, None);
        assert!(results.is_empty());
    }

    #[test]
    fn test_empty_query_returns_empty() {
        let (engine, _) = setup_engine(
            "empty_query",
            &[(
                "concepts/foo.md",
                "---\ntitle: Foo\ntype: concept\ntags: []\n---\n\nBody.",
            )],
        );
        let results = engine.search("", None, None, None);
        assert!(results.is_empty());
    }

    // -------------------------------------------------------------------
    // format_results
    // -------------------------------------------------------------------

    #[test]
    fn test_format_results_no_match() {
        let results: Vec<SearchResult> = Vec::new();
        let output = format_results(&results);
        assert_eq!(output, "未找到匹配的页面");
    }

    #[test]
    fn test_format_results_with_match() {
        let results = vec![SearchResult {
            path: "concepts/test.md".to_string(),
            title: "Test Page".to_string(),
            score: 5,
            page_type: "concept".to_string(),
            tags: vec![],
            contradictions: vec![],
        }];
        let output = format_results(&results);
        assert!(output.contains("concepts/test.md"));
        assert!(output.contains("Test Page"));
        assert!(output.contains("[score: 5]"));
    }

    #[test]
    fn test_format_results_json_empty() {
        let results: Vec<SearchResult> = Vec::new();
        let output = format_results_json(&results);
        assert_eq!(output, "[]");
    }

    #[test]
    fn test_format_results_json_structure() {
        let results = vec![SearchResult {
            path: "concepts/test.md".to_string(),
            title: "Test".to_string(),
            score: 4,
            page_type: "concept".to_string(),
            tags: vec!["a".to_string(), "b".to_string()],
            contradictions: vec![],
        }];
        let output = format_results_json(&results);
        assert!(output.contains("\"path\": \"concepts/test.md\""));
        assert!(output.contains("\"title\": \"Test\""));
        assert!(output.contains("\"score\": 4"));
        assert!(output.contains("\"type\": \"concept\""));
        assert!(output.contains("\"tags\": ["));
        assert!(output.contains("\"a\""));
        assert!(output.contains("\"b\""));
    }

    // -------------------------------------------------------------------
    // Sorting: by score descending
    // -------------------------------------------------------------------

    #[test]
    fn test_results_sorted_by_score_descending() {
        let (engine, _) = setup_engine(
            "sort_score",
            &[
                (
                    "low.md",
                    "---\ntitle: Low Match\ntype: concept\ntags: []\n---\n\npermission appears once in body only.",
                ),
                (
                    "high.md",
                    "---\ntitle: Permission Title\ntype: concept\ntags: [permission]\n---\n\npermission body.",
                ),
            ],
        );
        let results = engine.search("permission", None, None, None);
        assert_eq!(results.len(), 2);
        // high.md: title(4) + tag(3) + body(1) = 8
        // low.md: body(1) = 1
        assert!(results[0].score >= results[1].score);
        assert!(results[0].path.ends_with("high.md"));
        assert!(results[1].path.ends_with("low.md"));
    }

    // -------------------------------------------------------------------
    // Integration: in-process scanning (fallback path)
    // -------------------------------------------------------------------

    #[test]
    fn test_in_process_fallback_matches() {
        let (engine, _) = setup_engine(
            "inproc",
            &[
                (
                    "concepts/a.md",
                    "---\ntitle: Alpha\ntype: concept\ntags: []\n---\n\nTarget word here.",
                ),
                (
                    "concepts/b.md",
                    "---\ntitle: Beta\ntype: concept\ntags: []\n---\n\nNothing.",
                ),
            ],
        );
        let results = engine.search("Target", None, None, None);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("concepts/a.md"));
    }

    // -------------------------------------------------------------------
    // Contradictions metadata
    // -------------------------------------------------------------------

    #[test]
    fn test_search_result_contains_contradictions() {
        // Build page content with contradictions frontmatter.
        // Use a single-line string to avoid any escaping issues.
        let page_a_content = concat!(
            "---\n",
            "title: Page A\n",
            "type: concept\n",
            "tags: []\n",
            "contradictions:\n",
            "  - path: shared/page-b.md\n",
            "    claims:\n",
            "      - claim one\n",
            "    detected: 2026-07-01\n",
            "    resolution: unresolved\n",
            "---\n\nBody of page A."
        );
        // Verify parse_contradictions works on this content.
        let parsed = contradictions::parse_contradictions(page_a_content);
        assert_eq!(
            parsed.len(),
            1,
            "parse_contradictions should find 1 entry, got {}. Content: {:?}",
            parsed.len(),
            page_a_content
        );

        let (engine, _) = setup_engine(
            "search_contradictions",
            &[
                ("shared/page-a.md", page_a_content),
                (
                    "shared/page-b.md",
                    "---\ntitle: Page B\ntype: concept\ntags: []\n---\n\nBody about page B.",
                ),
            ],
        );
        let results = engine.search("Body", None, None, None);
        // Both pages match "Body".
        assert_eq!(results.len(), 2);

        // Find page-a result.
        let page_a = results
            .iter()
            .find(|r| r.path.ends_with("shared/page-a.md"))
            .expect("page-a should be in results");
        assert_eq!(page_a.contradictions.len(), 1);
        assert_eq!(page_a.contradictions[0].path, "shared/page-b.md");
        assert_eq!(page_a.contradictions[0].claims, vec!["claim one"]);
        assert_eq!(page_a.contradictions[0].detected, "2026-07-01");
        assert_eq!(page_a.contradictions[0].resolution, "unresolved");

        // page-b has no contradictions.
        let page_b = results
            .iter()
            .find(|r| r.path.ends_with("shared/page-b.md"))
            .expect("page-b should be in results");
        assert!(page_b.contradictions.is_empty());
    }

    #[test]
    fn test_format_results_shows_contradiction_indicator() {
        let results = vec![
            SearchResult {
                path: "shared/a.md".to_string(),
                title: "Page A".to_string(),
                score: 3,
                page_type: "concept".to_string(),
                tags: vec![],
                contradictions: vec![ContradictionEntry {
                    path: "shared/b.md".to_string(),
                    claims: vec!["claim".to_string()],
                    detected: "2026-07-01".to_string(),
                    resolution: "unresolved".to_string(),
                }],
            },
            SearchResult {
                path: "shared/c.md".to_string(),
                title: "Page C".to_string(),
                score: 1,
                page_type: "concept".to_string(),
                tags: vec![],
                contradictions: vec![],
            },
        ];
        let output = format_results(&results);
        assert!(
            output.contains("[!×1]"),
            "should show [!×1] for page with 1 contradiction"
        );
        // The line for page c (no contradictions) should NOT contain [!×.
        let line_c = output
            .lines()
            .find(|l| l.contains("shared/c.md"))
            .expect("page c line should exist");
        assert!(
            !line_c.contains("[!×"),
            "page without contradictions should not have [!× indicator"
        );
    }
}
