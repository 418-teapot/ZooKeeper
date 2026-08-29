//! Host auto-selection: unified entry points that pick the right session
//! provider for a [`HostFilter`] and open / search / list host sessions.
//!
//! Downstream CLI tools call [`open_session`], [`search_sessions`],
//! [`list_sessions`] and [`find_events_across`] instead of wiring host
//! detection themselves; the provider choice lives here only. Each
//! result is tagged with its [`Host`], so callers never map vector
//! positions back to hosts. Callers that assemble their own provider
//! list (e.g. to probe an explicit `--db` database first) reuse
//! [`open_with`] on that list.

use std::fmt;
use std::io;

use crate::session::model::{
    DetectedHost, Host, HostFilter, Session, SessionEvent, SessionMeta,
    detect_host,
};
#[cfg(feature = "db-helpers")]
use crate::session::opencode::OpenCodeSessionProvider;
use crate::session::pi::PiSessionProvider;
use crate::session::provider::SessionProvider;

/// Errors from resolving a session id against host providers.
///
/// The structured variants let CLI tools render miss and ambiguity
/// messages directly instead of slicing error text.
#[derive(Debug)]
pub enum ResolveError {
    /// No provider found a session for the requested id or prefix.
    NotFound {
        /// The id or prefix that was looked up.
        id: String,
        /// Host names that were probed, in probe order.
        tried_hosts: Vec<String>,
    },
    /// A provider matched more than one session for the prefix.
    Ambiguous {
        /// The ambiguous prefix.
        prefix: String,
        /// Every matching session id.
        matches: Vec<String>,
    },
    /// A genuine storage error, propagated verbatim.
    Io(io::Error),
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { id, tried_hosts } => {
                let tried = if tried_hosts.is_empty() {
                    "none".to_string()
                } else {
                    tried_hosts.join(", ")
                };
                write!(f, "no session matches {id:?} (tried hosts: {tried})")
            }
            Self::Ambiguous { prefix, matches } => write!(
                f,
                "ambiguous session prefix {prefix:?}: {}",
                matches.join(", ")
            ),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ResolveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for ResolveError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Construct the providers selected by `filter`, each paired with its
/// host, in probe order.
///
/// `Auto` yields `OpenCode` first, then pi — the same precedence the
/// crate-wide [`crate::resolve_session_path`] applies to log-file host
/// collisions. `Only` yields the single matching provider; an `Only`
/// request for a host that is not compiled in (the `OpenCode` provider
/// needs the `db-helpers` feature) yields an empty list.
#[must_use]
pub fn providers(filter: HostFilter) -> Vec<(Host, Box<dyn SessionProvider>)> {
    let mut out: Vec<(Host, Box<dyn SessionProvider>)> = Vec::new();
    match filter {
        HostFilter::Auto => {
            #[cfg(feature = "db-helpers")]
            out.push((
                Host::OpenCode,
                Box::new(OpenCodeSessionProvider::new()),
            ));
            out.push((Host::Pi, Box::new(PiSessionProvider::new())));
        }
        HostFilter::Only(Host::OpenCode) => {
            #[cfg(feature = "db-helpers")]
            out.push((
                Host::OpenCode,
                Box::new(OpenCodeSessionProvider::new()),
            ));
        }
        HostFilter::Only(Host::Pi) => {
            out.push((Host::Pi, Box::new(PiSessionProvider::new())));
        }
    }
    out
}

/// Open a session by full id or unique prefix, resolving its host.
///
/// `Auto` first applies the id-shape fast path via [`detect_host`]: a
/// `ses_`-prefixed id is tried against `OpenCode` only, a `UUID`-shaped
/// id against pi only. Ids matching neither shape probe both hosts in
/// [`providers`] order, and the first successful open wins. `Only`
/// probes its single host regardless of id shape, so a mismatched shape
/// still yields `NotFound` instead of falling through.
///
/// # Errors
///
/// Returns [`ResolveError::Ambiguous`] when a host reports an ambiguous
/// id prefix — the exact-match / prefix rule makes that information
/// actionable, so it is surfaced immediately instead of being treated as
/// a miss. Returns [`ResolveError::NotFound`] when no host matches; the
/// error lists every host that was tried. Genuine storage errors are
/// propagated as [`ResolveError::Io`].
pub fn open_session(
    filter: HostFilter,
    id_or_prefix: &str,
) -> Result<(Host, Session), ResolveError> {
    let list = providers(filter);
    open_with(&list, filter, id_or_prefix)
}

/// Shared open logic over an explicit provider list.
///
/// [`open_session`] passes the env-based providers; tests inject
/// fixture-rooted ones, which is why this logic is factored out. Callers
/// that build their own provider list — e.g. `ztrace` binding a
/// `--db`-selected [`OpenCodeSessionProvider::with_db_path`] into the
/// probe order — can reuse this entry point directly.
///
/// # Errors
///
/// Mirrors [`open_session`]: an [`ResolveError::Ambiguous`] ambiguous
/// prefix, a [`ResolveError::NotFound`] miss listing the tried hosts, or
/// the provider's storage error verbatim.
pub fn open_with(
    list: &[(Host, Box<dyn SessionProvider>)],
    filter: HostFilter,
    id_or_prefix: &str,
) -> Result<(Host, Session), ResolveError> {
    let order = match filter {
        HostFilter::Only(host) => vec![host],
        HostFilter::Auto => match detect_host(id_or_prefix) {
            DetectedHost::OpenCode => vec![Host::OpenCode],
            DetectedHost::Pi => vec![Host::Pi],
            DetectedHost::Unknown => vec![Host::OpenCode, Host::Pi],
        },
    };
    let mut tried: Vec<&'static str> = Vec::new();
    for (host, provider) in list {
        if !order.contains(host) {
            continue;
        }
        tried.push(host.name());
        match provider.open(id_or_prefix) {
            Ok(session) => return Ok((*host, session)),
            // "Not here" — keep probing the remaining hosts in order.
            Err(ResolveError::NotFound { .. }) => {}
            // Ambiguous prefixes and genuine storage errors carry useful
            // detail; surface them rather than mask them as a miss.
            Err(
                err @ (ResolveError::Ambiguous { .. } | ResolveError::Io(_)),
            ) => {
                return Err(err);
            }
        }
    }
    Err(ResolveError::NotFound {
        id: id_or_prefix.to_string(),
        tried_hosts: tried.iter().map(|host| (*host).to_string()).collect(),
    })
}

/// Search session content across the hosts selected by `filter`.
///
/// Runs each selected provider's search and merges the hits into one
/// list, sorted by start time then id, each entry tagged with its host.
///
/// # Errors
///
/// Returns an I/O error when any provider cannot read its storage.
pub fn search_sessions(
    filter: HostFilter,
    query: &str,
) -> io::Result<Vec<(Host, SessionMeta)>> {
    let list = providers(filter);
    collect_metas_with(&list, |p| p.search(query))
}

/// List every session across the hosts selected by `filter`.
///
/// Merges each provider's listing into one list, sorted by start time
/// then id, each entry tagged with its host.
///
/// # Errors
///
/// Returns an I/O error when any provider cannot read its storage.
pub fn list_sessions(
    filter: HostFilter,
) -> io::Result<Vec<(Host, SessionMeta)>> {
    let list = providers(filter);
    collect_metas_with(&list, |p| p.list())
}

/// Find events matching any wanted id prefix across the hosts selected
/// by `filter`.
///
/// Each provider scans its `max_sessions` most recent sessions for
/// events whose id starts with any of `ids` and reports the matching
/// sessions (metadata plus events); results are tagged with their host.
///
/// # Errors
///
/// Returns an I/O error when any provider cannot read its storage.
pub fn find_events_across(
    filter: HostFilter,
    ids: &[String],
    max_sessions: usize,
) -> io::Result<Vec<(Host, SessionMeta, Vec<SessionEvent>)>> {
    let list = providers(filter);
    find_events_with(&list, ids, max_sessions)
}

/// Shared find-events merge over an explicit provider list.
///
/// [`find_events_across`] passes the env-based providers; tests inject
/// fixture-rooted ones, mirroring [`collect_metas_with`].
fn find_events_with(
    list: &[(Host, Box<dyn SessionProvider>)],
    ids: &[String],
    max_sessions: usize,
) -> io::Result<Vec<(Host, SessionMeta, Vec<SessionEvent>)>> {
    let mut out = Vec::new();
    for (host, provider) in list {
        for (meta, events) in provider.find_events(ids, max_sessions)? {
            out.push((*host, meta, events));
        }
    }
    Ok(out)
}

/// Shared list/search merge over an explicit provider list.
///
/// `collect` maps a provider to its metadata; results are tagged with
/// their host and sorted by start time then id.
fn collect_metas_with(
    list: &[(Host, Box<dyn SessionProvider>)],
    collect: impl Fn(&dyn SessionProvider) -> io::Result<Vec<SessionMeta>>,
) -> io::Result<Vec<(Host, SessionMeta)>> {
    let mut out = Vec::new();
    for (host, provider) in list {
        for meta in collect(&**provider)? {
            out.push((*host, meta));
        }
    }
    out.sort_by(|(_, a), (_, b)| {
        (a.started_at, &a.id).cmp(&(b.started_at, &b.id))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[cfg(feature = "db-helpers")]
    use rusqlite::Connection;

    use crate::session::model::{Host, HostFilter};
    #[cfg(feature = "db-helpers")]
    use crate::session::opencode::OpenCodeSessionProvider;
    use crate::session::pi::PiSessionProvider;
    use crate::session::provider::SessionProvider;
    #[cfg(feature = "db-helpers")]
    use crate::test_db::{create_common_tables, create_part_table};

    // ── fixtures ──────────────────────────────────────────────────────

    /// Assert an open miss reports the expected id and tried hosts.
    fn assert_not_found(err: ResolveError, id: &str, tried: &[&str]) {
        match err {
            ResolveError::NotFound { id: err_id, tried_hosts } => {
                assert_eq!(err_id, id);
                let expected: Vec<String> =
                    tried.iter().map(|h| (*h).to_string()).collect();
                assert_eq!(tried_hosts, expected);
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    /// Assert an ambiguous prefix error carries every expected match id.
    fn assert_ambiguous(err: ResolveError, prefix: &str, wants: &[&str]) {
        match err {
            ResolveError::Ambiguous { prefix: p, matches } => {
                assert_eq!(p, prefix);
                for want in wants {
                    assert!(
                        matches.iter().any(|m| m == want),
                        "missing {want:?} in {matches:?}"
                    );
                }
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    /// Build a temp pi data dir with one `jsonl` session file per entry
    /// `(id, started_ms, first_user_text)`. Returns the root; the caller
    /// removes it after the test.
    fn pi_fixture(
        tag: &str,
        sessions: &[(&str, i64, Option<&str>)],
    ) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zutil-resolve-pi-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("sessions");
        std::fs::create_dir_all(&root).expect("create pi sessions dir");
        for (i, (id, started_at, text)) in sessions.iter().enumerate() {
            let cwd = root.join(format!("dir-{i}"));
            std::fs::create_dir_all(&cwd).expect("create pi cwd dir");
            let mut lines = vec![format!(
                r#"{{"type":"session","version":3,"id":"{id}","timestamp":"{}","cwd":"/w"}}"#,
                crate::epoch_ms_to_iso(*started_at)
            )];
            if let Some(text) = text {
                lines.push(format!(
                    r#"{{"type":"message","id":"m{i}","timestamp":"{}","message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}}}"#,
                    crate::epoch_ms_to_iso(*started_at + 1)
                ));
            }
            std::fs::write(cwd.join(format!("{i}.jsonl")), lines.join("\n"))
                .expect("write pi session file");
        }
        dir
    }

    /// Build a temp dir holding `opencode.db` with one `session` row per
    /// entry `(id, started_ms, title)`. Returns the dir; the caller
    /// removes it after the test.
    #[cfg(feature = "db-helpers")]
    fn oc_fixture(
        tag: &str,
        sessions: &[(&str, i64, Option<&str>)],
    ) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zutil-resolve-oc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create oc fixture dir");
        let conn =
            Connection::open(dir.join("opencode.db")).expect("open oc db");
        create_common_tables(&conn);
        create_part_table(&conn);
        for (id, started_at, title) in sessions {
            conn.execute(
                "INSERT INTO session (id, title, directory, time_created) \
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, title, "/w", started_at],
            )
            .expect("insert oc session");
        }
        conn.close().expect("close oc db");
        dir
    }

    /// Provider list shaped like the production one — `OpenCode` first,
    /// then pi — rooted at the given fixture dirs.
    #[cfg(feature = "db-helpers")]
    fn fixture_providers(
        oc_root: &Path,
        pi_root: &Path,
    ) -> Vec<(Host, Box<dyn SessionProvider>)> {
        vec![
            (
                Host::OpenCode,
                Box::new(OpenCodeSessionProvider::with_data_dir(
                    oc_root.to_string_lossy(),
                )),
            ),
            (
                Host::Pi,
                Box::new(PiSessionProvider::with_data_dir(
                    pi_root.to_string_lossy(),
                )),
            ),
        ]
    }

    /// Provider list with only pi, rooted at the given fixture dir.
    #[cfg(not(feature = "db-helpers"))]
    fn fixture_providers(
        pi_root: &Path,
    ) -> Vec<(Host, Box<dyn SessionProvider>)> {
        vec![(
            Host::Pi,
            Box::new(PiSessionProvider::with_data_dir(
                pi_root.to_string_lossy(),
            )),
        )]
    }

    // ── providers() composition ─────────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn providers_auto_orders_opencode_before_pi() {
        let hosts: Vec<Host> =
            providers(HostFilter::Auto).into_iter().map(|(h, _)| h).collect();
        assert_eq!(hosts, [Host::OpenCode, Host::Pi]);
    }

    #[cfg(not(feature = "db-helpers"))]
    #[test]
    fn providers_auto_is_pi_only_without_db_helpers() {
        let hosts: Vec<Host> =
            providers(HostFilter::Auto).into_iter().map(|(h, _)| h).collect();
        assert_eq!(hosts, [Host::Pi]);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn providers_only_maps_single_host() {
        let oc: Vec<Host> = providers(HostFilter::Only(Host::OpenCode))
            .into_iter()
            .map(|(h, _)| h)
            .collect();
        assert_eq!(oc, [Host::OpenCode]);
        let pi: Vec<Host> = providers(HostFilter::Only(Host::Pi))
            .into_iter()
            .map(|(h, _)| h)
            .collect();
        assert_eq!(pi, [Host::Pi]);
    }

    #[cfg(not(feature = "db-helpers"))]
    #[test]
    fn providers_only_opencode_is_empty_without_db_helpers() {
        assert!(providers(HostFilter::Only(Host::OpenCode)).is_empty());
        let pi: Vec<Host> = providers(HostFilter::Only(Host::Pi))
            .into_iter()
            .map(|(h, _)| h)
            .collect();
        assert_eq!(pi, [Host::Pi]);
    }

    // ── open fast paths ─────────────────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_ses_id_only_tries_opencode() {
        let oc = oc_fixture(
            "fast-oc-hit",
            &[("ses_resolve_001", 1_000, Some("oc"))],
        );
        let pi = pi_fixture(
            "fast-oc-hit",
            &[("ses_resolve_001", 2_000, Some("pi"))],
        );
        let list = fixture_providers(&oc, &pi);

        let (host, session) =
            open_with(&list, HostFilter::Auto, "ses_resolve_001")
                .expect("ses_ id must open");
        assert_eq!(host, Host::OpenCode);
        assert_eq!(session.meta.id, "ses_resolve_001");
        assert_eq!(session.meta.started_at, 1_000);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_ses_id_missing_in_opencode_does_not_fall_back_to_pi() {
        let oc = oc_fixture(
            "fast-oc-miss",
            &[("ses_resolve_001", 1_000, Some("oc"))],
        );
        // The id is shaped like opencode but lives only in pi: the shape
        // fast path must not double-probe.
        let pi = pi_fixture(
            "fast-oc-miss",
            &[("ses_only_in_pi", 2_000, Some("pi"))],
        );
        let list = fixture_providers(&oc, &pi);

        let err = open_with(&list, HostFilter::Auto, "ses_only_in_pi")
            .expect_err("shape fast path must not double-probe");
        assert_not_found(err, "ses_only_in_pi", &["opencode"]);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_uuid_id_only_tries_pi() {
        let uuid = "01a04bc0-fa14-76d5-95ec-a8d5ee80f706";
        // The same UUID exists in the opencode store too — pi must still
        // win because the shape fast path never consults opencode.
        let oc = oc_fixture("fast-uuid-hit", &[(uuid, 1_000, Some("oc"))]);
        let pi = pi_fixture("fast-uuid-hit", &[(uuid, 2_000, Some("pi"))]);
        let list = fixture_providers(&oc, &pi);

        let (host, session) =
            open_with(&list, HostFilter::Auto, uuid).expect("uuid must open");
        assert_eq!(host, Host::Pi);
        assert_eq!(session.meta.started_at, 2_000);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_uuid_id_missing_in_pi_does_not_fall_back_to_opencode() {
        let uuid = "01a04bc0-fa14-76d5-95ec-a8d5ee80f706";
        // The UUID lives only in the opencode store; the shape fast path
        // still reports NotFound because pi alone is consulted.
        let oc = oc_fixture("fast-uuid-miss", &[(uuid, 1_000, Some("oc"))]);
        let pi = pi_fixture("fast-uuid-miss", &[]);
        let list = fixture_providers(&oc, &pi);

        let err = open_with(&list, HostFilter::Auto, uuid)
            .expect_err("uuid fast path must not double-probe");
        assert_not_found(err, uuid, &["pi"]);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    // ── open double-probe (Unknown shape) ────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_unknown_id_probes_both_and_pi_hits() {
        let oc = oc_fixture("probe", &[("ses_resolve_001", 1_000, None)]);
        let pi = pi_fixture("probe", &[("shared-probe-9", 2_000, Some("hi"))]);
        let list = fixture_providers(&oc, &pi);

        let (host, session) =
            open_with(&list, HostFilter::Auto, "shared-probe-9")
                .expect("unknown shape must probe pi after opencode misses");
        assert_eq!(host, Host::Pi);
        assert_eq!(session.meta.id, "shared-probe-9");
        assert_eq!(session.meta.started_at, 2_000);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_unknown_id_probes_both_and_opencode_wins_first() {
        let oc = oc_fixture("order", &[("shared-winner", 1_000, Some("oc"))]);
        let pi = pi_fixture("order", &[("shared-winner", 2_000, Some("pi"))]);
        let list = fixture_providers(&oc, &pi);

        let (host, session) =
            open_with(&list, HostFilter::Auto, "shared-winner")
                .expect("both hosts match; opencode must win");
        assert_eq!(host, Host::OpenCode);
        assert_eq!(session.meta.started_at, 1_000);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_unknown_id_both_miss_reports_tried_hosts() {
        let oc = oc_fixture("miss", &[("ses_resolve_001", 1_000, None)]);
        let pi = pi_fixture(
            "miss",
            &[("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 2_000, None)],
        );
        let list = fixture_providers(&oc, &pi);

        let err = open_with(&list, HostFilter::Auto, "zzz-nope")
            .expect_err("no host can match");
        assert_not_found(err, "zzz-nope", &["opencode", "pi"]);

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(not(feature = "db-helpers"))]
    #[test]
    fn open_unknown_id_miss_reports_pi_only() {
        let pi = pi_fixture(
            "miss",
            &[("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 2_000, None)],
        );
        let list = fixture_providers(&pi);

        let err = open_with(&list, HostFilter::Auto, "zzz-nope")
            .expect_err("no host can match");
        assert_not_found(err, "zzz-nope", &["pi"]);

        let _ = std::fs::remove_dir_all(&pi);
    }

    // ── Only filter ─────────────────────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_only_pi_ignores_opencode_shaped_ids() {
        let oc = oc_fixture("only", &[("ses_resolve_001", 1_000, None)]);
        let pi = pi_fixture(
            "only",
            &[("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 2_000, None)],
        );
        let list = fixture_providers(&oc, &pi);

        // ses_ id exists only in opencode; Only(Pi) must still miss and
        // report just pi as tried.
        let err =
            open_with(&list, HostFilter::Only(Host::Pi), "ses_resolve_001")
                .expect_err("Only(Pi) must not consult opencode");
        assert_not_found(err, "ses_resolve_001", &["pi"]);

        // The UUID id exists only in pi; Only(OpenCode) must miss it.
        let err = open_with(
            &list,
            HostFilter::Only(Host::OpenCode),
            "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
        )
        .expect_err("Only(OpenCode) must not consult pi");
        assert_not_found(
            err,
            "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
            &["opencode"],
        );

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[test]
    fn open_only_pi_opens_pi_sessions() {
        let pi = pi_fixture(
            "onlypi",
            &[("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 2_000, Some("hi"))],
        );
        #[cfg(feature = "db-helpers")]
        let oc = oc_fixture("onlypi", &[]);
        #[cfg(feature = "db-helpers")]
        let list = fixture_providers(&oc, &pi);
        #[cfg(not(feature = "db-helpers"))]
        let list = fixture_providers(&pi);

        let (host, session) = open_with(
            &list,
            HostFilter::Only(Host::Pi),
            "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
        )
        .expect("Only(Pi) must open a pi session");
        assert_eq!(host, Host::Pi);
        assert_eq!(session.meta.id, "01a04bc0-fa14-76d5-95ec-a8d5ee80f706");

        #[cfg(feature = "db-helpers")]
        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    // ── ambiguous prefix passthrough ────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn open_opencode_ambiguous_prefix_passthrough() {
        let oc = oc_fixture(
            "amb-oc",
            &[("ses_resolve_a", 1_000, None), ("ses_resolve_b", 2_000, None)],
        );
        let pi = pi_fixture("amb-oc", &[]);
        let list = fixture_providers(&oc, &pi);

        let err = open_with(&list, HostFilter::Auto, "ses_resolve")
            .expect_err("ambiguous opencode prefix must surface");
        assert_ambiguous(
            err,
            "ses_resolve",
            &["ses_resolve_a", "ses_resolve_b"],
        );

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[test]
    fn open_pi_ambiguous_prefix_passthrough() {
        let pi = pi_fixture(
            "amb-pi",
            &[
                ("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 1_000, None),
                ("01a04bc0-fa14-76d5-95ec-b9e6f11a2233", 2_000, None),
            ],
        );
        #[cfg(feature = "db-helpers")]
        let oc = oc_fixture("amb-pi", &[]);
        #[cfg(feature = "db-helpers")]
        let list = fixture_providers(&oc, &pi);
        #[cfg(not(feature = "db-helpers"))]
        let list = fixture_providers(&pi);

        // The prefix matches pi's two sessions: the ambiguity must pass
        // straight through to the caller rather than become a miss.
        let err =
            open_with(&list, HostFilter::Auto, "01a04bc0-fa14-76d5-95ec-")
                .expect_err("ambiguous pi prefix must surface");
        assert_ambiguous(
            err,
            "01a04bc0-fa14-76d5-95ec-",
            &[
                "01a04bc0-fa14-76d5-95ec-a8d5ee80f706",
                "01a04bc0-fa14-76d5-95ec-b9e6f11a2233",
            ],
        );

        #[cfg(feature = "db-helpers")]
        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    /// Build a temp dir holding `opencode.db` with one session that carries
    /// a message id `msg-oc-1`. Returns the dir; the caller removes it
    /// after the test.
    #[cfg(feature = "db-helpers")]
    fn oc_message_fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zutil-resolve-find-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create oc fixture dir");
        let conn =
            Connection::open(dir.join("opencode.db")).expect("open oc db");
        create_common_tables(&conn);
        create_part_table(&conn);
        conn.execute(
            "INSERT INTO session (id, parent_id, directory, title, \
             time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "ses-find-oc",
                Option::<&str>::None,
                "/w",
                "find me",
                100_i64,
                200_i64,
            ],
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                "msg-oc-1",
                "ses-find-oc",
                101_i64,
                r#"{"role":"user","agent":"beaver"}"#
            ],
        )
        .expect("insert message");
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "part-oc-1",
                "msg-oc-1",
                "ses-find-oc",
                102_i64,
                102_i64,
                r#"{"type":"text","text":"find me too"}"#
            ],
        )
        .expect("insert part");
        conn.close().expect("close oc db");
        dir
    }

    // ── search / list merge ─────────────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn search_merges_and_sorts_across_hosts() {
        let oc = oc_fixture(
            "search",
            &[
                ("oc-10", 100, Some("aardvark alpha")),
                ("oc-30", 300, Some("aardvark gamma")),
            ],
        );
        let pi = pi_fixture(
            "search",
            &[
                ("pi-10", 100, Some("aardvark beta")),
                ("pi-20", 200, Some("aardvark delta")),
            ],
        );
        let list = fixture_providers(&oc, &pi);

        let hits = collect_metas_with(&list, |p| p.search("aardvark"))
            .expect("search ok");
        let ids: Vec<(&str, &str)> =
            hits.iter().map(|(h, m)| (h.name(), m.id.as_str())).collect();
        assert_eq!(
            ids,
            vec![
                ("opencode", "oc-10"),
                ("pi", "pi-10"),
                ("pi", "pi-20"),
                ("opencode", "oc-30"),
            ],
            "merged results sort by (started_at, id)"
        );

        // A query hitting neither host contributes nothing.
        let hits = collect_metas_with(&list, |p| p.search("zzz-nowhere"))
            .expect("search ok");
        assert!(hits.is_empty());

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[cfg(feature = "db-helpers")]
    #[test]
    fn list_merges_and_sorts_across_hosts() {
        let oc =
            oc_fixture("list", &[("oc-10", 100, None), ("oc-30", 300, None)]);
        let pi =
            pi_fixture("list", &[("pi-10", 100, None), ("pi-20", 200, None)]);
        let list = fixture_providers(&oc, &pi);

        let metas = collect_metas_with(&list, |p| p.list()).expect("list ok");
        let ids: Vec<(&str, &str)> =
            metas.iter().map(|(h, m)| (h.name(), m.id.as_str())).collect();
        assert_eq!(
            ids,
            vec![
                ("opencode", "oc-10"),
                ("pi", "pi-10"),
                ("pi", "pi-20"),
                ("opencode", "oc-30"),
            ],
            "merged listings sort by (started_at, id)"
        );

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let pi = pi_fixture("emptyq", &[("pi-one", 100, Some("text here"))]);
        #[cfg(feature = "db-helpers")]
        let oc = oc_fixture("emptyq", &[]);
        #[cfg(feature = "db-helpers")]
        let list = fixture_providers(&oc, &pi);
        #[cfg(not(feature = "db-helpers"))]
        let list = fixture_providers(&pi);

        let hits =
            collect_metas_with(&list, |p| p.search("")).expect("search ok");
        assert!(hits.is_empty());

        #[cfg(feature = "db-helpers")]
        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }

    // ── find-events merge ────────────────────────────────────────────

    #[cfg(feature = "db-helpers")]
    #[test]
    fn find_events_merges_and_tags_across_hosts() {
        let oc = oc_message_fixture("merged");
        let pi = pi_fixture(
            "merged",
            &[("01a04bc0-fa14-76d5-95ec-a8d5ee80f706", 100, Some("pi hello"))],
        );
        let list = fixture_providers(&oc, &pi);

        let hits = find_events_with(
            &list,
            &["msg-oc".to_string(), "m0".to_string()],
            10,
        )
        .expect("find events ok");
        assert_eq!(hits.len(), 2, "both hosts contribute a hit");

        let (host0, meta0, ev0) = &hits[0];
        assert_eq!(*host0, Host::OpenCode);
        assert_eq!(meta0.id, "ses-find-oc");
        assert_eq!(ev0.len(), 1);
        assert!(matches!(
            &ev0[0],
            SessionEvent::Message { id, .. }
                if id.as_deref() == Some("msg-oc-1")
        ));

        let (host1, meta1, ev1) = &hits[1];
        assert_eq!(*host1, Host::Pi);
        assert_eq!(meta1.id, "01a04bc0-fa14-76d5-95ec-a8d5ee80f706");
        assert_eq!(ev1.len(), 1);
        assert!(matches!(
            &ev1[0],
            SessionEvent::Message { id, .. }
                if id.as_deref() == Some("m0")
        ));

        // A prefix matching neither host contributes nothing.
        let hits = find_events_with(&list, &["zzz-nope".to_string()], 10)
            .expect("find events ok");
        assert!(hits.is_empty());

        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&pi);
    }
}
