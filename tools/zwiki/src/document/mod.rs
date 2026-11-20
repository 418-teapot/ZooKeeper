//! Page document model.
//!
//! [`PageDocument`] owns the whole page: typed metadata, the frontmatter
//! layout and the body.  It does not know where the page lives, whether the
//! root is writable, or how to write files.  Parsing reads the frontmatter
//! with a complete YAML parser; rendering writes it back in the field order
//! the page declares, so the same document always produces the same text.
//! Comment lines keep the place the page gives them.

mod body;
mod error;
mod frontmatter;
mod metadata;

pub use body::PageBody;
pub use error::Error;
pub use metadata::{Contradiction, ExtensionValue, PageMetadata, Relation};
pub use serde_yaml::Value;

/// A wiki page: metadata next to the body.
#[derive(Debug, Clone)]
pub struct PageDocument {
    /// Structured frontmatter.
    pub metadata: PageMetadata,
    /// Text below the frontmatter.
    pub body: PageBody,
    /// Position of every frontmatter comment line and every field.
    frontmatter: frontmatter::Layout,
}

/// Two documents are equal when they hold the same metadata and body.  The
/// layout records how the page is written, not what it says.
impl PartialEq for PageDocument {
    fn eq(&self, other: &Self) -> bool {
        self.metadata == other.metadata && self.body == other.body
    }
}

impl PageDocument {
    /// Parse page text.
    ///
    /// # Errors
    ///
    /// Fails when the text has no frontmatter block, when the block is not
    /// closed, when it is not valid YAML, when the layout cannot attribute
    /// every line to one field, when a required field is absent, or when a
    /// field holds the wrong YAML type.
    pub fn parse(text: &str) -> Result<Self, Error> {
        let text = frontmatter::normalize(text);
        let parts = frontmatter::split(&text)?;
        let fields = decode(parts.yaml)?;
        let frontmatter = frontmatter::Layout::parse(parts.yaml, &fields)?;
        Ok(Self {
            metadata: PageMetadata::from_mapping(fields)?,
            body: PageBody::parse(parts.body),
            frontmatter,
        })
    }

    /// Render the page text.
    ///
    /// Fields keep the order the page declares, a field that page does not
    /// declare follows at the end, the generated backlinks region sits at
    /// its fixed place, and a comment line stays where the page puts it.
    ///
    /// # Errors
    ///
    /// Fails when an extension field reuses a schema field name, when a
    /// field carrying a comment would change value, when the backlinks
    /// content would break the region, or when the YAML encoder rejects the
    /// frontmatter.
    pub fn render(&self) -> Result<String, Error> {
        let fields = self.metadata.to_mapping()?;
        let mut text = frontmatter::render(&self.frontmatter, &fields)?;
        let body = self.body.render()?;
        if body.is_empty() {
            return Ok(text);
        }
        text.push('\n');
        text.push_str(&body);
        text.push('\n');
        Ok(text)
    }
}

/// Read one frontmatter field as stored, without decoding the schema.
///
/// Unlike [`PageDocument::parse`], text that lacks required fields is
/// accepted, so a generated index or a partial page can be inspected.
///
/// # Errors
///
/// Fails when the frontmatter block is not closed or is not valid YAML.
pub fn read_field(text: &str, name: &str) -> Result<Option<Value>, Error> {
    let text = frontmatter::normalize(text);
    let parts = match frontmatter::split(&text) {
        Ok(parts) => parts,
        Err(Error::MissingFrontmatter) => return Ok(None),
        Err(error) => return Err(error),
    };
    match decode(parts.yaml)?.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(value.clone())),
    }
}

/// Decode the YAML block into a mapping.
fn decode(yaml: &str) -> Result<serde_yaml::Mapping, Error> {
    if yaml.trim().is_empty() {
        return Ok(serde_yaml::Mapping::new());
    }
    let value: Value = serde_yaml::from_str(yaml)
        .map_err(|error| Error::InvalidYaml { message: error.to_string() })?;
    match value {
        Value::Mapping(mapping) => Ok(mapping),
        _ => Err(Error::UnexpectedType {
            field: "frontmatter".to_string(),
            expected: "mapping",
        }),
    }
}

/// Strip leading and trailing blank lines from `text`.
///
/// Blank lines separate the frontmatter, the generated regions and the end
/// of the file, so they never belong to the content itself.
fn trim_blank_lines(text: &str) -> &str {
    let mut first = None;
    let mut last_end = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        if line.trim().is_empty() {
            continue;
        }
        first.get_or_insert(start);
        last_end = start + line.trim_end_matches('\n').len();
    }
    first.map_or("", |start| &text[start..last_end])
}
