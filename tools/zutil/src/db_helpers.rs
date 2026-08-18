use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::{epoch_ms_to_iso, expand_tilde, safe_json_loads};

/// Environment variable that overrides the opencode data directory used
/// for default multi-DB discovery.
pub const ZOO_OPENCODE_DATA_DIR: &str = "ZOO_OPENCODE_DATA_DIR";

/// Default opencode data directory (channel-based DB files live here).
const DEFAULT_DATA_DIR: &str = "~/.local/share/opencode";

/// Where to locate the `SQLite` databases behind a command's queries.
///
/// `Path` reproduces the single-DB behavior for an explicit `--db`;
/// `Aggregate` merges every `opencode*.db` file found in a data
/// directory (used when `--db` is absent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbTarget {
    /// Explicit `--db <path>`: open exactly this file.
    Path(String),
    /// No `--db`: aggregate all `opencode*.db` files in the given data
    /// directory (tilde expansion applies).
    Aggregate(String),
}

impl DbTarget {
    /// Build a target from an optional explicit `--db` value. `None`
    /// selects the default aggregate mode, using the data directory
    /// resolved by [`opencode_data_dir`].
    #[must_use]
    pub fn from_cli(explicit: Option<String>) -> Self {
        explicit
            .map_or_else(|| Self::Aggregate(opencode_data_dir()), Self::Path)
    }
}

/// Resolve the opencode data directory: `ZOO_OPENCODE_DATA_DIR` when set,
/// otherwise `~/.local/share/opencode`.
#[must_use]
pub fn opencode_data_dir() -> String {
    std::env::var(ZOO_OPENCODE_DATA_DIR)
        .unwrap_or_else(|_| expand_tilde(DEFAULT_DATA_DIR))
}

/// Discover `opencode*.db` files in `data_dir` (tilde-expanded).
///
/// Ordering is deterministic: the exact `opencode.db` (the historical
/// default) comes first, remaining files follow lexicographically. A
/// symlinked `opencode*.db` is discovered like a regular file. Missing
/// or unreadable directories yield an empty list.
#[must_use]
pub fn discover_databases(data_dir: &str) -> Vec<String> {
    let dir = expand_tilde(data_dir);
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .filter(|e| {
                    let file_name = e.file_name();
                    let name = file_name.to_string_lossy();
                    // Path-based is_file follows symlinks; DirEntry
                    // file_type does not.
                    e.path().is_file()
                        && name.starts_with("opencode")
                        && name.ends_with(".db")
                })
                .map(|e| e.path().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| discovery_key(a).cmp(&discovery_key(b)));
    files
}

/// Sort key for discovered DB paths: the exact `opencode.db` (the
/// historical default) sorts first, everything else by file name.
fn discovery_key(path: &str) -> (bool, &str) {
    let name =
        Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or("");
    (name != "opencode.db", name)
}

/// Try to open the DB in read-only URI mode.  Returns None if the file does
/// not exist (returns empty results, no error).
#[must_use]
pub fn open_db(path: &str) -> Option<Connection> {
    let expanded = expand_tilde(path);
    if !Path::new(&expanded).exists() {
        return None;
    }
    let uri = format!("file:{expanded}?mode=ro");
    Connection::open(&uri).ok()
}

/// Open a connection for the given target.
///
/// Returns `None` when the target resolves to no databases (missing
/// explicit file, or no discovered `opencode*.db` files) — callers then
/// behave like today's missing-DB case.
#[must_use]
pub fn open_db_target(target: &DbTarget) -> Option<Connection> {
    match target {
        DbTarget::Path(path) => open_db(path),
        DbTarget::Aggregate(dir) => open_aggregate_in(dir),
    }
}

/// Aggregates every `opencode*.db` file in `data_dir` into one connection.
///
/// The first file becomes the main connection, the rest are `ATTACH`ed
/// read-only as `aux1..auxN`, and temporary views named `session`,
/// `message`, and `part` merge the per-table rows across all databases.
///
/// Falls back to a plain single-file open of the first discovered database
/// when ATTACH or view creation fails (e.g. schema drift), so behavior
/// never regresses below today's single-DB mode.
#[must_use]
pub fn open_aggregate_in(data_dir: &str) -> Option<Connection> {
    let paths = discover_databases(data_dir);
    let first = paths.first()?;
    if paths.len() == 1 {
        return open_db(first);
    }
    open_multi_db(&paths).or_else(|| open_db(first))
}

/// Open the first path as the main connection, ATTACH the rest, and create
/// the merge views.
fn open_multi_db(paths: &[String]) -> Option<Connection> {
    let conn = open_db(&paths[0])?;
    for (i, path) in paths.iter().enumerate().skip(1) {
        let expanded = expand_tilde(path);
        let uri = format!("file:{expanded}?mode=ro").replace('\'', "''");
        conn.execute_batch(&format!("ATTACH DATABASE '{uri}' AS aux{i}"))
            .ok()?;
    }
    create_merge_views(&conn, paths.len()).ok()?;
    Some(conn)
}

/// Create temp views shadowing `session`, `message`, and `part` with a
/// UNION ALL over the main and all attached databases.
fn create_merge_views(conn: &Connection, count: usize) -> rusqlite::Result<()> {
    for table in ["session", "message", "part"] {
        let sources: Vec<String> = (0..count)
            .map(|i| {
                if i == 0 {
                    format!("SELECT * FROM main.{table}")
                } else {
                    format!("SELECT * FROM aux{i}.{table}")
                }
            })
            .collect();
        let sql = format!(
            "CREATE TEMP VIEW {table} AS {}",
            sources.join(" UNION ALL ")
        );
        conn.execute_batch(&sql)?;
    }
    Ok(())
}

/// Returned when a session ID prefix matches multiple sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguousPrefix {
    /// The original prefix that was ambiguous.
    pub prefix: String,
    /// All matching session IDs.
    pub matches: Vec<String>,
}

/// Resolve a possibly-prefix session ID to a full session ID.
///
/// First tries exact match, then falls back to LIKE prefix match.
/// The target determines whether the lookup spans a single DB (explicit
/// `--db`) or every `opencode*.db` file in the data dir (aggregate mode),
/// so prefix collisions between databases surface as ambiguous.
///
/// In aggregate mode the same session ID can exist in more than one
/// database; the exact match still resolves to that single ID (all rows
/// share the value), and later queries on it return the merged rows from
/// every database.
///
/// Returns:
/// - `Ok(Some(id))` — unique match
/// - `Ok(None)` — not found
/// - `Err(AmbiguousPrefix)` — ambiguous (struct with prefix and list of matches)
///
/// # Errors
///
/// Returns [`AmbiguousPrefix`] when the prefix matches multiple sessions.
///
/// # Panics
///
/// Panics if SQL preparation fails (indicates schema drift — developer error).
pub fn resolve_session_id(
    prefix: &str,
    target: &DbTarget,
) -> Result<Option<String>, AmbiguousPrefix> {
    // Empty prefix would match all sessions with LIKE '%'.
    if prefix.is_empty() {
        return Ok(None);
    }

    let Some(conn) = open_db_target(target) else {
        return Ok(None);
    };

    // 1. Try exact match. `DISTINCT` dedups rows when the same session
    // ID exists in several databases' merged view.
    let mut stmt = conn
        .prepare("SELECT DISTINCT id FROM session WHERE id = ?")
        .expect("SQL prepare failed");
    let exact: Option<String> = stmt
        .query_map(params![prefix], |row| row.get("id"))
        .expect("SQL query failed")
        .find_map(std::result::Result::ok);

    if let Some(id) = exact {
        return Ok(Some(id));
    }

    // 2. Fall back to LIKE prefix match
    let pattern = format!("{prefix}%");
    let mut like_stmt = conn
        .prepare("SELECT id FROM session WHERE id LIKE ?")
        .expect("SQL prepare failed");
    let matches: Vec<String> = like_stmt
        .query_map(params![pattern], |row| row.get("id"))
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].clone())),
        _ => Err(AmbiguousPrefix { prefix: prefix.to_string(), matches }),
    }
}

/// Convert a session DB row to a `serde_json::Value` object.
///
/// Handles string columns, JSON model parsing, epoch-ms-to-ISO timestamps,
/// and numeric columns.
///
/// # Errors
///
/// Returns `rusqlite::Error` if any column cannot be retrieved from the row.
pub fn row_to_session_value(row: &rusqlite::Row) -> Value {
    let mut m = Map::new();

    // Simple string columns — gracefully return Null if column missing
    for key in &["id", "parent_id", "title", "slug", "agent", "directory"] {
        let val = row.get::<_, Option<String>>(*key).ok().flatten();
        m.insert(key.to_string(), val.map_or(Value::Null, Value::String));
    }

    // Model: stored as a JSON string, parse it
    let model_str = row.get::<_, Option<String>>("model").ok().flatten();
    match model_str {
        Some(s) => {
            let parsed = safe_json_loads(&s).unwrap_or(Value::String(s));
            m.insert("model".to_string(), parsed);
        }
        None => {
            m.insert("model".to_string(), Value::Null);
        }
    }

    // Timestamps: epoch ms -> ISO
    for key in &["time_created", "time_updated"] {
        let val = row.get::<_, Option<i64>>(*key).ok().flatten();
        m.insert(
            key.to_string(),
            val.map_or(Value::Null, |v| Value::String(epoch_ms_to_iso(v))),
        );
    }

    // Numeric columns
    for key in &[
        "cost",
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
    ] {
        let val = row.get::<_, Option<f64>>(*key).ok().flatten();
        m.insert(
            key.to_string(),
            val.map_or(Value::Null, |v| {
                serde_json::Number::from_f64(v)
                    .map_or(Value::Null, Value::Number)
            }),
        );
    }

    Value::Object(m)
}

/// Run a session query with the given WHERE/ORDER/LIMIT clause and parameters.
///
/// Constructs `SELECT {SESSION_COLS} FROM session {where_order}`,
/// maps each row through `row_to_session_value`, and returns results.
///
/// The caller includes the full suffix starting from WHERE through LIMIT
/// in `where_order`, e.g. `"WHERE parent_id IS NULL ORDER BY
/// time_updated DESC LIMIT ?"`.
///
/// # Errors
///
/// Returns a `rusqlite::Error` if the SQL query fails.
pub fn query_sessions_where(
    target: &DbTarget,
    where_order: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<Value>, rusqlite::Error> {
    let Some(conn) = open_db_target(target) else {
        return Ok(vec![]);
    };
    let sql = format!("SELECT {SESSION_COLS} FROM session {where_order}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, |row| Ok(row_to_session_value(row)))?;
    rows.collect::<Result<Vec<_>, _>>()
}

/// Session table columns used in SELECT queries.
///
/// Uses `*` to avoid drifting out of sync with the `OpenCode` session table
/// schema. `row_to_session_value` reads columns by name, ignoring any columns
/// it does not recognize and returning `Null` for missing columns.
pub const SESSION_COLS: &str = "*";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_db;
    use std::fs;
    use std::sync::Mutex;

    /// Mutex to serialize DB-creating tests (all use the same temp file name).
    static DB_MUTEX: Mutex<()> = Mutex::new(());

    /// Mutex for tests sharing the two-DB temp directory name.
    static MULTIDB_MUTEX: Mutex<()> = Mutex::new(());

    /// Helper: create a temporary `SQLite` database with session fixtures.
    /// Returns the file path. Caller should delete it after the test.
    fn create_test_db() -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "zutil_resolve_session_test_{}.db",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        let conn = Connection::open(&path).expect("open test db");
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
            );",
        )
        .expect("create session table");

        conn.execute(
            "INSERT INTO session (id) VALUES (?1)",
            rusqlite::params!["ses-abc123"],
        )
        .expect("insert ses-abc123");

        conn.execute(
            "INSERT INTO session (id) VALUES (?1)",
            rusqlite::params!["ses-def456"],
        )
        .expect("insert ses-def456");

        conn.execute(
            "INSERT INTO session (id) VALUES (?1)",
            rusqlite::params!["ses-abc789"],
        )
        .expect("insert ses-abc789");

        conn.close().expect("close test db");
        path.to_str().unwrap().to_string()
    }

    /// Create a temp dir holding two `opencode*.db` fixtures. Returns the
    /// dir path; the caller removes it after the test.
    fn create_two_db_dir_tmp(db1_ids: &[&str], db2_ids: &[&str]) -> String {
        let dir = std::env::temp_dir()
            .join(format!("zutil_multidb_{}.db", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");
        test_db::create_two_db_dir(&dir, db1_ids, db2_ids);
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn test_resolve_session_id_exact_match() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let target = DbTarget::Path(db_path.clone());
        let result = resolve_session_id("ses-abc123", &target);
        assert_eq!(result, Ok(Some("ses-abc123".to_string())));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_prefix_unique() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let target = DbTarget::Path(db_path.clone());
        // "ses-def" only matches ses-def456
        let result = resolve_session_id("ses-def", &target);
        assert_eq!(result, Ok(Some("ses-def456".to_string())));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_no_match() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let target = DbTarget::Path(db_path.clone());
        let result = resolve_session_id("nonexistent", &target);
        assert_eq!(result, Ok(None));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_nonexistent_db() {
        let target = DbTarget::Path("/tmp/nonexistent_resolve_test.db".into());
        let result = resolve_session_id("ses-abc123", &target);
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn test_resolve_session_id_prefix_case_sensitive() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let target = DbTarget::Path(db_path.clone());
        // SQLite LIKE is case-insensitive by default for ASCII,
        // but exact match IS case-sensitive. This test verifies
        // the exact match path.
        let result = resolve_session_id("SES-ABC123", &target);
        // Exact match is case-sensitive, so this won't match "ses-abc123"
        // But prefix LIKE is case-insensitive, so "SES-ABC" would match
        // "ses-abc123" and "ses-abc789" -> ambiguous
        // For "SES-ABC123", exact fails, LIKE with "SES-ABC123%" matches only
        // "ses-abc123" since LIKE is case-insensitive for ASCII
        assert_eq!(result, Ok(Some("ses-abc123".to_string())));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_empty_string_returns_none() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let target = DbTarget::Path(db_path.clone());
        // Empty string would match ALL sessions with LIKE '%';
        // the guard at the top of resolve_session_id should return None.
        let result = resolve_session_id("", &target);
        assert_eq!(result, Ok(None));
        let _ = fs::remove_file(&db_path);
    }

    // ── Default aggregation across multiple databases ────────────────────

    #[test]
    fn test_aggregate_resolve_finds_sessions_in_both_dbs() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = create_two_db_dir_tmp(
            &["ses-abc123", "ses-def456", "ses-abc789"],
            &["ses-xyz001", "ses-xyz002"],
        );
        let target = DbTarget::Aggregate(dir.clone());

        // A session living only in the second DB resolves through the
        // aggregate connection.
        assert_eq!(
            resolve_session_id("ses-xyz001", &target),
            Ok(Some("ses-xyz001".to_string()))
        );
        // Sessions in the first DB keep resolving (exact + prefix paths).
        assert_eq!(
            resolve_session_id("ses-abc123", &target),
            Ok(Some("ses-abc123".to_string()))
        );
        assert_eq!(
            resolve_session_id("ses-def", &target),
            Ok(Some("ses-def456".to_string()))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_cross_db_prefix_ambiguous() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // "ses-abc" appears in both DBs: abc123/abc789 (first), abc999 (second).
        let dir = create_two_db_dir_tmp(
            &["ses-abc123", "ses-def456", "ses-abc789"],
            &["ses-abc999", "ses-xyz001"],
        );
        let target = DbTarget::Aggregate(dir.clone());

        let result = resolve_session_id("ses-abc", &target)
            .expect_err("cross-DB prefix collision must surface as ambiguous");
        let mut matches = result.matches;
        matches.sort();
        assert_eq!(result.prefix, "ses-abc");
        assert_eq!(
            matches,
            vec![
                "ses-abc123".to_string(),
                "ses-abc789".to_string(),
                "ses-abc999".to_string(),
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_exact_match_same_id_in_both_dbs() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The same session ID exists in both databases: the merged view
        // carries both DBs' rows, but the exact match must still resolve
        // to the single shared ID.
        let dir = create_two_db_dir_tmp(&["ses-shared"], &["ses-shared"]);
        let target = DbTarget::Aggregate(dir.clone());

        assert_eq!(
            resolve_session_id("ses-shared", &target),
            Ok(Some("ses-shared".to_string()))
        );

        // Both DBs' rows remain visible through the merged view.
        let conn = open_aggregate_in(&dir).expect("aggregate open should work");
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session WHERE id = 'ses-shared'",
                [],
                |r| r.get(0),
            )
            .expect("query merged view");
        assert_eq!(count, 2, "both databases contribute the shared row");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_query_sessions_where_merged() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = create_two_db_dir_tmp(
            &["ses-abc123", "ses-def456", "ses-abc789"],
            &["ses-xyz001", "ses-xyz002"],
        );
        let target = DbTarget::Aggregate(dir.clone());

        let rows = query_sessions_where(&target, "ORDER BY id", &[])
            .expect("merged query should succeed");
        let ids: Vec<&str> = rows
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids.len(), 5, "both DBs must contribute sessions");
        assert!(ids.contains(&"ses-abc123"), "first DB row present");
        assert!(ids.contains(&"ses-xyz001"), "second DB row present");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_merge_views_cover_message_and_part() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = create_two_db_dir_tmp(
            &["ses-abc123", "ses-def456"],
            &["ses-xyz001", "ses-xyz002"],
        );
        let conn = open_aggregate_in(&dir).expect("aggregate open should work");

        let msg_count: i64 = conn
            .query_row("SELECT count(*) FROM message", [], |r| r.get(0))
            .expect("message view should exist");
        assert_eq!(msg_count, 2, "one message row per DB, merged");

        let part_count: i64 = conn
            .query_row("SELECT count(*) FROM part", [], |r| r.get(0))
            .expect("part view should exist");
        assert_eq!(part_count, 2, "one part row per DB, merged");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_empty_dir_like_missing_db() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir()
            .join(format!("zutil_multidb_{}.db", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create empty fixture dir");
        let target = DbTarget::Aggregate(dir.to_string_lossy().to_string());

        // Zero DBs found behaves like today's missing-DB case.
        assert_eq!(resolve_session_id("ses-abc", &target), Ok(None));
        let rows = query_sessions_where(&target, "ORDER BY id", &[])
            .expect("query on empty aggregate should not error");
        assert!(rows.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aggregate_single_db_dir_works() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = create_two_db_dir_tmp(&["ses-abc123", "ses-def456"], &[]);
        let target = DbTarget::Aggregate(dir.clone());

        assert_eq!(
            resolve_session_id("ses-def", &target),
            Ok(Some("ses-def456".to_string()))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_discover_databases_sorted_and_filtered() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir()
            .join(format!("zutil_multidb_{}.db", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");
        for name in [
            "opencode.db",
            "opencode-stable.db",
            "opencode-beta.db",
            "other.db",
            "opencode.db-wal",
        ] {
            fs::write(dir.join(name), b"x").expect("write fixture file");
        }

        let found = discover_databases(&dir.to_string_lossy());
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map_or_else(String::new, |s| {
                        s.to_string_lossy().to_string()
                    })
            })
            .collect();
        assert_eq!(
            names,
            vec![
                "opencode.db".to_string(),
                "opencode-beta.db".to_string(),
                "opencode-stable.db".to_string(),
            ],
            "only opencode*.db files; default opencode.db first, rest sorted"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_discover_databases_follows_symlinks() {
        let _lock = MULTIDB_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir()
            .join(format!("zutil_multidb_{}.db", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");
        fs::write(dir.join("opencode.db"), b"x").expect("write fixture file");
        // A symlinked opencode*.db must be discovered too (DirEntry
        // file_type does not follow symlinks; path-based is_file does).
        std::os::unix::fs::symlink(
            dir.join("opencode.db"),
            dir.join("opencode-link.db"),
        )
        .expect("create symlink");

        let found = discover_databases(&dir.to_string_lossy());
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map_or_else(String::new, |s| {
                        s.to_string_lossy().to_string()
                    })
            })
            .collect();
        assert!(
            names.contains(&"opencode-link.db".to_string()),
            "symlinked DB must be discovered, got: {names:?}"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
