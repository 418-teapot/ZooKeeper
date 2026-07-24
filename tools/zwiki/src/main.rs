#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

mod aggregate;
mod backlinks;
mod bundle;
mod contradictions;
mod display;
mod health;
mod lint;
mod list;
mod log;
mod r#move;
mod page;
mod property;
mod search;
mod status;
mod supersede;
mod verify;
mod wiki;

use crate::bundle::ZwikiLock;
use clap::{Args, Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process;
use tempfile::TempDir;

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

/// Normalize a page path argument that should reference an **existing** page.
///
/// Pipeline (per §12.1 of the wiki design):
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
    /// Reads a JSON array of contradiction pairs from stdin and writes
    /// `contradictions` frontmatter blocks to both conflicting pages
    /// with symmetric status downgrade and `last_validated` update.
    Apply,
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

    /// Property name (e.g. timeliness, status, tags)
    pub prop: String,

    /// Value to set (required unless --downgrade is used)
    pub value: Option<String>,

    /// Downgrade the property value (status: stable→review→draft)
    #[arg(long)]
    pub downgrade: bool,
}

/// Delete a frontmatter property from a page
#[derive(Args)]
pub struct PageUnsetArgs {
    /// Wiki-relative page path
    pub path: String,
    /// Property name to delete
    pub prop: String,
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
}

/// Move / rename a wiki page
#[derive(Args)]
pub struct PageMoveArgs {
    /// Current wiki-relative page path
    pub old: String,
    /// New wiki-relative page path
    pub new: String,
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
// Top-level command enum
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
enum Command {
    /// Run all health and lint checks
    Check,

    /// Read a wiki page or manage page properties
    #[command(subcommand)]
    Page(PageCommand),

    /// Bundle distribution commands
    #[command(subcommand)]
    Bundle(bundle::BundleCommand),

    /// Append a log entry to wiki/logs/YYYY-MM.md
    Log {
        /// Operation: ingest, update, delete, query, health, lint, refresh, tool
        #[arg(long)]
        op: String,

        /// Wiki-relative page path (e.g. concepts/npc.md)
        #[arg(long)]
        path: String,

        /// Action: create, edit, delete, pass, fail
        #[arg(long)]
        action: String,

        /// Free-text note (truncated to 60 chars)
        #[arg(long)]
        note: Option<String>,
    },

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
    let wiki_root = match resolve_wiki_root(args.root.as_deref(), use_json) {
        Ok(r) => r,
        Err(e) => {
            if use_json {
                let output = serde_json::json!({"status": "error", "error": e});
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
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
            println!();
            process::exit(1);
        }
        Some(Command::Check) => {
            dispatch_check(&wiki_root, args.json);
        }
        Some(Command::Page(ref page_cmd)) => {
            dispatch_page(&wiki_root, page_cmd, args.json);
        }
        Some(Command::Log { op, path, action, note }) => {
            guard_writable(&wiki_root, "log");
            // Intentional per blueprint §12.1: log --path normalizes first
            // and rejects nonexistent pages with a clear error instead of
            // silently proceeding (behavioral change from old code).
            let normalized = normalize_page_path(wiki_root.path(), &path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            cmd_log(&wiki_root, &op, &normalized, &action, note.as_deref());
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

/// Dispatch the remaining subcommands (Verify through Contradictions)
/// to keep the main `dispatch` function under the line limit.
fn dispatch_tail(wiki_root: &WikiRoot, args: &ZwikiArgs, cmd: &Command) {
    match cmd {
        Command::Verify { domain } => {
            if check_domain_or_print(
                domain.as_deref(),
                wiki_root.path(),
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
        Command::Supersede { old, new, reason } => {
            guard_writable(wiki_root, "supersede");
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
            cmd_supersede(wiki_root, &old_norm, &new_norm, reason);
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
            if matches!(cmd, crate::ContradictionsCommand::Apply) {
                guard_writable(wiki_root, "contradictions apply");
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

/// Move a wiki page, updating references and indexes.
fn cmd_move(wiki_root: &WikiRoot, old: &str, new: &str, json: bool) {
    match r#move::execute_move(wiki_root.path(), old, new) {
        Ok(result) => {
            if json {
                let output = serde_json::json!({
                    "moved": result.moved,
                    "updated_refs": result.updated_refs,
                    "updated_indexes": result.updated_indexes,
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            } else {
                println!("已移动: {}", result.moved);
                if !result.updated_refs.is_empty() {
                    println!(
                        "已更新引用: {} 个页面",
                        result.updated_refs.len()
                    );
                    for r in &result.updated_refs {
                        println!("  {r}");
                    }
                }
                if !result.updated_indexes.is_empty() {
                    println!(
                        "已更新索引: {} 个文件",
                        result.updated_indexes.len()
                    );
                    for idx in &result.updated_indexes {
                        println!("  {idx}");
                    }
                }
                println!();
                println!("运行 zwiki check 验证引用一致性");
            }
        }
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}

/// Record a supersede relationship between two wiki pages.
fn cmd_supersede(wiki_root: &WikiRoot, old: &str, new: &str, reason: &str) {
    supersede::link_supersede_at(old, new, reason, wiki_root.path())
        .unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
    println!("已记录取代关系: {old} ← {new}");
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
    json: bool,
    json_empty: &str,
) -> bool {
    if let Some(df) = domain_filter
        && let Err(msg) = wiki::validate_domain(df, wiki_dir)
    {
        if json {
            eprintln!("{msg}");
            println!("{json_empty}");
        } else {
            println!("{msg}");
        }
        return true;
    }
    false
}

/// Handle `zwiki check` — unified dispatch for Dir and Temp roots.
///
/// - `Dir` root: per-bundle check + `sync_derived_metadata` (writable);
///   when no lock bundles exist, runs health/lint on the root directly.
/// - `Temp` root: manifest + structure + health/lint only (read-only).
fn dispatch_check(root: &WikiRoot, json_mode: bool) {
    match root {
        WikiRoot::Dir(dir) => {
            let lock = bundle::read_lock_at(dir).unwrap_or_else(|msg| {
                eprintln!("{msg}");
                process::exit(1);
            });
            if lock.bundles.is_empty() {
                // No bundles — check the root directory directly so that
                // `--root ./wiki` on a wiki without a lock still validates.
                let code = dispatch_check_root_dir(dir, json_mode);
                if code != 0 {
                    process::exit(code);
                }
            } else {
                let code = dispatch_check_no_arg_inner(dir, &lock, json_mode);
                if code != 0 {
                    process::exit(code);
                }
            }
        }
        WikiRoot::Temp(tmp) => {
            // Read bundle.toml directly (no double-copy via resolve_source).
            let manifest_path = tmp.path().join("bundle.toml");
            if !manifest_path.exists() {
                if json_mode {
                    let output = serde_json::json!({
                        "status": "error",
                        "error": "bundle.toml not found in wiki root",
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&output).unwrap()
                    );
                } else {
                    eprintln!("错误: 在 wiki 根中未找到 bundle.toml");
                }
                process::exit(1);
            }
            if let Err(e) = bundle::read_manifest(&manifest_path, json_mode) {
                if json_mode {
                    let output =
                        serde_json::json!({"status": "error", "error": e});
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&output).unwrap()
                    );
                } else {
                    eprintln!("{e}");
                }
                process::exit(1);
            }
            // Bundle structure check (index.md + logs/).
            if let Err(e) =
                bundle::check_bundle_structure(tmp.path(), json_mode)
            {
                if json_mode {
                    let output =
                        serde_json::json!({"status": "error", "error": e});
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&output).unwrap()
                    );
                } else {
                    eprintln!("{e}");
                }
                process::exit(1);
            }
            // Health + lint checks.
            let (health_results, lint_results, health_issues, lint_issues) =
                run_health_lint_at(tmp.path());
            let total = health_issues + lint_issues;
            if json_mode {
                print_json_check_output(
                    &health_results,
                    &lint_results,
                    health_issues,
                    lint_issues,
                );
            } else {
                println!(
                    "{}",
                    display::format_full_report(&health_results, &lint_results)
                );
            }
            // Read-only: skip derived metadata writes.
            eprintln!("只读模式：跳过派生元数据写入");
            if total > 0 {
                process::exit(1);
            }
        }
    }
}

/// Check a directory root directly (no lock file) — run health/lint +
/// `sync_derived_metadata`.  Returns exit code (0 = pass, 1 = issues found).
fn dispatch_check_root_dir(dir: &Path, json_mode: bool) -> i32 {
    let (health_results, lint_results, health_issues, lint_issues) =
        run_health_lint_at(dir);
    let total = health_issues + lint_issues;
    if json_mode {
        print_json_check_output(
            &health_results,
            &lint_results,
            health_issues,
            lint_issues,
        );
    } else {
        println!(
            "{}",
            display::format_full_report(&health_results, &lint_results)
        );
    }
    // Sync derived metadata (writable for Dir root).
    let paths = wiki::all_wiki_pages_at(dir);
    let all_pages: Vec<wiki::Page> =
        paths.iter().filter_map(|p| wiki::read_page_at(p, dir)).collect();
    sync_derived_metadata(dir, &all_pages, json_mode);
    i32::from(total > 0)
}

/// Sync backlinks and apply timeliness updates (`mark_stale` +
/// `invalidate_by_source`) across a set of pages under `root`.  When
/// `suppress_eprint` is true, informational eprintln messages are suppressed
/// (used in `json_mode` for the no-arg check path).
fn sync_derived_metadata(
    root: &Path,
    all_pages: &[wiki::Page],
    suppress_eprint: bool,
) {
    if all_pages.is_empty() {
        return;
    }

    // Sync backlinks.
    let bl_index = backlinks::build_reverse_index(root, all_pages);
    let updated = backlinks::update_backlinks(root, &bl_index, all_pages);
    if updated > 0 && !suppress_eprint {
        eprintln!("已同步 {updated} 个页面的反向链接");
    }

    // Apply timeliness updates (mark_stale + invalidate_by_source).
    let stale_updates = health::mark_stale(all_pages);
    let stale_count =
        stale_updates.iter().filter(|u| u.new_timeliness == "stale").count();
    let current_count =
        stale_updates.iter().filter(|u| u.new_timeliness == "current").count();
    for update in &stale_updates {
        if let Err(e) =
            property::set(&update.path, "timeliness", &update.new_timeliness)
        {
            eprintln!("写入失败 {}: {e}", update.rel);
        }
    }
    if !stale_updates.is_empty() && !suppress_eprint {
        eprintln!(
            "已标记 {} 个页面的 timeliness（stale: {}, current: {}）",
            stale_updates.len(),
            stale_count,
            current_count,
        );
    }

    // Invalidate derived pages whose sources have changed.
    let invalidated = health::invalidate_by_source(all_pages);
    for update in &invalidated {
        if let Err(e) = property::set(
            &update.path,
            "last_validated",
            &update.new_last_validated,
        ) {
            eprintln!("写入失败 {}: {e}", update.rel);
        }
    }
    if !invalidated.is_empty() && !suppress_eprint {
        eprintln!(
            "已重置 {} 个页面的 last_validated（来源页面已变更）",
            invalidated.len()
        );
    }
}

/// Inner implementation of `dispatch_check_no_arg` that returns an exit code
/// instead of calling `process::exit`.  Returns `0` for success, `1` for
/// failures (issues found or missing bundles).  Takes `wiki_root` and `lock`
/// as parameters so callers can pass test directories.
fn dispatch_check_no_arg_inner(
    wiki_root: &Path,
    lock: &ZwikiLock,
    json_mode: bool,
) -> i32 {
    // Root index check first — missing/corrupt index is fatal.
    if let Err(msg) = bundle::check_root_index(wiki_root, lock) {
        if json_mode {
            let output = serde_json::json!({"status": "error", "error": msg});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            println!("{msg}");
        }
        return 1;
    }
    if !json_mode {
        println!("root index.md 检查通过");
    }

    let mut total_issues: usize = 0;
    let mut missing_count: usize = 0;
    let mut bundle_results: Vec<serde_json::Value> = Vec::new();
    let mut had_missing = false;

    for entry in &lock.bundles {
        let bundle_dir = wiki_root.join(&entry.target);

        if !bundle_dir.exists() {
            had_missing = true;
            missing_count += 1;
            if json_mode {
                bundle_results.push(serde_json::json!({
                    "name": entry.name,
                    "status": "missing",
                }));
            } else {
                println!("✗ {} — 未安装（目标目录缺失）", entry.name);
            }
            continue;
        }

        let (health_issues, lint_issues) = check_single_bundle(
            &bundle_dir,
            json_mode,
            &mut bundle_results,
            entry,
        );
        total_issues += health_issues + lint_issues;
    }

    // Sync backlinks and apply timeliness updates across the entire
    // wiki root before printing the aggregate output.
    let paths = wiki::all_wiki_pages_at(wiki_root);
    let all_pages: Vec<wiki::Page> =
        paths.iter().filter_map(|p| wiki::read_page_at(p, wiki_root)).collect();
    sync_derived_metadata(wiki_root, &all_pages, json_mode);

    if json_mode {
        let status =
            if total_issues > 0 || had_missing { "error" } else { "ok" };
        let final_output = serde_json::json!({
            "status": status,
            "root_index": "ok",
            "bundles": bundle_results,
            "total_issues": total_issues,
            "missing": missing_count,
        });
        println!("{}", serde_json::to_string_pretty(&final_output).unwrap());
    } else if total_issues > 0 || had_missing {
        println!();
        println!("---");
        println!("**全局总计：{total_issues} 个问题**");
    }

    if total_issues > 0 || had_missing {
        return 1;
    }
    0
}

/// Run health + lint checks for a single bundle directory, accumulate JSON
/// results into `bundle_results` (when `json_mode`), and return the issue
/// counts for the caller to sum.
fn check_single_bundle(
    bundle_dir: &Path,
    json_mode: bool,
    bundle_results: &mut Vec<serde_json::Value>,
    entry: &bundle::ZwikiLockEntry,
) -> (usize, usize) {
    let health_results = health::run_all(bundle_dir);
    let lint_results = lint::run_all(bundle_dir);

    let health_issues = display::count_health_issues(&health_results);
    let lint_issues = display::count_lint_issues(&lint_results);

    if json_mode {
        let hl_json = format_health_lint_json(&health_results, &lint_results);
        bundle_results.push(serde_json::json!({
            "name": entry.name,
            "status": if health_issues + lint_issues == 0 { "ok" } else { "issues" },
            "issues": health_issues + lint_issues,
            "health": hl_json["health"],
            "lint": hl_json["lint"],
        }));
    } else {
        let total = health_issues + lint_issues;
        if total == 0 {
            println!("✓ {} — 健康", entry.name);
        } else {
            println!(
                "✗ {} — {} 个问题（health: {}, lint: {}）",
                entry.name, total, health_issues, lint_issues,
            );
        }
    }

    (health_issues, lint_issues)
}

/// Run health + lint checks against `root`, return structured results
/// and issue counts. Does NOT print, sync backlinks, write reports,
/// apply timeliness, or exit. Pure detection only.
pub(crate) fn run_health_lint_at(
    root: &Path,
) -> (display::CheckResults, display::LintResults, usize, usize) {
    let health_results = health::run_all(root);
    let lint_results = lint::run_all(root);
    let health_issues = display::count_health_issues(&health_results);
    let lint_issues = display::count_lint_issues(&lint_results);
    (health_results, lint_results, health_issues, lint_issues)
}

/// Build the JSON representation of health + lint results (without the
/// outer wrapper).  Used by both `check_single_bundle` and
/// `print_json_check_output`.
pub(crate) fn format_health_lint_json(
    health: &display::CheckResults,
    lint: &display::LintResults,
) -> serde_json::Value {
    let fmt_issues = |issues: &[display::Issue]| -> Vec<serde_json::Value> {
        issues
            .iter()
            .map(|i| {
                serde_json::json!({"page": i.page, "kind": i.kind, "details": i.details})
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
            "related_field": fmt_issues(&health.related_field),
            "related_body_consistency": fmt_issues(
                &health.related_body_consistency,
            ),
            "source_field": fmt_issues(&health.source_field),
            "missing_inline_links": fmt_issues(&health.missing_inline_links),
            "duplicate_inline_links": fmt_issues(&health.duplicate_inline_links),
        },
        "lint": {
            "broken_links": fmt_issues(&lint.broken_links),
            "orphan_pages": fmt_issues(&lint.orphan_pages),
            "sparse_pages": fmt_issues(&lint.sparse_pages),
            "stale_pages": fmt_issues(&lint.stale_pages),
            "cascade_stale": fmt_issues(&lint.cascade_stale),
        },
    })
}

fn print_json_check_output(
    health: &display::CheckResults,
    lint: &display::LintResults,
    health_issues: usize,
    lint_issues: usize,
) {
    let mut json_output = format_health_lint_json(health, lint);
    let total = health_issues + lint_issues;
    // `status` reflects whether the check passed — consumers rely on this
    // field (not just the exit code) to decide success/failure.
    json_output["status"] =
        serde_json::json!(if total == 0 { "ok" } else { "error" });
    json_output["total_issues"] = serde_json::json!(total);

    println!("{}", serde_json::to_string_pretty(&json_output).unwrap());
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
            guard_writable(wiki_root, "page set");
            let normalized = normalize_page_path(wiki_root.path(), &args.path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            cmd_page_set(
                wiki_root,
                &normalized,
                &args.prop,
                args.value.as_deref(),
                args.downgrade,
            );
        }
        PageCommand::Unset(args) => {
            guard_writable(wiki_root, "page unset");
            let normalized = normalize_page_path(wiki_root.path(), &args.path)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            cmd_page_unset(wiki_root, &normalized, &args.prop);
        }
        PageCommand::Create(args) => {
            guard_writable(wiki_root, "page create");
            cmd_create(
                wiki_root,
                &args.domain,
                &args.r#type,
                &args.title,
                args.slug.as_deref(),
                args.source_type.as_deref(),
            );
        }
        PageCommand::Move(args) => {
            guard_writable(wiki_root, "page move");
            // Normalize only the old path (new path doesn't exist yet).
            let old_norm = normalize_page_path(wiki_root.path(), &args.old)
                .unwrap_or_else(|e| {
                    eprintln!("{e}");
                    process::exit(1);
                });
            cmd_move(wiki_root, &old_norm, &args.new, json);
        }
    }
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
        let paths = wiki::all_wiki_pages_at(root);
        let pages: Vec<wiki::Page> =
            paths.iter().filter_map(|p| wiki::read_page_at(p, root)).collect();
        let filtered_index = backlinks::build_backlinks_for(path, root, &pages);

        if json {
            let total = pages.len();
            let with_bl = filtered_index.len();
            let mut map = serde_json::Map::new();
            for (tgt, srcs) in &filtered_index {
                let t = backlinks::page_title_from_rel(tgt, root);
                let s: Vec<_> = srcs
                    .iter()
                    .map(|s| {
                        let st = backlinks::page_title_from_rel(s, root);
                        serde_json::json!({"path": s, "title": st})
                    })
                    .collect();
                map.insert(
                    tgt.clone(),
                    serde_json::json!({"title": t, "sources": s}),
                );
            }
            let out = serde_json::json!({"total_pages": total, "pages_with_backlinks": with_bl, "backlinks": map});
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
        } else {
            // Compact single-page view — not the full-wiki report frame.
            let title = backlinks::page_title_from_rel(path, root);
            let sources: Vec<&String> = filtered_index
                .get(path)
                .map(|s| s.iter().collect())
                .unwrap_or_default();
            println!("## 反向链接 — {title}（{}）\n", sources.len());
            if sources.is_empty() {
                println!("无页面引用此页。");
            } else {
                for s in sources {
                    let st = backlinks::page_title_from_rel(s, root);
                    println!("- [{st}]({s})");
                }
            }
        }
        return;
    }

    let full = wiki_root.path().join(path);
    if let Some(prop) = property {
        match page::read_property(&full, prop) {
            Ok(Some(v)) => println!("{v}"),
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
            Ok(headings) => println!("{headings}"),
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    } else {
        match page::read_full(&full) {
            Ok(c) => print!("{c}"),
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    }
}

/// Set a frontmatter property on a page (or downgrade status).
fn cmd_page_set(
    wiki_root: &WikiRoot,
    path: &str,
    prop: &str,
    value: Option<&str>,
    downgrade: bool,
) {
    let full = wiki_root.path().join(path);
    if downgrade {
        if prop != "status" {
            eprintln!("--downgrade 仅适用于 status 属性");
            process::exit(1);
        }
        let current = property::get(&full, prop)
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                process::exit(1);
            })
            .unwrap_or_default();
        let new_val = property::downgrade_status(&current);
        property::set(&full, prop, new_val).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
        println!("{current} → {new_val}");
    } else if let Some(val) = value {
        property::set(&full, prop, val).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
    } else {
        eprintln!("需要设置值或 --downgrade");
        process::exit(1);
    }
}

/// Unset (delete) a frontmatter property from a page.
fn cmd_page_unset(wiki_root: &WikiRoot, path: &str, prop: &str) {
    let full = wiki_root.path().join(path);
    property::delete(&full, prop).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });
}

fn cmd_log(
    wiki_root: &WikiRoot,
    op: &str,
    path: &str,
    action: &str,
    note: Option<&str>,
) {
    log::add_entry_at(wiki_root.path(), op, path, action, note).unwrap_or_else(
        |e| {
            eprintln!("{e}");
            process::exit(1);
        },
    );
}

fn cmd_create(
    wiki_root: &WikiRoot,
    domain: &str,
    r#type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
) {
    match page::create_page_at(
        wiki_root.path(),
        domain,
        r#type,
        title,
        slug,
        source_type,
    ) {
        Ok(p) => println!("已创建页面: {}", p.display()),
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

    if check_domain_or_print(domain_filter, &wiki_dir, json, "[]") {
        return;
    }

    let results = engine.search(query, type_filter, tag_filter, domain_filter);

    if json {
        println!("{}", search::format_results_json(&results));
    } else {
        println!("{}", search::format_results(&results));
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

    if check_domain_or_print(domain_filter, &wiki_dir, json, "[]") {
        return;
    }

    let entries =
        list::list_pages(&wiki_dir, type_filter, tag_filter, domain_filter);

    if json {
        println!("{}", list::format_list_json(&entries));
    } else {
        println!("{}", list::format_list(&entries));
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

    if check_domain_or_print(domain_filter, &wiki_dir, json, "{}") {
        return;
    }

    let report = status::compute_status(
        &wiki_dir,
        type_filter,
        tag_filter,
        domain_filter,
    );

    if json {
        println!("{}", status::format_status_json(&report));
    } else {
        println!(
            "{}",
            status::format_status(
                &report,
                type_filter,
                tag_filter,
                domain_filter,
            ),
        );
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

    if check_domain_or_print(domain_filter, &wiki_dir, json, "[]") {
        return;
    }

    let counts = aggregate::aggregate_field(
        &wiki_dir,
        field,
        type_filter,
        tag_filter,
        domain_filter,
    );

    if json {
        println!("{}", aggregate::format_aggregate_json(&counts));
    } else {
        println!("{}", aggregate::format_aggregate_human(&counts, field));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_log_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "log",
            "--op",
            "ingest",
            "--path",
            "concepts/foo.md",
            "--action",
            "create",
        ])
        .unwrap();
        match args.command {
            Some(Command::Log { op, path, action, .. }) => {
                assert_eq!(op, "ingest");
                assert_eq!(path, "concepts/foo.md");
                assert_eq!(action, "create");
            }
            _ => panic!("expected Log"),
        }
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
            "timeliness",
            "stale",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Set(ref a))) => {
                assert_eq!(a.path, "concepts/npc.md");
                assert_eq!(a.prop, "timeliness");
                assert_eq!(a.value, Some("stale".to_string()));
                assert!(!a.downgrade);
            }
            _ => panic!("expected Page::Set"),
        }
    }

    #[test]
    fn test_page_set_downgrade_parses() {
        let args = ZwikiArgs::try_parse_from([
            "zwiki",
            "page",
            "set",
            "concepts/npc.md",
            "status",
            "--downgrade",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Set(ref a))) => {
                assert_eq!(a.path, "concepts/npc.md");
                assert_eq!(a.prop, "status");
                assert!(a.value.is_none());
                assert!(a.downgrade);
            }
            _ => panic!("expected Page::Set with downgrade"),
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
            "timeliness",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page(PageCommand::Unset(ref a))) => {
                assert_eq!(a.path, "concepts/npc.md");
                assert_eq!(a.prop, "timeliness");
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
            Some(Command::Supersede { old, new, reason }) => {
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
            "--kind",
            "team",
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
                assert_eq!(a.kind, "team");
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
    // dispatch_check_no_arg_inner
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test-main").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    /// Page content with full frontmatter + sufficient body text (>100 chars)
    /// to pass health and lint checks.
    const PAGE_OK: &str = "---
title: Proper Page
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
---

# Proper Page

This document has enough text to pass the health and lint checks that zwiki
runs during validation.  It contains well over one hundred characters to
satisfy the stub threshold check and other quality gates.\n";

    #[test]
    fn test_dispatch_check_root_dir_empty() {
        // Verify dispatch_check_root_dir succeeds on an empty directory.
        let dir = temp_dir("check_root_empty");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let code = dispatch_check_root_dir(&dir, false);
        assert_eq!(code, 0, "empty root dir should return 0");
    }

    #[test]
    fn test_dispatch_check_no_arg_inner_missing_exits() {
        let dir = temp_dir("check_inner_missing_ci");
        // Create index.md with markers referencing the missing bundle
        // so check_root_index passes and we test missing-dir detection.
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n[missing](bundles/missing)\n<!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();

        let lock = bundle::ZwikiLock {
            bundles: vec![bundle::ZwikiLockEntry {
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
        let code = dispatch_check_no_arg_inner(&dir, &lock, false);
        assert_eq!(code, 1, "missing bundle should return 1");
    }

    #[test]
    fn test_dispatch_check_no_arg_inner_valid() {
        let dir = temp_dir("check_inner_valid");
        // Create index.md with markers referencing the bundle and its page
        // so the page is indexed and not orphaned.
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n\
             [bundle](bundles/test)\n\
             [doc](bundles/test/doc.md)\n\
             <!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();

        // Create a bundle directory with a healthy page (not index.md, which
        // is excluded from page discovery).
        let bundle_dir = dir.join("bundles").join("test");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        // Add index.md referencing the bundle page so the index-sync check
        // passes and doc.md is not orphaned.
        std::fs::write(
            bundle_dir.join("index.md"),
            "---
title: Bundle Index
---

# Bundle

- [Doc](doc.md)
",
        )
        .unwrap();
        // Add a discoverable page with full frontmatter + body.
        std::fs::write(bundle_dir.join("doc.md"), PAGE_OK).unwrap();

        let lock = bundle::ZwikiLock {
            bundles: vec![bundle::ZwikiLockEntry {
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
        let code = dispatch_check_no_arg_inner(&dir, &lock, false);
        assert_eq!(code, 0, "valid bundle should return 0");
    }

    #[test]
    fn test_dispatch_check_no_arg_inner_default_timeliness_writes() {
        // Verify that `zwiki check` (no source) writes timeliness
        // updates to page frontmatter by default.  The page has
        // last_validated far enough in the past (>180d) that mark_stale
        // marks it stale, changing timeliness from "current" to "stale".
        let dir = temp_dir("check_inner_timeliness");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n\
             [bundle](bundles/test)\n\
             [doc](bundles/test/doc.md)\n\
             <!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();

        let bundle_dir = dir.join("bundles").join("test");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(
            bundle_dir.join("index.md"),
            "---\ntitle: Index\n---\n\n# Index\n\n- [Doc](doc.md)\n",
        )
        .unwrap();

        // Page with recent timestamp (within 90d lint threshold) but old
        // last_validated (> 180d) → mark_stale will flag it but lint won't.
        let page_content = "\
---
title: Timeliness Test
type: concept
timestamp: 2026-06-01T00:00:00Z
tags: []
status: draft
last_validated: 2025-01-01T00:00:00Z
timeliness: current
---

# Timeliness Test

This page has enough text to pass the health and lint checks that zwiki
runs during validation.  It contains well over one hundred characters to
satisfy the stub threshold check and other quality gates required for the
bundle validation process.\n";
        std::fs::write(bundle_dir.join("doc.md"), page_content).unwrap();

        let lock = bundle::ZwikiLock {
            bundles: vec![bundle::ZwikiLockEntry {
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

        let code = dispatch_check_no_arg_inner(&dir, &lock, false);
        assert_eq!(code, 0, "valid bundle with stale page should return 0");

        // Verify timeliness was updated in the file content.
        let content =
            std::fs::read_to_string(bundle_dir.join("doc.md")).unwrap();
        assert!(
            content.contains("timeliness: stale"),
            "doc.md should have timeliness: stale after check, got: {content:?}"
        );
    }

    #[test]
    fn test_dispatch_check_no_arg_inner_propagates_failure() {
        let dir = temp_dir("check_inner_fail");
        std::fs::write(
            dir.join("index.md"),
            "<!-- ZOO:BUNDLES:BEGIN -->\n[bundle](bundles/test)\n<!-- ZOO:BUNDLES:END -->\n",
        )
        .unwrap();

        let bundle_dir = dir.join("bundles").join("test");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        // index.md is excluded from page discovery, so add a non-index page
        // with no frontmatter — check_frontmatter reports missing_frontmatter.
        std::fs::write(bundle_dir.join("index.md"), "# Bundle\n").unwrap();
        std::fs::write(bundle_dir.join("page.md"), "# Page\n").unwrap();

        let lock = bundle::ZwikiLock {
            bundles: vec![bundle::ZwikiLockEntry {
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

        let code = dispatch_check_no_arg_inner(&dir, &lock, false);
        assert_eq!(
            code, 1,
            "check must propagate failure via return code instead of process::exit",
        );
    }

    #[test]
    fn test_sync_derived_metadata_writes_backlinks() {
        // Verify that sync_derived_metadata writes backlinks into pages.
        let dir = temp_dir("sync_bl");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();

        // Page A links to page B via relations + inline link.
        let page_a = format!(
            "---
title: Page A
type: concept
timestamp: 2026-07-01T00:00:00Z
tags: []
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
relations: [page_b.md]
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
status: draft
last_validated: 2026-07-01T00:00:00Z
timeliness: current
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

        let paths = wiki::all_wiki_pages_at(&dir);
        let all_pages: Vec<wiki::Page> =
            paths.iter().filter_map(|p| wiki::read_page_at(p, &dir)).collect();
        sync_derived_metadata(&dir, &all_pages, false);

        // Verify backlinks were synced to page_b.md.
        let content_b = std::fs::read_to_string(dir.join("page_b.md")).unwrap();
        assert!(
            content_b.contains("## Backlinks"),
            "page_b.md should have Backlinks after check"
        );
        assert!(
            content_b.contains("Page A"),
            "page_b.md Backlinks should reference Page A"
        );

        // Verify page_a.md was NOT modified.
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
}
