//! Text layout of the `check` report.
//!
//! The text shows what the run did: the pages checked, the applied changes,
//! the issues that remain, the failure that stopped the run, and the
//! result.

use super::rules::Rule;
use super::{ChangeKind, Report, Status};

/// Render the report for the terminal.
#[must_use]
pub fn render(report: &Report) -> String {
    let mut lines: Vec<String> = vec![format!("已检查 {} 页", report.pages)];

    if !report.changes.is_empty() {
        let title = if report.read_only { "未应用变更" } else { "变更" };
        lines.push(format!("{title}（{}）", report.changes.len()));
        for change in &report.changes {
            lines.push(format!(
                "- `{}` — {}",
                change.path,
                change_label(change.kind)
            ));
        }
    }

    if !report.issues.is_empty() {
        lines.push(format!("问题（{}）", report.issues.len()));
        for issue in &report.issues {
            lines.push(format!(
                "- `{}` — {}（{}）",
                issue.path,
                issue.message,
                issue.rule.as_str()
            ));
            if issue.rule == Rule::SourceNewer {
                lines.push(source_line(&issue.details));
            }
        }
    }

    if let Some(error) = &report.error {
        lines.push(format!("错误：{error}"));
    }
    lines.push(format!("结果：{}", status_label(report.status())));
    lines.join("\n")
}

/// Chinese label of one change kind.
const fn change_label(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Index => "索引",
        ChangeKind::Backlinks => "反向链接",
        ChangeKind::Format => "格式",
    }
}

/// Chinese label of one run outcome.
const fn status_label(status: Status) -> &'static str {
    match status {
        Status::Ok => "通过",
        Status::Issues => "存在问题",
        Status::Error => "执行失败",
    }
}

/// The source and the two times of a source-newer issue.
fn source_line(details: &serde_json::Value) -> String {
    format!(
        "  来源 `{}`，来源确认时间 {}，本页确认时间 {}",
        text(details, "source"),
        text(details, "source_timestamp"),
        text(details, "derived_timestamp"),
    )
}

/// One string field of an issue's details.
fn text<'a>(details: &'a serde_json::Value, field: &str) -> &'a str {
    details[field].as_str().unwrap_or_default()
}
