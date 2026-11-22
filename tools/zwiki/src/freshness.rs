//! Unified page freshness judgment.
//!
//! Every staleness decision in this tool — lint gating, `timeliness`
//! materialisation, and `verify` reporting — is derived from the single
//! judgment implemented here.  Keeping the thresholds, exemptions, and
//! reason semantics in one module stops the consumers from drifting apart.

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::catalog::Catalog;
use crate::wiki::{self, Page};

/// Time-decay threshold (days) for `concept`, `entity`, and untyped pages.
const FRESHNESS_DAYS_DEFAULT: i64 = 180;

/// Time-decay threshold (days) for derived `analysis` / `synthesis` pages.
const FRESHNESS_DAYS_DERIVED: i64 = 90;

/// Independent reasons a page can be judged stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReason {
    /// `last_validated` is older than the page's time threshold.
    TimeExpired,
    /// A referenced source page has a newer `timestamp`.
    SourceNewer,
    /// A referenced page was superseded after this page was validated.
    UnreviewedSupersede,
}

impl StaleReason {
    /// Stable machine-readable label used in lint issue details.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TimeExpired => "time_expired",
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
    /// A page with no staleness reason.
    #[must_use]
    pub const fn fresh() -> Self {
        Self { reasons: Vec::new() }
    }

    /// Whether any staleness reason applies.
    #[must_use]
    pub const fn is_stale(&self) -> bool {
        !self.reasons.is_empty()
    }

    /// The staleness reasons, in discovery order.
    #[must_use]
    pub fn reasons(&self) -> &[StaleReason] {
        &self.reasons
    }

    /// The `timeliness` value this verdict materialises to.
    #[must_use]
    pub const fn timeliness(&self) -> &'static str {
        if self.is_stale() { "stale" } else { "current" }
    }
}

/// Time-decay threshold in days for `page`.
///
/// A page-level `freshness_days` override wins; otherwise `analysis` /
/// `synthesis` use the derived default and every other type falls back to
/// the standard default.
#[must_use]
pub fn threshold_days(page: &Page) -> i64 {
    if let Some(days) = page.document.metadata.freshness_days {
        return days;
    }
    match page.document.metadata.page_type.as_str() {
        "analysis" | "synthesis" => FRESHNESS_DAYS_DERIVED,
        _ => FRESHNESS_DAYS_DEFAULT,
    }
}

/// Pairs `(source_rel, source_date)` where a source page is newer than the
/// derived page's `last_validated`.
///
/// Applies only to `analysis` / `synthesis` pages with a non-empty `sources`
/// list and a parseable `last_validated`.  A bare entry names a page of the
/// derived page's bundle; `@bundle/path` names a page of `bundle`.  An entry
/// may carry a markdown link, which names its target.
/// Unresolvable sources and unparseable timestamps are skipped.
#[must_use]
pub fn stale_sources<'a>(
    page: &'a Page,
    by_rel: &HashMap<&'a str, &'a Page>,
    catalog: &Catalog,
) -> Vec<(String, NaiveDate)> {
    let metadata = &page.document.metadata;
    if !matches!(metadata.page_type.as_str(), "analysis" | "synthesis") {
        return Vec::new();
    }

    let sources = match metadata.sources.as_deref() {
        Some(sources) if !sources.is_empty() => sources,
        _ => return Vec::new(),
    };

    let Some(derived_date) = wiki::parse_date(&metadata.last_validated) else {
        return Vec::new();
    };

    let mut stale: Vec<(String, NaiveDate)> = Vec::new();
    for entry in sources {
        let Some(source_rel) = source_rel(page, entry, catalog) else {
            continue;
        };

        let Some(source_page) = by_rel.get(source_rel.as_str()) else {
            continue;
        };
        let Some(ts_str) = source_page.document.metadata.timestamp.as_deref()
        else {
            continue;
        };
        let Some(source_date) = wiki::parse_date(ts_str) else {
            continue;
        };

        if source_date > derived_date {
            stale.push((source_rel, source_date));
        }
    }

    stale
}

/// The page path a `sources` entry names, `None` when it names no page.
fn source_rel(page: &Page, entry: &str, catalog: &Catalog) -> Option<String> {
    let referrer = catalog.id_of(&page.rel)?;
    catalog.resolve_rel(referrer, entry).map(ToString::to_string)
}

/// Peer lookups the judgment needs.  Build the context once from the page
/// set (and, for supersede detection, a reverse link index), then judge any
/// number of pages with [`FreshnessContext::judge`].
pub struct FreshnessContext<'a> {
    reference_date: NaiveDate,
    by_rel: HashMap<&'a str, &'a Page>,
    /// Page identity for `sources` lookup.
    catalog: &'a Catalog,
    /// Referrer rel → superseded page rels it still cites.
    cascade: HashMap<String, Vec<String>>,
}

impl<'a> FreshnessContext<'a> {
    /// Build a context for time-decay and source checks.
    #[must_use]
    pub fn new(
        pages: &'a [Page],
        catalog: &'a Catalog,
        reference_date: NaiveDate,
    ) -> Self {
        Self {
            reference_date,
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
    ///
    /// Returns `None` when the page does not participate: `deprecated`
    /// pages, and pages whose `last_validated` is unparseable.
    /// `source` pages always judge fresh.
    #[must_use]
    pub fn judge(&self, page: &Page) -> Option<Freshness> {
        let metadata = &page.document.metadata;
        if metadata.status == "deprecated" {
            return None;
        }

        // Source pages never expire.
        if metadata.page_type == "source" {
            return Some(Freshness::fresh());
        }

        let lv_str = metadata.last_validated.as_str();
        let lv_date = wiki::parse_date(lv_str)?;

        let mut reasons = Vec::new();
        if (self.reference_date - lv_date).num_days() > threshold_days(page) {
            reasons.push(StaleReason::TimeExpired);
        }
        if !stale_sources(page, &self.by_rel, self.catalog).is_empty() {
            reasons.push(StaleReason::SourceNewer);
        }
        if self.has_unreviewed_supersede(page, lv_str) {
            reasons.push(StaleReason::UnreviewedSupersede);
        }

        Some(Freshness { reasons })
    }

    /// Whether `page` cites a superseded page it has not been validated
    /// after.
    fn has_unreviewed_supersede(&self, page: &Page, lv_str: &str) -> bool {
        let Some(superseded) = self.cascade.get(&page.rel) else {
            return false;
        };
        superseded.iter().any(|rel| {
            self.by_rel.get(rel.as_str()).is_some_and(|p| {
                lv_str <= p.document.metadata.last_validated.as_str()
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
        status: &str,
        last_validated: &str,
        extra: &str,
        body: &str,
    ) -> String {
        format!(
            "---\ntitle: T\ntype: {page_type}\ntags: []\nstatus: {status}\n\
             last_validated: {last_validated}\ntimeliness: current\n\
             {extra}---\n\n{body}\n"
        )
    }

    fn reference() -> NaiveDate {
        NaiveDate::parse_from_str("2026-10-05", "%Y-%m-%d").unwrap()
    }

    /// A page validated `days_ago` days before the reference date.
    fn page_validated(rel: &str, type_str: &str, days_ago: i64) -> Page {
        let lv = (reference() - chrono::Duration::days(days_ago))
            .format("%Y-%m-%d")
            .to_string();
        make_page(rel, &page_text(type_str, "draft", &lv, "", "Body."))
    }

    fn judge_one(page: &Page) -> Option<Freshness> {
        let pages = vec![page.clone()];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog, reference());
        ctx.judge(&pages[0])
    }

    // -------------------------------------------------------------------
    // Time-decay thresholds
    // -------------------------------------------------------------------

    #[test]
    fn test_concept_181_days_is_stale() {
        let page = page_validated("c.md", "concept", 181);
        let verdict = judge_one(&page).expect("concept should be judged");
        assert_eq!(verdict.reasons(), &[StaleReason::TimeExpired]);
    }

    #[test]
    fn test_concept_179_days_is_fresh() {
        let page = page_validated("c.md", "concept", 179);
        let verdict = judge_one(&page).expect("concept should be judged");
        assert!(!verdict.is_stale());
        assert_eq!(verdict.timeliness(), "current");
    }

    #[test]
    fn test_synthesis_91_days_is_stale() {
        let page = page_validated("s.md", "synthesis", 91);
        let verdict = judge_one(&page).expect("synthesis should be judged");
        assert_eq!(verdict.reasons(), &[StaleReason::TimeExpired]);
    }

    #[test]
    fn test_synthesis_89_days_is_fresh() {
        let page = page_validated("s.md", "synthesis", 89);
        let verdict = judge_one(&page).expect("synthesis should be judged");
        assert!(!verdict.is_stale());
    }

    #[test]
    fn test_entity_uses_default_threshold() {
        let page = page_validated("e.md", "entity", 181);
        let verdict = judge_one(&page).expect("entity should be judged");
        assert_eq!(verdict.reasons(), &[StaleReason::TimeExpired]);
    }

    #[test]
    fn test_freshness_days_override_beats_type_default() {
        // 100 days old analysis would be stale at the 90-day derived
        // default, but the override raises the threshold to 200.
        let lv = (reference() - chrono::Duration::days(100))
            .format("%Y-%m-%d")
            .to_string();
        let page = make_page(
            "a.md",
            &page_text(
                "analysis",
                "draft",
                &lv,
                "freshness_days: 200\n",
                "Body.",
            ),
        );
        let verdict = judge_one(&page).expect("analysis should be judged");
        assert!(!verdict.is_stale(), "override should keep the page fresh");
    }

    // -------------------------------------------------------------------
    // Exemptions and skip rules
    // -------------------------------------------------------------------

    #[test]
    fn test_source_never_stale() {
        let page = page_validated("src.md", "source", 5000);
        let verdict = judge_one(&page).expect("source should be judged");
        assert!(!verdict.is_stale());
        assert_eq!(verdict.timeliness(), "current");
    }

    #[test]
    fn test_deprecated_not_judged() {
        let lv = (reference() - chrono::Duration::days(5000))
            .format("%Y-%m-%d")
            .to_string();
        let page = make_page(
            "d.md",
            &page_text("concept", "deprecated", &lv, "", "Body."),
        );
        assert!(judge_one(&page).is_none(), "deprecated pages do not judge");
    }

    #[test]
    fn test_unparseable_last_validated_skipped() {
        let page = make_page(
            "n.md",
            &page_text("concept", "draft", "not-a-date", "", "Body."),
        );
        assert!(judge_one(&page).is_none(), "bad lv should be skipped");
    }

    #[test]
    fn test_old_timestamp_new_last_validated_is_fresh() {
        // The core regression: a long-unedited page that was validated
        // recently must not be flagged stale.
        let page = make_page(
            "c.md",
            &page_text(
                "concept",
                "stable",
                "2026-10-01",
                "timestamp: 2020-01-01\n",
                "Body.",
            ),
        );
        let verdict = judge_one(&page).expect("page should be judged");
        assert!(!verdict.is_stale(), "recent validation keeps page fresh");
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
                "draft",
                "2026-01-01",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text(
                "source",
                "draft",
                "2026-10-05",
                "timestamp: 2026-06-01\n",
                "Body.",
            ),
        );
        let pages = vec![analysis, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog, reference());
        let verdict = ctx.judge(&pages[0]).expect("analysis judged");
        assert!(
            verdict.reasons().contains(&StaleReason::SourceNewer),
            "newer source should mark the analysis stale"
        );
    }

    #[test]
    fn test_markdown_link_source_names_the_same_page() {
        // A `sources` entry may carry a markdown link; its target is the
        // same page as the bare path, in the bare and explicit forms.
        let analysis = make_page(
            "shared/analysis/a.md",
            &page_text(
                "analysis",
                "draft",
                "2026-01-01",
                "sources:\n  - '[Bar](shared/sources/bar.md)'\n  \
                 - '[Bar](@flat/shared/sources/bar.md)'\n  \
                 - shared/sources/bar.md\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text(
                "source",
                "draft",
                "2026-10-05",
                "timestamp: 2026-06-01\n",
                "Body.",
            ),
        );
        let pages = vec![analysis, source];
        let by_rel: HashMap<&str, &Page> =
            pages.iter().map(|p| (p.rel.as_str(), p)).collect();
        let catalog = Catalog::flat(&pages);

        let stale = stale_sources(&pages[0], &by_rel, &catalog);
        let targets: Vec<&str> =
            stale.iter().map(|(rel, _)| rel.as_str()).collect();
        assert_eq!(
            targets,
            vec![
                "shared/sources/bar.md",
                "shared/sources/bar.md",
                "shared/sources/bar.md"
            ],
            "every spelling of the entry names the same page"
        );
    }

    #[test]
    fn test_source_newer_ignored_for_concept() {
        let concept = make_page(
            "shared/concepts/a.md",
            &page_text(
                "concept",
                "draft",
                "2026-10-01",
                "sources: [shared/sources/bar.md]\n",
                "Body.",
            ),
        );
        let source = make_page(
            "shared/sources/bar.md",
            &page_text(
                "source",
                "draft",
                "2026-10-05",
                "timestamp: 2026-09-01\n",
                "Body.",
            ),
        );
        let pages = vec![concept, source];
        let catalog = Catalog::flat(&pages);
        let ctx = FreshnessContext::new(&pages, &catalog, reference());
        let verdict = ctx.judge(&pages[0]).expect("concept judged");
        assert!(
            !verdict.reasons().contains(&StaleReason::SourceNewer),
            "only derived pages track source freshness"
        );
    }

    // -------------------------------------------------------------------
    // UnreviewedSupersede
    // -------------------------------------------------------------------

    fn cascade_context<'a>(
        pages: &'a [Page],
        catalog: &'a Catalog,
    ) -> FreshnessContext<'a> {
        use std::collections::HashMap;

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
        FreshnessContext::new(pages, catalog, reference())
            .with_reverse_index(&reverse)
    }

    #[test]
    fn test_unreviewed_supersede_flags_referrer() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "stable",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            &page_text(
                "concept",
                "stable",
                "2025-12-01T00:00:00Z",
                "",
                "# Referrer\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text(
                "concept",
                "stable",
                "2026-02-01T00:00:00Z",
                "",
                "# New\n\nContent.",
            ),
        );
        let pages = vec![old, referrer, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        let verdict = ctx.judge(&pages[1]).expect("referrer judged");
        assert!(
            verdict.reasons().contains(&StaleReason::UnreviewedSupersede),
            "unreviewed referrer should be flagged"
        );
    }

    #[test]
    fn test_reviewed_supersede_not_flagged() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "stable",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            &page_text(
                "concept",
                "stable",
                "2026-06-01T00:00:00Z",
                "",
                "# Referrer\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text(
                "concept",
                "stable",
                "2026-06-01T00:00:00Z",
                "",
                "# New\n\nContent.",
            ),
        );
        let pages = vec![old, referrer, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        let verdict = ctx.judge(&pages[1]).expect("referrer judged");
        assert!(
            !verdict.reasons().contains(&StaleReason::UnreviewedSupersede),
            "reviewed referrer should not be flagged"
        );
    }

    #[test]
    fn test_superseding_page_exempt() {
        let old = make_page(
            "shared/concepts/old.md",
            &page_text(
                "concept",
                "stable",
                "2026-01-01T00:00:00Z",
                "superseded_by:\n  - path: shared/concepts/new.md\n    reason: replaced\n",
                "# Old\n\nContent.",
            ),
        );
        let new = make_page(
            "shared/concepts/new.md",
            &page_text(
                "concept",
                "stable",
                "2025-01-01T00:00:00Z",
                "",
                "# New\n\nSee [old](shared/concepts/old.md).",
            ),
        );
        let pages = vec![old, new];
        let catalog = Catalog::flat(&pages);
        let ctx = cascade_context(&pages, &catalog);
        let verdict = ctx.judge(&pages[1]).expect("superseding page judged");
        assert!(
            !verdict.reasons().contains(&StaleReason::UnreviewedSupersede),
            "superseding page should be exempt"
        );
    }
}
