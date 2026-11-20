//! Bidirectional backlinks — reverse index and generated-region maintenance.
//!
//! The module reads pages as documents, extracts cross-references (typed
//! metadata paths, inline markdown links `[text](path.md)`, and
//! backtick-wrapped paths `` `path.md` ``), builds a reverse index, and
//! writes the generated `## Backlinks` region of each page through the page
//! document model.

use std::collections::HashMap;
use std::path::Path;

use regex::Regex;
use zwiki::document::{self, PageDocument};

use crate::{document_io, wiki};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// System files excluded from backlink targets.
const SYSTEM_FILES: &[&str] =
    &["index.md", "overview.md", "SCHEMA.md", ".gitkeep"];

/// Excluded directory names for backlink targets.
const EXCLUDED_DIRS: &[&str] = &["tools", "raw", "logs"];

// ---------------------------------------------------------------------------
// is_valid_wiki_target
// ---------------------------------------------------------------------------

/// Check whether `target` is a valid wiki-root-relative link target.
///
/// Must be a `.md` path that is not a system file, not under `tools/`,
/// `raw/`, or `logs/`, and points to a file that actually exists.
/// Paths containing `..` are rejected to prevent symlink traversal attacks.
///
/// For installed bundles, `target` is a bundle-relative path, so the
/// function also searches inside each discovered bundle directory for the
/// file.
#[must_use]
pub fn is_valid_wiki_target(
    wiki_root: &Path,
    target: &str,
    bundles: &wiki::BundleSet,
) -> bool {
    // Must end with .md
    if !std::path::Path::new(target)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return false;
    }

    // Must NOT contain ..
    if target.contains("..") {
        return false;
    }

    let p = Path::new(target);

    // Must NOT be a system file
    if let Some(name) = p.file_name().and_then(|n| n.to_str())
        && SYSTEM_FILES.contains(&name)
    {
        return false;
    }

    // Must NOT be in excluded directories
    for component in p.components() {
        if let Some(name) = component.as_os_str().to_str()
            && EXCLUDED_DIRS.contains(&name)
        {
            return false;
        }
    }

    // Target file must exist on disk — check the direct path first, then
    // each discovered bundle directory.
    let full_path = wiki_root.join(target);
    full_path.exists()
        || target_exists_in_any_bundle(wiki_root, target, bundles)
}

/// Check whether `target` exists inside any discovered bundle directory.
///
/// Links in the wiki are bundle-relative (e.g. `shared/concepts/foo.md`),
/// so they must be resolved against each installed bundle's root.
fn target_exists_in_any_bundle(
    wiki_root: &Path,
    target: &str,
    bundles: &wiki::BundleSet,
) -> bool {
    bundles.names().any(|name| wiki_root.join(name).join(target).exists())
}

// ---------------------------------------------------------------------------
// extract_links
// ---------------------------------------------------------------------------

/// Resolve a `sources` entry to a bare path.
///
/// An entry is either a plain path (`path/to.md`) or a markdown link
/// (`[Name](path/to.md)`).
fn source_path(value: &str) -> &str {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix('[')
        && let Some(close) = rest.find("](")
    {
        let after = &rest[close + 2..];
        if let Some(end) = after.find(')') {
            return after[..end].trim();
        }
    }
    trimmed
}

/// Extract cross-reference link targets from `document`.
///
/// Sources:
/// - Typed metadata paths: `sources`, `supersedes`, `superseded_by`, and
///   `contradictions`.  A derived page names its source pages in `sources`,
///   so a source page sees the derived pages as backlinks.
/// - Inline markdown links `[text](path.md)` in the author body
/// - Backtick-wrapped paths `` `path.md` `` in the author body
///
/// The generated `## Backlinks` region is not author text, so it never
/// feeds back into extraction.
///
/// Returns a sorted, deduplicated list of wiki-root-relative `.md` paths
/// that pass [`is_valid_wiki_target`].
#[must_use]
pub fn extract_links(
    wiki_root: &Path,
    document: &PageDocument,
    bundles: &wiki::BundleSet,
) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();

    let sources = document.metadata.sources.iter().flatten();
    let relations = document
        .metadata
        .supersedes
        .iter()
        .chain(&document.metadata.superseded_by)
        .flatten()
        .map(|relation| relation.path.as_str());
    let conflicts = document
        .metadata
        .contradictions
        .iter()
        .flatten()
        .map(|record| record.path.as_str());
    links.extend(
        sources
            .map(|source| source_path(source))
            .chain(relations)
            .chain(conflicts)
            .map(str::to_string),
    );

    let author = document.body.author();
    let md_re =
        Regex::new(r"\[([^\]]+)\]\(([^)]+\.md)\)").expect("valid regex");
    for cap in md_re.captures_iter(author) {
        let target = cap[2].trim();
        if !target.starts_with("http://")
            && !target.starts_with("https://")
            && !target.starts_with("mailto:")
        {
            links.push(target.to_string());
        }
    }

    // Backtick-wrapped paths `path.md` in the author body
    let bt_re = Regex::new(r"`([^\s`]+\.md)`").expect("valid regex");
    for cap in bt_re.captures_iter(author) {
        let target = cap[1].trim();
        if !target.starts_with("http://") && !target.starts_with("https://") {
            links.push(target.to_string());
        }
    }

    // Deduplicate, filter, sort
    links.sort();
    links.dedup();
    links
        .into_iter()
        .filter(|ln| is_valid_wiki_target(wiki_root, ln, bundles))
        .collect()
}

/// Map each bundle-relative path to every matching `page.rel` value.
///
/// Bundles may share the same bundle-relative path, so one key maps to all
/// matching pages.
fn bundle_rel_map(
    pages: &[wiki::Page],
    bundles: &wiki::BundleSet,
) -> HashMap<String, Vec<String>> {
    let mut rel_map: HashMap<String, Vec<String>> = HashMap::new();
    for page in pages {
        if let Some(relative) = bundles.strip_prefix(&page.rel) {
            rel_map
                .entry(relative.to_string())
                .or_default()
                .push(page.rel.clone());
        }
    }
    rel_map
}

// ---------------------------------------------------------------------------
// build_reverse_index
// ---------------------------------------------------------------------------

/// Build the reverse-link index from pages, using `wiki_root` for existence
/// validation.
///
/// Returns a map from each target page (wiki-root-relative path) to a
/// sorted, deduplicated list of source pages that link to it.
///
/// For installed bundles, links are bundle-relative while page rels include
/// the bundle-name prefix.  The index keys therefore use the full `page.rel`
/// form, so [`update_backlinks`] can look them up directly.
pub fn build_reverse_index(
    wiki_root: &Path,
    pages: &[wiki::Page],
    bundles: &wiki::BundleSet,
) -> HashMap<String, Vec<String>> {
    let rel_map = bundle_rel_map(pages, bundles);
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();

    for page in pages {
        for target in extract_links(wiki_root, &page.document, bundles) {
            // Multiple bundles may share the same bundle-relative path, so
            // every matching page.rel becomes a reverse-index key.
            match rel_map.get(&target) {
                Some(rels) => {
                    for rel in rels {
                        reverse
                            .entry(rel.clone())
                            .or_default()
                            .push(page.rel.clone());
                    }
                }
                None => {
                    reverse.entry(target).or_default().push(page.rel.clone());
                }
            }
        }
    }

    for sources in reverse.values_mut() {
        sources.sort();
        sources.dedup();
    }

    // Sort by key for deterministic iteration
    let mut sorted: Vec<(String, Vec<String>)> = reverse.into_iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted.into_iter().collect()
}

/// Build a reverse index for a single target page.
///
/// Scans all `pages` for outbound links and returns only those that
/// reference `target`.  The result holds at most one entry: the target
/// mapped to its sorted, deduplicated source `page.rel` values.
///
/// This is more efficient than [`build_reverse_index`] when only one target
/// is needed — every page is still scanned, but no global index is built.
/// Bundle-relative paths resolve the same way as [`build_reverse_index`].
pub fn build_backlinks_for(
    target: &str,
    wiki_root: &Path,
    pages: &[wiki::Page],
    bundles: &wiki::BundleSet,
) -> HashMap<String, Vec<String>> {
    let rel_map = bundle_rel_map(pages, bundles);
    let mut sources: Vec<String> = Vec::new();

    for page in pages {
        let links = extract_links(wiki_root, &page.document, bundles);
        let refers_to_target = links.iter().any(|link| {
            if link == target {
                return true;
            }
            rel_map
                .get(link)
                .is_some_and(|rels| rels.iter().any(|rel| rel == target))
        });
        if refers_to_target {
            sources.push(page.rel.clone());
        }
    }

    sources.sort();
    sources.dedup();

    let mut result = HashMap::new();
    if !sources.is_empty() {
        result.insert(target.to_string(), sources);
    }
    result
}

// ---------------------------------------------------------------------------
// format_backlinks_content
// ---------------------------------------------------------------------------

/// Format the generated `## Backlinks` content for `sources`.
///
/// The model owns the heading, so the content is the maintenance note
/// followed by one list entry per source page.  Titles come from `titles`,
/// which maps each source rel to its page title.  Source paths become
/// bundle-relative, because wiki links are bundle-relative.
#[must_use]
pub fn format_backlinks_content(
    sources: &[String],
    bundles: &wiki::BundleSet,
    titles: &HashMap<String, String>,
) -> String {
    let mut lines = vec![
        String::from("> 此节由 zwiki 自动维护，请勿手动编辑。"),
        String::new(),
    ];
    for source in sources {
        let title = titles.get(source).map_or_else(
            || source.rsplit('/').next().map(title_case).unwrap_or_default(),
            Clone::clone,
        );
        let link_target = bundles.strip_prefix(source).unwrap_or(source);
        lines.push(format!("- [{title}]({link_target})"));
    }
    lines.join("\n")
}

/// Map each page rel to its title.
pub fn title_map(pages: &[wiki::Page]) -> HashMap<String, String> {
    pages
        .iter()
        .map(|page| (page.rel.clone(), page.document.metadata.title.clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// update_backlinks
// ---------------------------------------------------------------------------

/// Synchronize the generated `## Backlinks` region of every page.
///
/// A page with inbound links gets the formatted list; a page without inbound
/// links loses the region.  The model places the region after the author
/// content, or before `## References` when that heading exists.  Only a page
/// whose generated content changes is written.
///
/// Returns the number of pages that were written.
///
/// # Errors
///
/// Fails when a page cannot be read, parsed, or written.
pub fn update_backlinks(
    index: &HashMap<String, Vec<String>>,
    titles: &HashMap<String, String>,
    pages: &[wiki::Page],
    bundles: &wiki::BundleSet,
) -> Result<usize, String> {
    let mut updated_count = 0;

    for page in pages {
        let sources = index.get(&page.rel).cloned().unwrap_or_default();
        let content = if sources.is_empty() {
            None
        } else {
            Some(format_backlinks_content(&sources, bundles, titles))
        };

        let mut document = page.document.clone();
        if document.body.backlinks() == content.as_deref() {
            continue;
        }
        document.body.set_backlinks(content);
        document_io::store(&page.path, &document)
            .map_err(|e| format!("{}: {e}", page.rel))?;
        updated_count += 1;
    }

    Ok(updated_count)
}

// ---------------------------------------------------------------------------
// Page titles
// ---------------------------------------------------------------------------

/// Read the page title, falling back to the title-cased file stem.
///
/// # Errors
///
/// Fails when the page cannot be read, or when its frontmatter is not valid
/// YAML.
fn page_title_from_path(page_path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(page_path)
        .map_err(|e| format!("无法读取文件: {e}"))?;
    match document::read_field(&text, "title").map_err(|e| e.to_string())? {
        Some(document::Value::String(title)) => Ok(title),
        _ => Ok(page_path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(title_case)
            .unwrap_or_default()),
    }
}

/// Read the title of a page given its wiki-relative path.
///
/// # Errors
///
/// Fails when the page cannot be read, or when its frontmatter is not valid
/// YAML.
pub fn page_title_from_rel(
    rel_path: &str,
    root: &Path,
) -> Result<String, String> {
    page_title_from_path(&root.join(rel_path))
}

/// Title-case a string: `"hello-world"` → `"Hello World"`.
fn title_case(s: &str) -> String {
    s.replace('-', " ")
        .split(' ')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().to_string() + chars.as_str()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::temp_dir;
    use std::fs;
    use std::path::PathBuf;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Page text with every required field and `extra` frontmatter lines.
    fn page_text(title: &str, extra: &str, body: &str) -> String {
        format!(
            "---\ntitle: {title}\ntype: concept\ntags: []\nstatus: draft\n\
             last_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n\
             {extra}---\n\n{body}\n"
        )
    }

    /// Parse `text` as a page document.
    fn document(text: &str) -> PageDocument {
        PageDocument::parse(text).expect("valid page document")
    }

    /// Write a page file and return its legacy `Page` record.
    fn make_page(wiki_root: &Path, rel: &str, text: &str) -> wiki::Page {
        let path = write(&wiki_root.join(rel), text);
        wiki::read_page_at(&path, wiki_root).expect("page record")
    }

    /// Write a page file that only serves as a link target.
    fn write_page(wiki_root: &Path, rel: &str, title: &str) {
        write(&wiki_root.join(rel), &page_text(title, "", "Body."));
    }

    /// An empty bundle set for tests that use a plain (non-aggregated) root.
    fn no_bundles() -> wiki::BundleSet {
        wiki::BundleSet::default()
    }

    /// Write `dir/<bundle>/bundle.toml` so the bundle is discoverable.
    fn write_bundle_manifest(dir: &Path, bundle: &str) {
        write(&dir.join(bundle).join("bundle.toml"), ".");
    }

    /// Titles of the pages currently on disk, keyed by rel.
    fn titles_of(dir: &Path) -> HashMap<String, String> {
        title_map(wiki::PageSet::load(dir).pages())
    }

    /// Extract links from `text` parsed as a document.
    fn links_of(wiki_root: &Path, text: &str) -> Vec<String> {
        extract_links(wiki_root, &document(text), &no_bundles())
    }

    // -------------------------------------------------------------------
    // is_valid_wiki_target
    // -------------------------------------------------------------------

    #[test]
    fn test_is_valid_wiki_target_valid_md() {
        let dir = temp_dir("valid_md");
        write(&dir.join("test.md"), "# Test");
        assert!(is_valid_wiki_target(&dir, "test.md", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_non_md() {
        let dir = temp_dir("non_md");
        write(&dir.join("test.txt"), "test");
        assert!(!is_valid_wiki_target(&dir, "test.txt", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_dotdot() {
        let dir = temp_dir("dotdot");
        assert!(!is_valid_wiki_target(&dir, "../etc/passwd.md", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_system_file() {
        let dir = temp_dir("system_file");
        for sys_file in SYSTEM_FILES {
            write(&dir.join(sys_file), "# Meta");
            assert!(
                !is_valid_wiki_target(&dir, sys_file, &no_bundles()),
                "expected {sys_file} to be rejected"
            );
        }
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_tools_dir() {
        let dir = temp_dir("tools_dir");
        write(&dir.join("tools").join("helper.md"), "# Helper");
        assert!(!is_valid_wiki_target(&dir, "tools/helper.md", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_raw_dir() {
        let dir = temp_dir("raw_dir");
        write(&dir.join("raw").join("notes.md"), "# Notes");
        assert!(!is_valid_wiki_target(&dir, "raw/notes.md", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_rejects_logs_dir() {
        let dir = temp_dir("logs_dir");
        write(&dir.join("logs").join("2026-07.md"), "# Log");
        assert!(!is_valid_wiki_target(&dir, "logs/2026-07.md", &no_bundles()));
    }

    #[test]
    fn test_is_valid_wiki_target_nonexistent_rejected() {
        let dir = temp_dir("nonexistent");
        assert!(!is_valid_wiki_target(&dir, "no-such-file.md", &no_bundles()));
    }

    // -------------------------------------------------------------------
    // extract_links — body text
    // -------------------------------------------------------------------

    #[test]
    fn test_extract_links_from_markdown_links() {
        let dir = temp_dir("extract_mdlinks");
        write_page(&dir, "foo.md", "Foo");
        write_page(&dir, "bar.md", "Bar");
        let text =
            page_text("Page", "", "See [Foo](foo.md) and [Bar](bar.md).");
        assert_eq!(links_of(&dir, &text), vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_extract_links_from_backtick() {
        let dir = temp_dir("extract_backtick");
        write_page(&dir, "foo.md", "Foo");
        write_page(&dir, "bar.md", "Bar");
        let text = page_text("Page", "", "See: `foo.md`, `bar.md`");
        assert_eq!(links_of(&dir, &text), vec!["bar.md", "foo.md"]);
    }

    #[test]
    fn test_extract_links_excludes_backlinks_region() {
        let dir = temp_dir("extract_excludes_bl");
        write_page(&dir, "foo.md", "Foo");
        write_page(&dir, "bar.md", "Bar");
        let text = page_text(
            "Page",
            "",
            "Intro.\n\n## Backlinks\n\n- [Foo](foo.md)\n- `bar.md`",
        );
        assert!(
            links_of(&dir, &text).is_empty(),
            "generated region must not feed link extraction"
        );
    }

    #[test]
    fn test_extract_links_excludes_http() {
        let dir = temp_dir("extract_http");
        let text = page_text("Page", "", "See [Example](https://e.com/x.md).");
        assert!(links_of(&dir, &text).is_empty());
    }

    #[test]
    fn test_extract_links_deduplicates() {
        let dir = temp_dir("extract_dedup");
        write_page(&dir, "foo.md", "Foo");
        let text = page_text("Page", "", "See [Foo](foo.md) and `foo.md`.");
        assert_eq!(links_of(&dir, &text), vec!["foo.md"]);
    }

    #[test]
    fn test_extract_links_sorted() {
        let dir = temp_dir("extract_sorted");
        write_page(&dir, "a.md", "A");
        write_page(&dir, "z.md", "Z");
        let text = page_text("Page", "", "See [Zed](z.md), [Alpha](a.md).");
        assert_eq!(links_of(&dir, &text), vec!["a.md", "z.md"]);
    }

    // -------------------------------------------------------------------
    // extract_links — typed metadata
    // -------------------------------------------------------------------

    #[test]
    fn test_extract_links_from_sources() {
        let dir = temp_dir("extract_sources");
        write_page(&dir, "alpha.md", "Alpha");
        write_page(&dir, "beta.md", "Beta");
        let extra = "sources:\n  - alpha.md\n  - \"[Beta](beta.md)\"\n";
        let text = page_text("Page", extra, "Body.");
        assert_eq!(links_of(&dir, &text), vec!["alpha.md", "beta.md"]);
    }

    #[test]
    fn test_extract_links_from_nested_relation_fields() {
        let dir = temp_dir("extract_relations");
        write_page(&dir, "old.md", "Old");
        write_page(&dir, "newer.md", "Newer");
        write_page(&dir, "other.md", "Other");
        let extra = "\
supersedes:
  - path: old.md
    reason: replaced by newer
superseded_by:
  - path: newer.md
    reason: successor
contradictions:
  - path: other.md
    claims:
      - something
    detected: 2026-07-01
    resolution: unresolved
";
        let text = page_text("Page", extra, "Body.");
        assert_eq!(
            links_of(&dir, &text),
            vec!["newer.md", "old.md", "other.md"]
        );
    }

    #[test]
    fn test_extract_links_from_relations_filters_missing_target() {
        let dir = temp_dir("extract_relations_missing");
        write_page(&dir, "existing.md", "Existing");
        let extra = "supersedes:\n  - path: existing.md\n    reason: r\n  - path: missing.md\n    reason: r\n";
        let text = page_text("Page", extra, "Body.");
        assert_eq!(links_of(&dir, &text), vec!["existing.md"]);
    }

    #[test]
    fn test_extract_links_from_empty_relations() {
        let dir = temp_dir("extract_relations_empty");
        write_page(&dir, "dummy.md", "Dummy");
        let extra = "\
sources: []
supersedes: []
superseded_by: []
contradictions: []
";
        let text = page_text("Page", extra, "Body.");
        assert!(links_of(&dir, &text).is_empty());
    }

    // -------------------------------------------------------------------
    // build_reverse_index
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_simple() {
        let dir = temp_dir("rev_simple");
        write_page(&dir, "b.md", "B");
        let pages = vec![
            make_page(
                &dir,
                "concepts/a.md",
                &page_text("A", "", "See [B](b.md)."),
            ),
            make_page(&dir, "concepts/b.md", &page_text("B", "", "No links.")),
        ];
        let index = build_reverse_index(&dir, &pages, &no_bundles());
        assert_eq!(
            index,
            HashMap::from([(
                "b.md".to_string(),
                vec!["concepts/a.md".to_string()]
            )])
        );
    }

    #[test]
    fn test_build_reverse_index_no_links() {
        let dir = temp_dir("rev_no_links");
        let pages = vec![
            make_page(&dir, "a.md", &page_text("A", "", "No links.")),
            make_page(&dir, "b.md", &page_text("B", "", "No links.")),
        ];
        let index = build_reverse_index(&dir, &pages, &no_bundles());
        assert!(index.is_empty());
    }

    #[test]
    fn test_build_reverse_index_self_links_ignored() {
        let dir = temp_dir("rev_self");
        let pages = vec![make_page(
            &dir,
            "a.md",
            &page_text("A", "", "See [A](a.md)."),
        )];
        let index = build_reverse_index(&dir, &pages, &no_bundles());
        assert_eq!(
            index,
            HashMap::from([("a.md".to_string(), vec!["a.md".to_string()])])
        );
    }

    #[test]
    fn test_build_reverse_index_bidirectional() {
        let dir = temp_dir("rev_bi");
        let pages = vec![
            make_page(&dir, "a.md", &page_text("A", "", "See [B](b.md).")),
            make_page(&dir, "b.md", &page_text("B", "", "See [A](a.md).")),
        ];
        let index = build_reverse_index(&dir, &pages, &no_bundles());
        assert_eq!(index["a.md"], vec!["b.md"]);
        assert_eq!(index["b.md"], vec!["a.md"]);
    }

    #[test]
    fn test_build_reverse_index_uses_loaded_document() {
        let dir = temp_dir("rev_loaded_doc");
        write_page(&dir, "target.md", "Target");
        // The file on disk has no links; the loaded document does.  The
        // index must follow the document instead of reading the file again.
        let mut page =
            make_page(&dir, "a.md", &page_text("A", "", "No links."));
        page.document = document(&page_text("A", "", "See [T](target.md)."));

        let index = build_reverse_index(&dir, &[page], &no_bundles());
        assert_eq!(index["target.md"], vec!["a.md"]);
    }

    // -------------------------------------------------------------------
    // format_backlinks_content
    // -------------------------------------------------------------------

    #[test]
    fn test_format_backlinks_content_lists_sources() {
        let dir = temp_dir("fmt_basic");
        write_page(&dir, "src.md", "Source Page");
        let pages = vec![make_page(
            &dir,
            "src.md",
            &page_text("Source Page", "", "Body."),
        )];
        let sources = vec![String::from("src.md")];
        let content = format_backlinks_content(
            &sources,
            &no_bundles(),
            &title_map(&pages),
        );
        assert_eq!(
            content,
            "> 此节由 zwiki 自动维护，请勿手动编辑。\n\n- [Source Page](src.md)"
        );
    }

    #[test]
    fn test_format_backlinks_content_uses_bundle_relative_link() {
        let dir = temp_dir("fmt_bundle");
        write_bundle_manifest(&dir, "core");
        write_page(&dir, "core/docs/a.md", "Page A");
        let bundles = wiki::BundleSet::discover(&dir);
        let pages = vec![make_page(
            &dir,
            "core/docs/a.md",
            &page_text("Page A", "", "Body."),
        )];
        let sources = vec![String::from("core/docs/a.md")];
        let content =
            format_backlinks_content(&sources, &bundles, &title_map(&pages));
        assert!(
            content.ends_with("- [Page A](docs/a.md)"),
            "link must be bundle-relative: {content}"
        );
    }

    // -------------------------------------------------------------------
    // update_backlinks
    // -------------------------------------------------------------------

    fn index_of(rel: &str, sources: &[&str]) -> HashMap<String, Vec<String>> {
        HashMap::from([(
            rel.to_string(),
            sources.iter().map(|s| (*s).to_string()).collect(),
        )])
    }

    #[test]
    fn test_update_backlinks_places_region_without_anchors() {
        let dir = temp_dir("update_no_anchor");
        write_page(&dir, "foo.md", "Foo");
        let page = make_page(
            &dir,
            "target.md",
            &page_text("Target", "", "# Target\n\nBody."),
        );
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect("update");
        assert_eq!(updated, 1);

        let text = fs::read_to_string(dir.join("target.md")).unwrap();
        let stored = document(&text);
        assert_eq!(
            stored.body.author(),
            "# Target\n\nBody.",
            "author text stays untouched"
        );
        assert_eq!(
            stored.body.backlinks().unwrap(),
            "> 此节由 zwiki 自动维护，请勿手动编辑。\n\n- [Foo](foo.md)"
        );
    }

    #[test]
    fn test_update_backlinks_places_region_before_references() {
        let dir = temp_dir("update_before_refs");
        write_page(&dir, "foo.md", "Foo");
        let page = make_page(
            &dir,
            "target.md",
            &page_text(
                "Target",
                "",
                "# Target\n\nIntro.\n\n## References\n\n- `bar.md`",
            ),
        );
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect("update");
        assert_eq!(updated, 1);

        let text = fs::read_to_string(dir.join("target.md")).unwrap();
        let stored = document(&text);
        assert!(stored.body.backlinks().is_some());
        assert_eq!(
            stored.body.author(),
            "# Target\n\nIntro.\n\n## References\n\n- `bar.md`"
        );
        let backlinks_at = text.find("## Backlinks").unwrap();
        let references_at = text.find("## References").unwrap();
        assert!(backlinks_at < references_at);
    }

    #[test]
    fn test_update_backlinks_replaces_existing_region() {
        let dir = temp_dir("update_existing");
        write_page(&dir, "foo.md", "Foo");
        write_page(&dir, "new.md", "New Source");
        let page = make_page(
            &dir,
            "target.md",
            &page_text(
                "Target",
                "",
                "# Target\n\n## Backlinks\n\n- [Old](old.md)",
            ),
        );
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md", "new.md"]),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect("update");
        assert_eq!(updated, 1);

        let text = fs::read_to_string(dir.join("target.md")).unwrap();
        let stored = document(&text);
        assert_eq!(
            stored.body.author(),
            "# Target",
            "the old region belongs to the model, not the author"
        );
        assert_eq!(
            stored.body.backlinks().unwrap(),
            "> 此节由 zwiki 自动维护，请勿手动编辑。\n\n\
             - [Foo](foo.md)\n- [New Source](new.md)"
        );
    }

    #[test]
    fn test_update_backlinks_removes_stale_region() {
        let dir = temp_dir("update_remove");
        let page = make_page(
            &dir,
            "target.md",
            &page_text(
                "Target",
                "",
                "# Target\n\n## Backlinks\n\n- [Old](old.md)",
            ),
        );
        let updated = update_backlinks(
            &HashMap::new(),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect("update");
        assert_eq!(updated, 1);

        let text = fs::read_to_string(dir.join("target.md")).unwrap();
        assert!(!text.contains("## Backlinks"));
        assert_eq!(document(&text).body.author(), "# Target");
    }

    #[test]
    fn test_update_backlinks_skips_page_without_changes() {
        let dir = temp_dir("update_noop");
        // A rewrite must not touch a page that needs no change.
        let text = "---\nstatus: draft\ntimeliness: current\ntitle: Target\n\
                    type: concept\ntags: []\n\
                    last_validated: 2026-07-01T00:00:00Z\n---\n\n\
                    # Target\n\nBody.\n";
        let page = make_page(&dir, "target.md", text);
        let updated = update_backlinks(
            &HashMap::new(),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect("update");
        assert_eq!(updated, 0);
        assert_eq!(
            fs::read_to_string(dir.join("target.md")).unwrap(),
            text,
            "a page without changes must not be written"
        );
    }

    #[test]
    fn test_update_backlinks_is_idempotent() {
        let dir = temp_dir("update_idempotent");
        write_page(&dir, "foo.md", "Foo");
        let text = page_text("Target", "", "# Target\n\nBody.");
        make_page(&dir, "target.md", &text);
        let index = index_of("target.md", &["foo.md"]);

        let first = {
            let pages = vec![make_page(&dir, "target.md", &text)];
            update_backlinks(&index, &titles_of(&dir), &pages, &no_bundles())
                .expect("first update")
        };
        assert_eq!(first, 1);
        let after_first = fs::read_to_string(dir.join("target.md")).unwrap();

        let pages = vec![make_page(&dir, "target.md", &after_first)];
        let second =
            update_backlinks(&index, &titles_of(&dir), &pages, &no_bundles())
                .expect("second update");
        assert_eq!(second, 0);
        assert_eq!(
            fs::read_to_string(dir.join("target.md")).unwrap(),
            after_first
        );
    }

    #[test]
    fn test_update_backlinks_reports_write_error() {
        let dir = temp_dir("update_write_error");
        write_page(&dir, "foo.md", "Foo");
        let page = make_page(
            &dir,
            "target.md",
            &page_text("Target", "", "# Target\n\nBody."),
        );
        // The atomic writer stores through a `target.md.tmp` sibling; a
        // directory at that path rejects the write.
        fs::create_dir(dir.join("target.md.tmp")).unwrap();

        let error = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &no_bundles(),
        )
        .expect_err("a rejected write must fail the update");
        assert!(
            error.contains("target.md"),
            "error must name the page: {error}"
        );
    }

    // -------------------------------------------------------------------
    // Bundle path resolution
    // -------------------------------------------------------------------

    #[test]
    fn test_is_valid_wiki_target_finds_bundle_file() {
        let dir = temp_dir("bundle_valid");
        write_bundle_manifest(&dir, "core");
        write(
            &dir.join("core").join("shared").join("concepts").join("foo.md"),
            "# Foo",
        );
        let bundles = wiki::BundleSet::discover(&dir);
        assert!(is_valid_wiki_target(&dir, "shared/concepts/foo.md", &bundles));
    }

    #[test]
    fn test_is_valid_wiki_target_finds_nested_bundle_file() {
        let dir = temp_dir("bundle_nested");
        write_bundle_manifest(&dir, "myorg");
        write(&dir.join("myorg").join("shared").join("bar.md"), "# Bar");
        let bundles = wiki::BundleSet::discover(&dir);
        assert!(is_valid_wiki_target(&dir, "shared/bar.md", &bundles));
    }

    #[test]
    fn test_is_valid_wiki_target_finds_deep_bundle_file() {
        let dir = temp_dir("bundle_deep");
        write_bundle_manifest(&dir, "up");
        write(&dir.join("up").join("docs").join("baz.md"), "# Baz");
        let bundles = wiki::BundleSet::discover(&dir);
        assert!(is_valid_wiki_target(&dir, "docs/baz.md", &bundles));
    }

    #[test]
    fn test_is_valid_wiki_target_bundle_nonexistent_rejected() {
        let dir = temp_dir("bundle_nonexistent");
        let bundles = wiki::BundleSet::discover(&dir);
        assert!(!is_valid_wiki_target(
            &dir,
            "shared/concepts/nonexistent.md",
            &bundles
        ));
    }

    #[test]
    fn test_is_valid_wiki_target_ignores_manifest_dir_without_manifest() {
        let dir = temp_dir("bundle_no_manifest");
        write(&dir.join("core").join("shared").join("foo.md"), "# Foo");
        let bundles = wiki::BundleSet::discover(&dir);
        assert_eq!(bundles.names().count(), 0);
        assert!(!is_valid_wiki_target(&dir, "shared/foo.md", &bundles));
    }

    // -------------------------------------------------------------------
    // build_reverse_index with bundle structure
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_bundle_structure() {
        let dir = temp_dir("rev_bundle");
        write_bundle_manifest(&dir, "core");
        let pages = vec![
            make_page(
                &dir,
                "core/shared/concepts/a.md",
                &page_text("Page A", "", "See [B](shared/concepts/b.md)."),
            ),
            make_page(
                &dir,
                "core/shared/concepts/b.md",
                &page_text("Page B", "", "No links."),
            ),
        ];
        let bundles = wiki::BundleSet::discover(&dir);
        let index = build_reverse_index(&dir, &pages, &bundles);
        assert_eq!(
            index,
            HashMap::from([(
                "core/shared/concepts/b.md".to_string(),
                vec!["core/shared/concepts/a.md".to_string()]
            )]),
            "keys use the full page.rel form"
        );
    }

    // -------------------------------------------------------------------
    // BundleSet::strip_prefix
    // -------------------------------------------------------------------

    #[test]
    fn test_strip_prefix_normal() {
        let dir = temp_dir("strip_prefix_normal");
        write_bundle_manifest(&dir, "core");
        write_bundle_manifest(&dir, "myorg");
        let bundles = wiki::BundleSet::discover(&dir);
        assert_eq!(
            bundles.strip_prefix("core/shared/concepts/foo.md"),
            Some("shared/concepts/foo.md")
        );
        assert_eq!(
            bundles.strip_prefix("myorg/docs/bar.md"),
            Some("docs/bar.md")
        );
    }

    #[test]
    fn test_strip_prefix_no_prefix() {
        let dir = temp_dir("strip_prefix_none");
        write_bundle_manifest(&dir, "core");
        let bundles = wiki::BundleSet::discover(&dir);
        assert_eq!(bundles.strip_prefix("index.md"), None);
        assert_eq!(bundles.strip_prefix("notes/other.md"), None);
    }

    // -------------------------------------------------------------------
    // build_reverse_index — multi-bundle collision
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_multi_bundle_collision() {
        let dir = temp_dir("rev_multi_bundle");
        write_bundle_manifest(&dir, "core");
        write_bundle_manifest(&dir, "other");
        let pages = vec![
            make_page(
                &dir,
                "core/shared/concepts/target.md",
                &page_text("Target Core", "", "No links."),
            ),
            make_page(
                &dir,
                "other/shared/concepts/target.md",
                &page_text("Target Other", "", "No links."),
            ),
            make_page(
                &dir,
                "core/docs/link_source.md",
                &page_text(
                    "Link Source",
                    "",
                    "Links to [target](shared/concepts/target.md).",
                ),
            ),
        ];
        let bundles = wiki::BundleSet::discover(&dir);
        let index = build_reverse_index(&dir, &pages, &bundles);

        let source = "core/docs/link_source.md".to_string();
        assert_eq!(
            index,
            HashMap::from([
                (
                    "core/shared/concepts/target.md".to_string(),
                    vec![source.clone()]
                ),
                ("other/shared/concepts/target.md".to_string(), vec![source]),
            ]),
            "both bundle-specific targets get the referrer"
        );
    }

    // -------------------------------------------------------------------
    // title_case
    // -------------------------------------------------------------------

    #[test]
    fn test_title_case_basic() {
        assert_eq!(title_case("hello-world"), "Hello World");
    }

    #[test]
    fn test_title_case_single_word() {
        assert_eq!(title_case("hello"), "Hello");
    }

    #[test]
    fn test_title_case_already_spaced() {
        assert_eq!(title_case("hello world"), "Hello World");
    }

    #[test]
    fn test_title_case_empty() {
        assert_eq!(title_case(""), "");
    }

    // -------------------------------------------------------------------
    // page_title_from_rel
    // -------------------------------------------------------------------

    #[test]
    fn test_page_title_from_rel_reads_frontmatter_title() {
        let dir = temp_dir("title_frontmatter");
        write_page(&dir, "page.md", "Frontmatter Title");
        assert_eq!(
            page_title_from_rel("page.md", &dir).expect("title"),
            "Frontmatter Title"
        );
    }

    #[test]
    fn test_page_title_from_rel_falls_back_to_stem() {
        let dir = temp_dir("title_stem");
        write(&dir.join("no-title.md"), "---\ntype: concept\n---\n\nBody.\n");
        assert_eq!(
            page_title_from_rel("no-title.md", &dir).expect("title"),
            "No Title"
        );
    }

    #[test]
    fn test_page_title_from_rel_reports_missing_file() {
        let dir = temp_dir("title_missing");
        assert!(page_title_from_rel("missing.md", &dir).is_err());
    }

    // -------------------------------------------------------------------
    // build_backlinks_for — equivalence with build_reverse_index + filter
    // -------------------------------------------------------------------

    fn setup_backlinks_pages(dir: &Path) {
        write_page(dir, "target.md", "Target");
        write_page(dir, "other.md", "Other");
        write(
            &dir.join("page_a.md"),
            &page_text(
                "Page A",
                "",
                "See also [Target](target.md) for details.",
            ),
        );
        write(
            &dir.join("page_b.md"),
            &page_text(
                "Page B",
                "",
                "Refer to `target.md` for the definition.",
            ),
        );
        write(
            &dir.join("page_c.md"),
            &page_text("Page C", "", "See [Other](other.md)."),
        );
    }

    fn discover_pages_backlinks(base: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = walkdir::WalkDir::new(base)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
            })
            .map(|e| e.path().to_path_buf())
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn test_build_backlinks_for_matches_full_index() {
        let dir = temp_dir("backlinks_for");
        setup_backlinks_pages(&dir);
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> = paths
            .iter()
            .map(|p| wiki::read_page_at(p, &dir).expect("valid page"))
            .collect();

        let full = build_reverse_index(&dir, &pages, &no_bundles());
        let single =
            build_backlinks_for("target.md", &dir, &pages, &no_bundles());

        assert_eq!(
            HashMap::from([(
                "target.md".to_string(),
                full["target.md"].clone()
            )]),
            single
        );
        assert_eq!(
            single["target.md"],
            vec!["page_a.md".to_string(), "page_b.md".to_string()]
        );
    }

    #[test]
    fn test_build_backlinks_for_nonexistent_target() {
        let dir = temp_dir("backlinks_for_nonexist");
        setup_backlinks_pages(&dir);
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> = paths
            .iter()
            .map(|p| wiki::read_page_at(p, &dir).expect("valid page"))
            .collect();
        let result =
            build_backlinks_for("nonexistent.md", &dir, &pages, &no_bundles());
        assert!(result.is_empty());
    }

    #[test]
    fn test_build_backlinks_for_no_references() {
        let dir = temp_dir("backlinks_for_noref");
        write(
            &dir.join("page_a.md"),
            &page_text("Page A", "", "See [Target](target.md)."),
        );
        write_page(&dir, "target.md", "Target");
        let paths = discover_pages_backlinks(&dir);
        let pages: Vec<wiki::Page> = paths
            .iter()
            .map(|p| wiki::read_page_at(p, &dir).expect("valid page"))
            .collect();
        let result =
            build_backlinks_for("target.md", &dir, &pages, &no_bundles());
        assert_eq!(result["target.md"], vec!["page_a.md".to_string()]);
    }
}
