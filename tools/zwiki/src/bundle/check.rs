//! Bundle check — `zwiki bundle check`.

use std::io;
use std::path::{Path, PathBuf};

use crate::bundle::args::CheckArgs;
use crate::bundle::index;
use crate::bundle::lock;
use crate::wiki;

/// Check integrity of installed bundles.
pub fn cmd_check(args: &CheckArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if let Err(msg) =
        cmd_check_inner(use_json, &wiki::wiki_dir(), args.fix, args.dry_run)
    {
        if !use_json {
            eprintln!("错误: {msg}");
        }
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_check` that returns `Result` instead of
/// calling `process::exit`.  Returns `Ok(())` when all bundles are intact
/// (or no bundles are installed), and `Err(())` when issues are found.
///
/// When `fix` is true, a missing or stale root index.md is automatically
/// regenerated instead of returning an error, orphan directories are removed,
/// and stale `.tmp_*` directories from interrupted swaps are
/// cleaned up.
///
/// When `dry_run` is true (implies `fix`-like preview), actions are printed but
/// no files are modified.
pub fn cmd_check_inner(
    use_json: bool,
    wiki_root: &Path,
    fix: bool,
    dry_run: bool,
) -> Result<(), String> {
    let mut l = lock::read_lock_at(wiki_root)?;

    if l.bundles.is_empty() {
        if use_json {
            println!("[]");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        return Ok(());
    }

    // Check root index integrity.
    let mut root_index_fixed = false;
    if let Err(msg) = index::check_root_index(wiki_root, &l) {
        if fix {
            index::regenerate_root_index_at(&l, wiki_root);
            root_index_fixed = true;
            if use_json {
                // Don't emit a separate message in JSON mode — the
                // per-bundle results will follow.
            } else {
                eprintln!("提醒: root index.md 已重新生成");
            }
        } else {
            return Err(msg);
        }
    }

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut has_error = false;

    for entry in &l.bundles {
        let abs_path = wiki_root.join(&entry.target);

        if !abs_path.exists() {
            has_error = true;
            if use_json {
                results.push(serde_json::json!({
                    "name": entry.name,
                    "status": "missing",
                    "note": "directory missing, may be caused by concurrent update",
                }));
            } else {
                println!(
                    "✗ {} MISSING（目标目录缺失，可能因并发更新导致，请重新检查）",
                    entry.name
                );
            }
            continue;
        }

        let actual = lock::compute_integrity(&abs_path);
        if actual == entry.integrity {
            if use_json {
                results.push(serde_json::json!({
                    "name": entry.name,
                    "status": "ok",
                    "expected": entry.integrity,
                    "actual": actual,
                }));
            } else {
                println!("✓ {}", entry.name);
            }
        } else {
            has_error = true;
            if use_json {
                results.push(serde_json::json!({
                    "name": entry.name,
                    "status": "mismatch",
                    "expected": entry.integrity,
                    "actual": actual,
                }));
            } else {
                println!(
                    "✗ {} MISMATCH (expected: {}, actual: {})",
                    entry.name, entry.integrity, actual
                );
            }
        }
    }

    // Orphan scan + fix / dry-run.
    if fix && !dry_run {
        // Apply fix first (uses fresh lock inside flock).
        apply_check_fix_with_lock_at(wiki_root, use_json)?;
        // Then scan orphans with fresh lock state.
        let fresh_l = lock::read_lock_at(wiki_root)?;
        scan_orphan_dirs_at(wiki_root, &fresh_l, &mut results, use_json);
    } else if dry_run {
        // Dry-run: scan and report but don't modify.
        apply_check_fix_cleanup_at(
            wiki_root,
            use_json,
            false,
            true,
            &mut l,
            &mut results,
        )?;
    } else {
        // Non-fix: scan orphans with original lock (read-only, acceptable).
        scan_orphan_dirs_at(wiki_root, &l, &mut results, use_json);
    }

    if use_json {
        let output = serde_json::json!({
            "results": results,
            "root_index_fixed": root_index_fixed,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&output)
                .map_err(|e| { format!("JSON 序列化失败: {e}") })?
        );
    }

    if has_error { Err("检查发现错误".to_string()) } else { Ok(()) }
}

/// Apply `--fix` with file lock: re-read lock inside the lock to get fresh
/// state, preventing races with concurrent install/update.
fn apply_check_fix_with_lock_at(
    wiki_root: &Path,
    use_json: bool,
) -> Result<(), String> {
    let lock_path = wiki_root.join(".zwiki.flock");
    // NOTE: flock() / fcntl(F_SETLK) is advisory and does NOT work on NFS.
    let fix_result: io::Result<()> =
        zutil::fileio::with_file_lock(&lock_path, || -> io::Result<()> {
            let mut fresh_l =
                lock::read_lock_at(wiki_root).map_err(io::Error::other)?;
            let mut dummy_results = Vec::new();
            apply_check_fix_cleanup_at(
                wiki_root,
                use_json,
                true,
                false,
                &mut fresh_l,
                &mut dummy_results,
            )
            .map_err(io::Error::other)?;
            Ok(())
        });
    fix_result.map_err(|e| format!("文件锁操作失败: {e}"))
}

/// Apply `--fix` cleanup or `--dry-run` preview for orphan directories, stale
/// temp directories, and orphan lock entries.
fn apply_check_fix_cleanup_at(
    wiki_root: &Path,
    use_json: bool,
    fix: bool,
    dry_run: bool,
    l: &mut lock::ZwikiLock,
    results: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    let orphan_paths = scan_orphan_paths_at(wiki_root, l);
    let stale_temp_paths = scan_stale_temp_paths_at(wiki_root);

    if dry_run {
        for rel in &orphan_paths {
            if use_json {
                results.push(serde_json::json!({
                    "name": rel,
                    "status": "orphan",
                }));
            } else {
                println!("DRY RUN — would remove orphan directory: {rel}");
            }
        }
        for p in &stale_temp_paths {
            if use_json {
                results.push(serde_json::json!({
                    "name": p.to_string_lossy(),
                    "status": "stale_temp",
                }));
            } else {
                println!(
                    "DRY RUN — would remove stale temp directory: {}",
                    p.display()
                );
            }
        }
    }

    if fix && !dry_run {
        for rel in &orphan_paths {
            let abs = wiki_root.join(rel);
            if abs.exists() {
                if let Err(e) = std::fs::remove_dir_all(&abs) {
                    if !use_json {
                        eprintln!("无法移除孤儿目录 {rel}: {e}");
                    }
                } else if !use_json {
                    eprintln!("已移除孤儿目录: {rel}");
                }
            }
        }
        for p in &stale_temp_paths {
            if p.exists() {
                if let Err(e) = std::fs::remove_dir_all(p) {
                    if !use_json {
                        eprintln!("无法移除临时目录 {}: {e}", p.display());
                    }
                } else if !use_json {
                    eprintln!("已移除临时目录: {}", p.display());
                }
            }
        }

        // Prune orphan lock entries (target directory missing).
        let pre_len = l.bundles.len();
        l.bundles.retain(|entry| {
            let keep = wiki_root.join(&entry.target).exists();
            if !keep && !use_json {
                eprintln!("已移除孤儿锁记录: {}（目标目录缺失）", entry.name);
            }
            keep
        });
        if l.bundles.len() != pre_len {
            lock::write_lock_at(l, wiki_root)
                .map_err(|e| format!("无法写入锁文件: {e}"))?;
            index::regenerate_root_index_at(l, wiki_root);
        }
    }

    Ok(())
}

/// Collect paths of directories under `.upstream/`, `.teams/`, `.org/` that
/// have no matching lock entry (orphan directories).
fn scan_orphan_paths_at(
    wiki_root: &Path,
    lock: &lock::ZwikiLock,
) -> Vec<String> {
    let lock_targets: std::collections::HashSet<&str> =
        lock.bundles.iter().map(|b| b.target.as_str()).collect();
    let mut paths = Vec::new();
    for subdir in &[".upstream", ".teams", ".org"] {
        let dir = wiki_root.join(subdir);
        if !dir.exists() {
            continue;
        }
        let Ok(mut read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        while let Some(Ok(entry)) = read_dir.next() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let rel = format!("{subdir}/{}/", name.to_string_lossy());
            if !lock_targets.contains(rel.as_str()) {
                paths.push(rel);
            }
        }
    }
    paths
}

/// Collect paths of `.tmp_*` directories that remain from
/// interrupted [`atomic_dir_swap`] operations (stale temporary directories).
fn scan_stale_temp_paths_at(wiki_root: &Path) -> Vec<PathBuf> {
    let prefixes = [".tmp_"];
    let scan_dirs = [
        wiki_root.to_path_buf(),
        wiki_root.join(".upstream"),
        wiki_root.join(".teams"),
        wiki_root.join(".org"),
    ];
    let mut paths = Vec::new();
    for dir in &scan_dirs {
        if !dir.exists() {
            continue;
        }
        let Ok(mut read_dir) = std::fs::read_dir(dir) else {
            continue;
        };
        while let Some(Ok(entry)) = read_dir.next() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if prefixes.iter().any(|p| name.starts_with(p)) {
                paths.push(entry.path());
            }
        }
    }
    paths
}

/// Scan `.upstream/`, `.teams/`, `.org/` for directories that have no
/// matching lock entry and report them as orphans.
fn scan_orphan_dirs_at(
    wiki_root: &Path,
    lock: &lock::ZwikiLock,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
) {
    let paths = scan_orphan_paths_at(wiki_root, lock);
    for rel in &paths {
        if use_json {
            results.push(serde_json::json!({
                "name": rel,
                "status": "orphan",
            }));
        } else {
            println!("提醒: {rel} 目录无对应锁记录（孤立）");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::lock;
    use crate::bundle::testutil::*;

    #[test]
    fn test_cmd_check_inner_returns_err_on_mismatch() {
        let wiki_root = temp_dir("check_inner_mismatch");
        let bundle_dir = wiki_root.join(".upstream").join("test-bundle");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("test.md"), "content").unwrap();

        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-different".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let l = lock::ZwikiLock { bundles: vec![entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&l).unwrap(),
        )
        .unwrap();

        let result = cmd_check_inner(false, &wiki_root, false, false);
        assert!(result.is_err(), "mismatched integrity should return Err");
    }

    #[test]
    fn test_cmd_check_inner_fix_cleans_orphans() {
        let wiki_root = temp_dir("check_inner_fix_orphans");
        let upstream = wiki_root.join(".upstream");
        let bundle_dir = upstream.join("test-bundle");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("test.md"), "content").unwrap();

        // Valid lock entry for test-bundle.
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: lock::compute_integrity(&bundle_dir),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let l = lock::ZwikiLock { bundles: vec![entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&l).unwrap(),
        )
        .unwrap();

        // Orphan directory — exists but no lock entry.
        let orphan_dir = upstream.join("orphan-bundle");
        std::fs::create_dir_all(&orphan_dir).unwrap();
        std::fs::write(orphan_dir.join("orphan.md"), "orphan").unwrap();

        // Stale temp directory from interrupted atomic_dir_swap.
        let stale_temp = wiki_root.join(".tmp_stale");
        std::fs::create_dir_all(&stale_temp).unwrap();
        std::fs::write(stale_temp.join("data.md"), "stale").unwrap();

        // Run fix.
        let result = cmd_check_inner(false, &wiki_root, true, false);
        assert!(result.is_ok(), "fix should succeed");

        // Assert orphan directory removed.
        assert!(!orphan_dir.exists(), "orphan directory should be removed");

        // Assert stale temp directory removed.
        assert!(!stale_temp.exists(), "stale temp directory should be removed");

        // Assert lock still valid — entry intact.
        let lock_after = lock::read_lock_at(&wiki_root).unwrap();
        assert_eq!(lock_after.bundles.len(), 1);
        assert_eq!(lock_after.bundles[0].name, "test-bundle");
    }

    #[test]
    fn test_cmd_check_inner_dry_run() {
        let wiki_root = temp_dir("check_inner_dry_run");
        let upstream = wiki_root.join(".upstream");
        let bundle_dir = upstream.join("test-bundle");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("test.md"), "content").unwrap();

        // Valid lock entry for test-bundle.
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: lock::compute_integrity(&bundle_dir),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let l = lock::ZwikiLock { bundles: vec![entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&l).unwrap(),
        )
        .unwrap();

        // Create valid root index.md for check_root_index.
        let index_content =
            "---\nokf_version: \"0.1\"\n---\n\n# Wiki Index\n\n\
             <!-- ZOO:BUNDLES:BEGIN -->\n\n\
             ## Upstream Bundles\n\n\
             - [test-bundle](.upstream/test-bundle/)\n\n\
             <!-- ZOO:BUNDLES:END -->\n"
                .to_string();
        std::fs::write(wiki_root.join("index.md"), &index_content).unwrap();

        // Orphan directory — exists but no lock entry.
        let orphan_dir = upstream.join("orphan-bundle");
        std::fs::create_dir_all(&orphan_dir).unwrap();
        std::fs::write(orphan_dir.join("orphan.md"), "orphan").unwrap();

        // Stale temp directory from interrupted atomic_dir_swap.
        let stale_temp = wiki_root.join(".tmp_stale");
        std::fs::create_dir_all(&stale_temp).unwrap();
        std::fs::write(stale_temp.join("data.md"), "stale").unwrap();

        // Run dry-run.
        let result = cmd_check_inner(false, &wiki_root, false, true);
        assert!(result.is_ok(), "dry-run should succeed");

        // Assert orphan directory still exists (not removed).
        assert!(
            orphan_dir.exists(),
            "orphan directory should still exist in dry-run",
        );

        // Assert stale temp directory still exists (not removed).
        assert!(
            stale_temp.exists(),
            "stale temp directory should still exist in dry-run",
        );
    }
}
