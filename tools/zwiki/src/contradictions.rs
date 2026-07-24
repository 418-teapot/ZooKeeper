//! Contradiction tracking — list, detect, and apply contradiction
//! resolutions across wiki pages.
//!
//! The `contradictions` frontmatter field stores an array of objects:
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
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{property, wiki};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A single contradiction entry as stored in frontmatter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContradictionEntry {
    /// Wiki-relative path of the conflicting page.
    ///
    /// Deserialized from frontmatter `path` field, serialized as `target`
    /// in JSON output to match the expected API contract.
    #[serde(rename(serialize = "target", deserialize = "path"))]
    pub path: String,
    /// List of contradictory claims.
    pub claims: Vec<String>,
    /// ISO date when the contradiction was detected.
    pub detected: String,
    /// Resolution status (`unresolved` or free-text description).
    pub resolution: String,
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
// Frontmatter extraction
// ---------------------------------------------------------------------------

/// Extract the raw YAML frontmatter block (between `---` … `---`).
fn extract_frontmatter_block(content: &str) -> Option<&str> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    let after_opening = &trimmed[3..];
    let end = after_opening.find("---")?;
    Some(after_opening[..end].trim())
}

// ---------------------------------------------------------------------------
// Contradiction parsing with proper YAML support
// ---------------------------------------------------------------------------

/// Parse the `contradictions` field from raw page content using
/// `serde_yaml` (handles nested YAML structures that the flat
/// `wiki::parse_frontmatter` cannot).
#[must_use]
pub fn parse_contradictions(content: &str) -> Vec<ContradictionEntry> {
    let fm_block = match extract_frontmatter_block(content) {
        Some(block) if !block.is_empty() => block,
        _ => return Vec::new(),
    };

    let yaml_value: serde_yaml::Value = match serde_yaml::from_str(fm_block) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let Some(contradictions) = yaml_value.get("contradictions") else {
        return Vec::new();
    };
    let Some(seq) = contradictions.as_sequence() else {
        return Vec::new();
    };

    seq.iter()
        .filter_map(|item| {
            serde_yaml::from_value::<ContradictionEntry>(item.clone()).ok()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/// Iterate all wiki pages and collect those with `contradictions` entries.
#[must_use]
pub fn collect_all(root: &Path) -> Vec<PageContradictions> {
    let wiki_root = root.to_path_buf();
    let paths = wiki::all_wiki_pages_at(root);
    let mut results: Vec<PageContradictions> = Vec::new();

    for path in &paths {
        let content = wiki::read_file(path);
        let entries = parse_contradictions(&content);
        if entries.is_empty() {
            continue;
        }

        let rel = path
            .strip_prefix(&wiki_root)
            .ok()
            .and_then(|p| p.to_str())
            .map_or_else(
                || path.to_string_lossy().to_string(),
                ToString::to_string,
            );

        results.push(PageContradictions { page: rel, entries });
    }

    results
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
        crate::ContradictionsCommand::Apply => cmd_apply(root, json),
    }
}

/// CLI entry point for `zwiki contradictions list`.
///
/// Collects all contradictions from every wiki page and prints them
/// as JSON (with `--json`) or as a human-readable table.
pub fn cmd_list(root: &Path, json: bool) {
    let results = collect_all(root);

    if json {
        println!("{}", format_json(&results));
    } else {
        println!("{}", format_human(&results));
    }
}

// ===========================================================================
// Apply (record contradictions from stdin)
// ===========================================================================

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/// Read and parse the contradiction input from stdin.
fn input_from_stdin() -> Result<Vec<ContradictionInput>, String> {
    let mut buffer = String::new();
    io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|e| format!("读取标准输入失败: {e}"))?;
    serde_json::from_str::<Vec<ContradictionInput>>(&buffer)
        .map_err(|e| format!("JSON 解析失败: {e}"))
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/// Check whether two pages already have mutual contradiction entries
/// pointing to each other.
///
/// Returns `true` when both pages contain at least one contradictions
/// entry referencing the other page.
fn has_mutual_contradiction(
    content_a: &str,
    content_b: &str,
    a_look_for_b: &str,
    b_look_for_a: &str,
) -> bool {
    let entries_a = parse_contradictions(content_a);
    let entries_b = parse_contradictions(content_b);
    entries_a.iter().any(|e| e.path == a_look_for_b)
        && entries_b.iter().any(|e| e.path == b_look_for_a)
}

// ---------------------------------------------------------------------------
// Status downgrade
// ---------------------------------------------------------------------------

// The canonical `downgrade_status` implementation lives in `property::downgrade_status`.

// ---------------------------------------------------------------------------
// Frontmatter block manipulation
// ---------------------------------------------------------------------------

/// Result of locating the `contradictions` field inside frontmatter.
struct CFieldLoc {
    /// Index of the opening `---`.
    start: usize,
    /// Index of the closing `---`.
    end: usize,
    /// Index of the `contradictions:` line, or `None` if absent.
    field_line: Option<usize>,
    /// Whether the field value is `[]`.
    empty_array: bool,
    /// Index of the last indented block line, or `None`.
    block_end: Option<usize>,
}

/// Locate frontmatter boundaries and scan for `contradictions` field.
///
/// Returns `None` when frontmatter is absent.
fn locate_contradictions_field(lines: &[&str]) -> Option<CFieldLoc> {
    // Find frontmatter `---` … `---`.
    let mut fm_start: Option<usize> = None;
    let mut fm_end: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "---" {
            if fm_start.is_none() {
                fm_start = Some(i);
            } else if fm_end.is_none() {
                fm_end = Some(i);
                break;
            }
        }
    }

    let (start, end) = (fm_start?, fm_end?);

    // Scan body for the field.
    let mut field_line_idx: Option<usize> = None;
    let mut is_empty_array = false;
    let mut block_end_idx: Option<usize> = None;

    let mut scan = start + 1;
    while scan < end {
        let trimmed = lines[scan].trim();

        if let Some(colon_idx) = trimmed.find(':') {
            let key = trimmed[..colon_idx].trim();
            if key == "contradictions" {
                field_line_idx = Some(scan);
                let value_part = trimmed[colon_idx + 1..].trim();

                if value_part == "[]" {
                    is_empty_array = true;
                    scan += 1;
                    continue;
                }

                if value_part.is_empty() {
                    let mut inner = scan + 1;
                    while inner < end && lines[inner].starts_with(' ') {
                        block_end_idx = Some(inner);
                        inner += 1;
                    }
                    scan = inner;
                    continue;
                }

                // Non-empty scalar value — treat as absent (defensive).
                field_line_idx = None;
            }
        }

        scan += 1;
    }

    Some(CFieldLoc {
        start,
        end,
        field_line: field_line_idx,
        empty_array: is_empty_array,
        block_end: block_end_idx,
    })
}

/// Build the YAML entry lines for a new contradiction entry.
///
/// Returns lines like:
///
/// ```text
///   - path: domain/page-b.md
///     claims:
///       - "Page A states X=1 but Page B states X=2"
///     detected: 2026-07-04
///     resolution: unresolved
/// ```
fn build_contradiction_entry(
    path_value: &str,
    claims: &[String],
    detected: &str,
    resolution: &str,
) -> Vec<String> {
    let mut entry = Vec::new();
    entry.push(format!("  - path: {path_value}"));
    entry.push("    claims:".to_string());
    for claim in claims {
        let escaped = claim.replace('\\', "\\\\").replace('"', "\\\"");
        entry.push(format!("      - \"{escaped}\""));
    }
    let escaped_detected = detected.replace('\\', "\\\\").replace('"', "\\\"");
    entry.push(format!("    detected: {escaped_detected}"));
    let escaped_resolution =
        resolution.replace('\\', "\\\\").replace('"', "\\\"");
    entry.push(format!("    resolution: {escaped_resolution}"));
    entry
}

/// Append a `contradictions` entry to the frontmatter of the given page.
///
/// Handles three frontmatter states:
///
/// 1. **Field absent** — insert a new multiline block before closing `---`.
/// 2. **Empty array** (`contradictions: []`) — replace the line with a block.
/// 3. **Existing entries** — append a new entry after the last one.
///
/// Writes atomically (temp file → rename).
fn append_contradictions_block(
    page_abs: &Path,
    path_value: &str,
    claims: &[String],
    detected: &str,
    resolution: &str,
) -> Result<(), String> {
    let content = fs::read_to_string(page_abs)
        .map_err(|e| format!("无法读取文件: {e}"))?;

    let lines: Vec<&str> = content.lines().collect();

    let Some(loc) = locate_contradictions_field(&lines) else {
        return Err("文件缺少有效的 frontmatter".to_string());
    };
    let CFieldLoc {
        start,
        end,
        field_line: field_line_idx,
        empty_array: is_empty_array,
        block_end: block_end_idx,
    } = loc;

    // Build the new entry lines.
    let new_entry =
        build_contradiction_entry(path_value, claims, detected, resolution);

    let mut new_lines: Vec<String> = Vec::new();

    // Lines before and including opening `---`.
    for line in &lines[..=start] {
        new_lines.push(line.to_string());
    }

    match field_line_idx {
        None => {
            // Case 1 — field absent: insert block before closing `---`.
            for line in &lines[start + 1..end] {
                new_lines.push(line.to_string());
            }
            new_lines.push("contradictions:".to_string());
            new_lines.extend_from_slice(&new_entry);
        }
        Some(fld_idx) if is_empty_array => {
            // Case 2 — `contradictions: []`: replace that line with a block.
            for line in &lines[start + 1..fld_idx] {
                new_lines.push(line.to_string());
            }
            new_lines.push("contradictions:".to_string());
            new_lines.extend_from_slice(&new_entry);
            for line in &lines[fld_idx + 1..end] {
                new_lines.push(line.to_string());
            }
        }
        Some(fld_idx) => {
            // Case 3 — existing block: append after the last entry.
            let last = block_end_idx.unwrap_or(fld_idx);
            for line in &lines[start + 1..=last] {
                new_lines.push(line.to_string());
            }
            new_lines.extend_from_slice(&new_entry);
            for line in &lines[last + 1..end] {
                new_lines.push(line.to_string());
            }
        }
    }

    // Closing `---`.
    new_lines.push(lines[end].to_string());

    // Lines after frontmatter.
    for line in &lines[end + 1..] {
        new_lines.push(line.to_string());
    }

    let mut new_content = new_lines.join("\n");
    // Preserve trailing newline if original had one.
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    // --- Atomic write ---

    let temp_path =
        page_abs.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp_path, &new_content)
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&temp_path, page_abs)
        .inspect_err(|_| {
            let _ = fs::remove_file(&temp_path);
        })
        .map_err(|e| format!("重命名文件失败: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/// Process a single contradiction pair: write blocks, downgrade status,
/// set `last_validated`. Returns `None` (skip) if mutual contradiction
/// already exists, or `Some(ApplyEntry)` on success.
fn apply_one_pair(
    input: &ContradictionInput,
    wiki_root: &std::path::Path,
    today: &str,
) -> Option<ApplyEntry> {
    let abs_a = wiki_root.join(&input.page_a);
    let abs_b = wiki_root.join(&input.page_b);

    // Check for existing mutual contradiction — skip if already present.
    let content_a = wiki::read_file(&abs_a);
    let content_b = wiki::read_file(&abs_b);
    if has_mutual_contradiction(
        &content_a,
        &content_b,
        &input.page_b,
        &input.page_a,
    ) {
        return None;
    }

    // Append contradiction frontmatter blocks.
    if let Err(e) = append_contradictions_block(
        &abs_a,
        &input.page_b,
        &input.claims,
        &input.detected,
        &input.resolution,
    ) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    if let Err(e) = append_contradictions_block(
        &abs_b,
        &input.page_a,
        &input.claims,
        &input.detected,
        &input.resolution,
    ) {
        eprintln!("{e}");
        std::process::exit(1);
    }

    // Update last_validated on both pages.
    if let Err(e) = property::set(&abs_a, "last_validated", today) {
        eprintln!("写入 last_validated 失败 {}: {e}", input.page_a);
        std::process::exit(1);
    }
    if let Err(e) = property::set(&abs_b, "last_validated", today) {
        eprintln!("写入 last_validated 失败 {}: {e}", input.page_b);
        std::process::exit(1);
    }

    Some(ApplyEntry {
        page_a: input.page_a.clone(),
        page_b: input.page_b.clone(),
        claims: input.claims.clone(),
    })
}

/// CLI entry point for `zwiki contradictions apply`.
///
/// Reads a JSON array of contradiction pairs from stdin, validates
/// page existence, checks for duplicates, and writes contradiction
/// frontmatter blocks with `last_validated` update.
/// Status downgrade is NOT performed — callers must explicitly use
/// `zwiki page set <path> status --downgrade` if desired.
pub fn cmd_apply(root: &Path, json: bool) {
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

    let today = Utc::now().format("%Y-%m-%d").to_string();
    let applied: Vec<ApplyEntry> = inputs
        .iter()
        .filter_map(|input| apply_one_pair(input, &wiki_root, &today))
        .collect();

    if json {
        let output = serde_json::json!({
            "applied": applied.len(),
            "entries": applied,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
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

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("zwiki-test")
            .join("contradictions")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &std::path::Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .expect("failed to create parent dirs");
        }
        std::fs::write(path, text).expect("failed to write file");
    }

    // -------------------------------------------------------------------
    // parse_contradictions
    // -------------------------------------------------------------------

    #[test]
    fn test_parses_nested_yaml() {
        let content = "\
---
contradictions:
  - path: other.md
    claims:
      - \"claim one\"
      - \"claim two\"
    detected: 2026-07-01
    resolution: unresolved
---
Body.
";
        let entries = parse_contradictions(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "other.md");
        assert_eq!(entries[0].claims, vec!["claim one", "claim two"]);
        assert_eq!(entries[0].detected, "2026-07-01");
        assert_eq!(entries[0].resolution, "unresolved");
    }

    #[test]
    fn test_multiple_entries() {
        let content = "\
---
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
---
";
        let entries = parse_contradictions(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "first.md");
        assert_eq!(entries[1].path, "second.md");
        assert_eq!(entries[1].claims, vec!["B", "C"]);
        assert_eq!(entries[1].resolution, "fixed by ADR-005");
    }

    #[test]
    fn test_no_frontmatter() {
        let content = "# Just a page\n\nNo frontmatter here.";
        let entries = parse_contradictions(content);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_empty_frontmatter() {
        let content = "---\n---\n\nBody.";
        let entries = parse_contradictions(content);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_no_contradictions_field() {
        let content = "---\ntitle: Hello\ntype: concept\n---\n\nBody.";
        let entries = parse_contradictions(content);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_empty_contradictions() {
        let content = "---\ncontradictions: []\n---\n\nBody.";
        let entries = parse_contradictions(content);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_inline_array_format() {
        // Some pages might use inline YAML array syntax.
        let content = "\
---
contradictions:
  - {path: other.md, claims: [x, y], detected: '2026-07-01', resolution: unresolved}
---
";
        let entries = parse_contradictions(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "other.md");
        assert_eq!(entries[0].claims, vec!["x", "y"]);
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
    // collect_all (integration with temp wiki)
    // -------------------------------------------------------------------

    #[test]
    fn test_collect_all_finds_contradictions() {
        let dir = temp_dir("collect_all");
        // Create pages with and without contradictions.
        write(
            &dir.join("shared").join("a.md"),
            "\
---
title: Page A
contradictions:
  - path: shared/b.md
    claims:
      - claim X
    detected: 2026-07-01
    resolution: unresolved
---
# Page A
",
        );
        write(
            &dir.join("shared").join("b.md"),
            "---\ntitle: Page B\n---\n\n# Page B\n",
        );
        write(&dir.join("shared").join("c.md"), "# Page C\n\nNo frontmatter.");

        // Override wiki_dir for testing by using discover_pages directly.
        let paths = wiki::discover_pages(&dir);
        let mut results: Vec<PageContradictions> = Vec::new();
        for path in &paths {
            let content = wiki::read_file(path);
            let entries = parse_contradictions(&content);
            if entries.is_empty() {
                continue;
            }
            let rel = path
                .strip_prefix(&dir)
                .ok()
                .and_then(|p| p.to_str())
                .map_or_else(
                    || path.to_string_lossy().to_string(),
                    ToString::to_string,
                );
            results.push(PageContradictions { page: rel, entries });
        }

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page, "shared/a.md");
        assert_eq!(results[0].entries.len(), 1);
        assert_eq!(results[0].entries[0].path, "shared/b.md");
    }

    #[test]
    fn test_collect_all_empty() {
        let dir = temp_dir("collect_all_empty");
        write(&dir.join("a.md"), "# Just body\n");

        let paths = wiki::discover_pages(&dir);
        let mut count = 0;
        for path in &paths {
            let content = wiki::read_file(path);
            let entries = parse_contradictions(&content);
            if !entries.is_empty() {
                count += 1;
            }
        }
        assert_eq!(count, 0);
    }

    // -------------------------------------------------------------------
    // downgrade_status (delegates to property::downgrade_status)
    // -------------------------------------------------------------------

    #[test]
    fn test_downgrade_stable_to_review() {
        assert_eq!(property::downgrade_status("stable"), "review");
    }

    #[test]
    fn test_downgrade_review_to_draft() {
        assert_eq!(property::downgrade_status("review"), "draft");
    }

    #[test]
    fn test_downgrade_draft_stays_draft() {
        assert_eq!(property::downgrade_status("draft"), "draft");
    }

    #[test]
    fn test_downgrade_deprecated_stays_deprecated() {
        assert_eq!(property::downgrade_status("deprecated"), "deprecated");
    }

    #[test]
    fn test_downgrade_unknown_status_passthrough() {
        assert_eq!(property::downgrade_status("unknown"), "unknown");
    }

    // -------------------------------------------------------------------
    // has_mutual_contradiction
    // -------------------------------------------------------------------

    #[test]
    fn test_mutual_contradiction_both_sides() {
        let content_a = "\
---
contradictions:
  - path: page_b.md
    claims:
      - claim X
    detected: 2026-07-01
    resolution: unresolved
---
";
        let content_b = "\
---
contradictions:
  - path: page_a.md
    claims:
      - claim X
    detected: 2026-07-01
    resolution: unresolved
---
";
        assert!(has_mutual_contradiction(
            content_a,
            content_b,
            "page_b.md",
            "page_a.md"
        ));
    }

    #[test]
    fn test_mutual_contradiction_only_one_side() {
        let content_a = "\
---
contradictions:
  - path: page_b.md
    claims:
      - claim X
    detected: 2026-07-01
    resolution: unresolved
---
";
        let content_b = "---\ntitle: B\n---\n";
        assert!(!has_mutual_contradiction(
            content_a,
            content_b,
            "page_b.md",
            "page_a.md"
        ));
    }

    #[test]
    fn test_mutual_contradiction_neither_side() {
        let content_a = "---\ntitle: A\n---\n";
        let content_b = "---\ntitle: B\n---\n";
        assert!(!has_mutual_contradiction(
            content_a,
            content_b,
            "page_b.md",
            "page_a.md"
        ));
    }

    // -------------------------------------------------------------------
    // build_contradiction_entry
    // -------------------------------------------------------------------

    #[test]
    fn test_build_entry_basic() {
        let claims = vec!["Page A says X=1 but Page B says X=2".to_string()];
        let entry = build_contradiction_entry(
            "shared/page-b.md",
            &claims,
            "2026-07-04",
            "unresolved",
        );
        assert_eq!(entry.len(), 5);
        assert_eq!(entry[0], "  - path: shared/page-b.md");
        assert_eq!(entry[1], "    claims:");
        assert_eq!(entry[2], "      - \"Page A says X=1 but Page B says X=2\"");
        assert_eq!(entry[3], "    detected: 2026-07-04");
        assert_eq!(entry[4], "    resolution: unresolved");
    }

    #[test]
    fn test_build_entry_multiple_claims() {
        let claims = vec![
            "Claim one".to_string(),
            "Claim two with \"quotes\"".to_string(),
        ];
        let entry = build_contradiction_entry(
            "other.md",
            &claims,
            "2026-07-01",
            "partial",
        );
        assert_eq!(entry.len(), 6);
        assert_eq!(entry[0], "  - path: other.md");
        assert_eq!(entry[1], "    claims:");
        assert_eq!(entry[2], "      - \"Claim one\"");
        assert_eq!(entry[3], "      - \"Claim two with \\\"quotes\\\"\"");
        assert_eq!(entry[4], "    detected: 2026-07-01");
        assert_eq!(entry[5], "    resolution: partial");
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — field absent
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_field_absent() {
        let dir = temp_dir("append_absent");
        let path = dir.join("test.md");
        write(&path, "---\ntitle: Page A\ntype: concept\n---\n\nBody.\n");

        append_contradictions_block(
            &path,
            "shared/page-b.md",
            &["claim text".to_string()],
            "2026-07-04",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("contradictions:"));
        assert!(content.contains("  - path: shared/page-b.md"));
        assert!(content.contains("    claims:"));
        assert!(content.contains("      - \"claim text\""));
        assert!(content.contains("    detected: 2026-07-04"));
        assert!(content.contains("    resolution: unresolved"));
        assert!(content.contains("title: Page A"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — empty array
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_empty_array() {
        let dir = temp_dir("append_empty_array");
        let path = dir.join("test.md");
        write(
            &path,
            "---\ntitle: Page A\ncontradictions: []\ntype: concept\n---\n\nBody.\n",
        );

        append_contradictions_block(
            &path,
            "shared/page-b.md",
            &["claim text".to_string()],
            "2026-07-04",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("contradictions: []"));
        assert!(content.contains("contradictions:"));
        assert!(content.contains("  - path: shared/page-b.md"));
        assert!(content.contains("    claims:"));
        assert!(content.contains("      - \"claim text\""));
        assert!(content.contains("    detected: 2026-07-04"));
        assert!(content.contains("    resolution: unresolved"));
        assert!(content.contains("title: Page A"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — existing entries
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_existing_entries() {
        let dir = temp_dir("append_existing");
        let path = dir.join("test.md");
        write(
            &path,
            "---\ntitle: Page A\ncontradictions:\n  - path: other-a.md\n    \
             claims:\n      - \"first claim\"\n    detected: 2026-06-01\n    \
             resolution: unresolved\ntype: concept\n---\n\nBody.\n",
        );

        append_contradictions_block(
            &path,
            "shared/page-b.md",
            &["second claim".to_string()],
            "2026-07-04",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("  - path: other-a.md"));
        assert!(content.contains("    claims:"));
        assert!(content.contains("      - \"first claim\""));
        assert!(content.contains("  - path: shared/page-b.md"));
        assert!(content.contains("      - \"second claim\""));
        assert!(content.contains("    detected: 2026-07-04"));
        assert!(content.contains("    resolution: unresolved"));

        // Order must be preserved: first entry before second.
        let pos_first = content.find("other-a.md").unwrap();
        let pos_second = content.find("shared/page-b.md").unwrap();
        assert!(pos_first < pos_second, "entries must be in order");

        assert!(content.contains("title: Page A"));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — no frontmatter → error
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_no_frontmatter() {
        let dir = temp_dir("append_no_fm");
        let path = dir.join("test.md");
        write(&path, "# Just body\n\nNo frontmatter.\n");

        let result = append_contradictions_block(
            &path,
            "other.md",
            &["claim".to_string()],
            "2026-07-01",
            "unresolved",
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("缺少有效的 frontmatter"));
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — empty file → error
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_empty_file() {
        let dir = temp_dir("append_empty_file");
        let path = dir.join("test.md");
        write(&path, "");

        let result = append_contradictions_block(
            &path,
            "other.md",
            &["claim".to_string()],
            "2026-07-01",
            "unresolved",
        );
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — header only (field with no entries)
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_header_only() {
        let dir = temp_dir("append_header_only");
        let path = dir.join("test.md");
        write(
            &path,
            "---\ntitle: Page A\ncontradictions:\ntype: concept\n---\n\nBody.\n",
        );

        append_contradictions_block(
            &path,
            "shared/page-b.md",
            &["header text".to_string()],
            "2026-07-04",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("contradictions:"));
        assert!(content.contains("  - path: shared/page-b.md"));
        assert!(content.contains("      - \"header text\""));
        assert!(content.contains("type: concept"));
        assert!(content.contains("Body."));
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — trailing newline preserved
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_preserves_trailing_newline() {
        let dir = temp_dir("append_trailing_nl");
        let path = dir.join("test.md");
        write(&path, "---\ntitle: Test\n---\n\nBody.\n");

        append_contradictions_block(
            &path,
            "other.md",
            &["claim".to_string()],
            "2026-07-01",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.ends_with('\n'), "trailing newline must be preserved");
    }

    // -------------------------------------------------------------------
    // append_contradictions_block — path with domain
    // -------------------------------------------------------------------

    #[test]
    fn test_append_block_path_with_domain() {
        let dir = temp_dir("append_path_domain");
        let path = dir.join("test.md");
        write(&path, "---\ntitle: Test\n---\n\nBody.\n");

        append_contradictions_block(
            &path,
            "autoresearch/concepts/other.md",
            &["domain claim".to_string()],
            "2026-07-04",
            "unresolved",
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("  - path: autoresearch/concepts/other.md"));
    }

    // -------------------------------------------------------------------
    // locate_contradictions_field
    // -------------------------------------------------------------------

    #[test]
    fn test_locate_field_finds_basic() {
        let lines = vec![
            "---",
            "title: Test",
            "contradictions:",
            "  - path: x.md",
            "    claims:",
            "      - c",
            "    detected: d",
            "    resolution: r",
            "type: concept",
            "---",
            "Body.",
        ];
        let loc = locate_contradictions_field(&lines).unwrap();
        assert_eq!(loc.start, 0);
        assert!(!loc.empty_array);
        assert!(loc.field_line.is_some());
        assert!(loc.block_end.is_some());
        // The last indented line is `    resolution: r` at index 7
        assert_eq!(loc.block_end.unwrap(), 7);
    }

    #[test]
    fn test_locate_field_absent_field() {
        let lines = vec!["---", "title: Test", "type: concept", "---", "Body."];
        let loc = locate_contradictions_field(&lines).unwrap();
        assert!(loc.field_line.is_none());
        assert!(!loc.empty_array);
    }

    #[test]
    fn test_locate_field_no_frontmatter() {
        let lines = vec!["# Just body"];
        let loc = locate_contradictions_field(&lines);
        assert!(loc.is_none());
    }

    #[test]
    fn test_locate_field_empty_array() {
        let lines = vec![
            "---",
            "title: Test",
            "contradictions: []",
            "type: concept",
            "---",
        ];
        let loc = locate_contradictions_field(&lines).unwrap();
        assert!(loc.field_line.is_some());
        assert!(loc.empty_array);
    }
}
