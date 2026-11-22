//! Internal page identity — bundle-qualified paths and reference syntax.
//!
//! A page is named by the scope that owns it and the path inside that
//! scope.  A root manifest names the root scope; a root without one forms
//! the unnamed root scope.  A reference resolves inside one scope only: a
//! bare path names a page of the referrer's scope, `@bundle/path` names a
//! page of a named bundle.

use std::fmt;

/// A bundle name taken from the manifest `package.name`.
///
/// The root scope of a wiki that holds no manifest at its root names its
/// pages by plain path.  It carries no name, so no reference reaches it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BundleId(BundleScope);

/// The scope a page belongs to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum BundleScope {
    /// The root scope of a wiki without a root manifest.
    Root,
    /// A bundle named by a manifest `package.name`.
    Named(String),
}

impl BundleId {
    /// Wrap a manifest bundle name.
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        Self(BundleScope::Named(name.into()))
    }

    /// The root scope of a wiki without a root manifest.
    #[must_use]
    pub const fn root() -> Self {
        Self(BundleScope::Root)
    }

    /// The manifest name, `None` for the root scope.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        match &self.0 {
            BundleScope::Root => None,
            BundleScope::Named(name) => Some(name),
        }
    }
}

/// A page path inside one bundle, ending in `.md`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PagePath(String);

impl PagePath {
    /// Parse `text` as a bundle-relative page path.
    ///
    /// A trailing `#fragment` is dropped and a missing `.md` extension is
    /// added, so `concepts/a#intro` and `concepts/a` both name
    /// `concepts/a.md`.  An accepted extension is written as `.md`, so
    /// `concepts/a.MD` names the same page.  Empty text, absolute paths,
    /// non-`.md` extensions and `.` or `..` components are invalid.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.split_once('#').map_or(text, |(path, _)| path);
        let text = text.strip_prefix("./").unwrap_or(text);
        if text.is_empty() || text.starts_with('/') {
            return None;
        }
        if text
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return None;
        }
        let (dir, name) = text.rsplit_once('/').map_or(("", text), |pair| pair);
        let (stem, extension) =
            name.rsplit_once('.').map_or((name, ""), |pair| pair);
        let name = if extension.is_empty() {
            format!("{name}.md")
        } else if extension.eq_ignore_ascii_case("md") {
            format!("{stem}.md")
        } else {
            return None;
        };
        Some(Self(if dir.is_empty() { name } else { format!("{dir}/{name}") }))
    }

    /// The page path.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The domain directory of the page, empty for a bundle-root page.
    #[must_use]
    pub fn domain(&self) -> &str {
        self.0.split_once('/').map_or("", |(domain, _)| domain)
    }
}

/// A page identity: the owning bundle and the path inside it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PageId {
    bundle: BundleId,
    path: PagePath,
}

impl PageId {
    /// Pair a bundle with a page path.
    #[must_use]
    pub const fn new(bundle: BundleId, path: PagePath) -> Self {
        Self { bundle, path }
    }

    /// The owning bundle.
    #[must_use]
    pub const fn bundle(&self) -> &BundleId {
        &self.bundle
    }

    /// The path inside the bundle.
    #[must_use]
    pub const fn path(&self) -> &PagePath {
        &self.path
    }

    /// The domain directory of the page, empty for a bundle-root page.
    #[must_use]
    pub fn domain(&self) -> &str {
        self.path.domain()
    }
}

impl fmt::Display for PageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.bundle.name() {
            Some(name) => write!(f, "@{name}/{}", self.path.as_str()),
            None => f.write_str(self.path.as_str()),
        }
    }
}

/// The target a piece of link text names.
///
/// A markdown link `[Name](path/to.md)` names its target `path/to.md`, so
/// a link and a plain path reach the same page identity.  Any other text
/// names itself.
#[must_use]
pub fn link_target(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix('[') else {
        return trimmed;
    };
    let Some((_, after)) = rest.split_once("](") else {
        return trimmed;
    };
    after.split_once(')').map_or(trimmed, |(target, _)| target.trim())
}

/// A page reference parsed from link text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    bundle: Option<BundleId>,
    path: PagePath,
}

impl Reference {
    /// Parse `text` as a page reference.
    ///
    /// `@bundle/path` names an explicit bundle.  A bare path leaves the
    /// bundle to the referrer.  A markdown link names the target it points
    /// at, so `[Name](path/to.md)` and `path/to.md` are the same reference.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = link_target(text);
        let Some(rest) = text.strip_prefix('@') else {
            return Some(Self { bundle: None, path: PagePath::parse(text)? });
        };
        let (name, path) = rest.split_once('/')?;
        if !is_bundle_name(name) {
            return None;
        }
        Some(Self {
            bundle: Some(BundleId::new(name)),
            path: PagePath::parse(path)?,
        })
    }

    /// The explicit bundle, `None` for a bare path.
    #[must_use]
    pub const fn bundle(&self) -> Option<&BundleId> {
        self.bundle.as_ref()
    }

    /// The referenced page path.
    #[must_use]
    pub const fn path(&self) -> &PagePath {
        &self.path
    }
}

/// Whether `name` can appear as the bundle part of a reference.
fn is_bundle_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', '#'])
        && name != "."
        && name != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_page_path_parses_anchor_and_extension() {
        let parsed = PagePath::parse("concepts/npc.md#stats").unwrap();
        assert_eq!(parsed.as_str(), "concepts/npc.md");

        let omitted = PagePath::parse("concepts/npc").unwrap();
        assert_eq!(omitted.as_str(), "concepts/npc.md");

        let relative = PagePath::parse("./concepts/npc.md").unwrap();
        assert_eq!(relative.as_str(), "concepts/npc.md");
    }

    #[test]
    fn test_page_path_normalizes_the_extension() {
        let upper = PagePath::parse("concepts/npc.MD").unwrap();
        assert_eq!(upper.as_str(), "concepts/npc.md");

        let mixed = PagePath::parse("A/B.Md").unwrap();
        assert_eq!(mixed.as_str(), "A/B.md", "only the extension is lowered");
    }

    #[test]
    fn test_page_path_rejects_unsafe_forms() {
        for text in [
            "",
            "#intro",
            "/concepts/npc.md",
            ".",
            "../npc.md",
            "concepts/./npc.md",
            "concepts/../npc.md",
            "concepts//npc.md",
            "notes.txt",
        ] {
            assert!(PagePath::parse(text).is_none(), "accepted {text:?}");
        }
    }

    #[test]
    fn test_reference_separates_bundle_and_path() {
        let explicit = Reference::parse("@core/concepts/npc.md").unwrap();
        assert_eq!(explicit.bundle().unwrap().name(), Some("core"));
        assert_eq!(explicit.path().as_str(), "concepts/npc.md");

        let bare = Reference::parse("concepts/npc.md").unwrap();
        assert!(bare.bundle().is_none());
        assert_eq!(bare.path().as_str(), "concepts/npc.md");
    }

    #[test]
    fn test_link_target_unwraps_a_markdown_link() {
        assert_eq!(link_target("[Name](concepts/npc.md)"), "concepts/npc.md");
        assert_eq!(link_target("[Name](@core/npc.md)"), "@core/npc.md");
        assert_eq!(link_target("concepts/npc.md"), "concepts/npc.md");
        assert_eq!(link_target("[ Name ]( a.md )"), "a.md");
        assert_eq!(link_target("[broken"), "[broken");
    }

    #[test]
    fn test_reference_reads_a_markdown_link_target() {
        let linked = Reference::parse("[Name](concepts/npc.md)").unwrap();
        assert!(linked.bundle().is_none());
        assert_eq!(linked.path().as_str(), "concepts/npc.md");
        assert_eq!(linked, Reference::parse("concepts/npc.md").unwrap());

        let explicit = Reference::parse("[Name](@core/npc.md)").unwrap();
        assert_eq!(explicit.bundle().unwrap().name(), Some("core"));
        assert_eq!(explicit.path().as_str(), "npc.md");
    }

    #[test]
    fn test_reference_matches_a_page_whatever_the_extension_case() {
        let expected = Reference::parse("concepts/npc.md").unwrap();
        assert_eq!(Reference::parse("concepts/npc.MD").unwrap(), expected);
        assert_eq!(
            Reference::parse("@core/concepts/npc.Md").unwrap(),
            Reference::parse("@core/concepts/npc.md").unwrap()
        );
    }

    #[test]
    fn test_reference_rejects_invalid_bundle_names() {
        for text in
            ["@/npc.md", "@./npc.md", "@../npc.md", "@core", "@co#re/x.md"]
        {
            assert!(Reference::parse(text).is_none(), "accepted {text:?}");
        }
    }

    #[test]
    fn test_page_id_renders_bundle_and_path() {
        let bundle = BundleId::new("core");
        let path = PagePath::parse("concepts/npc.md").unwrap();
        let id = PageId::new(bundle, path);
        assert_eq!(id.to_string(), "@core/concepts/npc.md");
        assert_eq!(id.domain(), "concepts");
    }

    #[test]
    fn test_root_scope_renders_the_plain_path() {
        let path = PagePath::parse("concepts/npc.md").unwrap();
        let id = PageId::new(BundleId::root(), path);
        assert_eq!(id.to_string(), "concepts/npc.md");
        assert_eq!(id.bundle().name(), None);
    }
}
