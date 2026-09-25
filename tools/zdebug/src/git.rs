//! Git working-tree snapshots for Case baselines and finals.
//!
//! A snapshot records the current commit, branch, porcelain status, and
//! content hashes of the staged and unstaged diffs. Working trees that are
//! not inside a Git repository degrade to a directory descriptor
//! (`{"path": ..., "kind": "directory"}`) instead of failing.
//!
//! Git is invoked through a subprocess; no native binding is used.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Map, Value, json};

use crate::util::{resolve_path, sha256_bytes, to_posix};

/// `git submodule status` markers that denote a modified working tree.
const DIRTY_SUBMODULE_MARKERS: [char; 2] = ['+', 'U'];

// ── Snapshot ─────────────────────────────────────────────────────────────────

/// Capture a snapshot of `workspace`, excluding `exclude_paths` from the
/// dirty check.
///
/// `exclude_paths` are resolved and, when they fall inside the repository
/// root, added as Git pathspec exclusions. This lets the caller keep its
/// own state directory (for example `.zoo/debug/`) out of the dirty
/// determination.
#[must_use]
pub fn capture_snapshot(workspace: &Path, exclude_paths: &[PathBuf]) -> Value {
    let workspace = resolve_path(workspace);
    let (inside, inside_out) =
        run_git(&workspace, &["rev-parse", "--is-inside-work-tree"]);
    if !inside || stdout_text(&inside_out).trim() != "true" {
        return json!({
            "path": workspace.to_string_lossy(),
            "kind": "directory",
        });
    }

    let (_, top_out) = run_git(&workspace, &["rev-parse", "--show-toplevel"]);
    let top = stdout_text(&top_out).trim().to_owned();
    let top_path = PathBuf::from(&top);

    let head_proc = run_git(&workspace, &["rev-parse", "HEAD"]);
    let head = head_proc.0.then(|| stdout_text(&head_proc.1).trim().to_owned());
    let branch_proc =
        run_git(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let branch =
        branch_proc.0.then(|| stdout_text(&branch_proc.1).trim().to_owned());

    let pathspec = build_pathspec(&top_path, exclude_paths);

    let status = git_status(&workspace, &pathspec);
    let staged = git_diff(&workspace, &pathspec, true);
    let unstaged = git_diff(&workspace, &pathspec, false);

    let mut combined = staged.clone();
    combined.push(0);
    combined.extend_from_slice(&unstaged);

    let submodule_proc =
        run_git(&workspace, &["submodule", "status", "--recursive"]);
    let submodules = if submodule_proc.0 {
        parse_submodules(&workspace, &submodule_proc.1)
    } else {
        Map::new()
    };

    json!({
        "path": workspace.to_string_lossy(),
        "kind": "git",
        "git": {
            "root": top,
            "head": head,
            "branch": branch,
            "detached": branch.is_none(),
            "status": status,
            "dirty": !status.is_empty(),
            "staged_diff_sha256": sha256_bytes(&staged),
            "unstaged_diff_sha256": sha256_bytes(&unstaged),
            "diff_sha256": sha256_bytes(&combined),
            "submodules": Value::Object(submodules),
        },
    })
}

// ── Git helpers ──────────────────────────────────────────────────────────────

/// Run `git -C workspace <args>`, returning success and raw stdout bytes.
fn run_git(workspace: &Path, args: &[&str]) -> (bool, Vec<u8>) {
    Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .map_or((false, Vec::new()), |output| {
            (output.status.success(), output.stdout)
        })
}

/// Decode raw Git stdout, tolerating invalid UTF-8.
fn stdout_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Build the pathspec limiting Git's dirty check to `workspace`, with the
/// resolved excludes appended.
fn build_pathspec(top: &Path, exclude_paths: &[PathBuf]) -> Vec<String> {
    let mut pathspec = vec![".".to_owned()];
    for excluded in exclude_paths {
        let resolved = resolve_path(excluded);
        if let Ok(relative) = resolved.strip_prefix(top) {
            pathspec.push(format!(":(exclude){}", to_posix(relative)));
        }
    }
    pathspec
}

/// Append a pathspec to a Git argument list.
fn with_pathspec<'a>(
    base: &'a [&'a str],
    pathspec: &'a [String],
) -> Vec<&'a str> {
    let mut args: Vec<&str> = base.to_vec();
    args.extend(pathspec.iter().map(String::as_str));
    args
}

/// Return the porcelain status lines for the pathspec.
fn git_status(workspace: &Path, pathspec: &[String]) -> Vec<String> {
    let args = with_pathspec(
        &["status", "--porcelain=v1", "--untracked-files=all", "--"],
        pathspec,
    );
    let (_, out) = run_git(workspace, &args);
    stdout_text(&out)
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Return the raw diff bytes for the staged (`cached`) or unstaged tree.
fn git_diff(workspace: &Path, pathspec: &[String], cached: bool) -> Vec<u8> {
    let mut base = vec!["diff"];
    if cached {
        base.push("--cached");
    }
    base.extend(["--binary", "--no-ext-diff", "--"]);
    let args = with_pathspec(&base, pathspec);
    run_git(workspace, &args).1
}

/// Parse `git submodule status` output into a map keyed by submodule path.
fn parse_submodules(workspace: &Path, output: &[u8]) -> Map<String, Value> {
    let mut submodules = Map::new();
    for line in stdout_text(output).lines() {
        let Some(marker) = line.chars().next() else {
            continue;
        };
        let fields: Vec<&str> =
            line.get(1..).unwrap_or_default().split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        let actual_head = fields[0].to_owned();
        let relative = fields[1].to_owned();
        let (_, tree_out) =
            run_git(workspace, &["ls-tree", "HEAD", "--", &relative]);
        let tree_text = stdout_text(&tree_out);
        let tree_fields: Vec<&str> = tree_text.split_whitespace().collect();
        let gitlink = tree_fields.get(2).map(|value| (*value).to_owned());
        submodules.insert(
            relative,
            json!({
                "head": actual_head,
                "gitlink": gitlink,
                "state": marker.to_string(),
                "dirty": DIRTY_SUBMODULE_MARKERS.contains(&marker),
            }),
        );
    }
    submodules
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Serialize tests that spawn Git children.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_guard()
    }

    #[test]
    fn test_non_git_directory_degrades() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        let snapshot = capture_snapshot(dir.path(), &[]);
        assert_eq!(snapshot["kind"], "directory");
        assert!(snapshot.get("git").is_none());
        assert!(snapshot["path"].is_string());
    }

    #[test]
    fn test_git_snapshot_clean_repo() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let snapshot = capture_snapshot(dir.path(), &[]);
        assert_eq!(snapshot["kind"], "git");
        assert!(snapshot["git"]["head"].is_string());
        assert!(snapshot["git"]["branch"].is_string());
        assert_eq!(snapshot["git"]["detached"], false);
        assert_eq!(snapshot["git"]["dirty"], false);
        assert_eq!(snapshot["git"]["status"], json!([]));
    }

    #[test]
    fn test_git_snapshot_detects_untracked_file() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("new.txt"), "data").unwrap();
        let snapshot = capture_snapshot(dir.path(), &[]);
        assert_eq!(snapshot["git"]["dirty"], true);
        assert!(
            snapshot["git"]["status"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line.as_str().unwrap().contains("new.txt"))
        );
    }

    #[test]
    fn test_exclude_path_ignores_state_directory() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let state = dir.path().join(".zoo/debug");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("event.jsonl"), "{}\n").unwrap();

        let included = capture_snapshot(dir.path(), &[]);
        assert_eq!(included["git"]["dirty"], true);

        let excluded = capture_snapshot(dir.path(), &[state]);
        assert_eq!(excluded["git"]["dirty"], false);
        assert_eq!(excluded["git"]["status"], json!([]));
    }

    #[test]
    fn test_git_snapshot_detects_staged_changes() {
        let _guard = guard();
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("tracked.txt"), "changed").unwrap();
        git(dir.path(), &["add", "tracked.txt"]);
        let snapshot = capture_snapshot(dir.path(), &[]);
        assert_eq!(snapshot["git"]["dirty"], true);
        assert_ne!(snapshot["git"]["staged_diff_sha256"], sha256_bytes(b""));
    }

    /// Initialize a Git repository with one commit at `dir`.
    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        fs::write(dir.join("README.md"), "initial\n").unwrap();
        git(dir, &["add", "README.md"]);
        git(dir, &["commit", "-qm", "init"]);
    }

    /// Run a Git command in `dir`, asserting success.
    fn git(dir: &Path, args: &[&str]) {
        let status =
            Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }
}
