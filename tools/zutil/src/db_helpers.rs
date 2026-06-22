use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::{epoch_ms_to_iso, expand_tilde, safe_json_loads};

/// Returned when a session ID prefix matches multiple sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguousPrefix {
    /// The original prefix that was ambiguous.
    pub prefix: String,
    /// All matching session IDs.
    pub matches: Vec<String>,
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

/// Resolve a possibly-prefix session ID to a full session ID.
///
/// First tries exact match, then falls back to LIKE prefix match.
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
    db_path: &str,
) -> Result<Option<String>, AmbiguousPrefix> {
    // Empty prefix would match all sessions with LIKE '%'.
    if prefix.is_empty() {
        return Ok(None);
    }

    let Some(conn) = open_db(db_path) else {
        return Ok(None);
    };

    // 1. Try exact match
    let mut stmt = conn
        .prepare("SELECT id FROM session WHERE id = ?")
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
    db_path: &str,
    where_order: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<Value>, rusqlite::Error> {
    let Some(conn) = open_db(db_path) else {
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
    use std::fs;
    use std::sync::Mutex;

    /// Mutex to serialize DB-creating tests (all use the same temp file name).
    static DB_MUTEX: Mutex<()> = Mutex::new(());

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

    #[test]
    fn test_resolve_session_id_exact_match() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let result = resolve_session_id("ses-abc123", &db_path);
        assert_eq!(result, Ok(Some("ses-abc123".to_string())));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_prefix_unique() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        // "ses-def" only matches ses-def456
        let result = resolve_session_id("ses-def", &db_path);
        assert_eq!(result, Ok(Some("ses-def456".to_string())));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_no_match() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let result = resolve_session_id("nonexistent", &db_path);
        assert_eq!(result, Ok(None));
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_resolve_session_id_nonexistent_db() {
        let result = resolve_session_id(
            "ses-abc123",
            "/tmp/nonexistent_resolve_test.db",
        );
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn test_resolve_session_id_prefix_case_sensitive() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        // SQLite LIKE is case-insensitive by default for ASCII,
        // but exact match IS case-sensitive. This test verifies
        // the exact match path.
        let result = resolve_session_id("SES-ABC123", &db_path);
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
        // Empty string would match ALL sessions with LIKE '%';
        // the guard at the top of resolve_session_id should return None.
        let result = resolve_session_id("", &db_path);
        assert_eq!(result, Ok(None));
        let _ = fs::remove_file(&db_path);
    }
}
