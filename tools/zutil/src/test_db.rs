use std::path::Path;

use rusqlite::Connection;

/// Create the `session` and `message` tables (identical schemas in both tools).
///
/// # Panics
///
/// Panics if the SQL table creation fails (test-only — indicates broken schema).
pub fn create_common_tables(conn: &Connection) {
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
        );",
    )
    .expect("create common test tables");
}

/// Create the `part` table used by the CLI fixture schema
/// (`create_common_tables` covers `session` and `message`).
///
/// # Panics
///
/// Panics if the SQL table creation fails (test-only — indicates broken schema).
pub fn create_part_table(conn: &Connection) {
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
}

/// Create a two-database fixture directory.
///
/// `opencode.db` holds `db1_ids` and `opencode-stable.db` holds
/// `db2_ids`, both with the full `session`/`message`/`part` schema. One
/// message + part pair is inserted per database (attached to the first id
/// of each list) so the merge views can be exercised for all three tables.
///
/// # Panics
///
/// Panics if any fixture table or row cannot be created (test-only —
/// indicates broken fixture setup).
pub fn create_two_db_dir(dir: &Path, db1_ids: &[&str], db2_ids: &[&str]) {
    create_db_with_rows(&dir.join("opencode.db"), db1_ids);
    create_db_with_rows(&dir.join("opencode-stable.db"), db2_ids);
}

/// Create a second-DB fixture (session `ses-900` + one message/part).
///
/// The session lives only in this database with unique
/// title/slug/agent/model values. Used by CLI integration tests to
/// exercise multi-DB aggregation.
///
/// # Panics
///
/// Panics if any fixture table or row cannot be created (test-only —
/// indicates broken fixture setup).
pub fn create_second_db(path: &Path) {
    let conn = Connection::open(path).expect("open second test db");
    create_common_tables(&conn);
    create_part_table(&conn);

    conn.execute(
        "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            "ses-900",
            Option::<&str>::None,
            "archived stable channel session",
            "archived-stable-channel",
            "kiwi",
            "/srv",
            r#"{"name":"deepseek-v4"}"#,
            1_715_000_600_000_i64,
            1_715_000_700_000_i64,
            0.001,
            10.0,
            5.0,
            0.0,
            0.0,
            0.0,
        ],
    )
    .expect("insert ses-900");

    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) \
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            "msg-900",
            "ses-900",
            1_715_000_610_000_i64,
            r#"{"role":"user","agent":"kiwi"}"#,
        ],
    )
    .expect("insert msg-900");

    conn.execute(
        "INSERT INTO part (id, message_id, session_id, time_created, \
         time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            "part-900",
            "msg-900",
            "ses-900",
            1_715_000_610_000_i64,
            1_715_000_610_000_i64,
            r#"{"type":"text","text":"hello from the stable channel"}"#,
        ],
    )
    .expect("insert part-900");

    conn.close().expect("close second test db");
}

/// Create a single fixture DB file with the full three-table schema and
/// one message + part row pair per (first) session.
fn create_db_with_rows(path: &Path, ids: &[&str]) {
    let conn = Connection::open(path).expect("open fixture db");
    create_common_tables(&conn);
    create_part_table(&conn);
    for id in ids {
        conn.execute(
            "INSERT INTO session (id) VALUES (?1)",
            rusqlite::params![id],
        )
        .expect("insert fixture session");
    }
    if let Some(first) = ids.first() {
        let msg_id = format!("fix-msg-{first}");
        conn.execute(
            "INSERT INTO message (id, session_id) VALUES (?1, ?2)",
            rusqlite::params![msg_id, first],
        )
        .expect("insert fixture message");
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, data) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                format!("fix-part-{first}"),
                msg_id,
                first,
                r#"{"type":"text","text":"fixture"}"#,
            ],
        )
        .expect("insert fixture part");
    }
    conn.close().expect("close fixture db");
}

/// Column values for one `session` row in a CLI fixture database.
///
/// Mirrors the schema created by [`create_common_tables`]: fifteen columns
/// with a nullable `parent_id`.
pub struct SessionRow<'a> {
    /// Primary key, e.g. `ses-001`.
    pub id: &'a str,
    /// Parent session id, or `None` for a root session.
    pub parent_id: Option<&'a str>,
    /// Human-readable session title.
    pub title: &'a str,
    /// URL-ish slug derived from the title.
    pub slug: &'a str,
    /// Agent that owns the session.
    pub agent: &'a str,
    /// Working directory recorded on the session.
    pub directory: &'a str,
    /// Raw JSON model descriptor, e.g. `{"name":"deepseek-v4"}`.
    pub model: &'a str,
    /// Creation time in epoch milliseconds.
    pub time_created: i64,
    /// Last-update time in epoch milliseconds.
    pub time_updated: i64,
    /// Accumulated cost.
    pub cost: f64,
    /// Input token count.
    pub tokens_input: f64,
    /// Output token count.
    pub tokens_output: f64,
    /// Reasoning token count.
    pub tokens_reasoning: f64,
    /// Cache-read token count.
    pub tokens_cache_read: f64,
    /// Cache-write token count.
    pub tokens_cache_write: f64,
}

/// Insert one full `session` row from `row`.
///
/// # Panics
///
/// Panics if the insert fails (test-only — indicates broken fixture).
pub fn insert_session(conn: &Connection, row: &SessionRow<'_>) {
    conn.execute(
        "INSERT INTO session VALUES \
         (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            row.id,
            row.parent_id,
            row.title,
            row.slug,
            row.agent,
            row.directory,
            row.model,
            row.time_created,
            row.time_updated,
            row.cost,
            row.tokens_input,
            row.tokens_output,
            row.tokens_reasoning,
            row.tokens_cache_read,
            row.tokens_cache_write,
        ],
    )
    .expect("insert session");
}

/// Insert one `message` row.
///
/// `data` is the raw JSON payload stored on the row.
///
/// # Panics
///
/// Panics if the insert fails (test-only — indicates broken fixture).
pub fn insert_message(
    conn: &Connection,
    id: &str,
    session_id: &str,
    time_created: i64,
    data: &str,
) {
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) \
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, session_id, time_created, data],
    )
    .expect("insert message");
}

/// Insert the two sessions shared verbatim by the `zfind`, `zinspect`,
/// and `ztrace` CLI fixtures.
///
/// `ses-001` is the root "auth middleware debug" session (agent
/// `beaver`, `/app`) and `ses-002` is the root "DB migration from v2 to
/// v3" session (agent `lynx`, `/db`). Both use the default model
/// `{"name":"deepseek-v4"}` and a NULL `parent_id`.
///
/// Call [`create_common_tables`] before this helper.
///
/// # Panics
///
/// Panics if either insert fails (test-only — indicates broken fixture).
pub fn seed_common_sessions(conn: &Connection) {
    insert_session(
        conn,
        &SessionRow {
            id: "ses-001",
            parent_id: None,
            title: "auth middleware debug",
            slug: "auth-middleware-debug",
            agent: "beaver",
            directory: "/app",
            model: r#"{"name":"deepseek-v4"}"#,
            time_created: 1_715_000_000_000,
            time_updated: 1_715_000_100_000,
            cost: 0.012,
            tokens_input: 500.0,
            tokens_output: 300.0,
            tokens_reasoning: 0.0,
            tokens_cache_read: 0.0,
            tokens_cache_write: 0.0,
        },
    );
    insert_session(
        conn,
        &SessionRow {
            id: "ses-002",
            parent_id: None,
            title: "DB migration from v2 to v3",
            slug: "db-migration-v2-v3",
            agent: "lynx",
            directory: "/db",
            model: r#"{"name":"deepseek-v4"}"#,
            time_created: 1_715_000_200_000,
            time_updated: 1_715_000_300_000,
            cost: 0.008,
            tokens_input: 200.0,
            tokens_output: 100.0,
            tokens_reasoning: 50.0,
            tokens_cache_read: 0.0,
            tokens_cache_write: 0.0,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Open an in-memory DB with the `session`/`message` tables ready.
    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        create_common_tables(&conn);
        conn
    }

    fn session_text(conn: &Connection, id: &str, column: &str) -> String {
        conn.query_row(
            &format!("SELECT {column} FROM session WHERE id = ?1"),
            rusqlite::params![id],
            |row| row.get(0),
        )
        .expect("query session text")
    }

    fn session_i64(conn: &Connection, id: &str, column: &str) -> i64 {
        conn.query_row(
            &format!("SELECT {column} FROM session WHERE id = ?1"),
            rusqlite::params![id],
            |row| row.get(0),
        )
        .expect("query session integer")
    }

    fn session_f64(conn: &Connection, id: &str, column: &str) -> f64 {
        conn.query_row(
            &format!("SELECT {column} FROM session WHERE id = ?1"),
            rusqlite::params![id],
            |row| row.get(0),
        )
        .expect("query session real")
    }

    #[test]
    fn test_seed_common_sessions_count() {
        let conn = memory_db();
        seed_common_sessions(&conn);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
            .expect("count sessions");
        assert_eq!(count, 2);
    }

    #[test]
    fn test_seed_common_sessions_ses_001() {
        let conn = memory_db();
        seed_common_sessions(&conn);
        assert_eq!(
            session_text(&conn, "ses-001", "title"),
            "auth middleware debug"
        );
        assert_eq!(
            session_text(&conn, "ses-001", "slug"),
            "auth-middleware-debug"
        );
        assert_eq!(session_text(&conn, "ses-001", "agent"), "beaver");
        assert_eq!(session_text(&conn, "ses-001", "directory"), "/app");
        assert_eq!(
            session_text(&conn, "ses-001", "model"),
            r#"{"name":"deepseek-v4"}"#
        );
        assert_eq!(
            session_i64(&conn, "ses-001", "time_created"),
            1_715_000_000_000
        );
        assert!(
            (session_f64(&conn, "ses-001", "cost") - 0.012).abs()
                < f64::EPSILON
        );
        assert!(
            (session_f64(&conn, "ses-001", "tokens_input") - 500.0).abs()
                < f64::EPSILON
        );
        assert!(
            (session_f64(&conn, "ses-001", "tokens_output") - 300.0).abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn test_seed_common_sessions_ses_002() {
        let conn = memory_db();
        seed_common_sessions(&conn);
        assert_eq!(
            session_text(&conn, "ses-002", "title"),
            "DB migration from v2 to v3"
        );
        assert_eq!(session_text(&conn, "ses-002", "agent"), "lynx");
        assert_eq!(session_text(&conn, "ses-002", "directory"), "/db");
        assert_eq!(
            session_i64(&conn, "ses-002", "time_created"),
            1_715_000_200_000
        );
        assert!(
            (session_f64(&conn, "ses-002", "tokens_reasoning") - 50.0).abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn test_insert_session_null_parent() {
        let conn = memory_db();
        insert_session(
            &conn,
            &SessionRow {
                id: "ses-100",
                parent_id: None,
                title: "t",
                slug: "s",
                agent: "a",
                directory: "/d",
                model: "{}",
                time_created: 1,
                time_updated: 2,
                cost: 0.0,
                tokens_input: 0.0,
                tokens_output: 0.0,
                tokens_reasoning: 0.0,
                tokens_cache_read: 0.0,
                tokens_cache_write: 0.0,
            },
        );
        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM session WHERE id = 'ses-100'",
                [],
                |row| row.get(0),
            )
            .expect("query parent_id");
        assert_eq!(parent, None);
    }

    #[test]
    fn test_insert_message_roundtrip() {
        let conn = memory_db();
        insert_message(&conn, "msg-001", "ses-001", 1_715_000_010_000, "{}");
        let (sid, data): (String, String) = conn
            .query_row(
                "SELECT session_id, data FROM message WHERE id = 'msg-001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query message");
        assert_eq!(sid, "ses-001");
        assert_eq!(data, "{}");
    }
}
