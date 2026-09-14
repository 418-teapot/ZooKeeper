//! Integration tests for the writability model: write commands require an
//! explicit `--root` pointing at a bundle source, store roots and installed
//! bundle copies reject writes, and `domain create` scaffolds a
//! complete domain.

use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("zwiki-inttest").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp_dir");
    dir
}

/// Mark `dir` as a bundle source by writing a minimal `bundle.toml`.
fn write_bundle_manifest(dir: &Path) {
    std::fs::write(
        dir.join("bundle.toml"),
        "[package]\nname = \"test-wiki\"\nversion = \"0.1.0\"\n\n[export]\ninclude = [\"**/*\"]\n",
    )
    .unwrap();
}

fn zwiki() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_zwiki"))
}

/// Run `zwiki` with `args`; return `(success, stderr)`.
fn run(args: &[&str]) -> (bool, String) {
    let output = Command::new(zwiki()).args(args).output().expect("run zwiki");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

#[test]
fn test_write_commands_require_explicit_root() {
    let write_commands: &[&[&str]] = &[
        &["page", "set", "a.md", "status", "draft"],
        &["page", "unset", "a.md", "status"],
        &[
            "page", "create", "--domain", "d", "--type", "concept", "--title",
            "T",
        ],
        &["page", "move", "a.md", "b.md"],
        &["supersede", "--old", "a.md", "--new", "b.md", "--reason", "r"],
        &["domain", "create", "d"],
        &["contradictions", "apply"],
    ];
    for argv in write_commands {
        let (success, stderr) = run(argv);
        assert!(!success, "write command without --root should fail: {argv:?}");
        assert!(
            stderr.contains("显式"),
            "stderr should require an explicit --root for {argv:?}: {stderr}"
        );
    }
}

#[test]
fn test_read_commands_keep_default_root() {
    // Read commands must not be blocked by the explicit-root requirement.
    // `--help` short-circuits, so use a syntax-level parse check instead:
    // `page show` without --root should fail with a "page not found" style
    // error, NOT the explicit-root error.
    let (success, stderr) = run(&["page", "show", "definitely-missing.md"]);
    assert!(!success, "missing page should fail");
    assert!(
        !stderr.contains("显式"),
        "read command should not require --root: {stderr}"
    );
}

#[test]
fn test_installed_bundle_root_rejects_write_with_bundle_name() {
    let root = temp_dir("bundles_write_gate");
    std::fs::write(root.join("zwiki.lock"), "bundles = []\n").unwrap();
    let bundle = root.join("core");
    std::fs::create_dir_all(bundle.join("concepts")).unwrap();
    write_bundle_manifest(&bundle);
    let bundle_arg = bundle.to_string_lossy().to_string();

    let (success, stderr) = run(&[
        "--root",
        &bundle_arg,
        "page",
        "create",
        "--domain",
        "concepts",
        "--type",
        "concept",
        "--title",
        "T",
    ]);
    assert!(!success, "writing inside an installed bundle should fail");
    assert!(stderr.contains("core"), "error should name the bundle: {stderr}");
    // No file should have been written.
    assert!(!bundle.join("concepts").join("t.md").exists());
}

#[test]
fn test_write_root_without_bundle_toml_rejected() {
    let root = temp_dir("write_no_manifest");
    let root_arg = root.to_string_lossy().to_string();

    let (success, stderr) = run(&[
        "--root",
        &root_arg,
        "page",
        "set",
        "concepts/a.md",
        "status",
        "draft",
    ]);
    assert!(!success, "root without bundle.toml must reject writes");
    assert!(
        stderr.contains("bundle.toml"),
        "error should point at the missing bundle.toml: {stderr}"
    );
}

#[test]
fn test_write_root_with_store_lock_rejected() {
    let root = temp_dir("write_store_lock");
    std::fs::write(root.join("zwiki.lock"), "\n").unwrap();
    let root_arg = root.to_string_lossy().to_string();

    let (success, stderr) = run(&[
        "--root", &root_arg, "page", "create", "--domain", "d", "--type",
        "concept", "--title", "T",
    ]);
    assert!(!success, "store root must reject writes");
    assert!(
        stderr.contains("zwiki.lock"),
        "error should name the store lock: {stderr}"
    );
    assert!(
        !root.join("d").exists(),
        "no domain should be scaffolded in a store"
    );
}

#[test]
fn test_domain_create_scaffolds_full_domain() {
    let root = temp_dir("domain_create");
    write_bundle_manifest(&root);
    let root_arg = root.to_string_lossy().to_string();

    let output = Command::new(zwiki())
        .args(["--root", &root_arg, "domain", "create", "newdomain"])
        .output()
        .expect("run zwiki");
    assert!(
        output.status.success(),
        "domain create should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    for subdir in [
        "concepts",
        "entities",
        "sources/adr",
        "sources/rfc",
        "sources/notes",
        "analysis",
        "syntheses",
    ] {
        assert!(
            root.join("newdomain").join(subdir).join(".gitkeep").exists(),
            "missing {subdir}/.gitkeep"
        );
    }

    let index =
        std::fs::read_to_string(root.join("newdomain").join("index.md"))
            .unwrap();
    assert!(
        index.starts_with("---\ntitle: newdomain\n---"),
        "domain index should have seeded frontmatter:\n{index}"
    );
}

#[test]
fn test_domain_create_registers_root_index_entry() {
    let root = temp_dir("domain_create_root_index");
    write_bundle_manifest(&root);
    // A pre-existing domain with an authored title and description.
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::write(
        root.join("alpha/index.md"),
        "---\ntitle: Alpha Domain\ndescription: first domain\n---\n",
    )
    .unwrap();
    let root_arg = root.to_string_lossy().to_string();

    let output = Command::new(zwiki())
        .args(["--root", &root_arg, "domain", "create", "beta"])
        .output()
        .expect("run zwiki");
    assert!(
        output.status.success(),
        "domain create should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let index = std::fs::read_to_string(root.join("index.md")).unwrap();
    assert!(
        index.contains("- [beta](beta/index.md)"),
        "new domain should be registered in the root index:\n{index}"
    );
    assert!(
        index.contains("- [Alpha Domain](alpha/index.md) — first domain"),
        "existing domain entry preserved with its description:\n{index}"
    );
}

#[test]
fn test_aggregate_root_rejects_page_write_inside_bundle() {
    let root = temp_dir("agg_root_page_gate");
    write_bundle_manifest(&root);
    let bundle = root.join("core");
    std::fs::create_dir_all(&bundle).unwrap();
    write_bundle_manifest(&bundle);
    let bundle_concepts = bundle.join("concepts");
    std::fs::create_dir_all(&bundle_concepts).unwrap();
    let page_path = bundle_concepts.join("page.md");
    let original = "---\ntitle: P\ntype: concept\nstatus: draft\n---\n\n# P\n";
    std::fs::write(&page_path, original).unwrap();
    let root_arg = root.to_string_lossy().to_string();

    // page set on a page inside an installed bundle is rejected.
    let (success, stderr) = run(&[
        "--root",
        &root_arg,
        "page",
        "set",
        "core/concepts/page.md",
        "status",
        "stable",
    ]);
    assert!(!success, "write into a bundle must fail");
    assert!(stderr.contains("core"), "error should name the bundle: {stderr}");
    assert_eq!(
        std::fs::read_to_string(&page_path).unwrap(),
        original,
        "bundle page must be untouched"
    );

    // page move whose new path lands inside a bundle is rejected.
    std::fs::create_dir_all(root.join("notes").join("concepts")).unwrap();
    std::fs::write(
        root.join("notes/concepts/movable.md"),
        "---\ntitle: M\ntype: concept\n---\n\n# M\n",
    )
    .unwrap();
    let (success, stderr) = run(&[
        "--root",
        &root_arg,
        "page",
        "move",
        "notes/concepts/movable.md",
        "core/concepts/moved.md",
    ]);
    assert!(!success, "move into a bundle must fail");
    assert!(stderr.contains("core"), "error should name the bundle: {stderr}");
    assert!(
        root.join("notes/concepts/movable.md").exists(),
        "source page must remain in place"
    );

    // page create whose domain is an installed bundle is rejected.
    let (success, stderr) = run(&[
        "--root", &root_arg, "page", "create", "--domain", "core", "--type",
        "concept", "--title", "T",
    ]);
    assert!(!success, "page create into a bundle domain must fail");
    assert!(stderr.contains("core"), "error should name the bundle: {stderr}");
}

#[test]
fn test_domain_create_rejects_reserved_logs() {
    let root = temp_dir("domain_create_logs_reserved");
    write_bundle_manifest(&root);
    let root_arg = root.to_string_lossy().to_string();

    let output = Command::new(zwiki())
        .args(["--root", &root_arg, "domain", "create", "logs"])
        .output()
        .expect("run zwiki");
    assert!(!output.status.success(), "domain create logs should be rejected");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("系统目录") || stderr.contains("无效的领域名"),
        "error should name the reserved directory: {stderr}"
    );
    assert!(
        !root.join("logs").join("index.md").exists(),
        "no logs/ domain should be scaffolded"
    );
}

#[test]
fn test_bundle_install_places_content_directly_in_store() {
    let store = temp_dir("bundle_install_store");
    let src = temp_dir("bundle_install_source");

    std::fs::write(
        src.join("bundle.toml"),
        "[package]\nname = \"test-install-bundle\"\nversion = \"1.0.0\"\n\n[export]\ninclude = [\"**/*\"]\n",
    )
    .unwrap();
    let doc = "---\ntitle: Doc\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Doc Content\n\nThis document has enough text to pass the health and lint checks that zwiki runs during bundle installation. It contains well over one hundred characters.\n";
    std::fs::write(
        src.join("index.md"),
        "---\ntitle: Index\ntype: concept\ntimestamp: 2026-07-01T00:00:00Z\ntags: []\nstatus: draft\nlast_validated: 2026-07-01T00:00:00Z\ntimeliness: current\n---\n\n# Index\n\n- [Doc](doc.md)\n",
    )
    .unwrap();
    std::fs::write(src.join("doc.md"), doc).unwrap();
    std::fs::create_dir_all(src.join("logs")).unwrap();
    std::fs::write(src.join("logs/.gitkeep"), "").unwrap();

    let output = Command::new(zwiki())
        .args([
            "--root",
            &store.to_string_lossy(),
            "bundle",
            "install",
            &src.to_string_lossy(),
        ])
        .output()
        .expect("run zwiki bundle install");
    assert!(
        output.status.success(),
        "bundle install should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let installed = store.join("test-install-bundle");
    assert!(
        installed.join("doc.md").is_file(),
        "content should install under <store>/<name>/"
    );

    let lock_content =
        std::fs::read_to_string(store.join("zwiki.lock")).unwrap();
    assert!(
        lock_content.contains("target = \"test-install-bundle/\""),
        "lock target should be the bundle directory: {lock_content}"
    );

    // The store root SCHEMA.md is materialized on install and matches the
    // running binary's embedded copy.
    let schema_path = store.join("SCHEMA.md");
    assert!(schema_path.is_file(), "install should write <store>/SCHEMA.md");
    let schema = std::fs::read_to_string(&schema_path).unwrap();
    let schema_cmd =
        Command::new(zwiki()).args(["schema"]).output().expect("run zwiki");
    assert!(schema_cmd.status.success());
    assert_eq!(
        schema,
        String::from_utf8_lossy(&schema_cmd.stdout),
        "store SCHEMA.md should match `zwiki schema` output"
    );
}
