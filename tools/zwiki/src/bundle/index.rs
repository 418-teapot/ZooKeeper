//! Root index utilities — regenerate and check the wiki root index.md.

use std::path::Path;

use crate::bundle::lock;

/// Append a bundle entry line and its domain entries (indented sub-pages) to
/// the output lines vector.
pub fn append_bundle_entry(
    lines: &mut Vec<String>,
    entry: &lock::ZwikiLockEntry,
    wiki_root: &Path,
) {
    let desc = entry.description.as_deref().unwrap_or("");
    let link = format!("{}{}", entry.target, "index.md");
    if desc.is_empty() {
        lines.push(format!("### [{}]({})", entry.name, link));
    } else {
        lines.push(format!("### [{}]({}) - {}", entry.name, link, desc));
    }
    lines.push(String::new());

    let bundle_abs = wiki_root.join(&entry.target);
    let bundle_index = bundle_abs.join("index.md");

    if bundle_index.exists()
        && let Ok(content) = std::fs::read_to_string(&bundle_index)
    {
        let body = strip_frontmatter(&content);
        for line in body.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('*') && !trimmed.starts_with('-') {
                continue;
            }
            let rewritten = rewrite_link(trimmed, &entry.target);
            lines.push(rewritten.clone());
        }
    }

    lines.push(String::new());
}

/// Remove YAML frontmatter from a string.
pub fn strip_frontmatter(content: &str) -> String {
    if content.starts_with("---") {
        content.splitn(3, "---").nth(2).unwrap_or(content).to_string()
    } else {
        content.to_string()
    }
}

/// Rewrite the first `[text](path)` link in `line` by prefixing relative
/// paths with `target`.  Returns the line unchanged if no link is found.
pub fn rewrite_link(line: &str, target: &str) -> String {
    if let Some(start) = line.find("](") {
        let before = &line[..start + 2];
        let rest = &line[start + 2..];
        if let Some(end) = rest.find(')') {
            let path = &rest[..end];
            let after = &rest[end..];
            if path.starts_with("http") || path.starts_with('/') {
                return format!("{before}{path}{after}");
            }
            return format!("{before}{target}{path}{after}");
        }
    }
    line.to_string()
}

/// OKF schema version used in root index frontmatter and bundle manifests.
pub const OKF_VERSION: &str = "0.1";

/// Write a root `index.md` at the given wiki root that aggregates all installed
/// bundles grouped by kind.  Returns `Ok(())` on success or an error message
/// describing which write operation failed.
pub fn regenerate_root_index_at(
    lock: &lock::ZwikiLock,
    wiki_root: &Path,
) -> Result<(), String> {
    let mut generated: Vec<String> =
        vec!["<!-- ZOO:BUNDLES:BEGIN -->".to_string(), String::new()];

    if lock.bundles.is_empty() {
        generated.push("_暂无已安装的 bundle。_".to_string());
        generated.push(String::new());
    } else {
        let mut teams: Vec<&lock::ZwikiLockEntry> = Vec::new();
        let mut upstreams: Vec<&lock::ZwikiLockEntry> = Vec::new();
        let mut orgs: Vec<&lock::ZwikiLockEntry> = Vec::new();

        for entry in &lock.bundles {
            let target = &entry.target;
            if target.starts_with(".teams/") {
                teams.push(entry);
            } else if target.starts_with(".upstream/") {
                upstreams.push(entry);
            } else if target.starts_with(".org/") {
                orgs.push(entry);
            }
        }

        teams.sort_by(|a, b| a.name.cmp(&b.name));
        upstreams.sort_by(|a, b| a.name.cmp(&b.name));
        orgs.sort_by(|a, b| a.name.cmp(&b.name));

        if !teams.is_empty() {
            generated.push("## 团队 Bundles".to_string());
            generated.push(String::new());
            for entry in &teams {
                append_bundle_entry(&mut generated, entry, wiki_root);
            }
        }

        if !upstreams.is_empty() {
            generated.push("## Upstream Bundles".to_string());
            generated.push(String::new());
            for entry in &upstreams {
                append_bundle_entry(&mut generated, entry, wiki_root);
            }
        }

        if !orgs.is_empty() {
            generated.push("## 组织 Bundles".to_string());
            generated.push(String::new());
            for entry in &orgs {
                append_bundle_entry(&mut generated, entry, wiki_root);
            }
        }
    }

    generated.push("<!-- ZOO:BUNDLES:END -->".to_string());

    let generated_str = generated.join("\n");
    let index_path = wiki_root.join("index.md");

    if index_path.exists() {
        let existing = std::fs::read_to_string(&index_path).unwrap_or_default();
        if existing.contains("<!-- ZOO:BUNDLES:BEGIN -->")
            && existing.contains("<!-- ZOO:BUNDLES:END -->")
        {
            match replace_marked_section(&existing, &generated_str) {
                Ok(updated) => {
                    zutil::fileio::write_atomic(&index_path, &updated)
                        .map_err(|e| {
                            format!(
                                "警告: 无法写入索引文件 {}: {e}",
                                index_path.display()
                            )
                        })?;
                    return Ok(());
                }
                Err(e) => {
                    eprintln!(
                        "警告: 无法更新索引标记 {}: {e}，将覆盖整个文件",
                        index_path.display()
                    );
                }
            }
        }
    }

    let full = format!(
        "---\nokf_version: \"{OKF_VERSION}\"\n---\n\n# Wiki Index\n\n{generated_str}\n"
    );
    zutil::fileio::write_atomic(&index_path, &full).map_err(|e| {
        format!("警告: 无法写入索引文件 {}: {e}", index_path.display())
    })
}

/// Check the root `index.md` for the wiki at `wiki_root`.
pub fn check_root_index(
    wiki_root: &Path,
    lock: &lock::ZwikiLock,
) -> Result<(), String> {
    let index_path = wiki_root.join("index.md");

    if !index_path.exists() || !index_path.is_file() {
        return Err("root index.md 不存在".to_string());
    }

    let content = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("无法读取 root index.md: {e}"))?;

    if !content.contains("<!-- ZOO:BUNDLES:BEGIN -->") {
        return Err("root index.md 缺少 ZOO:BUNDLES 标记（BEGIN）".to_string());
    }

    if !content.contains("<!-- ZOO:BUNDLES:END -->") {
        return Err("root index.md 缺少 ZOO:BUNDLES 标记（END）".to_string());
    }

    for entry in &lock.bundles {
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
/// is a substring prefix of another path (e.g. `.upstream/foo` vs
/// `.upstream/foo-v2/`).
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

/// Replace the content between `<!-- ZOO:BUNDLES:BEGIN -->` and
/// `<!-- ZOO:BUNDLES:END -->` markers in `existing` with `replacement`.
fn replace_marked_section(
    existing: &str,
    replacement: &str,
) -> Result<String, String> {
    let begin = "<!-- ZOO:BUNDLES:BEGIN -->";
    let end = "<!-- ZOO:BUNDLES:END -->";

    let start_pos = existing
        .find(begin)
        .ok_or_else(|| "index.md 缺少 BEGIN 标记".to_string())?;
    let end_pos = existing
        .rfind(end)
        .ok_or_else(|| "index.md 缺少 END 标记".to_string())?;

    if end_pos <= start_pos {
        return Err("index.md 标记顺序错误".to_string());
    }

    let after_end = end_pos + end.len();
    let after_end = if existing[after_end..].starts_with('\n') {
        after_end + 1
    } else {
        after_end
    };

    Ok(format!(
        "{}{}{}",
        &existing[..start_pos],
        replacement,
        &existing[after_end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::*;

    #[test]
    fn test_regenerate_root_index_empty_lock() {
        let tmp = temp_dir("regenerate_index_empty");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock = lock::ZwikiLock::default();
        regenerate_root_index_at(&lock, &wiki_root).unwrap();

        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists(), "index.md should exist");

        let content = std::fs::read_to_string(&index_path).unwrap();
        assert!(content.contains("暂无已安装的 bundle"));
        assert!(content.contains("<!-- ZOO:BUNDLES:BEGIN -->"));
        assert!(content.contains("<!-- ZOO:BUNDLES:END -->"));
        assert!(content.contains("# Wiki Index"));
        assert!(content.contains("okf_version"));
    }

    #[test]
    fn test_regenerate_root_index_with_entries() {
        let tmp = temp_dir("regenerate_index_entries");

        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let team_dir = wiki_root.join(".teams").join("my-team");
        std::fs::create_dir_all(&team_dir).unwrap();
        std::fs::write(
            team_dir.join("index.md"),
            "---\nokf_version: \"0.1\"\n---\n\n# Wiki Index\n\n\
             * [autoresearch](autoresearch/index.md) - 自主实验框架\n\
             * [shared](shared/index.md) - 跨领域概念\n\
             * [overview](overview.md) - 项目概览\n",
        )
        .unwrap();

        let lock = lock::ZwikiLock {
            bundles: vec![
                lock::ZwikiLockEntry {
                    name: "test-upstream".to_string(),
                    version: "1.0".to_string(),
                    registry: String::new(),
                    target: ".upstream/test-upstream/".to_string(),
                    integrity: "sha256-abc".to_string(),
                    installed_at: "2026-01-01T00:00:00Z".to_string(),
                    description: Some("A test upstream bundle".to_string()),
                },
                lock::ZwikiLockEntry {
                    name: "my-team-bundle".to_string(),
                    version: "2.0".to_string(),
                    registry: String::new(),
                    target: ".teams/my-team/".to_string(),
                    integrity: "sha256-def".to_string(),
                    installed_at: "2026-02-01T00:00:00Z".to_string(),
                    description: None,
                },
            ],
            ..Default::default()
        };
        regenerate_root_index_at(&lock, &wiki_root).unwrap();

        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists());

        let content = std::fs::read_to_string(&index_path).unwrap();
        assert!(content.contains("<!-- ZOO:BUNDLES:BEGIN -->"));
        assert!(content.contains("<!-- ZOO:BUNDLES:END -->"));
        assert!(content.contains("## Upstream Bundles"));
        assert!(content.contains("### [test-upstream]"));
        assert!(content.contains("A test upstream bundle"));
        assert!(content.contains("## 团队 Bundles"));
        assert!(content.contains("### [my-team-bundle]"));
        assert!(content.contains("自主实验框架"));
        assert!(content.contains(".teams/my-team/autoresearch/index.md"));
        assert!(content.contains("跨领域概念"));
        assert!(content.contains(".teams/my-team/shared/index.md"));
        assert!(content.contains("项目概览"));
        assert!(content.contains(".teams/my-team/overview.md"));
    }

    #[test]
    fn test_regenerate_root_index_org_kind() {
        let tmp = temp_dir("regenerate_index_org");

        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "my-org".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".org/my-org/".to_string(),
                integrity: "sha256-xyz".to_string(),
                installed_at: "2026-03-01T00:00:00Z".to_string(),
                description: Some("Org bundle".to_string()),
            }],
            ..Default::default()
        };
        regenerate_root_index_at(&lock, &wiki_root).unwrap();

        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists());

        let content = std::fs::read_to_string(&index_path).unwrap();
        assert!(content.contains("## 组织 Bundles"));
        assert!(content.contains("### [my-org]"));
        assert!(content.contains("Org bundle"));
        assert!(content.contains("<!-- ZOO:BUNDLES:END -->"));
    }

    #[test]
    fn test_regenerate_root_index_preserves_user_content() {
        let tmp = temp_dir("regenerate_preserve");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock1 = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "bundle-a".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/bundle-a/".to_string(),
                integrity: "sha256-a".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        regenerate_root_index_at(&lock1, &wiki_root).unwrap();

        let index_path = wiki_root.join("index.md");
        let content1 = std::fs::read_to_string(&index_path).unwrap();
        assert!(content1.contains("### [bundle-a]"));
        assert!(content1.contains("<!-- ZOO:BUNDLES:END -->"));

        let user_note = "\n## 个人笔记\n\n这里是手动添加的内容。\n";
        let with_user = format!("{content1}{user_note}");
        std::fs::write(&index_path, &with_user).unwrap();

        let lock2 = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "bundle-b".to_string(),
                version: "2.0".to_string(),
                registry: String::new(),
                target: ".teams/bundle-b/".to_string(),
                integrity: "sha256-b".to_string(),
                installed_at: "2026-02-01T00:00:00Z".to_string(),
                description: Some("Second bundle".to_string()),
            }],
            ..Default::default()
        };
        regenerate_root_index_at(&lock2, &wiki_root).unwrap();

        let content2 = std::fs::read_to_string(&index_path).unwrap();
        assert!(!content2.contains("bundle-a"));
        assert!(content2.contains("### [bundle-b]"));
        assert!(content2.contains("Second bundle"));
        assert!(
            content2.contains("## 个人笔记"),
            "user content should be preserved"
        );
        assert!(content2.contains("这里是手动添加的内容。"));
        assert!(content2.contains("<!-- ZOO:BUNDLES:BEGIN -->"));
        assert!(content2.contains("<!-- ZOO:BUNDLES:END -->"));
    }

    #[test]
    fn test_check_root_index_missing() {
        let dir = temp_dir("check_root_index_missing");
        let lock = lock::ZwikiLock::default();
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    #[test]
    fn test_check_root_index_missing_begin() {
        let dir = temp_dir("check_root_index_missing_begin");
        std::fs::write(dir.join("index.md"), "no markers here\n").unwrap();
        let lock = lock::ZwikiLock::default();
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("BEGIN"));
    }

    #[test]
    fn test_check_root_index_missing_end() {
        let dir = temp_dir("check_root_index_missing_end");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\ncontent\n",
        )
        .unwrap();
        let lock = lock::ZwikiLock::default();
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("END"));
    }

    #[test]
    fn test_check_root_index_ok() {
        let dir = temp_dir("check_root_index_ok");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n[test](.upstream/test/)\n<!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();
        let lock = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/test/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_ok());
    }

    #[test]
    fn test_check_root_index_bundle_not_referenced() {
        let dir = temp_dir("check_root_index_bundle_not_referenced");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\nother content\n<!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();
        let lock = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/test/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未引用"));
    }

    #[test]
    fn test_check_root_index_substring_no_false_positive() {
        let dir = temp_dir("check_root_index_substring");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n\
             [test-v2](.upstream/test-v2/index.md)\n\
             <!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();
        let lock = lock::ZwikiLock {
            bundles: vec![lock::ZwikiLockEntry {
                name: "test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/test/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("未引用"), "expected not-referenced error: {err}");
    }

    #[test]
    fn test_regenerate_root_index_write_failure_returns_err() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = temp_dir("regenerate_write_fail");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock = lock::ZwikiLock::default();

        // Make the directory read-only so write_atomic fails.
        std::fs::set_permissions(&wiki_root, PermissionsExt::from_mode(0o444))
            .unwrap();

        let result = regenerate_root_index_at(&lock, &wiki_root);

        // Restore permissions so cleanup can remove the temp dir.
        std::fs::set_permissions(&wiki_root, PermissionsExt::from_mode(0o755))
            .unwrap();

        assert!(
            result.is_err(),
            "regenerate should fail on read-only directory"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("无法写入索引文件"),
            "error should mention write failure: {err}"
        );
    }
}
