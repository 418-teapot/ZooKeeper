//! zwiki library surface: the page document model.
//!
//! The binary keeps its command modules; this crate root exposes the shared
//! model that every command reads, edits and writes pages through.  It owns
//! the frontmatter boundaries, the typed metadata, the field layout and the
//! body, and it does not know where pages live.

#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

pub mod document;
