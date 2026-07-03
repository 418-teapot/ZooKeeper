//! Status — `zwiki status` subcommand.
//!
//! Computes and displays a health overview of the wiki: total page count,
//! distributions by type, domain, status, and timeliness, and the range of
//! `last_validated` dates.  Supports optional slice filters (`--type`,
//! `--tag`, `--domain`) to scope the report to a subset of pages.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::Path;

use chrono::NaiveDate;
use serde::Serialize;

use crate::wiki;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// Date range for the `last_validated` field.
#[derive(Debug, Clone, Serialize)]
pub struct DateRange {
    /// Earliest date (formatted as YYYY-MM-DD), or `None` if unavailable.
    pub earliest: Option<String>,
    /// Latest date (formatted as YYYY-MM-DD), or `None` if unavailable.
    pub latest: Option<String>,
}

/// Health status report for the wiki.
#[derive(Debug, Clone, Serialize)]
pub struct StatusReport {
    /// Total page count (after slice filter, if any).
    pub total: usize,
    /// Distribution by page type (`type` frontmatter field).
    pub by_type: BTreeMap<String, usize>,
    /// Distribution by domain (first path component).
    pub by_domain: BTreeMap<String, usize>,
    /// Distribution by status (`status` frontmatter field).
    pub by_status: BTreeMap<String, usize>,
    /// Distribution by timeliness (`timeliness` frontmatter field).
    pub by_timeliness: BTreeMap<String, usize>,
    /// Range of `last_validated` dates.
    pub last_validated_range: DateRange,
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
/// Pages without a `status` or `timeliness` field do **not** contribute
/// to those distributions.
pub fn compute_status(
    wiki_dir: &Path,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
) -> StatusReport {
    let pages = wiki::discover_pages(wiki_dir);

    let mut by_type: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_domain: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_timeliness: BTreeMap<String, usize> = BTreeMap::new();
    let mut total: usize = 0;
    let mut earliest_date: Option<NaiveDate> = None;
    let mut latest_date: Option<NaiveDate> = None;

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

        // --- Distribution counts ---

        total += 1;

        // Type (only pages that have one).
        if let Some(t) = page.frontmatter.get("type").and_then(|v| v.as_str())
            && !t.is_empty()
        {
            *by_type.entry(t.to_string()).or_insert(0) += 1;
        }

        // Domain (first path component; root-level files excluded to
        // match validate_domain's directory-only rule).
        if page.rel.contains('/') {
            let domain = page.rel.split('/').next().unwrap_or("").to_string();
            *by_domain.entry(domain).or_insert(0) += 1;
        }

        // Status (only pages that have one).
        if let Some(s) = page.frontmatter.get("status").and_then(|v| v.as_str())
            && !s.is_empty()
        {
            *by_status.entry(s.to_string()).or_insert(0) += 1;
        }

        // Timeliness (only pages that have one).
        if let Some(t) =
            page.frontmatter.get("timeliness").and_then(|v| v.as_str())
            && !t.is_empty()
        {
            *by_timeliness.entry(t.to_string()).or_insert(0) += 1;
        }

        // last_validated range.
        if let Some(lv) =
            page.frontmatter.get("last_validated").and_then(|v| v.as_str())
            && let Some(date) = wiki::parse_date(lv)
        {
            if earliest_date.is_none_or(|e| date < e) {
                earliest_date = Some(date);
            }
            if latest_date.is_none_or(|l| date > l) {
                latest_date = Some(date);
            }
        }
    }

    let date_range = DateRange {
        earliest: earliest_date.map(|d| d.format("%Y-%m-%d").to_string()),
        latest: latest_date.map(|d| d.format("%Y-%m-%d").to_string()),
    };

    StatusReport {
        total,
        by_type,
        by_domain,
        by_status,
        by_timeliness,
        last_validated_range: date_range,
    }
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

    // Status distribution.
    output.push_str("\n状态分布:\n");
    for (k, v) in &report.by_status {
        let _ = writeln!(output, "{}", crate::display::count_line(k, *v));
    }

    // Timeliness distribution.
    output.push_str("\n时效性:\n");
    for (k, v) in &report.by_timeliness {
        let _ = writeln!(output, "{}", crate::display::count_line(k, *v));
    }

    // Date range.
    output.push_str("\n最近验证范围: ");
    match (
        &report.last_validated_range.earliest,
        &report.last_validated_range.latest,
    ) {
        (Some(e), Some(l)) => {
            let _ = write!(output, "{e} ~ {l}");
        }
        _ => output.push('无'),
    }
    output.push('\n');

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
    use std::fs;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("status").join(name);
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

    /// Create a page with the given properties for status testing.
    fn make_page(
        wiki_root: &Path,
        rel: &str,
        page_type: &str,
        status: &str,
        timeliness: &str,
        last_validated: &str,
        tags: &[&str],
    ) {
        let tags_str = if tags.is_empty() {
            "[]".to_string()
        } else {
            let items: Vec<String> =
                tags.iter().map(|t| format!("\"{t}\"")).collect();
            format!("[{}]", items.join(", "))
        };
        let title = rel.split('/').next_back().unwrap_or("page");
        let content = format!(
            "---\ntitle: {title}\ntype: {page_type}\nstatus: {status}\n\
             timeliness: {timeliness}\nlast_validated: {last_validated}\n\
             tags: {tags_str}\n---\n# {title}\n",
        );
        write_page(wiki_root, rel, &content);
    }

    // -------------------------------------------------------------------
    // Empty wiki
    // -------------------------------------------------------------------

    #[test]
    fn test_empty_wiki() {
        let dir = temp_dir("empty");
        let report = compute_status(&dir, None, None, None);
        assert_eq!(report.total, 0);
        assert!(report.by_type.is_empty());
        assert!(report.by_domain.is_empty());
        assert!(report.by_status.is_empty());
        assert!(report.by_timeliness.is_empty());
        assert!(report.last_validated_range.earliest.is_none());
        assert!(report.last_validated_range.latest.is_none());
    }

    // -------------------------------------------------------------------
    // Full status (all pages)
    // -------------------------------------------------------------------

    #[test]
    fn test_status_all_pages() {
        let dir = temp_dir("all_pages");
        make_page(
            &dir,
            "shared/concepts/foo.md",
            "concept",
            "stable",
            "current",
            "2025-01-15",
            &["access"],
        );
        make_page(
            &dir,
            "shared/entities/bar.md",
            "entity",
            "draft",
            "stale",
            "2024-06-01",
            &["item"],
        );
        make_page(
            &dir,
            "autoresearch/concepts/baz.md",
            "concept",
            "stable",
            "current",
            "2025-03-01",
            &["research"],
        );

        let report = compute_status(&dir, None, None, None);
        assert_eq!(report.total, 3);

        // Type distribution: concept: 2, entity: 1
        assert_eq!(report.by_type.get("concept"), Some(&2_usize));
        assert_eq!(report.by_type.get("entity"), Some(&1_usize));

        // Domain distribution.
        assert_eq!(report.by_domain.get("shared"), Some(&2_usize));
        assert_eq!(report.by_domain.get("autoresearch"), Some(&1_usize));

        // Status distribution.
        assert_eq!(report.by_status.get("stable"), Some(&2_usize));
        assert_eq!(report.by_status.get("draft"), Some(&1_usize));

        // Timeliness distribution.
        assert_eq!(report.by_timeliness.get("current"), Some(&2_usize));
        assert_eq!(report.by_timeliness.get("stale"), Some(&1_usize));

        // Date range.
        assert_eq!(
            report.last_validated_range.earliest,
            Some("2024-06-01".to_string())
        );
        assert_eq!(
            report.last_validated_range.latest,
            Some("2025-03-01".to_string())
        );
    }

    // -------------------------------------------------------------------
    // Pages without status / timeliness
    // -------------------------------------------------------------------

    #[test]
    fn test_status_missing_fields() {
        let dir = temp_dir("missing_fields");
        // A page without status, timeliness, or last_validated.
        write_page(
            &dir,
            "shared/concepts/nofields.md",
            "---\ntitle: No Fields\ntype: concept\n---\n# No Fields\n",
        );

        let report = compute_status(&dir, None, None, None);
        assert_eq!(report.total, 1);
        assert_eq!(report.by_type.get("concept"), Some(&1_usize));
        assert!(report.by_status.is_empty());
        assert!(report.by_timeliness.is_empty());
        assert!(report.last_validated_range.earliest.is_none());
        assert!(report.last_validated_range.latest.is_none());
    }

    #[test]
    fn test_status_missing_type_excluded_from_by_type() {
        let dir = temp_dir("missing_type");
        // Page without a type field — should count in total but not in
        // by_type (consistent with by_status/by_timeliness skip-empty rule).
        write_page(
            &dir,
            "shared/concepts/notype.md",
            "---\ntitle: No Type\nstatus: stable\n---\n# No Type\n",
        );

        let report = compute_status(&dir, None, None, None);
        assert_eq!(report.total, 1);
        assert!(report.by_type.is_empty());
        assert_eq!(report.by_status.get("stable"), Some(&1_usize));
    }

    // -------------------------------------------------------------------
    // Slice: by type
    // -------------------------------------------------------------------

    #[test]
    fn test_status_type_slice() {
        let dir = temp_dir("type_slice");
        make_page(
            &dir,
            "shared/concepts/a.md",
            "concept",
            "stable",
            "current",
            "2025-01-01",
            &[],
        );
        make_page(
            &dir,
            "shared/entities/b.md",
            "entity",
            "draft",
            "stale",
            "2024-01-01",
            &[],
        );

        let report = compute_status(&dir, Some("concept"), None, None);
        assert_eq!(report.total, 1);
        assert_eq!(report.by_type.get("concept"), Some(&1_usize));
        assert!(!report.by_type.contains_key("entity"));
    }

    // -------------------------------------------------------------------
    // Slice: by tag
    // -------------------------------------------------------------------

    #[test]
    fn test_status_tag_slice() {
        let dir = temp_dir("tag_slice");
        make_page(
            &dir,
            "shared/concepts/a.md",
            "concept",
            "stable",
            "current",
            "2025-01-01",
            &["access"],
        );
        make_page(
            &dir,
            "shared/concepts/b.md",
            "concept",
            "draft",
            "stale",
            "2024-01-01",
            &["misc"],
        );

        let report = compute_status(&dir, None, Some("access"), None);
        assert_eq!(report.total, 1);
    }

    // -------------------------------------------------------------------
    // Slice: by domain
    // -------------------------------------------------------------------

    #[test]
    fn test_status_domain_slice() {
        let dir = temp_dir("domain_slice");
        make_page(
            &dir,
            "shared/concepts/a.md",
            "concept",
            "stable",
            "current",
            "2025-01-01",
            &[],
        );
        make_page(
            &dir,
            "autoresearch/concepts/b.md",
            "concept",
            "draft",
            "stale",
            "2024-01-01",
            &[],
        );

        let report = compute_status(&dir, None, None, Some("shared"));
        assert_eq!(report.total, 1);
        assert!(report.by_domain.contains_key("shared"));
        assert!(!report.by_domain.contains_key("autoresearch"));
    }

    #[test]
    fn test_status_by_domain_excludes_root_files() {
        let dir = temp_dir("root_file_domain");
        make_page(
            &dir,
            "shared/concepts/a.md",
            "concept",
            "stable",
            "current",
            "2025-01-01",
            &[],
        );
        // Root-level file (no directory component).
        write_page(
            &dir,
            "overview.md",
            "---\ntitle: Overview\ntype: synthesis\n---\n# Overview\n",
        );

        let report = compute_status(&dir, None, None, None);
        assert_eq!(report.total, 2);
        assert!(report.by_domain.contains_key("shared"));
        // Root-level files must not appear as domains.
        assert!(!report.by_domain.contains_key("overview.md"));
    }

    // -------------------------------------------------------------------
    // Date range edge cases
    // -------------------------------------------------------------------

    #[test]
    fn test_status_invalid_dates_ignored() {
        let dir = temp_dir("bad_dates");
        write_page(
            &dir,
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\nstatus: stable\n\
             last_validated: not-a-date\n---\n# A\n",
        );
        let report = compute_status(&dir, None, None, None);
        assert!(report.last_validated_range.earliest.is_none());
        assert!(report.last_validated_range.latest.is_none());
    }

    #[test]
    fn test_status_single_date() {
        let dir = temp_dir("single_date");
        make_page(
            &dir,
            "shared/concepts/a.md",
            "concept",
            "stable",
            "current",
            "2025-06-15",
            &[],
        );
        let report = compute_status(&dir, None, None, None);
        assert_eq!(
            report.last_validated_range.earliest,
            Some("2025-06-15".to_string())
        );
        assert_eq!(
            report.last_validated_range.latest,
            Some("2025-06-15".to_string())
        );
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
            by_status: BTreeMap::new(),
            by_timeliness: BTreeMap::new(),
            last_validated_range: DateRange { earliest: None, latest: None },
        };
        let output = format_status(&report, None, None, None);
        assert!(output.contains("页面总数: 0"));
        assert!(output.contains("最近验证范围: 无"));
    }

    #[test]
    fn test_format_status_with_slice() {
        let report = StatusReport {
            total: 2,
            by_type: BTreeMap::from([("concept".to_string(), 2)]),
            by_domain: BTreeMap::from([("shared".to_string(), 2)]),
            by_status: BTreeMap::new(),
            by_timeliness: BTreeMap::new(),
            last_validated_range: DateRange { earliest: None, latest: None },
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
            by_status: BTreeMap::from([
                ("draft".to_string(), 1),
                ("stable".to_string(), 2),
            ]),
            by_timeliness: BTreeMap::from([
                ("current".to_string(), 2),
                ("stale".to_string(), 1),
            ]),
            last_validated_range: DateRange {
                earliest: Some("2024-06-01".to_string()),
                latest: Some("2025-03-01".to_string()),
            },
        };
        let output = format_status(&report, None, None, None);
        assert!(output.contains("页面总数: 3"));
        assert!(output.contains("类型分布:"));
        assert!(output.contains("  concept — 2 页"));
        assert!(output.contains("  entity — 1 页"));
        assert!(output.contains("领域分布:"));
        assert!(output.contains("  autoresearch — 1 页"));
        assert!(output.contains("  shared — 2 页"));
        assert!(output.contains("状态分布:"));
        assert!(output.contains("  draft — 1 页"));
        assert!(output.contains("  stable — 2 页"));
        assert!(output.contains("时效性:"));
        assert!(output.contains("  current — 2 页"));
        assert!(output.contains("  stale — 1 页"));
        assert!(output.contains("最近验证范围: 2024-06-01 ~ 2025-03-01"));
    }

    #[test]
    fn test_format_status_multi_filter_slice() {
        let report = StatusReport {
            total: 1,
            by_type: BTreeMap::from([("concept".to_string(), 1)]),
            by_domain: BTreeMap::from([("shared".to_string(), 1)]),
            by_status: BTreeMap::new(),
            by_timeliness: BTreeMap::new(),
            last_validated_range: DateRange { earliest: None, latest: None },
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
            by_status: BTreeMap::new(),
            by_timeliness: BTreeMap::new(),
            last_validated_range: DateRange { earliest: None, latest: None },
        };
        let output = format_status_json(&report);
        assert!(output.contains("\"total\": 0"));
        assert!(output.contains("\"by_type\": {}"));
        assert!(output.contains("\"by_domain\": {}"));
        assert!(output.contains("\"by_status\": {}"));
        assert!(output.contains("\"by_timeliness\": {}"));
        assert!(output.contains("\"last_validated_range\": {"));
        assert!(output.contains("\"earliest\": null"));
        assert!(output.contains("\"latest\": null"));
    }

    #[test]
    fn test_format_status_json_full() {
        let report = StatusReport {
            total: 2,
            by_type: BTreeMap::from([("concept".to_string(), 2)]),
            by_domain: BTreeMap::from([("shared".to_string(), 2)]),
            by_status: BTreeMap::from([("stable".to_string(), 2)]),
            by_timeliness: BTreeMap::from([("current".to_string(), 2)]),
            last_validated_range: DateRange {
                earliest: Some("2024-01-01".to_string()),
                latest: Some("2025-01-01".to_string()),
            },
        };
        let output = format_status_json(&report);
        assert!(output.contains("\"total\": 2"));
        assert!(output.contains("\"concept\": 2"));
        assert!(output.contains("\"shared\": 2"));
        assert!(output.contains("\"stable\": 2"));
        assert!(output.contains("\"current\": 2"));
        assert!(output.contains("\"earliest\": \"2024-01-01\""));
        assert!(output.contains("\"latest\": \"2025-01-01\""));
    }
}
