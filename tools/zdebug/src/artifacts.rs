//! Artifact capture *data layer* for a Case.
//!
//! An Artifact is a body of evidence the debugging loop wants to keep
//! alongside its event log. Three storages are supported, mirroring the
//! reference Python `artifacts.py`:
//!
//! * `copy` — the source file is copied into `artifacts/imported/<id>/`
//!   inside the Case and its SHA-256 is recorded;
//! * `reference` — an external file is referenced in place and its
//!   SHA-256 is recorded;
//! * `manifest` — a directory is recorded as a list of file hashes and
//!   symlink targets.
//!
//! The module only builds and checks artifact records; appending the
//! corresponding `artifact-created`/`artifact-invalidated` events is the
//! Case facade's job. Verification inspects the filesystem directly and
//! never depends on the runner or projector layers.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use crate::util::{
    ZdebugError, copy_file, path_within, relative_case_path, resolve_path,
    sha256_file, to_posix,
};

// ── Storage ──────────────────────────────────────────────────────────────────

/// How an Artifact's bytes are retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    /// Copy the source file into the Case and record its hash.
    Copy,
    /// Reference an external file in place and record its hash.
    Reference,
    /// Record a directory as a manifest of files and symlinks.
    Manifest,
}

impl Storage {
    /// Parse a storage label (`copy`, `reference`, or `manifest`).
    ///
    /// # Errors
    ///
    /// Returns [`ZdebugError`] with code `INVALID_STORAGE` for any other
    /// value.
    pub fn parse(value: &str) -> Result<Self, ZdebugError> {
        match value {
            "copy" => Ok(Self::Copy),
            "reference" => Ok(Self::Reference),
            "manifest" => Ok(Self::Manifest),
            other => Err(ZdebugError::new(
                "INVALID_STORAGE",
                format!("Invalid artifact storage: {other}"),
            )),
        }
    }

    /// Return the canonical storage label recorded in the event payload.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Reference => "reference",
            Self::Manifest => "manifest",
        }
    }
}

// ── Options ──────────────────────────────────────────────────────────────────

/// Optional parameters for [`create_artifact_payload`].
///
/// The defaults match the reference implementation: `copy` reuses the
/// source file name and every storage records `"durable"` availability.
#[derive(Debug, Clone)]
pub struct ArtifactOptions {
    /// Destination file name used by `copy`; defaults to the source name.
    pub destination_name: Option<String>,
    /// Availability recorded for `reference` and `manifest` storage.
    pub availability: String,
}

impl Default for ArtifactOptions {
    fn default() -> Self {
        Self { destination_name: None, availability: "durable".to_owned() }
    }
}

// ── Creation ─────────────────────────────────────────────────────────────────

/// Capture an Artifact record for `source`.
///
/// The returned JSON is the payload the `artifact-created` event expects:
/// `copy` stores the file under the Case and records its hash,
/// `reference` records the external path and hash, and `manifest` records
/// every file and symlink under a directory.
///
/// # Errors
///
/// Returns [`ZdebugError`] with code `FILE_NOT_FOUND` when `source` does
/// not exist, `COPY_REQUIRES_FILE` or `REFERENCE_REQUIRES_FILE` when a
/// file-only storage receives a directory, `MANIFEST_REQUIRES_DIRECTORY`
/// when manifest storage receives a file, and `PATH_OUTSIDE_CASE` when a
/// `copy` destination would escape the Case.
pub fn create_artifact_payload(
    case_dir: &Path,
    artifact_id: &str,
    source: &Path,
    storage: Storage,
    options: &ArtifactOptions,
) -> Result<Value, ZdebugError> {
    let source = resolve_path(source);
    if !source.exists() {
        return Err(ZdebugError::new(
            "FILE_NOT_FOUND",
            format!("Artifact source not found: {}", source.display()),
        ));
    }
    match storage {
        Storage::Copy => copy_artifact(case_dir, artifact_id, &source, options),
        Storage::Reference => reference_artifact(artifact_id, &source, options),
        Storage::Manifest => manifest_artifact(artifact_id, &source, options),
    }
}

/// Copy `source` into the Case's imported artifact directory.
fn copy_artifact(
    case_dir: &Path,
    artifact_id: &str,
    source: &Path,
    options: &ArtifactOptions,
) -> Result<Value, ZdebugError> {
    if !source.is_file() {
        return Err(ZdebugError::new(
            "COPY_REQUIRES_FILE",
            "Copy storage accepts files only",
        ));
    }
    let name =
        options.destination_name.clone().unwrap_or_else(|| file_name(source));
    let root = resolve_path(case_dir);
    let destination = lexical_normalize(
        &root.join("artifacts").join("imported").join(artifact_id).join(&name),
    );
    if !destination.starts_with(&root) {
        return Err(ZdebugError::new(
            "PATH_OUTSIDE_CASE",
            format!(
                "Artifact destination escapes Case: {}",
                destination.display()
            ),
        ));
    }
    copy_file(source, &destination)?;
    let record = file_record(&destination)?;
    Ok(json!({
        "id": artifact_id,
        "storage": Storage::Copy.as_str(),
        "path": relative_case_path(&destination, &root)?,
        "availability": "durable",
        "size": record.size,
        "sha256": record.sha256,
    }))
}

/// Record an external file reference.
fn reference_artifact(
    artifact_id: &str,
    source: &Path,
    options: &ArtifactOptions,
) -> Result<Value, ZdebugError> {
    if !source.is_file() {
        return Err(ZdebugError::new(
            "REFERENCE_REQUIRES_FILE",
            "Reference storage accepts files only",
        ));
    }
    let record = file_record(source)?;
    Ok(json!({
        "id": artifact_id,
        "storage": Storage::Reference.as_str(),
        "path": to_posix(source),
        "availability": options.availability.as_str(),
        "size": record.size,
        "sha256": record.sha256,
    }))
}

/// Record a directory as a manifest of files and symlinks.
fn manifest_artifact(
    artifact_id: &str,
    source: &Path,
    options: &ArtifactOptions,
) -> Result<Value, ZdebugError> {
    if !source.is_dir() {
        return Err(ZdebugError::new(
            "MANIFEST_REQUIRES_DIRECTORY",
            "Manifest storage accepts directories only",
        ));
    }
    let files = collect_manifest(source)?;
    Ok(json!({
        "id": artifact_id,
        "storage": Storage::Manifest.as_str(),
        "path": to_posix(source),
        "availability": options.availability.as_str(),
        "files": files,
    }))
}

// ── Invalidation ─────────────────────────────────────────────────────────────

/// Build the payload for an `artifact-invalidated` event.
#[must_use]
pub fn invalidation_payload(artifact_id: &str, reason: &str) -> Value {
    json!({"artifact_id": artifact_id, "reason": reason})
}

/// Report whether an Artifact record has been invalidated.
#[must_use]
pub fn is_invalidated(artifact: &Value) -> bool {
    artifact["invalidated"].as_bool() == Some(true)
}

// ── Verification ─────────────────────────────────────────────────────────────

/// Check `artifact` for existence and content drift.
///
/// Returns one human-readable problem per drift; an empty vector means the
/// artifact is intact. This mirrors the reference implementation's problem
/// strings so the Case facade can surface them unchanged.
#[must_use]
pub fn verify_artifact(case_dir: &Path, artifact: &Value) -> Vec<String> {
    let path = PathBuf::from(artifact["path"].as_str().unwrap_or_default());
    match artifact["storage"].as_str() {
        Some("copy") => verify_copy(case_dir, artifact, &path),
        Some("reference") => verify_reference(artifact, &path),
        Some("manifest") => verify_manifest(artifact, &path),
        _ => Vec::new(),
    }
}

/// Verify a self-contained copy artifact and its recorded hash.
fn verify_copy(case_dir: &Path, artifact: &Value, path: &Path) -> Vec<String> {
    let resolved = resolve_path(&case_dir.join(path));
    if !path_within(&resolved, case_dir) {
        return vec!["path escapes Case directory".to_owned()];
    }
    if !resolved.is_file() {
        return vec!["self-contained artifact is missing".to_owned()];
    }
    if !hash_matches(&resolved, &artifact["sha256"]) {
        return vec!["sha256 mismatch".to_owned()];
    }
    Vec::new()
}

/// Verify an external reference artifact and its recorded hash.
fn verify_reference(artifact: &Value, path: &Path) -> Vec<String> {
    if !path.is_file() {
        return vec!["external artifact is missing".to_owned()];
    }
    if !hash_matches(path, &artifact["sha256"]) {
        return vec!["sha256 mismatch".to_owned()];
    }
    Vec::new()
}

/// Verify a manifest directory against its recorded files and symlinks.
fn verify_manifest(artifact: &Value, path: &Path) -> Vec<String> {
    if !path.is_dir() {
        return vec!["manifest directory is missing".to_owned()];
    }
    let mut problems = Vec::new();
    let Some(items) = artifact["files"].as_array() else {
        return problems;
    };
    for item in items {
        let relative = item["path"].as_str().unwrap_or_default();
        let target = path.join(relative);
        if let Some(expected) = item["symlink"].as_str() {
            if !symlink_matches(&target, expected) {
                problems.push(format!("symlink changed: {relative}"));
            }
        } else if !target.is_file() {
            problems.push(format!("file missing: {relative}"));
        } else if !hash_matches(&target, &item["sha256"]) {
            problems.push(format!("sha256 mismatch: {relative}"));
        }
    }
    problems
}

/// Report whether `path` hashes to the expected digest value.
fn hash_matches(path: &Path, expected: &Value) -> bool {
    sha256_file(path).ok().as_deref() == expected.as_str()
}

/// Report whether `path` is a symlink whose target equals `expected`.
fn symlink_matches(path: &Path, expected: &str) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
        && fs::read_link(path).is_ok_and(|target| to_posix(&target) == expected)
}

// ── Manifest walk ────────────────────────────────────────────────────────────

/// Size and SHA-256 recorded for one regular file.
struct FileRecord {
    size: u64,
    sha256: String,
}

/// Collect the manifest entries for every non-directory under `source`.
fn collect_manifest(source: &Path) -> Result<Vec<Value>, ZdebugError> {
    let mut entries = Vec::new();
    walk_manifest(source, source, &mut entries)?;
    Ok(entries)
}

/// Walk `directory` depth-first, recording files and symlinks into `entries`.
///
/// The traversal mirrors `os.walk(followlinks=False)`: directory entries are
/// visited in sorted order, regular files and symlinks are recorded in
/// sorted order before descending, and symlinked directories are neither
/// recorded nor followed.
fn walk_manifest(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<Value>,
) -> Result<(), ZdebugError> {
    let mut directories = Vec::new();
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            directories.push(path);
        } else {
            names.push(path);
        }
    }
    directories.sort();
    names.sort();
    for path in &names {
        record_manifest_entry(root, path, entries)?;
    }
    for path in &directories {
        if !is_symlink(path) {
            walk_manifest(root, path, entries)?;
        }
    }
    Ok(())
}

/// Record one file or symlink as a manifest entry.
fn record_manifest_entry(
    root: &Path,
    path: &Path,
    entries: &mut Vec<Value>,
) -> Result<(), ZdebugError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        ZdebugError::new(
            "PATH_OUTSIDE_CASE",
            format!("Manifest entry escapes source: {}", path.display()),
        )
    })?;
    let relative = to_posix(relative);
    if is_symlink(path) {
        let target = fs::read_link(path)?;
        entries.push(json!({"path": relative, "symlink": to_posix(&target)}));
    } else if path.is_file() {
        let record = file_record(path)?;
        entries.push(json!({
            "path": relative,
            "size": record.size,
            "sha256": record.sha256,
        }));
    }
    Ok(())
}

/// Report whether `path` is itself a symlink (without following it).
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
}

/// Return the size and SHA-256 of one regular file.
fn file_record(path: &Path) -> Result<FileRecord, ZdebugError> {
    let size = fs::metadata(path)?.len();
    let sha256 = sha256_file(path).map_err(ZdebugError::from)?;
    Ok(FileRecord { size, sha256 })
}

/// Return the final path component of `path`, or `"artifact"` when absent.
fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || "artifact".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Collapse `.` and `..` components without touching the filesystem.
///
/// `source` and `case_dir` are canonical, but the joined `copy`
/// destination may not exist yet, so `..` components must be removed
/// lexically before the containment check.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{State, apply_event};
    use crate::util::sha256_bytes;

    /// Create a Case directory inside a fresh temporary directory.
    fn case_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        fs::create_dir_all(&case_dir).unwrap();
        (dir, case_dir)
    }

    #[test]
    fn test_copy_storage_roundtrip() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("notes.txt");
        fs::write(&source, b"hello").unwrap();

        let payload = create_artifact_payload(
            &case_dir,
            "AR-001",
            &source,
            Storage::Copy,
            &ArtifactOptions::default(),
        )
        .unwrap();

        assert_eq!(payload["id"], "AR-001");
        assert_eq!(payload["storage"], "copy");
        assert_eq!(payload["availability"], "durable");
        assert_eq!(payload["path"], "artifacts/imported/AR-001/notes.txt");
        assert_eq!(payload["size"], json!(5));
        assert_eq!(payload["sha256"], sha256_bytes(b"hello"));
        let stored = case_dir.join(payload["path"].as_str().unwrap());
        assert_eq!(fs::read(&stored).unwrap(), b"hello");
        assert!(verify_artifact(&case_dir, &payload).is_empty());
    }

    #[test]
    fn test_copy_destination_name_override() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("notes.txt");
        fs::write(&source, b"hello").unwrap();

        let payload = create_artifact_payload(
            &case_dir,
            "AR-002",
            &source,
            Storage::Copy,
            &ArtifactOptions {
                destination_name: Some("deliverable.md".to_owned()),
                ..ArtifactOptions::default()
            },
        )
        .unwrap();

        assert_eq!(payload["path"], "artifacts/imported/AR-002/deliverable.md");
    }

    #[test]
    fn test_copy_requires_file() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("bundle");
        fs::create_dir_all(&source).unwrap();
        let err = create_source_error(&case_dir, &source, Storage::Copy);
        assert_eq!(err.code(), "COPY_REQUIRES_FILE");
    }

    #[test]
    fn test_source_missing() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("missing.txt");
        let err = create_source_error(&case_dir, &source, Storage::Copy);
        assert_eq!(err.code(), "FILE_NOT_FOUND");
    }

    #[test]
    fn test_copy_destination_escape_rejected() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("notes.txt");
        fs::write(&source, b"hello").unwrap();

        let err = create_artifact_payload(
            &case_dir,
            "AR-001",
            &source,
            Storage::Copy,
            &ArtifactOptions {
                destination_name: Some("../../../../escape.txt".to_owned()),
                ..ArtifactOptions::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "PATH_OUTSIDE_CASE");
    }

    #[test]
    fn test_reference_storage_roundtrip() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("external.bin");
        fs::write(&source, b"payload").unwrap();

        let payload = create_artifact_payload(
            &case_dir,
            "AR-003",
            &source,
            Storage::Reference,
            &ArtifactOptions {
                availability: "ephemeral".to_owned(),
                ..ArtifactOptions::default()
            },
        )
        .unwrap();

        assert_eq!(payload["storage"], "reference");
        assert_eq!(payload["availability"], "ephemeral");
        assert_eq!(payload["path"], to_posix(&resolve_path(&source)));
        assert_eq!(payload["sha256"], sha256_bytes(b"payload"));
        assert!(verify_artifact(&case_dir, &payload).is_empty());
    }

    #[test]
    fn test_reference_missing_source_reported() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("external.bin");
        fs::write(&source, b"payload").unwrap();
        let payload = create_artifact_payload(
            &case_dir,
            "AR-003",
            &source,
            Storage::Reference,
            &ArtifactOptions::default(),
        )
        .unwrap();

        fs::remove_file(&source).unwrap();
        assert_eq!(
            verify_artifact(&case_dir, &payload),
            vec!["external artifact is missing".to_owned()]
        );
    }

    #[test]
    fn test_manifest_requires_directory() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("file.txt");
        fs::write(&source, b"data").unwrap();
        let err = create_source_error(&case_dir, &source, Storage::Manifest);
        assert_eq!(err.code(), "MANIFEST_REQUIRES_DIRECTORY");
    }

    #[cfg(unix)]
    #[test]
    fn test_manifest_storage_records_files_and_symlinks() {
        use std::os::unix::fs::symlink;

        let (dir, case_dir) = case_root();
        let source = dir.path().join("bundle");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("root.txt"), b"root").unwrap();
        fs::write(source.join("sub/nested.txt"), b"nested").unwrap();
        symlink("root.txt", source.join("link.txt")).unwrap();
        symlink("sub", source.join("linkdir")).unwrap();

        let payload = create_artifact_payload(
            &case_dir,
            "AR-004",
            &source,
            Storage::Manifest,
            &ArtifactOptions::default(),
        )
        .unwrap();

        assert_eq!(payload["storage"], "manifest");
        assert_eq!(payload["path"], to_posix(&resolve_path(&source)));
        let files = payload["files"].as_array().unwrap();
        let paths: Vec<&str> =
            files.iter().map(|item| item["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["link.txt", "root.txt", "sub/nested.txt"]);
        let link =
            files.iter().find(|item| item["path"] == "link.txt").unwrap();
        assert_eq!(link["symlink"], "root.txt");
        assert!(verify_artifact(&case_dir, &payload).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_manifest_verify_reports_content_and_symlink_drift() {
        use std::os::unix::fs::symlink;

        let (dir, case_dir) = case_root();
        let source = dir.path().join("bundle");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("sub/nested.txt"), b"nested").unwrap();
        symlink("sub/nested.txt", source.join("link.txt")).unwrap();

        let payload = create_artifact_payload(
            &case_dir,
            "AR-004",
            &source,
            Storage::Manifest,
            &ArtifactOptions::default(),
        )
        .unwrap();

        fs::write(source.join("sub/nested.txt"), b"tampered").unwrap();
        let problems = verify_artifact(&case_dir, &payload);
        assert!(
            problems.contains(&"sha256 mismatch: sub/nested.txt".to_owned())
        );

        fs::remove_file(source.join("link.txt")).unwrap();
        fs::write(source.join("link.txt"), b"now a regular file").unwrap();
        let problems = verify_artifact(&case_dir, &payload);
        assert!(problems.contains(&"symlink changed: link.txt".to_owned()));
    }

    #[test]
    fn test_verify_copy_reports_drift() {
        let (dir, case_dir) = case_root();
        let source = dir.path().join("notes.txt");
        fs::write(&source, b"hello").unwrap();
        let payload = create_artifact_payload(
            &case_dir,
            "AR-001",
            &source,
            Storage::Copy,
            &ArtifactOptions::default(),
        )
        .unwrap();
        let stored = case_dir.join(payload["path"].as_str().unwrap());

        fs::remove_file(&stored).unwrap();
        assert_eq!(
            verify_artifact(&case_dir, &payload),
            vec!["self-contained artifact is missing".to_owned()]
        );

        fs::write(&stored, b"tampered").unwrap();
        assert_eq!(
            verify_artifact(&case_dir, &payload),
            vec!["sha256 mismatch".to_owned()]
        );
    }

    #[test]
    fn test_invalidation_payload_rejects_invalidated_reference() {
        let mut state = State::default();
        apply_event(
            &mut state,
            &event(
                1,
                "case-created",
                json!({
                    "title": "t",
                    "objective": "o",
                    "workspaces": [],
                    "baseline": [],
                }),
            ),
        )
        .unwrap();
        apply_event(
            &mut state,
            &event(
                2,
                "artifact-created",
                json!({
                    "id": "AR-001",
                    "storage": "reference",
                    "path": "/tmp/external.bin",
                    "sha256": "deadbeef",
                }),
            ),
        )
        .unwrap();
        assert!(!is_invalidated(&state.artifacts["AR-001"]));

        apply_event(
            &mut state,
            &event(
                3,
                "artifact-invalidated",
                invalidation_payload("AR-001", "stale"),
            ),
        )
        .unwrap();
        assert!(is_invalidated(&state.artifacts["AR-001"]));
        assert_eq!(state.artifacts["AR-001"]["invalidation_reason"], "stale");

        let err = apply_event(
            &mut state,
            &event(
                4,
                "evidence-created",
                json!({
                    "id": "EV-001",
                    "statement": "s",
                    "provenance": {"kind": "observation"},
                    "attachments": ["AR-001"],
                }),
            ),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALIDATED_ARTIFACT");
    }

    /// Build an event envelope at `seq` for the model layer.
    fn event(seq: u64, event_type: &str, payload: Value) -> Value {
        let mut envelope = serde_json::Map::new();
        envelope.insert("format_version".to_owned(), json!(1));
        envelope.insert("case_id".to_owned(), json!("case-1"));
        envelope.insert("seq".to_owned(), json!(seq));
        envelope.insert(
            "event_id".to_owned(),
            Value::String(format!("EVT-{seq:06}")),
        );
        envelope
            .insert("timestamp".to_owned(), json!("2026-01-01T00:00:00.000Z"));
        envelope
            .insert("type".to_owned(), Value::String(event_type.to_owned()));
        envelope.insert("payload".to_owned(), payload);
        Value::Object(envelope)
    }

    #[test]
    fn test_storage_parse() {
        assert_eq!(Storage::parse("copy").unwrap(), Storage::Copy);
        assert_eq!(Storage::parse("reference").unwrap(), Storage::Reference);
        assert_eq!(Storage::parse("manifest").unwrap(), Storage::Manifest);
        assert_eq!(Storage::Copy.as_str(), "copy");
        let err = Storage::parse("archive").unwrap_err();
        assert_eq!(err.code(), "INVALID_STORAGE");
    }

    /// Capture an artifact and return the error for a failing creation.
    fn create_source_error(
        case_dir: &Path,
        source: &Path,
        storage: Storage,
    ) -> ZdebugError {
        create_artifact_payload(
            case_dir,
            "AR-001",
            source,
            storage,
            &ArtifactOptions::default(),
        )
        .unwrap_err()
    }
}
