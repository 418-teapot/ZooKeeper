//! `zwiki move` — rename / relocate a wiki page and update all references.
//!
//! Handles both same-domain renames and cross-domain moves. Updates
//! frontmatter path fields, body inline links, body backtick references,
//! and domain index.md entries.

use std::fs;
use std::path::Path;

use regex::Regex;

use crate::{backlinks, wiki};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Result of a successful move operation.
#[derive(Debug)]
pub struct MoveResult {
    /// Human-readable summary: `"old → new"`.
    pub moved: String,
    /// Deduplicated wiki-relative paths of pages whose references were updated.
    pub updated_refs: Vec<String>,
    /// Wiki-relative paths of index.md files that were modified.
    pub updated_indexes: Vec<String>,
}

/// Execute a page move: rename the file, rewrite all cross-references, and
/// update domain index.md files.
///
/// `wiki_root` is the base directory of the wiki (e.g. `~/.zoo/wiki/`).
pub fn execute_move(
    wiki_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<MoveResult, String> {
    // ---- Step 1: Validation ------------------------------------------------
    validate_rel_path(old_rel)?;
    validate_rel_path(new_rel)?;

    let old_abs = wiki_root.join(old_rel);
    let new_abs = wiki_root.join(new_rel);

    if !old_abs.exists() {
        return Err(format!("源页面不存在: {old_rel}"));
    }
    if new_abs.exists() {
        return Err(format!("目标路径已存在: {new_rel}"));
    }

    // Create parent directories for the new path.
    if let Some(parent) = new_abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目标目录: {e}"))?;
    }

    // ---- Step 2: Build reverse-index BEFORE the move -----------------------
    let all_paths = wiki::discover_pages(wiki_root);
    let all_pages: Vec<wiki::Page> = all_paths
        .iter()
        .filter_map(|p| wiki::read_page_at(p, wiki_root))
        .collect();
    let rev_index = backlinks::build_reverse_index(wiki_root, &all_pages);

    // ---- Step 3: Physical move ---------------------------------------------
    fs::rename(&old_abs, &new_abs).map_err(|e| format!("移动文件失败: {e}"))?;

    // ---- Step 4: Rewrite references in referring pages ---------------------
    let mut updated_refs: Vec<String> = Vec::new();
    if let Some(sources) = rev_index.get(old_rel) {
        for src_rel in sources {
            // Self-reference: the moved page is now at new_abs, so read from
            // there instead of the (now-gone) old location.
            let src_abs = if src_rel == old_rel {
                new_abs.clone()
            } else {
                wiki_root.join(src_rel)
            };
            if rewrite_page_references(&src_abs, old_rel, new_rel)? {
                updated_refs.push(src_rel.clone());
            }
        }
    }
    updated_refs.sort();
    updated_refs.dedup();

    // ---- Step 5: Update index.md files -------------------------------------
    let mut updated_indexes: Vec<String> = Vec::new();

    let old_domain = old_rel.split('/').next().unwrap_or("");
    let new_domain = new_rel.split('/').next().unwrap_or("");

    if old_domain == new_domain
        || old_domain.is_empty()
        || new_domain.is_empty()
    {
        // Same-domain rename — update the domain's index.md in-place.
        if !old_domain.is_empty() {
            let index_path = wiki_root.join(old_domain).join("index.md");
            if index_path.exists()
                && update_index_same_domain(
                    &index_path,
                    wiki_root,
                    old_rel,
                    new_rel,
                )?
            {
                let rel = index_path
                    .strip_prefix(wiki_root)
                    .unwrap_or(&index_path)
                    .to_string_lossy()
                    .to_string();
                updated_indexes.push(rel);
            }
        }
    } else {
        // Cross-domain move — remove from old index, add to new index.
        // Remove from old domain index.
        let old_index = wiki_root.join(old_domain).join("index.md");
        if old_index.exists()
            && remove_index_entry(&old_index, wiki_root, old_rel)?
        {
            let rel = old_index
                .strip_prefix(wiki_root)
                .unwrap_or(&old_index)
                .to_string_lossy()
                .to_string();
            updated_indexes.push(rel);
        }

        // Read moved page frontmatter for the new index entry.
        let moved_content = wiki::read_file(&new_abs);
        let moved_fm = wiki::parse_frontmatter(&moved_content);
        let page_type =
            moved_fm.get("type").and_then(|v| v.as_str()).unwrap_or("concept");
        let title = moved_fm
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled");

        // Add to new domain index.
        let new_index = wiki_root.join(new_domain).join("index.md");
        if add_index_entry(&new_index, wiki_root, new_rel, title, page_type)? {
            let rel = new_index
                .strip_prefix(wiki_root)
                .unwrap_or(&new_index)
                .to_string_lossy()
                .to_string();
            updated_indexes.push(rel);
        }
    }

    updated_indexes.sort();
    updated_indexes.dedup();

    Ok(MoveResult {
        moved: format!("{old_rel} → {new_rel}"),
        updated_refs,
        updated_indexes,
    })
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/// Reject absolute paths and paths containing `..`.
fn validate_rel_path(path_str: &str) -> Result<(), String> {
    if Path::new(path_str).is_absolute() {
        return Err(format!("路径不能是绝对路径: {path_str}"));
    }
    if path_str.contains("..") {
        return Err(format!("路径不能包含 '..': {path_str}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reference rewriting (per-page)
// ---------------------------------------------------------------------------

/// Rewrite all references to `old_rel` in a single page file.
///
/// Handles three reference types:
/// 1. Markdown inline links `[text](old_rel)` → `[text](new_rel)`.
///    This also covers frontmatter `relations` entries, which use the
///    same `[title](path.md)` markdown-link format.
/// 2. Backtick-wrapped `` `old_rel` `` → `` `new_rel` ``
/// 3. Frontmatter `supersedes`/`superseded_by`/`contradictions` path fields:
///    `path: old_rel` → `path: new_rel`
///
/// Returns `true` if the file was modified.
fn rewrite_page_references(
    page_abs: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<bool, String> {
    let content = fs::read_to_string(page_abs)
        .map_err(|e| format!("无法读取文件: {e}"))?;
    if content.is_empty() {
        return Ok(false);
    }

    let mut new_content = content.clone();

    // 1. Markdown inline links: [text](old_rel)
    //    Use literal replacement — the target appears exactly as old_rel in
    //    markdown link notation.
    let md_old = format!("]({old_rel})");
    let md_new = format!("]({new_rel})");
    new_content = new_content.replace(&md_old, &md_new);

    // 2. Backtick-wrapped paths: `old_rel`
    let bt_old = format!("`{old_rel}`");
    let bt_new = format!("`{new_rel}`");
    new_content = new_content.replace(&bt_old, &bt_new);

    // 3. Frontmatter supersedes / superseded_by / contradictions path fields.
    //    The parser stores block-list items as flat strings "path: <value>"
    //    and inline-list elements as "path: <value>".
    let path_old = format!("path: {old_rel}");
    let path_new = format!("path: {new_rel}");
    new_content = new_content.replace(&path_old, &path_new);

    if new_content == content {
        return Ok(false);
    }

    // Atomically write the modified content (temp file + rename).
    zutil::fileio::write_atomic(page_abs, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(true)
}

// ---------------------------------------------------------------------------
// Index.md — same-domain update
// ---------------------------------------------------------------------------

/// Update an index.md file for a same-domain move.
///
/// Finds the entry line referencing `old_rel` and replaces its link target
/// with the path relative to the index directory.
fn update_index_same_domain(
    index_abs: &Path,
    wiki_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<bool, String> {
    let content = fs::read_to_string(index_abs)
        .map_err(|e| format!("无法读取 index.md: {e}"))?;
    if content.is_empty() {
        return Ok(false);
    }

    // Compute the old/new link targets relative to the index directory.
    let index_dir = index_abs.parent().unwrap_or_else(|| Path::new(""));
    let old_rel_to_index = rel_from_index(index_dir, wiki_root, old_rel);
    let new_rel_to_index = rel_from_index(index_dir, wiki_root, new_rel);

    // Replace the link target in markdown links.
    let old_pattern = format!("]({old_rel_to_index})");
    let new_pattern = format!("]({new_rel_to_index})");

    let new_content = content.replace(&old_pattern, &new_pattern);

    if new_content == content {
        return Ok(false);
    }

    // Atomic write.
    zutil::fileio::write_atomic(index_abs, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(true)
}

// ---------------------------------------------------------------------------
// Index.md — cross-domain: remove entry
// ---------------------------------------------------------------------------

/// Remove the index entry line that references `old_rel` from an index.md.
fn remove_index_entry(
    index_abs: &Path,
    wiki_root: &Path,
    old_rel: &str,
) -> Result<bool, String> {
    let content = fs::read_to_string(index_abs)
        .map_err(|e| format!("无法读取 index.md: {e}"))?;
    if content.is_empty() {
        return Ok(false);
    }

    let index_dir = index_abs.parent().unwrap_or_else(|| Path::new(""));
    let old_rel_to_index = rel_from_index(index_dir, wiki_root, old_rel);

    // Pattern to match the full index entry line:
    //   * [Title](old_rel_to_index)
    // Optionally followed by " — description"
    let entry_pattern = format!(
        r"^\s*\*\s+\[.*?\]\({}\)\s*(?:[—\-].*)?$",
        regex::escape(&old_rel_to_index)
    );
    let re =
        Regex::new(&entry_pattern).map_err(|e| format!("正则错误: {e}"))?;

    let mut new_lines: Vec<String> = Vec::new();
    let mut removed = false;

    for line in content.lines() {
        if re.is_match(line) {
            removed = true;
            // Skip this line (remove the entry).
            continue;
        }
        new_lines.push(line.to_string());
    }

    if !removed {
        return Ok(false);
    }

    let new_content = new_lines.join("\n");
    // Preserve trailing newline.
    let new_content = if content.ends_with('\n') && !new_content.ends_with('\n')
    {
        format!("{new_content}\n")
    } else {
        new_content
    };

    // Atomic write.
    zutil::fileio::write_atomic(index_abs, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(true)
}

// ---------------------------------------------------------------------------
// Index.md — cross-domain: add entry
// ---------------------------------------------------------------------------

/// Append a new index entry `* [title](new_rel_filename) — description`
/// under the appropriate `## <type>` section in new domain's index.md.
///
/// If the section does not exist, it is created.  If the index.md file does
/// not exist, it is created with the section and entry.
fn add_index_entry(
    index_abs: &Path,
    wiki_root: &Path,
    new_rel: &str,
    title: &str,
    page_type: &str,
) -> Result<bool, String> {
    // Map the internal page_type to the real-world section header.
    let mapped_header =
        section_header_for_type(page_type).ok_or_else(|| {
            format!("未知的页面类型，无法定位 index section: {page_type}")
        })?;

    let index_dir = index_abs.parent().unwrap_or_else(|| Path::new(""));
    let new_rel_to_index = rel_from_index(index_dir, wiki_root, new_rel);

    // Build the new entry line.
    let entry_line = format!("* [{title}]({new_rel_to_index})");

    // Try reading existing content.
    let existing_content = fs::read_to_string(index_abs).unwrap_or_default();

    if existing_content.is_empty() {
        // File does not exist or is empty — create it with the section.
        let content = format!("{mapped_header}\n\n{entry_line}\n");
        if let Some(parent) = index_abs.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建目录: {e}"))?;
        }
        fs::write(index_abs, &content)
            .map_err(|e| format!("写入 index.md 失败: {e}"))?;
        return Ok(true);
    }

    // Find the section whose header line starts with the mapped header.
    // Use prefix matching so that extra content after the header (e.g.
    // Chinese annotations) is tolerated.
    let section_re =
        Regex::new(&format!(r"(?m)^{}.*$", regex::escape(mapped_header)))
            .map_err(|e| format!("正则错误: {e}"))?;

    let new_content: String = if let Some(section_match) =
        section_re.find(&existing_content)
    {
        let matched_header_line = section_match.as_str(); // keep original

        // Section exists — find the end of this section.
        let section_start = section_match.start();
        let after_header = section_match.end();

        // Find the next `## ` section or end of file.
        let next_section_re =
            Regex::new(r"(?m)^## ").map_err(|e| format!("正则错误: {e}"))?;
        let section_end = next_section_re
            .find(&existing_content[after_header..])
            .map_or(existing_content.len(), |m| after_header + m.start());

        let before_section = &existing_content[..section_start];
        let section_body = &existing_content[after_header..section_end];
        let after_section = &existing_content[section_end..];

        // Check if entry already exists (avoid duplicates).
        let entry_check = Regex::new(&format!(
            r"^\s*\*\s+\[.*?\]\({}\)",
            regex::escape(&new_rel_to_index)
        ))
        .map_err(|e| format!("正则错误: {e}"))?;
        if entry_check.is_match(section_body) {
            return Ok(false);
        }

        // Insert the new entry into the section body.
        let trimmed_body = section_body.trim();
        let updated_body = if trimmed_body.is_empty() {
            format!("\n{entry_line}\n")
        } else {
            format!("\n{trimmed_body}\n{entry_line}\n")
        };

        // Use the original header line from the file (preserving any
        // extra content such as annotations) rather than the mapped one.
        format!(
            "{before_section}{matched_header_line}{updated_body}{after_section}"
        )
    } else {
        // Section does not exist — create it at the end of the file.
        let trimmed = existing_content.trim_end();
        format!("{trimmed}\n\n{mapped_header}\n\n{entry_line}\n")
    };

    // Atomic write.
    zutil::fileio::write_atomic(index_abs, &new_content)
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(true)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Map the internal `page_type` value (lowercase singular) to the
/// corresponding real-world section header used in domain index.md files.
///
/// Returns `None` for unknown / unrecognised types.  The caller should
/// propagate this as an error rather than creating a malformed section.
fn section_header_for_type(page_type: &str) -> Option<&'static str> {
    let header = match page_type {
        "concept" => "## Concepts（概念）",
        "entity" => "## Entities（实体）",
        "source" => "## Sources（源文档）",
        "analysis" => "## Analysis（分析）",
        "synthesis" => "## Syntheses（综合）",
        _ => return None,
    };
    Some(header)
}

/// Compute the path from an index file's parent directory to a wiki-relative
/// page path.  This is what the markdown link target in the index would be.
fn rel_from_index(
    index_dir: &Path,
    wiki_root: &Path,
    wiki_rel: &str,
) -> String {
    // wiki_rel is like "concepts/foo.md";
    // index_dir is like "/path/wiki/concepts".
    // We need the relative path from index_dir to the wiki page.
    let page_abs = wiki_root.join(wiki_rel);
    page_abs
        .strip_prefix(index_dir)
        .unwrap_or_else(|_| Path::new(wiki_rel))
        .to_string_lossy()
        .to_string()
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("move").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Create a wiki page file with frontmatter.
    fn make_page(wiki_root: &Path, rel: &str, content: &str) -> PathBuf {
        write(&wiki_root.join(rel), content)
    }

    /// Simple frontmatter builder.
    fn fm_page(
        title: &str,
        page_type: &str,
        extra: &str,
        body: &str,
    ) -> String {
        format!(
            "---\ntitle: {title}\ntype: {page_type}\ntags: []\nstatus: draft\nlast_validated: 2025-01-01\n{extra}---\n\n{body}"
        )
    }

    /// Read the content of a file, panicking on error.
    fn read_file(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    // -------------------------------------------------------------------
    // Validation tests
    // -------------------------------------------------------------------

    #[test]
    fn test_validate_rejects_absolute_path() {
        assert!(validate_rel_path("/etc/passwd.md").is_err());
        assert!(validate_rel_path("/home/foo.md").is_err());
    }

    #[test]
    fn test_validate_rejects_dotdot() {
        assert!(validate_rel_path("../etc/passwd.md").is_err());
        assert!(validate_rel_path("concepts/../../foo.md").is_err());
    }

    #[test]
    fn test_validate_accepts_normal_path() {
        assert!(validate_rel_path("concepts/foo.md").is_ok());
        assert!(validate_rel_path("autoresearch/concepts/bar.md").is_ok());
        assert!(validate_rel_path("foo.md").is_ok());
    }

    // -------------------------------------------------------------------
    // Error scenarios
    // -------------------------------------------------------------------

    #[test]
    fn test_move_old_not_found() {
        let wiki_root = temp_dir("old_not_found");
        // Create a minimal wiki with a page but not the source.
        make_page(&wiki_root, "concepts/existing.md", "# Existing");
        let result = execute_move(
            &wiki_root,
            "concepts/nonexistent.md",
            "concepts/new.md",
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("源页面不存在"));
    }

    #[test]
    fn test_move_new_already_exists() {
        let wiki_root = temp_dir("new_exists");
        make_page(&wiki_root, "concepts/old.md", "# Old");
        make_page(&wiki_root, "concepts/new.md", "# New");
        let result =
            execute_move(&wiki_root, "concepts/old.md", "concepts/new.md");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("目标路径已存在"));
    }

    #[test]
    fn test_move_rejects_dotdot() {
        let wiki_root = temp_dir("dotdot");
        let result = execute_move(&wiki_root, "concepts/foo.md", "../bar.md");
        assert!(result.is_err());
    }

    #[test]
    fn test_move_rejects_absolute() {
        let wiki_root = temp_dir("absolute");
        let result = execute_move(&wiki_root, "concepts/foo.md", "/tmp/bar.md");
        assert!(result.is_err());
    }

    #[test]
    fn test_old_not_found_no_side_effects() {
        // Verify no file was created/moved when validation fails.
        let wiki_root = temp_dir("no_side_effect");
        make_page(&wiki_root, "concepts/foo.md", "# Foo");
        make_page(&wiki_root, "concepts/bar.md", "# Bar");

        let result = execute_move(
            &wiki_root,
            "concepts/nonexistent.md",
            "concepts/new.md",
        );
        assert!(result.is_err());

        // Original files should still exist.
        assert!(wiki_root.join("concepts/foo.md").exists());
        assert!(wiki_root.join("concepts/bar.md").exists());
        // New file should NOT exist.
        assert!(!wiki_root.join("concepts/new.md").exists());
    }

    // -------------------------------------------------------------------
    // Same-domain rename — basic
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_basic_rename() {
        let wiki_root = temp_dir("same_domain_basic");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        // Create the page to move.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "concept", "", "# Foo\n\nContent."),
        );
        // Create domain index.md with an entry for the page.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n\n## Entities（实体）\n\n* [Other](other.md)\n",
        );

        // Create a referencer page.
        make_page(
            &wiki_root,
            "concepts/referencer.md",
            &fm_page(
                "Referencer",
                "concept",
                "relations:\n- [Foo](concepts/foo.md)\nsupersedes:\n  - path: concepts/foo.md\n    reason: outdated\n",
                "See [Foo](concepts/foo.md) and check `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Check file was moved.
        assert!(!wiki_root.join(old_rel).exists());
        assert!(wiki_root.join(new_rel).exists());

        // Check referencer was updated.
        let ref_content = read_file(&wiki_root.join("concepts/referencer.md"));
        assert!(
            ref_content.contains("](concepts/bar.md)"),
            "markdown link should be updated"
        );
        assert!(
            ref_content.contains("`concepts/bar.md`"),
            "backtick reference should be updated"
        );
        assert!(
            ref_content.contains("[Foo](concepts/bar.md)"),
            "relations entry should be updated"
        );
        assert!(
            ref_content.contains("path: concepts/bar.md"),
            "supersedes path should be updated"
        );
        assert!(
            !ref_content.contains("concepts/foo.md"),
            "old path should not remain"
        );

        // Check index was updated.
        let index_content = read_file(&wiki_root.join("concepts/index.md"));
        assert!(
            index_content.contains("](bar.md)"),
            "index should reference new path"
        );
        assert!(
            !index_content.contains("](foo.md)"),
            "index should not reference old path"
        );

        // Check result metadata.
        assert!(
            result.updated_refs.contains(&"concepts/referencer.md".to_string())
        );
        assert!(
            result.updated_indexes.contains(&"concepts/index.md".to_string())
        );
        assert_eq!(result.moved, "concepts/foo.md → concepts/bar.md");
    }

    // -------------------------------------------------------------------
    // Same-domain rename — body-only references
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_body_only_references() {
        let wiki_root = temp_dir("body_only");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Referencer with only body links (no frontmatter relations).
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "Read [Foo](concepts/foo.md) and see `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(result.updated_refs.contains(&"concepts/ref.md".to_string()));

        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.contains("](concepts/bar.md)"));
        assert!(ref_content.contains("`concepts/bar.md`"));
        assert!(!ref_content.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Same-domain rename — all four frontmatter reference types
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_all_frontmatter_types() {
        let wiki_root = temp_dir("all_fm_types");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // A page that references foo in ALL four frontmatter fields.
        let ref_fm = "\
relations:
- [Foo](concepts/foo.md)
supersedes:
  - path: concepts/foo.md
    reason: outdated
superseded_by:
  - path: concepts/foo.md
contradictions:
  - path: concepts/foo.md
    claims:
      - claim
    detected: 2025-01-01
    resolution: unresolved
";

        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page("Ref", "concept", ref_fm, "# Ref\n\nBody.\n"),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.contains("[Foo](concepts/bar.md)"));

        // Count occurrences of the new path to verify all four were updated.
        let count_new = ref_content.matches("concepts/bar.md").count();
        assert_eq!(
            count_new, 4,
            "all four frontmatter entries should be updated"
        );

        assert!(!ref_content.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Cross-domain move
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_move() {
        let wiki_root = temp_dir("cross_domain");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        // Create the page to move.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo Concept", "concept", "", "# Foo\n\nContent.\n"),
        );
        // Create old domain index.md.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n* [Other](other.md)\n\n## Entities（实体）\n\n* [E](e.md)\n",
        );
        // Create new domain index.md.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n\n## Syntheses（综合）\n\n* [Synth](synth.md)\n",
        );

        // Create a referencer in the old domain.
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "relations:\n- [Foo](concepts/foo.md)\n",
                "See [Foo](concepts/foo.md).\nRefer to `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // File moved.
        assert!(!wiki_root.join(old_rel).exists());
        assert!(wiki_root.join(new_rel).exists());

        // Referencer updated.
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.contains("](autoresearch/concepts/foo.md)"));
        assert!(ref_content.contains("`autoresearch/concepts/foo.md`"));
        // The old path is a substring of the new path, so check link patterns
        // instead of raw substring.
        assert!(
            !ref_content.contains("](concepts/foo.md)"),
            "markdown link to old path should not remain"
        );
        assert!(
            !ref_content.contains("`concepts/foo.md`"),
            "backtick reference to old path should not remain"
        );

        // Old index: entry removed.
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(
            !old_index.contains("](foo.md)"),
            "old index should not have foo entry"
        );
        assert!(
            old_index.contains("](other.md)"),
            "other entries should remain"
        );
        assert!(old_index.contains("](e.md)"), "other entries should remain");

        // New index: entry added under correct type section.
        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("[Foo Concept](concepts/foo.md)"),
            "new index should have entry for the moved page"
        );
        assert!(
            new_index.contains("## Concepts（概念）"),
            "section type should exist"
        );
        // The existing concept entry should still be there.
        assert!(new_index.contains("[Bar](bar.md)"));

        // Result metadata.
        assert!(
            result
                .updated_indexes
                .contains(&"autoresearch/index.md".to_string())
        );
        assert!(
            result.updated_indexes.contains(&"concepts/index.md".to_string())
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain move — new domain without index.md
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_new_domain_no_index() {
        let wiki_root = temp_dir("new_domain_no_index");
        let old_rel = "concepts/foo.md";
        let new_rel = "newdomain/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // New index should be created.
        let new_index_path = wiki_root.join("newdomain/index.md");
        assert!(new_index_path.exists());
        let new_index = read_file(&new_index_path);
        assert!(new_index.contains("[Foo](concepts/foo.md)"));
        assert!(new_index.contains("## Concepts（概念）"));

        // Old index should have entry removed.
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(!old_index.contains("foo.md"));
    }

    // -------------------------------------------------------------------
    // Cross-domain move — with subdirectory in new domain
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_subdir() {
        let wiki_root = temp_dir("cross_domain_subdir");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        // Old domain index with foo entry.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        // New domain index with existing concept section.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(wiki_root.join(new_rel).exists());

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("[Foo](concepts/foo.md)"),
            "new index entry should reference the subdirectory relative path"
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain — entry added to correct type section
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_correct_type_section() {
        let wiki_root = temp_dir("correct_type");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "analysis", "", "# Foo\n\nAnalysis content."),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n\n## Analysis（分析）\n\n* [Existing](existing.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        // The entry should be added under ## Analysis（分析）, not ## Concepts（概念）.
        let analysis_section_start =
            new_index.find("## Analysis（分析）").unwrap();
        let foo_pos = new_index.find("[Foo](concepts/foo.md)").unwrap();
        assert!(
            foo_pos > analysis_section_start,
            "entry should be under the analysis section"
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain — type section does not exist yet
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_new_type_section() {
        let wiki_root = temp_dir("new_type_section");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "synthesis", "", "# Foo"),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        // New domain index does not have a ## Syntheses（综合） section.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("## Syntheses（综合）"),
            "new type section should be created"
        );
        assert!(
            new_index.contains("[Foo](concepts/foo.md)"),
            "entry should be present"
        );
    }

    // -------------------------------------------------------------------
    // Multiple referencers with deduplication
    // -------------------------------------------------------------------

    #[test]
    fn test_multiple_referencers() {
        let wiki_root = temp_dir("multiple_refs");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Two referencers.
        make_page(
            &wiki_root,
            "concepts/ref1.md",
            &fm_page("Ref1", "concept", "", "See [Foo](concepts/foo.md).\n"),
        );
        make_page(
            &wiki_root,
            "concepts/ref2.md",
            &fm_page("Ref2", "concept", "", "Check `concepts/foo.md`.\n"),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert_eq!(result.updated_refs.len(), 2);
        assert!(result.updated_refs.contains(&"concepts/ref1.md".to_string()));
        assert!(result.updated_refs.contains(&"concepts/ref2.md".to_string()));

        let r1 = read_file(&wiki_root.join("concepts/ref1.md"));
        assert!(r1.contains("](concepts/bar.md)"));
        assert!(!r1.contains("concepts/foo.md"));

        let r2 = read_file(&wiki_root.join("concepts/ref2.md"));
        assert!(r2.contains("`concepts/bar.md`"));
        assert!(!r2.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Self-reference: page links to itself, move should not crash
    // -------------------------------------------------------------------

    #[test]
    fn test_self_reference_does_not_crash() {
        let wiki_root = temp_dir("self_ref");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        // Page that links to itself in body and relations.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page(
                "Foo",
                "concept",
                "relations:\n- [Foo](concepts/foo.md)\n",
                "See [Foo](concepts/foo.md) and check `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert!(wiki_root.join(new_rel).exists());
        assert!(!wiki_root.join(old_rel).exists());

        // The moved page should have its self-references updated.
        let moved = read_file(&wiki_root.join(new_rel));
        assert!(
            moved.contains("](concepts/bar.md)"),
            "markdown self-link should be updated"
        );
        assert!(
            moved.contains("`concepts/bar.md`"),
            "backtick self-reference should be updated"
        );
        assert!(
            moved.contains("[Foo](concepts/bar.md)"),
            "relations self-link should be updated"
        );
        assert!(
            !moved.contains("concepts/foo.md"),
            "old path should not remain in moved page"
        );

        // Self-reference should be recorded in updated_refs.
        assert!(
            result.updated_refs.contains(&old_rel.to_string()),
            "self-reference page should be in updated_refs"
        );
    }

    // -------------------------------------------------------------------
    // Unknown page type → error instead of malformed section
    // -------------------------------------------------------------------

    #[test]
    fn test_unknown_page_type_errors() {
        let wiki_root = temp_dir("unknown_type");
        let old_rel = "concepts/foo.md";
        let new_rel = "other/foo.md";

        // Use type "unknown" which has no mapping in section_header_for_type.
        make_page(&wiki_root, old_rel, &fm_page("Foo", "unknown", "", "# Foo"));

        let result = execute_move(&wiki_root, old_rel, new_rel);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("未知的页面类型"),
            "error should mention unknown page type"
        );
        // The file was already renamed before the index update attempt,
        // so old_rel no longer exists and new_rel was created.
        assert!(!wiki_root.join(old_rel).exists());
        assert!(wiki_root.join(new_rel).exists());
        // The new index should NOT be created (no malformed section).
        let new_index = wiki_root.join("other/index.md");
        assert!(
            !new_index.exists(),
            "index should not be created for unknown type"
        );
    }

    // -------------------------------------------------------------------
    // No substring matching (no foo.md → foo-old.md false match)
    // -------------------------------------------------------------------

    #[test]
    fn test_no_substring_matching() {
        let wiki_root = temp_dir("no_substring");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Referencer that also links to foo-old.md (should not be affected).
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "See [Foo](concepts/foo.md) and [Foo Old](concepts/foo-old.md).\nAlso `concepts/foo.md` and `concepts/foo-old.md`.\n",
            ),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        // New references should be updated.
        assert!(ref_content.contains("](concepts/bar.md)"));
        assert!(ref_content.contains("`concepts/bar.md`"));

        // Old-like references should NOT be affected.
        assert!(
            ref_content.contains("foo-old.md"),
            "foo-old should remain unchanged"
        );
        assert!(
            ref_content.contains("concepts/foo-old.md"),
            "concepts/foo-old.md should remain unchanged"
        );
        // But the foo.md reference should be gone (replaced to bar.md).
        assert!(!ref_content.contains("](concepts/foo.md)"));
        assert!(!ref_content.contains("`concepts/foo.md`"));
    }

    // -------------------------------------------------------------------
    // Old doesn't exist in reverse index (page has no backlinks)
    // -------------------------------------------------------------------

    #[test]
    fn test_no_referencers() {
        let wiki_root = temp_dir("no_referencers");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert!(result.updated_refs.is_empty());
        assert!(wiki_root.join(new_rel).exists());
        assert!(!wiki_root.join(old_rel).exists());
    }

    // -------------------------------------------------------------------
    // Cross-domain — entry not in old index (not listed)
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_not_in_old_index() {
        let wiki_root = temp_dir("not_in_old_index");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        // Old domain index does NOT list foo.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Other](other.md)\n",
        );
        // New domain index exists.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Old index should be unchanged (no foo entry to remove).
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(old_index.contains("[Other](other.md)"));

        // New index should have the entry added.
        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(new_index.contains("[Foo](concepts/foo.md)"));
    }

    // -------------------------------------------------------------------
    // Index entry already exists (no duplicate)
    // -------------------------------------------------------------------

    #[test]
    fn test_add_entry_no_duplicate() {
        let wiki_root = temp_dir("no_dup");
        let old_rel = "other/foo.md";
        let new_rel = "shared/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "other/index.md",
            "# Other\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        // New index already has a foo entry.
        make_page(
            &wiki_root,
            "shared/index.md",
            "# Shared\n\n## Concepts（概念）\n\n* [Foo](concepts/foo.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Verify entry count in new index is still 1 (no duplicate).
        let new_index = read_file(&wiki_root.join("shared/index.md"));
        let count = new_index.matches("[Foo](concepts/foo.md)").count();
        assert_eq!(count, 1, "should not create duplicate entries");

        // Old index should have entry removed.
        let old_index = read_file(&wiki_root.join("other/index.md"));
        assert!(!old_index.contains("foo.md"));
    }

    // -------------------------------------------------------------------
    // Atomic write integrity check
    // -------------------------------------------------------------------

    #[test]
    fn test_atomic_write_preserves_content() {
        let wiki_root = temp_dir("atomic_write");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page("Ref", "concept", "", "See [Foo](concepts/foo.md).\n"),
        );

        execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Referencer should still be valid markdown with frontmatter.
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.starts_with("---"));
        assert!(ref_content.contains("title: Ref"));

        // Check the moved page is valid.
        let moved = read_file(&wiki_root.join(new_rel));
        assert!(moved.starts_with("---"));
        assert!(moved.contains("title: Foo"));
    }
}
