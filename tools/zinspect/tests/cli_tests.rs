//! Integration tests for the `zinspect` CLI binary.
//!
//! These tests verify exit codes and basic CLI behavior by running
//! the compiled binary as an external process.  Fixture-based tests
//! use a temporary SQLite database and log directory to exercise the
//! full command pipeline (stats, timeline, impact).

use std::fs;
use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
use tempfile::TempDir;

/// Path to the `zinspect` binary, set by `cargo test`.
const ZINSPECT_BIN: &str = env!("CARGO_BIN_EXE_zinspect");

// ── Test Fixture ──────────────────────────────────────────────────────────────

/// A test fixture that provisions a temporary SQLite database and a home
/// directory with a `~/.zoo/log/` folder containing JSONL log files.
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

        let db_path = db_dir.path().join("opencode.db");
        let db_path_str = db_path.to_string_lossy().to_string();
        let home_path_str = home_dir.path().to_string_lossy().to_string();

        Self::create_db(&db_path);
        Self::create_log_file(&log_dir.join("opencode-ses-001.log"), "ses-001");
        // ses-002 is a pi-hosted session: its log lives in `pi-ses-002.log`
        // and must be found through the pi prefix.
        Self::create_log_file(&log_dir.join("pi-ses-002.log"), "ses-002");
        Self::create_log_file(&log_dir.join("opencode-ses-003.log"), "ses-003");

        Self {
            _db_dir: db_dir,
            _home_dir: home_dir,
            db_path: db_path_str,
            home_path: home_path_str,
        }
    }

    /// Build a `Command` that runs `zinspect` with HOME pointing at the
    /// fixture's temp home directory and `--db` set to the fixture's database.
    fn zinspect(&self) -> Command {
        let mut cmd = Command::new(ZINSPECT_BIN);
        cmd.env("HOME", &self.home_path).args(["--db", &self.db_path]);
        cmd
    }

    // ── Database setup ────────────────────────────────────────────────────

    fn create_db(path: &Path) {
        let conn = Connection::open(path).expect("open test db");

        // Session table (same schema as zutil::test_db::create_common_tables)
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

        // ── ses-001 ───────────────────────────────────────────────────────
        conn.execute(
            "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                "ses-001",
                Option::<&str>::None,
                "auth middleware debug",
                "auth-middleware-debug",
                "beaver",
                "/app",
                r#"{"name":"deepseek-v4"}"#,
                1_715_000_000_000_i64,  // time_created
                1_715_000_100_000_i64,  // time_updated
                0.012,                  // cost
                500.0,                  // tokens_input
                300.0,                  // tokens_output
                0.0,                    // tokens_reasoning
                0.0,                    // tokens_cache_read
                0.0,                    // tokens_cache_write
            ],
        )
        .expect("insert ses-001");

        // Message for ses-001 (user turn)
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

        // Message for ses-001 (assistant turn with time info)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002", "ses-001", 1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"beaver","time":{"created":1715000020000,"completed":1715000090000}}"#,
            ],
        ).expect("insert msg-002");

        // Part: step-finish for msg-001 (step 1)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-001", "msg-001", "ses-001",
                1_715_000_010_000_i64, 1_715_000_015_000_i64,
                r#"{"type":"step-finish","tokens":{"input":100,"output":50,"cache":{"read":30,"write":10}},"cost":0.005,"reason":"completed"}"#,
            ],
        ).expect("insert part-001 (step-finish)");

        // Part: tool for msg-001
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-002", "msg-001", "ses-001",
                1_715_000_011_000_i64, 1_715_000_011_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts"}}}"#,
            ],
        ).expect("insert part-002 (tool)");

        // Part: step-finish for msg-002 (step 2)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-003", "msg-002", "ses-001",
                1_715_000_020_000_i64, 1_715_000_025_000_i64,
                r#"{"type":"step-finish","tokens":{"input":200,"output":100,"cache":{"read":80,"write":20}},"cost":0.008,"reason":"completed"}"#,
            ],
        ).expect("insert part-003 (step-finish)");

        // Part: tool for msg-002
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-004", "msg-002", "ses-001",
                1_715_000_021_000_i64, 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"edit","state":{"input":{"filePath":"src/auth.ts"}}}"#,
            ],
        ).expect("insert part-004 (tool)");

        // ── ses-002 ───────────────────────────────────────────────────────
        conn.execute(
            "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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

        // Message for ses-002
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

        // Part: step-finish for msg-003
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-005", "msg-003", "ses-002",
                1_715_000_210_000_i64, 1_715_000_220_000_i64,
                r#"{"type":"step-finish","tokens":{"input":200,"output":100,"cache":{"read":50,"write":20}},"cost":0.003,"reason":"completed"}"#,
            ],
        ).expect("insert part-005 (step-finish)");

        // ── ses-003 (pruning-heavy session) ────────────────────────────────
        conn.execute(
            "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                "ses-003",
                Option::<&str>::None,
                "context pruning reclamation",
                "context-pruning",
                "beaver",
                "/app",
                r#"{"name":"deepseek-v4"}"#,
                1_715_000_400_000_i64,  // time_created
                1_715_000_500_000_i64,  // time_updated (newest → first in multi-session ordering)
                0.02,                   // cost
                400.0,                  // tokens_input
                200.0,                  // tokens_output
                0.0,                    // tokens_reasoning
                0.0,                    // tokens_cache_read
                0.0,                    // tokens_cache_write
            ],
        )
        .expect("insert ses-003");

        // Message for ses-003
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-004",
                "ses-003",
                1_715_000_410_000_i64,
                r#"{"role":"user","agent":"beaver"}"#,
            ],
        )
        .expect("insert msg-004");

        // Part: step-finish for msg-004. Gives ses-003 step data so the
        // single-session pruning branch does not print the "No step-finish
        // records" warning (which would pollute JSON stdout).
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-006", "msg-004", "ses-003",
                1_715_000_410_000_i64, 1_715_000_415_000_i64,
                r#"{"type":"step-finish","tokens":{"input":300,"output":150,"cache":{"read":100,"write":30}},"cost":0.009,"reason":"completed"}"#,
            ],
        ).expect("insert part-006 (step-finish)");

        conn.close().expect("close test db");
    }

    // ── Log file setup ────────────────────────────────────────────────────

    fn create_log_file(path: &Path, session_id: &str) {
        let lines = match session_id {
            "ses-001" => vec![
                r#"{"hook":"task-prompt","event":"validate","level":"info","timestamp":"2025-01-09T12:00:00Z","sessionId":"ses-001","warnings":0,"errors":0}"#,
                r#"{"hook":"json-error-nudge","event":"trigger","level":"warn","timestamp":"2025-01-09T12:01:00Z","sessionId":"ses-001","tool":"webfetch","pattern":"SyntaxError"}"#,
                r#"{"hook":"direct-work-nudge","event":"trigger","level":"info","timestamp":"2025-01-09T12:02:00Z","sessionId":"ses-001","tool":"edit"}"#,
                r#"{"hook":"post-task-nudge","event":"trigger","level":"info","timestamp":"2025-01-09T12:03:00Z","sessionId":"ses-001","todo_state":"pending","nudge":"beaver"}"#,
                r#"{"hook":"context-metrics","event":"check","level":"info","timestamp":"2025-01-09T12:04:00Z","sessionId":"ses-001","estimated_tokens":1500,"message_count":3,"exact_tokens":1200,"estimated_new_tokens":300}"#,
                r#"{"hook":"plugin","event":"load","level":"info","timestamp":"2025-01-09T12:05:00Z","sessionId":"ses-001","agents":["beaver","lynx"],"skills":["git-commit"]}"#,
                r#"{"hook":"task-prompt","event":"trigger","level":"info","timestamp":"2025-01-09T12:06:00Z","sessionId":"ses-001","warnings":1,"errors":0}"#,
            ],
            "ses-002" => vec![
                r#"{"hook":"task-prompt","event":"validate","level":"info","timestamp":"2025-01-09T14:00:00Z","sessionId":"ses-002","warnings":0,"errors":0}"#,
            ],
            // Pruning fixture: covers all five event families consumed by
            // `build_pruning_summary`. Two `prune_completed` events verify
            // last-wins snapshot semantics; `sweep_marked` uses the
            // `totalEstimatedTokens` key; one `marks_released` is forced.
            "ses-003" => vec![
                r#"{"hook":"context-pruning","event":"prune_completed","level":"info","timestamp":"2025-01-09T16:00:00Z","sessionId":"ses-003","totalReclaimedTokens":5000,"prunedToolCount":5}"#,
                r#"{"hook":"context-pruning","event":"dedup_marked","level":"info","timestamp":"2025-01-09T16:01:00Z","sessionId":"ses-003","markedCount":40,"markedTokens":4000}"#,
                r#"{"hook":"context-pruning","event":"sweep_marked","level":"info","timestamp":"2025-01-09T16:02:00Z","sessionId":"ses-003","markedCount":60,"totalEstimatedTokens":6000}"#,
                r#"{"hook":"context-pruning","event":"purge-errors_marked","level":"warn","timestamp":"2025-01-09T16:03:00Z","sessionId":"ses-003","markedCount":20,"markedTokens":2000}"#,
                r#"{"hook":"context-pruning","event":"marks_released","level":"info","timestamp":"2025-01-09T16:04:00Z","sessionId":"ses-003","releasedCount":30,"releasedTokens":3000}"#,
                r#"{"hook":"context-pruning","event":"marks_released","level":"info","timestamp":"2025-01-09T16:05:00Z","sessionId":"ses-003","releasedCount":20,"releasedTokens":2000,"forced":"view_change"}"#,
                r#"{"hook":"context-pruning","event":"prune_completed","level":"info","timestamp":"2025-01-09T16:06:00Z","sessionId":"ses-003","totalReclaimedTokens":12000,"prunedToolCount":12}"#,
                r#"{"hook":"context-pruning","event":"compress_created","level":"info","timestamp":"2025-01-09T16:07:00Z","sessionId":"ses-003","blockId":"blk-1","messageCount":10,"inTokens":10000,"outTokens":2000}"#,
            ],
            _ => vec![],
        };

        let content = lines.join("\n");
        if !content.is_empty() {
            fs::write(path, &content).expect("write log file");
        }
    }
}

// ── Basic CLI tests ──────────────────────────────────────────────────────────

#[test]
fn test_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .arg("--help")
        .output()
        .expect("failed to run zinspect --help");
    assert!(
        output.status.success(),
        "zinspect --help should exit 0, got {}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ZooKeeper"), "help should mention 'ZooKeeper'");
}

#[test]
fn test_stats_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["stats", "--help"])
        .output()
        .expect("failed to run zinspect stats --help");
    assert!(
        output.status.success(),
        "zinspect stats --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_timeline_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["timeline", "--help"])
        .output()
        .expect("failed to run zinspect timeline --help");
    assert!(
        output.status.success(),
        "zinspect timeline --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_impact_help_exits_0() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["impact", "--help"])
        .output()
        .expect("failed to run zinspect impact --help");
    assert!(
        output.status.success(),
        "zinspect impact --help should exit 0, got {}",
        output.status
    );
}

#[test]
fn test_no_subcommand_exits_1() {
    let output = Command::new(ZINSPECT_BIN)
        .output()
        .expect("failed to run zinspect with no args");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zinspect with no args should exit 1"
    );
}

#[test]
fn test_stats_no_session_exits_1() {
    let output = Command::new(ZINSPECT_BIN)
        .arg("stats")
        .output()
        .expect("failed to run zinspect stats with no session");
    assert_eq!(
        output.status.code(),
        Some(1),
        "zinspect stats with no session should exit 1"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("provide a session_id"),
        "stderr should mention 'provide a session_id', got: {stderr}"
    );
}

#[test]
fn test_stats_invalid_session_exits_2() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["stats", "nonexistent-session-xyz-123"])
        .output()
        .expect("failed to run zinspect stats with invalid session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zinspect stats <invalid> should exit 2, got {:?}",
        output.status.code()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no unique log file"),
        "stderr should mention 'no unique log file', got: {stderr}"
    );
}

#[test]
fn test_timeline_invalid_session_exits_2() {
    let output = Command::new(ZINSPECT_BIN)
        .args(["timeline", "nonexistent-session-xyz-123"])
        .output()
        .expect("failed to run zinspect timeline with invalid session");
    assert_eq!(
        output.status.code(),
        Some(2),
        "zinspect timeline <invalid> should exit 2, got {:?}",
        output.status.code()
    );
}

#[test]
fn test_impact_with_json_output_is_valid_json() {
    let output = Command::new(ZINSPECT_BIN)
        .args([
            "impact",
            "--sessions",
            "1",
            "--json",
            "--no-color",
            "--db",
            "/tmp/zinspect-test-nonexistent.db",
        ])
        .output()
        .expect("failed to run zinspect impact --sessions 1 --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        let parsed: Result<serde_json::Value, _> =
            serde_json::from_str(stdout.trim());
        assert!(parsed.is_ok(), "Output should be valid JSON, got: {stdout}");
    }
}

#[test]
fn test_stats_sessions_no_db_is_valid_json() {
    let output = Command::new(ZINSPECT_BIN)
        .args([
            "stats",
            "--sessions",
            "5",
            "--json",
            "--no-color",
            "--db",
            "/tmp/zinspect-test-nonexistent.db",
        ])
        .output()
        .expect("failed to run zinspect stats with custom db");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
}

// ── Fixture-based integration tests ──────────────────────────────────────────

#[test]
fn test_stats_single_session_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["session_id"], "ses-001");
    assert_eq!(parsed["total_events"], 7);
    assert!(parsed["hook_breakdown"].is_object());
    assert!(parsed["token_summary"].is_object());
}

#[test]
fn test_stats_single_session_tokens_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--tokens", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --tokens --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert!(parsed.get("total_input").is_some());
    assert!(parsed.get("total_output").is_some());
}

#[test]
fn test_stats_single_session_hooks_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--hooks", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --hooks --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["session_id"], "ses-001");
    assert!(parsed["hook_breakdown"].is_object());
}

#[test]
fn test_stats_single_session_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table output should contain the session ID and some key labels
    assert!(stdout.contains("ses-001"), "output should contain session ID");
    assert!(
        stdout.contains("Stats for session"),
        "output should contain stats header"
    );
}

#[test]
fn test_stats_multi_session_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "--sessions", "5", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats --sessions 5 --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let sessions =
        parsed["sessions"].as_array().expect("sessions should be an array");
    assert!(!sessions.is_empty(), "should have at least one session");
    assert!(parsed["total"].is_object());
}

#[test]
fn test_stats_multi_session_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "--sessions", "5", "--no-color"])
        .output()
        .expect("failed to run zinspect stats --sessions 5 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Cross-Session"),
        "table output should contain cross-session title"
    );
}

#[test]
fn test_timeline_valid_session() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["timeline", "ses-001", "--no-color"])
        .output()
        .expect("failed to run zinspect timeline ses-001 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Timeline"),
        "output should contain Timeline header"
    );
    assert!(stdout.contains("ses-001"), "output should contain session ID");
}

#[test]
fn test_timeline_all_events() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["timeline", "ses-001", "--all-events", "--no-color"])
        .output()
        .expect(
            "failed to run zinspect timeline ses-001 --all-events --no-color",
        );
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Timeline"),
        "output should contain Timeline header"
    );
}

#[test]
fn test_impact_single_session_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "ses-001", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect impact ses-001 --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert!(parsed["sessions_analyzed"].is_array());
    assert!(!parsed["sessions_analyzed"].as_array().unwrap().is_empty());
    assert!(parsed["hook_aggregation"].is_object());
    assert!(parsed["recovery_curve"].is_array());
}

#[test]
fn test_impact_single_session_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "ses-001", "--no-color"])
        .output()
        .expect("failed to run zinspect impact ses-001 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Table output should contain hook names and analysis data. The
    // aggregation now groups by `hook:event` composite keys, so the header
    // reads "Hook:Event" (rendered in full at the default 80-col width).
    assert!(stdout.contains("task-prompt"), "output should contain hook name");
    assert!(
        stdout.contains("Hook:Event"),
        "output should contain Hook:Event column header"
    );
}

#[test]
fn test_impact_with_cost_and_verbose_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args([
            "impact",
            "ses-001",
            "--json",
            "--no-color",
            "--cost",
            "--verbose",
        ])
        .output()
        .expect(
            "failed to run zinspect impact ses-001 --json --cost --verbose",
        );
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert!(
        parsed.get("cost_impact").is_some(),
        "JSON should contain cost_impact"
    );
    assert!(
        parsed.get("verbose").is_some(),
        "JSON should contain verbose field"
    );
}

#[test]
fn test_impact_with_cost_and_verbose_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "ses-001", "--no-color", "--cost", "--verbose"])
        .output()
        .expect("failed to run zinspect impact ses-001 --cost --verbose");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Before Cost"),
        "table output should contain cost section"
    );
}

#[test]
fn test_impact_with_hook_filter() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args([
            "impact",
            "ses-001",
            "--json",
            "--no-color",
            "--hook",
            "task-prompt",
        ])
        .output()
        .expect("failed to run zinspect impact ses-001 --hook task-prompt");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let agg = parsed["hook_aggregation"].as_object().unwrap();
    // Aggregation keys are `hook:event` composite keys, so assert on the
    // composite form instead of the bare hook name.
    assert!(agg.contains_key("task-prompt:validate"));
    assert!(agg.contains_key("task-prompt:trigger"));
    // Every key must carry the filtered hook prefix — nothing from other
    // hooks should survive the filter.
    assert!(
        agg.keys().all(|k| k.starts_with("task-prompt:")),
        "all keys should start with the filtered hook prefix, got: {agg:?}"
    );
    assert!(!agg.contains_key("json-error-nudge"));
}

#[test]
fn test_impact_multi_session_json() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "--sessions", "5", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect impact --sessions 5 --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert!(parsed["sessions_analyzed"].is_array());
    assert!(!parsed["sessions_analyzed"].as_array().unwrap().is_empty());
}

#[test]
fn test_impact_multi_session_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "--sessions", "5", "--no-color"])
        .output()
        .expect("failed to run zinspect impact --sessions 5 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("task-prompt") || stdout.contains("json-error-nudge"),
        "output should contain hook names"
    );
}

#[test]
fn test_stats_single_session_tokens_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--tokens", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --tokens --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Total input tokens"),
        "table output should contain token summary"
    );
}

#[test]
fn test_stats_single_session_hooks_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--hooks", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --hooks --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Hook") || stdout.contains("task-prompt"),
        "table output should contain hook breakdown"
    );
}

#[test]
fn test_stats_single_session_pi_hosted_json() {
    let fix = TestFixture::new();
    // ses-002's log lives in `pi-ses-002.log`; stats must resolve it
    // through the pi prefix and surface the session's hook events.
    let output = fix
        .zinspect()
        .args(["stats", "ses-002", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-002 --json");
    assert!(
        output.status.success(),
        "stats pi-hosted ses-002 should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["session_id"], "ses-002");
    assert_eq!(parsed["total_events"], 1);
}

#[test]
fn test_impact_single_session_custom_window() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["impact", "ses-001", "--json", "--no-color", "--window", "3"])
        .output()
        .expect("failed to run zinspect impact ses-001 --window 3");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["window"], 3);
}

#[test]
fn test_impact_no_hooks_empty_db() {
    // No sessions in the DB at all → should print warning
    let output = Command::new(ZINSPECT_BIN)
        .args([
            "impact",
            "--sessions",
            "5",
            "--json",
            "--no-color",
            "--db",
            "/tmp/zinspect-test-nonexistent-2.db",
        ])
        .output()
        .expect("failed to run zinspect impact --sessions 5");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    assert_eq!(parsed["sessions_analyzed"].as_array().unwrap().len(), 0);
}

#[test]
fn test_impact_no_hooks_empty_db_table() {
    // No sessions in the DB at all → should print warning (table path)
    let output = Command::new(ZINSPECT_BIN)
        .args([
            "impact",
            "--sessions",
            "5",
            "--no-color",
            "--db",
            "/tmp/zinspect-test-nonexistent-3.db",
        ])
        .output()
        .expect("failed to run zinspect impact --sessions 5");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("No sessions"),
        "output should contain 'No sessions' warning"
    );
}

// ── Pruning stats integration tests ───────────────────────────────────────────

/// Run `stats <id> --pruning --json` on the pruning fixture session and
/// return the parsed JSON.
fn run_pruning_json(fix: &TestFixture, session_id: &str) -> serde_json::Value {
    let output = fix
        .zinspect()
        .args(["stats", session_id, "--pruning", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats <id> --pruning --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).expect("output should be valid JSON")
}

#[test]
fn test_stats_single_session_pruning_json() {
    let fix = TestFixture::new();
    let parsed = run_pruning_json(&fix, "ses-003");

    // Reclaimed: last prune_completed snapshot wins (5000 → 12000).
    assert_eq!(parsed["reclaimed"]["tokens"], 12000);
    assert_eq!(parsed["reclaimed"]["tools"], 12);

    // Marked: dedup (markedTokens), sweep (totalEstimatedTokens),
    // purge-errors (markedTokens) grouped by producer.
    let marked = &parsed["marked"];
    assert_eq!(marked["by_producer"]["dedup"]["count"], 40);
    assert_eq!(marked["by_producer"]["dedup"]["tokens"], 4000);
    assert_eq!(marked["by_producer"]["sweep"]["count"], 60);
    assert_eq!(marked["by_producer"]["sweep"]["tokens"], 6000);
    assert_eq!(marked["by_producer"]["purge-errors"]["count"], 20);
    assert_eq!(marked["by_producer"]["purge-errors"]["tokens"], 2000);
    assert_eq!(marked["total_count"], 120);
    assert_eq!(marked["total_tokens"], 12000);

    // Released: 2 batches, 50 tools / 5000 tokens, one forced.
    assert_eq!(parsed["released"]["batches"], 2);
    assert_eq!(parsed["released"]["count"], 50);
    assert_eq!(parsed["released"]["tokens"], 5000);
    assert_eq!(parsed["released"]["forced"], 1);

    // Compress blocks: 10000 in → 2000 out → 5.0x ratio, 80% reduction.
    let compress = &parsed["compress_blocks"];
    assert_eq!(compress["blocks"], 1);
    assert_eq!(compress["messages"], 10);
    assert_eq!(compress["in_tokens"], 10000);
    assert_eq!(compress["out_tokens"], 2000);
    assert_eq!(compress["ratio"].as_f64().unwrap(), 5.0);
    assert_eq!(compress["reduction_pct"].as_f64().unwrap(), 80.0);
}

#[test]
fn test_stats_single_session_pruning_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-003", "--pruning", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-003 --pruning --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // All four groups must be rendered: reclaimed / marked / released /
    // compress blocks.
    assert!(
        stdout.contains("Pruning Reclamation"),
        "output should contain section title"
    );
    assert!(stdout.contains("Reclaimed tokens"));
    assert!(stdout.contains("Pruned tools"));
    assert!(stdout.contains("Marked count (dedup)"));
    assert!(stdout.contains("Marked count (sweep)"));
    assert!(stdout.contains("Marked total count"));
    assert!(stdout.contains("Release batches"));
    assert!(stdout.contains("Forced batches"));
    assert!(stdout.contains("Compress blocks"));
    assert!(stdout.contains("Compression ratio"));
}

#[test]
fn test_stats_single_session_pruning_no_events_hint() {
    // `--pruning` on a session without pruning events prints a hint
    // instead of an empty table.
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--pruning", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --pruning --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("No pruning events found"),
        "output should contain the no-pruning hint"
    );
}

#[test]
fn test_stats_pruning_tokens_fallthrough_full_report() {
    // `--pruning --tokens` selects two sections, so the single-section
    // branches are skipped and the command falls back to the full report.
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-003", "--pruning", "--tokens", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-003 --pruning --tokens");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Stats for session"),
        "multi-flag stats should render the full report header"
    );
    assert!(
        stdout.contains("Total input tokens"),
        "full report should include the token summary section"
    );
    assert!(
        stdout.contains("Pruning Reclamation"),
        "full report for a pruning session should include the pruning section"
    );
}

#[test]
fn test_stats_full_report_includes_pruning_section() {
    // No flag → full report; the pruning section appears only for sessions
    // that contain pruning events.
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-003", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-003 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Pruning Reclamation"),
        "full report for a pruning session should include the pruning section"
    );
}

#[test]
fn test_stats_full_report_excludes_pruning_section() {
    // ses-001 has no pruning events → the full report must not render the
    // pruning section at all.
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "ses-001", "--no-color"])
        .output()
        .expect("failed to run zinspect stats ses-001 --no-color");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("Pruning Reclamation"),
        "full report for a non-pruning session should omit the pruning section"
    );
}

#[test]
fn test_stats_multi_session_pruning_json() {
    // Multi-session mode queries sessions from the DB (ordered by
    // time_updated DESC) and parses each session's JSONL once.
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "--sessions", "3", "--pruning", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats --sessions 3 --pruning --json");
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let sessions = parsed["pruning"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 3, "one row per session in the DB");

    // ses-003 is the newest session and the only one with pruning events.
    let s3 = sessions
        .iter()
        .find(|s| s.get("id").and_then(|v| v.as_str()) == Some("ses-003"))
        .expect("should contain a ses-003 row");
    assert_eq!(s3["summary"]["reclaimed"]["tokens"], 12000);
    assert_eq!(s3["summary"]["released"]["count"], 50);

    // Sessions without pruning events get a null summary.
    for sid in ["ses-001", "ses-002"] {
        let row = sessions
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(sid))
            .unwrap_or_else(|| panic!("should contain a {sid} row"));
        assert_eq!(row["summary"], serde_json::Value::Null);
    }

    // Totals aggregate numeric fields across all sessions.
    let total = &parsed["pruning"]["total"];
    assert_eq!(total["reclaimed_tokens"], 12000);
    assert_eq!(total["marked_count"], 120);
    assert_eq!(total["marked_tokens"], 12000);
    assert_eq!(total["released_count"], 50);
    assert_eq!(total["released_tokens"], 5000);
    assert_eq!(total["blocks"], 1);
}

#[test]
fn test_stats_multi_session_pruning_table() {
    let fix = TestFixture::new();
    let output = fix
        .zinspect()
        .args(["stats", "--sessions", "3", "--pruning", "--no-color"])
        .output()
        .expect(
            "failed to run zinspect stats --sessions 3 --pruning --no-color",
        );
    assert!(
        output.status.success(),
        "should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Cross-Session Pruning Reclamation"),
        "output should contain the cross-session pruning title"
    );
    assert!(stdout.contains("ses-003"), "output should list ses-003");
    assert!(stdout.contains("Total"), "output should contain totals row");
}

// ── Default aggregation across multiple databases ───────────────────────────

/// Build a temp data dir with both fixture DBs and a temp HOME, and
/// return (dir, home_dir) so the test can set both env vars.
fn two_db_env() -> (TempDir, String) {
    let dir = TempDir::new().expect("create temp data dir");
    let home = TempDir::new().expect("create temp home dir");
    TestFixture::create_db(&dir.path().join("opencode.db"));
    zutil::test_db::create_second_db(&dir.path().join("opencode-stable.db"));

    // The aggregate fixture has no JSONL logs for ses-900; seed a log dir
    // so log resolution returns empty events instead of globbing the real
    // home directory.
    let _ = fs::create_dir_all(home.path().join(".zoo").join("log"));

    let home_dir = home.path().to_string_lossy().to_string();
    (dir, home_dir)
}

#[test]
fn test_stats_default_aggregates_two_databases() {
    let (dir, home) = two_db_env();
    let data_dir = dir.path().to_string_lossy().to_string();

    // No --db: the session living only in the second DB must appear in
    // the multi-session stats query.
    let output = Command::new(ZINSPECT_BIN)
        .env("ZOO_OPENCODE_DATA_DIR", &data_dir)
        .env("HOME", &home)
        .args(["stats", "--sessions", "5", "--json", "--no-color"])
        .output()
        .expect("failed to run zinspect stats --sessions 5 (default)");
    assert!(
        output.status.success(),
        "default stats should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()))
        .collect();
    assert!(
        ids.contains(&"ses-900"),
        "default stats must include the second-DB session, got: {ids:?}"
    );
    assert!(
        ids.contains(&"ses-001"),
        "first-DB sessions still included, got: {ids:?}"
    );
}

#[test]
fn test_stats_explicit_db_only_sees_that_db() {
    let (dir, home) = two_db_env();
    let data_dir = dir.path().to_string_lossy().to_string();

    // First DB only: ses-900 must be absent from the stats query.
    let output = Command::new(ZINSPECT_BIN)
        .env("HOME", &home)
        .args([
            "--db",
            &format!("{data_dir}/opencode.db"),
            "stats",
            "--sessions",
            "5",
            "--json",
            "--no-color",
        ])
        .output()
        .expect("failed to run zinspect stats --db first.db");
    assert!(
        output.status.success(),
        "explicit --db stats should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()))
        .collect();
    assert!(
        !ids.contains(&"ses-900"),
        "explicit --db must not aggregate, got: {ids:?}"
    );

    // Second DB only: exactly the ses-900 row.
    let output = Command::new(ZINSPECT_BIN)
        .env("HOME", &home)
        .args([
            "--db",
            &format!("{data_dir}/opencode-stable.db"),
            "stats",
            "--sessions",
            "5",
            "--json",
            "--no-color",
        ])
        .output()
        .expect("failed to run zinspect stats --db stable.db");
    assert!(
        output.status.success(),
        "explicit --db stable stats should exit 0, got {:?}",
        output.status.code()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("output should be valid JSON");
    let ids: Vec<&str> = parsed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(ids, vec!["ses-900"], "only the second-DB session visible");
}
