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
use clap::{Parser, Subcommand};
use std::path::Path;
use std::process;

#[derive(Parser)]
#[command(
    name = "zwiki",
    about = "ZooKeeper wiki — manage ~/.zoo/wiki/ knowledge from the command line.",
    disable_help_subcommand = true
)]
struct Args {
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

#[derive(Subcommand)]
enum Command {
    /// Run all health and lint checks
    Check {
        /// Optional bundle source (path/.tar.gz/URL) to validate instead of
        /// running health/lint checks
        source: Option<String>,
    },

    /// Show backlinks
    Backlinks {
        /// Specific page to show backlinks for
        page: Option<String>,
    },

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

    /// Read a wiki page
    Page {
        /// Wiki-relative page path
        path: String,

        /// Print only a specific frontmatter property
        #[arg(long)]
        property: Option<String>,

        /// Print heading tree (## headings only)
        #[arg(long)]
        outline: bool,
    },

    /// Read, set, downgrade, or delete a frontmatter property
    Property {
        /// Property name (e.g. timeliness, status, tags)
        name: String,

        /// Target page path
        #[arg(long)]
        page: String,

        /// Value to set
        #[arg(long)]
        value: Option<String>,

        /// Downgrade the property value (status: stable→review→draft)
        #[arg(long)]
        downgrade: bool,

        /// Delete the property
        #[arg(long)]
        delete: bool,
    },

    /// Create a new wiki page from template
    Create {
        /// Domain: an existing wiki subdirectory (required)
        #[arg(long)]
        domain: String,

        /// Page type: concept, entity, source, analysis, synthesis
        #[arg(long)]
        r#type: String,

        /// Page title
        #[arg(long)]
        title: String,

        /// Custom filename slug (required for non-Latin titles)
        #[arg(long)]
        slug: Option<String>,

        /// Source sub-type: adr, rfc, notes (required when --type=source)
        #[arg(long)]
        source_type: Option<String>,
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

    /// Move / rename a wiki page, updating all references and index entries
    #[command(name = "move")]
    Move {
        /// Current wiki-relative page path
        old: String,

        /// New wiki-relative page path
        new: String,
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
    let args = Args::parse();
    dispatch(args);
}

fn dispatch(args: Args) {
    match args.command {
        None => {
            use clap::CommandFactory;
            let mut cmd = Args::command();
            let _ = cmd.print_help();
            println!();
            process::exit(1);
        }
        Some(Command::Check { source }) => {
            if !dispatch_check_source(source.as_deref(), args.json) {
                // No source — iterate all installed bundles from zwiki.lock.
                dispatch_check_no_arg(args.json);
            }
        }
        Some(Command::Backlinks { ref page }) => {
            cmd_backlinks(&args, page.as_deref());
        }
        Some(Command::Log { op, path, action, note }) => {
            cmd_log(&op, &path, &action, note.as_deref());
        }
        Some(Command::Page { path, property, outline }) => {
            cmd_page(&path, property.as_deref(), outline);
        }
        Some(Command::Property { name, page, value, downgrade, delete }) => {
            cmd_property(&name, &page, value.as_deref(), downgrade, delete);
        }
        Some(Command::Create { domain, r#type, title, slug, source_type }) => {
            cmd_create(
                &domain,
                &r#type,
                &title,
                slug.as_deref(),
                source_type.as_deref(),
            );
        }
        Some(Command::Search { query, r#type, tag, domain }) => {
            cmd_search(
                &query,
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::List { r#type, tag, domain }) => {
            cmd_list(
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::Status { r#type, tag, domain }) => {
            cmd_status(
                r#type.as_deref(),
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        ref cmd => dispatch_tail(&args, cmd.as_ref().unwrap()),
    }
}

/// Dispatch the remaining subcommands (Verify through Contradictions)
/// to keep the main `dispatch` function under the line limit.
fn dispatch_tail(args: &Args, cmd: &Command) {
    match cmd {
        Command::Verify { domain } => {
            let wiki_dir = wiki::wiki_dir();
            if check_domain_or_print(
                domain.as_deref(),
                &wiki_dir,
                args.json,
                "[]",
            ) {
                return;
            }
            verify::cmd_verify(args.json, domain.as_deref());
        }
        Command::Tags { r#type, domain } => {
            cmd_aggregate(
                aggregate::AggregateField::Tags,
                r#type.as_deref(),
                None,
                domain.as_deref(),
                args.json,
            );
        }
        Command::Types { tag, domain } => {
            cmd_aggregate(
                aggregate::AggregateField::Types,
                None,
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Command::Domains { r#type, tag } => {
            cmd_aggregate(
                aggregate::AggregateField::Domains,
                r#type.as_deref(),
                tag.as_deref(),
                None,
                args.json,
            );
        }
        Command::Move { old, new } => cmd_move(old, new, args.json),
        Command::Supersede { old, new, reason } => {
            cmd_supersede(old, new, reason);
        }
        Command::Bundle(cmd) => {
            bundle::dispatch(cmd, args.json);
        }
        Command::Contradictions(cmd) => {
            contradictions::dispatch(cmd, args.json);
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
fn cmd_move(old: &str, new: &str, json: bool) {
    let wiki_root = wiki::wiki_dir();
    match r#move::execute_move(&wiki_root, old, new) {
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
fn cmd_supersede(old: &str, new: &str, reason: &str) {
    supersede::link_supersede(old, new, reason).unwrap_or_else(|e| {
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

/// Handle the bundle-source path of `zwiki check <source>`.
///
/// Returns `true` when `source` was present and handled (either validated +
/// checked, or exited with a fatal error).  Returns `false` when `source`
/// is `None`, signalling the caller to run the regular health/lint path.
fn dispatch_check_source(source: Option<&str>, json: bool) -> bool {
    let Some(src) = source else { return false };
    let code = dispatch_check_source_inner(src, json);
    if code != 0 {
        process::exit(code);
    }
    true
}

/// Inner implementation of `dispatch_check_source` that returns an exit code
/// instead of calling `process::exit`.  Returns `0` on success, `1` on error.
fn dispatch_check_source_inner(source: &str, json: bool) -> i32 {
    match bundle::load_and_validate_manifest(source, json) {
        Ok((resolved, _manifest)) => {
            if bundle::check_bundle_structure(resolved.path(), json).is_err() {
                // Explicitly drop the TempDir before returning —
                // the caller would process::exit, which skips destructors.
                drop(resolved);
                return 1;
            }
            let (health_results, lint_results, health_issues, lint_issues) =
                run_health_lint_at(resolved.path());
            let total = health_issues + lint_issues;
            if json {
                print_json_check_output(
                    &health_results,
                    &lint_results,
                    health_issues,
                    lint_issues,
                );
            } else {
                println!(
                    "{}",
                    display::format_full_report(&health_results, &lint_results,)
                );
            }

            // Drop the TempDir — from here on we only access the original
            // source (which may be a local directory for backlinks sync).
            drop(resolved);

            // Sync backlinks and timeliness if source is a local
            // directory (can write back).  For tar.gz or URL sources,
            // this is skipped because the source is not writable.
            let source_path = Path::new(source);
            if source_path.is_dir() {
                let paths = wiki::all_wiki_pages_at(source_path);
                let all_pages: Vec<wiki::Page> = paths
                    .iter()
                    .filter_map(|p| wiki::read_page_at(p, source_path))
                    .collect();
                sync_derived_metadata(source_path, &all_pages, json);
            }

            if total > 0 {
                return 1;
            }
        }
        Err(_) => return 1,
    }
    0
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

/// Handle the no-arg path of `zwiki check`.
///
/// Reads the wiki root and `zwiki.lock`, then delegates to
/// [`dispatch_check_no_arg_inner`] for root-index check, missing-bundle
/// detection, and per-bundle health/lint checks.  Exits
/// with the returned code.
fn dispatch_check_no_arg(json_mode: bool) {
    let wiki_root = wiki::wiki_dir();
    let lock = bundle::read_lock_at(&wiki_root).unwrap_or_else(|msg| {
        eprintln!("{msg}");
        process::exit(1);
    });
    let code = dispatch_check_no_arg_inner(&wiki_root, &lock, json_mode);
    if code != 0 {
        process::exit(code);
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
    if lock.bundles.is_empty() {
        if json_mode {
            let output = serde_json::json!({
                "status": "ok",
                "root_index": "ok",
                "bundles": [],
                "total_issues": 0,
                "missing": 0,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            println!("没有已安装的 bundle");
        }
        return 0;
    }

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

fn cmd_backlinks(args: &Args, page: Option<&str>) {
    let root = wiki::wiki_dir();
    let paths = wiki::all_wiki_pages_at(&root);
    let pages: Vec<wiki::Page> =
        paths.iter().filter_map(|p| wiki::read_page_at(p, &root)).collect();
    let index = backlinks::build_reverse_index(&root, &pages);

    // Filter to a single page if specified
    let filtered_index: std::collections::HashMap<String, Vec<String>> =
        if let Some(p) = page {
            let target = if std::path::Path::new(p)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                p.to_string()
            } else {
                format!("{p}.md")
            };
            let mut map = std::collections::HashMap::new();
            if let Some(sources) = index.get(&target) {
                map.insert(target, sources.clone());
            }
            map
        } else {
            index
        };

    if args.json {
        let total = pages.len();
        let with_bl = filtered_index.len();
        let mut map = serde_json::Map::new();
        for (tgt, srcs) in &filtered_index {
            let t = backlinks::page_title_from_rel(tgt);
            let s: Vec<_> = srcs
                .iter()
                .map(|s| {
                    let st = backlinks::page_title_from_rel(s);
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
        println!("{}", backlinks::format_report(&filtered_index));
    }
}

fn cmd_log(op: &str, path: &str, action: &str, note: Option<&str>) {
    log::add_entry(op, path, action, note).unwrap_or_else(|e| {
        eprintln!("{e}");
        process::exit(1);
    });
}

fn cmd_page(path: &str, property: Option<&str>, outline: bool) {
    let full = wiki::wiki_dir().join(path);
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

fn cmd_property(
    name: &str,
    page_path: &str,
    value: Option<&str>,
    downgrade: bool,
    delete: bool,
) {
    let full = wiki::wiki_dir().join(page_path);
    if delete {
        property::delete(&full, name).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
    } else if downgrade {
        if name != "status" {
            eprintln!("--downgrade 仅适用于 status 属性");
            process::exit(1);
        }
        let current = property::get(&full, name)
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                process::exit(1);
            })
            .unwrap_or_default();
        let new_val = property::downgrade_status(&current);
        property::set(&full, name, new_val).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
        println!("{current} → {new_val}");
    } else if let Some(val) = value {
        property::set(&full, name, val).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
    } else {
        match property::get(&full, name) {
            Ok(Some(v)) => println!("{v}"),
            Ok(None) => {
                eprintln!("属性未找到: {name}");
                process::exit(1);
            }
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
    }
}

fn cmd_create(
    domain: &str,
    r#type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
) {
    match page::create_page(domain, r#type, title, slug, source_type) {
        Ok(p) => println!("已创建页面: {}", p.display()),
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}

fn cmd_search(
    query: &str,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki::wiki_dir();
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
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki::wiki_dir();

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
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki::wiki_dir();

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
    field: aggregate::AggregateField,
    type_filter: Option<&str>,
    tag_filter: Option<&str>,
    domain_filter: Option<&str>,
    json: bool,
) {
    let wiki_dir = wiki::wiki_dir();

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
        let result = Args::try_parse_from(["zwiki", "--help"]);
        // --help short-circuits with an error that clap handles
        assert!(result.is_err());
    }

    #[test]
    fn test_no_subcommand_shows_help() {
        let result = Args::try_parse_from(["zwiki"]);
        assert!(result.is_ok());
        let args = result.unwrap();
        assert!(args.command.is_none());
    }

    #[test]
    fn test_check_parses() {
        let args = Args::try_parse_from(["zwiki", "check"]).unwrap();
        assert!(matches!(args.command, Some(Command::Check { .. })));
    }

    #[test]
    fn test_check_with_source_parses() {
        let args = Args::try_parse_from(["zwiki", "check", "foo"]).unwrap();
        match args.command {
            Some(Command::Check { source, .. }) => {
                assert_eq!(source, Some("foo".to_string()));
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_source_optional_parses() {
        let args = Args::try_parse_from(["zwiki", "check"]).unwrap();
        match args.command {
            Some(Command::Check { source, .. }) => {
                assert_eq!(source, None);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_backlinks_parses() {
        let args = Args::try_parse_from(["zwiki", "backlinks"]).unwrap();
        assert!(matches!(args.command, Some(Command::Backlinks { .. })));
    }

    #[test]
    fn test_backlinks_with_page_parses() {
        let args =
            Args::try_parse_from(["zwiki", "backlinks", "concepts/npc.md"])
                .unwrap();
        match args.command {
            Some(Command::Backlinks { page, .. }) => {
                assert_eq!(page, Some("concepts/npc.md".to_string()));
            }
            _ => panic!("expected Backlinks"),
        }
    }

    #[test]
    fn test_log_parses() {
        let args = Args::try_parse_from([
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

    #[test]
    fn test_page_parses() {
        let args =
            Args::try_parse_from(["zwiki", "page", "concepts/npc.md"]).unwrap();
        match args.command {
            Some(Command::Page { path, .. }) => {
                assert_eq!(path, "concepts/npc.md");
            }
            _ => panic!("expected Page"),
        }
    }

    #[test]
    fn test_page_with_property_parses() {
        let args = Args::try_parse_from([
            "zwiki",
            "page",
            "concepts/npc.md",
            "--property",
            "status",
        ])
        .unwrap();
        match args.command {
            Some(Command::Page { property, .. }) => {
                assert_eq!(property, Some("status".to_string()));
            }
            _ => panic!("expected Page"),
        }
    }

    #[test]
    fn test_property_set_parses() {
        let args = Args::try_parse_from([
            "zwiki",
            "property",
            "timeliness",
            "--page",
            "concepts/npc.md",
            "--value",
            "stale",
        ])
        .unwrap();
        match args.command {
            Some(Command::Property { name, page, value, delete, .. }) => {
                assert_eq!(name, "timeliness");
                assert_eq!(page, "concepts/npc.md");
                assert_eq!(value, Some("stale".to_string()));
                assert!(!delete);
            }
            _ => panic!("expected Property"),
        }
    }

    #[test]
    fn test_property_delete_parses() {
        let args = Args::try_parse_from([
            "zwiki",
            "property",
            "timeliness",
            "--page",
            "concepts/npc.md",
            "--delete",
        ])
        .unwrap();
        match args.command {
            Some(Command::Property { delete, .. }) => {
                assert!(delete);
            }
            _ => panic!("expected Property"),
        }
    }

    #[test]
    fn test_property_downgrade_parses() {
        let args = Args::try_parse_from([
            "zwiki",
            "property",
            "status",
            "--page",
            "concepts/npc.md",
            "--downgrade",
        ])
        .unwrap();
        match args.command {
            Some(Command::Property { name, page, downgrade, .. }) => {
                assert_eq!(name, "status");
                assert_eq!(page, "concepts/npc.md");
                assert!(downgrade);
            }
            _ => panic!("expected Property"),
        }
    }

    #[test]
    fn test_create_parses() {
        let args = Args::try_parse_from([
            "zwiki",
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
            Some(Command::Create { domain, r#type, title, .. }) => {
                assert_eq!(domain, "autoresearch");
                assert_eq!(r#type, "concept");
                assert_eq!(title, "Test Page");
            }
            _ => panic!("expected Create"),
        }
    }

    #[test]
    fn test_create_with_slug_parses() {
        let args = Args::try_parse_from([
            "zwiki",
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
            Some(Command::Create {
                domain,
                r#type,
                title,
                slug,
                source_type,
            }) => {
                assert_eq!(domain, "wiki-system");
                assert_eq!(r#type, "source");
                assert_eq!(title, "ADR-001");
                assert_eq!(slug, Some("adr-001".to_string()));
                assert_eq!(source_type, Some("adr".to_string()));
            }
            _ => panic!("expected Create"),
        }
    }

    #[test]
    fn test_global_json_flag() {
        let args = Args::try_parse_from(["zwiki", "--json", "check"]).unwrap();
        assert!(args.json);
    }

    #[test]
    fn test_search_parses() {
        let args =
            Args::try_parse_from(["zwiki", "search", "permission"]).unwrap();
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from([
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
        let args =
            Args::try_parse_from(["zwiki", "--json", "search", "permission"])
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
        let args = Args::try_parse_from(["zwiki", "list"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "list", "--type", "concept"])
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
            Args::try_parse_from(["zwiki", "list", "--tag", "auth"]).unwrap();
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
            Args::try_parse_from(["zwiki", "list", "--domain", "shared"])
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from(["zwiki", "--json", "list"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "status"]).unwrap();
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
            Args::try_parse_from(["zwiki", "status", "--type", "concept"])
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
            Args::try_parse_from(["zwiki", "status", "--tag", "auth"]).unwrap();
        match args.command {
            Some(Command::Status { tag, .. }) => {
                assert_eq!(tag, Some("auth".to_string()));
            }
            _ => panic!("expected Status"),
        }
    }

    #[test]
    fn test_status_with_domain_parses() {
        let args =
            Args::try_parse_from(["zwiki", "status", "--domain", "shared"])
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from(["zwiki", "--json", "status"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "tags"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "tags", "--type", "concept"])
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
            Args::try_parse_from(["zwiki", "tags", "--domain", "shared"])
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from(["zwiki", "--json", "tags"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "types"]).unwrap();
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
            Args::try_parse_from(["zwiki", "types", "--tag", "auth"]).unwrap();
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
            Args::try_parse_from(["zwiki", "types", "--domain", "shared"])
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from(["zwiki", "--json", "types"]).unwrap();
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
        let args = Args::try_parse_from(["zwiki", "domains"]).unwrap();
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
        let args =
            Args::try_parse_from(["zwiki", "domains", "--type", "concept"])
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
        let args = Args::try_parse_from(["zwiki", "domains", "--tag", "auth"])
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
        let args = Args::try_parse_from([
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
            Args::try_parse_from(["zwiki", "--json", "domains"]).unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Domains { .. }) => {}
            _ => panic!("expected Domains"),
        }
    }

    // -------------------------------------------------------------------
    // Move subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_move_parses() {
        let args = Args::try_parse_from(["zwiki", "move", "old.md", "new.md"])
            .unwrap();
        match args.command {
            Some(Command::Move { old, new }) => {
                assert_eq!(old, "old.md");
                assert_eq!(new, "new.md");
            }
            _ => panic!("expected Move"),
        }
    }

    // -------------------------------------------------------------------
    // Supersede subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_supersede_parses() {
        let args = Args::try_parse_from([
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
        let result = Args::try_parse_from([
            "zwiki",
            "supersede",
            "--old",
            "o.md",
            "--new",
            "n.md",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_move_with_json_flag_parses() {
        let args = Args::try_parse_from([
            "zwiki",
            "--json",
            "move",
            "concepts/foo.md",
            "concepts/bar.md",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Move { old, new }) => {
                assert_eq!(old, "concepts/foo.md");
                assert_eq!(new, "concepts/bar.md");
            }
            _ => panic!("expected Move"),
        }
    }

    // -------------------------------------------------------------------
    // Verify subcommand
    // -------------------------------------------------------------------

    #[test]
    fn test_verify_parses() {
        let args = Args::try_parse_from(["zwiki", "verify"]).unwrap();
        match args.command {
            Some(Command::Verify { domain }) => {
                assert!(domain.is_none());
            }
            _ => panic!("expected Verify"),
        }
    }

    #[test]
    fn test_verify_with_json_parses() {
        let args = Args::try_parse_from(["zwiki", "--json", "verify"]).unwrap();
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from(["zwiki", "bundle", "init"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Init(..))) => {}
            _ => panic!("expected Bundle::Init"),
        }
    }

    #[test]
    fn test_bundle_init_with_name_parses() {
        let args = Args::try_parse_from([
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
        let args = Args::try_parse_from([
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
        let args =
            Args::try_parse_from(["zwiki", "bundle", "export", "/some/dir"])
                .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Export(_))) => {}
            _ => panic!("expected Bundle::Export"),
        }
    }

    #[test]
    fn test_bundle_install_parses() {
        let args =
            Args::try_parse_from(["zwiki", "bundle", "install", "source"])
                .unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Install(_))) => {}
            _ => panic!("expected Bundle::Install"),
        }
    }

    #[test]
    fn test_bundle_list_parses() {
        let args = Args::try_parse_from(["zwiki", "bundle", "list"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::List(..))) => {}
            _ => panic!("expected Bundle::List"),
        }
    }

    #[test]
    fn test_bundle_list_with_json_parses() {
        let args = Args::try_parse_from(["zwiki", "--json", "bundle", "list"])
            .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::List(..))) => {}
            _ => panic!("expected Bundle::List with json"),
        }
    }

    #[test]
    fn test_bundle_check_parses() {
        let args = Args::try_parse_from(["zwiki", "bundle", "check"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Check(..))) => {}
            _ => panic!("expected Bundle::Check"),
        }
    }

    #[test]
    fn test_bundle_check_with_json_parses() {
        let args = Args::try_parse_from(["zwiki", "--json", "bundle", "check"])
            .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Check(..))) => {}
            _ => panic!("expected Bundle::Check with json"),
        }
    }

    #[test]
    fn test_bundle_update_parses() {
        let args = Args::try_parse_from(["zwiki", "bundle", "update"]).unwrap();
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Update(..))) => {}
            _ => panic!("expected Bundle::Update"),
        }
    }

    #[test]
    fn test_bundle_update_with_name_parses() {
        let args = Args::try_parse_from([
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
            Args::try_parse_from(["zwiki", "--json", "bundle", "update"])
                .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Bundle(bundle::BundleCommand::Update(..))) => {}
            _ => panic!("expected Bundle::Update with json"),
        }
    }

    #[test]
    fn test_bundle_uninstall_parses() {
        let args =
            Args::try_parse_from(["zwiki", "bundle", "uninstall", "my-bundle"])
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
        let args = Args::try_parse_from([
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
    // dispatch_check_source_inner
    // -------------------------------------------------------------------

    #[test]
    fn test_dispatch_check_source_inner_ok() {
        let dir = temp_dir("src_inner_ok");
        let bundle_toml = r#"
[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(
            dir.join("index.md"),
            "---
title: Index
---
# Index\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        // Add a file inside logs/ so copy_recursive creates the directory
        std::fs::write(dir.join("logs").join(".gitkeep"), "").unwrap();

        let code = dispatch_check_source_inner(&dir.to_string_lossy(), false);
        assert_eq!(code, 0, "valid bundle should return 0");
    }

    #[test]
    fn test_dispatch_check_source_inner_structure_fail() {
        let dir = temp_dir("src_inner_struct_fail");
        let bundle_toml = r#"
[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();
        // No index.md → check_bundle_structure fails
        std::fs::create_dir_all(dir.join("logs")).unwrap();

        let code = dispatch_check_source_inner(&dir.to_string_lossy(), false);
        assert_eq!(code, 1, "missing index.md should return 1");
    }

    #[test]
    fn test_dispatch_check_source_inner_manifest_error() {
        let dir = temp_dir("src_inner_manifest_err");
        // Empty name triggers fatal validation error
        let bundle_toml = r#"
[package]
name = ""
version = "0.1.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();

        let code = dispatch_check_source_inner(&dir.to_string_lossy(), false);
        assert_eq!(code, 1, "invalid manifest should return 1");
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
    fn test_dispatch_check_no_arg_inner_empty_lock() {
        let dir = temp_dir("check_inner_empty");
        let lock = bundle::ZwikiLock::default();
        let code = dispatch_check_no_arg_inner(&dir, &lock, false);
        assert_eq!(code, 0, "empty lock should return 0");
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

    // -------------------------------------------------------------------
    // dispatch_check_source_inner — backlinks + timeliness for dir sources
    // -------------------------------------------------------------------

    #[test]
    fn test_dispatch_check_source_inner_syncs_backlinks() {
        // Verify that `zwiki check <dir>` with a local directory source
        // syncs backlinks into the actual source directory (not the temp copy).
        let dir = temp_dir("src_inner_backlinks");
        let bundle_toml = r#"
[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(
            dir.join("index.md"),
            "---
title: Index
---
# Index

- [Page A](page_a.md)
- [Page B](page_b.md)
",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs").join(".gitkeep"), "").unwrap();

        // Page A links to page B via relations + inline link — after check,
        // page B should get a Backlinks section with reference to Page A.
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

{}",
            // 200+ chars of body text to pass health & lint checks
            "This document has enough text to pass the health and lint checks that \
             zwiki runs during validation. It contains well over one hundred characters \
             to satisfy the stub threshold check and other quality gates required for \
             the bundle validation process.\n"
        );
        std::fs::write(dir.join("page_a.md"), &page_a).unwrap();

        // Page B needs a ## Details or ## References section so that
        // backlinks::find_insertion_point has an anchor for the new section.
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
            body = "This document has enough text to pass the health and lint checks that \
             zwiki runs during validation. It contains well over one hundred characters \
             to satisfy the stub threshold check and other quality gates required for \
             the bundle validation process."
        );
        std::fs::write(dir.join("page_b.md"), &page_b).unwrap();

        let code = dispatch_check_source_inner(&dir.to_string_lossy(), false);
        assert_eq!(code, 0, "valid bundle with backlinks should return 0");

        // Verify backlinks were synced to the actual directory — page_b.md
        // should now have a Backlinks section referencing Page A.
        let content_b = std::fs::read_to_string(dir.join("page_b.md")).unwrap();
        assert!(
            content_b.contains("## Backlinks"),
            "page_b.md should have a Backlinks section after check, got: {content_b:?}"
        );
        assert!(
            content_b.contains("Page A"),
            "page_b.md Backlinks should reference Page A, got: {content_b:?}"
        );
        assert!(
            content_b.contains("(page_a.md)"),
            "page_b.md Backlinks should link to page_a.md, got: {content_b:?}"
        );

        // Verify page_a.md was NOT modified (no pages link to it)
        let content_a = std::fs::read_to_string(dir.join("page_a.md")).unwrap();
        assert!(
            !content_a.contains("## Backlinks"),
            "page_a.md should NOT have a Backlinks section (no inbound links)"
        );
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
    fn test_dispatch_check_source_inner_default_timeliness_writes() {
        // Verify that `zwiki check <dir>` with a local directory source
        // writes timeliness updates to page frontmatter.
        let dir = temp_dir("src_inner_timeliness");
        let bundle_toml = r#"
[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(
            dir.join("index.md"),
            "---
title: Index
---
# Index

- [Doc](doc.md)
",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs").join(".gitkeep"), "").unwrap();

        // Page with recent timestamp (within 90d lint threshold) but old
        // last_validated (> 180d) → mark_stale will flag it but lint won't.
        let page_content = "\
---
title: Timeliness Src
type: concept
timestamp: 2026-06-01T00:00:00Z
tags: []
status: draft
last_validated: 2025-01-01T00:00:00Z
timeliness: current
---

# Timeliness Src

This page has enough text to pass the health and lint checks that zwiki
runs during validation.  It contains well over one hundred characters to
satisfy the stub threshold check and other quality gates required for the
bundle validation process.\n";
        std::fs::write(dir.join("doc.md"), page_content).unwrap();

        let code = dispatch_check_source_inner(&dir.to_string_lossy(), false);
        assert_eq!(code, 0, "valid source dir should return 0");

        // Verify timeliness was updated in the file content.
        let content = std::fs::read_to_string(dir.join("doc.md")).unwrap();
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
}
