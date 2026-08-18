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

/// Insert 3 shared session fixtures (ses-001, ses-002, ses-003).
///
/// Data is identical between zfind and zinspect tests.
///
/// # Panics
///
/// Panics if any INSERT fails (test-only — indicates broken fixture data).
pub fn insert_session_fixtures(conn: &Connection) {
    let model_json = r#"{"name":"deepseek-v4"}"#;

    // ses-001: root session, "auth middleware debug"
    conn.execute(
        "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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

    // ses-002: root session, "DB migration from v2 to v3"
    conn.execute(
        "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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

    // ses-003: child session, parent_id="ses-001", "auth retry"
    conn.execute(
        "INSERT INTO session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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
