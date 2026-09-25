//! End-to-end CLI integration tests for `zdebug`.
//!
//! Every test spawns the real `zdebug` binary (`CARGO_BIN_EXE_zdebug`)
//! inside its own temporary workspace. Nothing is mocked: the Case facade,
//! the append-only event store, the experiment runner, and Git all run for
//! real across the process boundary.
//!
//! Assertions target the documented contract: a successful command exits 0
//! and prints `{"ok":true,"result":...}` on stdout, while a business error
//! exits 2 and prints `{"ok":false,"code":...,"message":...,"details":...}`
//! on stderr.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use tempfile::TempDir;
use zdebug::events::EventStore;

/// Absolute path to the freshly built `zdebug` binary.
const ZDEBUG: &str = env!("CARGO_BIN_EXE_zdebug");

/// Identifier of the single Case every workspace holds.
const CASE_ID: &str = "CASE-1";

/// One finished CLI invocation.
struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Run {
    /// Assert success and return the `result` value of the JSON envelope.
    fn result(&self) -> Value {
        assert_eq!(
            self.code, 0,
            "expected success\nstdout: {}\nstderr: {}",
            self.stdout, self.stderr
        );
        let envelope = self.envelope();
        assert_eq!(envelope["ok"].as_bool(), Some(true), "{}", self.stdout);
        envelope.get("result").cloned().unwrap_or(Value::Null)
    }

    /// Assert the business-error contract and return the error envelope.
    fn error(&self) -> Value {
        assert_eq!(
            self.code, 2,
            "expected business error\nstdout: {}\nstderr: {}",
            self.stdout, self.stderr
        );
        let envelope = self.error_envelope();
        assert_eq!(envelope["ok"].as_bool(), Some(false), "{}", self.stderr);
        envelope
    }

    /// Parse the JSON stdout envelope.
    fn envelope(&self) -> Value {
        serde_json::from_str(self.stdout.trim()).unwrap_or_else(|err| {
            panic!("stdout is not JSON: {err}\n{}", self.stdout)
        })
    }

    /// Parse the JSON stderr error envelope.
    fn error_envelope(&self) -> Value {
        serde_json::from_str(self.stderr.trim()).unwrap_or_else(|err| {
            panic!("stderr is not JSON: {err}\n{}", self.stderr)
        })
    }
}

/// A temporary workspace and the Case operations run inside it.
struct Workspace {
    dir: TempDir,
}

impl Workspace {
    /// Create an empty temporary workspace.
    fn new() -> Self {
        Self { dir: TempDir::new().expect("create tempdir") }
    }

    /// The workspace root path.
    fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Resolve a path relative to the workspace root.
    fn file(&self, relative: &str) -> PathBuf {
        self.path().join(relative)
    }

    /// Write `contents` to a workspace-relative path.
    fn write(&self, relative: &str, contents: &str) {
        fs::write(self.file(relative), contents).expect("write fixture");
    }

    /// Run `zdebug` in the workspace root.
    fn run(&self, args: &[&str]) -> Run {
        Self::run_in(self.path(), args)
    }

    /// Run `zdebug` in `cwd`.
    fn run_in(cwd: &Path, args: &[&str]) -> Run {
        Self::run_child(cwd, None, args)
    }

    /// Run `zdebug` in `cwd` with `HOME` overridden for the child.
    fn run_with_home(home: &Path, cwd: &Path, args: &[&str]) -> Run {
        Self::run_child(cwd, Some(home), args)
    }

    /// Spawn `zdebug`, optionally overriding the child `HOME`.
    fn run_child(cwd: &Path, home: Option<&Path>, args: &[&str]) -> Run {
        let mut command = Command::new(ZDEBUG);
        command.args(args).current_dir(cwd);
        if let Some(home) = home {
            command.env("HOME", home);
        }
        let output = command.output().expect("spawn zdebug");
        Run {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    /// Run a command with `--json` expected to succeed, returning `result`.
    fn ok(&self, args: &[&str]) -> Value {
        let mut full = vec!["--json"];
        full.extend_from_slice(args);
        self.run(&full).result()
    }

    /// Initialize `CASE-1` over this workspace, plus any `extra` arguments.
    fn init_case(&self, extra: &[&str]) {
        let root = self.path().to_string_lossy().into_owned();
        let mut args = vec![
            "case",
            "init",
            CASE_ID,
            "--title",
            "test",
            "--objective",
            "test objective",
            "--workspace",
            root.as_str(),
        ];
        args.extend_from_slice(extra);
        self.ok(&args);
    }

    /// Turn the workspace into a Git repository with one committed file.
    fn init_git_repo(&self) {
        let root = self.path();
        git(root, &["init", "-q"]);
        self.write("source.txt", "baseline\n");
        git(root, &["add", "source.txt"]);
        git(
            root,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "init",
            ],
        );
    }

    /// Plan `EX-001` from a `/bin/sh` procedure with one interpretation.
    fn plan_experiment(&self, procedure: &str) {
        self.write(
            "interpretations.json",
            r#"[{"when":"done","meaning":"observe"}]"#,
        );
        self.write("procedure.sh", procedure);
        self.ok(&[
            "experiment",
            "plan",
            "--id",
            "EX-001",
            "--question",
            "observe",
            "--interpretations",
            "interpretations.json",
            "--script",
            "procedure.sh",
        ]);
    }
}

/// Run `git` in `cwd`, asserting it succeeded.
fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Append raw bytes to a file, simulating a partial write before a crash.
fn append_bytes(path: &Path, bytes: &[u8]) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open for append");
    file.write_all(bytes).expect("append bytes");
}

/// Recursively copy `from` into `to`.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create copy dir");
    for entry in fs::read_dir(from).expect("read source dir") {
        let entry = entry.expect("read entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

// ── Reference behaviour ──────────────────────────────────────────────────────

/// A diagnosis-only Case closes without a passing verification command.
#[test]
fn happy_path_closes_case() {
    let ws = Workspace::new();
    ws.init_git_repo();
    ws.init_case(&[]);
    ws.ok(&[
        "deliverable",
        "add",
        "--title",
        "cause",
        "--contract",
        "cause",
        "--criterion",
        "observation",
    ]);
    ws.ok(&[
        "claim",
        "add",
        "--id",
        "CL-001",
        "--statement",
        "The fixture is broken",
    ]);
    ws.write(
        "interpretations.json",
        r#"[{"when":"failure","meaning":"supports"}]"#,
    );
    ws.write("procedure.sh", "#!/bin/sh\nexit 7\n");
    ws.ok(&[
        "experiment",
        "plan",
        "--id",
        "EX-001",
        "--question",
        "Does the fixture fail?",
        "--claim",
        "CL-001",
        "--variable",
        "none",
        "--interpretations",
        "interpretations.json",
        "--script",
        "procedure.sh",
    ]);
    let metadata = ws.ok(&["experiment", "run", "EX-001"]);
    assert_eq!(metadata["exit_code"].as_i64(), Some(7));
    assert_eq!(metadata["status"].as_str(), Some("completed"));
    ws.ok(&[
        "evidence",
        "add",
        "--id",
        "EV-001",
        "--from-experiment",
        "EX-001",
        "--statement",
        "The command exited 7",
    ]);
    ws.ok(&[
        "evidence",
        "relate",
        "--evidence",
        "EV-001",
        "--relation",
        "supports",
        "--claim",
        "CL-001",
        "--reason",
        "the failed command is the observation",
    ]);
    ws.ok(&[
        "claim",
        "assess",
        "--claim",
        "CL-001",
        "--as",
        "supported",
        "--reason",
        "the execution recorded the failure",
        "--evidence",
        "EV-001",
    ]);
    ws.ok(&[
        "deliverable",
        "dispose",
        "--deliverable",
        "DL-001",
        "--criterion",
        "CR-001",
        "--as",
        "satisfied",
        "--reference",
        "CL-001",
    ]);
    ws.write("conclusion.md", "The fixture fails.\n");
    ws.ok(&[
        "deliverable",
        "content",
        "--deliverable",
        "DL-001",
        "--file",
        "conclusion.md",
        "--reference",
        "CL-001",
    ]);
    ws.ok(&["case", "finalize"]);
    ws.ok(&["case", "close", "--reason", "completed"]);

    let status = ws.ok(&["case", "status", "--json"]);
    assert_eq!(status["lifecycle"].as_str(), Some("CLOSED"));
    assert_eq!(status["close_reason"].as_str(), Some("completed"));
}

/// An established Claim is refused while a challenge is unaddressed.
#[test]
fn established_claim_requires_addressed_challenges() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.ok(&[
        "claim",
        "add",
        "--id",
        "CL-001",
        "--statement",
        "Cause X explains the failure",
    ]);
    ws.plan_experiment("#!/bin/sh\nprintf 'evidence\\n'\n");
    ws.ok(&["experiment", "run", "EX-001"]);
    ws.ok(&[
        "evidence",
        "add",
        "--id",
        "EV-001",
        "--from-experiment",
        "EX-001",
        "--statement",
        "Observed support",
    ]);
    ws.ok(&[
        "evidence",
        "add",
        "--id",
        "EV-002",
        "--from-experiment",
        "EX-001",
        "--statement",
        "Observed challenge",
    ]);
    ws.ok(&[
        "evidence",
        "relate",
        "--evidence",
        "EV-001",
        "--relation",
        "supports",
        "--claim",
        "CL-001",
        "--reason",
        "support",
    ]);
    ws.ok(&[
        "evidence",
        "relate",
        "--evidence",
        "EV-002",
        "--relation",
        "challenges",
        "--claim",
        "CL-001",
        "--reason",
        "challenge",
    ]);

    let failure = ws.run(&[
        "claim",
        "assess",
        "--claim",
        "CL-001",
        "--as",
        "established",
        "--reason",
        "cause",
        "--evidence",
        "EV-001",
        "--json",
    ]);
    let payload = failure.error();
    assert_eq!(payload["code"].as_str(), Some("UNADDRESSED_CHALLENGE"));
    assert_eq!(payload["details"]["missing"][0].as_str(), Some("EV-002"));

    // Addressing the challenge lets the same assessment through.
    ws.ok(&[
        "claim",
        "assess",
        "--claim",
        "CL-001",
        "--as",
        "established",
        "--reason",
        "cause",
        "--evidence",
        "EV-001",
        "--address-challenge",
        "EV-002",
    ]);
}

/// `summary.md` is rebuildable and reference drift is reported.
#[test]
fn summary_rebuild_and_artifact_drift_detected() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.write("evidence.txt", "original\n");
    let source = ws.file("evidence.txt");
    ws.ok(&[
        "artifact",
        "add",
        source.to_str().expect("utf8 path"),
        "--id",
        "AR-001",
        "--storage",
        "reference",
    ]);

    let summary = ws.file(".zoo/debug/CASE-1/summary.md");
    fs::remove_file(&summary).expect("remove summary");
    ws.ok(&["case", "repair-view"]);
    assert!(summary.is_file(), "repair-view must rebuild summary.md");

    fs::write(&source, "changed\n").expect("modify referenced file");
    let failure = ws.run(&["case", "verify", "--json"]);
    let payload = failure.error();
    assert_eq!(payload["code"].as_str(), Some("VERIFY_FAILED"));
    let problem = &payload["details"]["problems"][0];
    assert_eq!(problem["artifact"].as_str(), Some("AR-001"));
    assert_eq!(problem["problem"].as_str(), Some("sha256 mismatch"));
}

/// A non-Git workspace snapshots as a directory and survives relocation.
#[test]
fn non_git_workspace_and_relocation() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    let status = ws.ok(&["case", "status", "--json"]);
    assert_eq!(status["baseline"][0]["kind"].as_str(), Some("directory"));

    // Move the whole workspace, Case directory included, and verify there.
    let relocated = TempDir::new().expect("create relocated tempdir");
    copy_tree(ws.path(), relocated.path());
    let run = Workspace::run_in(relocated.path(), &["case", "verify"]);
    assert_eq!(
        run.code, 0,
        "verify after relocation failed\nstderr: {}",
        run.stderr
    );
}

/// Git snapshots stay clean because the Case directory is excluded.
#[test]
fn case_artifacts_are_excluded_from_git_snapshot() {
    let ws = Workspace::new();
    ws.init_git_repo();
    ws.init_case(&[]);

    let status = ws.ok(&["case", "status", "--json"]);
    let baseline = status["baseline"][0]["git"]["status"]
        .as_array()
        .expect("baseline status array");
    assert!(baseline.is_empty(), "baseline status: {baseline:?}");

    ws.ok(&["case", "finalize"]);
    let status = ws.ok(&["case", "status", "--json"]);
    let final_status = status["final_snapshot"][0]["git"]["status"]
        .as_array()
        .expect("final status array");
    assert!(final_status.is_empty(), "final status: {final_status:?}");
}

/// A truncated tail is quarantined and a running Attempt is interrupted.
#[test]
fn truncated_tail_recovery_marks_running_attempt_interrupted() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.plan_experiment("#!/bin/sh\nprintf 'hi\\n'\n");
    let case_dir = ws.file(".zoo/debug/CASE-1");

    // Simulate a runner that started an Attempt and then crashed: the
    // started event is on disk but no finishing event ever follows.
    EventStore::new(&case_dir)
        .append(
            "experiment-attempt-started",
            &json!({
                "experiment_id": "EX-001",
                "attempt_id": "EX-001-A001",
                "attempt_number": 1,
                "status": "running",
            }),
        )
        .expect("append started event");
    append_bytes(&case_dir.join("case.jsonl"), b"{\"format_version\": 1");

    let failure = ws.run(&["case", "status", "--json"]);
    let payload = failure.error();
    assert_eq!(payload["code"].as_str(), Some("TRUNCATED_EVENT"));

    ws.ok(&["case", "recover"]);
    let status = ws.ok(&["case", "status", "--json"]);
    assert_eq!(status["recoveries"].as_array().map(Vec::len), Some(1));
    let attempt = &status["experiments"]["EX-001"]["attempts"][0];
    assert_eq!(attempt["status"].as_str(), Some("interrupted"));
    assert_eq!(
        attempt["recovery_reason"].as_str(),
        Some("runner process did not finish")
    );
    assert!(
        case_dir.join("artifacts/recovery").is_dir(),
        "recovery tail must be quarantined under artifacts/recovery"
    );
}

/// Invalidated Evidence cannot satisfy a Deliverable criterion.
#[test]
fn invalidated_evidence_cannot_satisfy_deliverable() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.ok(&[
        "deliverable",
        "add",
        "--title",
        "cause",
        "--contract",
        "cause",
        "--criterion",
        "evidence",
    ]);
    ws.ok(&["claim", "add", "--id", "CL-001", "--statement", "claim"]);
    ws.plan_experiment("#!/bin/sh\nprintf 'evidence\\n'\n");
    ws.ok(&["experiment", "run", "EX-001"]);
    ws.ok(&[
        "evidence",
        "add",
        "--id",
        "EV-001",
        "--from-experiment",
        "EX-001",
        "--statement",
        "evidence",
    ]);
    ws.ok(&[
        "evidence",
        "relate",
        "--evidence",
        "EV-001",
        "--relation",
        "supports",
        "--claim",
        "CL-001",
        "--reason",
        "support",
    ]);
    ws.ok(&["evidence", "invalidate", "EV-001", "--reason", "source changed"]);

    let failure = ws.run(&[
        "deliverable",
        "dispose",
        "--deliverable",
        "DL-001",
        "--criterion",
        "CR-001",
        "--as",
        "satisfied",
        "--reference",
        "EV-001",
        "--json",
    ]);
    let payload = failure.error();
    assert_eq!(payload["code"].as_str(), Some("INVALIDATED_EVIDENCE"));
}

/// Editing the source script after planning does not change the stored copy.
#[test]
fn plan_is_immutable() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.plan_experiment("#!/bin/sh\nprintf 'one\\n'\n");
    ws.write("procedure.sh", "#!/bin/sh\nprintf 'two\\n'\n");
    ws.ok(&["experiment", "run", "EX-001"]);

    let log = ws.file(
        ".zoo/debug/CASE-1/artifacts/experiments/EX-001/EX-001-A001/stdout.log",
    );
    assert_eq!(fs::read_to_string(log).expect("read stdout"), "one\n");
}

/// `experiment plan --script -` copies the procedure from stdin.
#[test]
fn plan_reads_procedure_from_stdin() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.write(
        "interpretations.json",
        r#"[{"when":"done","meaning":"observe"}]"#,
    );
    let mut child = Command::new(ZDEBUG)
        .args([
            "--json",
            "experiment",
            "plan",
            "--question",
            "observe",
            "--interpretations",
            "interpretations.json",
            "--script",
            "-",
        ])
        .current_dir(ws.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn zdebug");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(b"#!/bin/sh\nprintf 'stdin\\n'\n")
        .expect("write stdin");
    let output = child.wait_with_output().expect("wait for zdebug");
    let run = Run {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    };
    // The omitted `--id` is auto-assigned from the locked Case state.
    let result = run.result();
    assert_eq!(result["experiments"]["EX-001"]["id"].as_str(), Some("EX-001"));

    let stored =
        ws.file(".zoo/debug/CASE-1/artifacts/experiments/EX-001/procedure");
    assert_eq!(
        fs::read_to_string(&stored).expect("read stored procedure"),
        "#!/bin/sh\nprintf 'stdin\\n'\n"
    );

    // The stored copy is executable as a procedure.
    ws.ok(&["experiment", "run", "EX-001"]);
    let stdout = ws.file(
        ".zoo/debug/CASE-1/artifacts/experiments/EX-001/EX-001-A001/stdout.log",
    );
    assert_eq!(fs::read_to_string(stdout).expect("read stdout"), "stdin\n");
}

// ── Increments ───────────────────────────────────────────────────────────────

/// `case init --verify` records a criterion visible in `case status`.
#[test]
fn init_verify_is_recorded_and_visible_in_status() {
    let ws = Workspace::new();
    ws.init_case(&["--verify", "cargo test"]);
    let status = ws.ok(&["case", "status", "--json"]);
    assert_eq!(status["verify"]["command"].as_str(), Some("cargo test"));
    assert_eq!(status["verify"]["source"].as_str(), Some("user"));
}

/// The pre-fix `--workspaces` spelling is rejected.
#[test]
fn case_init_rejects_plural_workspaces_flag() {
    let ws = Workspace::new();
    let root = ws.path().to_string_lossy().into_owned();
    let failure = ws.run(&[
        "--json",
        "case",
        "init",
        CASE_ID,
        "--title",
        "test",
        "--objective",
        "test objective",
        "--workspaces",
        root.as_str(),
    ]);
    assert_ne!(failure.code, 0, "unexpected success: {}", failure.stdout);
    assert!(
        failure.stderr.contains("--workspaces"),
        "stderr: {}",
        failure.stderr
    );
}

/// A quoted leading `~` in `--case-dir` resolves against `HOME`.
#[test]
fn case_dir_expands_leading_tilde() {
    let home = TempDir::new().expect("home");
    let cwd = TempDir::new().expect("cwd");
    let workspace = TempDir::new().expect("workspace");
    let workspace = workspace.path().to_string_lossy().into_owned();
    let run = Workspace::run_with_home(
        home.path(),
        cwd.path(),
        &[
            "--json",
            "case",
            "init",
            CASE_ID,
            "--title",
            "test",
            "--objective",
            "test objective",
            "--workspace",
            &workspace,
            "--case-dir",
            "~/nested/case",
        ],
    );
    let result = run.result();
    assert_eq!(result["case_id"].as_str(), Some(CASE_ID));
    assert!(home.path().join("nested/case/case.jsonl").is_file());
    assert!(!cwd.path().join("~").exists());
}

/// `case update-verify` replaces the criterion and leaves an audit event.
#[test]
fn update_verify_replaces_criterion_and_records_reason() {
    let ws = Workspace::new();
    ws.init_case(&["--verify", "cargo test"]);
    ws.ok(&[
        "case",
        "update-verify",
        "--verify",
        "pytest -q",
        "--reason",
        "narrowed scope",
    ]);

    let status = ws.ok(&["case", "status", "--json"]);
    assert_eq!(status["verify"]["command"].as_str(), Some("pytest -q"));
    assert_eq!(status["verify"]["source"].as_str(), Some("agent"));

    let log = fs::read_to_string(ws.file(".zoo/debug/CASE-1/case.jsonl"))
        .expect("read event log");
    let updated = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("event json"))
        .find(|event| event["type"].as_str() == Some("case-verify-updated"))
        .expect("case-verify-updated event");
    assert_eq!(updated["payload"]["reason"].as_str(), Some("narrowed scope"));
    assert_eq!(
        updated["payload"]["verify"]["command"].as_str(),
        Some("pytest -q")
    );
}

/// `case status --json` exposes the lifecycle, criterion, and five tables.
#[test]
fn status_json_exposes_lifecycle_verify_and_tables() {
    let ws = Workspace::new();
    ws.init_case(&["--verify", "true"]);
    let status = ws.ok(&["case", "status", "--json"]);

    assert_eq!(status["lifecycle"].as_str(), Some("OPEN"));
    assert_eq!(status["verify"]["command"].as_str(), Some("true"));
    for key in
        ["deliverables", "claims", "experiments", "evidence", "artifacts"]
    {
        assert!(status.get(key).is_some(), "missing status table: {key}");
    }
}

// ── Exit-code contract ───────────────────────────────────────────────────────

/// The `--json` flag behaves identically before and after the subcommand.
#[test]
fn json_flag_is_position_independent() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    let leading = ws.run(&["--json", "case", "status"]);
    let trailing = ws.run(&["case", "status", "--json"]);
    assert_eq!(leading.code, 0, "leading --json failed: {}", leading.stderr);
    assert_eq!(trailing.code, 0, "trailing --json failed: {}", trailing.stderr);
    assert_eq!(leading.stdout, trailing.stdout);
}

/// A business error exits 2 with a JSON error envelope on stderr.
#[test]
fn business_error_exits_two_with_json_envelope() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.ok(&["claim", "add", "--id", "CL-001", "--statement", "claim"]);

    let failure = ws.run(&[
        "claim",
        "assess",
        "--claim",
        "CL-001",
        "--as",
        "supported",
        "--reason",
        "no evidence cited",
        "--json",
    ]);
    assert_eq!(failure.code, 2);
    assert!(
        failure.stderr.contains("\"ok\":false"),
        "stderr: {}",
        failure.stderr
    );
    let payload = failure.error();
    assert_eq!(payload["code"].as_str(), Some("MISSING_SUPPORT"));
    assert!(failure.stdout.is_empty(), "stdout: {}", failure.stdout);
}

/// Without `--json` the same business error is rendered for humans.
#[test]
fn business_error_without_json_renders_code() {
    let ws = Workspace::new();
    ws.init_case(&[]);
    ws.ok(&["claim", "add", "--id", "CL-001", "--statement", "claim"]);

    let failure = ws.run(&[
        "claim",
        "assess",
        "--claim",
        "CL-001",
        "--as",
        "supported",
        "--reason",
        "no evidence cited",
    ]);
    assert_eq!(failure.code, 2);
    assert!(
        failure.stderr.contains("error[MISSING_SUPPORT]"),
        "stderr: {}",
        failure.stderr
    );
    assert!(failure.stdout.is_empty(), "stdout: {}", failure.stdout);
}
