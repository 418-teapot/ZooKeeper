//! Shared test harness for the ZooKeeper CLI integration tests.
//!
//! Spawning a CLI with `Command::new` inherits the developer's environment,
//! so an integration test can accidentally read the real `~/.zoo/log`,
//! `~/.pi/agent` or `~/.local/share/opencode` data and produce results that
//! depend on the machine and terminal running the suite.  [`TestEnv`]
//! removes that class of flakiness: it owns temporary directories, pins the
//! environment on every command it builds, and drops (and so removes) its
//! temp dirs at the end of the test.

pub mod pi;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tempfile::TempDir;

/// Terminal width pinned for spawned commands unless overridden.
///
/// `zutil::get_terminal_width` reads `COLUMNS` before querying the
/// controlling terminal, so pinning it keeps table rendering (and any
/// assertion about rendered columns) independent of the terminal that runs
/// the tests.
pub const DEFAULT_COLUMNS: u16 = 80;

/// `COLUMNS`, consumed by `zutil::get_terminal_width`.
const COLUMNS: &str = "COLUMNS";

/// `HOME`, backing every `~` expansion and the host data-dir defaults.
const HOME: &str = "HOME";

/// Mirrors `zutil::db_helpers::ZOO_OPENCODE_DATA_DIR`; kept as a literal so
/// this harness does not force the `db-helpers` feature on tools that do not
/// use it (e.g. `zlog`).
const ZOO_OPENCODE_DATA_DIR: &str = "ZOO_OPENCODE_DATA_DIR";

/// Mirrors `zutil::session::ZOO_PI_DATA_DIR`.
const ZOO_PI_DATA_DIR: &str = "ZOO_PI_DATA_DIR";

/// A hermetic environment for spawning CLI processes under test.
///
/// The struct owns the temporary directories backing `HOME`,
/// `ZOO_OPENCODE_DATA_DIR` and `ZOO_PI_DATA_DIR`, so a fixture that keeps
/// the `TestEnv` alive keeps those directories alive too.
pub struct TestEnv {
    home: TempDir,
    opencode_data: TempDir,
    pi_data: TempDir,
    columns: u16,
}

impl TestEnv {
    /// Create an environment backed by fresh, empty temporary directories.
    #[must_use]
    pub fn new() -> Self {
        Self {
            home: TempDir::new().expect("create temp HOME"),
            opencode_data: TempDir::new()
                .expect("create temp opencode data dir"),
            pi_data: TempDir::new().expect("create temp pi data dir"),
            columns: DEFAULT_COLUMNS,
        }
    }

    /// Pin `COLUMNS` to `columns` for every command built from this
    /// environment, instead of [`DEFAULT_COLUMNS`].
    #[must_use]
    pub fn with_columns(mut self, columns: u16) -> Self {
        self.columns = columns;
        self
    }

    /// The temporary directory used as `HOME`.
    #[must_use]
    pub fn home(&self) -> &Path {
        self.home.path()
    }

    /// The temporary directory used as `ZOO_OPENCODE_DATA_DIR`.
    #[must_use]
    pub fn opencode_data(&self) -> &Path {
        self.opencode_data.path()
    }

    /// The temporary directory used as `ZOO_PI_DATA_DIR`.
    #[must_use]
    pub fn pi_data(&self) -> &Path {
        self.pi_data.path()
    }

    /// The `~/.zoo/log` directory under this environment's `HOME`.
    ///
    /// This is the default log directory the CLI tools read.  The
    /// directory is returned as a path only and is not created; a test
    /// that seeds log fixtures creates it (and the files inside) itself.
    #[must_use]
    pub fn zoo_log_dir(&self) -> PathBuf {
        self.home.path().join(".zoo").join("log")
    }

    /// Build a `Command` for `program` with the environment pinned.
    ///
    /// The pinned variables are `HOME`, `ZOO_OPENCODE_DATA_DIR`,
    /// `ZOO_PI_DATA_DIR` and `COLUMNS`.  A test that needs a different value
    /// — a home directory seeded with log files, a wider terminal, a data
    /// directory holding fixtures — overrides the variable with its own
    /// `Command::env` call; the last value set for a key wins.
    #[must_use]
    pub fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let mut cmd = Command::new(program);
        cmd.env(HOME, self.home.path())
            .env(ZOO_OPENCODE_DATA_DIR, self.opencode_data.path())
            .env(ZOO_PI_DATA_DIR, self.pi_data.path())
            .env(COLUMNS, self.columns.to_string());
        cmd
    }
}

impl Default for TestEnv {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a spawned command's stdout as JSON, ignoring surrounding
/// whitespace.
///
/// # Panics
///
/// Panics if stdout is not valid JSON (test-only — a command under test
/// that should emit JSON emitted something else).
#[must_use]
pub fn parse_stdout_json(output: &std::process::Output) -> Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).expect("stdout should be valid JSON")
}

/// Create a unique temporary directory for a test.
///
/// The parent directory is unique per process and per call: parallel
/// test processes must never share a path, or one run can delete the
/// directory while another is renaming into it (observed as
/// "cannot move staging" failures in zwiki's `atomic_dir_swap`).  The
/// final segment stays `name` because some tests derive expectations
/// (e.g. generated index titles) from the directory name.  A stale
/// directory left by a crashed run under a recycled pid is removed
/// first; no live process can own the same pid + counter pair.
#[must_use]
pub fn temp_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir()
        .join(format!("zoo-test-{}-{id}", std::process::id()))
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("failed to create temp dir");
    dir
}
