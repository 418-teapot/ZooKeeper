//! Bundle update — `zwiki bundle update`.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tempfile::TempDir;

use crate::bundle::args::UpdateArgs;
use crate::bundle::http;
use crate::bundle::index;
use crate::bundle::install;
use crate::bundle::lock;
use crate::bundle::manifest;
use crate::bundle::source;
use crate::bundle::tar;
use crate::wiki;

/// Compare two version strings by splitting on `.` and comparing numeric
/// components element-wise. Pre-release suffixes (e.g. `-beta`, `-rc1`) are
/// handled per semver: a version with a pre-release suffix is less than the
/// same version without one; if both have suffixes, they are compared
/// lexicographically.
fn cmp_version(a: &str, b: &str) -> Ordering {
    // Split on '-' to separate core version from pre-release suffix.
    let (core_a, pre_a) =
        a.split_once('-').map_or((a, None), |(c, p)| (c, Some(p)));
    let (core_b, pre_b) =
        b.split_once('-').map_or((b, None), |(c, p)| (c, Some(p)));

    // Compare core numeric parts.
    let parts_a: Vec<&str> = core_a.split('.').collect();
    let parts_b: Vec<&str> = core_b.split('.').collect();
    let max_len = parts_a.len().max(parts_b.len());
    for i in 0..max_len {
        let na: u64 = parts_a.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
        let nb: u64 = parts_b.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
        match na.cmp(&nb) {
            Ordering::Equal => {}
            non_eq => return non_eq,
        }
    }

    // Core versions are equal — compare pre-release suffixes.
    match (pre_a, pre_b) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Less, // "1.0.0-beta" < "1.0.0"
        (None, Some(_)) => Ordering::Greater, // "1.0.0" > "1.0.0-beta"
        (Some(pa), Some(pb)) => pa.cmp(pb), // lexicographic
    }
}

/// Push a skipped result entry (JSON mode) or print to stdout (non-JSON
/// mode).
fn push_skip(
    results: &mut Vec<serde_json::Value>,
    name: &str,
    from: &str,
    to: &str,
    reason: &str,
    use_json: bool,
) {
    if use_json {
        results.push(serde_json::json!({
            "name": name, "status": "skipped", "from": from, "to": to,
            "reason": reason,
        }));
    } else {
        println!("已跳过: {name} ({reason})");
    }
}

/// Push an "updated" success result entry (JSON mode) or print to stdout (non-JSON mode).
fn push_updated(
    results: &mut Vec<serde_json::Value>,
    name: &str,
    from: &str,
    to: &str,
    use_json: bool,
) {
    if use_json {
        results.push(serde_json::json!({
            "name": name, "status": "updated", "from": from, "to": to,
            "reason": "ok",
        }));
    } else {
        println!("已更新: {name} {from} → {to}");
    }
}

/// Push an error result entry (JSON mode) or print to stderr (non-JSON mode).
fn push_err(
    results: &mut Vec<serde_json::Value>,
    name: &str,
    from: &str,
    to: &str,
    reason: &str,
    use_json: bool,
) {
    if use_json {
        results.push(serde_json::json!({
            "name": name, "status": "error", "from": from, "to": to,
            "reason": reason,
        }));
    } else {
        eprintln!("错误: {name}: {reason}");
    }
}

/// Fetch the remote `bundle.toml` content from the registry base URL.
fn fetch_remote_bundle_toml(base_url: &str) -> Result<String, String> {
    let bundle_url = format!("{base_url}/bundle.toml");
    let resp = match http::http_client().get(&bundle_url).send() {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let status = r.status();
            let _ = r.text();
            return Err(format!("获取 bundle.toml 失败 (HTTP {status})"));
        }
        Err(e) => {
            return Err(format!("无法访问 registry: {e}"));
        }
    };
    if let Some(cl) = resp.content_length()
        && cl > http::MAX_BUNDLE_SIZE
    {
        return Err(format!(
            "bundle.toml too large: {cl} bytes (max {})",
            http::MAX_BUNDLE_SIZE
        ));
    }
    http::read_body_capped_string(resp)
        .map_err(|e| format!("无法读取 bundle.toml: {e}"))
}

fn fetch_remote_manifest(
    entry: &lock::ZwikiLockEntry,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
    force: bool,
) -> Option<(String, String, Option<String>)> {
    if entry.registry.is_empty() {
        if use_json {
            results.push(serde_json::json!({
                "name": entry.name, "status": "skipped",
                "from": entry.version, "to": entry.version,
                "reason": "未配置 registry",
            }));
        } else {
            eprintln!("跳过 '{}'：未配置 registry", entry.name);
        }
        return None;
    }
    let base_url = entry.registry.trim_end_matches('/').to_string();
    let bundle_content = match fetch_remote_bundle_toml(&base_url) {
        Ok(c) => c,
        Err(msg) => {
            push_err(
                results,
                &entry.name,
                &entry.version,
                &entry.version,
                &msg,
                use_json,
            );
            return None;
        }
    };
    let remote: manifest::BundleManifest = match toml::from_str(&bundle_content)
    {
        Ok(m) => m,
        Err(e) => {
            push_err(
                results,
                &entry.name,
                &entry.version,
                &entry.version,
                format!("无效的 bundle.toml: {e}").as_str(),
                use_json,
            );
            return None;
        }
    };
    if remote.package.name != entry.name {
        push_err(
            results,
            &entry.name,
            &entry.version,
            &entry.version,
            format!(
                "远程 bundle 名称不匹配: 期望 '{}'，实际 '{}'",
                entry.name, remote.package.name
            )
            .as_str(),
            use_json,
        );
        return None;
    }
    let remote_version = remote.package.version;
    let remote_description = remote.package.description;
    let rv = remote_version.clone();
    check_remote_version(rv, entry, results, use_json, base_url, force)
        .map(|(base_url, _)| (base_url, remote_version, remote_description))
}

/// Compare the remote version with the local entry version and emit
/// appropriate result entries.
///
/// When `force` is false and the remote version is older than local, the
/// update is skipped (status `"skipped"`) instead of auto-downgrading.
fn check_remote_version(
    remote_version: String,
    entry: &lock::ZwikiLockEntry,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
    base_url: String,
    force: bool,
) -> Option<(String, String)> {
    if remote_version == entry.version {
        if use_json {
            results.push(serde_json::json!({
                "name": entry.name, "status": "skipped",
                "from": entry.version, "to": entry.version,
                "reason": "已是最新版本",
            }));
        } else {
            println!("{} 已是最新版本", entry.name);
        }
        return None;
    }

    if cmp_version(&remote_version, &entry.version) == Ordering::Less {
        if !force {
            if use_json {
                results.push(serde_json::json!({
                    "name": entry.name, "status": "skipped",
                    "from": entry.version, "to": remote_version,
                    "reason": "remote version is older than local, use --force to downgrade",
                }));
            } else {
                eprintln!(
                    "跳过 '{}'：远端版本 {} 低于本地版本 {}，使用 --force 降级",
                    entry.name, remote_version, entry.version
                );
            }
            return None;
        }

        if use_json {
            results.push(serde_json::json!({
                "name": entry.name, "status": "downgrade",
                "from": entry.version, "to": remote_version,
                "reason": "remote version is older than local, downgrading (--force)",
            }));
        } else {
            eprintln!(
                "⚠️  远端版本 {} 低于本地版本 {}，将强制降级",
                remote_version, entry.version
            );
        }
    }

    Some((base_url, remote_version))
}

/// Download the updated tar.gz for a bundle, extract it to a temp directory,
/// and verify `bundle.toml` exists.
fn download_and_extract_update_tar(
    base_url: &str,
    name: &str,
    remote_version: &str,
    entry_version: &str,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
) -> Option<(TempDir, PathBuf)> {
    let tar_url = format!("{base_url}/{name}-{remote_version}.tar.gz");
    let tar_resp = match http::http_client().get(&tar_url).send() {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let status = r.status();
            let _ = r.text();
            push_err(
                results,
                name,
                entry_version,
                remote_version,
                format!("下载 tar.gz 失败 (HTTP {status})").as_str(),
                use_json,
            );
            return None;
        }
        Err(e) => {
            push_err(
                results,
                name,
                entry_version,
                remote_version,
                format!("无法下载 tar.gz: {e}").as_str(),
                use_json,
            );
            return None;
        }
    };
    let tmp = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => {
            push_err(
                results,
                name,
                entry_version,
                remote_version,
                format!("无法创建临时目录: {e}").as_str(),
                use_json,
            );
            return None;
        }
    };
    let bytes = match http::read_body_capped(tar_resp) {
        Ok(b) => b,
        Err(e) => {
            push_err(
                results,
                name,
                entry_version,
                remote_version,
                format!("无法读取 tar.gz 内容: {e}").as_str(),
                use_json,
            );
            return None;
        }
    };
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = ::tar::Archive::new(decoder);
    if let Err(e) = tar::safe_unpack(&mut archive, tmp.path()) {
        push_err(
            results,
            name,
            entry_version,
            remote_version,
            format!("无法解压 tar.gz: {e}").as_str(),
            use_json,
        );
        return None;
    }
    let src_bundle_toml = tmp.path().join("bundle.toml");
    if !src_bundle_toml.exists() {
        push_err(
            results,
            name,
            entry_version,
            remote_version,
            "下载的包中未找到 bundle.toml",
            use_json,
        );
        return None;
    }
    Some((tmp, src_bundle_toml))
}

/// Copy updated bundle files into a staging directory, run validation,
/// and compute integrity.  Returns the `TempDir` (kept alive) and integrity
/// hash, or `Err(())` if validation or file operations fail.
fn prepare_update_staging(
    target_abs: &Path,
    src_path: &Path,
    src_bundle_toml: &Path,
    use_json: bool,
) -> Result<(TempDir, String), String> {
    let parent = target_abs.parent().unwrap_or_else(|| Path::new("."));
    // Ensure the parent directory exists — TempDir::new_in will fail if the
    // parent does not exist (e.g. when the target path is nested deeper than
    // the current wiki layout).
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建目标父目录: {e}"))?;
    let staging = TempDir::new_in(parent)
        .map_err(|e| format!("无法创建临时目录: {e}"))?;

    tar::copy_recursive(src_path, staging.path(), true)
        .map_err(|e| format!("无法复制文件: {e}"))?;

    std::fs::copy(src_bundle_toml, staging.path().join("bundle.toml"))
        .map_err(|e| format!("无法复制 bundle.toml: {e}"))?;

    // Validate bundle structure before installing
    source::check_bundle_structure(staging.path(), use_json)?;

    // Run health + lint checks before installing
    let (health_results, lint_results, health_issues, lint_issues) =
        crate::run_health_lint_at(staging.path());
    let total = health_issues + lint_issues;
    if total > 0 {
        if use_json {
            let details =
                crate::format_health_lint_json(&health_results, &lint_results);
            let mut output = serde_json::json!({
                "status": "fatal",
                "error": format!("check: {total} issues"),
                "health": health_issues,
                "lint": lint_issues,
            });
            output["details"] = details;
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            eprintln!(
                "{}",
                crate::display::format_check_report(&health_results)
            );
            eprintln!("{}", crate::display::format_lint_report(&lint_results));
            eprintln!(
                "✗ {total} 个问题（health: {health_issues}, lint: {lint_issues}）"
            );
        }
        return Err(format!("更新前检查未通过: {total} 个问题"));
    }

    let integrity = lock::compute_integrity(staging.path());
    Ok((staging, integrity))
}

/// Dry-run implementation for `cmd_update_at`: preview updates without
/// downloading or modifying files.
fn cmd_update_dry_run_at(
    pending: &[lock::ZwikiLockEntry],
    use_json: bool,
    force: bool,
) -> i32 {
    let mut dry_results: Vec<serde_json::Value> = Vec::new();
    for entry in pending {
        if let Some((_base_url, remote_version, _remote_desc)) =
            fetch_remote_manifest(entry, &mut dry_results, use_json, force)
        {
            if use_json {
                dry_results.push(serde_json::json!({
                    "name": entry.name,
                    "status": "would-update",
                    "from": entry.version,
                    "to": remote_version,
                }));
            } else {
                println!(
                    "{}: {} → {}",
                    entry.name, entry.version, remote_version
                );
            }
        }
    }
    if use_json {
        match serde_json::to_string_pretty(&dry_results) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("JSON 序列化失败: {e}");
                return 1;
            }
        }
    } else {
        println!("DRY RUN — 未修改任何文件");
    }
    0
}

/// A bundle that has been downloaded and validated (Phase 2), ready for
/// atomic commit under the file lock in Phase 3.
struct PendingUpdate {
    entry: lock::ZwikiLockEntry,
    staging: TempDir,
    integrity: String,
    remote_version: String,
    remote_description: Option<String>,
}

/// Update installed bundles from their configured registry, using an explicit
/// `wiki_root` so it can be tested without touching the real wiki directory.
///
/// Uses a 3-phase approach to minimise lock hold time:
/// 1. Under lock: read the lock file and clone pending entries
/// 2. Outside lock: download, extract and validate each bundle
/// 3. Re-acquire lock: atomically swap staging → target, write lock, regenerate index
// Phase 2: download, extract, and validate bundles outside file lock.
// Returns `(prepared_updates, had_error)`. When `had_error` is `true` the
// caller must not proceed to Phase 3.
fn phase2_download_and_prepare(
    pending: &[lock::ZwikiLockEntry],
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
    force: bool,
    wiki_root: &Path,
) -> (Vec<PendingUpdate>, bool) {
    let mut prepared_updates: Vec<PendingUpdate> = Vec::new();
    let mut had_error = false;

    for entry in pending {
        let Some((base_url, remote_version, remote_description)) =
            fetch_remote_manifest(entry, results, use_json, force)
        else {
            continue;
        };

        let Some((tmp, src_bundle_toml)) = download_and_extract_update_tar(
            &base_url,
            &entry.name,
            &remote_version,
            &entry.version,
            results,
            use_json,
        ) else {
            continue;
        };

        let target_abs = wiki_root.join(&entry.target);

        match prepare_update_staging(
            &target_abs,
            tmp.path(),
            &src_bundle_toml,
            use_json,
        ) {
            Ok((staging, integrity)) => {
                prepared_updates.push(PendingUpdate {
                    entry: entry.clone(),
                    staging,
                    integrity,
                    remote_version,
                    remote_description,
                });
            }
            Err(msg) => {
                if use_json {
                    results.push(serde_json::json!({
                        "name": entry.name,
                        "status": "error",
                        "from": entry.version,
                        "to": entry.version,
                        "reason": msg,
                    }));
                } else {
                    eprintln!("错误: {}: {msg}", entry.name);
                }
                had_error = true;
            }
        }
    }

    (prepared_updates, had_error)
}

/// Phase 3 of bundle update: re-acquire the file lock, atomically swap each
/// staging directory into its target location, update the lock entries, write
/// the lock, and regenerate the root index.
///
/// Returns `(json_success_entries, had_error)`.  On partial failure the lock
/// is written with whatever succeeded (partial lock persistence).
fn phase3_commit_updates(
    prepared_updates: Vec<PendingUpdate>,
    use_json: bool,
    wiki_root: &Path,
    lock_path: &Path,
) -> (Vec<serde_json::Value>, bool) {
    let mut commit_error = false;
    let mut success_entries: Vec<serde_json::Value> = Vec::new();
    let phase3_result: std::io::Result<()> =
        zutil::fileio::with_file_lock(lock_path, || {
            phase3_apply_updates(
                prepared_updates,
                use_json,
                wiki_root,
                &mut success_entries,
                &mut commit_error,
            )
        });

    if let Err(ref e) = phase3_result
        && !commit_error
    {
        let msg = format!("更新失败: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
    }

    (success_entries, commit_error || phase3_result.is_err())
}

/// Apply updates under the lock — read current lock, process each pending
/// update, write the lock, and regenerate the root index.
///
/// Returns `Ok(())` on success.  On partial failure the lock is written
/// with whatever succeeded (partial lock persistence).
fn phase3_apply_updates(
    prepared_updates: Vec<PendingUpdate>,
    use_json: bool,
    wiki_root: &Path,
    success_entries: &mut Vec<serde_json::Value>,
    commit_error: &mut bool,
) -> std::io::Result<()> {
    let mut l = lock::read_lock_at(wiki_root).map_err(std::io::Error::other)?;
    for PendingUpdate {
        entry,
        staging,
        integrity,
        remote_version,
        remote_description,
    } in prepared_updates
    {
        // Invariant 1: bundle was concurrently uninstalled during Phase 2.
        let Some(current) = l.bundles.iter().find(|b| b.name == entry.name)
        else {
            push_skip(
                &mut *success_entries,
                &entry.name,
                &entry.version,
                &entry.version,
                "bundle was concurrently uninstalled",
                use_json,
            );
            continue;
        };

        // Invariant 2: already at target version (concurrent update raced us).
        if current.version == remote_version {
            push_skip(
                &mut *success_entries,
                &entry.name,
                &entry.version,
                &remote_version,
                "已被并发更新到目标版本",
                use_json,
            );
            continue;
        }
        // Invariant 3: locally modified since Phase 1 snapshot.
        if current.version != entry.version {
            push_skip(
                &mut *success_entries,
                &entry.name,
                &entry.version,
                &remote_version,
                "本地版本已被并发修改",
                use_json,
            );
            continue;
        }
        let target_abs = wiki_root.join(&entry.target);
        // Ensure target parent directory exists (robustness).
        let _ = target_abs.parent().map(std::fs::create_dir_all);

        if let Err(msg) =
            install::atomic_dir_swap(staging, &target_abs, use_json)
        {
            push_err(
                &mut *success_entries,
                &entry.name,
                &entry.version,
                &remote_version,
                &msg,
                use_json,
            );
            *commit_error = true; // Write partial lock with what we have committed so far
            let _ = lock::write_lock_at(&l, wiki_root);
            if let Err(e) = index::regenerate_root_index_at(&l, wiki_root) {
                eprintln!("{e}");
            }
            return Err(std::io::Error::other(msg));
        }

        let installed_at = Utc::now().to_rfc3339();
        let updated_entry = lock::ZwikiLockEntry {
            name: entry.name.clone(),
            version: remote_version.clone(),
            registry: entry.registry.clone(),
            target: entry.target.clone(),
            integrity: integrity.clone(),
            installed_at,
            description: remote_description.or(entry.description),
        };
        lock::upsert_bundle(&mut l, updated_entry, true)
            .map_err(std::io::Error::other)?;
        push_updated(
            &mut *success_entries,
            &entry.name,
            &entry.version,
            &remote_version,
            use_json,
        );
    }

    lock::write_lock_at(&l, wiki_root)?;
    if let Err(e) = index::regenerate_root_index_at(&l, wiki_root) {
        eprintln!("{e}");
    }
    Ok(())
}
/// Update installed bundles from their configured registry, using an explicit
/// `wiki_root` so it can be tested without touching the real wiki directory.
///
/// Uses a 3-phase approach to minimise lock hold time:
/// 1. Under lock: read the lock file and clone pending entries
/// 2. Outside lock: download, extract and validate each bundle
/// 3. Re-acquire lock: atomically swap staging → target, write lock, regenerate index
pub fn cmd_update_at(args: &UpdateArgs, use_json: bool, wiki_root: &Path) {
    let lock_path = wiki_root.join(".zwiki.flock");
    // NOTE: flock() / fcntl(F_SETLK) is advisory and does NOT work on NFS.

    // ------------------------------------------------------------------
    // Phase 1 — Under lock: read + clone + drop
    // ------------------------------------------------------------------
    let pending: Vec<lock::ZwikiLockEntry> =
        match zutil::fileio::with_file_lock(&lock_path, || {
            let l =
                lock::read_lock_at(wiki_root).map_err(std::io::Error::other)?;
            Ok(l.bundles
                .iter()
                .filter(|b| args.name.as_ref().is_none_or(|n| b.name == *n))
                .cloned()
                .collect())
        }) {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("读取 bundle 状态失败: {e}");
                if use_json {
                    eprintln!("{msg}");
                } else {
                    eprintln!("错误: {msg}");
                }
                std::process::exit(1);
            }
        };
    // Lock is DROPPED here — Phase 2 runs entirely outside the lock.

    // Handle empty pending
    if pending.is_empty() {
        if use_json {
            if let Some(ref name) = args.name {
                let output = serde_json::json!({
                    "status": "not-found",
                    "name": name,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            } else {
                println!("[]");
            }
        } else if let Some(ref name) = args.name {
            eprintln!("bundle '{name}' 未找到");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        return;
    }

    // Dry-run: preview updates without downloading or modifying files.
    if args.dry_run {
        let code = cmd_update_dry_run_at(&pending, use_json, args.force);
        if code != 0 {
            std::process::exit(code);
        }
        return;
    }

    // ------------------------------------------------------------------
    // Phase 2 — Outside lock: download + extract + validate (no HTTP under lock)
    // ------------------------------------------------------------------
    let mut results: Vec<serde_json::Value> = Vec::new();
    let (prepared_updates, _had_error) = phase2_download_and_prepare(
        &pending,
        &mut results,
        use_json,
        args.force,
        wiki_root,
    );

    // Handle empty prepared_updates (all failed)
    if prepared_updates.is_empty() {
        if use_json {
            if let Ok(s) = serde_json::to_string_pretty(&results) {
                println!("{s}");
            }
        } else {
            eprintln!("没有可更新的 bundle");
        }
        return;
    }

    // ------------------------------------------------------------------
    // Phase 3 — Re-acquire lock: atomic swaps → write lock → regenerate
    // ------------------------------------------------------------------
    if !prepared_updates.is_empty() {
        let (success_entries, commit_error) = phase3_commit_updates(
            prepared_updates,
            use_json,
            wiki_root,
            &lock_path,
        );

        results.extend(success_entries);

        if commit_error {
            if use_json && let Ok(s) = serde_json::to_string_pretty(&results) {
                println!("{s}");
            }
            return;
        }
    }

    // All done — print JSON summary if needed (also handles up-to-date case)
    if use_json && let Ok(s) = serde_json::to_string_pretty(&results) {
        println!("{s}");
    }
}

/// Update installed bundles from their configured registry.
pub fn cmd_update(args: &UpdateArgs, global_json: bool) {
    let use_json = args.json || global_json;
    cmd_update_at(args, use_json, &wiki::wiki_dir());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::args::UpdateArgs;
    use crate::bundle::lock;
    use crate::bundle::testutil::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn test_cmp_version_equal() {
        assert_eq!(cmp_version("1.0.0", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn test_cmp_version_greater() {
        assert_eq!(cmp_version("2.0.0", "1.0.0"), Ordering::Greater);
        assert_eq!(cmp_version("1.1.0", "1.0.0"), Ordering::Greater);
        assert_eq!(cmp_version("1.0.1", "1.0.0"), Ordering::Greater);
    }

    #[test]
    fn test_cmp_version_less() {
        assert_eq!(cmp_version("1.0.0", "2.0.0"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0", "1.1.0"), Ordering::Less);
    }

    #[test]
    fn test_cmp_version_different_lengths() {
        assert_eq!(cmp_version("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(cmp_version("2.0", "1.0.0"), Ordering::Greater);
        assert_eq!(cmp_version("1.0", "2.0.0"), Ordering::Less);
    }

    #[test]
    fn test_cmp_version_non_numeric_fallback() {
        // Non-numeric parts (e.g. "0-alpha") fail to parse as u64 and
        // fall back to 0 — both sides are 0, so the core version is equal.
        // Pre-release suffixes are compared lexicographically.
        assert_eq!(cmp_version("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0-beta", "1.0.0-alpha"), Ordering::Greater);
    }

    #[test]
    fn test_cmp_version_pre_release_less() {
        // "1.0.0-beta" < "1.0.0" (pre-release is less than release)
        assert_eq!(cmp_version("1.0.0-beta", "1.0.0"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0-rc1", "1.0.0"), Ordering::Less);
    }

    #[test]
    fn test_cmp_version_pre_release_greater() {
        // "1.0.0" > "1.0.0-beta" (release is greater than pre-release)
        assert_eq!(cmp_version("1.0.0", "1.0.0-beta"), Ordering::Greater);
        assert_eq!(cmp_version("1.0.0", "1.0.0-rc1"), Ordering::Greater);
    }

    #[test]
    fn test_cmp_version_pre_release_lexicographic() {
        // Both have pre-release suffixes — compare lexicographically.
        assert_eq!(cmp_version("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0-beta", "1.0.0-rc1"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0-rc1", "1.0.0-beta"), Ordering::Greater);
        assert_eq!(cmp_version("1.0.0-alpha", "1.0.0-alpha"), Ordering::Equal);
    }

    #[test]
    fn test_push_err_non_json() {
        let mut results: Vec<serde_json::Value> = Vec::new();
        push_err(&mut results, "test-pkg", "1.0", "2.0", "some error", false);
        assert!(results.is_empty(), "non-JSON should not push to results");
    }

    #[test]
    fn test_push_err_json() {
        let mut results: Vec<serde_json::Value> = Vec::new();
        push_err(&mut results, "test-pkg", "1.0", "2.0", "some error", true);
        assert_eq!(results.len(), 1, "JSON should push a result entry");
        let entry = &results[0];
        assert_eq!(entry["name"], "test-pkg");
        assert_eq!(entry["status"], "error");
        assert_eq!(entry["from"], "1.0");
        assert_eq!(entry["to"], "2.0");
        assert_eq!(entry["reason"], "some error");
    }

    #[test]
    fn test_fetch_remote_manifest_downgrade_hint() {
        let remote_toml = br#"[package]
name = "downgrade-test"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let toml = remote_toml.to_vec();

        let server = std::thread::spawn(move || {
            for mut stream in listener.incoming().take(1).flatten() {
                let mut buf = [0u8; 4096];
                if stream.read(&mut buf).is_err() {
                    break;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Length: {}\r\n\
                     Content-Type: text/plain\r\n\
                     Connection: close\r\n\
                     \r\n",
                    toml.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&toml);
                let _ = stream.flush();
            }
        });

        let entry = lock::ZwikiLockEntry {
            name: "downgrade-test".to_string(),
            version: "2.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/downgrade-test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };

        let mut results = Vec::new();
        let result = fetch_remote_manifest(&entry, &mut results, true, true);

        assert!(
            result.is_some(),
            "fetch_remote_manifest should return Some for forced downgrade"
        );
        let (_base_url, remote_version, _remote_description) = result.unwrap();
        assert_eq!(remote_version, "1.0.0");

        let downgrade_entry = results.iter().find(|r| {
            r.get("status").and_then(|s| s.as_str()) == Some("downgrade")
        });
        assert!(
            downgrade_entry.is_some(),
            "results should contain a downgrade entry"
        );
        if let Some(entry) = downgrade_entry {
            assert_eq!(entry["name"], "downgrade-test");
            assert_eq!(entry["from"], "2.0.0");
            assert_eq!(entry["to"], "1.0.0");
        }

        server.join().unwrap();
    }

    #[test]
    fn test_cmd_update_at_handles_staging_error_gracefully() {
        let bundle_toml_content = br#"[package]
name = "test-bundle"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;

        let tar_gz_bytes = tar::raw_tar_gz("bundle.toml", bundle_toml_content);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let tar_gz = tar_gz_bytes;

        let server = std::thread::spawn(move || {
            for mut stream in listener.incoming().take(2).flatten() {
                let mut buf = [0u8; 4096];
                if stream.read(&mut buf).is_err() {
                    break;
                }
                let request = String::from_utf8_lossy(&buf);
                let (body, content_type) = if request.contains("bundle.toml") {
                    (bundle_toml_content.to_vec(), "text/plain")
                } else {
                    (tar_gz.clone(), "application/gzip")
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Length: {}\r\n\
                     Content-Type: {content_type}\r\n\
                     Connection: close\r\n\
                     \r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });

        let wiki_root = temp_dir("update_err_copy");
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock =
            lock::ZwikiLock { bundles: vec![entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        let upstream = wiki_root.join(".upstream");
        std::fs::create_dir_all(&upstream).unwrap();
        std::fs::set_permissions(&upstream, PermissionsExt::from_mode(0o444))
            .unwrap();

        let args = UpdateArgs {
            name: Some("test-bundle".to_string()),
            force: false,
            json: false,
            dry_run: false,
        };

        let test_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_update_at(&args, false, &wiki_root);
            }));

        let _ = std::fs::set_permissions(
            &upstream,
            PermissionsExt::from_mode(0o755),
        );

        assert!(
            test_result.is_ok(),
            "cmd_update_at should not panic on staging error"
        );

        // Lock file should be unchanged (Phase 3 is never reached)
        let lock_content =
            std::fs::read_to_string(wiki_root.join("zwiki.lock")).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        assert_eq!(updated_lock.bundles.len(), 1);
        assert_eq!(
            updated_lock.bundles[0].version, "1.0.0",
            "lock should retain old version"
        );

        server.join().unwrap();
    }

    #[test]
    fn test_cmd_update_at_persists_partial_lock_on_error() {
        let bundle_a_toml: &[u8] = br#"[package]
name = "bundle-a"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        let second_toml: &[u8] = br#"[package]
name = "bundle-b"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        let index_a = br"---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\nUpdated bundle-a index for health/lint pass.\n";
        let log_a = br"# 2026-07\n\nAll good.\n";
        let tar_a = tar::raw_multi_tar_gz(&[
            ("bundle.toml", bundle_a_toml),
            ("index.md", index_a),
            ("logs/log.md", log_a),
        ]);
        let tar_b = tar::raw_multi_tar_gz(&[
            ("bundle.toml", second_toml),
            ("index.md", index_a),
            ("logs/log.md", log_a),
        ]);

        let (port_a, server_a) = serve_update_bundle(bundle_a_toml, tar_a, 2);
        let (port_b, server_b) = serve_update_bundle(second_toml, tar_b, 2);

        let (wiki_root, target_b) = setup_partial_lock_env(port_a, port_b);

        let args = UpdateArgs {
            name: None,
            force: false,
            json: false,
            dry_run: false,
        };
        let use_json = false;

        let test_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_update_at(&args, use_json, &wiki_root);
                server_a.join().unwrap();
                server_b.join().unwrap();
            }));

        let _ = std::fs::set_permissions(
            &target_b,
            PermissionsExt::from_mode(0o755),
        );

        if test_result.is_err() {
            eprintln!("cmd_update_at or server panicked (not process::exit)");
        }

        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists(), "lock file should exist");
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        let updated_a =
            updated_lock.bundles.iter().find(|b| b.name == "bundle-a");
        assert!(updated_a.is_some(), "bundle-a should be in the lock");
        assert_eq!(
            updated_a.unwrap().version,
            "2.0.0",
            "bundle-a should have been updated to 2.0.0"
        );

        if let Err(e) = test_result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn test_phase3_skips_concurrently_uninstalled() {
        let wiki_root = temp_dir("phase3_uninstalled");
        let lock_path = wiki_root.join(".zwiki.flock");

        // Set up a lock with one bundle.
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock = lock::ZwikiLock {
            bundles: vec![entry.clone()],
            ..Default::default()
        };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        // Create a staging dir with a dummy file.
        let staging = tempfile::tempdir().unwrap();
        std::fs::write(staging.path().join("dummy.md"), "dummy").unwrap();

        let pending_update = PendingUpdate {
            entry,
            staging,
            integrity: "sha256-abc".to_string(),
            remote_version: "2.0.0".to_string(),
            remote_description: None,
        };

        // Remove the bundle from the lock (simulating concurrent uninstall).
        let empty_lock = lock::ZwikiLock::default();
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&empty_lock).unwrap(),
        )
        .unwrap();

        let (success_entries, had_error) = phase3_commit_updates(
            vec![pending_update],
            true,
            &wiki_root,
            &lock_path,
        );

        assert!(!had_error, "should not report error for skipped bundle");
        assert_eq!(success_entries.len(), 1);
        assert_eq!(success_entries[0]["status"], "skipped");
        assert_eq!(
            success_entries[0]["reason"],
            "bundle was concurrently uninstalled"
        );

        // Lock should remain empty.
        let lock_content =
            std::fs::read_to_string(wiki_root.join("zwiki.lock")).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        assert!(updated_lock.bundles.is_empty());
    }

    #[test]
    fn test_phase3_skips_already_at_target_version() {
        let wiki_root = temp_dir("phase3_already_at_target");
        let lock_path = wiki_root.join(".zwiki.flock");

        // Lock has the bundle at version 2.0.0 (concurrent update already
        // applied).
        let lock_entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "2.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock =
            lock::ZwikiLock { bundles: vec![lock_entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        // PendingUpdate with Phase 1 snapshot version 1.0.0 and
        // remote_version 2.0.0 (same as current lock version).
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let staging = tempfile::tempdir().unwrap();
        std::fs::write(staging.path().join("dummy.md"), "dummy").unwrap();

        let pending_update = PendingUpdate {
            entry,
            staging,
            integrity: "sha256-def".to_string(),
            remote_version: "2.0.0".to_string(),
            remote_description: None,
        };

        let (success_entries, had_error) = phase3_commit_updates(
            vec![pending_update],
            true,
            &wiki_root,
            &lock_path,
        );

        assert!(!had_error, "should not report error for skipped bundle");
        assert_eq!(success_entries.len(), 1);
        assert_eq!(success_entries[0]["status"], "skipped");
        assert_eq!(success_entries[0]["reason"], "已被并发更新到目标版本");

        // Lock version should remain 2.0.0.
        let lock_content =
            std::fs::read_to_string(wiki_root.join("zwiki.lock")).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        assert_eq!(updated_lock.bundles.len(), 1);
        assert_eq!(updated_lock.bundles[0].version, "2.0.0");
    }

    #[test]
    fn test_phase3_skips_concurrently_modified() {
        let wiki_root = temp_dir("phase3_concurrently_modified");
        let lock_path = wiki_root.join(".zwiki.flock");

        // Lock has the bundle at version 3.0.0 (concurrent modification
        // changed the version since Phase 1).
        let lock_entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "3.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock =
            lock::ZwikiLock { bundles: vec![lock_entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        // PendingUpdate with Phase 1 snapshot version 1.0.0 and
        // remote_version 2.0.0.  Lock version is 3.0.0 — different from
        // both.
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let staging = tempfile::tempdir().unwrap();
        std::fs::write(staging.path().join("dummy.md"), "dummy").unwrap();

        let pending_update = PendingUpdate {
            entry,
            staging,
            integrity: "sha256-def".to_string(),
            remote_version: "2.0.0".to_string(),
            remote_description: None,
        };

        let (success_entries, had_error) = phase3_commit_updates(
            vec![pending_update],
            true,
            &wiki_root,
            &lock_path,
        );

        assert!(!had_error, "should not report error for skipped bundle");
        assert_eq!(success_entries.len(), 1);
        assert_eq!(success_entries[0]["status"], "skipped");
        assert_eq!(success_entries[0]["reason"], "本地版本已被并发修改");

        // Lock version should remain 3.0.0.
        let lock_content =
            std::fs::read_to_string(wiki_root.join("zwiki.lock")).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        assert_eq!(updated_lock.bundles.len(), 1);
        assert_eq!(updated_lock.bundles[0].version, "3.0.0");
    }

    #[test]
    fn test_update_staging_rollback_preserves_old_files() {
        let bundle_toml_content = br#"[package]
name = "rollback-test"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let bundle_toml = bundle_toml_content.to_vec();

        let server = std::thread::spawn(move || {
            for mut stream in listener.incoming().take(2).flatten() {
                let mut buf = [0u8; 4096];
                if stream.read(&mut buf).is_err() {
                    break;
                }
                let request = String::from_utf8_lossy(&buf);
                if request.contains("bundle.toml") {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\n\
                         Content-Length: {}\r\n\
                         Content-Type: text/plain\r\n\
                         Connection: close\r\n\
                         \r\n",
                        bundle_toml.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&bundle_toml);
                } else {
                    let response = "HTTP/1.1 500 Internal Server Error\r\n\
                                    Content-Length: 0\r\n\
                                    Connection: close\r\n\
                                    \r\n";
                    let _ = stream.write_all(response.as_bytes());
                }
                let _ = stream.flush();
            }
        });

        let wiki_root = temp_dir("update_rollback");
        let bundle_dir = wiki_root.join(".upstream").join("rollback-test");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("old-file.md"), "old content").unwrap();

        let entry = lock::ZwikiLockEntry {
            name: "rollback-test".to_string(),
            version: "1.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/rollback-test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock =
            lock::ZwikiLock { bundles: vec![entry], ..Default::default() };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        let args = UpdateArgs {
            name: Some("rollback-test".to_string()),
            force: false,
            json: false,
            dry_run: false,
        };
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_update_at(&args, false, &wiki_root);
            }));

        assert!(result.is_ok(), "cmd_update_at should not panic or exit");

        assert!(
            bundle_dir.exists(),
            "old target dir should survive failed update"
        );
        assert!(
            bundle_dir.join("old-file.md").exists(),
            "old-file.md should survive"
        );
        let old_content =
            std::fs::read_to_string(bundle_dir.join("old-file.md")).unwrap();
        assert_eq!(
            old_content, "old content",
            "file content should be unchanged"
        );

        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists(), "lock file should exist");
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let updated_lock: lock::ZwikiLock =
            toml::from_str(&lock_content).unwrap();
        assert_eq!(updated_lock.bundles.len(), 1);
        assert_eq!(
            updated_lock.bundles[0].version, "1.0.0",
            "lock should retain old version"
        );

        server.join().unwrap();
    }
}
