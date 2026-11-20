//! Frontmatter boundaries and layout: block detection in the page text, the
//! position of every line inside the block, and the block itself.
//!
//! This module is the only place that locates the block.  The block starts
//! at the first line of the text and ends at the first line that holds
//! nothing but `---`; no substring search is used.  A delimiter may carry
//! trailing blanks, and the text is read as if it uses LF line endings.
//!
//! A page keeps its comment lines because the layout records them next to
//! the fields they precede or follow.  Only the fields themselves are
//! decoded and encoded; a comment line is copied as the page wrote it.

use std::borrow::Cow;

use serde_yaml::{Mapping, Value};

use super::Error;

/// Page text split into the YAML block and the body that follows it.
pub(super) struct Parts<'a> {
    /// YAML text between the two delimiter lines.
    pub(super) yaml: &'a str,
    /// Text after the closing delimiter line.
    pub(super) body: &'a str,
}

/// Split `text` at the frontmatter boundaries.
pub(super) fn split(text: &str) -> Result<Parts<'_>, Error> {
    let mut lines = text.split_inclusive('\n');
    let Some(opening) = lines.next() else {
        return Err(Error::MissingFrontmatter);
    };
    if !is_delimiter(opening) {
        return Err(Error::MissingFrontmatter);
    }

    let yaml_start = opening.len();
    let mut offset = yaml_start;
    for line in lines {
        let line_start = offset;
        offset += line.len();
        if is_delimiter(line) {
            let parts = Parts {
                yaml: &text[yaml_start..line_start],
                body: &text[offset..],
            };
            return Ok(parts);
        }
    }
    Err(Error::UnterminatedFrontmatter)
}

/// Read `text` as LF line endings.
///
/// Rendering writes LF lines only, so a page that used CRLF is read as the
/// same content; without this step one block would mix both endings.
pub(super) fn normalize(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// Report whether `line` holds nothing but the delimiter and trailing
/// blanks.
fn is_delimiter(line: &str) -> bool {
    line.strip_suffix('\n').unwrap_or(line).trim_end() == "---"
}

/// One item of the frontmatter block, in the order the page declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Item {
    /// One line kept as written: a comment or a blank line.
    Line(String),
    /// One top-level field and the lines it occupies.
    Field {
        /// Field name, as the line that starts the field writes it.
        name: String,
        /// Lines of the field block, without line breaks.
        raw: Vec<String>,
    },
}

/// Position of every comment line and every field of the frontmatter block.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Layout {
    items: Vec<Item>,
}

impl Layout {
    /// Read the layout of the YAML text between the two delimiter lines.
    ///
    /// A top-level key starts a field; an indented line or a sequence item
    /// continues the field above it; anything else is a line the page keeps
    /// as written.
    ///
    /// # Errors
    ///
    /// Fails when a continuation line follows a line no field owns, or when
    /// the field names differ from the keys of `fields`.  Rendering cannot
    /// keep such a block intact, so parsing rejects it instead.
    pub(super) fn parse(yaml: &str, fields: &Mapping) -> Result<Self, Error> {
        let mut items: Vec<Item> = Vec::new();
        for line in yaml.split_terminator('\n') {
            if let Some(name) = field_name(line) {
                items.push(Item::Field { name, raw: vec![line.to_string()] });
            } else if continues_field(line) {
                if let Some(Item::Field { raw, .. }) = items.last_mut() {
                    raw.push(line.to_string());
                } else {
                    let message = format!("{line} 无法归属到唯一字段");
                    return Err(Error::InvalidLayout { message });
                }
            } else {
                items.push(Item::Line(line.to_string()));
            }
        }
        check_field_names(&items, fields)?;
        Ok(Self { items })
    }
}

/// Report an error when the field names do not match the mapping keys.
fn check_field_names(items: &[Item], fields: &Mapping) -> Result<(), Error> {
    let names: Vec<&str> = items
        .iter()
        .filter_map(|item| match item {
            Item::Field { name, .. } => Some(name.as_str()),
            Item::Line(_) => None,
        })
        .collect();
    if let Some(name) = names.iter().find(|name| fields.get(**name).is_none()) {
        return Err(Error::InvalidLayout {
            message: format!("字段 {name} 与 YAML 键不一致"),
        });
    }
    if names.len() != fields.len() {
        return Err(Error::InvalidLayout {
            message: "字段与 YAML 键不一致".to_string(),
        });
    }
    Ok(())
}

/// Render the frontmatter block from `layout` and the current field values.
///
/// A field keeps the place the layout gives it, a field the layout does not
/// cover follows the covered ones, and a line the page keeps as written
/// stays where it sits.  Every nested block sits two spaces inside its
/// parent key, so a list item or a nested mapping keeps that offset at any
/// depth.
///
/// # Errors
///
/// Fails when a field name is not a string, when the encoder rejects a
/// value, or when a field carrying a comment would change value.
pub(super) fn render(
    layout: &Layout,
    fields: &Mapping,
) -> Result<String, Error> {
    let mut yaml = String::new();
    let mut covered: Vec<&str> = Vec::new();
    for item in &layout.items {
        match item {
            Item::Line(line) => {
                yaml.push_str(line);
                yaml.push('\n');
            }
            Item::Field { name, raw } => {
                let Some(value) = fields.get(name.as_str()) else {
                    continue;
                };
                covered.push(name);
                if !has_comment(raw) {
                    write_entry(name, value, 0, &mut yaml)?;
                } else if written_value(raw, name).as_ref() == Some(value) {
                    for line in raw {
                        yaml.push_str(line);
                        yaml.push('\n');
                    }
                } else {
                    return Err(Error::CommentedField { field: name.clone() });
                }
            }
        }
    }
    for (key, value) in fields {
        let Value::String(name) = key else {
            return Err(non_string_field_key());
        };
        if !covered.contains(&name.as_str()) {
            write_entry(name, value, 0, &mut yaml)?;
        }
    }
    Ok(format!("---\n{yaml}---\n"))
}

/// Report the field name that `line` declares, when `line` starts a field.
///
/// The name is the decoded YAML key, so a quoted key that holds a colon
/// keeps its place in the layout.
fn field_name(line: &str) -> Option<String> {
    if line.starts_with([' ', '\t', '#', '-', '?', '[', '{']) {
        return None;
    }
    let key = &line[..key_end(line)?];
    if key.starts_with(['\'', '"']) {
        return match serde_yaml::from_str::<Value>(key) {
            Ok(Value::String(name)) => Some(name),
            _ => None,
        };
    }
    (!key.is_empty()).then(|| key.trim_end().to_string())
}

/// Report the offset where the key of `line` ends.
///
/// The key ends at the first colon that a quote does not cover and that is
/// followed by a space or by the end of the line.
fn key_end(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut index = 0;
    let mut quote: Option<u8> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        match (quote, byte) {
            (Some(b'"'), b'\\') => index += 1,
            (Some(b'"'), b'"') => quote = None,
            (Some(b'\''), b'\'') => {
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 1;
                } else {
                    quote = None;
                }
            }
            (None, b'"' | b'\'') => quote = Some(byte),
            (None, b':')
                if matches!(bytes.get(index + 1), None | Some(b' ')) =>
            {
                return Some(index);
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Report whether `line` continues the field above it.
fn continues_field(line: &str) -> bool {
    line.starts_with([' ', '\t']) || line == "-" || line.starts_with("- ")
}

/// Read the value of field `name` out of the lines that hold it.
fn written_value(raw: &[String], name: &str) -> Option<Value> {
    let text = raw.join("\n");
    let value: Value = serde_yaml::from_str(&text).ok()?;
    value.as_mapping()?.get(name).cloned()
}

/// Report whether any of `raw` holds a comment.
fn has_comment(raw: &[String]) -> bool {
    raw.iter().any(|line| holds_comment(line))
}

/// Report whether `line` holds a comment.
///
/// A `#` starts a comment at the start of a line or after a space, unless a
/// quote opened earlier on the line still covers it.
fn holds_comment(line: &str) -> bool {
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut after_space = true;
    for byte in line.bytes() {
        if escaped {
            escaped = false;
        } else {
            match quote {
                Some(b'"') => match byte {
                    b'\\' => escaped = true,
                    b'"' => quote = None,
                    _ => {}
                },
                Some(_) => {
                    if byte == b'\'' {
                        quote = None;
                    }
                }
                None => {
                    if after_space && byte == b'#' {
                        return true;
                    }
                    if byte == b'"' || byte == b'\'' {
                        quote = Some(byte);
                    }
                }
            }
        }
        after_space = byte == b' ' || byte == b'\t';
    }
    false
}

/// Build the error for a field name that is not a string.
fn non_string_field_key() -> Error {
    Error::Serialize { message: "字段名不是字符串".to_string() }
}

/// Write one mapping entry per line, nested blocks two spaces deeper than
/// `indent`.
fn write_mapping(
    mapping: &Mapping,
    indent: usize,
    out: &mut String,
) -> Result<(), Error> {
    for (key, value) in mapping {
        let Value::String(name) = key else {
            return Err(non_string_field_key());
        };
        write_entry(name, value, indent, out)?;
    }
    Ok(())
}

/// Write one mapping entry on the line at `indent`.
fn write_entry(
    name: &str,
    value: &Value,
    indent: usize,
    out: &mut String,
) -> Result<(), Error> {
    out.push_str(&padding(indent));
    out.push_str(&scalar(&Value::from(name))?);
    out.push(':');
    write_value(value, indent, out)
}

/// Write a sequence item per line, nested blocks two spaces deeper than
/// `indent`.
fn write_sequence(
    items: &[Value],
    indent: usize,
    out: &mut String,
) -> Result<(), Error> {
    for item in items {
        match item {
            Value::Mapping(mapping) if !mapping.is_empty() => {
                let mut block = String::new();
                write_mapping(mapping, indent + 2, &mut block)?;
                out.push_str(&padding(indent));
                out.push_str("- ");
                out.push_str(&block[(indent + 2)..]);
            }
            _ => {
                out.push_str(&padding(indent));
                out.push('-');
                write_value(item, indent, out)?;
            }
        }
    }
    Ok(())
}

/// Write `value` after the current line prefix, whose nesting is `indent`.
fn write_value(
    value: &Value,
    indent: usize,
    out: &mut String,
) -> Result<(), Error> {
    match value {
        Value::Mapping(mapping) if !mapping.is_empty() => {
            out.push('\n');
            write_mapping(mapping, indent + 2, out)
        }
        Value::Sequence(items) if !items.is_empty() => {
            out.push('\n');
            write_sequence(items, indent + 2, out)
        }
        Value::Mapping(_) => {
            out.push_str(" {}\n");
            Ok(())
        }
        Value::Sequence(_) => {
            out.push_str(" []\n");
            Ok(())
        }
        _ => write_scalar(value, indent, out),
    }
}

/// Write a scalar after the current line prefix.
///
/// A multi-line string arrives as a block scalar whose lines start two
/// spaces in; adding the current `indent` keeps the content deeper than the
/// line that introduces it.
fn write_scalar(
    value: &Value,
    indent: usize,
    out: &mut String,
) -> Result<(), Error> {
    let text = scalar(value)?;
    let mut lines = text.split('\n');
    out.push(' ');
    out.push_str(lines.next().unwrap_or_default());
    out.push('\n');
    for line in lines {
        if !line.is_empty() {
            out.push_str(&padding(indent));
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(())
}

/// YAML text of one scalar, without the trailing line break.
fn scalar(value: &Value) -> Result<String, Error> {
    let text = serde_yaml::to_string(value)
        .map_err(|error| Error::Serialize { message: error.to_string() })?;
    Ok(text.strip_suffix('\n').unwrap_or(&text).to_string())
}

/// Spaces for one nesting level.
fn padding(indent: usize) -> String {
    " ".repeat(indent)
}
