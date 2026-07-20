//! Integration tests for the `ztrace` CLI binary.
//!
//! These tests verify exit codes and CLI behavior by running the
//! compiled binary as an external process.  Fixture-based tests use a
//! temporary SQLite database to exercise the `steps`, `tokens`,
//! `show`, and `export` subcommands.
//!
//! Three data sources are simulated via the fixture: a SQLite database,
//! a ZooKeeper JSONL log (`~/.zoo/log/`), and the main opencode
//! key=value log (`~/.local/share/opencode/log/opencode.log`).

use std::fs;
use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
use tempfile::TempDir;

/// Path to the `ztrace` binary, set by `cargo test`.
const ZTRACE_BIN: &str = env!("CARGO_BIN_EXE_ztrace");

/// A DB path that is guaranteed not to exist.
const NO_DB: &str = "/tmp/ztrace-test-nonexistent.db";

// ── Basic CLI tests ──────────────────────────────────────────────────────────

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZTRACE_BIN)
        .arg("--help")
        .output()
        .expect("failed to run ztrace --help");
    assert!(
        output.status.success(),
        "ztrace --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
    assert!(stdout.contains("tokens"), "help should show 'tokens' subcommand");
}

#[test]
fn test_tokens_help_exits_0() {
    let output = Command::new(ZTRACE_BIN)
        .args(["tokens", "--help"])
        .output()
        .expect("failed to run ztrace tokens --help");
    assert!(
        output.status.success(),
        "ztrace tokens --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SESSION_ID"),
        "tokens --help should mention SESSION_ID positional arg"
    );
}

#[test]
fn test_no_subcommand_exits_1() {
    // No subcommand given → print help and exit 1 (consistent with
    // zfind, zinspect, zlog)
    let output = Command::new(ZTRACE_BIN)
        .output()
        .expect("failed to run ztrace with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "ztrace with no args should exit 1, got {:?}",
        output.status.code()
    );
}

#[test]
fn test_tokens_no_session_exits_2() {
    // tokens requires a session_id positional arg; clap exits 2 when
    // a required positional argument is missing.
    let output = Command::new(ZTRACE_BIN)
        .arg("tokens")
        .output()
        .expect("failed to run ztrace tokens with no session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace tokens with no session should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SESSION_ID"),
        "stderr should mention SESSION_ID, got: {stderr}"
    );
}

// ── Steps subcommand tests ────────────────────────────────────────────────────

#[test]
fn test_steps_help_exits_0() {
    let output = Command::new(ZTRACE_BIN)
        .args(["steps", "--help"])
        .output()
        .expect("failed to run ztrace steps --help");
    assert!(
        output.status.success(),
        "ztrace steps --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SESSION_ID"),
        "steps --help should mention SESSION_ID positional arg"
    );
    assert!(
        stdout.contains("min-cache-drop"),
        "steps --help should mention --min-cache-drop"
    );
    assert!(
        stdout.contains("hook-overlays"),
        "steps --help should mention --hook-overlays"
    );
}

#[test]
fn test_steps_no_session_exits_2() {
    let output = Command::new(ZTRACE_BIN)
        .arg("steps")
        .output()
        .expect("failed to run ztrace steps with no session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace steps with no session should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SESSION_ID"),
        "stderr should mention SESSION_ID, got: {stderr}"
    );
}

#[test]
fn test_steps_invalid_session_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "nonexistent-session"])
        .output()
        .expect("failed to run ztrace steps <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace steps <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_steps_ambiguous_prefix_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "ses-"])
        .output()
        .expect("failed to run ztrace steps ses-");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace steps ambiguous prefix should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ambiguous session ID prefix"),
        "stderr should mention 'ambiguous session ID prefix', got: {stderr}"
    );
}

#[test]
fn test_steps_table() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "ses-001"])
        .output()
        .expect("failed to run ztrace steps ses-001");
    assert!(
        output.status.success(),
        "steps ses-001 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table title
    assert!(
        stdout.contains("Step Token Timeline"),
        "table output should contain title, got: {stdout}"
    );
    // Column headers
    assert!(
        stdout.contains("Step"),
        "table output should contain Step column, got: {stdout}"
    );
    assert!(
        stdout.contains("Cache Read"),
        "table output should contain Cache Read column, got: {stdout}"
    );
    assert!(
        stdout.contains("Cache%"),
        "table output should contain Cache% column, got: {stdout}"
    );
    // Step indices should appear
    assert!(
        stdout.contains("1"),
        "output should contain step index 1, got: {stdout}"
    );
    assert!(
        stdout.contains("2"),
        "output should contain step index 2, got: {stdout}"
    );
    // Summary row
    assert!(
        stdout.contains("Total"),
        "output should contain Total summary row, got: {stdout}"
    );
    // Hook events from log file should appear (hook_overlays enabled by default)
    assert!(
        stdout.contains("task-prompt-validate"),
        "output should contain hook name from log, got: {stdout}"
    );
}

#[test]
fn test_steps_json() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "ses-001", "--json"])
        .output()
        .expect("failed to run ztrace steps ses-001 --json");
    assert!(
        output.status.success(),
        "steps ses-001 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");

    // Top-level keys
    assert!(parsed.get("steps").is_some(), "JSON should contain steps array");
    assert!(
        parsed.get("summary").is_some(),
        "JSON should contain summary object"
    );

    // steps array should have 2 entries (ses-001 has 2 step-finish parts)
    let steps = parsed["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2, "should have 2 steps");

    // Check first step
    assert_eq!(steps[0]["step"], 1);
    assert_eq!(steps[0]["session_id"], "ses-001");
    assert!(
        (steps[0]["cache_read"].as_f64().unwrap_or(0.0) - 30.0).abs() < 0.1,
        "cache_read should be ~30"
    );
    assert!(
        (steps[0]["input_tokens"].as_f64().unwrap_or(0.0) - 100.0).abs() < 0.1,
        "input_tokens should be ~100"
    );
    assert!(
        (steps[0]["output_tokens"].as_f64().unwrap_or(0.0) - 50.0).abs() < 0.1,
        "output_tokens should be ~50"
    );

    // Check second step (has tool "read" from part-005)
    assert_eq!(steps[1]["step"], 2);
    assert!(
        steps[1]["cache_pct"].as_f64().unwrap_or(0.0) > 0.0,
        "cache_pct should be > 0"
    );
    let tools = steps[1]["tools"].as_array().unwrap();
    assert!(
        tools.iter().any(|t| t.as_str() == Some("read")),
        "step 2 should have 'read' tool"
    );

    // Hooks should be present (hook_overlays enabled by default)
    let hooks0 = steps[0]["hooks"].as_array().unwrap();
    assert_eq!(hooks0.len(), 1, "step 1 should have 1 hook");
    assert_eq!(hooks0[0], "task-prompt-validate");

    let hooks1 = steps[1]["hooks"].as_array().unwrap();
    assert!(!hooks1.is_empty(), "step 2 should have hooks");

    // Summary structure
    let summary = &parsed["summary"];
    assert_eq!(
        summary["total_steps"].as_u64().unwrap_or(0),
        2,
        "total_steps should be 2"
    );
    assert!(
        summary["total_input"].as_f64().unwrap_or(0.0) > 0.0,
        "total_input should be > 0"
    );
    assert!(
        summary["total_hooks"].as_u64().unwrap_or(0) > 0,
        "total_hooks should be > 0"
    );
}

#[test]
fn test_steps_hook_overlays_false() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "ses-001", "--hook-overlays", "false"])
        .output()
        .expect("failed to run ztrace steps ses-001 --hook-overlays false");
    assert!(
        output.status.success(),
        "steps with hook_overlays false should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table output with no hook data — column still present but empty
    assert!(
        stdout.contains("Step Token Timeline"),
        "table output should contain title, got: {stdout}"
    );
    // Hook name should NOT appear
    assert!(
        !stdout.contains("task-prompt-validate"),
        "output should not contain hook name when overlays disabled, got: {stdout}"
    );
}

#[test]
fn test_steps_min_cache_drop_no_steps_remaining() {
    let fix = TestFixture::new();
    // All steps have positive delta_cache (10 and 50), so no step satisfies
    // delta_cache < -threshold for any positive threshold.
    let output = fix
        .ztrace()
        .args(["steps", "ses-001", "--min-cache-drop", "1"])
        .output()
        .expect("failed to run ztrace steps ses-001 --min-cache-drop 1");
    assert!(
        output.status.success(),
        "steps with --min-cache-drop should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("No steps to display"),
        "output should indicate no steps after filtering, got: {stdout}"
    );
}

#[test]
fn test_steps_min_cache_drop_json() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["steps", "ses-001", "--min-cache-drop", "1", "--json"])
        .output()
        .expect("failed to run ztrace steps ses-001 --min-cache-drop 1 --json");
    assert!(
        output.status.success(),
        "steps with --min-cache-drop --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    // Empty steps array
    let steps = parsed["steps"].as_array().unwrap();
    assert!(steps.is_empty(), "steps should be empty after filter");
    // Summary with 0 steps
    let summary = &parsed["summary"];
    assert_eq!(
        summary["total_steps"].as_u64().unwrap_or(999),
        0,
        "total_steps should be 0"
    );
}

#[test]
fn test_steps_empty_session() {
    let fix = TestFixture::new();
    // ses-002 has no step-finish parts → empty result
    let output = fix
        .ztrace()
        .args(["steps", "ses-002"])
        .output()
        .expect("failed to run ztrace steps ses-002");
    assert!(
        output.status.success(),
        "steps ses-002 (no steps) should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("No steps to display"),
        "empty session should show no steps message, got: {stdout}"
    );
}

#[test]
fn test_tokens_invalid_session_exits_2() {
    let output = Command::new(ZTRACE_BIN)
        .args(["--db", NO_DB, "tokens", "nonexistent-session"])
        .output()
        .expect("failed to run ztrace tokens <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace tokens <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_tokens_json_invalid_session_exits_2() {
    let output = Command::new(ZTRACE_BIN)
        .args(["--db", NO_DB, "--json", "tokens", "nonexistent"])
        .output()
        .expect("failed to run ztrace --json tokens <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "ztrace --json tokens <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

// ── Test Fixture ──────────────────────────────────────────────────────────────

/// A test fixture that provisions a temporary SQLite database and a home
/// directory with a `~/.zoo/log/` folder containing JSONL log files and
/// the main opencode log at `~/.local/share/opencode/log/opencode.log`.
///
/// The fixture is alive for the duration of the test (drop = cleanup).
struct TestFixture {
    /// Keeps the temp dir alive until the test ends.
    _db_dir: TempDir,
    /// Keeps the fake HOME alive until the test ends.
    _home_dir: TempDir,
    /// Absolute path to the SQLite database file.
    db_path: String,
    /// Absolute path to the fake HOME directory.
    home_path: String,
}

impl TestFixture {
    /// Create a new fixture with a populated database and log files.
    fn new() -> Self {
        let db_dir = TempDir::new().expect("create temp dir for db");
        let home_dir = TempDir::new().expect("create temp dir for home");

        // Create log directory structure: ~/.zoo/log/
        let log_dir = home_dir.path().join(".zoo").join("log");
        fs::create_dir_all(&log_dir).expect("create log dir");

        // Create opencode log directory: ~/.local/share/opencode/log/
        let opencode_log_dir = home_dir
            .path()
            .join(".local")
            .join("share")
            .join("opencode")
            .join("log");
        fs::create_dir_all(&opencode_log_dir).expect("create opencode log dir");

        let db_path = db_dir.path().join("opencode.db");
        let db_path_str = db_path.to_string_lossy().to_string();
        let home_path_str = home_dir.path().to_string_lossy().to_string();

        Self::create_db(&db_path);
        Self::create_log_file(&log_dir.join("opencode-ses-001.log"), "ses-001");
        Self::create_opencode_log_file(&opencode_log_dir.join("opencode.log"));

        Self {
            _db_dir: db_dir,
            _home_dir: home_dir,
            db_path: db_path_str,
            home_path: home_path_str,
        }
    }

    /// Build a `Command` that runs `ztrace` with HOME pointing at the
    /// fixture's temp home directory and `--db` set to the fixture's database.
    fn ztrace(&self) -> Command {
        let mut cmd = Command::new(ZTRACE_BIN);
        cmd.env("HOME", &self.home_path).env("COLUMNS", "200").args([
            "--db",
            &self.db_path,
            "--no-color",
        ]);
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
                r#"{"name":"deepseek-v4"}"#,
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

        // msg-001 (user role, text part + step-finish)
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

        // Text part for msg-001
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
        .expect("insert part-001");

        // Step-finish for msg-001 (filtered from segments, but counted in tokens)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-002", "msg-001", "ses-001",
                1_715_000_010_000_i64, 1_715_000_015_000_i64,
                concat!(
                    r#"{"type":"step-finish","#,
                    r#""tokens":{"input":100,"output":50,"cache":{"read":30,"write":10}},"cost":0.005}"#,
                ),
            ],
        )
        .expect("insert part-002");

        // msg-002 (assistant with tool → tool_use role_class)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"beaver","modelID":"gpt-4"}"#,
            ],
        )
        .expect("insert msg-002");

        // Text part for msg-002
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-003", "msg-002", "ses-001",
                1_715_000_020_000_i64, 1_715_000_020_000_i64,
                r#"{"type":"text","text":"Let me check the middleware file for auth issues"}"#,
            ],
        )
        .expect("insert part-003");

        // Step-finish for msg-002
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-004", "msg-002", "ses-001",
                1_715_000_020_000_i64, 1_715_000_025_000_i64,
                concat!(
                    r#"{"type":"step-finish","#,
                    r#""tokens":{"input":200,"output":100,"cache":{"read":80,"write":20}},"cost":0.008}"#,
                ),
            ],
        )
        .expect("insert part-004");

        // Tool part for msg-002
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-005", "msg-002", "ses-001",
                1_715_000_021_000_i64, 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts"},"output":{"content":"// auth middleware code"}}}"#,
            ],
        )
        .expect("insert part-005");

        // msg-003 (assistant without tool → "assistant" role_class)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-003",
                "ses-001",
                1_715_000_030_000_i64,
                r#"{"role":"assistant","agent":"beaver","modelID":"gpt-4"}"#,
            ],
        )
        .expect("insert msg-003");

        // Text part for msg-003 only (no tool parts)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-006", "msg-003", "ses-001",
                1_715_000_030_000_i64, 1_715_000_030_000_i64,
                r#"{"type":"text","text":"I found the issue in the auth middleware ordering"}"#,
            ],
        )
        .expect("insert part-006");

        // msg-004 (tool role → "tool_result" role_class)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-004",
                "ses-001",
                1_715_000_040_000_i64,
                r#"{"role":"tool","agent":"beaver"}"#,
            ],
        )
        .expect("insert msg-004");

        // Text part for msg-004
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-007", "msg-004", "ses-001",
                1_715_000_040_000_i64, 1_715_000_040_000_i64,
                r#"{"type":"text","text":"The auth middleware fix has been applied"}"#,
            ],
        )
        .expect("insert part-007");

        // ── ses-002 (root, empty — no messages) ───────────────────────────
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
                r#"{"name":"deepseek-v4"}"#,
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
                r#"{"name":"deepseek-v4"}"#,
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

    // ── Zoo JSONL log setup ─────────────────────────────────────────────

    fn create_log_file(path: &Path, session_id: &str) {
        // Timestamps are aligned with step time_created values:
        //   Step 1 (part-002, msg-001): 2024-05-06T12:53:30.000000Z
        //   Step 2 (part-004, msg-002): 2024-05-06T12:53:40.000000Z
        let lines = match session_id {
            "ses-001" => vec![
                // Before step 1 → matched to step 1
                r#"{"hook":"task-prompt-validate","event":"trigger","level":"info","timestamp":"2024-05-06T12:53:25Z","sessionId":"ses-001"}"#,
                // Between step 1 and step 2 → matched to step 2
                r#"{"hook":"json-error-nudge","event":"trigger","level":"warn","timestamp":"2024-05-06T12:53:36Z","sessionId":"ses-001","tool":"webfetch","pattern":"SyntaxError"}"#,
                // After step 2 → matched to last step (step 2)
                r#"{"hook":"context-metrics","event":"check","level":"info","timestamp":"2024-05-06T12:53:45Z","sessionId":"ses-001","estimated_tokens":1500}"#,
            ],
            _ => vec![],
        };

        let content = lines.join("\n");
        if !content.is_empty() {
            fs::write(path, &content).expect("write log file");
        }
    }

    // ── Opencode key=value log setup ─────────────────────────────────────

    /// Create the main opencode `key=value` log file at the expected path.
    ///
    /// Format: `shlex`-compatible `key=value` tokens (NOT JSON).
    /// Timestamps align with the fixture DB and zoo JSONL log:
    ///   step 1 (part-002):   2024-05-06T12:53:30.000000Z
    ///   step 2 (part-004):   2024-05-06T12:53:40.000000Z
    ///   zoo events:          12:53:25Z / 12:53:36Z / 12:53:45Z
    fn create_opencode_log_file(path: &Path) {
        // ── Alignment guide ─────────────────────────────────────────────
        // 12:53:20  message=created         id=ses-001
        // 12:53:28  llm runtime selected    ses-001
        // 12:53:30  stream                  ses-001
        // 12:53:31  loop step=1             ses-001
        // 12:53:32  process msg-001         ses-001
        // 12:53:30  [DB] msg-001 user
        // 12:53:35  evaluated (read: src/auth.ts)  ses-001
        // 12:53:36  [zoo] json-error-nudge
        // 12:53:40  [DB] msg-002 assistant
        // 12:53:42  touching file           ses-001
        // 12:53:45  [zoo] context-metrics
        // 12:53:50  exiting loop            ses-001
        // ────────────────────────────────────────────────────────────────
        let content = concat!(
            r#"message=created id=ses-001 run=run-001 "#,
            r#"slug=auth-middleware-debug agent=beaver "#,
            r#"model_id=deepseek-v4 model_providerID=deepseek "#,
            r#"title="auth middleware debug" "#,
            r#"cost=0.012 tokens_input=500 tokens_output=300 "#,
            r#"timestamp=2024-05-06T12:53:20Z"#,
            "\n",
            r#"message="llm runtime selected" "#,
            r#"timestamp=2024-05-06T12:53:28Z "#,
            r#"llm_provider=deepseek llm_model=deepseek-v4 "#,
            r#"llm_runtime=opencode session_id=ses-001"#,
            "\n",
            r#"message=stream timestamp=2024-05-06T12:53:30Z "#,
            r#"providerID=deepseek modelID=deepseek-v4 "#,
            r#"agent=beaver mode=full session_id=ses-001"#,
            "\n",
            r#"message=loop step=1 timestamp=2024-05-06T12:53:31Z "#,
            r#"session_id=ses-001"#,
            "\n",
            r#"message=process timestamp=2024-05-06T12:53:32Z "#,
            r#"messageID=msg-001 session_id=ses-001"#,
            "\n",
            r#"message=evaluated timestamp=2024-05-06T12:53:35Z "#,
            r#"permission=read pattern="src/auth.ts" "#,
            r#"action_action=allow duration=1.2 session_id=ses-001"#,
            "\n",
            r#"message="touching file" timestamp=2024-05-06T12:53:42Z "#,
            r#"file="src/auth.ts" action=edit session_id=ses-001"#,
            "\n",
            r#"message="exiting loop" timestamp=2024-05-06T12:53:50Z "#,
            r#"session_id=ses-001"#,
            "\n",
        );
        fs::write(path, content).expect("write opencode log file");
    }
}

// ── Fixture-based integration tests: tokens ───────────────────────────────────

#[test]
fn test_tokens_table() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["tokens", "ses-001"])
        .output()
        .expect("failed to run ztrace tokens ses-001");
    assert!(
        output.status.success(),
        "tokens ses-001 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table header
    assert!(
        stdout.contains("Message Token Distribution"),
        "table output should contain title, got: {stdout}"
    );
    // Column headers
    assert!(
        stdout.contains("Role"),
        "table output should contain Role column, got: {stdout}"
    );
    assert!(
        stdout.contains("Tokens"),
        "table output should contain Tokens column, got: {stdout}"
    );
    assert!(
        stdout.contains("ID"),
        "table output should contain ID column, got: {stdout}"
    );
    // Data rows — message IDs should appear
    assert!(
        stdout.contains("msg-001"),
        "output should contain msg-001, got: {stdout}"
    );
    assert!(
        stdout.contains("msg-002"),
        "output should contain msg-002, got: {stdout}"
    );
    assert!(
        stdout.contains("msg-003"),
        "output should contain msg-003, got: {stdout}"
    );
    assert!(
        stdout.contains("msg-004"),
        "output should contain msg-004, got: {stdout}"
    );
    // Role classifications in output
    assert!(
        stdout.contains("user"),
        "output should contain user role_class, got: {stdout}"
    );
    assert!(
        stdout.contains("tool_use"),
        "output should contain tool_use role_class, got: {stdout}"
    );
    assert!(
        stdout.contains("assistant"),
        "output should contain assistant role_class, got: {stdout}"
    );
    assert!(
        stdout.contains("tool_result"),
        "output should contain tool_result role_class, got: {stdout}"
    );
    // Footer stats summary
    assert!(
        stdout.contains("Total tokens"),
        "output should contain total tokens summary, got: {stdout}"
    );
}

#[test]
fn test_tokens_json() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["tokens", "ses-001", "--json"])
        .output()
        .expect("failed to run ztrace tokens ses-001 --json");
    assert!(
        output.status.success(),
        "tokens ses-001 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");

    // Top-level keys
    assert!(
        parsed.get("messages").is_some(),
        "JSON should contain messages array"
    );
    assert!(
        parsed.get("summary").is_some(),
        "JSON should contain summary object"
    );

    // messages array length
    let msgs = parsed["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 4, "should have 4 messages");

    // Check first message (user)
    assert_eq!(msgs[0]["id"], "msg-001");
    assert_eq!(msgs[0]["role"], "user");
    assert!(msgs[0]["tokens"].as_u64().unwrap() > 0);
    assert!(msgs[0]["preview"].as_str().unwrap().contains("auth"));

    // Second message (tool_use)
    assert_eq!(msgs[1]["id"], "msg-002");
    assert_eq!(msgs[1]["role"], "tool_use");
    assert!(msgs[1]["segments"].as_u64().unwrap() >= 2);
    assert!(msgs[1]["preview"].as_str().unwrap().contains("middleware"));

    // Third message (assistant)
    assert_eq!(msgs[2]["id"], "msg-003");
    assert_eq!(msgs[2]["role"], "assistant");

    // Fourth message (tool_result)
    assert_eq!(msgs[3]["id"], "msg-004");
    assert_eq!(msgs[3]["role"], "tool_result");

    // Summary structure
    let summary = &parsed["summary"];
    assert!(
        summary["total_tokens"].as_f64().unwrap_or(0.0) > 0.0,
        "total_tokens should be > 0"
    );
    assert!(
        summary.get("by_role").unwrap().is_object(),
        "by_role should be an object"
    );
    assert!(
        summary["avg_tokens_per_msg"].as_f64().unwrap_or(0.0) > 0.0,
        "avg_tokens_per_msg should be > 0"
    );
    assert!(
        summary["max_tokens"].as_f64().unwrap_or(0.0) > 0.0,
        "max_tokens should be > 0"
    );
    assert!(
        summary.get("largest_messages").unwrap().is_array(),
        "largest_messages should be an array"
    );
    assert!(
        summary["largest_messages"].as_array().unwrap().len() <= 3,
        "largest_messages should have at most 3 entries"
    );
    // empty_parts_count may be 0 since all parts have tokens > 0
    assert!(
        summary.get("empty_parts_count").is_some(),
        "JSON should contain empty_parts_count"
    );
}

#[test]
fn test_tokens_empty_session() {
    let fix = TestFixture::new();
    // ses-002 has no messages → empty result
    let output = fix
        .ztrace()
        .args(["tokens", "ses-002"])
        .output()
        .expect("failed to run ztrace tokens ses-002");
    assert!(
        output.status.success(),
        "tokens ses-002 (no messages) should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table output with empty rows — render_tokens_table returns early with no output
    assert!(
        stdout.trim().is_empty(),
        "empty session should produce no table output, got: {stdout}"
    );
}

#[test]
fn test_tokens_empty_session_json() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["tokens", "ses-002", "--json"])
        .output()
        .expect("failed to run ztrace tokens ses-002 --json");
    assert!(
        output.status.success(),
        "tokens ses-002 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    // Empty messages array
    let msgs = parsed["messages"].as_array().unwrap();
    assert!(msgs.is_empty(), "empty session should have empty messages array");
    // Summary should still be present with zero values
    let summary = &parsed["summary"];
    assert_eq!(
        summary["total_tokens"].as_f64().unwrap_or(-1.0),
        0.0,
        "total_tokens should be 0"
    );
    assert_eq!(
        summary["empty_parts_count"].as_u64().unwrap_or(999),
        0,
        "empty_parts_count should be 0"
    );
}

#[test]
fn test_tokens_ambiguous_prefix_exits_2() {
    let fix = TestFixture::new();
    // "ses-" matches ses-001, ses-002, ses-003 → ambiguous
    let output = fix
        .ztrace()
        .args(["tokens", "ses-"])
        .output()
        .expect("failed to run ztrace tokens ses-");
    assert_eq!(
        output.status.code(),
        Some(2),
        "tokens ambiguous prefix should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ambiguous session ID prefix"),
        "stderr should mention 'ambiguous session ID prefix', got: {stderr}"
    );
}

#[test]
fn test_tokens_ambiguous_prefix_json_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["tokens", "ses-", "--json"])
        .output()
        .expect("failed to run ztrace tokens ses- --json");
    assert_eq!(
        output.status.code(),
        Some(2),
        "tokens ambiguous prefix --json should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ambiguous session ID prefix"),
        "stderr should mention 'ambiguous session ID prefix', got: {stderr}"
    );
}

// ── Show subcommand tests ──────────────────────────────────────────────────────

#[test]
fn test_show_basic() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["show", "ses-001"])
        .output()
        .expect("failed to run ztrace show ses-001");
    assert!(
        output.status.success(),
        "show ses-001 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Session panel should show the slug
    assert!(
        stdout.contains("auth-middleware-debug"),
        "output should contain session slug, got: {stdout}"
    );
    // Ops summary should contain tool/event statistics
    assert!(
        stdout.contains("events"),
        "output should contain events summary, got: {stdout}"
    );
    // Session panel should show agent
    assert!(
        stdout.contains("beaver"),
        "output should contain agent name, got: {stdout}"
    );
}

#[test]
fn test_show_verbose() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["show", "ses-001", "-v"])
        .output()
        .expect("failed to run ztrace show ses-001 -v");
    assert!(
        output.status.success(),
        "show ses-001 -v should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Verbose panel should contain "Session ID:"
    assert!(
        stdout.contains("Session ID:"),
        "verbose output should contain 'Session ID:', got: {stdout}"
    );
    // Timeline table should show time entries
    assert!(
        stdout.contains("12:53:20"),
        "verbose output should contain timeline time, got: {stdout}"
    );
    // Timeline should show session created summary
    assert!(
        stdout.contains("Session"),
        "verbose output should contain 'Session', got: {stdout}"
    );
}

#[test]
fn test_show_json() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["show", "ses-001", "--json"])
        .output()
        .expect("failed to run ztrace show ses-001 --json");
    assert!(
        output.status.success(),
        "show ses-001 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON array");
    let events = parsed.as_array().expect("JSON output should be an array");
    assert!(!events.is_empty(), "timeline should contain events");
    // Each event should have timestamp and source
    for ev in events {
        assert!(
            ev.get("timestamp").is_some(),
            "each event should have a timestamp"
        );
        assert!(ev.get("source").is_some(), "each event should have a source");
    }
    // Should contain 'opencode', 'db', and 'zoo' source events
    let sources: Vec<&str> = events
        .iter()
        .filter_map(|ev| ev.get("source").and_then(|v| v.as_str()))
        .collect();
    assert!(
        sources.contains(&"opencode"),
        "JSON should contain opencode events, got: {sources:?}"
    );
    assert!(
        sources.contains(&"zoo"),
        "JSON should contain zoo events, got: {sources:?}"
    );
    assert!(
        sources.contains(&"db"),
        "JSON should contain db events, got: {sources:?}"
    );
}

#[test]
fn test_show_invalid_session_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["show", "nonexistent-session"])
        .output()
        .expect("failed to run ztrace show <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "show <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_show_ambiguous_prefix_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["show", "ses-"])
        .output()
        .expect("failed to run ztrace show ses-");
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

// ── Export subcommand tests ────────────────────────────────────────────────────

/// Helper: run export and verify success, output message, and file contents.
///
/// `extra_args` are appended after `-o <path>`.  `expected_labels` are
/// checked in stdout (e.g. "spans", "trace events").  `check_json`
/// receives the parsed output file for format-specific assertions.
fn run_export_test(
    fix: &TestFixture,
    output_path: &str,
    extra_args: &[&str],
    expected_labels: &[&str],
    check_json: fn(&serde_json::Value),
) {
    let mut args: Vec<&str> = vec!["export", "ses-001", "-o", output_path];
    args.extend_from_slice(extra_args);
    let output = fix
        .ztrace()
        .args(&args)
        .output()
        .unwrap_or_else(|e| panic!("failed to run ztrace export: {e}"));
    assert!(
        output.status.success(),
        "export ses-001 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Exported"),
        "output should contain 'Exported', got: {stdout}"
    );
    for label in expected_labels {
        assert!(
            stdout.contains(label),
            "output should contain '{label}', got: {stdout}"
        );
    }
    assert!(
        stdout.contains(output_path),
        "output should mention output path, got: {stdout}"
    );
    // Verify file was created and is valid JSON
    let file_content = fs::read_to_string(output_path).unwrap_or_else(|e| {
        panic!("export file should exist at {output_path}: {e}")
    });
    let doc: serde_json::Value = serde_json::from_str(&file_content)
        .unwrap_or_else(|e| panic!("export file should be valid JSON: {e}"));
    check_json(&doc);
}

#[test]
fn test_export_help_exits_0() {
    let output = Command::new(ZTRACE_BIN)
        .args(["export", "--help"])
        .output()
        .expect("failed to run ztrace export --help");
    assert!(
        output.status.success(),
        "ztrace export --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("SESSION_ID"),
        "export --help should mention SESSION_ID positional arg"
    );
    assert!(stdout.contains("format"), "export --help should mention --format");
    assert!(stdout.contains("output"), "export --help should mention --output");
}

#[test]
fn test_export_jaeger_default() {
    let fix = TestFixture::new();
    let dir = TempDir::new().expect("create temp dir for export");
    let output_path = dir.path().join("ztrace-export-jaeger.json");
    let output_path_str = output_path.to_string_lossy().to_string();
    run_export_test(&fix, &output_path_str, &[], &["spans"], |doc| {
        assert!(doc.get("data").is_some(), "Jaeger doc should contain 'data'");
    });
}

#[test]
fn test_export_chrome() {
    let fix = TestFixture::new();
    let dir = TempDir::new().expect("create temp dir for export");
    let output_path = dir.path().join("ztrace-export-chrome.json");
    let output_path_str = output_path.to_string_lossy().to_string();
    run_export_test(
        &fix,
        &output_path_str,
        &["--format", "chrome"],
        &["trace events"],
        |doc| {
            let events =
                doc.as_array().expect("chrome trace should be a JSON array");
            assert!(!events.is_empty(), "chrome trace should have events");
            for ev in events {
                assert!(
                    ev.get("name").is_some(),
                    "chrome event should have 'name'"
                );
                assert_eq!(
                    ev.get("ph").and_then(|v| v.as_str()),
                    Some("X"),
                    "chrome event should have ph='X'"
                );
            }
        },
    );
}

#[test]
fn test_export_json_envelope() {
    let fix = TestFixture::new();
    let dir = TempDir::new().expect("create temp dir for export");
    let output_path = dir.path().join("ztrace-export-envelope.json");
    let output_path_str = output_path.to_string_lossy().to_string();
    let output = fix
        .ztrace()
        .args(["export", "ses-001", "--json", "-o", &output_path_str])
        .output()
        .expect("failed to run ztrace export ses-001 --json");
    assert!(
        output.status.success(),
        "export ses-001 --json should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope_start =
        stdout.rfind('{').expect("stdout should contain JSON envelope");
    let envelope_str = &stdout[envelope_start..];
    let parsed: serde_json::Value = serde_json::from_str(envelope_str)
        .expect("JSON envelope should be valid JSON");
    assert_eq!(parsed["status"].as_str(), Some("ok"), "status should be 'ok'");
    assert!(parsed.get("format").is_some(), "envelope should contain format");
    assert!(
        parsed.get("events").is_some(),
        "envelope should contain events count"
    );
}

#[test]
fn test_export_no_session_exits_2() {
    let output = Command::new(ZTRACE_BIN)
        .arg("export")
        .output()
        .expect("failed to run ztrace export with no session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "export with no session should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SESSION_ID"),
        "stderr should mention SESSION_ID, got: {stderr}"
    );
}

#[test]
fn test_export_invalid_session_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["export", "nonexistent-session"])
        .output()
        .expect("failed to run ztrace export <invalid>");
    assert_eq!(
        output.status.code(),
        Some(2),
        "export <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no session found matching"),
        "stderr should mention 'no session found matching', got: {stderr}"
    );
}

#[test]
fn test_export_ambiguous_prefix_exits_2() {
    let fix = TestFixture::new();
    let output = fix
        .ztrace()
        .args(["export", "ses-"])
        .output()
        .expect("failed to run ztrace export ses-");
    assert_eq!(
        output.status.code(),
        Some(2),
        "export ambiguous prefix should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ambiguous session ID prefix"),
        "stderr should mention 'ambiguous session ID prefix', got: {stderr}"
    );
}
