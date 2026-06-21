//! Page scaffolding — create new pages from templates, read pages and outlines.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::wiki;

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/// Convert a title string to a kebab-case filename slug (no extension).
///
/// Rules:
/// - Lowercase, underscores → hyphens
/// - Strip dots, slashes, backslashes
/// - Collapse multiple hyphens to one
/// - Strip leading/trailing hyphens
/// - Strip non-alphanumeric (except hyphens)
/// - Chinese chars → empty string
pub fn to_kebab_case(title: &str) -> String {
    let mut name = title.to_lowercase();

    // Underscores → hyphens
    name = name.replace('_', "-");

    // Whitespace runs → single hyphen
    let re_ws = Regex::new(r"\s+").expect("valid regex");
    name = re_ws.replace_all(&name, "-").to_string();

    // Strip non-alphanumeric (except hyphens). This also strips dots,
    // slashes, backslashes, and non-ASCII chars like Chinese.
    let re_strip = Regex::new(r"[^a-z0-9-]").expect("valid regex");
    name = re_strip.replace_all(&name, "").to_string();

    // Collapse multiple hyphens
    let re_hyphens = Regex::new(r"-{2,}").expect("valid regex");
    name = re_hyphens.replace_all(&name, "-").to_string();

    // Strip leading/trailing hyphens
    name.trim_matches('-').to_string()
}

// ---------------------------------------------------------------------------
// Template directory map
// ---------------------------------------------------------------------------

fn type_to_dir(page_type: &str) -> Option<&'static str> {
    match page_type {
        "concept" => Some("concepts"),
        "entity" => Some("entities"),
        "source" => Some("sources"),
        "analysis" => Some("analysis"),
        "synthesis" => Some("syntheses"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Template application
// ---------------------------------------------------------------------------

/// Apply template substitutions: timestamp, status, title placeholders.
fn apply_template(content: &str, title: &str) -> String {
    let today = chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // 1. Timestamp placeholder
    let re_ts = Regex::new(r"(?m)^timestamp: YYYY-MM-DDTHH:mm:ssZ$")
        .expect("valid regex");
    let content =
        re_ts.replace(content, format!("timestamp: {today}")).to_string();

    // 2. Default status → draft
    let re_status =
        Regex::new(r"(?m)^status: draft\|review\|stable\|deprecated$")
            .expect("valid regex");
    let content = re_status.replace(&content, "status: draft").to_string();

    // 3. Title placeholders: `title: <...>` and `# <...>`
    let re_title_fm = Regex::new(r"(?m)^title: <[^>]+>$").expect("valid regex");
    let content =
        re_title_fm.replace(&content, format!("title: {title}")).to_string();

    let re_title_h1 = Regex::new(r"(?m)^# <[^>]+>$").expect("valid regex");
    re_title_h1.replace(&content, format!("# {title}")).to_string()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new wiki page from a template.
///
/// Writes the rendered content to `WIKI_DIR/{type}/{slug}.md` (or
/// `WIKI_DIR/sources/{source_type}/{slug}.md` for source pages).
///
/// # Errors
///
/// Returns an error string if:
/// - The page type is unknown
/// - The slug is empty, or contains `..`, `/`, `\`
/// - The template file does not exist
/// - File I/O fails
pub fn create_page(
    page_type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
) -> Result<PathBuf, String> {
    create_page_at(&wiki::wiki_dir(), page_type, title, slug, source_type)
}

/// Inner implementation: create a page under an explicit wiki root.
pub fn create_page_at(
    wiki_root: &Path,
    page_type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
) -> Result<PathBuf, String> {
    // Validate slug
    let slug = slug
        .map_or_else(|| to_kebab_case(title), std::borrow::ToOwned::to_owned);
    if slug.is_empty()
        || slug.contains("..")
        || slug.contains('/')
        || slug.contains('\\')
    {
        return Err("无效的文件名 slug — 不能包含 .. / \\ 等路径分隔符。请使用 --slug 参数指定有效的英文文件名。".to_string());
    }

    // source_type required for source pages
    if page_type == "source" && source_type.is_none() {
        return Err("source 类型页面必须指定 --source-type (adr/rfc/notes)。"
            .to_string());
    }

    // Resolve output directory
    let dir_name = type_to_dir(page_type)
        .ok_or_else(|| format!("未知的页面类型: {page_type}"))?;

    // Load template
    let template_path =
        wiki_root.join("templates").join(format!("{page_type}.md"));
    let template_content = fs::read_to_string(&template_path)
        .map_err(|e| format!("未找到模板 {page_type}.md: {e}"))?;

    // Apply substitutions
    let processed = apply_template(&template_content, title);

    // Compute output path
    let output_path = if page_type == "source" {
        wiki_root
            .join("sources")
            .join(source_type.expect("already validated"))
            .join(format!("{slug}.md"))
    } else {
        wiki_root.join(dir_name).join(format!("{slug}.md"))
    };

    // Create parent dirs
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
    }

    // Write atomically (temp file → rename)
    let temp_path =
        output_path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp_path, &processed)
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&temp_path, &output_path)
        .inspect_err(|_| {
            let _ = fs::remove_file(&temp_path);
        })
        .map_err(|e| format!("重命名文件失败: {e}"))?;

    Ok(output_path)
}

/// Read the full content of a wiki page (including frontmatter).
pub fn read_full(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("无法读取文件: {e}"))
}

/// Extract a single frontmatter property value from a wiki page.
///
/// Returns `Ok(None)` if the property does not exist.
pub fn read_property(
    path: &Path,
    name: &str,
) -> Result<Option<String>, String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("无法读取文件: {e}"))?;
    let fm = wiki::parse_frontmatter(&content);
    Ok(fm.get(name).and_then(|v| v.as_str().map(ToString::to_string)))
}

/// Extract `## ` headings (outline) from a wiki page body.
///
/// Returns each heading text on its own line, in document order.
pub fn read_outline(path: &Path) -> Result<String, String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("无法读取文件: {e}"))?;
    let body = wiki::strip_frontmatter(&content);

    let re = Regex::new(r"(?m)^##\s+(.+)$").expect("valid regex");
    let headings: Vec<String> =
        re.captures_iter(&body).map(|cap| cap[1].trim().to_string()).collect();

    Ok(headings.join("\n"))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("page").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    /// Run a closure with a temp directory that has a `templates/` subdirectory
    /// with all known template files.
    fn with_wiki_dir(test_name: &str, f: impl FnOnce(PathBuf)) {
        let wiki = temp_dir(test_name);
        let templates = wiki.join("templates");
        fs::create_dir_all(&templates).expect("failed to create templates dir");
        // Write all known templates so create_page can find them.
        for ttype in &["concept", "entity", "source", "analysis", "synthesis"] {
            let tpl = match *ttype {
                "concept" => {
                    "---\ntitle: <概念名称>\ntype: concept\ntimestamp: YYYY-MM-DDTHH:mm:ssZ\nstatus: draft|review|stable|deprecated\n---\n\n# <概念名称>\n"
                }
                "entity" => {
                    "---\ntitle: <实体名称>\ntype: entity\ntimestamp: YYYY-MM-DDTHH:mm:ssZ\nstatus: draft|review|stable|deprecated\n---\n\n# <实体名称>\n"
                }
                "source" => {
                    "---\ntitle: <源文档标题>\ntype: source\ntimestamp: YYYY-MM-DDTHH:mm:ssZ\nstatus: draft|review|stable|deprecated\n---\n\n# <源文档标题>\n"
                }
                "analysis" => {
                    "---\ntitle: <分析标题>\ntype: analysis\ntimestamp: YYYY-MM-DDTHH:mm:ssZ\nstatus: draft|review|stable|deprecated\n---\n\n# <分析标题>\n"
                }
                "synthesis" => {
                    "---\ntitle: <综合标题>\ntype: synthesis\ntimestamp: YYYY-MM-DDTHH:mm:ssZ\nstatus: draft|review|stable|deprecated\n---\n\n# <综合标题>\n"
                }
                _ => unreachable!(),
            };
            fs::write(templates.join(format!("{ttype}.md")), tpl)
                .expect("failed to write template");
        }
        f(wiki);
    }

    // -------------------------------------------------------------------
    // to_kebab_case
    // -------------------------------------------------------------------

    #[test]
    fn test_to_kebab_case_basic() {
        assert_eq!(to_kebab_case("Hello World"), "hello-world");
    }

    #[test]
    fn test_to_kebab_case_underscores() {
        assert_eq!(to_kebab_case("hello_world"), "hello-world");
    }

    #[test]
    fn test_to_kebab_case_traversal_safe() {
        // Dots, slashes, backslashes stripped
        assert_eq!(to_kebab_case("foo.bar"), "foobar");
        assert_eq!(to_kebab_case("foo/bar"), "foobar");
        assert_eq!(to_kebab_case("foo\\bar"), "foobar");
    }

    #[test]
    fn test_to_kebab_case_hyphens_collapse() {
        assert_eq!(to_kebab_case("foo---bar"), "foo-bar");
        assert_eq!(to_kebab_case("foo___bar"), "foo-bar");
    }

    #[test]
    fn test_to_kebab_case_leading_trailing_strip() {
        assert_eq!(to_kebab_case("--hello--"), "hello");
    }

    #[test]
    fn test_to_kebab_case_non_alnum_strip() {
        assert_eq!(to_kebab_case("hello$world"), "helloworld");
        assert_eq!(to_kebab_case("hello@#$%"), "hello");
    }

    #[test]
    fn test_to_kebab_case_chinese_empty() {
        assert_eq!(to_kebab_case("你好世界"), "");
    }

    #[test]
    fn test_to_kebab_case_mixed_chinese() {
        assert_eq!(to_kebab_case("npc名称"), "npc");
    }

    // -------------------------------------------------------------------
    // create_page
    // -------------------------------------------------------------------

    #[test]
    fn test_create_page_concept() {
        with_wiki_dir("create_concept", |wiki| {
            let result =
                create_page_at(&wiki, "concept", "Test Concept", None, None);
            assert!(result.is_ok(), "create_page failed: {:?}", result.err());
            let path = result.unwrap();
            assert!(path.exists(), "file should exist: {}", path.display());
            assert!(
                path.starts_with(wiki.join("concepts")),
                "path should be under concepts/"
            );

            let content = fs::read_to_string(&path).unwrap();
            assert!(content.contains("title: Test Concept"));
            assert!(content.contains("# Test Concept"));
            assert!(content.contains("status: draft"));
            assert!(content.contains("type: concept"));
            assert!(content.contains("timestamp: "));
        });
    }

    #[test]
    fn test_create_page_entity() {
        with_wiki_dir("create_entity", |wiki| {
            let result =
                create_page_at(&wiki, "entity", "Test Entity", None, None);
            assert!(result.is_ok(), "create_page failed: {:?}", result.err());
            let path = result.unwrap();
            assert!(path.exists());
            let content = fs::read_to_string(&path).unwrap();
            assert!(content.contains("title: Test Entity"));
            assert!(content.contains("# Test Entity"));
            assert!(content.contains("type: entity"));
        });
    }

    #[test]
    fn test_create_page_source_with_source_type() {
        with_wiki_dir("create_source_with_type", |wiki| {
            let result = create_page_at(
                &wiki,
                "source",
                "ADR-001",
                Some("adr-001"),
                Some("adr"),
            );
            assert!(result.is_ok(), "create_page failed: {:?}", result.err());
            let path = result.unwrap();
            assert!(path.exists());
            assert!(
                path.starts_with(wiki.join("sources").join("adr")),
                "path should be under sources/adr/"
            );
            let content = fs::read_to_string(&path).unwrap();
            assert!(content.contains("title: ADR-001"));
            assert!(content.contains("type: source"));
        });
    }

    #[test]
    fn test_create_page_source_without_source_type_error() {
        with_wiki_dir("create_source_no_type", |wiki| {
            let result = create_page_at(&wiki, "source", "ADR-001", None, None);
            assert!(result.is_err(), "should fail without source_type");
            let err = result.unwrap_err();
            assert!(
                err.contains("--source-type"),
                "error should mention --source-type: {err}"
            );
        });
    }

    #[test]
    fn test_create_page_slug_override() {
        with_wiki_dir("create_slug_override", |wiki| {
            let result = create_page_at(
                &wiki,
                "concept",
                "My Title",
                Some("custom-slug"),
                None,
            );
            assert!(result.is_ok());
            let path = result.unwrap();
            let filename =
                path.file_name().unwrap().to_string_lossy().to_string();
            assert_eq!(filename, "custom-slug.md");
            assert!(
                path.starts_with(wiki.join("concepts")),
                "path should be under concepts/"
            );
        });
    }

    #[test]
    fn test_create_page_chinese_title_without_slug_error() {
        with_wiki_dir("create_chinese_no_slug", |wiki| {
            let result =
                create_page_at(&wiki, "concept", "中文标题", None, None);
            assert!(
                result.is_err(),
                "should fail without slug for Chinese title"
            );
        });
    }

    #[test]
    fn test_create_page_chinese_title_with_slug() {
        with_wiki_dir("create_chinese_with_slug", |wiki| {
            let result = create_page_at(
                &wiki,
                "concept",
                "中文标题",
                Some("chinese-title"),
                None,
            );
            assert!(result.is_ok(), "should succeed with slug");
        });
    }

    // -------------------------------------------------------------------
    // read_full
    // -------------------------------------------------------------------

    #[test]
    fn test_read_full_returns_content() {
        let dir = temp_dir("read_full");
        let path = dir.join("test.md");
        fs::write(&path, "---\ntitle: Hello\n---\n\nBody.").unwrap();

        let result = read_full(&path);
        assert!(result.is_ok());
        let content = result.unwrap();
        assert!(content.contains("title: Hello"));
        assert!(content.contains("Body."));
    }

    #[test]
    fn test_read_full_file_not_found() {
        let dir = temp_dir("read_full_missing");
        let path = dir.join("nope.md");
        let result = read_full(&path);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // read_property
    // -------------------------------------------------------------------

    #[test]
    fn test_read_property_existing_field() {
        let dir = temp_dir("read_prop_existing");
        let path = dir.join("test.md");
        fs::write(&path, "---\ntitle: Hello\nstatus: draft\n---\n\nBody.")
            .unwrap();

        let result = read_property(&path, "status");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some("draft".to_string()));
    }

    #[test]
    fn test_read_property_missing_field() {
        let dir = temp_dir("read_prop_missing");
        let path = dir.join("test.md");
        fs::write(&path, "---\ntitle: Hello\n---\n\nBody.").unwrap();

        let result = read_property(&path, "tags");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn test_read_property_no_frontmatter() {
        let dir = temp_dir("read_prop_no_fm");
        let path = dir.join("test.md");
        fs::write(&path, "# Just body").unwrap();

        let result = read_property(&path, "title");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    // -------------------------------------------------------------------
    // read_outline
    // -------------------------------------------------------------------

    #[test]
    fn test_read_outline_basic() {
        let dir = temp_dir("outline_basic");
        let path = dir.join("test.md");
        fs::write(
            &path,
            "---\ntitle: Test\n---\n\n## First Heading\n\nSome text\n\n## Second Heading\n\n### Sub heading\n\n## Third Heading\n",
        )
        .unwrap();

        let result = read_outline(&path);
        assert!(result.is_ok());
        let outline = result.unwrap();
        assert_eq!(outline, "First Heading\nSecond Heading\nThird Heading");
    }

    #[test]
    fn test_read_outline_no_headings() {
        let dir = temp_dir("outline_none");
        let path = dir.join("test.md");
        fs::write(&path, "---\ntitle: Test\n---\n\nJust text.").unwrap();

        let result = read_outline(&path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn test_read_outline_ignores_h1_and_h3() {
        let dir = temp_dir("outline_levels");
        let path = dir.join("test.md");
        fs::write(
            &path,
            "# Title\n\n## H2 Only\n\n### H3 ignored\n\n## Another H2\n",
        )
        .unwrap();

        let result = read_outline(&path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "H2 Only\nAnother H2");
    }
}
