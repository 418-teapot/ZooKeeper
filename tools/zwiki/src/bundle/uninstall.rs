//! Bundle uninstall — `zwiki bundle uninstall`.

use std::path::Path;

use crate::bundle::args::UninstallArgs;
use crate::bundle::index;
use crate::bundle::lock;
use crate::wiki;

/// Uninstall a bundle by name: remove its directory, lock entry, and
/// regenerate the root index.
pub fn cmd_uninstall(args: &UninstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let wiki_root = wiki::wiki_dir();
    if let Err(msg) = cmd_uninstall_inner(args, use_json, &wiki_root) {
        if !use_json {
            eprintln!("错误: {msg}");
        }
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_uninstall` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
pub fn cmd_uninstall_inner(
    args: &UninstallArgs,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), String> {
    let lock_path = wiki_root.join(".zwiki.flock");
    // NOTE: flock() / fcntl(F_SETLK) is advisory and does NOT work on NFS.
    let result: std::io::Result<Result<(), String>> =
        zutil::fileio::with_file_lock(&lock_path, || {
            let inner: Result<(), String> = (|| {
                let mut l = lock::read_lock_at(wiki_root)?;

                let pos = l.bundles.iter().position(|b| b.name == args.name);
                let entry = if let Some(idx) = pos {
                    l.bundles.remove(idx)
                } else {
                    return Err(if use_json {
                        format!("bundle '{}' not found", args.name)
                    } else {
                        format!("bundle '{}' 未找到", args.name)
                    });
                };

                uninstall_bundle_entry_inner(&l, &entry, wiki_root, use_json)?;

                if use_json {
                    let output = serde_json::json!({
                        "status": "ok",
                        "name": args.name,
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&output).unwrap()
                    );
                } else {
                    println!("已卸载: {}", args.name);
                }

                Ok(())
            })();
            Ok(inner)
        });
    match result {
        Ok(inner) => inner,
        Err(e) => Err(format!("无法获取文件锁: {e}")),
    }
}

/// Internal helper that removes a bundle entry's directory from disk, writes
/// the updated lock, and regenerates the root index.
fn uninstall_bundle_entry_inner(
    l: &lock::ZwikiLock,
    entry: &lock::ZwikiLockEntry,
    wiki_root: &Path,
    use_json: bool,
) -> Result<(), String> {
    let target_abs = wiki_root.join(&entry.target);
    if target_abs.exists() {
        std::fs::remove_dir_all(&target_abs).map_err(|e| {
            if use_json {
                format!("cannot remove '{}': {e}", entry.target)
            } else {
                format!("无法移除 '{}': {e}", entry.target)
            }
        })?;
    }

    lock::write_lock_at(l, wiki_root).map_err(|e| {
        if use_json {
            format!("cannot write lock file: {e}")
        } else {
            format!("无法写入锁文件: {e}")
        }
    })?;

    if let Err(e) = index::regenerate_root_index_at(l, wiki_root) {
        eprintln!("{e}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::args::UninstallArgs;
    use crate::bundle::lock;
    use crate::bundle::testutil::*;

    #[test]
    fn test_uninstall_args_parse() {
        let args = UninstallArgs { name: "my-bundle".to_string(), json: false };
        assert_eq!(args.name, "my-bundle");
        assert!(!args.json);
    }

    #[test]
    fn test_uninstall_args_parse_json() {
        let args = UninstallArgs { name: "my-bundle".to_string(), json: true };
        assert_eq!(args.name, "my-bundle");
        assert!(args.json);
    }

    #[test]
    fn test_uninstall_bundle_entry_removes_dir_and_lock_entry() {
        let tmp = temp_dir("uninstall_entry");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let bundle_dir = wiki_root.join(".upstream").join("test-pkg");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("doc.md"), "content").unwrap();

        let entry = lock::ZwikiLockEntry {
            name: "test-pkg".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-pkg/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let mut l =
            lock::ZwikiLock { bundles: vec![entry], ..Default::default() };

        let lock_path = wiki_root.join("zwiki.lock");
        let lock_toml = toml::to_string_pretty(&l).unwrap();
        std::fs::write(&lock_path, &lock_toml).unwrap();

        assert!(bundle_dir.exists());
        assert!(lock_path.exists());

        let removed_entry = l.bundles.remove(0);
        let result =
            uninstall_bundle_entry_inner(&l, &removed_entry, &wiki_root, false);
        assert!(result.is_ok(), "uninstall should succeed");

        assert!(!bundle_dir.exists(), "bundle dir should be removed");

        let content = std::fs::read_to_string(&lock_path).unwrap();
        let parsed: lock::ZwikiLock = toml::from_str(&content).unwrap();
        assert!(parsed.bundles.is_empty(), "lock should have no entries");

        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists(), "index.md should exist");
        let index_content = std::fs::read_to_string(&index_path).unwrap();
        assert!(
            index_content.contains("暂无已安装的 bundle"),
            "index should indicate no bundles"
        );
    }

    #[test]
    fn test_cmd_uninstall_inner_returns_err_on_not_found() {
        let wiki_root = temp_dir("uninstall_inner_not_found");
        let args =
            UninstallArgs { name: "nonexistent".to_string(), json: false };
        let result = cmd_uninstall_inner(&args, false, &wiki_root);
        assert!(
            result.is_err(),
            "uninstall of non-existent bundle should return Err"
        );
    }
}
