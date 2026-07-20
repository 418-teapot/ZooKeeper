//! Integration tests for the `zfind` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Fixture-based tests
//! use a temporary SQLite database to exercise the full command
//! pipeline (search, list, show, message).

use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
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

        // msg-002: assistant turn with reasoning + tool
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"beaver"}"#,
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
        stdout.contains("Messages for session"),
        "output should contain 'Messages for session', got: {stdout}"
    );
    assert!(
        stdout.contains("ses-001"),
        "output should contain ses-001, got: {stdout}"
    );
    assert!(
        stdout.contains("msg-001"),
        "output should contain msg-001, got: {stdout}"
    );
}

#[test]
fn test_show_json() {
    let fix = TestFixture::new();
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
    assert_eq!(parsed["matches"], 2);
    let messages = parsed["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], "msg-001");
    assert_eq!(messages[1]["id"], "msg-002");
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
    // Should have agent field from message data
    assert_eq!(parsed["messages"][0]["agent"], "lynx");
}

#[test]
fn test_message_table() {
    let fix = TestFixture::new();
    // msg-004 has: text, tool, step-finish, custom_event →
    // exercises print_text_part, print_tool_part, step-finish skip,
    // and print_unknown_part
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
    // Agent should be shown (msg-004 has agent "lynx")
    assert!(
        stdout.contains("Agent: lynx"),
        "output should contain 'Agent: lynx', got: {stdout}"
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
    // Part rendering: tool part
    assert!(
        stdout.contains("Part 2 (tool:"),
        "output should contain tool part, got: {stdout}"
    );
    // Part rendering: unknown part type (step-finish is skipped, so
    // visible_idx goes text=1, tool=2, custom_event=3)
    assert!(
        stdout.contains("Part 3 (custom_event):"),
        "output should contain unknown part type, got: {stdout}"
    );
    // Step-finish should NOT appear
    assert!(
        !stdout.contains("step-finish"),
        "output should NOT contain step-finish, got: {stdout}"
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
