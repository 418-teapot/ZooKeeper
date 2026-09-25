//! Experiment attempt execution engine.
//!
//! The runner turns a planned Experiment into a recorded Attempt. It
//! mirrors the reference Python `runner.py`: a procedure is copied into
//! the Case when the Experiment is planned, and each run resolves an
//! interpreter, spawns the procedure in its own process group, and folds
//! `experiment-attempt-started`/`experiment-attempt-finished` events into
//! the log while holding the Case lock.
//!
//! Signals received by the `zdebug` process are forwarded to the child's
//! whole process group. The child is started with
//! [`std::os::unix::process::CommandExt::process_group`] (the safe
//! equivalent of the Python `start_new_session` option, which makes the
//! child a process-group leader), and forwarding uses `killpg` from the
//! safe `nix` wrapper because `libc::kill` requires an `unsafe` block that
//! this crate forbids.
//!
//! Recovery of an Attempt that was left `running` by a crashed runner is
//! not this module's job; the model's `ATTEMPT_RUNNING` rule rejects a new
//! Attempt while one is still marked running.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::os::fd::OwnedFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, pipe};
use serde_json::{Value, json};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::case::CaseRepository;
use crate::git;
use crate::model::State;
use crate::util::{
    ZdebugError, atomic_write, canonical_json, environment_snapshot, next_id,
    relative_case_path, resolve_path, sha256_file, utc_now, validate_id,
    which_executable,
};

/// File name of a stored Experiment procedure.
const PROCEDURE_NAME: &str = "procedure";

/// Signals forwarded from `zdebug` to a running Attempt's process group.
const FORWARDED_SIGNALS: [i32; 2] = [SIGINT, SIGTERM];

/// Upper bound on how long a single interpreter version probe may run.
const INTERPRETER_VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval while waiting for an interpreter version probe to exit.
const VERSION_PROBE_POLL: Duration = Duration::from_millis(10);

// ── Planning ─────────────────────────────────────────────────────────────────

/// The inputs a caller must supply to plan an Experiment.
///
/// The procedure script is copied into the Case, so later edits to the
/// original file do not change the recorded procedure.
pub struct PlanSpec<'a> {
    /// Identifier for the new Experiment, or `None` to auto-assign the next
    /// free `EX-` identifier under the Case lock.
    pub id: Option<&'a str>,
    /// The question the Experiment answers.
    pub question: &'a str,
    /// Claim ids the Experiment is related to.
    pub related_claims: &'a [String],
    /// Controlled variables held fixed.
    pub controlled: &'a [String],
    /// The independent variable under test, if any.
    pub variable: Option<&'a str>,
    /// Non-empty interpretations of the possible outcomes.
    pub interpretations: &'a [Value],
    /// The script to copy into the Case as the procedure.
    pub script: &'a Path,
    /// Explicit interpreter command line, if the shebang should be ignored.
    pub interpreter: Option<&'a str>,
    /// Working directory the procedure should run from.
    pub cwd: &'a Path,
}

/// Plan an Experiment by copying `spec.script` into the Case and appending
/// an `experiment-planned` event.
///
/// The procedure is stored at
/// `artifacts/experiments/<id>/procedure`; its digest is computed from the
/// stored copy, never from the original source. The Case lock is taken
/// before the filesystem is touched, and the event is validated against
/// the locked state first, so a rejected plan leaves no directory behind.
///
/// # Errors
///
/// Returns `MISSING_INTERPRETATIONS` when no interpretations were given,
/// `INVALID_ID` for a malformed Experiment id, `CASE_BUSY`, `CASE_CLOSED`,
/// `DUPLICATE_EXPERIMENT`, or any reference error raised by the model, plus
/// I/O errors from the copy or the event append.
pub fn plan_experiment(
    case_dir: &Path,
    spec: &PlanSpec<'_>,
) -> Result<Value, ZdebugError> {
    if spec.interpretations.is_empty() {
        return Err(ZdebugError::new(
            "MISSING_INTERPRETATIONS",
            "Experiment requires at least one interpretation",
        ));
    }
    let case_dir = resolve_path(case_dir);
    let repository = CaseRepository::new(&case_dir);
    let _lock = repository.lock()?;
    let mut state = repository.load()?;
    let id = match spec.id {
        Some(id) => id.to_owned(),
        None => next_id("EX", &state.experiments),
    };
    validate_id(&id, "experiment id")?;

    let experiments_dir = case_dir.join("artifacts").join("experiments");
    fs::create_dir_all(&experiments_dir)?;
    // Stage the procedure beside its final home so the recorded digest is
    // computed from the bytes that will actually be stored.
    let staged = StagedProcedure::stage(spec.script, &experiments_dir)?;
    let procedure_dir = experiments_dir.join(&id);
    let procedure_path = procedure_dir.join(PROCEDURE_NAME);
    let payload = json!({
        "id": id,
        "question": spec.question,
        "related_claims": spec.related_claims,
        "controlled": spec.controlled,
        "variable": spec.variable,
        "interpretations": spec.interpretations,
        "procedure_artifact": relative_case_path(&procedure_path, &case_dir)?,
        "procedure_sha256": sha256_file(staged.path())?,
        "interpreter": spec.interpreter,
        "cwd": resolve_path(spec.cwd).to_string_lossy(),
    });
    // Reject the plan before creating the Experiment directory, so a
    // duplicate id or a closed Case cannot leave an orphan behind.
    CaseRepository::validate_event(&state, "experiment-planned", &payload)?;
    let directory = ExperimentDir::create(procedure_dir)?;
    fs::rename(staged.path(), &procedure_path)?;
    let event =
        repository.append_locked(&mut state, "experiment-planned", &payload)?;
    directory.commit();
    Ok(event)
}

/// A staged procedure file removed when dropped.
///
/// The copy lands next to the Experiment directory so it can be renamed
/// into place without crossing a filesystem boundary.
struct StagedProcedure {
    path: PathBuf,
}

impl StagedProcedure {
    /// Copy `source` to a unique temporary sibling under `directory`.
    fn stage(source: &Path, directory: &Path) -> Result<Self, ZdebugError> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |delta| delta.as_nanos());
        let path = directory
            .join(format!(".procedure.{}.{nanos}.tmp", std::process::id()));
        fs::copy(source, &path)?;
        Ok(Self { path })
    }

    /// Return the staged file's path.
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagedProcedure {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// A newly created Experiment directory removed unless committed.
///
/// The guard is committed only once the `experiment-planned` event is
/// persisted, so a copy or append failure cannot leave an orphan behind.
struct ExperimentDir {
    path: PathBuf,
    committed: bool,
}

impl ExperimentDir {
    /// Create `path` exclusively.
    fn create(path: PathBuf) -> Result<Self, ZdebugError> {
        fs::create_dir(&path)?;
        Ok(Self { path, committed: false })
    }

    /// Keep the directory after the event was persisted.
    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for ExperimentDir {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

// ── Execution ────────────────────────────────────────────────────────────────

/// Run one Attempt of `experiment_id` and return its `execution.json`.
///
/// The Case lock is held for the whole call, so a concurrent run fails with
/// `CASE_BUSY`; the model's `ATTEMPT_RUNNING` rule additionally rejects a
/// new Attempt while an earlier one is still marked running.
///
/// # Errors
///
/// Returns `CASE_BUSY`, `CASE_CLOSED`, `EXPERIMENT_NOT_FOUND`,
/// `INVALID_EXPERIMENT`, `ATTEMPT_RUNNING`, `INTERPRETER_NOT_FOUND`,
/// `INVALID_INTERPRETER`, or an I/O error. A failing interpreter runs to
/// completion anyway: the spawn error is written to `stderr.log` and
/// recorded with exit code 127.
#[must_use = "the attempt metadata is the recorded result"]
pub fn run_experiment(
    case_dir: &Path,
    experiment_id: &str,
    cwd: Option<&Path>,
    env_overrides: &BTreeMap<String, String>,
) -> Result<Value, ZdebugError> {
    let case_dir = resolve_path(case_dir);
    let repository = CaseRepository::new(&case_dir);
    let _lock = repository.lock()?;
    let mut state = repository.load()?;
    if state.lifecycle != "OPEN" {
        return Err(ZdebugError::new("CASE_CLOSED", "Case is closed"));
    }
    let experiment =
        state.experiments.get(experiment_id).cloned().ok_or_else(|| {
            ZdebugError::new(
                "EXPERIMENT_NOT_FOUND",
                format!("Experiment not found: {experiment_id}"),
            )
        })?;

    let run = begin_attempt(
        &case_dir,
        experiment_id,
        &experiment,
        cwd,
        env_overrides,
        &repository,
        &mut state,
    )?;
    let procedure = case_dir.join(&run.procedure_artifact);
    let (exit_code, caught) = run_child(
        &run.interpreter,
        &procedure,
        &run.run_cwd,
        &run.environment,
        &run.stdout_path,
        &run.stderr_path,
    )?;
    finish_attempt(
        &case_dir,
        experiment_id,
        &run,
        exit_code,
        caught,
        &repository,
        &mut state,
    )
}

/// An Attempt's identity and inputs, resolved before it is spawned.
struct AttemptRun {
    attempt_id: String,
    procedure_artifact: String,
    procedure_sha256: String,
    interpreter: Vec<String>,
    run_cwd: PathBuf,
    environment: BTreeMap<String, String>,
    explicit_env: BTreeSet<String>,
    before: Vec<Value>,
    started_at: String,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    metadata_path: PathBuf,
}

/// Resolve the Attempt's identity and inputs and record its start.
fn begin_attempt(
    case_dir: &Path,
    experiment_id: &str,
    experiment: &Value,
    cwd: Option<&Path>,
    env_overrides: &BTreeMap<String, String>,
    repository: &CaseRepository,
    state: &mut State,
) -> Result<AttemptRun, ZdebugError> {
    let attempt_number = experiment
        .get("attempts")
        .and_then(Value::as_array)
        .map_or(1, |attempts| attempts.len() + 1);
    let attempt_id = format!("{experiment_id}-A{attempt_number:03}");
    let attempt_dir = case_dir
        .join("artifacts")
        .join("experiments")
        .join(experiment_id)
        .join(&attempt_id);
    if let Some(parent) = attempt_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&attempt_dir)?;
    let stdout_path = attempt_dir.join("stdout.log");
    let stderr_path = attempt_dir.join("stderr.log");
    let metadata_path = attempt_dir.join("execution.json");

    let procedure_artifact = experiment
        .get("procedure_artifact")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ZdebugError::new(
                "INVALID_EXPERIMENT",
                "Experiment has no procedure",
            )
        })?
        .to_owned();
    let procedure = case_dir.join(&procedure_artifact);
    let procedure_sha256 = sha256_file(&procedure)?;
    let interpreter_spec = experiment
        .get("interpreter")
        .and_then(Value::as_str)
        .filter(|spec| !spec.is_empty())
        .or(state.default_interpreter.as_deref());
    let interpreter = resolve_interpreter(interpreter_spec, &procedure)?;
    let run_cwd = experiment_cwd(cwd, experiment)?;
    let environment = build_environment(env_overrides);
    let explicit_env: BTreeSet<String> =
        env_overrides.keys().cloned().collect();
    let before = workspace_snapshots(state, case_dir);
    let started_at = utc_now();
    let started_payload = json!({
        "experiment_id": experiment_id,
        "attempt_id": attempt_id,
        "attempt_number": attempt_number,
        "status": "running",
        "started_at": started_at,
        "cwd": run_cwd.to_string_lossy(),
        "interpreter": interpreter,
        "procedure_sha256": procedure_sha256,
        "stdout": relative_case_path(&stdout_path, case_dir)?,
        "stderr": relative_case_path(&stderr_path, case_dir)?,
        "metadata": relative_case_path(&metadata_path, case_dir)?,
        "workspace_before": before,
    });
    repository.append_locked(
        state,
        "experiment-attempt-started",
        &started_payload,
    )?;
    Ok(AttemptRun {
        attempt_id,
        procedure_artifact,
        procedure_sha256,
        interpreter,
        run_cwd,
        environment,
        explicit_env,
        before,
        started_at,
        stdout_path,
        stderr_path,
        metadata_path,
    })
}

/// Record the Attempt's outcome and return its `execution.json`.
fn finish_attempt(
    case_dir: &Path,
    experiment_id: &str,
    run: &AttemptRun,
    exit_code: i64,
    caught: i32,
    repository: &CaseRepository,
    state: &mut State,
) -> Result<Value, ZdebugError> {
    let signal = if caught == 0 { Value::Null } else { json!(caught) };
    let finished_at = utc_now();
    let after = workspace_snapshots(state, case_dir);
    let status = if caught == 0 { "completed" } else { "interrupted" };
    let metadata = json!({
        "experiment_id": experiment_id,
        "attempt_id": run.attempt_id,
        "status": status,
        "started_at": run.started_at,
        "finished_at": finished_at,
        "cwd": run.run_cwd.to_string_lossy(),
        "interpreter": run.interpreter,
        "interpreter_version": interpreter_version(
            &run.interpreter,
            INTERPRETER_VERSION_TIMEOUT,
        ),
        "procedure": run.procedure_artifact,
        "procedure_sha256": run.procedure_sha256,
        "environment": environment_snapshot(&run.environment, &run.explicit_env),
        "system": {
            "platform": platform_string(),
            "runtime": format!("zdebug {}", env!("CARGO_PKG_VERSION")),
        },
        "exit_code": exit_code,
        "signal": signal,
        "workspace_before": run.before,
        "workspace_after": after,
    });
    atomic_write(
        &run.metadata_path,
        &format!("{}\n", canonical_json(&metadata)),
    )?;
    let finished_payload = json!({
        "experiment_id": experiment_id,
        "attempt_id": run.attempt_id,
        "status": status,
        "finished_at": finished_at,
        "exit_code": exit_code,
        "signal": signal,
        "workspace_after": after,
        "stdout_sha256": sha256_file(&run.stdout_path)?,
        "stderr_sha256": sha256_file(&run.stderr_path)?,
        "metadata_sha256": sha256_file(&run.metadata_path)?,
    });
    repository.append_locked(
        state,
        "experiment-attempt-finished",
        &finished_payload,
    )?;
    Ok(metadata)
}

/// Resolve the Attempt's working directory from the override or the plan.
fn experiment_cwd(
    cwd: Option<&Path>,
    experiment: &Value,
) -> Result<PathBuf, ZdebugError> {
    if let Some(cwd) = cwd {
        return Ok(resolve_path(cwd));
    }
    let planned =
        experiment.get("cwd").and_then(Value::as_str).ok_or_else(|| {
            ZdebugError::new("INVALID_EXPERIMENT", "Experiment has no cwd")
        })?;
    Ok(resolve_path(Path::new(planned)))
}

/// Start and wait for the procedure, returning its exit code and the
/// signal `zdebug` received while it ran (`0` when none did).
fn run_child(
    interpreter: &[String],
    procedure: &Path,
    run_cwd: &Path,
    environment: &BTreeMap<String, String>,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<(i64, i32), ZdebugError> {
    let stdout = fs::File::create(stdout_path)?;
    let stderr = fs::File::create(stderr_path)?;
    let mut signals = Signals::new(FORWARDED_SIGNALS)?;
    let caught = Arc::new(AtomicI32::new(0));
    let child_pgid = Arc::new(AtomicI32::new(0));
    let handle = signals.handle();
    let forwarder = {
        let caught = Arc::clone(&caught);
        let child_pgid = Arc::clone(&child_pgid);
        std::thread::spawn(move || {
            forward_signals(&mut signals, &caught, &child_pgid);
        })
    };

    let mut command = Command::new(&interpreter[0]);
    command
        .args(&interpreter[1..])
        .arg(procedure)
        .current_dir(run_cwd)
        .env_clear()
        .envs(environment)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .process_group(0);
    let exit_code = match command.spawn() {
        Ok(mut child) => {
            child_pgid.store(
                i32::try_from(child.id()).unwrap_or(i32::MAX),
                Ordering::SeqCst,
            );
            child.wait().map_or(127, exit_code_of)
        }
        Err(err) => {
            // Mirror the reference runner: the spawn failure is recorded as
            // a 127 exit and the message becomes the Attempt's stderr.
            let _ = fs::write(stderr_path, format!("{err}\n"));
            127
        }
    };
    handle.close();
    let _ = forwarder.join();
    Ok((exit_code, caught.load(Ordering::SeqCst)))
}

/// Forward every received signal to the child's process group until the
/// signal registration is closed.
fn forward_signals(
    signals: &mut Signals,
    caught: &AtomicI32,
    child_pgid: &AtomicI32,
) {
    for signal in signals.forever() {
        caught.store(signal, Ordering::SeqCst);
        let pgid = child_pgid.load(Ordering::SeqCst);
        if pgid > 0
            && let Ok(forwarded) = Signal::try_from(signal)
        {
            let _ = killpg(Pid::from_raw(pgid), forwarded);
        }
    }
}

/// Express a child exit status the way Python's `Popen.wait` does: a
/// terminating signal is reported as its negative number.
fn exit_code_of(status: ExitStatus) -> i64 {
    status
        .code()
        .map_or_else(|| -i64::from(status.signal().unwrap_or(0)), i64::from)
}

// ── Interpreter resolution ───────────────────────────────────────────────────

/// Resolve the interpreter command line for `procedure`.
///
/// An explicit specification wins; otherwise a `#!` line is honoured; the
/// fallback is `bash`. The leading program is resolved like `shutil.which`
/// -- an absolute or slash-containing path is used as-is, otherwise every
/// `PATH` entry is searched -- and canonicalized before use.
///
/// # Errors
///
/// Returns `INVALID_INTERPRETER` when the specification or shebang parses
/// to nothing, `FILE_NOT_FOUND` when the procedure cannot be read, and
/// `INTERPRETER_NOT_FOUND` when the program is not an executable file.
fn resolve_interpreter(
    specification: Option<&str>,
    procedure: &Path,
) -> Result<Vec<String>, ZdebugError> {
    let parts = if let Some(specification) = specification {
        shlex::split(specification).ok_or_else(malformed_interpreter)?
    } else {
        let first_line = read_first_line(procedure)?;
        match first_line.trim_end_matches('\n').strip_prefix("#!") {
            Some(rest) => {
                shlex::split(rest.trim()).ok_or_else(malformed_interpreter)?
            }
            None => vec!["bash".to_owned()],
        }
    };
    let Some((program, arguments)) = parts.split_first() else {
        return Err(ZdebugError::new(
            "INVALID_INTERPRETER",
            "Interpreter is empty",
        ));
    };
    let executable = which_executable(program)
        .ok_or_else(|| interpreter_not_found(program))?;
    let mut resolved =
        vec![resolve_path(&executable).to_string_lossy().into_owned()];
    resolved.extend(arguments.iter().cloned());
    Ok(resolved)
}

/// Build the `INVALID_INTERPRETER` error for an unparsable specification.
fn malformed_interpreter() -> ZdebugError {
    ZdebugError::new("INVALID_INTERPRETER", "Interpreter is malformed")
}

/// Build the `INTERPRETER_NOT_FOUND` error for `program`.
fn interpreter_not_found(program: &str) -> ZdebugError {
    ZdebugError::new(
        "INTERPRETER_NOT_FOUND",
        format!("Interpreter not found: {program}"),
    )
}

/// Read the first line of `procedure`, replacing invalid UTF-8.
fn read_first_line(path: &Path) -> Result<String, ZdebugError> {
    let file = fs::File::open(path).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            ZdebugError::new(
                "FILE_NOT_FOUND",
                format!("File not found: {}", path.display()),
            )
        } else {
            ZdebugError::from(err)
        }
    })?;
    let mut buffer = Vec::new();
    BufReader::new(file).read_until(b'\n', &mut buffer)?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Query the interpreter's self-reported version, or `"unknown"`.
///
/// The probe runs `<program> --version`, then `-V`, with a null stdin and
/// a hard `timeout`. It must never block the caller indefinitely: the
/// Case lock is held while the Attempt finishes, so a probe that waits on
/// stdin or hangs would freeze every other Case operation.
#[must_use]
fn interpreter_version(interpreter: &[String], timeout: Duration) -> String {
    let Some(program) = interpreter.first() else {
        return "unknown".to_owned();
    };
    for flag in ["--version", "-V"] {
        if let Some(text) = probe_version(program, flag, timeout) {
            return text;
        }
    }
    "unknown".to_owned()
}

/// Run one version probe, returning its first non-empty output line.
///
/// The child's stdout and stderr share a single pipe, so their bytes
/// interleave in arrival order like the reference
/// `subprocess.run(..., stderr=subprocess.STDOUT)`. The read end is
/// non-blocking, so `timeout` bounds draining as well as the wait: a
/// descendant that inherits the write end cannot stall the probe past the
/// deadline, in which case the child is killed and reaped before the
/// caller falls back to the next flag and finally to `"unknown"`.
#[must_use]
fn probe_version(
    program: &str,
    flag: &str,
    timeout: Duration,
) -> Option<String> {
    let (read_fd, write_fd) = pipe().ok()?;
    prepare_read_end(&read_fd)?;
    let mut child = Command::new(program)
        .arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::from(write_fd.try_clone().ok()?))
        .stderr(Stdio::from(write_fd))
        .spawn()
        .ok()?;
    let mut reader = fs::File::from(read_fd);
    let mut text = Vec::new();
    let deadline = Instant::now() + timeout;
    loop {
        drain(&mut reader, &mut text);
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(VERSION_PROBE_POLL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // The child exited, but a descendant may still hold the write end, so
    // the non-blocking read collects whatever is buffered without waiting
    // for end-of-file.
    drain(&mut reader, &mut text);
    let text = String::from_utf8_lossy(&text);
    text.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
}

/// Mark `fd` close-on-exec and non-blocking.
///
/// The write end handed to the child keeps its blocking mode; only the
/// read end held by this process is switched, so the child cannot observe
/// a short write if it emits more than one pipe buffer.
fn prepare_read_end(fd: &OwnedFd) -> Option<()> {
    fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC)).ok()?;
    let flags = fcntl(fd, FcntlArg::F_GETFL).ok()?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(fd, FcntlArg::F_SETFL(flags)).ok()?;
    Some(())
}

/// Read every byte the non-blocking reader currently holds into `buffer`.
///
/// The loop stops at end-of-file or at the first error, which for a
/// non-blocking descriptor is [`io::ErrorKind::WouldBlock`] when no more
/// data is available; errors are not surfaced because the caller only
/// needs the best-effort output the child produced.
fn drain(reader: &mut fs::File, buffer: &mut Vec<u8>) {
    let mut chunk = [0_u8; 4096];
    while let Ok(count) = reader.read(&mut chunk) {
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
}

// ── Environment and snapshots ────────────────────────────────────────────────

/// Copy the current process environment and apply `overrides`.
#[must_use]
fn build_environment(
    overrides: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = std::env::vars_os()
        .filter_map(|(key, value)| {
            Some((key.into_string().ok()?, value.into_string().ok()?))
        })
        .collect();
    for (key, value) in overrides {
        environment.insert(key.clone(), value.clone());
    }
    environment
}

/// Capture a Git snapshot of every workspace, excluding the Case directory.
#[must_use]
fn workspace_snapshots(state: &State, case_dir: &Path) -> Vec<Value> {
    let exclude = [case_dir.to_path_buf()];
    state
        .workspaces
        .iter()
        .filter_map(Value::as_str)
        .map(|path| git::capture_snapshot(Path::new(path), &exclude))
        .collect()
}

/// Canonical `os-arch` platform descriptor for `execution.json`.
#[must_use]
fn platform_string() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::events::EventStore;
    use crate::model;
    use crate::util::sha256_file;

    /// Serialize tests that hold the Case lock while spawning processes.
    fn run_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_guard()
    }

    /// Create an empty open Case with no workspaces.
    fn init_case(case_dir: &Path) {
        init_case_with_workspaces(case_dir, &[]);
    }

    /// Create an empty open Case bound to `workspaces`.
    fn init_case_with_workspaces(case_dir: &Path, workspaces: &[Value]) {
        EventStore::new(case_dir)
            .initialize(
                "CASE-1",
                &json!({
                    "title": "t",
                    "objective": "o",
                    "workspaces": workspaces,
                    "baseline": [],
                    "default_interpreter": null,
                }),
            )
            .unwrap();
    }

    /// Plan `EX-001` from `script`.
    fn plan_with_script(case_dir: &Path, script: &Path) {
        plan_spec(case_dir, script, Some("EX-001")).unwrap();
    }

    /// Plan an Experiment from `script` with an optional explicit id.
    fn plan_spec(
        case_dir: &Path,
        script: &Path,
        id: Option<&str>,
    ) -> Result<Value, ZdebugError> {
        let interpretations =
            vec![json!({"when": "done", "meaning": "observe"})];
        let related_claims: Vec<String> = Vec::new();
        let controlled: Vec<String> = Vec::new();
        let cwd = case_dir.to_path_buf();
        let spec = PlanSpec {
            id,
            question: "observe",
            related_claims: &related_claims,
            controlled: &controlled,
            variable: None,
            interpretations: &interpretations,
            script,
            interpreter: None,
            cwd: &cwd,
        };
        plan_experiment(case_dir, &spec)
    }

    /// Read the last event of the Case log.
    fn last_event(case_dir: &Path) -> Value {
        let (events, _) = EventStore::new(case_dir).read_events(false).unwrap();
        events.last().cloned().unwrap()
    }

    #[test]
    fn test_plan_copies_script_and_hashes_the_copy() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "printf 'one\\n'\n").unwrap();

        let event = {
            let interpretations =
                vec![json!({"when": "done", "meaning": "observe"})];
            let related_claims: Vec<String> = Vec::new();
            let controlled: Vec<String> = Vec::new();
            let spec = PlanSpec {
                id: Some("EX-001"),
                question: "observe",
                related_claims: &related_claims,
                controlled: &controlled,
                variable: None,
                interpretations: &interpretations,
                script: &script,
                interpreter: Some("/bin/sh"),
                cwd: &case_dir,
            };
            plan_experiment(&case_dir, &spec).unwrap()
        };

        // Editing the original after planning must not touch the copy.
        fs::write(&script, "printf 'two\\n'\n").unwrap();
        let stored = case_dir.join("artifacts/experiments/EX-001/procedure");
        assert_eq!(fs::read_to_string(&stored).unwrap(), "printf 'one\\n'\n");
        assert_eq!(
            event["payload"]["procedure_artifact"],
            "artifacts/experiments/EX-001/procedure"
        );
        assert_eq!(
            event["payload"]["procedure_sha256"],
            sha256_file(&stored).unwrap()
        );
        assert_eq!(event["payload"]["interpreter"], "/bin/sh");
    }

    #[test]
    fn test_plan_rejects_empty_interpretations() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "exit 0\n").unwrap();
        let interpretations: Vec<Value> = Vec::new();
        let related_claims: Vec<String> = Vec::new();
        let controlled: Vec<String> = Vec::new();
        let spec = PlanSpec {
            id: Some("EX-001"),
            question: "observe",
            related_claims: &related_claims,
            controlled: &controlled,
            variable: None,
            interpretations: &interpretations,
            script: &script,
            interpreter: None,
            cwd: &case_dir,
        };
        let err = plan_experiment(&case_dir, &spec).unwrap_err();
        assert_eq!(err.code(), "MISSING_INTERPRETATIONS");
    }

    #[test]
    fn test_plan_allocates_the_next_free_id() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();

        let first = plan_spec(&case_dir, &script, None).unwrap();
        assert_eq!(first["payload"]["id"], "EX-001");
        let second = plan_spec(&case_dir, &script, None).unwrap();
        assert_eq!(second["payload"]["id"], "EX-002");
    }

    #[test]
    fn test_plan_duplicate_id_leaves_no_orphan() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        plan_with_script(&case_dir, &script);

        fs::write(&script, "#!/bin/sh\nexit 1\n").unwrap();
        let err = plan_spec(&case_dir, &script, Some("EX-001")).unwrap_err();
        assert_eq!(err.code(), "DUPLICATE_EXPERIMENT");
        // The stored procedure is untouched and no staging file survives.
        let stored = case_dir.join("artifacts/experiments/EX-001/procedure");
        assert_eq!(fs::read_to_string(&stored).unwrap(), "#!/bin/sh\nexit 0\n");
        assert_eq!(
            fs::read_dir(case_dir.join("artifacts/experiments"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn test_plan_closed_case_leaves_no_directory() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let repository = CaseRepository::new(&case_dir);
        repository.finalize().unwrap();
        repository.close("completed").unwrap();

        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        let err = plan_spec(&case_dir, &script, Some("EX-001")).unwrap_err();
        assert_eq!(err.code(), "CASE_CLOSED");
        assert!(!case_dir.join("artifacts/experiments/EX-001").exists());
        assert_eq!(
            fs::read_dir(case_dir.join("artifacts/experiments"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn test_run_records_exit_code_and_artifacts() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 7\n").unwrap();
        plan_with_script(&case_dir, &script);

        let metadata =
            run_experiment(&case_dir, "EX-001", None, &BTreeMap::new())
                .unwrap();
        assert_eq!(metadata["exit_code"], 7);
        assert_eq!(metadata["status"], "completed");
        assert!(metadata["signal"].is_null());
        assert_eq!(metadata["attempt_id"], "EX-001-A001");
        assert_eq!(metadata["interpreter"], json!(["/bin/sh"]));

        let attempt_dir =
            case_dir.join("artifacts/experiments/EX-001/EX-001-A001");
        assert!(attempt_dir.join("stdout.log").exists());
        assert!(attempt_dir.join("stderr.log").exists());
        assert!(attempt_dir.join("execution.json").exists());

        // execution.json carries the platform, interpreter version, and
        // redacted environment snapshot.
        let execution: Value = serde_json::from_str(
            &fs::read_to_string(attempt_dir.join("execution.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(execution["exit_code"], 7);
        assert_eq!(
            execution["procedure"],
            "artifacts/experiments/EX-001/procedure"
        );
        assert!(execution["interpreter_version"].is_string());
        assert!(execution["system"]["platform"].is_string());
        assert!(execution["environment"]["value_hashes"].is_object());

        let finished = last_event(&case_dir);
        assert_eq!(finished["type"], "experiment-attempt-finished");
        assert_eq!(finished["payload"]["exit_code"], 7);
        assert_eq!(finished["payload"]["signal"], Value::Null);
        assert_eq!(finished["payload"]["status"], "completed");
        assert_eq!(
            finished["payload"]["metadata_sha256"].as_str().unwrap(),
            sha256_file(&attempt_dir.join("execution.json")).unwrap()
        );
        assert_eq!(
            finished["payload"]["stdout_sha256"].as_str().unwrap(),
            sha256_file(&attempt_dir.join("stdout.log")).unwrap()
        );

        // The persisted log folds back into a finished Attempt.
        let (events, _) =
            EventStore::new(&case_dir).read_events(false).unwrap();
        let state = model::replay(&events).unwrap();
        let attempt = &state.experiments["EX-001"]["attempts"][0];
        assert_eq!(attempt["status"], "completed");
        assert_eq!(attempt["exit_code"], 7);
    }

    #[test]
    fn test_run_records_workspace_snapshots() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        init_case_with_workspaces(
            &case_dir,
            &[json!(workspace.to_string_lossy())],
        );
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        plan_with_script(&case_dir, &script);

        let metadata =
            run_experiment(&case_dir, "EX-001", None, &BTreeMap::new())
                .unwrap();
        assert_eq!(metadata["workspace_before"][0]["kind"], "directory");
        assert_eq!(metadata["workspace_after"][0]["kind"], "directory");
        assert_eq!(
            last_event(&case_dir)["payload"]["workspace_after"][0]["kind"],
            "directory"
        );
    }

    #[test]
    fn test_run_records_signal_when_child_is_killed() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nkill -KILL $$\n").unwrap();
        plan_with_script(&case_dir, &script);

        let metadata =
            run_experiment(&case_dir, "EX-001", None, &BTreeMap::new())
                .unwrap();
        // The child was killed by SIGKILL, which Python reports as -9.
        assert_eq!(metadata["exit_code"], -9);
        // No signal reached the runner itself, so this is not "interrupted".
        assert_eq!(metadata["status"], "completed");
        assert!(metadata["signal"].is_null());
    }

    #[test]
    fn test_run_forwards_signal_to_process_group() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);

        let marker = dir.path().join("marker");
        let pidfile = dir.path().join("grand.pid");
        let grandchild = dir.path().join("grandchild.sh");
        fs::write(
            &grandchild,
            "#!/bin/sh\n\
             trap 'touch \"$MARKER\"; exit 0' TERM\n\
             printf '%s' \"$$\" > \"$PIDFILE\"\n\
             sleep 30\n",
        )
        .unwrap();
        let script = dir.path().join("procedure.sh");
        fs::write(
            &script,
            "#!/bin/sh\n\
             sh \"$GRANDCHILD\" &\n\
             grand=$!\n\
             while [ ! -f \"$PIDFILE\" ]; do sleep 0.05; done\n\
             kill -TERM \"$RUNNER_PID\"\n\
             wait \"$grand\"\n",
        )
        .unwrap();
        plan_with_script(&case_dir, &script);

        let mut overrides = BTreeMap::new();
        overrides
            .insert("RUNNER_PID".to_owned(), std::process::id().to_string());
        overrides.insert(
            "GRANDCHILD".to_owned(),
            grandchild.to_string_lossy().into_owned(),
        );
        overrides.insert(
            "PIDFILE".to_owned(),
            pidfile.to_string_lossy().into_owned(),
        );
        overrides
            .insert("MARKER".to_owned(), marker.to_string_lossy().into_owned());

        let metadata =
            run_experiment(&case_dir, "EX-001", None, &overrides).unwrap();
        assert_eq!(metadata["signal"], 15);
        assert_eq!(metadata["status"], "interrupted");
        assert_eq!(last_event(&case_dir)["payload"]["signal"], 15);

        // The grandchild only receives the signal through the process-group
        // forward, so let it finish its trap before checking the marker.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            marker.exists(),
            "grandchild did not receive the forwarded signal"
        );
    }

    #[test]
    fn test_run_rejects_when_attempt_already_running() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let script = dir.path().join("procedure.sh");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        plan_with_script(&case_dir, &script);

        EventStore::new(&case_dir)
            .append(
                "experiment-attempt-started",
                &json!({
                    "experiment_id": "EX-001",
                    "attempt_id": "EX-001-A001",
                }),
            )
            .unwrap();

        let err = run_experiment(&case_dir, "EX-001", None, &BTreeMap::new())
            .unwrap_err();
        assert_eq!(err.code(), "ATTEMPT_RUNNING");
    }

    #[test]
    fn test_run_unknown_experiment() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        init_case(&case_dir);
        let err = run_experiment(&case_dir, "EX-404", None, &BTreeMap::new())
            .unwrap_err();
        assert_eq!(err.code(), "EXPERIMENT_NOT_FOUND");
    }

    #[test]
    fn test_resolve_interpreter_prefers_explicit_spec() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "#!/bin/bash\nexit 0\n").unwrap();
        let resolved =
            resolve_interpreter(Some("/bin/sh -e"), &procedure).unwrap();
        assert!(resolved[0].ends_with("sh"));
        assert_eq!(resolved[1], "-e");
    }

    #[test]
    fn test_resolve_interpreter_reads_shebang() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "#!/bin/sh\nexit 0\n").unwrap();
        let resolved = resolve_interpreter(None, &procedure).unwrap();
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].ends_with("sh"));
    }

    #[test]
    fn test_resolve_interpreter_defaults_to_bash() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "exit 0\n").unwrap();
        if which_executable("bash").is_none() {
            return;
        }
        let resolved = resolve_interpreter(None, &procedure).unwrap();
        assert!(resolved[0].ends_with("bash"));
    }

    #[test]
    fn test_resolve_interpreter_missing_program() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "exit 0\n").unwrap();
        let err = resolve_interpreter(
            Some("zdebug-definitely-missing-interpreter"),
            &procedure,
        )
        .unwrap_err();
        assert_eq!(err.code(), "INTERPRETER_NOT_FOUND");
    }

    #[test]
    fn test_resolve_interpreter_rejects_non_executable_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "exit 0\n").unwrap();
        let program = dir.path().join("not-executable");
        fs::write(&program, "exit 0\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o644))
            .unwrap();
        let specification = program.to_string_lossy().into_owned();
        let err =
            resolve_interpreter(Some(&specification), &procedure).unwrap_err();
        assert_eq!(err.code(), "INTERPRETER_NOT_FOUND");
    }

    #[test]
    fn test_interpreter_version_captures_output() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("version.sh");
        fs::write(&script, "#!/bin/sh\nprintf 'fake 1.2.3\\n'\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .unwrap();

        let interpreter = vec![script.to_string_lossy().into_owned()];
        let version =
            interpreter_version(&interpreter, INTERPRETER_VERSION_TIMEOUT);
        assert_eq!(version, "fake 1.2.3");
    }

    #[test]
    fn test_interpreter_version_times_out_on_hanging_probe() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hanging.sh");
        fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .unwrap();

        let interpreter = vec![script.to_string_lossy().into_owned()];
        let start = Instant::now();
        let version =
            interpreter_version(&interpreter, Duration::from_millis(200));
        assert_eq!(version, "unknown");
        // The probe must return well before the child's own sleep elapses.
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "probe blocked for {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn test_interpreter_version_merges_stderr_into_stdout() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("merged.sh");
        fs::write(&script, "#!/bin/sh\necho err-first >&2\necho out-second\n")
            .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .unwrap();

        let interpreter = vec![script.to_string_lossy().into_owned()];
        let version =
            interpreter_version(&interpreter, INTERPRETER_VERSION_TIMEOUT);
        // Sharing one pipe preserves arrival order, so the stderr line that
        // the script writes first is also the first line returned. Separate
        // pipes read stdout first and would yield "out-second" instead.
        assert_eq!(version, "err-first");
    }

    #[test]
    fn test_interpreter_version_returns_when_descendant_holds_pipe() {
        let _guard = run_guard();
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("leaky.sh");
        fs::write(&script, "#!/bin/sh\nprintf 'fake 9.9.9\\n'\nsleep 8 &\n")
            .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .unwrap();

        let interpreter = vec![script.to_string_lossy().into_owned()];
        let start = Instant::now();
        let version = interpreter_version(&interpreter, Duration::from_secs(3));
        assert_eq!(version, "fake 9.9.9");
        // The background `sleep` inherits the probe's pipe write end and
        // outlives the probe; a blocking drain would wait it out, while the
        // deadline-bounded drain returns as soon as the child exits.
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "probe blocked for {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn test_resolve_interpreter_empty_spec() {
        let dir = tempfile::tempdir().unwrap();
        let procedure = dir.path().join("procedure.sh");
        fs::write(&procedure, "#!/bin/sh\nexit 0\n").unwrap();
        let err = resolve_interpreter(Some("   "), &procedure).unwrap_err();
        assert_eq!(err.code(), "INVALID_INTERPRETER");
    }
}
