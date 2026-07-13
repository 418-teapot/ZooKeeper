//! Bundle init — `zwiki bundle init`.

use std::path::Path;

use crate::bundle::args::InitArgs;
use crate::bundle::manifest;
use crate::bundle::report_manifest_errors;

/// Derive a bundle name from the current working directory basename.
pub fn derive_name() -> String {
    std::env::current_dir()
        .ok()
        .as_deref()
        .and_then(Path::file_name)
        .map_or_else(
            || "bundle".to_string(),
            // to_string_lossy replaces non-UTF-8 bytes with U+FFFD — acceptable for display
            |n| n.to_string_lossy().to_string(),
        )
}

/// Initialize a new bundle manifest with defaults and CLI-provided values.
pub fn cmd_init(args: &InitArgs, global_json: bool) {
    let use_json = args.json || global_json;
    if let Err(msg) = cmd_init_inner(args, use_json) {
        eprintln!("{msg}");
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_init` that returns `Result` instead of
/// calling `process::exit`.  This makes the logic testable.
pub fn cmd_init_inner(args: &InitArgs, use_json: bool) -> Result<(), String> {
    let resolved_name =
        args.name.clone().map_or_else(derive_name, String::from);

    let manifest = manifest::BundleManifest {
        package: manifest::PackageSection {
            name: resolved_name,
            version: args.version.clone(),
            okf_version: args.okf_version.clone(),
            kind: args.kind.clone(),
            team: args.team.clone(),
            registry: args.registry.clone(),
            description: args.description.clone(),
        },
        export: manifest::ExportSection {
            include: if args.include.is_empty() {
                vec!["**/*".to_string()]
            } else {
                args.include.clone()
            },
            exclude: args.exclude.clone(),
        },
    };

    // Validate before output.
    let errors = manifest.validate(use_json);
    if report_manifest_errors(&errors, use_json) {
        return Err("bundle.toml 验证失败".to_string());
    }

    let serialized = if use_json {
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("JSON 序列化失败: {e}"))?
    } else {
        toml::to_string_pretty(&manifest)
            .map_err(|e| format!("TOML 序列化失败: {e}"))?
    };

    if let Some(ref path) = args.output {
        zutil::fileio::write_atomic(Path::new(path), &serialized)
            .map_err(|e| format!("写入文件失败: {e}"))?;
        eprintln!("已生成 bundle.toml 模板");
    } else {
        println!("{serialized}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::args::InitArgs;

    #[test]
    fn test_derive_name_fallback() {
        let name = derive_name();
        assert!(!name.is_empty());
    }

    #[test]
    fn test_cmd_init_inner_rejects_empty_name() {
        let args = InitArgs {
            name: Some(String::new()),
            version: "0.1.0".to_string(),
            kind: "upstream".to_string(),
            okf_version: "0.1".to_string(),
            team: None,
            registry: None,
            description: None,
            include: vec!["*.md".to_string()],
            exclude: Vec::new(),
            output: None,
            json: false,
        };
        let result = cmd_init_inner(&args, false);
        assert!(result.is_err(), "empty name should return Err");
    }
}
