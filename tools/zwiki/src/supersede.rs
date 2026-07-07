//! Supersede linking — maintain `supersedes` / `superseded_by` relations
//! between wiki pages via line-level frontmatter manipulation.
//!
//! Deliberately avoids parsing the block list semantically; instead
//! it finds the relevant field by scanning lines and inserts / replaces
//! text at the row level (same philosophy as `property.rs`).

use std::fs;
use std::path::Path;

use chrono::Utc;

use crate::property;
use crate::wiki;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Establish a supersede relationship between two wiki pages.
///
/// * `old_rel` — wiki-root-relative path of the superseded page
///   (e.g. `autoresearch/concepts/old.md`)
/// * `new_rel` — wiki-root-relative path of the superseding page
/// * `reason` — human-readable explanation
pub fn link_supersede(
    old_rel: &str,
    new_rel: &str,
    reason: &str,
) -> Result<(), String> {
    link_supersede_at(old_rel, new_rel, reason, &wiki::wiki_dir())
}

/// Testable variant of [`link_supersede`] that accepts an explicit
/// `wiki_root` instead of reading the global wiki directory.
pub fn link_supersede_at(
    old_rel: &str,
    new_rel: &str,
    reason: &str,
    wiki_root: &Path,
) -> Result<(), String> {
    if old_rel == new_rel {
        return Err("--old 和 --new 不能指向同一个页面".to_string());
    }

    let old_abs = wiki_root.join(old_rel);
    let new_abs = wiki_root.join(new_rel);

    if !old_abs.exists() {
        return Err(format!("页面不存在: {old_rel}"));
    }
    if !new_abs.exists() {
        return Err(format!("页面不存在: {new_rel}"));
    }

    // New page (superseding) gets a `supersedes` entry pointing to the old
    // page.
    append_frontmatter_block(&new_abs, "supersedes", old_rel, reason)?;

    // Old page (superseded) gets a `superseded_by` entry pointing to the new
    // page.
    append_frontmatter_block(&old_abs, "superseded_by", new_rel, reason)?;

    // Mark the old page as validated at the moment of supersedure so that
    // `check_cascade_stale` can distinguish pages reviewed post-supersedure
    // from those that still need attention.
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    property::set(&old_abs, "last_validated", &now)
        .map_err(|e| format!("写入 last_validated 失败: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Result of locating a field inside frontmatter.
struct FmFieldLoc {
    /// Index of the opening `---`.
    start: usize,
    /// Index of the closing `---`.
    end: usize,
    /// Index of the `field_name:` line, or `None` if absent.
    field_line: Option<usize>,
    /// Whether the field value is `[]`.
    empty_array: bool,
    /// Index of the last indented block line, or `None`.
    block_end: Option<usize>,
}

/// Locate frontmatter boundaries and scan for `field_name`.
///
/// Returns `None` when frontmatter is absent.
fn locate_field_in_frontmatter(
    lines: &[&str],
    field_name: &str,
) -> Option<FmFieldLoc> {
    // Find frontmatter `---` … `---`.
    let mut fm_start: Option<usize> = None;
    let mut fm_end: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "---" {
            if fm_start.is_none() {
                fm_start = Some(i);
            } else if fm_end.is_none() {
                fm_end = Some(i);
                break;
            }
        }
    }

    let (start, end) = (fm_start?, fm_end?);

    // Scan body for the field.
    let mut field_line_idx: Option<usize> = None;
    let mut is_empty_array = false;
    let mut block_end_idx: Option<usize> = None;

    let mut scan = start + 1;
    while scan < end {
        let trimmed = lines[scan].trim();

        if let Some(colon_idx) = trimmed.find(':') {
            let key = trimmed[..colon_idx].trim();
            if key == field_name {
                field_line_idx = Some(scan);
                let value_part = trimmed[colon_idx + 1..].trim();

                if value_part == "[]" {
                    is_empty_array = true;
                    scan += 1;
                    continue;
                }

                if value_part.is_empty() {
                    let mut inner = scan + 1;
                    while inner < end && lines[inner].starts_with(' ') {
                        block_end_idx = Some(inner);
                        inner += 1;
                    }
                    scan = inner;
                    continue;
                }

                // Non-empty scalar value — treat as absent (defensive).
                field_line_idx = None;
            }
        }

        scan += 1;
    }

    Some(FmFieldLoc {
        start,
        end,
        field_line: field_line_idx,
        empty_array: is_empty_array,
        block_end: block_end_idx,
    })
}

/// Append (or create) a block-list entry for `field_name` in the frontmatter
/// of the given page.
///
/// Handles three frontmatter states:
///
/// 1. **Field absent** — insert a new multiline block before closing `---`.
/// 2. **Empty array** (`field: []`) — replace the line with a block.
/// 3. **Existing entries** — append a new entry pair after the last one.
///
/// Writes atomically (temp file → rename).
fn append_frontmatter_block(
    page_abs: &Path,
    field_name: &str,
    path_value: &str,
    reason: &str,
) -> Result<(), String> {
    let content = fs::read_to_string(page_abs)
        .map_err(|e| format!("无法读取文件: {e}"))?;

    let lines: Vec<&str> = content.lines().collect();

    let Some(loc) = locate_field_in_frontmatter(&lines, field_name) else {
        return Err("文件缺少有效的 frontmatter".to_string());
    };
    let FmFieldLoc {
        start,
        end,
        field_line: field_line_idx,
        empty_array: is_empty_array,
        block_end: block_end_idx,
    } = loc;

    // --- Build new content ---

    let new_entry: [String; 2] =
        [format!("  - path: {path_value}"), format!("    reason: {reason}")];

    let mut new_lines: Vec<String> = Vec::new();

    // Lines before and including opening `---`.
    for line in &lines[..=start] {
        new_lines.push(line.to_string());
    }

    match field_line_idx {
        None => {
            // Case 1 — field absent: insert block before closing `---`.
            for line in &lines[start + 1..end] {
                new_lines.push(line.to_string());
            }
            new_lines.push(format!("{field_name}:"));
            new_lines.extend_from_slice(&new_entry);
        }
        Some(fld_idx) if is_empty_array => {
            // Case 2 — `field: []`: replace that line with a block.
            for line in &lines[start + 1..fld_idx] {
                new_lines.push(line.to_string());
            }
            new_lines.push(format!("{field_name}:"));
            new_lines.extend_from_slice(&new_entry);
            for line in &lines[fld_idx + 1..end] {
                new_lines.push(line.to_string());
            }
        }
        Some(fld_idx) => {
            // Case 3 — existing block: append after the last entry.
            let last = block_end_idx.unwrap_or(fld_idx);
            for line in &lines[start + 1..=last] {
                new_lines.push(line.to_string());
            }
            new_lines.extend_from_slice(&new_entry);
            for line in &lines[last + 1..end] {
                new_lines.push(line.to_string());
            }
        }
    }

    // Closing `---`.
    new_lines.push(lines[end].to_string());

    // Lines after frontmatter.
    for line in &lines[end + 1..] {
        new_lines.push(line.to_string());
    }

    let mut new_content = new_lines.join("\n");
    // Preserve trailing newline if original had one.
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    // --- Atomic write ---

    let temp_path =
        page_abs.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp_path, &new_content)
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&temp_path, page_abs)
        .inspect_err(|_| {
            let _ = fs::remove_file(&temp_path);
        })
        .map_err(|e| format!("重命名文件失败: {e}"))?;

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
        let dir = std::env::temp_dir()
            .join("zwiki-test")
            .join("supersede")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn make_page(dir: &Path, filename: &str, content: &str) -> PathBuf {
        let path = dir.join(filename);
        fs::write(&path, content).expect("failed to write test page");
        path
    }

    fn read_content(path: &Path) -> String {
        fs::read_to_string(path).expect("failed to read test page")
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — absent field
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_field_absent() {
        let dir = temp_dir("field_absent");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: Test\ntype: concept\n---\n\nBody.\n",
        );

        append_frontmatter_block(
            &path,
            "supersedes",
            "old.md",
            "replaced by new",
        )
        .unwrap();

        let content = read_content(&path);
        assert!(content.contains("supersedes:"));
        assert!(content.contains("  - path: old.md"));
        assert!(content.contains("    reason: replaced by new"));
        assert!(content.contains("title: Test"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — empty array
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_empty_array() {
        let dir = temp_dir("empty_array");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: Test\nsupersedes: []\ntype: concept\n---\n\nBody.\n",
        );

        append_frontmatter_block(
            &path,
            "supersedes",
            "old.md",
            "replaced by new",
        )
        .unwrap();

        let content = read_content(&path);
        assert!(!content.contains("supersedes: []"));
        assert!(content.contains("supersedes:"));
        assert!(content.contains("  - path: old.md"));
        assert!(content.contains("    reason: replaced by new"));
        assert!(content.contains("title: Test"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — existing entries
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_existing_entries() {
        let dir = temp_dir("existing_entries");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: Test\nsupersedes:\n  - path: old1.md\n    \
             reason: first\n  - path: old2.md\n    \
             reason: second\ntype: concept\n---\n\nBody.\n",
        );

        append_frontmatter_block(
            &path,
            "supersedes",
            "old3.md",
            "third reason",
        )
        .unwrap();

        let content = read_content(&path);
        assert!(content.contains("  - path: old1.md"));
        assert!(content.contains("    reason: first"));
        assert!(content.contains("  - path: old2.md"));
        assert!(content.contains("    reason: second"));
        assert!(content.contains("  - path: old3.md"));
        assert!(content.contains("    reason: third reason"));

        let pos1 = content.find("old1.md").unwrap();
        let pos2 = content.find("old2.md").unwrap();
        let pos3 = content.find("old3.md").unwrap();
        assert!(pos1 < pos2 && pos2 < pos3, "entries must be in order");

        assert!(content.contains("title: Test"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — header only (field with no entries yet)
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_header_only() {
        let dir = temp_dir("header_only");
        let path = make_page(
            &dir,
            "test.md",
            "---\nsupersedes:\ntype: concept\n---\n\nBody.\n",
        );

        append_frontmatter_block(&path, "supersedes", "old.md", "just because")
            .unwrap();

        let content = read_content(&path);
        assert!(content.contains("supersedes:"));
        assert!(content.contains("  - path: old.md"));
        assert!(content.contains("    reason: just because"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — no frontmatter → error
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_no_frontmatter() {
        let dir = temp_dir("no_frontmatter");
        let path =
            make_page(&dir, "test.md", "# Just body\n\nNo frontmatter.\n");

        let result = append_frontmatter_block(&path, "supersedes", "x.md", "r");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("缺少有效的 frontmatter"));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — empty file → error
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_empty_file() {
        let dir = temp_dir("empty_file");
        let path = make_page(&dir, "test.md", "");

        let result = append_frontmatter_block(&path, "supersedes", "x.md", "r");
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — superseded_by variant
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_superseded_by() {
        let dir = temp_dir("superseded_by");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: Old\ntype: concept\n---\n\nBody.\n",
        );

        append_frontmatter_block(
            &path,
            "superseded_by",
            "new.md",
            "replaces old",
        )
        .unwrap();

        let content = read_content(&path);
        assert!(content.contains("superseded_by:"));
        assert!(content.contains("  - path: new.md"));
        assert!(content.contains("    reason: replaces old"));
        assert!(content.contains("title: Old"));
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — trailing newline preserved
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_preserves_trailing_newline() {
        let dir = temp_dir("trailing_newline");
        let path =
            make_page(&dir, "test.md", "---\ntitle: Test\n---\n\nBody.\n");

        append_frontmatter_block(&path, "supersedes", "old.md", "reason")
            .unwrap();

        let content = read_content(&path);
        assert!(content.ends_with('\n'), "trailing newline must be preserved");
    }

    // -------------------------------------------------------------------
    // append_frontmatter_block — path_value with slashes
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_path_with_domain() {
        let dir = temp_dir("path_with_domain");
        let path =
            make_page(&dir, "test.md", "---\ntitle: Test\n---\n\nBody.\n");

        append_frontmatter_block(
            &path,
            "supersedes",
            "autoresearch/concepts/old.md",
            "content merged",
        )
        .unwrap();

        let content = read_content(&path);
        assert!(content.contains("  - path: autoresearch/concepts/old.md"));
        assert!(content.contains("    reason: content merged"));
    }

    // -------------------------------------------------------------------
    // link_supersede — same path
    // -------------------------------------------------------------------

    #[test]
    fn test_link_supersede_same_path() {
        let result = link_supersede("same.md", "same.md", "nope");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不能指向同一个页面"));
    }

    // -------------------------------------------------------------------
    // link_supersede — missing pages
    // -------------------------------------------------------------------

    #[test]
    fn test_link_supersede_missing_pages() {
        let dir = temp_dir("missing_pages");
        let result = link_supersede_at(
            "nonexistent.md",
            "also-nonexistent.md",
            "reason",
            &dir,
        );
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // link_supersede — both sides
    // -------------------------------------------------------------------

    #[test]
    fn test_link_supersede_both_sides() {
        let dir = temp_dir("both_sides");
        let old_path =
            make_page(&dir, "old.md", "---\ntitle: Old Page\n---\n\nBody.\n");
        let new_path =
            make_page(&dir, "new.md", "---\ntitle: New Page\n---\n\nBody.\n");

        append_frontmatter_block(
            &new_path,
            "supersedes",
            "old.md",
            "replaces old",
        )
        .unwrap();
        append_frontmatter_block(
            &old_path,
            "superseded_by",
            "new.md",
            "replaces old",
        )
        .unwrap();

        let old_content = read_content(&old_path);
        assert!(old_content.contains("superseded_by:"));
        assert!(old_content.contains("  - path: new.md"));
        assert!(old_content.contains("    reason: replaces old"));

        let new_content = read_content(&new_path);
        assert!(new_content.contains("supersedes:"));
        assert!(new_content.contains("  - path: old.md"));
        assert!(new_content.contains("    reason: replaces old"));
    }

    // -------------------------------------------------------------------
    // link_supersede — writes last_validated (success path)
    // -------------------------------------------------------------------

    #[test]
    fn test_link_supersede_writes_last_validated() {
        // Use an isolated temp dir as the wiki root — never touches the
        // real ~/.zoo/wiki/.
        let wiki_root = temp_dir("lv_root");
        let old_rel = "lv-old.md";
        let new_rel = "lv-new.md";
        let old_abs = wiki_root.join(old_rel);
        let new_abs = wiki_root.join(new_rel);

        // Create two test page files.
        fs::write(&old_abs, "---\ntitle: Old Page\n---\n\nBody.\n")
            .expect("failed to write test old page");
        fs::write(&new_abs, "---\ntitle: New Page\n---\n\nBody.\n")
            .expect("failed to write test new page");

        // Run link_supersede_at — this is the success path under test.
        let result =
            link_supersede_at(old_rel, new_rel, "successor", &wiki_root);
        assert!(result.is_ok(), "link_supersede should succeed: {result:?}");

        // Read old file and verify last_validated was written.
        let old_content = fs::read_to_string(&old_abs)
            .expect("failed to read old page after supersedure");
        assert!(
            old_content.contains("last_validated:"),
            "old page should have last_validated after supersedure"
        );

        // Extract and validate the timestamp is a sensible ISO 8601 value.
        let fm = wiki::parse_frontmatter(&old_content);
        let lv = fm
            .get("last_validated")
            .and_then(|v| v.as_str())
            .expect("last_validated should be a string");
        assert!(
            lv.contains('T') || lv.contains('-'),
            "last_validated should be an ISO 8601 timestamp, got: {lv}"
        );
    }
}
