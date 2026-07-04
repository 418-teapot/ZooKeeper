//! Log append operations for the wiki change log.

use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::wiki;

/// Normalize a wiki path: strip the `wiki/` prefix if present.
fn normalize_path(path: &str) -> String {
    path.strip_prefix("wiki/")
        .map_or_else(|| path.to_string(), ToString::to_string)
}

/// Truncate a note string to at most 60 characters.
///
/// If truncation occurs, the last character is replaced with `…`
/// for a total of exactly 60 characters.
fn truncate_note(note: &str) -> String {
    if note.chars().count() <= 60 {
        return note.to_string();
    }
    let truncated: String = note.chars().take(59).collect();
    format!("{truncated}…")
}

/// Map action names to Chinese verbs.
fn action_to_chinese(action: &str) -> &str {
    match action {
        "create" => "创建",
        "edit" => "编辑",
        "ingest" => "摄入",
        "pass" => "通过",
        "fail" => "失败",
        "update" => "更新",
        "delete" => "删除",
        other => other,
    }
}

/// Format a single log entry line (OKF §7 prose style).
///
/// Returns a markdown bullet like `* **创建**: <path> — <note>`.
/// The `op` parameter is accepted for API compatibility but is not
/// included in the output (the action verb encodes the operation).
fn format_entry(_op: &str, path: &str, action: &str, note: &str) -> String {
    let verb = action_to_chinese(action);
    if note.is_empty() {
        format!("* **{verb}**: {path}")
    } else {
        format!("* **{verb}**: {path} — {note}")
    }
}

/// Insert a new entry line into the log content under the right date group.
///
/// If a `## YYYY-MM-DD` section for `date` already exists the entry is
/// appended to that section.  Otherwise a new section is created after the
/// `# 目录更新日志` title (or at the top if the title is missing).
fn insert_entry(content: &str, date: &str, entry_line: &str) -> String {
    let title = "# 目录更新日志";
    let date_header = format!("## {date}");

    // Empty content → create fresh file structure
    if content.trim().is_empty() {
        return format!("{title}\n\n{date_header}\n\n{entry_line}\n");
    }

    let mut lines: Vec<&str> = content.lines().collect();

    // Check if today's section already exists
    if let Some(section_idx) = lines.iter().position(|l| *l == date_header) {
        // Find where this section ends (next `## ` line or end of file)
        let after_section = lines[section_idx + 1..]
            .iter()
            .position(|l| l.starts_with("## "))
            .map_or(lines.len(), |i| section_idx + 1 + i);

        // Append entry at the end of this section,
        // skipping trailing blank lines so the entry
        // stays with its group and the inter-group
        // blank line separator is preserved.
        let mut insert_at = after_section;
        while insert_at > section_idx + 1 && lines[insert_at - 1].is_empty() {
            insert_at -= 1;
        }
        lines.insert(insert_at, entry_line);
    } else {
        // New date section — insert after the title, before existing sections
        let title_idx = lines.iter().position(|l| *l == title);

        if let Some(idx) = title_idx {
            // Find first existing `## ` section after the title
            let first_section = lines[idx + 1..]
                .iter()
                .position(|l| l.starts_with("## "))
                .map_or(lines.len(), |i| idx + 1 + i);

            // Insert: blank line separator, entry, blank line after
            // date header, then date header
            // (reverse order because Vec::insert shifts right)
            if first_section < lines.len() {
                lines.insert(first_section, ""); // blank line before old sections
            }
            lines.insert(first_section, entry_line);
            lines.insert(first_section, ""); // blank line after date header
            lines.insert(first_section, &date_header);
        } else {
            // No title found — prepend everything
            lines.insert(0, entry_line);
            lines.insert(0, ""); // blank line after date header
            lines.insert(0, &date_header);
            lines.insert(0, "");
            lines.insert(0, title);
        }
    }

    lines.join("\n") + "\n"
}

/// Append a structured log entry to `wiki/logs/YYYY-MM.md`.
///
/// The entry is prepended to the file (most recent first).  File locking
/// (`LOCK_EX`) prevents concurrent write interleaving.
///
/// # Errors
///
/// Returns an error string if file I/O or locking fails.
pub fn add_entry(
    op: &str,
    path: &str,
    action: &str,
    note: Option<&str>,
) -> Result<(), String> {
    add_entry_at(&wiki::wiki_dir(), op, path, action, note)
}

/// Inner implementation: append a log entry under an explicit wiki root.
pub fn add_entry_at(
    wiki_root: &Path,
    op: &str,
    path: &str,
    action: &str,
    note: Option<&str>,
) -> Result<(), String> {
    let year_month = chrono::Local::now().format("%Y-%m").to_string();
    let log_path: PathBuf =
        wiki_root.join("logs").join(format!("{year_month}.md"));

    // Normalize path (strip wiki/ prefix)
    let path = normalize_path(path);

    // Truncate note to 60 chars
    let note = note.map_or_else(String::new, truncate_note);

    // Format entry
    let entry = format_entry(op, &path, action, &note);

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // Create parent directory if needed
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建日志目录: {e}"))?;
    }

    // Ensure file exists (touch)
    if !log_path.exists() {
        fs::write(&log_path, "")
            .map_err(|e| format!("无法创建日志文件: {e}"))?;
    }

    // Open for read+write
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&log_path)
        .map_err(|e| format!("无法打开日志文件: {e}"))?;

    // Exclusive file lock
    file.lock_exclusive().map_err(|e| format!("无法获取文件锁: {e}"))?;

    // Read existing content
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("无法读取日志文件: {e}"))?;

    // Build new content with OKF §7 date grouping
    let new_content = insert_entry(&content, &today, &entry);

    // Seek to beginning
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| format!("无法定位文件: {e}"))?;

    // Write new content
    file.write_all(new_content.as_bytes())
        .map_err(|e| format!("无法写入日志文件: {e}"))?;

    // Truncate any remaining old data
    file.set_len(new_content.len() as u64)
        .map_err(|e| format!("无法截断文件: {e}"))?;

    // Unlock
    let _ = file.unlock();

    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("log").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    /// Return the monthly log path expected by `add_entry_at`.
    fn monthly_log_path(root: &Path) -> PathBuf {
        let year_month = chrono::Local::now().format("%Y-%m").to_string();
        root.join("logs").join(format!("{year_month}.md"))
    }

    // -------------------------------------------------------------------
    // normalize_path
    // -------------------------------------------------------------------

    #[test]
    fn test_normalize_path_strips_wiki_prefix() {
        assert_eq!(normalize_path("wiki/concepts/foo.md"), "concepts/foo.md");
    }

    #[test]
    fn test_normalize_path_no_prefix() {
        assert_eq!(normalize_path("concepts/foo.md"), "concepts/foo.md");
    }

    // -------------------------------------------------------------------
    // truncate_note
    // -------------------------------------------------------------------

    #[test]
    fn test_truncate_note_within_limit() {
        let note = "short note";
        assert_eq!(truncate_note(note), "short note");
    }

    #[test]
    fn test_truncate_note_exact_limit() {
        let note = "a".repeat(60);
        assert_eq!(truncate_note(&note), note);
    }

    #[test]
    fn test_truncate_note_exceeds_limit() {
        let note = "a".repeat(61);
        let result = truncate_note(&note);
        assert_eq!(result.chars().count(), 60);
        assert!(result.ends_with('…'), "result should end with …: {result}");
    }

    // -------------------------------------------------------------------
    // action_to_chinese
    // -------------------------------------------------------------------

    #[test]
    fn test_action_to_chinese_known() {
        assert_eq!(action_to_chinese("create"), "创建");
        assert_eq!(action_to_chinese("edit"), "编辑");
        assert_eq!(action_to_chinese("ingest"), "摄入");
        assert_eq!(action_to_chinese("pass"), "通过");
        assert_eq!(action_to_chinese("fail"), "失败");
        assert_eq!(action_to_chinese("update"), "更新");
        assert_eq!(action_to_chinese("delete"), "删除");
    }

    #[test]
    fn test_action_to_chinese_unknown() {
        assert_eq!(action_to_chinese("unknown"), "unknown");
        assert_eq!(action_to_chinese("review"), "review");
    }

    // -------------------------------------------------------------------
    // format_entry
    // -------------------------------------------------------------------

    #[test]
    fn test_format_entry_with_note() {
        let result =
            format_entry("ingest", "concepts/foo.md", "create", "test note");
        assert_eq!(result, "* **创建**: concepts/foo.md — test note");
    }

    #[test]
    fn test_format_entry_without_note() {
        let result = format_entry("ingest", "concepts/foo.md", "create", "");
        assert_eq!(result, "* **创建**: concepts/foo.md");
    }

    #[test]
    fn test_format_entry_unknown_action() {
        let result =
            format_entry("ingest", "concepts/foo.md", "review", "needs review");
        assert_eq!(result, "* **review**: concepts/foo.md — needs review");
    }

    // -------------------------------------------------------------------
    // insert_entry
    // -------------------------------------------------------------------

    #[test]
    fn test_insert_entry_empty_content() {
        let result = insert_entry("", "2026-06-19", "* **创建**: test.md");
        assert_eq!(
            result,
            "# 目录更新日志\n\n## 2026-06-19\n\n* **创建**: test.md\n"
        );
    }

    #[test]
    fn test_insert_entry_appends_to_existing_section() {
        let content =
            "# 目录更新日志\n\n## 2026-06-19\n* **创建**: first.md — first\n";
        let result = insert_entry(
            content,
            "2026-06-19",
            "* **创建**: second.md — second",
        );
        assert_eq!(
            result,
            "# 目录更新日志\n\n## 2026-06-19\n* **创建**: first.md — first\n* **创建**: second.md — second\n"
        );
    }

    #[test]
    fn test_insert_entry_creates_new_section() {
        let content =
            "# 目录更新日志\n\n## 2026-06-18\n* **创建**: old.md — old\n";
        let result =
            insert_entry(content, "2026-06-19", "* **创建**: new.md — new");
        assert_eq!(
            result,
            "# 目录更新日志\n\n## 2026-06-19\n\n* **创建**: new.md — new\n\n## 2026-06-18\n* **创建**: old.md — old\n"
        );
    }

    #[test]
    fn test_insert_entry_no_title() {
        let content = "## 2026-06-18\n* **创建**: old.md\n";
        let result = insert_entry(content, "2026-06-19", "* **创建**: new.md");
        assert!(result.starts_with(
            "# 目录更新日志\n\n## 2026-06-19\n\n* **创建**: new.md\n"
        ));
        assert!(result.contains("## 2026-06-18\n* **创建**: old.md"));
    }

    #[test]
    fn test_insert_entry_append_with_trailing_blank_lines() {
        // Existing section with trailing blank line before next section
        let content = "# 目录更新日志\n\n## 2026-06-19\n* **创建**: first.md — first\n\n## 2026-06-18\n* **创建**: old.md — old\n";
        let result = insert_entry(
            content,
            "2026-06-19",
            "* **创建**: second.md — second",
        );
        // The new entry should be grouped with its date section,
        // before the inter-group blank line
        let expected = "# 目录更新日志\n\n## 2026-06-19\n* **创建**: first.md — first\n* **创建**: second.md — second\n\n## 2026-06-18\n* **创建**: old.md — old\n";
        assert_eq!(result, expected);
    }

    // -------------------------------------------------------------------
    // add_entry
    // -------------------------------------------------------------------

    #[test]
    fn test_add_entry_creates_file() {
        let wiki = temp_dir("creates_file");

        let result = add_entry_at(
            &wiki,
            "ingest",
            "concepts/test.md",
            "create",
            Some("test note"),
        );
        assert!(result.is_ok());

        let log_path = monthly_log_path(&wiki);
        assert!(log_path.exists(), "monthly log should exist");

        let content = fs::read_to_string(&log_path).unwrap();
        assert!(
            content.contains("# 目录更新日志"),
            "should contain title: {content}"
        );
        assert!(
            content.contains("* **创建**: concepts/test.md — test note"),
            "log entry not found in: {content}"
        );
    }

    #[test]
    fn test_add_entry_format_correct() {
        let wiki = temp_dir("format_correct");

        add_entry_at(
            &wiki,
            "update",
            "entities/foo.md",
            "edit",
            Some("updated description"),
        )
        .unwrap();

        let content = fs::read_to_string(monthly_log_path(&wiki)).unwrap();
        // Should have the title
        assert!(
            content.starts_with("# 目录更新日志"),
            "should start with title: {content}"
        );
        // Should have a date group
        assert!(
            content.contains("## "),
            "should contain date group: {content}"
        );
        // Should have the entry with Chinese verb
        assert!(
            content
                .contains("* **编辑**: entities/foo.md — updated description"),
            "entry content mismatch: {content}"
        );
    }

    #[test]
    fn test_add_entry_note_truncated() {
        let wiki = temp_dir("note_truncated");

        let long_note = "x".repeat(100);
        add_entry_at(
            &wiki,
            "query",
            "concepts/test.md",
            "pass",
            Some(&long_note),
        )
        .unwrap();

        let content = fs::read_to_string(monthly_log_path(&wiki)).unwrap();
        let expected_note = truncate_note(&long_note);
        assert!(
            content.contains(&expected_note),
            "should contain truncated note: {content}"
        );
        assert!(
            !content.contains(&long_note),
            "should NOT contain original long note"
        );
    }

    #[test]
    fn test_add_entry_path_normalized() {
        let wiki = temp_dir("path_normalized");

        add_entry_at(
            &wiki,
            "ingest",
            "wiki/concepts/test.md",
            "create",
            Some("via prefix"),
        )
        .unwrap();

        let content = fs::read_to_string(monthly_log_path(&wiki)).unwrap();
        assert!(
            content.contains("concepts/test.md"),
            "path should be normalized: {content}"
        );
        assert!(
            !content.contains("wiki/concepts/test.md"),
            "path should NOT have wiki/ prefix"
        );
    }

    #[test]
    fn test_add_entry_same_day_grouping() {
        let wiki = temp_dir("same_day_grouping");

        // First entry
        add_entry_at(&wiki, "ingest", "first.md", "create", Some("first"))
            .unwrap();
        // Second entry — same day, should be in the same group
        add_entry_at(&wiki, "ingest", "second.md", "create", Some("second"))
            .unwrap();

        let content = fs::read_to_string(monthly_log_path(&wiki)).unwrap();
        // Both entries should be present
        assert!(
            content.contains("* **创建**: first.md — first"),
            "first entry missing"
        );
        assert!(
            content.contains("* **创建**: second.md — second"),
            "second entry missing"
        );
        // Both should be under the same date section, second after first
        let lines: Vec<&str> = content.lines().collect();
        let date_idx = lines.iter().position(|l| l.starts_with("## ")).unwrap();
        assert!(
            lines[date_idx + 2].contains("first.md"),
            "first entry should be first in group: {lines:?}"
        );
        assert!(
            lines[date_idx + 3].contains("second.md"),
            "second entry should be second in group: {lines:?}"
        );
    }
}
