//! Bidirectional backlinks — reverse index and automatic section maintenance.
//!
//! Scans all wiki pages, extracts cross-references (frontmatter `relations`,
//! inline markdown links `[text](path.md)`, and backtick-wrapped paths
//! `` `path.md` ``), builds a reverse index, and optionally writes
//! `## Backlinks` sections into each page.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use regex::Regex;
use serde_json::Value;

use crate::wiki;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// System files excluded from backlink targets.
const SYSTEM_FILES: &[&str] =
    &["index.md", "overview.md", "SCHEMA.md", ".gitkeep"];

/// Excluded directory names for backlink targets.
const EXCLUDED_DIRS: &[&str] = &["templates", "tools", "raw", "logs"];

// ---------------------------------------------------------------------------
// 1. is_valid_wiki_target
// ---------------------------------------------------------------------------

/// Check whether `target` is a valid wiki-root-relative link target.
///
/// Must be a `.md` path that is not a system file, not under `templates/`,
/// `tools/`, or `raw/`, and points to a file that actually exists.
/// Paths containing `..` are rejected to prevent symlink traversal attacks.
///
/// For multi-team bundle wikis (`.teams/<name>/`, `.org/<name>/`,
/// `.upstream/<name>/`), `target` is a bundle-relative path, so the
/// function also searches inside bundle subdirectories for the file.
#[must_use]
pub fn is_valid_wiki_target(wiki_root: &Path, target: &str) -> bool {
    // Must end with .md
    if !std::path::Path::new(target)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return false;
    }

    // Must NOT contain ..
    if target.contains("..") {
        return false;
    }

    let p = Path::new(target);

    // Must NOT be a system file
    if let Some(name) = p.file_name().and_then(|n| n.to_str())
        && SYSTEM_FILES.contains(&name)
    {
        return false;
    }

    // Must NOT be in excluded directories
    for component in p.components() {
        if let Some(name) = component.as_os_str().to_str()
            && EXCLUDED_DIRS.contains(&name)
        {
            return false;
        }
    }

    // Target file must exist on disk — check direct path first, then
    // bundle subdirectories (.teams/, .org/, .upstream/).
    let full_path = wiki_root.join(target);
    full_path.exists() || target_exists_in_any_bundle(wiki_root, target)
}

/// Check if `target` exists inside any bundle subdirectory
/// (`.teams/<name>/`, `.org/<name>/`, `.upstream/<name>/`) under
/// `wiki_root`.
///
/// Links in the wiki are bundle-relative (e.g. `shared/concepts/foo.md`),
/// so they must be resolved against each installed bundle's root.
fn target_exists_in_any_bundle(wiki_root: &Path, target: &str) -> bool {
    for bundle_type in &[".teams", ".org", ".upstream"] {
        let bundle_root = wiki_root.join(bundle_type);
        if !bundle_root.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&bundle_root) {
            for entry in entries.flatten() {
                let candidate = entry.path().join(target);
                if candidate.exists() {
                    return true;
                }
            }
        }
    }
    false
}

/// Strip the bundle-layer prefix from a `page.rel` value.
///
/// Bundle-relative paths drop the `.teams/<name>/`, `.org/<name>/`, or
/// `.upstream/<name>/` prefix.  For example:
/// `.teams/core/shared/concepts/foo.md` → `shared/concepts/foo.md`.
///
/// Returns `None` when no bundle prefix is found (e.g. root-level files
/// like `index.md` or `personal/` paths).
fn strip_bundle_prefix(rel: &str) -> Option<&str> {
    for prefix in &[".teams/", ".org/", ".upstream/"] {
        if let Some(rest) = rel.strip_prefix(prefix) {
            // rest is "<bundle-name>/<path>"; strip the bundle-name too.
            if let Some((_, path)) = rest.split_once('/') {
                return Some(path);
            }
            // rest is empty (e.g. ".teams/") or has no '/' after
            // bundle-name — not a valid bundle-relative path.
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 2. strip_backlinks_section
// ---------------------------------------------------------------------------

/// Remove the `## Backlinks` section from `body`.
///
/// Links inside the `## Backlinks` section of a page are *incoming*
/// references (pages that link TO this page). They must not be treated as
/// *outgoing* references from this page, otherwise a feedback loop is
/// created where Backlinks generate new cross-references on each run.
#[must_use]
pub fn strip_backlinks_section(body: &str) -> String {
    if let Some((start, end)) = find_section_pos(body, "Backlinks") {
        let mut result = String::with_capacity(body.len() - (end - start));
        result.push_str(&body[..start]);
        result.push_str(&body[end..]);
        result
    } else {
        body.to_string()
    }
}

// ---------------------------------------------------------------------------
// 3. extract_links
// ---------------------------------------------------------------------------

/// Extract cross-reference link targets from `content`, checking existence
/// against `wiki_root`.
///
/// Sources (in order):
/// 1. Frontmatter `relations` field
///    1b. Frontmatter `supersedes`/`superseded_by`/`contradictions` fields
/// 2. Inline markdown links `[text](path.md)` in body text
///    (excluding the `## Backlinks` section)
/// 3. Backtick-wrapped paths `` `path.md` `` in body text
///    (excluding the `## Backlinks` section)
///
/// Returns a sorted, deduplicated list of wiki-root-relative `.md` paths
/// that pass [`is_valid_wiki_target`].
#[must_use]
pub fn extract_links(wiki_root: &Path, content: &str) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();

    let fm = wiki::parse_frontmatter(content);
    let body = wiki::strip_frontmatter(content);
    let clean_body = strip_backlinks_section(&body);

    // 1. Frontmatter relations field
    if let Some(Value::Array(related)) = fm.get("relations") {
        for val in related {
            if let Some(s) = val.as_str() {
                let bare = wiki::parse_related_entry(s);
                if std::path::Path::new(&bare)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                {
                    links.push(bare);
                }
            }
        }
    }

    // 1b. Frontmatter supersedes / superseded_by / contradictions fields
    for field in ["supersedes", "superseded_by", "contradictions"] {
        if let Some(Value::Array(items)) = fm.get(field) {
            for item in items {
                // Current parser stores block-list items as flat strings
                // like "path: <value>". Try object first for forward compat.
                let path = item.as_object().map_or_else(
                    || {
                        item.as_str()
                            .and_then(|s| s.strip_prefix("path: "))
                            .map(str::to_string)
                    },
                    |obj| {
                        obj.get("path")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    },
                );
                if let Some(p) = path
                    && std::path::Path::new(&p)
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                {
                    links.push(p);
                }
            }
        }
    }

    // 2. Inline markdown links [text](path.md) in body
    let md_re =
        Regex::new(r"\[([^\]]+)\]\(([^)]+\.md)\)").expect("valid regex");
    for cap in md_re.captures_iter(&clean_body) {
        let target = cap[2].trim();
        if !target.starts_with("http://")
            && !target.starts_with("https://")
            && !target.starts_with("mailto:")
        {
            links.push(target.to_string());
        }
    }

    // 3. Backtick-wrapped paths `path.md` in body
    let bt_re = Regex::new(r"`([^\s`]+\.md)`").expect("valid regex");
    for cap in bt_re.captures_iter(&clean_body) {
        let target = cap[1].trim();
        if !target.starts_with("http://") && !target.starts_with("https://") {
            links.push(target.to_string());
        }
    }

    // Deduplicate, filter, sort
    links.sort();
    links.dedup();
    links.into_iter().filter(|ln| is_valid_wiki_target(wiki_root, ln)).collect()
}

// ---------------------------------------------------------------------------
// 4. build_reverse_index
// ---------------------------------------------------------------------------

/// Build reverse-link index from parsed pages, using `wiki_root` for
/// existence validation.
///
/// Returns a map from each target page (wiki-root-relative path) to a
/// sorted, deduplicated list of source pages (wiki-root-relative paths)
/// that link to it.
///
/// For multi-team bundle wikis, links are bundle-relative while
/// page rels include a bundle prefix (`.teams/<name>/`).  This function
/// normalises the index keys to use the full `page.rel` form so that
/// [`update_backlinks`] can look them up directly.
#[must_use]
pub fn build_reverse_index(
    wiki_root: &Path,
    pages: &[wiki::Page],
) -> HashMap<String, Vec<String>> {
    // Build a map from bundle-relative path → all matching page.rel values.
    // e.g. "shared/concepts/foo.md" → [".teams/core/shared/concepts/foo.md", ...]
    // Multiple bundles may share the same bundle-relative path, so we use
    // a Vec to capture all matches.
    let mut rel_map: HashMap<String, Vec<String>> = HashMap::new();
    for p in pages {
        if let Some(br) = strip_bundle_prefix(&p.rel) {
            rel_map.entry(br.to_string()).or_default().push(p.rel.clone());
        }
    }

    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();

    for page in pages {
        let content = wiki::read_file(&page.path);
        if content.is_empty() {
            continue;
        }

        let targets = extract_links(wiki_root, &content);
        for target in targets {
            // Resolve bundle-relative target to the full page.rel(s).
            // Multiple bundles may share the same bundle-relative path,
            // so we add all matching page.rel values as reverse-index keys.
            if let Some(rels) = rel_map.get(&target) {
                for rel in rels {
                    reverse
                        .entry(rel.clone())
                        .or_default()
                        .push(page.rel.clone());
                }
            } else {
                reverse.entry(target).or_default().push(page.rel.clone());
            }
        }
    }

    // Sort source lists and deduplicate for deterministic output
    for sources in reverse.values_mut() {
        sources.sort();
        sources.dedup();
    }

    // Sort by key for deterministic iteration
    let mut sorted: Vec<(String, Vec<String>)> = reverse.into_iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted.into_iter().collect()
}

/// Build a reverse-index for a single target page.
///
/// Scans all `pages` for outbound links and returns only those that
/// reference `target`.  The returned map has at most one entry (the
/// target → sorted, deduplicated list of source `page.rel` values).
///
/// This is more efficient than [`build_reverse_index`] when only one
/// target is needed — still does full I/O (every page must be read),
/// but avoids constructing and sorting a global `HashMap`.
///
/// Bundle-relative paths (`.teams/<name>/...`) are resolved the same
/// way as `build_reverse_index`.
#[must_use]
pub fn build_backlinks_for(
    target: &str,
    wiki_root: &Path,
    pages: &[wiki::Page],
) -> HashMap<String, Vec<String>> {
    // Build rel_map for bundle-relative resolution.
    let mut rel_map: HashMap<String, Vec<String>> = HashMap::new();
    for p in pages {
        if let Some(br) = strip_bundle_prefix(&p.rel) {
            rel_map.entry(br.to_string()).or_default().push(p.rel.clone());
        }
    }

    let mut sources: Vec<String> = Vec::new();

    for page in pages {
        let content = wiki::read_file(&page.path);
        if content.is_empty() {
            continue;
        }

        let links = extract_links(wiki_root, &content);
        if links.iter().any(|ln| {
            // Direct match.
            if ln == target {
                return true;
            }
            // Bundle-relative resolution.
            if let Some(rels) = rel_map.get(ln) {
                return rels.iter().any(|r| r == target);
            }
            false
        }) {
            sources.push(page.rel.clone());
        }
    }

    sources.sort();
    sources.dedup();

    let mut result = HashMap::new();
    if !sources.is_empty() {
        result.insert(target.to_string(), sources);
    }
    result
}

// ---------------------------------------------------------------------------
// 5. format_backlinks_section
// ---------------------------------------------------------------------------

/// Format a `## Backlinks` section body for `_target_rel` with `sources`.
///
/// Page titles are resolved against `wiki_root`. The `_target_rel` parameter
/// identifies the page being updated (used for display context). The section
/// lists each source page with its title and a wiki-relative link.
///
/// Source paths are converted to bundle-relative form (stripping
/// `.teams/<name>/` prefixes) since wiki links use bundle-relative paths.
#[must_use]
pub fn format_backlinks_section(
    wiki_root: &Path,
    _target_rel: &str,
    sources: &[String],
) -> String {
    let mut lines = vec![String::from("## Backlinks"), String::new()];
    lines.push(String::from("> 此节由 zwiki 自动维护，请勿手动编辑。"));
    lines.push(String::new());
    for src in sources {
        let title = page_title_from_path(&wiki_root.join(src));
        // Use bundle-relative path for the link (strip .teams/<name>/ prefix).
        let link_target = strip_bundle_prefix(src).unwrap_or(src).to_string();
        lines.push(format!("- [{title}]({link_target})"));
    }
    lines.push(String::new());
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// 6. find_insertion_point
// ---------------------------------------------------------------------------

/// Find the best offset to insert a new `## Backlinks` section.
///
/// The byte offsets returned by `find_section_pos` are safe for string
/// slicing because `regex` guarantees UTF-8 boundary alignment in its
/// match positions — all captured offsets are always on valid char
/// boundaries.
///
/// Priority:
/// 1. After `## Details` section end
/// 2. Before `## References` section start
/// 3. (Legacy) After `## Relations` — kept as a fallback for pages not yet
///    migrated; `## Relations` sections have been removed wiki-wide.
///
/// Returns `None` if none of the anchors exist.
#[must_use]
pub fn find_insertion_point(content: &str) -> Option<usize> {
    // Priority 1: after ## Details
    if let Some((_, end)) = find_section_pos(content, "Details") {
        return Some(end);
    }

    // Priority 2: before ## References
    if let Some((start, _)) = find_section_pos(content, "References") {
        return Some(start);
    }

    // Legacy fallback: after ## Relations (removed wiki-wide; kept in case
    // a page was not migrated or is rolled back from history).
    if let Some((_, end)) = find_section_pos(content, "Relations") {
        return Some(end);
    }

    None
}

// ---------------------------------------------------------------------------
// 7. update_backlinks
// ---------------------------------------------------------------------------

/// Write `## Backlinks` sections into each wiki page.
///
/// For each page that has inbound links, adds or updates a `## Backlinks`
/// section. The section is placed after `## Details`, or before
/// `## References` (legacy `## Relations` fallback kept for unmigrated pages).
///
/// Pages with no inbound links that still carry a `## Backlinks` section
/// (e.g. from a previous run) will have it removed to keep pages clean.
///
/// Returns the number of pages that were modified.
pub fn update_backlinks(
    wiki_root: &Path,
    index: &HashMap<String, Vec<String>>,
    pages: &[wiki::Page],
) -> usize {
    let mut updated_count = 0;

    for page in pages {
        let sources: Vec<String> =
            index.get(&page.rel).cloned().unwrap_or_default();
        let has_backlinks = !sources.is_empty();

        let content = wiki::read_file(&page.path);
        if content.is_empty() {
            continue;
        }

        let existing = find_section_pos(&content, "Backlinks");
        let new_content: String;

        if has_backlinks {
            let backlinks_content =
                format_backlinks_section(wiki_root, &page.rel, &sources);

            if let Some((start, end)) = existing {
                // Replace existing backlinks section.  Add a trailing
                // newline to keep a blank line before the next section.
                new_content = format!(
                    "{}{}\n\n{}",
                    &content[..start],
                    backlinks_content.trim_end(),
                    &content[end..].trim_start()
                );
            } else {
                match find_insertion_point(&content) {
                    Some(ins_point) => {
                        // Insert new backlinks section, preserving
                        // blank line separation from adjacent sections.
                        new_content = format!(
                            "{}\n\n{}\n\n{}",
                            &content[..ins_point].trim_end(),
                            backlinks_content.trim(),
                            &content[ins_point..].trim_start()
                        );
                    }
                    None => continue,
                }
            }
        } else if let Some((start, end)) = existing {
            // No inbound links — remove stale Backlinks section
            let pre = &content[..start];
            let post = &content[end..];

            // Clean up surrounding blank lines, then insert exactly one
            // blank line to keep the separation before the next section
            // (e.g. `## References`).
            let pre = pre.trim_end_matches('\n');
            let post = post
                .strip_prefix("\n\n")
                .or_else(|| post.strip_prefix('\n'))
                .unwrap_or(post);

            new_content = format!("{pre}\n\n{post}");
        } else {
            continue;
        }

        if new_content != content {
            // Atomic write: temp file → rename (use PID suffix to avoid races)
            let temp_path =
                page.path.with_extension(format!("tmp-{}", std::process::id()));
            if fs::write(&temp_path, &new_content).is_ok()
                && fs::rename(&temp_path, &page.path).is_ok()
            {
                updated_count += 1;
            } else {
                let _ = fs::remove_file(&temp_path);
            }
        }
    }

    updated_count
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Find a `## <heading>` section in `content`.
///
/// Returns `(start_offset, end_offset)` where `start` is the offset of the
/// `## <heading>` line and `end` is the offset of the next `## ` heading
/// (or end of content).
fn find_section_pos(content: &str, heading: &str) -> Option<(usize, usize)> {
    let escaped = regex::escape(heading);
    // Use [ \t]*$ instead of \s*$ to avoid consuming newlines.
    let pattern = format!(r"(?m)^## {escaped}[ \t]*$");
    let re = Regex::new(&pattern).ok()?;
    let m = re.find(content)?;
    let start = m.start();
    let after_end = m.end();
    let rest = &content[after_end..];
    let next_re = Regex::new(r"(?m)^## ").ok()?;
    let end = next_re
        .find(rest)
        .map_or(content.len(), |next_m| after_end + next_m.start());
    Some((start, end))
}

/// Get page title from a wiki page file.
///
/// Returns the `title` field from frontmatter if present, otherwise
/// title-cases the filename stem.
fn page_title_from_path(page_path: &Path) -> String {
    let content = wiki::read_file(page_path);
    if !content.is_empty() {
        let fm = wiki::parse_frontmatter(&content);
        if let Some(Value::String(title)) = fm.get("title") {
            return title.clone();
        }
    }
    // Fallback: filename stem title-cased
    page_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(title_case)
        .unwrap_or_default()
}

/// Get page title from a wiki-root-relative path.
///
/// Returns the `title` field from frontmatter if present, otherwise
/// title-cases the filename stem.
#[must_use]
pub fn page_title_from_rel(rel_path: &str, root: &Path) -> String {
    page_title_from_path(&root.join(rel_path))
}

/// Title-case a string: `"hello-world"` → `"Hello World"`.
fn title_case(s: &str) -> String {
    s.replace('-', " ")
        .split(' ')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().to_string() + chars.as_str()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
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
        let dir = std::env::temp_dir()
            .join("zwiki-test")
            .join("backlinks")
            .join(name);
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

    /// Create a `Page` struct from a file path inside a wiki root.
    fn make_page(wiki_root: &Path, rel: &str, content: &str) -> wiki::Page {
        let path = write(&wiki_root.join(rel), content);
        let rel_str = rel.to_string();
        let frontmatter = wiki::parse_frontmatter(content);
        let body = wiki::strip_frontmatter(content);
        wiki::Page {
            path,
            rel: rel_str,
            frontmatter,
            body,
            raw: content.to_string(),
        }
    }

    // -------------------------------------------------------------------
    // 1. is_valid_wiki_target
    // -------------------------------------------------------------------

    #[test]
    fn test_is_valid_wiki_target_valid_md() {
        let dir = temp_dir("valid_md");
        write(&dir.join("test.md"), "# Test");
        assert!(is_valid_wiki_target(&dir, "test.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_non_md() {
        let dir = temp_dir("non_md");
        write(&dir.join("test.txt"), "test");
        assert!(!is_valid_wiki_target(&dir, "test.txt"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_dotdot() {
        let dir = temp_dir("dotdot");
        assert!(!is_valid_wiki_target(&dir, "../etc/passwd.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_system_file() {
        let dir = temp_dir("system_file");
        for sys_file in SYSTEM_FILES {
            write(&dir.join(sys_file), "# Meta");
            assert!(
                !is_valid_wiki_target(&dir, sys_file),
                "expected {sys_file} to be rejected"
            );
        }
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_template_dir() {
        let dir = temp_dir("template_dir");
        write(&dir.join("templates").join("page.md"), "# Tpl");
        assert!(!is_valid_wiki_target(&dir, "templates/page.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_tools_dir() {
        let dir = temp_dir("tools_dir");
        write(&dir.join("tools").join("helper.md"), "# Helper");
        assert!(!is_valid_wiki_target(&dir, "tools/helper.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_raw_dir() {
        let dir = temp_dir("raw_dir");
        write(&dir.join("raw").join("notes.md"), "# Notes");
        assert!(!is_valid_wiki_target(&dir, "raw/notes.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_logs_dir() {
        let dir = temp_dir("logs_dir");
        write(&dir.join("logs").join("2026-07.md"), "# Log");
        assert!(!is_valid_wiki_target(&dir, "logs/2026-07.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_nonexistent_rejected() {
        let dir = temp_dir("nonexistent");
        assert!(!is_valid_wiki_target(&dir, "no-such-file.md"));
    }

    // -------------------------------------------------------------------
    // 2. strip_backlinks_section
    // -------------------------------------------------------------------

    #[test]
    fn test_strip_backlinks_section_removes_section() {
        let body =
            "Some text.\n\n## Backlinks\n\n- [Foo](foo.md)\n\nOther text.";
        let result = strip_backlinks_section(body);
        // Section extends to EOF since there is no next ## heading.
        assert_eq!(result, "Some text.\n\n");
    }

    #[test]
    fn test_strip_backlinks_section_removes_till_next_heading() {
        let body =
            "Before.\n\n## Backlinks\n\n- [Foo](foo.md)\n\n## Next\n\nAfter.";
        let result = strip_backlinks_section(body);
        // Section removed completely (blank line before ## Next is part of the section).
        assert_eq!(result, "Before.\n\n## Next\n\nAfter.");
    }

    #[test]
    fn test_strip_backlinks_section_no_section() {
        let body = "Just text.";
        assert_eq!(strip_backlinks_section(body), "Just text.");
    }

    #[test]
    fn test_strip_backlinks_section_empty() {
        assert_eq!(strip_backlinks_section(""), "");
    }

    #[test]
    fn test_strip_backlinks_section_at_end() {
        let body = "Body here.\n\n## Backlinks\n\n- [A](a.md)";
        assert_eq!(strip_backlinks_section(body), "Body here.\n\n");
    }

    // -------------------------------------------------------------------
    // 3. extract_links
    // -------------------------------------------------------------------

    #[test]
    fn test_extract_links_from_related_frontmatter() {
        let content =
            "---\ntitle: Test\nrelations: [foo.md, bar.md]\n---\n\nBody.";
        let dir = temp_dir("extract_related");
        write(&dir.join("foo.md"), "# Foo");
        write(&dir.join("bar.md"), "# Bar");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_extract_links_from_markdown_links() {
        let content = "See [Foo](foo.md) and [Bar](bar.md).";
        let dir = temp_dir("extract_mdlinks");
        write(&dir.join("foo.md"), "# Foo");
        write(&dir.join("bar.md"), "# Bar");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_extract_links_from_backtick() {
        let content = "Relations: `foo.md`, `bar.md`";
        let dir = temp_dir("extract_backtick");
        write(&dir.join("foo.md"), "# Foo");
        write(&dir.join("bar.md"), "# Bar");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_extract_links_excludes_backlinks_section() {
        let content =
            "Intro.\n\n## Backlinks\n\n- [Foo](foo.md)\n- `bar.md`\n\nOutro.";
        let dir = temp_dir("extract_excludes_bl");
        write(&dir.join("foo.md"), "# Foo");
        write(&dir.join("bar.md"), "# Bar");
        let result = extract_links(&dir, content);
        // Only 'Intro.' text — no links in backlinks section should be extracted.
        // Also 'Outro.' has no links.
        let empty: Vec<String> = vec![];
        assert_eq!(result, empty);
    }

    #[test]
    fn test_extract_links_excludes_http() {
        let content = "See [Example](https://example.com).";
        let dir = temp_dir("extract_http");
        // No files exist, so even if links were extracted they'd be filtered out.
        let result = extract_links(&dir, content);
        let empty: Vec<String> = vec![];
        assert_eq!(result, empty);
    }

    #[test]
    fn test_extract_links_deduplicates() {
        let content =
            "---\nrelations: [foo.md]\n---\n\nSee [Foo](foo.md) and `foo.md`.";
        let dir = temp_dir("extract_dedup");
        write(&dir.join("foo.md"), "# Foo");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["foo.md"]);
    }

    #[test]
    fn test_extract_links_sorted() {
        let content = "See [Zed](z.md), [Alpha](a.md).";
        let dir = temp_dir("extract_sorted");
        write(&dir.join("a.md"), "# A");
        write(&dir.join("z.md"), "# Z");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["a.md", "z.md"]);
    }

    // -------------------------------------------------------------------
    // 3b. extract_links from supersedes / superseded_by / contradictions
    // -------------------------------------------------------------------

    #[test]
    fn test_extract_links_from_supersedes_fields() {
        let content = "\
---\n\
supersedes:\n\
  - path: old.md\n\
    reason: replaced by newer\n\
superseded_by:\n\
  - path: newer.md\n\
    reason: successor\n\
contradictions:\n\
  - path: other.md\n\
    claims:\n\
      - something\n\
    detected: 2026-07-01\n\
    resolution: unresolved\n\
---\n\n\
Body.";
        let dir = temp_dir("extract_supersedes");
        write(&dir.join("old.md"), "# Old");
        write(&dir.join("newer.md"), "# Newer");
        write(&dir.join("other.md"), "# Other");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["newer.md", "old.md", "other.md"]);
    }

    #[test]
    fn test_extract_links_from_supersedes_missing_target_filtered() {
        // Use inline-list syntax to test filtering of nonexistent targets.
        // The parser stores each `path: <value>` string as-is.
        let content = "---\nsupersedes: [path: existing.md, path: missing.md]\n---\n\nBody.";
        let dir = temp_dir("extract_supersedes_filtered");
        write(&dir.join("existing.md"), "# Existing");
        let result = extract_links(&dir, content);
        assert_eq!(result, vec!["existing.md"]);
    }

    #[test]
    fn test_extract_links_from_supersedes_empty() {
        let content = "---\nsupersedes: []\nsuperseded_by: []\ncontradictions: []\n---\n\nBody.";
        let dir = temp_dir("extract_supersedes_empty");
        write(&dir.join("dummy.md"), "# Dummy");
        let result = extract_links(&dir, content);
        let empty: Vec<String> = vec![];
        assert_eq!(result, empty);
    }

    // -------------------------------------------------------------------
    // 4. build_reverse_index
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_simple() {
        let dir = temp_dir("rev_simple");
        let pages = vec![
            make_page(
                &dir,
                "concepts/a.md",
                "---\nrelations: [b.md]\n---\n\n# A\n\nSee [B](b.md).",
            ),
            make_page(&dir, "concepts/b.md", "# B\n\nNo links."),
        ];
        write(&dir.join("b.md"), "# B"); // b.md at root for target validation
        let index = build_reverse_index(&dir, &pages);
        assert_eq!(index.len(), 1);
        assert!(index.contains_key("b.md"));
        let sources = &index["b.md"];
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0], "concepts/a.md");
    }

    #[test]
    fn test_build_reverse_index_no_links() {
        let dir = temp_dir("rev_no_links");
        let pages = vec![
            make_page(&dir, "a.md", "# A"),
            make_page(&dir, "b.md", "# B"),
        ];
        let index = build_reverse_index(&dir, &pages);
        assert!(index.is_empty());
    }

    #[test]
    fn test_build_reverse_index_self_links_ignored() {
        let dir = temp_dir("rev_self");
        write(&dir.join("a.md"), "# A");
        let a_content = "See [A](a.md).";
        let pages = vec![make_page(&dir, "a.md", a_content)];
        let index = build_reverse_index(&dir, &pages);
        // Self-links are still valid — a.md links to itself
        assert_eq!(index.len(), 1);
        assert!(index.contains_key("a.md"));
    }

    #[test]
    fn test_build_reverse_index_bidirectional() {
        let dir = temp_dir("rev_bi");
        write(&dir.join("a.md"), "# A");
        write(&dir.join("b.md"), "# B");
        let pages = vec![
            make_page(&dir, "a.md", "See [B](b.md)."),
            make_page(&dir, "b.md", "See [A](a.md)."),
        ];
        let index = build_reverse_index(&dir, &pages);
        assert_eq!(index.len(), 2);
        assert!(index.contains_key("a.md"));
        assert!(index.contains_key("b.md"));
        assert_eq!(index["a.md"], vec!["b.md"]);
        assert_eq!(index["b.md"], vec!["a.md"]);
    }

    // -------------------------------------------------------------------
    // 5. format_backlinks_section
    // -------------------------------------------------------------------

    #[test]
    fn test_format_backlinks_section_basic() {
        let dir = temp_dir("fmt_basic");
        write(&dir.join("src.md"), "---\ntitle: Source Page\n---\n\nBody.");
        let sources = vec![String::from("src.md")];
        let result = format_backlinks_section(&dir, "target.md", &sources);
        assert!(result.starts_with("## Backlinks"));
        assert!(result.contains("> 此节由 zwiki 自动维护，请勿手动编辑。"));
        assert!(result.contains("Source Page"));
        assert!(result.contains("(src.md)"));
    }

    #[test]
    fn test_format_backlinks_section_multiple_sources() {
        let dir = temp_dir("fmt_multiple");
        write(&dir.join("a.md"), "---\ntitle: Page A\n---\n\nBody.");
        write(&dir.join("b.md"), "---\ntitle: Page B\n---\n\nBody.");
        let sources = vec![String::from("a.md"), String::from("b.md")];
        let result = format_backlinks_section(&dir, "target.md", &sources);
        assert!(result.contains("Page A"));
        assert!(result.contains("Page B"));
        assert!(result.contains("(a.md)"));
        assert!(result.contains("(b.md)"));
    }

    // -------------------------------------------------------------------
    // 6. find_insertion_point
    // -------------------------------------------------------------------

    #[test]
    fn test_find_insertion_point_after_relations() {
        let content =
            "# Title\n\n## Relations\n\n- `foo.md`\n\n## Details\n\nStuff.";
        let point = find_insertion_point(content);
        assert!(point.is_some());
        // Point should be after ## Relations section end
        let pos = point.unwrap();
        assert!(pos > content.find("## Relations").unwrap());
        assert!(pos <= content.len());
    }

    #[test]
    fn test_find_insertion_point_after_details() {
        let content =
            "# Title\n\n## Details\n\nStuff.\n\n## References\n\n- bar.md";
        let point = find_insertion_point(content);
        assert!(point.is_some());
        let pos = point.unwrap();
        assert!(pos > content.find("## Details").unwrap());
        assert!(pos <= content.find("## References").unwrap_or(content.len()));
    }

    #[test]
    fn test_find_insertion_point_before_references() {
        let content = "# Title\n\n## References\n\n- bar.md";
        let point = find_insertion_point(content);
        assert!(point.is_some());
        let pos = point.unwrap();
        assert_eq!(pos, content.find("## References").unwrap());
    }

    #[test]
    fn test_find_insertion_point_no_anchor() {
        let content = "# Title\n\nJust text.";
        assert!(find_insertion_point(content).is_none());
    }

    // -------------------------------------------------------------------
    // 7. update_backlinks
    // -------------------------------------------------------------------

    #[test]
    fn test_update_backlinks_adds_new_section() {
        let dir = temp_dir("update_add");
        let page = make_page(
            &dir,
            "target.md",
            "---\ntitle: Target\n---\n\n# Target\n\n## Relations\n\n- `foo.md`\n\nBody.",
        );
        write(&dir.join("foo.md"), "# Foo");
        let pages = vec![page];
        let mut index = HashMap::new();
        index.insert("target.md".to_string(), vec!["foo.md".to_string()]);
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 1);

        let content = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(content.contains("## Backlinks"));
        assert!(content.contains("> 此节由 zwiki 自动维护，请勿手动编辑。"));
        assert!(content.contains("Foo"));
    }

    #[test]
    fn test_update_backlinks_updates_existing_section() {
        let dir = temp_dir("update_existing");
        let page = make_page(
            &dir,
            "target.md",
            "---\ntitle: Target\n---\n\n# Target\n\n## Relations\n\n- `foo.md`\n\n\
             ## Backlinks\n\n- [Old](old.md)\n\nBody.",
        );
        write(&dir.join("foo.md"), "# Foo");
        write(&dir.join("new.md"), "---\ntitle: New Source\n---\n\nBody.");
        let pages = vec![page];
        let mut index = HashMap::new();
        index.insert(
            "target.md".to_string(),
            vec!["foo.md".to_string(), "new.md".to_string()],
        );
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 1);

        let content = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(content.contains("New Source"));
        assert!(!content.contains("Old"));
    }

    #[test]
    fn test_update_backlinks_removes_stale_section() {
        let dir = temp_dir("update_remove");
        let page = make_page(
            &dir,
            "target.md",
            "---\ntitle: Target\n---\n\n# Target\n\n## Backlinks\n\n- [Old](old.md)\n\nBody.",
        );
        let pages = vec![page];
        let index: HashMap<String, Vec<String>> = HashMap::new();
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 1);

        let content = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(!content.contains("## Backlinks"));
    }

    #[test]
    fn test_update_backlinks_no_inbound_no_section_noop() {
        let dir = temp_dir("update_noop");
        let page = make_page(&dir, "target.md", "# Target\n\nBody.");
        let pages = vec![page];
        let index: HashMap<String, Vec<String>> = HashMap::new();
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 0);
    }

    // -------------------------------------------------------------------
    // 9. Bundle path resolution
    // -------------------------------------------------------------------

    #[test]
    fn test_is_valid_wiki_target_finds_bundle_file() {
        // Simulate a bundle structure: wiki_root/.teams/core/shared/concepts/foo.md
        let dir = temp_dir("bundle_valid");
        let bundle_page = dir
            .join(".teams")
            .join("core")
            .join("shared")
            .join("concepts")
            .join("foo.md");
        write(&bundle_page, "# Foo");
        // Target is bundle-relative: "shared/concepts/foo.md"
        assert!(is_valid_wiki_target(&dir, "shared/concepts/foo.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_finds_bundle_in_org() {
        let dir = temp_dir("bundle_org");
        let bundle_page =
            dir.join(".org").join("myorg").join("shared").join("bar.md");
        write(&bundle_page, "# Bar");
        assert!(is_valid_wiki_target(&dir, "shared/bar.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_finds_bundle_in_upstream() {
        let dir = temp_dir("bundle_upstream");
        let bundle_page =
            dir.join(".upstream").join("up").join("docs").join("baz.md");
        write(&bundle_page, "# Baz");
        assert!(is_valid_wiki_target(&dir, "docs/baz.md"));
    }

    #[test]
    fn test_is_valid_wiki_target_bundle_nonexistent_rejected() {
        let dir = temp_dir("bundle_nonexistent");
        // No files at all
        assert!(!is_valid_wiki_target(&dir, "shared/concepts/nonexistent.md"));
    }

    // -------------------------------------------------------------------
    // 10. build_reverse_index with bundle structure
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_bundle_structure() {
        let dir = temp_dir("rev_bundle");
        // Create pages inside .teams/core/ bundle
        let page_a = make_page(
            &dir,
            ".teams/core/shared/concepts/a.md",
            "---\ntitle: Page A\n---\n# A\n\nSee [B](shared/concepts/b.md).",
        );
        let page_b = make_page(
            &dir,
            ".teams/core/shared/concepts/b.md",
            "# B\n\nNo links.",
        );
        // Also create a non-bundle root page
        write(&dir.join("shared").join("concepts").join("b.md"), "# B");
        let pages = vec![page_a, page_b];
        let index = build_reverse_index(&dir, &pages);
        // Key should be the full page.rel, not bundle-relative
        assert_eq!(
            index.len(),
            1,
            "reverse index should have 1 entry (page b has 1 backlink from a)"
        );
        let key = ".teams/core/shared/concepts/b.md";
        assert!(
            index.contains_key(key),
            "reverse index key should be full page.rel '{key}', got keys: {:?}",
            index.keys().collect::<Vec<_>>(),
        );
        let sources = &index[key];
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0], ".teams/core/shared/concepts/a.md");
    }

    // -------------------------------------------------------------------
    // 11. update_backlinks — newline handling
    // -------------------------------------------------------------------

    #[test]
    fn test_update_backlinks_remove_stale_preserves_references_newline() {
        let dir = temp_dir("update_newline");
        let page = make_page(
            &dir,
            "target.md",
            "---\ntitle: Target\n---\n\
             # Target\n\n\
             ## Details\n\nContent here.\n\n\
             ## Backlinks\n\n- [Old](old.md)\n\n\
             ## References\n\n- bar.md",
        );
        let pages = vec![page];
        let index: HashMap<String, Vec<String>> = HashMap::new();
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 1);

        let content = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(!content.contains("## Backlinks"));
        // The blank line before ## References must be preserved
        assert!(
            content.contains("\n\n## References"),
            "Expected blank line before ## References, got content: {content:?}",
        );
    }

    // -------------------------------------------------------------------
    // 12. strip_bundle_prefix edge cases
    // -------------------------------------------------------------------

    #[test]
    fn test_strip_bundle_prefix_empty_team_name() {
        // ".teams/" has no team name — should return None
        assert_eq!(strip_bundle_prefix(".teams/"), None);
        assert_eq!(strip_bundle_prefix(".org/"), None);
        assert_eq!(strip_bundle_prefix(".upstream/"), None);
    }

    #[test]
    fn test_strip_bundle_prefix_normal() {
        assert_eq!(
            strip_bundle_prefix(".teams/core/shared/concepts/foo.md"),
            Some("shared/concepts/foo.md")
        );
        assert_eq!(
            strip_bundle_prefix(".org/myorg/docs/bar.md"),
            Some("docs/bar.md")
        );
        assert_eq!(
            strip_bundle_prefix(".upstream/up/docs/baz.md"),
            Some("docs/baz.md")
        );
    }

    #[test]
    fn test_strip_bundle_prefix_no_prefix() {
        assert_eq!(strip_bundle_prefix("index.md"), None);
        assert_eq!(strip_bundle_prefix("personal/notes.md"), None);
    }

    // -------------------------------------------------------------------
    // 13. build_reverse_index — multi-bundle collision
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_multi_bundle_collision() {
        // Two bundles with the same bundle-relative path:
        //   .teams/core/shared/concepts/target.md
        //   .teams/other/shared/concepts/target.md
        // Both target.md pages are included in `pages`, so their
        // bundle-relative paths are in rel_map.
        // A page linking to "shared/concepts/target.md" should produce
        // backlinks for BOTH full page.rel values.
        let dir = temp_dir("rev_multi_bundle");
        // Two target pages sharing the same bundle-relative path
        let target_core = make_page(
            &dir,
            ".teams/core/shared/concepts/target.md",
            "# Target Core\n\nNo links.",
        );
        let target_other = make_page(
            &dir,
            ".teams/other/shared/concepts/target.md",
            "# Target Other\n\nNo links.",
        );
        // A linking page that references the shared path
        let link_source = make_page(
            &dir,
            ".teams/core/docs/link_source.md",
            "---\ntitle: Link Source\nrelations: [shared/concepts/target.md]\n---\n\n# Link Source\n\nLinks to [target](shared/concepts/target.md).",
        );
        let pages = vec![target_core, target_other, link_source];
        let index = build_reverse_index(&dir, &pages);

        // Both bundle-specific targets should have a backlink from link_source
        let key_core = ".teams/core/shared/concepts/target.md";
        let key_other = ".teams/other/shared/concepts/target.md";

        assert!(
            index.contains_key(key_core),
            "expected key '{key_core}' in reverse index, got keys: {:?}",
            index.keys().collect::<Vec<_>>(),
        );
        assert!(
            index.contains_key(key_other),
            "expected key '{key_other}' in reverse index, got keys: {:?}",
            index.keys().collect::<Vec<_>>(),
        );

        let source_rel = ".teams/core/docs/link_source.md";
        assert!(
            index[key_core].contains(&source_rel.to_string()),
            "expected {key_core} backlinks to include {source_rel}, got: {:?}",
            index[key_core],
        );
        assert!(
            index[key_other].contains(&source_rel.to_string()),
            "expected {key_other} backlinks to include {source_rel}, got: {:?}",
            index[key_other],
        );

        // Also verify neither target backlinks to itself
        assert_eq!(
            index[key_core].len(),
            1,
            "target_core should have 1 backlink"
        );
        assert_eq!(
            index[key_other].len(),
            1,
            "target_other should have 1 backlink"
        );
    }

    // -------------------------------------------------------------------
    // 14. update_backlinks — single newline edge case
    // -------------------------------------------------------------------

    #[test]
    fn test_update_backlinks_remove_single_newline_pre() {
        // When the content before ## Backlinks ends with a single \n
        // (no blank line separator), the removal should still produce
        // exactly 2 \n (1 blank line) before the next section — not 3 \n.
        let dir = temp_dir("update_single_nl");
        let page = make_page(
            &dir,
            "target.md",
            "---\ntitle: Target\n---\n\
             # Target\n\n\
             ## Details\n\nContent here.\n\
             ## Backlinks\n\n- [Old](old.md)\n\n\
             ## References\n\n- bar.md",
        );
        let pages = vec![page];
        let index: HashMap<String, Vec<String>> = HashMap::new();
        let updated = update_backlinks(&dir, &index, &pages);
        assert_eq!(updated, 1);

        let content = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(!content.contains("## Backlinks"));
        // There should be exactly one blank line before ## References
        // Content before Backlinks: "# Target\n\n## Details\n\nContent here.\n"
        // After removal + trim: "# Target\n\n## Details\n\nContent here.\n\n## References\n\n- bar.md"
        // That means 2 \n between "Content here." and "## References"
        assert!(
            content.contains("\n\n## References"),
            "Expected single blank line before ## References, got content: {content:?}",
        );
        // Verify there are NOT 3 \n before ## References
        assert!(
            !content.contains("\n\n\n## References"),
            "Expected NO double blank line before ## References, got content: {content:?}",
        );
    }

    // -------------------------------------------------------------------
    // title_case
    // -------------------------------------------------------------------

    #[test]
    fn test_title_case_basic() {
        assert_eq!(title_case("hello-world"), "Hello World");
    }

    #[test]
    fn test_title_case_single_word() {
        assert_eq!(title_case("hello"), "Hello");
    }

    #[test]
    fn test_title_case_already_spaced() {
        assert_eq!(title_case("hello world"), "Hello World");
    }

    #[test]
    fn test_title_case_empty() {
        assert_eq!(title_case(""), "");
    }

    // -------------------------------------------------------------------
    // build_backlinks_for — equivalence with build_reverse_index + filter
    // -------------------------------------------------------------------

    fn setup_backlinks_pages(dir: &Path) -> Vec<PathBuf> {
        // Page A links to target.md via relations + inline link.
        write(
            &dir.join("page_a.md"),
            "---
title: Page A
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
relations: [target.md]
---

# Page A

See also [Target](target.md) for details.",
        );
        // Page B links to target.md via backtick.
        write(
            &dir.join("page_b.md"),
            "---
title: Page B
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
---

# Page B

Refer to `target.md` for the canonical definition.",
        );
        // Page C links to other.md (not target).
        write(
            &dir.join("page_c.md"),
            "---
title: Page C
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
relations: [other.md]
---

# Page C

See [Other](other.md).",
        );
        // target.md itself.
        write(
            &dir.join("target.md"),
            "---
title: Target
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
---

# Target

Body.",
        );
        // other.md — referenced but no one links to target.
        write(
            &dir.join("other.md"),
            "---
title: Other
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
---

# Other

Body.",
        );

        vec![
            dir.join("page_a.md"),
            dir.join("page_b.md"),
            dir.join("page_c.md"),
            dir.join("target.md"),
            dir.join("other.md"),
        ]
    }

    #[test]
    fn test_build_backlinks_for_matches_full_index() {
        let dir = temp_dir("backlinks_for");
        setup_backlinks_pages(&dir);
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> =
            paths.iter().filter_map(|p| wiki::read_page_at(p, &dir)).collect();

        // Full reverse index.
        let full = build_reverse_index(&dir, &pages);

        // Filtered: target.md
        let filtered = {
            let mut m = HashMap::new();
            if let Some(srcs) = full.get("target.md") {
                m.insert("target.md".to_string(), srcs.clone());
            }
            m
        };

        // Single-target function.
        let single = build_backlinks_for("target.md", &dir, &pages);

        assert_eq!(
            filtered, single,
            "build_backlinks_for should match filtered full index"
        );

        // Verify page C and other.md do NOT appear.
        let sources = single.get("target.md");
        assert!(sources.is_some(), "target.md should have sources");
        let srcs = sources.unwrap();
        assert!(srcs.contains(&"page_a.md".to_string()));
        assert!(srcs.contains(&"page_b.md".to_string()));
        assert!(!srcs.contains(&"page_c.md".to_string()));
        assert!(!srcs.contains(&"other.md".to_string()));
    }

    fn discover_pages_backlinks(base: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = walkdir::WalkDir::new(base)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
            })
            .map(|e| e.path().to_path_buf())
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn test_build_backlinks_for_nonexistent_target() {
        let dir = temp_dir("backlinks_for_nonexist");
        setup_backlinks_pages(&dir);
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> =
            paths.iter().filter_map(|p| wiki::read_page_at(p, &dir)).collect();

        let result = build_backlinks_for("nonexistent.md", &dir, &pages);
        assert!(
            result.is_empty(),
            "nonexistent target should have no backlinks"
        );
    }

    #[test]
    fn test_build_backlinks_for_no_references() {
        let dir = temp_dir("backlinks_for_noref");
        // Only page A which links to target.md, but query other.md.
        write(
            &dir.join("page_a.md"),
            "---
title: Page A
type: concept
relations: [target.md]
---",
        );
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> =
            paths.iter().filter_map(|p| wiki::read_page_at(p, &dir)).collect();

        let result = build_backlinks_for("other.md", &dir, &pages);
        assert!(result.is_empty(), "other.md has no references");
    }
}
