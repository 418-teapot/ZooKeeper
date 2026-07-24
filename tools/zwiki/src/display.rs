//! Output formatting — Chinese markdown reports and JSON output.

use chrono::Local;

// ---------------------------------------------------------------------------
// Section counts — must match the number of fields in CheckResults/LintResults
// ---------------------------------------------------------------------------

/// Number of health check sections.
const HEALTH_SECTION_COUNT: usize = 9;

/// Number of lint check sections.
const LINT_SECTION_COUNT: usize = 5;

/// Total number of check items across health and lint.
const TOTAL_SECTION_COUNT: usize = HEALTH_SECTION_COUNT + LINT_SECTION_COUNT;

// ---------------------------------------------------------------------------
// Issue counting
// ---------------------------------------------------------------------------

/// Sum all health issues.
#[must_use]
pub const fn count_health_issues(r: &CheckResults) -> usize {
    r.empty_files.len()
        + r.index_sync.on_disk_not_in_index.len()
        + r.index_sync.in_index_not_on_disk.len()
        + r.log_coverage.len()
        + r.frontmatter.len()
        + r.related_field.len()
        + r.related_body_consistency.len()
        + r.source_field.len()
        + r.missing_inline_links.len()
        + r.duplicate_inline_links.len()
}

/// Sum all lint issues.
#[must_use]
pub const fn count_lint_issues(r: &LintResults) -> usize {
    r.broken_links.len()
        + r.orphan_pages.len()
        + r.sparse_pages.len()
        + r.stale_pages.len()
        + r.cascade_stale.len()
}

// ---------------------------------------------------------------------------
// Shared terminal line formatting
// ---------------------------------------------------------------------------

/// Format a value-count line for terminal output.
///
/// All count-style listings (tags, types, domains, status distributions)
/// use this single format to guarantee visual consistency across
/// commands.
///
/// Format: `  {value} — {count} 页` (2-space indent, em dash).
#[must_use]
pub fn count_line(value: &str, count: usize) -> String {
    format!("  {value} — {count} 页")
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CheckResults {
    pub total_pages: usize,
    pub empty_files: Vec<Issue>,
    pub index_sync: IndexSyncResult,
    pub log_coverage: Vec<Issue>,
    pub frontmatter: Vec<Issue>,
    pub related_field: Vec<Issue>,
    pub related_body_consistency: Vec<Issue>,
    pub source_field: Vec<Issue>,
    pub missing_inline_links: Vec<Issue>,
    pub duplicate_inline_links: Vec<Issue>,
}

#[derive(Debug, Clone, Default)]
pub struct IndexSyncResult {
    pub on_disk_not_in_index: Vec<String>,
    pub in_index_not_on_disk: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Issue {
    pub page: String,
    pub kind: String,
    pub details: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Current date as `YYYY-MM-DD`.
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Truncate a string for display: keep the first `max` characters,
/// replacing newlines with spaces.
fn truncate_for_display(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ");
    if flat.chars().count() <= max {
        flat
    } else {
        flat.chars().take(max).collect::<String>() + "..."
    }
}

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

fn fmt_empty_files(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 空文件 / 存根文件（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 总字节 | 正文字节 | 状态 |".to_string());
    lines.push("|---|---|---|---|".to_string());
    for issue in issues {
        // details = "{total_bytes}:{body_bytes}"
        let parts: Vec<&str> = issue.details.split(':').collect();
        let total = parts.first().unwrap_or(&"0");
        let body = parts.get(1).unwrap_or(&"0");
        let (emoji, status_cn) = if issue.kind == "empty" {
            ("🔴", "空文件")
        } else {
            ("🟡", "存根")
        };
        lines.push(format!(
            "| `{}` | {} | {} | {} {} |",
            issue.page, total, body, emoji, status_cn
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_index_sync(result: &IndexSyncResult) -> Vec<String> {
    let mut lines = Vec::new();
    let total =
        result.on_disk_not_in_index.len() + result.in_index_not_on_disk.len();
    lines.push(format!("## 索引同步（{total}）"));
    lines.push(String::new());

    if !result.in_index_not_on_disk.is_empty() {
        lines.push(
            "### 索引中存在但磁盘上已删除（in_index_not_on_disk）".to_string(),
        );
        for p in &result.in_index_not_on_disk {
            lines.push(format!("- `{p}`"));
        }
        lines.push(String::new());
    }

    if !result.on_disk_not_in_index.is_empty() {
        lines.push(
            "### 磁盘上存在但索引中未收录（on_disk_not_in_index）".to_string(),
        );
        for p in &result.on_disk_not_in_index {
            lines.push(format!("- `{p}`"));
        }
        lines.push(String::new());
    }

    lines.push(String::new());
    lines
}

fn fmt_log_coverage(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 日志覆盖（{}）", issues.len()));
    lines.push(String::new());
    lines.push("以下源页面在 logs/ 目录中没有对应的日志记录：".to_string());
    lines.push(String::new());
    for issue in issues {
        // details = title
        lines.push(format!("- `{}` — {}", issue.page, issue.details));
    }
    lines.push(String::new());
    lines
}

fn fmt_frontmatter(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## Frontmatter 完整性（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 问题 | 详情 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, issue.kind, issue.details
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_related_field(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## Relations 字段完整性（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 问题 | 详情 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, issue.kind, issue.details
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_related_body_consistency(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## Relations 与正文一致性（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 方向 | 详情 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, issue.kind, issue.details
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_source_field(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## Resource 字段验证（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 问题 | 详情 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, issue.kind, issue.details
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_missing_inline_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 缺失内联链接（{}）", issues.len()));
    lines.push(String::new());
    lines.push(
        "以下术语在正文首次出现时缺少 wiki 内联链接（仅报告每页每条术语的首次出现）："
            .to_string(),
    );
    lines.push(String::new());
    lines.push("| 页面 | 术语 | 建议链接到 | 上下文 |".to_string());
    lines.push("|---|---|---|---|".to_string());
    for issue in issues {
        // details is JSON with {term, targets, snippet}
        if let Ok(val) =
            serde_json::from_str::<serde_json::Value>(&issue.details)
        {
            let term = val["term"].as_str().unwrap_or("");
            let targets_arr = val["targets"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| format!("`{}`", v.as_str().unwrap_or("")))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let snippet = val["snippet"].as_str().unwrap_or("");
            let snippet_short = truncate_for_display(snippet, 60);
            lines.push(format!(
                "| `{}` | **{}** | {} | {} |",
                issue.page, term, targets_arr, snippet_short
            ));
        } else {
            lines.push(format!(
                "| `{}` | — | — | {} |",
                issue.page,
                truncate_for_display(&issue.details, 60)
            ));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_duplicate_inline_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 重复内联链接（{}）", issues.len()));
    lines.push(String::new());
    lines.push(
        "以下页面在正文中多次链接到同一个目标页面（Relations/Backlinks/References/Notes 已排除）："
            .to_string(),
    );
    lines.push(String::new());
    lines.push("| 页面 | 目标 | 出现位置 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        // details is JSON with {target, occurrences: [{display, line}]}
        if let Ok(val) =
            serde_json::from_str::<serde_json::Value>(&issue.details)
        {
            let target = val["target"].as_str().unwrap_or("");
            let occ_text = val["occurrences"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|o| {
                            let line = o["line"].as_u64().unwrap_or(0);
                            let display = o["display"].as_str().unwrap_or("");
                            format!("第 {line} 行「{display}」")
                        })
                        .collect::<Vec<_>>()
                        .join("；")
                })
                .unwrap_or_default();
            lines.push(format!(
                "| `{}` | `{}` | {} |",
                issue.page, target, occ_text
            ));
        } else {
            lines.push(format!(
                "| `{}` | — | {} |",
                issue.page,
                truncate_for_display(&issue.details, 60)
            ));
        }
    }
    lines.push(String::new());
    lines
}

// ---------------------------------------------------------------------------
// Public API — unified full report
// ---------------------------------------------------------------------------

/// Results from all lint checks.
#[derive(Debug, Clone, Default)]
pub struct LintResults {
    pub broken_links: Vec<Issue>,
    pub orphan_pages: Vec<Issue>,
    pub sparse_pages: Vec<Issue>,
    pub stale_pages: Vec<Issue>,
    pub cascade_stale: Vec<Issue>,
}

/// Format health + lint results as a single Chinese markdown report.
///
/// # Format
///
/// - `# Wiki 检查报告 — <date>`
/// - `<page_count> 页，<N> 项检查`
/// - All pass: `全部通过 ✅` with no sections
/// - Issues: only non-zero sections, each as `## <Title>（<count>）`
/// - Footer: `---` then `**总计：M 个问题**（健康 X + lint Y）`
#[must_use]
pub fn format_full_report(health: &CheckResults, lint: &LintResults) -> String {
    let health_total = count_health_issues(health);
    let lint_total = count_lint_issues(lint);
    let total = health_total + lint_total;

    let mut lines = Vec::new();

    // Header
    lines.push(format!("# Wiki 检查报告 — {}", today()));
    lines.push(String::new());
    lines.push(format!(
        "扫描 {} 页，{TOTAL_SECTION_COUNT} 项检查",
        health.total_pages
    ));
    lines.push(String::new());

    if total == 0 {
        lines.push("全部通过 ✅".to_string());
    } else {
        // Health sections — only non-zero
        if !health.empty_files.is_empty() {
            lines.extend(fmt_empty_files(&health.empty_files));
        }
        let index_total = health.index_sync.on_disk_not_in_index.len()
            + health.index_sync.in_index_not_on_disk.len();
        if index_total > 0 {
            lines.extend(fmt_index_sync(&health.index_sync));
        }
        if !health.log_coverage.is_empty() {
            lines.extend(fmt_log_coverage(&health.log_coverage));
        }
        if !health.frontmatter.is_empty() {
            lines.extend(fmt_frontmatter(&health.frontmatter));
        }
        if !health.related_field.is_empty() {
            lines.extend(fmt_related_field(&health.related_field));
        }
        if !health.related_body_consistency.is_empty() {
            lines.extend(fmt_related_body_consistency(
                &health.related_body_consistency,
            ));
        }
        if !health.source_field.is_empty() {
            lines.extend(fmt_source_field(&health.source_field));
        }
        if !health.missing_inline_links.is_empty() {
            lines
                .extend(fmt_missing_inline_links(&health.missing_inline_links));
        }
        if !health.duplicate_inline_links.is_empty() {
            lines.extend(fmt_duplicate_inline_links(
                &health.duplicate_inline_links,
            ));
        }

        // Lint sections — only non-zero
        if !lint.broken_links.is_empty() {
            lines.extend(fmt_broken_links(&lint.broken_links));
        }
        if !lint.orphan_pages.is_empty() {
            lines.extend(fmt_orphan_pages(&lint.orphan_pages));
        }
        if !lint.sparse_pages.is_empty() {
            lines.extend(fmt_sparse_pages(&lint.sparse_pages));
        }
        if !lint.stale_pages.is_empty() {
            lines.extend(fmt_stale_pages(&lint.stale_pages));
        }
        if !lint.cascade_stale.is_empty() {
            lines.extend(fmt_cascade_stale(&lint.cascade_stale));
        }

        // Footer
        lines.push("---".to_string());
        lines.push(String::new());
        lines.push(format!(
            "**总计：{total} 个问题**（健康 {health_total} + lint {lint_total}）"
        ));
        lines.push(String::new());
    }

    lines.join("\n")
}

fn fmt_broken_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 断裂链接（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 链接文本 | 目标路径 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        let details: serde_json::Value =
            serde_json::from_str(&issue.details).unwrap_or_default();
        let link_text = details["link_text"].as_str().unwrap_or("");
        let target_path = details["target_path"].as_str().unwrap_or("");
        lines.push(format!(
            "| `{}` | `{}` | `{}` |",
            issue.page, link_text, target_path
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_orphan_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 孤立页面（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 入链数 | 在 index 中 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        let details: serde_json::Value =
            serde_json::from_str(&issue.details).unwrap_or_default();
        let inbound = details["inbound_links"].as_u64().unwrap_or(0);
        let in_index = details["in_index"].as_bool().unwrap_or(false);
        let in_index_str = if in_index { "是" } else { "否" };
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, inbound, in_index_str
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_sparse_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 稀疏页面（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 正文长度 | 阈值 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        let details: serde_json::Value =
            serde_json::from_str(&issue.details).unwrap_or_default();
        let body_len = details["body_length"].as_u64().unwrap_or(0);
        let threshold = details["threshold"].as_u64().unwrap_or(0);
        lines.push(format!(
            "| `{}` | {} | {} |",
            issue.page, body_len, threshold
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_stale_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 过时页面（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 页面 | 时间戳 | 状态 | 距今天数 |".to_string());
    lines.push("|---|---|---|---|".to_string());
    for issue in issues {
        let details: serde_json::Value =
            serde_json::from_str(&issue.details).unwrap_or_default();
        let timestamp = details["timestamp"].as_str().unwrap_or("");
        let status = details["status"].as_str().unwrap_or("");
        let days = details["days_since_update"].as_i64().unwrap_or(0);
        lines.push(format!(
            "| `{}` | {} | {} | {} |",
            issue.page, timestamp, status, days
        ));
    }
    lines.push(String::new());
    lines
}

fn fmt_cascade_stale(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 级联过时（{}）", issues.len()));
    lines.push(String::new());
    lines.push("| 引用页面 | 被取代页面 | 取代为 |".to_string());
    lines.push("|---|---|---|".to_string());
    for issue in issues {
        let details: serde_json::Value =
            serde_json::from_str(&issue.details).unwrap_or_default();
        let superseded_page = details["superseded_page"].as_str().unwrap_or("");
        let superseded_by = details["superseded_by"].as_str().unwrap_or("");
        lines.push(format!(
            "| `{}` | `{}` | `{}` |",
            issue.page, superseded_page, superseded_by
        ));
    }
    lines.push(String::new());
    lines
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_line_format() {
        assert_eq!(count_line("auth", 3), "  auth — 3 页");
        assert_eq!(count_line("autoresearch", 15), "  autoresearch — 15 页");
    }

    #[test]
    fn test_count_line_zero() {
        assert_eq!(count_line("empty", 0), "  empty — 0 页");
    }

    /// All-pass report: only header + "全部通过 ✅", no sections, no footer.
    #[test]
    fn test_format_full_report_all_pass() {
        let health = CheckResults { total_pages: 42, ..Default::default() };
        let lint = LintResults::default();
        let report = format_full_report(&health, &lint);

        assert!(report.contains("全部通过 ✅"), "should contain all-pass");
        assert!(
            report.contains("扫描 42 页，14 项检查"),
            "header with page count"
        );
        assert!(!report.contains("## "), "no sections when all-pass: {report}");
        assert!(!report.contains("---"), "no footer when all-pass");
    }

    /// Health-only issues — only those sections appear, lint sections
    /// are omitted entirely.
    #[test]
    fn test_format_full_report_health_issues_only() {
        let mut health = CheckResults { total_pages: 10, ..Default::default() };
        health.empty_files.push(Issue {
            page: "concepts/foo.md".into(),
            kind: "stub".into(),
            details: "100:50".into(),
        });
        health.frontmatter.push(Issue {
            page: "concepts/bar.md".into(),
            kind: "missing_field:type".into(),
            details: String::new(),
        });
        let lint = LintResults::default();
        let report = format_full_report(&health, &lint);

        assert!(
            report.contains("## 空文件 / 存根文件（1）"),
            "non-zero section present"
        );
        assert!(
            report.contains("## Frontmatter 完整性（1）"),
            "non-zero section present"
        );
        assert!(!report.contains("## 断裂链接"), "zero lint section absent");
        assert!(!report.contains("## 孤立页面"), "zero lint section absent");
        assert!(report.contains("concepts/foo.md"));
        assert!(report.contains("concepts/bar.md"));
        assert!(report.contains("**总计：2 个问题**（健康 2 + lint 0）"));
    }

    /// Lint-only issues — only those sections appear.
    #[test]
    fn test_format_full_report_lint_issues_only() {
        let health = CheckResults::default();
        let mut lint = LintResults::default();
        lint.broken_links.push(Issue {
            page: "concepts/bad.md".into(),
            kind: "target_not_found".into(),
            details: r#"{"link_text":"bad link","target_path":"nope.md"}"#
                .into(),
        });
        let report = format_full_report(&health, &lint);

        assert!(report.contains("## 断裂链接（1）"), "non-zero lint section");
        assert!(!report.contains("## 空文件"), "zero health section absent");
        assert!(report.contains("concepts/bad.md"));
        assert!(report.contains("**总计：1 个问题**（健康 0 + lint 1）"));
    }

    /// Mixed health + lint issues: only non-zero sections appear.
    #[test]
    fn test_format_full_report_mixed_issues() {
        let mut health = CheckResults { total_pages: 20, ..Default::default() };
        health.log_coverage.push(Issue {
            page: "sources/rfc.md".into(),
            kind: "missing_log".into(),
            details: "RFC-001".into(),
        });
        let mut lint = LintResults::default();
        lint.orphan_pages.push(Issue {
            page: "concepts/ghost.md".into(),
            kind: "orphan".into(),
            details: r#"{"inbound_links":0,"in_index":false}"#.into(),
        });
        lint.stale_pages.push(Issue {
            page: "concepts/old.md".into(),
            kind: "stale".into(),
            details:
                r#"{"timestamp":"2020-01-01","status":"draft","days_since_update":2000}"#.into(),
        });
        let report = format_full_report(&health, &lint);

        assert!(report.contains("## 日志覆盖（1）"));
        assert!(report.contains("## 孤立页面（1）"));
        assert!(report.contains("## 过时页面（1）"));
        assert!(!report.contains("## 空文件"), "zero health section");
        assert!(!report.contains("## 断裂链接"), "zero lint section");
        assert!(report.contains("**总计：3 个问题**（健康 1 + lint 2）"));
    }

    /// Section titles for lint use pure Chinese (no English annotation).
    #[test]
    fn test_format_full_report_lint_section_titles_pure_chinese() {
        let health = CheckResults { total_pages: 1, ..Default::default() };
        let mut lint = LintResults::default();
        lint.broken_links.push(Issue {
            page: "a.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        lint.orphan_pages.push(Issue {
            page: "b.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        lint.sparse_pages.push(Issue {
            page: "c.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        lint.stale_pages.push(Issue {
            page: "d.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        lint.cascade_stale.push(Issue {
            page: "e.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        let report = format_full_report(&health, &lint);

        assert!(report.contains("## 断裂链接（1）"));
        assert!(report.contains("## 孤立页面（1）"));
        assert!(report.contains("## 稀疏页面（1）"));
        assert!(report.contains("## 过时页面（1）"));
        assert!(report.contains("## 级联过时（1）"));
        // No English annotations
        assert!(!report.contains("Broken Links"));
        assert!(!report.contains("Orphan Pages"));
        assert!(!report.contains("Sparse Pages"));
        assert!(!report.contains("Stale Pages"));
        assert!(!report.contains("Cascade Stale"));
    }

    /// Footer format: "---" then "**总计：M 个问题**（健康 X + lint Y）"
    #[test]
    fn test_format_full_report_footer_format() {
        let mut health = CheckResults { total_pages: 3, ..Default::default() };
        health.empty_files.push(Issue {
            page: "p.md".into(),
            kind: "empty".into(),
            details: "0:0".into(),
        });
        let mut lint = LintResults::default();
        lint.broken_links.push(Issue {
            page: "q.md".into(),
            kind: "x".into(),
            details: "{}".into(),
        });
        let report = format_full_report(&health, &lint);

        assert!(
            report.contains("---\n\n**总计：2 个问题**（健康 1 + lint 1）"),
            "footer mismatch"
        );
    }

    /// Saturation test: every check field has exactly 1 issue, so all
    /// `HEALTH_SECTION_COUNT` + `LINT_SECTION_COUNT` sections are rendered.
    ///
    /// This guards against "rendered but not counted" drift: if someone adds
    /// a new field to `CheckResults`/`LintResults` AND a render branch in
    /// `format_full_report` but forgets to bump the corresponding
    /// `SECTION_COUNT` constant, the section-header count will mismatch
    /// `TOTAL_SECTION_COUNT` and this test fails.
    ///
    /// Note: if a new field is added WITHOUT a render branch, this test still
    /// passes (the field is invisible but the section count stays aligned with
    /// the constant).  That gap is intentional — this test only catches
    /// inconsistent constant updates, not forgotten renders.
    #[test]
    fn test_format_full_report_saturation_all_fields() {
        let mut health = CheckResults { total_pages: 14, ..Default::default() };

        // Health: 9 sections (index_sync has 2 sub-vecs → 1 section)
        health.empty_files.push(Issue {
            page: "empty.md".into(),
            kind: "empty".into(),
            details: "0:0".into(),
        });
        health.index_sync.on_disk_not_in_index.push("disk-only.md".into());
        health.index_sync.in_index_not_on_disk.push("index-only.md".into());
        health.log_coverage.push(Issue {
            page: "sources/s.md".into(),
            kind: "missing_log".into(),
            details: "Source Title".into(),
        });
        health.frontmatter.push(Issue {
            page: "no-fm.md".into(),
            kind: "missing_field:type".into(),
            details: String::new(),
        });
        health.related_field.push(Issue {
            page: "bad-related.md".into(),
            kind: "related_to_system".into(),
            details: String::new(),
        });
        health.related_body_consistency.push(Issue {
            page: "mismatch.md".into(),
            kind: "related_omission".into(),
            details: "in-body link not in relations".into(),
        });
        health.source_field.push(Issue {
            page: "no-source.md".into(),
            kind: "missing_resource".into(),
            details: String::new(),
        });
        health.missing_inline_links.push(Issue {
            page: "no-link.md".into(),
            kind: "x".into(),
            details:
                r#"{"term":"term","targets":["term.md"],"snippet":"some context"}"#.into(),
        });
        health.duplicate_inline_links.push(Issue {
            page: "dup-link.md".into(),
            kind: "x".into(),
            details:
                r#"{"target":"other.md","occurrences":[{"display":"other","line":5}]}"#.into(),
        });

        // Lint: 5 sections
        let mut lint = LintResults::default();
        lint.broken_links.push(Issue {
            page: "broken.md".into(),
            kind: "target_not_found".into(),
            details: r#"{"link_text":"bad","target_path":"gone.md"}"#.into(),
        });
        lint.orphan_pages.push(Issue {
            page: "orphan.md".into(),
            kind: "orphan".into(),
            details: r#"{"inbound_links":0,"in_index":false}"#.into(),
        });
        lint.sparse_pages.push(Issue {
            page: "sparse.md".into(),
            kind: "sparse".into(),
            details: r#"{"body_length":10,"threshold":50}"#.into(),
        });
        lint.stale_pages.push(Issue {
            page: "stale.md".into(),
            kind: "stale".into(),
            details:
                r#"{"timestamp":"2020-01-01","status":"draft","days_since_update":2000}"#.into(),
        });
        lint.cascade_stale.push(Issue {
            page: "cascade.md".into(),
            kind: "stale".into(),
            details: r#"{"superseded_page":"old.md","superseded_by":"new.md"}"#
                .into(),
        });

        let report = format_full_report(&health, &lint);

        // Count lines starting with "## " — each is a rendered section header.
        let section_count =
            report.lines().filter(|l| l.starts_with("## ")).count();
        assert_eq!(
            section_count, TOTAL_SECTION_COUNT,
            "All {TOTAL_SECTION_COUNT} check sections should render when \
             every field has issues; got {section_count}",
        );
    }
}
