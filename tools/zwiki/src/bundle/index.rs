//! Store root index — regenerate and check the installed-store `index.md`.
//!
//! The store root index is fully generated: it lives beside `zwiki.lock`
//! and lists every installed bundle.  It has no authored part, so
//! regeneration always overwrites the whole file.

use std::path::Path;

use crate::bundle::lock;

/// OKF schema version used in the store root index frontmatter.
pub const OKF_VERSION: &str = "0.1";

/// Render the generated store root `index.md` content for `lock`.
fn render_store_root_index(lock: &lock::ZwikiLock) -> String {
    let mut entries: Vec<&lock::ZwikiLockEntry> = lock.entries.iter().collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let mut lines: Vec<String> = Vec::new();
    for entry in entries {
        let link = format!("{}index.md", entry.target);
        let description = entry.description.as_deref().unwrap_or("").trim();
        if description.is_empty() {
            lines.push(format!("- [{}]({link})", entry.name));
        } else {
            lines.push(format!("- [{}]({link}) — {description}", entry.name));
        }
    }

    let body = lines.join("\n");
    if body.is_empty() {
        format!("---\nokf_version: \"{OKF_VERSION}\"\n---\n")
    } else {
        format!("---\nokf_version: \"{OKF_VERSION}\"\n---\n\n{body}\n")
    }
}

/// Regenerate the store root `index.md` at `store_root` from `lock`.
///
/// The whole file is generated (the store is read-only, so it has no
/// authored part).
///
/// # Errors
///
/// Returns an error message when the index file cannot be written.
#[must_use = "the returned result must be handled"]
pub fn regenerate_store_root_index(
    lock: &lock::ZwikiLock,
    store_root: &Path,
) -> Result<(), String> {
    let index_path = store_root.join("index.md");
    let content = render_store_root_index(lock);
    zutil::fileio::write_atomic(&index_path, &content).map_err(|e| {
        format!("警告: 无法写入索引文件 {}: {e}", index_path.display())
    })
}

/// (Re)write the store root `SCHEMA.md` from the embedded copy, so the
/// store copy always matches the running binary.
///
/// # Errors
///
/// Returns an error message when the file cannot be written.
#[must_use = "the returned result must be handled"]
pub fn write_store_schema(store_root: &Path) -> Result<(), String> {
    let path = store_root.join("SCHEMA.md");
    zutil::fileio::write_atomic(&path, crate::assets::SCHEMA)
        .map_err(|e| format!("警告: 无法写入 {}: {e}", path.display()))
}

/// Refresh the generated store root files: the `index.md` bundle listing and
/// the embedded `SCHEMA.md`.
///
/// # Errors
///
/// Returns an error message when either file cannot be written.
#[must_use = "the returned result must be handled"]
pub fn regenerate_store_metadata(
    lock: &lock::ZwikiLock,
    store_root: &Path,
) -> Result<(), String> {
    regenerate_store_root_index(lock, store_root)?;
    write_store_schema(store_root)
}

/// Check the store root `index.md` at `store_root` references every
/// installed bundle.
///
/// # Errors
///
/// Returns an error message when the index is missing or does not reference
/// an installed bundle.
#[must_use = "the returned result must be handled"]
pub fn check_root_index(
    store_root: &Path,
    lock: &lock::ZwikiLock,
) -> Result<(), String> {
    let index_path = store_root.join("index.md");

    if !index_path.exists() || !index_path.is_file() {
        return Err("root index.md 不存在".to_string());
    }

    let content = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("无法读取 root index.md: {e}"))?;

    for entry in &lock.entries {
        if !link_contains_target(&content, &entry.target) {
            return Err(format!(
                "root index.md 未引用已安装的 bundle: {}",
                entry.name
            ));
        }
    }

    Ok(())
}

/// Check whether `content` contains a markdown link `[text](url...)` whose URL
/// starts with `target`.  When `target` ends with `/`, any URL under that
/// directory is accepted; otherwise the URL must reach a boundary (`/`, `#`,
/// `)`, or EOF) right after `target`.  This avoids false matches when `target`
/// is a substring prefix of another path (e.g. `foo` vs
/// `foo-v2/`).
fn link_contains_target(content: &str, target: &str) -> bool {
    let mut remaining = content;
    while let Some(pos) = remaining.find("](") {
        let url_start = pos + 2;
        let rest = &remaining[url_start..];
        // Find end of URL: `)`, `#`, or line break
        let url_end = rest.find([')', '#', '\n', '\r']).unwrap_or(rest.len());
        let url = &rest[..url_end];

        if let Some(after) = url.strip_prefix(target)
            && (after.is_empty()
                || after.starts_with('/')
                || after.starts_with('#')
                || target.ends_with('/'))
        {
            return true;
        }

        remaining = &remaining[url_start + url_end..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::*;

    fn entry(
        name: &str,
        target: &str,
        description: Option<&str>,
    ) -> lock::ZwikiLockEntry {
        lock::ZwikiLockEntry {
            name: name.to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: target.to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: description.map(ToString::to_string),
        }
    }

    // -------------------------------------------------------------------
    // regenerate_store_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_store_index_empty_lock() {
        let tmp = temp_dir("store_index_empty");
        let store_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&store_root).unwrap();

        let lock = lock::ZwikiLock::default();
        regenerate_store_root_index(&lock, &store_root).unwrap();

        let content =
            std::fs::read_to_string(store_root.join("index.md")).unwrap();
        assert!(content.contains("okf_version"));
        assert!(!content.contains("- ["));
    }

    #[test]
    fn test_store_index_lists_bundles_with_descriptions() {
        let tmp = temp_dir("store_index_entries");
        let store_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&store_root).unwrap();

        let lock = lock::ZwikiLock {
            entries: vec![
                entry("zeta", "zeta/", Some("Zeta description")),
                entry("alpha", "alpha/", None),
            ],
            ..Default::default()
        };
        regenerate_store_root_index(&lock, &store_root).unwrap();

        let content =
            std::fs::read_to_string(store_root.join("index.md")).unwrap();
        assert!(content.contains("- [alpha](alpha/index.md)"));
        assert!(content.contains("- [zeta](zeta/index.md) — Zeta description"));
        // Sorted by bundle name.
        let alpha = content.find("- [alpha]").unwrap();
        let zeta = content.find("- [zeta]").unwrap();
        assert!(alpha < zeta);
    }

    #[test]
    fn test_store_index_overwrites_user_content() {
        let tmp = temp_dir("store_index_overwrite");
        let store_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&store_root).unwrap();
        std::fs::write(
            store_root.join("index.md"),
            "hand-written content that must be replaced\n",
        )
        .unwrap();

        let lock = lock::ZwikiLock {
            entries: vec![entry("one", "one/", None)],
            ..Default::default()
        };
        regenerate_store_root_index(&lock, &store_root).unwrap();

        let content =
            std::fs::read_to_string(store_root.join("index.md")).unwrap();
        assert!(content.contains("- [one](one/index.md)"));
        assert!(!content.contains("hand-written"));
    }

    #[test]
    fn test_store_metadata_writes_schema() {
        let tmp = temp_dir("store_metadata_schema");
        let store_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&store_root).unwrap();

        let lock = lock::ZwikiLock {
            entries: vec![entry("one", "one/", None)],
            ..Default::default()
        };
        regenerate_store_metadata(&lock, &store_root).unwrap();

        assert!(store_root.join("index.md").exists());
        let schema =
            std::fs::read_to_string(store_root.join("SCHEMA.md")).unwrap();
        assert_eq!(schema, crate::assets::SCHEMA);
    }

    #[test]
    fn test_store_index_write_failure_returns_err() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = temp_dir("store_index_write_fail");
        let store_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&store_root).unwrap();

        std::fs::set_permissions(&store_root, PermissionsExt::from_mode(0o444))
            .unwrap();

        let result = regenerate_store_root_index(
            &lock::ZwikiLock::default(),
            &store_root,
        );

        std::fs::set_permissions(&store_root, PermissionsExt::from_mode(0o755))
            .unwrap();

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无法写入索引文件"));
    }

    // -------------------------------------------------------------------
    // check_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_check_root_index_missing() {
        let dir = temp_dir("check_root_index_missing");
        let result = check_root_index(&dir, &lock::ZwikiLock::default());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    #[test]
    fn test_check_root_index_ok() {
        let dir = temp_dir("check_root_index_ok");
        let lock = lock::ZwikiLock {
            entries: vec![entry("test", "test/", None)],
            ..Default::default()
        };
        std::fs::write(
            dir.join("index.md"),
            "---\nokf_version: \"0.1\"\n---\n\n\
             - [test](test/index.md)\n",
        )
        .unwrap();
        assert!(check_root_index(&dir, &lock).is_ok());
    }

    #[test]
    fn test_check_root_index_bundle_not_referenced() {
        let dir = temp_dir("check_root_index_not_referenced");
        let lock = lock::ZwikiLock {
            entries: vec![entry("test", "test/", None)],
            ..Default::default()
        };
        std::fs::write(dir.join("index.md"), "other content\n").unwrap();
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未引用"));
    }

    #[test]
    fn test_check_root_index_substring_no_false_positive() {
        let dir = temp_dir("check_root_index_substring");
        let lock = lock::ZwikiLock {
            entries: vec![entry("test", "test/", None)],
            ..Default::default()
        };
        std::fs::write(dir.join("index.md"), "- [test-v2](test-v2/index.md)\n")
            .unwrap();
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未引用"));
    }
}
