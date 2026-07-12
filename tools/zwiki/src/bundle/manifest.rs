//! Bundle manifest — `bundle.toml` data model and validation.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Severity — three-tier validation
// ---------------------------------------------------------------------------

/// Validation severity level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Severity {
    /// Hard error that rejects the operation.
    Fatal,
    /// Non-blocking issue that the user should be aware of.
    Warning,
    /// Field required only when a condition is met (e.g. `team` when
    /// `kind == "team"`).
    ConditionalRequired,
}

/// A single validation result.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationError {
    pub severity: Severity,
    pub field: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// BundleManifest — data model
// ---------------------------------------------------------------------------

/// The top-level bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    #[serde(rename = "package")]
    pub package: PackageSection,
    #[serde(rename = "export")]
    pub export: ExportSection,
}

/// `[package]` section of the bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageSection {
    pub name: String,
    pub version: String,
    #[serde(default = "default_okf_version")]
    pub okf_version: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub team: Option<String>,
    pub registry: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `[export]` section of the bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSection {
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[must_use]
fn default_okf_version() -> String {
    "0.1".to_string()
}

#[must_use]
fn default_kind() -> String {
    "upstream".to_string()
}

impl BundleManifest {
    /// Validate the manifest, returning a list of all issues found.
    ///
    /// Three-tier severity: **Fatal** rejects the operation, **Warning** is a
    /// non-blocking advisory, **`ConditionalRequired`** flags a field that is
    /// mandatory only under specific conditions.
    ///
    /// When `use_json` is `true`, messages are in English (locale-stable for
    /// JSON consumers); when `false`, messages are in Chinese.
    #[must_use]
    pub fn validate(&self, use_json: bool) -> Vec<ValidationError> {
        let mut errors: Vec<ValidationError> = Vec::new();

        // --- Fatal checks ---
        if self.package.name.trim().is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.name".to_string(),
                message: if use_json {
                    "bundle name must not be empty".to_string()
                } else {
                    "包名称不能为空".to_string()
                },
            });
        }

        if self.package.version.trim().is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.version".to_string(),
                message: if use_json {
                    "bundle version must not be empty".to_string()
                } else {
                    "包版本不能为空".to_string()
                },
            });
        }

        if self.export.include.is_empty() {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "export.include".to_string(),
                message: if use_json {
                    "export include patterns must not be empty".to_string()
                } else {
                    "导出包含规则不能为空".to_string()
                },
            });
        }

        let kind = self.package.kind.trim().to_lowercase();
        if kind != "upstream" && kind != "team" && kind != "org" {
            errors.push(ValidationError {
                severity: Severity::Fatal,
                field: "package.kind".to_string(),
                message: if use_json {
                    format!(
                        "invalid kind '{}', must be upstream, team, or org",
                        self.package.kind
                    )
                } else {
                    format!(
                        "无效的 kind 值 '{}'，可选值为 upstream、team 或 org",
                        self.package.kind
                    )
                },
            });
        }

        // --- ConditionalRequired ---
        if kind == "team" && self.package.team.is_none() {
            errors.push(ValidationError {
                severity: Severity::ConditionalRequired,
                field: "package.team".to_string(),
                message: if use_json {
                    "team field is required when kind is 'team'".to_string()
                } else {
                    "当 kind 为 'team' 时，team 字段是必需的".to_string()
                },
            });
        }

        // --- Warning checks ---
        if self.package.okf_version.trim() != "0.1" {
            errors.push(ValidationError {
                severity: Severity::Warning,
                field: "package.okf_version".to_string(),
                message: if use_json {
                    format!(
                        "okf_version '{}' is not recommended, use '0.1'",
                        self.package.okf_version
                    )
                } else {
                    format!(
                        "不推荐的 okf_version '{}'，建议使用 '0.1'",
                        self.package.okf_version
                    )
                },
            });
        }

        // --- Duplicate include patterns ---
        append_duplicate_include_errors(
            &self.export.include,
            &mut errors,
            use_json,
        );

        errors
    }
}

/// Check for duplicate entries in the `export.include` list and append
/// warning-level errors to `errors`.
fn append_duplicate_include_errors(
    include: &[String],
    errors: &mut Vec<ValidationError>,
    use_json: bool,
) {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut duplicates: Vec<&str> = Vec::new();
    for pattern in include {
        if !seen.insert(pattern) {
            duplicates.push(pattern);
        }
    }
    if !duplicates.is_empty() {
        let dup_list = duplicates.join(", ");
        errors.push(ValidationError {
            severity: Severity::Warning,
            field: "export.include".to_string(),
            message: if use_json {
                format!(
                    "export.include contains duplicate patterns: {dup_list}"
                )
            } else {
                format!("export.include 包含重复的导出模式: {dup_list}")
            },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_manifest() -> BundleManifest {
        BundleManifest {
            package: PackageSection {
                name: "test-bundle".to_string(),
                version: "0.1.0".to_string(),
                okf_version: "0.1".to_string(),
                kind: "upstream".to_string(),
                team: None,
                registry: None,
                description: None,
            },
            export: ExportSection {
                include: vec!["pages/**/*.md".to_string()],
                exclude: Vec::new(),
            },
        }
    }

    #[test]
    fn test_validate_ok() {
        let m = valid_manifest();
        let errors = m.validate(false);
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_empty_name_fatal() {
        let mut m = valid_manifest();
        m.package.name = String::new();
        let errors = m.validate(false);
        assert!(errors.iter().any(
            |e| e.severity == Severity::Fatal && e.field == "package.name"
        ));
    }

    #[test]
    fn test_validate_empty_version_fatal() {
        let mut m = valid_manifest();
        m.package.version = "   ".to_string();
        let errors = m.validate(false);
        assert!(
            errors.iter().any(|e| e.severity == Severity::Fatal
                && e.field == "package.version")
        );
    }

    #[test]
    fn test_validate_empty_include_fatal() {
        let mut m = valid_manifest();
        m.export.include.clear();
        let errors = m.validate(false);
        assert!(
            errors.iter().any(|e| e.severity == Severity::Fatal
                && e.field == "export.include")
        );
    }

    #[test]
    fn test_validate_invalid_kind_fatal() {
        let mut m = valid_manifest();
        m.package.kind = "invalid".to_string();
        let errors = m.validate(false);
        assert!(errors.iter().any(
            |e| e.severity == Severity::Fatal && e.field == "package.kind"
        ));
    }

    #[test]
    fn test_validate_team_required_when_kind_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = None;
        let errors = m.validate(false);
        assert!(
            errors.iter().any(|e| e.severity == Severity::ConditionalRequired
                && e.field == "package.team")
        );
    }

    #[test]
    fn test_validate_team_ok_when_kind_team() {
        let mut m = valid_manifest();
        m.package.kind = "team".to_string();
        m.package.team = Some("my-team".to_string());
        let errors = m.validate(false);
        assert!(!errors.iter().any(|e| e.field == "package.team"));
    }

    #[test]
    fn test_validate_wrong_okf_version_warning() {
        let mut m = valid_manifest();
        m.package.okf_version = "0.2".to_string();
        let errors = m.validate(false);
        assert!(errors.iter().any(|e| e.severity == Severity::Warning
            && e.field == "package.okf_version"));
    }

    #[test]
    fn test_validate_kind_case_insensitive() {
        let mut m = valid_manifest();
        m.package.kind = "TEAM".to_string();
        m.package.team = Some("t".to_string());
        let errors = m.validate(false);
        assert!(!errors.iter().any(|e| e.field == "package.kind"));
    }

    #[test]
    fn test_default_okf_version() {
        assert_eq!(default_okf_version(), "0.1");
    }

    #[test]
    fn test_default_kind() {
        assert_eq!(default_kind(), "upstream");
    }

    #[test]
    fn test_validate_duplicate_include_warning() {
        let mut m = valid_manifest();
        m.export.include = vec![
            "*.md".to_string(),
            "*.md".to_string(),
            "pages/**".to_string(),
        ];
        let errors = m.validate(false);
        let dup_warnings: Vec<&ValidationError> = errors
            .iter()
            .filter(|e| {
                e.severity == Severity::Warning && e.field == "export.include"
            })
            .collect();
        assert_eq!(dup_warnings.len(), 1);
        assert!(dup_warnings[0].message.contains("重复"));
    }
}
