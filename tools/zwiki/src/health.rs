//! Structural health checks for the wiki knowledge base.
//!
//! Each check takes `&[Page]` (or `&HashMap<String, Page>`) and returns issues.
//! Results are aggregated by `run_all()` into a `CheckResults` for display.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use regex::Regex;
use serde_json::Value;

use crate::display::{CheckResults, IndexSyncResult, Issue};
use crate::wiki;
use crate::wiki::Page;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum body character count (after stripping frontmatter) before a page
/// is considered a stub rather than having real content.
const DEFAULT_STUB_THRESHOLD: usize = 100;

/// System files that should not be referenced in `relations` fields or
/// markdown links.
///
/// `overview.md` is excluded from this list — it is a synthesis page
/// that other pages may legitimately reference.
const SYSTEM_FILES: &[&str] =
    &["index.md", "log.md", "lint-report.md", "health-report.md", "SCHEMA.md"];

/// Meta file names excluded from index-sync comparison.
///
/// `overview.md` is a real synthesis page listed in the root index,
/// so it must participate in index-sync checks.
const META_FILE_NAMES: &[&str] =
    &["index.md", "log.md", "lint-report.md", "health-report.md", "SCHEMA.md"];

/// Required frontmatter fields.
const REQUIRED_FM_FIELDS: &[&str] =
    &["title", "type", "timestamp", "tags", "status"];

/// Valid page types.
const VALID_TYPES: &[&str] =
    &["concept", "entity", "source", "analysis", "synthesis"];

/// Valid status values.
const VALID_STATUSES: &[&str] = &["draft", "review", "stable", "deprecated"];

/// Sections to skip when checking body text for inline links.
const SKIP_LINK_CHECK_SECTIONS: &[&str] = &["backlinks", "references", "notes"];

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/// Resolve a markdown link target to a wiki-relative path.
///
/// Assumes links are wiki-root-relative (the wiki convention).  Skips
/// absolute paths and paths containing `..` components that escape
/// the wiki directory.
pub fn resolve_wiki_link(target: &str, wiki_dir: &Path) -> Option<String> {
    let target_path = Path::new(target);
    // Skip absolute paths.
    if target_path.is_absolute() {
        return None;
    }
    // Skip targets with parent-dir components (not standard in this wiki).
    if target_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let full = wiki_dir.join(target_path);
    if full.starts_with(wiki_dir) {
        full.strip_prefix(wiki_dir)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 1. check_empty_files
// ---------------------------------------------------------------------------

/// Find wiki pages whose body (after stripping frontmatter) is below
/// `threshold` characters.
///
/// Returns issues with `issue` = `"stub"` or `"empty"` and `details` =
/// `"{total_bytes}:{body_bytes}"`.
pub fn check_empty_files(pages: &[Page], threshold: usize) -> Vec<Issue> {
    let mut results: Vec<Issue> = Vec::new();
    for page in pages {
        let body_len = page.body.trim().len();
        if body_len < threshold {
            let total_len = fs::metadata(&page.path)
                .map_or(0, |m| usize::try_from(m.len()).unwrap_or(0));
            let status = if body_len == 0 { "empty" } else { "stub" };
            results.push(Issue {
                page: page.rel.clone(),
                kind: status.to_string(),
                details: format!("{total_len}:{body_len}"),
            });
        }
    }
    // Sort by body length ascending.
    results.sort_by(|a, b| {
        let a_body = a
            .details
            .split(':')
            .nth(1)
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let b_body = b
            .details
            .split(':')
            .nth(1)
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        a_body.cmp(&b_body)
    });
    results
}

// ---------------------------------------------------------------------------
// 2. check_index_sync
// ---------------------------------------------------------------------------

/// Extract markdown link targets from `index.md` content.
///
/// Matches patterns like `[Title](path.md)`.
fn parse_index_links(content: &str) -> Vec<String> {
    let re = Regex::new(r"\[.*?\]\(([^)]+\.md)\)").unwrap();
    re.captures_iter(content).map(|c| c[1].to_string()).collect()
}

/// Compare all `index.md` files (root + subdirectories) against actual files
/// on disk.
///
/// Walk all `index.md` files under `wiki_dir` (excluding templates, tools,
/// raw directories).  Collects every page path referenced across **any**
/// index as the global `indexed_anywhere` set.  A file is reported as
/// `on_disk_not_in_index` only if it appears on disk but is **not** listed
/// in any index — this implements the OKF §6 progressive-disclosure
/// contract, where a page indexed by a subdirectory `index.md` is
/// considered covered even if omitted from the root `index.md`.
///
/// `in_index_not_on_disk` reports links that exist in any index but whose
/// target file is missing from disk.
pub fn check_index_sync(pages: &[Page], wiki_dir: &Path) -> IndexSyncResult {
    let meta_names: HashSet<&str> = META_FILE_NAMES.iter().copied().collect();
    let exclude_dirs: HashSet<&str> =
        ["templates", "tools", "raw"].iter().copied().collect();

    // Build a set of all wiki-relative disk paths (non-meta).
    let all_disk: HashSet<&str> = pages
        .iter()
        .map(|p| p.rel.as_str())
        .filter(|rel| {
            let fname = Path::new(rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !meta_names.contains(fname)
        })
        .collect();
    let all_disk_owned: HashSet<String> =
        all_disk.iter().map(|s| (*s).to_string()).collect();

    // Collect every page path referenced across ANY index.md.
    let mut indexed_anywhere: HashSet<String> = HashSet::new();
    let mut in_index_not_on_disk: Vec<String> = Vec::new();

    for entry in walkdir::WalkDir::new(wiki_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name() == "index.md")
    {
        let index_path = entry.path();
        let rel_index = index_path.strip_prefix(wiki_dir).unwrap_or(index_path);

        if rel_index.components().any(|c| {
            exclude_dirs.contains(c.as_os_str().to_str().unwrap_or(""))
        }) {
            continue;
        }

        let index_dir = index_path.parent().unwrap_or(wiki_dir);
        let index_rel_parent =
            rel_index.parent().unwrap_or_else(|| Path::new(""));

        let index_content = wiki::read_file(index_path);
        let index_links = parse_index_links(&index_content);

        let mut index_rel_paths: HashSet<String> = HashSet::new();
        for link in &index_links {
            if let Some(rel_to_index) = resolve_wiki_link(link, index_dir) {
                let full_rel = if index_rel_parent.as_os_str().is_empty() {
                    rel_to_index
                } else {
                    format!(
                        "{}/{}",
                        index_rel_parent.to_string_lossy(),
                        rel_to_index
                    )
                };
                let fname = Path::new(&full_rel)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !meta_names.contains(fname) {
                    index_rel_paths.insert(full_rel.clone());
                    indexed_anywhere.insert(full_rel);
                }
            }
        }

        // in_index_not_on_disk: linked in this index but file missing on disk.
        for p in index_rel_paths.difference(&all_disk_owned) {
            if !in_index_not_on_disk.contains(p) {
                in_index_not_on_disk.push(p.clone());
            }
        }
    }

    // on_disk_not_in_index: files on disk not indexed in ANY index.md.
    let mut on_disk_not_in_index: Vec<String> = all_disk
        .iter()
        .filter(|rel| !indexed_anywhere.contains::<str>(*rel))
        .map(|s| (*s).to_string())
        .collect();

    in_index_not_on_disk.sort();
    on_disk_not_in_index.sort();

    IndexSyncResult { on_disk_not_in_index, in_index_not_on_disk }
}

// ---------------------------------------------------------------------------
// 3. check_log_coverage
// ---------------------------------------------------------------------------

/// Extract logged paths from `log.md` content.
///
/// Supports two formats:
/// - Old format: `## [YYYY-MM-DD] op | path | action — note`
/// - New OKF §7 format: `* **verb**: path — note` under `## YYYY-MM-DD` groups
fn parse_log_entries(content: &str) -> HashSet<String> {
    let mut paths = HashSet::new();

    // Old format: ## [YYYY-MM-DD] op | path | action — note
    let old_re =
        Regex::new(r"(?m)^## \[\d{4}-\d{2}-\d{2}\] \w+ \| ([^|]+) \|").unwrap();
    for cap in old_re.captures_iter(content) {
        paths.insert(cap[1].trim().to_string());
    }

    // New OKF §7 format: * **verb**: path — note
    let new_re = Regex::new(r"(?m)^\* \*\*[^*]+\*\*:\s*([^—\n]+)").unwrap();
    for cap in new_re.captures_iter(content) {
        paths.insert(cap[1].trim().to_string());
    }

    paths
}

/// Find source pages that have no corresponding log entry in `log.md`.
///
/// Only checks pages under `<domain>/sources/` — entity/concept pages are created
/// as side-effects and don't need their own log entry.
pub fn check_log_coverage(pages: &[Page], wiki_dir: &Path) -> Vec<Issue> {
    let log_path = wiki_dir.join("log.md");
    let log_content = wiki::read_file(&log_path);
    let logged_paths = parse_log_entries(&log_content);

    // Only check pages under <domain>/sources/.
    let source_pages: Vec<&Page> =
        pages.iter().filter(|p| p.rel.contains("/sources/")).collect();

    let mut results = Vec::new();
    for page in source_pages {
        if !logged_paths.contains(&page.rel) {
            let title = page
                .frontmatter
                .get("title")
                .and_then(|v| v.as_str())
                .map_or_else(
                    || {
                        Path::new(&page.rel)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string()
                    },
                    std::string::ToString::to_string,
                );
            results.push(Issue {
                page: page.rel.clone(),
                kind: "missing_log_coverage".to_string(),
                details: title,
            });
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}

// ---------------------------------------------------------------------------
// 4. check_frontmatter
// ---------------------------------------------------------------------------

/// Verify every page has required frontmatter fields with valid values.
///
/// Checks:
/// - Required fields: title, type, timestamp, tags, status
/// - Valid type enum: concept/entity/source/analysis/synthesis
/// - Valid status enum: draft/review/stable/deprecated
/// - Valid ISO 8601 date format for timestamp
pub fn check_frontmatter(pages: &[Page]) -> Vec<Issue> {
    let valid_types: HashSet<&str> = VALID_TYPES.iter().copied().collect();
    let valid_statuses: HashSet<&str> =
        VALID_STATUSES.iter().copied().collect();
    let mut results: Vec<Issue> = Vec::new();

    for page in pages {
        let fm = &page.frontmatter;

        if fm.is_empty() {
            results.push(Issue {
                page: page.rel.clone(),
                kind: "missing_frontmatter".to_string(),
                details: "No YAML frontmatter found".to_string(),
            });
            continue;
        }

        // Check required fields.
        for field in REQUIRED_FM_FIELDS {
            if !fm.contains_key(*field) {
                results.push(Issue {
                    page: page.rel.clone(),
                    kind: format!("missing_field:{field}"),
                    details: format!(
                        "Required frontmatter field '{field}' is missing"
                    ),
                });
            }
        }

        // Check type validity.
        if let Some(val) = fm.get("type").and_then(|v| v.as_str())
            && !valid_types.contains(val)
        {
            let valid_list = VALID_TYPES.join(", ");
            results.push(Issue {
                page: page.rel.clone(),
                kind: format!("invalid_type:{val}"),
                details: format!(
                    "Type '{val}' is not valid. Must be one of: {valid_list}"
                ),
            });
        }

        // Check status validity.
        if let Some(val) = fm.get("status").and_then(|v| v.as_str())
            && !valid_statuses.contains(val)
        {
            let valid_list = VALID_STATUSES.join(", ");
            results.push(Issue {
                page: page.rel.clone(),
                kind: format!("invalid_status:{val}"),
                details: format!(
                    "Status '{val}' is not valid. Must be one of: {valid_list}"
                ),
            });
        }

        // Check timestamp validity (ISO 8601).
        if let Some(val) = fm.get("timestamp").and_then(|v| v.as_str())
            && wiki::parse_date(val).is_none()
        {
            results.push(Issue {
                page: page.rel.clone(),
                kind: "invalid_date:timestamp".to_string(),
                details: format!(
                    "Field 'timestamp' value '{val}' is not a valid ISO 8601 date"
                ),
            });
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}

// ---------------------------------------------------------------------------
// 5. check_relations_field
// ---------------------------------------------------------------------------

/// Check that `relations` frontmatter fields and markdown links don't point
/// to system files (index.md, log.md, SCHEMA.md, etc.).
pub fn check_related_field(pages: &[Page]) -> Vec<Issue> {
    let system_names: HashSet<&str> = SYSTEM_FILES.iter().copied().collect();
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let mut results: Vec<Issue> = Vec::new();

    for page in pages {
        // 1. Check frontmatter `relations` field.
        if let Some(related) = page.frontmatter.get("relations") {
            let items: Vec<&str> = match related {
                Value::String(s) => vec![s.as_str()],
                Value::Array(arr) => {
                    arr.iter().filter_map(|v| v.as_str()).collect()
                }
                _ => Vec::new(),
            };
            for target in items {
                // Parse markdown-link wrapper to extract target path.
                let bare_target = wiki::parse_related_entry(target);
                let fname = Path::new(&bare_target)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if system_names.contains(fname) {
                    results.push(Issue {
                        page: page.rel.clone(),
                        kind: "related_to_system_file".to_string(),
                        details: format!(
                            "Frontmatter 'relations' field points to system file '{target}' — \
                             this is not allowed"
                        ),
                    });
                }
            }
        }

        // 2. Check markdown links in body text.
        for cap in link_re.captures_iter(&page.body) {
            let link_text = &cap[1];
            let link_target = &cap[2];
            let fname = Path::new(link_target)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if system_names.contains(fname) {
                results.push(Issue {
                    page: page.rel.clone(),
                    kind: "markdown_link_to_system_file".to_string(),
                    details: format!(
                        "Markdown link [{link_text}]({link_target}) points to system file — \
                         this is not allowed"
                    ),
                });
            }
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}

// ---------------------------------------------------------------------------
// 6. check_related_body_consistency — bidirectional consistency
// ---------------------------------------------------------------------------

/// Verify that each page's `relations` frontmatter entries and inline wiki
/// links in the body (excluding Backlinks/References/Notes sections) are
/// mutually consistent.
///
/// Two types of issues are reported:
///
/// - **`related_redundant`** (direction A): a page listed in `related` but
///   no inline link points to it.
/// - **`related_omission`** (direction B): an inline wiki link pointing to a
///   page that is not listed in `relations`.
///
/// Only wiki-internal `.md` targets are compared.  External URLs, system
/// files, and `raw/` paths are skipped.
pub fn check_related_body_consistency(
    pages: &[Page],
    wiki_dir: &Path,
) -> Vec<Issue> {
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let system_names: HashSet<&str> = SYSTEM_FILES.iter().copied().collect();
    let mut results: Vec<Issue> = Vec::new();

    for page in pages {
        // --- Extract relations entries from frontmatter ---
        let raw_related: Vec<String> = page
            .frontmatter
            .get("relations")
            .map(|v| match v {
                Value::String(s) => vec![s.clone()],
                Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
                _ => Vec::new(),
            })
            .unwrap_or_default();

        // Resolve each relations entry to a wiki-relative path.
        let resolved_related: HashSet<String> = raw_related
            .iter()
            .map(|entry| wiki::parse_related_entry(entry))
            .filter_map(|entry| resolve_wiki_link(&entry, wiki_dir))
            .collect();

        // --- Extract inline links from body (excl special sections) ---
        let check_body = body_sections_to_check(&page.body);
        let mut resolved_links: HashSet<String> = HashSet::new();

        for cap in link_re.captures_iter(&check_body) {
            let target = cap[2].trim().to_string();
            // Skip non-.md targets.
            if !Path::new(&target)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            // Resolve to wiki-relative path.
            let Some(rel_target) = resolve_wiki_link(&target, wiki_dir) else {
                continue;
            };
            // Skip system files and raw/ paths.
            let fname = Path::new(&rel_target)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if system_names.contains(fname) || rel_target.starts_with("raw/") {
                continue;
            }
            resolved_links.insert(rel_target);
        }

        // --- Direction A: relations entries with no matching inline link ---
        for entry in &raw_related {
            let bare_entry = wiki::parse_related_entry(entry);
            // Only check entries that resolved successfully.
            let Some(rel_entry) = resolve_wiki_link(&bare_entry, wiki_dir)
            else {
                continue;
            };
            // Skip system files and raw/ paths.
            let fname = Path::new(&rel_entry)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if system_names.contains(fname) || rel_entry.starts_with("raw/") {
                continue;
            }
            if !resolved_links.contains(&rel_entry) {
                results.push(Issue {
                    page: page.rel.clone(),
                    kind: "related_redundant".to_string(),
                    details: format!(
                        "relations 字段包含 {entry}，但正文中无内联链接指向该页面"
                    ),
                });
            }
        }

        // --- Direction B: inline links not listed in relations ---
        for cap in link_re.captures_iter(&check_body) {
            let target = cap[2].trim().to_string();
            // Skip non-.md targets.
            if !Path::new(&target)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let Some(rel_target) = resolve_wiki_link(&target, wiki_dir) else {
                continue;
            };
            // Skip system files and raw/ paths.
            let fname = Path::new(&rel_target)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if system_names.contains(fname) || rel_target.starts_with("raw/") {
                continue;
            }
            if !resolved_related.contains(&rel_target) {
                results.push(Issue {
                    page: page.rel.clone(),
                    kind: "related_omission".to_string(),
                    details: format!(
                        "正文包含指向 {rel_target} 的内联链接，但 relations 字段未收录该页面"
                    ),
                });
            }
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}
// ---------------------------------------------------------------------------

/// Validate `resource` field for source-type pages under `<domain>/sources/`.
///
/// Checks:
/// - source-type pages must have a `resource` field
/// - resource field should be a valid URL (http/https) or `raw/` path
pub fn check_source_field(pages: &[Page]) -> Vec<Issue> {
    let mut results: Vec<Issue> = Vec::new();

    for page in pages {
        // Only check files under <domain>/sources/ directory.
        if !page.rel.contains("/sources/") {
            continue;
        }

        let page_type =
            page.frontmatter.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Only validate source-type pages.
        if page_type != "source" {
            continue;
        }

        let fname = Path::new(&page.rel)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        let resource_value =
            page.frontmatter.get("resource").and_then(|v| v.as_str());

        match resource_value {
            None | Some("") => {
                results.push(Issue {
                    page: page.rel.clone(),
                    kind: "missing_resource_field".to_string(),
                    details: format!(
                        "Source-type page '{fname}' is missing required 'resource' field"
                    ),
                });
            }
            Some(val) => {
                if !val.starts_with("http://")
                    && !val.starts_with("https://")
                    && !val.starts_with("raw/")
                {
                    results.push(Issue {
                        page: page.rel.clone(),
                        kind: "invalid_resource_url".to_string(),
                        details: format!(
                            "Page '{fname}' has resource value '{val}' — should be a URL \
                             (http:// or https://) or a raw/ file path"
                        ),
                    });
                }
            }
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}

// ---------------------------------------------------------------------------
// 7. check_missing_inline_links — anchor text mining
// ---------------------------------------------------------------------------

/// Scan all pages and extract `[display text](target.md)` → target mappings.
///
/// Builds a dictionary of every display text used in markdown links across
/// the wiki, mapped to the set of wiki-relative target paths it points to.
pub fn extract_anchor_map(
    pages: &[Page],
    wiki_dir: &Path,
) -> HashMap<String, HashSet<String>> {
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let mut map: HashMap<String, HashSet<String>> = HashMap::new();

    for page in pages {
        for cap in link_re.captures_iter(&page.body) {
            let display_text = cap[1].trim().to_string();
            let target = cap[2].trim().to_string();

            if display_text.is_empty() || target.is_empty() {
                continue;
            }
            if !Path::new(&target)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }

            if let Some(rel_target) = resolve_wiki_link(&target, wiki_dir) {
                map.entry(display_text).or_default().insert(rel_target);
            }
        }
    }

    map
}

/// Add prefix aliases for multi-word anchor texts.
///
/// Generates progressive prefixes by truncating the tail of the anchor
/// text character by character.  Only prefixes that contain at least one
/// space and are ≥ 5 characters are kept.
pub fn expand_anchor_prefixes(map: &mut HashMap<String, HashSet<String>>) {
    let mut new_entries: HashMap<String, HashSet<String>> = HashMap::new();

    let keys: Vec<String> = map.keys().cloned().collect();
    for text in &keys {
        if let Some((head, tail)) = text.split_once(' ') {
            let targets = map[text].clone();

            let tail_chars: Vec<char> = tail.chars().collect();
            for end in (1..=tail_chars.len()).rev() {
                let tail_prefix: String = tail_chars[..end].iter().collect();
                let prefix = format!("{head} {tail_prefix}");
                let prefix = prefix.trim_end().to_string();

                if prefix.len() < 5 {
                    continue;
                }
                if !prefix.contains(' ') {
                    continue;
                }
                if let Some(existing) = map.get_mut(&prefix) {
                    existing.extend(targets.clone());
                } else {
                    new_entries
                        .entry(prefix)
                        .or_default()
                        .extend(targets.clone());
                }
            }
        }
    }

    map.extend(new_entries);
}

/// Return body text with Backlinks/References/Notes sections removed.
///
/// These sections contain explicit, structured links — checking them for
/// missing inline links would produce noise.
pub fn body_sections_to_check(body: &str) -> String {
    // Split at `\n## ` boundaries (consuming the delimiter).
    // Sections after the first implicitly started with `## ` before the split.
    let sections: Vec<&str> = body.split("\n## ").collect();

    let mut kept: Vec<String> = Vec::new();
    for (i, section) in sections.iter().enumerate() {
        if i == 0 {
            // First section (before any `## ` heading) — always keep.
            kept.push(section.to_string());
            continue;
        }
        // For sections after the first, the first line is the heading text.
        let header_label = section
            .lines()
            .next()
            .map(|h| h.split_whitespace().next().unwrap_or("").to_lowercase());

        if let Some(label) = header_label
            && SKIP_LINK_CHECK_SECTIONS.contains(&label.as_str())
        {
            continue;
        }
        // Re-attach the `## ` prefix that was consumed by the split.
        kept.push(format!("## {section}"));
    }

    kept.join("\n")
}

/// Check a body text fragment for anchor terms missing inline links.
pub fn check_body_for_missing_links(
    body: &str,
    rel_page: &str,
    anchor_map: &HashMap<String, HashSet<String>>,
    wiki_dir: &Path,
) -> Vec<Issue> {
    let mut results: Vec<Issue> = Vec::new();
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();

    // Remove code blocks.
    let code_re = Regex::new(r"(?s)```.*?```").unwrap();
    let body = code_re.replace_all(body, "").to_string();

    // Remove the page's own h1 heading.
    let h1_re = Regex::new(r"(?m)^#\s+.+\n?").unwrap();
    let body = h1_re.replace(&body, "").to_string();

    // Keep only sections where links are expected.
    let body = body_sections_to_check(&body);

    // Build link span map and linked-text set.
    let mut link_spans: Vec<(usize, usize, String)> = Vec::new();
    let mut linked_texts: HashSet<(String, String)> = HashSet::new();

    for cap in link_re.captures_iter(&body) {
        let target = cap[2].trim().to_string();
        if !Path::new(&target)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        if let Some(rel_target) = resolve_wiki_link(&target, wiki_dir) {
            let display = cap[1].trim().to_string();
            link_spans.push((
                cap.get(0).unwrap().start(),
                cap.get(0).unwrap().end(),
                rel_target.clone(),
            ));
            linked_texts.insert((display, rel_target));
        }
    }

    let mut reported_terms: HashSet<String> = HashSet::new();

    for (anchor_text, valid_targets) in anchor_map {
        if anchor_text.len() < 5 {
            continue;
        }
        if !anchor_text.contains(' ') && !anchor_text.contains('\u{2014}') {
            continue;
        }
        if reported_terms.contains(anchor_text) {
            continue;
        }

        // Check if a shorter or longer form is already linked on this page.
        let mut covered_by_prefix = false;
        for (lt_text, lt_target) in &linked_texts {
            if !valid_targets.contains(lt_target) {
                continue;
            }
            if lt_text.starts_with(anchor_text)
                || anchor_text.starts_with(lt_text)
            {
                covered_by_prefix = true;
                break;
            }
        }
        if covered_by_prefix {
            continue;
        }

        // Remove self-reference.
        let targets: Vec<&String> =
            valid_targets.iter().filter(|t| *t != rel_page).collect();
        if targets.is_empty() {
            continue;
        }

        // Find the first occurrence in body.
        let Some(idx) = body.find(anchor_text) else {
            continue;
        };

        // Check if inside an existing link.
        let mut covered = false;
        for (span_start, span_end, span_target) in &link_spans {
            if *span_start <= idx && idx < *span_end {
                if valid_targets.contains(span_target) {
                    covered = true;
                }
                break;
            }
        }
        if covered {
            continue;
        }

        reported_terms.insert(anchor_text.clone());

        // Build a context snippet around the match. Slice on char
        // boundaries to avoid splitting multi-byte UTF-8 sequences.
        let snippet_start = body.floor_char_boundary(idx.saturating_sub(20));
        let snippet_end = body.ceil_char_boundary(std::cmp::min(
            body.len(),
            idx + anchor_text.len() + 20,
        ));
        let snippet = &body[snippet_start..snippet_end];
        let snippet_flat = snippet.replace('\n', " ");

        let targets_str: Vec<String> =
            targets.iter().map(|t| (*t).clone()).collect();

        let details = serde_json::json!({
            "term": anchor_text,
            "targets": targets_str,
            "snippet": format!("…{}…", snippet_flat),
        })
        .to_string();

        results.push(Issue {
            page: rel_page.to_string(),
            kind: "missing_inline_link".to_string(),
            details,
        });
    }

    results
}

/// Remove shorter prefix matches when a longer one already covers the
/// same page + target combination.
pub fn deduplicate_prefix_matches(results: &mut Vec<Issue>) {
    // Group by (page, sorted targets string).
    let mut groups: HashMap<(String, String), Vec<Issue>> = HashMap::new();

    for result in results.drain(..) {
        let targets_key = serde_json::from_str::<serde_json::Value>(
            &result.details,
        )
        .map_or(String::new(), |val| {
            val["targets"]
                .as_array()
                .map(|a| {
                    let mut v: Vec<String> = a
                        .iter()
                        .filter_map(|t| t.as_str().map(ToString::to_string))
                        .collect();
                    v.sort();
                    v.join(",")
                })
                .unwrap_or_default()
        });
        let key = (result.page.clone(), targets_key);
        groups.entry(key).or_default().push(result);
    }

    let mut deduped: Vec<Issue> = Vec::new();
    for group in groups.values_mut() {
        // Keep only the longest term in each group.
        group.sort_by(|a, b| {
            let a_len = serde_json::from_str::<serde_json::Value>(&a.details)
                .ok()
                .and_then(|v| v["term"].as_str().map(str::len))
                .unwrap_or(0);
            let b_len = serde_json::from_str::<serde_json::Value>(&b.details)
                .ok()
                .and_then(|v| v["term"].as_str().map(str::len))
                .unwrap_or(0);
            b_len.cmp(&a_len) // descending
        });
        deduped.push(group[0].clone());
    }

    deduped.sort_by(|a, b| a.page.cmp(&b.page).then(a.details.cmp(&b.details)));
    *results = deduped;
}

/// Find anchor texts that appear in body text without a matching inline link.
///
/// Uses anchor text mining: first scans every wiki page to build a dictionary
/// of `[display text](target)` pairs, then checks each page for terms that
/// appear in the body without a corresponding link.
pub fn check_missing_inline_links(
    pages: &[Page],
    wiki_dir: &Path,
) -> Vec<Issue> {
    let mut anchor_map = extract_anchor_map(pages, wiki_dir);

    // Register each page's own title as an anchor text pointing to itself.
    for page in pages {
        if let Some(title) =
            page.frontmatter.get("title").and_then(|v| v.as_str())
            && title.len() >= 3
        {
            anchor_map
                .entry(title.to_string())
                .or_default()
                .insert(page.rel.clone());
        }
    }

    // Expand multi-word anchor texts with prefix aliases.
    expand_anchor_prefixes(&mut anchor_map);

    let mut results: Vec<Issue> = Vec::new();
    for page in pages {
        results.extend(check_body_for_missing_links(
            &page.body,
            &page.rel,
            &anchor_map,
            wiki_dir,
        ));
    }

    deduplicate_prefix_matches(&mut results);
    results
}

// ---------------------------------------------------------------------------
// 8. check_duplicate_inline_links
// ---------------------------------------------------------------------------

/// Find pages that link to the same wiki target multiple times in prose
/// sections (Backlinks/References/Notes excluded).
pub fn check_duplicate_inline_links(
    pages: &[Page],
    wiki_dir: &Path,
) -> Vec<Issue> {
    let link_re = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    let code_re = Regex::new(r"(?s)```.*?```").unwrap();
    let mut results: Vec<Issue> = Vec::new();

    for page in pages {
        let body = &page.body;

        // Remove code blocks.
        let body = code_re.replace_all(body, "").to_string();

        // Keep only prose sections.
        let body = body_sections_to_check(&body);

        // Group links by resolved target path.
        let mut target_groups: HashMap<String, Vec<(String, usize)>> =
            HashMap::new();

        for cap in link_re.captures_iter(&body) {
            let display_text = cap[1].trim().to_string();
            let target = cap[2].trim().to_string();

            if display_text.is_empty() || target.is_empty() {
                continue;
            }
            if !Path::new(&target)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }

            if let Some(rel_target) = resolve_wiki_link(&target, wiki_dir) {
                // 1-based line number within body (frontmatter already stripped).
                let line_num =
                    body[..cap.get(0).unwrap().start()].matches('\n').count()
                        + 1;

                target_groups
                    .entry(rel_target)
                    .or_default()
                    .push((display_text, line_num));
            }
        }

        // Report any target with >1 occurrence in prose sections.
        for (rel_target, occurrences) in &target_groups {
            if occurrences.len() > 1 {
                let occ_json: Vec<serde_json::Value> = occurrences
                    .iter()
                    .map(|(display, line)| {
                        serde_json::json!({
                            "display": display,
                            "line": line,
                        })
                    })
                    .collect();

                let details = serde_json::json!({
                    "target": rel_target,
                    "occurrences": occ_json,
                })
                .to_string();

                results.push(Issue {
                    page: page.rel.clone(),
                    kind: "duplicate_inline_link".to_string(),
                    details,
                });
            }
        }
    }

    results.sort_by(|a, b| a.page.cmp(&b.page));
    results
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/// Run all health checks and return structured results.
pub fn run_all() -> CheckResults {
    let wiki_dir = wiki::wiki_dir();
    let paths = wiki::all_wiki_pages();
    let cache = wiki::page_cache(&paths);
    let pages: Vec<wiki::Page> = cache.into_values().collect();

    let total_pages = pages.len();

    CheckResults {
        total_pages,
        empty_files: check_empty_files(&pages, DEFAULT_STUB_THRESHOLD),
        index_sync: check_index_sync(&pages, &wiki_dir),
        log_coverage: check_log_coverage(&pages, &wiki_dir),
        frontmatter: check_frontmatter(&pages),
        related_field: check_related_field(&pages),
        related_body_consistency: check_related_body_consistency(
            &pages, &wiki_dir,
        ),
        source_field: check_source_field(&pages),
        missing_inline_links: check_missing_inline_links(&pages, &wiki_dir),
        duplicate_inline_links: check_duplicate_inline_links(&pages, &wiki_dir),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test-health").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Build a `Page` from content with frontmatter.
    fn make_page(rel: &str, content: &str) -> Page {
        let wiki_dir = wiki::wiki_dir();
        let path = wiki_dir.join(rel);
        let frontmatter = wiki::parse_frontmatter(content);
        let body = wiki::strip_frontmatter(content);
        Page { path, rel: rel.to_string(), frontmatter, body }
    }

    fn page_paths_to_pages(paths: &[PathBuf], base: &Path) -> Vec<Page> {
        paths
            .iter()
            .filter_map(|p| {
                let content = wiki::read_file(p);
                if content.is_empty() {
                    return None;
                }
                let rel = p
                    .strip_prefix(base)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .to_string();
                let frontmatter = wiki::parse_frontmatter(&content);
                let body = wiki::strip_frontmatter(&content);
                Some(Page { path: p.clone(), rel, frontmatter, body })
            })
            .collect()
    }

    /// Create a temp wiki directory and return (`wiki_dir`, pages).
    fn setup_wiki(
        dir_name: &str,
        files: &[(&str, &str)],
    ) -> (PathBuf, Vec<Page>) {
        let dir = temp_dir(dir_name);
        for (rel_path, content) in files {
            let path = dir.join(rel_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(&path, content).unwrap();
        }
        // Discover pages
        let paths = discover_local_pages_raw(&dir);
        let pages = page_paths_to_pages(&paths, &dir);
        (dir, pages)
    }

    /// Helper: discover all `.md` files under `dir` (including meta files).
    fn discover_local_pages_raw(dir: &Path) -> Vec<PathBuf> {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
            })
            .map(|e| e.path().to_path_buf())
            .collect()
    }

    // =======================================================================
    // 1. check_empty_files
    // =======================================================================

    #[test]
    fn test_empty_files_stub() {
        // Body < 100 chars -> stub
        let (_, pages) = setup_wiki(
            "empty_stub",
            &[("concepts/foo.md", "---\ntitle: Foo\n---\nShort body.")],
        );
        let issues = check_empty_files(&pages, 100);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "stub");
        assert_eq!(issues[0].page, "concepts/foo.md");
    }

    #[test]
    fn test_empty_files_empty() {
        // Body == 0 chars -> empty
        let (_, pages) = setup_wiki(
            "empty_empty",
            &[("concepts/empty.md", "---\ntitle: Empty\n---")],
        );
        let issues = check_empty_files(&pages, 100);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "empty");
    }

    #[test]
    fn test_empty_files_custom_threshold() {
        // Body has 200 chars, threshold 50 -> no issue
        let long_body = "A".repeat(200);
        let (_, pages) = setup_wiki(
            "empty_threshold",
            &[(
                "concepts/long.md",
                &format!("---\ntitle: Long\n---\n{long_body}"),
            )],
        );
        let issues = check_empty_files(&pages, 50);
        assert!(issues.is_empty(), "expected no issues for body >= threshold");
    }

    #[test]
    fn test_empty_files_no_issues() {
        let long_body = "A".repeat(200);
        let (_, pages) = setup_wiki(
            "empty_no_issues",
            &[(
                "concepts/long.md",
                &format!("---\ntitle: Long\n---\n{long_body}"),
            )],
        );
        let issues = check_empty_files(&pages, 100);
        assert!(issues.is_empty());
    }

    // =======================================================================
    // 2. check_index_sync
    // =======================================================================

    #[test]
    fn test_index_sync_on_disk_not_in_index() {
        let dir = temp_dir("index_on_disk_not_in_index");
        // Create index.md without the page, but the page file exists.
        write(&dir.join("index.md"), "# Index\n\n[Foo](concepts/foo.md)\n");
        write(&dir.join("concepts").join("foo.md"), "# Foo\nBody.\n");
        write(&dir.join("concepts").join("bar.md"), "# Bar\nBody.\n");
        write(&dir.join("concepts").join("baz.md"), "# Baz\nBody.\n");

        let pages = discover_local_pages(&dir);
        let result = check_index_sync(&pages, &dir);
        assert!(
            result
                .on_disk_not_in_index
                .contains(&"concepts/bar.md".to_string())
        );
        assert!(
            result
                .on_disk_not_in_index
                .contains(&"concepts/baz.md".to_string())
        );
        assert!(
            !result
                .on_disk_not_in_index
                .contains(&"concepts/foo.md".to_string())
        );
    }

    #[test]
    fn test_index_sync_in_index_not_on_disk() {
        let dir = temp_dir("index_in_index_not_on_disk");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Foo](concepts/foo.md)\n[Bar](concepts/bar.md)\n",
        );
        // Only foo.md exists.
        write(&dir.join("concepts").join("foo.md"), "# Foo\nBody.\n");

        let pages = discover_local_pages(&dir);
        let result = check_index_sync(&pages, &dir);
        assert!(
            result
                .in_index_not_on_disk
                .contains(&"concepts/bar.md".to_string())
        );
        assert!(
            !result
                .in_index_not_on_disk
                .contains(&"concepts/foo.md".to_string())
        );
    }

    #[test]
    fn test_index_sync_all_synced() {
        let dir = temp_dir("index_all_synced");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Foo](concepts/foo.md)\n[Bar](concepts/bar.md)\n",
        );
        write(&dir.join("concepts").join("foo.md"), "# Foo\nBody.\n");
        write(&dir.join("concepts").join("bar.md"), "# Bar\nBody.\n");

        let pages = discover_local_pages(&dir);
        let result = check_index_sync(&pages, &dir);
        assert!(result.on_disk_not_in_index.is_empty());
        assert!(result.in_index_not_on_disk.is_empty());
    }

    #[test]
    fn test_index_sync_overview_is_regular_page() {
        let dir = temp_dir("index_overview_regular");
        // overview.md is a real synthesis page listed in the root index;
        // it participates in index sync like any other page.
        write(
            &dir.join("index.md"),
            "# Index\n\n[Overview](overview.md)\n[Foo](concepts/foo.md)\n",
        );
        write(&dir.join("overview.md"), "# Overview\nBody.\n");
        write(&dir.join("concepts").join("foo.md"), "# Foo\nBody.\n");

        let pages = discover_local_pages(&dir);
        let result = check_index_sync(&pages, &dir);
        // Both overview.md and concepts/foo.md are indexed and on disk.
        assert!(
            !result.in_index_not_on_disk.contains(&"overview.md".to_string()),
            "overview.md is on disk, should not be in_index_not_on_disk"
        );
        assert!(
            !result.on_disk_not_in_index.contains(&"overview.md".to_string()),
            "overview.md is in index, should not be on_disk_not_in_index"
        );
    }

    #[test]
    fn test_index_sync_subdir_indexed_not_root() {
        // Page indexed in subdirectory index.md but NOT in root index.md
        // should NOT be reported as on_disk_not_in_index (OKF §6 progressive
        // disclosure).
        let dir = temp_dir("index_subdir_indexed_not_root");
        write(
            &dir.join("index.md"),
            "# Index\n\n[Concepts](concepts/index.md)\n",
        );
        fs::create_dir_all(dir.join("concepts")).unwrap();
        write(
            &dir.join("concepts").join("index.md"),
            "# Concepts\n\n[Foo](foo.md)\n[Bar](bar.md)\n",
        );
        write(&dir.join("concepts").join("foo.md"), "# Foo\nBody.\n");
        write(&dir.join("concepts").join("bar.md"), "# Bar\nBody.\n");

        let pages = discover_local_pages(&dir);
        let result = check_index_sync(&pages, &dir);
        assert!(
            result.on_disk_not_in_index.is_empty(),
            "pages indexed in subdir index.md should not be reported: {:?}",
            result.on_disk_not_in_index
        );
        assert!(result.in_index_not_on_disk.is_empty());
    }

    /// Helper: discover pages under dir and return as `Vec<Page>`.
    fn discover_local_pages(dir: &Path) -> Vec<Page> {
        let paths: Vec<PathBuf> = walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
            })
            .map(|e| e.path().to_path_buf())
            .collect();

        page_paths_to_pages(&paths, dir)
    }

    // =======================================================================
    // 3. check_log_coverage
    // =======================================================================

    #[test]
    fn test_log_coverage_covered() {
        let dir = temp_dir("log_covered");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | autoresearch/sources/adr/adr-001.md | create — New\n",
        );
        write(
            &dir.join("autoresearch")
                .join("sources")
                .join("adr")
                .join("adr-001.md"),
            "---\ntitle: ADR-001\ntype: source\n---\nBody.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert!(issues.is_empty(), "source page with log entry should pass");
    }

    #[test]
    fn test_log_coverage_missing() {
        let dir = temp_dir("log_missing");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | autoresearch/sources/adr/other.md | create\n",
        );
        write(
            &dir.join("autoresearch")
                .join("sources")
                .join("adr")
                .join("adr-001.md"),
            "---\ntitle: ADR-001\ntype: source\n---\nBody.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "autoresearch/sources/adr/adr-001.md");
        assert_eq!(issues[0].details, "ADR-001");
    }

    #[test]
    fn test_log_coverage_non_source_ignored() {
        let dir = temp_dir("log_non_source");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | concepts/foo.md | create\n",
        );
        write(
            &dir.join("concepts").join("foo.md"),
            "---\ntitle: Foo\ntype: concept\n---\nBody.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert!(issues.is_empty(), "non-source pages should be ignored");
    }

    #[test]
    fn test_log_coverage_empty_sources_dir() {
        let dir = temp_dir("log_empty_sources");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | concepts/foo.md | create\n",
        );
        // A non-domain sources/ dir with no source pages should not trigger
        // the source-page filter (it does not match `<domain>/sources/`).
        fs::create_dir_all(dir.join("sources")).ok();

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_log_coverage_title_from_fm() {
        let dir = temp_dir("log_title_fm");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | other.md | create\n",
        );
        write(
            &dir.join("autoresearch")
                .join("sources")
                .join("rfc")
                .join("rfc-001.md"),
            "---\ntitle: RFC 001 Custom Title\ntype: source\n---\nBody.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].details, "RFC 001 Custom Title");
    }

    #[test]
    fn test_log_coverage_slug_fallback() {
        let dir = temp_dir("log_slug_fallback");
        write(
            &dir.join("log.md"),
            "## [2024-06-01] ingest | other.md | create\n",
        );
        write(
            &dir.join("autoresearch")
                .join("sources")
                .join("notes")
                .join("meeting-notes.md"),
            "---\ntype: source\n---\nBody.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_log_coverage(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].details, "meeting-notes");
    }

    // =======================================================================
    // 4. check_frontmatter
    // =======================================================================

    #[test]
    fn test_frontmatter_valid_passes() {
        let pages = vec![make_page(
            "concepts/valid.md",
            "---\ntitle: Valid\ntype: concept\ntimestamp: 2024-06-01\ntags: [test]\nstatus: draft\n---\nBody.\n",
        )];
        let issues = check_frontmatter(&pages);
        let field_issues: Vec<&Issue> = issues
            .iter()
            .filter(|i| i.kind.starts_with("missing_field:"))
            .collect();
        assert!(
            field_issues.is_empty(),
            "all required fields present: {field_issues:?}"
        );
        assert!(
            issues.iter().all(|i| !i.kind.starts_with("invalid_type")),
            "valid type should pass"
        );
        assert!(
            issues.iter().all(|i| !i.kind.starts_with("invalid_status")),
            "valid status should pass"
        );
    }

    #[test]
    fn test_frontmatter_missing_fm() {
        let pages =
            vec![make_page("concepts/nofm.md", "# No frontmatter\n\nBody.\n")];
        let issues = check_frontmatter(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "missing_frontmatter"),
            "should report missing frontmatter"
        );
    }

    #[test]
    fn test_frontmatter_missing_field() {
        let pages = vec![make_page(
            "concepts/missing.md",
            "---\ntitle: Missing\n---\nBody.\n",
        )];
        let issues = check_frontmatter(&pages);
        let missing_fields: Vec<&str> = issues
            .iter()
            .filter_map(|i| i.kind.strip_prefix("missing_field:"))
            .collect();
        assert!(missing_fields.contains(&"type"), "type should be missing");
        assert!(
            missing_fields.contains(&"timestamp"),
            "timestamp should be missing"
        );
        assert!(missing_fields.contains(&"tags"), "tags should be missing");
        assert!(missing_fields.contains(&"status"), "status should be missing");
    }

    #[test]
    fn test_frontmatter_invalid_type() {
        let pages = vec![make_page(
            "concepts/badtype.md",
            "---\ntitle: Bad\ntype: invalid_type_value\ntimestamp: 2024-06-01\ntags: [test]\nstatus: draft\n---\nBody.\n",
        )];
        let issues = check_frontmatter(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "invalid_type:invalid_type_value"),
            "invalid type should be reported"
        );
    }

    #[test]
    fn test_frontmatter_invalid_status() {
        let pages = vec![make_page(
            "concepts/badstatus.md",
            "---\ntitle: Bad\ntype: concept\ntimestamp: 2024-06-01\ntags: [test]\nstatus: obsolete\n---\nBody.\n",
        )];
        let issues = check_frontmatter(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "invalid_status:obsolete"),
            "invalid status should be reported"
        );
    }

    #[test]
    fn test_frontmatter_invalid_date() {
        let pages = vec![make_page(
            "concepts/baddate.md",
            "---\ntitle: Bad\ntype: concept\ntimestamp: not-a-date\ntags: [test]\nstatus: draft\n---\nBody.\n",
        )];
        let issues = check_frontmatter(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "invalid_date:timestamp"),
            "invalid date should be reported"
        );
    }

    // =======================================================================
    // 5. check_related_field
    // =======================================================================

    #[test]
    fn test_related_field_valid() {
        let pages = vec![make_page(
            "concepts/valid.md",
            "---\ntitle: Valid\ntype: concept\nrelations: [concepts/other.md]\n---\nSee [other](concepts/other.md).\n",
        )];
        let issues = check_related_field(&pages);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_related_field_related_to_system_file() {
        let pages = vec![make_page(
            "concepts/bad.md",
            "---\ntitle: Bad\ntype: concept\nrelations: [log.md, concepts/foo.md]\n---\nBody.\n",
        )];
        let issues = check_related_field(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "related_to_system_file"),
            "should detect relations field pointing to system file"
        );
    }

    #[test]
    fn test_related_field_markdown_link_to_system_file() {
        let pages = vec![make_page(
            "concepts/badlink.md",
            "---\ntitle: Bad\ntype: concept\n---\nSee [log](log.md) and [index](index.md).\n",
        )];
        let issues = check_related_field(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "markdown_link_to_system_file"),
            "should detect markdown link to system file"
        );
        assert_eq!(issues.len(), 2);
    }

    #[test]
    fn test_related_field_external_ignored() {
        let pages = vec![make_page(
            "concepts/external.md",
            "---\ntitle: External\ntype: concept\n---\nSee [example](https://example.com).\n",
        )];
        let issues = check_related_field(&pages);
        assert!(issues.is_empty(), "external URLs should be ignored");
    }

    // =======================================================================
    // 6. check_source_field
    // =======================================================================

    #[test]
    fn test_source_field_valid_url() {
        let pages = vec![make_page(
            "autoresearch/sources/adr/adr-001.md",
            "---\ntitle: ADR-001\ntype: source\nresource: https://example.com/doc\n---\nBody.\n",
        )];
        let issues = check_source_field(&pages);
        assert!(issues.is_empty(), "valid URL should pass");
    }

    #[test]
    fn test_source_field_missing_resource() {
        let pages = vec![make_page(
            "autoresearch/sources/adr/adr-001.md",
            "---\ntitle: ADR-001\ntype: source\n---\nBody.\n",
        )];
        let issues = check_source_field(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "missing_resource_field"),
            "missing resource should be reported"
        );
    }

    #[test]
    fn test_source_field_invalid_resource() {
        let pages = vec![make_page(
            "autoresearch/sources/adr/adr-001.md",
            "---\ntitle: ADR-001\ntype: source\nresource: /local/path.txt\n---\nBody.\n",
        )];
        let issues = check_source_field(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "invalid_resource_url"),
            "non-URL/non-raw/ resource should be invalid"
        );
    }

    #[test]
    fn test_source_field_non_source_ignored() {
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\ntype: concept\n---\nBody.\n",
        )];
        let issues = check_source_field(&pages);
        assert!(issues.is_empty(), "non-source pages should be ignored");
    }

    #[test]
    fn test_source_field_raw_path_valid() {
        let pages = vec![make_page(
            "autoresearch/sources/notes/meeting.md",
            "---\ntitle: Meeting\ntype: source\nresource: raw/notes/meeting.txt\n---\nBody.\n",
        )];
        let issues = check_source_field(&pages);
        assert!(issues.is_empty(), "raw/ paths should be valid");
    }

    // =======================================================================
    // 7. check_missing_inline_links — integration test via high-level
    //    function.  Full anchor-map expansion is a complex cross-page check;
    //    we test the public API with a minimal two-page scenario.
    // =======================================================================

    #[test]
    fn test_missing_inline_links_basic() {
        let dir = temp_dir("missing_links_basic");
        // Page A links to page B with display text "target page".
        write(
            &dir.join("page-a.md"),
            "---\ntitle: Page A\n---\n\nSee [target page](page-b.md) for details.\n",
        );
        // Page B links to page C.
        write(
            &dir.join("page-b.md"),
            "---\ntitle: Page B\n---\n\nSee [page c](page-c.md) for details.\n",
        );
        // Page C mentions "target page" (which links to page B) without a link.
        write(
            &dir.join("page-c.md"),
            "---\ntitle: Page C\n---\n\nSome text that mentions target page but without a link.\n",
        );

        let pages = discover_local_pages(&dir);
        let issues = check_missing_inline_links(&pages, &dir);
        // "target page" appears in page-c.md without a link.
        // The anchor map has "target page" → {page-b.md} from page-a.md.
        assert!(!issues.is_empty(), "should find at least one missing link");
        assert!(
            issues.iter().any(|i| i.page == "page-c.md"),
            "page-c.md should have a missing link report for 'target page'"
        );
    }

    // =======================================================================
    // 8. check_duplicate_inline_links — minimal integration test.
    // =======================================================================

    #[test]
    fn test_duplicate_inline_links_detected() {
        let dir = temp_dir("dup_links_detected");
        write(
            &dir.join("page.md"),
            "---\ntitle: Test\n---\n\nSee [foo](page-b.md) and also [foo again](page-b.md).\n",
        );
        write(&dir.join("page-b.md"), "---\ntitle: Page B\n---\n\nBody.\n");

        let pages = discover_local_pages(&dir);
        let issues = check_duplicate_inline_links(&pages, &dir);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].page, "page.md");
    }

    #[test]
    fn test_duplicate_inline_links_no_duplicates() {
        let dir = temp_dir("dup_links_none");
        write(
            &dir.join("page.md"),
            "---\ntitle: Test\n---\n\nSee [foo](page-b.md) and [bar](page-c.md).\n",
        );
        write(&dir.join("page-b.md"), "---\ntitle: B\n---\n\nBody.\n");
        write(&dir.join("page-c.md"), "---\ntitle: C\n---\n\nBody.\n");

        let pages = discover_local_pages(&dir);
        let issues = check_duplicate_inline_links(&pages, &dir);
        assert!(issues.is_empty());
    }

    // =======================================================================
    // Helper unit tests
    // =======================================================================

    #[test]
    fn test_parse_index_links_basic() {
        let content =
            "# Index\n\n[Foo](concepts/foo.md)\n[Bar](concepts/bar.md)\n";
        let links = parse_index_links(content);
        assert_eq!(links.len(), 2);
        assert!(links.contains(&"concepts/foo.md".to_string()));
        assert!(links.contains(&"concepts/bar.md".to_string()));
    }

    #[test]
    fn test_parse_index_links_no_links() {
        let content = "# Index\n\nNo links here.\n";
        let links = parse_index_links(content);
        assert!(links.is_empty());
    }

    #[test]
    fn test_parse_log_entries_old_format() {
        let content = "## [2024-06-01] ingest | autoresearch/sources/adr/adr-001.md | create — New ADR\n\
             ## [2024-06-02] update | concepts/foo.md | edit — Updated\n";
        let entries = parse_log_entries(content);
        assert_eq!(entries.len(), 2);
        assert!(entries.contains("autoresearch/sources/adr/adr-001.md"));
        assert!(entries.contains("concepts/foo.md"));
    }

    #[test]
    fn test_parse_log_entries_new_format() {
        let content = "# 目录更新日志\n\n\
            ## 2024-06-01\n\
            * **创建**: autoresearch/sources/adr/adr-001.md — New ADR\n\
            * **编辑**: concepts/foo.md — Updated\n";
        let entries = parse_log_entries(content);
        assert_eq!(entries.len(), 2);
        assert!(entries.contains("autoresearch/sources/adr/adr-001.md"));
        assert!(entries.contains("concepts/foo.md"));
    }

    #[test]
    fn test_parse_log_entries_mixed_format() {
        let content = "## [2024-05-01] ingest | old/format.md | create — Old\n\n\
            # 目录更新日志\n\n\
            ## 2024-06-01\n\
            * **创建**: new/format.md — New\n";
        let entries = parse_log_entries(content);
        assert_eq!(entries.len(), 2);
        assert!(entries.contains("old/format.md"));
        assert!(entries.contains("new/format.md"));
    }

    #[test]
    fn test_parse_log_entries_empty() {
        let entries = parse_log_entries("");
        assert!(entries.is_empty());

        let entries =
            parse_log_entries("# Just a heading\n\nNo log entries.\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn test_resolve_wiki_link_simple() {
        let wiki = Path::new("/tmp/wiki");
        let result = resolve_wiki_link("concepts/foo.md", wiki);
        assert_eq!(result, Some("concepts/foo.md".to_string()));
    }

    #[test]
    fn test_resolve_wiki_link_absolute_skipped() {
        let wiki = Path::new("/tmp/wiki");
        let result = resolve_wiki_link("/etc/passwd", wiki);
        assert_eq!(result, None);
    }

    #[test]
    fn test_resolve_wiki_link_parent_dir_skipped() {
        let wiki = Path::new("/tmp/wiki");
        let result = resolve_wiki_link("../outside.md", wiki);
        assert_eq!(result, None);
    }

    #[test]
    fn test_body_sections_to_check_keeps_first_section() {
        let body = "## Overview\nContent.\n\n## Relations\nRelated.\n";
        let result = body_sections_to_check(body);
        assert!(result.contains("## Overview"));
        // Relations is no longer in SKIP_LINK_CHECK_SECTIONS, so it is kept.
        assert!(result.contains("## Relations"));
    }

    #[test]
    fn test_body_sections_to_check_all_skipped() {
        let body = "## Relations\nR1\n\n## Backlinks\nB1\n\n## References\nRef1\n\n## Notes\nN1\n";
        let result = body_sections_to_check(body);
        // First section (before any `\n## ` split) is always kept: "## Relations\nR1\n\n".
        assert!(
            result.contains("## Relations"),
            "first section is always kept"
        );
        // Backlinks, References, Notes should be removed.
        assert!(
            !result.contains("## Backlinks"),
            "Backlinks should be removed"
        );
        assert!(
            !result.contains("## References"),
            "References should be removed"
        );
        assert!(!result.contains("## Notes"), "Notes should be removed");
    }

    // =======================================================================
    // 9. check_related_body_consistency
    // =======================================================================

    #[test]
    fn test_related_body_consistency_direction_a_redundant() {
        let dir = temp_dir("consistency_a");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- concepts/bar.md\n---\n\nBody text with no link to bar.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        let redundant: Vec<&Issue> =
            issues.iter().filter(|i| i.kind == "related_redundant").collect();
        assert_eq!(
            redundant.len(),
            1,
            "should report one related_redundant: {issues:?}"
        );
        assert_eq!(redundant[0].page, "concepts/foo.md");
        assert!(
            redundant[0].details.contains("concepts/bar.md"),
            "details should mention the redundant entry"
        );
    }

    #[test]
    fn test_related_body_consistency_direction_b_omission() {
        let dir = temp_dir("consistency_b");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\n---\n\nSee [bar](concepts/bar.md) for details.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        let omission: Vec<&Issue> =
            issues.iter().filter(|i| i.kind == "related_omission").collect();
        assert_eq!(
            omission.len(),
            1,
            "should report one related_omission: {issues:?}"
        );
        assert_eq!(omission[0].page, "concepts/foo.md");
        assert!(
            omission[0].details.contains("concepts/bar.md"),
            "details should mention the omitted target"
        );
    }

    #[test]
    fn test_related_body_consistency_both_directions() {
        let dir = temp_dir("consistency_both");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- concepts/bar.md\n- concepts/baz.md\n---\n\
             \nSee [bar](concepts/bar.md) for details.\n\
             Also see [qux](concepts/qux.md).\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        let redundant: Vec<&Issue> =
            issues.iter().filter(|i| i.kind == "related_redundant").collect();
        let omission: Vec<&Issue> =
            issues.iter().filter(|i| i.kind == "related_omission").collect();
        assert_eq!(redundant.len(), 1, "baz is redundant");
        assert!(redundant[0].details.contains("baz"));
        assert_eq!(omission.len(), 1, "qux is omitted");
        assert!(omission[0].details.contains("qux"));
    }

    #[test]
    fn test_related_body_consistency_consistent() {
        let dir = temp_dir("consistency_ok");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- concepts/bar.md\n---\n\
             \nSee [bar](concepts/bar.md) for details.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        assert!(
            issues.is_empty(),
            "consistent page should have no issues: {issues:?}"
        );
    }

    #[test]
    fn test_related_body_consistency_skips_system_files() {
        let dir = temp_dir("consistency_system");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- index.md\n---\n\
             \nSee [log](log.md) for details.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        // System files should be skipped entirely — no issues.
        assert!(
            issues.is_empty(),
            "system file references should be skipped: {issues:?}"
        );
    }

    #[test]
    fn test_related_body_consistency_skips_raw_paths() {
        let dir = temp_dir("consistency_raw");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- raw/notes/meeting.txt\n---\n\
             \nSee [raw notes](raw/notes/meeting.txt) for details.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        // raw/ paths should be skipped entirely.
        assert!(issues.is_empty(), "raw/ paths should be skipped: {issues:?}");
    }

    #[test]
    fn test_related_body_consistency_markdown_link_entry() {
        // Relations entry in markdown-link format should resolve correctly.
        let dir = temp_dir("consistency_mdlink");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- \"[Bar](concepts/bar.md)\"\n---\n\
             \nSee [bar](concepts/bar.md) for details.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        assert!(
            issues.is_empty(),
            "markdown-link relations entry should resolve: {issues:?}"
        );
    }

    #[test]
    fn test_related_body_consistency_markdown_link_entry_redundant() {
        // Markdown-link relations entry with no matching inline link.
        let dir = temp_dir("consistency_mdlink_redun");
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- \"[Bar](concepts/bar.md)\"\n---\n\
             \nBody text with no link to bar.\n",
        )];
        let issues = check_related_body_consistency(&pages, &dir);
        let redundant_count =
            issues.iter().filter(|i| i.kind == "related_redundant").count();
        assert_eq!(redundant_count, 1);
    }

    #[test]
    fn test_related_field_markdown_link_format() {
        // Markdown-link format entries should have path extracted for
        // system-file checking.
        let pages = vec![make_page(
            "concepts/foo.md",
            "---\ntitle: Foo\nrelations:\n- \"[Log](log.md)\"\n---\nBody.\n",
        )];
        let issues = check_related_field(&pages);
        assert!(
            issues.iter().any(|i| i.kind == "related_to_system_file"),
            "should detect system file even inside markdown-link wrapper"
        );
    }
}
