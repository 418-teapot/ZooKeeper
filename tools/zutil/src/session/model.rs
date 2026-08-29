//! Host-agnostic session domain model shared by all CLI tools.
//!
//! The model decouples session browsing from any single host's storage:
//! `OpenCode` keeps sessions in `SQLite`, pi keeps them in `JSONL` files.
//! Providers translate a host's native storage into [`SessionMeta`] and
//! [`Session`], which consumers render uniformly.

use serde_json::Value;

/// A host whose sessions the tooling can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    /// `OpenCode` host — session ids look like `ses_...`, storage is `SQLite`.
    OpenCode,
    /// pi host — session ids are `UUID`s, storage is `JSONL` files.
    Pi,
}

impl Host {
    /// Lowercase host name as used in session log-file prefixes.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }
}

/// Outcome of [`detect_host`], including the fallback for ids that match
/// neither known host shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedHost {
    /// The id carries the `OpenCode` `ses_` prefix.
    OpenCode,
    /// The id has `UUID` shape (pi host).
    Pi,
    /// The id matches neither shape; callers fall back to probing both
    /// sources.
    Unknown,
}

/// Which host a session lookup should consider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostFilter {
    /// Probe hosts in a fixed order until one matches.
    Auto,
    /// Restrict the lookup to a single host.
    Only(Host),
}

/// Detect the host that owns a session id.
///
/// A `ses_` prefix means `OpenCode`, a `UUID`-shaped id means pi. Anything
/// else yields [`DetectedHost::Unknown`] so callers can fall back to
/// probing both sources.
#[must_use]
pub fn detect_host(id: &str) -> DetectedHost {
    if id.starts_with("ses_") {
        DetectedHost::OpenCode
    } else if is_uuid(id) {
        DetectedHost::Pi
    } else {
        DetectedHost::Unknown
    }
}

/// True when `id` has canonical `UUID` shape: 8-4-4-4-12 hex groups.
fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts.iter().all(|part| part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Metadata describing a session, independent of storage host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    /// Full session id (`ses_...` for `OpenCode`, `UUID` for pi).
    pub id: String,
    /// Parent session id when this session was forked from another.
    pub parent_id: Option<String>,
    /// Working directory the session ran in.
    pub cwd: String,
    /// Session start time as epoch milliseconds.
    pub started_at: i64,
    /// Human-readable session title; hosts without a title concept
    /// summarize the first user message instead.
    pub label: Option<String>,
    /// Full, untruncated session title: the host's recorded title
    /// (`OpenCode`) or the raw first user message text (pi). `label`
    /// may truncate this for display; exact search matches against this
    /// instead of the possibly shortened label.
    pub title: Option<String>,
    /// Last update time as epoch milliseconds, when the host records one.
    pub updated_at: Option<i64>,
    /// Model of the session's first assistant message (`Provider/modelId`
    /// for pi, `providerID/modelID` for `OpenCode`); `None` when the host
    /// records none.
    pub model: Option<String>,
    /// Agent that ran the session (`OpenCode` message data agent; pi has
    /// no agent concept so this stays `None` there).
    pub agent: Option<String>,
}

/// One recorded event inside a session, in stream order.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// A chat message (user prompt or assistant text reply).
    Message {
        /// Message id (`OpenCode` message table id, pi record id).
        id: Option<String>,
        /// Message role: `user` or `assistant`.
        role: String,
        /// Message text content.
        text: String,
        /// Event time as epoch milliseconds.
        timestamp: i64,
    },
    /// A tool invocation made by the assistant.
    ToolUse {
        /// Tool-call id (part id in `OpenCode`, `toolCall` part id in pi).
        id: Option<String>,
        /// Tool name (e.g. `bash`, `read`).
        name: String,
        /// Tool arguments as parsed JSON.
        input: Value,
        /// Event time as epoch milliseconds.
        timestamp: i64,
    },
    /// The result a tool returned for a previous invocation.
    ToolResult {
        /// Tool-call id the result belongs to (part id in `OpenCode`,
        /// `toolCallId` in pi).
        id: Option<String>,
        /// Tool name the result belongs to.
        name: String,
        /// Concatenated text output of the result.
        output: String,
        /// Whether the tool reported an error.
        is_error: bool,
        /// Event time as epoch milliseconds.
        timestamp: i64,
    },
    /// An assistant reasoning (thinking) excerpt.
    Reasoning {
        /// Reasoning text content.
        text: String,
        /// Event time as epoch milliseconds.
        timestamp: i64,
        /// Part id in `OpenCode`; pi thinking blocks carry none.
        id: Option<String>,
    },
    /// Token usage reported for an assistant message.
    Usage {
        /// Input (prompt) tokens.
        input: i64,
        /// Output (completion) tokens.
        output: i64,
        /// Prompt-cache read tokens.
        cache_read: i64,
        /// Prompt-cache write tokens.
        cache_write: i64,
        /// Reported cost in dollars when the provider reports one.
        cost: Option<f64>,
        /// Event time as epoch milliseconds.
        timestamp: i64,
        /// Reasoning tokens reported by the provider (missing = 0).
        reasoning: i64,
        /// Step finish reason (`OpenCode` `step-finish.reason`, pi
        /// `stopReason`).
        reason: Option<String>,
        /// Id of the message this usage belongs to (`OpenCode` message id,
        /// pi record id).
        message_id: Option<String>,
        /// Duration of the assistant message in milliseconds (`OpenCode`
        /// message `time.completed - time.created`; pi reports none).
        duration_ms: Option<i64>,
        /// Model that produced the assistant message (`Provider/modelId`
        /// for pi, `providerID/modelID` for `OpenCode`); `None` when the
        /// host records none.
        model: Option<String>,
    },
}

/// A fully loaded session: metadata plus its ordered event stream.
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    /// Session metadata.
    pub meta: SessionMeta,
    /// Events in the order they were recorded.
    pub events: Vec<SessionEvent>,
}

/// One host-specific event recorded outside the session store, e.g. a
/// lifecycle line from the host's application log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEvent {
    /// Event time as epoch milliseconds.
    pub timestamp: i64,
    /// Classification name of the event (e.g. `created`, `loop`,
    /// `evaluated`).
    pub kind: String,
    /// Human-readable one-line summary.
    pub summary: String,
    /// Structured payload with the host's native event fields.
    pub data: Value,
}

/// The id an event carries, when it has one: message id for `Message`,
/// part / tool-call id for tool and reasoning events, none for `Usage`.
#[must_use]
pub(crate) fn event_id(event: &SessionEvent) -> Option<&str> {
    match event {
        SessionEvent::Message { id, .. }
        | SessionEvent::ToolUse { id, .. }
        | SessionEvent::ToolResult { id, .. }
        | SessionEvent::Reasoning { id, .. } => id.as_deref(),
        SessionEvent::Usage { .. } => None,
    }
}

/// True when the event's id starts with any of `prefixes`.
#[must_use]
pub(crate) fn event_matches_any_prefix(
    event: &SessionEvent,
    prefixes: &[String],
) -> bool {
    event_id(event).is_some_and(|id| prefixes.iter().any(|p| id.starts_with(p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_host_three_shapes() {
        assert_eq!(detect_host("ses_abc123xyz"), DetectedHost::OpenCode);
        assert_eq!(detect_host("ses_"), DetectedHost::OpenCode);
        assert_eq!(
            detect_host("01a04bc0-fa14-76d5-95ec-a8d5ee80f706"),
            DetectedHost::Pi
        );
        assert_eq!(detect_host("not-an-id"), DetectedHost::Unknown);
        assert_eq!(detect_host(""), DetectedHost::Unknown);
        assert_eq!(detect_host("ses-"), DetectedHost::Unknown);
    }

    #[test]
    fn test_detect_host_uuid_is_case_insensitive() {
        assert_eq!(
            detect_host("01A04BC0-FA14-76D5-95EC-A8D5EE80F706"),
            DetectedHost::Pi
        );
    }

    #[test]
    fn test_host_name() {
        assert_eq!(Host::OpenCode.name(), "opencode");
        assert_eq!(Host::Pi.name(), "pi");
    }
}
