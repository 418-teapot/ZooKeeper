//! Bundle export — `zwiki bundle export`.

use std::path::Path;

use crate::bundle::args::ExportArgs;
use crate::bundle::tar;
use crate::bundle::{read_manifest, report_manifest_errors};

/// Export a bundle directory into a `.tar.gz` archive.
pub fn cmd_export(args: &ExportArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if let Err(msg) = cmd_export_inner(args, use_json) {
        if !use_json {
            eprintln!("错误: {msg}");
        }
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_export` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
pub fn cmd_export_inner(
    args: &ExportArgs,
    use_json: bool,
) -> Result<(), String> {
    let bundle_dir = Path::new(&args.dir);

    let manifest_path = bundle_dir.join("bundle.toml");
    let (manifest_content, manifest) = read_manifest(&manifest_path, use_json)?;

    let errors = manifest.validate(use_json);
    if report_manifest_errors(&errors, use_json) {
        return Err("bundle.toml 验证失败".to_string());
    }

    let files = tar::collect_export_files(
        bundle_dir,
        &manifest.export.include,
        &manifest.export.exclude,
        use_json,
    )?;

    let safe_name =
        zutil::fileio::sanitize_path_component(&manifest.package.name);
    let safe_version =
        zutil::fileio::sanitize_path_component(&manifest.package.version);
    let output_path = args
        .output
        .clone()
        .unwrap_or_else(|| format!("{safe_name}-{safe_version}.tar.gz"));

    tar::write_tar_gz(
        &output_path,
        bundle_dir,
        &manifest_content,
        &files,
        use_json,
    )
    .map_err(|e| format!("无法写入 tar.gz: {e}"))?;

    if use_json {
        let output = serde_json::json!({
            "status": "ok",
            "output": output_path,
            "files": files.len(),
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        eprintln!("已导出: {output_path}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::bundle::args::ExportArgs;

    #[test]
    fn test_export_arg_fields() {
        let args = ExportArgs {
            dir: "/some/dir".to_string(),
            output: Some("bundle.tar.gz".to_string()),
            json: false,
        };
        assert_eq!(args.dir, "/some/dir");
        assert_eq!(args.output, Some("bundle.tar.gz".to_string()));
        assert!(!args.json);
    }
}
