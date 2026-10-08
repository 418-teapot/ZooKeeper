//! Shared fixtures for the zwiki integration tests.
//!
//! Integration tests are separate crates, so each test file pulls this
//! module in.  Declare it as `pub mod common;` rather than `mod common;`:
//! a private module would leave the helpers a given test binary does not
//! call unreachable, which trips `dead_code` under `-D warnings`, and
//! suppressing lints is not allowed in this repository.

use std::path::{Path, PathBuf};

/// Manifest embedded in the tar fixtures: a minimal bundle exporting
/// `*.md`.
const BUNDLE_TOML: &str = r#"[package]
name = "test-bundle"
version = "0.1.0"
okf_version = "0.1"

[export]
include = ["*.md"]
"#;

/// `index.md` embedded in the tar fixtures.
const INDEX_MD: &str = "---\ntitle: Index\n---\n# Index\n";

/// Write a gzipped tar at `tar_path` holding `entries` as top-level
/// regular files.  Each entry is a `(archive name, bytes)` pair.
pub fn write_tar(tar_path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(tar_path).unwrap();
    let gz =
        flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(gz);
    for (name, data) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(data.len() as u64);
        archive.append_data(&mut header, name, *data).unwrap();
    }
    let gz = archive.into_inner().unwrap();
    gz.finish().unwrap();
}

/// Build a minimal read-only bundle tar.gz inside a fresh temp directory
/// named `dir_name`, and return the archive path.
///
/// The archive always carries the standard `bundle.toml`, `index.md` and
/// an empty `logs/` directory; `doc_md` supplies the `doc.md` contents so
/// callers can choose a plain page or one with frontmatter.
pub fn make_bundle_tar(dir_name: &str, doc_md: &str) -> PathBuf {
    let dir = ztest::temp_dir(dir_name);
    std::fs::write(dir.join("bundle.toml"), BUNDLE_TOML).unwrap();
    std::fs::write(dir.join("index.md"), INDEX_MD).unwrap();
    std::fs::write(dir.join("doc.md"), doc_md).unwrap();
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("logs/.gitkeep"), "").unwrap();

    let tar_path = dir.join("test-bundle.tar.gz");
    let file = std::fs::File::create(&tar_path).unwrap();
    let gz =
        flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(gz);
    archive
        .append_path_with_name(dir.join("bundle.toml"), "bundle.toml")
        .unwrap();
    archive.append_path_with_name(dir.join("index.md"), "index.md").unwrap();
    archive.append_path_with_name(dir.join("doc.md"), "doc.md").unwrap();
    archive.append_dir("logs", dir.join("logs")).unwrap();
    let gz = archive.into_inner().unwrap();
    gz.finish().unwrap();
    tar_path
}

/// Write a minimal valid `bundle.toml`, marking `dir` as a bundle source.
///
/// Commands only test for the manifest's presence, so a root marked this
/// way is writable and pages under it are not treated as installed
/// bundle content.
pub fn write_bundle_manifest(dir: &Path) {
    std::fs::write(
        dir.join("bundle.toml"),
        "[package]\nname = \"test-wiki\"\nversion = \"0.1.0\"\n\n\
         [export]\ninclude = [\"**/*\"]\n",
    )
    .unwrap();
}
