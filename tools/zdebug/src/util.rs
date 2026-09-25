//! Deterministic helpers shared across `zdebug` layers.
//!
//! The functions mirror the reference Python utilities: canonical JSON for
//! byte-stable event serialization, atomic writes with `fsync` durability,
//! SHA-256 content hashing, environment snapshots with sensitive-key
//! redaction, and a stable, code-carrying [`ZdebugError`].

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use nix::unistd::User;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Allowed identifier shape: an ASCII alphanumeric lead, then any mix of
/// ASCII alphanumerics, dot, underscore, and hyphen.
const ID_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9._-]*$";

/// Environment key markers whose values are never emitted verbatim.
const SENSITIVE_ENV_MARKERS: [&str; 8] = [
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "SECRET",
    "API_KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
    "AUTH",
];

/// Chunk size used when hashing a file's contents.
const HASH_CHUNK_BYTES: usize = 1024 * 1024;

// ── Errors ───────────────────────────────────────────────────────────────────

/// A stable, user-facing failure carrying a machine-readable `code`.
///
/// The `code` is a business identifier (for example `INVALID_EVENT` or
/// `CASE_BUSY`); `message` is the human-readable description and `details`
/// holds structured context for programmatic consumers.
#[derive(Debug, Clone)]
pub struct ZdebugError {
    code: String,
    message: String,
    details: BTreeMap<String, Value>,
}

impl ZdebugError {
    /// Build an error with a code and message and no structured details.
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: BTreeMap::new(),
        }
    }

    /// Build an error with a code, message, and structured `details`.
    #[must_use]
    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: BTreeMap<String, Value>,
    ) -> Self {
        Self { code: code.into(), message: message.into(), details }
    }

    /// Return the machine-readable error code.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Return the human-readable error message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Return the structured error details.
    #[must_use]
    pub const fn details(&self) -> &BTreeMap<String, Value> {
        &self.details
    }
}

impl fmt::Display for ZdebugError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ZdebugError {}

impl From<io::Error> for ZdebugError {
    fn from(err: io::Error) -> Self {
        Self::new("IO_ERROR", err.to_string())
    }
}

// ── Time ─────────────────────────────────────────────────────────────────────

/// Return the current UTC time as an ISO-8601 string with millisecond
/// precision and a trailing `Z`.
#[must_use]
pub fn utc_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ── Identifiers ──────────────────────────────────────────────────────────────

/// Derive the next identifier for `prefix` from the keys of `mapping`.
///
/// Keys are `<prefix>-<number>` (optionally with a further `-` suffix);
/// the highest number seen determines the next one, mirroring the
/// reference `CaseRepository.next_id`.
#[must_use]
pub fn next_id(prefix: &str, mapping: &Map<String, Value>) -> String {
    let mut highest = 0_u32;
    for identifier in mapping.keys() {
        let Some(rest) = identifier
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('-'))
        else {
            continue;
        };
        let Some(number) =
            rest.split('-').next().and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        highest = highest.max(number);
    }
    format!("{prefix}-{:03}", highest + 1)
}

/// Validate an identifier against [`ID_PATTERN`], returning it unchanged.
///
/// # Errors
///
/// Returns [`ZdebugError`] with code `INVALID_ID` when `value` does not
/// match the identifier pattern.
pub fn validate_id(value: &str, label: &str) -> Result<String, ZdebugError> {
    let mut chars = value.chars();
    let leads_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric());
    let tail_ok = chars
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if leads_ok && tail_ok {
        return Ok(value.to_owned());
    }
    let details = BTreeMap::from([(
        "expected".to_owned(),
        Value::String(ID_PATTERN.to_owned()),
    )]);
    Err(ZdebugError::with_details(
        "INVALID_ID",
        format!("Invalid {label}: {value:?}"),
        details,
    ))
}

// ── Canonical JSON ───────────────────────────────────────────────────────────

/// Serialize `value` to canonical JSON.
///
/// Object keys are sorted, separators are compact (`,` and `:` without
/// spaces), and non-ASCII characters are emitted literally, so equal
/// logical values always produce byte-identical output.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

/// Recursively append the canonical encoding of `value` to `out`.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => write_json_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// Append `value` as a quoted JSON string, escaping only the characters
/// JSON requires and leaving non-ASCII code points intact.
fn write_json_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Read and parse a UTF-8 JSON file.
///
/// # Errors
///
/// Returns [`ZdebugError`] with code `FILE_NOT_FOUND` when the file is
/// missing, `INVALID_JSON` when parsing fails, or `IO_ERROR` for any other
/// read failure.
pub fn read_json(path: &Path) -> Result<Value, ZdebugError> {
    let text = fs::read_to_string(path).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            ZdebugError::new(
                "FILE_NOT_FOUND",
                format!("File not found: {}", path.display()),
            )
        } else {
            ZdebugError::from(err)
        }
    })?;
    serde_json::from_str(&text).map_err(|err| {
        ZdebugError::new(
            "INVALID_JSON",
            format!("Invalid JSON in {}: {err}", path.display()),
        )
    })
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/// Return the lowercase hex SHA-256 digest of `data`.
#[must_use]
pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex_digest(&hasher.finalize())
}

/// Return the lowercase hex SHA-256 digest of a file's contents.
///
/// # Errors
///
/// Returns an I/O error if the file cannot be opened or read.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

/// Encode a byte slice as lowercase hexadecimal.
fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        },
    )
}

// ── Filesystem ───────────────────────────────────────────────────────────────

/// Write `data` to `path` atomically and durably.
///
/// The content is written to a unique temporary sibling, flushed and
/// `fsync`ed, then renamed onto `path`; the parent directory is `fsync`ed
/// so the rename survives a crash. Parent directories are created as
/// needed, and the temporary file is removed on failure.
///
/// # Errors
///
/// Returns an I/O error if the parent directory cannot be created, the
/// temporary file cannot be written, or the rename fails.
pub fn atomic_write(path: &Path, data: &str) -> io::Result<()> {
    let parent = parent_dir(path);
    fs::create_dir_all(parent)?;
    let temp = temp_path(path);
    if let Err(err) = write_sync(&temp, data.as_bytes()) {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    sync_dir(parent);
    Ok(())
}

/// Copy `source` to `destination` atomically.
///
/// The source is copied to a temporary sibling of `destination` and then
/// renamed into place, so readers never observe a partial file.
///
/// # Errors
///
/// Returns an I/O error if the parent directory cannot be created, the
/// source cannot be copied, or the rename fails.
pub fn copy_file(source: &Path, destination: &Path) -> io::Result<()> {
    let parent = parent_dir(destination);
    fs::create_dir_all(parent)?;
    let temp = temp_path(destination);
    if let Err(err) = fs::copy(source, &temp) {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    Ok(())
}

/// Write `data` to `path` and flush it to stable storage.
fn write_sync(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(data)?;
    file.flush()?;
    file.sync_all()
}

/// Best-effort `fsync` of a directory so renames within it are durable.
fn sync_dir(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// Return the directory that should contain a temporary sibling of `path`.
fn parent_dir(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Build a unique temporary path in the same directory as `path`.
fn temp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map_or_else(
        || "tmp".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |delta| delta.as_nanos());
    path.with_file_name(format!(".{name}.{}.{nanos}.tmp", process::id()))
}

// ── Paths ────────────────────────────────────────────────────────────────────

/// Report whether `path` is located within `root`.
#[must_use]
pub fn path_within(path: &Path, root: &Path) -> bool {
    resolve_path(path).starts_with(resolve_path(root))
}

/// Return `path` relative to `case_dir` using forward slashes.
///
/// # Errors
///
/// Returns [`ZdebugError`] with code `PATH_OUTSIDE_CASE` when `path` is not
/// contained in `case_dir`.
pub fn relative_case_path(
    path: &Path,
    case_dir: &Path,
) -> Result<String, ZdebugError> {
    let resolved = resolve_path(path);
    let root = resolve_path(case_dir);
    resolved.strip_prefix(&root).map_or_else(
        |_| {
            Err(ZdebugError::new(
                "PATH_OUTSIDE_CASE",
                format!(
                    "Path is outside the Case directory: {}",
                    path.display()
                ),
            ))
        },
        |relative| Ok(to_posix(relative)),
    )
}

// ── Executables ──────────────────────────────────────────────────────────────

/// Locate an executable named `program`, like `shutil.which`.
///
/// A name containing a path separator is resolved against the current
/// directory (or used as-is when absolute); otherwise every `PATH` entry is
/// searched in order. Only a regular file carrying an execute bit counts as
/// a match.
#[must_use]
pub fn which_executable(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let candidate = Path::new(program);
        let candidate = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            std::env::current_dir().ok()?.join(candidate)
        };
        return is_executable(&candidate).then_some(candidate);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(program))
        .find(|candidate| is_executable(candidate))
}

/// Report whether `path` is a regular, executable file.
#[must_use]
fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    })
}

/// Expand a leading `~` in `path` using `home`, when one is available.
///
/// A bare `~` and `~/...` use `home` (the caller passes the value of
/// `HOME`). A `~user` prefix is resolved through the system user database
/// via [`nix::unistd::User::from_name`]: a known user expands to its home,
/// while an unknown user leaves the path unchanged, matching Python's
/// `expanduser`. A `~` that is not the leading component is preserved
/// verbatim, and a missing `home` leaves the bare forms untouched.
fn expand_tilde(path: &Path, home: Option<&Path>) -> PathBuf {
    let bytes = path.as_os_str().as_bytes();
    let Some(rest) = bytes.strip_prefix(b"~") else {
        return path.to_path_buf();
    };
    if rest.is_empty() {
        return home.map_or_else(|| path.to_path_buf(), Path::to_path_buf);
    }
    if let Some(rest) = rest.strip_prefix(b"/") {
        return home.map_or_else(
            || path.to_path_buf(),
            |home| home.join(OsStr::from_bytes(rest)),
        );
    }
    let (name, tail) = rest.iter().position(|byte| *byte == b'/').map_or_else(
        || (rest, &rest[rest.len()..]),
        |index| (&rest[..index], &rest[index + 1..]),
    );
    let Ok(name) = std::str::from_utf8(name) else {
        return path.to_path_buf();
    };
    user_home(name).map_or_else(
        || path.to_path_buf(),
        |user_home| user_home.join(OsStr::from_bytes(tail)),
    )
}

/// Look up `name` in the system user database and return its home.
fn user_home(name: &str) -> Option<PathBuf> {
    User::from_name(name).ok().flatten().map(|user| user.dir)
}

/// Expand a leading `~` in `path` to the home directory from `HOME`.
///
/// Mirrors Python's `Path.expanduser`: the bare `~` forms use `HOME`, and
/// `~user` forms resolve through the system user database. When `HOME` is
/// unset, or the named user is unknown, the path is returned unchanged.
#[must_use]
pub fn expand_user(path: &Path) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    expand_tilde(path, home.as_deref())
}

/// Resolve `path` to an absolute path, tolerating paths that do not exist.
///
/// Existing paths are canonicalized (resolving symlinks) to match the paths
/// Git reports. For a missing path the nearest existing ancestor is
/// canonicalized and the remaining components are appended, mirroring
/// Python's `Path.resolve(strict=False)`.
pub(crate) fn resolve_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    let mut tail: Vec<OsString> = Vec::new();
    let mut current = path;
    while let Some(parent) = current.parent() {
        if let Some(name) = current.file_name() {
            tail.push(name.to_os_string());
        }
        if let Ok(canonical) = parent.canonicalize() {
            let mut resolved = canonical;
            for name in tail.iter().rev() {
                resolved.push(name);
            }
            return resolved;
        }
        current = parent;
    }
    path.to_path_buf()
}

/// Render a path using forward slashes.
pub(crate) fn to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

// ── Environment ──────────────────────────────────────────────────────────────

/// Snapshot environment variables with sensitive values redacted.
///
/// Every key is hashed into `value_hashes`; keys whose names match a
/// sensitive marker are listed in `redacted_keys` and never stored
/// verbatim. Keys listed in `explicit` that are not sensitive are stored
/// verbatim in `explicit_values`.
#[must_use]
pub fn environment_snapshot(
    environment: &BTreeMap<String, String>,
    explicit: &BTreeSet<String>,
) -> Value {
    let mut value_hashes = Map::new();
    let mut explicit_values = Map::new();
    let mut redacted_keys = Vec::new();
    for (key, value) in environment {
        value_hashes
            .insert(key.clone(), Value::String(sha256_bytes(value.as_bytes())));
        if is_sensitive_key(key) {
            redacted_keys.push(Value::String(key.clone()));
        } else if explicit.contains(key) {
            explicit_values.insert(key.clone(), Value::String(value.clone()));
        }
    }
    let mut object = Map::new();
    object.insert("value_hashes".to_owned(), Value::Object(value_hashes));
    object.insert("explicit_values".to_owned(), Value::Object(explicit_values));
    object.insert("redacted_keys".to_owned(), Value::Array(redacted_keys));
    Value::Object(object)
}

/// Report whether an environment key name denotes a sensitive value.
fn is_sensitive_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    SENSITIVE_ENV_MARKERS.iter().any(|marker| upper.contains(marker))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_canonical_json_is_key_order_stable() {
        let first = json!({"b": 1, "a": 2});
        let second = json!({"a": 2, "b": 1});
        assert_eq!(canonical_json(&first), canonical_json(&second));
        assert_eq!(canonical_json(&first), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn test_canonical_json_sorts_nested_objects() {
        let value = json!({
            "z": {"y": [{"b": 1, "a": 2}], "x": true},
            "a": null,
        });
        assert_eq!(
            canonical_json(&value),
            r#"{"a":null,"z":{"x":true,"y":[{"a":2,"b":1}]}}"#
        );
    }

    #[test]
    fn test_canonical_json_keeps_non_ascii_literal() {
        let value = json!({"名字": "调试", "emoji": "🐛"});
        assert_eq!(
            canonical_json(&value),
            "{\"emoji\":\"🐛\",\"名字\":\"调试\"}"
        );
    }

    #[test]
    fn test_canonical_json_escapes_control_characters() {
        let value = Value::String("a\nb\t\"c\\".to_owned());
        assert_eq!(canonical_json(&value), r#""a\nb\t\"c\\""#);
    }

    #[test]
    fn test_canonical_json_scalar_roundtrip() {
        assert_eq!(canonical_json(&json!(42)), "42");
        assert_eq!(canonical_json(&json!(true)), "true");
        assert_eq!(canonical_json(&Value::Null), "null");
        assert_eq!(canonical_json(&json!([1, 2, 3])), "[1,2,3]");
    }

    #[test]
    fn test_sha256_bytes_known_vector() {
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn test_sha256_file_known_vector() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.txt");
        fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn test_sha256_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.bin");
        assert!(sha256_file(&missing).is_err());
    }

    #[test]
    fn test_atomic_write_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/out.json");
        atomic_write(&path, "hello").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
        assert!(no_temp_files(path.parent().unwrap()));
    }

    #[test]
    fn test_atomic_write_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("value.txt");
        atomic_write(&path, "first").unwrap();
        atomic_write(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert!(no_temp_files(dir.path()));
    }

    #[test]
    fn test_copy_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.txt");
        let destination = dir.path().join("nested/dest.txt");
        fs::write(&source, "payload").unwrap();
        copy_file(&source, &destination).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), "payload");
        assert!(no_temp_files(destination.parent().unwrap()));
    }

    #[test]
    fn test_copy_file_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("missing.txt");
        let destination = dir.path().join("dest.txt");
        assert!(copy_file(&source, &destination).is_err());
    }

    #[test]
    fn test_read_json_valid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(&path, r#"{"a":1}"#).unwrap();
        assert_eq!(read_json(&path).unwrap(), json!({"a": 1}));
    }

    #[test]
    fn test_read_json_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.json");
        let err = read_json(&path).unwrap_err();
        assert_eq!(err.code(), "FILE_NOT_FOUND");
    }

    #[test]
    fn test_read_json_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        fs::write(&path, "{not json").unwrap();
        let err = read_json(&path).unwrap_err();
        assert_eq!(err.code(), "INVALID_JSON");
    }

    #[test]
    fn test_which_executable_requires_the_execute_bit() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("plain-tool");
        fs::write(&tool, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o644)).unwrap();
        let absolute = tool.to_string_lossy().into_owned();
        assert!(which_executable(&absolute).is_none());

        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(which_executable(&absolute), Some(tool));
        assert!(which_executable("zdebug-definitely-missing-tool").is_none());
    }

    #[test]
    fn test_validate_id_accepts() {
        assert_eq!(validate_id("case-1", "case").unwrap(), "case-1");
        assert_eq!(validate_id("a.b_c-9", "case").unwrap(), "a.b_c-9");
    }

    #[test]
    fn test_validate_id_rejects() {
        for bad in ["", "-lead", ".lead", "has space", "щ"] {
            let err = validate_id(bad, "case").unwrap_err();
            assert_eq!(err.code(), "INVALID_ID");
            assert!(err.details().contains_key("expected"));
        }
    }

    #[test]
    fn test_path_within() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(path_within(&root.join("a/b"), root));
        assert!(!path_within(&root.join("../escape"), root));
    }

    #[test]
    fn test_relative_case_path_inside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let nested = root.join("a/b.txt");
        assert_eq!(relative_case_path(&nested, root).unwrap(), "a/b.txt");
    }

    #[test]
    fn test_relative_case_path_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("case");
        fs::create_dir_all(&root).unwrap();
        let outside = dir.path().join("other.txt");
        let err = relative_case_path(&outside, &root).unwrap_err();
        assert_eq!(err.code(), "PATH_OUTSIDE_CASE");
    }

    #[test]
    fn test_expand_tilde_only_leading_bare_tilde() {
        let home = Path::new("/home/tester");
        assert_eq!(expand_tilde(Path::new("~"), Some(home)), home);
        assert_eq!(
            expand_tilde(Path::new("~/case"), Some(home)),
            home.join("case")
        );
        assert_eq!(
            expand_tilde(Path::new("~/a/b"), Some(home)),
            home.join("a/b")
        );
        // A non-leading tilde is preserved verbatim.
        assert_eq!(
            expand_tilde(Path::new("/tmp/~/x"), Some(home)),
            PathBuf::from("/tmp/~/x")
        );
    }

    #[test]
    fn test_expand_tilde_named_user() {
        let current = User::from_uid(nix::unistd::getuid())
            .unwrap()
            .expect("current uid resolves to a user");
        let named = PathBuf::from(format!("~{}/data", current.name));
        assert_eq!(expand_tilde(&named, None), current.dir.join("data"));
    }

    #[test]
    fn test_expand_tilde_unknown_user_is_identity() {
        let path = Path::new("~zdebug-absent-user/x");
        assert_eq!(
            expand_tilde(path, None),
            PathBuf::from("~zdebug-absent-user/x")
        );
    }

    #[test]
    fn test_expand_tilde_without_home_is_identity() {
        assert_eq!(
            expand_tilde(Path::new("~/case"), None),
            PathBuf::from("~/case")
        );
        assert_eq!(
            expand_tilde(Path::new("plain"), None),
            PathBuf::from("plain")
        );
    }

    #[test]
    fn test_environment_snapshot_redaction() {
        let environment = BTreeMap::from([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("API_TOKEN".to_owned(), "shh".to_owned()),
            ("LANG".to_owned(), "en_US".to_owned()),
        ]);
        let explicit =
            BTreeSet::from(["LANG".to_owned(), "API_TOKEN".to_owned()]);
        let snapshot = environment_snapshot(&environment, &explicit);
        assert_eq!(snapshot["explicit_values"]["LANG"], "en_US");
        assert!(snapshot["explicit_values"].get("API_TOKEN").is_none());
        assert_eq!(snapshot["redacted_keys"], json!(["API_TOKEN"]));
        assert_eq!(snapshot["value_hashes"]["PATH"], sha256_bytes(b"/bin"));
        assert_eq!(snapshot["value_hashes"]["API_TOKEN"], sha256_bytes(b"shh"));
    }

    #[test]
    fn test_utc_now_has_millisecond_shape() {
        let now = utc_now();
        assert!(now.ends_with('Z'), "timestamp should end with Z: {now}");
        assert_eq!(now.len(), 24, "timestamp should be 24 chars: {now}");
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[19..20], ".");
    }

    #[test]
    fn test_zdebug_error_accessors_and_display() {
        let details =
            BTreeMap::from([("k".to_owned(), Value::String("v".to_owned()))]);
        let err = ZdebugError::with_details("CASE_BUSY", "busy", details);
        assert_eq!(err.code(), "CASE_BUSY");
        assert_eq!(err.message(), "busy");
        assert_eq!(err.details()["k"], "v");
        assert_eq!(err.to_string(), "busy");
    }

    #[test]
    fn test_zdebug_error_from_io() {
        let io_err = io::Error::other("boom");
        let err = ZdebugError::from(io_err);
        assert_eq!(err.code(), "IO_ERROR");
        assert!(err.message().contains("boom"));
    }

    /// Report whether `dir` is free of leftover temporary files.
    fn no_temp_files(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().all(|entry| {
            entry.is_ok_and(|entry| {
                !entry.file_name().to_string_lossy().ends_with(".tmp")
            })
        })
    }
}
