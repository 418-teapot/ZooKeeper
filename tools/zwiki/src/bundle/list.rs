//! Bundle list — `zwiki bundle list`.

use std::fmt::Write;
use std::path::Path;

use crate::bundle::args::ListArgs;
use crate::bundle::lock;

/// Format the bundle lock contents as a human-readable table.
#[must_use]
fn format_bundle_table(lock: &lock::ZwikiLock) -> String {
    if lock.bundles.is_empty() {
        return String::new();
    }

    let header_name = "NAME";
    let header_version = "VERSION";
    let header_target = "TARGET";
    let header_installed = "INSTALLED";

    let max_name = lock
        .bundles
        .iter()
        .map(|b| b.name.len())
        .max()
        .unwrap_or(0)
        .max(header_name.len());
    let max_version = lock
        .bundles
        .iter()
        .map(|b| b.version.len())
        .max()
        .unwrap_or(0)
        .max(header_version.len());
    let max_target = lock
        .bundles
        .iter()
        .map(|b| b.target.len())
        .max()
        .unwrap_or(0)
        .max(header_target.len());

    let mut out = String::new();

    writeln!(
        out,
        " {header_name:<max_name$}  {header_version:<max_version$}  {header_target:<max_target$}  {header_installed}",
    )
    .expect("write to string");
    writeln!(
        out,
        " {:-<width_name$}  {:-<width_ver$}  {:-<width_tgt$}  {:-<10}",
        "",
        "",
        "",
        "",
        width_name = max_name,
        width_ver = max_version,
        width_tgt = max_target,
    )
    .expect("write to string");

    for entry in &lock.bundles {
        let date = zutil::ts_display(&entry.installed_at);
        writeln!(
            out,
            " {:<width_name$}  {:<width_ver$}  {:<width_tgt$}  {}",
            entry.name,
            entry.version,
            entry.target,
            date,
            width_name = max_name,
            width_ver = max_version,
            width_tgt = max_target,
        )
        .expect("write to string");
    }

    out
}

/// List installed bundles from the lock file.
pub fn cmd_list_installed(
    args: &ListArgs,
    global_json: bool,
    wiki_root: &Path,
) {
    let use_json = args.json || global_json;
    if let Err(msg) = cmd_list_installed_inner(args, use_json, wiki_root) {
        if !use_json {
            eprintln!("错误: {msg}");
        }
        std::process::exit(1);
    }
}

/// Inner implementation of `cmd_list_installed` that returns `Result` instead
/// of calling `process::exit`.  This makes the logic testable.
pub fn cmd_list_installed_inner(
    _args: &ListArgs,
    use_json: bool,
    wiki_root: &Path,
) -> Result<(), String> {
    let l = lock::read_lock_at(wiki_root)?;

    if l.bundles.is_empty() {
        if use_json {
            println!("[]");
        } else {
            println!("没有已安装的 bundle");
        }
        return Ok(());
    }

    if use_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&l)
                .map_err(|e| format!("JSON 序列化失败: {e}"))?
        );
        return Ok(());
    }

    print!("{}", format_bundle_table(&l));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::lock;

    #[test]
    fn test_list_empty_lock_reads_gracefully() {
        let lock = lock::ZwikiLock::default();
        let formatted = format_bundle_table(&lock);
        assert!(formatted.is_empty());
    }

    #[test]
    fn test_format_bundle_table_with_entries() {
        let entries = vec![
            lock::ZwikiLockEntry {
                name: "test-bundle".to_string(),
                version: "1.0.0".to_string(),
                registry: String::new(),
                target: ".upstream/test-bundle/".to_string(),
                integrity: "sha256-abc".to_string(),
                installed_at: "2026-07-05T12:00:00Z".to_string(),
                description: None,
            },
            lock::ZwikiLockEntry {
                name: "another-pkg".to_string(),
                version: "2.1.0".to_string(),
                registry: String::new(),
                target: ".teams/my-team/".to_string(),
                integrity: "sha256-def".to_string(),
                installed_at: "2026-06-01T00:00:00Z".to_string(),
                description: None,
            },
        ];
        let lock = lock::ZwikiLock { bundles: entries, ..Default::default() };
        let table = format_bundle_table(&lock);
        assert!(table.contains("test-bundle"));
        assert!(table.contains("another-pkg"));
        assert!(table.contains("1.0.0"));
        assert!(table.contains("2.1.0"));
        assert!(table.contains("NAME"));
        assert!(table.contains("VERSION"));
        assert!(table.contains("TARGET"));
        assert!(table.contains("INSTALLED"));
        assert!(table.lines().count() >= 4);
    }

    #[test]
    fn test_format_bundle_table_empty() {
        let lock = lock::ZwikiLock::default();
        let table = format_bundle_table(&lock);
        assert!(table.is_empty());
    }
}
