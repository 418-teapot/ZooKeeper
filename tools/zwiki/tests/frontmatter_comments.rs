//! End-to-end contract for frontmatter comments.
//!
//! `template` and `page create` must hand a page its lifecycle guidance, and
//! every command that writes a page afterwards must keep the comment lines
//! where the page puts them: `page set`, `supersede` and `check`.

use std::path::Path;
use std::process::{Command, Output};
use ztest::temp_dir;
use zwiki::document::PageDocument;

pub mod common;

/// Lifecycle guidance block the templates carry.
const GUIDANCE: &str = concat!(
    "# 可选生命周期字段（按需取消注释填写，详见 SCHEMA.md）：\n",
    "# supersedes:\n",
    "#   - path: <domain>/concepts/old.md\n",
);

/// Run the binary with `args`.
fn zwiki(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(args)
        .output()
        .expect("run zwiki")
}

/// Write `text` as the page at `root/rel`, creating the parent directory.
fn write_page(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().expect("parent")).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Page with the guidance block and an inline comment, next to untouched
/// authored body text.
fn commented_page(title: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntags:\n  - permission\n\
         status: stable\nlast_validated: 2099-01-01T00:00:00Z\n\
         timeliness: current # 复查后更新\n{GUIDANCE}---\n\n# {title}\n\n正文。\n"
    )
}

/// Page that `check` judges stale, so its `timeliness` value must change.
fn stale_page(title: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntags:\n  - permission\n\
         status: stable\nlast_validated: 2020-01-01T00:00:00Z\n\
         timeliness: current # 复查后更新\n{GUIDANCE}---\n\n# {title}\n\n正文。\n"
    )
}

/// Field names of the frontmatter in `text`, in the order they appear.
fn field_names(text: &str) -> Vec<&str> {
    text.lines()
        .skip(1)
        .take_while(|line| *line != "---")
        .filter(|line| !line.starts_with([' ', '#']))
        .map(|line| line.split_once(':').expect("field line").0)
        .collect()
}

#[test]
fn test_template_prints_the_guidance_block() {
    let output = zwiki(&["template", "concept"]);
    assert!(output.status.success(), "template should print");
    let stdout = String::from_utf8(output.stdout).expect("utf-8");

    assert!(stdout.contains(GUIDANCE), "{stdout}");
    assert!(stdout.contains("# freshness_days: 90\n"), "{stdout}");
    let document = PageDocument::parse(&stdout).expect("template is a page");
    assert_eq!(document.metadata.supersedes, None);
    assert!(document.metadata.extensions.is_empty());
    assert_eq!(document.render().expect("render"), stdout);
}

#[test]
fn test_page_create_keeps_the_guidance_block() {
    let root = temp_dir("comments_create");
    common::write_bundle_manifest(&root);
    let output = zwiki(&[
        "--root",
        &root.to_string_lossy(),
        "page",
        "create",
        "--domain",
        "autodesign",
        "--type",
        "entity",
        "--title",
        "Coin: v2",
        "--slug",
        "coin-v2",
    ]);
    assert!(
        output.status.success(),
        "create should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content =
        std::fs::read_to_string(root.join("autodesign/entities/coin-v2.md"))
            .expect("read created page");

    assert!(content.contains(GUIDANCE), "{content}");
    let document = PageDocument::parse(&content).expect("valid YAML");
    assert_eq!(document.metadata.title, "Coin: v2");
    assert_eq!(document.render().expect("render"), content);
}

#[test]
fn test_supersede_keeps_comments_next_to_the_real_relation() {
    let root = temp_dir("comments_supersede");
    common::write_bundle_manifest(&root);
    write_page(&root, "concepts/old.md", &commented_page("旧权限模型"));
    write_page(&root, "concepts/new.md", &commented_page("新权限模型"));

    let output = zwiki(&[
        "--root",
        &root.to_string_lossy(),
        "supersede",
        "--old",
        "concepts/old.md",
        "--new",
        "concepts/new.md",
        "--reason",
        "新结论取代旧结论",
    ]);
    assert!(
        output.status.success(),
        "supersede should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let new_page =
        std::fs::read_to_string(root.join("concepts/new.md")).expect("new");
    assert!(new_page.contains(GUIDANCE), "{new_page}");
    assert!(
        new_page.contains(
            "supersedes:\n  - path: concepts/old.md\n    reason: 新结论取代旧结论\n"
        ),
        "{new_page}"
    );
    assert_eq!(
        field_names(&new_page),
        [
            "title",
            "type",
            "tags",
            "status",
            "last_validated",
            "timeliness",
            "supersedes"
        ]
    );
    assert!(new_page.ends_with("# 新权限模型\n\n正文。\n"), "{new_page}");

    let old_page =
        std::fs::read_to_string(root.join("concepts/old.md")).expect("old");
    assert!(old_page.contains(GUIDANCE), "{old_page}");
    assert!(
        old_page.contains(
            "superseded_by:\n  - path: concepts/new.md\n    reason: 新结论取代旧结论\n"
        ),
        "{old_page}"
    );
    assert_eq!(
        field_names(&old_page),
        [
            "title",
            "type",
            "tags",
            "status",
            "last_validated",
            "timeliness",
            "superseded_by"
        ]
    );
    assert!(old_page.ends_with("# 旧权限模型\n\n正文。\n"), "{old_page}");
}

#[test]
fn test_page_set_keeps_comments() {
    let root = temp_dir("comments_set");
    common::write_bundle_manifest(&root);
    write_page(&root, "concepts/old.md", &commented_page("旧权限模型"));

    let output = zwiki(&[
        "--root",
        &root.to_string_lossy(),
        "page",
        "set",
        "concepts/old.md",
        "status",
        "review",
    ]);
    assert!(
        output.status.success(),
        "page set should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content =
        std::fs::read_to_string(root.join("concepts/old.md")).expect("read");

    assert!(content.contains(GUIDANCE), "{content}");
    assert!(content.contains("status: review\n"), "{content}");
    assert!(
        content.contains("timeliness: current # 复查后更新\n"),
        "{content}"
    );
    assert_eq!(
        field_names(&content),
        ["title", "type", "tags", "status", "last_validated", "timeliness"]
    );
    assert!(content.ends_with("# 旧权限模型\n\n正文。\n"), "{content}");
}

#[test]
fn test_check_keeps_comments_while_syncing_derived_content() {
    let root = temp_dir("comments_check");
    common::write_bundle_manifest(&root);
    write_page(&root, "concepts/target.md", &commented_page("目标页面"));
    write_page(
        &root,
        "concepts/linker.md",
        &commented_page("引用页面")
            .replace("正文。", "见 [目标](concepts/target.md)。"),
    );

    let output = zwiki(&["--root", &root.to_string_lossy(), "check"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("已同步 1 个页面的反向链接"),
        "check should sync the backlinks: {stderr}"
    );

    let content =
        std::fs::read_to_string(root.join("concepts/target.md")).expect("read");
    assert!(content.contains(GUIDANCE), "{content}");
    assert!(
        content.contains("timeliness: current # 复查后更新\n"),
        "{content}"
    );
    assert!(content.contains("## Backlinks\n"), "{content}");
    assert!(
        content.contains("- [引用页面](concepts/linker.md)\n"),
        "{content}"
    );
    assert_eq!(
        field_names(&content),
        ["title", "type", "tags", "status", "last_validated", "timeliness"]
    );
}

#[test]
fn test_contradictions_keep_comments_next_to_the_real_records() {
    let root = temp_dir("comments_contradictions");
    common::write_bundle_manifest(&root);
    write_page(&root, "concepts/alpha.md", &commented_page("甲页面"));
    write_page(&root, "concepts/beta.md", &commented_page("乙页面"));
    let pairs = concat!(
        "[{\"page_a\": \"concepts/alpha.md\", ",
        "\"page_b\": \"concepts/beta.md\", ",
        "\"claims\": [\"甲声称权限由 X 控制\"], ",
        "\"detected\": \"2026-07-02\", ",
        "\"resolution\": \"unresolved\"}]"
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_zwiki"))
        .args(["--root", &root.to_string_lossy(), "contradictions", "apply"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("run contradictions apply");
    std::io::Write::write_all(
        child.stdin.as_mut().expect("stdin"),
        pairs.as_bytes(),
    )
    .expect("write stdin");
    let output = child.wait_with_output().expect("wait");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "apply should succeed: {stderr}");

    let content =
        std::fs::read_to_string(root.join("concepts/alpha.md")).expect("read");
    assert!(content.contains(GUIDANCE), "{content}");
    assert!(content.contains("contradictions:\n"), "{content}");
    assert!(content.contains("  - path: concepts/beta.md\n"), "{content}");
    assert_eq!(
        field_names(&content),
        [
            "title",
            "type",
            "tags",
            "status",
            "last_validated",
            "timeliness",
            "contradictions"
        ]
    );
    assert!(content.ends_with("# 甲页面\n\n正文。\n"), "{content}");
}

#[test]
fn test_check_reports_a_commented_field_it_must_rewrite() {
    let root = temp_dir("comments_check_reject");
    common::write_bundle_manifest(&root);
    let before = stale_page("过期页面");
    write_page(&root, "concepts/stale.md", &before);

    let output = zwiki(&["--root", &root.to_string_lossy(), "check"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "check should fail: {stderr}");
    assert!(stderr.contains("timeliness"), "{stderr}");
    assert!(stderr.contains("含注释"), "{stderr}");

    let after =
        std::fs::read_to_string(root.join("concepts/stale.md")).expect("read");
    assert_eq!(after, before, "a rejected write must leave the page as it was");
}

/// Page whose `tags` list carries a column-0 comment between two items.
/// No field owns the second item, so the layout cannot place it.
fn ambiguous_page(title: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: concept\ntags:\n  - permission\n\
         # 权限标签\n  - security\nstatus: stable\n\
         last_validated: 2099-01-01T00:00:00Z\ntimeliness: current\n\
         ---\n\n# {title}\n\n正文。\n"
    )
}

#[test]
fn test_page_set_rejects_a_page_with_an_ambiguous_layout() {
    let root = temp_dir("comments_set_ambiguous");
    common::write_bundle_manifest(&root);
    let before = ambiguous_page("歧义页面");
    write_page(&root, "concepts/ambiguous.md", &before);

    let output = zwiki(&[
        "--root",
        &root.to_string_lossy(),
        "page",
        "set",
        "concepts/ambiguous.md",
        "status",
        "review",
    ]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "page set must fail: {stderr}");
    assert!(stderr.contains("布局"), "the failure names the layout: {stderr}");

    let after = std::fs::read_to_string(root.join("concepts/ambiguous.md"))
        .expect("read");
    assert_eq!(after, before, "a rejected write leaves the page as it was");
}

#[test]
fn test_check_reports_an_ambiguous_layout() {
    let root = temp_dir("comments_check_ambiguous");
    common::write_bundle_manifest(&root);
    std::fs::create_dir_all(root.join("logs")).unwrap();
    std::fs::write(root.join("logs").join(".gitkeep"), "").unwrap();
    write_page(&root, "concepts/valid.md", &commented_page("正常页面"));
    let before = ambiguous_page("歧义页面");
    write_page(&root, "concepts/ambiguous.md", &before);

    let output = zwiki(&["--root", &root.to_string_lossy(), "check", "--json"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "check must fail: {stderr}");
    assert!(stderr.contains("concepts/ambiguous.md"), "{stderr}");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: serde_json::Value =
        serde_json::from_str(&stdout).expect("check keeps the JSON contract");
    let frontmatter = report["health"]["frontmatter"]
        .as_array()
        .expect("frontmatter issues stay in the payload");
    let invalid: Vec<&serde_json::Value> = frontmatter
        .iter()
        .filter(|issue| issue["category"] == "invalid_document")
        .collect();

    assert_eq!(invalid.len(), 1, "one explicit invalid_document: {stdout}");
    assert_eq!(invalid[0]["page"], "concepts/ambiguous.md");
    assert!(
        invalid[0]["details"]
            .as_str()
            .is_some_and(|details| details.contains("布局")),
        "the issue names the layout: {stdout}"
    );

    let after = std::fs::read_to_string(root.join("concepts/ambiguous.md"))
        .expect("read");
    assert_eq!(after, before, "check must not rewrite the page");
}
