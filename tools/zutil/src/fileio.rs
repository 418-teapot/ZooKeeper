//! Atomic file write and cross-process file locking.
//!
//! `write_atomic` / `write_atomic_bytes` write content to a `.tmp` sibling
//! (same filesystem, ensuring `rename` is atomic) and then atomically rename
//! it to the target path.  No `.tmp` file lingers after a successful write.
//!
//! `acquire_file_lock` / `with_file_lock` (gated behind the `file-lock`
//! feature) provide exclusive cross-process locking via `fs2::FileExt`.
//! The lock is released when the returned `File` is dropped, or when the
//! closure passed to `with_file_lock` returns.

use std::io;
use std::path::Path;

/// Write `content` to `path` atomically via a temporary sibling file.
///
/// The content is first written to `{path}.tmp` (in the same directory as
/// `path`, so `rename` is atomic on the same filesystem), then renamed to
/// `path`.  If the function returns `Ok`, the `.tmp` file is guaranteed to
/// have been removed.
///
/// # Errors
///
/// Returns an I/O error if the temporary file cannot be written or the
/// rename fails.
pub fn write_atomic(path: &Path, content: &str) -> io::Result<()> {
    write_atomic_bytes(path, content.as_bytes())
}

/// Write `content` (bytes) to `path` atomically via a temporary sibling file.
///
/// See [`write_atomic`] for details.
///
/// # Errors
///
/// Returns an I/O error if the temporary file cannot be written or the
/// rename fails.
pub fn write_atomic_bytes(path: &Path, content: &[u8]) -> io::Result<()> {
    let tmp = tmp_path_for(path);
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// Write to `path` atomically via a temporary sibling file, using a closure
/// for streaming/binary data that is written to the temp file first, then
/// atomically renamed to the target path.
///
/// This follows the same atomic-rename pattern as [`write_atomic`] but is
/// suitable for binary data or streaming writers (e.g. gzip encoders).
///
/// # Errors
///
/// Returns an I/O error if the temporary file cannot be created, the closure
/// fails, or the rename fails.
pub fn write_atomic_stream(
    path: &Path,
    write_fn: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    let tmp = tmp_path_for(path);
    let mut f = std::fs::File::create(&tmp)?;
    write_fn(&mut f)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Return the `.tmp` sibling path for `path`.
///
/// If `path` has an extension, the extension is suffixed with `.tmp`
/// (e.g. `foo.lock` → `foo.lock.tmp`).  If `path` has no extension,
/// `.tmp` is appended directly (e.g. `foo` → `foo.tmp`).
pub(crate) fn tmp_path_for(path: &Path) -> std::path::PathBuf {
    let ext = path.extension().map(|e| e.to_string_lossy()).unwrap_or_default();
    path.with_extension(format!("{ext}.tmp"))
}

/// Acquire an exclusive cross-process file lock on `path`.
///
/// Opens or creates `path`, then acquires an exclusive advisory lock via
/// `fs2::FileExt::lock_exclusive`.  The lock is released when the returned
/// `File` is dropped.
///
/// This function is only available when the `file-lock` feature is enabled.
///
/// # Errors
///
/// Returns an I/O error if the file cannot be opened/created or if the
/// lock cannot be acquired.
#[cfg(feature = "file-lock")]
pub fn acquire_file_lock(path: &Path) -> io::Result<std::fs::File> {
    use fs2::FileExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(path)?;
    file.lock_exclusive()?;
    Ok(file)
}

/// Acquire an exclusive cross-process file lock, run `f`, then release.
///
/// Convenience wrapper around [`acquire_file_lock`] that drops the lock
/// file handle after the closure completes.
///
/// This function is only available when the `file-lock` feature is enabled.
///
/// # Errors
///
/// Returns the I/O error from [`acquire_file_lock`] if the lock cannot be
/// acquired, or the error returned by `f`.
#[cfg(feature = "file-lock")]
pub fn with_file_lock<F, R>(path: &Path, f: F) -> io::Result<R>
where
    F: FnOnce() -> io::Result<R>,
{
    let _lock = acquire_file_lock(path)?;
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_atomic_roundtrip() {
        let dir = std::env::temp_dir().join("zutil-test-write-atomic");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test.txt");
        let content = "hello atomic world";

        write_atomic(&path, content).unwrap();

        // File exists with correct content.
        assert!(path.exists(), "target file should exist");
        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, content);

        // No .tmp file lingers.
        let tmp_path = dir.join("test.txt.tmp");
        assert!(!tmp_path.exists(), "tmp file should not linger");

        // Cleanup.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_atomic_no_extension() {
        let dir = std::env::temp_dir().join("zutil-test-write-atomic-noext");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("noextfile");
        write_atomic(&path, "content").unwrap();

        assert!(path.exists());
        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, "content");

        // No .tmp file lingers regardless of extension.
        let tmp_path = dir.join("noextfile.tmp");
        assert!(!tmp_path.exists(), "tmp file should not linger");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_atomic_bytes_roundtrip() {
        let dir = std::env::temp_dir().join("zutil-test-write-atomic-bytes");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("data.bin");
        let content = b"\x00\x01\x02\xff\xfe";

        write_atomic_bytes(&path, content).unwrap();

        assert!(path.exists());
        let read_back = std::fs::read(&path).unwrap();
        assert_eq!(read_back, content);

        let tmp_path = dir.join("data.bin.tmp");
        assert!(!tmp_path.exists(), "tmp file should not linger");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "file-lock")]
    #[test]
    fn test_acquire_file_lock_creates_file() {
        let dir = std::env::temp_dir().join("zutil-test-file-lock");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let lock_path = dir.join(".test.flock");

        // Acquire the lock — the file should be created.
        let file = acquire_file_lock(&lock_path).unwrap();
        assert!(lock_path.exists(), "lock file should exist on disk");

        // Drop releases the lock.
        drop(file);

        // Re-acquire after drop should succeed.
        let file2 = acquire_file_lock(&lock_path).unwrap();
        drop(file2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "file-lock")]
    #[test]
    fn test_with_file_lock_runs_closure() {
        let dir = std::env::temp_dir().join("zutil-test-with-file-lock");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let lock_path = dir.join(".test2.flock");
        let mut flag = false;

        let result = with_file_lock(&lock_path, || {
            flag = true;
            assert!(
                lock_path.exists(),
                "lock file should exist inside closure"
            );
            Ok(())
        });

        assert!(result.is_ok());
        assert!(flag, "closure should have been executed");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
