use std::path::Path;

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::{epoch_ms_to_iso, expand_tilde, safe_json_loads};

/// Try to open the DB in read-only URI mode.  Returns None if the file does
/// not exist (matching Python: empty results, no error).
#[must_use]
pub fn open_db(path: &str) -> Option<Connection> {
    let expanded = expand_tilde(path);
    if !Path::new(&expanded).exists() {
        return None;
    }
    let uri = format!("file:{expanded}?mode=ro");
    Connection::open(&uri).ok()
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
