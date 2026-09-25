#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

//! Shared foundation for the `zdebug` CLI.
//!
//! The library collects the deterministic building blocks used by the
//! event store, model, and runner layers: canonical JSON, atomic file
//! writes, content hashing, environment snapshots, Git working-tree
//! snapshots, and the append-only Case event log.

#[cfg(test)]
use std::sync::{Mutex, MutexGuard};

pub mod artifacts;
pub mod case;
pub mod events;
pub mod git;
pub mod model;
pub mod projector;
pub mod runner;
pub mod util;

// ── Test synchronization ─────────────────────────────────────────────────────

/// Serializes the tests that take a Case lock or spawn a child process.
///
/// Forking a child briefly duplicates every open descriptor, including a
/// Case lock held by another test; the duplicated descriptor keeps the
/// advisory lock alive until the child reaches `exec`, which makes a
/// concurrently running test observe a spurious `CASE_BUSY`. Tests that
/// take the lock or spawn a process hold this mutex so they run one at a
/// time.
#[cfg(test)]
pub(crate) static TEST_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire [`TEST_MUTEX`], ignoring poisoning by an earlier panic.
#[cfg(test)]
pub(crate) fn test_guard() -> MutexGuard<'static, ()> {
    TEST_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
