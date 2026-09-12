// Parser module for ZooKeeper log parsing.
//
// Maps tool IDs to (event_type, icon) and resolves the per-session zoo
// log path. The JSONL event parsing itself lives in `zutil::zoo_log`.

use zutil::get_zoo_log_dir;
use zutil::resolve_session_path;

/// Map a tool identifier string to a trace event type and icon.
///
/// Accepts both permission and tool name fields.
///
/// # Returns
///
/// Tuple of (`event_type`, `icon`).
#[must_use]
pub fn tool_type_and_icon(tool_id: &str) -> (String, String) {
    match tool_id {
        "read" | "grep" | "glob" => ("tool_read".to_string(), "▶".to_string()),
        "edit" | "write" => ("tool_write".to_string(), "◀".to_string()),
        "bash" => ("tool_exec".to_string(), "⚙".to_string()),
        "task" => ("tool_orch".to_string(), "◈".to_string()),
        _ => ("tool_other".to_string(), "◆".to_string()),
    }
}

/// Resolve the zoo log path for a given session ID.
///
/// Delegates to `zutil::resolve_session_path`, which finds
/// `<host>-<session_id>.log` (host ∈ {opencode, pi}) in the zoo log dir.
/// Returns `None` when no unique log file exists for the session.
#[must_use]
pub fn resolve_log_path(session_id: &str) -> Option<String> {
    let dir = get_zoo_log_dir();
    resolve_session_path(session_id, &dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── tool_type_and_icon ─────────────────────────────────────────────────

    #[test]
    fn test_tool_type_and_icon_read() {
        for tool in &["read", "grep", "glob"] {
            let (ty, icon) = tool_type_and_icon(tool);
            assert_eq!(ty, "tool_read");
            assert_eq!(icon, "▶");
        }
    }

    #[test]
    fn test_tool_type_and_icon_write() {
        for tool in &["edit", "write"] {
            let (ty, icon) = tool_type_and_icon(tool);
            assert_eq!(ty, "tool_write");
            assert_eq!(icon, "◀");
        }
    }

    #[test]
    fn test_tool_type_and_icon_exec() {
        let (ty, icon) = tool_type_and_icon("bash");
        assert_eq!(ty, "tool_exec");
        assert_eq!(icon, "⚙");
    }

    #[test]
    fn test_tool_type_and_icon_orch() {
        let (ty, icon) = tool_type_and_icon("task");
        assert_eq!(ty, "tool_orch");
        assert_eq!(icon, "◈");
    }

    #[test]
    fn test_tool_type_and_icon_other() {
        let (ty, icon) = tool_type_and_icon("unknown_tool");
        assert_eq!(ty, "tool_other");
        assert_eq!(icon, "◆");

        let (ty2, icon2) = tool_type_and_icon("webfetch");
        assert_eq!(ty2, "tool_other");
        assert_eq!(icon2, "◆");
    }

    // ── resolve_log_path ───────────────────────────────────────────────────

    #[test]
    fn test_resolve_log_path_format() {
        // Resolves against the real ~/.zoo/log dir, which is absent in the
        // test environment → the lookup returns None (no unique match).
        let path = resolve_log_path("ses-001");
        assert_eq!(path, None);
    }
}
