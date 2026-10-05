//! Unified page freshness judgment.
//!
//! Every staleness decision in this tool — lint gating, `timeliness`
//! materialisation, and `verify` reporting — is derived from the single
//! judgment implemented here.  Keeping the thresholds, exemptions, and
//! reason semantics in one module stops the consumers from drifting apart.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde_json::Value;

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
/// A page-level `freshness_days` override (integer or numeric string) wins;
/// otherwise `analysis` / `synthesis` use the derived default and every
/// other type falls back to the standard default.
#[must_use]
pub fn threshold_days(page: &Page) -> i64 {
    if let Some(days) = page.frontmatter.get("freshness_days").and_then(|v| {
        v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    }) {
        return days;
    }
    match page.frontmatter.get("type").and_then(|v| v.as_str()) {
        Some("analysis" | "synthesis") => FRESHNESS_DAYS_DERIVED,
        _ => FRESHNESS_DAYS_DEFAULT,
    }
}

/// Pairs `(source_rel, source_date)` where a source page is newer than the
/// derived page's `last_validated`.
///
/// Applies only to `analysis` / `synthesis` pages with a non-empty `sources`
/// array and a parseable `last_validated`.  Unresolvable sources and
/// unparseable timestamps are silently skipped.
#[must_use]
pub fn stale_sources<'a>(
    page: &'a Page,
    by_rel: &HashMap<&'a str, &'a Page>,
) -> Vec<(String, NaiveDate)> {
    if !matches!(
        page.frontmatter.get("type").and_then(|v| v.as_str()),
        Some("analysis" | "synthesis")
    ) {
        return Vec::new();
    }

    let sources = match page.frontmatter.get("sources") {
        Some(Value::Array(arr)) if !arr.is_empty() => arr,
        _ => return Vec::new(),
    };

    let Some(lv_str) =
        page.frontmatter.get("last_validated").and_then(|v| v.as_str())
    else {
        return Vec::new();
    };
    let Some(derived_date) = wiki::parse_date(lv_str) else {
        return Vec::new();
    };

    let mut stale: Vec<(String, NaiveDate)> = Vec::new();
    for source_val in sources {
        let Some(source_rel_in) = source_val.as_str() else {
            continue;
        };
        let source_rel = if std::path::Path::new(source_rel_in)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            source_rel_in.to_string()
        } else {
            format!("{source_rel_in}.md")
        };

        let Some(source_page) = by_rel.get(source_rel.as_str()) else {
            continue;
        };
        let Some(ts_str) =
            source_page.frontmatter.get("timestamp").and_then(|v| v.as_str())
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

/// Peer lookups the judgment needs.  Build the context once from the page
/// set (and, for supersede detection, a reverse link index), then judge any
/// number of pages with [`FreshnessContext::judge`].
pub struct FreshnessContext<'a> {
    reference_date: NaiveDate,
    by_rel: HashMap<&'a str, &'a Page>,
    /// Referrer rel → superseded page rels it still cites.
    cascade: HashMap<String, Vec<String>>,
}

impl<'a> FreshnessContext<'a> {
    /// Build a context for time-decay and source checks.
    #[must_use]
    pub fn new(pages: &'a [Page], reference_date: NaiveDate) -> Self {
        Self {
            reference_date,
            by_rel: pages.iter().map(|p| (p.rel.as_str(), p)).collect(),
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
    /// pages, and pages whose `last_validated` is missing or unparseable.
    /// `source` pages always judge fresh.
    #[must_use]
    pub fn judge(&self, page: &Page) -> Option<Freshness> {
        if status(page) == "deprecated" {
            return None;
        }

        // Source pages never expire.
        if page.frontmatter.get("type").and_then(|v| v.as_str())
            == Some("source")
        {
            return Some(Freshness::fresh());
        }

        let lv_str =
            page.frontmatter.get("last_validated").and_then(|v| v.as_str())?;
        let lv_date = wiki::parse_date(lv_str)?;

        let mut reasons = Vec::new();
        if (self.reference_date - lv_date).num_days() > threshold_days(page) {
            reasons.push(StaleReason::TimeExpired);
        }
        if !stale_sources(page, &self.by_rel).is_empty() {
            reasons.push(StaleReason::SourceNewer);
        }
        if self.has_unreviewed_supersede(page, lv_str) {
            reasons.push(StaleReason::UnreviewedSupersede);
        }

        Some(Freshness { reasons })
    }

    /// Whether `page` cites a superseded page it has not been validated
    /// after.  A superseded page without `last_validated` cannot be compared,
    /// so the referrer is flagged.
    fn has_unreviewed_supersede(&self, page: &Page, lv_str: &str) -> bool {
        let Some(superseded) = self.cascade.get(&page.rel) else {
            return false;
        };
        superseded.iter().any(|rel| {
            self.by_rel
                .get(rel.as_str())
                .and_then(|p| p.frontmatter.get("last_validated"))
                .and_then(|v| v.as_str())
                .is_none_or(|sup_lv| lv_str <= sup_lv)
        })
    }
}

/// Page status, defaulting to an empty string when absent.
fn status(page: &Page) -> &str {
    page.frontmatter.get("status").and_then(|v| v.as_str()).unwrap_or("")
}

/// Paths listed in a page's `superseded_by` field.
fn superseding_paths(page: &Page) -> Vec<String> {
    match page.frontmatter.get("superseded_by") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("path").and_then(|v| v.as_str()))
                    .map(str::to_string)
                    .or_else(|| {
                        item.as_str()
                            .and_then(|s| s.strip_prefix("path: "))
                            .map(str::to_string)
                    })
            })
            .collect(),
        _ => Vec::new(),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::wiki::{self, Page};

    /// Build a `Page` from content with frontmatter.
    fn make_page(rel: &str, content: &str) -> Page {
        let path = PathBuf::from(rel);
        let frontmatter = wiki::parse_frontmatter(content);
        let body = wiki::strip_frontmatter(content);
        Page {
            path,
            rel: rel.to_string(),
            frontmatter,
            body,
            raw: content.to_string(),
        }
    }

    fn reference() -> NaiveDate {
        NaiveDate::parse_from_str("2026-10-05", "%Y-%m-%d").unwrap()
    }

    /// A page validated `days_ago` days before the reference date.
    fn page_validated(rel: &str, type_str: &str, days_ago: i64) -> Page {
        let lv = (reference() - chrono::Duration::days(days_ago))
            .format("%Y-%m-%d")
            .to_string();
        make_page(
            rel,
            &format!(
                "---\ntitle: T\ntype: {type_str}\nstatus: draft\n\
                 last_validated: {lv}\n---\nBody.\n"
            ),
        )
    }

    fn judge_one(page: &Page) -> Option<Freshness> {
        let pages = vec![page.clone()];
        let ctx = FreshnessContext::new(&pages, reference());
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
        let page = make_page(
            "a.md",
            &format!(
                "---\ntitle: T\ntype: analysis\nstatus: draft\n\
                 freshness_days: 200\nlast_validated: {}\n---\nBody.\n",
                (reference() - chrono::Duration::days(100)).format("%Y-%m-%d")
            ),
        );
        let verdict = judge_one(&page).expect("analysis should be judged");
        assert!(!verdict.is_stale(), "override should keep the page fresh");
    }

    #[test]
    fn test_freshness_days_string_accepted() {
        let page = make_page(
            "a.md",
            &format!(
                "---\ntitle: T\ntype: analysis\nstatus: draft\n\
                 freshness_days: \"200\"\nlast_validated: {}\n---\nBody.\n",
                (reference() - chrono::Duration::days(100)).format("%Y-%m-%d")
            ),
        );
        let verdict = judge_one(&page).expect("analysis should be judged");
        assert!(!verdict.is_stale(), "numeric string override should apply");
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
        let page = make_page(
            "d.md",
            &format!(
                "---\ntitle: T\ntype: concept\nstatus: deprecated\n\
                 last_validated: {}\n---\nBody.\n",
                (reference() - chrono::Duration::days(5000)).format("%Y-%m-%d")
            ),
        );
        assert!(judge_one(&page).is_none(), "deprecated pages do not judge");
    }

    #[test]
    fn test_missing_last_validated_skipped() {
        let page = make_page(
            "n.md",
            "---\ntitle: T\ntype: concept\nstatus: draft\n---\nBody.\n",
        );
        assert!(judge_one(&page).is_none(), "missing lv should be skipped");
    }

    #[test]
    fn test_unparseable_last_validated_skipped() {
        let page = make_page(
            "n.md",
            "---\ntitle: T\ntype: concept\nstatus: draft\n\
             last_validated: not-a-date\n---\nBody.\n",
        );
        assert!(judge_one(&page).is_none(), "bad lv should be skipped");
    }

    #[test]
    fn test_old_timestamp_new_last_validated_is_fresh() {
        // The core regression: a long-unedited page that was validated
        // recently must not be flagged stale.
        let page = make_page(
            "c.md",
            "---\ntitle: T\ntype: concept\nstatus: stable\n\
             timestamp: 2020-01-01\nlast_validated: 2026-10-01\n---\nBody.\n",
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
            "---\ntitle: A\ntype: analysis\nstatus: draft\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2026-01-01\n---\nBody.\n",
        );
        let source = make_page(
            "shared/sources/bar.md",
            "---\ntitle: B\ntype: source\ntimestamp: 2026-06-01\n---\nBody.\n",
        );
        let pages = vec![analysis, source];
        let ctx = FreshnessContext::new(&pages, reference());
        let verdict = ctx.judge(&pages[0]).expect("analysis judged");
        assert!(
            verdict.reasons().contains(&StaleReason::SourceNewer),
            "newer source should mark the analysis stale"
        );
    }

    #[test]
    fn test_source_newer_ignored_for_concept() {
        let concept = make_page(
            "shared/concepts/a.md",
            "---\ntitle: A\ntype: concept\nstatus: draft\n\
             sources: [shared/sources/bar.md]\n\
             last_validated: 2026-10-01\n---\nBody.\n",
        );
        let source = make_page(
            "shared/sources/bar.md",
            "---\ntitle: B\ntype: source\ntimestamp: 2026-09-01\n---\nBody.\n",
        );
        let pages = vec![concept, source];
        let ctx = FreshnessContext::new(&pages, reference());
        let verdict = ctx.judge(&pages[0]).expect("concept judged");
        assert!(
            !verdict.reasons().contains(&StaleReason::SourceNewer),
            "only derived pages track source freshness"
        );
    }

    // -------------------------------------------------------------------
    // UnreviewedSupersede
    // -------------------------------------------------------------------

    fn cascade_context(pages: &[Page]) -> FreshnessContext<'_> {
        use std::collections::HashMap;

        // The reverse index maps the superseded page to its referrers.
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for page in pages {
            for other in pages {
                if other.raw.contains(&format!("({})", page.rel))
                    || other.raw.contains(&format!(": {}", page.rel))
                {
                    reverse
                        .entry(page.rel.clone())
                        .or_default()
                        .push(other.rel.clone());
                }
            }
        }
        FreshnessContext::new(pages, reference()).with_reverse_index(&reverse)
    }

    #[test]
    fn test_unreviewed_supersede_flags_referrer() {
        let old = make_page(
            "shared/concepts/old.md",
            "---\ntitle: Old\nstatus: stable\n\
             superseded_by: [path: shared/concepts/new.md]\n\
             last_validated: 2026-01-01T00:00:00Z\n---\n# Old\n\nContent.\n",
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            "---\ntitle: Referrer\nstatus: stable\n\
             last_validated: 2025-12-01T00:00:00Z\n---\n\
             # Referrer\n\nSee [old](shared/concepts/old.md).\n",
        );
        let new = make_page(
            "shared/concepts/new.md",
            "---\ntitle: New\nstatus: stable\n\
             last_validated: 2026-02-01T00:00:00Z\n---\n# New\n\nContent.\n",
        );
        let pages = vec![old, referrer, new];
        let ctx = cascade_context(&pages);
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
            "---\ntitle: Old\nstatus: stable\n\
             superseded_by: [path: shared/concepts/new.md]\n\
             last_validated: 2026-01-01T00:00:00Z\n---\n# Old\n\nContent.\n",
        );
        let referrer = make_page(
            "shared/concepts/referrer.md",
            "---\ntitle: Referrer\nstatus: stable\n\
             last_validated: 2026-06-01T00:00:00Z\n---\n\
             # Referrer\n\nSee [old](shared/concepts/old.md).\n",
        );
        let new = make_page(
            "shared/concepts/new.md",
            "---\ntitle: New\nstatus: stable\n\
             last_validated: 2026-06-01T00:00:00Z\n---\n# New\n\nContent.\n",
        );
        let pages = vec![old, referrer, new];
        let ctx = cascade_context(&pages);
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
            "---\ntitle: Old\nstatus: stable\n\
             superseded_by: [path: shared/concepts/new.md]\n\
             last_validated: 2026-01-01T00:00:00Z\n---\n# Old\n\nContent.\n",
        );
        let new = make_page(
            "shared/concepts/new.md",
            "---\ntitle: New\nstatus: stable\n\
             last_validated: 2025-01-01T00:00:00Z\n---\n# New\n\n\
             See [old](shared/concepts/old.md).\n",
        );
        let pages = vec![old, new];
        let ctx = cascade_context(&pages);
        let verdict = ctx.judge(&pages[1]).expect("superseding page judged");
        assert!(
            !verdict.reasons().contains(&StaleReason::UnreviewedSupersede),
            "superseding page should be exempt"
        );
    }
}
