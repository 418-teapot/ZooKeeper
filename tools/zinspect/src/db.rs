use std::collections::{HashMap, HashSet};

#[cfg_attr(not(test), allow(unused_imports))]
use rusqlite::{Connection, params};
use serde_json::{Map, Number, Value};

use zutil::db_helpers::{open_db, query_sessions_where};
use zutil::{epoch_ms_to_iso, safe_json_loads};

/// Get the *n* most recently updated sessions.
///
/// # Errors
///
/// Returns a `rusqlite::Error` if the database query fails.
pub fn query_recent_sessions(
    n: i64,
    db_path: &str,
    include_children: bool,
) -> Result<Vec<Value>, rusqlite::Error> {
    if include_children {
        query_sessions_where(
            db_path,
            "ORDER BY time_updated DESC LIMIT ?",
            rusqlite::params![n],
        )
    } else {
        query_sessions_where(
            db_path,
            "WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?",
            rusqlite::params![n],
        )
    }
}

/// Fetch message time map (created, completed) for the given message IDs.
fn fetch_msg_time_map(
    conn: &Connection,
    msg_ids: &HashSet<String>,
    session_id: &str,
) -> HashMap<String, (Option<i64>, Option<i64>)> {
    let mut msg_time_map: HashMap<String, (Option<i64>, Option<i64>)> =
        HashMap::new();

    if !msg_ids.is_empty() {
        let placeholders: Vec<String> =
            msg_ids.iter().map(|_| "?".to_string()).collect();
        let in_clause = placeholders.join(",");

        let mut msg_stmt = conn
            .prepare(&format!(
                "SELECT id, data FROM message \
                 WHERE id IN ({in_clause}) AND session_id = ?"
            ))
            .expect("SQL prepare failed");

        let mut msg_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for mid in msg_ids {
            msg_params.push(Box::new(mid.clone()));
        }
        msg_params.push(Box::new(session_id.to_string()));
        let msg_refs: Vec<&dyn rusqlite::types::ToSql> =
            msg_params.iter().map(std::convert::AsRef::as_ref).collect();

        let msg_rows = msg_stmt
            .query_map(msg_refs.as_slice(), |row| {
                let id: String = row.get("id")?;
                let data_str: String = row.get("data")?;
                Ok((id, safe_json_loads(&data_str).unwrap_or(Value::Null)))
            })
            .expect("SQL query failed");

        for msg_row in msg_rows.flatten() {
            let time_info = msg_row.1.get("time");
            let created = time_info
                .and_then(|t| t.get("created"))
                .and_then(serde_json::Value::as_i64);
            let completed = time_info
                .and_then(|t| t.get("completed"))
                .and_then(serde_json::Value::as_i64);
            msg_time_map.insert(msg_row.0, (created, completed));
        }
    }

    msg_time_map
}

/// A row from the step-finish parts query.
#[derive(Clone)]
struct StepRow {
    message_id: String,
    time_created: Option<i64>,
    time_updated: Option<i64>,
    data: Value,
}

/// Extract per-step token timeline for a session.
///
/// Queries step-finish parts and tool parts, then associates tool
/// names with their corresponding step by matching `message_id`.
pub fn query_step_data(session_id: &str, db_path: &str) -> Vec<Value> {
    #[derive(Clone)]
    struct ToolRow {
        message_id: String,
        data: Value,
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    // Step-finish parts
    let mut step_stmt = conn
        .prepare(
            "SELECT message_id, time_created, time_updated, data \
             FROM part \
             WHERE session_id = ? \
             AND json_extract(data, '$.type') = 'step-finish' \
             ORDER BY time_created ASC",
        )
        .expect("SQL prepare failed");

    let step_rows: Vec<StepRow> = step_stmt
        .query_map(params![session_id], |row| {
            let message_id: String = row.get("message_id")?;
            let tc: Option<i64> = row.get("time_created")?;
            let tu: Option<i64> = row.get("time_updated")?;
            let data_str: String = row.get("data")?;
            Ok(StepRow {
                message_id,
                time_created: tc,
                time_updated: tu,
                data: safe_json_loads(&data_str).unwrap_or(Value::Null),
            })
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    // Tool parts
    let mut tool_stmt = conn
        .prepare(
            "SELECT id, message_id, time_created, data \
             FROM part \
             WHERE session_id = ? \
             AND json_extract(data, '$.type') = 'tool' \
             ORDER BY time_created ASC",
        )
        .expect("SQL prepare failed");

    let tool_rows: Vec<ToolRow> = tool_stmt
        .query_map(params![session_id], |row| {
            let _id: String = row.get("id")?;
            let message_id: String = row.get("message_id")?;
            let data_str: String = row.get("data")?;
            Ok(ToolRow {
                message_id,
                data: safe_json_loads(&data_str).unwrap_or(Value::Null),
            })
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    // Build tool name lookup keyed by message_id
    let mut tools_by_msg: HashMap<String, Vec<String>> = HashMap::new();
    for trow in &tool_rows {
        if let Some(tool_name) = trow
            .data
            .get("tool")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            tools_by_msg
                .entry(trow.message_id.clone())
                .or_default()
                .push(tool_name.to_string());
        }
    }

    let msg_ids: HashSet<String> =
        step_rows.iter().map(|s| s.message_id.clone()).collect();
    let msg_time_map = fetch_msg_time_map(&conn, &msg_ids, session_id);

    // Build results
    let results: Vec<Value> = step_rows
        .iter()
        .enumerate()
        .map(|(idx, srow)| {
            build_step_value(idx, srow, &tools_by_msg, &msg_time_map)
        })
        .collect();

    results
}

/// Build a single step JSON value from a `StepRow` and auxiliary data.
/// Helper: convert an f64 token value to JSON Number or Null.
fn f64_to_json(v: f64) -> Value {
    Number::from_f64(v).map_or(Value::Null, Value::Number)
}

fn build_step_value(
    idx: usize,
    srow: &StepRow,
    tools_by_msg: &HashMap<String, Vec<String>>,
    msg_time_map: &HashMap<String, (Option<i64>, Option<i64>)>,
) -> Value {
    let step_index = idx + 1;
    let msg_id = &srow.message_id;
    let sdata = &srow.data;

    let ts_created = srow.time_created.map(epoch_ms_to_iso).unwrap_or_default();
    let ts_updated = srow.time_updated.map(epoch_ms_to_iso).unwrap_or_default();

    let tokens_obj = sdata
        .get("tokens")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let cache_obj = tokens_obj
        .get("cache")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let input_tokens =
        tokens_obj.get("input").and_then(Value::as_f64).unwrap_or(0.0);
    let output_tokens =
        tokens_obj.get("output").and_then(Value::as_f64).unwrap_or(0.0);
    let reasoning_tokens =
        tokens_obj.get("reasoning").and_then(Value::as_f64).unwrap_or(0.0);
    let cache_read =
        cache_obj.get("read").and_then(Value::as_f64).unwrap_or(0.0);
    let cache_write =
        cache_obj.get("write").and_then(Value::as_f64).unwrap_or(0.0);
    let cost = sdata.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    let reason =
        sdata.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let tools: Vec<Value> = tools_by_msg
        .get(msg_id)
        .map(|v| v.iter().map(|s| Value::String(s.clone())).collect())
        .unwrap_or_default();

    let msg_times = msg_time_map.get(msg_id);
    let msg_time_created = msg_times
        .and_then(|(c, _)| *c)
        .map(|ts| Value::Number(Number::from(ts)));
    let msg_time_completed = msg_times
        .and_then(|(_, c)| *c)
        .map(|ts| Value::Number(Number::from(ts)));

    let mut step = Map::new();
    step.insert(
        "step_index".to_string(),
        Value::Number(Number::from(step_index as u64)),
    );
    step.insert("message_id".to_string(), Value::String(msg_id.clone()));
    step.insert("time_created".to_string(), Value::String(ts_created));
    step.insert("time_updated".to_string(), Value::String(ts_updated));
    step.insert("cache_read".to_string(), f64_to_json(cache_read));
    step.insert("cache_write".to_string(), f64_to_json(cache_write));
    step.insert("input_tokens".to_string(), f64_to_json(input_tokens));
    step.insert("output_tokens".to_string(), f64_to_json(output_tokens));
    step.insert("reasoning_tokens".to_string(), f64_to_json(reasoning_tokens));
    step.insert("cost".to_string(), f64_to_json(cost));
    step.insert("reason".to_string(), Value::String(reason));
    step.insert("tools".to_string(), Value::Array(tools));
    step.insert(
        "msg_time_created".to_string(),
        msg_time_created.unwrap_or(Value::Null),
    );
    step.insert(
        "msg_time_completed".to_string(),
        msg_time_completed.unwrap_or(Value::Null),
    );

    Value::Object(step)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;
    use zutil::test_db::{create_common_tables, insert_session_fixtures};

    /// Mutex to serialize DB-creating tests (all use the same temp file name).
    static DB_MUTEX: Mutex<()> = Mutex::new(());

    /// Create a temporary `SQLite` database with test tables and sample data.
    /// Returns the file path. Caller should delete it after the test.
    fn create_test_db() -> String {
        let dir = std::env::temp_dir();
        let path =
            dir.join(format!("zoo_inspect_test_{}.db", std::process::id()));
        let _ = fs::remove_file(&path);

        let conn = Connection::open(&path).expect("open test db");

        create_common_tables(&conn);

        conn.execute_batch(
            "CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                time_updated INTEGER,
                data TEXT
            );",
        )
        .expect("create part table");

        insert_session_fixtures(&conn);

        // Messages for ses-001
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
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002", "ses-001", 1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"beaver","time":{"created":1715000020000,"completed":1715000090000}}"#,
            ],
        ).expect("insert msg-002");

        // Parts for msg-002 (step-finish + tool)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-001", "msg-002", "ses-001",
                1_715_000_020_000_i64, 1_715_000_025_000_i64,
                r#"{"type":"step-finish","tokens":{"input":100,"output":50,"cache":{"read":30,"write":10}},"cost":0.005,"reason":"completed"}"#,
            ],
        ).expect("insert part-001");

        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-002", "msg-002", "ses-001",
                1_715_000_021_000_i64, 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts"}}}"#,
            ],
        ).expect("insert part-002");

        // Messages for ses-002
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

        // Parts for msg-003 (step-finish only)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-003", "msg-003", "ses-002",
                1_715_000_210_000_i64, 1_715_000_220_000_i64,
                r#"{"type":"step-finish","tokens":{"input":200,"output":100,"cache":{"read":50,"write":20}},"cost":0.003,"reason":"completed"}"#,
            ],
        ).expect("insert part-003");

        conn.close().expect("close test db");
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn test_query_recent_sessions_root_only() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_recent_sessions(10, &db_path, false).unwrap();
        // 2 root sessions (ses-003 is a child)
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["id"], "ses-002");
        assert_eq!(results[1]["id"], "ses-001");
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_recent_sessions_include_children() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_recent_sessions(10, &db_path, true).unwrap();
        // 3 sessions including child
        assert_eq!(results.len(), 3);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_recent_sessions_limit() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_recent_sessions(1, &db_path, false).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "ses-002");
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_step_data() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_step_data("ses-001", &db_path);
        // 1 step-finish for ses-001
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["step_index"], 1);
        assert_eq!(results[0]["message_id"], "msg-002");
        assert!(
            (results[0]["input_tokens"].as_f64().unwrap() - 100.0).abs()
                < 0.001
        );
        assert!(
            (results[0]["output_tokens"].as_f64().unwrap() - 50.0).abs()
                < 0.001
        );
        assert!(
            (results[0]["cache_read"].as_f64().unwrap() - 30.0).abs() < 0.001
        );
        assert!(
            (results[0]["cache_write"].as_f64().unwrap() - 10.0).abs() < 0.001
        );
        assert_eq!(results[0]["reason"], "completed");
        // Has a tool associated
        let tools = results[0]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0], "read");
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_step_data_empty_session() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_step_data("nonexistent-session", &db_path);
        // No data for nonexistent session
        assert!(results.is_empty());
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_step_data_nonexistent_db() {
        let results =
            query_step_data("ses-001", "/tmp/nonexistent_db_file_12345.db");
        assert!(results.is_empty());
    }

    #[test]
    fn test_query_recent_sessions_nonexistent_db() {
        let results = query_recent_sessions(
            10,
            "/tmp/nonexistent_db_file_12345.db",
            false,
        )
        .unwrap();
        assert!(results.is_empty());
    }
}
