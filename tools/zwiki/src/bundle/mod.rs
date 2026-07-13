//! Bundle distribution — bundle manifest struct, validation, and CLI commands.
//!
//! A bundle is a distributable collection of wiki pages and assets, described
//! by a `bundle.toml` manifest with `[package]` and `[export]` sections.
//!
//! Bundles can be exported to `.tar.gz` archives and installed into the wiki
//! directory under `.upstream/<name>/` (upstream bundles) or
//! `.teams/<team>/` (team bundles).  A `zwiki.lock` file tracks installed
//! bundles with integrity hashing.

pub mod args;
pub mod check;
pub mod export;
pub mod http;
pub mod index;
pub mod init;
pub mod install;
pub mod list;
pub mod lock;
pub mod manifest;
pub mod source;
pub mod tar;
#[cfg(test)]
pub mod testutil;
pub mod uninstall;
pub mod update;

// Re-export public API (what main.rs and tests import from bundle::).
pub use args::BundleCommand;
pub use index::check_root_index;
pub use install::load_and_validate_manifest;
pub use lock::{ZwikiLock, ZwikiLockEntry, read_lock_at};
pub use source::check_bundle_structure;

use std::path::Path;

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `BundleCommand` from the CLI.
pub fn dispatch(cmd: &BundleCommand, global_json: bool) {
    match cmd {
        BundleCommand::Init(args) => init::cmd_init(args.as_ref(), global_json),
        BundleCommand::Export(args) => export::cmd_export(args, global_json),
        BundleCommand::Install(args) => install::cmd_install(args, global_json),
        BundleCommand::List(args) => {
            list::cmd_list_installed(args, global_json);
        }
        BundleCommand::Check(args) => check::cmd_check(args, global_json),
        BundleCommand::Update(args) => update::cmd_update(args, global_json),
        BundleCommand::Uninstall(args) => {
            uninstall::cmd_uninstall(args, global_json);
        }
    }
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/// Read and parse `bundle.toml` from the given path.
pub fn read_manifest(
    manifest_path: &Path,
    use_json: bool,
) -> Result<(String, manifest::BundleManifest), String> {
    let content = std::fs::read_to_string(manifest_path).map_err(|e| {
        if use_json {
            format!("cannot read bundle.toml: {e}")
        } else {
            format!("无法读取 bundle.toml: {e}")
        }
    })?;

    let manifest: manifest::BundleManifest =
        toml::from_str(&content).map_err(|e| {
            if use_json {
                format!("invalid bundle.toml: {e}")
            } else {
                format!("无效的 bundle.toml: {e}")
            }
        })?;

    Ok((content, manifest))
}

/// Validate the manifest, print errors, and return whether the caller
/// should exit.  Returns `true` when there are `Fatal` or
/// `ConditionalRequired` errors (`Warning` alone does not cause exit).
pub fn report_manifest_errors(
    errors: &[manifest::ValidationError],
    use_json: bool,
) -> bool {
    let has_fatal = errors.iter().any(|e| {
        matches!(
            e.severity,
            manifest::Severity::Fatal | manifest::Severity::ConditionalRequired
        )
    });

    if !errors.is_empty() {
        if use_json {
            if has_fatal {
                let errs: Vec<serde_json::Value> = errors
                    .iter()
                    .map(|err| {
                        serde_json::json!({
                            "field": err.field,
                            "message": err.message,
                        })
                    })
                    .collect();
                let summary = errors
                    .iter()
                    .map(|err| format!("[{}] {}", err.field, err.message))
                    .collect::<Vec<_>>()
                    .join("; ");
                let output = serde_json::json!({
                    "status": "fatal",
                    "error": summary,
                    "errors": errs,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            } else {
                let warnings: Vec<serde_json::Value> = errors
                    .iter()
                    .map(|err| {
                        serde_json::json!({
                            "field": err.field,
                            "message": err.message,
                        })
                    })
                    .collect();
                let output = serde_json::json!({
                    "status": "ok",
                    "warnings": warnings,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            }
        } else {
            for err in errors {
                match err.severity {
                    manifest::Severity::Fatal
                    | manifest::Severity::ConditionalRequired => {
                        eprintln!("错误: [{}] {}", err.field, err.message);
                    }
                    manifest::Severity::Warning => {
                        eprintln!("提醒: [{}] {}", err.field, err.message);
                    }
                }
            }
        }
    }

    has_fatal
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::bundle::args::{
        ExportArgs, InitArgs, InstallArgs, ListArgs, UninstallArgs,
    };
    use crate::bundle::testutil::{DOC_M0, IDX0, RDM0, temp_dir, w};

    /// End-to-end lifecycle: init → export → install → check → list → uninstall
    /// using default parameters (empty `include` triggers `["**/*"]`).
    #[test]
    fn test_bundle_lifecycle_default_path() -> Result<(), String> {
        // 1. Create temp source bundle directory.
        let source_dir = temp_dir("integration_source");

        // 2. Write source files (index.md, doc.md, logs/).
        w(source_dir.join("index.md"), IDX0);
        w(source_dir.join("doc.md"), DOC_M0);
        w(source_dir.join("readme.md"), RDM0);
        std::fs::create_dir_all(source_dir.join("logs"))
            .map_err(|e| format!("cannot create logs dir: {e}"))?;
        w(source_dir.join("logs/2026-07.md"), "# Log\n");

        // 3. Create temp wiki root.
        let wiki_root = temp_dir("integration_wiki");

        // 4. InitArgs — empty include triggers default ["**/*"].
        let init_args = InitArgs {
            name: Some("test-bundle".to_string()),
            version: "1.0.0".to_string(),
            kind: "upstream".to_string(),
            okf_version: "0.1".to_string(),
            team: None,
            registry: None,
            description: None,
            include: Vec::new(), // empty → triggers default
            exclude: Vec::new(),
            output: Some(
                source_dir.join("bundle.toml").to_string_lossy().to_string(),
            ),
            json: false,
        };

        // 5. Init — generates bundle.toml with default include pattern.
        crate::bundle::init::cmd_init_inner(&init_args, false)?;

        // 6. Assert the generated bundle.toml contains the default pattern.
        let bundle_toml_content =
            std::fs::read_to_string(source_dir.join("bundle.toml"))
                .map_err(|e| format!("cannot read bundle.toml: {e}"))?;
        assert!(
            bundle_toml_content.contains(r#"include = ["**/*"]"#),
            "bundle.toml should contain default include pattern, got: \
             {bundle_toml_content}",
        );

        // 7. ExportArgs.
        let tar_gz_path = source_dir.join("test-bundle-1.0.0.tar.gz");
        let export_args = ExportArgs {
            dir: source_dir.to_string_lossy().to_string(),
            output: Some(tar_gz_path.to_string_lossy().to_string()),
            json: false,
        };

        // 8. Export — creates tar.gz archive.
        crate::bundle::export::cmd_export_inner(&export_args, false)?;
        assert!(tar_gz_path.exists(), "tar.gz should exist at {tar_gz_path:?}");

        // 9. Verify bundle.toml appears exactly ONCE in the tar.gz (bug #3).
        let tar_output = std::process::Command::new("tar")
            .args(["-tzf", &tar_gz_path.to_string_lossy()])
            .output()
            .map_err(|e| format!("tar command failed: {e}"))?;
        assert!(
            tar_output.status.success(),
            "tar -tzf exited with status: {}",
            tar_output.status,
        );
        let tar_entries = String::from_utf8_lossy(&tar_output.stdout);
        let bundle_toml_count = tar_entries
            .lines()
            .filter(|line| line.trim() == "bundle.toml")
            .count();
        assert_eq!(
            bundle_toml_count, 1,
            "bundle.toml should appear exactly once in tar.gz, got \
             {bundle_toml_count}",
        );

        // 10. InstallArgs.
        let install_args = InstallArgs {
            source: tar_gz_path.to_string_lossy().to_string(),
            force: false,
            json: false,
            dry_run: false,
        };

        // 11. Install from tar.gz.
        crate::bundle::install::cmd_install_at_inner(
            &install_args,
            false,
            &wiki_root,
        )?;

        // 12. Read lock — verify bundle is installed.
        let lock = crate::bundle::lock::read_lock_at(&wiki_root)?;
        assert_eq!(
            lock.bundles.len(),
            1,
            "lock should have 1 bundle after install",
        );
        assert_eq!(lock.bundles[0].name, "test-bundle");

        // 13. Check — integrity should pass.
        crate::bundle::check::cmd_check_inner(false, &wiki_root, false, false)?;

        // 14. List — should succeed.
        let list_args = ListArgs { json: false };
        crate::bundle::list::cmd_list_installed_inner(
            &list_args, false, &wiki_root,
        )?;

        // 15. Uninstall.
        let uninstall_args =
            UninstallArgs { name: "test-bundle".to_string(), json: false };
        crate::bundle::uninstall::cmd_uninstall_inner(
            &uninstall_args,
            false,
            &wiki_root,
        )?;

        // 16. Read lock — verify empty.
        let lock = crate::bundle::lock::read_lock_at(&wiki_root)?;
        assert!(
            lock.bundles.is_empty(),
            "lock should be empty after uninstall",
        );

        // 17. Assert target directory is removed.
        let target_dir = wiki_root.join(".upstream").join("test-bundle");
        assert!(
            !target_dir.exists(),
            "target directory should be removed after uninstall: \
             {target_dir:?}",
        );

        Ok(())
    }
}
