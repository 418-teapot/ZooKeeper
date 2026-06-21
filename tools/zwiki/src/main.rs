#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

mod backlinks;
mod diff;
mod display;
mod health;
mod lint;
mod log;
mod page;
mod property;
mod wiki;

use clap::{Parser, Subcommand};
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
}

fn main() {
    let args = Args::parse();

    match args.command {
        None => {
            use clap::CommandFactory;
            let mut cmd = Args::command();
            let _ = cmd.print_help();
            println!();
            process::exit(1);
        }
        Some(Command::Check { save, ci, diff, cached, commit }) => {
            let diff_check =
                if diff { Some(DiffCheck { cached, commit }) } else { None };
            cmd_check(&CheckOpts { save, ci, json: args.json, diff_check });
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
        Some(Command::Create { r#type, title, slug, source_type }) => {
            cmd_create(
                &r#type,
                &title,
                slug.as_deref(),
                source_type.as_deref(),
            );
        }
    }
}

struct CheckOpts {
    save: bool,
    ci: bool,
    json: bool,
    diff_check: Option<DiffCheck>,
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

    if opts.save {
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
        + r.source_field.len()
        + r.missing_inline_links.len()
        + r.duplicate_inline_links.len()
}

const fn count_lint_issues(r: &display::LintResults) -> usize {
    r.broken_links.len()
        + r.orphan_pages.len()
        + r.sparse_pages.len()
        + r.stale_pages.len()
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
            "source_field": fmt_issues(&health.source_field),
            "missing_inline_links": fmt_issues(&health.missing_inline_links),
            "duplicate_inline_links": fmt_issues(&health.duplicate_inline_links),
        },
        "lint": {
            "broken_links": fmt_issues(&lint.broken_links),
            "orphan_pages": fmt_issues(&lint.orphan_pages),
            "sparse_pages": fmt_issues(&lint.sparse_pages),
            "stale_pages": fmt_issues(&lint.stale_pages),
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
    r#type: &str,
    title: &str,
    slug: Option<&str>,
    source_type: Option<&str>,
) {
    match page::create_page(r#type, title, slug, source_type) {
        Ok(p) => println!("已创建页面: {}", p.display()),
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
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
        ])
        .unwrap();
        match args.command {
            Some(Command::Create { r#type, title, .. }) => {
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
            "--source-type",
            "adr",
            "--slug",
            "adr-001",
        ])
        .unwrap();
        match args.command {
            Some(Command::Create { r#type, title, slug, source_type }) => {
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
}
