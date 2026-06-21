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

/// Format a single log entry line.
fn format_entry(op: &str, path: &str, action: &str, note: &str) -> String {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    format!("## [{today}] {op} | {path} | {action} — {note}")
}

/// Append a structured log entry to `wiki/log.md`.
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
    let log_path: PathBuf = wiki_root.join("log.md");

    // Normalize path (strip wiki/ prefix)
    let path = normalize_path(path);

    // Truncate note to 60 chars
    let note = note.map_or_else(String::new, truncate_note);

    // Format entry
    let entry = format_entry(op, &path, action, &note);

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

    // Seek to beginning
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| format!("无法定位文件: {e}"))?;

    // Prepend new entry
    let new_content = format!("{entry}\n{content}");
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

        let log_path = wiki.join("log.md");
        assert!(log_path.exists(), "log.md should exist");

        let content = fs::read_to_string(&log_path).unwrap();
        assert!(
            content.contains("ingest | concepts/test.md | create — test note"),
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

        let content = fs::read_to_string(wiki.join("log.md")).unwrap();
        assert!(
            content.starts_with("## ["),
            "should start with '## [date]': {content}"
        );
        assert!(
            content.contains(
                "update | entities/foo.md | edit — updated description"
            ),
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

        let content = fs::read_to_string(wiki.join("log.md")).unwrap();
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

        let content = fs::read_to_string(wiki.join("log.md")).unwrap();
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
    fn test_add_entry_prepends() {
        let wiki = temp_dir("prepends");

        // First entry
        add_entry_at(&wiki, "ingest", "first.md", "create", Some("first"))
            .unwrap();
        // Second entry — should be prepended
        add_entry_at(&wiki, "ingest", "second.md", "create", Some("second"))
            .unwrap();

        let content = fs::read_to_string(wiki.join("log.md")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert!(
            lines[0].contains("second.md"),
            "second entry should be first: {lines:?}"
        );
        assert!(
            lines[1].contains("first.md") || lines[2].contains("first.md"),
            "first entry should be after second: {lines:?}"
        );
    }
}
