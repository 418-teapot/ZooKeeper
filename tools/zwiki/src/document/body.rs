//! Page body: author content next to the generated regions.
//!
//! A page carries at most one generated region, the `## Backlinks` section.
//! Parsing takes it out of the author content; rendering puts it back at a
//! fixed place.  Everything below the frontmatter that is not that section
//! belongs to the author and is kept verbatim.

use super::{Error, trim_blank_lines};

/// Generated section heading.
const BACKLINKS_HEADING: &str = "## Backlinks";

/// Heading the generated section stays in front of.
const REFERENCES_HEADING: &str = "## References";

/// Text below the frontmatter, split into author content and the generated
/// backlinks region.
///
/// Leading and trailing blank lines separate regions, so they never belong
/// to the content itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageBody {
    author: String,
    backlinks: Option<String>,
}

impl PageBody {
    /// Split the text below the frontmatter.
    pub(super) fn parse(text: &str) -> Self {
        let Some((start, content_start, end)) =
            section_span(text, BACKLINKS_HEADING)
        else {
            return Self {
                author: trim_blank_lines(text).to_string(),
                backlinks: None,
            };
        };
        let content = trim_blank_lines(&text[content_start..end]);
        let author = format!("{}{}", &text[..start], &text[end..]);
        Self {
            author: trim_blank_lines(&author).to_string(),
            backlinks: (!content.is_empty()).then(|| content.to_string()),
        }
    }

    /// Author content, without the generated regions.
    #[must_use]
    pub fn author(&self) -> &str {
        &self.author
    }

    /// Mutable author content.
    pub const fn author_mut(&mut self) -> &mut String {
        &mut self.author
    }

    /// Content of the generated `## Backlinks` region.
    #[must_use]
    pub fn backlinks(&self) -> Option<&str> {
        self.backlinks.as_deref()
    }

    /// Replace the generated `## Backlinks` region; `None` removes it.
    pub fn set_backlinks(&mut self, content: Option<String>) {
        self.backlinks = content
            .map(|text| trim_blank_lines(&text).to_string())
            .filter(|text| !text.is_empty());
    }

    /// Render the body, with the generated region at its fixed place.
    pub(super) fn render(&self) -> Result<String, Error> {
        let author = trim_blank_lines(&self.author);
        let Some(backlinks) = self.backlinks.as_deref() else {
            return Ok(author.to_string());
        };
        if next_heading(backlinks).is_some() {
            return Err(Error::InvalidBacklinks {
                message: "生成区不得包含二级标题".to_string(),
            });
        }
        let section = format!("{BACKLINKS_HEADING}\n\n{backlinks}");
        let Some(offset) = line_start(author, REFERENCES_HEADING) else {
            return Ok(if author.is_empty() {
                section
            } else {
                format!("{author}\n\n{section}")
            });
        };
        let mut text = String::with_capacity(author.len() + section.len() + 4);
        text.push_str(author[..offset].trim_end_matches('\n'));
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&section);
        text.push_str("\n\n");
        text.push_str(&author[offset..]);
        Ok(text)
    }
}

/// Locate the `heading` section: heading line start, content start, and the
/// offset where the section ends.
fn section_span(text: &str, heading: &str) -> Option<(usize, usize, usize)> {
    let start = line_start(text, heading)?;
    let content_start = (line_end(text, start) + 1).min(text.len());
    let end = next_heading(&text[content_start..])
        .map_or(text.len(), |offset| content_start + offset);
    Some((start, content_start, end))
}

/// Report the offset of the line that holds `heading`.
fn line_start(text: &str, heading: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.strip_suffix('\n').unwrap_or(line) == heading {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

/// Report the offset where the line at `offset` ends, without its newline.
fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |index| offset + index)
}

/// Report the offset of the first second-level heading in `text`.
fn next_heading(text: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with("## ") {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}
