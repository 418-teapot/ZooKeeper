//! Core wiki library — path resolution, page discovery, frontmatter parsing.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Meta / system filenames excluded from wiki page listings.
///
/// `overview.md` is intentionally NOT listed here — it is a real
/// synthesis page and must participate in health checks (relations-field
/// consistency, inline-link coverage, etc.).
const META_FILES: &[&str] = &[
    "index.md",
    "log.md",
    "lint-report.md",
    "health-report.md",
    "SCHEMA.md",
    ".gitkeep",
];

/// Directory names excluded from page discovery.
const EXCLUDED_DIRS: &[&str] = &["templates", "tools", "raw"];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Wiki root directory: `~/.zoo/wiki/`
#[must_use]
pub fn wiki_dir() -> PathBuf {
    let home = zutil::expand_tilde("~");
    PathBuf::from(home).join(".zoo").join("wiki")
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/// Read a file and return its contents as a UTF-8 string.
///
/// Returns `""` if the file does not exist or cannot be read.
#[must_use]
pub fn read_file(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

/// Find all `*.md` files under `base`, excluding meta / system
/// files and directories named `templates/`, `tools/`, `raw/`.
pub fn discover_pages(base: &Path) -> Vec<PathBuf> {
    let mut pages: Vec<PathBuf> = WalkDir::new(base)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
        })
        .filter(|e| {
            let filename =
                e.path().file_name().and_then(|n| n.to_str()).unwrap_or("");
            if META_FILES.contains(&filename) {
                return false;
            }
            if let Ok(rel) = e.path().strip_prefix(base) {
                for component in rel.components() {
                    let name = component.as_os_str().to_str().unwrap_or("");
                    if EXCLUDED_DIRS.contains(&name) {
                        return false;
                    }
                }
            }
            true
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    pages.sort();
    pages
}

/// Return all markdown files under `WIKI_DIR`, excluding meta / system files.
///
/// The following are excluded:
///
/// * Meta files: `index.md`, `log.md`, `lint-report.md`,
///   `health-report.md`, `overview.md`, `SCHEMA.md`, `.gitkeep`.
/// * Files under the `templates/`, `tools/`, and `raw/` directories.
#[must_use]
pub fn all_wiki_pages() -> Vec<PathBuf> {
    discover_pages(&wiki_dir())
}

// ---------------------------------------------------------------------------
// Frontmatter utilities
// ---------------------------------------------------------------------------

/// Remove YAML frontmatter (`---` … `---`) from `content`.
#[must_use]
pub fn strip_frontmatter(content: &str) -> String {
    if let Some(rest) = content.strip_prefix("---")
        && let Some(end) = rest.find("---")
    {
        return rest[end + 3..].trim().to_string();
    }
    content.trim().to_string()
}

/// Lazily-compiled regex matching a YAML frontmatter delimiter line.
fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^---\s*$").unwrap())
}

/// Minimal YAML frontmatter parser.
///
/// Handles `key: value` pairs and YAML list syntax (both inline `[a, b]`
/// and block `- a\n- b`).  Returns a map with `Value::String` / `Value::Array`
/// values.
///
/// NOT use `serde_yaml` because pages have arbitrary field order and comments.
#[must_use]
pub fn parse_frontmatter(content: &str) -> HashMap<String, Value> {
    let mut fm: HashMap<String, Value> = HashMap::new();

    // Opening delimiter must be at the very start of the content.
    let Some(opening) = frontmatter_re().find(content) else {
        return fm;
    };
    if opening.start() != 0 {
        return fm;
    }
    let after_opening = opening.end();
    let rest = &content[after_opening..];

    // Find closing delimiter.
    let Some(closing) = frontmatter_re().find(rest) else {
        return fm;
    };

    let raw = rest[..closing.start()].trim();
    if raw.is_empty() {
        return fm;
    }

    let mut current_key: Option<String> = None;
    let mut list_accum: Vec<String> = Vec::new();

    for line in raw.lines() {
        let stripped = line.trim();

        // Block list item: `- value`
        if let Some(val) = stripped.strip_prefix("- ")
            && current_key.is_some()
        {
            list_accum.push(val.trim().to_string());
            continue;
        }

        // Flush accumulated block list before handling the next line.
        if let Some(ref key) = current_key
            && !list_accum.is_empty()
        {
            let arr: Vec<Value> =
                list_accum.iter().map(|s| Value::String(s.clone())).collect();
            fm.insert(key.clone(), Value::Array(arr));
            list_accum.clear();
        }

        // Empty or comment line.
        if stripped.is_empty() || stripped.starts_with('#') {
            if stripped.is_empty() {
                current_key = None;
            }
            continue;
        }

        // Line containing a colon (potential key: value pair).
        if let Some(colon_idx) = stripped.find(':')
            && !stripped.starts_with('-')
        {
            let key = stripped[..colon_idx].trim().to_string();
            let value_part = stripped[colon_idx + 1..].trim();

            if value_part.starts_with('[') && value_part.ends_with(']') {
                // Inline list: [a, b]
                let inner = &value_part[1..value_part.len() - 1];
                let items: Vec<Value> = inner
                    .split(',')
                    .map(|item| {
                        Value::String(
                            item.trim()
                                .trim_matches('"')
                                .trim_matches('\'')
                                .to_string(),
                        )
                    })
                    .filter(|v| match v {
                        Value::String(s) => !s.is_empty(),
                        _ => true,
                    })
                    .collect();
                fm.insert(key, Value::Array(items));
                list_accum.clear();
                continue;
            }

            if !value_part.is_empty() {
                // Scalar value.
                let val =
                    value_part.trim_matches('"').trim_matches('\'').to_string();
                fm.insert(key, Value::String(val));
                list_accum.clear();
                continue;
            }

            // Empty value after colon → start of a block list.
            current_key = Some(key);
            list_accum.clear();
            continue;
        }

        // Line without colon → reset current_key.
        current_key = None;
    }

    // Final flush of any remaining block list.
    if let Some(ref key) = current_key
        && !list_accum.is_empty()
    {
        let arr: Vec<Value> =
            list_accum.iter().map(|s| Value::String(s.clone())).collect();
        fm.insert(key.clone(), Value::Array(arr));
    }

    fm
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Internal: return `path` relative to `base` as a string.
fn relative_to(base: &Path, path: &Path) -> String {
    path.strip_prefix(base).map_or_else(
        |_| path.to_string_lossy().to_string(),
        |p| p.to_string_lossy().to_string(),
    )
}

/// Extract the wiki-relative path from a `relations` markdown-link entry.
///
/// Expects the markdown-link format `"[title](path.md)"` and returns
/// the path inside the parentheses.  If the entry does not contain a
/// `](` pattern (malformed or unexpected input), the trimmed input is
/// returned as-is as a fallback.
#[must_use]
pub fn parse_related_entry(entry: &str) -> String {
    let entry = entry.trim();
    if entry.contains("](")
        && let Some(start) = entry.rfind('(')
        && let Some(end) = entry.rfind(')')
        && start < end
    {
        return entry[start + 1..end].to_string();
    }
    entry.to_string()
}

// ---------------------------------------------------------------------------
// Page struct & read_page
// ---------------------------------------------------------------------------
/// A parsed wiki page.
#[derive(Debug, Clone)]
pub struct Page {
    /// Absolute filesystem path.
    pub path: PathBuf,
    /// Path relative to `WIKI_DIR`.
    pub rel: String,
    /// Parsed frontmatter (key → string or array of strings).
    pub frontmatter: HashMap<String, Value>,
    /// Body content with frontmatter removed.
    pub body: String,
}

/// Read and parse a wiki page given an explicit wiki base dir.
pub fn read_page_at(path: &Path, wiki_base: &Path) -> Option<Page> {
    let content = read_file(path);
    if content.is_empty() {
        return None;
    }
    let rel = relative_to(wiki_base, path);
    let frontmatter = parse_frontmatter(&content);
    let body = strip_frontmatter(&content);
    Some(Page { path: path.to_path_buf(), rel, frontmatter, body })
}

/// Read and parse a wiki page.
///
/// Returns `None` if the path does not exist or cannot be read.
#[must_use]
pub fn read_page(path: &Path) -> Option<Page> {
    read_page_at(path, &wiki_dir())
}

// ---------------------------------------------------------------------------
// Page cache
// ---------------------------------------------------------------------------

/// Internal: build a page cache keyed by relative path.
pub fn page_cache_at(
    pages: &[PathBuf],
    wiki_base: &Path,
) -> HashMap<String, Page> {
    let mut cache = HashMap::new();
    for path in pages {
        if let Some(page) = read_page_at(path, wiki_base) {
            cache.insert(page.rel.clone(), page);
        }
    }
    cache
}

/// Preload all pages into a map keyed by relative path.
#[must_use]
pub fn page_cache(pages: &[PathBuf]) -> HashMap<String, Page> {
    page_cache_at(pages, &wiki_dir())
}

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

/// Validate that a domain filter matches a known top-level directory.
///
/// Collects known domains from `discover_pages` by extracting the first path
/// component of each page (directories only, not root-level files). Returns
/// `Ok(())` if `domain` matches any known domain (case-insensitive), or
/// `Err(message)` with a Chinese hint listing available domains.
pub fn validate_domain(domain: &str, wiki_dir: &Path) -> Result<(), String> {
    let known: std::collections::BTreeSet<String> = discover_pages(wiki_dir)
        .into_iter()
        .filter_map(|p| {
            p.strip_prefix(wiki_dir)
                .ok()
                .and_then(|r| r.to_str())
                .and_then(|r| {
                    // Only count top-level directories as domains,
                    // not root-level standalone files.
                    r.split('/').next().filter(|_| r.contains('/'))
                })
                .map(String::from)
        })
        .collect();
    let df_lower = domain.to_lowercase();
    if !known.iter().any(|d| d.to_lowercase() == df_lower) {
        return Err(format!(
            "未知的 domain '{}'，可用：{}",
            domain,
            known.iter().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Slice filter (shared by aggregate, status, list)
// ---------------------------------------------------------------------------

/// Check whether a page matches all provided slice filters (AND semantics).
///
/// - `type_filter`: case-insensitive substring match on the `type`
///   frontmatter field.
/// - `tag_filter`: case-insensitive substring match on any element of
///   the `tags` frontmatter field (handles both array and string).
/// - `domain_filter`: case-insensitive exact match on the first path
///   component of `page.rel`.
///
/// Returns `true` when the page passes all provided filters (or all
/// filters are `None`).
#[must_use]
pub fn page_matches_slice(
    page: &Page,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
) -> bool {
    // Type filter (case-insensitive substring).
    if let Some(tf) = type_filter {
        let tf_lower = tf.to_lowercase();
        let page_type =
            page.frontmatter.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !page_type.to_lowercase().contains(&tf_lower) {
            return false;
        }
    }

    // Tag filter (case-insensitive substring on any tag).
    if let Some(tf) = tag_filter {
        let tf_lower = tf.to_lowercase();
        let matches = match page.frontmatter.get("tags") {
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str())
                .any(|t| t.to_lowercase().contains(&tf_lower)),
            Some(Value::String(s)) => s.to_lowercase().contains(&tf_lower),
            _ => false,
        };
        if !matches {
            return false;
        }
    }

    // Domain filter (case-insensitive exact match on first component).
    if let Some(df) = domain_filter {
        let df_lower = df.to_lowercase();
        let domain = page.rel.split('/').next().unwrap_or("");
        if domain.to_lowercase() != df_lower {
            return false;
        }
    }

    true
}

// ---------------------------------------------------------------------------
// Tag extraction (shared by aggregate, list, search)
// ---------------------------------------------------------------------------

/// Extract tag strings from parsed frontmatter.
///
/// Handles both `Value::Array` (inline `[a, b]` or block list) and
/// `Value::String` (single non-empty tag).  Returns an empty vec for
/// missing or empty fields.
#[must_use]
pub fn extract_tags(frontmatter: &HashMap<String, Value>) -> Vec<String> {
    match frontmatter.get("tags") {
        Some(Value::Array(arr)) => {
            arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
        }
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/// Parse an ISO 8601 date string (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ssZ`).
///
/// Accepts both with and without time component for backward compatibility.
///
/// Returns `Some(NaiveDate)` on success, `None` on failure.
#[must_use]
pub fn parse_date(date_str: &str) -> Option<chrono::NaiveDate> {
    let cleaned = date_str.trim();
    if cleaned.is_empty() {
        return None;
    }

    // Try plain date format: YYYY-MM-DD
    if let Ok(d) = chrono::NaiveDate::parse_from_str(cleaned, "%Y-%m-%d") {
        return Some(d);
    }

    // Try datetime formats (with optional Z suffix).
    let cleaned = cleaned.strip_suffix('Z').unwrap_or(cleaned);

    // With fractional seconds.
    if let Ok(dt) =
        chrono::NaiveDateTime::parse_from_str(cleaned, "%Y-%m-%dT%H:%M:%S%.f")
    {
        return Some(dt.date());
    }

    // Without fractional seconds.
    if let Ok(dt) =
        chrono::NaiveDateTime::parse_from_str(cleaned, "%Y-%m-%dT%H:%M:%S")
    {
        return Some(dt.date());
    }

    None
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /// Create a temporary directory for a test group.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    /// Write `text` to `path`, creating parent directories.
    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    // -------------------------------------------------------------------
    // 1. read_file
    // -------------------------------------------------------------------

    #[test]
    fn test_reads_existing_file() {
        let dir = temp_dir("read_file_exists");
        let path = write(&dir.join("hello.md"), "Hello, world!\n");
        assert_eq!(read_file(&path), "Hello, world!\n");
    }

    #[test]
    fn test_file_not_found_returns_empty() {
        let dir = temp_dir("read_file_not_found");
        let path = dir.join("nope.md");
        assert_eq!(read_file(&path), "");
    }

    // -------------------------------------------------------------------
    // 2. all_wiki_pages (tested via discover_pages)
    // -------------------------------------------------------------------

    #[test]
    fn test_all_wiki_pages_includes_regular_md() {
        let dir = temp_dir("wiki_pages_regular");
        write(&dir.join("concepts").join("foo.md"), "# Foo");
        write(&dir.join("concepts").join("bar.md"), "# Bar");

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        assert_eq!(names, vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_all_wiki_pages_excludes_meta_files() {
        let dir = temp_dir("wiki_pages_meta");
        write(&dir.join("regular.md"), "# Regular");
        write(&dir.join("overview.md"), "# Overview");
        for meta in &[
            "index.md",
            "log.md",
            "lint-report.md",
            "health-report.md",
            "SCHEMA.md",
            ".gitkeep",
        ] {
            write(&dir.join(meta), &format!("# {meta}"));
        }

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // overview.md is a real page, not a meta file.
        assert_eq!(names, vec!["overview.md", "regular.md"]);
    }

    #[test]
    fn test_all_wiki_pages_excludes_templates_dir() {
        let dir = temp_dir("wiki_pages_templates");
        write(&dir.join("regular.md"), "# Regular");
        write(&dir.join("templates").join("page-tpl.md"), "# Tpl");

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["regular.md"]);
    }

    #[test]
    fn test_all_wiki_pages_excludes_tools_dir() {
        let dir = temp_dir("wiki_pages_tools");
        write(&dir.join("regular.md"), "# Regular");
        write(&dir.join("tools").join("helper.md"), "# Helper");

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["regular.md"]);
    }

    #[test]
    fn test_all_wiki_pages_excludes_raw_dir() {
        let dir = temp_dir("wiki_pages_raw");
        write(&dir.join("regular.md"), "# Regular");
        write(&dir.join("raw").join("notes.md"), "# Notes");

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["regular.md"]);
    }

    #[test]
    fn test_all_wiki_pages_sorted_order() {
        let dir = temp_dir("wiki_pages_sorted");
        write(&dir.join("z.md"), "# Z");
        write(&dir.join("a.md"), "# A");
        write(&dir.join("m.md"), "# M");

        let pages = discover_pages(&dir);
        let names: Vec<String> = pages
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.md", "m.md", "z.md"]);
    }

    // -------------------------------------------------------------------
    // 3. strip_frontmatter
    // -------------------------------------------------------------------

    #[test]
    fn test_strip_frontmatter_empty_string() {
        assert_eq!(strip_frontmatter(""), "");
    }

    #[test]
    fn test_strip_frontmatter_no_frontmatter() {
        assert_eq!(strip_frontmatter("  just text  "), "just text");
    }

    #[test]
    fn test_strip_frontmatter_frontmatter_only() {
        let content = "---\ntitle: only frontmatter\n---";
        assert_eq!(strip_frontmatter(content), "");
    }

    #[test]
    fn test_strip_frontmatter_trailing_content() {
        let content = "---\ntitle: hello\n---\n\nreal content here";
        assert_eq!(strip_frontmatter(content), "real content here");
    }

    #[test]
    fn test_strip_frontmatter_leading_and_trailing_whitespace() {
        let content = "---\ntitle: foo\n---\n  \nbody\n  ";
        assert_eq!(strip_frontmatter(content), "body");
    }

    #[test]
    fn test_strip_frontmatter_multiple_markers() {
        let content = "---\ntitle: foo\n---\n\n---\nnot frontmatter\n---";
        assert_eq!(strip_frontmatter(content), "---\nnot frontmatter\n---");
    }

    #[test]
    fn test_strip_frontmatter_no_closing_marker() {
        let content = "---\ntitle: no close";
        assert_eq!(strip_frontmatter(content), "---\ntitle: no close");
    }

    // -------------------------------------------------------------------
    // 4. parse_frontmatter
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_frontmatter_scalar_values() {
        let content = "---\ntitle: Hello\ntype: concept\nstatus: draft\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Hello".to_string()))
        );
        assert_eq!(
            result.get("type"),
            Some(&Value::String("concept".to_string()))
        );
        assert_eq!(
            result.get("status"),
            Some(&Value::String("draft".to_string()))
        );
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_parse_frontmatter_inline_list() {
        let content =
            "---\ntags: [python, test]\nrelations: [foo.md, bar.md]\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("tags"),
            Some(&Value::Array(vec![
                Value::String("python".to_string()),
                Value::String("test".to_string()),
            ]))
        );
        assert_eq!(
            result.get("relations"),
            Some(&Value::Array(vec![
                Value::String("foo.md".to_string()),
                Value::String("bar.md".to_string()),
            ]))
        );
    }

    #[test]
    fn test_parse_frontmatter_block_list() {
        let content = "---\ntags:\n- python\n- test\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result.get("tags"),
            Some(&Value::Array(vec![
                Value::String("python".to_string()),
                Value::String("test".to_string()),
            ]))
        );
    }

    #[test]
    fn test_parse_frontmatter_empty_frontmatter() {
        let content = "---\n---\nBody here.";
        let result = parse_frontmatter(content);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        let content = "# Just a heading\n\nNo frontmatter here.\n";
        let result = parse_frontmatter(content);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_frontmatter_mixed_types() {
        let content = "---\ntitle: Mixed\ntype: concept\n\
                        tags: [foo, bar]\nrelations:\n- a.md\n- b.md\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Mixed".to_string()))
        );
        assert_eq!(
            result.get("type"),
            Some(&Value::String("concept".to_string()))
        );
        assert_eq!(
            result.get("tags"),
            Some(&Value::Array(vec![
                Value::String("foo".to_string()),
                Value::String("bar".to_string()),
            ]))
        );
        assert_eq!(
            result.get("relations"),
            Some(&Value::Array(vec![
                Value::String("a.md".to_string()),
                Value::String("b.md".to_string()),
            ]))
        );
    }

    #[test]
    fn test_parse_frontmatter_quoted_values_stripped() {
        let content = "---\ntitle: \"Hello World\"\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Hello World".to_string()))
        );
    }

    #[test]
    fn test_parse_frontmatter_single_quoted_values_stripped() {
        let content = "---\ntitle: 'Hello World'\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Hello World".to_string()))
        );
    }

    #[test]
    fn test_parse_frontmatter_commented_lines_ignored() {
        let content =
            "---\ntitle: Hello\n# this is a comment\ntype: concept\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Hello".to_string()))
        );
        assert_eq!(
            result.get("type"),
            Some(&Value::String("concept".to_string()))
        );
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_parse_frontmatter_no_closing_marker() {
        let content = "---\ntitle: Hello\ntype: concept\n";
        let result = parse_frontmatter(content);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_frontmatter_block_list_flush_on_new_key() {
        let content =
            "---\ntags:\n- python\n- test\ntitle: After List\n---\nBody.";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("tags"),
            Some(&Value::Array(vec![
                Value::String("python".to_string()),
                Value::String("test".to_string()),
            ]))
        );
        assert_eq!(
            result.get("title"),
            Some(&Value::String("After List".to_string()))
        );
    }

    #[test]
    fn test_parse_frontmatter_non_key_line_sets_current_key_to_none() {
        let content = "---\ntitle: Hello\nunknown_line\ntype: concept\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("title"),
            Some(&Value::String("Hello".to_string()))
        );
        assert_eq!(
            result.get("type"),
            Some(&Value::String("concept".to_string()))
        );
        assert_eq!(result.len(), 2);
    }

    // -------------------------------------------------------------------
    // 5. parse_date
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_date_valid() {
        let result = parse_date("2024-06-01");
        assert_eq!(
            result,
            Some(
                chrono::NaiveDate::parse_from_str("2024-06-01", "%Y-%m-%d")
                    .unwrap()
            )
        );
    }

    #[test]
    fn test_parse_date_invalid() {
        assert_eq!(parse_date("not-a-date"), None);
    }

    #[test]
    fn test_parse_date_empty_string() {
        assert_eq!(parse_date(""), None);
    }

    #[test]
    fn test_parse_date_whitespace_around() {
        let result = parse_date("  2024-01-15  ");
        assert_eq!(
            result,
            Some(
                chrono::NaiveDate::parse_from_str("2024-01-15", "%Y-%m-%d")
                    .unwrap()
            )
        );
    }

    #[test]
    fn test_parse_date_invalid_month() {
        assert_eq!(parse_date("2024-13-01"), None);
    }

    // -------------------------------------------------------------------
    // 6. parse_related_entry
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_related_entry_markdown_link() {
        let result = parse_related_entry("[title](concepts/foo.md)");
        assert_eq!(result, "concepts/foo.md");
    }

    #[test]
    fn test_parse_related_entry_markdown_link_nested() {
        let result = parse_related_entry("[some [text]](concepts/foo.md)");
        assert_eq!(result, "concepts/foo.md");
    }

    #[test]
    fn test_parse_related_entry_non_markdown_fallback() {
        // Non-markdown input is treated as malformed; trimmed input is returned.
        let result = parse_related_entry("  concepts/foo.md  ");
        assert_eq!(result, "concepts/foo.md");
    }

    #[test]
    fn test_parse_related_entry_empty() {
        let result = parse_related_entry("");
        assert_eq!(result, "");
    }

    // -------------------------------------------------------------------
    // 7. validate_domain
    // -------------------------------------------------------------------

    #[test]
    fn test_validate_domain_valid() {
        let dir = temp_dir("validate_domain_valid");
        write(
            &dir.join("autoresearch").join("concepts").join("foo.md"),
            "# Foo",
        );
        write(&dir.join("shared").join("concepts").join("bar.md"), "# Bar");
        let result = validate_domain("autoresearch", &dir);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_domain_case_insensitive() {
        let dir = temp_dir("validate_domain_ci");
        write(&dir.join("AutoResearch").join("foo.md"), "# Foo");
        let result = validate_domain("autoresearch", &dir);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_domain_invalid() {
        let dir = temp_dir("validate_domain_invalid");
        write(&dir.join("autoresearch").join("foo.md"), "# Foo");
        let result = validate_domain("nonexistent", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未知的 domain"));
    }

    #[test]
    fn test_validate_domain_ignores_root_files() {
        let dir = temp_dir("validate_domain_root");
        write(&dir.join("root.md"), "# Root");
        write(&dir.join("sub").join("page.md"), "# Page");
        // "root" is not a domain — it's a root-level file.
        let result = validate_domain("root", &dir);
        assert!(result.is_err());
        let result2 = validate_domain("sub", &dir);
        assert!(result2.is_ok());
    }

    // -------------------------------------------------------------------
    // 8. page_matches_slice
    // -------------------------------------------------------------------

    #[test]
    fn test_page_matches_slice_no_filters() {
        let dir = temp_dir("slice_no_filters");
        write(
            &dir.join("shared").join("a.md"),
            "---\ntype: concept\ntags: [auth]\n---\n",
        );
        let pages = discover_pages(&dir);
        let page = read_page_at(&pages[0], &dir).unwrap();
        assert!(page_matches_slice(&page, None, None, None));
    }

    #[test]
    fn test_page_matches_slice_type_substring() {
        let dir = temp_dir("slice_type");
        write(&dir.join("a.md"), "---\ntype: concept\ntags: []\n---\n");
        let page = read_page_at(&dir.join("a.md"), &dir).unwrap();
        assert!(page_matches_slice(&page, Some("conc"), None, None));
        assert!(!page_matches_slice(&page, Some("entity"), None, None));
    }

    #[test]
    fn test_page_matches_slice_tag_substring() {
        let dir = temp_dir("slice_tag");
        write(
            &dir.join("a.md"),
            "---\ntype: concept\ntags: [access-control]\n---\n",
        );
        let page = read_page_at(&dir.join("a.md"), &dir).unwrap();
        assert!(page_matches_slice(&page, None, Some("access"), None));
        assert!(!page_matches_slice(&page, None, Some("auth"), None));
    }

    #[test]
    fn test_page_matches_slice_domain_exact() {
        let dir = temp_dir("slice_domain");
        write(
            &dir.join("shared").join("a.md"),
            "---\ntype: concept\ntags: []\n---\n",
        );
        let page =
            read_page_at(&dir.join("shared").join("a.md"), &dir).unwrap();
        assert!(page_matches_slice(&page, None, None, Some("shared")));
        assert!(!page_matches_slice(&page, None, None, Some("other")));
    }

    #[test]
    fn test_page_matches_slice_combined_and() {
        let dir = temp_dir("slice_combined");
        write(
            &dir.join("shared").join("a.md"),
            "---\ntype: concept\ntags: [auth]\n---\n",
        );
        write(
            &dir.join("shared").join("b.md"),
            "---\ntype: entity\ntags: [auth]\n---\n",
        );
        let page_a =
            read_page_at(&dir.join("shared").join("a.md"), &dir).unwrap();
        let page_b =
            read_page_at(&dir.join("shared").join("b.md"), &dir).unwrap();
        // Both match domain+tag, only a matches type.
        assert!(page_matches_slice(
            &page_a,
            Some("concept"),
            Some("auth"),
            Some("shared"),
        ));
        assert!(!page_matches_slice(
            &page_b,
            Some("concept"),
            Some("auth"),
            Some("shared"),
        ));
    }
}
