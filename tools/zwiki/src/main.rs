#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

mod aggregate;
mod assets;
mod backlinks;
mod bundle;
pub mod catalog;
mod contradictions;
mod display;
mod document_io;
mod freshness;
mod health;
mod index;
mod lint;
mod list;
mod log;
mod r#move;
mod page;
mod property;
mod report;
mod search;
mod status;
mod supersede;
mod verify;
mod wiki;

use crate::report::ChangeKind;
use clap::{Args, Parser, Subcommand};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use tempfile::TempDir;
use zwiki::document::PageDocument;

/// Resolved wiki root — either a writable local directory or a read-only
/// temporary extraction (from tar.gz or URL).
enum WikiRoot {
    /// A local directory that can be written to.
    Dir(PathBuf),
    /// A temporary extraction (tar.gz or URL) that is read-only.
    Temp(TempDir),
}

impl WikiRoot {
    fn path(&self) -> &Path {
        match self {
            Self::Dir(p) => p.as_path(),
            Self::Temp(t) => t.path(),
        }
    }

    const fn is_writable(&self) -> bool {
        matches!(self, Self::Dir(_))
    }
}

/// Guard: exit with an error when `root` is read-only (tar.gz/URL).
fn guard_writable(root: &WikiRoot, cmd_desc: &str) {
    if !root.is_writable() {
        eprintln!(
            "错误: 在 tar.gz/URL 形式的 wiki 根上不支持「{cmd_desc}」操作"
        );
        std::process::exit(1);
    }
}

/// Return the command description when `cmd` mutates the wiki, or `None`
/// for read-only commands.  Write commands must be given an explicit
/// `--root` so the write target is never guessed.
const fn write_command_desc(cmd: &Command) -> Option<&'static str> {
    match cmd {
        Command::Supersede { .. } => Some("supersede"),
        Command::Contradictions(ContradictionsCommand::Apply(_)) => {
            Some("contradictions apply")
        }
        Command::Page(PageCommand::Set(_)) => Some("page set"),
        Command::Page(PageCommand::Unset(_)) => Some("page unset"),
        Command::Page(PageCommand::Create(_)) => Some("page create"),
        Command::Page(PageCommand::Move(_)) => Some("page move"),
        Command::Domain(DomainCommand::Create(_)) => Some("domain create"),
        _ => None,
    }
}

/// Print a rejection for a write whose target lies inside an installed
/// bundle and exit.
fn reject_readonly_bundle(bundle: &str, cmd_desc: &str) -> ! {
    eprintln!(
        "错误: 路径位于只读的安装态 bundle「{bundle}」，不支持「{cmd_desc}」写入；请在包含 bundle.toml 的 bundle 源目录操作"
    );
    process::exit(1);
}

/// Print a rejection for a write whose root is the installed wiki store (a
/// directory holding `zwiki.lock`) and exit.
fn reject_store_root(cmd_desc: &str) -> ! {
    eprintln!(
        "错误: 「{cmd_desc}」不能在安装态 wiki 仓库（包含 zwiki.lock）上写入；请将 --root 指向包含 bundle.toml 的 bundle 源目录"
    );
    process::exit(1);
}

/// Print a rejection for a write whose root lacks `bundle.toml` and exit.
fn reject_not_bundle_source(root: &Path, cmd_desc: &str) -> ! {
    eprintln!(
        "错误: 「{cmd_desc}」要求 --root 指向 bundle 源目录（包含 bundle.toml），但 {} 中缺少 bundle.toml",
        root.display()
    );
    process::exit(1);
}

/// Whether `root` must be treated as read-only by `check`: an installed
/// wiki store (a directory holding `zwiki.lock`), a directory nested inside
/// a bundle, or a directory that is not a bundle source (lacks
/// `bundle.toml`).  A bare directory has no writable page tree of its own,
/// so `check` reports on it without regenerating derived metadata.
fn is_read_only_check_root(root: &Path) -> bool {
    root.join("zwiki.lock").exists()
        || wiki::enclosing_bundle(root).is_some()
        || !root.join("bundle.toml").is_file()
}

/// Guard a write command after root resolution: reject read-only
/// (tar.gz/URL) roots, the installed wiki store (`zwiki.lock`), roots
/// inside an installed bundle, and roots that are not bundle sources
/// (`bundle.toml`).  Explicit `--root` is enforced earlier, before root
/// resolution, so omitting it never silently writes to the default
/// installation root.
fn guard_write(root: &WikiRoot, cmd_desc: &str) {
    guard_writable(root, cmd_desc);
    let path = root.path();
    if path.join("zwiki.lock").exists() {
        reject_store_root(cmd_desc);
    }
    if let Some(bundle) = wiki::installed_bundle(path) {
        reject_readonly_bundle(&bundle, cmd_desc);
    }
    if !path.join("bundle.toml").is_file() {
        reject_not_bundle_source(path, cmd_desc);
    }
}

/// Guard a write whose target is a specific page within a writable root:
/// reject when the resolved page path passes through any directory below
/// the root that contains `bundle.toml`.  This complements [`guard_write`],
/// which only judges the root, so a page below an installed bundle is never
/// written when the root aggregates installed bundles.
pub(crate) fn guard_write_page(root: &Path, page_rel: &str, cmd_desc: &str) {
    if let Some(bundle) = wiki::bundle_on_path(root, page_rel) {
        reject_readonly_bundle(&bundle, cmd_desc);
    }
}

/// Normalize a page path argument that should reference an **existing** page.
///
/// Pipeline:
/// 1. Strip leading `./` prefix.
/// 2. Make relative to wiki root (strip root prefix or reject absolute paths).
/// 3. Append `.md` if the path has no extension.
/// 4. Exact match — if the file exists, return it.
/// 5. Unique-suffix fallback — find all `.md` files whose relative path ends
///    with the requested suffix.  Error if ambiguous (multiple matches) or
///    no matches found.
fn normalize_page_path(root: &Path, raw: &str) -> Result<String, String> {
    // Step 1: strip all leading ./ prefixes
    let mut cleaned = raw;
    while let Some(stripped) = cleaned.strip_prefix("./") {
        cleaned = stripped;
    }

    // Reject paths containing `..` components (path traversal guard).
    if cleaned.contains("..") {
        return Err("页面路径不能包含「..」".to_string());
    }

    // Step 2: make relative to wiki root
    // If the path is absolute, try to make it relative to root.
    let rel = if Path::new(cleaned).is_absolute() {
        let root_canonical = root
            .canonicalize()
            .map_err(|e| format!("无法解析 wiki 根路径: {e}"))?;
        let raw_path = Path::new(cleaned);
        raw_path
            .strip_prefix(&root_canonical)
            .map_err(|_| {
                format!("路径是绝对路径但不在 wiki 根目录下: {cleaned}")
            })?
            .to_string_lossy()
            .to_string()
    } else if let Some(stripped) = cleaned.strip_prefix('/') {
        // Rooted path — treat as relative after the leading /
        stripped.to_string()
    } else {
        // Step 2c: try resolving relative to cwd — if the path exists
        // and its canonical form is under the canonical root, use the
        // root-relative portion (handles paths like
        // `wiki/concepts/page.md` with `--root ./wiki/`).
        let root_rel = std::env::current_dir().ok().and_then(|cwd| {
            let candidate = cwd.join(cleaned);
            if !candidate.exists() {
                return None;
            }
            let canon = candidate.canonicalize().ok()?;
            let root_canon = root.canonicalize().ok()?;
            canon
                .strip_prefix(&root_canon)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        });
        root_rel.unwrap_or_else(|| cleaned.to_string())
    };

    // Step 3: append .md if missing
    let with_ext =
        if Path::new(&rel).extension().is_none_or(std::ffi::OsStr::is_empty) {
            format!("{rel}.md")
        } else {
            rel
        };

    // Step 4: exact match
    let abs = root.join(&with_ext);
    if abs.exists() {
        return Ok(with_ext);
    }

    // Step 5: unique-suffix fallback
    let all = wiki::discover_pages(root);
    let matches: Vec<PathBuf> = all
        .into_iter()
        .filter(|p| {
            p.strip_prefix(root).ok().and_then(|r| r.to_str()).is_some_and(
                |r| r == with_ext || r.ends_with(&format!("/{with_ext}")),
            )
        })
        .collect();

    match matches.len() {
        0 => Err(format!("页面不存在: {raw}")),
        1 => {
            let found = matches[0]
                .strip_prefix(root)
                .unwrap_or(&matches[0])
                .to_string_lossy()
                .to_string();
            Ok(found)
        }
        _ => {
            let candidates: Vec<String> = matches
                .iter()
                .map(|p| {
                    p.strip_prefix(root)
                        .unwrap_or(p)
                        .to_string_lossy()
                        .to_string()
                })
                .collect();
            Err(format!(
                "页面路径不明确: {raw} — 找到多个匹配: {}",
                candidates.join(", ")
            ))
        }
    }
}

/// Resolve the `--root` argument to a [`WikiRoot`].
///
/// - `None` → default `~/.zoo/wiki/` directory (writable).
/// - Existing directory → use in place (writable).
/// - tar.gz path or URL → extract to `TempDir` (read-only).
///
/// `use_json` controls error message formatting.
fn resolve_wiki_root(
    root: Option<&str>,
    use_json: bool,
) -> Result<WikiRoot, String> {
    let Some(root_str) = root else {
        return Ok(WikiRoot::Dir(wiki::wiki_dir()));
    };

    let path = Path::new(root_str);
    if path.is_dir() {
        return Ok(WikiRoot::Dir(path.to_path_buf()));
    }

    // tar.gz or URL — resolve via bundle source resolution.
    let tmp = crate::bundle::source::resolve_source(root_str, use_json)?;
    Ok(WikiRoot::Temp(tmp))
}

#[derive(Parser)]
#[command(
    name = "zwiki",
    about = "ZooKeeper wiki — manage ~/.zoo/wiki/ knowledge from the command line.",
    disable_help_subcommand = true
)]
struct ZwikiArgs {
    /// Wiki root directory, tar.gz path, or URL (default: ~/.zoo/wiki/)
    #[arg(long, global = true)]
    root: Option<String>,

    /// Output as JSON
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum ContradictionsCommand {
    /// List known contradictions across all wiki pages.
    List,
    /// Apply/record contradictions from stdin JSON.
    ///
    /// Reads a JSON array of contradiction pairs from stdin and records
    /// the contradictions on both pages with a `timestamp` update.
    Apply(ContradictionsApplyArgs),
}

/// Record contradictions from stdin, with an optional change-log note.
#[derive(Args)]
pub struct ContradictionsApplyArgs {
    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// Page command family — show, set, unset, create, move
// ---------------------------------------------------------------------------

/// Show a wiki page (full content, property, outline, or backlinks)
#[derive(Args)]
pub struct PageShowArgs {
    /// Wiki-relative page path
    pub path: String,

    /// Print only a specific frontmatter property
    #[arg(long)]
    pub property: Option<String>,

    /// Print heading tree (## headings only)
    #[arg(long)]
    pub outline: bool,

    /// Show backlinks to this page
    #[arg(long)]
    pub backlinks: bool,
}

/// Set a frontmatter property on a page
#[derive(Args)]
pub struct PageSetArgs {
    /// Wiki-relative page path
    pub path: String,

    /// Property name (e.g. description, resource, tags)
    pub prop: String,

    /// Value to set
    pub value: Option<String>,

    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

/// Delete a frontmatter property from a page
#[derive(Args)]
pub struct PageUnsetArgs {
    /// Wiki-relative page path
    pub path: String,
    /// Property name to delete
    pub prop: String,

    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

/// Create a new wiki page from template
#[derive(Args)]
pub struct PageCreateArgs {
    /// Domain: an existing wiki subdirectory (required)
    #[arg(long)]
    pub domain: String,

    /// Page type: concept, entity, source, analysis, synthesis
    #[arg(long)]
    pub r#type: String,

    /// Page title
    #[arg(long)]
    pub title: String,

    /// Custom filename slug (required for non-Latin titles)
    #[arg(long)]
    pub slug: Option<String>,

    /// Source sub-type: adr, rfc, notes (required when --type=source)
    #[arg(long)]
    pub source_type: Option<String>,

    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

/// Move / rename a wiki page
#[derive(Args)]
pub struct PageMoveArgs {
    /// Current wiki-relative page path
    pub old: String,
    /// New wiki-relative page path
    pub new: String,

    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

#[derive(Subcommand)]
enum PageCommand {
    /// Display a wiki page (full content, or with --property/--outline/--backlinks)
    Show(PageShowArgs),

    /// Set a frontmatter property on a page
    Set(PageSetArgs),

    /// Delete a frontmatter property from a page
    Unset(PageUnsetArgs),

    /// Create a new wiki page from template
    Create(PageCreateArgs),

    /// Move / rename a wiki page, updating all references and index entries
    #[command(name = "move")]
    Move(PageMoveArgs),
}

// ---------------------------------------------------------------------------
// Domain command family — create
// ---------------------------------------------------------------------------

/// Scaffold a new domain with the standard directory layout and index.
#[derive(Args)]
pub struct DomainCreateArgs {
    /// Domain name (kebab-case, e.g. agent-design)
    pub name: String,

    /// Free-text note recorded in the change log
    #[arg(long)]
    pub note: Option<String>,
}

#[derive(Subcommand)]
enum DomainCommand {
    /// Scaffold a new domain with the standard subdirectories and index.md
    Create(DomainCreateArgs),
}

// ---------------------------------------------------------------------------
// Top-level command enum
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
enum Command {
    /// Run all health and lint checks
    Check,

    /// Print an embedded page template to stdout
    Template {
        /// Template type: concept, entity, source, analysis, synthesis
        r#type: String,
    },

    /// Print the embedded OKF schema document (SCHEMA.md) to stdout
    Schema,

    /// Read a wiki page or manage page properties
    #[command(subcommand)]
    Page(PageCommand),

    /// Scaffold and manage wiki domains
    #[command(subcommand)]
    Domain(DomainCommand),

    /// Bundle distribution commands
    #[command(subcommand)]
    Bundle(bundle::BundleCommand),

    /// Search wiki pages for a query
    Search {
        /// Literal substring to search for
        query: String,

        /// Filter by page type (concept, entity, source, analysis, synthesis)
        #[arg(long)]
        r#type: Option<String>,

        /// Filter by tag (case-insensitive substring match)
        #[arg(long)]
        tag: Option<String>,

        /// Filter by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// List wiki pages with optional field-based filters
    List {
        /// Filter by page type (substring, case-insensitive)
        #[arg(long)]
        r#type: Option<String>,

        /// Filter by tag (case-insensitive substring match)
        #[arg(long)]
        tag: Option<String>,

        /// Filter by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// Show wiki health overview with optional slice filters
    Status {
        /// Slice by page type (substring, case-insensitive)
        #[arg(long)]
        r#type: Option<String>,

        /// Slice by tag (case-insensitive substring match)
        #[arg(long)]
        tag: Option<String>,

        /// Slice by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// Check which derived pages have stale sources
    Verify {
        /// Filter by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// List all tags with page counts
    Tags {
        /// Filter by page type (substring, case-insensitive)
        #[arg(long)]
        r#type: Option<String>,

        /// Filter by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// List all page types with page counts
    Types {
        /// Filter by tag (case-insensitive substring match)
        #[arg(long)]
        tag: Option<String>,

        /// Filter by top-level domain (e.g. autoresearch, shared)
        #[arg(long)]
        domain: Option<String>,
    },

    /// List all domains with page counts
    Domains {
        /// Filter by page type (substring, case-insensitive)
        #[arg(long)]
        r#type: Option<String>,

        /// Filter by tag (case-insensitive substring match)
        #[arg(long)]
        tag: Option<String>,
    },

    /// Record a supersede relationship between two pages
    Supersede {
        /// Wiki-relative path of the superseded (old) page
        #[arg(long)]
        old: String,

        /// Wiki-relative path of the superseding (new) page
        #[arg(long)]
        new: String,

        /// Reason for the supersede relationship
        #[arg(long)]
        reason: String,

        /// Free-text note recorded in the change log
        #[arg(long)]
        note: Option<String>,
    },

    /// Find and manage contradictory claims between wiki pages
    #[command(subcommand)]
    Contradictions(ContradictionsCommand),
}

fn main() {
    let args = ZwikiArgs::parse();
    dispatch(args);
}

fn dispatch(args: ZwikiArgs) {
    let use_json = args.json;

    // Write commands must name their target explicitly.  This check runs
    // before root resolution so that omitting `--root` never falls back to
    // the default installation root (and never fails with an unrelated
    // "root not found" error).
    if let Some(cmd) = args.command.as_ref()
        && let Some(desc) = write_command_desc(cmd)
        && args.root.is_none()
    {
        let msg = format!(
            "「{desc}」是写命令，必须用 --root 显式指定写入目标（例如 --root ./wiki/）"
        );
        if use_json {
            let output = serde_json::json!({"status": "error", "error": msg});
            crate::print_stdout_line(
                serde_json::to_string_pretty(&output).unwrap(),
            );
        } else {
            eprintln!("错误: {msg}");
        }
        process::exit(1);
    }

    let wiki_root = match resolve_wiki_root(args.root.as_deref(), use_json) {
        Ok(r) => r,
        Err(e) => {
            if use_json {
                let output = serde_json::json!({"status": "error", "error": e});
                crate::print_stdout_line(
                    serde_json::to_string_pretty(&output).unwrap(),
                );
            } else {
                eprintln!("{e}");
            }
            process::exit(1);
        }
    };

    match args.command {
        None => {
            use clap::CommandFactory;
            let mut cmd = ZwikiArgs::command();
            let _ = cmd.print_help();
            crate::print_stdout_line("");
            process::exit(1);
        }
        Some(Command::Check) => {
            dispatch_check(&wiki_root, args.json);
        }
        Some(Command::Template { r#type }) => {
            cmd_template(&r#type, args.json);
        }
        Some(Command::Schema) => {
            cmd_schema(args.json);
        }
        Some(Command::Page(ref page_cmd)) => {
            dispatch_page(&wiki_root, page_cmd, args.json);
        }
        Some(Command::Domain(ref domain_cmd)) => {
            dispatch_domain(&wiki_root, domain_cmd);
        }
        Some(Command::Search { query, r#type, tag, domain }) => {
            cmd_search(
                &wiki_root,
                &query,
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::List { r#type, tag, domain }) => {
            cmd_list(
                &wiki_root,
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::Status { r#type, tag, domain }) => {
            cmd_status(
                &wiki_root,
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        ref cmd => dispatch_tail(&wiki_root, &args, cmd.as_ref().unwrap()),
    }
}

/// Exit quietly when `result` reports a closed downstream pipe, otherwise
/// report the write failure on stderr.
fn finish_stdout(result: io::Result<()>) {
    if let Err(e) = result {
        if e.kind() == io::ErrorKind::BrokenPipe {
            process::exit(0);
        }
        eprintln!("错误: 写入标准输出失败: {e}");
        process::exit(1);
    }
}

/// Write `text` to stdout without a trailing newline.
///
/// A closed reader (`Broken pipe`) is a normal end of output for a pager or
/// `head`, so it exits with status 0 instead of panicking the way the
/// standard printing macros do.
pub(crate) fn print_stdout(text: impl std::fmt::Display) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    finish_stdout(write!(handle, "{text}").and_then(|()| handle.flush()));
}

/// Write `text` to stdout followed by a newline.
pub(crate) fn print_stdout_line(text: impl std::fmt::Display) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    finish_stdout(writeln!(handle, "{text}").and_then(|()| handle.flush()));
}

/// Print an embedded page template to stdout.
fn cmd_template(page_type: &str, json: bool) {
    if let Some(content) = assets::template(page_type) {
        if json {
            let output = serde_json::json!({
                "type": page_type,
                "content": content,
            });
            crate::print_stdout_line(
                serde_json::to_string_pretty(&output).unwrap(),
            );
        } else {
            print_stdout(content);
        }
    } else {
        let valid = assets::TEMPLATE_TYPES.join(", ");
        let msg = format!("未知的模板类型: {page_type} — 有效类型: {valid}");
        if json {
            let output = serde_json::json!({"status": "error", "error": msg});
            crate::print_stdout_line(
                serde_json::to_string_pretty(&output).unwrap(),
            );
        } else {
            eprintln!("错误: {msg}");
        }
        process::exit(1);
    }
}

/// Print the embedded OKF schema document to stdout.
fn cmd_schema(json: bool) {
    if json {
        let output = serde_json::json!({"content": assets::SCHEMA});
        crate::print_stdout_line(
            serde_json::to_string_pretty(&output).unwrap(),
        );
    } else {
        print_stdout(assets::SCHEMA);
    }
}

/// Dispatch the remaining subcommands (Verify through Contradictions).
fn dispatch_tail(wiki_root: &WikiRoot, args: &ZwikiArgs, cmd: &Command) {
    match cmd {
        Command::Verify { domain } => {
            if check_domain_or_print(
                domain.as_deref(),
                wiki_root.path(),
                &wiki::BundleSet::discover(wiki_root.path()),
                args.json,
                "[]",
            ) {
                return;
            }
            verify::cmd_verify(wiki_root.path(), args.json, domain.as_deref());
        }
        Command::Tags { r#type, domain } => {
            cmd_aggregate(
                wiki_root,
                aggregate::AggregateField::Tags,
                r#type.as_deref(),
                None,
                domain.as_deref(),
                args.json,
            );
        }
        Command::Types { tag, domain } => {
            cmd_aggregate(
                wiki_root,
                aggregate::AggregateField::Types,
                None,
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Command::Domains { r#type, tag } => {
            cmd_aggregate(
                wiki_root,
                aggregate::AggregateField::Domains,
                r#type.as_deref(),
                tag.as_deref(),
                None,
                args.json,
            );
        }
        Command::Supersede { old, new, reason, note } => {
            guard_write(wiki_root, "supersede");
            // Normalize both old and new paths.
            let old_norm = normalize_page_path(wiki_root.path(), old)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            let new_norm = normalize_page_path(wiki_root.path(), new)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            guard_write_page(wiki_root.path(), &old_norm, "supersede");
            guard_write_page(wiki_root.path(), &new_norm, "supersede");
            cmd_supersede(
                wiki_root,
                &old_norm,
                &new_norm,
                reason,
                note.as_deref(),
            );
        }
        Command::Bundle(cmd) => {
            // All bundle subcommands require a lock-based wiki root
            // (installed bundles).  Temporary root (tar.gz/URL) cannot
            // satisfy this — reject early with a targeted message.
            if !wiki_root.is_writable() {
                eprintln!(
                    "错误: 在 tar.gz/URL 形式的 wiki 根上不支持 bundle \
                     子命令。请直接使用「zwiki --root <制品> check」检查临时制品。"
                );
                process::exit(1);
            }
            match cmd {
                bundle::BundleCommand::Install(_)
                | bundle::BundleCommand::Uninstall(_)
                | bundle::BundleCommand::Update(_) => {
                    guard_writable(wiki_root, "bundle 写操作");
                }
                _ => {}
            }
            bundle::dispatch(cmd, args.json, wiki_root.path());
        }
        Command::Contradictions(cmd) => {
            if matches!(cmd, crate::ContradictionsCommand::Apply(_)) {
                guard_write(wiki_root, "contradictions apply");
            }
            contradictions::dispatch(cmd, wiki_root.path(), args.json);
        }
        _ => {
            // Unknown subcommand variant — never panic at runtime.  New
            // variants could be added without updating this catch-all.
            eprintln!("未知子命令");
            process::exit(1);
        }
    }
}

/// Append an automatic change-log entry for a completed mutation.
///
/// A logging failure is reported as a warning because the page write has
/// already succeeded and must not be reported as failed.
pub(crate) fn log_mutation(
    wiki_root: &Path,
    path: &str,
    action: &str,
    note: Option<&str>,
) {
    if let Err(e) = log::add_entry_at(wiki_root, path, action, note) {
        eprintln!("警告: 无法写入变更日志: {e}");
    }
}

/// Move a wiki page, updating references and indexes.
fn cmd_move(
    wiki_root: &WikiRoot,
    old: &str,
    new: &str,
    note: Option<&str>,
    json: bool,
) {
    match r#move::execute_move(wiki_root.path(), old, new) {
        Ok(result) => {
            // Record the move in the wiki log (structured old → new).
            // Log the result's recorded destination (normalized relative
            // path) rather than the raw user-typed argument.
            if let Err(e) = log::add_move_entry_at(
                wiki_root.path(),
                old,
                &result.new_rel,
                note,
            ) {
                eprintln!("警告: 无法写入移动日志: {e}");
            }
            if json {
                let output = serde_json::json!({
                    "moved": result.moved,
                    "updated_refs": result.updated_refs,
                    "updated_indexes": result.updated_indexes,
                    "backlinks_synced": result.backlinks_synced,
                });
                crate::print_stdout_line(
                    serde_json::to_string_pretty(&output).unwrap(),
                );
            } else {
                crate::print_stdout_line(format!("已移动: {}", result.moved));
                if !result.updated_refs.is_empty() {
                    crate::print_stdout_line(format!(
                        "已更新引用: {} 个页面",
                        result.updated_refs.len()
                    ));
                    for r in &result.updated_refs {
                        crate::print_stdout_line(format!("  {r}"));
                    }
                }
                if !result.updated_indexes.is_empty() {
                    crate::print_stdout_line(format!(
                        "已更新索引: {} 个文件",
                        result.updated_indexes.len()
                    ));
                    for idx in &result.updated_indexes {
                        crate::print_stdout_line(format!("  {idx}"));
                    }
                }
                if result.backlinks_synced > 0 {
                    crate::print_stdout_line(format!(
                        "已同步反向链接: {} 个页面",
                        result.backlinks_synced
                    ));
                }
                crate::print_stdout_line("");
                crate::print_stdout_line("运行 zwiki check 验证引用一致性");
            }
        }
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}

/// Record a supersede relationship between two wiki pages.
fn cmd_supersede(
    wiki_root: &WikiRoot,
    old: &str,
    new: &str,
    reason: &str,
    note: Option<&str>,
) {
    supersede::link_supersede_at(old, new, reason, wiki_root.path())
        .unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
    log_mutation(wiki_root.path(), old, "edit", note);
    log_mutation(wiki_root.path(), new, "edit", note);
    crate::print_stdout_line(format!("已记录取代关系: {old} ← {new}"));
}

/// Validate `--domain` and emit the error output if invalid.
///
/// Returns `true` when the caller should short-circuit (invalid domain
/// already printed). `json_empty` is the JSON value to print on the
/// error path in JSON mode — `[]` for array-output commands (search,
/// list), `{}` for object-output commands (status).
fn check_domain_or_print(
    domain_filter: Option<&str>,
    wiki_dir: &Path,
    bundles: &wiki::BundleSet,
    json: bool,
    json_empty: &str,
) -> bool {
    if let Some(df) = domain_filter
        && let Err(msg) = wiki::validate_domain(df, wiki_dir, bundles)
    {
        if json {
            eprintln!("{msg}");
            crate::print_stdout_line(json_empty);
        } else {
            crate::print_stdout_line(msg);
        }
        return true;
    }
    false
}

/// Handle `zwiki check` — one report for every root form.
///
/// A local directory is writable when it is a bundle source; the installed
/// store and a directory without `bundle.toml` are read-only.  A temporary
/// root always is: the archive is examined and never written.
fn dispatch_check(root: &WikiRoot, json_mode: bool) {
    match root {
        WikiRoot::Dir(dir) => {
            let read_only = is_read_only_check_root(dir);
            let lock = match bundle::read_lock_at(dir) {
                Ok(lock) => lock,
                Err(message) => process::exit(report_check_error(
                    &message, read_only, json_mode,
                )),
            };
            let issues = if lock.entries.is_empty() {
                Vec::new()
            } else {
                store_root_issues(dir, &lock)
            };
            let code = run_check(dir, read_only, issues, json_mode);
            if code != 0 {
                process::exit(code);
            }
        }
        WikiRoot::Temp(tmp) => {
            if let Err(message) = check_temp_root(tmp.path(), json_mode) {
                process::exit(report_check_error(&message, true, json_mode));
            }
            let code = run_check(tmp.path(), true, Vec::new(), json_mode);
            if code != 0 {
                process::exit(code);
            }
        }
    }
}

/// Validate the manifest and the layout of a temporary root.
///
/// # Errors
///
/// Fails when the root holds no manifest, holds an invalid one, or misses
/// the bundle layout, so no bundle is left to check.
fn check_temp_root(root: &Path, json_mode: bool) -> Result<(), String> {
    let manifest_path = root.join("bundle.toml");
    if !manifest_path.exists() {
        return Err(String::from("在 wiki 根中未找到 bundle.toml"));
    }
    bundle::read_manifest(&manifest_path, json_mode)?;
    bundle::check_bundle_structure(root, json_mode)
}

/// The store-root checks: the root index must name every installed bundle,
/// and every installed bundle must be present.
///
/// A broken root index or a missing bundle is a content issue of the root,
/// not a failure of the run.
fn store_root_issues(
    root: &Path,
    lock: &bundle::ZwikiLock,
) -> Vec<report::ReportIssue> {
    let mut issues: Vec<report::ReportIssue> = Vec::new();
    if let Err(message) = bundle::check_root_index(root, lock) {
        issues.push(report::ReportIssue {
            rule: report::rules::Rule::RootIndex,
            path: String::from("index.md"),
            message,
            details: serde_json::json!({"index": "index.md"}),
        });
    }
    issues.extend(
        lock.entries
            .iter()
            .filter_map(|entry| missing_bundle_issue(root, entry)),
    );
    issues
}

/// The issue of one installed bundle whose directory is missing.
fn missing_bundle_issue(
    root: &Path,
    entry: &bundle::ZwikiLockEntry,
) -> Option<report::ReportIssue> {
    if root.join(&entry.target).exists() {
        return None;
    }
    Some(report::ReportIssue {
        rule: report::rules::Rule::BundleMissing,
        path: entry.target.clone(),
        message: String::from("已安装的 bundle 目录缺失"),
        details: serde_json::json!({
            "name": entry.name,
            "target": entry.target,
        }),
    })
}

/// Check one root and print its report.
///
/// A writable root applies the automatic writes, then judges the stored
/// pages.  A write that fails keeps the changes it stored, and the run
/// judges the pages as they are on disk.
/// A read-only root writes nothing: it reports the same
/// normalization as unapplied changes and judges the state a write would
/// store, including the index content a write would generate.
fn run_check(
    root: &Path,
    read_only: bool,
    mut issues: Vec<report::ReportIssue>,
    json_mode: bool,
) -> i32 {
    let mut set = wiki::PageSet::load(root);
    let mut changes: Vec<report::Change> = Vec::new();
    let mut indexes: HashMap<String, String> = HashMap::new();
    let mut error: Option<String> = None;

    if read_only {
        eprintln!("只读根，已跳过派生元数据同步");
        let pending = index::pending_updates(root, json_mode);
        changes.extend(pending.iter().map(|update| report::Change {
            path: update.path.clone(),
            kind: ChangeKind::Index,
        }));
        indexes = pending.into_iter().map(|u| (u.path, u.content)).collect();
        match pending_page_writes(root, &set, false, json_mode) {
            Ok(writes) => {
                changes.extend(writes.iter().flat_map(PageWrite::changes));
                set.apply_documents(
                    writes.into_iter().map(|w| (w.rel, w.document)),
                );
            }
            Err(message) => error = Some(message),
        }
    } else {
        match apply_check_writes(root, &set, json_mode) {
            Ok((applied, reloaded)) => {
                changes = applied;
                set = reloaded;
            }
            Err(failure) => {
                changes = failure.changes;
                error = Some(failure.message);
                // A partial write leaves the pages on disk as they are.
                set = wiki::PageSet::load(root);
            }
        }
    }

    let pages = set.pages().len() + set.errors().len();
    match run_health_lint_with_indexes(root, &set, &indexes) {
        Ok((health, lint, _, _)) => {
            issues.extend(report::rules::from_health_lint(&health, &lint));
            match report::rules::from_source_relations(root, &set) {
                Ok(source_issues) => issues.extend(source_issues),
                Err(message) => error = error.or(Some(message)),
            }
        }
        Err(message) => error = error.or(Some(message)),
    }

    let report = report::Report::new(read_only, pages, changes, issues, error);
    print_report(&report, json_mode);
    report.exit_code()
}

/// Print one `check` report: a single JSON document or the text layout.
///
/// The failure that stopped the run also goes to stderr, so a shell that
/// reads only the error stream still sees it.
fn print_report(report: &report::Report, json_mode: bool) {
    if json_mode {
        let document = serde_json::to_string_pretty(&report.to_json()).unwrap();
        crate::print_stdout_line(document);
    } else {
        crate::print_stdout_line(report::text::render(report));
    }
    if let Some(message) = &report.error {
        eprintln!("{message}");
    }
}

/// Print the report of a run that stopped before it examined any page.
fn report_check_error(error: &str, read_only: bool, json_mode: bool) -> i32 {
    let report = report::Report::new(
        read_only,
        0,
        Vec::new(),
        Vec::new(),
        Some(error.to_string()),
    );
    print_report(&report, json_mode);
    report.exit_code()
}

/// One page an automatic `check` write updates.
struct PageWrite {
    /// Path relative to the checked root.
    rel: String,
    /// The page document the write stores.
    document: PageDocument,
    /// Updates the write applies, in application order.
    kinds: Vec<ChangeKind>,
}

impl PageWrite {
    /// The report entries of this write, one per update.
    fn changes(&self) -> impl Iterator<Item = report::Change> + '_ {
        self.kinds
            .iter()
            .map(|kind| report::Change { path: self.rel.clone(), kind: *kind })
    }
}

/// A `check` write that stopped before it stored every update.
#[derive(Debug)]
struct CheckWriteError {
    /// Updates the run stored before the failure.
    changes: Vec<report::Change>,
    /// Failure that stopped the write.
    message: String,
}

/// Apply the automatic writes a writable bundle source accepts, then reload
/// the pages.
///
/// The writes are the generated indexes, the `## Backlinks` region, and the
/// stored page layout.  `timestamp` is never written: only an agent edit may
/// refresh it.  Every update of one page is merged into one render, so a
/// page never overwrites its own earlier write.
///
/// Returns the applied changes and the pages as stored afterwards.
///
/// # Errors
///
/// Fails when a page cannot be read, parsed, rendered, or written.  The
/// error keeps the changes the run stored before the failure.
fn apply_check_writes(
    dir: &Path,
    set: &wiki::PageSet,
    suppress_eprint: bool,
) -> Result<(Vec<report::Change>, wiki::PageSet), CheckWriteError> {
    let mut changes: Vec<report::Change> =
        index::regenerate_all_indexes(dir, suppress_eprint)
            .into_iter()
            .map(|path| report::Change { path, kind: ChangeKind::Index })
            .collect();
    let writes = match pending_page_writes(dir, set, true, suppress_eprint) {
        Ok(writes) => writes,
        Err(message) => return Err(CheckWriteError { changes, message }),
    };
    for write in &writes {
        if let Err(e) =
            document_io::store(&dir.join(&write.rel), &write.document)
        {
            let message = format!("{}: {e}", write.rel);
            return Err(CheckWriteError { changes, message });
        }
        changes.extend(write.changes());
    }
    Ok((changes, wiki::PageSet::load(dir)))
}

/// Compute the normalization an automatic `check` write applies to the pages
/// of `root`, without writing them.
///
/// The updates are the `## Backlinks` region and the stored page layout.  A
/// page inside an installed bundle layer is never rewritten, so
/// `skip_bundle_pages` leaves it out of a writable root; a read-only root
/// writes nothing and keeps every page in the candidate state.
///
/// Returns one entry per page whose stored form would change, each carrying
/// the document the write stores.
///
/// # Errors
///
/// Fails when a page cannot be read or parsed, so the caller reports the
/// failure instead of a partial state.
fn pending_page_writes(
    root: &Path,
    set: &wiki::PageSet,
    skip_bundle_pages: bool,
    suppress_eprint: bool,
) -> Result<Vec<PageWrite>, String> {
    let all_pages = set.require_all()?;
    if all_pages.is_empty() {
        return Ok(Vec::new());
    }

    let candidates: Vec<wiki::Page> = all_pages
        .iter()
        .filter(|page| {
            !skip_bundle_pages
                || wiki::bundle_on_path(root, &page.rel).is_none()
        })
        .cloned()
        .collect();
    if skip_bundle_pages
        && candidates.len() < all_pages.len()
        && !suppress_eprint
    {
        eprintln!(
            "已跳过 {} 个只读 bundle 页面",
            all_pages.len() - candidates.len()
        );
    }

    // Page identity comes from the bundle manifests; without them no
    // reference has a target.
    let catalog = catalog::Catalog::new(root, set)?;

    // The reverse index is built from all pages so that bundle pages
    // contribute their outbound links, but only candidate pages are
    // normalized.  It also feeds the supersede detection of the freshness
    // verdict.
    let bl_index = backlinks::build_reverse_index(&catalog, all_pages);
    let titles = backlinks::title_map(all_pages);
    let backlinks_by_rel: HashMap<String, Option<String>> =
        backlinks::pending_backlinks(&bl_index, &titles, &candidates, &catalog)
            .into_iter()
            .map(|(page, content)| (page.rel.clone(), content))
            .collect();

    let mut writes: Vec<PageWrite> = Vec::new();
    for page in &candidates {
        let backlinks = backlinks_by_rel.get(&page.rel);
        if backlinks.is_none() && !layout_differs(page)? {
            continue;
        }

        let mut document = page.document.clone();
        let mut kinds: Vec<ChangeKind> = Vec::new();
        if let Some(content) = backlinks {
            document.body.set_backlinks(content.clone());
            kinds.push(ChangeKind::Backlinks);
        }
        if layout_differs(page)? {
            kinds.push(ChangeKind::Format);
        }
        writes.push(PageWrite { rel: page.rel.clone(), document, kinds });
    }

    Ok(writes)
}

/// Whether the stored page text differs from what the document model writes.
///
/// A page a write normalizes also carries that difference.
///
/// # Errors
///
/// Fails when the stored page cannot be read or the document rendered.
fn layout_differs(page: &wiki::Page) -> Result<bool, String> {
    let rendered =
        page.document.render().map_err(|e| format!("{}: {e}", page.rel))?;
    let stored = std::fs::read_to_string(&page.path)
        .map_err(|e| format!("{}: {e}", page.rel))?;
    Ok(rendered != stored)
}

/// Run health + lint checks against `root`, return structured results
/// and issue counts. Does NOT print, sync backlinks, write reports, or
/// exit. Pure detection only.
///
/// # Errors
///
/// Fails when the pages carry no bundle identity, so the lint rules cannot
/// resolve their references.
pub(crate) fn run_health_lint_at(
    root: &Path,
) -> Result<(display::CheckResults, display::LintResults, usize, usize), String>
{
    run_health_lint(root, &wiki::PageSet::load(root))
}

/// Run health and lint checks on one page snapshot.
///
/// # Errors
///
/// Fails when the pages carry no bundle identity, so the lint rules cannot
/// resolve their references.
pub(crate) fn run_health_lint(
    root: &Path,
    set: &wiki::PageSet,
) -> Result<(display::CheckResults, display::LintResults, usize, usize), String>
{
    run_health_lint_with_indexes(root, set, &HashMap::new())
}

/// Run health and lint checks on one snapshot, judging `indexes` content in
/// place of the index files on disk.
///
/// # Errors
///
/// Fails when the pages carry no bundle identity, so the lint rules cannot
/// resolve their references.
fn run_health_lint_with_indexes(
    root: &Path,
    set: &wiki::PageSet,
    indexes: &HashMap<String, String>,
) -> Result<(display::CheckResults, display::LintResults, usize, usize), String>
{
    let health_results = health::run_all(root, set, indexes)?;
    let lint_results = lint::run_all(root, set)?;
    let health_issues = display::count_health_issues(&health_results);
    let lint_issues = display::count_lint_issues(&lint_results);
    Ok((health_results, lint_results, health_issues, lint_issues))
}

/// Build the JSON representation of health + lint results (without the
/// outer wrapper).  `bundle install` and `bundle update` show a candidate
/// bundle with it.
pub(crate) fn format_health_lint_json(
    health: &display::CheckResults,
    lint: &display::LintResults,
) -> serde_json::Value {
    let fmt_issues = |issues: &[display::Issue]| -> Vec<serde_json::Value> {
        issues
            .iter()
            .map(|i| {
                serde_json::json!({"page": i.page, "category": i.category, "details": i.details})
            })
            .collect()
    };

    serde_json::json!({
        "health": {
            "total_pages": health.total_pages,
            "empty_files": fmt_issues(&health.empty_files),
            "index_sync": {
                "on_disk_not_in_index": health.index_sync.on_disk_not_in_index,
                "in_index_not_on_disk": health.index_sync.in_index_not_on_disk,
            },
            "log_coverage": fmt_issues(&health.log_coverage),
            "frontmatter": fmt_issues(&health.frontmatter),
            "system_file_links": fmt_issues(&health.system_file_links),
            "source_field": fmt_issues(&health.source_field),
            "missing_inline_links": fmt_issues(&health.missing_inline_links),
            "duplicate_inline_links": fmt_issues(&health.duplicate_inline_links),
        },
        "lint": {
            "broken_links": fmt_issues(&lint.broken_links),
            "orphan_pages": fmt_issues(&lint.orphan_pages),
            "sparse_pages": fmt_issues(&lint.sparse_pages),
            "cascade_stale": fmt_issues(&lint.cascade_stale),
        },
    })
}

/// Dispatch all `page` subcommands — show, set, unset, create, move.
fn dispatch_page(wiki_root: &WikiRoot, cmd: &PageCommand, json: bool) {
    match cmd {
        PageCommand::Show(args) => {
            let normalized = normalize_page_path(wiki_root.path(), &args.path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            cmd_page_show(
                wiki_root,
                &normalized,
                args.property.as_deref(),
                args.outline,
                args.backlinks,
                json,
            );
        }
        PageCommand::Set(args) => {
            guard_write(wiki_root, "page set");
            let normalized = normalize_page_path(wiki_root.path(), &args.path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            guard_write_page(wiki_root.path(), &normalized, "page set");
            cmd_page_set(
                wiki_root,
                &normalized,
                &args.prop,
                args.value.as_deref(),
                args.note.as_deref(),
            );
        }
        PageCommand::Unset(args) => {
            guard_write(wiki_root, "page unset");
            let normalized = normalize_page_path(wiki_root.path(), &args.path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            guard_write_page(wiki_root.path(), &normalized, "page unset");
            cmd_page_unset(
                wiki_root,
                &normalized,
                &args.prop,
                args.note.as_deref(),
            );
        }
        PageCommand::Create(args) => {
            guard_write(wiki_root, "page create");
            // The target page is always created inside `<domain>/`, so
            // guarding the domain directory covers the write target.
            guard_write_page(wiki_root.path(), &args.domain, "page create");
            cmd_create(
                wiki_root,
                &args.domain,
                &args.r#type,
                &args.title,
                args.slug.as_deref(),
                args.source_type.as_deref(),
                args.note.as_deref(),
            );
        }
        PageCommand::Move(args) => {
            guard_write(wiki_root, "page move");
            // Normalize only the old path (new path doesn't exist yet).
            let old_norm = normalize_page_path(wiki_root.path(), &args.old)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            guard_write_page(wiki_root.path(), &old_norm, "page move");
            guard_write_page(wiki_root.path(), &args.new, "page move");
            cmd_move(
                wiki_root,
                &old_norm,
                &args.new,
                args.note.as_deref(),
                json,
            );
        }
    }
}

/// Dispatch `domain` subcommands — currently only `domain create`.
fn dispatch_domain(wiki_root: &WikiRoot, cmd: &DomainCommand) {
    match cmd {
        DomainCommand::Create(args) => {
            guard_write(wiki_root, "domain create");
            match page::create_domain_at(wiki_root.path(), &args.name) {
                Ok(path) => {
                    let rel = path
                        .strip_prefix(wiki_root.path())
                        .unwrap_or(path.as_path());
                    log_mutation(
                        wiki_root.path(),
                        &rel.to_string_lossy(),
                        "create",
                        args.note.as_deref(),
                    );
                    crate::print_stdout_line(format!(
                        "已创建领域: {}",
                        path.display()
                    ));
                }
                Err(e) => {
                    eprintln!("{e}");
                    process::exit(1);
                }
            }
        }
    }
}

/// Read a page title for display, failing the command on a read error.
fn page_title(rel: &str, root: &Path) -> String {
    backlinks::page_title_from_rel(rel, root).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    })
}

/// Show a page: read full content, or project property/outline/backlinks.
fn cmd_page_show(
    wiki_root: &WikiRoot,
    path: &str,
    property: Option<&str>,
    outline: bool,
    backlinks: bool,
    json: bool,
) {
    if backlinks {
        let root = wiki_root.path();
        let set = wiki::PageSet::load(root);
        let pages = set.require_all().unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
        let catalog = catalog::Catalog::new(root, &set).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
        let sources = catalog.id_of(path).map_or_else(Vec::new, |target| {
            backlinks::build_backlinks_for(target, &catalog, pages)
        });

        if json {
            let total = pages.len();
            let with_bl = usize::from(!sources.is_empty());
            let mut map = serde_json::Map::new();
            if !sources.is_empty() {
                let list: Vec<_> = sources
                    .iter()
                    .map(|s| {
                        serde_json::json!({"path": s, "title": page_title(s, root)})
                    })
                    .collect();
                map.insert(
                    path.to_string(),
                    serde_json::json!({"title": page_title(path, root), "sources": list}),
                );
            }
            let out = serde_json::json!({"total_pages": total, "pages_with_backlinks": with_bl, "backlinks": map});
            crate::print_stdout_line(
                serde_json::to_string_pretty(&out).unwrap(),
            );
        } else {
            // Compact single-page view — not the full-wiki report frame.
            let title = page_title(path, root);
            crate::print_stdout_line(format!(
                "## 反向链接 — {title}（{}）\n",
                sources.len()
            ));
            if sources.is_empty() {
                crate::print_stdout_line("无页面引用此页。");
            } else {
                for s in &sources {
                    let title = page_title(s, root);
                    crate::print_stdout_line(format!("- [{title}]({s})"));
                }
            }
        }
        return;
    }

    let full = wiki_root.path().join(path);
    if let Some(prop) = property {
        match property::get(&full, prop) {
            Ok(Some(v)) => crate::print_stdout_line(v),
            Ok(None) => {
                eprintln!("属性未找到: {prop}");
                process::exit(1);
            }
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    } else if outline {
        match page::read_outline(&full) {
            Ok(headings) => crate::print_stdout_line(headings),
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    } else {
        match page::read_full(&full) {
            Ok(c) => print_stdout(c),
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    }
}

/// Set a frontmatter property on a page.
fn cmd_page_set(
    wiki_root: &WikiRoot,
    path: &str,
    prop: &str,
    value: Option<&str>,
    note: Option<&str>,
) {
    let full = wiki_root.path().join(path);
    let Some(val) = value else {
        eprintln!("需要设置值");
        process::exit(1);
    };
    property::set(&full, prop, val).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });
    log_mutation(wiki_root.path(), path, "edit", note);
}

/// Unset (delete) a frontmatter property from a page.
fn cmd_page_unset(
    wiki_root: &WikiRoot,
    path: &str,
    prop: &str,
    note: Option<&str>,
) {
    let full = wiki_root.path().join(path);
    property::delete(&full, prop).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });
    log_mutation(wiki_root.path(), path, "edit", note);
}

fn cmd_create(
    wiki_root: &WikiRoot,
    domain: &str,
    r#type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
    note: Option<&str>,
) {
    match page::create_page_at(
        wiki_root.path(),
        domain,
        r#type,
        title,
        slug,
        source_type,
    ) {
        Ok(p) => {
            let rel = p.strip_prefix(wiki_root.path()).unwrap_or(p.as_path());
            log_mutation(
                wiki_root.path(),
                &rel.to_string_lossy(),
                "create",
                note,
            );
            crate::print_stdout_line(format!("已创建页面: {}", p.display()));
        }
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}

fn cmd_search(
    wiki_root: &WikiRoot,
    query: &str,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki_root.path().to_path_buf();
    let engine = search::SearchEngine::new(wiki_dir.clone());

    if check_domain_or_print(
        domain_filter,
        &wiki_dir,
        &wiki::BundleSet::discover(&wiki_dir),
        json,
        "[]",
    ) {
        return;
    }

    let results = engine
        .search(query, type_filter, tag_filter, domain_filter)
        .unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });

    if json {
        crate::print_stdout_line(search::format_results_json(&results));
    } else {
        print_stdout_line(search::format_results(&results));
    }
}

fn cmd_list(
    wiki_root: &WikiRoot,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki_root.path().to_path_buf();
    let bundles = wiki::BundleSet::discover(&wiki_dir);

    if check_domain_or_print(domain_filter, &wiki_dir, &bundles, json, "[]") {
        return;
    }

    let entries = list::list_pages(
        &wiki_dir,
        type_filter,
        tag_filter,
        domain_filter,
        &bundles,
    )
    .unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });

    if json {
        crate::print_stdout_line(list::format_list_json(&entries));
    } else {
        print_stdout_line(list::format_list(&entries));
    }
}

fn cmd_status(
    wiki_root: &WikiRoot,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki_root.path().to_path_buf();
    let bundles = wiki::BundleSet::discover(&wiki_dir);

    if check_domain_or_print(domain_filter, &wiki_dir, &bundles, json, "{}") {
        return;
    }

    let report = status::compute_status(
        &wiki_dir,
        type_filter,
        tag_filter,
        domain_filter,
        &bundles,
    )
    .unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });

    if json {
        crate::print_stdout_line(status::format_status_json(&report));
    } else {
        print_stdout_line(status::format_status(
            &report,
            type_filter,
            tag_filter,
            domain_filter,
        ));
    }
}

// ---------------------------------------------------------------------------
// Tags / Types / Domains — shared aggregate handler
// ---------------------------------------------------------------------------

fn cmd_aggregate(
    wiki_root: &WikiRoot,
    field: aggregate::AggregateField,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki_root.path().to_path_buf();
    let bundles = wiki::BundleSet::discover(&wiki_dir);

    if check_domain_or_print(domain_filter, &wiki_dir, &bundles, json, "[]") {
        return;
    }

    let counts = aggregate::aggregate_field(
        &wiki_dir,
        field,
        type_filter,
        tag_filter,
        domain_filter,
        &bundles,
    )
    .unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });

    if json {
        crate::print_stdout_line(aggregate::format_aggregate_json(&counts));
    } else {
        print_stdout_line(aggregate::format_aggregate_human(&counts, field));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::temp_dir;

    #[test]
    fn test_help_exits_ok() {
        let result = ZwikiArgs::try_parse_from(["zwiki", "--help"]);
        // --help short-circuits with an error that clap handles
        assert!(result.is_err());
    }

    #[test]
    fn test_no_subcommand_shows_help() {
        let result = ZwikiArgs::try_parse_from(["zwiki"]);
        assert!(result.is_ok());
        let args = result.unwrap();
        assert!(args.command.is_none());
    }

    #[test]
    fn test_check_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "check"]).unwrap();
        assert!(matches!(args.command, Some(Command::Check)));
    }

    #[test]
    fn test_check_requires_no_args() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "check"]).unwrap();
        assert!(matches!(args.command, Some(Command::Check)));
    }

    #[test]
    fn test_check_with_root_before() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--root", "./wiki", "check"])
                .unwrap();
        assert_eq!(args.root, Some("./wiki".to_string()));
        assert!(matches!(args.command, Some(Command::Check)));
    }

    #[test]
    fn test_check_with_root_after() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "check", "--root", "./wiki"])
                .unwrap();
        assert_eq!(args.root, Some("./wiki".to_string()));
        assert!(matches!(args.command, Some(Command::Check)));
    }

    #[test]
    fn test_write_command_desc_classifies_commands() {
        let cases: &[(&[&str], bool)] = &[
            (&["zwiki", "check"], false),
            (&["zwiki", "page", "show", "a.md"], false),
            (&["zwiki", "page", "set", "a.md", "status", "draft"], true),
            (&["zwiki", "page", "unset", "a.md", "status"], true),
            (
                &[
                    "zwiki", "page", "create", "--domain", "d", "--type",
                    "concept", "--title", "T",
                ],
                true,
            ),
            (&["zwiki", "page", "move", "a.md", "b.md"], true),
            (
                &[
                    "zwiki",
                    "supersede",
                    "--old",
                    "a.md",
                    "--new",
                    "b.md",
                    "--reason",
                    "r",
                ],
                true,
            ),
            (&["zwiki", "domain", "create", "d"], true),
            (&["zwiki", "contradictions", "apply"], true),
            (&["zwiki", "contradictions", "list"], false),
            (&["zwiki", "bundle", "list"], false),
        ];
        for (argv, expect_write) in cases {
            let args = ZwikiArgs::try_parse_from(*argv).unwrap();
            let is_write =
                args.command.as_ref().and_then(write_command_desc).is_some();
            assert_eq!(is_write, *expect_write, "argv: {argv:?}");
        }
    }

    #[test]
    fn test_bundle_path_helpers() {
        let base = temp_dir("bundle_helpers");
        let store = base.join("store");
        let bundle_root = store.join("myteam");
        std::fs::create_dir_all(&bundle_root).unwrap();
        std::fs::write(bundle_root.join("bundle.toml"), ".").unwrap();
        std::fs::write(store.join("zwiki.lock"), "").unwrap();

        // A nested directory inside the bundle is owned by it.
        let nested = bundle_root.join("concepts");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(wiki::installed_bundle(&nested), Some("myteam".to_string()));
        assert_eq!(
            wiki::installed_bundle(&bundle_root),
            Some("myteam".to_string())
        );
        // The store root itself has no owning bundle.
        assert_eq!(wiki::installed_bundle(&store), None);
        // A standalone bundle source (no store ancestor) is writable.
        let source = base.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("bundle.toml"), ".").unwrap();
        assert_eq!(wiki::installed_bundle(&source), None);

        // A page below a bundle directory is detected by probe.
        assert_eq!(
            wiki::bundle_on_path(&store, "myteam/concepts/page.md"),
            Some("myteam".to_string())
        );
        assert_eq!(
            wiki::bundle_on_path(&store, "myteam/readme.md"),
            Some("myteam".to_string())
        );
        assert_eq!(wiki::bundle_on_path(&source, "concepts/page.md"), None);
    }

    #[test]
    fn test_log_subcommand_removed() {
        let result = ZwikiArgs::try_parse_from([
            "zwiki",
            "log",
            "--path",
            "concepts/foo.md",
            "--action",
            "create",
        ]);
        assert!(result.is_err(), "log is not a recognized command");
    }

    // -------------------------------------------------------------------
    // Page subcommand — show
    // -------------------------------------------------------------------

    #[test]
    fn test_page_show_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "show",
            "concepts/npc.md",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Show(ref s))) => {
                assert_eq!(s.path, "concepts/npc.md");
                assert!(!s.outline);
                assert!(!s.backlinks);
                assert!(s.property.is_none());
            }
            _ => panic!("expected Page::Show"),
        }
    }

    #[test]
    fn test_page_show_with_property_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "show",
            "concepts/npc.md",
            "--property",
            "status",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Show(ref s))) => {
                assert_eq!(s.property, Some("status".to_string()));
            }
            _ => panic!("expected Page::Show"),
        }
    }

    #[test]
    fn test_page_show_with_outline_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "show",
            "concepts/npc.md",
            "--outline",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Show(ref s))) => {
                assert!(s.outline);
            }
            _ => panic!("expected Page::Show with outline"),
        }
    }

    #[test]
    fn test_page_show_with_backlinks_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "show",
            "concepts/npc.md",
            "--backlinks",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Show(ref s))) => {
                assert!(s.backlinks);
            }
            _ => panic!("expected Page::Show with backlinks"),
        }
    }

    #[test]
    fn test_page_show_with_root_before() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "--root",
            "./wiki",
            "page",
            "show",
            "concepts/npc.md",
        ])
        .unwrap();
        assert_eq!(args.root, Some("./wiki".to_string()));
        match args.command {
            Some(Command::Page(PageCommand::Show(ref s))) => {
                assert_eq!(s.path, "concepts/npc.md");
            }
            _ => panic!("expected Page::Show"),
        }
    }

    // -------------------------------------------------------------------
    // Page subcommand — set
    // -------------------------------------------------------------------

    #[test]
    fn test_page_set_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "set",
            "concepts/npc.md",
            "description",
            "new summary",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Set(ref a))) => {
                assert_eq!(a.path, "concepts/npc.md");
                assert_eq!(a.prop, "description");
                assert_eq!(a.value, Some("new summary".to_string()));
            }
            _ => panic!("expected Page::Set"),
        }
    }

    // -------------------------------------------------------------------
    // Page subcommand — unset
    // -------------------------------------------------------------------

    #[test]
    fn test_page_unset_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "unset",
            "concepts/npc.md",
            "description",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Unset(ref a))) => {
                assert_eq!(a.path, "concepts/npc.md");
                assert_eq!(a.prop, "description");
            }
            _ => panic!("expected Page::Unset"),
        }
    }

    // -------------------------------------------------------------------
    // Page subcommand — create
    // -------------------------------------------------------------------

    #[test]
    fn test_page_create_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "create",
            "--type",
            "concept",
            "--title",
            "Test Page",
            "--domain",
            "autoresearch",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Create(ref a))) => {
                assert_eq!(a.domain, "autoresearch");
                assert_eq!(a.r#type, "concept");
                assert_eq!(a.title, "Test Page");
            }
            _ => panic!("expected Page::Create"),
        }
    }

    #[test]
    fn test_page_create_with_slug_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "create",
            "--type",
            "source",
            "--title",
            "ADR-001",
            "--domain",
            "wiki-system",
            "--source-type",
            "adr",
            "--slug",
            "adr-001",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Create(ref a))) => {
                assert_eq!(a.domain, "wiki-system");
                assert_eq!(a.r#type, "source");
                assert_eq!(a.title, "ADR-001");
                assert_eq!(a.slug, Some("adr-001".to_string()));
                assert_eq!(a.source_type, Some("adr".to_string()));
            }
            _ => panic!("expected Page::Create"),
        }
    }

    // -------------------------------------------------------------------
    // Page subcommand — move
    // -------------------------------------------------------------------

    #[test]
    fn test_page_move_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "page", "move", "old.md", "new.md",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Move(ref a))) => {
                assert_eq!(a.old, "old.md");
                assert_eq!(a.new, "new.md");
            }
            _ => panic!("expected Page::Move"),
        }
    }

    #[test]
    fn test_page_move_with_json_flag_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "--json",
            "page",
            "move",
            "concepts/foo.md",
            "concepts/bar.md",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Page(PageCommand::Move(ref a))) => {
                assert_eq!(a.old, "concepts/foo.md");
                assert_eq!(a.new, "concepts/bar.md");
            }
            _ => panic!("expected Page::Move with json"),
        }
    }

    #[test]
    fn test_page_move_parses_note() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "move",
            "old.md",
            "new.md",
            "--note",
            "重命名",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Move(ref a))) => {
                assert_eq!(a.note.as_deref(), Some("重命名"));
            }
            _ => panic!("expected Page::Move with note"),
        }
    }

    #[test]
    fn test_global_json_flag() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "check"]).unwrap();
        assert!(args.json);
    }

    #[test]
    fn test_search_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "search", "permission"])
            .unwrap();
        match args.command {
            Some(Command::Search { query, r#type, tag, domain: _ }) => {
                assert_eq!(query, "permission");
                assert!(r#type.is_none());
                assert!(tag.is_none());
            }
            _ => panic!("expected Search"),
        }
    }

    #[test]
    fn test_search_with_type_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "search",
            "permission",
            "--type",
            "concept",
        ])
        .unwrap();
        match args.command {
            Some(Command::Search { query, r#type, .. }) => {
                assert_eq!(query, "permission");
                assert_eq!(r#type, Some("concept".to_string()));
            }
            _ => panic!("expected Search"),
        }
    }

    #[test]
    fn test_search_with_tag_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "search",
            "permission",
            "--tag",
            "auth",
        ])
        .unwrap();
        match args.command {
            Some(Command::Search { query, tag, .. }) => {
                assert_eq!(query, "permission");
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Search"),
        }
    }

    #[test]
    fn test_search_with_json_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "--json",
            "search",
            "permission",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Search { query, .. }) => {
                assert_eq!(query, "permission");
            }
            _ => panic!("expected Search"),
        }
    }

    // -------------------------------------------------------------------
    // List subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_list_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "list"]).unwrap();
        match args.command {
            Some(Command::List { r#type, tag, domain }) => {
                assert!(r#type.is_none());
                assert!(tag.is_none());
                assert!(domain.is_none());
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_with_type_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "list", "--type", "concept"])
                .unwrap();
        match args.command {
            Some(Command::List { r#type, .. }) => {
                assert_eq!(r#type, Some("concept".to_string()));
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_with_tag_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "list", "--tag", "auth"])
                .unwrap();
        match args.command {
            Some(Command::List { tag, .. }) => {
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_with_domain_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "list", "--domain", "shared"])
                .unwrap();
        match args.command {
            Some(Command::List { domain, .. }) => {
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "list", "--type", "concept", "--tag", "auth", "--domain",
            "shared",
        ])
        .unwrap();
        match args.command {
            Some(Command::List { r#type, tag, domain }) => {
                assert_eq!(r#type, Some("concept".to_string()));
                assert_eq!(tag, Some("auth".to_string()));
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "list"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::List { .. }) => {}
            _ => panic!("expected List"),
        }
    }

    // -------------------------------------------------------------------
    // Status subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_status_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "status"]).unwrap();
        match args.command {
            Some(Command::Status { r#type, tag, domain }) => {
                assert!(r#type.is_none());
                assert!(tag.is_none());
                assert!(domain.is_none());
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_type_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "status", "--type", "concept"])
                .unwrap();
        match args.command {
            Some(Command::Status { r#type, .. }) => {
                assert_eq!(r#type, Some("concept".to_string()));
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_tag_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "status", "--tag", "auth"])
                .unwrap();
        match args.command {
            Some(Command::Status { tag, .. }) => {
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_domain_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "status", "--domain", "shared",
        ])
        .unwrap();
        match args.command {
            Some(Command::Status { domain, .. }) => {
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "status", "--type", "concept", "--tag", "auth",
            "--domain", "shared",
        ])
        .unwrap();
        match args.command {
            Some(Command::Status { r#type, tag, domain }) => {
                assert_eq!(r#type, Some("concept".to_string()));
                assert_eq!(tag, Some("auth".to_string()));
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "status"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Status { .. }) => {}
            _ => panic!("expected Status"),
        }
    }

    // -------------------------------------------------------------------
    // Tags subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_tags_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "tags"]).unwrap();
        match args.command {
            Some(Command::Tags { r#type, domain }) => {
                assert!(r#type.is_none());
                assert!(domain.is_none());
            }
            _ => panic!("expected Tags"),
        }
    }

    #[test]
    fn test_tags_with_type_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "tags", "--type", "concept"])
                .unwrap();
        match args.command {
            Some(Command::Tags { r#type, .. }) => {
                assert_eq!(r#type, Some("concept".to_string()));
            }
            _ => panic!("expected Tags"),
        }
    }

    #[test]
    fn test_tags_with_domain_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "tags", "--domain", "shared"])
                .unwrap();
        match args.command {
            Some(Command::Tags { domain, .. }) => {
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Tags"),
        }
    }

    #[test]
    fn test_tags_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "tags", "--type", "concept", "--domain", "shared",
        ])
        .unwrap();
        match args.command {
            Some(Command::Tags { r#type, domain }) => {
                assert_eq!(r#type, Some("concept".to_string()));
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Tags"),
        }
    }

    #[test]
    fn test_tags_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "tags"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Tags { .. }) => {}
            _ => panic!("expected Tags"),
        }
    }

    // -------------------------------------------------------------------
    // Types subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_types_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "types"]).unwrap();
        match args.command {
            Some(Command::Types { tag, domain }) => {
                assert!(tag.is_none());
                assert!(domain.is_none());
            }
            _ => panic!("expected Types"),
        }
    }

    #[test]
    fn test_types_with_tag_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "types", "--tag", "auth"])
                .unwrap();
        match args.command {
            Some(Command::Types { tag, .. }) => {
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Types"),
        }
    }

    #[test]
    fn test_types_with_domain_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "types", "--domain", "shared"])
                .unwrap();
        match args.command {
            Some(Command::Types { domain, .. }) => {
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Types"),
        }
    }

    #[test]
    fn test_types_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "types", "--tag", "auth", "--domain", "shared",
        ])
        .unwrap();
        match args.command {
            Some(Command::Types { tag, domain }) => {
                assert_eq!(tag, Some("auth".to_string()));
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Types"),
        }
    }

    #[test]
    fn test_types_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "types"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Types { .. }) => {}
            _ => panic!("expected Types"),
        }
    }

    // -------------------------------------------------------------------
    // Domains subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_domains_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "domains"]).unwrap();
        match args.command {
            Some(Command::Domains { r#type, tag }) => {
                assert!(r#type.is_none());
                assert!(tag.is_none());
            }
            _ => panic!("expected Domains"),
        }
    }

    #[test]
    fn test_domains_with_type_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "domains", "--type", "concept",
        ])
        .unwrap();
        match args.command {
            Some(Command::Domains { r#type, .. }) => {
                assert_eq!(r#type, Some("concept".to_string()));
            }
            _ => panic!("expected Domains"),
        }
    }

    #[test]
    fn test_domains_with_tag_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "domains", "--tag", "auth"])
                .unwrap();
        match args.command {
            Some(Command::Domains { tag, .. }) => {
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Domains"),
        }
    }

    #[test]
    fn test_domains_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "domains", "--type", "concept", "--tag", "auth",
        ])
        .unwrap();
        match args.command {
            Some(Command::Domains { r#type, tag }) => {
                assert_eq!(r#type, Some("concept".to_string()));
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Domains"),
        }
    }

    #[test]
    fn test_domains_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "domains"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Domains { .. }) => {}
            _ => panic!("expected Domains"),
        }
    }

    // -------------------------------------------------------------------
    // Supersede subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_supersede_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "supersede",
            "--old",
            "old.md",
            "--new",
            "new.md",
            "--reason",
            "replaces old content",
        ])
        .unwrap();
        match args.command {
            Some(Command::Supersede { old, new, reason, .. }) => {
                assert_eq!(old, "old.md");
                assert_eq!(new, "new.md");
                assert_eq!(reason, "replaces old content");
            }
            _ => panic!("expected Supersede"),
        }
    }

    #[test]
    fn test_supersede_missing_reason_fails() {
        let result = ZwikiArgs::try_parse_from([
            "zwiki",
            "supersede",
            "--old",
            "o.md",
            "--new",
            "n.md",
        ]);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // Verify subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_verify_parses() {
        let args = ZwikiArgs::try_parse_from(["zwiki", "verify"]).unwrap();
        match args.command {
            Some(Command::Verify { domain }) => {
                assert!(domain.is_none());
            }
            _ => panic!("expected Verify"),
        }
    }

    #[test]
    fn test_verify_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "verify"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Verify { domain }) => {
                assert!(domain.is_none());
            }
            _ => panic!("expected Verify with json"),
        }
    }

    #[test]
    fn test_verify_with_domain_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "verify",
            "--domain",
            "autoresearch",
        ])
        .unwrap();
        match args.command {
            Some(Command::Verify { domain }) => {
                assert_eq!(domain, Some("autoresearch".to_string()));
            }
            _ => panic!("expected Verify with domain"),
        }
    }

    #[test]
    fn test_verify_with_json_and_domain_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki", "--json", "verify", "--domain", "shared",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Verify { domain }) => {
                assert_eq!(domain, Some("shared".to_string()));
            }
            _ => panic!("expected Verify with json and domain"),
        }
    }

    // -------------------------------------------------------------------
    // Bundle subcommand (CLI parsing only)
    // -------------------------------------------------------------------

    #[test]
    fn test_bundle_init_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "bundle", "init"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Init(..))) => {}
            _ => panic!("expected Bundle::Init"),
        }
    }

    #[test]
    fn test_bundle_init_with_name_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "bundle",
            "init",
            "--name",
            "my-bundle",
        ])
        .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Init(ref a))) => {
                assert_eq!(a.name, Some("my-bundle".to_string()));
            }
            _ => panic!("expected Bundle::Init"),
        }
    }

    #[test]
    fn test_bundle_init_with_all_flags_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "bundle",
            "init",
            "--name",
            "my-bundle",
            "--version",
            "1.0.0",
            "--okf-version",
            "0.2",
            "--registry",
            "https://reg.example.com",
            "--include",
            "*.md",
            "--include",
            "assets/**",
            "--exclude",
            "drafts/**",
            "--json",
        ])
        .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Init(ref a))) => {
                assert_eq!(a.name, Some("my-bundle".to_string()));
                assert_eq!(a.version, "1.0.0");
                assert_eq!(a.okf_version, "0.2");
                assert_eq!(
                    a.registry,
                    Some("https://reg.example.com".to_string())
                );
                assert_eq!(a.include, vec!["*.md", "assets/**"]);
                assert_eq!(a.exclude, vec!["drafts/**"]);
                assert!(a.json);
            }
            _ => panic!("expected Bundle::Init"),
        }
    }

    #[test]
    fn test_bundle_export_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "bundle",
            "export",
            "/some/dir",
        ])
        .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Export(_))) => {}
            _ => panic!("expected Bundle::Export"),
        }
    }

    #[test]
    fn test_bundle_install_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "bundle", "install", "source"])
                .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Install(_))) => {}
            _ => panic!("expected Bundle::Install"),
        }
    }

    #[test]
    fn test_bundle_list_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "bundle", "list"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::List(..))) => {}
            _ => panic!("expected Bundle::List"),
        }
    }

    #[test]
    fn test_bundle_list_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "bundle", "list"])
                .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::List(..))) => {}
            _ => panic!("expected Bundle::List with json"),
        }
    }

    #[test]
    fn test_bundle_check_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "bundle", "check"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Check(..))) => {}
            _ => panic!("expected Bundle::Check"),
        }
    }

    #[test]
    fn test_bundle_check_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "bundle", "check"])
                .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Check(..))) => {}
            _ => panic!("expected Bundle::Check with json"),
        }
    }

    #[test]
    fn test_bundle_update_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "bundle", "update"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Update(..))) => {}
            _ => panic!("expected Bundle::Update"),
        }
    }

    #[test]
    fn test_bundle_update_with_name_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "bundle",
            "update",
            "--name",
            "my-bundle",
        ])
        .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Update(ref a))) => {
                assert_eq!(a.name, Some("my-bundle".to_string()));
            }
            _ => panic!("expected Bundle::Update with name"),
        }
    }

    #[test]
    fn test_bundle_update_with_json_parses() {
        let args =
            ZwikiArgs::try_parse_from(["zwiki", "--json", "bundle", "update"])
                .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Update(..))) => {}
            _ => panic!("expected Bundle::Update with json"),
        }
    }

    #[test]
    fn test_bundle_uninstall_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "bundle",
            "uninstall",
            "my-bundle",
        ])
        .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Uninstall(ref a))) => {
                assert_eq!(a.name, "my-bundle");
            }
            _ => panic!("expected Bundle::Uninstall"),
        }
    }

    #[test]
    fn test_bundle_uninstall_with_json_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "--json",
            "bundle",
            "uninstall",
            "my-bundle",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Uninstall(ref a))) => {
                assert_eq!(a.name, "my-bundle");
            }
            _ => panic!("expected Bundle::Uninstall with json"),
        }
    }

    // -------------------------------------------------------------------
    // run_check
    // -------------------------------------------------------------------

    /// A valid bundle manifest for fixtures that need page identity.
    const TEST_MANIFEST: &str = "[package]\nname = \"test\"\nversion = \"0.1.0\"\n\n\
         [export]\ninclude = [\"**/*.md\"]\n";

    #[test]
    fn test_run_health_lint_shares_one_snapshot() {
        // Health and lint see the same snapshot: the rejected page is one
        // invalid_document issue, and its links are missing targets for lint.
        let dir = temp_dir("shared_snapshot");
        std::fs::write(dir.join("bundle.toml"), TEST_MANIFEST).unwrap();
        std::fs::write(
            dir.join("linker.md"),
            "---\ntitle: Linker\ntype: concept\ntags: []\n\
             timestamp: 2026-01-01T00:00:00Z\n---\n\n\
             See [Broken](broken.md).\n",
        )
        .unwrap();
        std::fs::write(dir.join("broken.md"), "# Broken page\n").unwrap();

        let (health, lint, health_issues, lint_issues) =
            run_health_lint_at(&dir).expect("the root holds a manifest");

        assert_eq!(health.total_pages, 2, "both pages are counted");
        assert!(
            health
                .frontmatter
                .iter()
                .any(|i| i.category == "invalid_document"
                    && i.page == "broken.md"),
            "health reports the rejected page"
        );
        assert!(
            lint.broken_links.iter().any(|i| i.category == "target_not_found"
                && i.details.contains("broken.md")),
            "lint misses the rejected page as a link target"
        );
        assert!(health_issues > 0 && lint_issues > 0);
    }

    #[test]
    fn test_run_check_reports_the_generated_index_unapplied() {
        // A bare directory accepts no write, so the index a bundle source
        // would generate stays unapplied.
        let dir = temp_dir("check_root_empty");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let code = run_check(&dir, true, Vec::new(), false);
        assert_eq!(code, 1, "an unapplied index fails the run");
        assert!(
            !dir.join("index.md").exists(),
            "the read-only root is never written"
        );
    }

    #[test]
    fn test_store_root_issues_report_a_missing_bundle() {
        let dir = temp_dir("check_store_missing");
        std::fs::write(
            dir.join("index.md"),
            "- [missing](bundles/missing/index.md)\n",
        )
        .unwrap();

        let lock = bundle::ZwikiLock {
            entries: vec![bundle::ZwikiLockEntry {
                name: "missing".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: "bundles/missing".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        let issues = store_root_issues(&dir, &lock);

        assert_eq!(issues.len(), 1, "one issue per missing bundle: {issues:?}");
        assert_eq!(issues[0].rule, report::rules::Rule::BundleMissing);
        assert_eq!(issues[0].path, "bundles/missing");
    }

    #[test]
    fn test_store_root_issues_report_an_unlinked_index() {
        let dir = temp_dir("check_store_unlinked");
        std::fs::write(dir.join("index.md"), "# Index\n").unwrap();
        let bundle_dir = dir.join("bundles").join("test");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("bundle.toml"), TEST_MANIFEST).unwrap();

        let lock = bundle::ZwikiLock {
            entries: vec![bundle::ZwikiLockEntry {
                name: "test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: "bundles/test".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
            ..Default::default()
        };
        let issues = store_root_issues(&dir, &lock);

        assert_eq!(issues.len(), 1, "one root index issue: {issues:?}");
        assert_eq!(issues[0].rule, report::rules::Rule::RootIndex);
        assert_eq!(issues[0].path, "index.md");
        assert!(
            issues[0].message.contains("test"),
            "the issue names the unreferenced bundle: {}",
            issues[0].message
        );
    }

    #[test]
    fn test_run_check_does_not_write_timestamp() {
        // A writable root normalizes the layout and keeps the stored
        // `timestamp`: only an agent edit may refresh it.
        let dir = temp_dir("check_writable_timestamp");
        std::fs::write(dir.join("bundle.toml"), TEST_MANIFEST).unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();

        let stamp = "2020-01-01T00:00:00Z";
        let body = "This document has enough text to pass the health and lint \
                    checks that zwiki runs during validation.  See \
                    [Linker](shared/linker.md).\n";
        let path = dir.join("shared").join("doc.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                "---\ntitle: Timestamp Test\ntype: concept\n\
                 timestamp: {stamp}\ntags: []\n---\n\n\
                 # Timestamp Test\n\n{body}\n"
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("shared/linker.md"),
            format!(
                "---\ntitle: Linker\ntype: concept\ntimestamp: {stamp}\n\
                 tags: []\n---\n\n# Linker\n\nSee [Doc](shared/doc.md).\n\
                 This page carries enough body text to pass the health and \
                 lint checks that zwiki runs during validation, so the \
                 fixture leaves no finding of its own.\n"
            ),
        )
        .unwrap();

        let code = run_check(&dir, false, Vec::new(), false);

        assert_eq!(code, 0, "a normalized page leaves no issue");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains(&format!("timestamp: {stamp}")),
            "check must not rewrite the timestamp: {content:?}"
        );
    }

    #[test]
    fn test_run_check_propagates_a_page_failure() {
        let dir = temp_dir("check_page_failure");
        std::fs::write(dir.join("bundle.toml"), TEST_MANIFEST).unwrap();
        // No frontmatter: the document model rejects the page.
        std::fs::write(dir.join("page.md"), "# Page\n").unwrap();

        let code = run_check(&dir, false, Vec::new(), false);

        assert_eq!(code, 1, "a page the model rejects fails the run");
    }

    #[test]
    fn test_apply_check_writes_stores_backlinks() {
        // A page with an inbound link gains the generated region.
        let dir = temp_dir("sync_bl");
        std::fs::write(dir.join("bundle.toml"), TEST_MANIFEST).unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();

        // Page A links to page B via an inline link.
        let page_a = format!(
            "---
title: Page A
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
---

# Page A

See also [Page B](page_b.md) for related information.
{}
",
            "This document has enough text to pass health and lint checks. \
             It contains well over one hundred characters to satisfy stub \
             thresholds and other quality gates for validation.\n"
        );
        std::fs::write(dir.join("page_a.md"), &page_a).unwrap();

        let page_b = format!(
            "---
title: Page B
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
---

# Page B

{body}

## Details

Detailed information about page B goes here.
",
            body = "This document has enough text to pass health and lint checks. \
             It contains well over one hundred characters to satisfy stub \
             thresholds and other quality gates for validation."
        );
        std::fs::write(dir.join("page_b.md"), &page_b).unwrap();

        let (changes, _) =
            apply_check_writes(&dir, &wiki::PageSet::load(&dir), false)
                .expect("apply writes");
        assert!(
            changes
                .iter()
                .any(|c| c.path == "page_b.md"
                    && c.kind == ChangeKind::Backlinks),
            "the change names the page that gained backlinks: {changes:?}"
        );

        // The write stores the region, not only the report entry.
        let content_b = std::fs::read_to_string(dir.join("page_b.md")).unwrap();
        assert!(
            content_b.contains("## Backlinks"),
            "page_b.md should have Backlinks after check"
        );
        assert!(
            content_b.contains("Page A"),
            "page_b.md Backlinks should reference Page A"
        );

        // A page with no inbound link stays unchanged.
        let content_a = std::fs::read_to_string(dir.join("page_a.md")).unwrap();
        assert!(
            !content_a.contains("## Backlinks"),
            "page_a.md should NOT have Backlinks (no inbound links)"
        );
    }

    #[test]
    fn test_root_flag_before_and_after_check() {
        // Verify --root is accepted both before and after subcommand.
        let before = ZwikiArgs::try_parse_from([
            "zwiki",
            "--root",
            "/tmp/test",
            "check",
        ]);
        assert!(before.is_ok());
        assert_eq!(before.unwrap().root, Some("/tmp/test".to_string()));

        let after = ZwikiArgs::try_parse_from([
            "zwiki",
            "check",
            "--root",
            "/tmp/test",
        ]);
        assert!(after.is_ok());
        assert_eq!(after.unwrap().root, Some("/tmp/test".to_string()));
    }

    /// Page text with every required field.
    fn page_text(title: &str, timestamp: &str, body: &str) -> String {
        format!(
            "---\ntitle: {title}\ntype: concept\ntags: []\n\
             timestamp: {timestamp}\n---\n\n# {title}\n\n{body}\n"
        )
    }

    /// The page at `rel` in `set`.
    fn page_at<'a>(set: &'a wiki::PageSet, rel: &str) -> &'a wiki::Page {
        set.pages()
            .iter()
            .find(|page| page.rel == rel)
            .unwrap_or_else(|| panic!("no page at {rel}"))
    }

    /// A bundle source with `target.md`, plus a linker that references it.
    fn link_fixture(dir_name: &str, target: &str) -> PathBuf {
        let dir = temp_dir(dir_name);
        std::fs::write(dir.join("bundle.toml"), TEST_MANIFEST).unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        std::fs::write(
            dir.join("linker.md"),
            page_text("Linker", &now, "See [Target](target.md)."),
        )
        .unwrap();
        std::fs::write(dir.join("target.md"), target).unwrap();
        dir
    }

    #[test]
    fn test_apply_check_writes_merges_page_updates() {
        // One page needs backlinks and a layout normalization at once: the
        // record holds one entry, and the reloaded snapshot carries both
        // updates.
        let dir = link_fixture(
            "check_merged_write",
            &page_text("Target", "2020-01-01T00:00:00Z", "Target body.")
                .replace("tags: []", "tags: [a]"),
        );
        let before = wiki::PageSet::load(&dir);

        let (changes, after) =
            apply_check_writes(&dir, &before, true).expect("apply writes");

        let target: Vec<&report::Change> =
            changes.iter().filter(|c| c.path == "target.md").collect();
        assert_eq!(
            target.iter().map(|c| c.kind).collect::<Vec<_>>(),
            vec![ChangeKind::Backlinks, ChangeKind::Format],
            "both updates belong to the same write: {changes:?}"
        );
        assert!(
            changes
                .iter()
                .any(|c| c.path == "index.md" && c.kind == ChangeKind::Index),
            "the generated root index is part of the change set: {changes:?}"
        );

        assert!(
            page_at(&before, "target.md").document.body.backlinks().is_none(),
            "the snapshot before the write has no generated region"
        );
        let stored = &page_at(&after, "target.md").document;
        assert!(
            stored.body.backlinks().is_some(),
            "the reloaded snapshot carries the generated region"
        );
        assert_eq!(
            stored.metadata.timestamp, "2020-01-01T00:00:00Z",
            "check never rewrites the timestamp"
        );
    }

    #[test]
    fn test_apply_check_writes_records_layout_normalization() {
        // A rewritten page whose stored text is not canonical reports both
        // the update and the layout the write normalizes.
        let target = page_text("Target", "2020-01-01T00:00:00Z", "Body.");
        let dir = link_fixture("check_format", &format!("{target}\n\n"));

        let (changes, _) =
            apply_check_writes(&dir, &wiki::PageSet::load(&dir), true)
                .expect("apply writes");

        let kinds: Vec<ChangeKind> = changes
            .iter()
            .filter(|c| c.path == "target.md")
            .map(|c| c.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![ChangeKind::Backlinks, ChangeKind::Format],
            "the stale validation date is already stored as stale"
        );
        let text = std::fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(
            !text.contains("\n\n\n"),
            "the write drops the trailing blank lines: {text:?}"
        );
    }

    #[test]
    fn test_apply_check_writes_is_idempotent() {
        // A second run finds nothing to write and leaves every file alone.
        let dir = link_fixture(
            "check_idempotent",
            &page_text("Target", "2020-01-01T00:00:00Z", "Target body.")
                .replace("tags: []", "tags: [a]"),
        );

        let (first, _) =
            apply_check_writes(&dir, &wiki::PageSet::load(&dir), true)
                .expect("first run");
        assert!(!first.is_empty(), "the first run writes");
        let stored = std::fs::read_to_string(dir.join("target.md")).unwrap();

        let (second, _) =
            apply_check_writes(&dir, &wiki::PageSet::load(&dir), true)
                .expect("second run");
        assert!(
            second.is_empty(),
            "a synchronized root needs no write: {second:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("target.md")).unwrap(),
            stored,
            "the second run keeps the stored page"
        );
    }
}
