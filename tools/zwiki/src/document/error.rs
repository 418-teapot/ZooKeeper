//! Errors raised while decoding or encoding a page document.

use std::fmt;

/// Failure details for a page document operation.
///
/// Every variant names the location that failed, so callers can report the
/// problem without inspecting the raw text again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The text does not start with a frontmatter block.
    MissingFrontmatter,
    /// The frontmatter block has no closing `---` line.
    UnterminatedFrontmatter,
    /// The frontmatter block is not valid YAML.
    InvalidYaml {
        /// Message reported by the YAML decoder.
        message: String,
    },
    /// A required field is absent or empty.
    MissingField {
        /// Field path, for example `supersedes[0].path`.
        field: String,
    },
    /// A field value given as text is not valid YAML.
    InvalidValue {
        /// Message reported by the YAML decoder.
        message: String,
    },
    /// A field holds a value of the wrong YAML type.
    UnexpectedType {
        /// Field path, for example `tags[1]`.
        field: String,
        /// Type the field must hold.
        expected: &'static str,
    },
    /// A nested object holds a field the schema does not declare.
    UnexpectedField {
        /// Field path, for example `supersedes[0].note`.
        field: String,
    },
    /// An extension field reuses the name of a schema field.
    ReservedExtensionKey {
        /// Name shared with a schema field.
        key: String,
    },
    /// Generated backlinks content holds a second-level heading, which would
    /// end the generated region when the text is parsed again.
    InvalidBacklinks {
        /// Details about the rejected content.
        message: String,
    },
    /// The frontmatter layout cannot attribute every line to one field.
    InvalidLayout {
        /// Details about the line or field that has no unique owner.
        message: String,
    },
    /// The YAML encoder rejected the frontmatter.
    Serialize {
        /// Message reported by the YAML encoder.
        message: String,
    },
    /// A field that carries a comment would change value, which would drop
    /// the comment or break the YAML around it.
    CommentedField {
        /// Field that would change.
        field: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFrontmatter => {
                write!(f, "文件缺少 frontmatter")
            }
            Self::UnterminatedFrontmatter => {
                write!(f, "frontmatter 缺少闭合的 --- 行")
            }
            Self::InvalidYaml { message } => {
                write!(f, "frontmatter 不是有效 YAML: {message}")
            }
            Self::MissingField { field } => {
                write!(f, "缺少必需字段 {field}")
            }
            Self::InvalidValue { message } => {
                write!(f, "无法解析属性值: {message}")
            }
            Self::UnexpectedType { field, expected } => {
                write!(f, "字段 {field} 的类型不是 {expected}")
            }
            Self::UnexpectedField { field } => {
                write!(f, "字段 {field} 不在 schema 中")
            }
            Self::ReservedExtensionKey { key } => {
                write!(f, "扩展字段 {key} 与 schema 字段重名")
            }
            Self::InvalidBacklinks { message } => {
                write!(f, "Backlinks 内容不可用: {message}")
            }
            Self::InvalidLayout { message } => {
                write!(f, "frontmatter 布局不明确: {message}")
            }
            Self::Serialize { message } => {
                write!(f, "frontmatter 编码失败: {message}")
            }
            Self::CommentedField { field } => {
                write!(
                    f,
                    "字段 {field} 含注释，改写该字段会丢失注释；请手动编辑该字段"
                )
            }
        }
    }
}

impl std::error::Error for Error {}
