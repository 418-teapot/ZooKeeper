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
use zwiki::identity::{PageId, link_target};

use crate::catalog::{Catalog, Resolution};
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
// is_backlink_target
// ---------------------------------------------------------------------------

/// Check whether `target` can name a backlink target.
///
/// Must be a `.md` path that is not a system file and not under `tools/`,
/// `raw/`, or `logs/`.  Paths containing `..` are rejected.  Whether the
/// path names a page is decided by the catalog, not by this check.
#[must_use]
pub fn is_backlink_target(target: &str) -> bool {
    if !Path::new(target)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return false;
    }

    if target.contains("..") {
        return false;
    }

    let p = Path::new(target);

    if let Some(name) = p.file_name().and_then(|n| n.to_str())
        && SYSTEM_FILES.contains(&name)
    {
        return false;
    }

    for component in p.components() {
        if let Some(name) = component.as_os_str().to_str()
            && EXCLUDED_DIRS.contains(&name)
        {
            return false;
        }
    }

    true
}

// ---------------------------------------------------------------------------
// extract_links
// ---------------------------------------------------------------------------

/// Extract cross-reference link targets from `document`.
///
/// Sources:
/// - Typed metadata paths: `sources`, `supersedes`, `superseded_by`, and
///   `contradictions`.  A derived page names its source pages in `sources`,
///   so a source page sees the derived pages as backlinks.  A `sources`
///   entry may be a markdown link, which names its target.
/// - Inline markdown links `[text](path.md)` in the author body
/// - Backtick-wrapped paths `` `path.md` `` in the author body
///
/// The generated `## Backlinks` region is not author text, so it never
/// feeds back into extraction.
///
/// Returns a sorted, deduplicated list of reference texts that pass
/// [`is_backlink_target`].  A reference names a page only after
/// [`Catalog::resolve`] resolves it from the referrer's bundle.
#[must_use]
pub fn extract_links(document: &PageDocument) -> Vec<String> {
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
            .map(|source| link_target(source))
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
    links.into_iter().filter(|ln| is_backlink_target(ln)).collect()
}

// ---------------------------------------------------------------------------
// build_reverse_index
// ---------------------------------------------------------------------------

/// Build the reverse-link index.
///
/// Returns a map from each target page rel to a sorted, deduplicated list
/// of the referrer page rels that link to it.  Each reference resolves to
/// one page identity through `catalog`, so a bare path never reaches a
/// second bundle.
pub fn build_reverse_index(
    catalog: &Catalog,
    pages: &[wiki::Page],
) -> HashMap<String, Vec<String>> {
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();

    for page in pages {
        let Some(referrer) = catalog.id_of(&page.rel) else {
            continue;
        };
        for text in extract_links(&page.document) {
            let Some(target) = catalog.resolve_rel(referrer, &text) else {
                continue;
            };
            reverse
                .entry(target.to_string())
                .or_default()
                .push(page.rel.clone());
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

/// The referrer rels of `target`, sorted and deduplicated.
///
/// This is more efficient than [`build_reverse_index`] when only one target
/// is needed — every page is still scanned, but no global index is built.
#[must_use]
pub fn build_backlinks_for(
    target: &PageId,
    catalog: &Catalog,
    pages: &[wiki::Page],
) -> Vec<String> {
    let mut sources: Vec<String> = Vec::new();

    for page in pages {
        let Some(referrer) = catalog.id_of(&page.rel) else {
            continue;
        };
        let refers_to_target = extract_links(&page.document).iter().any(|t| {
            matches!(catalog.resolve(referrer, t), Resolution::Found(id) if &id == target)
        });
        if refers_to_target {
            sources.push(page.rel.clone());
        }
    }

    sources.sort();
    sources.dedup();
    sources
}

// ---------------------------------------------------------------------------
// format_backlinks_content
// ---------------------------------------------------------------------------

/// Format the generated `## Backlinks` content for `sources`.
///
/// The model owns the heading, so the content is the maintenance note
/// followed by one list entry per source page.  Titles come from `titles`,
/// which maps each source rel to its page title.  Each entry names the
/// source page: a page of the target's bundle by its bundle-relative path,
/// a page of another bundle by its `@bundle` path.
#[must_use]
pub fn format_backlinks_content(
    sources: &[String],
    target: &PageId,
    catalog: &Catalog,
    titles: &HashMap<String, String>,
) -> String {
    let mut lines = vec![
        String::from("> 此节由 zwiki 自动维护，请勿手动编辑。"),
        String::new(),
    ];
    for source in sources {
        let Some(id) = catalog.id_of(source) else {
            continue;
        };
        let title = titles.get(source).map_or_else(
            || source.rsplit('/').next().map(title_case).unwrap_or_default(),
            Clone::clone,
        );
        let link_target = if id.bundle() == target.bundle() {
            id.path().as_str().to_string()
        } else {
            id.to_string()
        };
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
    catalog: &Catalog,
) -> Result<usize, String> {
    let mut updated_count = 0;

    for page in pages {
        let Some(target) = catalog.id_of(&page.rel) else {
            continue;
        };
        let sources = index.get(&page.rel).cloned().unwrap_or_default();
        let content = if sources.is_empty() {
            None
        } else {
            Some(format_backlinks_content(&sources, target, catalog, titles))
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
    use crate::catalog::{Catalog, FLAT_BUNDLE};
    use std::fs;
    use std::path::PathBuf;
    use zwiki::identity::{BundleId, PagePath};

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

    /// Write a page file and return its page record.
    fn make_page(wiki_root: &Path, rel: &str, text: &str) -> wiki::Page {
        let path = write(&wiki_root.join(rel), text);
        wiki::read_page_at(&path, wiki_root).expect("page record")
    }

    /// Write a page file that only serves as a link target.
    fn write_page(wiki_root: &Path, rel: &str, title: &str) {
        write(&wiki_root.join(rel), &page_text(title, "", "Body."));
    }

    /// Mark `dir/<name>` as the root of the bundle named `name`.
    fn mark_bundle(dir: &Path, name: &str) {
        write(
            &dir.join(name).join("bundle.toml"),
            &format!(
                "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n\n\
                 [export]\ninclude = [\"**/*.md\"]\n"
            ),
        );
    }

    /// The flat catalog of every page written below `dir`.
    fn disk_catalog(dir: &Path) -> Catalog {
        Catalog::flat(wiki::PageSet::load(dir).pages())
    }

    /// The catalog of `root`, as a command builds it.
    fn catalog_of(root: &Path) -> Catalog {
        Catalog::new(root, &wiki::PageSet::load(root)).expect("catalog")
    }

    /// The identity stored at `rel`.
    fn id(catalog: &Catalog, rel: &str) -> PageId {
        catalog.id_of(rel).unwrap_or_else(|| panic!("no page at {rel}")).clone()
    }

    /// A referrer for a test that keeps no page record for the referrer.
    fn referrer() -> PageId {
        PageId::new(
            BundleId::new(FLAT_BUNDLE),
            PagePath::parse("referrer.md").expect("path"),
        )
    }

    /// The resolved target rels of `text` below `root`.
    fn links_of(root: &Path, text: &str) -> Vec<String> {
        let catalog = Catalog::flat(wiki::PageSet::load(root).pages());
        extract_links(&document(text))
            .iter()
            .filter_map(|link| catalog.resolve_rel(&referrer(), link))
            .map(ToString::to_string)
            .collect()
    }

    /// Titles of the pages currently on disk, keyed by rel.
    fn titles_of(dir: &Path) -> HashMap<String, String> {
        title_map(wiki::PageSet::load(dir).pages())
    }

    // -------------------------------------------------------------------
    // is_backlink_target
    // -------------------------------------------------------------------

    #[test]
    fn test_is_backlink_target_accepts_md() {
        assert!(is_backlink_target("test.md"));
        assert!(is_backlink_target("shared/concepts/foo.md"));
    }

    #[test]
    fn test_is_backlink_target_rejects_non_md() {
        assert!(!is_backlink_target("test.txt"));
    }

    #[test]
    fn test_is_backlink_target_rejects_dotdot() {
        assert!(!is_backlink_target("../etc/passwd.md"));
    }

    #[test]
    fn test_is_backlink_target_rejects_system_file() {
        for sys_file in SYSTEM_FILES {
            assert!(
                !is_backlink_target(sys_file),
                "expected {sys_file} to be rejected"
            );
        }
    }

    #[test]
    fn test_is_backlink_target_rejects_excluded_dirs() {
        for target in ["tools/helper.md", "raw/notes.md", "logs/2026-07.md"] {
            assert!(!is_backlink_target(target), "accepted {target}");
        }
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
    fn test_extract_links_deduplicates_and_sorts() {
        let dir = temp_dir("extract_dedup");
        write_page(&dir, "foo.md", "Foo");
        write_page(&dir, "z.md", "Z");
        write_page(&dir, "a.md", "A");
        let text = page_text("Page", "", "See [Foo](foo.md), [Foo](foo.md).");
        assert_eq!(links_of(&dir, &text), vec!["foo.md"]);
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
    fn test_extract_links_from_relations_skips_missing_target() {
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
        let pages = vec![
            make_page(
                &dir,
                "concepts/a.md",
                &page_text("A", "", "See [B](concepts/b.md)."),
            ),
            make_page(&dir, "concepts/b.md", &page_text("B", "", "No links.")),
        ];
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
        assert_eq!(
            index,
            HashMap::from([(
                "concepts/b.md".to_string(),
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
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
        assert!(index.is_empty());
    }

    #[test]
    fn test_build_reverse_index_keeps_self_links() {
        let dir = temp_dir("rev_self");
        let pages = vec![make_page(
            &dir,
            "a.md",
            &page_text("A", "", "See [A](a.md)."),
        )];
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
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
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
        assert_eq!(index["a.md"], vec!["b.md"]);
        assert_eq!(index["b.md"], vec!["a.md"]);
    }

    #[test]
    fn test_build_reverse_index_uses_loaded_document() {
        let dir = temp_dir("rev_loaded_doc");
        // The file on disk has no links; the loaded document does.  The
        // index must follow the document instead of reading the file again.
        let mut page =
            make_page(&dir, "a.md", &page_text("A", "", "No links."));
        page.document = document(&page_text("A", "", "See [T](b.md)."));
        let target = make_page(&dir, "b.md", &page_text("B", "", "Body."));

        let pages = vec![page, target];
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
        assert_eq!(index["b.md"], vec!["a.md"]);
    }

    #[test]
    fn test_build_reverse_index_skips_a_target_without_a_page() {
        let dir = temp_dir("rev_missing_target");
        let pages = vec![make_page(
            &dir,
            "a.md",
            &page_text("A", "", "See [Gone](gone.md)."),
        )];
        let index = build_reverse_index(&Catalog::flat(&pages), &pages);
        assert!(index.is_empty(), "a target without a page has no referrer");
    }

    // -------------------------------------------------------------------
    // build_reverse_index — bundle structure
    // -------------------------------------------------------------------

    #[test]
    fn test_build_reverse_index_bundle_structure() {
        let dir = temp_dir("rev_bundle");
        mark_bundle(&dir, "core");
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
        let index = build_reverse_index(&catalog_of(&dir), &pages);
        assert_eq!(
            index,
            HashMap::from([(
                "core/shared/concepts/b.md".to_string(),
                vec!["core/shared/concepts/a.md".to_string()]
            )]),
            "keys use the full page.rel form"
        );
    }

    #[test]
    fn test_build_reverse_index_keeps_bundles_apart() {
        let dir = temp_dir("rev_two_bundles");
        mark_bundle(&dir, "core");
        mark_bundle(&dir, "vendor");
        let pages = vec![
            make_page(
                &dir,
                "core/shared/concepts/target.md",
                &page_text("Target Core", "", "No links."),
            ),
            make_page(
                &dir,
                "vendor/shared/concepts/target.md",
                &page_text("Target Vendor", "", "No links."),
            ),
            make_page(
                &dir,
                "core/docs/linker.md",
                &page_text(
                    "Linker",
                    "",
                    "See [target](shared/concepts/target.md).",
                ),
            ),
        ];
        let index = build_reverse_index(&catalog_of(&dir), &pages);
        assert_eq!(
            index,
            HashMap::from([(
                "core/shared/concepts/target.md".to_string(),
                vec!["core/docs/linker.md".to_string()]
            )]),
            "a bare reference names the page of the referrer's bundle only"
        );
    }

    #[test]
    fn test_build_reverse_index_follows_an_explicit_reference() {
        let dir = temp_dir("rev_explicit_bundle");
        mark_bundle(&dir, "core");
        mark_bundle(&dir, "vendor");
        let pages = vec![
            make_page(
                &dir,
                "core/shared/concepts/target.md",
                &page_text("Target Core", "", "No links."),
            ),
            make_page(
                &dir,
                "vendor/shared/concepts/target.md",
                &page_text("Target Vendor", "", "No links."),
            ),
            make_page(
                &dir,
                "core/docs/linker.md",
                &page_text(
                    "Linker",
                    "",
                    "See [target](@vendor/shared/concepts/target.md).",
                ),
            ),
        ];
        let index = build_reverse_index(&catalog_of(&dir), &pages);
        assert_eq!(
            index,
            HashMap::from([(
                "vendor/shared/concepts/target.md".to_string(),
                vec!["core/docs/linker.md".to_string()]
            )]),
            "an explicit reference names the page of that bundle only"
        );
    }

    #[test]
    fn test_build_reverse_index_follows_a_markdown_link_source() {
        // A `sources` entry may carry a markdown link.  The bare link and
        // the explicit bundle link name the same page.
        let dir = temp_dir("rev_markdown_link_source");
        mark_bundle(&dir, "core");
        mark_bundle(&dir, "vendor");
        let pages = vec![
            make_page(
                &dir,
                "vendor/shared/concepts/target.md",
                &page_text("Target", "", "No links."),
            ),
            make_page(
                &dir,
                "vendor/docs/bare.md",
                &page_text(
                    "Bare",
                    "sources:\n  - \"[Target](shared/concepts/target.md)\"\n",
                    "No links.",
                ),
            ),
            make_page(
                &dir,
                "core/docs/explicit.md",
                &page_text(
                    "Explicit",
                    "sources:\n  - \"[Target](@vendor/shared/concepts/target.md)\"\n",
                    "No links.",
                ),
            ),
        ];
        let index = build_reverse_index(&catalog_of(&dir), &pages);
        assert_eq!(
            index,
            HashMap::from([(
                "vendor/shared/concepts/target.md".to_string(),
                vec![
                    "core/docs/explicit.md".to_string(),
                    "vendor/docs/bare.md".to_string()
                ]
            )]),
            "both spellings of the link name one target"
        );
    }

    // -------------------------------------------------------------------
    // format_backlinks_content
    // -------------------------------------------------------------------

    #[test]
    fn test_format_backlinks_content_lists_sources() {
        let dir = temp_dir("fmt_basic");
        let pages = vec![make_page(
            &dir,
            "src.md",
            &page_text("Source Page", "", "Body."),
        )];
        let catalog = Catalog::flat(&pages);
        let sources = vec![String::from("src.md")];
        let content = format_backlinks_content(
            &sources,
            &id(&catalog, "src.md"),
            &catalog,
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
        mark_bundle(&dir, "core");
        let pages = vec![make_page(
            &dir,
            "core/docs/a.md",
            &page_text("Page A", "", "Body."),
        )];
        let catalog = catalog_of(&dir);
        let sources = vec![String::from("core/docs/a.md")];
        let content = format_backlinks_content(
            &sources,
            &id(&catalog, "core/docs/a.md"),
            &catalog,
            &title_map(&pages),
        );
        assert!(
            content.ends_with("- [Page A](docs/a.md)"),
            "a page of the target's bundle keeps its bundle-relative link: \
             {content}"
        );
    }

    #[test]
    fn test_format_backlinks_content_marks_a_foreign_bundle() {
        let dir = temp_dir("fmt_cross_bundle");
        mark_bundle(&dir, "core");
        mark_bundle(&dir, "vendor");
        write_page(&dir, "vendor/docs/b.md", "Page B");
        let pages = vec![make_page(
            &dir,
            "core/docs/a.md",
            &page_text("Page A", "", "Body."),
        )];
        let catalog = catalog_of(&dir);
        let sources = vec![String::from("core/docs/a.md")];
        let content = format_backlinks_content(
            &sources,
            &id(&catalog, "vendor/docs/b.md"),
            &catalog,
            &title_map(&pages),
        );
        assert!(
            content.ends_with("- [Page A](@core/docs/a.md)"),
            "a page of another bundle carries its bundle name: {content}"
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
        let catalog = disk_catalog(&dir);
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &catalog,
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
        let catalog = disk_catalog(&dir);
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &catalog,
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
        let catalog = disk_catalog(&dir);
        let updated = update_backlinks(
            &index_of("target.md", &["foo.md", "new.md"]),
            &titles_of(&dir),
            &[page],
            &catalog,
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
        let catalog = disk_catalog(&dir);
        let updated = update_backlinks(
            &HashMap::new(),
            &titles_of(&dir),
            &[page],
            &catalog,
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
        let catalog = disk_catalog(&dir);
        let updated = update_backlinks(
            &HashMap::new(),
            &titles_of(&dir),
            &[page],
            &catalog,
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
            let catalog = disk_catalog(&dir);
            update_backlinks(&index, &titles_of(&dir), &pages, &catalog)
                .expect("first update")
        };
        assert_eq!(first, 1);
        let after_first = fs::read_to_string(dir.join("target.md")).unwrap();

        let pages = vec![make_page(&dir, "target.md", &after_first)];
        let catalog = disk_catalog(&dir);
        let second =
            update_backlinks(&index, &titles_of(&dir), &pages, &catalog)
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
        let catalog = disk_catalog(&dir);
        // The atomic writer stores through a `target.md.tmp` sibling; a
        // directory at that path rejects the write.
        fs::create_dir(dir.join("target.md.tmp")).unwrap();

        let error = update_backlinks(
            &index_of("target.md", &["foo.md"]),
            &titles_of(&dir),
            &[page],
            &catalog,
        )
        .expect_err("a rejected write must fail the update");
        assert!(
            error.contains("target.md"),
            "error must name the page: {error}"
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
    // build_backlinks_for
    // -------------------------------------------------------------------

    #[test]
    fn test_build_backlinks_for_matches_full_index() {
        let dir = temp_dir("backlinks_for");
        write_page(&dir, "target.md", "Target");
        write_page(&dir, "other.md", "Other");
        let pages = vec![
            make_page(
                &dir,
                "page_a.md",
                &page_text(
                    "Page A",
                    "",
                    "See also [Target](target.md) for details.",
                ),
            ),
            make_page(
                &dir,
                "page_b.md",
                &page_text(
                    "Page B",
                    "",
                    "Refer to `target.md` for the definition.",
                ),
            ),
            make_page(
                &dir,
                "page_c.md",
                &page_text("Page C", "", "See [Other](other.md)."),
            ),
            make_page(&dir, "target.md", &page_text("Target", "", "Body.")),
        ];
        let catalog = Catalog::flat(&pages);

        let full = build_reverse_index(&catalog, &pages);
        let single =
            build_backlinks_for(&id(&catalog, "target.md"), &catalog, &pages);

        assert_eq!(single, full["target.md"]);
        assert_eq!(
            single,
            vec!["page_a.md".to_string(), "page_b.md".to_string()]
        );
    }

    #[test]
    fn test_build_backlinks_for_nonexistent_target() {
        let dir = temp_dir("backlinks_for_nonexist");
        write_page(&dir, "target.md", "Target");
        let pages = vec![make_page(
            &dir,
            "page_a.md",
            &page_text("Page A", "", "See [Target](target.md)."),
        )];
        let catalog = Catalog::flat(&pages);
        let absent = PageId::new(
            BundleId::new(FLAT_BUNDLE),
            PagePath::parse("absent.md").expect("path"),
        );
        assert!(build_backlinks_for(&absent, &catalog, &pages).is_empty());
    }

    #[test]
    fn test_build_backlinks_for_no_references() {
        let dir = temp_dir("backlinks_for_noref");
        let pages = vec![
            make_page(
                &dir,
                "page_a.md",
                &page_text("Page A", "", "No references."),
            ),
            make_page(&dir, "target.md", &page_text("Target", "", "Body.")),
        ];
        let catalog = Catalog::flat(&pages);
        assert!(
            build_backlinks_for(&id(&catalog, "target.md"), &catalog, &pages)
                .is_empty()
        );
    }
}
