//! Frontmatter property read/write/delete — structural YAML field ops.

use std::fs;
use std::path::Path;

use crate::wiki;

/// Read the value of a frontmatter property.
///
/// Returns `Ok(None)` if the field does not exist.
pub fn get(page: &Path, name: &str) -> Result<Option<String>, String> {
    let content =
        fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))?;
    let fm = wiki::parse_frontmatter(&content);
    Ok(fm.get(name).and_then(|v| v.as_str().map(ToString::to_string)))
}

/// Set (add or update) a frontmatter property.
///
/// If the field already exists, its value is replaced.  If not, a new
/// line is inserted before the closing `---`.
///
/// Writes atomically (temp file → rename).
pub fn set(page: &Path, name: &str, value: &str) -> Result<(), String> {
    let content =
        fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))?;

    let lines: Vec<&str> = content.lines().collect();

    // Find frontmatter boundaries: first `---` to second `---`
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

    let (Some(start), Some(end)) = (fm_start, fm_end) else {
        return Err("文件缺少有效的 frontmatter".to_string());
    };

    let mut new_lines: Vec<String> = Vec::new();
    let mut found = false;

    // Lines before frontmatter (including opening `---`)
    for line in &lines[..=start] {
        new_lines.push(line.to_string());
    }

    // Frontmatter body
    for line in &lines[start + 1..end] {
        if let Some((key, _)) = line.split_once(':') {
            if key.trim() == name {
                new_lines.push(format!("{name}: {value}"));
                found = true;
            } else {
                new_lines.push(line.to_string());
            }
        } else {
            new_lines.push(line.to_string());
        }
    }

    // If field was not found, insert before closing `---`
    if !found {
        new_lines.push(format!("{name}: {value}"));
    }

    // Closing `---`
    new_lines.push(lines[end].to_string());

    // Lines after frontmatter
    for line in &lines[end + 1..] {
        new_lines.push(line.to_string());
    }

    let mut new_content = new_lines.join("\n");
    // Preserve trailing newline if original content had one
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    // Atomic write
    zutil::fileio::write_atomic(page, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

/// Set (or remove) a frontmatter block-list field.
///
/// Replaces the field's key line and any indented continuation lines with
/// a YAML block list (`  - item` per value).  When `items` is empty the
/// field is removed entirely.  Returns `true` when the file content
/// changed on disk.
///
/// Writes atomically (temp file → rename).
pub fn set_block_list(
    page: &Path,
    name: &str,
    items: &[String],
) -> Result<bool, String> {
    let content =
        fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))?;

    // The opening delimiter must be the very first line; otherwise a body
    // containing two horizontal rules would be mistaken for a frontmatter
    // block and the field would be injected mid-body.
    if wiki::frontmatter_inner_range(&content).is_none() {
        return Err("文件缺少有效的 frontmatter".to_string());
    }

    let lines: Vec<&str> = content.lines().collect();

    // Find frontmatter boundaries: first `---` to second `---`
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

    let (Some(start), Some(end)) = (fm_start, fm_end) else {
        return Err("文件缺少有效的 frontmatter".to_string());
    };

    let mut new_lines: Vec<String> = Vec::new();

    // Lines before frontmatter (including opening `---`)
    for line in &lines[..=start] {
        new_lines.push((*line).to_string());
    }

    let mut found = false;
    let mut skipping = false;

    // Frontmatter body
    for line in &lines[start + 1..end] {
        // A field's block list continues until a non-indented line.
        if skipping {
            if line.starts_with(' ') || line.starts_with('\t') {
                continue;
            }
            skipping = false;
        }

        let is_field = !line.starts_with(' ')
            && !line.starts_with('\t')
            && line.split_once(':').is_some_and(|(key, _)| key.trim() == name);

        if is_field {
            found = true;
            skipping = true;
            if !items.is_empty() {
                new_lines.push(format!("{name}:"));
                for item in items {
                    new_lines.push(format!("  - {item}"));
                }
            }
        } else {
            new_lines.push((*line).to_string());
        }
    }

    // Field absent but values provided — insert before closing `---`
    if !found && !items.is_empty() {
        new_lines.push(format!("{name}:"));
        for item in items {
            new_lines.push(format!("  - {item}"));
        }
    }

    // Closing `---`
    new_lines.push(lines[end].to_string());

    // Lines after frontmatter
    for line in &lines[end + 1..] {
        new_lines.push((*line).to_string());
    }

    let mut new_content = new_lines.join("\n");
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    if new_content == content {
        return Ok(false);
    }

    zutil::fileio::write_atomic(page, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(true)
}

/// Delete a frontmatter property (remove its line).
///
/// Writes atomically (temp file → rename).
pub fn delete(page: &Path, name: &str) -> Result<(), String> {
    let content =
        fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))?;

    let lines: Vec<&str> = content.lines().collect();

    // Find frontmatter boundaries
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

    let (Some(start), Some(end)) = (fm_start, fm_end) else {
        return Err("文件缺少有效的 frontmatter".to_string());
    };

    let mut new_lines: Vec<String> = Vec::new();

    // Lines before and including opening `---`
    for line in &lines[..=start] {
        new_lines.push(line.to_string());
    }

    // Frontmatter body — skip the line matching `name:`
    for line in &lines[start + 1..end] {
        let should_skip =
            line.split_once(':').is_some_and(|(key, _)| key.trim() == name);
        if !should_skip {
            new_lines.push(line.to_string());
        }
    }

    // Closing `---`
    new_lines.push(lines[end].to_string());

    // Lines after frontmatter
    for line in &lines[end + 1..] {
        new_lines.push(line.to_string());
    }

    let mut new_content = new_lines.join("\n");
    // Preserve trailing newline if original content had one
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    // Atomic write
    zutil::fileio::write_atomic(page, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Status downgrade
// ---------------------------------------------------------------------------

/// Downgrade a status value by one confidence level.
///
/// Mapping: `stable` → `review` → `draft` → `draft`.
/// `deprecated` and unknown values pass through unchanged.
#[must_use]
pub fn downgrade_status(status: &str) -> &str {
    match status {
        "stable" => "review",
        "review" | "draft" => "draft",
        "deprecated" => "deprecated",
        other => other,
    }
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
            std::env::temp_dir().join("zwiki-test").join("property").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn make_page(dir: &Path, filename: &str, frontmatter: &str) -> PathBuf {
        let path = dir.join(filename);
        fs::write(&path, frontmatter).expect("failed to write test page");
        path
    }

    const SAMPLE: &str = "---\ntitle: Test Page\nstatus: draft\ntags: [a, b]\n---\n\nBody content.\n";

    // -------------------------------------------------------------------
    // get
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // downgrade_status
    // -------------------------------------------------------------------

    #[test]
    fn test_downgrade_stable_to_review() {
        assert_eq!(downgrade_status("stable"), "review");
    }

    #[test]
    fn test_downgrade_review_to_draft() {
        assert_eq!(downgrade_status("review"), "draft");
    }

    #[test]
    fn test_downgrade_draft_stays_draft() {
        assert_eq!(downgrade_status("draft"), "draft");
    }

    #[test]
    fn test_downgrade_deprecated_stays_deprecated() {
        assert_eq!(downgrade_status("deprecated"), "deprecated");
    }

    #[test]
    fn test_downgrade_unknown_status_passthrough() {
        assert_eq!(downgrade_status("unknown"), "unknown");
    }

    #[test]
    fn test_get_existing_field() {
        let dir = temp_dir("get_existing");
        let path = make_page(&dir, "test.md", SAMPLE);
        let result = get(&path, "status");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some("draft".to_string()));
    }

    #[test]
    fn test_get_missing_field() {
        let dir = temp_dir("get_missing");
        let path = make_page(&dir, "test.md", SAMPLE);
        let result = get(&path, "timeliness");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn test_get_no_frontmatter() {
        let dir = temp_dir("get_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        let result = get(&path, "title");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    // -------------------------------------------------------------------
    // set
    // -------------------------------------------------------------------

    #[test]
    fn test_set_new_field() {
        let dir = temp_dir("set_new");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "timeliness", "stale").unwrap();

        let result = get(&path, "timeliness").unwrap();
        assert_eq!(result, Some("stale".to_string()));

        // Verify other fields preserved
        let result = get(&path, "title").unwrap();
        assert_eq!(result, Some("Test Page".to_string()));
    }

    #[test]
    fn test_set_existing_field() {
        let dir = temp_dir("set_existing");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "status", "stable").unwrap();

        let result = get(&path, "status").unwrap();
        assert_eq!(result, Some("stable".to_string()));

        // Body should still be intact
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("Body content."));
    }

    #[test]
    fn test_set_field_no_frontmatter() {
        let dir = temp_dir("set_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        let result = set(&path, "title", "Hello");
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // set_block_list
    // -------------------------------------------------------------------

    #[test]
    fn test_set_block_list_creates_field() {
        let dir = temp_dir("bl_create");
        let path = make_page(&dir, "test.md", SAMPLE);
        let items = vec!["a.md".to_string(), "b.md".to_string()];
        let changed = set_block_list(&path, "relations", &items).unwrap();
        assert!(changed);

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("relations:\n  - a.md\n  - b.md"));
        // Other fields preserved.
        assert!(content.contains("title: Test Page"));
    }

    #[test]
    fn test_set_block_list_is_idempotent() {
        let dir = temp_dir("bl_idem");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: T\nrelations:\n  - a.md\n---\n\nBody.\n",
        );
        let items = vec!["a.md".to_string()];
        assert!(!set_block_list(&path, "relations", &items).unwrap());
    }

    #[test]
    fn test_set_block_list_replaces_inline_array() {
        let dir = temp_dir("bl_inline");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: T\nrelations: [a.md, b.md]\nstatus: draft\n---\n\nBody.\n",
        );
        let items = vec!["c.md".to_string()];
        assert!(set_block_list(&path, "relations", &items).unwrap());

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("relations:\n  - c.md"));
        assert!(!content.contains("a.md"));
        assert!(content.contains("status: draft"));
    }

    #[test]
    fn test_set_block_list_empty_removes_field() {
        let dir = temp_dir("bl_remove");
        let path = make_page(
            &dir,
            "test.md",
            "---\ntitle: T\nrelations:\n  - a.md\n  - b.md\nstatus: draft\n---\n\nBody.\n",
        );
        assert!(set_block_list(&path, "relations", &[]).unwrap());

        let content = fs::read_to_string(&path).unwrap();
        assert!(!content.contains("relations"));
        assert!(content.contains("status: draft"));
    }

    #[test]
    fn test_set_block_list_no_frontmatter() {
        let dir = temp_dir("bl_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        let items = vec!["a.md".to_string()];
        assert!(set_block_list(&path, "relations", &items).is_err());
    }

    #[test]
    fn test_set_block_list_body_rules_not_frontmatter() {
        // A page without frontmatter whose body contains two `---` rules
        // must be rejected instead of having the field injected mid-body.
        let dir = temp_dir("bl_body_rules");
        let content = "# Body\n\nBefore.\n\n---\n\nMiddle.\n\n---\n\nAfter.\n";
        let path = make_page(&dir, "test.md", content);
        let items = vec!["a.md".to_string()];
        assert!(set_block_list(&path, "relations", &items).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }

    // -------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------

    #[test]
    fn test_delete_field() {
        let dir = temp_dir("delete_field");
        let path = make_page(&dir, "test.md", SAMPLE);
        delete(&path, "status").unwrap();

        let result = get(&path, "status").unwrap();
        assert_eq!(result, None);

        // Other fields preserved
        let result = get(&path, "title").unwrap();
        assert_eq!(result, Some("Test Page".to_string()));
    }

    #[test]
    fn test_delete_nonexistent_field() {
        let dir = temp_dir("delete_nonexistent");
        let path = make_page(&dir, "test.md", SAMPLE);
        // Should not error; just no-op
        let result = delete(&path, "timeliness");
        assert!(result.is_ok());

        // Body intact
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("Body content."));
    }

    #[test]
    fn test_delete_field_no_frontmatter() {
        let dir = temp_dir("delete_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        let result = delete(&path, "title");
        assert!(result.is_err());
    }
}
