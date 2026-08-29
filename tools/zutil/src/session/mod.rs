//! Host-agnostic session domain model and per-host session providers.
//!
//! This module decouples session browsing from any single host's storage
//! format. The shared model ([`model`]) is fed by providers ([`provider`])
//! that translate `OpenCode`'s `SQLite` and pi's `JSONL` session stores.
//! Adding a new host is purely additive: existing tools keep working
//! unchanged.

pub mod model;
#[cfg(feature = "db-helpers")]
pub mod opencode;
pub mod pi;
pub mod provider;
pub mod resolve;

pub use model::{
    DetectedHost, Host, HostEvent, HostFilter, Session, SessionEvent,
    SessionMeta, detect_host,
};
#[cfg(feature = "db-helpers")]
pub use opencode::OpenCodeSessionProvider;
pub use pi::{PiSessionProvider, ZOO_PI_DATA_DIR, pi_data_dir};
pub use provider::SessionProvider;
pub use resolve::{
    ResolveError, find_events_across, list_sessions, open_session, open_with,
    providers, search_sessions,
};
