use std::collections::HashMap;

#[cfg_attr(not(test), allow(unused_imports))]
use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use zutil::db_helpers::{open_db, query_sessions_where};
use zutil::{epoch_ms_to_iso, safe_json_loads};

pub fn query_sessions(
    keyword: &str,
    db_path: &str,
    limit: usize,
) -> Result<Vec<Value>, rusqlite::Error> {
    let pattern = format!("%{keyword}%");
    query_sessions_where(
        db_path,
        "WHERE parent_id IS NULL AND title LIKE ? ORDER BY time_updated DESC LIMIT ?",
        rusqlite::params![pattern, i64::try_from(limit).unwrap_or(i64::MAX)],
    )
}

pub fn query_sessions_all(
    db_path: &str,
    limit: usize,
) -> Result<Vec<Value>, rusqlite::Error> {
    query_sessions_where(
        db_path,
        "WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?",
        rusqlite::params![i64::try_from(limit).unwrap_or(i64::MAX)],
    )
}

pub fn query_sessions_exact(
    title: &str,
    db_path: &str,
    limit: usize,
) -> Result<Vec<Value>, rusqlite::Error> {
    query_sessions_where(
        db_path,
        "WHERE title = ? ORDER BY time_updated DESC LIMIT ?",
        rusqlite::params![title, i64::try_from(limit).unwrap_or(i64::MAX)],
    )
}

#[allow(clippy::too_many_lines)]
pub fn query_message_by_ids(
    msg_ids: &[String],
    session_id: Option<&str>,
    db_path: &str,
    scan_limit: usize,
) -> Vec<Value> {
    type MsgGroup = Vec<(String, Option<i64>, Value, Value)>;

    if msg_ids.is_empty() {
        return vec![];
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    // Build dynamic placeholders for IN clause
    let placeholders: Vec<String> =
        msg_ids.iter().map(|_| "?".to_string()).collect();
    let in_clause = placeholders.join(",");

    let session_filter: String = match session_id {
        Some(_) => "AND m.session_id = ?".to_string(),
        None => "AND m.session_id IN (SELECT id FROM session \
             ORDER BY time_updated DESC LIMIT ?)"
            .to_string(),
    };

    let sql = format!(
        "SELECT m.id, m.session_id, m.time_created, m.data AS msg_data, \
         p.data AS part_data \
         FROM message m \
         JOIN part p ON p.message_id = m.id \
         WHERE m.id IN ({in_clause}) {session_filter} \
         ORDER BY m.time_created ASC, p.time_created ASC"
    );

    // Build params: msg_ids first, then session_id or scan_limit
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    for id in msg_ids {
        params.push(Box::new(id.clone()));
    }
    match session_id {
        Some(sid) => params.push(Box::new(sid.to_string())),
        None => {
            params
                .push(Box::new(i64::try_from(scan_limit).unwrap_or(i64::MAX)));
        }
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();

    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");
    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let id: String = row.get("id")?;
            let sid: String = row.get("session_id")?;
            let ts: Option<i64> = row.get("time_created")?;
            let msg_data_str: String = row.get("msg_data")?;
            let part_data_str: String = row.get("part_data")?;
            Ok((
                id,
                sid,
                ts,
                safe_json_loads(&msg_data_str).unwrap_or(Value::Null),
                safe_json_loads(&part_data_str).unwrap_or(Value::Null),
            ))
        })
        .expect("SQL query failed");

    let mut grouped: HashMap<String, MsgGroup> = HashMap::new();
    for row in rows.flatten() {
        grouped.entry(row.0).or_default().push((row.1, row.2, row.3, row.4));
    }

    // Fallback to LIKE prefix matching for any IDs not found by exact match.
    let found: std::collections::HashSet<&str> =
        grouped.keys().map(std::string::String::as_str).collect();
    let missing: Vec<&String> =
        msg_ids.iter().filter(|id| !found.contains(id.as_str())).collect();

    if !missing.is_empty() {
        let like_placeholders: Vec<String> =
            missing.iter().map(|_| "m.id LIKE ?".to_string()).collect();
        let like_clause = like_placeholders.join(" OR ");

        let like_sql = format!(
            "SELECT m.id, m.session_id, m.time_created, m.data AS msg_data, \
             p.data AS part_data \
             FROM message m \
             JOIN part p ON p.message_id = m.id \
             WHERE ({like_clause}) {session_filter} \
             ORDER BY m.time_created ASC, p.time_created ASC"
        );

        let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for id in &missing {
            like_params.push(Box::new(format!("{id}%")));
        }
        match session_id {
            Some(sid) => like_params.push(Box::new(sid.to_string())),
            None => like_params
                .push(Box::new(i64::try_from(scan_limit).unwrap_or(i64::MAX))),
        }
        let like_refs: Vec<&dyn rusqlite::types::ToSql> =
            like_params.iter().map(std::convert::AsRef::as_ref).collect();

        let mut like_stmt =
            conn.prepare(&like_sql).expect("SQL prepare failed");
        let like_rows = like_stmt
            .query_map(like_refs.as_slice(), |row| {
                let id: String = row.get("id")?;
                let sid: String = row.get("session_id")?;
                let ts: Option<i64> = row.get("time_created")?;
                let msg_data_str: String = row.get("msg_data")?;
                let part_data_str: String = row.get("part_data")?;
                Ok((
                    id,
                    sid,
                    ts,
                    safe_json_loads(&msg_data_str).unwrap_or(Value::Null),
                    safe_json_loads(&part_data_str).unwrap_or(Value::Null),
                ))
            })
            .expect("SQL query failed");

        for row in like_rows.flatten() {
            grouped
                .entry(row.0)
                .or_default()
                .push((row.1, row.2, row.3, row.4));
        }
    }

    // Convert grouped data to result Values
    let mut results: Vec<Value> = Vec::new();
    for (msg_id, part_rows) in &grouped {
        let first = &part_rows[0];
        let msg_data = &first.2;
        let timestamp = first.1.map(epoch_ms_to_iso).unwrap_or_default();

        // Tokens: prefer msg_data.tokens.input + msg_data.tokens.output
        let tokens = msg_data
            .get("tokens")
            .and_then(|t| t.as_object())
            .map(|t| {
                let inp = t
                    .get("input")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let out = t
                    .get("output")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                usize::try_from(inp + out).unwrap_or(0)
            })
            .filter(|&t| t > 0)
            .or_else(|| {
                // Fallback: look for step-finish part tokens
                for (_sid, _ts, _mdata, pdata) in part_rows {
                    if pdata.get("type").and_then(|v| v.as_str())
                        == Some("step-finish")
                    {
                        let tok = pdata.get("tokens");
                        if let Some(t) = tok.and_then(|v| v.as_object()) {
                            let inp = t
                                .get("input")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0);
                            let out = t
                                .get("output")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0);
                            return Some(
                                usize::try_from(inp + out).unwrap_or(0),
                            );
                        }
                    }
                }
                None
            })
            .unwrap_or(0);

        // Collect parts
        let parts: Vec<Value> =
            part_rows.iter().map(|(_, _, _, pdata)| pdata.clone()).collect();

        let mut m = Map::new();
        m.insert("id".to_string(), Value::String(msg_id.clone()));
        m.insert("session_id".to_string(), Value::String(first.0.clone()));
        m.insert(
            "role".to_string(),
            msg_data
                .get("role")
                .cloned()
                .unwrap_or(Value::String(String::new())),
        );
        m.insert(
            "agent".to_string(),
            msg_data
                .get("agent")
                .cloned()
                .unwrap_or(Value::String(String::new())),
        );
        m.insert("timestamp".to_string(), Value::String(timestamp));
        m.insert(
            "tokens".to_string(),
            Value::Number(serde_json::Number::from(tokens)),
        );
        m.insert("parts".to_string(), Value::Array(parts));

        results.push(Value::Object(m));
    }

    results
}

pub fn query_message_parts(session_id: &str, db_path: &str) -> Vec<Value> {
    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    // Query messages
    let mut msg_stmt = conn
        .prepare(
            "SELECT id, session_id, time_created, data \
             FROM message WHERE session_id = ? \
             ORDER BY time_created ASC",
        )
        .expect("SQL prepare failed");

    let msg_rows: Vec<(String, String, Option<i64>, Value)> = msg_stmt
        .query_map(params![session_id], |row| {
            let id: String = row.get("id")?;
            let sid: String = row.get("session_id")?;
            let ts: Option<i64> = row.get("time_created")?;
            let data_str: String = row.get("data")?;
            Ok((id, sid, ts, safe_json_loads(&data_str).unwrap_or(Value::Null)))
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    // Query parts
    let mut part_stmt = conn
        .prepare(
            "SELECT message_id, session_id, time_created, data \
             FROM part WHERE session_id = ? \
             ORDER BY time_created ASC",
        )
        .expect("SQL prepare failed");

    let part_rows: Vec<(String, Value)> = part_stmt
        .query_map(params![session_id], |row| {
            let msg_id: String = row.get("message_id")?;
            let data_str: String = row.get("data")?;
            Ok((msg_id, safe_json_loads(&data_str).unwrap_or(Value::Null)))
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    // Group parts by message_id
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    for (msg_id, pdata) in &part_rows {
        parts_by_msg.entry(msg_id.clone()).or_default().push(pdata.clone());
    }

    // Build results
    let mut results: Vec<Value> = Vec::new();
    for (msg_id, sid, ts_opt, msg_data) in &msg_rows {
        let ts = ts_opt.map(epoch_ms_to_iso).unwrap_or_default();
        let role = msg_data
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let parts = parts_by_msg.get(msg_id).cloned().unwrap_or_default();

        let mut m = Map::new();
        m.insert("id".to_string(), Value::String(msg_id.clone()));
        m.insert("session_id".to_string(), Value::String(sid.clone()));
        m.insert("role".to_string(), Value::String(role));
        m.insert("time_created".to_string(), Value::String(ts));
        m.insert("data".to_string(), msg_data.clone());
        m.insert("parts".to_string(), Value::Array(parts));
        results.push(Value::Object(m));
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::Mutex;
    use zutil::test_db::{create_common_tables, insert_session_fixtures};

    /// Mutex to serialize DB-creating tests (all use the same temp file name).
    static DB_MUTEX: Mutex<()> = Mutex::new(());

    /// Create a temporary `SQLite` database with test tables and sample data.
    /// Returns the file path. Caller should delete it after the test.
    fn create_test_db() -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("zfind_test_{}.db", std::process::id()));
        let _ = fs::remove_file(&path); // clean up any leftover

        let conn = Connection::open(&path).expect("open test db");

        // Create tables
        create_common_tables(&conn);
        conn.execute_batch(
            "CREATE TABLE part (
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                data TEXT
            );",
        )
        .expect("create part table");

        // Insert sessions
        insert_session_fixtures(&conn);

        // Messages and parts
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-001",
                "ses-001",
                1_715_000_010_000_i64,
                r#"{"role":"user","agent":"general","tokens":null}"#,
            ],
        )
        .expect("insert msg-001");

        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"general","tokens":null}"#,
            ],
        )
        .expect("insert msg-002");

        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-003",
                "ses-002",
                1_715_000_210_000_i64,
                r#"{"role":"user","agent":"explore","tokens":null}"#,
            ],
        )
        .expect("insert msg-003");

        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-004",
                "ses-002",
                1_715_000_220_000_i64,
                r#"{"role":"assistant","agent":"explore","tokens":null}"#,
            ],
        )
        .expect("insert msg-004");

        // Parts for msg-001 (user text)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-001",
                "ses-001",
                1_715_000_010_000_i64,
                r#"{"type":"text","text":"fix the auth middleware bug"}"#,
            ],
        )
        .expect("insert part msg-001");

        // Parts for msg-002 (reasoning + tool)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"type":"reasoning","text":"I need to read the auth file"}"#,
            ],
        )
        .expect("insert part reasoning msg-002");

        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002", "ses-001", 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts","limit":50}}}"#,
            ],
        ).expect("insert part tool msg-002");

        // Parts for msg-003 (user text)
        conn.execute(
            "INSERT INTO part VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-003",
                "ses-002",
                1_715_000_210_000_i64,
                r#"{"type":"text","text":"how does the migration work?"}"#,
            ],
        )
        .expect("insert part msg-003");

        conn.close().expect("close test db");
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn test_query_sessions_all() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();
        let results = query_sessions_all(&db_path, 50).unwrap();
        // Should return 2 root sessions, ses-003 excluded (parent_id not null)
        assert_eq!(results.len(), 2, "expected 2 root sessions");
        // Most recent first
        assert_eq!(results[0]["id"], "ses-002");
        assert_eq!(results[1]["id"], "ses-001");
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_sessions_keyword() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        // Search for "auth" — should match ses-001
        let results = query_sessions("auth", &db_path, 50).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "ses-001");

        // Search for "migration" — should match ses-002
        let results = query_sessions("migration", &db_path, 50).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "ses-002");

        // Search for nothing — no match
        let results = query_sessions("nonexistent", &db_path, 50).unwrap();
        assert_eq!(results.len(), 0);

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_sessions_exact() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let results =
            query_sessions_exact("auth middleware debug", &db_path, 50)
                .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "ses-001");

        let results =
            query_sessions_exact("nonexistent title", &db_path, 50).unwrap();
        assert_eq!(results.len(), 0);

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_message_by_ids() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let results =
            query_message_by_ids(&["msg-001".into()], None, &db_path, 500);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "msg-001");
        assert_eq!(results[0]["role"], "user");

        let results =
            query_message_by_ids(&["msg-002".into()], None, &db_path, 500);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "msg-002");
        // role from message data (raw), not classify_role
        assert_eq!(results[0]["role"], "assistant");
        // but parts include the tool part
        let parts = results[0]["parts"].as_array().unwrap();
        let has_tool = parts
            .iter()
            .any(|p| p.get("type").and_then(|v| v.as_str()) == Some("tool"));
        assert!(has_tool, "msg-002 parts should include a tool part");

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_message_parts() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let results = query_message_parts("ses-001", &db_path);
        // 2 messages for ses-001
        assert_eq!(results.len(), 2);

        // First part should be the text part
        assert_eq!(results[0]["id"], "msg-001");
        let parts0 = results[0]["parts"].as_array().unwrap();
        assert_eq!(parts0.len(), 1);
        assert_eq!(parts0[0]["type"], "text");

        // Second message has two parts (reasoning + tool)
        assert_eq!(results[1]["id"], "msg-002");
        let parts1 = results[1]["parts"].as_array().unwrap();
        assert_eq!(parts1.len(), 2);
        assert_eq!(parts1[0]["type"], "reasoning");

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_estimate_tokens_with_mock_data() {
        use zutil::estimate_tokens;

        let parts = vec![
            json!({"type": "text", "text": "hello world"}),
            json!({"type": "reasoning", "text": "thinking..."}),
            json!({"type": "step-finish"}),
            json!({"type": "tool", "state": {"input": "query", "output": "result"}}),
        ];
        // text(11) + reasoning(11) + tool_input(json-"query"=7) +
        // tool_output(json-"result"=8) = 37 / 4 = 9
        // Wait: inp.to_string() on a JSON string Value produces "\"query\"" (7 chars)
        // to_string uses display format with quotes
        assert_eq!(estimate_tokens(&parts), 7);
    }
}
