//! Lock file — persistent bundle registry lock file (`zwiki.lock`).
//!
//! Tracks installed bundles with integrity hashing under `~/.zoo/wiki/zwiki.lock`.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use sha2::{Digest, Sha256};

use crate::wiki;

/// The lock file tracking installed bundles under `~/.zoo/wiki/zwiki.lock`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZwikiLock {
    #[serde(rename = "bundles")]
    pub bundles: Vec<ZwikiLockEntry>,
}

/// A single installed bundle entry in the lock file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZwikiLockEntry {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub registry: String,
    pub target: String,
    pub integrity: String,
    pub installed_at: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Return the absolute path to the lock file.
#[must_use]
pub fn lock_path() -> PathBuf {
    wiki::wiki_dir().join("zwiki.lock")
}

/// Read the lock file from disk, returning an empty lock if it doesn't exist.
#[must_use]
pub fn read_lock() -> ZwikiLock {
    let path = lock_path();
    if !path.exists() {
        return ZwikiLock { bundles: Vec::new() };
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("警告: 无法读取 zwiki.lock ({e})，已重置");
            return ZwikiLock { bundles: Vec::new() };
        }
    };
    toml::from_str(&content).unwrap_or_else(|e| {
        eprintln!("警告: zwiki.lock 损坏 ({e})，已重置");
        ZwikiLock { bundles: Vec::new() }
    })
}

/// Read the lock file from a specific wiki root (testable variant).
#[must_use]
pub fn read_lock_at(wiki_root: &Path) -> ZwikiLock {
    let path = wiki_root.join("zwiki.lock");
    if !path.exists() {
        return ZwikiLock { bundles: Vec::new() };
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("警告: 无法读取 zwiki.lock ({e})，已重置");
            return ZwikiLock { bundles: Vec::new() };
        }
    };
    toml::from_str(&content).unwrap_or_else(|e| {
        eprintln!("警告: zwiki.lock 损坏 ({e})，已重置");
        ZwikiLock { bundles: Vec::new() }
    })
}

/// Write the lock file to a specific wiki root (testable variant).
///
/// # Errors
///
/// Returns an I/O error if the file cannot be written.
pub fn write_lock_at(lock: &ZwikiLock, wiki_root: &Path) -> io::Result<()> {
    let content = toml::to_string_pretty(lock).map_err(io::Error::other)?;
    let lock_path = wiki_root.join("zwiki.lock");
    zutil::fileio::write_atomic(&lock_path, &content)?;
    Ok(())
}

/// Insert or update a bundle entry in the lock.
///
/// If a bundle with the same `name` already exists and `force` is `false`,
/// returns `Err("bundle already installed")`.  If `force` is `true`, the
/// existing entry is replaced.  Otherwise the entry is appended.
///
/// # Errors
///
/// Returns an error string if the bundle is already installed and `force` is
/// `false`.
pub fn upsert_bundle(
    lock: &mut ZwikiLock,
    entry: ZwikiLockEntry,
    force: bool,
) -> Result<(), String> {
    let pos = lock.bundles.iter().position(|b| b.name == entry.name);
    if let Some(p) = pos {
        if !force {
            return Err("bundle already installed".to_string());
        }
        lock.bundles[p] = entry;
    } else {
        lock.bundles.push(entry);
    }
    Ok(())
}

/// Base64-encode the given bytes using the standard (RFC 4648) alphabet.
fn base64_encode(data: impl AsRef<[u8]>) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data.as_ref())
}

/// Compute an SRI-style integrity hash for all files under `dir`.
///
/// Recursively walks `dir`, collecting all regular files.  Files are sorted
/// by relative path for determinism.  For each file the relative path and
/// contents are fed into SHA-256 as `path\0contents`.  The returned string
/// has the format `sha256-<base64>`.
#[must_use]
pub fn compute_integrity(dir: &Path) -> String {
    let mut hasher = Sha256::new();

    let mut entries: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();

    entries.sort();

    for abs_path in &entries {
        let rel = abs_path
            .strip_prefix(dir)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .to_string();
        let content = match std::fs::read(abs_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!(
                    "警告: 无法读取文件用于完整性计算: {} ({e})",
                    abs_path.display()
                );
                Vec::new()
            }
        };

        // Feed "path\0contents" to detect both content and path changes
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(&content);
    }

    let hash_bytes = hasher.finalize();
    let encoded = base64_encode(hash_bytes);
    format!("sha256-{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    #[test]
    fn test_read_lock_file_not_exists() {
        let dir = temp_dir("read_lock_not_exists");
        let lock_path = dir.join("zwiki.lock");
        let exists = lock_path.exists();
        assert!(!exists, "lock file should not exist yet");
        let lock = ZwikiLock { bundles: Vec::new() };
        assert!(lock.bundles.is_empty());
    }

    #[test]
    fn test_upsert_bundle_new() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };

        assert!(upsert_bundle(&mut lock, entry, false).is_ok());
        assert_eq!(lock.bundles.len(), 1);
    }

    #[test]
    fn test_upsert_bundle_duplicate_no_force() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry1 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let entry2 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "2.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-def".to_string(),
            installed_at: "2026-01-02T00:00:00Z".to_string(),
            description: None,
        };

        upsert_bundle(&mut lock, entry1, false).unwrap();
        let result = upsert_bundle(&mut lock, entry2, false);
        assert!(result.is_err());
        assert_eq!(lock.bundles.len(), 1);
    }

    #[test]
    fn test_upsert_bundle_duplicate_force() {
        let mut lock = ZwikiLock { bundles: Vec::new() };
        let entry1 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            description: None,
        };
        let entry2 = ZwikiLockEntry {
            name: "test".to_string(),
            version: "2.0".to_string(),
            registry: String::new(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-def".to_string(),
            installed_at: "2026-01-02T00:00:00Z".to_string(),
            description: None,
        };

        upsert_bundle(&mut lock, entry1, false).unwrap();
        assert!(upsert_bundle(&mut lock, entry2, true).is_ok());
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].version, "2.0");
    }

    #[test]
    fn test_compute_integrity_empty_dir() {
        let dir = temp_dir("integrity_empty");
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"), "hash should start with sha256-");
        assert_eq!(hash.len(), 51, "sha256- (7) + 44 base64 chars = 51");
    }

    #[test]
    fn test_compute_integrity_single_file() {
        let dir = temp_dir("integrity_single");
        std::fs::write(dir.join("test.md"), "hello").unwrap();
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"));
    }

    #[test]
    fn test_compute_integrity_deterministic() {
        let dir1 = temp_dir("integrity_det1");
        let dir2 = temp_dir("integrity_det2");
        std::fs::write(dir1.join("a.md"), "a").unwrap();
        std::fs::write(dir1.join("b.md"), "b").unwrap();
        std::fs::write(dir2.join("a.md"), "a").unwrap();
        std::fs::write(dir2.join("b.md"), "b").unwrap();
        assert_eq!(compute_integrity(&dir1), compute_integrity(&dir2));
    }

    #[test]
    fn test_compute_integrity_detects_rename() {
        let dir1 = temp_dir("integrity_rename1");
        let dir2 = temp_dir("integrity_rename2");
        std::fs::write(dir1.join("old-name.md"), "content").unwrap();
        std::fs::write(dir2.join("new-name.md"), "content").unwrap();
        assert_ne!(
            compute_integrity(&dir1),
            compute_integrity(&dir2),
            "renamed files should produce different hashes"
        );
    }

    #[test]
    fn test_compute_integrity_skips_directories() {
        let dir = temp_dir("integrity_skips_dirs");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("f.md"), "f").unwrap();
        let hash = compute_integrity(&dir);
        assert!(hash.starts_with("sha256-"));
        assert_eq!(hash.len(), 51);
    }

    #[test]
    fn test_write_lock_roundtrip() {
        let dir = temp_dir("lock_roundtrip");

        let entry = ZwikiLockEntry {
            name: "mypkg".to_string(),
            version: "1.0.0".to_string(),
            registry: String::new(),
            target: ".upstream/mypkg/".to_string(),
            integrity: "sha256-abc".to_string(),
            installed_at: "2026-06-01T12:00:00Z".to_string(),
            description: None,
        };
        let lock = ZwikiLock { bundles: vec![entry] };

        let toml_str = toml::to_string_pretty(&lock).unwrap();
        let lock_file = dir.join("zwiki.lock");
        std::fs::write(&lock_file, &toml_str).unwrap();

        let content = std::fs::read_to_string(&lock_file).unwrap();
        let parsed: ZwikiLock = toml::from_str(&content).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].name, "mypkg");
        assert_eq!(parsed.bundles[0].version, "1.0.0");
    }

    #[test]
    fn test_zwiki_lock_toml_format() {
        let entry = ZwikiLockEntry {
            name: "test".to_string(),
            version: "1.0".to_string(),
            registry: "https://example.com".to_string(),
            target: ".upstream/test/".to_string(),
            integrity: "sha256-aGVsbG8=".to_string(),
            installed_at: "2026-07-05T12:00:00Z".to_string(),
            description: None,
        };
        let lock = ZwikiLock { bundles: vec![entry] };

        let toml_str = toml::to_string_pretty(&lock).unwrap();
        assert!(
            toml_str.contains("[[bundles]]"),
            "should use [[bundles]] table array: {toml_str}"
        );
        assert!(toml_str.contains("name = \"test\""));
        assert!(toml_str.contains("version = \"1.0\""));

        let parsed: ZwikiLock = toml::from_str(&toml_str).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].registry, "https://example.com");
    }

    #[test]
    fn test_zwiki_lock_empty_defaults() {
        let toml_input = r#"[[bundles]]
name = "test"
version = "1.0"
target = ".upstream/test/"
integrity = "sha256-abc"
installed_at = "2026-07-05T12:00:00Z"
"#;
        let parsed: ZwikiLock = toml::from_str(toml_input).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].registry, "");
    }

    #[test]
    fn test_zwiki_lock_entry_description_default_none() {
        let toml_input = r#"[[bundles]]
name = "test"
version = "1.0"
target = ".upstream/test/"
integrity = "sha256-abc"
installed_at = "2026-07-05T12:00:00Z"
"#;
        let parsed: ZwikiLock = toml::from_str(toml_input).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert!(parsed.bundles[0].description.is_none());
    }

    #[test]
    fn test_read_lock_corrupt_toml_returns_empty() {
        let corrupt = "this is not valid toml {{{";
        let result: Result<ZwikiLock, _> = toml::from_str(corrupt);
        assert!(result.is_err(), "corrupt TOML should fail to parse");
        let lock = result.unwrap_or(ZwikiLock { bundles: Vec::new() });
        assert!(lock.bundles.is_empty());
    }

    #[test]
    fn test_read_lock_valid_toml_parses() {
        let content = r#"
[[bundles]]
name = "test-bundle"
version = "1.0.0"
registry = ""
target = ".upstream/test-bundle/"
integrity = "sha256-abc"
installed_at = "2026-01-01T00:00:00Z"
"#;
        let lock: ZwikiLock = toml::from_str(content).unwrap();
        assert_eq!(lock.bundles.len(), 1);
        assert_eq!(lock.bundles[0].name, "test-bundle");
    }

    #[test]
    fn test_write_lock_at_atomic() {
        let dir = temp_dir("write_lock_atomic");
        let lock = ZwikiLock {
            bundles: vec![ZwikiLockEntry {
                name: "test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/test/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
        };

        write_lock_at(&lock, &dir).unwrap();
        let tmp_path = dir.join("zwiki.lock.tmp");
        assert!(
            !tmp_path.exists(),
            "zwiki.lock.tmp should not exist after write"
        );

        let lock_path = dir.join("zwiki.lock");
        assert!(lock_path.exists(), "zwiki.lock should exist");
        let content = std::fs::read_to_string(&lock_path).unwrap();
        let parsed: ZwikiLock = toml::from_str(&content).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
        assert_eq!(parsed.bundles[0].name, "test");
    }

    #[test]
    fn test_file_lock_sidecar_works() {
        let dir = temp_dir("file_lock_sidecar");

        let file = zutil::fileio::acquire_file_lock(&dir.join(".zwiki.flock"))
            .unwrap();
        let flock_path = dir.join(".zwiki.flock");
        assert!(flock_path.exists(), ".zwiki.flock should exist");
        drop(file);

        let _file2 =
            zutil::fileio::acquire_file_lock(&dir.join(".zwiki.flock"))
                .unwrap();
        let lock = ZwikiLock {
            bundles: vec![ZwikiLockEntry {
                name: "sidecar-test".to_string(),
                version: "1.0".to_string(),
                registry: String::new(),
                target: ".upstream/sidecar-test/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                description: None,
            }],
        };
        write_lock_at(&lock, &dir).unwrap();
        let lock_path = dir.join("zwiki.lock");
        assert!(lock_path.exists(), "zwiki.lock should exist");
        let content = std::fs::read_to_string(&lock_path).unwrap();
        let parsed: ZwikiLock = toml::from_str(&content).unwrap();
        assert_eq!(parsed.bundles.len(), 1);
    }
}
