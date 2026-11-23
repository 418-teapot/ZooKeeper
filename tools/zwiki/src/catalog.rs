//! Semantic page index — bundle ownership, page identity and references.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use walkdir::WalkDir;
use zwiki::identity::{BundleId, PageId, PagePath, Reference};

use crate::bundle::manifest::BundleManifest;
use crate::wiki::PageSet;

/// The outcome of resolving one reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// The referenced page exists.
    Found(PageId),
    /// The scope exists, the page does not.
    MissingPage(PageId),
    /// The reference names a bundle the catalog does not hold.
    MissingBundle(BundleId),
    /// The text is not a page reference.
    Invalid,
}

/// One bundle root: its root-relative directory and its manifest name.
struct BundleRoot {
    rel: String,
    name: BundleId,
}

/// Page identity and reference index over one wiki root.
#[derive(Debug)]
pub struct Catalog {
    bundles: BTreeSet<BundleId>,
    locations: BTreeMap<PageId, String>,
    ids: BTreeMap<String, PageId>,
}

impl Catalog {
    /// Index every page of `set` below `root`.
    ///
    /// The root directory is always a scope: a root manifest names it, and
    /// a root without one forms the unnamed root scope.  A page belongs to
    /// its nearest bundle root, so a nested bundle keeps its own pages.
    ///
    /// # Errors
    ///
    /// Fails when a bundle manifest cannot be read or parsed, or when two
    /// bundle roots share one name.
    pub fn new(root: &Path, set: &PageSet) -> Result<Self, String> {
        let roots = bundle_roots(root)?;
        let mut bundles = BTreeSet::new();
        for bundle in &roots {
            if !bundles.insert(bundle.name.clone())
                && let Some(name) = bundle.name.name()
            {
                return Err(format!("bundle 名称重复: {name}"));
            }
        }
        let mut locations = BTreeMap::new();
        let mut ids = BTreeMap::new();
        for page in set.pages() {
            let (bundle, path) = owner_of(&roots, &page.rel);
            let Some(path) = PagePath::parse(path) else {
                return Err(format!("页面路径无效: {}", page.rel));
            };
            let id = PageId::new(bundle.name.clone(), path);
            locations.insert(id.clone(), page.rel.clone());
            ids.insert(page.rel.clone(), id);
        }
        Ok(Self { bundles, locations, ids })
    }

    /// Iterate over every page identity, ordered by scope and path.
    pub fn pages(&self) -> impl Iterator<Item = &PageId> + '_ {
        self.locations.keys()
    }

    /// The root-relative file of `id`, or `None` when the page is absent.
    #[must_use]
    pub fn rel(&self, id: &PageId) -> Option<&str> {
        self.locations.get(id).map(String::as_str)
    }

    /// The identity of the page stored at root-relative `rel`.
    #[must_use]
    pub fn id_of(&self, rel: &str) -> Option<&PageId> {
        self.ids.get(rel)
    }

    /// The domain directory of `id`, `None` when the page is absent.
    #[must_use]
    pub fn domain<'a>(&self, id: &'a PageId) -> Option<&'a str> {
        self.locations.contains_key(id).then(|| id.domain())
    }

    /// Resolve `text` from `referrer`.
    ///
    /// A bare path stays in the referrer's scope; `@bundle/path` names a
    /// page of `bundle`.  Only the named target is resolved — the catalog
    /// never searches every scope for a bare path, and the root scope has
    /// no name to address.
    #[must_use]
    pub fn resolve(&self, referrer: &PageId, text: &str) -> Resolution {
        let Some(reference) = Reference::parse(text) else {
            return Resolution::Invalid;
        };
        let bundle = reference
            .bundle()
            .cloned()
            .unwrap_or_else(|| referrer.bundle().clone());
        if !self.bundles.contains(&bundle) {
            return Resolution::MissingBundle(bundle);
        }
        let id = PageId::new(bundle, reference.path().clone());
        if self.locations.contains_key(&id) {
            Resolution::Found(id)
        } else {
            Resolution::MissingPage(id)
        }
    }

    /// The root-relative file `text` names when read from `referrer`.
    ///
    /// `None` when the text names no page of the catalog.
    #[must_use]
    pub fn resolve_rel(&self, referrer: &PageId, text: &str) -> Option<&str> {
        match self.resolve(referrer, text) {
            Resolution::Found(id) => self.rel(&id),
            Resolution::MissingPage(_)
            | Resolution::MissingBundle(_)
            | Resolution::Invalid => None,
        }
    }
}

/// Bundle name of the flat catalog unit tests build from page records.
#[cfg(test)]
pub const FLAT_BUNDLE: &str = "flat";

#[cfg(test)]
impl Catalog {
    /// Index `pages` as one bundle named [`FLAT_BUNDLE`].
    ///
    /// A unit test holds page records without a wiki root, so every page
    /// keeps its rel as the bundle-relative path.
    #[must_use]
    pub fn flat(pages: &[crate::wiki::Page]) -> Self {
        let mut locations = BTreeMap::new();
        let mut ids = BTreeMap::new();
        for page in pages {
            let Some(path) = PagePath::parse(&page.rel) else {
                continue;
            };
            let id = PageId::new(BundleId::new(FLAT_BUNDLE), path);
            locations.insert(id.clone(), page.rel.clone());
            ids.insert(page.rel.clone(), id);
        }
        Self {
            bundles: BTreeSet::from([BundleId::new(FLAT_BUNDLE)]),
            locations,
            ids,
        }
    }
}

/// Every bundle root below `root`, including `root` itself.
fn bundle_roots(root: &Path) -> Result<Vec<BundleRoot>, String> {
    let mut roots =
        vec![BundleRoot { rel: String::new(), name: root_bundle_name(root)? }];
    let entries = WalkDir::new(root).min_depth(1).into_iter();
    for dir in entries.filter_map(Result::ok).map(walkdir::DirEntry::into_path)
    {
        if !dir.join("bundle.toml").is_file() {
            continue;
        }
        let rel = dir
            .strip_prefix(root)
            .map_err(|e| format!("无法定位 {}: {e}", dir.display()))?
            .to_string_lossy()
            .to_string();
        roots.push(BundleRoot { rel, name: read_bundle_name(&dir)? });
    }
    Ok(roots)
}

/// The scope name of the bundle rooted at `root`,
/// [`BundleId::root`] when it holds no manifest.
fn root_bundle_name(root: &Path) -> Result<BundleId, String> {
    if root.join("bundle.toml").is_file() {
        read_bundle_name(root)
    } else {
        Ok(BundleId::root())
    }
}

/// Read the manifest name of the bundle rooted at `dir`.
fn read_bundle_name(dir: &Path) -> Result<BundleId, String> {
    let path = dir.join("bundle.toml");
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
    let manifest: BundleManifest = toml::from_str(&text)
        .map_err(|e| format!("无法解析 {}: {e}", path.display()))?;
    Ok(BundleId::new(manifest.package.name))
}

/// The bundle owning `rel` and the page path inside it.
///
/// The nearest bundle root wins, so a nested bundle keeps its own pages.
/// The root scope covers every page, so the first root always matches.
fn owner_of<'a>(
    roots: &'a [BundleRoot],
    rel: &'a str,
) -> (&'a BundleRoot, &'a str) {
    let mut owner = (&roots[0], rel);
    for bundle in roots {
        let inner = if bundle.rel.is_empty() {
            rel
        } else {
            let Some(inner) = rel
                .strip_prefix(bundle.rel.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            inner
        };
        if bundle.rel.len() > owner.0.rel.len() {
            owner = (bundle, inner);
        }
    }
    owner
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::bundle::testutil::temp_dir;
    use crate::wiki::PageSet;

    /// A page document the loader accepts.
    fn page(title: &str) -> String {
        format!(
            "---\ntitle: {title}\ntype: concept\ntags: []\n\
             timestamp: 2026-01-01T00:00:00Z\n---\n\
             \n# {title}\n"
        )
    }

    /// Write a page fixture at `rel` below `root`.
    fn write_page(root: &Path, rel: &str, title: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, page(title)).unwrap();
    }

    /// Write a bundle manifest naming `name` in `dir` below `root`.
    fn write_manifest(root: &Path, dir: &str, name: &str) {
        let dir = root.join(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("bundle.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n\n\
                 [export]\ninclude = [\"**/*.md\"]\n"
            ),
        )
        .unwrap();
    }

    /// Build the catalog of `root`.
    fn catalog(root: &Path) -> Catalog {
        Catalog::new(root, &PageSet::load(root)).expect("catalog")
    }

    /// The identity stored at root-relative `rel`.
    fn id(catalog: &Catalog, rel: &str) -> PageId {
        catalog.id_of(rel).unwrap_or_else(|| panic!("no page at {rel}")).clone()
    }

    /// Render a resolution as text for assertions.
    fn outcome(resolution: &Resolution) -> String {
        match resolution {
            Resolution::Found(id) => format!("found {id}"),
            Resolution::MissingPage(id) => format!("missing page {id}"),
            Resolution::MissingBundle(bundle) => {
                format!("missing bundle @{}", bundle.name().unwrap_or_default())
            }
            Resolution::Invalid => "invalid".to_string(),
        }
    }

    #[test]
    fn test_bare_reference_stays_in_the_referrer_bundle() {
        let root = temp_dir("catalog_bare");
        write_manifest(&root, "", "wiki");
        write_page(&root, "concepts/a.md", "A");
        write_page(&root, "concepts/b.md", "B");
        let catalog = catalog(&root);

        let a = id(&catalog, "concepts/a.md");
        assert_eq!(
            outcome(&catalog.resolve(&a, "concepts/b.md")),
            "found @wiki/concepts/b.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&a, "concepts/b")),
            "found @wiki/concepts/b.md"
        );
    }

    #[test]
    fn test_explicit_reference_reaches_another_bundle() {
        let root = temp_dir("catalog_explicit");
        write_manifest(&root, "core", "core");
        write_manifest(&root, "vendor", "vendor");
        write_page(&root, "core/concepts/a.md", "A");
        write_page(&root, "vendor/concepts/x.md", "X");
        let catalog = catalog(&root);

        let a = id(&catalog, "core/concepts/a.md");
        assert_eq!(
            outcome(&catalog.resolve(&a, "@vendor/concepts/x.md")),
            "found @vendor/concepts/x.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&a, "@vendor/concepts/x#notes")),
            "found @vendor/concepts/x.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&a, "@core/concepts/a.md")),
            "found @core/concepts/a.md"
        );
    }

    #[test]
    fn test_source_and_aggregate_roots_share_one_identity() {
        let source = temp_dir("catalog_source");
        write_manifest(&source, "", "core");
        write_page(&source, "concepts/a.md", "A");
        let source_catalog = catalog(&source);

        let aggregate = temp_dir("catalog_aggregate");
        write_manifest(&aggregate, "core", "core");
        write_page(&aggregate, "core/concepts/a.md", "A");
        let aggregate_catalog = catalog(&aggregate);

        let source_id = id(&source_catalog, "concepts/a.md");
        let aggregate_id = id(&aggregate_catalog, "core/concepts/a.md");
        assert_eq!(source_id.to_string(), "@core/concepts/a.md");
        assert_eq!(aggregate_id.to_string(), "@core/concepts/a.md");
        assert_eq!(source_catalog.rel(&source_id), Some("concepts/a.md"));
        assert_eq!(
            aggregate_catalog.rel(&aggregate_id),
            Some("core/concepts/a.md")
        );
    }

    #[test]
    fn test_same_path_in_two_bundles_stays_distinct() {
        let root = temp_dir("catalog_same_path");
        write_manifest(&root, "core", "core");
        write_manifest(&root, "vendor", "vendor");
        write_page(&root, "core/concepts/note.md", "Core Note");
        write_page(&root, "vendor/concepts/note.md", "Vendor Note");
        let catalog = catalog(&root);

        let core_note = id(&catalog, "core/concepts/note.md");
        let vendor_note = id(&catalog, "vendor/concepts/note.md");
        assert_eq!(catalog.pages().count(), 2);
        assert_eq!(
            outcome(&catalog.resolve(&core_note, "concepts/note.md")),
            "found @core/concepts/note.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&core_note, "@vendor/concepts/note.md")),
            "found @vendor/concepts/note.md"
        );
        assert_eq!(catalog.rel(&core_note), Some("core/concepts/note.md"));
        assert_eq!(catalog.rel(&vendor_note), Some("vendor/concepts/note.md"));
    }

    #[test]
    fn test_missing_page_bundle_and_invalid() {
        let root = temp_dir("catalog_outcomes");
        write_manifest(&root, "", "wiki");
        write_page(&root, "concepts/a.md", "A");
        let catalog = catalog(&root);

        let a = id(&catalog, "concepts/a.md");
        assert_eq!(
            outcome(&catalog.resolve(&a, "concepts/gone.md")),
            "missing page @wiki/concepts/gone.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&a, "@absent/concepts/a.md")),
            "missing bundle @absent"
        );
        for text in [
            "",
            "#intro",
            "../a.md",
            "/concepts/a.md",
            "@/concepts/a.md",
            "@wiki",
            "notes.txt",
        ] {
            assert_eq!(
                outcome(&catalog.resolve(&a, text)),
                "invalid",
                "text {text:?}"
            );
        }
    }

    #[test]
    fn test_page_belongs_to_nearest_bundle_root() {
        let root = temp_dir("catalog_nearest");
        write_manifest(&root, "", "top");
        write_manifest(&root, "nested", "inner");
        write_page(&root, "concepts/own.md", "Own");
        write_page(&root, "nested/concepts/deep.md", "Deep");
        let catalog = catalog(&root);

        let deep = id(&catalog, "nested/concepts/deep.md");
        assert_eq!(
            id(&catalog, "concepts/own.md").to_string(),
            "@top/concepts/own.md"
        );
        assert_eq!(deep.to_string(), "@inner/concepts/deep.md");
        assert_eq!(catalog.rel(&deep), Some("nested/concepts/deep.md"));
        assert_eq!(
            outcome(&catalog.resolve(&deep, "concepts/own.md")),
            "missing page @inner/concepts/own.md"
        );
    }

    #[test]
    fn test_domain_is_the_first_bundle_relative_component() {
        let root = temp_dir("catalog_domain");
        write_manifest(&root, "", "wiki");
        write_page(&root, "concepts/a.md", "A");
        write_page(&root, "overview.md", "Overview");
        let catalog = catalog(&root);

        assert_eq!(
            catalog.domain(&id(&catalog, "concepts/a.md")),
            Some("concepts")
        );
        assert_eq!(catalog.domain(&id(&catalog, "overview.md")), Some(""));
        let absent = PageId::new(
            BundleId::new("wiki"),
            PagePath::parse("domain/x.md").unwrap(),
        );
        assert_eq!(catalog.domain(&absent), None);
    }

    #[test]
    fn test_duplicate_bundle_names_are_rejected() {
        let root = temp_dir("catalog_duplicate");
        write_manifest(&root, "one", "core");
        write_manifest(&root, "two", "core");

        let Err(error) = Catalog::new(&root, &PageSet::load(&root)) else {
            panic!("duplicate bundle names must fail");
        };
        assert!(error.contains("core"), "{error}");
    }

    #[test]
    fn test_root_without_manifest_forms_a_local_scope() {
        // A bare directory holds its pages without a manifest.  The root
        // scope names them by their plain path, and no bundle name reaches
        // them.
        let root = temp_dir("catalog_root_scope");
        write_page(&root, "concepts/a.md", "A");
        write_page(&root, "concepts/b.md", "B");
        let catalog = catalog(&root);

        let a = id(&catalog, "concepts/a.md");
        assert_eq!(a.to_string(), "concepts/a.md");
        assert_eq!(
            outcome(&catalog.resolve(&a, "concepts/b.md")),
            "found concepts/b.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&a, "@concepts/b.md")),
            "missing bundle @concepts",
            "a directory name never addresses the root scope"
        );
    }

    #[test]
    fn test_root_scope_yields_to_a_nested_manifest() {
        // An aggregate without a root manifest still keeps its bundles
        // apart: the nearest manifest owns its pages and the root scope
        // owns the rest.
        let root = temp_dir("catalog_root_scope_nested");
        write_manifest(&root, "core", "core");
        write_page(&root, "concepts/loose.md", "Loose");
        write_page(&root, "core/concepts/own.md", "Own");
        let catalog = catalog(&root);

        let loose = id(&catalog, "concepts/loose.md");
        assert_eq!(loose.to_string(), "concepts/loose.md");
        assert_eq!(
            id(&catalog, "core/concepts/own.md").to_string(),
            "@core/concepts/own.md"
        );
        assert_eq!(
            outcome(&catalog.resolve(&loose, "@core/concepts/own.md")),
            "found @core/concepts/own.md",
            "the root scope reaches a named bundle"
        );
        assert_eq!(
            outcome(&catalog.resolve(&loose, "core/concepts/own.md")),
            "missing page core/concepts/own.md",
            "the root scope holds no page below a bundle root"
        );
    }
}
