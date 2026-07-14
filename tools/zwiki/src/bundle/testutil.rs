//! Shared test helpers for bundle tests.

#![cfg(test)]

use std::path::PathBuf;

use clap::Parser;

use crate::bundle::args::BundleCommand;
use crate::bundle::lock;
use crate::bundle::manifest;

/// Helper to parse `BundleCommand` subcommands in tests.
#[derive(Parser)]
pub struct BundleTestParser {
    #[command(subcommand)]
    pub cmd: BundleCommand,
}

/// Helper to write a file in tests.
pub fn w(path: PathBuf, content: &str) {
    std::fs::write(path, content).unwrap();
}

/// Create a temp directory for testing.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-test").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("failed to create temp dir");
    dir
}

/// Build a valid bundle manifest with the given name.
pub fn valid_manifest_with_name(name: &str) -> manifest::BundleManifest {
    manifest::BundleManifest {
        package: manifest::PackageSection {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            okf_version: "0.1".to_string(),
            kind: "upstream".to_string(),
            registry: None,
            description: None,
        },
        export: manifest::ExportSection {
            include: vec!["*.md".to_string()],
            exclude: Vec::new(),
        },
    }
}

/// Set up a test environment for partial lock update tests.
/// Creates the wiki root directory, writes a lock file with two entries,
/// and creates the target directories (with bundle-b's target made
/// read-only to simulate an install error).
/// Returns `(wiki_root, target_b_path)`.
pub fn setup_partial_lock_env(port_a: u16, port_b: u16) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let wiki_root = temp_dir("update_partial_lock");
    let entry_a = lock::ZwikiLockEntry {
        name: "bundle-a".to_string(),
        version: "1.0.0".to_string(),
        registry: format!("http://127.0.0.1:{port_a}"),
        target: ".upstream/bundle-a/".to_string(),
        integrity: "sha256-abc".to_string(),
        installed_at: "2026-01-01T00:00:00Z".to_string(),
        description: None,
    };
    let entry_b = lock::ZwikiLockEntry {
        name: "bundle-b".to_string(),
        version: "1.0.0".to_string(),
        registry: format!("http://127.0.0.1:{port_b}"),
        target: ".upstream/bundle-b/".to_string(),
        integrity: "sha256-def".to_string(),
        installed_at: "2026-01-01T00:00:00Z".to_string(),
        description: None,
    };
    let lock = lock::ZwikiLock {
        bundles: vec![entry_a, entry_b],
        ..Default::default()
    };
    std::fs::write(
        wiki_root.join("zwiki.lock"),
        toml::to_string_pretty(&lock).unwrap(),
    )
    .unwrap();
    std::fs::create_dir_all(wiki_root.join(".upstream").join("bundle-a"))
        .unwrap();
    std::fs::create_dir_all(wiki_root.join(".upstream")).unwrap();
    let target_b = wiki_root.join(".upstream").join("bundle-b");
    std::fs::create_dir_all(&target_b).unwrap();
    std::fs::set_permissions(&target_b, PermissionsExt::from_mode(0o444))
        .unwrap();
    (wiki_root, target_b)
}

/// Start a local HTTP server that serves a static bundle manifest and
/// tar.gz for the duration of the test.  `max_requests` controls how many
/// HTTP requests the server handles before exiting.
/// Returns `(port, join_handle)`.
pub fn serve_update_bundle(
    bundle_toml: &'static [u8],
    tar_gz: Vec<u8>,
    max_requests: usize,
) -> (u16, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = std::thread::spawn(move || {
        for mut stream in listener.incoming().take(max_requests).flatten() {
            let mut buf = [0u8; 4096];
            if stream.read(&mut buf).is_err() {
                break;
            }
            let request = String::from_utf8_lossy(&buf);
            let (body, content_type) = if request.contains("bundle.toml") {
                (bundle_toml.to_vec(), "text/plain")
            } else {
                (tar_gz.clone(), "application/gzip")
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Length: {}\r\n\
                 Content-Type: {content_type}\r\n\
                 Connection: close\r\n\
                 \r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
    });

    (port, handle)
}

pub const DOC_M0: &str = "---\ntitle: Doc\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Doc Content\n\nThis document has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n";
pub const RDM0: &str = "---\ntitle: Readme\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Readme\n\nThis readme has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n";
pub const IDX0: &str = "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Doc](doc.md)\n- [Readme](readme.md)\n";
pub const DOC_U0: &str = "---\ntitle: Doc\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Updated Doc Content\n\nThis document has been updated to test force reinstall. It has enough text to pass health and lint checks during reinstall.\n";
pub const NEW_M0: &str = "---\ntitle: New\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# New File\n\nThis new file is added during the force reinstall test step. It has enough text to pass health and lint checks.\n";
pub const IDX_U0: &str = "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Doc](doc.md)\n- [Readme](readme.md)\n- [New](new.md)\n";
