//! Contradiction tracking — list, detect, and apply contradiction
//! resolutions across wiki pages.
//!
//! Records live in the typed `contradictions` metadata field:
//!
//! ```yaml
//! contradictions:
//!   - path: other.md
//!     claims:
//!       - "claim text one"
//!     detected: 2026-07-01
//!     resolution: unresolved
//! ```

use std::fmt::Write;
use std::io::{self, Read};
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use zwiki::document::Contradiction;

use crate::document_io::{load, store};
use crate::wiki;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A single contradiction entry in list output.
///
/// The stored field is `path`; JSON output names it `target` to match the
/// command contract.
#[derive(Debug, Clone, Serialize)]
pub struct ContradictionEntry {
    /// Wiki-relative path of the conflicting page.
    #[serde(rename = "target")]
    pub path: String,
    /// List of contradictory claims.
    pub claims: Vec<String>,
    /// ISO date when the contradiction was detected.
    pub detected: String,
    /// Resolution status (`unresolved` or free-text description).
    pub resolution: String,
}

impl From<Contradiction> for ContradictionEntry {
    fn from(record: Contradiction) -> Self {
        Self {
            path: record.path,
            claims: record.claims,
            detected: record.detected,
            resolution: record.resolution,
        }
    }
}

/// Contradictions found on a single wiki page (output struct).
#[derive(Debug, Clone, Serialize)]
pub struct PageContradictions {
    /// Wiki-relative page path.
    pub page: String,
    /// Contradiction entries on this page.
    #[serde(rename = "contradictions")]
    pub entries: Vec<ContradictionEntry>,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Iterate all wiki pages and collect those with `contradictions` entries.
///
/// # Errors
///
/// Fails when any page cannot be loaded, naming its path.
pub fn collect_all(root: &Path) -> Result<Vec<PageContradictions>, String> {
    let set = wiki::PageSet::load(root);
    let mut results: Vec<PageContradictions> = Vec::new();

    for page in set.require_all()? {
        let entries = page.document.metadata.contradictions.as_deref();
        let Some(entries) = entries.filter(|entries| !entries.is_empty())
        else {
            continue;
        };

        results.push(PageContradictions {
            page: page.rel.clone(),
            entries: entries
                .iter()
                .cloned()
                .map(ContradictionEntry::from)
                .collect(),
        });
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/// Format contradictions as a JSON array.
#[must_use]
pub fn format_json(results: &[PageContradictions]) -> String {
    serde_json::to_string_pretty(results).unwrap_or_default()
}

/// Format contradictions as a human-readable table.
#[must_use]
pub fn format_human(results: &[PageContradictions]) -> String {
    if results.is_empty() {
        return "No contradictions found.".to_string();
    }

    let header = format!(
        "{:<30} {:<24} {:>6}  {:<14} {}",
        "Page", "Target", "Claims", "Detected", "Resolution"
    );
    let sep: String = "-".repeat(header.len().max(60));
    let mut out = String::new();
    let _ = writeln!(out, "{header}");
    let _ = writeln!(out, "{sep}");

    for pc in results {
        for entry in &pc.entries {
            let _ = writeln!(
                out,
                "{:<30} {:<24} {:>6}  {:<14} {}",
                pc.page,
                entry.path,
                entry.claims.len(),
                entry.detected,
                entry.resolution,
            );
        }
    }

    out
}

/// Dispatch a `ContradictionsCommand` from the CLI.
pub fn dispatch(cmd: &crate::ContradictionsCommand, root: &Path, json: bool) {
    match cmd {
        crate::ContradictionsCommand::List => cmd_list(root, json),
        crate::ContradictionsCommand::Apply(args) => {
            cmd_apply(root, json, args.note.as_deref());
        }
    }
}

/// CLI entry point for `zwiki contradictions list`.
///
/// Collects all contradictions from every wiki page and prints them
/// as JSON (with `--json`) or as a human-readable table.
pub fn cmd_list(root: &Path, json: bool) {
    let results = match collect_all(root) {
        Ok(results) => results,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if json {
        crate::print_stdout_line(format_json(&results));
    } else {
        crate::print_stdout_line(format_human(&results));
    }
}

// ===========================================================================
// Apply (record contradictions from stdin)
// ===========================================================================

/// A single contradiction pair from stdin JSON.
#[derive(Debug, Deserialize)]
struct ContradictionInput {
    /// Wiki-relative path of the first page.
    page_a: String,
    /// Wiki-relative path of the second page.
    page_b: String,
    /// List of contradictory claims.
    claims: Vec<String>,
    /// ISO date when the contradiction was detected.
    detected: String,
    /// Resolution status.
    resolution: String,
}

/// Summary entry for a written contradiction (used in JSON output).
#[derive(Debug, Serialize)]
struct ApplyEntry {
    /// Wiki-relative path of page A.
    page_a: String,
    /// Wiki-relative path of page B.
    page_b: String,
    /// Contradictory claims.
    claims: Vec<String>,
}

/// Read and parse the contradiction input from stdin.
fn input_from_stdin() -> Result<Vec<ContradictionInput>, String> {
    let mut buffer = String::new();
    io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|e| format!("读取标准输入失败: {e}"))?;
    serde_json::from_str::<Vec<ContradictionInput>>(&buffer)
        .map_err(|e| format!("JSON 解析失败: {e}"))
}

/// Check whether two pages already point at each other.
///
/// Returns `true` when both pages contain at least one contradiction entry
/// referencing the other page.
fn has_mutual_contradiction(
    entries_a: &[Contradiction],
    entries_b: &[Contradiction],
    a_look_for_b: &str,
    b_look_for_a: &str,
) -> bool {
    entries_a.iter().any(|e| e.path == a_look_for_b)
        && entries_b.iter().any(|e| e.path == b_look_for_a)
}

/// Build one record for the page at `path`.
fn record(path: &str, input: &ContradictionInput) -> Contradiction {
    Contradiction {
        path: path.to_string(),
        claims: input.claims.clone(),
        detected: input.detected.clone(),
        resolution: input.resolution.clone(),
    }
}

/// Process a single contradiction pair: append the record to both pages and
/// set `timestamp`.  Returns `None` (skip) when the mutual contradiction
/// already exists.
fn apply_one_pair(
    input: &ContradictionInput,
    wiki_root: &Path,
    now: &str,
) -> Result<Option<ApplyEntry>, String> {
    let abs_a = wiki_root.join(&input.page_a);
    let abs_b = wiki_root.join(&input.page_b);

    let mut document_a =
        load(&abs_a).map_err(|e| format!("{}: {e}", input.page_a))?;
    let mut document_b =
        load(&abs_b).map_err(|e| format!("{}: {e}", input.page_b))?;

    if has_mutual_contradiction(
        document_a.metadata.contradictions.as_deref().unwrap_or(&[]),
        document_b.metadata.contradictions.as_deref().unwrap_or(&[]),
        &input.page_b,
        &input.page_a,
    ) {
        return Ok(None);
    }

    document_a
        .metadata
        .contradictions
        .get_or_insert_with(Vec::new)
        .push(record(&input.page_b, input));
    document_b
        .metadata
        .contradictions
        .get_or_insert_with(Vec::new)
        .push(record(&input.page_a, input));

    document_a.metadata.timestamp = now.to_string();
    document_b.metadata.timestamp = now.to_string();

    store(&abs_a, &document_a).map_err(|e| format!("{}: {e}", input.page_a))?;
    store(&abs_b, &document_b).map_err(|e| format!("{}: {e}", input.page_b))?;

    Ok(Some(ApplyEntry {
        page_a: input.page_a.clone(),
        page_b: input.page_b.clone(),
        claims: input.claims.clone(),
    }))
}

/// CLI entry point for `zwiki contradictions apply`.
///
/// Reads a JSON array of contradiction pairs from stdin, validates
/// page existence, checks for duplicates, and writes contradiction
/// records with a `timestamp` update.
pub fn cmd_apply(root: &Path, json: bool, note: Option<&str>) {
    let inputs = match input_from_stdin() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let wiki_root = root.to_path_buf();

    // Validate all referenced pages exist before writing anything.
    for input in &inputs {
        // Reject path traversal in the caller-supplied paths before they
        // are joined to the wiki root.
        for path in [&input.page_a, &input.page_b] {
            if let Err(e) = crate::r#move::validate_rel_path(path) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        // Reject targets inside a read-only installation bundle layer
        // before any write.
        crate::guard_write_page(root, &input.page_a, "contradictions apply");
        crate::guard_write_page(root, &input.page_b, "contradictions apply");
        let abs_a = wiki_root.join(&input.page_a);
        let abs_b = wiki_root.join(&input.page_b);

        if !abs_a.exists() {
            eprintln!("页面不存在: {}", input.page_a);
            std::process::exit(1);
        }
        if !abs_b.exists() {
            eprintln!("页面不存在: {}", input.page_b);
            std::process::exit(1);
        }
    }

    let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut applied: Vec<ApplyEntry> = Vec::new();
    for input in &inputs {
        match apply_one_pair(input, &wiki_root, &now) {
            Ok(Some(entry)) => applied.push(entry),
            Ok(None) => {}
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    }

    // Log every page whose frontmatter was mutated.
    for entry in &applied {
        crate::log_mutation(&wiki_root, &entry.page_a, "edit", note);
        crate::log_mutation(&wiki_root, &entry.page_b, "edit", note);
    }

    if json {
        let output = serde_json::json!({
            "applied": applied.len(),
            "entries": applied,
        });
        crate::print_stdout_line(
            serde_json::to_string_pretty(&output).unwrap(),
        );
    }

    eprintln!(
        "Wrote {} contradiction(s) across {} pages.",
        applied.len(),
        applied.len() * 2,
    );
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::temp_dir;
    use std::fs;
    use zwiki::document::PageDocument;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn write(path: &std::path::Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .expect("failed to create parent dirs");
        }
        std::fs::write(path, text).expect("failed to write file");
    }

    /// Valid page with every required field and extra frontmatter lines.
    fn page(title: &str, extra: &str) -> String {
        format!(
            "---\ntitle: {title}\ntype: concept\ntags: []\n\
             timestamp: 2026-07-01T00:00:00Z\n\
             {extra}---\n\n# {title}\n\nBody.\n"
        )
    }

    /// One contradiction record pointing at `other.md`.
    const CONTRADICTION: &str = "contradictions:\n  - path: other.md\n    \
                                 claims:\n      - \"claim one\"\n      - \
                                 \"claim two\"\n    detected: 2026-07-01\n    \
                                 resolution: unresolved\n";

    fn input(page_a: &str, page_b: &str) -> ContradictionInput {
        ContradictionInput {
            page_a: page_a.to_string(),
            page_b: page_b.to_string(),
            claims: vec!["claim X".to_string()],
            detected: "2026-07-04".to_string(),
            resolution: "unresolved".to_string(),
        }
    }

    // -------------------------------------------------------------------
    // contradictions metadata
    // -------------------------------------------------------------------

    /// Contradiction entries of a valid page document.
    fn entries(content: &str) -> Vec<Contradiction> {
        PageDocument::parse(content)
            .expect("valid page")
            .metadata
            .contradictions
            .unwrap_or_default()
    }

    #[test]
    fn test_parses_nested_yaml() {
        let entries = entries(&page("Page A", CONTRADICTION));

        assert_eq!(
            entries,
            vec![Contradiction {
                path: "other.md".to_string(),
                claims: vec!["claim one".to_string(), "claim two".to_string(),],
                detected: "2026-07-01".to_string(),
                resolution: "unresolved".to_string(),
            }]
        );
    }

    #[test]
    fn test_multiple_entries() {
        let extra = "\
contradictions:
  - path: first.md
    claims:
      - A
    detected: 2026-01-01
    resolution: unresolved
  - path: second.md
    claims:
      - B
      - C
    detected: 2026-02-01
    resolution: fixed by ADR-005
";
        let entries = entries(&page("Page A", extra));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "first.md");
        assert_eq!(entries[1].path, "second.md");
        assert_eq!(entries[1].claims, vec!["B", "C"]);
        assert_eq!(entries[1].resolution, "fixed by ADR-005");
    }

    #[test]
    fn test_no_contradictions_field() {
        assert!(entries(&page("Page A", "")).is_empty());
    }

    #[test]
    fn test_empty_contradictions() {
        let content = page("Page A", "contradictions: []\n");
        assert!(entries(&content).is_empty());
    }

    #[test]
    fn test_inline_array_format() {
        let extra = "contradictions:\n  - {path: other.md, claims: [x, y], \
                     detected: '2026-07-01', resolution: unresolved}\n";
        let entries = entries(&page("Page A", extra));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "other.md");
        assert_eq!(entries[0].claims, vec!["x", "y"]);
    }

    #[test]
    fn test_malformed_entry_reports_error() {
        let extra = "contradictions:\n  - path: other.md\n    detected: \
                     2026-07-01\nresolution: unresolved\n";
        let error = PageDocument::parse(&page("Page A", extra))
            .expect_err("claims missing")
            .to_string();

        assert!(
            error.contains("contradictions[0].claims"),
            "unexpected error: {error}"
        );
    }

    // -------------------------------------------------------------------
    // format
    // -------------------------------------------------------------------

    #[test]
    fn test_format_json_empty() {
        let result = format_json(&[]);
        assert_eq!(result, "[]");
    }

    #[test]
    fn test_format_human_empty() {
        let result = format_human(&[]);
        assert_eq!(result, "No contradictions found.");
    }

    #[test]
    fn test_format_json_output() {
        let data = vec![PageContradictions {
            page: "shared/a.md".to_string(),
            entries: vec![ContradictionEntry {
                path: "other.md".to_string(),
                claims: vec!["claim1".to_string()],
                detected: "2026-07-01".to_string(),
                resolution: "unresolved".to_string(),
            }],
        }];
        let json = format_json(&data);
        assert!(json.contains("\"page\": \"shared/a.md\""));
        assert!(json.contains("\"target\""));
        assert!(json.contains("\"claims\": ["));
        assert!(json.contains("\"claim1\""));
        assert!(json.contains("\"detected\": \"2026-07-01\""));
    }

    // -------------------------------------------------------------------
    // collect_all
    // -------------------------------------------------------------------

    #[test]
    fn test_collect_all_finds_contradictions() {
        let dir = temp_dir("collect_all");
        write(&dir.join("shared/a.md"), &page("Page A", CONTRADICTION));
        write(&dir.join("shared/b.md"), &page("Page B", ""));
        write(&dir.join("shared/c.md"), &page("Page C", ""));

        let results = collect_all(&dir).expect("collect");

        assert_eq!(results.len(), 1);

        let results = collect_all(&dir).expect("collect");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page, "shared/a.md");
        assert_eq!(results[0].entries.len(), 1);
        assert_eq!(results[0].entries[0].path, "other.md");
    }

    #[test]
    fn test_collect_all_empty() {
        let dir = temp_dir("collect_all_empty");
        write(&dir.join("a.md"), &page("Page A", ""));

        assert!(collect_all(&dir).expect("collect").is_empty());
    }

    #[test]
    fn test_collect_all_reports_invalid_page() {
        let dir = temp_dir("collect_all_invalid");
        write(
            &dir.join("a.md"),
            "---\ntitle: Page A\ncontradictions: []\n---\n\nBody.",
        );

        let error = collect_all(&dir).expect_err("invalid page");

        assert!(error.contains("a.md"), "unexpected error: {error}");
        assert!(error.contains("缺少必需字段"), "unexpected error: {error}");
    }

    // -------------------------------------------------------------------
    // has_mutual_contradiction
    // -------------------------------------------------------------------

    fn entry(path: &str) -> Contradiction {
        Contradiction {
            path: path.to_string(),
            claims: vec!["claim X".to_string()],
            detected: "2026-07-01".to_string(),
            resolution: "unresolved".to_string(),
        }
    }

    #[test]
    fn test_mutual_contradiction_both_sides() {
        assert!(has_mutual_contradiction(
            &[entry("page_b.md")],
            &[entry("page_a.md")],
            "page_b.md",
            "page_a.md"
        ));
    }

    #[test]
    fn test_mutual_contradiction_only_one_side() {
        assert!(!has_mutual_contradiction(
            &[entry("page_b.md")],
            &[],
            "page_b.md",
            "page_a.md"
        ));
    }

    #[test]
    fn test_mutual_contradiction_neither_side() {
        assert!(!has_mutual_contradiction(&[], &[], "page_b.md", "page_a.md"));
    }

    // -------------------------------------------------------------------
    // apply_one_pair
    // -------------------------------------------------------------------

    #[test]
    fn test_apply_writes_both_sides() {
        let dir = temp_dir("apply_both_sides");
        write(&dir.join("a.md"), &page("Page A", ""));
        write(&dir.join("b.md"), &page("Page B", ""));

        let applied = apply_one_pair(
            &input("a.md", "b.md"),
            &dir,
            "2026-07-05T00:00:00Z",
        )
        .expect("apply")
        .expect("new pair");
        assert_eq!(applied.page_a, "a.md");
        assert_eq!(applied.page_b, "b.md");

        let document_a = load(&dir.join("a.md")).expect("page a");
        assert_eq!(
            document_a.metadata.contradictions,
            Some(vec![Contradiction {
                path: "b.md".to_string(),
                claims: vec!["claim X".to_string()],
                detected: "2026-07-04".to_string(),
                resolution: "unresolved".to_string(),
            }])
        );
        assert_eq!(document_a.metadata.timestamp, "2026-07-05T00:00:00Z");

        let document_b = load(&dir.join("b.md")).expect("page b");
        assert_eq!(
            document_b.metadata.contradictions,
            Some(vec![Contradiction {
                path: "a.md".to_string(),
                claims: vec!["claim X".to_string()],
                detected: "2026-07-04".to_string(),
                resolution: "unresolved".to_string(),
            }])
        );
        assert_eq!(document_b.metadata.timestamp, "2026-07-05T00:00:00Z");
    }

    #[test]
    fn test_apply_skips_existing_pair() {
        let dir = temp_dir("apply_existing_pair");
        write(&dir.join("a.md"), &page("Page A", ""));
        write(&dir.join("b.md"), &page("Page B", ""));
        apply_one_pair(&input("a.md", "b.md"), &dir, "2026-07-05T00:00:00Z")
            .expect("first apply")
            .expect("new pair");
        let before = fs::read_to_string(dir.join("a.md")).expect("read");

        assert!(
            apply_one_pair(
                &input("a.md", "b.md"),
                &dir,
                "2026-07-06T00:00:00Z"
            )
            .expect("second apply")
            .is_none()
        );
        assert_eq!(fs::read_to_string(dir.join("a.md")).expect("read"), before);
    }

    #[test]
    fn test_apply_keeps_existing_entries() {
        let dir = temp_dir("apply_existing_entries");
        write(&dir.join("a.md"), &page("Page A", CONTRADICTION));
        write(&dir.join("b.md"), &page("Page B", ""));

        apply_one_pair(&input("a.md", "b.md"), &dir, "2026-07-05T00:00:00Z")
            .expect("apply")
            .expect("new pair");

        let document_a = load(&dir.join("a.md")).expect("page a");
        let entries =
            document_a.metadata.contradictions.expect("contradictions present");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "other.md");
        assert_eq!(entries[1].path, "b.md");
    }

    #[test]
    fn test_apply_reports_invalid_page() {
        let dir = temp_dir("apply_invalid_page");
        write(&dir.join("a.md"), &page("Page A", ""));
        write(&dir.join("b.md"), "---\ntitle: Page B\n---\n\nBody.\n");
        let before = fs::read_to_string(dir.join("a.md")).expect("read");

        let error = apply_one_pair(
            &input("a.md", "b.md"),
            &dir,
            "2026-07-05T00:00:00Z",
        )
        .expect_err("invalid page");

        assert!(error.contains("缺少必需字段"), "unexpected error: {error}");
        assert_eq!(fs::read_to_string(dir.join("a.md")).expect("read"), before);
    }
}
