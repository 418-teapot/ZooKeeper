//! `zwiki move` — rename / relocate a wiki page and update all references.
//!
//! Handles both same-domain renames and cross-domain moves. Updates
//! frontmatter path fields, body inline links, body backtick references,
//! and regenerates the affected domain indexes.

use std::fs;
use std::path::Path;

use regex::Regex;

use zwiki::document::PageDocument;

use crate::catalog::Catalog;
use crate::{backlinks, document_io, wiki};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Result of a successful move operation.
#[derive(Debug)]
pub struct MoveResult {
    /// Human-readable summary: `"old → new"`.
    pub moved: String,
    /// Wiki-relative path the page now occupies.
    pub new_rel: String,
    /// Deduplicated wiki-relative paths of pages whose references were updated.
    pub updated_refs: Vec<String>,
    /// Wiki-relative paths of index.md files that were modified.
    pub updated_indexes: Vec<String>,
    /// Number of pages whose `## Backlinks` section was rewritten by the
    /// post-move rebuild.
    pub backlinks_synced: usize,
}

/// Execute a page move: rename the file, rewrite all cross-references, and
/// update domain index.md files.
///
/// `wiki_root` is the base directory of the wiki (e.g. `~/.zoo/wiki/`).
pub fn execute_move(
    wiki_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<MoveResult, String> {
    // ---- Step 1: Validation ------------------------------------------------
    validate_rel_path(old_rel)?;
    validate_rel_path(new_rel)?;

    let old_abs = wiki_root.join(old_rel);
    let new_abs = wiki_root.join(new_rel);

    // Record the destination as a root-relative path so a `.` component in
    // the user-typed argument does not leak into logs or results.
    let new_rel_recorded = new_abs
        .strip_prefix(wiki_root)
        .unwrap_or(&new_abs)
        .to_string_lossy()
        .to_string();

    if !old_abs.exists() {
        return Err(format!("源页面不存在: {old_rel}"));
    }
    if new_abs.exists() {
        return Err(format!("目标路径已存在: {new_rel}"));
    }

    // Create parent directories for the new path.
    if let Some(parent) = new_abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目标目录: {e}"))?;
    }

    // ---- Step 2: Build reverse-index BEFORE the move -----------------------
    let set = wiki::PageSet::load(wiki_root);
    let all_pages = set.require_all()?.to_vec();
    let catalog = Catalog::new(wiki_root, &set)?;
    let rev_index = backlinks::build_reverse_index(&catalog, &all_pages);

    // The reference forms are known before the move, so a target the bundle
    // cannot express fails here and leaves the page in place.
    let forms = reference_forms(&catalog, old_rel, new_rel, &new_rel_recorded)?;

    // ---- Step 3: Physical move ---------------------------------------------
    fs::rename(&old_abs, &new_abs).map_err(|e| format!("移动文件失败: {e}"))?;

    // ---- Step 4: Rewrite references in referring pages ---------------------
    let mut updated_refs: Vec<String> = Vec::new();
    if let Some(sources) = rev_index.get(old_rel) {
        for src_rel in sources {
            // Never rewrite pages inside an installed bundle: they are
            // read-only.
            if wiki::bundle_on_path(wiki_root, src_rel).is_some() {
                continue;
            }
            // Self-reference: the moved page is now at new_abs, so read from
            // there instead of the (now-gone) old location.
            let src_abs = if src_rel == old_rel {
                new_abs.clone()
            } else {
                wiki_root.join(src_rel)
            };
            if rewrite_page_references(&src_abs, &forms)
                .map_err(|e| format!("{src_rel}: {e}"))?
            {
                updated_refs.push(src_rel.clone());
            }
        }
    }
    updated_refs.sort();
    updated_refs.dedup();

    // ---- Step 5: Regenerate affected domain indexes ------------------------
    // Index bodies are generated artifacts: a move regenerates the affected
    // domain index(es) from the pages on disk instead of editing entries.
    let mut updated_indexes: Vec<String> = Vec::new();

    let old_domain = old_rel.split('/').next().unwrap_or("");
    let new_domain = new_rel.split('/').next().unwrap_or("");

    regenerate_and_record(wiki_root, old_domain, &mut updated_indexes);
    if new_domain != old_domain {
        regenerate_and_record(wiki_root, new_domain, &mut updated_indexes);
        // A move into a new domain must surface that domain in the bundle
        // root index right away, not only on the next check.
        regenerate_root_index_and_record(wiki_root, &mut updated_indexes);
    }

    updated_indexes.sort();
    updated_indexes.dedup();
    // ---- Step 6: Rebuild Backlinks sections immediately --------------------
    // The reference rewrite above used a reverse index built *before* the
    // rename, and it never touches the auto-generated `## Backlinks`
    // sections.  Rescan the wiki now and run the same sync used by
    // `zwiki check` so pages whose only stale reference lived in their
    // Backlinks section are refreshed without waiting for the next check.
    let backlinks_synced = rebuild_backlinks(wiki_root)
        .map_err(|e| format!("反向链接同步失败: {e}"))?;

    Ok(MoveResult {
        moved: format!("{old_rel} → {new_rel_recorded}"),
        new_rel: new_rel_recorded,
        updated_refs,
        updated_indexes,
        backlinks_synced,
    })
}

// ---------------------------------------------------------------------------
// Backlinks rebuild
// ---------------------------------------------------------------------------

/// Rescan `wiki_root` and synchronize every page's `## Backlinks` section,
/// reusing the same logic as `zwiki check`.
///
/// Returns the number of pages whose section changed.  Only pages whose
/// inbound links actually changed are rewritten.
fn rebuild_backlinks(wiki_root: &Path) -> Result<usize, String> {
    let set = wiki::PageSet::load(wiki_root);
    let refreshed_pages = set.require_all()?.to_vec();
    let catalog = Catalog::new(wiki_root, &set)?;
    let index = backlinks::build_reverse_index(&catalog, &refreshed_pages);
    // The reverse index is built from all pages so bundle pages still
    // contribute outbound links, but only pages outside installed bundles
    // are rewritten.
    let titles = backlinks::title_map(&refreshed_pages);
    let writable: Vec<wiki::Page> = refreshed_pages
        .into_iter()
        .filter(|p| wiki::bundle_on_path(wiki_root, &p.rel).is_none())
        .collect();
    backlinks::update_backlinks(&index, &titles, &writable, &catalog)
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/// Reject absolute paths and paths containing `..`.
pub fn validate_rel_path(path_str: &str) -> Result<(), String> {
    if Path::new(path_str).is_absolute() {
        return Err(format!("路径不能是绝对路径: {path_str}"));
    }
    if path_str.contains("..") {
        return Err(format!("路径不能包含 '..': {path_str}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reference rewriting (per-page)
// ---------------------------------------------------------------------------

/// One literal reference form of the moved page and its replacement.
struct PathForm {
    from: String,
    to: String,
    pattern: Regex,
}

impl PathForm {
    /// Prepare the rewrite of literal `from` into `to`.
    fn new(from: &str, to: &str) -> Result<Self, String> {
        let pattern = Regex::new(&regex::escape(from))
            .map_err(|e| format!("正则编译失败: {e}"))?;
        Ok(Self { from: from.to_string(), to: to.to_string(), pattern })
    }
}

/// The reference forms that name the moved page.
///
/// The bare form keeps the root-relative text.  The explicit
/// `@bundle/path` form keeps its bundle and gains the new bundle-relative
/// path.  A page of the root scope has no explicit form.  The reverse index
/// already limits the rewrite to pages that resolve to the moved page.
fn reference_forms(
    catalog: &Catalog,
    old_rel: &str,
    new_rel: &str,
    new_rel_recorded: &str,
) -> Result<Vec<PathForm>, String> {
    let mut forms = vec![PathForm::new(old_rel, new_rel)?];
    let Some(moved) = catalog.id_of(old_rel) else {
        return Ok(forms);
    };
    let Some(bundle) = moved.bundle().name() else {
        return Ok(forms);
    };
    let old_path = moved.path().as_str();
    // The bundle root is the registered rel without the page path.
    let prefix = old_rel.strip_suffix(old_path).unwrap_or_default();
    let new_path = new_rel_recorded.strip_prefix(prefix).ok_or_else(|| {
        format!("移动目标必须留在 bundle @{bundle} 内: {new_rel_recorded}")
    })?;
    forms.push(PathForm::new(
        &format!("@{bundle}/{old_path}"),
        &format!("@{bundle}/{new_path}"),
    )?);
    Ok(forms)
}

/// Rewrite every whole-token occurrence of a path form in `text`.
///
/// Boundaries are checked without consuming them, so two occurrences
/// separated by a single delimiter (e.g. `[a.md,a.md]`) are both
/// rewritten.  A boundary character is anything outside
/// `[A-Za-z0-9_./-]`; this prevents `concepts/foo.md` from matching inside
/// `concepts/foo-old.md` or `xconcepts/foo.md`.
fn rewrite_path_tokens(form: &PathForm, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in form.pattern.find_iter(text) {
        let (start, end) = (m.start(), m.end());
        let before_ok =
            text[..start].chars().next_back().is_none_or(is_path_boundary);
        let after_ok = text[end..].chars().next().is_none_or(is_path_boundary);
        if !before_ok || !after_ok {
            continue;
        }
        out.push_str(&text[last..start]);
        out.push_str(&form.to);
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

/// Whether `c` may delimit a bare path token (or be a string edge).
const fn is_path_boundary(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '/' || c == '-')
}

/// Rewrite the path values of one typed metadata field.
fn rewrite_paths<T>(
    entries: &mut Option<Vec<T>>,
    path: impl Fn(&mut T) -> &mut String,
    forms: &[PathForm],
) -> bool {
    let Some(entries) = entries else {
        return false;
    };
    let mut changed = false;
    for entry in entries {
        let value = path(entry);
        for form in forms {
            let rewritten = rewrite_path_tokens(form, value);
            if rewritten != *value {
                *value = rewritten;
                changed = true;
            }
        }
    }
    changed
}

/// Rewrite body references: markdown inline links and backtick paths.
fn rewrite_body_references(body: &str, forms: &[PathForm]) -> String {
    let mut text = body.to_string();
    for form in forms {
        text = text
            .replace(&format!("]({})", form.from), &format!("]({})", form.to));
        text = text
            .replace(&format!("`{}`", form.from), &format!("`{}`", form.to));
    }
    text
}

/// Rewrite all occurrences of the moved page in a parsed page.
///
/// Typed path fields keep their structure, so only their path values
/// change.  The author body keeps the literal replacement of markdown
/// inline links `[text](form)` and backtick-wrapped `` `form` ``.  Each
/// form keeps its shape: a bare path stays bare, `@bundle/path` stays
/// explicit.  The generated backlinks region is left for the rebuild step.
fn rewrite_document_references(
    document: &mut PageDocument,
    forms: &[PathForm],
) -> bool {
    let mut changed =
        rewrite_paths(&mut document.metadata.sources, |value| value, forms);
    changed |= rewrite_paths(
        &mut document.metadata.supersedes,
        |relation| &mut relation.path,
        forms,
    );
    changed |= rewrite_paths(
        &mut document.metadata.superseded_by,
        |relation| &mut relation.path,
        forms,
    );
    changed |= rewrite_paths(
        &mut document.metadata.contradictions,
        |record| &mut record.path,
        forms,
    );

    let author = rewrite_body_references(document.body.author(), forms);
    if author != document.body.author() {
        *document.body.author_mut() = author;
        changed = true;
    }

    changed
}

/// Rewrite the moved-page references in one page file.
///
/// The page is parsed as a document, changed in memory, rendered and
/// written atomically.  A page the model cannot parse fails the command
/// instead of being rewritten as raw text.
///
/// Returns `true` if the file was modified.
fn rewrite_page_references(
    page_abs: &Path,
    forms: &[PathForm],
) -> Result<bool, String> {
    let mut document = document_io::load(page_abs)?;
    if !rewrite_document_references(&mut document, forms) {
        return Ok(false);
    }
    document_io::store(page_abs, &document)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Domain index regeneration
// ---------------------------------------------------------------------------

/// Regenerate `domain`'s index after a move and record the wiki-relative
/// index path when the file changed.
fn regenerate_and_record(
    wiki_root: &Path,
    domain: &str,
    updated: &mut Vec<String>,
) {
    if domain.is_empty() {
        return;
    }
    let domain_dir = wiki_root.join(domain);
    let index_path = domain_dir.join("index.md");
    match crate::index::regenerate_domain_index(&domain_dir) {
        Ok(true) => {
            let rel = index_path
                .strip_prefix(wiki_root)
                .unwrap_or(&index_path)
                .to_string_lossy()
                .to_string();
            updated.push(rel);
        }
        Ok(false) => {}
        Err(e) => eprintln!("警告: {e}"),
    }
}

/// Regenerate the bundle root index after a move and record its
/// wiki-relative path when the file changed.
fn regenerate_root_index_and_record(
    wiki_root: &Path,
    updated: &mut Vec<String>,
) {
    let index_path = wiki_root.join("index.md");
    match crate::index::regenerate_bundle_root_index(wiki_root) {
        Ok(true) => {
            let rel = index_path
                .strip_prefix(wiki_root)
                .unwrap_or(&index_path)
                .to_string_lossy()
                .to_string();
            updated.push(rel);
        }
        Ok(false) => {}
        Err(e) => eprintln!("警告: {e}"),
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

    /// A temp root holding the bundle named `wiki`.
    fn wiki_root(name: &str) -> PathBuf {
        let dir = crate::bundle::testutil::temp_dir(name);
        write(
            &dir.join("bundle.toml"),
            "[package]\nname = \"wiki\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n",
        );
        dir
    }

    fn write(path: &Path, text: &str) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        fs::write(path, text).expect("failed to write file");
        path.to_path_buf()
    }

    /// Create a wiki page file with frontmatter.
    fn make_page(wiki_root: &Path, rel: &str, content: &str) -> PathBuf {
        write(&wiki_root.join(rel), content)
    }

    /// Simple frontmatter builder.
    fn fm_page(
        title: &str,
        page_type: &str,
        extra: &str,
        body: &str,
    ) -> String {
        format!(
            "---\ntitle: {title}\ntype: {page_type}\ntags: []\ntimestamp: 2025-01-01T00:00:00Z\n{extra}---\n\n{body}"
        )
    }

    /// Read the content of a file, panicking on error.
    fn read_file(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    /// The bare reference form of one move, without a catalog.
    fn bare_form(from: &str, to: &str) -> Vec<PathForm> {
        vec![PathForm::new(from, to).expect("valid form")]
    }

    // -------------------------------------------------------------------
    // Validation tests
    // -------------------------------------------------------------------

    #[test]
    fn test_validate_rejects_absolute_path() {
        assert!(validate_rel_path("/etc/passwd.md").is_err());
        assert!(validate_rel_path("/home/foo.md").is_err());
    }

    #[test]
    fn test_validate_rejects_dotdot() {
        assert!(validate_rel_path("../etc/passwd.md").is_err());
        assert!(validate_rel_path("concepts/../../foo.md").is_err());
    }

    #[test]
    fn test_validate_accepts_normal_path() {
        assert!(validate_rel_path("concepts/foo.md").is_ok());
        assert!(validate_rel_path("autoresearch/concepts/bar.md").is_ok());
        assert!(validate_rel_path("foo.md").is_ok());
    }

    // -------------------------------------------------------------------
    // Error scenarios
    // -------------------------------------------------------------------

    #[test]
    fn test_move_old_not_found() {
        let wiki_root = wiki_root("old_not_found");
        // Create a minimal wiki with a page but not the source.
        make_page(&wiki_root, "concepts/existing.md", "# Existing");
        let result = execute_move(
            &wiki_root,
            "concepts/nonexistent.md",
            "concepts/new.md",
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("源页面不存在"));
    }

    #[test]
    fn test_move_new_already_exists() {
        let wiki_root = wiki_root("new_exists");
        make_page(&wiki_root, "concepts/old.md", "# Old");
        make_page(&wiki_root, "concepts/new.md", "# New");
        let result =
            execute_move(&wiki_root, "concepts/old.md", "concepts/new.md");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("目标路径已存在"));
    }

    #[test]
    fn test_move_rejects_dotdot() {
        let wiki_root = wiki_root("dotdot");
        let result = execute_move(&wiki_root, "concepts/foo.md", "../bar.md");
        assert!(result.is_err());
    }

    #[test]
    fn test_move_rejects_absolute() {
        let wiki_root = wiki_root("absolute");
        let result = execute_move(&wiki_root, "concepts/foo.md", "/tmp/bar.md");
        assert!(result.is_err());
    }

    #[test]
    fn test_old_not_found_no_side_effects() {
        // Verify no file was created/moved when validation fails.
        let wiki_root = wiki_root("no_side_effect");
        make_page(&wiki_root, "concepts/foo.md", "# Foo");
        make_page(&wiki_root, "concepts/bar.md", "# Bar");

        let result = execute_move(
            &wiki_root,
            "concepts/nonexistent.md",
            "concepts/new.md",
        );
        assert!(result.is_err());

        // Original files should still exist.
        assert!(wiki_root.join("concepts/foo.md").exists());
        assert!(wiki_root.join("concepts/bar.md").exists());
        // New file should NOT exist.
        assert!(!wiki_root.join("concepts/new.md").exists());
    }

    // -------------------------------------------------------------------
    // Same-domain rename — basic
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_basic_rename() {
        let wiki_root = wiki_root("same_domain_basic");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        // Create the page to move.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "concept", "", "# Foo\n\nContent."),
        );
        // Create domain index.md with an entry for the page.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n\n## Entities（实体）\n\n* [Other](other.md)\n",
        );

        // Create a referencer page.
        make_page(
            &wiki_root,
            "concepts/referencer.md",
            &fm_page(
                "Referencer",
                "concept",
                "supersedes:\n  - path: concepts/foo.md\n    reason: outdated\n",
                "See [Foo](concepts/foo.md) and check `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Check file was moved.
        assert!(!wiki_root.join(old_rel).exists());
        assert!(wiki_root.join(new_rel).exists());

        // Check referencer was updated.
        let ref_content = read_file(&wiki_root.join("concepts/referencer.md"));
        assert!(
            ref_content.contains("](concepts/bar.md)"),
            "markdown link should be updated"
        );
        assert!(
            ref_content.contains("`concepts/bar.md`"),
            "backtick reference should be updated"
        );
        assert!(
            ref_content.contains("path: concepts/bar.md"),
            "supersedes path should be updated"
        );
        assert!(
            !ref_content.contains("concepts/foo.md"),
            "old path should not remain"
        );

        // The domain index is regenerated from pages, listing the new path.
        let index_content = read_file(&wiki_root.join("concepts/index.md"));
        assert!(
            index_content.contains("- [Foo](bar.md)"),
            "index should be regenerated with the new path:\n{index_content}"
        );
        assert!(
            !index_content.contains("concepts/foo.md"),
            "index should not reference old path"
        );

        // Check result metadata.
        assert!(
            result.updated_refs.contains(&"concepts/referencer.md".to_string())
        );
        assert!(
            result.updated_indexes.contains(&"concepts/index.md".to_string())
        );
        assert_eq!(result.moved, "concepts/foo.md → concepts/bar.md");
    }

    // -------------------------------------------------------------------
    // Same-domain rename — body-only references
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_body_only_references() {
        let wiki_root = wiki_root("body_only");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Referencer with only body links (no frontmatter path fields).
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "Read [Foo](concepts/foo.md) and see `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(result.updated_refs.contains(&"concepts/ref.md".to_string()));

        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.contains("](concepts/bar.md)"));
        assert!(ref_content.contains("`concepts/bar.md`"));
        assert!(!ref_content.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Same-domain rename — all frontmatter reference types
    // -------------------------------------------------------------------

    #[test]
    fn test_same_domain_all_frontmatter_types() {
        let wiki_root = wiki_root("all_fm_types");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // A page that references foo in all three path-carrying
        // frontmatter fields.
        let ref_fm = "\
supersedes:
  - path: concepts/foo.md
    reason: outdated
superseded_by:
  - path: concepts/foo.md
    reason: newer
contradictions:
  - path: concepts/foo.md
    claims:
      - claim
    detected: 2025-01-01
    resolution: unresolved
";

        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page("Ref", "concept", ref_fm, "# Ref\n\nBody.\n"),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));

        // Count occurrences of the new path to verify all three were updated.
        let count_new = ref_content.matches("concepts/bar.md").count();
        assert_eq!(
            count_new, 3,
            "all three frontmatter entries should be updated"
        );

        assert!(!ref_content.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Cross-domain move
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_move() {
        let wiki_root = wiki_root("cross_domain");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        // Create the page to move.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo Concept", "concept", "", "# Foo\n\nContent.\n"),
        );
        // Create old domain index.md.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n* [Other](other.md)\n\n## Entities（实体）\n\n* [E](e.md)\n",
        );
        // Create new domain index.md.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n\n## Syntheses（综合）\n\n* [Synth](synth.md)\n",
        );

        // Create a referencer in the old domain.
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "See [Foo](concepts/foo.md).\nRefer to `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // File moved.
        assert!(!wiki_root.join(old_rel).exists());
        assert!(wiki_root.join(new_rel).exists());

        // Referencer updated.
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.contains("](autoresearch/concepts/foo.md)"));
        assert!(ref_content.contains("`autoresearch/concepts/foo.md`"));
        // The old path is a substring of the new path, so check link patterns
        // instead of raw substring.
        assert!(
            !ref_content.contains("](concepts/foo.md)"),
            "markdown link to old path should not remain"
        );
        assert!(
            !ref_content.contains("`concepts/foo.md`"),
            "backtick reference to old path should not remain"
        );

        // Old index: regenerated from the remaining page (ref.md).
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(
            !old_index.contains("concepts/foo.md"),
            "old index should not list the moved page:\n{old_index}"
        );
        assert!(
            old_index.contains("- [Ref](ref.md)"),
            "old index should list the remaining page:\n{old_index}"
        );

        // New index: regenerated from the moved page.
        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("- [Foo Concept](concepts/foo.md)"),
            "new index should have entry for the moved page:\n{new_index}"
        );
        assert!(new_index.contains("## concept"), "type heading should exist");

        // Result metadata.
        assert!(
            result
                .updated_indexes
                .contains(&"autoresearch/index.md".to_string())
        );
        assert!(
            result.updated_indexes.contains(&"concepts/index.md".to_string())
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain move — new domain without index.md
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_move_registers_root_index() {
        let wiki_root = wiki_root("cross_domain_root_index");
        make_page(
            &wiki_root,
            "concepts/foo.md",
            &fm_page("Foo", "concept", "", "# Foo"),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        let result =
            execute_move(&wiki_root, "concepts/foo.md", "newdomain/foo.md")
                .unwrap();

        // The new domain must appear in the bundle root index immediately,
        // not only on the next check.
        let root_index = read_file(&wiki_root.join("index.md"));
        assert!(
            root_index.contains("- [newdomain](newdomain/index.md)"),
            "root index should list the new domain:\n{root_index}"
        );
        assert!(
            root_index.contains("- [concepts](concepts/index.md)"),
            "root index should list existing domains too:\n{root_index}"
        );
        assert!(
            result.updated_indexes.contains(&"index.md".to_string()),
            "updated_indexes should record the root index: {:?}",
            result.updated_indexes
        );
    }

    #[test]
    fn test_cross_domain_new_domain_no_index() {
        let wiki_root = wiki_root("new_domain_no_index");
        let old_rel = "concepts/foo.md";
        let new_rel = "newdomain/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // New index should be created.
        let new_index_path = wiki_root.join("newdomain/index.md");
        assert!(new_index_path.exists());
        let new_index = read_file(&new_index_path);
        assert!(new_index.contains("- [Foo](concepts/foo.md)"));
        assert!(new_index.contains("## concept"));

        // Old index should have entry removed.
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(!old_index.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Cross-domain move — new index uses the canonical skeleton
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_new_index_is_generated() {
        let wiki_root = wiki_root("generated_new_index");
        let old_rel = "concepts/foo.md";
        let new_rel = "brandnew/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let new_index = read_file(&wiki_root.join("brandnew/index.md"));
        // A brand-new domain index gets seeded frontmatter and a generated
        // body listing the moved page.
        assert!(new_index.starts_with("---\ntitle: brandnew\n---"));
        assert!(new_index.contains("## concept"));
        assert!(new_index.contains("- [Foo](concepts/foo.md)"));
    }

    // -------------------------------------------------------------------
    // Cross-domain move — source pages listed under the source heading
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_source_lists_under_source_heading() {
        let wiki_root = wiki_root("cross_domain_source");

        make_page(
            &wiki_root,
            "concepts/foo.md",
            &fm_page("Foo Source", "source", "", "# Foo"),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        execute_move(
            &wiki_root,
            "concepts/foo.md",
            "brandnew/sources/notes/foo.md",
        )
        .unwrap();

        let new_index = read_file(&wiki_root.join("brandnew/index.md"));
        assert!(new_index.contains("## source"));
        assert!(
            new_index.contains("- [Foo Source](sources/notes/foo.md)"),
            "source page should be listed under the source heading:\n{new_index}"
        );
    }

    #[test]
    fn test_cross_domain_lists_multiple_source_pages() {
        let wiki_root = wiki_root("cross_domain_two_sources");

        make_page(
            &wiki_root,
            "concepts/a.md",
            &fm_page("First ADR", "source", "", "# First"),
        );
        make_page(
            &wiki_root,
            "concepts/b.md",
            &fm_page("Second ADR", "source", "", "# Second"),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [A](a.md)\n* [B](b.md)\n",
        );

        execute_move(&wiki_root, "concepts/a.md", "brandnew/sources/adr/a.md")
            .unwrap();
        execute_move(&wiki_root, "concepts/b.md", "brandnew/sources/adr/b.md")
            .unwrap();

        let index = read_file(&wiki_root.join("brandnew/index.md"));
        assert!(index.contains("- [First ADR](sources/adr/a.md)"));
        assert!(index.contains("- [Second ADR](sources/adr/b.md)"));
        assert_eq!(index.matches("## source").count(), 1);
    }

    // -------------------------------------------------------------------
    // Cross-domain move — with subdirectory in new domain
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_subdir() {
        let wiki_root = wiki_root("cross_domain_subdir");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        // Old domain index with foo entry.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        // New domain index with existing concept section.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(wiki_root.join(new_rel).exists());

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("[Foo](concepts/foo.md)"),
            "new index entry should reference the subdirectory relative path"
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain — entry added to correct type section
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_correct_type_section() {
        let wiki_root = wiki_root("correct_type");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "analysis", "", "# Foo\n\nAnalysis content."),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n\n## Analysis（分析）\n\n* [Existing](existing.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        // The entry should be listed under ## analysis, not ## concept.
        let analysis_section_start = new_index.find("## analysis").unwrap();
        let foo_pos = new_index.find("- [Foo](concepts/foo.md)").unwrap();
        assert!(
            foo_pos > analysis_section_start,
            "entry should be under the analysis section"
        );
    }

    // -------------------------------------------------------------------
    // Cross-domain — type section does not exist yet
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_new_type_section() {
        let wiki_root = wiki_root("new_type_section");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(
            &wiki_root,
            old_rel,
            &fm_page("Foo", "synthesis", "", "# Foo"),
        );
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );
        // New domain index does not have a ## Syntheses（综合） section.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(
            new_index.contains("## synthesis"),
            "type heading should be created"
        );
        assert!(
            new_index.contains("- [Foo](concepts/foo.md)"),
            "entry should be present"
        );
    }

    // -------------------------------------------------------------------
    // Multiple referencers with deduplication
    // -------------------------------------------------------------------

    #[test]
    fn test_multiple_referencers() {
        let wiki_root = wiki_root("multiple_refs");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Two referencers.
        make_page(
            &wiki_root,
            "concepts/ref1.md",
            &fm_page("Ref1", "concept", "", "See [Foo](concepts/foo.md).\n"),
        );
        make_page(
            &wiki_root,
            "concepts/ref2.md",
            &fm_page("Ref2", "concept", "", "Check `concepts/foo.md`.\n"),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert_eq!(result.updated_refs.len(), 2);
        assert!(result.updated_refs.contains(&"concepts/ref1.md".to_string()));
        assert!(result.updated_refs.contains(&"concepts/ref2.md".to_string()));

        let r1 = read_file(&wiki_root.join("concepts/ref1.md"));
        assert!(r1.contains("](concepts/bar.md)"));
        assert!(!r1.contains("concepts/foo.md"));

        let r2 = read_file(&wiki_root.join("concepts/ref2.md"));
        assert!(r2.contains("`concepts/bar.md`"));
        assert!(!r2.contains("concepts/foo.md"));
    }

    // -------------------------------------------------------------------
    // Self-reference: page links to itself, move should not crash
    // -------------------------------------------------------------------

    #[test]
    fn test_self_reference_does_not_crash() {
        let wiki_root = wiki_root("self_ref");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        // Page that links to itself in its body.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page(
                "Foo",
                "concept",
                "",
                "See [Foo](concepts/foo.md) and check `concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert!(wiki_root.join(new_rel).exists());
        assert!(!wiki_root.join(old_rel).exists());

        // The moved page should have its self-references updated.
        let moved = read_file(&wiki_root.join(new_rel));
        assert!(
            moved.contains("](concepts/bar.md)"),
            "markdown self-link should be updated"
        );
        assert!(
            moved.contains("`concepts/bar.md`"),
            "backtick self-reference should be updated"
        );
        assert!(
            !moved.contains("concepts/foo.md"),
            "old path should not remain in moved page"
        );

        // Self-reference should be recorded in updated_refs.
        assert!(
            result.updated_refs.contains(&old_rel.to_string()),
            "self-reference page should be in updated_refs"
        );
    }

    // -------------------------------------------------------------------
    // Unknown page type → listed under its own heading
    // -------------------------------------------------------------------

    #[test]
    fn test_unknown_page_type_lists_under_custom_heading() {
        let wiki_root = wiki_root("unknown_type");
        make_page(
            &wiki_root,
            "concepts/foo.md",
            &fm_page("Foo", "custom", "", "# Foo"),
        );

        execute_move(&wiki_root, "concepts/foo.md", "other/foo.md").unwrap();

        assert!(wiki_root.join("other/foo.md").exists());
        let new_index = read_file(&wiki_root.join("other/index.md"));
        assert!(new_index.contains("## custom"));
        assert!(new_index.contains("- [Foo](foo.md)"));
    }

    // -------------------------------------------------------------------
    // No substring matching (no foo.md → foo-old.md false match)
    // -------------------------------------------------------------------

    #[test]
    fn test_no_substring_matching() {
        let wiki_root = wiki_root("no_substring");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Referencer that also links to foo-old.md (should not be affected).
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "See [Foo](concepts/foo.md) and [Foo Old](concepts/foo-old.md).\nAlso `concepts/foo.md` and `concepts/foo-old.md`.\n",
            ),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        // New references should be updated.
        assert!(ref_content.contains("](concepts/bar.md)"));
        assert!(ref_content.contains("`concepts/bar.md`"));

        // Old-like references should NOT be affected.
        assert!(
            ref_content.contains("foo-old.md"),
            "foo-old should remain unchanged"
        );
        assert!(
            ref_content.contains("concepts/foo-old.md"),
            "concepts/foo-old.md should remain unchanged"
        );
        // But the foo.md reference should be gone (replaced to bar.md).
        assert!(!ref_content.contains("](concepts/foo.md)"));
        assert!(!ref_content.contains("`concepts/foo.md`"));
    }

    // -------------------------------------------------------------------
    // Old doesn't exist in reverse index (page has no backlinks)
    // -------------------------------------------------------------------

    #[test]
    fn test_no_referencers() {
        let wiki_root = wiki_root("no_referencers");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert!(result.updated_refs.is_empty());
        assert!(wiki_root.join(new_rel).exists());
        assert!(!wiki_root.join(old_rel).exists());
    }

    // -------------------------------------------------------------------
    // Cross-domain — entry not in old index (not listed)
    // -------------------------------------------------------------------

    #[test]
    fn test_cross_domain_not_in_old_index() {
        let wiki_root = wiki_root("not_in_old_index");
        let old_rel = "concepts/foo.md";
        let new_rel = "autoresearch/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        // Old domain index does NOT list foo.
        make_page(
            &wiki_root,
            "concepts/index.md",
            "# Concepts\n\n## Concepts（概念）\n\n* [Other](other.md)\n",
        );
        // New domain index exists.
        make_page(
            &wiki_root,
            "autoresearch/index.md",
            "# AutoResearch\n\n## Concepts（概念）\n\n* [Bar](bar.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Old index is regenerated from its (now empty) page set.
        let old_index = read_file(&wiki_root.join("concepts/index.md"));
        assert!(!old_index.contains("concepts/foo.md"));
        assert!(!old_index.contains("other.md"));

        // New index is regenerated with the moved page.
        let new_index = read_file(&wiki_root.join("autoresearch/index.md"));
        assert!(new_index.contains("- [Foo](concepts/foo.md)"));
    }

    // -------------------------------------------------------------------
    // Index entry already exists (no duplicate)
    // -------------------------------------------------------------------

    #[test]
    fn test_regeneration_has_no_duplicate_entries() {
        let wiki_root = wiki_root("no_dup");
        let old_rel = "other/foo.md";
        let new_rel = "shared/concepts/foo.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "other/index.md",
            "# Other\n\n## Concepts（概念）\n\n* [Foo](foo.md)\n",
        );

        // New index already has a foo entry.
        make_page(
            &wiki_root,
            "shared/index.md",
            "# Shared\n\n## Concepts（概念）\n\n* [Foo](concepts/foo.md)\n",
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Regeneration produces exactly one entry for the page.
        let new_index = read_file(&wiki_root.join("shared/index.md"));
        let count = new_index.matches("- [Foo](concepts/foo.md)").count();
        assert_eq!(count, 1, "should not create duplicate entries");

        // Old index no longer references the moved page.
        let old_index = read_file(&wiki_root.join("other/index.md"));
        assert!(!old_index.contains("foo.md"));
    }

    // -------------------------------------------------------------------
    // Atomic write integrity check
    // -------------------------------------------------------------------

    #[test]
    fn test_atomic_write_preserves_content() {
        let wiki_root = wiki_root("atomic_write");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page("Ref", "concept", "", "See [Foo](concepts/foo.md).\n"),
        );

        execute_move(&wiki_root, old_rel, new_rel).unwrap();

        // Referencer should still be valid markdown with frontmatter.
        let ref_content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(ref_content.starts_with("---"));
        assert!(ref_content.contains("title: Ref"));

        // Check the moved page is valid.
        let moved = read_file(&wiki_root.join(new_rel));
        assert!(moved.starts_with("---"));
        assert!(moved.contains("title: Foo"));
    }

    // -------------------------------------------------------------------
    // Backlinks rebuild
    // -------------------------------------------------------------------

    #[test]
    fn test_move_rebuilds_backlinks_through_documents() {
        let wiki_root = wiki_root("move_backlinks");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "See [Foo](concepts/foo.md) for details.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        assert_eq!(
            result.backlinks_synced, 1,
            "the moved page gains its referrer: {:?}",
            result.updated_refs
        );
        let moved = read_file(&wiki_root.join(new_rel));
        assert!(moved.contains("## Backlinks"), "{moved}");
        assert!(moved.contains("- [Ref](concepts/ref.md)"), "{moved}");
        assert!(
            !read_file(&wiki_root.join("concepts/ref.md"))
                .contains("## Backlinks"),
            "a page without inbound links keeps no region"
        );
    }

    // -------------------------------------------------------------------
    // Frontmatter-aware reference rewriting
    // -------------------------------------------------------------------

    #[test]
    fn test_move_rewrites_bare_path_fields() {
        let wiki_root = wiki_root("bare_path_fields");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Inline arrays (bare paths, no markdown-link syntax).
        make_page(
            &wiki_root,
            "concepts/ref_inline.md",
            &fm_page(
                "Ref Inline",
                "concept",
                "sources: [concepts/foo.md]\n",
                "# Ref\n",
            ),
        );

        // Block lists (unindented form).
        make_page(
            &wiki_root,
            "concepts/ref_block.md",
            &fm_page(
                "Ref Block",
                "concept",
                "sources:\n- concepts/foo.md\n",
                "# Ref\n",
            ),
        );

        // Block lists (indented form, as used by real pages).
        make_page(
            &wiki_root,
            "concepts/ref_block_indent.md",
            &fm_page(
                "Ref Block Indent",
                "concept",
                "sources:\n  - concepts/foo.md\n",
                "# Ref\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        for rel in [
            "concepts/ref_inline.md",
            "concepts/ref_block.md",
            "concepts/ref_block_indent.md",
        ] {
            assert!(
                result.updated_refs.contains(&rel.to_string()),
                "{rel} should be in updated_refs: {:?}",
                result.updated_refs
            );
        }

        for rel in [
            "concepts/ref_inline.md",
            "concepts/ref_block.md",
            "concepts/ref_block_indent.md",
        ] {
            let content = read_file(&wiki_root.join(rel));
            assert!(
                content.contains("concepts/bar.md"),
                "{rel} should reference the new path:\n{content}"
            );
            assert!(
                !content.contains("concepts/foo.md"),
                "{rel} should not reference the old path:\n{content}"
            );
        }
    }

    #[test]
    fn test_move_rewrites_explicit_bundle_references() {
        let wiki_root = wiki_root("explicit_bundle_refs");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        let ref_fm = "\
sources: ['@wiki/concepts/foo.md']
supersedes:
  - path: '@wiki/concepts/foo.md'
    reason: outdated
superseded_by:
  - path: '@wiki/concepts/foo.md'
    reason: newer
contradictions:
  - path: '@wiki/concepts/foo.md'
    claims:
      - claim
    detected: 2025-01-01
    resolution: unresolved
";
        let ref_path = make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                ref_fm,
                "# Ref\n\nSee [Foo](@wiki/concepts/foo.md), \
                 [Same](concepts/foo.md), and `@wiki/concepts/foo.md`.\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(
            result.updated_refs.contains(&"concepts/ref.md".to_string()),
            "referencer should be updated: {:?}",
            result.updated_refs
        );

        let text = read_file(&ref_path);
        let document = PageDocument::parse(&text).expect("valid document");
        assert_eq!(
            document.metadata.sources,
            Some(vec!["@wiki/concepts/bar.md".to_string()])
        );
        assert_eq!(
            document.metadata.supersedes.as_ref().map(|items| &items[0].path),
            Some(&"@wiki/concepts/bar.md".to_string())
        );
        assert_eq!(
            document
                .metadata
                .superseded_by
                .as_ref()
                .map(|items| &items[0].path),
            Some(&"@wiki/concepts/bar.md".to_string())
        );
        assert_eq!(
            document
                .metadata
                .contradictions
                .as_ref()
                .map(|items| &items[0].path),
            Some(&"@wiki/concepts/bar.md".to_string())
        );
        assert!(
            text.contains("](@wiki/concepts/bar.md)"),
            "explicit body link should keep its form:\n{text}"
        );
        assert!(
            text.contains("`@wiki/concepts/bar.md`"),
            "explicit backtick path should keep its form:\n{text}"
        );
        assert!(
            text.contains("](concepts/bar.md)"),
            "the bare path should stay bare:\n{text}"
        );
        assert!(!text.contains("concepts/foo.md"), "{text}");

        let moved = read_file(&wiki_root.join(new_rel));
        assert!(
            moved.contains("- [Ref](concepts/ref.md)"),
            "the rewritten reference still feeds the backlinks rebuild:\n{moved}"
        );
    }

    #[test]
    fn test_move_keeps_explicit_reference_of_another_bundle() {
        let wiki_root = wiki_root("explicit_other_bundle");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        write(
            &wiki_root.join("vendor/bundle.toml"),
            "[package]\nname = \"vendor\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n",
        );
        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));
        let vendor_page = make_page(
            &wiki_root,
            "vendor/concepts/foo.md",
            &fm_page("Vendor Foo", "concept", "", "# Vendor Foo"),
        );
        let vendor_before = read_file(&vendor_page);

        let ref_path = make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "# Ref\n\nSee [Mine](@wiki/concepts/foo.md) and \
                 [Vendor](@vendor/concepts/foo.md).\n",
            ),
        );

        execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let text = read_file(&ref_path);
        assert!(
            text.contains("](@wiki/concepts/bar.md)"),
            "own bundle reference should be updated:\n{text}"
        );
        assert!(
            text.contains("](@vendor/concepts/foo.md)"),
            "another bundle's page must keep its path:\n{text}"
        );
        assert!(!text.contains("](@wiki/concepts/foo.md)"), "{text}");
        assert_eq!(
            read_file(&vendor_page),
            vendor_before,
            "an installed bundle page stays read-only"
        );
    }

    #[test]
    fn test_move_rewrites_adjacent_same_token_on_one_line() {
        let wiki_root = wiki_root("adjacent_tokens");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // Two identical tokens separated by a single comma within one
        // line — the second must be rewritten too.
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "sources: [concepts/foo.md,concepts/foo.md]\n",
                "# Ref\n",
            ),
        );

        let result = execute_move(&wiki_root, old_rel, new_rel).unwrap();
        assert!(
            result.updated_refs.contains(&"concepts/ref.md".to_string()),
            "referencer should be updated: {:?}",
            result.updated_refs
        );

        let content = read_file(&wiki_root.join("concepts/ref.md"));
        assert_eq!(
            content.matches("concepts/bar.md").count(),
            2,
            "both adjacent tokens must be rewritten:\n{content}"
        );
        assert!(
            !content.contains("concepts/foo.md"),
            "no old token should remain:\n{content}"
        );
    }

    #[test]
    fn test_move_across_bundles_keeps_the_page_and_its_references() {
        // The page belongs to the nested bundle `core`.  A target outside
        // that bundle has no reference form, so the move fails before the
        // rename: the page stays, the target never appears and every
        // reference keeps its text.
        let wiki_root = wiki_root("move_across_bundles");
        write(
            &wiki_root.join("core/bundle.toml"),
            "[package]\nname = \"core\"\nversion = \"0.1.0\"\n\n\
             [export]\ninclude = [\"**/*.md\"]\n",
        );
        make_page(
            &wiki_root,
            "core/concepts/foo.md",
            &fm_page("Foo", "concept", "", "# Foo"),
        );
        let ref_path = make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "# Ref\n\nSee [Foo](@core/concepts/foo.md).\n",
            ),
        );
        let ref_before = read_file(&ref_path);

        let error =
            execute_move(&wiki_root, "core/concepts/foo.md", "concepts/bar.md")
                .expect_err("a cross-bundle target must fail");
        assert!(error.contains("@core"), "{error}");
        assert!(
            wiki_root.join("core/concepts/foo.md").exists(),
            "the page stays in place"
        );
        assert!(
            !wiki_root.join("concepts/bar.md").exists(),
            "the rejected target never appears"
        );
        assert_eq!(
            read_file(&ref_path),
            ref_before,
            "the reference keeps its text"
        );
    }

    #[test]
    fn test_move_leaves_body_path_string_untouched() {
        let wiki_root = wiki_root("body_path_string");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        // The body contains a `path: <old>` string shaped like a frontmatter
        // path field, plus a real inline link so the page is discovered.
        make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                "",
                "See [Foo](concepts/foo.md).\n\npath: concepts/foo.md\n",
            ),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let content = read_file(&wiki_root.join("concepts/ref.md"));
        assert!(
            content.contains("](concepts/bar.md)"),
            "inline link should be rewritten:\n{content}"
        );
        assert!(
            content.contains("path: concepts/foo.md"),
            "body path string must not be rewritten:\n{content}"
        );
        assert!(
            !content.contains("path: concepts/bar.md"),
            "body path string must not become the new path:\n{content}"
        );
    }

    // -------------------------------------------------------------------
    // Immediate Backlinks rebuild
    // -------------------------------------------------------------------

    #[test]
    fn test_move_rebuilds_backlinks_immediately() {
        let wiki_root = wiki_root("backlinks_rebuild");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        // foo links to target, so target's Backlinks section lists foo.
        make_page(
            &wiki_root,
            old_rel,
            &fm_page(
                "Foo",
                "concept",
                "",
                "# Foo\n\nSee [Target](concepts/target.md).\n",
            ),
        );

        // target already carries a (now stale) Backlinks section.
        make_page(
            &wiki_root,
            "concepts/target.md",
            &fm_page(
                "Target",
                "concept",
                "",
                "# Target\n\n## Backlinks\n\n> 此节由 zwiki 自动维护，请勿手动编辑。\n\n- [Foo](concepts/foo.md)\n",
            ),
        );

        let _result = execute_move(&wiki_root, old_rel, new_rel).unwrap();

        let content = read_file(&wiki_root.join("concepts/target.md"));
        assert!(
            content.contains("- [Foo](concepts/bar.md)"),
            "Backlinks should be rebuilt to the new path:\n{content}"
        );
        assert!(
            !content.contains("concepts/foo.md"),
            "stale Backlinks reference must be gone:\n{content}"
        );
    }

    // -------------------------------------------------------------------
    // Invalid document rejection
    // -------------------------------------------------------------------

    #[test]
    fn test_rewrite_rejects_invalid_document() {
        let wiki_root = wiki_root("invalid_document");
        let path = write(
            &wiki_root.join("concepts/ref.md"),
            "---\ntitle: Ref\n---\n\nSee [Foo](concepts/foo.md).\n",
        );
        let before = read_file(&path);

        let error = rewrite_page_references(
            &path,
            &bare_form("concepts/foo.md", "concepts/bar.md"),
        )
        .expect_err("page without required fields");

        assert!(error.contains("缺少必需字段"), "unexpected error: {error}");
        assert_eq!(read_file(&path), before);
    }

    // -------------------------------------------------------------------
    // Typed path fields
    // -------------------------------------------------------------------

    #[test]
    fn test_move_updates_all_typed_path_fields() {
        let wiki_root = wiki_root("typed_path_fields");
        let old_rel = "concepts/foo.md";
        let new_rel = "concepts/bar.md";

        make_page(&wiki_root, old_rel, &fm_page("Foo", "concept", "", "# Foo"));

        let ref_fm = "\
sources: [concepts/foo.md]
supersedes:
  - path: concepts/foo.md
    reason: outdated
superseded_by:
  - path: concepts/foo.md
    reason: newer
contradictions:
  - path: concepts/foo.md
    claims:
      - claim
    detected: 2025-01-01
    resolution: unresolved
owner: team-a
";
        let ref_path = make_page(
            &wiki_root,
            "concepts/ref.md",
            &fm_page(
                "Ref",
                "concept",
                ref_fm,
                "# Ref\n\nSee [Foo](concepts/foo.md).\n",
            ),
        );

        execute_move(&wiki_root, old_rel, new_rel).expect("move");

        let text = read_file(&ref_path);
        let document = PageDocument::parse(&text).expect("valid document");
        assert_eq!(
            document.metadata.sources,
            Some(vec!["concepts/bar.md".to_string()])
        );
        assert_eq!(
            document.metadata.supersedes.as_ref().map(|items| &items[0].path),
            Some(&"concepts/bar.md".to_string())
        );
        assert_eq!(
            document
                .metadata
                .superseded_by
                .as_ref()
                .map(|items| &items[0].path),
            Some(&"concepts/bar.md".to_string())
        );
        assert_eq!(
            document
                .metadata
                .contradictions
                .as_ref()
                .map(|items| &items[0].path),
            Some(&"concepts/bar.md".to_string())
        );
        assert_eq!(
            document
                .metadata
                .extensions
                .get("owner")
                .map(|value| (**value).clone()),
            Some(zwiki::document::Value::from("team-a"))
        );
        assert_eq!(
            document.body.author(),
            "# Ref\n\nSee [Foo](concepts/bar.md)."
        );
        assert!(!text.contains("concepts/foo.md"), "{text}");
    }

    #[test]
    fn test_rewrite_document_leaves_backlinks_for_rebuild() {
        let text = concat!(
            "---\n",
            "title: Ref\n",
            "type: concept\n",
            "tags: []\n",
            "",
            "timestamp: 2025-01-01T00:00:00Z\n",
            "",
            "---\n",
            "\n",
            "# Ref\n",
            "\n",
            "Author text.\n",
            "\n",
            "## Backlinks\n",
            "\n",
            "- [Foo](concepts/foo.md)\n",
        );
        let mut document = PageDocument::parse(text).expect("valid document");

        let changed = rewrite_document_references(
            &mut document,
            &bare_form("concepts/foo.md", "concepts/bar.md"),
        );

        assert!(!changed, "backlinks must not count as author content");
        assert_eq!(document.body.author(), "# Ref\n\nAuthor text.");
        assert_eq!(document.body.backlinks(), Some("- [Foo](concepts/foo.md)"));
    }
}
