#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

mod aggregate;
mod backlinks;
mod diff;
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
mod wiki;

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
enum Command {
    /// Run all health and lint checks
    Check {
        /// Save report to wiki/health-report.md
        #[arg(long)]
        save: bool,

        /// Exit 1 if any issues found (CI mode)
        #[arg(long)]
        ci: bool,

        /// Run incremental diff link check
        #[arg(long)]
        diff: bool,

        /// Check staged changes (requires --diff)
        #[arg(long)]
        cached: bool,

        /// Git ref to diff against (requires --diff)
        #[arg(long)]
        commit: Option<String>,

        /// Apply timeliness updates (stale/current) based on staleness rules
        #[arg(long)]
        apply: bool,
    },

    /// Show backlinks
    Backlinks {
        /// Specific page to show backlinks for
        page: Option<String>,
    },

    /// Append a log entry to wiki/log.md
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

    /// Read, set, or delete a frontmatter property
    Property {
        /// Property name (e.g. timeliness, status, tags)
        name: String,

        /// Target page path
        #[arg(long)]
        page: String,

        /// Value to set
        #[arg(long)]
        value: Option<String>,

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
}

fn main() {
    let args = Args::parse();
    dispatch(args);
}

/// Build the write-action list for `check` from its boolean flags.
fn check_write_actions(save: bool, apply: bool) -> Vec<WriteAction> {
    let mut actions = Vec::new();
    if save {
        actions.push(WriteAction::SaveReport);
    }
    if apply {
        actions.push(WriteAction::ApplyTimeliness);
    }
    actions
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
        Some(Command::Check { save, ci, diff, cached, commit, apply }) => {
            let diff_check =
                if diff { Some(DiffCheck { cached, commit }) } else { None };
            cmd_check(&CheckOpts {
                ci,
                json: args.json,
                diff_check,
                write_actions: check_write_actions(save, apply),
            });
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
        Some(Command::Property { name, page, value, delete }) => {
            cmd_property(&name, &page, value.as_deref(), delete);
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
        Some(Command::Tags { r#type, domain }) => {
            cmd_aggregate(
                aggregate::AggregateField::Tags,
                r#type.as_deref(),
                None,
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::Types { tag, domain }) => {
            cmd_aggregate(
                aggregate::AggregateField::Types,
                None,
                tag.as_deref(),
                domain.as_deref(),
                args.json,
            );
        }
        Some(Command::Domains { r#type, tag }) => {
            cmd_aggregate(
                aggregate::AggregateField::Domains,
                r#type.as_deref(),
                tag.as_deref(),
                None,
                args.json,
            );
        }
        Some(Command::Move { old, new }) => {
            cmd_move(&old, &new, args.json);
        }
        Some(Command::Supersede { old, new, reason }) => {
            cmd_supersede(&old, &new, &reason);
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

#[derive(Clone, PartialEq, Debug)]
enum WriteAction {
    SaveReport,
    ApplyTimeliness,
}

struct CheckOpts {
    ci: bool,
    json: bool,
    diff_check: Option<DiffCheck>,
    write_actions: Vec<WriteAction>,
}

struct DiffCheck {
    cached: bool,
    commit: Option<String>,
}

fn cmd_check(opts: &CheckOpts) {
    eprintln!("注意：check 命令会同步所有页面的反向链接章节");

    let health_results = health::run_all();
    let lint_results = lint::run_all();

    let health_issues = count_health_issues(&health_results);
    let lint_issues = count_lint_issues(&lint_results);

    let mut diff_issues = 0;
    let mut diff_results: Vec<display::Issue> = Vec::new();
    if let Some(df) = &opts.diff_check {
        match diff::run_diff(df.cached, df.commit.as_deref()) {
            Ok(issues) => {
                diff_results = issues;
                diff_issues = diff_results.len();
            }
            Err(e) => eprintln!("diff check failed: {e}"),
        }
    }

    if opts.json {
        print_json_check_output(
            &health_results,
            &lint_results,
            &diff_results,
            health_issues,
            lint_issues,
            diff_issues,
        );
    } else {
        print_markdown_check_output(
            &health_results,
            &lint_results,
            &diff_results,
            opts,
        );
    }

    if opts.write_actions.contains(&WriteAction::SaveReport) {
        let root = wiki::wiki_dir();
        let health_report = display::format_check_report(&health_results);
        let lint_report = display::format_lint_report(&lint_results);
        let _ = std::fs::write(root.join("health-report.md"), &health_report);
        let _ = std::fs::write(root.join("lint-report.md"), &lint_report);
        eprintln!("已保存：{}", root.display());
    }

    // Sync backlinks automatically — check ensures cross-references are
    // always up-to-date.
    let root = wiki::wiki_dir();
    let paths = wiki::all_wiki_pages();
    let all_pages: Vec<wiki::Page> =
        paths.iter().filter_map(|p| wiki::read_page(p)).collect();
    let bl_index = backlinks::build_reverse_index(&root, &all_pages);
    let updated = backlinks::update_backlinks(&root, &bl_index, &all_pages);
    if updated > 0 {
        eprintln!("已同步 {updated} 个页面的反向链接");
    }

    // Apply timeliness updates if --apply is set.
    if opts.write_actions.contains(&WriteAction::ApplyTimeliness) {
        let stale_updates = health::mark_stale(&all_pages);
        let stale_count = stale_updates
            .iter()
            .filter(|u| u.new_timeliness == "stale")
            .count();
        let current_count = stale_updates
            .iter()
            .filter(|u| u.new_timeliness == "current")
            .count();
        for update in &stale_updates {
            if let Err(e) = property::set(
                &update.path,
                "timeliness",
                &update.new_timeliness,
            ) {
                eprintln!("写入失败 {}: {e}", update.rel);
            }
        }
        if !stale_updates.is_empty() {
            eprintln!(
                "已标记 {} 个页面的 timeliness（stale: {}, current: {}）",
                stale_updates.len(),
                stale_count,
                current_count,
            );
        }
    }

    if opts.ci && (health_issues + lint_issues + diff_issues) > 0 {
        process::exit(1);
    }
}

const fn count_health_issues(r: &display::CheckResults) -> usize {
    r.empty_files.len()
        + r.index_sync.on_disk_not_in_index.len()
        + r.index_sync.in_index_not_on_disk.len()
        + r.log_coverage.len()
        + r.frontmatter.len()
        + r.related_field.len()
        + r.related_body_consistency.len()
        + r.source_field.len()
        + r.missing_inline_links.len()
        + r.duplicate_inline_links.len()
}

const fn count_lint_issues(r: &display::LintResults) -> usize {
    r.broken_links.len()
        + r.orphan_pages.len()
        + r.sparse_pages.len()
        + r.stale_pages.len()
        + r.cascade_stale.len()
}

fn print_json_check_output(
    health: &display::CheckResults,
    lint: &display::LintResults,
    diff: &[display::Issue],
    health_issues: usize,
    lint_issues: usize,
    diff_issues: usize,
) {
    let fmt_issues = |issues: &[display::Issue]| -> Vec<serde_json::Value> {
        issues
            .iter()
            .map(|i| {
                serde_json::json!({"page": i.page, "kind": i.kind, "details": i.details})
            })
            .collect()
    };

    let mut json_output = serde_json::json!({
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
        "total_issues": health_issues + lint_issues + diff_issues,
    });

    if !diff.is_empty() {
        let diff_items: Vec<serde_json::Value> = diff
            .iter()
            .map(|d| serde_json::json!({"page": d.page, "details": d.details}))
            .collect();
        json_output["diff"] = serde_json::json!({"issues": diff_items});
    }

    println!("{}", serde_json::to_string_pretty(&json_output).unwrap());
}

fn print_markdown_check_output(
    health: &display::CheckResults,
    lint: &display::LintResults,
    diff_results: &[display::Issue],
    opts: &CheckOpts,
) {
    println!("{}", display::format_check_report(health));
    println!("{}", display::format_lint_report(lint));

    if opts.diff_check.is_some() {
        if diff_results.is_empty() {
            println!("## 增量内联链接（0 处缺失）\n\n✅");
        } else {
            println!("## 增量内联链接（{} 处缺失）", diff_results.len());
            println!();
            for issue in diff_results {
                if let Ok(val) =
                    serde_json::from_str::<serde_json::Value>(&issue.details)
                {
                    let term = val["term"].as_str().unwrap_or("");
                    let targets = val["targets"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|t| t.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    println!(
                        "- `{}`: **{}** → 建议链接到: {}",
                        issue.page, term, targets
                    );
                } else {
                    println!("- `{}`: {}", issue.page, issue.details);
                }
            }
        }
    }

    // Global total across health + lint + diff, so the report ends
    // with an unambiguous verdict instead of the lint-only footer.
    let health_total = count_health_issues(health);
    let lint_total = count_lint_issues(lint);
    let diff_total = diff_results.len();
    let grand_total = health_total + lint_total + diff_total;
    println!();
    println!("---");
    println!();
    println!(
        "**全局总计：{grand_total} 个问题**（健康检查 {health_total} + lint {lint_total} + 增量 {diff_total}）"
    );
}

fn cmd_backlinks(args: &Args, page: Option<&str>) {
    let root = wiki::wiki_dir();
    let paths = wiki::all_wiki_pages();
    let pages: Vec<wiki::Page> =
        paths.iter().filter_map(|p| wiki::read_page(p)).collect();
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
    delete: bool,
) {
    let full = wiki::wiki_dir().join(page_path);
    if delete {
        property::delete(&full, name).unwrap_or_else(|e| {
            eprintln!("{e}");
            process::exit(1);
        });
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
    fn test_check_with_flags_parses() {
        let args =
            Args::try_parse_from(["zwiki", "check", "--save", "--ci"]).unwrap();
        match args.command {
            Some(Command::Check { save, ci, .. }) => {
                assert!(save);
                assert!(ci);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_with_diff_parses() {
        let args = Args::try_parse_from(["zwiki", "check", "--diff"]).unwrap();
        match args.command {
            Some(Command::Check { diff, .. }) => {
                assert!(diff);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_with_cached_parses() {
        let args =
            Args::try_parse_from(["zwiki", "check", "--diff", "--cached"])
                .unwrap();
        match args.command {
            Some(Command::Check { diff, cached, .. }) => {
                assert!(diff);
                assert!(cached);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_with_commit_parses() {
        let args = Args::try_parse_from([
            "zwiki", "check", "--diff", "--commit", "HEAD~1",
        ])
        .unwrap();
        match args.command {
            Some(Command::Check { diff, commit, .. }) => {
                assert!(diff);
                assert_eq!(commit, Some("HEAD~1".to_string()));
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
            Some(Command::Property { name, page, value, delete }) => {
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
    fn test_check_with_json_parses() {
        let args = Args::try_parse_from([
            "zwiki", "--json", "check", "--ci", "--save",
        ])
        .unwrap();
        assert!(args.json);
        match args.command {
            Some(Command::Check { ci, save, .. }) => {
                assert!(ci);
                assert!(save);
            }
            _ => panic!("expected Check"),
        }
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
}
