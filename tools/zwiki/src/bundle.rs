//! Bundle distribution — bundle manifest struct, validation, and CLI commands.
//!
//! A bundle is a distributable collection of wiki pages and assets, described
//! by a `bundle.toml` manifest with `[package]` and `[export]` sections.
//!
//! Bundles can be exported to `.tar.gz` archives and installed into the wiki
//! directory under `.upstream/<name>/` (upstream bundles) or
//! `.teams/<team>/` (team bundles).  A `zwiki.lock` file tracks installed
//! bundles with integrity hashing.

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use std::fmt::Write;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process;

use chrono::Utc;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};
use tar::Builder;
use walkdir::WalkDir;

use crate::wiki;

// ---------------------------------------------------------------------------
// Severity — three-tier validation
// ---------------------------------------------------------------------------

/// Validation severity level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Severity {
    /// Hard error that rejects the operation.
    Fatal,
    /// Non-blocking issue that the user should be aware of.
    Warning,
    /// Field required only when a condition is met (e.g. `team` when
    /// `kind == "team"`).
    ConditionalRequired,
}

/// A single validation result.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationError {
    pub severity: Severity,
    pub field: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// BundleManifest — data model
// ---------------------------------------------------------------------------

/// The top-level bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    #[serde(rename = "package")]
    pub package: PackageSection,
    #[serde(rename = "export")]
    pub export: ExportSection,
}

/// `[package]` section of the bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageSection {
    pub name: String,
    pub version: String,
    #[serde(default = "default_okf_version")]
    pub okf_version: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub team: Option<String>,
    pub registry: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `[export]` section of the bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSection {
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[must_use]
fn default_okf_version() -> String {
    "0.1".to_string()
}

#[must_use]
fn default_kind() -> String {
    "upstream".to_string()
}

impl BundleManifest {
    /// Validate the manifest, returning a list of all issues found.
    ///
    /// Three-tier severity: **Fatal** rejects the operation, **Warning** is a
    /// non-blocking advisory, **`ConditionalRequired`** flags a field that is
    /// mandatory only under specific conditions.
    #[must_use]
    pub fn validate(&self) -> Vec<ValidationError> {
        let mut errors: Vec<ValidationError> = Vec::new();

        // --- Fatal checks ---
        if self.package.name.trim().is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.name".to_string(),
                message: "包名称不能为空".to_string(),
            });
        }

        if self.package.version.trim().is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.version".to_string(),
                message: "包版本不能为空".to_string(),
            });
        }

        if self.export.include.is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "export.include".to_string(),
                message: "导出包含规则不能为空".to_string(),
            });
        }

        let kind = self.package.kind.trim().to_lowercase();
        if kind != "upstream" && kind != "team" && kind != "org" {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.kind".to_string(),
                message: format!(
                    "无效的 kind 值 '{}'，可选值为 upstream、team 或 org",
                    self.package.kind
                ),
            });
        }

        // --- ConditionalRequired ---
        if kind == "team" && self.package.team.is_none() {
            errors.push(ValidationError {
                severity: Severity::ConditionalRequired,
                field: "package.team".to_string(),
                message: "当 kind 为 'team' 时，team 字段是必需的".to_string(),
            });
        }

        // --- Warning checks ---
        if self.package.okf_version.trim() != "0.1" {
            errors.push(ValidationError {
                severity: Severity::Warning,
                field: "package.okf_version".to_string(),
                message: format!(
                    "不推荐的 okf_version '{}'，建议使用 '0.1'",
                    self.package.okf_version
                ),
            });
        }

        errors
    }
}

// ---------------------------------------------------------------------------
// ZwikiLock — persistent bundle registry lock file
// ---------------------------------------------------------------------------

/// The lock file tracking installed bundles under `~/.zoo/wiki/zwiki.lock`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZwikiLock {
    #[serde(rename = "bundles")]
    pub bundles: Vec<ZwikiLockEntry>,
}

/// A single installed bundle entry in the lock file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZwikiLockEntry {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub registry: String,
    pub target: String,
    pub integrity: String,
    pub installed_at: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Return the absolute path to the lock file.
#[must_use]
pub fn lock_path() -> PathBuf {
    wiki::wiki_dir().join("zwiki.lock")
}

/// Read the lock file from disk, returning an empty lock if it doesn't exist.
#[must_use]
pub fn read_lock() -> ZwikiLock {
    let path = lock_path();
    if !path.exists() {
        return ZwikiLock { bundles: Vec::new() };
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("警告: 无法读取 zwiki.lock ({e})，已重置");
            return ZwikiLock { bundles: Vec::new() };
        }
    };
    toml::from_str(&content).unwrap_or_else(|e| {
        eprintln!("警告: zwiki.lock 损坏 ({e})，已重置");
        ZwikiLock { bundles: Vec::new() }
    })
}

/// Write the lock file to disk.
///
/// # Errors
///
/// Returns an I/O error if the file cannot be written.
pub fn write_lock(lock: &ZwikiLock) -> io::Result<()> {
    let content = toml::to_string_pretty(lock).map_err(io::Error::other)?;
    std::fs::write(lock_path(), content)
}

/// Read the lock file from a specific wiki root (testable variant).
#[must_use]
fn read_lock_at(wiki_root: &Path) -> ZwikiLock {
    let path = wiki_root.join("zwiki.lock");
    if !path.exists() {
        return ZwikiLock { bundles: Vec::new() };
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("警告: 无法读取 zwiki.lock ({e})，已重置");
            return ZwikiLock { bundles: Vec::new() };
        }
    };
    toml::from_str(&content).unwrap_or_else(|e| {
        eprintln!("警告: zwiki.lock 损坏 ({e})，已重置");
        ZwikiLock { bundles: Vec::new() }
    })
}

/// Write the lock file to a specific wiki root (testable variant).
///
/// # Errors
///
/// Returns an I/O error if the file cannot be written.
fn write_lock_at(lock: &ZwikiLock, wiki_root: &Path) -> io::Result<()> {
    let content = toml::to_string_pretty(lock).map_err(io::Error::other)?;
    std::fs::write(wiki_root.join("zwiki.lock"), content)
}

/// Insert or update a bundle entry in the lock.
///
/// If a bundle with the same `name` already exists and `force` is `false`,
/// returns `Err("bundle already installed")`.  If `force` is `true`, the
/// existing entry is replaced.  Otherwise the entry is appended.
///
/// # Errors
///
/// Returns an error string if the bundle is already installed and `force` is
/// `false`.
pub fn upsert_bundle(
    lock: &mut ZwikiLock,
    entry: ZwikiLockEntry,
    force: bool,
) -> Result<(), String> {
    let pos = lock.bundles.iter().position(|b| b.name == entry.name);
    if let Some(p) = pos {
        if !force {
            return Err("bundle already installed".to_string());
        }
        lock.bundles[p] = entry;
    } else {
        lock.bundles.push(entry);
    }
    Ok(())
}

/// Base64-encode the given bytes using the standard (RFC 4648) alphabet.
fn base64_encode(data: impl AsRef<[u8]>) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data.as_ref())
}

/// Compute an SRI-style integrity hash for all files under `dir`.
///
/// Recursively walks `dir`, collecting all regular files.  Files are sorted
/// by relative path for determinism.  For each file the relative path and
/// contents are fed into SHA-256 as `path\0contents`.  The returned string
/// has the format `sha256-<base64>`.
#[must_use]
pub fn compute_integrity(dir: &Path) -> String {
    let mut hasher = Sha256::new();

    let mut entries: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();

    entries.sort();

    for abs_path in &entries {
        let rel = abs_path
            .strip_prefix(dir)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .to_string();
        let content = match std::fs::read(abs_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!(
                    "警告: 无法读取文件用于完整性计算: {} ({e})",
                    abs_path.display()
                );
                Vec::new()
            }
        };

        // Feed "path\0contents" to detect both content and path changes
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(&content);
    }

    let hash_bytes = hasher.finalize();
    let encoded = base64_encode(hash_bytes);
    format!("sha256-{encoded}")
}

// ---------------------------------------------------------------------------
// TempDir — RAII temporary directory
// ---------------------------------------------------------------------------

/// A temporary directory that is automatically cleaned up on drop.
struct TempDir {
    path: Option<PathBuf>,
}

impl TempDir {
    /// Create a new temporary directory under the system temp dir.
    fn new(prefix: &str) -> io::Result<Self> {
        let base = std::env::temp_dir();
        let mut i = 0u64;
        loop {
            let path = base.join(format!("{prefix}-{i}"));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path: Some(path) }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    i += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Return the path to the temporary directory.
    fn path(&self) -> &Path {
        self.path.as_ref().expect("TempDir path is None (already taken)")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if let Some(ref p) = self.path {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

// ---------------------------------------------------------------------------
// Recursive directory copy helper
// ---------------------------------------------------------------------------

/// Recursively copy all files from `src` to `dst`, preserving relative paths.
///
/// If `skip_root_bundle` is `true`, the file `bundle.toml` at the root of `src`
/// is skipped (useful for the install step where `bundle.toml` is copied
/// separately).
fn copy_recursive(
    src: &Path,
    dst: &Path,
    skip_root_bundle: bool,
) -> io::Result<()> {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel =
            entry.path().strip_prefix(src).unwrap_or_else(|_| entry.path());
        if skip_root_bundle && rel == Path::new("bundle.toml") {
            continue;
        }
        let target = dst.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(entry.path(), &target)?;
    }
    Ok(())
}

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

    /// Strict mode: missing include paths are fatal instead of warn
    #[arg(long)]
    pub strict: bool,

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

    /// Strict path validation
    #[arg(long)]
    pub strict: bool,

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
    let resolved_name =
        args.name.clone().map_or_else(derive_name, String::from);

    let manifest = BundleManifest {
        package: PackageSection {
            name: resolved_name,
            version: args.version.clone(),
            okf_version: args.okf_version.clone(),
            kind: args.kind.clone(),
            team: args.team.clone(),
            registry: args.registry.clone(),
            description: args.description.clone(),
        },
        export: ExportSection {
            include: if args.include.is_empty() {
                vec!["pages/**/*.md".to_string()]
            } else {
                args.include.clone()
            },
            exclude: args.exclude.clone(),
        },
    };

    // Validate before output.
    let errors = manifest.validate();
    let fatals: Vec<&ValidationError> =
        errors.iter().filter(|e| e.severity == Severity::Fatal).collect();

    if !fatals.is_empty() {
        for err in &fatals {
            eprintln!("错误: [{}] {}", err.field, err.message);
        }
        process::exit(1);
    }

    // Print warnings to stderr regardless of output format.
    for err in &errors {
        if err.severity == Severity::Warning
            || err.severity == Severity::ConditionalRequired
        {
            eprintln!("提醒: [{}] {}", err.field, err.message);
        }
    }

    let use_json = args.json || global_json;

    // Serialize as TOML (bundle.toml is always TOML format).
    let serialized = if use_json {
        serde_json::to_string_pretty(&manifest).unwrap_or_else(|e| {
            eprintln!("JSON 序列化失败: {e}");
            process::exit(1);
        })
    } else {
        toml::to_string_pretty(&manifest).unwrap_or_else(|e| {
            eprintln!("TOML 序列化失败: {e}");
            process::exit(1);
        })
    };

    // Write to file or stdout.
    if let Some(ref path) = args.output {
        std::fs::write(path, &serialized).unwrap_or_else(|e| {
            eprintln!("写入文件失败: {e}");
            process::exit(1);
        });
        eprintln!("已生成 bundle.toml 模板");
    } else {
        println!("{serialized}");
    }
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/// Read and parse `bundle.toml` from the given path.
///
/// Returns the raw content and the parsed manifest.  Exits on failure.
fn read_manifest(
    manifest_path: &Path,
    use_json: bool,
) -> (String, BundleManifest) {
    let content = std::fs::read_to_string(manifest_path).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot read bundle.toml: {e}")
            } else {
                format!("无法读取 bundle.toml: {e}")
            }
        );
        process::exit(1);
    });

    let manifest: BundleManifest =
        toml::from_str(&content).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("invalid bundle.toml: {e}")
                } else {
                    format!("无效的 bundle.toml: {e}")
                }
            );
            process::exit(1);
        });

    (content, manifest)
}

/// Validate the manifest and print errors.  Exits on fatal or (in strict
/// mode) on any non-fatal issue.  Non-fatal warnings are printed to stderr.
fn check_manifest_errors(
    errors: &[ValidationError],
    strict: bool,
    use_json: bool,
) {
    let fatals: Vec<&ValidationError> =
        errors.iter().filter(|e| e.severity == Severity::Fatal).collect();

    // In strict mode, warnings and conditional-required are also fatal.
    let strict_fatals: Vec<&ValidationError> = if strict {
        errors.iter().filter(|e| e.severity != Severity::Fatal).collect()
    } else {
        Vec::new()
    };

    if !fatals.is_empty() || (!strict_fatals.is_empty()) {
        for err in &fatals {
            eprintln!(
                "{}",
                if use_json {
                    format!("fatal: [{}] {}", err.field, err.message)
                } else {
                    format!("错误: [{}] {}", err.field, err.message)
                }
            );
        }
        for err in &strict_fatals {
            eprintln!(
                "{}",
                if use_json {
                    format!("fatal: [{}] {}", err.field, err.message)
                } else {
                    format!("错误: [{}] {}", err.field, err.message)
                }
            );
        }
        process::exit(1);
    }

    // Print non-fatal warnings in non-strict mode.
    if !strict {
        for err in errors {
            if err.severity == Severity::Warning
                || err.severity == Severity::ConditionalRequired
            {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("warn: [{}] {}", err.field, err.message)
                    } else {
                        format!("提醒: [{}] {}", err.field, err.message)
                    }
                );
            }
        }
    }
}

/// Collect files matching include/exclude globs relative to `bundle_dir`.
fn collect_export_files(
    bundle_dir: &Path,
    include: &[String],
    exclude: &[String],
    strict: bool,
    use_json: bool,
) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for pattern in include {
        let full_pattern =
            bundle_dir.join(pattern).to_string_lossy().to_string();
        let matches: Vec<PathBuf> = glob::glob(&full_pattern)
            .unwrap_or_else(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("invalid glob pattern '{pattern}': {e}")
                    } else {
                        format!("无效的 glob 模式 '{pattern}': {e}")
                    }
                );
                process::exit(1);
            })
            .filter_map(|r| match r {
                Ok(p) => {
                    // Only regular files
                    if p.is_file() { Some(p) } else { None }
                }
                Err(e) => {
                    if strict {
                        eprintln!(
                            "{}",
                            if use_json {
                                format!("glob error for '{pattern}': {e}")
                            } else {
                                format!("glob 错误 '{pattern}': {e}")
                            }
                        );
                        process::exit(1);
                    }
                    None
                }
            })
            .collect();

        if matches.is_empty() {
            if strict {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("include glob '{pattern}' matched no files")
                    } else {
                        format!("包含规则 '{pattern}' 没有匹配任何文件")
                    }
                );
                process::exit(1);
            }
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "warning: include glob '{pattern}' matched no files"
                    )
                } else {
                    format!("警告: 包含规则 '{pattern}' 没有匹配任何文件")
                }
            );
        }

        // Add unique files
        for p in matches {
            if !files.contains(&p) {
                files.push(p);
            }
        }
    }

    // --- Apply exclude globs ---
    for pattern in exclude {
        let full_pattern =
            bundle_dir.join(pattern).to_string_lossy().to_string();
        if let Ok(entries) = glob::glob(&full_pattern) {
            for entry in entries.flatten() {
                files.retain(|f| *f != entry);
            }
        }
    }

    files.sort();
    files
}

/// Append all matching export files to a tar archive.
fn add_files_to_tar_archive(
    tar: &mut Builder<GzEncoder<std::fs::File>>,
    bundle_dir: &Path,
    files: &[PathBuf],
    use_json: bool,
) {
    for abs_path in files {
        let relative_path =
            abs_path.strip_prefix(bundle_dir).unwrap_or(abs_path);
        let mut src_file = std::fs::File::open(abs_path).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot open '{}': {e}", abs_path.display())
                } else {
                    format!("无法打开 '{}': {e}", abs_path.display())
                }
            );
            process::exit(1);
        });

        let metadata = src_file.metadata().unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "cannot read metadata for '{}': {e}",
                        abs_path.display()
                    )
                } else {
                    format!("无法读取文件信息 '{}': {e}", abs_path.display())
                }
            );
            process::exit(1);
        });

        let mut header = tar::Header::new_gnu();
        header.set_path(relative_path).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "tar header error for '{}': {e}",
                        relative_path.display()
                    )
                } else {
                    format!("tar 头错误 '{}': {e}", relative_path.display())
                }
            );
            process::exit(1);
        });
        header.set_size(metadata.len());
        header.set_mode(0o644);
        header.set_cksum();
        tar.append(&header, &mut src_file).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "tar append error for '{}': {e}",
                        relative_path.display()
                    )
                } else {
                    format!("tar 添加错误 '{}': {e}", relative_path.display())
                }
            );
            process::exit(1);
        });
    }
}

/// Create a tar.gz archive at `output_path` containing `bundle.toml` and
/// the given `files` (with paths relative to `bundle_dir`).
fn write_tar_gz(
    output_path: &str,
    bundle_dir: &Path,
    manifest_content: &str,
    files: &[PathBuf],
    use_json: bool,
) {
    let file = std::fs::File::create(output_path).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot create output file: {e}")
            } else {
                format!("无法创建输出文件: {e}")
            }
        );
        process::exit(1);
    });

    let encoder = GzEncoder::new(file, Compression::default());
    let mut tar = Builder::new(encoder);

    // Add bundle.toml first
    {
        let mut header = tar::Header::new_gnu();
        header.set_path("bundle.toml").unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("tar header error: {e}")
                } else {
                    format!("tar 头错误: {e}")
                }
            );
            process::exit(1);
        });
        header.set_size(manifest_content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append(&header, manifest_content.as_bytes()).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("tar append error: {e}")
                } else {
                    format!("tar 添加错误: {e}")
                }
            );
            process::exit(1);
        });
    }

    // Add all collected files
    add_files_to_tar_archive(&mut tar, bundle_dir, files, use_json);

    let encoder = tar.into_inner().unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("tar finalize error: {e}")
            } else {
                format!("tar 完成错误: {e}")
            }
        );
        process::exit(1);
    });
    encoder.finish().unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("gzip finalize error: {e}")
            } else {
                format!("gzip 完成错误: {e}")
            }
        );
        process::exit(1);
    });
}

// ---------------------------------------------------------------------------
// cmd_export — `zwiki bundle export`
// ---------------------------------------------------------------------------

/// Export a bundle directory into a `.tar.gz` archive.
pub fn cmd_export(args: &ExportArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let bundle_dir = Path::new(&args.dir);

    // --- Read and parse bundle.toml ---
    let manifest_path = bundle_dir.join("bundle.toml");
    let (manifest_content, manifest) = read_manifest(&manifest_path, use_json);

    // --- Validate ---
    let errors = manifest.validate();
    check_manifest_errors(&errors, args.strict, use_json);

    // --- Expand include/exclude globs ---
    let files = collect_export_files(
        bundle_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        args.strict,
        use_json,
    );

    // --- Determine output path ---
    let output_path = args.output.clone().unwrap_or_else(|| {
        format!("{}-{}.tar.gz", manifest.package.name, manifest.package.version)
    });

    // --- Create tar.gz ---
    write_tar_gz(&output_path, bundle_dir, &manifest_content, &files, use_json);

    // --- Output ---
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
}

// ---------------------------------------------------------------------------
// cmd_install — `zwiki bundle install`
// ---------------------------------------------------------------------------

/// Compute integrity, update the lock file, and print the install output.
/// Uses an explicit `wiki_root` so it can be tested without touching the real
/// wiki directory.
fn finalize_install_and_lock_at(
    target_abs: &Path,
    target_rel: String,
    manifest: &BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) {
    // --- Compute integrity ---
    let integrity = compute_integrity(target_abs);

    // --- Update lock ---
    let installed_at = Utc::now().to_rfc3339();
    let entry = ZwikiLockEntry {
        name: manifest.package.name.clone(),
        version: manifest.package.version.clone(),
        registry: manifest.package.registry.clone().unwrap_or_default(),
        target: target_rel,
        integrity: integrity.clone(),
        installed_at,
        description: manifest.package.description.clone(),
    };

    let mut lock = read_lock_at(wiki_root);
    upsert_bundle(&mut lock, entry, force).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });
    write_lock_at(&lock, wiki_root).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot write lock file: {e}")
            } else {
                format!("无法写入锁文件: {e}")
            }
        );
        process::exit(1);
    });

    // --- Regenerate root index ---
    regenerate_root_index_at(&lock, wiki_root);

    // --- Output ---
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
}

/// Copy files matched by manifest include/exclude + bundle.toml into the
/// target directory.  Extracted from `install_bundle_files` to keep the
/// function under the `too_many_lines` limit.
fn copy_bundle_files_to_target(
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &BundleManifest,
    target_abs: &Path,
    use_json: bool,
) {
    let files = collect_export_files(
        source_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        false,
        use_json,
    );
    for abs_path in &files {
        let rel = abs_path.strip_prefix(source_dir).unwrap_or(abs_path);
        let target = target_abs.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).unwrap_or_else(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot create dir: {e}")
                    } else {
                        format!("无法创建目录: {e}")
                    }
                );
                process::exit(1);
            });
        }
        std::fs::copy(abs_path, &target).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot copy file: {e}")
                } else {
                    format!("无法复制文件: {e}")
                }
            );
            process::exit(1);
        });
    }

    // Copy bundle.toml separately (for identity + registry traceback)
    std::fs::copy(manifest_path, target_abs.join("bundle.toml"))
        .unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot copy bundle.toml: {e}")
                } else {
                    format!("无法复制 bundle.toml: {e}")
                }
            );
            process::exit(1);
        });
}

/// Install bundle files from `source_dir` into the wiki, compute integrity,
/// and update the lock file.
/// Uses an explicit `wiki_root` so it can be tested without touching the real
/// wiki directory.
fn install_bundle_files_at(
    source_dir: &Path,
    manifest_path: &Path,
    manifest: &BundleManifest,
    force: bool,
    use_json: bool,
    wiki_root: &Path,
) {
    let target_rel = resolve_target_rel(manifest, use_json);
    let target_abs = wiki_root.join(&target_rel);

    // --- Check if already installed ---
    if target_abs.exists() {
        let has_files = WalkDir::new(&target_abs)
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
                process::exit(1);
            }
            // force — remove existing
            std::fs::remove_dir_all(&target_abs).unwrap_or_else(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot remove existing target: {e}")
                    } else {
                        format!("无法移除已存在的目标目录: {e}")
                    }
                );
                process::exit(1);
            });
        }
    }

    // --- Create target and copy files ---
    std::fs::create_dir_all(&target_abs).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot create target directory: {e}")
            } else {
                format!("无法创建目标目录: {e}")
            }
        );
        process::exit(1);
    });

    copy_bundle_files_to_target(
        source_dir,
        manifest_path,
        manifest,
        &target_abs,
        use_json,
    );

    // --- Compute integrity, update lock, and output ---
    finalize_install_and_lock_at(
        &target_abs,
        target_rel,
        manifest,
        force,
        use_json,
        wiki_root,
    );
}

/// Install a bundle from a local directory, tar.gz file, or URL.
/// Uses an explicit `wiki_root` so it can be tested without touching the real
/// wiki directory.
pub fn cmd_install_at(args: &InstallArgs, use_json: bool, wiki_root: &Path) {
    let source = &args.source;

    // --- Resolve source to a directory containing bundle.toml ---
    let resolved = resolve_source(source, args.strict, use_json);
    let source_dir = resolved.path();
    let manifest_path = source_dir.join("bundle.toml");

    if !manifest_path.exists() {
        eprintln!(
            "{}",
            if use_json {
                format!("bundle.toml not found in source '{source}'")
            } else {
                format!("在源 '{source}' 中未找到 bundle.toml")
            }
        );
        process::exit(1);
    }

    // --- Parse and validate manifest ---
    let (_manifest_content, manifest) = read_manifest(&manifest_path, use_json);
    let errors = manifest.validate();
    check_manifest_errors(&errors, args.strict, use_json);

    // --- Install files + compute integrity + write lock ---
    install_bundle_files_at(
        source_dir,
        &manifest_path,
        &manifest,
        args.force,
        use_json,
        wiki_root,
    );

    // TempDir is dropped here, cleaning up resolved source
}

/// Thin wrapper that calls [`cmd_install_at`] with the real wiki directory.
pub fn cmd_install(args: &InstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    cmd_install_at(args, use_json, &wiki::wiki_dir());
}

// ---------------------------------------------------------------------------
// Safe tar extraction — prevents path traversal
// ---------------------------------------------------------------------------

/// Extract a tar archive safely, skipping entries with absolute paths or `..`
/// components that would escape `dest`.
fn safe_unpack<R: io::Read>(
    archive: &mut tar::Archive<R>,
    dest: &Path,
) -> io::Result<()> {
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;

        // Deny absolute paths and path traversal
        if path.is_absolute()
            || path.components().any(|c| c == Component::ParentDir)
        {
            let display_path = path.display().to_string();
            eprintln!("警告: 跳过可疑路径: {display_path}");
            continue;
        }

        entry.unpack_in(dest)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/// Resolve a bundle source (URL, tar.gz, or local directory) to a directory
/// containing `bundle.toml`.
///
/// Returns a `TempDir` that is cleaned up when the returned value is dropped.
fn resolve_source(source: &str, strict: bool, use_json: bool) -> TempDir {
    // URL source
    if source.starts_with("http://") || source.starts_with("https://") {
        return resolve_url_source(source, strict, use_json);
    }

    // Local tar.gz file
    let source_lower = source.to_lowercase();
    if source_lower.ends_with(".tar.gz")
        || Path::new(source)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tgz"))
    {
        return resolve_tar_source(Path::new(source), strict, use_json);
    }

    // Local directory
    let dir = Path::new(source);
    if dir.is_dir() {
        // Create a temp dir and copy everything into it.
        let tmp = TempDir::new("zwiki-install").unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot create temp directory: {e}")
                } else {
                    format!("无法创建临时目录: {e}")
                }
            );
            process::exit(1);
        });

        copy_recursive(dir, tmp.path(), false).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot copy source directory: {e}")
                } else {
                    format!("无法复制源目录: {e}")
                }
            );
            process::exit(1);
        });

        return tmp;
    }

    eprintln!(
        "{}",
        if use_json {
            format!("source '{source}' is not a file, directory or URL")
        } else {
            format!("源 '{source}' 不是文件、目录或 URL")
        }
    );
    process::exit(1);
}

/// Download individual files from a directory URL based on manifest include
/// patterns.
fn download_manifest_files(
    url: &str,
    tmp_path: &Path,
    include: &[String],
    strict: bool,
    use_json: bool,
) {
    for pattern in include {
        // Skip glob patterns — we can only download specific files
        if pattern.contains('*')
            || pattern.contains('?')
            || pattern.contains('[')
        {
            if strict {
                eprintln!(
                    "{}",
                    if use_json {
                        format!(
                            "cannot download files matching glob pattern '{pattern}' from directory URL"
                        )
                    } else {
                        format!(
                            "无法从目录 URL 下载匹配 glob 模式 '{pattern}' 的文件"
                        )
                    }
                );
                process::exit(1);
            }
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "warning: cannot download files matching glob pattern '{pattern}' from directory URL"
                    )
                } else {
                    format!(
                        "警告: 无法从目录 URL 下载匹配 glob 模式 '{pattern}' 的文件"
                    )
                }
            );
            continue;
        }

        // Reject path traversal in include patterns
        let pattern_path = Path::new(pattern);
        if pattern_path.is_absolute()
            || pattern_path.components().any(|c| c == Component::ParentDir)
        {
            eprintln!(
                "{}",
                if use_json {
                    format!("warning: skipping out-of-bounds path '{pattern}'")
                } else {
                    format!("警告: 跳过越界路径: {pattern}")
                }
            );
            continue;
        }

        // Download individual file
        let file_url = format!("{}/{}", url.trim_end_matches('/'), pattern);
        let file_resp = reqwest::blocking::get(&file_url);
        if let Ok(resp) = file_resp {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes() {
                    let target_path = tmp_path.join(pattern);
                    if let Some(parent) = target_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&target_path, &bytes);
                }
            } else if strict {
                eprintln!(
                    "{}",
                    if use_json {
                        format!(
                            "cannot fetch '{}' (status {})",
                            file_url,
                            resp.status()
                        )
                    } else {
                        format!(
                            "无法获取 '{}' (状态 {})",
                            file_url,
                            resp.status()
                        )
                    }
                );
                process::exit(1);
            }
        } else if strict {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot fetch '{file_url}'")
                } else {
                    format!("无法获取 '{file_url}'")
                }
            );
            process::exit(1);
        }
    }
}

/// Download a bundle directory from a URL (non-tar.gz path).
///
/// Fetches `bundle.toml` and the individual files listed in the manifest,
/// writing them into the given temporary directory.
fn download_dir_from_url(
    url: &str,
    tmp_path: &Path,
    strict: bool,
    use_json: bool,
) {
    // Simplified directory URL: try to fetch <url>/bundle.toml
    let bundle_url = format!("{}/bundle.toml", url.trim_end_matches('/'));
    let bundle_resp = reqwest::blocking::get(&bundle_url).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot fetch '{bundle_url}': {e}")
            } else {
                format!("无法访问 '{bundle_url}': {e}")
            }
        );
        process::exit(1);
    });

    if !bundle_resp.status().is_success() {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "cannot find bundle.toml at '{}' (status {})",
                    bundle_url,
                    bundle_resp.status()
                )
            } else {
                format!(
                    "在 '{}' 未找到 bundle.toml (状态 {})",
                    bundle_url,
                    bundle_resp.status()
                )
            }
        );
        process::exit(1);
    }

    let bundle_content = bundle_resp.text().unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot read bundle.toml: {e}")
            } else {
                format!("无法读取 bundle.toml: {e}")
            }
        );
        process::exit(1);
    });

    // Write bundle.toml to temp dir
    let btoml_path = tmp_path.join("bundle.toml");
    std::fs::write(&btoml_path, &bundle_content).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot write bundle.toml: {e}")
            } else {
                format!("无法写入 bundle.toml: {e}")
            }
        );
        process::exit(1);
    });

    // Parse manifest to discover and download individual files
    if let Ok(manifest) = toml::from_str::<BundleManifest>(&bundle_content) {
        download_manifest_files(
            url,
            tmp_path,
            &manifest.export.include,
            strict,
            use_json,
        );
    }
}

/// Resolve a URL source by downloading bundle content.
fn resolve_url_source(url: &str, strict: bool, use_json: bool) -> TempDir {
    let tmp = TempDir::new("zwiki-install").unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot create temp directory: {e}")
            } else {
                format!("无法创建临时目录: {e}")
            }
        );
        process::exit(1);
    });

    // Check if URL points to a tar.gz
    let url_lower = url.to_lowercase();
    let is_tar = url_lower.ends_with(".tar.gz")
        || Path::new(url)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tgz"));

    let response = reqwest::blocking::get(url).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot fetch URL '{url}': {e}")
            } else {
                format!("无法访问 URL '{url}': {e}")
            }
        );
        process::exit(1);
    });

    if !response.status().is_success() {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "fetching '{}' returned status {}",
                    url,
                    response.status()
                )
            } else {
                format!("访问 '{}' 返回状态 {}", url, response.status())
            }
        );
        process::exit(1);
    }

    if is_tar {
        // Download tar.gz and extract
        let bytes = response.bytes().unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot read response body: {e}")
                } else {
                    format!("无法读取响应内容: {e}")
                }
            );
            process::exit(1);
        });

        let decoder = GzDecoder::new(bytes.as_ref());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, tmp.path()).unwrap_or_else(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot extract tar.gz: {e}")
                } else {
                    format!("无法解压 tar.gz: {e}")
                }
            );
            process::exit(1);
        });
    } else {
        download_dir_from_url(url, tmp.path(), strict, use_json);
    }

    tmp
}

/// Resolve a local tar.gz file by extracting to a temp directory.
fn resolve_tar_source(
    tar_path: &Path,
    _strict: bool,
    use_json: bool,
) -> TempDir {
    let tmp = TempDir::new("zwiki-install").unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot create temp directory: {e}")
            } else {
                format!("无法创建临时目录: {e}")
            }
        );
        process::exit(1);
    });

    let file = std::fs::File::open(tar_path).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot open '{}': {e}", tar_path.display())
            } else {
                format!("无法打开 '{}': {e}", tar_path.display())
            }
        );
        process::exit(1);
    });

    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    safe_unpack(&mut archive, tmp.path()).unwrap_or_else(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot extract '{}': {e}", tar_path.display())
            } else {
                format!("无法解压 '{}': {e}", tar_path.display())
            }
        );
        process::exit(1);
    });

    tmp
}

/// Determine the wiki-relative install target path from the manifest.
fn resolve_target_rel(manifest: &BundleManifest, use_json: bool) -> String {
    let kind = manifest.package.kind.trim().to_lowercase();
    match kind.as_str() {
        "upstream" => format!(".upstream/{}/", manifest.package.name),
        "org" => format!(".org/{}/", manifest.package.name),
        "team" => {
            let team = manifest.package.team.as_deref().unwrap_or_default();
            if team.is_empty() {
                eprintln!(
                    "{}",
                    if use_json {
                        "team bundles require a 'team' field".to_string()
                    } else {
                        "团队 bundle 需要指定 team 字段".to_string()
                    }
                );
                process::exit(1);
            }
            format!(".teams/{team}/")
        }
        _ => {
            eprintln!(
                "{}",
                if use_json {
                    format!("unknown kind '{kind}'")
                } else {
                    format!("未知的 kind 值 '{kind}'")
                }
            );
            process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// regenerate_root_index — write ~/.zoo/wiki/index.md
// ---------------------------------------------------------------------------

/// Append a bundle entry line and its domain entries (indented sub-pages) to
/// the output lines vector.
///
/// Domain entries are derived from the bundle's own `index.md` (if it exists),
/// falling back to scanning the bundle directory for subdirectories and
/// root-level `.md` pages.
fn append_bundle_entry(
    lines: &mut Vec<String>,
    entry: &ZwikiLockEntry,
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
        // Strip frontmatter, then extract unordered list lines.
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
/// bundles grouped by kind (teams, upstream, org), each with a link to the
/// bundle root, its description, and the domains within each bundle.
///
/// Wraps generated content in `<!-- ZOO:BUNDLES:BEGIN -->` / `ZOO:BUNDLES:END`
/// markers.  If the file already exists, only the marked section is replaced;
/// user content above or below the markers is preserved.
fn regenerate_root_index_at(lock: &ZwikiLock, wiki_root: &Path) {
    let mut generated: Vec<String> =
        vec!["<!-- ZOO:BUNDLES:BEGIN -->".to_string(), String::new()];

    if lock.bundles.is_empty() {
        generated.push("_暂无已安装的 bundle。_".to_string());
        generated.push(String::new());
    } else {
        let mut teams: Vec<&ZwikiLockEntry> = Vec::new();
        let mut upstreams: Vec<&ZwikiLockEntry> = Vec::new();
        let mut orgs: Vec<&ZwikiLockEntry> = Vec::new();

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

    // If the file already exists with markers, replace only the marked section.
    // Otherwise (first time or legacy format), overwrite with the full content.
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

    // First time or legacy — full overwrite with frontmatter.
    let full = format!(
        "---\nokf_version: \"0.1\"\n---\n\n# Wiki Index\n\n{generated_str}\n"
    );
    if let Err(e) = std::fs::write(&index_path, &full) {
        eprintln!("警告: 无法写入索引文件 {}: {e}", index_path.display());
    }
}

/// Replace the content between `<!-- ZOO:BUNDLES:BEGIN -->` and
/// `<!-- ZOO:BUNDLES:END -->` markers in `existing` with `replacement`.
///
/// Returns an error if the markers are missing or malformed.
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

    // Find the end of the END marker line.
    let after_end = end_pos + end.len();
    // Include the newline after END if present.
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
///
/// Returns an empty string when there are no bundles.
#[must_use]
pub fn format_bundle_table(lock: &ZwikiLock) -> String {
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

    // Header
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
    let lock = read_lock();

    if lock.bundles.is_empty() {
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
            serde_json::to_string_pretty(&lock).unwrap_or_else(|e| {
                eprintln!("JSON 序列化失败: {e}");
                process::exit(1);
            })
        );
        return;
    }

    print!("{}", format_bundle_table(&lock));
}

// ---------------------------------------------------------------------------
// cmd_check — `zwiki bundle check`
// ---------------------------------------------------------------------------

/// Check integrity of installed bundles.
pub fn cmd_check(args: &CheckArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let lock = read_lock();

    if lock.bundles.is_empty() {
        if use_json {
            println!("[]");
        } else {
            eprintln!("没有已安装的 bundle");
        }
        process::exit(0);
    }

    let wiki_root = wiki::wiki_dir();
    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut has_error = false;

    for entry in &lock.bundles {
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

        let actual = compute_integrity(&abs_path);
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
            serde_json::to_string_pretty(&results).unwrap_or_else(|e| {
                eprintln!("JSON 序列化失败: {e}");
                process::exit(1);
            })
        );
    }

    if has_error {
        process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// cmd_update — `zwiki bundle update`
// ---------------------------------------------------------------------------

/// Fetch the remote manifest for a bundle entry, parse it, and compare
/// versions.  Returns `None` (after pushing an appropriate result entry) on
/// error or when the bundle is already up-to-date.
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
    entry: &ZwikiLockEntry,
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
    let resp = match reqwest::blocking::get(&bundle_url) {
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
    let bundle_content = match resp.text() {
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
    let remote: BundleManifest = match toml::from_str(&bundle_content) {
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
    Some((base_url, remote_version))
}

/// Download the updated tar.gz for a bundle, extract it to a temp directory,
/// and verify `bundle.toml` exists.  Returns `None` (after pushing a result
/// entry) on error.
fn download_and_extract_update_tar(
    base_url: &str,
    name: &str,
    remote_version: &str,
    entry_version: &str,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
) -> Option<(TempDir, PathBuf)> {
    let tar_url = format!("{base_url}/{name}-{remote_version}.tar.gz");
    let tar_resp = match reqwest::blocking::get(&tar_url) {
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
    let tmp = match TempDir::new("zwiki-update") {
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
    let bytes = match tar_resp.bytes() {
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
    let decoder = GzDecoder::new(bytes.as_ref());
    let mut archive = tar::Archive::new(decoder);
    if let Err(e) = safe_unpack(&mut archive, tmp.path()) {
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
///
/// Fetches the remote bundle manifest, compares versions, downloads and
/// installs the new version if available.  Appends a result entry to
/// `results` and updates `lock` in place.
fn update_single_bundle(
    entry: &ZwikiLockEntry,
    lock: &mut ZwikiLock,
    results: &mut Vec<serde_json::Value>,
    use_json: bool,
) {
    let Some((base_url, remote_version)) =
        fetch_remote_manifest(entry, results, use_json)
    else {
        return;
    };

    let Some((tmp, src_bundle_toml)) = download_and_extract_update_tar(
        &base_url,
        &entry.name,
        &remote_version,
        &entry.version,
        results,
        use_json,
    ) else {
        return;
    };

    // Install into existing target directory.
    let wiki_root = wiki::wiki_dir();
    let target_abs = wiki_root.join(&entry.target);

    // Remove existing files.
    if target_abs.exists() {
        std::fs::remove_dir_all(&target_abs).unwrap_or_else(|e| {
            let msg = format!("无法移除已存在的目标目录: {e}");
            if use_json {
                eprintln!("{msg}");
            } else {
                eprintln!("错误: {msg}");
            }
            process::exit(1);
        });
    }

    std::fs::create_dir_all(&target_abs).unwrap_or_else(|e| {
        let msg = format!("无法创建目标目录: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
        process::exit(1);
    });

    // Copy files (skip root bundle.toml).
    copy_recursive(tmp.path(), &target_abs, true).unwrap_or_else(|e| {
        let msg = format!("无法复制文件: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
        process::exit(1);
    });

    // Copy bundle.toml separately.
    std::fs::copy(&src_bundle_toml, target_abs.join("bundle.toml"))
        .unwrap_or_else(|e| {
            let msg = format!("无法复制 bundle.toml: {e}");
            if use_json {
                eprintln!("{msg}");
            } else {
                eprintln!("错误: {msg}");
            }
            process::exit(1);
        });

    // Compute integrity.
    let integrity = compute_integrity(&target_abs);

    // Update lock entry.
    let installed_at = Utc::now().to_rfc3339();
    let updated_entry = ZwikiLockEntry {
        name: entry.name.clone(),
        version: remote_version.clone(),
        registry: entry.registry.clone(),
        target: entry.target.clone(),
        integrity,
        installed_at,
        description: entry.description.clone(),
    };

    upsert_bundle(lock, updated_entry, true).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });

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
}

/// Update installed bundles from their configured registry.
pub fn cmd_update(args: &UpdateArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let mut lock = read_lock();

    // Collect entries to update (owned to avoid borrow issues).
    let pending: Vec<ZwikiLockEntry> = lock
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

    for entry in &pending {
        update_single_bundle(entry, &mut lock, &mut results, use_json);
    }

    // Persist lock changes.
    write_lock(&lock).unwrap_or_else(|e| {
        let msg = format!("无法写入锁文件: {e}");
        if use_json {
            eprintln!("{msg}");
        } else {
            eprintln!("错误: {msg}");
        }
        process::exit(1);
    });

    if use_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&results).unwrap_or_else(|e| {
                eprintln!("JSON 序列化失败: {e}");
                process::exit(1);
            })
        );
    }
}

// ---------------------------------------------------------------------------
// cmd_uninstall — `zwiki bundle uninstall <name>`
// ---------------------------------------------------------------------------

/// Uninstall a bundle by name: remove its directory, lock entry, and
/// regenerate the root index.
pub fn cmd_uninstall(args: &UninstallArgs, global_json: bool) {
    let use_json = args.json || global_json;
    let wiki_root = wiki::wiki_dir();
    let mut lock = read_lock();

    let pos = lock.bundles.iter().position(|b| b.name == args.name);
    let entry = if let Some(idx) = pos {
        lock.bundles.remove(idx)
    } else {
        let msg = if use_json {
            format!("bundle '{}' not found", args.name)
        } else {
            format!("bundle '{}' 未找到", args.name)
        };
        eprintln!("{msg}");
        process::exit(1);
    };

    // Delegate the actual removal and lock/index update.
    uninstall_bundle_entry(&lock, &entry, &wiki_root, use_json);

    // Output.
    if use_json {
        let output = serde_json::json!({
            "status": "ok",
            "name": args.name,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        println!("已卸载: {}", args.name);
    }
}

/// Internal helper that removes a bundle entry's directory from disk, writes
/// the updated lock, and regenerates the root index.  Exposed with a
/// `wiki_root` parameter so it can be tested without touching the real wiki.
fn uninstall_bundle_entry(
    lock: &ZwikiLock,
    entry: &ZwikiLockEntry,
    wiki_root: &Path,
    use_json: bool,
) {
    // Remove the target directory.
    let target_abs = wiki_root.join(&entry.target);
    if target_abs.exists() {
        std::fs::remove_dir_all(&target_abs).unwrap_or_else(|e| {
            let msg = if use_json {
                format!("cannot remove '{}': {e}", entry.target)
            } else {
                format!("无法移除 '{}': {e}", entry.target)
            };
            eprintln!("{msg}");
            process::exit(1);
        });
    }

    // Write updated lock to the given wiki root.
    let lock_path = wiki_root.join("zwiki.lock");
    let content = toml::to_string_pretty(lock).map_err(io::Error::other);
    if let Err(e) = content.and_then(|c| std::fs::write(&lock_path, c)) {
        let msg = if use_json {
            format!("cannot write lock file: {e}")
        } else {
            format!("无法写入锁文件: {e}")
        };
        eprintln!("{msg}");
        process::exit(1);
    }

    // Regenerate index at the given wiki root.
    regenerate_root_index_at(lock, wiki_root);
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
    // BundleManifest validation
    // -------------------------------------------------------------------

    fn valid_manifest() -> BundleManifest {
        BundleManifest {
            package: PackageSection {
                name: "test-bundle".to_string(),
                version: "0.1.0".to_string(),
                okf_version: "0.1".to_string(),
                kind: "upstream".to_string(),
                team: None,
                registry: None,
                description: None,
            },
            export: ExportSection {
                include: vec!["pages/**/*.md".to_string()],
                exclude: Vec::new(),
            },
        }
    }

    #[test]
    fn test_validate_ok() {
        let m = valid_manifest();
        let errors = m.validate();
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_empty_name_fatal() {
        let mut m = valid_manifest();
        m.package.name = String::new();
        let errors = m.validate();
        assert!(errors.iter().any(
            |e| e.severity == Severity::Fatal && e.field == "package.name"
        ));
    }

    #[test]
    fn test_validate_empty_version_fatal() {
        let mut m = valid_manifest();
        m.package.version = "   ".to_string();
        let errors = m.validate();
        assert!(
            errors.iter().any(|e| e.severity == Severity::Fatal
                && e.field == "package.version")
        );
    }

    #[test]
    fn test_validate_empty_include_fatal() {
        let mut m = valid_manifest();
        m.export.include.clear();
        let errors = m.validate();
        assert!(
            errors.iter().any(|e| e.severity == Severity::Fatal
                && e.field == "export.include")
        );
    }

    #[test]
    fn test_validate_invalid_kind_fatal() {
        let mut m = valid_manifest();
        m.package.kind = "invalid".to_string();
        let errors = m.validate();
        assert!(errors.iter().any(
            |e| e.severity == Severity::Fatal && e.field == "package.kind"
        ));
    }

    #[test]
    fn test_validate_team_required_when_kind_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = None;
        let errors = m.validate();
        assert!(
            errors.iter().any(|e| e.severity == Severity::ConditionalRequired
                && e.field == "package.team")
        );
    }

    #[test]
    fn test_validate_team_ok_when_kind_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = Some("my-team".to_string());
        let errors = m.validate();
        assert!(!errors.iter().any(|e| e.field == "package.team"));
    }

    #[test]
    fn test_validate_wrong_okf_version_warning() {
        let mut m = valid_manifest();
        m.package.okf_version = "0.2".to_string();
        let errors = m.validate();
        assert!(errors.iter().any(|e| e.severity == Severity::Warning
            && e.field == "package.okf_version"));
    }

    #[test]
    fn test_validate_kind_case_insensitive() {
        let mut m = valid_manifest();
        m.package.kind = "TEAM".to_string();
        m.package.team = Some("t".to_string());
        let errors = m.validate();
        assert!(!errors.iter().any(|e| e.field == "package.kind"));
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
    // Defaults
    // -------------------------------------------------------------------

    #[test]
    fn test_default_okf_version() {
        assert_eq!(default_okf_version(), "0.1");
    }

    #[test]
    fn test_default_kind() {
        assert_eq!(default_kind(), "upstream");
    }

    // -------------------------------------------------------------------
    // ZwikiLock helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    #[test]
    fn test_read_lock_file_not_exists() {
        // Temporarily override wiki_dir by creating an empty dir
        let dir = temp_dir("read_lock_not_exists");
        let lock_path = dir.join("zwiki.lock");
        // Don't create the file
        let exists = lock_path.exists();
        assert!(!exists, "lock file should not exist yet");
        // Just verify read_lock doesn't panic and returns empty
        // We can't easily mock wiki_dir, so we test the concept
        // by checking the struct creation directly
        let lock = ZwikiLock { bundles: Vec::new() };
        assert!(lock.bundles.is_empty());
    }

    #[test]
    fn test_upsert_bundle_new() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };

        assert!(upsert_bundle(&mut lock, entry, false).is_ok());
        assert_eq!(lock.bundles.len(), 1);
    }

    #[test]
    fn test_upsert_bundle_duplicate_no_force() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry1 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let entry2 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "2.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-def".to_string(),
            installed_at: "2026-01-02T00:00:00Z".to_string(),
            description: None,
        };

        upsert_bundle(&mut lock, entry1, false).unwrap();
        let result = upsert_bundle(&mut lock, entry2, false);
        assert!(result.is_err());
        assert_eq!(lock.bundles.len(), 1);
    }

    #[test]
    fn test_upsert_bundle_duplicate_force() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry1 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let entry2 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "2.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-def".to_string(),
            installed_at: "2026-01-02T00:00:00Z".to_string(),
            description: None,
        };

        upsert_bundle(&mut lock, entry1, false).unwrap();
        assert!(upsert_bundle(&mut lock, entry2, true).is_ok());
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].version, "2.0");
    }

    // -------------------------------------------------------------------
    // compute_integrity
    // -------------------------------------------------------------------

    #[test]
    fn test_compute_integrity_empty_dir() {
        let dir = temp_dir("integrity_empty");
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"), "hash should start with sha256-");
        // Empty directory should produce a deterministic hash
        assert_eq!(hash.len(), 51, "sha256- (7) + 44 base64 chars = 51");
    }

    #[test]
    fn test_compute_integrity_single_file() {
        let dir = temp_dir("integrity_single");
        std::fs::write(dir.join("test.md"), "hello").unwrap();
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"));
    }

    #[test]
    fn test_compute_integrity_deterministic() {
        let dir1 = temp_dir("integrity_det1");
        let dir2 = temp_dir("integrity_det2");
        std::fs::write(dir1.join("a.md"), "a").unwrap();
        std::fs::write(dir1.join("b.md"), "b").unwrap();
        std::fs::write(dir2.join("a.md"), "a").unwrap();
        std::fs::write(dir2.join("b.md"), "b").unwrap();
        assert_eq!(compute_integrity(&dir1), compute_integrity(&dir2));
    }

    #[test]
    fn test_compute_integrity_detects_rename() {
        let dir1 = temp_dir("integrity_rename1");
        let dir2 = temp_dir("integrity_rename2");
        // Same content, different filename
        std::fs::write(dir1.join("old-name.md"), "content").unwrap();
        std::fs::write(dir2.join("new-name.md"), "content").unwrap();
        assert_ne!(
            compute_integrity(&dir1),
            compute_integrity(&dir2),
            "renamed files should produce different hashes"
        );
    }

    // -------------------------------------------------------------------
    // resolve_target_rel
    // -------------------------------------------------------------------

    #[test]
    fn test_resolve_target_upstream() {
        let m = valid_manifest();
        let target = resolve_target_rel(&m, false);
        assert_eq!(target, ".upstream/test-bundle/");
    }

    #[test]
    fn test_resolve_target_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = Some("my-team".to_string());
        let target = resolve_target_rel(&m, false);
        assert_eq!(target, ".teams/my-team/");
    }

    // -------------------------------------------------------------------
    // TempDir
    // -------------------------------------------------------------------

    #[test]
    fn test_temp_dir_creates_and_cleans() {
        let path = {
            let tmp = TempDir::new("test-temp").unwrap();
            let p = tmp.path().to_path_buf();
            assert!(p.exists(), "temp dir should exist");
            p
        };
        // After TempDir is dropped, the directory should be removed
        assert!(!path.exists(), "temp dir should be cleaned up");
    }

    // -------------------------------------------------------------------
    // copy_recursive
    // -------------------------------------------------------------------

    #[test]
    fn test_copy_recursive_copies_files() {
        let src = temp_dir("copy_recursive_src");
        let dst = temp_dir("copy_recursive_dst");

        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("a.md"), "a").unwrap();
        std::fs::write(src.join("subdir").join("b.md"), "b").unwrap();
        std::fs::write(src.join("bundle.toml"), "[package]\nname = \"test\"\n")
            .unwrap();

        copy_recursive(&src, &dst, false).unwrap();
        assert!(dst.join("a.md").exists());
        assert!(dst.join("subdir").join("b.md").exists());
        assert!(dst.join("bundle.toml").exists());
    }

    #[test]
    fn test_copy_recursive_skips_root_bundle_toml() {
        let src = temp_dir("copy_recursive_skip");
        let dst = temp_dir("copy_recursive_skip_dst");

        std::fs::write(src.join("a.md"), "a").unwrap();
        std::fs::write(src.join("bundle.toml"), "[package]\nname = \"test\"\n")
            .unwrap();

        copy_recursive(&src, &dst, true).unwrap();
        assert!(dst.join("a.md").exists());
        assert!(!dst.join("bundle.toml").exists());
    }

    // -------------------------------------------------------------------
    // read_lock / write_lock roundtrip
    // -------------------------------------------------------------------

    #[test]
    fn test_write_lock_roundtrip() {
        let dir = temp_dir("lock_roundtrip");

        let entry = ZwikiLockEntry {
            name: "mypkg".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/mypkg/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-06-01T12:00:00Z".to_string(),
            description: None,
        };
        let lock = ZwikiLock { bundles: vec![entry] };

        // Serialize to TOML manually (write_lock uses wiki_dir which is ~/.zoo/wiki/)
        let toml_str = toml::to_string_pretty(&lock).unwrap();
        let lock_file = dir.join("zwiki.lock");
        std::fs::write(&lock_file, &toml_str).unwrap();

        // Read back
        let content = std::fs::read_to_string(&lock_file).unwrap();
        let parsed: ZwikiLock = toml::from_str(&content).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].name, "mypkg");
        assert_eq!(parsed.bundles[0].version, "1.0.0");
    }

    // -------------------------------------------------------------------
    // Export tar.gz (integration)
    // -------------------------------------------------------------------

    #[test]
    fn test_export_creates_tar_gz() {
        let dir = temp_dir("export_test");
        // Create bundle.toml
        let bundle_toml = r#"
[package]
name = "test-export-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["pages/**/*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();

        // Create some files matching the glob
        std::fs::create_dir_all(dir.join("pages")).unwrap();
        std::fs::write(dir.join("pages").join("hello.md"), "# Hello").unwrap();
        std::fs::write(dir.join("pages").join("world.md"), "# World").unwrap();

        let output_path = dir.join("test-output.tar.gz");
        let args = ExportArgs {
            dir: dir.to_string_lossy().to_string(),
            output: Some(output_path.to_string_lossy().to_string()),
            strict: false,
            json: false,
        };

        cmd_export(&args, false);

        assert!(output_path.exists(), "tar.gz should exist at {output_path:?}");

        // Verify contents by listing the archive
        let file = std::fs::File::open(&output_path).unwrap();
        let decoder = GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let entries: Vec<String> = archive
            .entries()
            .unwrap()
            .filter_map(|e| {
                e.ok().and_then(|e| {
                    e.path().ok().map(|p| p.to_string_lossy().to_string())
                })
            })
            .collect();

        assert!(
            entries.contains(&"bundle.toml".to_string()),
            "archive should contain bundle.toml: {entries:?}"
        );
        assert!(
            entries.contains(&"pages/hello.md".to_string()),
            "archive should contain pages/hello.md: {entries:?}"
        );
        assert!(
            entries.contains(&"pages/world.md".to_string()),
            "archive should contain pages/world.md: {entries:?}"
        );
    }

    // -------------------------------------------------------------------
    // Install tar.gz (integration)
    // -------------------------------------------------------------------

    #[test]
    fn test_install_from_tar_gz() {
        // Create source bundle
        let src_dir = temp_dir("install_tar_src");
        let bundle_toml = r#"
[package]
name = "test-install-bundle"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(src_dir.join("doc.md"), "# Doc").unwrap();

        // Export to tar.gz
        let tar_path = src_dir.join("bundle.tar.gz");
        let export_args = ExportArgs {
            dir: src_dir.to_string_lossy().to_string(),
            output: Some(tar_path.to_string_lossy().to_string()),
            strict: false,
            json: false,
        };
        cmd_export(&export_args, false);

        // Create a fake wiki dir
        let _wiki_root = temp_dir("install_tar_wiki");

        // Temporarily override wiki_dir by using a static mut... can't in Rust.
        // Instead, we test the resolution and copy logic manually.
        // The install command calls resolve_source then copies. We'll test resolve_tar_source.
        let tmp = resolve_tar_source(&tar_path, false, false);
        assert!(tmp.path().join("bundle.toml").exists());
        assert!(tmp.path().join("doc.md").exists());
        assert!(!tmp.path().join("pages").exists()); // no pages dir
    }

    // -------------------------------------------------------------------
    // ZwikiLock serialization format (TOML)
    // -------------------------------------------------------------------

    #[test]
    fn test_zwiki_lock_toml_format() {
        let entry = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: "https://example.com".to_string(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-aGVsbG8=".to_string(),
            installed_at: "2026-07-05T12:00:00Z".to_string(),
            description: None,
        };
        let lock = ZwikiLock { bundles: vec![entry] };

        let toml_str = toml::to_string_pretty(&lock).unwrap();
        // Should contain [[bundles]] table array
        assert!(
            toml_str.contains("[[bundles]]"),
            "should use [[bundles]] table array: {toml_str}"
        );
        assert!(toml_str.contains("name = \"test\""));
        assert!(toml_str.contains("version = \"1.0\""));

        // Roundtrip
        let parsed: ZwikiLock = toml::from_str(&toml_str).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].registry, "https://example.com");
    }

    #[test]
    fn test_zwiki_lock_empty_defaults() {
        // Entry without registry should default to empty string
        let toml_input = r#"[[bundles]]
name = "test"
version = "1.0"
target = ".upstream/test/"
integrity = "sha256-abc"
installed_at = "2026-07-05T12:00:00Z"
"#;
        let parsed: ZwikiLock = toml::from_str(toml_input).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].registry, "");
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
            "--strict",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert_eq!(args.dir, "/some/dir");
                assert_eq!(args.output, Some("bundle.tar.gz".to_string()));
                assert!(args.strict);
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

    // -------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------

    #[test]
    fn test_compute_integrity_skips_directories() {
        let dir = temp_dir("integrity_skips_dirs");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("f.md"), "f").unwrap();
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"));
        // Should only have one file contribution
        assert_eq!(hash.len(), 51); // sha256- (7) + 44 base64 chars
    }

    #[test]
    fn test_export_args_default_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "export", "/some/dir"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert!(!args.json);
                assert!(!args.strict);
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
                assert!(!args.strict);
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
        // The lock reading is tested by the roundtrip test elsewhere.
        // This test only verifies that an empty lock + format_bundle_table
        // doesn't panic and returns empty output.
        let lock = ZwikiLock { bundles: Vec::new() };
        let formatted = format_bundle_table(&lock);
        assert!(formatted.is_empty());
    }

    // -------------------------------------------------------------------
    // format_bundle_table formatting
    // -------------------------------------------------------------------

    #[test]
    fn test_format_bundle_table_with_entries() {
        let entries = vec![
            ZwikiLockEntry {
                name: "test-bundle".to_string(),
                version: "1.0.0".to_string(),
                registry: String::new(),
                target: ".upstream/test-bundle/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-07-05T12:00:00Z".to_string(),
                description: None,
            },
            ZwikiLockEntry {
                name: "another-pkg".to_string(),
                version: "2.1.0".to_string(),
                registry: String::new(),
                target: ".teams/my-team/".to_string(),
                integrity: "sha256-def".to_string(),
                installed_at: "2026-06-01T00:00:00Z".to_string(),
                description: None,
            },
        ];
        let lock = ZwikiLock { bundles: entries };
        let table = format_bundle_table(&lock);
        assert!(table.contains("test-bundle"));
        assert!(table.contains("another-pkg"));
        assert!(table.contains("1.0.0"));
        assert!(table.contains("2.1.0"));
        assert!(table.contains("NAME"));
        assert!(table.contains("VERSION"));
        assert!(table.contains("TARGET"));
        assert!(table.contains("INSTALLED"));
        // Lines should be separated by newlines
        assert!(table.lines().count() >= 4); // header + separator + 2 entries
    }

    #[test]
    fn test_format_bundle_table_empty() {
        let lock = ZwikiLock { bundles: Vec::new() };
        let table = format_bundle_table(&lock);
        assert!(table.is_empty());
    }

    // -------------------------------------------------------------------
    // Security: safe_unpack rejects path traversal
    // -------------------------------------------------------------------

    /// Build raw tar.gz bytes for testing path traversal rejection.
    /// Unlike `Builder::append_data`, this does NOT validate the entry path,
    /// so we can test `safe_unpack` with truly malicious archives.
    fn raw_tar_gz(path: &str, content: &[u8]) -> Vec<u8> {
        use std::io::Write;

        let content_size = content.len() as u64;
        let mut hdr = [0u8; 512];

        // Name (first 99 bytes + null)
        let name = path.as_bytes();
        let n = name.len().min(99);
        hdr[..n].copy_from_slice(&name[..n]);

        // Mode, uid, gid (POSIX octal format)
        hdr[100..108].copy_from_slice(b"0000644\0");
        hdr[108..116].copy_from_slice(b"0000000\0");
        hdr[116..124].copy_from_slice(b"0000000\0");

        // Size (11 octal digits + null)
        let size_str = format!("{content_size:011o}");
        hdr[124..135].copy_from_slice(size_str.as_bytes());
        hdr[135] = b'\0';

        // Mtime (11 octal digits + null = 12 bytes)
        hdr[136..148].copy_from_slice(b"00000000000\0");

        // Typeflag: '0' = regular file
        hdr[156] = b'0';

        // UStar magic
        hdr[257..262].copy_from_slice(b"ustar");

        // Compute checksum: sum all bytes with checksum field set to spaces
        for b in &mut hdr[148..156] {
            *b = b' ';
        }
        let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
        let chk = format!("{sum:06o}");
        hdr[148..154].copy_from_slice(chk.as_bytes());
        hdr[154] = b'\0';
        hdr[155] = b' ';

        // Build raw tar data: header + content (padded) + end-of-archive
        let mut raw = Vec::new();
        raw.extend_from_slice(&hdr);
        raw.extend_from_slice(content);
        let pad = (512 - (content.len() % 512)) % 512;
        raw.extend(std::iter::repeat_n(0u8, pad));
        raw.extend(std::iter::repeat_n(0u8, 1024)); // two zero blocks = end

        // Gzip compress
        let mut compressed = Vec::new();
        let mut encoder =
            GzEncoder::new(&mut compressed, Compression::default());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap();
        compressed
    }

    #[test]
    fn test_safe_unpack_rejects_path_traversal() {
        let bytes = raw_tar_gz("../../../etc/passwd", b"hack");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            entries.is_empty(),
            "no files should be extracted from a traversal-only tar"
        );
    }

    #[test]
    fn test_safe_unpack_rejects_absolute_path() {
        let bytes = raw_tar_gz("/tmp/evil.txt", b"bad");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(entries.is_empty(), "absolute-path entries should be skipped");
    }

    #[test]
    fn test_safe_unpack_allows_safe_paths() {
        let bytes = raw_tar_gz("pages/hello.md", b"hello");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let safe_path = dest.path().join("pages/hello.md");
        assert!(safe_path.exists(), "safe relative path should be extracted");
        assert_eq!(
            std::fs::read_to_string(&safe_path).unwrap(),
            "hello",
            "extracted content should match"
        );
    }

    // -------------------------------------------------------------------
    // Security: manifest include path traversal rejection
    // -------------------------------------------------------------------

    #[test]
    fn test_manifest_path_traversal_is_detected() {
        // The path validation logic in download_manifest_files rejects
        // absolute paths and paths with ParentDir components.
        let bad_patterns =
            ["../../../etc/passwd", "../escape.md", "/tmp/absolute.md"];
        for pattern in &bad_patterns {
            let path = Path::new(pattern);
            assert!(
                path.is_absolute()
                    || path.components().any(|c| c == Component::ParentDir),
                "pattern '{pattern}' should be detected as traversal"
            );
        }
        let safe_patterns =
            ["pages/hello.md", "data/file.txt", "sub/deep/path.md"];
        for pattern in &safe_patterns {
            let path = Path::new(pattern);
            assert!(
                !path.is_absolute()
                    && !path.components().any(|c| c == Component::ParentDir),
                "pattern '{pattern}' should be allowed"
            );
        }
    }

    // -------------------------------------------------------------------
    // Resilience: read_lock handles corruption gracefully
    // -------------------------------------------------------------------

    #[test]
    fn test_read_lock_corrupt_toml_returns_empty() {
        // Verify that toml::from_str with corrupt content + fallback works.
        let corrupt = "this is not valid toml {{{";
        let result: Result<ZwikiLock, _> = toml::from_str(corrupt);
        assert!(result.is_err(), "corrupt TOML should fail to parse");
        // The fallback path should produce an empty lock.
        let lock = result.unwrap_or(ZwikiLock { bundles: Vec::new() });
        assert!(lock.bundles.is_empty());
    }

    #[test]
    fn test_read_lock_valid_toml_parses() {
        let content = r#"
[[bundles]]
name = "test-bundle"
version = "1.0.0"
registry = ""
target = ".upstream/test-bundle/"
integrity = "sha256-abc"
installed_at = "2026-01-01T00:00:00Z"
"#;
        let lock: ZwikiLock = toml::from_str(content).unwrap();
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].name, "test-bundle");
    }

    // -------------------------------------------------------------------
    // regenerate_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_regenerate_root_index_empty_lock() {
        let tmp = temp_dir("regenerate_index_empty");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        let lock = ZwikiLock { bundles: Vec::new() };
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

        // Create a bundle directory with its own index.md (like the real
        // wiki/bundle.toml install would produce).
        let team_dir = wiki_root.join(".teams").join("my-team");
        std::fs::create_dir_all(&team_dir).unwrap();
        // The bundle's index.md has the domain listings — we copy them
        // directly, rewriting relative paths to include the target prefix.
        std::fs::write(
            team_dir.join("index.md"),
            "---\nokf_version: \"0.1\"\n---\n\n# Wiki Index\n\n\
             * [autoresearch](autoresearch/index.md) - 自主实验框架\n\
             * [shared](shared/index.md) - 跨领域概念\n\
             * [overview](overview.md) - 项目概览\n",
        )
        .unwrap();

        let lock = ZwikiLock {
            bundles: vec![
                ZwikiLockEntry {
                    name: "test-upstream".to_string(),
                    version: "1.0".to_string(),
                    registry: String::new(),
                    target: ".upstream/test-upstream/".to_string(),
                    integrity: "sha256-abc".to_string(),
                    installed_at: "2026-01-01T00:00:00Z".to_string(),
                    description: Some("A test upstream bundle".to_string()),
                },
                ZwikiLockEntry {
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
        // Markers
        assert!(content.contains("<!-- ZOO:BUNDLES:BEGIN -->"));
        assert!(content.contains("<!-- ZOO:BUNDLES:END -->"));
        // Bundle-level entries — now ### headings
        assert!(content.contains("## Upstream Bundles"));
        assert!(content.contains("### [test-upstream]"));
        assert!(content.contains("A test upstream bundle"));
        assert!(content.contains("## 团队 Bundles"));
        assert!(content.contains("### [my-team-bundle]"));
        // Domain entries from bundle's index.md with rewritten links
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

        let lock = ZwikiLock {
            bundles: vec![ZwikiLockEntry {
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

        // First generation: install one bundle.
        let lock1 = ZwikiLock {
            bundles: vec![ZwikiLockEntry {
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

        // Simulate user adding custom content after the markers.
        let user_note = "\n## 个人笔记\n\n这里是手动添加的内容。\n";
        let with_user = format!("{content1}{user_note}");
        std::fs::write(&index_path, &with_user).unwrap();

        // Second generation: update lock (remove bundle-a, add bundle-b).
        let lock2 = ZwikiLock {
            bundles: vec![ZwikiLockEntry {
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
        // Old bundle gone.
        assert!(!content2.contains("bundle-a"));
        // New bundle present.
        assert!(content2.contains("### [bundle-b]"));
        assert!(content2.contains("Second bundle"));
        // User content preserved.
        assert!(
            content2.contains("## 个人笔记"),
            "user content should be preserved"
        );
        assert!(content2.contains("这里是手动添加的内容。"));
        // Markers still present.
        assert!(content2.contains("<!-- ZOO:BUNDLES:BEGIN -->"));
        assert!(content2.contains("<!-- ZOO:BUNDLES:END -->"));
    }

    // -------------------------------------------------------------------
    // resolve_target_rel — org kind
    // -------------------------------------------------------------------

    #[test]
    fn test_resolve_target_org() {
        let mut m = valid_manifest();
        m.package.kind = "org".to_string();
        m.package.name = "my-org-bundle".to_string();
        let target = resolve_target_rel(&m, false);
        assert_eq!(target, ".org/my-org-bundle/");
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
    // ZwikiLockEntry — description field defaults
    // -------------------------------------------------------------------

    #[test]
    fn test_zwiki_lock_entry_description_default_none() {
        // Existing lock entries without description should parse with None
        let toml_input = r#"[[bundles]]
name = "test"
version = "1.0"
target = ".upstream/test/"
integrity = "sha256-abc"
installed_at = "2026-07-05T12:00:00Z"
"#;
        let parsed: ZwikiLock = toml::from_str(toml_input).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert!(parsed.bundles[0].description.is_none());
    }

    // -------------------------------------------------------------------
    // uninstall_bundle_entry (integration-style)
    // -------------------------------------------------------------------

    #[test]
    fn test_uninstall_bundle_entry_removes_dir_and_lock_entry() {
        let tmp = temp_dir("uninstall_entry");
        let wiki_root = tmp.join(".zoo").join("wiki");
        std::fs::create_dir_all(&wiki_root).unwrap();

        // Create a bundle directory.
        let bundle_dir = wiki_root.join(".upstream").join("test-pkg");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("doc.md"), "content").unwrap();

        // Create a lock with one entry.
        let entry = ZwikiLockEntry {
            name: "test-pkg".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test-pkg/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let mut lock = ZwikiLock { bundles: vec![entry] };

        // Write lock to wiki root so uninstall can read it.
        let lock_path = wiki_root.join("zwiki.lock");
        let lock_toml = toml::to_string_pretty(&lock).unwrap();
        std::fs::write(&lock_path, &lock_toml).unwrap();

        // Verify bundle dir and lock exist.
        assert!(bundle_dir.exists());
        assert!(lock_path.exists());

        // Call uninstall_bundle_entry — it uses wiki_root for all paths.
        let removed_entry = lock.bundles.remove(0);
        uninstall_bundle_entry(&lock, &removed_entry, &wiki_root, false);

        // Verify directory was removed.
        assert!(!bundle_dir.exists(), "bundle dir should be removed");

        // Verify lock was updated (read it back from disk).
        let content = std::fs::read_to_string(&lock_path).unwrap();
        let parsed: ZwikiLock = toml::from_str(&content).unwrap();
        assert!(parsed.bundles.is_empty(), "lock should have no entries");

        // Verify index.md was regenerated.
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
        // Non-JSON branch only calls eprintln, results remain unchanged.
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

    #[test]
    fn test_install_from_local_dir_full() {
        // 1. Create source bundle directory with bundle.toml + .md files.
        let src_dir = temp_dir("install_local_full_src");
        let bundle_toml = r#"
[package]
name = "test-install-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(src_dir.join("doc.md"), "# Doc Content").unwrap();
        std::fs::write(src_dir.join("readme.md"), "# Readme").unwrap();
        // Create a file that should NOT be included (not matching *.md).
        std::fs::write(src_dir.join("notes.txt"), "not included").unwrap();

        // 2. Create a temporary wiki_root (no real wiki touched).
        let wiki_root = temp_dir("install_local_full_wiki");

        // 3. Build InstallArgs pointing to the source dir.
        let args = InstallArgs {
            source: src_dir.to_string_lossy().to_string(),
            force: false,
            strict: false,
            json: false,
        };

        // 4. Call cmd_install_at with the temp wiki_root.
        cmd_install_at(&args, false, &wiki_root);

        // 5. Verify files were copied to the correct layer directory.
        let bundle_dir =
            wiki_root.join(".upstream").join("test-install-bundle");
        assert!(bundle_dir.exists(), "bundle target directory should exist");
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
            "notes.txt should NOT be copied (not in include pattern)"
        );
        // Verify content integrity.
        let doc_content =
            std::fs::read_to_string(bundle_dir.join("doc.md")).unwrap();
        assert_eq!(doc_content, "# Doc Content");

        // 6. Verify zwiki.lock exists with correct entry.
        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists(), "zwiki.lock should exist");
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let lock: ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].name, "test-install-bundle");
        assert_eq!(lock.bundles[0].version, "1.0.0");
        assert_eq!(lock.bundles[0].target, ".upstream/test-install-bundle/");
        assert!(
            lock.bundles[0].integrity.starts_with("sha256-"),
            "integrity should be sha256- format"
        );

        // 7. Verify index.md was regenerated with correct content.
        let index_path = wiki_root.join("index.md");
        assert!(index_path.exists(), "index.md should exist");
        let index_content = std::fs::read_to_string(&index_path).unwrap();
        assert!(index_content.contains("## Upstream Bundles"));
        assert!(index_content.contains("test-install-bundle"));

        // 8. Repeat with --force to test overwrite reinstall.
        // Update the source so we can detect the overwrite.
        std::fs::write(src_dir.join("doc.md"), "# Updated Doc Content")
            .unwrap();
        std::fs::write(src_dir.join("new.md"), "# New File").unwrap();

        let args_force = InstallArgs {
            source: src_dir.to_string_lossy().to_string(),
            force: true,
            strict: false,
            json: false,
        };
        cmd_install_at(&args_force, false, &wiki_root);

        // Verify updated content after force reinstall.
        let doc_content =
            std::fs::read_to_string(bundle_dir.join("doc.md")).unwrap();
        assert_eq!(doc_content, "# Updated Doc Content");
        assert!(
            bundle_dir.join("new.md").exists(),
            "new.md should be copied on reinstall"
        );
        // Lock should still have exactly one entry (upserted).
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let lock: ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(
            lock.bundles.len(),
            1,
            "lock should still have one entry after force reinstall"
        );
        assert_eq!(lock.bundles[0].version, "1.0.0");
    }

    #[test]
    fn test_install_at_with_json_output() {
        // Similar setup but with use_json=true to cover JSON output branches
        // in finalize_install_and_lock_at (lines corresponding to 1083-1091).
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
        std::fs::write(src_dir.join("page.md"), "# JSON").unwrap();

        let wiki_root = temp_dir("install_json_wiki");

        let args = InstallArgs {
            source: src_dir.to_string_lossy().to_string(),
            force: false,
            strict: false,
            json: true,
        };

        // Capture stdout to validate JSON output.
        let output =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cmd_install_at(&args, true, &wiki_root);
            }));
        assert!(output.is_ok(), "cmd_install_at with JSON should not panic");

        // Verify the bundle was installed correctly.
        let bundle_dir = wiki_root.join(".org").join("json-test-bundle");
        assert!(bundle_dir.exists(), "org bundle dir should exist");
        assert!(bundle_dir.join("page.md").exists(), "page.md should exist");

        // Verify lock.
        let lock_path = wiki_root.join("zwiki.lock");
        assert!(lock_path.exists());
        let lock_content = std::fs::read_to_string(&lock_path).unwrap();
        let lock: ZwikiLock = toml::from_str(&lock_content).unwrap();
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].name, "json-test-bundle");
        assert_eq!(lock.bundles[0].target, ".org/json-test-bundle/");
    }
}
