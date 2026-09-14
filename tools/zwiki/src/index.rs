//! Index generation — regenerate the body of index files from page
//! frontmatter and domain metadata.
//!
//! An index file's frontmatter is authored by the user; its body below the
//! frontmatter is fully generated.  A domain index (`<domain>/index.md`)
//! lists the pages of one domain grouped by type; a bundle root index
//! (`<root>/index.md`) lists the domains of a writable bundle source.
//! Regeneration preserves the authored frontmatter verbatim and replaces
//! only the body, so the operation is idempotent.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::wiki;

/// Canonical page types, in index display order.
const PAGE_TYPES: &[&str] =
    &["concept", "entity", "source", "analysis", "synthesis"];

// ---------------------------------------------------------------------------
// Frontmatter-preserving body replacement
// ---------------------------------------------------------------------------

/// Lazily-compiled regex matching a YAML frontmatter delimiter line.
fn delimiter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^---[ \t\r]*$").unwrap())
}

/// Return the byte offset just past the closing `---` delimiter line of the
/// frontmatter block, or `None` when the content has no frontmatter.
fn frontmatter_end(content: &str) -> Option<usize> {
    let mut delimiters = delimiter_re().find_iter(content);
    let opening = delimiters.next()?;
    if opening.start() != 0 {
        return None;
    }
    delimiters.next().map(|closing| closing.end())
}

/// Seed frontmatter for an index file that does not exist yet.
fn default_frontmatter(title: &str) -> String {
    format!("---\ntitle: {title}\n---")
}

/// Replace the body of `existing` with `body`, preserving the authored
/// frontmatter verbatim.
fn with_generated_body(existing: &str, body: &str) -> String {
    let body_block =
        if body.is_empty() { String::new() } else { format!("{body}\n") };
    match frontmatter_end(existing) {
        Some(end) => format!("{}\n\n{body_block}", &existing[..end]),
        None => body_block,
    }
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

/// Read a non-empty string frontmatter field.
fn fm_string(
    frontmatter: &HashMap<String, Value>,
    key: &str,
) -> Option<String> {
    frontmatter
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

/// Map a page's first path component to its canonical type name.
fn type_from_dir(rel: &str) -> String {
    let first = rel.split('/').next().unwrap_or("");
    match first {
        "concepts" => "concept".to_string(),
        "entities" => "entity".to_string(),
        "sources" => "source".to_string(),
        "analysis" => "analysis".to_string(),
        "syntheses" => "synthesis".to_string(),
        other => other.to_string(),
    }
}

/// Resolve a page's type, falling back to its directory when frontmatter
/// carries no `type` field.
fn page_type(frontmatter: &HashMap<String, Value>, rel: &str) -> String {
    fm_string(frontmatter, "type").unwrap_or_else(|| type_from_dir(rel))
}

/// Render the ` — description` suffix for an index entry.
fn description_suffix(description: Option<&String>) -> String {
    description.map_or_else(String::new, |s| format!(" — {s}"))
}

// ---------------------------------------------------------------------------
// Domain body
// ---------------------------------------------------------------------------

/// A single page entry in a generated domain index.
struct PageEntry {
    title: String,
    rel: String,
    description: Option<String>,
}

/// Build the generated body of a domain index from the domain's pages.
///
/// Pages are grouped by type under `## <type>` headings in canonical order
/// and each group is sorted alphabetically by title.
fn build_domain_body(domain_dir: &Path) -> String {
    let mut groups: BTreeMap<String, Vec<PageEntry>> = BTreeMap::new();

    for path in wiki::discover_pages(domain_dir) {
        let Some(page) = wiki::read_page_at(&path, domain_dir) else {
            continue;
        };
        let rel = path
            .strip_prefix(domain_dir)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let title = fm_string(&page.frontmatter, "title")
            .unwrap_or_else(|| "Untitled".to_string());
        let description = fm_string(&page.frontmatter, "description");
        let page_type = page_type(&page.frontmatter, &rel);
        groups.entry(page_type).or_default().push(PageEntry {
            title,
            rel,
            description,
        });
    }

    // Canonical types first, then any remaining types alphabetically.
    let mut ordered: Vec<(String, Vec<PageEntry>)> = Vec::new();
    for page_type in PAGE_TYPES {
        if let Some(entries) = groups.remove(*page_type) {
            ordered.push(((*page_type).to_string(), entries));
        }
    }
    ordered.extend(groups);

    let mut sections: Vec<String> = Vec::new();
    for (page_type, mut entries) in ordered {
        entries.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| a.rel.cmp(&b.rel))
        });
        let mut section = format!("## {page_type}\n");
        for entry in &entries {
            let _ = write!(
                section,
                "\n- [{}]({}){}",
                entry.title,
                entry.rel,
                description_suffix(entry.description.as_ref())
            );
        }
        sections.push(section);
    }

    sections.join("\n\n")
}

/// Regenerate `<domain_dir>/index.md` from the domain's pages.
///
/// The authored frontmatter is preserved verbatim; only the body is
/// replaced.  Returns `true` when the file changed.
///
/// # Errors
///
/// Returns an error when the generated index cannot be written.
#[must_use = "the returned change flag should be handled"]
pub fn regenerate_domain_index(domain_dir: &Path) -> Result<bool, String> {
    let index_path = domain_dir.join("index.md");
    let domain =
        domain_dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let existing = std::fs::read_to_string(&index_path).ok();
    let base = existing.clone().unwrap_or_else(|| default_frontmatter(domain));
    let updated = with_generated_body(&base, &build_domain_body(domain_dir));

    if existing.as_deref() == Some(updated.as_str()) {
        return Ok(false);
    }

    zutil::fileio::write_atomic(&index_path, &updated).map_err(|e| {
        format!("无法写入领域索引 {}: {e}", index_path.display())
    })?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Bundle root body
// ---------------------------------------------------------------------------

/// Whether a top-level directory name denotes a domain.  Directories that
/// are bundles (contain `bundle.toml`) are aggregated installs, not domains.
fn is_domain_dir(root: &Path, name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !wiki::EXCLUDED_DIRS.contains(&name)
        && !root.join(name).join("bundle.toml").is_file()
}

/// List the domain directories directly under `root`, sorted by name.
fn discover_domain_dirs(root: &Path) -> Vec<String> {
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read_dir
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_domain_dir(root, n))
        .collect();
    names.sort();
    names
}

/// List the root-level page files (`*.md`) directly under `root`, sorted
/// by file name.  Meta files (`index.md`, `SCHEMA.md`) and pages under
/// excluded directories are filtered out.
fn discover_root_pages(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = wiki::discover_pages(root)
        .into_iter()
        .filter(|p| {
            p.strip_prefix(root).is_ok_and(|rel| rel.components().count() == 1)
        })
        .filter_map(|p| {
            p.file_name().and_then(|n| n.to_str()).map(ToString::to_string)
        })
        .collect();
    names.sort();
    names
}

/// Read the authored `title` and `description` from a page frontmatter.
fn page_title_description(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let frontmatter = wiki::parse_frontmatter(&content);
    (fm_string(&frontmatter, "title"), fm_string(&frontmatter, "description"))
}

/// Build the generated body of a bundle root index from its domains and
/// root-level pages.
fn build_bundle_root_body(root: &Path) -> String {
    let mut lines: Vec<String> = Vec::new();
    for domain in discover_domain_dirs(root) {
        let (title, description) =
            page_title_description(&root.join(&domain).join("index.md"));
        let title = title.unwrap_or_else(|| domain.clone());
        lines.push(format!(
            "- [{title}]({domain}/index.md){}",
            description_suffix(description.as_ref())
        ));
    }
    for page in discover_root_pages(root) {
        let (title, description) = page_title_description(&root.join(&page));
        let title = title.unwrap_or_else(|| page.clone());
        lines.push(format!(
            "- [{title}]({page}){}",
            description_suffix(description.as_ref())
        ));
    }
    lines.join("\n")
}

/// Regenerate `<root>/index.md` from the root's domains.
///
/// The authored frontmatter is preserved verbatim; only the body is
/// replaced.  Returns `true` when the file changed.
///
/// # Errors
///
/// Returns an error when the generated index cannot be written.
#[must_use = "the returned change flag should be handled"]
pub fn regenerate_bundle_root_index(root: &Path) -> Result<bool, String> {
    let index_path = root.join("index.md");
    let root_name =
        root.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let existing = std::fs::read_to_string(&index_path).ok();
    let base =
        existing.clone().unwrap_or_else(|| default_frontmatter(root_name));
    let updated = with_generated_body(&base, &build_bundle_root_body(root));

    if existing.as_deref() == Some(updated.as_str()) {
        return Ok(false);
    }

    zutil::fileio::write_atomic(&index_path, &updated)
        .map_err(|e| format!("无法写入根索引 {}: {e}", index_path.display()))?;
    Ok(true)
}

/// Regenerate every domain index under a writable bundle source and its
/// bundle root index.  Failures are reported (unless suppressed) without
/// aborting the caller.
///
/// A root carrying `zwiki.lock` is an installed store, not a bundle source,
/// so its store root index is left to the bundle commands.
pub fn regenerate_all_indexes(root: &Path, suppress_eprint: bool) {
    for domain in discover_domain_dirs(root) {
        if let Err(e) = regenerate_domain_index(&root.join(&domain))
            && !suppress_eprint
        {
            eprintln!("警告: {e}");
        }
    }

    if root.join("zwiki.lock").exists() {
        return;
    }
    if let Err(e) = regenerate_bundle_root_index(root)
        && !suppress_eprint
    {
        eprintln!("警告: {e}");
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

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join("zwiki-test").join("index").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(path, text).expect("failed to write file");
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    // -------------------------------------------------------------------
    // regenerate_domain_index
    // -------------------------------------------------------------------

    #[test]
    fn test_domain_index_generated_from_pages() {
        let dir = temp_dir("domain_generated");
        write(
            &dir.join("concepts/beta.md"),
            "---\ntitle: Beta\ntype: concept\ndescription: Beta description\n---\n\n# Beta\n",
        );
        write(
            &dir.join("concepts/alpha.md"),
            "---\ntitle: Alpha\ntype: concept\n---\n\n# Alpha\n",
        );
        write(
            &dir.join("entities/ent.md"),
            "---\ntitle: Entity One\ntype: entity\n---\n\n# Entity One\n",
        );

        assert!(regenerate_domain_index(&dir).unwrap());
        let content = read(&dir.join("index.md"));

        // Seeded frontmatter.
        assert!(content.starts_with("---\ntitle: domain_generated\n---"));
        // Grouped by type, alphabetical by title within a group.
        let concepts = content.find("## concept").unwrap();
        let entities = content.find("## entity").unwrap();
        assert!(concepts < entities, "canonical type order");
        let alpha = content.find("- [Alpha](concepts/alpha.md)").unwrap();
        let beta = content
            .find("- [Beta](concepts/beta.md) — Beta description")
            .unwrap();
        assert!(alpha < beta, "alphabetical by title");
        // Title-only entry when no description.
        assert!(content.contains("- [Entity One](entities/ent.md)"));
        assert!(!content.contains("Entity One](entities/ent.md) —"));
    }

    #[test]
    fn test_domain_index_preserves_authored_frontmatter() {
        let dir = temp_dir("domain_preserve");
        let frontmatter = "---\ntitle: Custom Title\ndescription: Domain description\ncustom: keep-me\n---\n";
        write(
            &dir.join("index.md"),
            &format!(
                "{frontmatter}\n## concept\n\n- [Stale](concepts/gone.md)\n"
            ),
        );
        write(
            &dir.join("concepts/live.md"),
            "---\ntitle: Live\ntype: concept\n---\n\n# Live\n",
        );

        assert!(regenerate_domain_index(&dir).unwrap());
        let content = read(&dir.join("index.md"));

        assert!(
            content.starts_with(frontmatter),
            "authored frontmatter must be preserved verbatim:\n{content}"
        );
        assert!(content.contains("- [Live](concepts/live.md)"));
        assert!(
            !content.contains("Stale"),
            "stale body must be replaced:\n{content}"
        );
    }

    #[test]
    fn test_domain_index_regeneration_is_idempotent() {
        let dir = temp_dir("domain_idempotent");
        write(
            &dir.join("concepts/one.md"),
            "---\ntitle: One\ntype: concept\n---\n\n# One\n",
        );
        assert!(regenerate_domain_index(&dir).unwrap());
        assert!(
            !regenerate_domain_index(&dir).unwrap(),
            "second run must report no change"
        );
    }

    #[test]
    fn test_domain_index_unknown_type_gets_own_group() {
        let dir = temp_dir("domain_unknown_type");
        write(
            &dir.join("misc/odd.md"),
            "---\ntitle: Odd\ntype: custom\n---\n\n# Odd\n",
        );
        regenerate_domain_index(&dir).unwrap();
        let content = read(&dir.join("index.md"));
        assert!(content.contains("## custom"));
        assert!(content.contains("- [Odd](misc/odd.md)"));
    }

    #[test]
    fn test_domain_index_missing_type_derives_from_dir() {
        let dir = temp_dir("domain_missing_type");
        write(
            &dir.join("sources/adr/adr-1.md"),
            "---\ntitle: ADR One\n---\n\n# ADR One\n",
        );
        regenerate_domain_index(&dir).unwrap();
        let content = read(&dir.join("index.md"));
        assert!(content.contains("## source"));
        assert!(content.contains("- [ADR One](sources/adr/adr-1.md)"));
    }

    // -------------------------------------------------------------------
    // regenerate_bundle_root_index
    // -------------------------------------------------------------------

    #[test]
    fn test_bundle_root_lists_domains_with_descriptions() {
        let dir = temp_dir("root_domains");
        write(
            &dir.join("alpha/index.md"),
            "---\ntitle: Alpha Domain\ndescription: First domain\n---\n",
        );
        write(&dir.join("beta/index.md"), "---\ntitle: Beta Domain\n---\n");
        // Reserved, hidden, and bundle directories are not domains.
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::create_dir_all(dir.join(".cache")).unwrap();
        fs::create_dir_all(dir.join("installed")).unwrap();
        fs::write(dir.join("installed").join("bundle.toml"), ".").unwrap();

        assert!(regenerate_bundle_root_index(&dir).unwrap());
        let content = read(&dir.join("index.md"));

        assert!(
            content.contains("- [Alpha Domain](alpha/index.md) — First domain")
        );
        assert!(content.contains("- [Beta Domain](beta/index.md)"));
        assert!(!content.contains("logs/index.md"));
        assert!(!content.contains(".cache"));
        assert!(!content.contains("installed/index.md"));
    }

    #[test]
    fn test_bundle_root_preserves_authored_frontmatter() {
        let dir = temp_dir("root_preserve");
        let frontmatter =
            "---\ntitle: My Bundle\ndescription: Bundle description\n---\n";
        write(
            &dir.join("index.md"),
            &format!("{frontmatter}\n- [stale](stale/index.md)\n"),
        );
        write(&dir.join("real/index.md"), "---\ntitle: Real\n---\n");

        regenerate_bundle_root_index(&dir).unwrap();
        let content = read(&dir.join("index.md"));
        assert!(content.starts_with(frontmatter));
        assert!(content.contains("- [Real](real/index.md)"));
        assert!(!content.contains("stale"));
    }

    #[test]
    fn test_bundle_root_lists_root_level_pages() {
        let dir = temp_dir("root_pages");
        write(&dir.join("alpha/index.md"), "---\ntitle: Alpha Domain\n---\n");
        write(
            &dir.join("overview.md"),
            "---\ntitle: Overview\ndescription: High-level map\n---\n\nBody.\n",
        );
        write(&dir.join("notes.md"), "---\ntitle: Notes\n---\n\nBody.\n");
        // Meta files must never be listed.
        write(&dir.join("SCHEMA.md"), "---\ntitle: Schema\n---\n");

        assert!(regenerate_bundle_root_index(&dir).unwrap());
        let content = read(&dir.join("index.md"));

        // Domains come first, then root-level pages.
        let domain = content.find("- [Alpha Domain](alpha/index.md)").unwrap();
        let overview =
            content.find("- [Overview](overview.md) — High-level map").unwrap();
        let notes = content.find("- [Notes](notes.md)").unwrap();
        assert!(domain < notes, "pages follow the domain list");
        assert!(notes < overview, "pages sorted by file name");
        assert!(!content.contains("SCHEMA.md"));
        assert!(!content.contains("[index]"), "index.md excludes itself");
    }

    #[test]
    fn test_bundle_root_domain_without_title_falls_back_to_name() {
        let dir = temp_dir("root_no_title");
        fs::create_dir_all(dir.join("gamma")).unwrap();
        regenerate_bundle_root_index(&dir).unwrap();
        let content = read(&dir.join("index.md"));
        assert!(content.contains("- [gamma](gamma/index.md)"));
    }

    // -------------------------------------------------------------------
    // regenerate_all_indexes
    // -------------------------------------------------------------------

    #[test]
    fn test_regenerate_all_indexes_writes_domain_and_root() {
        let dir = temp_dir("all_indexes");
        write(
            &dir.join("alpha/concepts/one.md"),
            "---\ntitle: One\ntype: concept\n---\n\n# One\n",
        );
        regenerate_all_indexes(&dir, false);

        assert!(dir.join("alpha/index.md").exists());
        assert!(dir.join("index.md").exists());
        assert!(read(&dir.join("alpha/index.md")).contains("One"));
        assert!(read(&dir.join("index.md")).contains("alpha/index.md"));
    }

    #[test]
    fn test_regenerate_all_indexes_skips_store_root() {
        let dir = temp_dir("all_indexes_store");
        write(
            &dir.join("alpha/concepts/one.md"),
            "---\ntitle: One\ntype: concept\n---\n\n# One\n",
        );
        fs::write(dir.join("zwiki.lock"), "").unwrap();
        regenerate_all_indexes(&dir, false);

        // Domain index regenerated, but the store root index is untouched.
        assert!(dir.join("alpha/index.md").exists());
        assert!(!dir.join("index.md").exists());
    }
}
