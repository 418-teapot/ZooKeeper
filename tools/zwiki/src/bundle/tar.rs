//! Tar archive creation and safe extraction utilities.

use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};

use flate2::{Compression, write::GzEncoder};
use tar::Builder;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Atomic write via temp-file + rename (same pattern as zutil::fileio)
// ---------------------------------------------------------------------------

/// Return the `.tmp` sibling path for `path`.
fn tmp_path_for(path: &Path) -> PathBuf {
    let ext = path.extension().map(|e| e.to_string_lossy()).unwrap_or_default();
    path.with_extension(format!("{ext}.tmp"))
}

// ---------------------------------------------------------------------------
// Safe tar extraction — prevents path traversal
// ---------------------------------------------------------------------------

/// Extract a tar archive safely, skipping entries with absolute paths or `..`
/// components that would escape `dest`.
pub fn safe_unpack<R: io::Read>(
    archive: &mut tar::Archive<R>,
    dest: &Path,
) -> io::Result<()> {
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;

        // Deny absolute paths and path traversal
        if path.is_absolute()
            || path.components().any(|c| c == Component::ParentDir)
        {
            let display_path = path.display().to_string();
            eprintln!("警告: 跳过可疑路径: {display_path}");
            continue;
        }

        // Deny symlinks and hardlinks with absolute or traversal targets
        let entry_type = entry.header().entry_type();
        if (entry_type.is_symlink() || entry_type.is_hard_link())
            && let Ok(Some(link_name)) = entry.link_name()
            && (link_name.is_absolute()
                || link_name.components().any(|c| c == Component::ParentDir))
        {
            let display = link_name.display().to_string();
            eprintln!("警告: 跳过可疑链接目标: {display}");
            continue;
        }

        entry.unpack_in(dest)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Recursive directory copy helper
// ---------------------------------------------------------------------------

/// Recursively copy all files from `src` to `dst`, preserving relative paths.
///
/// If `skip_root_bundle` is `true`, the file `bundle.toml` at the root of `src`
/// is skipped (useful for the install step where `bundle.toml` is copied
/// separately).
pub fn copy_recursive(
    src: &Path,
    dst: &Path,
    skip_root_bundle: bool,
) -> io::Result<()> {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let rel =
            entry.path().strip_prefix(src).unwrap_or_else(|_| entry.path());
        if skip_root_bundle && rel == Path::new("bundle.toml") {
            continue;
        }
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Export file collection
// ---------------------------------------------------------------------------

/// Collect files matching include/exclude globs relative to `bundle_dir`.
///
/// # Errors
///
/// Returns `Err(())` if a glob pattern is invalid, fails to match any files,
/// or encounters an I/O error during matching.
pub fn collect_export_files(
    bundle_dir: &Path,
    include: &[String],
    exclude: &[String],
    use_json: bool,
) -> Result<Vec<PathBuf>, ()> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    let canonical_bundle = bundle_dir.canonicalize().map_err(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot resolve bundle directory: {e}")
            } else {
                format!("无法解析 bundle 目录: {e}")
            }
        );
    })?;

    for pattern in include {
        let full_pattern =
            bundle_dir.join(pattern).to_string_lossy().to_string();
        let glob_result = glob::glob(&full_pattern).map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("invalid glob pattern '{pattern}': {e}")
                } else {
                    format!("无效的 glob 模式 '{pattern}': {e}")
                }
            );
        })?;

        let mut matches: Vec<PathBuf> = Vec::new();
        for entry in glob_result {
            let p = entry.map_err(|e| {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("glob error for '{pattern}': {e}")
                    } else {
                        format!("glob 错误 '{pattern}': {e}")
                    }
                );
            })?;
            if p.is_file() {
                matches.push(p);
            }
        }

        if matches.is_empty() {
            eprintln!(
                "{}",
                if use_json {
                    format!("include glob '{pattern}' matched no files")
                } else {
                    format!("包含规则 '{pattern}' 没有匹配任何文件")
                }
            );
            return Err(());
        }

        for p in matches {
            if seen.insert(p.clone()) {
                // Reject files outside bundle_dir (path traversal defense)
                if let Ok(canonical) = p.canonicalize()
                    && !canonical.starts_with(&canonical_bundle)
                {
                    eprintln!(
                        "{}",
                        if use_json {
                            format!(
                                "skipping out-of-bounds file: {}",
                                p.display()
                            )
                        } else {
                            format!("跳过越界文件: {}", p.display())
                        }
                    );
                    continue;
                }
                files.push(p);
            }
        }
    }

    // --- Apply exclude globs ---
    for pattern in exclude {
        let full_pattern =
            bundle_dir.join(pattern).to_string_lossy().to_string();
        if let Ok(entries) = glob::glob(&full_pattern) {
            for entry in entries.flatten() {
                files.retain(|f| *f != entry);
            }
        }
    }

    files.sort();
    Ok(files)
}

// ---------------------------------------------------------------------------
// Tar archive creation
// ---------------------------------------------------------------------------

/// Append all matching export files to a tar archive.
fn add_files_to_tar_archive(
    tar: &mut Builder<GzEncoder<std::fs::File>>,
    bundle_dir: &Path,
    files: &[PathBuf],
    use_json: bool,
) -> io::Result<()> {
    for abs_path in files {
        let relative_path =
            abs_path.strip_prefix(bundle_dir).unwrap_or(abs_path);
        let mut src_file = std::fs::File::open(abs_path).map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot open '{}': {e}", abs_path.display())
                } else {
                    format!("无法打开 '{}': {e}", abs_path.display())
                }
            );
            e
        })?;

        let metadata = src_file.metadata().map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "cannot read metadata for '{}': {e}",
                        abs_path.display()
                    )
                } else {
                    format!("无法读取文件信息 '{}': {e}", abs_path.display())
                }
            );
            e
        })?;

        let mut header = tar::Header::new_gnu();
        header.set_path(relative_path).map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "tar header error for '{}': {e}",
                        relative_path.display()
                    )
                } else {
                    format!("tar 头错误 '{}': {e}", relative_path.display())
                }
            );
            e
        })?;
        header.set_size(metadata.len());
        header.set_mode(0o644);
        header.set_cksum();
        tar.append(&header, &mut src_file).map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "tar append error for '{}': {e}",
                        relative_path.display()
                    )
                } else {
                    format!("tar 添加错误 '{}': {e}", relative_path.display())
                }
            );
            e
        })?;
    }
    Ok(())
}

/// Create a tar.gz archive at `output_path` containing `bundle.toml` and
/// the given `files` (with paths relative to `bundle_dir`).
///
/// The tar.gz is written to a temporary file first then atomically renamed,
/// so a process interruption cannot leave a half-written archive at the
/// destination path.
pub fn write_tar_gz(
    output_path: &str,
    bundle_dir: &Path,
    manifest_content: &str,
    files: &[PathBuf],
    use_json: bool,
) -> io::Result<()> {
    let final_path = Path::new(output_path);
    let tmp_path = tmp_path_for(final_path);

    let file = std::fs::File::create(&tmp_path).map_err(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot create temp output file: {e}")
            } else {
                format!("无法创建临时输出文件: {e}")
            }
        );
        e
    })?;

    let encoder = GzEncoder::new(file, Compression::default());
    let mut tar = Builder::new(encoder);

    // Add bundle.toml first
    {
        let mut header = tar::Header::new_gnu();
        header.set_path("bundle.toml").map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("tar header error: {e}")
                } else {
                    format!("tar 头错误: {e}")
                }
            );
            e
        })?;
        header.set_size(manifest_content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append(&header, manifest_content.as_bytes()).map_err(|e| {
            eprintln!(
                "{}",
                if use_json {
                    format!("tar append error: {e}")
                } else {
                    format!("tar 添加错误: {e}")
                }
            );
            e
        })?;
    }

    // Add all collected files
    add_files_to_tar_archive(&mut tar, bundle_dir, files, use_json)?;

    let encoder = tar.into_inner().map_err(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("tar finalize error: {e}")
            } else {
                format!("tar 完成错误: {e}")
            }
        );
        e
    })?;
    encoder.finish().map_err(|e| {
        eprintln!(
            "{}",
            if use_json {
                format!("gzip finalize error: {e}")
            } else {
                format!("gzip 完成错误: {e}")
            }
        );
        e
    })?;

    // Atomically rename temp file to final path
    std::fs::rename(&tmp_path, final_path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp_path);
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Test helpers (shared across bundle submodules)
// ---------------------------------------------------------------------------

/// Build raw tar.gz bytes for testing path traversal rejection.
/// Unlike `Builder::append_data`, this does NOT validate the entry path,
/// so we can test `safe_unpack` with truly malicious archives.
#[cfg(test)]
pub fn raw_tar_gz(path: &str, content: &[u8]) -> Vec<u8> {
    use std::io::Write;

    let content_size = content.len() as u64;
    let mut hdr = [0u8; 512];

    // Name (first 99 bytes + null)
    let name = path.as_bytes();
    let n = name.len().min(99);
    hdr[..n].copy_from_slice(&name[..n]);

    // Mode, uid, gid (POSIX octal format)
    hdr[100..108].copy_from_slice(b"0000644\0");
    hdr[108..116].copy_from_slice(b"0000000\0");
    hdr[116..124].copy_from_slice(b"0000000\0");

    // Size (11 octal digits + null)
    let size_str = format!("{content_size:011o}");
    hdr[124..135].copy_from_slice(size_str.as_bytes());
    hdr[135] = b'\0';

    // Mtime (11 octal digits + null = 12 bytes)
    hdr[136..148].copy_from_slice(b"00000000000\0");

    // Typeflag: '0' = regular file
    hdr[156] = b'0';

    // UStar magic
    hdr[257..262].copy_from_slice(b"ustar");

    // Compute checksum: sum all bytes with checksum field set to spaces
    for b in &mut hdr[148..156] {
        *b = b' ';
    }
    let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
    let chk = format!("{sum:06o}");
    hdr[148..154].copy_from_slice(chk.as_bytes());
    hdr[154] = b'\0';
    hdr[155] = b' ';

    // Build raw tar data: header + content (padded) + end-of-archive
    let mut raw = Vec::new();
    raw.extend_from_slice(&hdr);
    raw.extend_from_slice(content);
    let pad = (512 - (content.len() % 512)) % 512;
    raw.extend(std::iter::repeat_n(0u8, pad));
    raw.extend(std::iter::repeat_n(0u8, 1024)); // two zero blocks = end

    // Gzip compress
    let mut compressed = Vec::new();
    let mut encoder = GzEncoder::new(&mut compressed, Compression::default());
    encoder.write_all(&raw).unwrap();
    encoder.finish().unwrap();
    compressed
}

/// Build raw tar.gz bytes for a single symlink entry (typeflag '2').
/// The entry has no content data (symlinks have size = 0).
#[cfg(test)]
pub fn raw_tar_symlink_gz(path: &str, link_target: &str) -> Vec<u8> {
    use std::io::Write;

    let mut hdr = [0u8; 512];

    let name = path.as_bytes();
    let n = name.len().min(99);
    hdr[..n].copy_from_slice(&name[..n]);

    hdr[100..108].copy_from_slice(b"0000777\0");
    hdr[108..116].copy_from_slice(b"0000000\0");
    hdr[116..124].copy_from_slice(b"0000000\0");

    hdr[124..135].copy_from_slice(b"00000000000");
    hdr[135] = b'\0';

    hdr[136..148].copy_from_slice(b"00000000000\0");

    hdr[156] = b'2';

    let link = link_target.as_bytes();
    let ln = link.len().min(99);
    hdr[157..157 + ln].copy_from_slice(&link[..ln]);

    hdr[257..262].copy_from_slice(b"ustar");

    for b in &mut hdr[148..156] {
        *b = b' ';
    }
    let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
    let chk = format!("{sum:06o}");
    hdr[148..154].copy_from_slice(chk.as_bytes());
    hdr[154] = b'\0';
    hdr[155] = b' ';

    let mut raw = Vec::new();
    raw.extend_from_slice(&hdr);
    raw.extend(std::iter::repeat_n(0u8, 1024));

    let mut compressed = Vec::new();
    let mut encoder = GzEncoder::new(&mut compressed, Compression::default());
    encoder.write_all(&raw).unwrap();
    encoder.finish().unwrap();
    compressed
}

/// Build raw tar.gz bytes with a symlink entry followed by a regular file
/// entry at the same path.  This simulates the classic tar symlink attack.
#[cfg(test)]
pub fn raw_tar_symlink_and_file_gz(
    symlink_path: &str,
    symlink_target: &str,
    file_path: &str,
    file_content: &[u8],
) -> Vec<u8> {
    use std::io::Write;

    let mut raw = Vec::new();

    // Entry 1: symlink
    {
        let mut hdr = [0u8; 512];
        let name = symlink_path.as_bytes();
        let n = name.len().min(99);
        hdr[..n].copy_from_slice(&name[..n]);
        hdr[100..108].copy_from_slice(b"0000777\0");
        hdr[108..116].copy_from_slice(b"0000000\0");
        hdr[116..124].copy_from_slice(b"0000000\0");
        hdr[124..135].copy_from_slice(b"00000000000");
        hdr[135] = b'\0';
        hdr[136..148].copy_from_slice(b"00000000000\0");
        hdr[156] = b'2';
        let link = symlink_target.as_bytes();
        let ln = link.len().min(99);
        hdr[157..157 + ln].copy_from_slice(&link[..ln]);
        hdr[257..262].copy_from_slice(b"ustar");
        for b in &mut hdr[148..156] {
            *b = b' ';
        }
        let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
        let chk = format!("{sum:06o}");
        hdr[148..154].copy_from_slice(chk.as_bytes());
        hdr[154] = b'\0';
        hdr[155] = b' ';
        raw.extend_from_slice(&hdr);
    }

    // Entry 2: regular file
    {
        let content_size = file_content.len() as u64;
        let mut hdr = [0u8; 512];
        let name = file_path.as_bytes();
        let n = name.len().min(99);
        hdr[..n].copy_from_slice(&name[..n]);
        hdr[100..108].copy_from_slice(b"0000644\0");
        hdr[108..116].copy_from_slice(b"0000000\0");
        hdr[116..124].copy_from_slice(b"0000000\0");
        let size_str = format!("{content_size:011o}");
        hdr[124..135].copy_from_slice(size_str.as_bytes());
        hdr[135] = b'\0';
        hdr[136..148].copy_from_slice(b"00000000000\0");
        hdr[156] = b'0';
        hdr[257..262].copy_from_slice(b"ustar");
        for b in &mut hdr[148..156] {
            *b = b' ';
        }
        let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
        let chk = format!("{sum:06o}");
        hdr[148..154].copy_from_slice(chk.as_bytes());
        hdr[154] = b'\0';
        hdr[155] = b' ';
        raw.extend_from_slice(&hdr);
        raw.extend_from_slice(file_content);
        let pad = (512 - (file_content.len() % 512)) % 512;
        raw.extend(std::iter::repeat_n(0u8, pad));
    }

    // End of archive
    raw.extend(std::iter::repeat_n(0u8, 1024));

    // Gzip compress
    let mut compressed = Vec::new();
    let mut encoder = GzEncoder::new(&mut compressed, Compression::default());
    encoder.write_all(&raw).unwrap();
    encoder.finish().unwrap();
    compressed
}

/// Build raw tar.gz bytes with multiple file entries (paths limited to 99
/// characters).  Each entry is a regular file (typeflag '0').  This is useful
/// for creating valid bundle archives in integration tests.
#[cfg(test)]
pub fn raw_multi_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;

    let mut raw = Vec::new();

    for (path, content) in entries {
        let content_size = content.len() as u64;
        let mut hdr = [0u8; 512];

        let name = path.as_bytes();
        let n = name.len().min(99);
        hdr[..n].copy_from_slice(&name[..n]);

        hdr[100..108].copy_from_slice(b"0000644\0");
        hdr[108..116].copy_from_slice(b"0000000\0");
        hdr[116..124].copy_from_slice(b"0000000\0");

        let size_str = format!("{content_size:011o}");
        hdr[124..135].copy_from_slice(size_str.as_bytes());
        hdr[135] = b'\0';

        hdr[136..148].copy_from_slice(b"00000000000\0");

        hdr[156] = b'0';

        hdr[257..262].copy_from_slice(b"ustar");

        for b in &mut hdr[148..156] {
            *b = b' ';
        }
        let sum: u32 = hdr.iter().map(|&b| u32::from(b)).sum();
        let chk = format!("{sum:06o}");
        hdr[148..154].copy_from_slice(chk.as_bytes());
        hdr[154] = b'\0';
        hdr[155] = b' ';

        raw.extend_from_slice(&hdr);
        raw.extend_from_slice(content);
        let pad = (512 - (content.len() % 512)) % 512;
        raw.extend(std::iter::repeat_n(0u8, pad));
    }

    // End of archive
    raw.extend(std::iter::repeat_n(0u8, 1024));

    // Gzip compress
    let mut compressed = Vec::new();
    let mut encoder = GzEncoder::new(&mut compressed, Compression::default());
    encoder.write_all(&raw).unwrap();
    encoder.finish().unwrap();
    compressed
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;

    #[test]
    fn test_copy_recursive_copies_files() {
        let src = temp_dir("copy_recursive_src");
        let dst = temp_dir("copy_recursive_dst");

        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("a.md"), "a").unwrap();
        std::fs::write(src.join("subdir").join("b.md"), "b").unwrap();
        std::fs::write(src.join("bundle.toml"), "[package]\nname = \"test\"\n")
            .unwrap();

        copy_recursive(&src, &dst, false).unwrap();
        assert!(dst.join("a.md").exists());
        assert!(dst.join("subdir").join("b.md").exists());
        assert!(dst.join("bundle.toml").exists());
    }

    #[test]
    fn test_copy_recursive_skips_root_bundle_toml() {
        let src = temp_dir("copy_recursive_skip");
        let dst = temp_dir("copy_recursive_skip_dst");

        std::fs::write(src.join("a.md"), "a").unwrap();
        std::fs::write(src.join("bundle.toml"), "[package]\nname = \"test\"\n")
            .unwrap();

        copy_recursive(&src, &dst, true).unwrap();
        assert!(dst.join("a.md").exists());
        assert!(!dst.join("bundle.toml").exists());
    }

    #[test]
    fn test_safe_unpack_rejects_path_traversal() {
        let bytes = raw_tar_gz("../../../etc/passwd", b"hack");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            entries.is_empty(),
            "no files should be extracted from a traversal-only tar"
        );
    }

    #[test]
    fn test_safe_unpack_rejects_absolute_path() {
        let bytes = raw_tar_gz("/tmp/evil.txt", b"bad");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(entries.is_empty(), "absolute-path entries should be skipped");
    }

    #[test]
    fn test_safe_unpack_allows_safe_paths() {
        let bytes = raw_tar_gz("pages/hello.md", b"hello");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let safe_path = dest.path().join("pages/hello.md");
        assert!(safe_path.exists(), "safe relative path should be extracted");
        assert_eq!(
            std::fs::read_to_string(&safe_path).unwrap(),
            "hello",
            "extracted content should match"
        );
    }

    #[test]
    fn test_safe_unpack_rejects_symlink_traversal_target() {
        let bytes = raw_tar_symlink_gz("safe_link.txt", "../escape");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            entries.is_empty(),
            "symlink with traversal target should be skipped"
        );
    }

    #[test]
    fn test_safe_unpack_rejects_symlink_with_absolute_target() {
        let bytes = raw_tar_symlink_gz("safe_link.txt", "/etc/passwd");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dest.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            entries.is_empty(),
            "symlink with absolute target should be skipped"
        );
    }

    #[test]
    fn test_safe_unpack_allows_symlink_with_safe_target() {
        let bytes = raw_tar_gz("safe_link.txt", b"plain file content");

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let safe_path = dest.path().join("safe_link.txt");
        assert!(
            safe_path.exists(),
            "safe non-traversal file should be extracted"
        );
    }

    #[test]
    fn test_safe_unpack_rejects_symlink_attack_chain() {
        let bytes = raw_tar_symlink_and_file_gz(
            "safe_link",
            "../escape",
            "safe_link",
            b"pwned",
        );

        let dest = tempfile::tempdir().unwrap();
        let decoder = GzDecoder::new(bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        safe_unpack(&mut archive, dest.path()).unwrap();

        let safe_path = dest.path().join("safe_link");
        assert!(
            safe_path.exists(),
            "regular file should be extracted after symlink skip"
        );
        assert_eq!(
            std::fs::read_to_string(&safe_path).unwrap(),
            "pwned",
            "regular file content should match"
        );

        let escape_path = dest.path().join("../escape");
        assert!(
            !escape_path.exists(),
            "no file should be created outside dest via symlink"
        );
    }

    #[test]
    fn test_write_tar_gz_returns_err_on_unwritable_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let manifest = "[package]\nname = \"test\"\nversion = \"1.0\"\n\n[export]\ninclude = []\n";

        std::fs::set_permissions(dir.path(), PermissionsExt::from_mode(0o444))
            .unwrap();

        let output_path = dir.path().join("out.tar.gz");
        let result = write_tar_gz(
            &output_path.to_string_lossy(),
            dir.path(),
            manifest,
            &[],
            false,
        );

        let _ = std::fs::set_permissions(
            dir.path(),
            PermissionsExt::from_mode(0o755),
        );

        assert!(
            result.is_err(),
            "write_tar_gz should return Err on unwritable path"
        );
    }

    #[test]
    fn test_export_creates_tar_gz() {
        let dir = temp_dir("export_test");
        let bundle_toml = r#"
[package]
name = "test-export-bundle"
version = "1.0.0"
kind = "upstream"

[export]
include = ["pages/**/*.md"]
"#;
        std::fs::write(dir.join("bundle.toml"), bundle_toml).unwrap();

        std::fs::create_dir_all(dir.join("pages")).unwrap();
        std::fs::write(dir.join("pages").join("hello.md"), "# Hello").unwrap();
        std::fs::write(dir.join("pages").join("world.md"), "# World").unwrap();

        let output_path = dir.join("test-output.tar.gz");
        let manifest_content =
            std::fs::read_to_string(dir.join("bundle.toml")).unwrap();
        let files = collect_export_files(
            &dir,
            &["pages/**/*.md".to_string()],
            &[],
            false,
        )
        .unwrap();
        write_tar_gz(
            &output_path.to_string_lossy(),
            &dir,
            &manifest_content,
            &files,
            false,
        )
        .unwrap();

        assert!(output_path.exists(), "tar.gz should exist at {output_path:?}");

        let file = std::fs::File::open(&output_path).unwrap();
        let decoder = GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let entries: Vec<String> = archive
            .entries()
            .unwrap()
            .filter_map(|e| {
                e.ok().and_then(|e| {
                    e.path().ok().map(|p| p.to_string_lossy().to_string())
                })
            })
            .collect();

        assert!(
            entries.contains(&"bundle.toml".to_string()),
            "archive should contain bundle.toml: {entries:?}"
        );
        assert!(
            entries.contains(&"pages/hello.md".to_string()),
            "archive should contain pages/hello.md: {entries:?}"
        );
        assert!(
            entries.contains(&"pages/world.md".to_string()),
            "archive should contain pages/world.md: {entries:?}"
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }
}
