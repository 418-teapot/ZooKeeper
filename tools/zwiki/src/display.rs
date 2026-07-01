//! Output formatting — Chinese markdown reports and JSON output.

use chrono::Local;

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
    lines.push(format!("## 空文件 / 存根文件（发现 {} 个）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push("所有页面在 frontmatter 之外都有实际内容。✅".to_string());
    } else {
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
    }
    lines.push(String::new());
    lines
}

fn fmt_index_sync(result: &IndexSyncResult) -> Vec<String> {
    let mut lines = Vec::new();
    let total =
        result.on_disk_not_in_index.len() + result.in_index_not_on_disk.len();
    lines.push(format!("## 索引同步（{total} 个问题）"));
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

    if total == 0 {
        lines.push("index.md 与磁盘保持同步。✅".to_string());
        lines.push(String::new());
    }

    lines
}

fn fmt_log_coverage(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 日志覆盖（{} 个源页面缺少日志记录）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push("所有源页面都有对应的日志记录。✅".to_string());
    } else {
        lines.push("以下源页面在 log.md 中没有对应的操作记录：".to_string());
        lines.push(String::new());
        for issue in issues {
            // details = title
            lines.push(format!("- `{}` — {}", issue.page, issue.details));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_frontmatter(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines
        .push(format!("## Frontmatter 完整性（发现 {} 个问题）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push("所有页面 frontmatter 字段完整有效。✅".to_string());
    } else {
        lines.push("| 页面 | 问题 | 详情 |".to_string());
        lines.push("|---|---|---|".to_string());
        for issue in issues {
            lines.push(format!(
                "| `{}` | {} | {} |",
                issue.page, issue.kind, issue.details
            ));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_related_field(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!(
        "## Relations 字段完整性（发现 {} 个问题）",
        issues.len()
    ));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push(
            "所有页面的 relations 字段均合法，未指向系统文件。✅".to_string(),
        );
    } else {
        lines.push("| 页面 | 问题 | 详情 |".to_string());
        lines.push("|---|---|---|".to_string());
        for issue in issues {
            lines.push(format!(
                "| `{}` | {} | {} |",
                issue.page, issue.kind, issue.details
            ));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_related_body_consistency(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!(
        "## Relations 与正文一致性（发现 {} 个问题）",
        issues.len()
    ));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push(
            "所有页面的 relations 字段与正文内联链接双向一致。✅".to_string(),
        );
    } else {
        lines.push("| 页面 | 方向 | 详情 |".to_string());
        lines.push("|---|---|---|".to_string());
        for issue in issues {
            lines.push(format!(
                "| `{}` | {} | {} |",
                issue.page, issue.kind, issue.details
            ));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_source_field(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## Resource 字段验证（发现 {} 个问题）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines
            .push("所有 source 类型页面的 resource 字段均有效。✅".to_string());
    } else {
        lines.push("| 页面 | 问题 | 详情 |".to_string());
        lines.push("|---|---|---|".to_string());
        for issue in issues {
            lines.push(format!(
                "| `{}` | {} | {} |",
                issue.page, issue.kind, issue.details
            ));
        }
    }
    lines.push(String::new());
    lines
}

fn fmt_missing_inline_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 缺失内联链接（发现 {} 处）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push(
            "所有已知术语在正文中的首次出现均有对应的内联链接。✅".to_string(),
        );
    } else {
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
    }
    lines.push(String::new());
    lines
}

fn fmt_duplicate_inline_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("## 重复内联链接（发现 {} 处）", issues.len()));
    lines.push(String::new());

    if issues.is_empty() {
        lines.push("所有页面在正文中均无重复内联链接。✅".to_string());
    } else {
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
                                let display =
                                    o["display"].as_str().unwrap_or("");
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
    }
    lines.push(String::new());
    lines
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Format health check results as Chinese markdown.
pub fn format_check_report(results: &CheckResults) -> String {
    let mut lines: Vec<String> = Vec::new();

    // Header
    lines.push(format!("# Wiki 健康检查报告 — {}", today()));
    lines.push(String::new());
    lines.push(format!(
        "扫描了 {} 个 wiki 页面。检查纯结构层面（无 LLM 调用）。",
        results.total_pages
    ));
    lines.push(String::new());

    // Sections
    lines.extend(fmt_empty_files(&results.empty_files));
    lines.extend(fmt_index_sync(&results.index_sync));
    lines.extend(fmt_log_coverage(&results.log_coverage));
    lines.extend(fmt_frontmatter(&results.frontmatter));
    lines.extend(fmt_related_field(&results.related_field));
    lines.extend(fmt_related_body_consistency(
        &results.related_body_consistency,
    ));
    lines.extend(fmt_source_field(&results.source_field));
    lines.extend(fmt_missing_inline_links(&results.missing_inline_links));
    lines.extend(fmt_duplicate_inline_links(&results.duplicate_inline_links));

    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Lint report
// ---------------------------------------------------------------------------

/// Results from all lint checks.
#[derive(Debug, Clone, Default)]
pub struct LintResults {
    pub broken_links: Vec<Issue>,
    pub orphan_pages: Vec<Issue>,
    pub sparse_pages: Vec<Issue>,
    pub stale_pages: Vec<Issue>,
}

// ---------------------------------------------------------------------------
// Lint section formatters
// ---------------------------------------------------------------------------

fn fmt_broken_links(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push("## 断裂链接 (Broken Links)".to_string());
    lines.push(String::new());
    lines.push(format!("共发现 **{}** 个问题。", issues.len()));
    lines.push(String::new());
    if !issues.is_empty() {
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
    }
    lines.push(String::new());
    lines
}

fn fmt_orphan_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push("## 孤立页面 (Orphan Pages)".to_string());
    lines.push(String::new());
    lines.push(format!("共发现 **{}** 个问题。", issues.len()));
    lines.push(String::new());
    if !issues.is_empty() {
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
    }
    lines.push(String::new());
    lines
}

fn fmt_sparse_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push("## 稀疏页面 (Sparse Pages)".to_string());
    lines.push(String::new());
    lines.push(format!("共发现 **{}** 个问题。", issues.len()));
    lines.push(String::new());
    if !issues.is_empty() {
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
    }
    lines.push(String::new());
    lines
}

fn fmt_stale_pages(issues: &[Issue]) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push("## 过时页面 (Stale Pages)".to_string());
    lines.push(String::new());
    lines.push(format!("共发现 **{}** 个问题。", issues.len()));
    lines.push(String::new());
    if !issues.is_empty() {
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
    }
    lines.push(String::new());
    lines
}

/// Format lint check results as Chinese markdown.
///
/// Sections:
/// - 断裂链接 (Broken Links)
/// - 孤立页面 (Orphan Pages)
/// - 稀疏页面 (Sparse Pages)
/// - 过时页面 (Stale Pages)
pub fn format_lint_report(results: &LintResults) -> String {
    let total = results.broken_links.len()
        + results.orphan_pages.len()
        + results.sparse_pages.len()
        + results.stale_pages.len();

    let mut lines: Vec<String> = Vec::new();

    // Header
    lines.push("# Wiki Lint Report".to_string());
    lines.push(String::new());
    lines.push(format!(
        "Generated: {}",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    lines.push(String::new());

    // Sections
    lines.extend(fmt_broken_links(&results.broken_links));
    lines.extend(fmt_orphan_pages(&results.orphan_pages));
    lines.extend(fmt_sparse_pages(&results.sparse_pages));
    lines.extend(fmt_stale_pages(&results.stale_pages));

    // Footer
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(format!("**Lint 小计：{total} 个问题**"));
    lines.push(String::new());

    lines.join("\n")
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_check_report_contains_sections() {
        let results = CheckResults::default();
        let report = format_check_report(&results);
        assert!(report.contains("## 空文件"));
        assert!(report.contains("## 索引同步"));
        assert!(report.contains("## Frontmatter 完整性"));
    }

    #[test]
    fn test_format_lint_report_contains_sections() {
        let results = LintResults::default();
        let report = format_lint_report(&results);
        assert!(report.contains("## 断裂链接"));
        assert!(report.contains("## 孤立页面"));
    }

    #[test]
    fn test_format_check_report_zero_issues() {
        let results = CheckResults::default();
        let report = format_check_report(&results);
        assert!(report.contains("✅"));
    }

    #[test]
    fn test_format_check_report_with_issues() {
        let mut results = CheckResults::default();
        results.empty_files.push(Issue {
            page: "concepts/foo.md".into(),
            kind: "stub".into(),
            details: "body too short".into(),
        });
        results.frontmatter.push(Issue {
            page: "concepts/bar.md".into(),
            kind: "missing_field:type".into(),
            details: String::new(),
        });
        let report = format_check_report(&results);
        assert!(report.contains("concepts/foo.md"));
        assert!(report.contains("concepts/bar.md"));
        assert!(report.contains("个问题"));
    }

    #[test]
    fn test_format_lint_report_zero_issues() {
        let results = LintResults::default();
        let report = format_lint_report(&results);
        assert!(report.contains("共发现 **0** 个问题"));
    }

    #[test]
    fn test_format_lint_report_with_issues() {
        let mut results = LintResults::default();
        results.broken_links.push(Issue {
            page: "concepts/bad.md".into(),
            kind: "target_not_found".into(),
            details: r#"{"link_text":"bad link","target_path":"nope.md"}"#
                .into(),
        });
        results.stale_pages.push(Issue {
            page: "concepts/old.md".into(),
            kind: "stale".into(),
            details: r#"{"timestamp":"2020-01-01","status":"draft","days_since_update":2000}"#.into(),
        });
        let report = format_lint_report(&results);
        assert!(report.contains("concepts/bad.md"));
        assert!(report.contains("concepts/old.md"));
    }

    #[test]
    fn test_format_check_report_all_sections() {
        let results = CheckResults::default();
        let report = format_check_report(&results);
        for section in &[
            "## 空文件",
            "## 索引同步",
            "## 日志覆盖",
            "## Frontmatter 完整性",
            "## Relations 字段完整性",
            "## Relations 与正文一致性",
            "## Resource 字段验证",
            "## 缺失内联链接",
            "## 重复内联链接",
        ] {
            assert!(report.contains(section), "missing section: {section}");
        }
    }

    #[test]
    fn test_format_lint_report_all_sections() {
        let results = LintResults::default();
        let report = format_lint_report(&results);
        for section in
            &["## 断裂链接", "## 孤立页面", "## 稀疏页面", "## 过时页面"]
        {
            assert!(report.contains(section), "missing section: {section}");
        }
    }
}
