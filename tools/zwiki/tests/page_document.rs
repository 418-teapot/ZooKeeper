//! Contract tests for the page document model.
//!
//! The tests drive the public library API only: `PageDocument::parse`,
//! `PageDocument::render`, the metadata field operations and `read_field`.
//! Expected text and error values are written from `assets/SCHEMA.md`, not
//! from the implementation.

use zwiki::document::{
    Contradiction, Error, PageBody, PageDocument, Relation, Value, read_field,
};

/// Smallest valid page: every required field, no optional field.
const MINIMAL: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags: [permission, security]\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "---\n",
    "\n",
    "# 权限系统\n",
    "\n",
    "正文。\n",
);

#[test]
fn parses_required_metadata_and_author_body() {
    let doc = PageDocument::parse(MINIMAL).expect("valid page");

    assert_eq!(doc.metadata.title, "权限系统");
    assert_eq!(doc.metadata.page_type, "concept");
    assert_eq!(doc.metadata.tags, ["permission", "security"]);
    assert_eq!(doc.metadata.status, "stable");
    assert_eq!(doc.metadata.last_validated, "2026-06-19T00:00:00Z");
    assert_eq!(doc.metadata.timeliness, "current");
    assert_eq!(doc.metadata.description, None);
    assert_eq!(doc.metadata.sources, None);
    assert_eq!(doc.metadata.freshness_days, None);
    assert!(doc.metadata.extensions.is_empty());
    assert_eq!(doc.body.author(), "# 权限系统\n\n正文。");
}

#[test]
fn rejects_text_without_frontmatter() {
    let error =
        PageDocument::parse("# 标题\n\n正文。\n").expect_err("no block");

    assert_eq!(error, Error::MissingFrontmatter);
}

#[test]
fn rejects_empty_text() {
    let error = PageDocument::parse("").expect_err("empty file");

    assert_eq!(error, Error::MissingFrontmatter);
}

#[test]
fn rejects_indented_opening_delimiter() {
    let error =
        PageDocument::parse(" ---\ntitle: x\n---\n").expect_err("indented");

    assert_eq!(error, Error::MissingFrontmatter);
}

#[test]
fn rejects_unterminated_frontmatter() {
    let error =
        PageDocument::parse("---\ntitle: 未闭合\n").expect_err("no close");

    assert_eq!(error, Error::UnterminatedFrontmatter);
}

#[test]
fn rejects_invalid_yaml() {
    let error = PageDocument::parse("---\ntitle: [未闭合\n---\n")
        .expect_err("bad yaml");

    assert!(matches!(error, Error::InvalidYaml { .. }), "{error:?}");
}

#[test]
fn rejects_missing_required_field() {
    let text = MINIMAL.replace("title: 权限系统\n", "");
    let error = PageDocument::parse(&text).expect_err("no title");

    assert_eq!(error, Error::MissingField { field: "title".to_string() });
}

#[test]
fn rejects_wrong_field_type() {
    let text =
        MINIMAL.replace("tags: [permission, security]", "tags: permission");
    let error = PageDocument::parse(&text).expect_err("tags is not a list");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "tags"),
        "{error:?}"
    );
}

#[test]
fn keeps_dashes_inside_a_value() {
    let text = MINIMAL.replace("title: 权限系统", "title: a---b");
    let doc = PageDocument::parse(&text).expect("dashes inside a scalar");

    assert_eq!(doc.metadata.title, "a---b");
}

/// Page that uses every field the schema declares.
const FULL: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "description: 基于 deny 列表的权限判定模型。\n",
    "timestamp: 2026-06-17T00:00:00Z\n",
    "resource: https://example.com/auth\n",
    "sources: [security/concepts/deny-list.md]\n",
    "tags: [permission, security]\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "supersedes:\n",
    "  - path: security/concepts/old-permission.md\n",
    "    reason: 新设计覆盖了旧的权限模型\n",
    "superseded_by:\n",
    "  - path: security/concepts/new-permission.md\n",
    "    reason: 被新结论取代\n",
    "contradictions:\n",
    "  - path: security/concepts/auth-model.md\n",
    "    claims:\n",
    "      - 声称权限由 X 控制\n",
    "      - 声称权限由 Y 控制\n",
    "    detected: 2026-06-19\n",
    "    resolution: unresolved\n",
    "freshness_days: 90\n",
    "---\n",
    "\n",
    "# 权限系统\n",
);

#[test]
fn parses_every_schema_field() {
    let doc = PageDocument::parse(FULL).expect("valid page");
    let metadata = &doc.metadata;

    assert_eq!(
        metadata.description.as_deref(),
        Some("基于 deny 列表的权限判定模型。")
    );
    assert_eq!(metadata.timestamp.as_deref(), Some("2026-06-17T00:00:00Z"));
    assert_eq!(metadata.resource.as_deref(), Some("https://example.com/auth"));
    assert_eq!(
        metadata.sources.as_deref(),
        Some(["security/concepts/deny-list.md".to_string()].as_slice())
    );
    assert_eq!(
        metadata.supersedes.as_deref(),
        Some(
            [Relation {
                path: "security/concepts/old-permission.md".to_string(),
                reason: "新设计覆盖了旧的权限模型".to_string(),
            }]
            .as_slice()
        )
    );
    assert_eq!(
        metadata.superseded_by.as_deref(),
        Some(
            [Relation {
                path: "security/concepts/new-permission.md".to_string(),
                reason: "被新结论取代".to_string(),
            }]
            .as_slice()
        )
    );
    assert_eq!(
        metadata.contradictions.as_deref(),
        Some(
            [Contradiction {
                path: "security/concepts/auth-model.md".to_string(),
                claims: vec![
                    "声称权限由 X 控制".to_string(),
                    "声称权限由 Y 控制".to_string(),
                ],
                detected: "2026-06-19".to_string(),
                resolution: "unresolved".to_string(),
            }]
            .as_slice()
        )
    );
    assert_eq!(metadata.freshness_days, Some(90));
    assert!(metadata.extensions.is_empty());
}

#[test]
fn treats_null_optional_field_as_absent() {
    let text =
        MINIMAL.replace("type: concept\n", "type: concept\ndescription:\n");
    let doc = PageDocument::parse(&text).expect("null is absence");

    assert_eq!(doc.metadata.description, None);
}

#[test]
fn rejects_relation_without_reason() {
    let text = FULL.replace("    reason: 新设计覆盖了旧的权限模型\n", "");
    let error = PageDocument::parse(&text).expect_err("reason is required");

    assert_eq!(
        error,
        Error::MissingField { field: "supersedes[0].reason".to_string() }
    );
}

#[test]
fn rejects_unknown_field_inside_a_relation() {
    let text = FULL.replace(
        "    reason: 新设计覆盖了旧的权限模型\n",
        "    reason: 新设计覆盖了旧的权限模型\n    note: 额外字段\n",
    );
    let error = PageDocument::parse(&text).expect_err("unknown nested field");

    assert_eq!(
        error,
        Error::UnexpectedField { field: "supersedes[0].note".to_string() }
    );
}

#[test]
fn rejects_relation_entry_that_is_not_an_object() {
    let text = FULL.replace(
        "  - path: security/concepts/old-permission.md\n    reason: 新设计覆盖了旧的权限模型\n",
        "  - security/concepts/old-permission.md\n",
    );
    let error = PageDocument::parse(&text).expect_err("relation is a scalar");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "supersedes[0]"),
        "{error:?}"
    );
}

#[test]
fn keeps_unknown_fields_flat() {
    let text = MINIMAL.replace(
        "type: concept\n",
        "type: concept\nowner: team-a\nreview_cycle:\n  days: 30\n",
    );
    let doc = PageDocument::parse(&text).expect("extensions");
    let extensions = &doc.metadata.extensions;

    assert_eq!(extensions.len(), 2);
    assert_eq!(extensions["owner"], Value::from("team-a"));
    let cycle = extensions["review_cycle"].as_mapping().expect("mapping");
    assert_eq!(cycle["days"], Value::from(30));
}

/// Page carrying a generated `## Backlinks` section between two prose
/// sections.
const WITH_BACKLINKS: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags: [permission]\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "---\n",
    "\n",
    "# 权限系统\n",
    "\n",
    "## Details\n",
    "\n",
    "细节。\n",
    "\n",
    "## Backlinks\n",
    "\n",
    "> 此节由 zwiki 自动维护，请勿手动编辑。\n",
    "\n",
    "- [旧模型](security/concepts/old-permission.md)\n",
    "\n",
    "## References\n",
    "\n",
    "- https://example.com/auth\n",
);

#[test]
fn keeps_the_declared_field_order() {
    let doc = PageDocument::parse(MINIMAL).expect("valid page");
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "type: concept\n",
        "tags:\n",
        "  - permission\n",
        "  - security\n",
        "status: stable\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "timeliness: current\n",
        "---\n",
        "\n",
        "# 权限系统\n",
        "\n",
        "正文。\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

/// Page whose fields sit out of schema order: `description` before `type`,
/// `resource` after `timestamp`, `timeliness` before `status`.
const PERMUTED: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "description: 基于 deny 列表的权限判定模型。\n",
    "type: concept\n",
    "timestamp: 2026-06-17T00:00:00Z\n",
    "resource: https://example.com/auth\n",
    "tags: [permission]\n",
    "timeliness: current\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "---\n",
);

#[test]
fn keeps_fields_out_of_schema_order_in_place() {
    let doc = PageDocument::parse(PERMUTED).expect("valid page");
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "description: 基于 deny 列表的权限判定模型。\n",
        "type: concept\n",
        "timestamp: 2026-06-17T00:00:00Z\n",
        "resource: https://example.com/auth\n",
        "tags:\n",
        "  - permission\n",
        "timeliness: current\n",
        "status: stable\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "---\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

#[test]
fn keeps_two_pages_of_the_same_fields_in_their_own_orders() {
    let swapped = MINIMAL.replace(
        "title: 权限系统\ntype: concept\n",
        "type: concept\ntitle: 权限系统\n",
    );
    let forward = PageDocument::parse(MINIMAL).expect("valid page");
    let backward = PageDocument::parse(&swapped).expect("valid page");

    assert_eq!(
        top_level_keys(&forward.render().expect("render")),
        ["title", "type", "tags", "status", "last_validated", "timeliness"]
    );
    assert_eq!(
        top_level_keys(&backward.render().expect("render")),
        ["type", "title", "tags", "status", "last_validated", "timeliness"]
    );
}

/// Page whose lists sit at three levels: top, relation object and claims.
const NESTED: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags: [permission, security]\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "sources: [security/concepts/deny-list.md]\n",
    "supersedes:\n",
    "  - path: security/concepts/old-permission.md\n",
    "    reason: 新设计覆盖了旧的权限模型\n",
    "contradictions:\n",
    "  - path: security/concepts/auth-model.md\n",
    "    claims: [声称权限由 X 控制, 声称权限由 Y 控制]\n",
    "    detected: 2026-06-19\n",
    "    resolution: unresolved\n",
    "---\n",
);

#[test]
fn indents_each_list_level_by_two_spaces() {
    let doc = PageDocument::parse(NESTED).expect("valid page");
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "type: concept\n",
        "tags:\n",
        "  - permission\n",
        "  - security\n",
        "status: stable\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "timeliness: current\n",
        "sources:\n",
        "  - security/concepts/deny-list.md\n",
        "supersedes:\n",
        "  - path: security/concepts/old-permission.md\n",
        "    reason: 新设计覆盖了旧的权限模型\n",
        "contradictions:\n",
        "  - path: security/concepts/auth-model.md\n",
        "    claims:\n",
        "      - 声称权限由 X 控制\n",
        "      - 声称权限由 Y 控制\n",
        "    detected: 2026-06-19\n",
        "    resolution: unresolved\n",
        "---\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

/// Page whose extension fields nest a mapping, a list of mappings and a
/// list inside a mapping.
const EXTENDED: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags: [permission]\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "review_cycle:\n",
    "  days: 30\n",
    "  owners: [team-a, team-b]\n",
    "matrix:\n",
    "  - name: x\n",
    "    values: [1, 2]\n",
    "---\n",
);

#[test]
fn indents_nested_extension_values() {
    let doc = PageDocument::parse(EXTENDED).expect("valid page");
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "type: concept\n",
        "tags:\n",
        "  - permission\n",
        "status: stable\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "timeliness: current\n",
        "review_cycle:\n",
        "  days: 30\n",
        "  owners:\n",
        "    - team-a\n",
        "    - team-b\n",
        "matrix:\n",
        "  - name: x\n",
        "    values:\n",
        "      - 1\n",
        "      - 2\n",
        "---\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

/// Page whose extension fields hold multi-line strings at three
/// indentation levels.
const BLOCK_SCALARS: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags:\n",
    "  - permission\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "note: |\n",
    "  第一行\n",
    "  第二行\n",
    "review_cycle:\n",
    "  remark: |-\n",
    "    甲\n",
    "    乙\n",
    "steps:\n",
    "  - |\n",
    "    其一\n",
    "    其二\n",
    "---\n",
);

#[test]
fn keeps_block_scalar_values_when_indenting() {
    let doc = PageDocument::parse(BLOCK_SCALARS).expect("valid page");
    let rendered = doc.render().expect("render");

    assert_eq!(rendered, BLOCK_SCALARS);
    let extensions =
        &PageDocument::parse(&rendered).expect("reparse").metadata.extensions;
    assert_eq!(extensions["note"], Value::from("第一行\n第二行\n"));
    assert_eq!(extensions["review_cycle"]["remark"], Value::from("甲\n乙"));
    assert_eq!(extensions["steps"][0], Value::from("其一\n其二\n"));
}

#[test]
fn keeps_values_of_nested_and_block_scalar_pages_when_rendering() {
    for text in [NESTED, EXTENDED, BLOCK_SCALARS] {
        let doc = PageDocument::parse(text).expect("valid page");
        let once = doc.render().expect("render");
        let twice = PageDocument::parse(&once)
            .expect("reparse")
            .render()
            .expect("rerender");

        assert_eq!(once, twice);
        assert_eq!(PageDocument::parse(&once).expect("reparse"), doc);
    }
}

#[test]
fn render_is_idempotent() {
    for text in [MINIMAL, FULL, WITH_BACKLINKS] {
        let once =
            PageDocument::parse(text).expect("parse").render().expect("render");
        let twice = PageDocument::parse(&once)
            .expect("reparse")
            .render()
            .expect("rerender");

        assert_eq!(once, twice);
    }
}

#[test]
fn round_trip_keeps_metadata_and_body() {
    let doc = PageDocument::parse(FULL).expect("valid page");
    let reparsed =
        PageDocument::parse(&doc.render().expect("render")).expect("reparse");

    assert_eq!(reparsed, doc);
}

#[test]
fn keeps_extension_fields_in_place() {
    let text = MINIMAL.replace(
        "type: concept\n",
        "type: concept\nzeta: 1\nalpha:\n  nested: true\n",
    );
    let doc = PageDocument::parse(&text).expect("extensions");
    let rendered = doc.render().expect("render");
    let reparsed = PageDocument::parse(&rendered).expect("reparse");

    assert_eq!(
        top_level_keys(&rendered),
        [
            "title",
            "type",
            "zeta",
            "alpha",
            "tags",
            "status",
            "last_validated",
            "timeliness"
        ]
    );
    assert_eq!(reparsed.metadata.extensions, doc.metadata.extensions);
    assert_eq!(
        reparsed.metadata.extensions["alpha"]["nested"],
        Value::from(true)
    );
}

#[test]
fn appends_a_new_known_field_at_the_end() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata.description = Some("一句话摘要。".to_string());
    doc.metadata.resource = Some("https://example.com/auth".to_string());
    let rendered = doc.render().expect("render");

    assert_eq!(
        top_level_keys(&rendered),
        [
            "title",
            "type",
            "tags",
            "status",
            "last_validated",
            "timeliness",
            "description",
            "resource"
        ]
    );
    let reparse_then_render = PageDocument::parse(&rendered)
        .expect("reparse")
        .render()
        .expect("rerender");
    assert_eq!(reparse_then_render, rendered);
}

#[test]
fn appends_a_new_extension_field_at_the_end() {
    let text = MINIMAL.replace("type: concept\n", "type: concept\nzeta: 1\n");
    let mut doc = PageDocument::parse(&text).expect("extensions");
    doc.metadata.set_field("alpha", Value::from(true)).expect("set extension");
    let rendered = doc.render().expect("render");

    assert_eq!(
        top_level_keys(&rendered),
        [
            "title",
            "type",
            "zeta",
            "tags",
            "status",
            "last_validated",
            "timeliness",
            "alpha"
        ]
    );
}

#[test]
fn keeps_the_field_position_when_a_value_changes() {
    let mut doc = PageDocument::parse(PERMUTED).expect("valid page");
    doc.metadata
        .set_field_text("description", "新摘要。")
        .expect("set summary");
    doc.metadata
        .set_field_text("resource", "https://example.com/new")
        .expect("set link");
    doc.metadata.status = "draft".to_string();
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "description: 新摘要。\n",
        "type: concept\n",
        "timestamp: 2026-06-17T00:00:00Z\n",
        "resource: https://example.com/new\n",
        "tags:\n",
        "  - permission\n",
        "timeliness: current\n",
        "status: draft\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "---\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

#[test]
fn removes_only_the_target_field() {
    let mut doc = PageDocument::parse(FULL).expect("valid page");
    doc.metadata.remove_field("description").expect("remove description");
    let rendered = doc.render().expect("render");

    assert!(!rendered.contains("description:"), "{rendered}");
    assert!(
        rendered.contains("type: concept\ntimestamp: 2026-06-17T00:00:00Z\n"),
        "{rendered}"
    );
    assert!(
        rendered.contains("resource: https://example.com/auth\nsources:\n"),
        "{rendered}"
    );
}

#[test]
fn separates_the_generated_backlinks_section() {
    let doc = PageDocument::parse(WITH_BACKLINKS).expect("valid page");

    assert_eq!(
        doc.body.author(),
        concat!(
            "# 权限系统\n",
            "\n",
            "## Details\n",
            "\n",
            "细节。\n",
            "\n",
            "## References\n",
            "\n",
            "- https://example.com/auth",
        )
    );
    assert_eq!(
        doc.body.backlinks(),
        Some(concat!(
            "> 此节由 zwiki 自动维护，请勿手动编辑。\n",
            "\n",
            "- [旧模型](security/concepts/old-permission.md)",
        ))
    );
}

#[test]
fn places_backlinks_before_references() {
    let mut doc = PageDocument::parse(WITH_BACKLINKS).expect("valid page");
    doc.body.set_backlinks(Some(
        "- [新模型](security/concepts/new.md)".to_string(),
    ));
    let rendered = doc.render().expect("render");

    assert!(rendered.contains(concat!(
        "## Backlinks\n",
        "\n",
        "- [新模型](security/concepts/new.md)\n",
        "\n",
        "## References\n",
    )));
    assert!(!rendered.contains("old-permission.md"));
    assert_eq!(
        PageDocument::parse(&rendered).expect("reparse").body.backlinks(),
        Some("- [新模型](security/concepts/new.md)")
    );
}

#[test]
fn appends_backlinks_when_references_are_absent() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.body.set_backlinks(Some(
        "- [新模型](security/concepts/new.md)".to_string(),
    ));
    let rendered = doc.render().expect("render");

    assert!(rendered.ends_with(concat!(
        "正文。\n",
        "\n",
        "## Backlinks\n",
        "\n",
        "- [新模型](security/concepts/new.md)\n",
    )));
}

#[test]
fn removes_backlinks_when_content_is_empty() {
    let mut doc = PageDocument::parse(WITH_BACKLINKS).expect("valid page");
    doc.body.set_backlinks(Some("  \n".to_string()));
    let rendered = doc.render().expect("render");

    assert!(!rendered.contains("## Backlinks"));
    assert!(rendered.contains("## References"));

    doc.body.set_backlinks(None);
    assert!(!doc.render().expect("render").contains("## Backlinks"));
}

#[test]
fn rejects_backlinks_content_with_a_second_level_heading() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.body.set_backlinks(Some("## Details\n\n- 生成内容".to_string()));
    let error = doc.render().expect_err("heading splits the region");

    assert!(matches!(error, Error::InvalidBacklinks { .. }), "{error:?}");
}

#[test]
fn metadata_changes_keep_author_body() {
    let mut doc = PageDocument::parse(WITH_BACKLINKS).expect("valid page");
    let author = doc.body.author().to_string();
    doc.metadata.title = "新标题".to_string();
    doc.metadata.tags.push("new-tag".to_string());
    let rendered = doc.render().expect("render");

    assert_eq!(
        PageDocument::parse(&rendered).expect("reparse").body.author(),
        author
    );
}

#[test]
fn rejects_empty_frontmatter_block() {
    let error =
        PageDocument::parse("---\n---\n\n正文。\n").expect_err("no fields");

    assert_eq!(error, Error::MissingField { field: "title".to_string() });
}

#[test]
fn rejects_frontmatter_that_is_not_a_mapping() {
    let error =
        PageDocument::parse("---\n- title\n---\n").expect_err("sequence");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "frontmatter"),
        "{error:?}"
    );
}

#[test]
fn rejects_non_string_field_name() {
    let text = MINIMAL.replace("type: concept\n", "type: concept\n1: 数值键\n");
    let error = PageDocument::parse(&text).expect_err("numeric key");

    assert!(
        matches!(&error, Error::InvalidLayout { message } if message.contains('1')),
        "{error:?}"
    );
}

#[test]
fn rejects_extension_key_shadowing_a_schema_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .extensions
        .insert("title".to_string(), Value::from("影子标题").into());
    let error = doc.render().expect_err("shadowing key");

    assert_eq!(error, Error::ReservedExtensionKey { key: "title".to_string() });
}

#[test]
fn renders_metadata_only_page() {
    let text = text_with_body(MINIMAL, "");
    let doc = PageDocument::parse(&text).expect("page without body");

    assert_eq!(doc.body.author(), "");
    assert!(doc.render().expect("render").ends_with("---\n"));
}

#[test]
fn builds_a_body_from_author_text() {
    let mut body = PageBody::default();
    body.author_mut().push_str("# 新页面\n\n正文。");
    body.set_backlinks(Some(
        "- [来源](security/sources/vendor.md)".to_string(),
    ));

    assert_eq!(body.author(), "# 新页面\n\n正文。");
    assert_eq!(body.backlinks(), Some("- [来源](security/sources/vendor.md)"));
}

#[test]
fn describes_errors_for_users() {
    let no_title = MINIMAL.replace("title: 权限系统\n", "");
    let bad_tags = MINIMAL.replace("tags: [permission, security]", "tags: 1");
    let bad_notation = FULL.replace(
        "    reason: 新设计覆盖了旧的权限模型\n",
        "    reason: 新设计覆盖了旧的权限模型\n    note: 额外字段\n",
    );
    let messages = [
        (
            PageDocument::parse("").expect_err("no block"),
            "文件缺少 frontmatter".to_string(),
        ),
        (
            PageDocument::parse("---\ntitle: x\n").expect_err("no close"),
            "frontmatter 缺少闭合的 --- 行".to_string(),
        ),
        (
            PageDocument::parse(&no_title).expect_err("no title"),
            "缺少必需字段 title".to_string(),
        ),
        (
            PageDocument::parse(&bad_tags).expect_err("bad tags"),
            "字段 tags 的类型不是 sequence of strings".to_string(),
        ),
        (
            PageDocument::parse(&bad_notation).expect_err("extra key"),
            "字段 supersedes[0].note 不在 schema 中".to_string(),
        ),
    ];

    for (error, expected) in messages {
        assert_eq!(error.to_string(), expected);
    }

    let error =
        PageDocument::parse("---\ntitle: [\n---\n").expect_err("bad yaml");
    assert!(
        error.to_string().starts_with("frontmatter 不是有效 YAML: "),
        "{error}"
    );

    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .extensions
        .insert("title".to_string(), Value::from("影子标题").into());
    assert_eq!(
        doc.render().expect_err("shadowing").to_string(),
        "扩展字段 title 与 schema 字段重名"
    );

    doc.metadata.extensions.clear();
    doc.body.set_backlinks(Some("## Details".to_string()));
    assert_eq!(
        doc.render().expect_err("heading").to_string(),
        "Backlinks 内容不可用: 生成区不得包含二级标题"
    );
}

/// Replace the body of `page` with `body`.
fn text_with_body(page: &str, body: &str) -> String {
    let start = page.find("\n---\n").expect("closing delimiter") + 5;
    format!("{}{body}", &page[..start])
}

#[test]
fn rejects_list_item_of_the_wrong_type() {
    let text = MINIMAL
        .replace("tags: [permission, security]", "tags: [permission, 2]");
    let error = PageDocument::parse(&text).expect_err("number in tags");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "tags[1]"),
        "{error:?}"
    );
}

#[test]
fn rejects_non_integer_freshness_threshold() {
    let text = MINIMAL.replace(
        "timeliness: current",
        "timeliness: current\nfreshness_days: 90.5",
    );
    let error = PageDocument::parse(&text).expect_err("float threshold");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "freshness_days"),
        "{error:?}"
    );
}

#[test]
fn rejects_relation_without_path() {
    let text = FULL.replace(
        "  - path: security/concepts/old-permission.md\n    reason: 新设计覆盖了旧的权限模型\n",
        "  - reason: 覆盖旧模型\n",
    );
    let error = PageDocument::parse(&text).expect_err("no path");

    assert_eq!(
        error,
        Error::MissingField { field: "supersedes[0].path".to_string() }
    );
}

#[test]
fn rejects_relation_list_that_is_not_a_list() {
    let text = FULL.replace(
        "supersedes:\n  - path: security/concepts/old-permission.md\n    reason: 新设计覆盖了旧的权限模型\n",
        "supersedes: security/concepts/old-permission.md\n",
    );
    let error = PageDocument::parse(&text).expect_err("scalar list");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "supersedes"),
        "{error:?}"
    );
}

#[test]
fn treats_null_relation_list_as_absent() {
    let text = FULL.replace(
        "supersedes:\n  - path: security/concepts/old-permission.md\n    reason: 新设计覆盖了旧的权限模型\n",
        "supersedes:\n",
    );
    let doc = PageDocument::parse(&text).expect("null is absence");

    assert_eq!(doc.metadata.supersedes, None);
}

#[test]
fn renders_backlinks_without_author_content() {
    let mut doc =
        PageDocument::parse(&text_with_body(MINIMAL, "")).expect("empty body");
    doc.body.set_backlinks(Some("- [来源](a.md)".to_string()));
    let rendered = doc.render().expect("render");
    let reparsed = PageDocument::parse(&rendered).expect("reparse");

    assert_eq!(reparsed.body.author(), "");
    assert_eq!(reparsed.body.backlinks(), Some("- [来源](a.md)"));
    assert!(!rendered.contains("\n\n\n"));
}

// ---------------------------------------------------------------------------
// Field edits
// ---------------------------------------------------------------------------

#[test]
fn sets_a_known_scalar_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .set_field("description", Value::from("一句话摘要。"))
        .expect("set description");

    assert_eq!(doc.metadata.description.as_deref(), Some("一句话摘要。"));
    let rendered = doc.render().expect("render");
    assert!(rendered.contains("description: 一句话摘要。\n"), "{rendered}");
}

#[test]
fn sets_a_list_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .set_field(
            "tags",
            Value::Sequence(vec![Value::from("a"), Value::from("b")]),
        )
        .expect("set tags");

    assert_eq!(doc.metadata.tags, ["a", "b"]);
    let rendered = doc.render().expect("render");
    assert!(rendered.contains("tags:\n  - a\n  - b\n"), "{rendered}");
}

#[test]
fn sets_an_integer_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .set_field("freshness_days", Value::from(90))
        .expect("set freshness threshold");

    assert_eq!(doc.metadata.freshness_days, Some(90));
    assert!(doc.render().expect("render").contains("freshness_days: 90\n"));
}

#[test]
fn sets_a_structured_field() {
    let value: Value = serde_yaml::from_str(
        "- path: security/concepts/old.md\n  reason: 覆盖旧模型\n",
    )
    .expect("yaml value");
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata.set_field("supersedes", value).expect("set relations");

    assert_eq!(
        doc.metadata.supersedes,
        Some(vec![Relation {
            path: "security/concepts/old.md".to_string(),
            reason: "覆盖旧模型".to_string(),
        }])
    );
}

#[test]
fn sets_an_extension_field_flat() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .set_field("owner", Value::from("team-a"))
        .expect("set extension");

    assert_eq!(
        doc.metadata.extensions.get("owner").map(|value| (**value).clone()),
        Some(Value::from("team-a"))
    );
    let rendered = doc.render().expect("render");
    assert!(rendered.contains("\nowner: team-a\n"), "{rendered}");
    assert!(
        rendered.ends_with("owner: team-a\n---\n\n# 权限系统\n\n正文。\n"),
        "{rendered}"
    );
}

#[test]
fn keeps_text_of_a_string_field_as_written() {
    // Every string field of the schema takes the text literally, so YAML
    // marks and colons stay part of the value.
    for name in [
        "title",
        "type",
        "description",
        "timestamp",
        "resource",
        "status",
        "last_validated",
        "timeliness",
    ] {
        let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
        doc.metadata.set_field_text(name, "Coin: v2").expect("set text");
        let rendered = doc.render().expect("render");
        let reparsed = PageDocument::parse(&rendered).expect("reparse");
        assert_eq!(
            read_field(&rendered, name).expect("read field"),
            Some(Value::from("Coin: v2")),
            "{name} should keep the text as written:\n{rendered}",
        );
        assert_eq!(reparsed.body, doc.body, "{name} should keep the body");
    }
}

#[test]
fn keeps_number_shaped_text_in_a_string_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata.set_field_text("title", "12345").expect("set title");
    doc.metadata.set_field_text("description", "0.5").expect("set summary");

    assert_eq!(doc.metadata.title, "12345");
    assert_eq!(doc.metadata.description.as_deref(), Some("0.5"));
    let rendered = doc.render().expect("render");
    assert_eq!(
        read_field(&rendered, "title").expect("read title"),
        Some(Value::from("12345")),
        "{rendered}",
    );
}

#[test]
fn decodes_text_as_yaml_for_a_non_string_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata.set_field_text("freshness_days", "90").expect("set threshold");

    assert_eq!(doc.metadata.freshness_days, Some(90));
}

#[test]
fn decodes_text_as_yaml_for_an_extension_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    doc.metadata
        .set_field_text("owners", "[team-a, team-b]")
        .expect("set extension");

    assert_eq!(
        doc.metadata.extensions.get("owners").map(|value| (**value).clone()),
        Some(Value::Sequence(vec![
            Value::from("team-a"),
            Value::from("team-b")
        ]))
    );
}

#[test]
fn rejects_text_of_the_wrong_type() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    let error = doc
        .metadata
        .set_field_text("tags", "not-a-list")
        .expect_err("tags is not a list");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "tags"),
        "{error:?}"
    );
    assert_eq!(doc.metadata.tags, ["permission", "security"]);
}

#[test]
fn rejects_a_known_field_of_the_wrong_type() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    let error = doc
        .metadata
        .set_field("tags", Value::from("permission"))
        .expect_err("tags is not a list");

    assert!(
        matches!(&error, Error::UnexpectedType { field, .. } if field == "tags"),
        "{error:?}"
    );
    assert_eq!(doc.metadata.tags, ["permission", "security"]);
}

#[test]
fn removes_an_optional_field() {
    let mut doc = PageDocument::parse(FULL).expect("valid page");
    doc.metadata.remove_field("description").expect("remove description");

    assert_eq!(doc.metadata.description, None);
    assert!(!doc.render().expect("render").contains("description:"));
}

#[test]
fn removes_a_structured_field() {
    let mut doc = PageDocument::parse(FULL).expect("valid page");
    doc.metadata.remove_field("supersedes").expect("remove relations");

    assert_eq!(doc.metadata.supersedes, None);
    assert!(!doc.render().expect("render").contains("supersedes:"));
}

#[test]
fn rejects_removing_a_required_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    let error = doc.metadata.remove_field("status").expect_err("required");

    assert_eq!(error, Error::MissingField { field: "status".to_string() });
    assert_eq!(doc.metadata.status, "stable");
}

#[test]
fn keeps_the_document_when_removing_an_absent_field() {
    let mut doc = PageDocument::parse(MINIMAL).expect("valid page");
    let before = doc.clone();
    doc.metadata.remove_field("resource").expect("absent field");

    assert_eq!(doc, before);
}

#[test]
fn a_dotted_extension_name_does_not_edit_the_parent_field() {
    let mut doc = PageDocument::parse(FULL).expect("valid page");
    doc.metadata
        .set_field("supersedes.note", Value::from("其他页.md"))
        .expect("set extension");

    assert_eq!(doc.metadata.supersedes.as_ref().map(Vec::len), Some(1));
    let rendered = doc.render().expect("render");
    assert!(rendered.contains("supersedes.note: 其他页.md\n"), "{rendered}");
}

#[test]
fn removing_a_field_keeps_a_dotted_extension_with_the_same_prefix() {
    let mut doc = PageDocument::parse(FULL).expect("valid page");
    doc.metadata
        .set_field("supersedes.note", Value::from("其他页.md"))
        .expect("set extension");
    doc.metadata.remove_field("supersedes").expect("remove relations");

    assert_eq!(doc.metadata.supersedes, None);
    assert!(doc.metadata.extensions.contains_key("supersedes.note"));
}

#[test]
fn reads_a_field_without_required_fields() {
    let text = "---\ntitle: 领域索引\nokf_version: \"0.1\"\n---\n\n正文。\n";

    assert_eq!(
        read_field(text, "title").expect("read title"),
        Some(Value::from("领域索引"))
    );
    assert_eq!(
        read_field(text, "okf_version").expect("read extension"),
        Some(Value::from("0.1"))
    );
}

#[test]
fn reads_no_field_from_text_without_frontmatter() {
    assert_eq!(read_field("# 标题\n\n正文。\n", "title").expect("read"), None);
}

#[test]
fn reads_absent_and_empty_fields_as_absent() {
    assert_eq!(read_field(MINIMAL, "description").expect("read"), None);
    assert_eq!(read_field("---\ntitle:\n---\n", "title").expect("read"), None);
}

#[test]
fn rejects_unreadable_frontmatter_when_reading_a_field() {
    let error =
        read_field("---\ntitle: [\n---\n", "title").expect_err("bad yaml");

    assert!(matches!(error, Error::InvalidYaml { .. }), "{error:?}");
}

/// Page carrying comment lines between fields, at the end of the block and
/// inside a field, next to a field that a comment follows on its own line.
const COMMENTED: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "# 可选生命周期字段（按需取消注释填写，详见 SCHEMA.md）：\n",
    "# supersedes:\n",
    "#   - path: <domain>/concepts/old.md\n",
    "type: concept\n",
    "tags:\n",
    "  - permission\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current # 复查后更新\n",
    "---\n",
    "\n",
    "# 权限系统\n",
);

#[test]
fn keeps_comment_lines_where_the_page_puts_them() {
    let doc = PageDocument::parse(COMMENTED).expect("valid page");

    assert_eq!(doc.render().expect("render"), COMMENTED);
    assert_eq!(doc.metadata.supersedes, None);
    assert!(doc.metadata.extensions.is_empty());
    assert_eq!(doc.metadata.timeliness, "current");
}

/// Page whose comment block follows the last field.
const TRAILING_COMMENT: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags:\n",
    "  - permission\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "# 可选生命周期字段（按需取消注释填写，详见 SCHEMA.md）：\n",
    "# supersedes:\n",
    "#   - path: <domain>/concepts/old.md\n",
    "---\n",
    "\n",
    "# 权限系统\n",
);

#[test]
fn keeps_a_comment_block_after_the_last_field() {
    let doc = PageDocument::parse(TRAILING_COMMENT).expect("valid page");
    let once = doc.render().expect("render");

    assert_eq!(once, TRAILING_COMMENT);
    let twice = PageDocument::parse(&once)
        .expect("reparse")
        .render()
        .expect("rerender");
    assert_eq!(once, twice);
}

/// Page whose relation field holds a comment among its own lines.
const NESTED_COMMENT: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags:\n",
    "  - permission\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "supersedes:\n",
    "  # 旧模型的权限判定已被推翻\n",
    "  - path: security/concepts/old-permission.md\n",
    "    reason: 新设计覆盖了旧的权限模型\n",
    "---\n",
);

#[test]
fn keeps_a_comment_inside_a_relation_list() {
    let doc = PageDocument::parse(NESTED_COMMENT).expect("valid page");

    assert_eq!(doc.render().expect("render"), NESTED_COMMENT);
    assert_eq!(
        doc.metadata.supersedes,
        Some(vec![Relation {
            path: "security/concepts/old-permission.md".to_string(),
            reason: "新设计覆盖了旧的权限模型".to_string(),
        }])
    );
}

#[test]
fn changes_a_field_next_to_a_comment_block() {
    let mut doc = PageDocument::parse(COMMENTED).expect("valid page");
    doc.metadata
        .set_field_text("description", "一句话摘要。")
        .expect("set summary");
    doc.metadata.status = "draft".to_string();
    let expected = concat!(
        "---\n",
        "title: 权限系统\n",
        "# 可选生命周期字段（按需取消注释填写，详见 SCHEMA.md）：\n",
        "# supersedes:\n",
        "#   - path: <domain>/concepts/old.md\n",
        "type: concept\n",
        "tags:\n",
        "  - permission\n",
        "status: draft\n",
        "last_validated: 2026-06-19T00:00:00Z\n",
        "timeliness: current # 复查后更新\n",
        "description: 一句话摘要。\n",
        "---\n",
        "\n",
        "# 权限系统\n",
    );

    assert_eq!(doc.render().expect("render"), expected);
}

#[test]
fn appends_a_real_relation_after_its_commented_example() {
    let mut doc = PageDocument::parse(COMMENTED).expect("valid page");
    doc.metadata.supersedes.get_or_insert_with(Vec::new).push(Relation {
        path: "security/concepts/old-permission.md".to_string(),
        reason: "新设计覆盖了旧的权限模型".to_string(),
    });
    let rendered = doc.render().expect("render");
    let expected = concat!(
        "timeliness: current # 复查后更新\n",
        "supersedes:\n",
        "  - path: security/concepts/old-permission.md\n",
        "    reason: 新设计覆盖了旧的权限模型\n",
        "---\n",
    );

    assert!(rendered.contains("# supersedes:\n"), "{rendered}");
    assert!(rendered.contains(expected), "{rendered}");
    let reparsed = PageDocument::parse(&rendered).expect("reparse");
    assert_eq!(reparsed.metadata.supersedes, doc.metadata.supersedes);
    assert_eq!(reparsed.render().expect("rerender"), rendered);
}

#[test]
fn rejects_changing_a_field_that_carries_an_inline_comment() {
    let mut doc = PageDocument::parse(COMMENTED).expect("valid page");
    doc.metadata.set_field_text("timeliness", "stale").expect("set mark");
    let error = doc.render().expect_err("the comment blocks the change");

    assert_eq!(
        error,
        Error::CommentedField { field: "timeliness".to_string() }
    );
    assert!(error.to_string().contains("timeliness"), "{error}");
}

#[test]
fn rejects_changing_a_field_that_carries_a_nested_comment() {
    let mut doc = PageDocument::parse(NESTED_COMMENT).expect("valid page");
    doc.metadata.remove_field("supersedes").expect("drop relations");
    doc.metadata.supersedes.get_or_insert_with(Vec::new).push(Relation {
        path: "security/concepts/new-permission.md".to_string(),
        reason: "被新结论取代".to_string(),
    });
    let error = doc.render().expect_err("the comment blocks the change");

    assert_eq!(
        error,
        Error::CommentedField { field: "supersedes".to_string() }
    );
}

/// Field names of the frontmatter block in `text`, in the order they appear.
fn top_level_keys(text: &str) -> Vec<&str> {
    text.lines()
        .skip(1)
        .take_while(|line| *line != "---")
        .filter(|line| !line.starts_with([' ', '#']))
        .map(|line| line.split_once(':').expect("field line").0)
        .collect()
}

// ---------------------------------------------------------------------------
// Layout uniqueness
// ---------------------------------------------------------------------------

/// Page whose frontmatter uses block layouts, so a comment or a blank line
/// can sit between the lines of one field.
const BLOCK_LAYOUT: &str = concat!(
    "---\n",
    "title: 权限系统\n",
    "type: concept\n",
    "tags:\n",
    "  - permission\n",
    "  - security\n",
    "status: stable\n",
    "last_validated: 2026-06-19T00:00:00Z\n",
    "timeliness: current\n",
    "---\n",
    "\n",
    "# 权限系统\n",
    "\n",
    "正文。\n",
);

#[test]
fn rejects_a_column_zero_comment_inside_a_list() {
    let text =
        BLOCK_LAYOUT.replace("  - security\n", "# 权限标签\n  - security\n");
    let error =
        PageDocument::parse(&text).expect_err("the comment splits the list");

    assert!(matches!(error, Error::InvalidLayout { .. }), "{error:?}");
}

#[test]
fn rejects_a_blank_line_inside_a_list() {
    let text = BLOCK_LAYOUT.replace("  - security\n", "\n  - security\n");
    let error =
        PageDocument::parse(&text).expect_err("the blank line splits the list");

    assert!(matches!(error, Error::InvalidLayout { .. }), "{error:?}");
}

#[test]
fn rejects_a_column_zero_comment_inside_a_nested_mapping() {
    let text = BLOCK_LAYOUT.replace(
        "type: concept\n",
        concat!(
            "type: concept\n",
            "review_cycle:\n",
            "  days: 30\n",
            "# 复查周期\n",
            "  weeks: 4\n",
        ),
    );
    let error =
        PageDocument::parse(&text).expect_err("the comment splits the mapping");

    assert!(matches!(error, Error::InvalidLayout { .. }), "{error:?}");
}

#[test]
fn keeps_comment_blocks_and_blank_lines_between_fields() {
    let text = BLOCK_LAYOUT.replace(
        "status: stable\n",
        concat!(
            "# 生命周期字段（按需取消注释填写）：\n",
            "# supersedes:\n",
            "status: stable\n",
            "\n",
            "# 末尾备注\n",
        ),
    );
    let doc =
        PageDocument::parse(&text).expect("comments between fields are legal");

    assert_eq!(doc.render().expect("render"), text);
}

#[test]
fn keeps_a_quoted_field_name_in_place() {
    let text = BLOCK_LAYOUT.replace(
        "type: concept\n",
        concat!(
            "type: concept\n",
            "\"my: key\": 双引号值\n",
            "'甲 乙': 单引号值\n",
        ),
    );
    let doc = PageDocument::parse(&text).expect("quoted field names");

    assert_eq!(doc.metadata.extensions["my: key"], Value::from("双引号值"));
    assert_eq!(doc.metadata.extensions["甲 乙"], Value::from("单引号值"));

    let rendered = doc.render().expect("render");
    let position = |needle: &str| {
        rendered
            .find(needle)
            .unwrap_or_else(|| panic!("{needle} missing: {rendered}"))
    };
    assert!(position("type: concept") < position("my: key"), "{rendered}");
    assert!(position("my: key") < position("甲 乙"), "{rendered}");
    assert!(position("甲 乙") < position("tags:"), "{rendered}");

    let again = PageDocument::parse(&rendered)
        .expect("reparse")
        .render()
        .expect("rerender");
    assert_eq!(again, rendered, "the quoted field name stays stable");
}

#[test]
fn reads_a_page_with_crlf_line_endings() {
    let text = BLOCK_LAYOUT.replace('\n', "\r\n");
    let doc = PageDocument::parse(&text).expect("crlf page");

    assert_eq!(doc.metadata.title, "权限系统");
    assert_eq!(doc.metadata.tags, ["permission", "security"]);
    assert_eq!(doc.body.author(), "# 权限系统\n\n正文。");

    let rendered = doc.render().expect("render");
    assert!(
        !rendered.contains('\r'),
        "render writes one line ending: {rendered:?}"
    );
    assert_eq!(rendered, BLOCK_LAYOUT);
}

#[test]
fn reads_delimiters_with_trailing_whitespace() {
    let text = BLOCK_LAYOUT.replacen("---\n", "--- \n", 1).replacen(
        "\n---\n",
        "\n---\t\n",
        1,
    );
    let doc = PageDocument::parse(&text).expect("trailing whitespace");

    assert_eq!(doc.render().expect("render"), BLOCK_LAYOUT);
}

#[test]
fn rejects_frontmatter_written_as_one_flow_mapping() {
    let text = concat!(
        "---\n",
        "{title: 权限系统, type: concept, tags: [permission], ",
        "status: stable, last_validated: 2026-06-19T00:00:00Z, ",
        "timeliness: current}\n",
        "---\n",
    );
    let error = PageDocument::parse(text).expect_err("no field line exists");

    assert!(matches!(error, Error::InvalidLayout { .. }), "{error:?}");
}
