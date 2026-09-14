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

    #[test]
    fn test_template_covers_every_declared_type() {
        for page_type in TEMPLATE_TYPES {
            assert!(
                template(page_type).is_some(),
                "missing template for {page_type}"
            );
        }
    }

    #[test]
    fn test_template_unknown_type_is_none() {
        assert!(template("nope").is_none());
    }

    #[test]
    fn test_schema_is_embedded() {
        assert!(SCHEMA.starts_with("# Wiki Schema"));
    }
}
