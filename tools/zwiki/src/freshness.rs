//! Unified page freshness judgment.
//!
//! Every staleness decision in this tool is derived from the single
//! judgment implemented here: a derived page outdates when a source it
//! lists is newer, and a page outdates when it still cites a superseded
//! page.  Both comparisons use the parsed `timestamp` of the two pages.

use std::collections::{HashMap, HashSet};

use crate::catalog::Catalog;
use crate::wiki::{self, Page};

/// Page types that derive their content from `sources`.
const DERIVED_TYPES: [&str; 2] = ["analysis", "synthesis"];

/// Independent reasons a page can be judged stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReason {
    /// A referenced source page has a newer `timestamp`.
    SourceNewer,
    /// A referenced page was superseded after this page was confirmed.
    UnreviewedSupersede,
}

impl StaleReason {
    /// Stable machine-readable label used in lint issue details.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceNewer => "source_newer",
            Self::UnreviewedSupersede => "unreviewed_supersede",
        }
    }
}

/// Verdict for a single judged page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Freshness {
    reasons: Vec<StaleReason>,
}

impl Freshness {
    /// The staleness reasons, in discovery order.
    #[must_use]
    pub fn reasons(&self) -> &[StaleReason] {
        &self.reasons
    }
}

/// A source page that outdates the derived page listing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceNewer {
    /// Source page path relative to the wiki root.
    pub source: String,
    /// The source `timestamp` as stored.
    pub source_timestamp: String,
    /// The derived page `timestamp` as stored.
    pub derived_timestamp: String,
}

/// Sources whose `timestamp` is later than the page's `timestamp`.
///
/// Applies to `analysis` / `synthesis` pages with a non-empty `sources`
/// list.  A source may hold any page type.  A bare entry names a page of
/// the derived page's bundle; `@bundle/path` names a page of `bundle`.  An
/// entry may carry a markdown link, which names its target.
/// Entries that name the same page give one result.
/// Unresolvable sources and invalid timestamps are skipped.
#[must_use]
pub fn newer_sources<'a>(
    page: &'a Page,
    by_rel: &HashMap<&'a str, &'a Page>,
    catalog: &Catalog,
) -> Vec<SourceNewer> {
    let metadata = &page.document.metadata;
    if !DERIVED_TYPES.contains(&metadata.page_type.as_str()) {
        return Vec::new();
    }

    let sources = match metadata.sources.as_deref() {
        Some(sources) if !sources.is_empty() => sources,
        _ => return Vec::new(),
    };

    let Some(confirmed) = wiki::parse_timestamp(&metadata.timestamp) else {
        return Vec::new();
    };

    let mut newer: Vec<SourceNewer> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for entry in sources {
        let Some(source_rel) = source_rel(page, entry, catalog) else {
            continue;
        };
        // Several spellings of an entry name one page, and one page gives
        // one result.
        if !seen.insert(source_rel) {
            continue;
        }

        let Some(source_page) = by_rel.get(source_rel) else {
            continue;
        };
        let source_timestamp = &source_page.document.metadata.timestamp;
        let Some(changed) = wiki::parse_timestamp(source_timestamp) else {
            continue;
        };

        if changed > confirmed {
            newer.push(SourceNewer {
                source: source_rel.to_string(),
                source_timestamp: source_timestamp.clone(),
                derived_timestamp: metadata.timestamp.clone(),
            });
        }
    }

    newer
}

/// The page path a `sources` entry names, `None` when it names no page.
fn source_rel<'c>(
    page: &Page,
    entry: &str,
    catalog: &'c Catalog,
) -> Option<&'c str> {
    let referrer = catalog.id_of(&page.rel)?;
    catalog.resolve_rel(referrer, entry)
}

/// Peer lookups the judgment needs.  Build the context once from the page
/// set and a reverse link index, then judge any number of pages with
/// [`FreshnessContext::judge`].
pub struct FreshnessContext<'a> {
    by_rel: HashMap<&'a str, &'a Page>,
    /// Page identity for `sources` lookup.
    catalog: &'a Catalog,
    /// Referrer rel → superseded page rels it still cites.
    cascade: HashMap<String, Vec<String>>,
}

impl<'a> FreshnessContext<'a> {
    /// Build a context for the source and supersede checks.
    #[must_use]
    pub fn new(pages: &'a [Page], catalog: &'a Catalog) -> Self {
        Self {
            by_rel: pages.iter().map(|p| (p.rel.as_str(), p)).collect(),
            catalog,
            cascade: HashMap::new(),
        }
    }

    /// Enable supersede detection from a reverse link index (target rel →
    /// referrer rels), as produced by `backlinks::build_reverse_index`.
    #[must_use]
    pub fn with_reverse_index(
        mut self,
        reverse_index: &HashMap<String, Vec<String>>,
    ) -> Self {
        let mut cascade: HashMap<String, Vec<String>> = HashMap::new();
        for page in self.by_rel.values() {
            let superseding = superseding_paths(page);
            if superseding.is_empty() {
                continue;
            }
            let Some(referrers) = reverse_index.get(&page.rel) else {
                continue;
            };
            for referrer in referrers {
                // The superseding page itself may link back to the old page
                // by design — never flag it.
                if superseding.iter().any(|s| s == referrer) {
                    continue;
                }
                cascade
                    .entry(referrer.clone())
                    .or_default()
                    .push(page.rel.clone());
            }
        }
        for cited in cascade.values_mut() {
            cited.sort();
            cited.dedup();
        }
        self.cascade = cascade;
        self
    }

    /// Superseded pages still cited by `rel` (empty when none).
    #[must_use]
    pub fn cited_superseded(&self, rel: &str) -> &[String] {
        self.cascade.get(rel).map_or(&[], Vec::as_slice)
    }

    /// Judge one page.
    #[must_use]
    pub fn judge(&self, page: &Page) -> Freshness {
        let mut reasons = Vec::new();
        if !newer_sources(page, &self.by_rel, self.catalog).is_empty() {
            reasons.push(StaleReason::SourceNewer);
        }
        if self.has_unreviewed_supersede(page) {
            reasons.push(StaleReason::UnreviewedSupersede);
        }
        Freshness { reasons }
    }

    /// Whether `page` cites a superseded page confirmed since `page` was.
    ///
    /// A superseded page without a comparable timestamp is skipped.
    fn has_unreviewed_supersede(&self, page: &Page) -> bool {
        let Some(superseded) = self.cascade.get(&page.rel) else {
            return false;
        };
        let Some(confirmed) =
            wiki::parse_timestamp(&page.document.metadata.timestamp)
        else {
            return false;
        };
        superseded.iter().any(|rel| {
            self.by_rel.get(rel.as_str()).is_some_and(|p| {
                wiki::parse_timestamp(&p.document.metadata.timestamp)
                    .is_some_and(|moment| moment >= confirmed)
            })
        })
    }
}

/// Paths listed in a page's `superseded_by` field.
fn superseding_paths(page: &Page) -> Vec<String> {
    page.document
        .metadata
        .superseded_by
        .iter()
        .flatten()
        .map(|relation| relation.path.clone())
        .collect()
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use zwiki::document::PageDocument;

    use crate::wiki::Page;

    /// Build a `Page` from complete page text; the text must be valid.
    fn make_page(rel: &str, content: &str) -> Page {
        let document = PageDocument::parse(content)
            .unwrap_or_else(|e| panic!("invalid fixture {rel}: {e}"));
        Page { path: PathBuf::from(rel), rel: rel.to_string(), document }
    }

    /// Page text with the required fields plus `extra` frontmatter lines.
    fn page_text(
        page_type: &str,
        timestamp: &str,
        extra: &str,
        body: &str,
    ) -> String {
        format!(
            "---\ntitle: T\ntype: {page_type}\ntimestamp: {timestamp}\n\
             tags: []\n{extra}---\n\n{body}\n"
        )
    }

    // -------------------------------------------------------------------
    // SourceNewer
    // -------------------------------------------------------------------

    #[test]
    fn test_source_newer_flags_analysis() {
        let analysis = make_page(
            "shared/analysis/a.md",
            &page_text(
                "analysis",
                "2026-01-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text("source", "2026-06-01T00:00:00Z", "", "Body."),
        );
        let pages = vec![analysis, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog);
        let verdict = ctx.judge(&pages[0]);
        assert!(
            verdict.reasons().contains(&StaleReason::SourceNewer),
            "newer source should mark the analysis stale"
        );
    }

    #[test]
    fn test_source_newer_same_day_later_time() {
        // Both timestamps name the same day; the later time still counts.
        let analysis = make_page(
            "shared/analysis/a.md",
            &page_text(
                "analysis",
                "2026-06-01T08:00:00Z",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text("source", "2026-06-01T09:00:00Z", "", "Body."),
        );
        let pages = vec![analysis, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog);
        assert!(
            ctx.judge(&pages[0]).reasons().contains(&StaleReason::SourceNewer),
            "a later time on the same day counts as newer"
        );
    }

    #[test]
    fn test_source_newer_accepts_any_source_type() {
        for source_type in ["concept", "entity", "analysis", "synthesis"] {
            let analysis = make_page(
                "shared/analysis/a.md",
                &page_text(
                    "analysis",
                    "2026-01-01T00:00:00Z",
                    "sources: [shared/pages/bar.md]\n",
                    "Body.",
                ),
            );
            let source = make_page(
                "shared/pages/bar.md",
                &page_text(source_type, "2026-06-01T00:00:00Z", "", "Body."),
            );
            let pages = vec![analysis, source];
            let catalog = Catalog::flat(&pages);
            let ctx = FreshnessContext::new(&pages, &catalog);
            assert!(
                ctx.judge(&pages[0])
                    .reasons()
                    .contains(&StaleReason::SourceNewer),
                "a source of type {source_type} still counts"
            );
        }
    }

    #[test]
    fn test_source_spellings_report_one_source_newer() {
        // A `sources` entry may carry a markdown link; its target is the
        // same page as the bare path, in the bare and explicit forms.
        let analysis = make_page(
            "shared/analysis/a.md",
            &page_text(
                "analysis",
                "2026-01-01T00:00:00Z",
                "sources:\n  - '[Bar](shared/sources/bar.md)'\n  \
                 - '[Bar](@flat/shared/sources/bar.md)'\n  \
                 - shared/sources/bar.md\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text("source", "2026-06-01T00:00:00Z", "", "Body."),
        );
        let pages = vec![analysis, source];
        let by_rel: HashMap<&str, &Page> =
            pages.iter().map(|p| (p.rel.as_str(), p)).collect();
        let catalog = Catalog::flat(&pages);

        let newer = newer_sources(&pages[0], &by_rel, &catalog);
        let targets: Vec<&str> =
            newer.iter().map(|source| source.source.as_str()).collect();
        assert_eq!(
            targets,
            vec!["shared/sources/bar.md"],
            "every spelling of the entry names the same page once"
        );
    }

    #[test]
    fn test_source_newer_ignored_for_concept() {
        let concept = make_page(
            "shared/concepts/a.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text("source", "2026-09-01T00:00:00Z", "", "Body."),
        );
        let pages = vec![concept, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog);
        assert!(
            !ctx.judge(&pages[0]).reasons().contains(&StaleReason::SourceNewer),
            "only derived pages track source freshness"
        );
    }

    #[test]
    fn test_source_newer_skips_invalid_timestamp() {
        let analysis = make_page(
            "shared/analysis/a.md",
            &page_text(
                "analysis",
                "2026-01-01T00:00:00Z",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text("source", "2026-06-01", "", "Body."),
        );
        let pages = vec![analysis, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog);
        assert!(
            ctx.judge(&pages[0]).reasons().is_empty(),
            "a date-only source timestamp is not comparable"
        );
    }

    // -------------------------------------------------------------------
    // UnreviewedSupersede
    // -------------------------------------------------------------------

    fn cascade_context<'a>(
        pages: &'a [Page],
        catalog: &'a Catalog,
    ) -> FreshnessContext<'a> {
        // The reverse index maps the superseded page to its referrers.
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for page in pages {
            for other in pages {
                let body = other.document.body.author();
                if body.contains(&format!("({})", page.rel))
                    || body.contains(&format!(": {}", page.rel))
                {
                    reverse
                        .entry(page.rel.clone())
                        .or_default()
                        .push(other.rel.clone());
                }
            }
        }
        FreshnessContext::new(pages, catalog).with_reverse_index(&reverse)
    }

    #[test]
    fn test_unreviewed_supersede_flags_referrer() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    \
                 reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            &page_text(
                "concept",
                "2025-12-01T00:00:00Z",
                "",
                "# Referrer\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text("concept", "2026-02-01T00:00:00Z", "", "# New\n\nYes."),
        );
        let pages = vec![old, referrer, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        assert!(
            ctx.judge(&pages[1])
                .reasons()
                .contains(&StaleReason::UnreviewedSupersede),
            "unreviewed referrer should be flagged"
        );
    }

    #[test]
    fn test_reviewed_supersede_not_flagged() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    \
                 reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            &page_text(
                "concept",
                "2026-06-01T00:00:00Z",
                "",
                "# Referrer\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text("concept", "2026-06-01T00:00:00Z", "", "# New\n\nYes."),
        );
        let pages = vec![old, referrer, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        assert!(
            !ctx.judge(&pages[1])
                .reasons()
                .contains(&StaleReason::UnreviewedSupersede),
            "a referrer confirmed after the supersedure is reviewed"
        );
    }

    #[test]
    fn test_superseding_page_exempt() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    \
                 reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text(
                "concept",
                "2025-01-01T00:00:00Z",
                "",
                "# New\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let pages = vec![old, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        assert!(
            !ctx.judge(&pages[1])
                .reasons()
                .contains(&StaleReason::UnreviewedSupersede),
            "superseding page should be exempt"
        );
    }

    #[test]
    fn test_supersede_compares_full_timestamps() {
        // A referrer confirmed later on the same day counts as reviewed.
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    \
                 reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            &page_text(
                "concept",
                "2026-01-01T00:00:01Z",
                "",
                "# Referrer\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text("concept", "2026-01-01T00:00:00Z", "", "# New\n\nYes."),
        );
        let pages = vec![old, referrer, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        assert!(
            !ctx.judge(&pages[1])
                .reasons()
                .contains(&StaleReason::UnreviewedSupersede),
            "one second later is reviewed"
        );
    }
}
