//! Result-oriented report of `zwiki check`.
//!
//! One model feeds both outputs: the pages checked, the automatic changes
//! (applied by a writable root, unapplied by a read-only one), the issues
//! that remain, and the failure that stopped the run.  Rule detection lives
//! in [`rules`], the text layout in [`text`].

use serde::Serialize;

pub mod rules;
pub mod text;

use rules::Rule;

/// Version of the JSON layout.
const SCHEMA_VERSION: u32 = 1;

/// Outcome of a `check` run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The run completed and no issue remains.
    Ok,
    /// The run completed and an issue or an unapplied change remains.
    Issues,
    /// The run did not complete.
    Error,
}

impl Status {
    /// Stable label used in the JSON report.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Issues => "issues",
            Self::Error => "error",
        }
    }
}

/// Kind of automatic update a `check` write applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// A generated index body.
    Index,
    /// The generated `## Backlinks` region.
    Backlinks,
    /// The `timeliness` field.
    Timeliness,
    /// The stored page layout.
    Format,
}

impl ChangeKind {
    /// Stable label used in the JSON report.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Backlinks => "backlinks",
            Self::Timeliness => "timeliness",
            Self::Format => "format",
        }
    }
}

impl Serialize for ChangeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// One automatic update of one page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Path relative to the checked root.
    pub path: String,
    /// What the write updated.
    pub kind: ChangeKind,
}

/// One problem that remains after the writes.
#[derive(Debug, Clone, Serialize)]
pub struct ReportIssue {
    /// Stable rule identifier.
    pub rule: Rule,
    /// Path relative to the checked root.
    pub path: String,
    /// Short Chinese description.
    pub message: String,
    /// Structured facts of this rule.
    pub details: serde_json::Value,
}

/// Everything one `check` run reports.
#[derive(Debug, Clone)]
pub struct Report {
    /// Whether the checked root accepts no write.
    pub(crate) read_only: bool,
    /// Number of pages the run examined.
    pub(crate) pages: usize,
    /// Updates, sorted by path and kind: applied by a writable root,
    /// unapplied by a read-only one.
    pub(crate) changes: Vec<Change>,
    /// Remaining problems, sorted by path and rule.
    pub(crate) issues: Vec<ReportIssue>,
    /// The failure that stopped the run before it completed.
    pub(crate) error: Option<String>,
}

impl Report {
    /// Build the report of one run.
    ///
    /// The arrays are sorted and deduplicated, so two runs over the same
    /// state print the same document.  The issue order never depends on the
    /// order a rule discovered its findings.
    #[must_use]
    pub fn new(
        read_only: bool,
        pages: usize,
        mut changes: Vec<Change>,
        mut issues: Vec<ReportIssue>,
        error: Option<String>,
    ) -> Self {
        changes.sort_by(|a, b| {
            a.path
                .cmp(&b.path)
                .then_with(|| a.kind.as_str().cmp(b.kind.as_str()))
        });
        changes.dedup();
        issues.sort_by(|a, b| {
            a.path
                .cmp(&b.path)
                .then_with(|| a.rule.as_str().cmp(b.rule.as_str()))
                .then_with(|| a.message.cmp(&b.message))
                .then_with(|| a.details.to_string().cmp(&b.details.to_string()))
        });
        Self { read_only, pages, changes, issues, error }
    }

    /// Outcome of the run.
    ///
    /// A read-only root fails while a change stays unapplied, even when no
    /// issue remains.
    #[must_use]
    pub const fn status(&self) -> Status {
        if self.error.is_some() {
            Status::Error
        } else if !self.issues.is_empty()
            || (self.read_only && !self.changes.is_empty())
        {
            Status::Issues
        } else {
            Status::Ok
        }
    }

    /// Process exit code: `0` for a clean run, `1` otherwise.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        i32::from(self.status() != Status::Ok)
    }

    /// The JSON document of this report.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "status": self.status().as_str(),
            "read_only": self.read_only,
            "summary": {
                "pages": self.pages,
                "changes": self.changes.len(),
                "issues": self.issues.len(),
            },
            "changes": &self.changes,
            "issues": &self.issues,
            "error": &self.error,
        })
    }
}
