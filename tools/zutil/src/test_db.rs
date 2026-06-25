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
