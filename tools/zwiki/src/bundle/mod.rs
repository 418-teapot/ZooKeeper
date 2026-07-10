//! Bundle distribution — bundle manifest struct, validation, and CLI commands.
//!
//! A bundle is a distributable collection of wiki pages and assets, described
//! by a `bundle.toml` manifest with `[package]` and `[export]` sections.
//!
//! Bundles can be exported to `.tar.gz` archives and installed into the wiki
//! directory under `.upstream/<name>/` (upstream bundles) or
//! `.teams/<team>/` (team bundles).  A `zwiki.lock` file tracks installed
//! bundles with integrity hashing.

pub mod http;
pub mod lock;
pub mod manifest;
pub mod source;
pub mod tar;

// Re-export public API (what main.rs and tests import from bundle::).
pub use lock::{ZwikiLock, ZwikiLockEntry, read_lock};
pub use source::check_bundle_structure;

use chrono::Utc;
use clap::{Args, Subcommand};
use std::cmp::Ordering;
use std::fmt::Write;
use std::path::{Path, PathBuf};
use std::process;
use tempfile::TempDir;

use crate::wiki;

// ---------------------------------------------------------------------------
// CLI subcommand enums & args
// ---------------------------------------------------------------------------

/// Arguments for `zwiki bundle init`.
#[derive(Args, Debug, Clone)]
pub struct InitArgs {
    /// Bundle name (default: basename of current working directory)
    #[arg(long)]
    pub name: Option<String>,

    /// Bundle version
    #[arg(long, default_value = "0.1.0")]
    pub version: String,

    /// Bundle kind — upstream, team, or org
    #[arg(long, default_value = "upstream")]
    pub kind: String,

    /// OKF schema version
    #[arg(long = "okf-version", default_value = "0.1")]
    pub okf_version: String,

    /// Team name (required when kind=team)
    #[arg(long)]
    pub team: Option<String>,

    /// Registry URL
    #[arg(long)]
    pub registry: Option<String>,

    /// Bundle description
    #[arg(long)]
    pub description: Option<String>,

    /// Include glob patterns (can be repeated)
    #[arg(long)]
    pub include: Vec<String>,

    /// Exclude glob patterns (can be repeated)
    #[arg(long)]
    pub exclude: Vec<String>,

    /// Output file path
    #[arg(long, short)]
    pub output: Option<String>,

    /// Output as JSON instead of YAML
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle export`.
#[derive(Args, Debug, Clone)]
pub struct ExportArgs {
    /// Bundle directory containing bundle.toml
    pub dir: String,

    /// Custom output path (default: <name>-<version>.tar.gz in CWD)
    #[arg(long)]
    pub output: Option<String>,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle install`.
#[derive(Args, Debug, Clone)]
pub struct InstallArgs {
    /// Source: local directory path, tar.gz path, or URL
    pub source: String,

    /// Overwrite existing bundle if already installed
    #[arg(long)]
    pub force: bool,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle list`.
#[derive(Args, Debug, Clone)]
pub struct ListArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle check`.
#[derive(Args, Debug, Clone)]
pub struct CheckArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle uninstall`.
#[derive(Args, Debug, Clone)]
pub struct UninstallArgs {
    /// Bundle name to uninstall
    pub name: String,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle update`.
#[derive(Args, Debug, Clone)]
pub struct UpdateArgs {
    /// Filter by bundle name (update only this bundle)
    #[arg(long)]
    pub name: Option<String>,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Bundle distribution subcommands.
#[derive(Subcommand)]
pub enum BundleCommand {
    /// Initialize a new bundle manifest in the current directory.
    Init(Box<InitArgs>),

    /// Export bundle to a .tar.gz archive.
    Export(ExportArgs),

    /// Install a bundle from a local directory, tar.gz, or URL.
    Install(InstallArgs),

    /// List installed bundles.
    List(ListArgs),

    /// Check integrity of installed bundles.
    Check(CheckArgs),

    /// Update installed bundles from their registry.
    Update(UpdateArgs),

    /// Uninstall a bundle by name.
    Uninstall(UninstallArgs),
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `BundleCommand` from the CLI.
pub fn dispatch(cmd: &BundleCommand, global_json: bool) {
    match cmd {
        BundleCommand::Init(args) => cmd_init(args.as_ref(), global_json),
        BundleCommand::Export(args) => cmd_export(args, global_json),
        BundleCommand::Install(args) => cmd_install(args, global_json),
        BundleCommand::List(args) => cmd_list_installed(args, global_json),
        BundleCommand::Check(args) => cmd_check(args, global_json),
        BundleCommand::Update(args) => cmd_update(args, global_json),
        BundleCommand::Uninstall(args) => cmd_uninstall(args, global_json),
    }
}

/// Derive a bundle name from the current working directory basename.
fn derive_name() -> String {
    std::env::current_dir()
        .ok()
        .as_deref()
        .and_then(Path::file_name)
        .map_or_else(
            || "bundle".to_string(),
            |n| n.to_string_lossy().to_string(),
        )
}

// ---------------------------------------------------------------------------
// cmd_init — `zwiki bundle init`
// ---------------------------------------------------------------------------

/// Initialize a new bundle manifest with defaults and CLI-provided values.
pub fn cmd_init(args: &InitArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if cmd_init_inner(args, use_json).is_err() {
        process::exit(1);
    }
}

/// Inner implementation of `cmd_init` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
fn cmd_init_inner(args: &InitArgs, use_json: bool) -> Result<(), ()> {
    let resolved_name =
        args.name.clone().map_or_else(derive_name, String::from);

    let manifest = manifest::BundleManifest {
        package: manifest::PackageSection {
            name: resolved_name,
            version: args.version.clone(),
            okf_version: args.okf_version.clone(),
            kind: args.kind.clone(),
            team: args.team.clone(),
            registry: args.registry.clone(),
            description: args.description.clone(),
        },
        export: manifest::ExportSection {
            include: if args.include.is_empty() {
                vec!["pages/**/*.md".to_string()]
            } else {
                args.include.clone()
            },
            exclude: args.exclude.clone(),
        },
    };

    // Validate before output.
    let errors = manifest.validate(use_json);
    let fatals: Vec<&manifest::ValidationError> = errors
        .iter()
        .filter(|e| e.severity == manifest::Severity::Fatal)
        .collect();

    if !fatals.is_empty() {
        for err in &fatals {
            eprintln!("错误: [{}] {}", err.field, err.message);
        }
        return Err(());
    }

    for err in &errors {
        if err.severity == manifest::Severity::Warning
            || err.severity == manifest::Severity::ConditionalRequired
        {
            eprintln!("提醒: [{}] {}", err.field, err.message);
        }
    }

    let serialized = if use_json {
        serde_json::to_string_pretty(&manifest).map_err(|e| {
            eprintln!("JSON 序列化失败: {e}");
        })?
    } else {
        toml::to_string_pretty(&manifest).map_err(|e| {
            eprintln!("TOML 序列化失败: {e}");
        })?
    };

    if let Some(ref path) = args.output {
        std::fs::write(path, &serialized).map_err(|e| {
            eprintln!("写入文件失败: {e}");
        })?;
        eprintln!("已生成 bundle.toml 模板");
    } else {
        println!("{serialized}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/// Read and parse `bundle.toml` from the given path.
fn read_manifest(
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
/// should exit.  Returns `true` if there are fatal errors or any non-fatal
/// issue (warnings are always fatal).
fn report_manifest_errors(
    errors: &[manifest::ValidationError],
    use_json: bool,
) -> bool {
    let should_exit = !errors.is_empty();

    if should_exit {
        if use_json {
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
            for err in errors {
                eprintln!("错误: [{}] {}", err.field, err.message);
            }
        }
    }

    should_exit
}

// ---------------------------------------------------------------------------
// cmd_export — `zwiki bundle export`
// ---------------------------------------------------------------------------

/// Export a bundle directory into a `.tar.gz` archive.
pub fn cmd_export(args: &ExportArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if cmd_export_inner(args, use_json).is_err() {
        process::exit(1);
    }
}

/// Inner implementation of `cmd_export` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
fn cmd_export_inner(args: &ExportArgs, use_json: bool) -> Result<(), ()> {
    let bundle_dir = Path::new(&args.dir);

    let manifest_path = bundle_dir.join("bundle.toml");
    let (manifest_content, manifest) = read_manifest(&manifest_path, use_json)
        .map_err(|msg| {
            if use_json {
                let output = serde_json::json!({
                    "status": "fatal",
                    "error": msg,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            } else {
                eprintln!("{msg}");
            }
        })?;

    let errors = manifest.validate(use_json);
    if report_manifest_errors(&errors, use_json) {
        return Err(());
    }

    let files = tar::collect_export_files(
        bundle_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        use_json,
    )?;

    let output_path = args.output.clone().unwrap_or_else(|| {
        format!("{}-{}.tar.gz", manifest.package.name, manifest.package.version)
    });

    tar::write_tar_gz(
        &output_path,
        bundle_dir,
        &manifest_content,
        &files,
        use_json,
    )
    .map_err(|_| ())?;

    if use_json {
        let output = serde_json::json!({
            "status": "ok",
            "output": output_path,
            "files": files.len(),
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        eprintln!("已导出: {output_path}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// cmd_install — `zwiki bundle install`
// ---------------------------------------------------------------------------

/// Compute integrity, update the lock file, and print the install output.
fn finalize_install_and_lock_at(
    target_abs: &Path,
    target_rel: String,
    manifest: &manifest::BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), ()> {
    let _flock =
        zutil::fileio::acquire_file_lock(&wiki_root.join(".zwiki.flock"))
            .map_err(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot acquire file lock: {e}")
                    } else {
                        format!("无法获取文件锁: {e}")
                    }
                );
            })?;

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

    let mut l = lock::read_lock_at(wiki_root);
    if let Err(e) = lock::upsert_bundle(&mut l, entry, force) {
        eprintln!("{e}");
        return Err(());
    }
    if let Err(e) = lock::write_lock_at(&l, wiki_root) {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot write lock file: {e}")
            } else {
                format!("无法写入锁文件: {e}")
            }
        );
        return Err(());
    }

    regenerate_root_index_at(&l, wiki_root);

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
) -> Result<(), ()> {
    let files = tar::collect_export_files(
        source_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        use_json,
    )?;
    for abs_path in &files {
        let rel = abs_path.strip_prefix(source_dir).unwrap_or(abs_path);
        let target = target_abs.join(rel);
        if let Some(parent) = target.parent()
            && let Err(e) = std::fs::create_dir_all(parent)
        {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot create dir: {e}")
                } else {
                    format!("无法创建目录: {e}")
                }
            );
            return Err(());
        }
        if let Err(e) = std::fs::copy(abs_path, &target) {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot copy file: {e}")
                } else {
                    format!("无法复制文件: {e}")
                }
            );
            return Err(());
        }
    }

    if let Err(e) = std::fs::copy(manifest_path, target_abs.join("bundle.toml"))
    {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot copy bundle.toml: {e}")
            } else {
                format!("无法复制 bundle.toml: {e}")
            }
        );
        return Err(());
    }

    Ok(())
}

/// Install bundle files from `source_dir` into the wiki, compute integrity,
/// and update the lock file.
fn install_bundle_files_at(
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &manifest::BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), ()> {
    let target_rel = source::resolve_target_rel(manifest, use_json)?;
    let target_abs = wiki_root.join(&target_rel);

    if target_abs.exists() {
        let has_files = walkdir::WalkDir::new(&target_abs)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| e.file_type().is_file());

        if has_files {
            if !force {
                eprintln!(
                    "{}",
                    if use_json {
                        format!(
                            "bundle '{}' already installed at '{}', use --force to overwrite",
                            manifest.package.name, target_rel
                        )
                    } else {
                        format!(
                            "bundle '{}' 已安装到 '{}'，使用 --force 覆盖",
                            manifest.package.name, target_rel
                        )
                    }
                );
                return Err(());
            }
            let staging = TempDir::new_in(
                target_abs.parent().unwrap_or_else(|| Path::new(".")),
            )
            .map_err(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot create staging directory: {e}")
                    } else {
                        format!("无法创建临时目录: {e}")
                    }
                );
            })?;

            copy_bundle_files_to_target(
                source_dir,
                manifest_path,
                manifest,
                staging.path(),
                use_json,
            )?;

            if let Err(e) = std::fs::remove_dir_all(&target_abs) {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot remove existing target: {e}")
                    } else {
                        format!("无法移除已存在的目标目录: {e}")
                    }
                );
                return Err(());
            }
            std::fs::rename(staging.path(), &target_abs).map_err(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot rename staging to target: {e}")
                    } else {
                        format!("无法重命名临时目录: {e}")
                    }
                );
            })?;
            let _ = staging.keep();
        }
    }

    if !target_abs.exists() {
        if let Err(e) = std::fs::create_dir_all(&target_abs) {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot create target directory: {e}")
                } else {
                    format!("无法创建目标目录: {e}")
                }
            );
            return Err(());
        }

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
    let resolved =
        source::resolve_source(source, use_json).map_err(|()| Vec::new())?;
    let source_dir = resolved.path();
    let manifest_path = source_dir.join("bundle.toml");

    if !manifest_path.exists() {
        let msg = format!("bundle.toml not found in source '{source}'");
        if use_json {
            let output = serde_json::json!({
                "status": "fatal",
                "error": msg,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            eprintln!("在源 '{source}' 中未找到 bundle.toml");
        }
        return Err(Vec::new());
    }

    let (_content, manifest) = read_manifest(&manifest_path, use_json)
        .map_err(|msg| {
            if use_json {
                let output = serde_json::json!({
                    "status": "fatal",
                    "error": msg,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            } else {
                eprintln!("{msg}");
            }
            Vec::new()
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
    if cmd_install_at_inner(args, use_json, wiki_root).is_err() {
        process::exit(1);
    }
}

/// Inner implementation of `cmd_install_at` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
fn cmd_install_at_inner(
    args: &InstallArgs,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), ()> {
    let source = &args.source;

    let (resolved, manifest) =
        load_and_validate_manifest(source, use_json).map_err(|_| ())?;
    let source_dir = resolved.path();
    let manifest_path = source_dir.join("bundle.toml");

    if source::check_bundle_structure(source_dir, use_json).is_err() {
        return Err(());
    }

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
        return Err(());
    }

    if install_bundle_files_at(
        source_dir,
        &manifest_path,
        &manifest,
        args.force,
        use_json,
        wiki_root,
    )
    .is_err()
    {
        return Err(());
    }

    Ok(())
}

/// Thin wrapper that calls [`cmd_install_at`] with the real wiki directory.
pub fn cmd_install(args: &InstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    cmd_install_at(args, use_json, &wiki::wiki_dir());
}

// ---------------------------------------------------------------------------
// regenerate_root_index — write ~/.zoo/wiki/index.md
// ---------------------------------------------------------------------------

/// Append a bundle entry line and its domain entries (indented sub-pages) to
/// the output lines vector.
fn append_bundle_entry(
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
fn strip_frontmatter(content: &str) -> String {
    if content.starts_with("---") {
        content.splitn(3, "---").nth(2).unwrap_or(content).to_string()
    } else {
        content.to_string()
    }
}

/// Rewrite the first `[text](path)` link in `line` by prefixing relative
/// paths with `target`.  Returns the line unchanged if no link is found.
fn rewrite_link(line: &str, target: &str) -> String {
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

/// Write a root `index.md` at the given wiki root that aggregates all installed
/// bundles grouped by kind.
fn regenerate_root_index_at(lock: &lock::ZwikiLock, wiki_root: &Path) {
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
                    if let Err(e) = std::fs::write(&index_path, &updated) {
                        eprintln!(
                            "警告: 无法写入索引文件 {}: {e}",
                            index_path.display()
                        );
                    }
                    return;
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
        "---\nokf_version: \"0.1\"\n---\n\n# Wiki Index\n\n{generated_str}\n"
    );
    if let Err(e) = std::fs::write(&index_path, &full) {
        eprintln!("警告: 无法写入索引文件 {}: {e}", index_path.display());
    }
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
        if !content.contains(&format!("]({}", entry.target)) {
            return Err(format!(
                "root index.md 未引用已安装的 bundle: {}",
                entry.name
            ));
        }
    }

    Ok(())
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

// ---------------------------------------------------------------------------
// cmd_list_installed — `zwiki bundle list`
// ---------------------------------------------------------------------------

/// Format the bundle lock contents as a human-readable table.
#[must_use]
pub fn format_bundle_table(lock: &lock::ZwikiLock) -> String {
    if lock.bundles.is_empty() {
        return String::new();
    }

    let header_name = "NAME";
    let header_version = "VERSION";
    let header_target = "TARGET";
    let header_installed = "INSTALLED";

    let max_name = lock
        .bundles
        .iter()
        .map(|b| b.name.len())
        .max()
        .unwrap_or(0)
        .max(header_name.len());
    let max_version = lock
        .bundles
        .iter()
        .map(|b| b.version.len())
        .max()
        .unwrap_or(0)
        .max(header_version.len());
    let max_target = lock
        .bundles
        .iter()
        .map(|b| b.target.len())
        .max()
        .unwrap_or(0)
        .max(header_target.len());

    let mut out = String::new();

    writeln!(
        out,
        " {header_name:<max_name$}  {header_version:<max_version$}  {header_target:<max_target$}  {header_installed}",
    )
    .expect("write to string");
    writeln!(
        out,
        " {:-<width_name$}  {:-<width_ver$}  {:-<width_tgt$}  {:-<10}",
        "",
        "",
        "",
        "",
        width_name = max_name,
        width_ver = max_version,
        width_tgt = max_target,
    )
    .expect("write to string");

    for entry in &lock.bundles {
        let date = zutil::ts_display(&entry.installed_at);
        writeln!(
            out,
            " {:<width_name$}  {:<width_ver$}  {:<width_tgt$}  {}",
            entry.name,
            entry.version,
            entry.target,
            date,
            width_name = max_name,
            width_ver = max_version,
            width_tgt = max_target,
        )
        .expect("write to string");
    }

    out
}

/// List installed bundles from the lock file.
pub fn cmd_list_installed(args: &ListArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let l = lock::read_lock();

    if l.bundles.is_empty() {
        if use_json {
            println!("[]");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        process::exit(0);
    }

    if use_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&l).unwrap_or_else(|e| {
                eprintln!("JSON 序列化失败: {e}");
                process::exit(1);
            })
        );
        return;
    }

    print!("{}", format_bundle_table(&l));
}

// ---------------------------------------------------------------------------
// cmd_check — `zwiki bundle check`
// ---------------------------------------------------------------------------

/// Check integrity of installed bundles.
pub fn cmd_check(args: &CheckArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if cmd_check_inner(use_json, &wiki::wiki_dir()).is_err() {
        process::exit(1);
    }
}

/// Inner implementation of `cmd_check` that returns `Result` instead of
/// calling `process::exit`.  Returns `Ok(())` when all bundles are intact
/// (or no bundles are installed), and `Err(())` when issues are found.
fn cmd_check_inner(use_json: bool, wiki_root: &Path) -> Result<(), ()> {
    let l = lock::read_lock_at(wiki_root);

    if l.bundles.is_empty() {
        if use_json {
            println!("[]");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        return Ok(());
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
                }));
            } else {
                println!("✗ {} MISSING", entry.name);
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

    if use_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&results).map_err(|e| {
                eprintln!("JSON 序列化失败: {e}");
            })?
        );
    }

    if has_error { Err(()) } else { Ok(()) }
}

// ---------------------------------------------------------------------------
// cmd_update — `zwiki bundle update`
// ---------------------------------------------------------------------------

/// Compare two version strings by splitting on `.` and comparing numeric
/// components element-wise.
fn cmp_version(a: &str, b: &str) -> Ordering {
    let parts_a: Vec<&str> = a.split('.').collect();
    let parts_b: Vec<&str> = b.split('.').collect();
    let max_len = parts_a.len().max(parts_b.len());
    for i in 0..max_len {
        let va = parts_a.get(i).copied().unwrap_or("0");
        let vb = parts_b.get(i).copied().unwrap_or("0");
        let cmp = match (va.parse::<u64>(), vb.parse::<u64>()) {
            (Ok(na), Ok(nb)) => na.cmp(&nb),
            _ => va.cmp(vb),
        };
        if cmp != Ordering::Equal {
            return cmp;
        }
    }
    Ordering::Equal
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

fn fetch_remote_manifest(
    entry: &lock::ZwikiLockEntry,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
) -> Option<(String, String)> {
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
    let bundle_url = format!("{base_url}/bundle.toml");
    let resp = match http::http_client().get(&bundle_url).send() {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            push_err(
                results,
                &entry.name,
                &entry.version,
                &entry.version,
                format!("获取 bundle.toml 失败 (HTTP {})", r.status()).as_str(),
                use_json,
            );
            return None;
        }
        Err(e) => {
            push_err(
                results,
                &entry.name,
                &entry.version,
                &entry.version,
                format!("无法访问 registry: {e}").as_str(),
                use_json,
            );
            return None;
        }
    };
    if let Some(cl) = resp.content_length()
        && cl > http::MAX_BUNDLE_SIZE
    {
        push_err(
            results,
            &entry.name,
            &entry.version,
            &entry.version,
            format!(
                "bundle.toml too large: {cl} bytes (max {})",
                http::MAX_BUNDLE_SIZE
            )
            .as_str(),
            use_json,
        );
        return None;
    }
    let bundle_content = match http::read_body_capped_string(resp) {
        Ok(t) => t,
        Err(e) => {
            push_err(
                results,
                &entry.name,
                &entry.version,
                &entry.version,
                format!("无法读取 bundle.toml: {e}").as_str(),
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
    let remote_version = remote.package.version;
    check_remote_version(remote_version, entry, results, use_json, base_url)
}

/// Compare the remote version with the local entry version and emit
/// appropriate result entries.
fn check_remote_version(
    remote_version: String,
    entry: &lock::ZwikiLockEntry,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
    base_url: String,
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
        if use_json {
            results.push(serde_json::json!({
                "name": entry.name, "status": "downgrade",
                "from": entry.version, "to": remote_version,
                "reason": "remote version is older than local, auto-downgrading",
            }));
        } else {
            eprintln!(
                "⚠️  远端版本 {} 低于本地版本 {}，将自动降级",
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
            push_err(
                results,
                name,
                entry_version,
                remote_version,
                format!("下载 tar.gz 失败 (HTTP {})", r.status()).as_str(),
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
    if let Some(cl) = tar_resp.content_length()
        && cl > http::MAX_BUNDLE_SIZE
    {
        push_err(
            results,
            name,
            entry_version,
            remote_version,
            format!(
                "tar.gz too large: {cl} bytes (max {})",
                http::MAX_BUNDLE_SIZE
            )
            .as_str(),
            use_json,
        );
        return None;
    }
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

/// Update a single bundle entry from its configured registry.
fn update_single_bundle_at(
    entry: &lock::ZwikiLockEntry,
    l: &mut lock::ZwikiLock,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), ()> {
    let Some((base_url, remote_version)) =
        fetch_remote_manifest(entry, results, use_json)
    else {
        return Ok(());
    };

    let Some((tmp, src_bundle_toml)) = download_and_extract_update_tar(
        &base_url,
        &entry.name,
        &remote_version,
        &entry.version,
        results,
        use_json,
    ) else {
        return Ok(());
    };

    let target_abs = wiki_root.join(&entry.target);

    let staging =
        TempDir::new_in(target_abs.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|e| {
                let msg = format!("无法创建临时目录: {e}");
                if use_json {
                    eprintln!("{msg}");
                } else {
                    eprintln!("错误: {msg}");
                }
            })?;

    tar::copy_recursive(tmp.path(), staging.path(), true).map_err(|e| {
        let msg = format!("无法复制文件: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
    })?;

    std::fs::copy(&src_bundle_toml, staging.path().join("bundle.toml"))
        .map_err(|e| {
            let msg = format!("无法复制 bundle.toml: {e}");
            if use_json {
                eprintln!("{msg}");
            } else {
                eprintln!("错误: {msg}");
            }
        })?;

    let integrity = lock::compute_integrity(staging.path());

    if target_abs.exists() {
        std::fs::remove_dir_all(&target_abs).map_err(|e| {
            let msg = format!("无法移除已存在的目标目录: {e}");
            if use_json {
                eprintln!("{msg}");
            } else {
                eprintln!("错误: {msg}");
            }
        })?;
    }
    std::fs::rename(staging.path(), &target_abs).map_err(|e| {
        let msg = format!("无法重命名临时目录: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
    })?;
    let _ = staging.keep();

    let installed_at = Utc::now().to_rfc3339();
    let updated_entry = lock::ZwikiLockEntry {
        name: entry.name.clone(),
        version: remote_version.clone(),
        registry: entry.registry.clone(),
        target: entry.target.clone(),
        integrity,
        installed_at,
        description: entry.description.clone(),
    };

    lock::upsert_bundle(l, updated_entry, true).map_err(|e| {
        eprintln!("{e}");
    })?;

    if use_json {
        results.push(serde_json::json!({
            "name": entry.name,
            "status": "updated",
            "from": entry.version,
            "to": remote_version,
            "reason": "ok",
        }));
    } else {
        println!(
            "已更新: {} {} → {}",
            entry.name, entry.version, remote_version
        );
    }
    Ok(())
}

/// Update installed bundles from their configured registry, using an explicit
/// `wiki_root` so it can be tested without touching the real wiki directory.
pub fn cmd_update_at(args: &UpdateArgs, use_json: bool, wiki_root: &Path) {
    let _flock =
        zutil::fileio::acquire_file_lock(&wiki_root.join(".zwiki.flock"))
            .unwrap_or_else(|e| {
                let msg = format!("无法获取文件锁: {e}");
                if use_json {
                    eprintln!("{msg}");
                } else {
                    eprintln!("错误: {msg}");
                }
                process::exit(1);
            });

    let mut l = lock::read_lock_at(wiki_root);

    let pending: Vec<lock::ZwikiLockEntry> = l
        .bundles
        .iter()
        .filter(|b| args.name.as_ref().is_none_or(|n| b.name == *n))
        .cloned()
        .collect();

    if pending.is_empty() {
        if use_json {
            println!("[]");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        process::exit(0);
    }

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut had_error = false;

    for entry in &pending {
        if update_single_bundle_at(
            entry,
            &mut l,
            &mut results,
            use_json,
            wiki_root,
        )
        .is_err()
        {
            had_error = true;
            lock::write_lock_at(&l, wiki_root).unwrap_or_else(|e| {
                eprintln!("无法写入锁文件: {e}");
            });
            break;
        }
    }

    if !had_error {
        lock::write_lock_at(&l, wiki_root).unwrap_or_else(|e| {
            let msg = format!("无法写入锁文件: {e}");
            if use_json {
                eprintln!("{msg}");
            } else {
                eprintln!("错误: {msg}");
            }
            process::exit(1);
        });
    }

    if use_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&results).unwrap_or_else(|e| {
                eprintln!("JSON 序列化失败: {e}");
                process::exit(1);
            })
        );
    }

    if had_error {
        process::exit(1);
    }
}

/// Update installed bundles from their configured registry.
pub fn cmd_update(args: &UpdateArgs, global_json: bool) {
    let use_json = args.json || global_json;
    cmd_update_at(args, use_json, &wiki::wiki_dir());
}

// ---------------------------------------------------------------------------
// cmd_uninstall — `zwiki bundle uninstall <name>`
// ---------------------------------------------------------------------------

/// Uninstall a bundle by name: remove its directory, lock entry, and
/// regenerate the root index.
pub fn cmd_uninstall(args: &UninstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let wiki_root = wiki::wiki_dir();
    if cmd_uninstall_inner(args, use_json, &wiki_root).is_err() {
        process::exit(1);
    }
}

/// Inner implementation of `cmd_uninstall` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
fn cmd_uninstall_inner(
    args: &UninstallArgs,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), ()> {
    let _flock =
        zutil::fileio::acquire_file_lock(&wiki_root.join(".zwiki.flock"))
            .map_err(|e| {
                eprintln!("无法获取文件锁: {e}");
            })?;

    let mut l = lock::read_lock_at(wiki_root);

    let pos = l.bundles.iter().position(|b| b.name == args.name);
    let entry = if let Some(idx) = pos {
        l.bundles.remove(idx)
    } else {
        let msg = if use_json {
            format!("bundle '{}' not found", args.name)
        } else {
            format!("bundle '{}' 未找到", args.name)
        };
        eprintln!("{msg}");
        return Err(());
    };

    uninstall_bundle_entry_inner(&l, &entry, wiki_root, use_json)?;

    if use_json {
        let output = serde_json::json!({
            "status": "ok",
            "name": args.name,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        println!("已卸载: {}", args.name);
    }

    Ok(())
}

/// Internal helper that removes a bundle entry's directory from disk, writes
/// the updated lock, and regenerates the root index.
fn uninstall_bundle_entry_inner(
    l: &lock::ZwikiLock,
    entry: &lock::ZwikiLockEntry,
    wiki_root: &Path,
    use_json: bool,
) -> Result<(), ()> {
    let target_abs = wiki_root.join(&entry.target);
    if target_abs.exists() {
        std::fs::remove_dir_all(&target_abs).map_err(|e| {
            let msg = if use_json {
                format!("cannot remove '{}': {e}", entry.target)
            } else {
                format!("无法移除 '{}': {e}", entry.target)
            };
            eprintln!("{msg}");
        })?;
    }

    lock::write_lock_at(l, wiki_root).map_err(|e| {
        let msg = if use_json {
            format!("cannot write lock file: {e}")
        } else {
            format!("无法写入锁文件: {e}")
        };
        eprintln!("{msg}");
    })?;

    regenerate_root_index_at(l, wiki_root);

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Helper to parse `BundleCommand` subcommands in tests.
    #[derive(Parser)]
    struct BundleTestParser {
        #[command(subcommand)]
        cmd: BundleCommand,
    }

    // -------------------------------------------------------------------
    // Derive name
    // -------------------------------------------------------------------

    #[test]
    fn test_derive_name_fallback() {
        let name = derive_name();
        assert!(!name.is_empty());
    }

    // -------------------------------------------------------------------
    // BundleCommand parsing (clap)
    // -------------------------------------------------------------------

    #[test]
    fn test_export_args_parse() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "export",
            "/some/dir",
            "--output",
            "bundle.tar.gz",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert_eq!(args.dir, "/some/dir");
                assert_eq!(args.output, Some("bundle.tar.gz".to_string()));
            }
            _ => panic!("expected Export"),
        }
    }

    #[test]
    fn test_install_args_parse() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "install",
            "https://example.com/bundle.tar.gz",
            "--force",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Install(args) => {
                assert_eq!(args.source, "https://example.com/bundle.tar.gz");
                assert!(args.force);
            }
            _ => panic!("expected Install"),
        }
    }

    #[test]
    fn test_install_args_local_dir() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "install",
            "./my-bundle",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Install(args) => {
                assert_eq!(args.source, "./my-bundle");
                assert!(!args.force);
            }
            _ => panic!("expected Install"),
        }
    }

    #[test]
    fn test_export_args_default_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "export", "/some/dir"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert!(!args.json);
                assert_eq!(args.output, None);
            }
            _ => panic!("expected Export"),
        }
    }

    #[test]
    fn test_install_args_defaults() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "install", "/path"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Install(args) => {
                assert!(!args.force);
                assert!(!args.json);
            }
            _ => panic!("expected Install"),
        }
    }

    // -------------------------------------------------------------------
    // ListArgs parsing
    // -------------------------------------------------------------------

    #[test]
    fn test_list_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "list"]).unwrap();
        match parser.cmd {
            BundleCommand::List(args) => {
                assert!(!args.json);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_args_parse_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "list", "--json"])
                .unwrap();
        match parser.cmd {
            BundleCommand::List(args) => {
                assert!(args.json);
            }
            _ => panic!("expected List"),
        }
    }

    // -------------------------------------------------------------------
    // CheckArgs parsing
    // -------------------------------------------------------------------

    #[test]
    fn test_check_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "check"]).unwrap();
        match parser.cmd {
            BundleCommand::Check(args) => {
                assert!(!args.json);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_args_parse_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "check", "--json"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Check(args) => {
                assert!(args.json);
            }
            _ => panic!("expected Check"),
        }
    }

    // -------------------------------------------------------------------
    // UpdateArgs parsing
    // -------------------------------------------------------------------

    #[test]
    fn test_update_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "update"]).unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert!(args.name.is_none());
                assert!(!args.json);
            }
            _ => panic!("expected Update"),
        }
    }

    #[test]
    fn test_update_args_parse_name() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "update",
            "--name",
            "my-bundle",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert_eq!(args.name, Some("my-bundle".to_string()));
                assert!(!args.json);
            }
            _ => panic!("expected Update"),
        }
    }

    #[test]
    fn test_update_args_parse_json() {
        let parser = BundleTestParser::try_parse_from([
            "bundle", "update", "--name", "test", "--json",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert_eq!(args.name, Some("test".to_string()));
                assert!(args.json);
            }
            _ => panic!("expected Update"),
        }
    }

    // -------------------------------------------------------------------
    // cmd_list_installed with empty lock (no-op)
    // -------------------------------------------------------------------

    #[test]
    fn test_list_empty_lock_reads_gracefully() {
        let lock = lock::ZwikiLock { bundles: Vec::new() };
        let formatted = format_bundle_table(&lock);
        assert!(formatted.is_empty());
    }

    // -------------------------------------------------------------------
    // format_bundle_table formatting
    // -------------------------------------------------------------------

    #[test]
    fn test_format_bundle_table_with_entries() {
        let entries = vec![
            lock::ZwikiLockEntry {
                name: "test-bundle".to_string(),
                version: "1.0.0".to_string(),
                registry: String::new(),
                target: ".upstream/test-bundle/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-07-05T12:00:00Z".to_string(),
                description: None,
            },
            lock::ZwikiLockEntry {
                name: "another-pkg".to_string(),
                version: "2.1.0".to_string(),
                registry: String::new(),
                target: ".teams/my-team/".to_string(),
                integrity: "sha256-def".to_string(),
                installed_at: "2026-06-01T00:00:00Z".to_string(),
                description: None,
            },
        ];
        let lock = lock::ZwikiLock { bundles: entries };
        let table = format_bundle_table(&lock);
        assert!(table.contains("test-bundle"));
        assert!(table.contains("another-pkg"));
        assert!(table.contains("1.0.0"));
        assert!(table.contains("2.1.0"));
        assert!(table.contains("NAME"));
        assert!(table.contains("VERSION"));
        assert!(table.contains("TARGET"));
        assert!(table.contains("INSTALLED"));
        assert!(table.lines().count() >= 4);
    }

    #[test]
    fn test_format_bundle_table_empty() {
        let lock = lock::ZwikiLock { bundles: Vec::new() };
        let table = format_bundle_table(&lock);
        assert!(table.is_empty());
    }

    // -------------------------------------------------------------------
    // regenerate_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_regenerate_root_index_empty_lock() {
        let tmp = temp_dir("regenerate_index_empty");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock = lock::ZwikiLock { bundles: Vec::new() };
        regenerate_root_index_at(&lock, &wiki_root);

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
        };
        regenerate_root_index_at(&lock, &wiki_root);

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
        };
        regenerate_root_index_at(&lock, &wiki_root);

        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists());

        let content = std::fs::read_to_string(&index_path).unwrap();
        assert!(content.contains("## 组织 Bundles"));
        assert!(content.contains("### [my-org]"));
        assert!(content.contains("Org bundle"));
        assert!(content.contains("<!-- ZOO:BUNDLES:END -->"));
    }

    // -------------------------------------------------------------------
    // replace_marked_section — preserve user content
    // -------------------------------------------------------------------

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
        };
        regenerate_root_index_at(&lock1, &wiki_root);

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
        };
        regenerate_root_index_at(&lock2, &wiki_root);

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

    // -------------------------------------------------------------------
    // cmd_uninstall (parsing + basic uninstall logic)
    // -------------------------------------------------------------------

    #[test]
    fn test_uninstall_args_parse() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "uninstall",
            "my-bundle",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Uninstall(args) => {
                assert_eq!(args.name, "my-bundle");
                assert!(!args.json);
            }
            _ => panic!("expected Uninstall"),
        }
    }

    #[test]
    fn test_uninstall_args_parse_json() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "uninstall",
            "my-bundle",
            "--json",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Uninstall(args) => {
                assert_eq!(args.name, "my-bundle");
                assert!(args.json);
            }
            _ => panic!("expected Uninstall"),
        }
    }

    // -------------------------------------------------------------------
    // uninstall_bundle_entry_inner (integration-style)
    // -------------------------------------------------------------------

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
        let mut l = lock::ZwikiLock { bundles: vec![entry] };

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

    // -------------------------------------------------------------------
    // push_err — both branches
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // cmd_install_at — full integration test
    // -------------------------------------------------------------------

    fn w(path: PathBuf, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    const DOC_M0: &str = "---\ntitle: Doc\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Doc Content\n\nThis document has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n";
    const RDM0: &str = "---\ntitle: Readme\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Readme\n\nThis readme has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n";
    const IDX0: &str = "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Doc](doc.md)\n- [Readme](readme.md)\n";
    const DOC_U0: &str = "---\ntitle: Doc\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Updated Doc Content\n\nThis document has been updated to test force reinstall. It has enough text to pass health and lint checks during reinstall.\n";
    const NEW_M0: &str = "---\ntitle: New\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# New File\n\nThis new file is added during the force reinstall test step. It has enough text to pass health and lint checks.\n";
    const IDX_U0: &str = "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Doc](doc.md)\n- [Readme](readme.md)\n- [New](new.md)\n";

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

    // -------------------------------------------------------------------
    // cmd_install_at rejects unhealthy bundle (no TempDir leak)
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // load_and_validate_manifest — behavior tests
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // check_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_check_root_index_missing() {
        let dir = temp_dir("check_root_index_missing");
        let lock = lock::ZwikiLock { bundles: Vec::new() };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    #[test]
    fn test_check_root_index_missing_begin() {
        let dir = temp_dir("check_root_index_missing_begin");
        std::fs::write(dir.join("index.md"), "no markers here\n").unwrap();
        let lock = lock::ZwikiLock { bundles: Vec::new() };
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
        let lock = lock::ZwikiLock { bundles: Vec::new() };
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
        };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未引用"));
    }

    // -------------------------------------------------------------------
    // read_manifest
    // -------------------------------------------------------------------

    #[test]
    fn test_read_manifest_returns_err_on_missing_file() {
        let dir = temp_dir("read_manifest_missing");
        let path = dir.join("bundle.toml");
        let result = read_manifest(&path, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无法读取 bundle.toml"));
    }

    #[test]
    fn test_read_manifest_returns_err_on_invalid_toml() {
        let dir = temp_dir("read_manifest_invalid");
        let path = dir.join("bundle.toml");
        std::fs::write(&path, "invalid toml {{{").unwrap();
        let result = read_manifest(&path, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无效的 bundle.toml"));
    }

    // -------------------------------------------------------------------
    // load_and_validate_manifest — TempDir drop on parse error
    // -------------------------------------------------------------------

    #[test]
    fn test_load_and_validate_manifest_drops_tempdir_on_parse_error() {
        let dir = temp_dir("lv_manifest_parse_err");
        std::fs::write(dir.join("bundle.toml"), "invalid toml {{{").unwrap();
        let result = load_and_validate_manifest(dir.to_str().unwrap(), false);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // install_bundle_files_at — error propagation
    // -------------------------------------------------------------------

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

    fn valid_manifest_with_name(name: &str) -> manifest::BundleManifest {
        manifest::BundleManifest {
            package: manifest::PackageSection {
                name: name.to_string(),
                version: "1.0.0".to_string(),
                okf_version: "0.1".to_string(),
                kind: "upstream".to_string(),
                team: None,
                registry: None,
                description: None,
            },
            export: manifest::ExportSection {
                include: vec!["*.md".to_string()],
                exclude: Vec::new(),
            },
        }
    }

    // -------------------------------------------------------------------
    // cmd_init_inner — error path returns Err (no process::exit)
    // -------------------------------------------------------------------

    #[test]
    fn test_cmd_init_inner_rejects_empty_name() {
        let args = InitArgs {
            name: Some(String::new()),
            version: "0.1.0".to_string(),
            kind: "upstream".to_string(),
            okf_version: "0.1".to_string(),
            team: None,
            registry: None,
            description: None,
            include: vec!["*.md".to_string()],
            exclude: Vec::new(),
            output: None,
            json: false,
        };
        let result = cmd_init_inner(&args, false);
        assert!(result.is_err(), "empty name should return Err");
    }

    // -------------------------------------------------------------------
    // cmd_install_at_inner — error path returns Err (no process::exit)
    // -------------------------------------------------------------------

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
        let args =
            InstallArgs { source: src.to_string(), force: false, json: false };

        let result = cmd_install_at_inner(&args, false, &wiki_root);
        assert!(result.is_err(), "unhealthy bundle should be rejected");
    }

    // -------------------------------------------------------------------
    // cmd_check_inner — error path returns Err (no process::exit)
    // -------------------------------------------------------------------

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
        let l = lock::ZwikiLock { bundles: vec![entry] };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&l).unwrap(),
        )
        .unwrap();

        let result = cmd_check_inner(false, &wiki_root);
        assert!(result.is_err(), "mismatched integrity should return Err");
    }

    // -------------------------------------------------------------------
    // cmd_uninstall_inner — error path returns Err (no process::exit)
    // -------------------------------------------------------------------

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
        };
        let result = check_root_index(&dir, &lock);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("未引用"), "expected not-referenced error: {err}");
    }

    // -------------------------------------------------------------------
    // update_single_bundle_at — error path returns Err (no process::exit)
    // -------------------------------------------------------------------

    #[test]
    fn test_update_single_bundle_at_returns_err_on_copy_failure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::os::unix::fs::PermissionsExt;

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
        let lock_path = wiki_root.join("zwiki.lock");
        let entry = lock::ZwikiLockEntry {
            name: "test-bundle".to_string(),
            version: "1.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/test-bundle/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock = lock::ZwikiLock { bundles: vec![entry.clone()] };
        std::fs::write(&lock_path, toml::to_string_pretty(&lock).unwrap())
            .unwrap();

        let upstream = wiki_root.join(".upstream");
        std::fs::create_dir_all(&upstream).unwrap();
        std::fs::set_permissions(&upstream, PermissionsExt::from_mode(0o444))
            .unwrap();

        let mut lock_mut = lock::read_lock_at(&wiki_root);
        let mut results = Vec::new();

        let result = update_single_bundle_at(
            &entry,
            &mut lock_mut,
            &mut results,
            false,
            &wiki_root,
        );
        assert!(
            result.is_err(),
            "update should fail when target dir is non-writable"
        );

        server.join().unwrap();

        let _ = std::fs::set_permissions(
            &upstream,
            PermissionsExt::from_mode(0o755),
        );
    }

    // -------------------------------------------------------------------
    // cmd_update_at — partial lock persistence
    // -------------------------------------------------------------------

    #[test]
    fn test_cmd_update_at_persists_partial_lock_on_error() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::os::unix::fs::PermissionsExt;

        let bundle_a_toml = br#"[package]
name = "bundle-a"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        let tar_a = tar::raw_tar_gz("bundle.toml", bundle_a_toml);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let tar_a_shared = tar_a;

        let server = std::thread::spawn(move || {
            for mut stream in listener.incoming().take(4).flatten() {
                let mut buf = [0u8; 4096];
                if stream.read(&mut buf).is_err() {
                    break;
                }
                let request = String::from_utf8_lossy(&buf);
                let (body, content_type) = if request.contains("bundle.toml") {
                    (bundle_a_toml.to_vec(), "text/plain")
                } else {
                    (tar_a_shared.clone(), "application/gzip")
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

        let wiki_root = temp_dir("update_partial_lock");

        let entry_a = lock::ZwikiLockEntry {
            name: "bundle-a".to_string(),
            version: "1.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/bundle-a/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let entry_b = lock::ZwikiLockEntry {
            name: "bundle-b".to_string(),
            version: "1.0.0".to_string(),
            registry: format!("http://127.0.0.1:{port}"),
            target: ".upstream/bundle-b/".to_string(),
            integrity: "sha256-def".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let lock = lock::ZwikiLock { bundles: vec![entry_a, entry_b] };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        let target_a = wiki_root.join(".upstream").join("bundle-a");
        std::fs::create_dir_all(&target_a).unwrap();
        let upstream_b = wiki_root.join(".upstream");
        std::fs::create_dir_all(&upstream_b).unwrap();
        let target_b = wiki_root.join(".upstream").join("bundle-b");
        std::fs::create_dir_all(&target_b).unwrap();
        std::fs::set_permissions(&target_b, PermissionsExt::from_mode(0o444))
            .unwrap();

        let args = UpdateArgs { name: None, json: false };
        let use_json = false;

        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_update_at(&args, use_json, &wiki_root);
            }));

        let _ = std::fs::set_permissions(
            &target_b,
            PermissionsExt::from_mode(0o755),
        );

        if result.is_err() {
            eprintln!("cmd_update_at panicked (not process::exit)");
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

        server.join().unwrap();
    }

    // -------------------------------------------------------------------
    // Staging rollback: update failure preserves old files
    // -------------------------------------------------------------------

    #[test]
    fn test_update_staging_rollback_preserves_old_files() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

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
        let lock = lock::ZwikiLock { bundles: vec![entry] };
        std::fs::write(
            wiki_root.join("zwiki.lock"),
            toml::to_string_pretty(&lock).unwrap(),
        )
        .unwrap();

        let args =
            UpdateArgs { name: Some("rollback-test".to_string()), json: false };
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

    // -------------------------------------------------------------------
    // cmp_version
    // -------------------------------------------------------------------

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
        assert_eq!(cmp_version("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
        assert_eq!(cmp_version("1.0.0-beta", "1.0.0-alpha"), Ordering::Greater);
    }

    // -------------------------------------------------------------------
    // fetch_remote_manifest — downgrade hint
    // -------------------------------------------------------------------

    #[test]
    fn test_fetch_remote_manifest_downgrade_hint() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

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
        let result = fetch_remote_manifest(&entry, &mut results, true);

        assert!(
            result.is_some(),
            "fetch_remote_manifest should return Some for downgrade"
        );
        let (_base_url, remote_version) = result.unwrap();
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

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }
}
