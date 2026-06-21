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
const META_FILES: &[&str] = &[
    "index.md",
    "log.md",
    "lint-report.md",
    "health-report.md",
    "overview.md",
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

/// Internal: find all `*.md` files under `base`, excluding meta / system
/// files and directories named `templates/`, `tools/`, `raw/`.
fn discover_pages(base: &Path) -> Vec<PathBuf> {
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

/// Internal: read and parse a wiki page given an explicit wiki base dir.
fn read_page_at(path: &Path, wiki_base: &Path) -> Option<Page> {
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
fn page_cache_at(pages: &[PathBuf], wiki_base: &Path) -> HashMap<String, Page> {
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
        for meta in &[
            "index.md",
            "log.md",
            "lint-report.md",
            "health-report.md",
            "overview.md",
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
        assert_eq!(names, vec!["regular.md"]);
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
            "---\ntags: [python, test]\nrelated: [foo.md, bar.md]\n---\n";
        let result = parse_frontmatter(content);
        assert_eq!(
            result.get("tags"),
            Some(&Value::Array(vec![
                Value::String("python".to_string()),
                Value::String("test".to_string()),
            ]))
        );
        assert_eq!(
            result.get("related"),
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
                        tags: [foo, bar]\nrelated:\n- a.md\n- b.md\n---\n";
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
            result.get("related"),
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
}
