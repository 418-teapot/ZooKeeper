//! Tool-level assets embedded in the binary: page templates and the OKF
//! schema document.
//!
//! These are part of the tool, not of any bundle, so they are compiled in
//! via `include_str!` and can never drift from the running binary.

/// Page types that have an embedded template, in display order.
pub const TEMPLATE_TYPES: &[&str] =
    &["concept", "entity", "source", "analysis", "synthesis"];

/// The embedded OKF schema document (`SCHEMA.md`).
pub const SCHEMA: &str = include_str!("../assets/SCHEMA.md");

/// Return the embedded page template for `page_type`.
#[must_use]
pub fn template(page_type: &str) -> Option<&'static str> {
    match page_type {
        "concept" => Some(include_str!("../assets/templates/concept.md")),
        "entity" => Some(include_str!("../assets/templates/entity.md")),
        "source" => Some(include_str!("../assets/templates/source.md")),
        "analysis" => Some(include_str!("../assets/templates/analysis.md")),
        "synthesis" => Some(include_str!("../assets/templates/synthesis.md")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zwiki::document::PageDocument;

    #[test]
    fn test_template_covers_every_declared_type() {
        for page_type in TEMPLATE_TYPES {
            assert!(
                template(page_type).is_some(),
                "missing template for {page_type}"
            );
        }
    }

    /// Every template is a complete page, and rendering it changes no byte,
    /// so `template` shows the same text `page create` writes.
    #[test]
    fn test_template_renders_unchanged() {
        for page_type in TEMPLATE_TYPES {
            let content = template(page_type).expect("template");
            let document = PageDocument::parse(content)
                .unwrap_or_else(|e| panic!("{page_type}: {e}"));
            assert_eq!(document.metadata.page_type, *page_type);
            let rendered = document
                .render()
                .unwrap_or_else(|e| panic!("{page_type}: {e}"));
            assert_eq!(rendered, content, "{page_type} drifts from the model");
        }
    }

    #[test]
    fn test_template_round_trip_is_idempotent() {
        for page_type in TEMPLATE_TYPES {
            let content = template(page_type).expect("template");
            let once = PageDocument::parse(content)
                .expect("parse")
                .render()
                .expect("render");
            let twice = PageDocument::parse(&once)
                .expect("reparse")
                .render()
                .expect("rerender");
            assert_eq!(once, twice, "{page_type} is not idempotent");
        }
    }

    #[test]
    fn test_template_unknown_type_is_none() {
        assert!(template("nope").is_none());
    }

    /// The lifecycle guidance block belongs to the template contract:
    /// `page create` fills the fields and keeps the guidance as written.
    #[test]
    fn test_template_keeps_the_lifecycle_guidance() {
        for page_type in TEMPLATE_TYPES {
            let content = template(page_type).expect("template");
            assert!(content.contains("# supersedes:\n"), "{page_type}");
        }
    }

    /// Guidance lines are comments, so they never become page fields.
    #[test]
    fn test_template_guidance_is_not_parsed_as_fields() {
        for page_type in TEMPLATE_TYPES {
            let content = template(page_type).expect("template");
            let document =
                PageDocument::parse(content).expect("template is a page");
            let metadata = &document.metadata;

            assert_eq!(metadata.supersedes, None, "{page_type}");
            assert_eq!(metadata.superseded_by, None, "{page_type}");
            assert_eq!(metadata.contradictions, None, "{page_type}");
            assert!(metadata.extensions.is_empty(), "{page_type}");
        }
    }

    #[test]
    fn test_schema_is_embedded() {
        assert!(SCHEMA.starts_with("# Wiki Schema"));
    }
}
