//! Page properties: typed frontmatter reads and writes.
//!
//! Every operation works on the page document model, so a write always
//! produces a complete frontmatter block that keeps the field order of the
//! page, and an edit that the model cannot express fails instead of writing
//! a broken page.

use std::fs;
use std::path::Path;

use zwiki::document::{self, Value};

use crate::document_io::{load, store};

/// Read the value of a frontmatter property as YAML text.
///
/// Returns `Ok(None)` if the page has no such field.
pub fn get(page: &Path, name: &str) -> Result<Option<String>, String> {
    let text = read_text(page)?;
    let value = document::read_field(&text, name).map_err(|e| e.to_string())?;
    value.as_ref().map(render).transpose()
}

/// Set a frontmatter property.
///
/// A string property takes the value as written, so a colon or a number
/// stays part of it.  Every other property decodes the value as YAML, so
/// numbers and lists keep their type.  A schema field rejects a value of the
/// wrong type; an unknown name becomes a flat extension field.
///
/// Writes atomically (temp file → rename).
///
/// # Errors
///
/// Fails when the page cannot be read or parsed, when the value is not valid
/// YAML, when a schema field rejects the value, or when the write fails.
pub fn set(page: &Path, name: &str, value: &str) -> Result<(), String> {
    let mut document = load(page)?;
    document.metadata.set_field_text(name, value).map_err(|e| e.to_string())?;
    store(page, &document)
}

/// Delete a frontmatter property.
///
/// Deleting a field the schema requires fails, because a page without it is
/// not a valid document.
///
/// Writes atomically (temp file → rename).
pub fn delete(page: &Path, name: &str) -> Result<(), String> {
    let mut document = load(page)?;
    document.metadata.remove_field(name).map_err(|e| e.to_string())?;
    store(page, &document)
}

/// Read the page text.
fn read_text(page: &Path) -> Result<String, String> {
    fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))
}

/// Render a property value as text.
///
/// A string prints as itself; every other value prints as YAML, so lists and
/// numbers stay readable.
fn render(value: &Value) -> Result<String, String> {
    let Value::String(text) = value else {
        let yaml = serde_yaml::to_string(value)
            .map_err(|e| format!("无法呈现属性值: {e}"))?;
        return Ok(yaml.trim_end_matches('\n').to_string());
    };
    Ok(text.clone())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::temp_dir;
    use std::fs;
    use std::path::PathBuf;
    /// Page with every required field and two optional fields.
    const SAMPLE: &str = concat!(
        "---\n",
        "title: Test Page\n",
        "type: concept\n",
        "description: 摘要\n",
        "tags: [a, b]\n",
        "",
        "timestamp: 2026-07-01T00:00:00Z\n",
        "",
        "---\n",
        "\n",
        "Body content.\n",
    );

    fn make_page(dir: &Path, filename: &str, text: &str) -> PathBuf {
        let path = dir.join(filename);
        fs::write(&path, text).expect("failed to write test page");
        path
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).expect("failed to read test page")
    }

    // -------------------------------------------------------------------
    // get
    // -------------------------------------------------------------------

    #[test]
    fn test_get_existing_field() {
        let dir = temp_dir("get_existing");
        let path = make_page(&dir, "test.md", SAMPLE);
        let result = get(&path, "timestamp");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some("2026-07-01T00:00:00Z".to_string()));
    }

    #[test]
    fn test_get_missing_field() {
        let dir = temp_dir("get_missing");
        let path = make_page(&dir, "test.md", SAMPLE);
        let result = get(&path, "resource");
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

    #[test]
    fn test_get_field_on_partial_page() {
        let dir = temp_dir("get_partial");
        let path =
            make_page(&dir, "test.md", "---\ntitle: Hello\n---\n\nBody.");
        assert_eq!(get(&path, "title").unwrap(), Some("Hello".to_string()));
        assert_eq!(get(&path, "tags").unwrap(), None);
    }

    #[test]
    fn test_get_list_field() {
        let dir = temp_dir("get_list");
        let path = make_page(&dir, "test.md", SAMPLE);
        assert_eq!(get(&path, "tags").unwrap(), Some("- a\n- b".to_string()));
    }

    #[test]
    fn test_get_integer_field() {
        let dir = temp_dir("get_integer");
        let page =
            SAMPLE.replace("tags: [a, b]\n", "tags: [a, b]\npriority: 90\n");
        let path = make_page(&dir, "test.md", &page);
        assert_eq!(get(&path, "priority").unwrap(), Some("90".to_string()));
    }

    #[test]
    fn test_get_extension_field() {
        let dir = temp_dir("get_extension");
        let page = SAMPLE
            .replace("tags: [a, b]\n", "tags: [a, b]\nokf_version: \"0.1\"\n");
        let path = make_page(&dir, "test.md", &page);
        assert_eq!(get(&path, "okf_version").unwrap(), Some("0.1".to_string()));
    }

    #[test]
    fn test_get_rejects_broken_yaml() {
        let dir = temp_dir("get_broken_yaml");
        let path = make_page(&dir, "test.md", "---\ntitle: [\n---\n");
        let error = get(&path, "title").expect_err("broken yaml");
        assert!(error.contains("frontmatter"), "unexpected error: {error}");
    }

    // -------------------------------------------------------------------
    // set
    // -------------------------------------------------------------------

    #[test]
    fn test_set_writes_deterministic_frontmatter() {
        let dir = temp_dir("set_deterministic");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "resource", "https://example.com/a").unwrap();

        assert_eq!(
            read(&path),
            concat!(
                "---\n",
                "title: Test Page\n",
                "type: concept\n",
                "description: 摘要\n",
                "tags:\n",
                "  - a\n",
                "  - b\n",
                "",
                "timestamp: 2026-07-01T00:00:00Z\n",
                "",
                "resource: https://example.com/a\n",
                "---\n",
                "\n",
                "Body content.\n",
            )
        );
    }

    #[test]
    fn test_set_existing_field() {
        let dir = temp_dir("set_existing");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "resource", "https://example.com/a").unwrap();

        assert_eq!(
            get(&path, "resource").unwrap(),
            Some("https://example.com/a".to_string())
        );
        assert_eq!(get(&path, "title").unwrap(), Some("Test Page".to_string()));
        assert!(read(&path).contains("Body content."));
    }

    #[test]
    fn test_set_field_no_frontmatter() {
        let dir = temp_dir("set_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        assert!(set(&path, "title", "Hello").is_err());
    }

    #[test]
    fn test_set_list_field() {
        let dir = temp_dir("set_list");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "sources", "[shared/a.md, shared/b.md]").unwrap();

        assert_eq!(
            get(&path, "sources").unwrap(),
            Some("- shared/a.md\n- shared/b.md".to_string())
        );
        let text = read(&path);
        assert!(text.contains("sources:\n  - shared/a.md\n  - shared/b.md\n"));
        assert!(text.contains("tags:\n  - a\n  - b\n"), "{text}");
    }

    #[test]
    fn test_set_integer_field() {
        let dir = temp_dir("set_integer");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "priority", "90").unwrap();

        assert_eq!(get(&path, "priority").unwrap(), Some("90".to_string()));
        assert!(read(&path).contains("priority: 90\n"));
    }

    #[test]
    fn test_set_extension_field() {
        let dir = temp_dir("set_extension");
        let path = make_page(&dir, "test.md", SAMPLE);
        set(&path, "owner", "team-a").unwrap();

        assert_eq!(get(&path, "owner").unwrap(), Some("team-a".to_string()));
        let text = read(&path);
        assert!(text.contains("\nowner: team-a\n"), "{text}");
        assert_eq!(get(&path, "title").unwrap(), Some("Test Page".to_string()));
    }

    #[test]
    fn test_set_rejects_wrong_type() {
        let dir = temp_dir("set_wrong_type");
        let path = make_page(&dir, "test.md", SAMPLE);
        let error = set(&path, "tags", "permission").expect_err("scalar tags");

        assert!(error.contains("tags"), "unexpected error: {error}");
        assert_eq!(read(&path), SAMPLE);
    }

    #[test]
    fn test_set_rejects_invalid_yaml() {
        let dir = temp_dir("set_invalid_yaml");
        let path = make_page(&dir, "test.md", SAMPLE);
        let error = set(&path, "owner", "[unclosed").expect_err("invalid yaml");

        assert!(error.contains("无法解析属性值"), "unexpected error: {error}");
        assert_eq!(read(&path), SAMPLE);
    }

    #[test]
    fn test_set_keeps_body_and_backlinks() {
        let dir = temp_dir("set_backlinks");
        let page = concat!(
            "---\n",
            "title: Test Page\n",
            "type: concept\n",
            "tags: [a]\n",
            "",
            "timestamp: 2026-07-01T00:00:00Z\n",
            "",
            "---\n",
            "\n",
            "# Test Page\n",
            "\n",
            "正文。\n",
            "\n",
            "## Backlinks\n",
            "\n",
            "- [Linker](concepts/linker.md)\n",
            "\n",
            "## References\n",
            "\n",
            "- 来源\n",
        );
        let path = make_page(&dir, "test.md", page);
        set(&path, "description", "摘要").unwrap();

        assert_eq!(
            read(&path),
            concat!(
                "---\n",
                "title: Test Page\n",
                "type: concept\n",
                "tags:\n",
                "  - a\n",
                "timestamp: 2026-07-01T00:00:00Z\n",
                "description: 摘要\n",
                "---\n",
                "\n",
                "# Test Page\n",
                "\n",
                "正文。\n",
                "\n",
                "## Backlinks\n",
                "\n",
                "- [Linker](concepts/linker.md)\n",
                "\n",
                "## References\n",
                "\n",
                "- 来源\n",
            )
        );
    }

    // -------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------

    #[test]
    fn test_delete_field() {
        let dir = temp_dir("delete_field");
        let path = make_page(&dir, "test.md", SAMPLE);
        delete(&path, "description").unwrap();

        assert_eq!(get(&path, "description").unwrap(), None);
        assert_eq!(get(&path, "title").unwrap(), Some("Test Page".to_string()));
        assert!(read(&path).contains("Body content."));
    }

    #[test]
    fn test_delete_nonexistent_field() {
        let dir = temp_dir("delete_nonexistent");
        let path = make_page(&dir, "test.md", SAMPLE);
        delete(&path, "resource").unwrap();

        assert_eq!(
            read(&path),
            SAMPLE.replace("tags: [a, b]", "tags:\n  - a\n  - b")
        );
    }

    #[test]
    fn test_delete_field_no_frontmatter() {
        let dir = temp_dir("delete_no_fm");
        let path = make_page(&dir, "test.md", "# Just body\n");
        assert!(delete(&path, "title").is_err());
    }

    #[test]
    fn test_delete_required_field_rejected() {
        let dir = temp_dir("delete_required");
        let path = make_page(&dir, "test.md", SAMPLE);
        let error = delete(&path, "timestamp").expect_err("required field");

        assert!(error.contains("timestamp"), "unexpected error: {error}");
        assert_eq!(read(&path), SAMPLE);
    }

    #[test]
    fn test_delete_structured_field_removes_nested_lines() {
        let dir = temp_dir("delete_structured");
        let page = concat!(
            "---\n",
            "title: Test Page\n",
            "type: concept\n",
            "supersedes:\n",
            "- path: shared/a.md\n",
            "  reason: 覆盖旧模型\n",
            "tags: [a]\n",
            "",
            "timestamp: 2026-07-01T00:00:00Z\n",
            "",
            "---\n",
            "\n",
            "Body content.\n",
        );
        let path = make_page(&dir, "test.md", page);
        delete(&path, "supersedes").unwrap();

        let text = read(&path);
        assert!(!text.contains("path:"), "nested line leaked:\n{text}");
        assert!(!text.contains("reason:"), "nested line leaked:\n{text}");
        assert_eq!(get(&path, "title").unwrap(), Some("Test Page".to_string()));
    }

    #[test]
    fn test_set_dotted_name_does_not_edit_nested_field() {
        let dir = temp_dir("set_dotted");
        let page = concat!(
            "---\n",
            "title: Test Page\n",
            "type: concept\n",
            "supersedes:\n",
            "- path: shared/a.md\n",
            "  reason: 覆盖旧模型\n",
            "tags: [a]\n",
            "",
            "timestamp: 2026-07-01T00:00:00Z\n",
            "",
            "---\n",
            "\n",
            "Body content.\n",
        );
        let path = make_page(&dir, "test.md", page);
        set(&path, "path", "shared/b.md").unwrap();

        let text = read(&path);
        assert!(text.contains("- path: shared/a.md\n"), "{text}");
        assert!(text.contains("\npath: shared/b.md\n"), "{text}");
    }
}
