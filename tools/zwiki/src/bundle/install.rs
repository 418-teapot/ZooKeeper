//! Bundle install — `zwiki bundle install`.

use std::path::Path;

use chrono::Utc;
use tempfile::TempDir;

use crate::bundle::args::InstallArgs;
use crate::bundle::index;
use crate::bundle::lock;
use crate::bundle::manifest;
use crate::bundle::source;
use crate::bundle::tar;
use crate::bundle::{read_manifest, report_manifest_errors};
use crate::wiki;

/// Compute integrity, update the lock file, and print the install output.
/// The caller MUST hold the `.zwiki.flock` before calling this function.
/// Note: `pub` is effectively `pub(crate)` because `mod bundle` is private.
pub fn finalize_install_and_lock_at(
    target_abs: &Path,
    target_rel: String,
    manifest: &manifest::BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), String> {
    let integrity = lock::compute_integrity(target_abs);

    let installed_at = Utc::now().to_rfc3339();
    let entry = lock::ZwikiLockEntry {
        name: manifest.package.name.clone(),
        version: manifest.package.version.clone(),
        registry: manifest.package.registry.clone().unwrap_or_default(),
        target: target_rel,
        integrity: integrity.clone(),
        installed_at,
        description: manifest.package.description.clone(),
    };

    let mut l = lock::read_lock_at(wiki_root)?;

    // If the target directory was manually deleted (orphaned lock entry),
    // allow the install to proceed as if --force was set.
    let effective_force = force
        || (!target_abs.exists()
            && l.bundles.iter().any(|b| b.name == manifest.package.name));

    if effective_force != force && !use_json {
        eprintln!(
            "提醒: bundle '{}' 的锁记录存在但目标目录缺失，将重新安装",
            manifest.package.name
        );
    }

    lock::upsert_bundle(&mut l, entry, effective_force)?;
    lock::write_lock_at(&l, wiki_root).map_err(|e| {
        if use_json {
            format!("cannot write lock file: {e}")
        } else {
            format!("无法写入锁文件: {e}")
        }
    })?;

    index::regenerate_root_index_at(&l, wiki_root);

    let target_display = target_abs.to_string_lossy().to_string();
    if use_json {
        let output = serde_json::json!({
            "status": "ok",
            "name": manifest.package.name,
            "target": target_display,
            "integrity": integrity,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        println!("已安装: {} → {}", manifest.package.name, target_display);
    }

    Ok(())
}

/// Copy files matched by manifest include/exclude + bundle.toml into the
/// target directory.
fn copy_bundle_files_to_target(
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &manifest::BundleManifest,
    target_abs: &Path,
    use_json: bool,
) -> Result<(), String> {
    let files = tar::collect_export_files(
        source_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        use_json,
    )?;
    for abs_path in &files {
        let rel = abs_path.strip_prefix(source_dir).unwrap_or(abs_path);
        let target = target_abs.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                if use_json {
                    format!("cannot create dir: {e}")
                } else {
                    format!("无法创建目录: {e}")
                }
            })?;
        }
        std::fs::copy(abs_path, &target).map_err(|e| {
            if use_json {
                format!("cannot copy file: {e}")
            } else {
                format!("无法复制文件: {e}")
            }
        })?;
    }

    std::fs::copy(manifest_path, target_abs.join("bundle.toml")).map_err(
        |e| {
            if use_json {
                format!("cannot copy bundle.toml: {e}")
            } else {
                format!("无法复制 bundle.toml: {e}")
            }
        },
    )?;

    Ok(())
}

/// Atomically replace `target` with the contents of `staging`.
///
/// Rename staging to a `.tmp_*` temp name, remove the old target (if any),
/// then rename the temp to the final target.  If a crash occurs after
/// removing the old target but before the final rename, the new data
/// survives at the `.tmp_*` path and can be recovered via `check --fix`.
pub fn atomic_dir_swap(
    staging: tempfile::TempDir,
    target_abs: &Path,
    use_json: bool,
) -> Result<(), String> {
    let file_name =
        target_abs.file_name().unwrap_or_default().to_string_lossy();
    let temp_path = target_abs.with_file_name(format!(".tmp_{file_name}"));
    let _ = std::fs::remove_dir_all(&temp_path);

    std::fs::rename(staging.path(), &temp_path).map_err(|e| {
        if use_json {
            format!("cannot move staging to temp: {e}")
        } else {
            format!("无法移动暂存目录: {e}")
        }
    })?;

    if target_abs.exists() {
        let temp_display = temp_path.display();
        std::fs::remove_dir_all(target_abs).map_err(|e| {
            if use_json {
                format!(
                    "cannot remove existing target: {e}; new files left at: \
                     {temp_display}; retry with --force to clean up",
                )
            } else {
                format!(
                    "无法移除已存在的目标目录: {e}；新文件保留在临时目录: \
                     {temp_display}；重试时使用 --force 清理",
                )
            }
        })?;
    }

    std::fs::rename(&temp_path, target_abs).map_err(|e| {
        if use_json {
            format!("cannot rename temp to target: {e}")
        } else {
            format!("无法重命名临时目录: {e}")
        }
    })?;
    let _ = staging.keep();
    Ok(())
}

/// Install bundle files from `source_dir` into the wiki, compute integrity,
/// and update the lock file.
/// If `target_abs` exists and has files, either error (when `!force`) or
/// replace it atomically via staging.  Returns `Ok(true)` when the target
/// was force-replaced, `Ok(false)` when target did not exist or was empty
/// (caller should create + copy), and `Err(())` when not forced.
fn force_replace_bundle_at(
    target_abs: &Path,
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &manifest::BundleManifest,
    target_rel: &str,
    force: bool,
    use_json: bool,
) -> Result<bool, String> {
    if !target_abs.exists() {
        return Ok(false);
    }

    let has_files = walkdir::WalkDir::new(target_abs)
        .into_iter()
        .filter_map(Result::ok)
        .any(|e| e.file_type().is_file());

    if !has_files {
        // Empty target directory — remove it so the caller's
        // existence check will copy files into a fresh directory.
        let _ = std::fs::remove_dir_all(target_abs);
        return Ok(false);
    }

    if !force {
        return Err(if use_json {
            format!(
                "bundle '{}' already installed at '{}', use --force to overwrite",
                manifest.package.name, target_rel
            )
        } else {
            format!(
                "bundle '{}' 已安装到 '{}'，使用 --force 覆盖",
                manifest.package.name, target_rel
            )
        });
    }

    let parent = target_abs.parent().ok_or_else(|| {
        if use_json {
            "target directory has no parent".to_string()
        } else {
            "目标目录没有父目录".to_string()
        }
    })?;
    let staging = TempDir::new_in(parent).map_err(|e| {
        if use_json {
            format!("cannot create staging directory: {e}")
        } else {
            format!("无法创建临时目录: {e}")
        }
    })?;

    copy_bundle_files_to_target(
        source_dir,
        manifest_path,
        manifest,
        staging.path(),
        use_json,
    )?;

    atomic_dir_swap(staging, target_abs, use_json)?;

    Ok(true)
}

pub fn install_bundle_files_at(
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &manifest::BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), String> {
    let lock_path = wiki_root.join(".zwiki.flock");
    // NOTE: flock() / fcntl(F_SETLK) is advisory and does NOT work on NFS.
    //       The wiki directory should not be on NFS.
    let result: std::io::Result<Result<(), String>> =
        zutil::fileio::with_file_lock(&lock_path, || {
            let inner: Result<(), String> = (|| {
                let target_rel =
                    source::resolve_target_rel(manifest, use_json)?;
                let target_abs = wiki_root.join(&target_rel);

                if force_replace_bundle_at(
                    &target_abs,
                    source_dir,
                    manifest_path,
                    manifest,
                    &target_rel,
                    force,
                    use_json,
                )? {
                    // target exists with files and was force-replaced (or already handled)
                }

                if !target_abs.exists() {
                    std::fs::create_dir_all(&target_abs).map_err(|e| {
                        if use_json {
                            format!("cannot create target directory: {e}")
                        } else {
                            format!("无法创建目标目录: {e}")
                        }
                    })?;

                    copy_bundle_files_to_target(
                        source_dir,
                        manifest_path,
                        manifest,
                        &target_abs,
                        use_json,
                    )?;
                }

                finalize_install_and_lock_at(
                    &target_abs,
                    target_rel,
                    manifest,
                    force,
                    use_json,
                    wiki_root,
                )?;

                Ok(())
            })();
            Ok(inner)
        });
    match result {
        Ok(inner) => inner,
        Err(e) => Err(if use_json {
            format!("cannot acquire file lock: {e}")
        } else {
            format!("无法获取文件锁: {e}")
        }),
    }
}

/// Resolve source, read and validate `bundle.toml`.
///
/// Returns the `TempDir` (kept alive by the caller) and parsed manifest on
/// success, or `Err` with the collected validation errors after printing an
/// error message.
pub fn load_and_validate_manifest(
    source: &str,
    use_json: bool,
) -> Result<(TempDir, manifest::BundleManifest), Vec<manifest::ValidationError>>
{
    let resolved = source::resolve_source(source, use_json).map_err(|e| {
        if !use_json {
            eprintln!("解析源失败: {e}");
        }
        vec![manifest::ValidationError {
            severity: manifest::Severity::Fatal,
            field: "source".to_string(),
            message: format!("解析源失败: {e}"),
        }]
    })?;
    let source_dir = resolved.path();
    let manifest_path = source_dir.join("bundle.toml");

    if !manifest_path.exists() {
        if !use_json {
            eprintln!("在源 '{source}' 中未找到 bundle.toml");
        }
        return Err(vec![manifest::ValidationError {
            severity: manifest::Severity::Fatal,
            field: "source".to_string(),
            message: format!("在源 '{source}' 中未找到 bundle.toml"),
        }]);
    }

    let (_content, manifest) = read_manifest(&manifest_path, use_json)
        .map_err(|e| {
            if !use_json {
                eprintln!("读取 bundle.toml 失败: {e}");
            }
            vec![manifest::ValidationError {
                severity: manifest::Severity::Fatal,
                field: "manifest".to_string(),
                message: format!("读取 bundle.toml 失败: {e}"),
            }]
        })?;
    let errors = manifest.validate(use_json);
    let should_exit = report_manifest_errors(&errors, use_json);
    if should_exit {
        return Err(errors);
    }

    Ok((resolved, manifest))
}

/// Install a bundle from a local directory, tar.gz file, or URL.
/// Uses an explicit `wiki_root` so it can be tested without touching the real
/// wiki directory.
pub fn cmd_install_at(args: &InstallArgs, use_json: bool, wiki_root: &Path) {
    if let Err(msg) = cmd_install_at_inner(args, use_json, wiki_root) {
        if !use_json {
            eprintln!("错误: {msg}");
        }
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_install_at` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
pub fn cmd_install_at_inner(
    args: &InstallArgs,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), String> {
    let source = &args.source;

    let (resolved, manifest) = load_and_validate_manifest(source, use_json)
        .map_err(|_| "加载或验证 bundle 失败".to_string())?;
    let source_dir = resolved.path();
    let manifest_path = source_dir.join("bundle.toml");

    // Dry-run: preview without modifying files.
    if args.dry_run {
        let target_rel = source::resolve_target_rel(&manifest, use_json)?;
        let target_abs = wiki_root.join(&target_rel);
        let would_overwrite = target_abs.exists();
        if use_json {
            let output = serde_json::json!({
                "status": "dry-run",
                "name": manifest.package.name,
                "version": manifest.package.version,
                "target": target_rel,
                "would_overwrite": would_overwrite,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            print!(
                "DRY RUN: bundle '{}' v{} → {}",
                manifest.package.name, manifest.package.version, target_rel
            );
            if would_overwrite {
                println!(" (将覆盖)");
            } else {
                println!();
            }
        }
        if !use_json {
            println!("DRY RUN — 未修改任何文件");
        }
        return Ok(());
    }

    source::check_bundle_structure(source_dir, use_json)?;

    let (health_results, lint_results, health_issues, lint_issues) =
        crate::run_health_lint_at(source_dir);
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
        return Err(format!("检查未通过: {total} 个问题"));
    }

    install_bundle_files_at(
        source_dir,
        &manifest_path,
        &manifest,
        args.force,
        use_json,
        wiki_root,
    )?;

    Ok(())
}

/// Thin wrapper that calls [`cmd_install_at`] with the real wiki directory.
pub fn cmd_install(args: &InstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    cmd_install_at(args, use_json, &wiki::wiki_dir());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::args::InstallArgs;
    use crate::bundle::testutil::*;

    #[test]
    fn test_install_args_defaults() {
        let args = InstallArgs {
            source: "/path".to_string(),
            force: false,
            json: false,
            dry_run: false,
        };
        assert!(!args.force);
        assert!(!args.json);
    }

    #[test]
    fn test_install_from_local_dir_full() {
        let s = temp_dir("install_local_full_src");
        let bundle_toml = r#"
[package]
name = "test-install-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(s.join("bundle.toml"), bundle_toml);
        w(s.join("doc.md"), DOC_M0);
        w(s.join("readme.md"), RDM0);
        w(s.join("notes.txt"), "not included");
        w(s.join("index.md"), IDX0);
        std::fs::create_dir_all(s.join("logs")).unwrap();
        w(s.join("logs/2026-07.md"), "# Log\n");
        let wiki_root = temp_dir("install_local_full_wiki");
        let args = InstallArgs {
            source: s.to_string_lossy().to_string(),
            force: false,
            json: false,
            dry_run: false,
        };
        cmd_install_at(&args, false, &wiki_root);
        let bundle_dir =
            wiki_root.join(".upstream").join("test-install-bundle");
        assert!(bundle_dir.exists(), "bundle target dir should exist");
        assert!(bundle_dir.join("doc.md").exists(), "doc.md should be copied");
        assert!(
            bundle_dir.join("readme.md").exists(),
            "readme.md should be copied"
        );
        assert!(
            bundle_dir.join("bundle.toml").exists(),
            "bundle.toml should be copied"
        );
        assert!(
            !bundle_dir.join("notes.txt").exists(),
            "notes.txt should NOT be copied"
        );
        let doc_content =
            std::fs::read_to_string(bundle_dir.join("doc.md")).unwrap();
        assert!(
            doc_content.contains("# Doc Content"),
            "doc.md should contain the heading"
        );
        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists(), "zwiki.lock should exist");
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let l: lock::ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(l.bundles.len(), 1);
        assert_eq!(l.bundles[0].name, "test-install-bundle");
        assert_eq!(l.bundles[0].version, "1.0.0");
        assert_eq!(l.bundles[0].target, ".upstream/test-install-bundle/");
        assert!(
            l.bundles[0].integrity.starts_with("sha256-"),
            "integrity should be sha256- format"
        );
        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists(), "index.md should exist");
        let index_content = std::fs::read_to_string(&index_path).unwrap();
        assert!(index_content.contains("## Upstream Bundles"));
        assert!(index_content.contains("test-install-bundle"));
        w(s.join("doc.md"), DOC_U0);
        w(s.join("new.md"), NEW_M0);
        w(s.join("index.md"), IDX_U0);
        let args_force = InstallArgs {
            source: s.to_string_lossy().to_string(),
            force: true,
            json: false,
            dry_run: false,
        };
        cmd_install_at(&args_force, false, &wiki_root);
        let doc_content =
            std::fs::read_to_string(bundle_dir.join("doc.md")).unwrap();
        assert!(
            doc_content.contains("# Updated Doc Content"),
            "doc.md should contain updated heading"
        );
        assert!(
            bundle_dir.join("new.md").exists(),
            "new.md should be copied on reinstall"
        );
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let l: lock::ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(
            l.bundles.len(),
            1,
            "lock should still have one entry after force reinstall"
        );
        assert_eq!(l.bundles[0].version, "1.0.0");
    }

    #[test]
    fn test_install_at_with_json_output() {
        let src_dir = temp_dir("install_json_src");
        let bundle_toml = r#"
[package]
name = "json-test-bundle"
version = "0.5.0"
kind = "org"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(
            src_dir.join("page.md"),
            "---\ntitle: Page\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# JSON\n\nThis page has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n",
        )
        .unwrap();
        std::fs::write(
            src_dir.join("index.md"),
            "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Page](page.md)\n",
        )
        .unwrap();
        std::fs::create_dir_all(src_dir.join("logs")).unwrap();
        std::fs::write(src_dir.join("logs/2026-07.md"), "# Log\n").unwrap();

        let wiki_root = temp_dir("install_json_wiki");

        let args = InstallArgs {
            source: src_dir.to_string_lossy().to_string(),
            force: false,
            json: true,
            dry_run: false,
        };

        let output =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_install_at(&args, true, &wiki_root);
            }));
        assert!(output.is_ok(), "cmd_install_at with JSON should not panic");

        let bundle_dir = wiki_root.join(".org").join("json-test-bundle");
        assert!(bundle_dir.exists(), "org bundle dir should exist");
        assert!(bundle_dir.join("page.md").exists(), "page.md should exist");

        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists());
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let l: lock::ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(l.bundles.len(), 1);
        assert_eq!(l.bundles[0].name, "json-test-bundle");
        assert_eq!(l.bundles[0].target, ".org/json-test-bundle/");
    }

    #[test]
    fn test_cmd_install_at_rejects_unhealthy_bundle() {
        let s = temp_dir("install_unhealthy_src");
        let bundle_toml = r#"
[package]
name = "unhealthy-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(s.join("bundle.toml"), bundle_toml);
        w(s.join("page.md"), "# Page\n");
        w(s.join("index.md"), "# Index\n");
        std::fs::create_dir_all(s.join("logs")).unwrap();
        w(s.join("logs/2026-07.md"), "# Log\n");

        let wiki_root = temp_dir("install_unhealthy_wiki");

        let src = s.to_string_lossy();
        let (resolved, _manifest) =
            load_and_validate_manifest(&src, false).unwrap();
        let source_dir = resolved.path().to_path_buf();

        assert!(
            source::check_bundle_structure(&source_dir, false).is_ok(),
            "bundle structure should be valid"
        );

        let (_health_results, _lint_results, health_issues, lint_issues) =
            crate::run_health_lint_at(&source_dir);
        let total = health_issues + lint_issues;
        assert!(
            total > 0,
            "unhealthy bundle should have health/lint issues, got {total}"
        );

        let target_dir = wiki_root.join(".upstream").join("unhealthy-bundle");
        assert!(
            !target_dir.exists(),
            "target directory should not exist for rejected bundle"
        );

        let lock_path = wiki_root.join("zwiki.lock");
        assert!(
            !lock_path.exists(),
            "lock file should not exist for rejected bundle"
        );
    }

    #[test]
    fn test_load_and_validate_manifest_valid_bundle() {
        let src_dir = temp_dir("validate_valid_src");
        let bundle_toml = r#"
[package]
name = "valid-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();

        let src = src_dir.to_string_lossy();
        let result = load_and_validate_manifest(&src, false);
        assert!(result.is_ok(), "valid bundle should return Ok");
    }

    #[test]
    fn test_load_and_validate_manifest_missing_bundle_toml() {
        let src_dir = temp_dir("validate_missing_src");
        std::fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.to_string_lossy();
        let result = load_and_validate_manifest(&src, false);
        assert!(result.is_err(), "missing bundle.toml should return Err");
    }

    #[test]
    fn test_load_and_validate_manifest_fatal_validation() {
        let src_dir = temp_dir("validate_fatal_src");
        let bundle_toml = r#"
[package]
name = ""
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();

        let src = src_dir.to_string_lossy();
        let result = load_and_validate_manifest(&src, false);
        assert!(result.is_err(), "empty name should return Err");

        let Err(errors) = result else { unreachable!() };
        let has_name_fatal = errors.iter().any(|e| {
            e.severity == manifest::Severity::Fatal && e.field == "package.name"
        });
        assert!(
            has_name_fatal,
            "errors should contain a fatal on package.name"
        );
    }

    #[test]
    fn test_load_and_validate_manifest_drops_tempdir_on_parse_error() {
        let dir = temp_dir("lv_manifest_parse_err");
        std::fs::write(dir.join("bundle.toml"), "invalid toml {{{").unwrap();
        let result = load_and_validate_manifest(dir.to_str().unwrap(), false);
        assert!(result.is_err());
    }

    #[test]
    fn test_install_bundle_files_at_returns_err_on_already_installed() {
        let src = temp_dir("install_err_already_installed_src");
        let bundle_toml = r#"
[package]
name = "err-test-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(src.join("bundle.toml"), bundle_toml);
        w(src.join("index.md"), IDX0);
        w(src.join("doc.md"), DOC_M0);
        std::fs::create_dir_all(src.join("logs")).unwrap();
        w(src.join("logs/2026-07.md"), "# Log\n");

        let wiki_root = temp_dir("install_err_already_installed_wiki");
        let manifest = valid_manifest_with_name("err-test-bundle");

        let result = install_bundle_files_at(
            &src,
            &src.join("bundle.toml"),
            &manifest,
            false,
            false,
            &wiki_root,
        );
        assert!(result.is_ok(), "first install should succeed");

        let result = install_bundle_files_at(
            &src,
            &src.join("bundle.toml"),
            &manifest,
            false,
            false,
            &wiki_root,
        );
        assert!(
            result.is_err(),
            "install without --force when target exists should return Err"
        );
    }

    #[test]
    fn test_install_bundle_files_at_returns_err_on_copy_failure() {
        let src = temp_dir("install_err_copy_failure_src");
        let bundle_toml = r#"
[package]
name = "copy-fail-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(src.join("bundle.toml"), bundle_toml);
        w(src.join("index.md"), IDX0);
        w(src.join("doc.md"), DOC_M0);
        std::fs::create_dir_all(src.join("logs")).unwrap();
        w(src.join("logs/2026-07.md"), "# Log\n");

        let wiki_root = temp_dir("install_err_copy_failure_wiki");
        let manifest = valid_manifest_with_name("copy-fail-bundle");
        let fake_manifest = src.join("nonexistent-bundle.toml");

        let result = install_bundle_files_at(
            &src,
            &fake_manifest,
            &manifest,
            false,
            false,
            &wiki_root,
        );
        assert!(
            result.is_err(),
            "install with non-existent manifest_path should return Err"
        );
    }

    #[test]
    fn test_cmd_install_at_inner_rejects_unhealthy_bundle() {
        let s = temp_dir("install_inner_unhealthy_src");
        let bundle_toml = r#"
[package]
name = "unhealthy-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(s.join("bundle.toml"), bundle_toml);
        w(s.join("page.md"), "# Page\n");
        w(s.join("index.md"), "# Index\n");
        std::fs::create_dir_all(s.join("logs")).unwrap();
        w(s.join("logs/2026-07.md"), "# Log\n");

        let wiki_root = temp_dir("install_inner_unhealthy_wiki");
        let src = s.to_string_lossy();
        let args = InstallArgs {
            source: src.to_string(),
            force: false,
            json: false,
            dry_run: false,
        };

        let result = cmd_install_at_inner(&args, false, &wiki_root);
        assert!(result.is_err(), "unhealthy bundle should be rejected");
    }

    #[test]
    fn test_read_manifest_returns_err_on_missing_file() {
        let dir = temp_dir("read_manifest_missing");
        let path = dir.join("bundle.toml");
        let result = crate::bundle::read_manifest(&path, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无法读取 bundle.toml"));
    }

    #[test]
    fn test_read_manifest_returns_err_on_invalid_toml() {
        let dir = temp_dir("read_manifest_invalid");
        let path = dir.join("bundle.toml");
        std::fs::write(&path, "invalid toml {{{").unwrap();
        let result = crate::bundle::read_manifest(&path, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无效的 bundle.toml"));
    }

    #[test]
    fn test_install_into_empty_target_dir() {
        // Create a source bundle with valid content.
        let src = temp_dir("install_empty_target_src");
        let bundle_toml = r#"
[package]
name = "empty-target-test-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        w(src.join("bundle.toml"), bundle_toml);
        w(src.join("index.md"), IDX0);
        w(src.join("doc.md"), DOC_M0);

        let wiki_root = temp_dir("install_empty_target_wiki");
        let manifest = valid_manifest_with_name("empty-target-test-bundle");

        // Pre-create an empty target directory (simulating the bug scenario).
        let target_rel = source::resolve_target_rel(&manifest, false).unwrap();
        let target_abs = wiki_root.join(&target_rel);
        std::fs::create_dir_all(&target_abs).unwrap();

        // Verify the target directory exists and is empty.
        assert!(target_abs.exists(), "pre-created target should exist");
        let has_files = walkdir::WalkDir::new(&target_abs)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| e.file_type().is_file());
        assert!(!has_files, "pre-created target should be empty");

        // Install without --force — should succeed because the empty
        // directory is removed and files are copied normally.
        let result = install_bundle_files_at(
            &src,
            &src.join("bundle.toml"),
            &manifest,
            false,
            false,
            &wiki_root,
        );
        assert!(result.is_ok(), "install into empty target dir should succeed");

        // Verify the target directory now contains the expected files.
        assert!(target_abs.exists(), "target dir should exist after install");
        assert!(
            target_abs.join("index.md").exists(),
            "index.md should be copied"
        );
        assert!(target_abs.join("doc.md").exists(), "doc.md should be copied");
        assert!(
            target_abs.join("bundle.toml").exists(),
            "bundle.toml should be copied"
        );

        // Verify the lock file registers the bundle.
        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists(), "zwiki.lock should exist");
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let l: lock::ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(l.bundles.len(), 1);
        assert_eq!(l.bundles[0].name, "empty-target-test-bundle");
        assert_eq!(l.bundles[0].version, "1.0.0");
        assert_eq!(l.bundles[0].target, ".upstream/empty-target-test-bundle/");
        assert!(
            l.bundles[0].integrity.starts_with("sha256-"),
            "integrity should be sha256- format"
        );
    }
}
