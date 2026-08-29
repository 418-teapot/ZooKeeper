//! Integration tests for the `zfind` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Fixture-based tests
//! use a temporary SQLite database (OpenCode) and/or temporary JSONL
//! session files (pi) to exercise the full command pipeline (search,
//! list, show, message).

use std::fs;
use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;

/// Path to the `zfind` binary, set by `cargo test`.
const ZFIND_BIN: &str = env!("CARGO_BIN_EXE_zfind");

/// A DB path that is guaranteed not to exist.
const NO_DB: &str = "/tmp/zfind-test-nonexistent.db";

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZFIND_BIN)
        .arg("--help")
        .output()
        .expect("failed to run zfind --help");
    assert!(
        output.status.success(),
        "zfind --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
    assert!(stdout.contains("search"), "help should show 'search' subcommand");
    assert!(stdout.contains("list"), "help should show 'list' subcommand");
    assert!(stdout.contains("show"), "help should show 'show' subcommand");
    assert!(
        stdout.contains("message"),
        "help should show 'message' subcommand"
    );
    assert!(
        stdout.contains("--host"),
        "help should show the global '--host' flag"
    );
}

#[test]
fn test_list_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "list"])
        .output()
        .expect("failed to run zfind --db <no-db> list");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind list with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found"),
        "stderr should mention 'no sessions found', got: {stderr}"
    );
}

#[test]
fn test_show_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "show", "nonexistent-session-xyz"])
        .output()
        .expect("failed to run zfind show <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind show with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_message_invalid_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "message", "invalid-msg-id"])
        .output()
        .expect("failed to run zfind message <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind message with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found"),
        "stderr should mention 'no messages found', got: {stderr}"
    );
}

#[test]
fn test_json_list_with_nonexistent_db_exits_2() {
    // With no DB, list exits 2 before producing any output.
    // If there were output (e.g. on a system with a real DB), it
    // should be valid JSON — we guard with the empty check.
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "--json", "list"])
        .output()
        .expect("failed to run zfind --json list");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind --json list with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        let parsed: Result<serde_json::Value, _> =
            serde_json::from_str(stdout.trim());
        assert!(parsed.is_ok(), "JSON output should be valid, got: {stdout}");
    }
}

#[test]
fn test_list_help_shows_all_flag() {
    let output = Command::new(ZFIND_BIN)
        .args(["list", "--help"])
        .output()
        .expect("failed to run zfind list --help");
    assert!(
        output.status.success(),
        "zfind list --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("-a, --all"),
        "list --help should show '-a, --all' flag, got: {stdout}"
    );
}

#[test]
fn test_list_all_with_nonexistent_db_exits_2() {
    let output = Command::new(ZFIND_BIN)
        .args(["--db", NO_DB, "list", "--all"])
        .output()
        .expect("failed to run zfind --db <no-db> list --all");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zfind list --all with nonexistent DB should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found"),
        "stderr should mention 'no sessions found', got: {stderr}"
    );
}

#[test]
fn test_no_args_exits_1() {
    // No subcommand given → print help and exit 1
    // (consistent with zlog, zinspect, ztrace)
    let output = Command::new(ZFIND_BIN)
        .output()
        .expect("failed to run zfind with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zfind with no args should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.is_empty(),
        "stderr should be empty (help goes to stdout), got: {stderr}"
    );
}

#[test]
fn test_search_help_shows_search_specific_flags() {
    let output = Command::new(ZFIND_BIN)
        .args(["search", "--help"])
        .output()
        .expect("failed to run zfind search --help");
    assert!(
        output.status.success(),
        "zfind search --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--exact"),
        "search --help should show --exact flag"
    );
    assert!(
        stdout.contains("--session-list-limit"),
        "search --help should show --session-list-limit flag"
    );
}

#[test]
fn test_show_help_shows_show_specific_usage() {
    let output = Command::new(ZFIND_BIN)
        .args(["show", "--help"])
        .output()
        .expect("failed to run zfind show --help");
    assert!(
        output.status.success(),
        "zfind show --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SESSION_ID"),
        "show --help should mention SESSION_ID positional arg"
    );
}

#[test]
fn test_message_help_shows_message_specific_flags() {
    let output = Command::new(ZFIND_BIN)
        .args(["message", "--help"])
        .output()
        .expect("failed to run zfind message --help");
    assert!(
        output.status.success(),
        "zfind message --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--session"),
        "message --help should show --session flag"
    );
    assert!(
        stdout.contains("--scan"),
        "message --help should show --scan flag"
    );
}

// ── Test Fixture ──────────────────────────────────────────────────────────────

/// A test fixture that provisions a temporary SQLite database with session,
/// message, and part tables populated with sample data. The fixture is alive
/// for the duration of the test (drop = cleanup).
struct TestFixture {
    /// Keeps the temp dir alive until the test ends.
    _db_dir: TempDir,
    /// Absolute path to the SQLite database file.
    db_path: String,
}

impl TestFixture {
    /// Create a new fixture with a populated database.
    fn new() -> Self {
        let db_dir = TempDir::new().expect("create temp dir for db");
        let db_path = db_dir.path().join("opencode.db");
        let db_path_str = db_path.to_string_lossy().to_string();

        Self::create_db(&db_path);

        Self { _db_dir: db_dir, db_path: db_path_str }
    }

    /// Build a `Command` that runs `zfind` with `--db` set to the fixture's
    /// database and `--no-color` (table rendering needs it without a TTY).
    fn zfind(&self) -> Command {
        let mut cmd = Command::new(ZFIND_BIN);
        cmd.args(["--db", &self.db_path, "--no-color"]);
        cmd
    }

    // ── Database setup ────────────────────────────────────────────────────

    fn create_db(path: &Path) {
        let conn = Connection::open(path).expect("open test db");

        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT,
                slug TEXT,
                agent TEXT,
                directory TEXT,
                model TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                cost REAL,
                tokens_input REAL,
                tokens_output REAL,
                tokens_reasoning REAL,
                tokens_cache_read REAL,
                tokens_cache_write REAL
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                data TEXT
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                time_updated INTEGER,
                data TEXT
            );",
        )
        .expect("create tables");

        let model_json = r#"{"name":"deepseek-v4"}"#;

        // ── ses-001 (root, "auth middleware debug") ───────────────────────
        conn.execute(
            concat!(
                "INSERT INTO session VALUES ",
                "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            ),
            rusqlite::params![
                "ses-001",
                Option::<&str>::None,
                "auth middleware debug",
                "auth-middleware-debug",
                "beaver",
                "/app",
                model_json,
                1_715_000_000_000_i64,
                1_715_000_100_000_i64,
                0.012,
                500.0,
                300.0,
                0.0,
                0.0,
                0.0,
            ],
        )
        .expect("insert ses-001");

        // msg-001: user turn with text
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-001",
                "ses-001",
                1_715_000_010_000_i64,
                r#"{"role":"user","agent":"beaver"}"#,
            ],
        )
        .expect("insert msg-001");

        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-001",
                "msg-001",
                "ses-001",
                1_715_000_010_000_i64,
                1_715_000_010_000_i64,
                r#"{"type":"text","text":"fix the auth middleware bug"}"#,
            ],
        )
        .expect("insert part msg-001");

        // msg-002: assistant turn with reasoning + tool (its structured
        // `model` decides the session-level model shown in the meta block)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"beaver","model":{"providerID":"openai","modelID":"gpt-5"}}"#,
            ],
        )
        .expect("insert msg-002");

        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-002",
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                1_715_000_020_000_i64,
                r#"{"type":"reasoning","text":"I need to read the auth file"}"#,
            ],
        )
        .expect("insert part reasoning msg-002");

        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-003", "msg-002", "ses-001",
                1_715_000_021_000_i64, 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts","limit":50},"output":{"content":"// auth middleware"}}}"#,
            ],
        )
        .expect("insert part tool msg-002");

        // ── ses-002 (root, "DB migration from v2 to v3") ──────────────────
        conn.execute(
            concat!(
                "INSERT INTO session VALUES ",
                "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            ),
            rusqlite::params![
                "ses-002",
                Option::<&str>::None,
                "DB migration from v2 to v3",
                "db-migration-v2-v3",
                "lynx",
                "/db",
                model_json,
                1_715_000_200_000_i64,
                1_715_000_300_000_i64,
                0.008,
                200.0,
                100.0,
                50.0,
                0.0,
                0.0,
            ],
        )
        .expect("insert ses-002");

        // msg-003: user turn with text
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-003",
                "ses-002",
                1_715_000_210_000_i64,
                r#"{"role":"user","agent":"lynx"}"#,
            ],
        )
        .expect("insert msg-003");

        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-004",
                "msg-003",
                "ses-002",
                1_715_000_210_000_i64,
                1_715_000_210_000_i64,
                r#"{"type":"text","text":"how does the migration work?"}"#,
            ],
        )
        .expect("insert part msg-003");

        // msg-004: assistant with tokens, various part types
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-004", "ses-002", 1_715_000_220_000_i64,
                r#"{"role":"assistant","agent":"lynx","tokens":{"input":100,"output":50}}"#,
            ],
        )
        .expect("insert msg-004");

        // text part → exercises print_text_part (label: "text")
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-005", "msg-004", "ses-002",
                1_715_000_220_000_i64, 1_715_000_220_000_i64,
                r#"{"type":"text","text":"Here is the summary of the migration process..."}"#,
            ],
        )
        .expect("insert part text msg-004");

        // tool part with object input/output → exercises print_tool_part
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-006", "msg-004", "ses-002",
                1_715_000_221_000_i64, 1_715_000_221_000_i64,
                r#"{"type":"tool","tool":"migrate","state":{"input":{"from":"v2","to":"v3"},"output":{"status":"completed","rows_affected":150}}}"#,
            ],
        )
        .expect("insert part tool msg-004");

        // step-finish part (should be skipped in display)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-007", "msg-004", "ses-002",
                1_715_000_222_000_i64, 1_715_000_222_000_i64,
                concat!(
                    r#"{"type":"step-finish","#,
                    r#""tokens":{"input":100,"output":50,"cache":{"read":30,"write":10}},"cost":0.005}"#,
                ),
            ],
        )
        .expect("insert part step-finish msg-004");

        // unknown part type → exercises print_unknown_part
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-008",
                "msg-004",
                "ses-002",
                1_715_000_223_000_i64,
                1_715_000_223_000_i64,
                r#"{"type":"custom_event","data":"something"}"#,
            ],
        )
        .expect("insert part custom msg-004");

        // ── ses-003 (child of ses-001, no messages) ───────────────────────
        conn.execute(
            concat!(
                "INSERT INTO session VALUES ",
                "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            ),
            rusqlite::params![
                "ses-003",
                "ses-001",
                "auth retry",
                "auth-retry",
                "beaver",
                "/app",
                model_json,
                1_715_000_400_000_i64,
                1_715_000_500_000_i64,
                0.004,
                100.0,
                50.0,
                0.0,
                0.0,
                0.0,
            ],
        )
        .expect("insert ses-003");

        conn.close().expect("close test db");
    }
}

// ── Fixture-based integration tests ──────────────────────────────────────────

#[test]
fn test_search_keyword_table() {
    let fix = TestFixture::new();
    // "auth" matches ses-001 ("auth middleware debug") only among root
    // sessions → single match → pipe-friendly output (session ID only)
    let output = fix
        .zfind()
        .args(["search", "auth"])
        .output()
        .expect("failed to run zfind search auth");
    assert!(
        output.status.success(),
        "search auth should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "ses-001");
}

#[test]
fn test_search_keyword_multi_table() {
    let fix = TestFixture::new();
    // "a" matches both ses-001 ("auth middleware debug" has 'a') and
    // ses-002 ("DB migration from v2 to v3" has 'a' in "migration")
    // → 2 results → table rendering path
    let output = fix
        .zfind()
        .args(["search", "a"])
        .output()
        .expect("failed to run zfind search a");
    assert!(
        output.status.success(),
        "search a should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Found"),
        "table output should contain 'Found', got: {stdout}"
    );
    assert!(
        stdout.contains("ses-001"),
        "output should contain ses-001, got: {stdout}"
    );
    assert!(
        stdout.contains("ses-002"),
        "output should contain ses-002, got: {stdout}"
    );
}

#[test]
fn test_search_keyword_json() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["search", "auth", "--json"])
        .output()
        .expect("failed to run zfind search auth --json");
    assert!(
        output.status.success(),
        "search auth --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["keyword"], "auth");
    assert_eq!(parsed["matches"], 1);
    assert!(parsed["sessions"].is_array());
    assert_eq!(parsed["sessions"][0]["id"], "ses-001");
}

#[test]
fn test_search_exact_json() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["search", "--exact", "auth middleware debug", "--json"])
        .output()
        .expect("failed to run zfind search --exact --json");
    assert!(
        output.status.success(),
        "search --exact --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["matches"], 1);
    assert_eq!(parsed["sessions"][0]["id"], "ses-001");
}

#[test]
fn test_search_no_match() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["search", "nonexistent"])
        .output()
        .expect("failed to run zfind search nonexistent");
    assert_eq!(
        output.status.code(),
        Some(2),
        "search nonexistent should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no sessions found matching"),
        "stderr should mention 'no sessions found matching', got: {stderr}"
    );
}

#[test]
fn test_search_no_keyword() {
    let fix = TestFixture::new();
    let output =
        fix.zfind().arg("search").output().expect("failed to run zfind search");
    assert_eq!(
        output.status.code(),
        Some(1),
        "search with no args should exit 1, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("either a keyword or --exact"),
        "stderr should mention 'either a keyword or --exact', got: {stderr}"
    );
}

#[test]
fn test_list_table() {
    let fix = TestFixture::new();
    // 2 root sessions → table with is_all=true
    let output =
        fix.zfind().arg("list").output().expect("failed to run zfind list");
    assert!(
        output.status.success(),
        "list should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("All main sessions"),
        "table output should contain 'All main sessions', got: {stdout}"
    );
    assert!(
        stdout.contains("ses-001"),
        "output should contain ses-001, got: {stdout}"
    );
    assert!(
        stdout.contains("ses-002"),
        "output should contain ses-002, got: {stdout}"
    );
}

#[test]
fn test_list_json() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["list", "--json"])
        .output()
        .expect("failed to run zfind list --json");
    assert!(
        output.status.success(),
        "list --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["keyword"], "");
    assert_eq!(parsed["matches"], 2);
    assert_eq!(parsed["sessions"].as_array().unwrap().len(), 2);
}

#[test]
fn test_list_all_table() {
    let fix = TestFixture::new();
    // list --all includes child session ses-003 → 3 total
    let output = fix
        .zfind()
        .args(["list", "--all"])
        .output()
        .expect("failed to run zfind list --all");
    assert!(
        output.status.success(),
        "list --all should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("All sessions (including sub-sessions"),
        "table output should contain 'All sessions (including sub-sessions', \
         got: {stdout}"
    );
    assert!(
        stdout.contains("ses-003"),
        "output should contain child session ses-003, got: {stdout}"
    );
}

#[test]
fn test_list_all_json() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["list", "--all", "--json"])
        .output()
        .expect("failed to run zfind list --all --json");
    assert!(
        output.status.success(),
        "list --all --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["matches"], 3);
    assert_eq!(parsed["sessions"].as_array().unwrap().len(), 3);
}

#[test]
fn test_show_table() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["show", "ses-001"])
        .output()
        .expect("failed to run zfind show ses-001");
    assert!(
        output.status.success(),
        "show ses-001 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Events for session"),
        "output should contain 'Events for session', got: {stdout}"
    );
    assert!(
        stdout.contains("ses-001"),
        "output should contain ses-001, got: {stdout}"
    );
    assert!(
        stdout.contains("msg-001"),
        "output should contain msg-001, got: {stdout}"
    );
    // The meta block shows the session-level model and agent, derived
    // from the first assistant message of ses-001.
    assert!(
        stdout.contains("Model:"),
        "meta block should show Model, got: {stdout}"
    );
    assert!(
        stdout.contains("openai/gpt-5"),
        "meta block should show the session model, got: {stdout}"
    );
    assert!(
        stdout.contains("Agent:"),
        "meta block should show Agent, got: {stdout}"
    );
}

#[test]
fn test_show_table_hides_model_when_absent() {
    let fix = TestFixture::new();
    // ses-002's first assistant message records an agent but no model,
    // so the meta block shows Agent but omits the Model line.
    let output = fix
        .zfind()
        .args(["show", "ses-002"])
        .output()
        .expect("failed to run zfind show ses-002");
    assert!(
        output.status.success(),
        "show ses-002 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Agent: lynx"),
        "meta block should show the agent, got: {stdout}"
    );
    assert!(
        !stdout.contains("Model:"),
        "meta block should omit Model for a model-less session, got: \
         {stdout}"
    );
}

#[test]
fn test_show_json() {
    let fix = TestFixture::new();
    // ses-001 holds a user message, a reasoning part, a tool use, and its
    // result — the show output is one row per event now, so 4 rows.
    let output = fix
        .zfind()
        .args(["show", "ses-001", "--json"])
        .output()
        .expect("failed to run zfind show ses-001 --json");
    assert!(
        output.status.success(),
        "show ses-001 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["keyword"], "ses-001");
    assert_eq!(parsed["matches"], 4);
    let messages = parsed["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["id"], "msg-001");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["id"], "part-002");
    assert_eq!(messages[1]["role"], "reasoning");
    assert_eq!(messages[2]["id"], "part-003");
    assert_eq!(messages[2]["role"], "tool_use");
    assert_eq!(messages[3]["id"], "part-003");
    assert_eq!(messages[3]["role"], "tool_result");
    assert_eq!(messages[3]["host"], "opencode");
}

#[test]
fn test_show_ambiguous_prefix() {
    let fix = TestFixture::new();
    // "ses-" matches ses-001, ses-002, ses-003 → ambiguous
    let output = fix
        .zfind()
        .args(["show", "ses-"])
        .output()
        .expect("failed to run zfind show ses-");
    assert_eq!(
        output.status.code(),
        Some(2),
        "show ambiguous prefix should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ambiguous session ID prefix"),
        "stderr should mention 'ambiguous session ID prefix', got: {stderr}"
    );
}

#[test]
fn test_show_no_messages() {
    let fix = TestFixture::new();
    // ses-003 has no messages → exit 2
    let output = fix
        .zfind()
        .args(["show", "ses-003"])
        .output()
        .expect("failed to run zfind show ses-003");
    assert_eq!(
        output.status.code(),
        Some(2),
        "show ses-003 (no messages) should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found"),
        "stderr should mention 'no messages found', got: {stderr}"
    );
}

#[test]
fn test_message_json() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["message", "msg-004", "--json"])
        .output()
        .expect("failed to run zfind message msg-004 --json");
    assert!(
        output.status.success(),
        "message msg-004 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["matches"], 1);
    assert_eq!(parsed["messages"][0]["id"], "msg-004");
    assert_eq!(parsed["messages"][0]["role"], "assistant");
    // The event model carries the host tag instead of the message agent.
    assert_eq!(parsed["messages"][0]["host"], "opencode");
    assert!(
        parsed["messages"][0].get("agent").is_none(),
        "message rows should not carry a per-message agent"
    );
}

#[test]
fn test_message_table() {
    let fix = TestFixture::new();
    // msg-004 is an assistant message with a single text part, so the
    // detail renderer shows one text part (the old raw-part fixtures —
    // agent, custom part types — are gone from the event model).
    let output = fix
        .zfind()
        .args(["message", "msg-004"])
        .output()
        .expect("failed to run zfind message msg-004");
    assert!(
        output.status.success(),
        "message msg-004 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Message header
    assert!(
        stdout.contains("Message:"),
        "output should contain 'Message:', got: {stdout}"
    );
    assert!(
        stdout.contains("msg-004"),
        "output should contain msg-004 id, got: {stdout}"
    );
    // Role and tokens
    assert!(
        stdout.contains("Role:"),
        "output should contain 'Role:', got: {stdout}"
    );
    assert!(
        stdout.contains("Tokens:"),
        "output should contain 'Tokens:', got: {stdout}"
    );
    // Timestamp should be shown (msg-004 has time_created)
    assert!(
        stdout.contains("Timestamp:"),
        "output should contain 'Timestamp:', got: {stdout}"
    );
    // Part rendering: text part
    assert!(
        stdout.contains("Part 1 (text):"),
        "output should contain text part, got: {stdout}"
    );
}

#[test]
fn test_message_tool_event_table() {
    let fix = TestFixture::new();
    // part-003 is the tool part of msg-002 (a `read` call): the event
    // model matches it by its id and renders the tool part detail.
    let output = fix
        .zfind()
        .args(["message", "part-003"])
        .output()
        .expect("failed to run zfind message part-003");
    assert!(
        output.status.success(),
        "message part-003 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Part 1 (tool: read):"),
        "output should contain tool part, got: {stdout}"
    );
    assert!(
        stdout.contains("Input:"),
        "output should show tool input, got: {stdout}"
    );
}

#[test]
fn test_message_with_session() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["message", "msg-004", "--session", "ses-002"])
        .output()
        .expect("failed to run zfind message msg-004 --session ses-002");
    assert!(
        output.status.success(),
        "message msg-004 --session ses-002 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("msg-004"),
        "output should contain msg-004, got: {stdout}"
    );
}

#[test]
fn test_message_no_match() {
    let fix = TestFixture::new();
    let output = fix
        .zfind()
        .args(["message", "nonexistent"])
        .output()
        .expect("failed to run zfind message nonexistent");
    assert_eq!(
        output.status.code(),
        Some(2),
        "message nonexistent should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no messages found matching"),
        "stderr should mention 'no messages found matching', got: {stderr}"
    );
}

// ── Default aggregation across multiple databases ───────────────────────────

/// Build a temp data dir with both fixture DBs and return it.
fn two_db_data_dir() -> TempDir {
    let dir = TempDir::new().expect("create temp data dir");
    TestFixture::create_db(&dir.path().join("opencode.db"));
    zutil::test_db::create_second_db(&dir.path().join("opencode-stable.db"));
    dir
}

#[test]
fn test_default_no_db_list_aggregates_two_databases() {
    let dir = two_db_data_dir();
    let data_dir = dir.path().to_string_lossy().to_string();
    // A deterministic environment: no `--db` auto-detects both hosts, so
    // pi must be pinned to an empty dir to keep the count exact (the real
    // `~/.pi/agent` must not leak into the fixture run).
    let empty_pi = TempDir::new().expect("create temp pi dir");

    let output = Command::new(ZFIND_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", &data_dir)
        .env("ZOO_PI_DATA_DIR", empty_pi.path())
        .args(["--no-color", "list", "--json"])
        .output()
        .expect("failed to run zfind list --json (default aggregation)");
    assert!(
        output.status.success(),
        "default list should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    // 2 root sessions from the first DB + 1 root session living only in
    // the second (ses-003 is a child and excluded by `list`).
    assert_eq!(parsed["matches"], 3, "expected all sessions from both DBs");
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()))
        .collect();
    assert!(
        ids.contains(&"ses-900"),
        "default invocation must list the second-DB session, got: {ids:?}"
    );
    assert!(ids.contains(&"ses-001"), "first-DB sessions still listed");
}

#[test]
fn test_default_search_finds_session_only_in_second_db() {
    let dir = two_db_data_dir();
    let data_dir = dir.path().to_string_lossy().to_string();
    // Same deterministic environment as the list test above.
    let empty_pi = TempDir::new().expect("create temp pi dir");

    // "archived" only appears in ses-900's title → single match → the
    // command prints the session ID (pipe-friendly output).
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", &data_dir)
        .env("ZOO_PI_DATA_DIR", empty_pi.path())
        .args(["--no-color", "search", "archived"])
        .output()
        .expect("failed to run zfind search archived (default aggregation)");
    assert!(
        output.status.success(),
        "default search should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        stdout.trim(),
        "ses-900",
        "search without --db must find the second-DB session"
    );
}

#[test]
fn test_explicit_db_preserves_single_db_behavior() {
    let dir = two_db_data_dir();
    let data_dir = dir.path().to_string_lossy().to_string();

    // First DB only: root sessions ses-001/ses-002; ses-900 must be
    // invisible (ses-003 is a child and excluded by `list`).
    let output = Command::new(ZFIND_BIN)
        .args([
            "--db",
            &format!("{data_dir}/opencode.db"),
            "--no-color",
            "list",
            "--json",
        ])
        .output()
        .expect("failed to run zfind --db opencode.db list --json");
    assert!(
        output.status.success(),
        "explicit --db list should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["matches"], 2, "explicit DB must not aggregate");
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()))
        .collect();
    assert!(
        !ids.contains(&"ses-900"),
        "ses-900 must not appear when --db is the first DB, got: {ids:?}"
    );

    // Second DB only: ses-001 must be invisible, ses-900 visible.
    let output = Command::new(ZFIND_BIN)
        .args([
            "--db",
            &format!("{data_dir}/opencode-stable.db"),
            "--no-color",
            "list",
            "--json",
        ])
        .output()
        .expect("failed to run zfind --db stable.db list --json");
    assert!(
        output.status.success(),
        "explicit --db stable list should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["matches"], 1);
    assert_eq!(parsed["sessions"][0]["id"], "ses-900");

    // Searching for the second-DB session against the first DB exits 2.
    let output = Command::new(ZFIND_BIN)
        .args([
            "--db",
            &format!("{data_dir}/opencode.db"),
            "--no-color",
            "search",
            "archived",
        ])
        .output()
        .expect("failed to run zfind --db opencode.db search archived");
    assert_eq!(
        output.status.code(),
        Some(2),
        "search archived --db first.db should exit 2, got {:?}",
        output.status.code()
    );
}

// ── pi host tests ───────────────────────────────────────────────────────────

/// A pi session id with UUID shape.
const PI_UUID: &str = "01a04bc0-fa14-76d5-95ec-a8d5ee80f706";

/// Write one pi session file per entry under
/// `<root>/sessions/<cwd-dir>/<name>.jsonl`, the layout the pi provider
/// scans.
fn pi_data_dir(root: &Path, sessions: &[(&str, &[String])]) {
    for (name, lines) in sessions {
        let cwd = root.join("sessions").join("--cwd--");
        fs::create_dir_all(&cwd).expect("create pi cwd dir");
        fs::write(cwd.join(format!("{name}.jsonl")), lines.join("\n"))
            .expect("write pi session file");
    }
}

/// One pi session file's JSONL lines: the session header plus message
/// records (in stream order).
fn pi_session_lines(
    id: &str,
    header_ts: i64,
    messages: &[Value],
) -> Vec<String> {
    let mut lines = vec![
        json!({
            "type": "session", "version": 3, "id": id,
            "timestamp": zutil::epoch_ms_to_iso(header_ts), "cwd": "/w",
        })
        .to_string(),
    ];
    for msg in messages {
        lines.push(msg.to_string());
    }
    lines
}

/// A pi `message` record with a user role.
fn user_message(id: &str, ts: i64, text: &str) -> Value {
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": text}],
        },
    })
}

/// A pi `message` record with an assistant role carrying an optional tool
/// call.
fn assistant_message(
    id: &str,
    ts: i64,
    text: &str,
    tool: Option<(&str, &str)>,
) -> Value {
    let mut body = json!({
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "timestamp": ts,
    });
    if let Some((call_id, name)) = tool {
        body["content"] = json!([
            {"type": "text", "text": text},
            {"type": "toolCall", "id": call_id, "name": name,
             "arguments": {"command": "ls"}},
        ]);
    }
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": body,
    })
}

/// A pi `message` record with a toolResult role.
fn tool_result_message(
    id: &str,
    ts: i64,
    call_id: &str,
    name: &str,
    text: &str,
) -> Value {
    json!({
        "type": "message", "id": id, "timestamp": zutil::epoch_ms_to_iso(ts),
        "message": {
            "role": "toolResult", "toolCallId": call_id, "toolName": name,
            "content": [{"type": "text", "text": text}],
            "isError": false, "timestamp": ts,
        },
    })
}

/// Parse the command's stdout as JSON.
fn parse_stdout_json(output: &std::process::Output) -> Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).expect("stdout should be valid JSON")
}

/// A pi fixture session with a user turn, an assistant tool call, and its
/// result — the events `show`/`message` expose.
fn pi_events_session_lines() -> Vec<String> {
    pi_session_lines(
        PI_UUID,
        1_715_000_000_000,
        &[
            user_message("m1", 1_715_000_001_000, "refactor the parser module"),
            assistant_message(
                "m2",
                1_715_000_010_000,
                "calling bash",
                Some(("call-1", "bash")),
            ),
            tool_result_message(
                "m3",
                1_715_000_015_000,
                "call-1",
                "bash",
                "all tests passed",
            ),
        ],
    )
}

#[test]
fn test_pi_search_hits_session() {
    let pi_root = TempDir::new().expect("temp pi root");
    let lines = pi_events_session_lines();
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    // Single match → pipe-friendly output: the bare session id.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "search", "parser"])
        .output()
        .expect("failed to run zfind --host pi search parser");
    assert!(
        output.status.success(),
        "pi search should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), PI_UUID);

    // The provider search matches message text too, not just the label.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "search", "tests passed"])
        .output()
        .expect("failed to run zfind --host pi search tests passed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), PI_UUID, "tool-result text must match");
}

#[test]
fn test_pi_search_exact_matches_untruncated_long_title() {
    let pi_root = TempDir::new().expect("temp pi root");
    // Longer than the 60-character label truncation: --exact must match
    // against the full first user message, not the shortened label.
    let long_title = "refactor the entire authentication flow and add \
                      integration tests for the new session model";
    assert!(long_title.chars().count() > 60);
    let lines = pi_session_lines(
        PI_UUID,
        1_715_000_000_000,
        &[user_message("m1", 1_715_000_001_000, long_title)],
    );
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "search", "--exact", long_title])
        .output()
        .expect("failed to run zfind search --exact <long title>");
    assert!(
        output.status.success(),
        "pi exact search should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), PI_UUID, "full title must exact-match");

    // A truncated prefix must NOT match: exact compares the whole,
    // untruncated first user message.
    let truncated: String = long_title.chars().take(60).collect();
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "search", "--exact", &truncated])
        .output()
        .expect("failed to run zfind search --exact <prefix>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "a truncated prefix must not be an exact title match"
    );
}

#[test]
fn test_pi_message_scan_hits_newest_across_cwd_dirs() {
    let pi_root = TempDir::new().expect("temp pi root");
    // The newer session sits in the alphabetically-first cwd directory;
    // --scan 1 must consult it even though a full-path sort would scan
    // the older `--z--` session first.
    fs::create_dir_all(pi_root.path().join("sessions").join("--a--"))
        .expect("create --a-- dir");
    fs::create_dir_all(pi_root.path().join("sessions").join("--z--"))
        .expect("create --z-- dir");
    let new_lines = pi_session_lines(
        "01a04bc0-fa14-76d5-95ec-222222222222",
        1_715_000_100_000,
        &[user_message("mnew", 1_715_000_101_000, "newest turn")],
    );
    fs::write(
        pi_root
            .path()
            .join("sessions")
            .join("--a--")
            .join("2026-08-29T04-22-13-268Z_01a04bc0-fa14-76d5-95ec-222222222222.jsonl"),
        new_lines.join("\n"),
    )
    .expect("write newer pi session");
    let old_lines = pi_session_lines(
        "01a04bc0-fa14-76d5-95ec-111111111111",
        1_715_000_000_000,
        &[user_message("mold", 1_715_000_001_000, "oldest turn")],
    );
    fs::write(
        pi_root
            .path()
            .join("sessions")
            .join("--z--")
            .join("2026-08-01T00-00-00-000Z_01a04bc0-fa14-76d5-95ec-111111111111.jsonl"),
        old_lines.join("\n"),
    )
    .expect("write older pi session");

    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "message", "mnew", "--scan", "1"])
        .output()
        .expect("failed to run zfind message mnew --scan 1");
    assert!(
        output.status.success(),
        "pi message --scan 1 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("mnew"),
        "scan 1 must find the message of the newest session, got: {stdout}"
    );
    assert!(
        !stdout.contains("mold"),
        "scan 1 must not reach the older decoy session, got: {stdout}"
    );

    // A scan budget of 1 also misses the older session's message.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "message", "mold", "--scan", "1"])
        .output()
        .expect("failed to run zfind message mold --scan 1");
    assert_eq!(
        output.status.code(),
        Some(2),
        "the older session must be outside the --scan 1 budget"
    );
}

#[test]
fn test_pi_show_json() {
    let pi_root = TempDir::new().expect("temp pi root");
    let lines = pi_events_session_lines();
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["show", PI_UUID, "--host", "pi", "--json"])
        .output()
        .expect("failed to run zfind show <pi> --json");
    assert!(
        output.status.success(),
        "pi show should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    assert_eq!(parsed["keyword"], PI_UUID);
    // Events: user message, assistant message, tool use, tool result.
    assert_eq!(parsed["matches"], 4);
    let messages = parsed["messages"].as_array().unwrap();
    assert_eq!(messages[0]["id"], "m1");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["id"], "m2");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[2]["id"], "call-1");
    assert_eq!(messages[2]["role"], "tool_use");
    assert_eq!(messages[3]["id"], "call-1");
    assert_eq!(messages[3]["role"], "tool_result");
    assert_eq!(messages[3]["host"], "pi");
}

#[test]
fn test_list_merges_both_hosts_with_markers() {
    let oc_dir = TempDir::new().expect("temp oc dir");
    let pi_root = TempDir::new().expect("temp pi root");
    TestFixture::create_db(&oc_dir.path().join("opencode.db"));
    let lines = pi_events_session_lines();
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    // Auto (no --host/--db): both hosts merge; JSON rows carry the host
    // tag.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", oc_dir.path())
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "list", "--json"])
        .output()
        .expect("failed to run zfind list --json (both hosts)");
    assert!(
        output.status.success(),
        "merged list should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    // 2 opencode root sessions + 1 pi session (ses-003 is a child).
    assert_eq!(parsed["matches"], 3);
    let sessions = parsed["sessions"].as_array().unwrap();
    let ids: Vec<&str> = sessions
        .iter()
        .filter_map(|s| s.get("id").and_then(Value::as_str))
        .collect();
    for expected in ["ses-001", "ses-002", PI_UUID] {
        assert!(ids.contains(&expected), "missing {expected}: {ids:?}");
    }
    let hosts: Vec<&str> = sessions
        .iter()
        .filter_map(|s| s.get("host").and_then(Value::as_str))
        .collect();
    assert!(hosts.contains(&"opencode"), "opencode rows present");
    assert!(hosts.contains(&"pi"), "pi rows present");

    // Human-readable mode shows the host column too (wide COLUMNS so the
    // host names are not ellipsized).
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", oc_dir.path())
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .env("COLUMNS", "200")
        .args(["--no-color", "list"])
        .output()
        .expect("failed to run zfind list (both hosts, table)");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("opencode"),
        "table should contain the opencode host marker"
    );
    assert!(stdout.contains("pi"), "table should contain the pi host marker");
}

#[test]
fn test_pi_list_host_restricted() {
    let oc_dir = TempDir::new().expect("temp oc dir");
    let pi_root = TempDir::new().expect("temp pi root");
    TestFixture::create_db(&oc_dir.path().join("opencode.db"));
    let lines = pi_events_session_lines();
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    let output = Command::new(ZFIND_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", oc_dir.path())
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["--no-color", "--host", "pi", "list", "--json"])
        .output()
        .expect("failed to run zfind --host pi list --json");
    assert!(
        output.status.success(),
        "--host pi list should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    assert_eq!(parsed["matches"], 1);
    let sessions = parsed["sessions"].as_array().unwrap();
    assert_eq!(sessions[0]["id"], PI_UUID);
    assert_eq!(sessions[0]["host"], "pi");
}

#[test]
fn test_pi_message_lookup() {
    let pi_root = TempDir::new().expect("temp pi root");
    let lines = pi_events_session_lines();
    pi_data_dir(pi_root.path(), &[(PI_UUID, &lines)]);

    // Message-id lookup returns the user message.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["message", "m1", "--host", "pi", "--json"])
        .output()
        .expect("failed to run zfind message m1 --host pi --json");
    assert!(
        output.status.success(),
        "pi message should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    assert_eq!(parsed["matches"], 1);
    assert_eq!(parsed["messages"][0]["id"], "m1");
    assert_eq!(parsed["messages"][0]["role"], "user");
    assert_eq!(parsed["messages"][0]["host"], "pi");
    assert_eq!(parsed["messages"][0]["session_id"], PI_UUID);

    // Tool-call id lookup returns the use + result pair.
    let output = Command::new(ZFIND_BIN)
        .env("ZOO_PI_DATA_DIR", pi_root.path())
        .args(["message", "call-1", "--host", "pi", "--json"])
        .output()
        .expect("failed to run zfind message call-1 --host pi --json");
    assert!(
        output.status.success(),
        "pi toolCall message should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    assert_eq!(parsed["matches"], 2);
    assert_eq!(parsed["messages"][0]["role"], "assistant");
    assert_eq!(parsed["messages"][1]["role"], "tool");
    let parts0 = parsed["messages"][0]["parts"].as_array().unwrap();
    assert_eq!(parts0[0]["type"], "tool");
    assert_eq!(parts0[0]["tool"], "bash");
}

#[test]
fn test_db_implies_opencode_even_with_host_pi() {
    let fix = TestFixture::new();
    // --db names an OpenCode SQLite file, so it wins over --host pi.
    let output = fix
        .zfind()
        .args(["--host", "pi", "list", "--json"])
        .output()
        .expect("failed to run zfind --db <oc> --host pi list --json");
    assert!(
        output.status.success(),
        "--db + --host pi list should exit 0, got {:?}",
        output.status.code()
    );
    let parsed = parse_stdout_json(&output);
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(Value::as_str))
        .collect();
    assert!(ids.contains(&"ses-001"), "opencode sessions still listed");
    assert!(
        !ids.contains(&PI_UUID),
        "pi must not be consulted under an explicit --db"
    );
}
