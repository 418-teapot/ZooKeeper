//! Storage-agnostic interface for reading sessions from a host.

use std::io;

use crate::session::model::{HostEvent, Session, SessionEvent, SessionMeta};
use crate::session::resolve::ResolveError;

/// Storage-agnostic reader for a host's session store.
///
/// Implementations translate a host's native storage (`OpenCode` `SQLite`,
/// pi `JSONL` files) into the shared [`SessionMeta`] / [`Session`] model.
pub trait SessionProvider {
    /// List every session's metadata.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the underlying storage cannot be read.
    /// A missing storage directory yields an empty list, not an error.
    fn list(&self) -> io::Result<Vec<SessionMeta>>;

    /// Open a session by full id or by a unique id prefix.
    ///
    /// # Errors
    ///
    /// Returns [`ResolveError::NotFound`] when no session matches and
    /// [`ResolveError::Ambiguous`] when the id prefix matches more than
    /// one session, each carrying the structured detail the resolver and
    /// CLI tools render.
    fn open(&self, id_or_prefix: &str) -> Result<Session, ResolveError>;

    /// Search session content for a case-insensitive substring, matching
    /// session labels and message / tool-result text.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the underlying storage cannot be read.
    fn search(&self, query: &str) -> io::Result<Vec<SessionMeta>>;

    /// Find events whose id starts with any of `ids`, scanning only the
    /// `max_sessions` most recent sessions of this host.
    ///
    /// `Message` events match by message id, tool events and reasoning by
    /// their part / call id — the same prefix semantics the `message`
    /// subcommand applies. Returns one entry per session with at least
    /// one matching event, each entry holding the session metadata and
    /// the matching events in stream order.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the underlying storage cannot be read.
    fn find_events(
        &self,
        ids: &[String],
        max_sessions: usize,
    ) -> io::Result<Vec<(SessionMeta, Vec<SessionEvent>)>>;

    /// Host-specific events for a session (e.g. lifecycle lines from the
    /// host's application log), in stream order. Hosts without such
    /// events return `None`.
    #[must_use]
    fn host_events(&self, _session_id: &str) -> Option<Vec<HostEvent>> {
        None
    }
}
