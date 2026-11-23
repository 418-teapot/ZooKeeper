//! Supersede linking — maintain `supersedes` / `superseded_by` relations
//! between wiki pages.
//!
//! Both pages are read as documents, their relation fields change through
//! the typed metadata, and each updated document renders back once.

use std::path::Path;

use chrono::Utc;
use zwiki::document::Relation;

use crate::document_io::{load, store};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Establish a supersede relationship between two wiki pages under an
/// explicit wiki root.
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

    let mut old_document =
        load(&old_abs).map_err(|e| format!("{old_rel}: {e}"))?;
    let mut new_document =
        load(&new_abs).map_err(|e| format!("{new_rel}: {e}"))?;

    // New page (superseding) gets a `supersedes` entry pointing to the old
    // page.
    new_document.metadata.supersedes.get_or_insert_with(Vec::new).push(
        Relation { path: old_rel.to_string(), reason: reason.to_string() },
    );
    // Old page (superseded) gets a `superseded_by` entry pointing to the new
    // page.
    old_document.metadata.superseded_by.get_or_insert_with(Vec::new).push(
        Relation { path: new_rel.to_string(), reason: reason.to_string() },
    );

    // The supersedure edits the old page, so its `timestamp` names the
    // moment of the edit.  A referrer edited later counts as reviewed.
    old_document.metadata.timestamp =
        Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    store(&new_abs, &new_document)?;
    store(&old_abs, &old_document)?;

    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::temp_dir;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn make_page(dir: &Path, filename: &str, content: &str) -> PathBuf {
        let path = dir.join(filename);
        fs::write(&path, content).expect("failed to write test page");
        path
    }

    /// Valid page with every required field and extra frontmatter lines.
    fn page(title: &str, extra: &str) -> String {
        format!(
            "---\ntitle: {title}\ntype: concept\ntags: []\n\
             timestamp: 2026-07-01T00:00:00Z\n\
             {extra}---\n\n# {title}\n\nBody.\n"
        )
    }

    #[test]
    fn test_link_supersede_both_sides() {
        let dir = temp_dir("both_sides");
        let old_path = make_page(&dir, "old.md", &page("Old Page", ""));
        let new_path = make_page(&dir, "new.md", &page("New Page", ""));

        link_supersede_at("old.md", "new.md", "replaces old", &dir)
            .expect("link supersede");

        let new_document = load(&new_path).expect("new page");
        assert_eq!(
            new_document.metadata.supersedes,
            Some(vec![Relation {
                path: "old.md".to_string(),
                reason: "replaces old".to_string(),
            }])
        );
        assert_eq!(new_document.body.author(), "# New Page\n\nBody.");

        let old_document = load(&old_path).expect("old page");
        assert_eq!(
            old_document.metadata.superseded_by,
            Some(vec![Relation {
                path: "new.md".to_string(),
                reason: "replaces old".to_string(),
            }])
        );
        assert_eq!(old_document.body.author(), "# Old Page\n\nBody.");
    }

    #[test]
    fn test_link_supersede_appends_to_existing_relations() {
        let dir = temp_dir("existing_relations");
        let old_path = make_page(
            &dir,
            "old.md",
            &page(
                "Old Page",
                "superseded_by:\n  - path: older.md\n    reason: first\n",
            ),
        );
        make_page(&dir, "new.md", &page("New Page", ""));

        link_supersede_at("old.md", "new.md", "replaces old", &dir)
            .expect("link supersede");

        let old_document = load(&old_path).expect("old page");
        assert_eq!(
            old_document.metadata.superseded_by,
            Some(vec![
                Relation {
                    path: "older.md".to_string(),
                    reason: "first".to_string(),
                },
                Relation {
                    path: "new.md".to_string(),
                    reason: "replaces old".to_string(),
                },
            ])
        );
    }

    #[test]
    fn test_link_supersede_updates_timestamp() {
        let dir = temp_dir("supersede_timestamp");
        let old_path = make_page(&dir, "old.md", &page("Old Page", ""));
        let new_path = make_page(&dir, "new.md", &page("New Page", ""));

        link_supersede_at("old.md", "new.md", "replaces old", &dir)
            .expect("link supersede");

        let old_document = load(&old_path).expect("old page");
        assert_ne!(old_document.metadata.timestamp, "2026-07-01T00:00:00Z");
        assert!(old_document.metadata.timestamp.ends_with('Z'));

        let new_document = load(&new_path).expect("new page");
        assert_eq!(new_document.metadata.timestamp, "2026-07-01T00:00:00Z");
    }

    #[test]
    fn test_link_supersede_keeps_extensions_and_backlinks() {
        let dir = temp_dir("keep_extensions");
        let old_path = make_page(
            &dir,
            "old.md",
            &page("Old Page", "owner: team-a\n").replace(
                "Body.\n",
                "Body.\n\n## Backlinks\n\n- [Other](other.md)\n",
            ),
        );
        make_page(&dir, "new.md", &page("New Page", ""));

        link_supersede_at("old.md", "new.md", "replaces old", &dir)
            .expect("link supersede");

        let old_document = load(&old_path).expect("old page");
        assert_eq!(
            old_document
                .metadata
                .extensions
                .get("owner")
                .map(|v| (**v).clone()),
            Some(zwiki::document::Value::from("team-a"))
        );
        assert_eq!(old_document.body.backlinks(), Some("- [Other](other.md)"));
        assert_eq!(old_document.body.author(), "# Old Page\n\nBody.");
    }

    #[test]
    fn test_link_supersede_rejects_invalid_page() {
        let dir = temp_dir("invalid_page");
        make_page(&dir, "old.md", "---\ntitle: Old Page\n---\n\nBody.\n");
        make_page(&dir, "new.md", &page("New Page", ""));

        let error = link_supersede_at("old.md", "new.md", "reason", &dir)
            .expect_err("missing required fields");

        assert!(error.contains("缺少必需字段"), "unexpected error: {error}");
    }

    #[test]
    fn test_link_supersede_rejects_missing_frontmatter() {
        let dir = temp_dir("missing_frontmatter");
        make_page(&dir, "old.md", "# Old Page\n");
        make_page(&dir, "new.md", &page("New Page", ""));

        let error = link_supersede_at("old.md", "new.md", "reason", &dir)
            .expect_err("no frontmatter");

        assert!(error.contains("frontmatter"), "unexpected error: {error}");
    }

    #[test]
    fn test_link_supersede_same_path() {
        let dir = temp_dir("same_path");
        let result = link_supersede_at("same.md", "same.md", "nope", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不能指向同一个页面"));
    }

    #[test]
    fn test_link_supersede_missing_pages() {
        let dir = temp_dir("missing_pages");
        let result =
            link_supersede_at("nonexistent.md", "other.md", "reason", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("页面不存在"));
    }

    #[test]
    fn test_link_supersede_renders_schema_order() {
        let dir = temp_dir("render_order");
        make_page(&dir, "old.md", &page("Old Page", ""));
        let new_path = make_page(&dir, "new.md", &page("New Page", ""));

        link_supersede_at("old.md", "new.md", "replaces old", &dir)
            .expect("link supersede");

        let text = fs::read_to_string(&new_path).expect("read new page");
        assert_eq!(
            text,
            concat!(
                "---\n",
                "title: New Page\n",
                "type: concept\n",
                "tags: []\n",
                "",
                "timestamp: 2026-07-01T00:00:00Z\n",
                "",
                "supersedes:\n",
                "  - path: old.md\n",
                "    reason: replaces old\n",
                "---\n",
                "\n",
                "# New Page\n",
                "\n",
                "Body.\n",
            )
        );
    }
}
