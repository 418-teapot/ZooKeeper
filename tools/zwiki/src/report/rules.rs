//! Rule detection of the `check` report.
//!
//! A rule turns one detection result into a report issue: a stable machine
//! identifier, a short Chinese message, and the structured facts of the
//! finding.  The health and lint modules keep their own grouping; the
//! report flattens it.

use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};

use crate::catalog::Catalog;
use crate::display::{CheckResults, Issue, LintResults};
use crate::freshness;
use crate::wiki::{Page, PageSet};

use super::ReportIssue;

/// Stable identifier of a report rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// A page holds no body text, or only a stub.
    EmptyPage,
    /// A page on disk is missing from every index.
    IndexEntryMissing,
    /// An index lists a page that is not on disk.
    IndexTargetMissing,
    /// A source page has no log entry.
    LogMissing,
    /// The document model rejected a page.
    PageInvalid,
    /// The `type` value is not valid.
    InvalidType,
    /// A date field is not a valid date.
    InvalidDate,
    /// A frontmatter finding without a specific rule.
    InvalidFrontmatter,
    /// Body text links a system file.
    SystemFileLink,
    /// A source page has no `resource` field.
    MissingResource,
    /// The `resource` value is not valid.
    InvalidResource,
    /// A term has no inline link at its first occurrence.
    MissingInlineLink,
    /// The body links one target more than once.
    DuplicateInlineLink,
    /// A markdown link names no page.
    BrokenLink,
    /// A page has no inbound link.
    OrphanPage,
    /// The body is shorter than the sparse threshold.
    SparsePage,
    /// The page cites a superseded page.
    CascadeStale,
    /// A source page is newer than the page's `timestamp`.
    SourceNewer,
    /// The store root index is missing or does not list an installed bundle.
    RootIndex,
    /// An installed bundle is missing from the store root.
    BundleMissing,
}

impl Rule {
    /// Stable label used in the JSON report.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EmptyPage => "empty_page",
            Self::IndexEntryMissing => "index_entry_missing",
            Self::IndexTargetMissing => "index_target_missing",
            Self::LogMissing => "log_missing",
            Self::PageInvalid => "page_invalid",
            Self::InvalidType => "invalid_type",
            Self::InvalidDate => "invalid_date",
            Self::InvalidFrontmatter => "invalid_frontmatter",
            Self::SystemFileLink => "system_file_link",
            Self::MissingResource => "missing_resource",
            Self::InvalidResource => "invalid_resource",
            Self::MissingInlineLink => "missing_inline_link",
            Self::DuplicateInlineLink => "duplicate_inline_link",
            Self::BrokenLink => "broken_link",
            Self::OrphanPage => "orphan_page",
            Self::SparsePage => "sparse_page",
            Self::CascadeStale => "cascade_stale",
            Self::SourceNewer => "source_newer",
            Self::RootIndex => "root_index",
            Self::BundleMissing => "bundle_missing",
        }
    }
}

impl Serialize for Rule {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// Report the findings of the health and lint checks of one snapshot.
#[must_use]
pub fn from_health_lint(
    health: &CheckResults,
    lint: &LintResults,
) -> Vec<ReportIssue> {
    let mut issues = health_issues(health);
    issues.extend(lint_issues(lint));
    issues
}

/// Report the findings of the health checks.
fn health_issues(health: &CheckResults) -> Vec<ReportIssue> {
    let mut issues: Vec<ReportIssue> = Vec::new();

    for issue in &health.empty_files {
        let (total_bytes, body_bytes) = byte_counts(&issue.details);
        let message = if issue.category == "empty" {
            "页面没有正文"
        } else {
            "页面正文过短"
        };
        issues.push(issue_of(
            Rule::EmptyPage,
            &issue.page,
            message,
            json!({"total_bytes": total_bytes, "body_bytes": body_bytes}),
        ));
    }

    for path in &health.index_sync.on_disk_not_in_index {
        issues.push(issue_of(
            Rule::IndexEntryMissing,
            path,
            "页面未收录到任何索引",
            json!({"indexed": false}),
        ));
    }
    for path in &health.index_sync.in_index_not_on_disk {
        issues.push(issue_of(
            Rule::IndexTargetMissing,
            path,
            "索引引用的页面不存在",
            json!({"exists_on_disk": false}),
        ));
    }

    for issue in &health.log_coverage {
        issues.push(issue_of(
            Rule::LogMissing,
            &issue.page,
            "源页面缺少日志记录",
            json!({"title": issue.details}),
        ));
    }

    issues.extend(health.frontmatter.iter().map(frontmatter_issue));

    for issue in &health.system_file_links {
        issues.push(issue_of(
            Rule::SystemFileLink,
            &issue.page,
            "正文链接指向系统文件",
            json!({"detail": issue.details}),
        ));
    }

    for issue in &health.source_field {
        let (rule, message) = if issue.category == "missing_resource_field" {
            (Rule::MissingResource, "源页面缺少 resource 字段")
        } else {
            (Rule::InvalidResource, "resource 字段值无效")
        };
        issues.push(issue_of(
            rule,
            &issue.page,
            message,
            json!({"detail": issue.details}),
        ));
    }

    for issue in &health.missing_inline_links {
        issues.push(issue_of(
            Rule::MissingInlineLink,
            &issue.page,
            "术语首次出现时缺少内联链接",
            json_details(issue),
        ));
    }
    for issue in &health.duplicate_inline_links {
        issues.push(issue_of(
            Rule::DuplicateInlineLink,
            &issue.page,
            "同一目标存在重复内联链接",
            json_details(issue),
        ));
    }

    issues
}

/// Report the findings of the lint checks.
fn lint_issues(lint: &LintResults) -> Vec<ReportIssue> {
    let mut issues: Vec<ReportIssue> = Vec::new();

    for issue in &lint.broken_links {
        issues.push(issue_of(
            Rule::BrokenLink,
            &issue.page,
            "链接目标不存在",
            json_details(issue),
        ));
    }
    for issue in &lint.orphan_pages {
        issues.push(issue_of(
            Rule::OrphanPage,
            &issue.page,
            "页面没有入链",
            json_details(issue),
        ));
    }
    for issue in &lint.sparse_pages {
        issues.push(issue_of(
            Rule::SparsePage,
            &issue.page,
            "正文长度低于阈值",
            json_details(issue),
        ));
    }
    for issue in &lint.cascade_stale {
        issues.push(issue_of(
            Rule::CascadeStale,
            &issue.page,
            "页面引用了已被取代的页面",
            json_details(issue),
        ));
    }

    issues
}

/// Report one issue per derived page and source that outdates it.
///
/// The judgment uses the full timestamp of both pages, so a source updated
/// later on the same day still counts.
///
/// # Errors
///
/// Fails when the pages carry no bundle identity, as a `sources` entry is
/// resolved through the catalog.
pub fn from_source_relations(
    root: &Path,
    set: &PageSet,
) -> Result<Vec<ReportIssue>, String> {
    let pages = set.pages();
    let catalog = Catalog::new(root, set)?;
    let by_rel: std::collections::HashMap<&str, &Page> =
        pages.iter().map(|page| (page.rel.as_str(), page)).collect();

    let mut issues: Vec<ReportIssue> = Vec::new();
    for page in pages {
        for newer in freshness::newer_sources(page, &by_rel, &catalog) {
            issues.push(issue_of(
                Rule::SourceNewer,
                &page.rel,
                "来源页面的确认时间晚于本页的确认时间",
                json!({
                    "source": newer.source,
                    "source_timestamp": newer.source_timestamp,
                    "derived_timestamp": newer.derived_timestamp,
                }),
            ));
        }
    }
    Ok(issues)
}

/// One report issue.
fn issue_of(
    rule: Rule,
    path: &str,
    message: &str,
    details: Value,
) -> ReportIssue {
    ReportIssue {
        rule,
        path: path.to_string(),
        message: message.to_string(),
        details,
    }
}

/// Turn one frontmatter finding into a report issue.
fn frontmatter_issue(issue: &Issue) -> ReportIssue {
    let (head, value) =
        issue.category.split_once(':').unwrap_or((issue.category.as_str(), ""));
    match head {
        "invalid_document" => issue_of(
            Rule::PageInvalid,
            &issue.page,
            "页面无法通过解析",
            json!({"error": issue.details}),
        ),
        "invalid_type" => issue_of(
            Rule::InvalidType,
            &issue.page,
            "type 字段值无效",
            json!({"field": "type", "value": value}),
        ),
        "invalid_date" => issue_of(
            Rule::InvalidDate,
            &issue.page,
            "日期字段值无效",
            json!({"field": value}),
        ),
        _ => issue_of(
            Rule::InvalidFrontmatter,
            &issue.page,
            "frontmatter 字段无效",
            json!({"category": issue.category, "detail": issue.details}),
        ),
    }
}

/// The `(total_bytes, body_bytes)` pair an empty-file finding carries.
fn byte_counts(details: &str) -> (u64, u64) {
    let mut parts = details.split(':').map(|part| part.parse().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// The structured details of a finding that already holds JSON.
fn json_details(issue: &Issue) -> Value {
    serde_json::from_str(&issue.details)
        .unwrap_or_else(|_| json!({"detail": issue.details}))
}
