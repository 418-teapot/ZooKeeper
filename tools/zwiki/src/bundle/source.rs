//! Source resolution — resolve bundle source (URL, tar.gz, or local directory)
//! to a directory containing `bundle.toml`.

use std::path::{Component, Path};

use tempfile::TempDir;

use crate::bundle::http;

/// Resolve a bundle source (URL, tar.gz, or local directory) to a directory
/// containing `bundle.toml`.
///
/// Returns a `TempDir` that is cleaned up when the returned value is dropped.
pub fn resolve_source(source: &str, use_json: bool) -> Result<TempDir, ()> {
    // URL source
    if source.starts_with("http://") || source.starts_with("https://") {
        return resolve_url_source(source, use_json);
    }

    // Local tar.gz file
    let source_lower = source.to_lowercase();
    if source_lower.ends_with(".tar.gz")
        || Path::new(source)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tgz"))
    {
        return resolve_tar_source(Path::new(source), use_json);
    }

    // Local directory
    let dir = Path::new(source);
    if dir.is_dir() {
        let tmp = match TempDir::new() {
            Ok(t) => t,
            Err(e) => {
                eprintln!(
                    "{}",
                    if use_json {
                        format!("cannot create temp directory: {e}")
                    } else {
                        format!("无法创建临时目录: {e}")
                    }
                );
                return Err(());
            }
        };

        if let Err(e) =
            crate::bundle::tar::copy_recursive(dir, tmp.path(), false)
        {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot copy source directory: {e}")
                } else {
                    format!("无法复制源目录: {e}")
                }
            );
            return Err(());
        }

        return Ok(tmp);
    }

    let msg = if use_json {
        format!("source '{source}' is not a file, directory or URL")
    } else {
        format!("源 '{source}' 不是文件、目录或 URL")
    };
    if use_json {
        let output = serde_json::json!({
            "status": "fatal",
            "error": msg,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        eprintln!("{msg}");
    }
    Err(())
}

/// Download individual files from a directory URL based on manifest include
/// patterns.
fn download_manifest_files(
    url: &str,
    tmp_path: &Path,
    include: &[String],
    use_json: bool,
) -> Result<(), ()> {
    for pattern in include {
        // Skip glob patterns — we can only download specific files
        if pattern.contains('*')
            || pattern.contains('?')
            || pattern.contains('[')
        {
            eprintln!(
                "{}",
                if use_json {
                    format!(
                        "cannot download files matching glob pattern '{pattern}' from directory URL"
                    )
                } else {
                    format!(
                        "无法从目录 URL 下载匹配 glob 模式 '{pattern}' 的文件"
                    )
                }
            );
            return Err(());
        }

        // Reject path traversal in include patterns
        let pattern_path = Path::new(pattern);
        if pattern_path.is_absolute()
            || pattern_path.components().any(|c| c == Component::ParentDir)
        {
            eprintln!(
                "{}",
                if use_json {
                    format!("warning: skipping out-of-bounds path '{pattern}'")
                } else {
                    format!("警告: 跳过越界路径: {pattern}")
                }
            );
            continue;
        }

        // Download individual file
        let file_url = format!("{}/{}", url.trim_end_matches('/'), pattern);
        let file_resp = http::http_client().get(&file_url).send();
        if let Ok(resp) = file_resp {
            if resp.status().is_success() {
                if let Some(cl) = resp.content_length()
                    && cl > http::MAX_BUNDLE_SIZE
                {
                    eprintln!(
                        "{}",
                        if use_json {
                            format!(
                                "response too large for '{file_url}': {cl} bytes (max {})",
                                http::MAX_BUNDLE_SIZE
                            )
                        } else {
                            format!(
                                "响应过大 '{file_url}': {cl} 字节 (最大 {})",
                                http::MAX_BUNDLE_SIZE
                            )
                        }
                    );
                    return Err(());
                }
                if let Ok(bytes) = http::read_body_capped(resp) {
                    let target_path = tmp_path.join(pattern);
                    if let Some(parent) = target_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&target_path, &bytes);
                }
            } else {
                eprintln!(
                    "{}",
                    if use_json {
                        format!(
                            "cannot fetch '{}' (status {})",
                            file_url,
                            resp.status()
                        )
                    } else {
                        format!(
                            "无法获取 '{}' (状态 {})",
                            file_url,
                            resp.status()
                        )
                    }
                );
                return Err(());
            }
        } else {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot fetch '{file_url}'")
                } else {
                    format!("无法获取 '{file_url}'")
                }
            );
            return Err(());
        }
    }
    Ok(())
}

/// Download a bundle directory from a URL (non-tar.gz path).
///
/// Fetches `bundle.toml` and the individual files listed in the manifest,
/// writing them into the given temporary directory.
fn download_dir_from_url(
    url: &str,
    tmp_path: &Path,
    use_json: bool,
) -> Result<(), ()> {
    let bundle_url = format!("{}/bundle.toml", url.trim_end_matches('/'));
    let bundle_resp = match http::http_client().get(&bundle_url).send() {
        Ok(resp) => resp,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot fetch '{bundle_url}': {e}")
                } else {
                    format!("无法访问 '{bundle_url}': {e}")
                }
            );
            return Err(());
        }
    };

    if !bundle_resp.status().is_success() {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "cannot find bundle.toml at '{}' (status {})",
                    bundle_url,
                    bundle_resp.status()
                )
            } else {
                format!(
                    "在 '{}' 未找到 bundle.toml (状态 {})",
                    bundle_url,
                    bundle_resp.status()
                )
            }
        );
        return Err(());
    }

    if let Some(cl) = bundle_resp.content_length()
        && cl > http::MAX_BUNDLE_SIZE
    {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "response too large for '{bundle_url}': {cl} bytes (max {})",
                    http::MAX_BUNDLE_SIZE
                )
            } else {
                format!("响应过大: {cl} 字节 (最大 {})", http::MAX_BUNDLE_SIZE)
            }
        );
        return Err(());
    }

    let bundle_content = match http::read_body_capped_string(bundle_resp) {
        Ok(content) => content,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot read bundle.toml: {e}")
                } else {
                    format!("无法读取 bundle.toml: {e}")
                }
            );
            return Err(());
        }
    };

    let btoml_path = tmp_path.join("bundle.toml");
    if let Err(e) = std::fs::write(&btoml_path, &bundle_content) {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot write bundle.toml: {e}")
            } else {
                format!("无法写入 bundle.toml: {e}")
            }
        );
        return Err(());
    }

    if let Ok(manifest) = toml::from_str::<
        crate::bundle::manifest::BundleManifest,
    >(&bundle_content)
    {
        download_manifest_files(
            url,
            tmp_path,
            &manifest.export.include,
            use_json,
        )?;
    }

    Ok(())
}

/// Resolve a URL source by downloading bundle content.
fn resolve_url_source(url: &str, use_json: bool) -> Result<TempDir, ()> {
    let tmp = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot create temp directory: {e}")
                } else {
                    format!("无法创建临时目录: {e}")
                }
            );
            return Err(());
        }
    };

    let url_lower = url.to_lowercase();
    let is_tar = url_lower.ends_with(".tar.gz")
        || Path::new(url)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tgz"));

    let response = match http::http_client().get(url).send() {
        Ok(resp) => resp,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot fetch URL '{url}': {e}")
                } else {
                    format!("无法访问 URL '{url}': {e}")
                }
            );
            return Err(());
        }
    };

    if !response.status().is_success() {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "fetching '{}' returned status {}",
                    url,
                    response.status()
                )
            } else {
                format!("访问 '{}' 返回状态 {}", url, response.status())
            }
        );
        return Err(());
    }

    if is_tar {
        extract_tar_response(response, tmp.path(), use_json)?;
    } else {
        download_dir_from_url(url, tmp.path(), use_json)?;
    }

    Ok(tmp)
}

/// Extract a tar.gz response into a temp directory.
fn extract_tar_response(
    response: reqwest::blocking::Response,
    tmp: &Path,
    use_json: bool,
) -> Result<(), ()> {
    if let Some(cl) = response.content_length()
        && cl > http::MAX_BUNDLE_SIZE
    {
        eprintln!(
            "{}",
            if use_json {
                format!(
                    "response too large: {cl} bytes (max {})",
                    http::MAX_BUNDLE_SIZE
                )
            } else {
                format!("响应过大: {cl} 字节 (最大 {})", http::MAX_BUNDLE_SIZE)
            }
        );
        return Err(());
    }
    let bytes = match http::read_body_capped(response) {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot read response body: {e}")
                } else {
                    format!("无法读取响应内容: {e}")
                }
            );
            return Err(());
        }
    };

    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    if let Err(e) = crate::bundle::tar::safe_unpack(&mut archive, tmp) {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot extract tar.gz: {e}")
            } else {
                format!("无法解压 tar.gz: {e}")
            }
        );
        return Err(());
    }
    Ok(())
}

/// Resolve a local tar.gz file by extracting to a temp directory.
fn resolve_tar_source(tar_path: &Path, use_json: bool) -> Result<TempDir, ()> {
    let tmp = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot create temp directory: {e}")
                } else {
                    format!("无法创建临时目录: {e}")
                }
            );
            return Err(());
        }
    };

    let file = match std::fs::File::open(tar_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "{}",
                if use_json {
                    format!("cannot open '{}': {e}", tar_path.display())
                } else {
                    format!("无法打开 '{}': {e}", tar_path.display())
                }
            );
            return Err(());
        }
    };

    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    if let Err(e) = crate::bundle::tar::safe_unpack(&mut archive, tmp.path()) {
        eprintln!(
            "{}",
            if use_json {
                format!("cannot extract '{}': {e}", tar_path.display())
            } else {
                format!("无法解压 '{}': {e}", tar_path.display())
            }
        );
        return Err(());
    }

    Ok(tmp)
}

/// Determine the wiki-relative install target path from the manifest.
pub fn resolve_target_rel(
    manifest: &crate::bundle::manifest::BundleManifest,
    use_json: bool,
) -> Result<String, ()> {
    let kind = manifest.package.kind.trim().to_lowercase();
    match kind.as_str() {
        "upstream" => Ok(format!(".upstream/{}/", manifest.package.name)),
        "org" => Ok(format!(".org/{}/", manifest.package.name)),
        "team" => {
            let team = manifest.package.team.as_deref().unwrap_or_default();
            if team.is_empty() {
                eprintln!(
                    "{}",
                    if use_json {
                        "team bundles require a 'team' field".to_string()
                    } else {
                        "团队 bundle 需要指定 team 字段".to_string()
                    }
                );
                return Err(());
            }
            Ok(format!(".teams/{team}/"))
        }
        _ => {
            eprintln!(
                "{}",
                if use_json {
                    format!("unknown kind '{kind}'")
                } else {
                    format!("未知的 kind 值 '{kind}'")
                }
            );
            Err(())
        }
    }
}

/// Check that a bundle directory has the required wiki structure.
///
/// A valid bundle MUST contain `index.md` (a file) and `logs` (a directory).
/// Missing either is a fatal error — prints a Chinese error message (and
/// JSON when `use_json` is true) and returns `Err`.  The caller is
/// responsible for exiting; this lets the caller's `TempDir` drop normally,
/// avoiding a temp-dir leak on the error path.
pub fn check_bundle_structure(
    source_dir: &Path,
    use_json: bool,
) -> Result<(), ()> {
    let index_path = source_dir.join("index.md");
    let logs_path = source_dir.join("logs");

    if !index_path.exists() || !index_path.is_file() {
        if use_json {
            let output = serde_json::json!({
                "status": "fatal",
                "error": "bundle 缺少 index.md"
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            eprintln!("错误: bundle 缺少 index.md");
        }
        return Err(());
    }

    if !logs_path.exists() || !logs_path.is_dir() {
        if use_json {
            let output = serde_json::json!({
                "status": "fatal",
                "error": "bundle 缺少 logs 目录"
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            eprintln!("错误: bundle 缺少 logs 目录");
        }
        return Err(());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::manifest::BundleManifest;
    use crate::bundle::manifest::ExportSection;
    use crate::bundle::manifest::PackageSection;
    use std::path::PathBuf;

    fn valid_manifest() -> BundleManifest {
        BundleManifest {
            package: PackageSection {
                name: "test-bundle".to_string(),
                version: "0.1.0".to_string(),
                okf_version: "0.1".to_string(),
                kind: "upstream".to_string(),
                team: None,
                registry: None,
                description: None,
            },
            export: ExportSection {
                include: vec!["pages/**/*.md".to_string()],
                exclude: Vec::new(),
            },
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zwiki-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    #[test]
    fn test_resolve_target_upstream() {
        let m = valid_manifest();
        let target = resolve_target_rel(&m, false);
        assert_eq!(target.unwrap(), ".upstream/test-bundle/");
    }

    #[test]
    fn test_resolve_target_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = Some("my-team".to_string());
        let target = resolve_target_rel(&m, false);
        assert_eq!(target.unwrap(), ".teams/my-team/");
    }

    #[test]
    fn test_resolve_target_org() {
        let mut m = valid_manifest();
        m.package.kind = "org".to_string();
        m.package.name = "my-org-bundle".to_string();
        let target = resolve_target_rel(&m, false);
        assert_eq!(target.unwrap(), ".org/my-org-bundle/");
    }

    #[test]
    fn test_resolve_url_source_rejects_oversized_response() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let oversized = http::MAX_BUNDLE_SIZE + 1;
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Length: {oversized}\r\n\
                     Content-Type: application/gzip\r\n\
                     Connection: close\r\n\
                     \r\n"
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });

        let url = format!("http://127.0.0.1:{port}/test.tar.gz");
        let result = resolve_url_source(&url, false);
        assert!(
            result.is_err(),
            "resolve_url_source should reject oversized response"
        );

        server.join().unwrap();
    }

    #[test]
    fn test_manifest_path_traversal_is_detected() {
        let bad_patterns =
            ["../../../etc/passwd", "../escape.md", "/tmp/absolute.md"];
        for pattern in &bad_patterns {
            let path = Path::new(pattern);
            assert!(
                path.is_absolute()
                    || path.components().any(|c| c == Component::ParentDir),
                "pattern '{pattern}' should be detected as traversal"
            );
        }
        let safe_patterns =
            ["pages/hello.md", "data/file.txt", "sub/deep/path.md"];
        for pattern in &safe_patterns {
            let path = Path::new(pattern);
            assert!(
                !path.is_absolute()
                    && !path.components().any(|c| c == Component::ParentDir),
                "pattern '{pattern}' should be allowed"
            );
        }
    }

    #[test]
    fn test_temp_dir_creates_and_cleans() {
        let path = {
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().to_path_buf();
            assert!(p.exists(), "temp dir should exist");
            p
        };
        assert!(!path.exists(), "temp dir should be cleaned up");
    }

    #[test]
    fn test_install_from_tar_gz() {
        let src_dir = temp_dir("install_tar_src");
        let bundle_toml = r#"
[package]
name = "test-install-bundle"
version = "2.0.0"
kind = "upstream"

[export]
include = ["*.md"]
"#;
        std::fs::write(src_dir.join("bundle.toml"), bundle_toml).unwrap();
        std::fs::write(src_dir.join("doc.md"), "# Doc").unwrap();

        let tar_path = src_dir.join("bundle.tar.gz");
        let manifest_content =
            std::fs::read_to_string(src_dir.join("bundle.toml")).unwrap();
        let files = crate::bundle::tar::collect_export_files(
            &src_dir,
            &["*.md".to_string()],
            &[],
            false,
        )
        .unwrap();
        crate::bundle::tar::write_tar_gz(
            &tar_path.to_string_lossy(),
            &src_dir,
            &manifest_content,
            &files,
            false,
        )
        .unwrap();

        let tmp = resolve_tar_source(&tar_path, false).unwrap();
        assert!(tmp.path().join("bundle.toml").exists());
        assert!(tmp.path().join("doc.md").exists());
        assert!(!tmp.path().join("pages").exists());
    }
}
