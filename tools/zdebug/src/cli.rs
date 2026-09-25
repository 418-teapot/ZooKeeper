//! Command-line surface for `zdebug`.
//!
//! The module mirrors the reference Python `autodebug` CLI: it builds the
//! subcommand tree, resolves the target Case, assembles event payloads
//! from the typed arguments, and drives the Case facade, the runner, and
//! the artifact layer. It owns no business logic of its own.
//!
//! The output contract follows the reference `_output`/`_error` pair: a
//! successful command prints `{"ok":true,"result":...}` and exits 0, while
//! a [`ZdebugError`] prints `{"ok":false,"code":...,"message":...,
//! "details":...}` to stderr and exits 2. Without `--json` the same value
//! is rendered for humans instead.
//!
//! Case discovery reimplements the reference `locate_case` against the
//! host integration root `.zoo/debug` (rather than the reference's
//! `.autodebug`): an explicit `--case-dir` wins, then `--case-id` maps to
//! `<cwd>/.zoo/debug/<id>`, and otherwise the nearest ancestor containing
//! a single Case is used.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::builder::PossibleValuesParser;
use clap::{ArgGroup, Args, Parser, Subcommand};
use serde_json::{Map, Value, json};

use zdebug::artifacts::{
    ArtifactOptions, Storage, create_artifact_payload, invalidation_payload,
};
use zdebug::case::{ArtifactProblem, CaseRepository, VerifyReport};
use zdebug::git::capture_snapshot;
use zdebug::model::State;
use zdebug::runner::{PlanSpec, plan_experiment, run_experiment};
use zdebug::util::{
    ZdebugError, canonical_json, expand_user, next_id, read_json, validate_id,
    which_executable,
};

/// CLI version, sourced from the crate manifest.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Discovery root holding the per-Case directories.
const CASE_ROOT: &str = ".zoo/debug";

/// File whose presence marks a directory as a Case.
const CASE_FILE: &str = "case.jsonl";

const STORAGE_VALUES: [&str; 3] = ["copy", "reference", "manifest"];
const AVAILABILITY_VALUES: [&str; 4] =
    ["durable", "ephemeral", "remote", "missing"];
const DISPOSITION_VALUES: [&str; 3] = ["satisfied", "blocked", "waived"];
const CLAIM_RELATION_VALUES: [&str; 3] =
    ["refines", "contradicts", "supersedes"];
const EVIDENCE_RELATION_VALUES: [&str; 2] = ["supports", "challenges"];
const ASSESSMENT_VALUES: [&str; 4] =
    ["open", "supported", "established", "rejected"];
const CLOSE_REASON_VALUES: [&str; 3] =
    ["completed", "partially-blocked", "cancelled"];
const VERIFY_SOURCE_VALUES: [&str; 2] = ["user", "agent"];

// ── Entry point ──────────────────────────────────────────────────────────────

/// Parse the process arguments, run the command, and return its exit code.
pub fn run() -> ExitCode {
    let cli = Cli::parse();
    let context = match Context::new() {
        Ok(context) => context,
        Err(err) => return output_error(&err, cli.json),
    };
    match dispatch(&context, &cli.command) {
        Ok(report) => {
            output(&report, cli.json);
            ExitCode::SUCCESS
        }
        Err(err) => output_error(&err, cli.json),
    }
}

/// Process-wide inputs shared by every handler.
struct Context {
    /// The invocation working directory.
    cwd: PathBuf,
}

impl Context {
    /// Capture the current working directory.
    fn new() -> Result<Self, ZdebugError> {
        Ok(Self { cwd: env::current_dir()? })
    }
}

/// A command outcome: the machine value plus an optional human rendering.
struct Report {
    /// The value emitted inside the `result` envelope under `--json`.
    value: Value,
    /// A pre-rendered human form used when `--json` is absent.
    human: Option<String>,
}

impl Report {
    /// Wrap a plain value with no human-specific rendering.
    const fn value(value: Value) -> Self {
        Self { value, human: None }
    }

    /// Wrap a value together with a human-readable rendering.
    const fn with_human(value: Value, human: String) -> Self {
        Self { value, human: Some(human) }
    }
}

// ── Argument tree ────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "zdebug",
    version = VERSION,
    about = "ZooKeeper 自主调试循环状态基底工具",
    disable_help_subcommand = true
)]
struct Cli {
    /// Emit stable JSON output.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 打印环境诊断信息
    Doctor,
    /// 创建、查询与收敛 Case
    #[command(subcommand)]
    Case(CaseCommand),
    /// 维护交付物契约
    #[command(subcommand)]
    Deliverable(DeliverableCommand),
    /// 记录调查假设
    #[command(subcommand)]
    Claim(ClaimCommand),
    /// 规划与执行实验
    #[command(subcommand)]
    Experiment(ExperimentCommand),
    /// 记录观察证据
    #[command(subcommand)]
    Evidence(EvidenceCommand),
    /// 登记与作废工件
    #[command(subcommand)]
    Artifact(ArtifactCommand),
}

/// Selects the Case a command operates on.
#[derive(Args)]
struct CaseLocator {
    /// Case id resolved under `<cwd>/.zoo/debug`.
    #[arg(long = "case-id", id = "case_id")]
    id: Option<String>,
    /// Explicit Case directory.
    #[arg(long = "case-dir", id = "case_dir")]
    dir: Option<PathBuf>,
}

#[derive(Subcommand)]
enum CaseCommand {
    /// 创建新 Case
    Init(CaseInitArgs),
    /// 打印 Case 状态
    Status(CaseLocator),
    /// 结清并关闭 Case
    Close(CaseCloseArgs),
    /// 重新打开已关闭的 Case
    Reopen(CaseReopenArgs),
    /// 记录工作区终态快照
    Finalize(CaseLocator),
    /// 校验全部工件
    Verify(CaseLocator),
    /// 修复损坏事件尾部
    Recover(CaseLocator),
    /// 重建 summary.md
    RepairView(CaseLocator),
    /// 替换验证判据
    UpdateVerify(CaseUpdateVerifyArgs),
}

#[derive(Args)]
struct CaseInitArgs {
    /// Case identifier.
    case_id: String,
    /// Explicit Case directory; defaults to `<cwd>/.zoo/debug/<case_id>`.
    #[arg(long)]
    case_dir: Option<PathBuf>,
    /// Human-readable Case title.
    #[arg(long)]
    title: String,
    /// The debugging objective.
    #[arg(long)]
    objective: String,
    /// Workspace path to snapshot; repeatable, defaults to the cwd.
    #[arg(long = "workspace")]
    workspaces: Vec<String>,
    /// Interpreter used when an Experiment declares none.
    #[arg(long)]
    default_interpreter: Option<String>,
    /// Initial verification command declared by the user.
    #[arg(long)]
    verify: Option<String>,
}

#[derive(Args)]
struct CaseCloseArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Why the Case is being closed.
    #[arg(long, value_parser = PossibleValuesParser::new(CLOSE_REASON_VALUES))]
    reason: String,
}

#[derive(Args)]
struct CaseReopenArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Why the Case is being reopened.
    #[arg(long)]
    reason: String,
}

#[derive(Args)]
struct CaseUpdateVerifyArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// The replacement verification command.
    #[arg(long)]
    verify: String,
    /// Why the criterion changed.
    #[arg(long)]
    reason: String,
    /// Who declared the replacement criterion.
    #[arg(
        long,
        default_value = "agent",
        value_parser = PossibleValuesParser::new(VERIFY_SOURCE_VALUES)
    )]
    source: String,
}

#[derive(Subcommand)]
enum DeliverableCommand {
    /// 登记交付物
    Add(DeliverableAddArgs),
    /// 处置交付判据
    Dispose(DeliverableDisposeArgs),
    /// 挂接交付内容
    Content(DeliverableContentArgs),
}

#[derive(Args)]
struct DeliverableAddArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Deliverable identifier; auto-assigned when omitted.
    #[arg(long)]
    id: Option<String>,
    /// Human-readable title.
    #[arg(long)]
    title: String,
    /// The delivery contract.
    #[arg(long)]
    contract: String,
    /// A criterion description; repeatable.
    #[arg(long = "criterion", required = true)]
    criteria: Vec<String>,
    /// Mark the deliverables non-required.
    #[arg(long)]
    optional: bool,
}

#[derive(Args)]
struct DeliverableDisposeArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Target Deliverable identifier.
    #[arg(long)]
    deliverable: String,
    /// Target criterion identifier.
    #[arg(long)]
    criterion: String,
    /// Disposition to record.
    #[arg(
        long = "as",
        value_parser = PossibleValuesParser::new(DISPOSITION_VALUES)
    )]
    disposition: String,
    /// Claim or Evidence reference; repeatable.
    #[arg(long = "reference")]
    references: Vec<String>,
    /// Why the criterion was disposed this way.
    #[arg(long)]
    reason: Option<String>,
}

#[derive(Args)]
struct DeliverableContentArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Target Deliverable identifier.
    #[arg(long)]
    deliverable: String,
    /// File copied into the Case as the delivery content.
    #[arg(long)]
    file: PathBuf,
    /// Claim or Evidence reference; repeatable.
    #[arg(long = "reference", required = true)]
    references: Vec<String>,
}

#[derive(Subcommand)]
enum ClaimCommand {
    /// 记录假设
    Add(ClaimAddArgs),
    /// 评估假设
    Assess(ClaimAssessArgs),
    /// 关联假设
    Relate(ClaimRelateArgs),
}

#[derive(Args)]
struct ClaimAddArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Claim identifier; auto-assigned when omitted.
    #[arg(long)]
    id: Option<String>,
    /// The falsifiable statement.
    #[arg(long)]
    statement: String,
    /// JSON scope object, given inline or as a file path.
    #[arg(long)]
    scope: Option<String>,
}

#[derive(Args)]
struct ClaimAssessArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Target Claim identifier.
    #[arg(long)]
    claim: String,
    /// Assessment to record.
    #[arg(
        long = "as",
        value_parser = PossibleValuesParser::new(ASSESSMENT_VALUES)
    )]
    assessment: String,
    /// Why the assessment was reached.
    #[arg(long)]
    reason: String,
    /// Supporting Evidence reference; repeatable.
    #[arg(long)]
    evidence: Vec<String>,
    /// Challenge addressed by the assessment; repeatable.
    #[arg(long = "address-challenge")]
    addressed_challenges: Vec<String>,
}

#[derive(Args)]
struct ClaimRelateArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Source Claim identifier.
    #[arg(long)]
    source: String,
    /// Relation kind.
    #[arg(long, value_parser = PossibleValuesParser::new(CLAIM_RELATION_VALUES))]
    relation: String,
    /// Target Claim identifier.
    #[arg(long)]
    target: String,
    /// Why the relation holds.
    #[arg(long)]
    reason: String,
}

#[derive(Subcommand)]
enum ExperimentCommand {
    /// 规划实验
    Plan(ExperimentPlanArgs),
    /// 执行实验
    Run(ExperimentRunArgs),
}

#[derive(Args)]
struct ExperimentPlanArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Experiment identifier; auto-assigned when omitted.
    #[arg(long)]
    id: Option<String>,
    /// The question the experiment answers.
    #[arg(long)]
    question: String,
    /// Related Claim identifiers; repeatable.
    #[arg(long = "claim")]
    claims: Vec<String>,
    /// Controlled variables; repeatable.
    #[arg(long)]
    controlled: Vec<String>,
    /// The independent variable.
    #[arg(long)]
    variable: Option<String>,
    /// JSON interpretation list, given inline or as a file path.
    #[arg(long)]
    interpretations: String,
    /// Procedure script copied into the Case.
    #[arg(long)]
    script: PathBuf,
    /// Explicit interpreter command line.
    #[arg(long)]
    interpreter: Option<String>,
    /// Working directory the procedure runs from.
    #[arg(long)]
    cwd: Option<PathBuf>,
}

#[derive(Args)]
struct ExperimentRunArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Experiment identifier to run.
    experiment: String,
    /// Working directory override.
    #[arg(long)]
    cwd: Option<PathBuf>,
    /// `KEY=VALUE` environment override; repeatable.
    #[arg(long)]
    env: Vec<String>,
}

#[derive(Subcommand)]
enum EvidenceCommand {
    /// 记录证据
    Add(EvidenceAddArgs),
    /// 关联证据与假设
    Relate(EvidenceRelateArgs),
    /// 作废证据
    Invalidate(EvidenceInvalidateArgs),
}

#[derive(Args)]
#[command(group(
    ArgGroup::new("provenance")
        .required(true)
        .multiple(false)
        .args(["from_experiment", "source"])
))]
struct EvidenceAddArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Evidence identifier; auto-assigned when omitted.
    #[arg(long)]
    id: Option<String>,
    /// The observed statement.
    #[arg(long)]
    statement: String,
    /// Experiment the evidence comes from.
    #[arg(long)]
    from_experiment: Option<String>,
    /// External source of the evidence.
    #[arg(long)]
    source: Option<String>,
    /// Attempt identifier within the source Experiment.
    #[arg(long)]
    attempt: Option<String>,
    /// JSON context object, given inline or as a file path.
    #[arg(long)]
    context: Option<String>,
    /// Attached Artifact identifier; repeatable.
    #[arg(long = "attach")]
    attachments: Vec<String>,
}

#[derive(Args)]
struct EvidenceRelateArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Evidence identifier.
    #[arg(long)]
    evidence: String,
    /// Relation kind.
    #[arg(
        long,
        value_parser = PossibleValuesParser::new(EVIDENCE_RELATION_VALUES)
    )]
    relation: String,
    /// Target Claim identifier.
    #[arg(long)]
    claim: String,
    /// Why the relation holds.
    #[arg(long)]
    reason: String,
}

#[derive(Args)]
struct EvidenceInvalidateArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Evidence identifier.
    evidence: String,
    /// Why the evidence is invalidated.
    #[arg(long)]
    reason: String,
}

#[derive(Subcommand)]
enum ArtifactCommand {
    /// 登记工件
    Add(ArtifactAddArgs),
    /// 作废工件
    Invalidate(ArtifactInvalidateArgs),
}

#[derive(Args)]
struct ArtifactAddArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Source path to capture.
    path: PathBuf,
    /// Artifact identifier; auto-assigned when omitted.
    #[arg(long)]
    id: Option<String>,
    /// How the bytes are retained.
    #[arg(long, value_parser = PossibleValuesParser::new(STORAGE_VALUES))]
    storage: String,
    /// Destination file name for `copy` storage.
    #[arg(long)]
    name: Option<String>,
    /// Availability recorded for the Artifact.
    #[arg(
        long,
        default_value = "durable",
        value_parser = PossibleValuesParser::new(AVAILABILITY_VALUES)
    )]
    availability: String,
}

#[derive(Args)]
struct ArtifactInvalidateArgs {
    #[command(flatten)]
    locator: CaseLocator,
    /// Artifact identifier.
    artifact: String,
    /// Why the artifact is invalidated.
    #[arg(long)]
    reason: String,
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// Route a parsed command to its handler.
fn dispatch(
    context: &Context,
    command: &Command,
) -> Result<Report, ZdebugError> {
    match command {
        Command::Doctor => Ok(doctor()),
        Command::Case(command) => dispatch_case(context, command),
        Command::Deliverable(command) => dispatch_deliverable(context, command),
        Command::Claim(command) => dispatch_claim(context, command),
        Command::Experiment(command) => dispatch_experiment(context, command),
        Command::Evidence(command) => dispatch_evidence(context, command),
        Command::Artifact(command) => dispatch_artifact(context, command),
    }
}

/// Route a `case` subcommand.
fn dispatch_case(
    context: &Context,
    command: &CaseCommand,
) -> Result<Report, ZdebugError> {
    match command {
        CaseCommand::Init(args) => case_init(context, args),
        CaseCommand::Status(locator) => case_status(context, locator),
        CaseCommand::Close(args) => case_close(context, args),
        CaseCommand::Reopen(args) => case_reopen(context, args),
        CaseCommand::Finalize(locator) => case_finalize(context, locator),
        CaseCommand::Verify(locator) => case_verify(context, locator),
        CaseCommand::Recover(locator) => case_recover(context, locator),
        CaseCommand::RepairView(locator) => case_repair_view(context, locator),
        CaseCommand::UpdateVerify(args) => case_update_verify(context, args),
    }
}

/// Route a `deliverable` subcommand.
fn dispatch_deliverable(
    context: &Context,
    command: &DeliverableCommand,
) -> Result<Report, ZdebugError> {
    match command {
        DeliverableCommand::Add(args) => deliverable_add(context, args),
        DeliverableCommand::Dispose(args) => deliverable_dispose(context, args),
        DeliverableCommand::Content(args) => deliverable_content(context, args),
    }
}

/// Route a `claim` subcommand.
fn dispatch_claim(
    context: &Context,
    command: &ClaimCommand,
) -> Result<Report, ZdebugError> {
    match command {
        ClaimCommand::Add(args) => claim_add(context, args),
        ClaimCommand::Assess(args) => claim_assess(context, args),
        ClaimCommand::Relate(args) => claim_relate(context, args),
    }
}

/// Route an `experiment` subcommand.
fn dispatch_experiment(
    context: &Context,
    command: &ExperimentCommand,
) -> Result<Report, ZdebugError> {
    match command {
        ExperimentCommand::Plan(args) => experiment_plan(context, args),
        ExperimentCommand::Run(args) => experiment_run(context, args),
    }
}

/// Route an `evidence` subcommand.
fn dispatch_evidence(
    context: &Context,
    command: &EvidenceCommand,
) -> Result<Report, ZdebugError> {
    match command {
        EvidenceCommand::Add(args) => evidence_add(context, args),
        EvidenceCommand::Relate(args) => evidence_relate(context, args),
        EvidenceCommand::Invalidate(args) => evidence_invalidate(context, args),
    }
}

/// Route an `artifact` subcommand.
fn dispatch_artifact(
    context: &Context,
    command: &ArtifactCommand,
) -> Result<Report, ZdebugError> {
    match command {
        ArtifactCommand::Add(args) => artifact_add(context, args),
        ArtifactCommand::Invalidate(args) => artifact_invalidate(context, args),
    }
}

// ── Case handlers ────────────────────────────────────────────────────────────

/// Create a new Case, applying the workspace and verify defaults.
fn case_init(
    context: &Context,
    args: &CaseInitArgs,
) -> Result<Report, ZdebugError> {
    let case_dir = locate_case(
        Some(&args.case_id),
        args.case_dir.as_deref(),
        &context.cwd,
    )?;
    let workspaces = if args.workspaces.is_empty() {
        vec![context.cwd.to_string_lossy().into_owned()]
    } else {
        args.workspaces.clone()
    };
    for workspace in &workspaces {
        if !Path::new(workspace).is_dir() {
            return Err(ZdebugError::new(
                "WORKSPACE_NOT_FOUND",
                format!("Workspace not found: {workspace}"),
            ));
        }
    }
    let verify = args
        .verify
        .as_ref()
        .map(|command| json!({"command": command, "source": "user"}));
    let repository = CaseRepository::new(&case_dir);
    let state = repository.initialize(
        &args.case_id,
        &args.title,
        &args.objective,
        &workspaces,
        args.default_interpreter.as_deref(),
        verify.as_ref(),
    )?;
    Ok(Report::value(state.to_dict()))
}

/// Report the machine-readable Case view.
fn case_status(
    context: &Context,
    locator: &CaseLocator,
) -> Result<Report, ZdebugError> {
    let state = repository(locator, context)?.status()?;
    Ok(Report::value(state.to_dict()))
}

/// Close the Case after the artifact and delivery gates pass.
fn case_close(
    context: &Context,
    args: &CaseCloseArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    ensure_artifacts(&repository, "Artifact verification failed before close")?;
    Ok(Report::value(repository.close(&args.reason)?.to_dict()))
}

/// Reopen a closed Case.
fn case_reopen(
    context: &Context,
    args: &CaseReopenArgs,
) -> Result<Report, ZdebugError> {
    let state = repository(&args.locator, context)?.reopen(&args.reason)?;
    Ok(Report::value(state.to_dict()))
}

/// Record the final workspace snapshots.
fn case_finalize(
    context: &Context,
    locator: &CaseLocator,
) -> Result<Report, ZdebugError> {
    let state = repository(locator, context)?.finalize()?;
    Ok(Report::value(state.to_dict()))
}

/// Verify every Artifact and report the result.
fn case_verify(
    context: &Context,
    locator: &CaseLocator,
) -> Result<Report, ZdebugError> {
    let report = repository(locator, context)?.verify()?;
    if !report.ok {
        return Err(verify_failed("Case verification failed", &report));
    }
    Ok(Report::value(report.to_dict()))
}

/// Quarantine a damaged tail and mark interrupted Attempts.
fn case_recover(
    context: &Context,
    locator: &CaseLocator,
) -> Result<Report, ZdebugError> {
    let state = repository(locator, context)?.recover()?;
    Ok(Report::value(state.to_dict()))
}

/// Rebuild `summary.md` and report its path.
fn case_repair_view(
    context: &Context,
    locator: &CaseLocator,
) -> Result<Report, ZdebugError> {
    let path = repository(locator, context)?.repair_view()?;
    Ok(Report::value(json!({"summary": path.display().to_string()})))
}

/// Replace the verification criterion with a recorded reason.
fn case_update_verify(
    context: &Context,
    args: &CaseUpdateVerifyArgs,
) -> Result<Report, ZdebugError> {
    let verify = json!({"command": args.verify, "source": args.source});
    let state = repository(&args.locator, context)?
        .update_verify(&verify, &args.reason)?;
    Ok(Report::value(state.to_dict()))
}

// ── Deliverable handlers ─────────────────────────────────────────────────────

/// Register a Deliverable and its numbered criteria.
fn deliverable_add(
    context: &Context,
    args: &DeliverableAddArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let criteria: Vec<Value> = args
        .criteria
        .iter()
        .enumerate()
        .map(|(index, description)| {
            json!({
                "id": format!("CR-{:03}", index + 1),
                "description": description,
            })
        })
        .collect();
    let state = repository.append_with(|state| {
        let id = resolve_id(args.id.as_ref(), "DL", &state.deliverables);
        validate_id(&id, "Deliverable id")?;
        Ok((
            "deliverable-created".to_owned(),
            json!({
                "id": id,
                "title": args.title,
                "contract": args.contract,
                "required": !args.optional,
                "criteria": criteria,
            }),
        ))
    })?;
    Ok(Report::value(state.to_dict()))
}

/// Dispose a single Deliverable criterion.
fn deliverable_dispose(
    context: &Context,
    args: &DeliverableDisposeArgs,
) -> Result<Report, ZdebugError> {
    let payload = json!({
        "deliverable_id": args.deliverable,
        "criterion_id": args.criterion,
        "disposition": args.disposition,
        "references": args.references,
        "reason": args.reason,
    });
    let state = repository(&args.locator, context)?
        .append("deliverable-criterion-disposed", &payload)?;
    Ok(Report::value(state.to_dict()))
}

/// Copy a file into the Case and attach it as the Deliverable content.
fn deliverable_content(
    context: &Context,
    args: &DeliverableContentArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let case_dir = repository.case_dir().to_path_buf();
    let options = ArtifactOptions {
        destination_name: Some("deliverable.md".to_owned()),
        availability: "durable".to_owned(),
    };
    let mut artifact_id = String::new();
    repository.append_with(|state| {
        if !state.deliverables.contains_key(&args.deliverable) {
            return Err(ZdebugError::new(
                "DELIVERABLE_NOT_FOUND",
                format!("Deliverable not found: {}", args.deliverable),
            ));
        }
        artifact_id = next_id("AR", &state.artifacts);
        guard_artifact_write(state, &artifact_id)?;
        let payload = create_artifact_payload(
            &case_dir,
            &artifact_id,
            &args.file,
            Storage::Copy,
            &options,
        )?;
        Ok(("artifact-created".to_owned(), payload))
    })?;
    let attached = json!({
        "deliverable_id": args.deliverable,
        "artifact_id": artifact_id,
        "references": args.references,
    });
    let state = repository.append("deliverable-content-attached", &attached)?;
    Ok(Report::value(state.to_dict()))
}

// ── Claim handlers ───────────────────────────────────────────────────────────

/// Record a falsifiable Claim.
fn claim_add(
    context: &Context,
    args: &ClaimAddArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let scope = load_json_arg(args.scope.as_deref(), json!({}))?;
    let state = repository.append_with(|state| {
        let id = resolve_id(args.id.as_ref(), "CL", &state.claims);
        Ok((
            "claim-created".to_owned(),
            json!({"id": id, "statement": args.statement, "scope": scope}),
        ))
    })?;
    Ok(Report::value(state.to_dict()))
}

/// Record an assessment of a Claim.
fn claim_assess(
    context: &Context,
    args: &ClaimAssessArgs,
) -> Result<Report, ZdebugError> {
    let payload = json!({
        "claim_id": args.claim,
        "assessment": args.assessment,
        "reason": args.reason,
        "evidence": args.evidence,
        "addressed_challenges": args.addressed_challenges,
    });
    let state = repository(&args.locator, context)?
        .append("claim-assessed", &payload)?;
    Ok(Report::value(state.to_dict()))
}

/// Record a relation between two Claims.
fn claim_relate(
    context: &Context,
    args: &ClaimRelateArgs,
) -> Result<Report, ZdebugError> {
    let payload = json!({
        "source": args.source,
        "relation": args.relation,
        "target": args.target,
        "reason": args.reason,
    });
    let state = repository(&args.locator, context)?
        .append("claim-related", &payload)?;
    Ok(Report::value(state.to_dict()))
}

// ── Experiment handlers ──────────────────────────────────────────────────────

/// Plan an Experiment, copying its procedure into the Case.
fn experiment_plan(
    context: &Context,
    args: &ExperimentPlanArgs,
) -> Result<Report, ZdebugError> {
    let source = ProcedureSource::resolve(&args.script)?;
    if !source.path().is_file() {
        return Err(ZdebugError::new(
            "FILE_NOT_FOUND",
            format!("Experiment script not found: {}", args.script.display()),
        ));
    }
    let interpretations =
        load_json_arg(Some(&args.interpretations), json!([]))?;
    let Value::Array(interpretations) = interpretations else {
        return Err(missing_interpretations());
    };
    if interpretations.is_empty() {
        return Err(missing_interpretations());
    }
    let repository = repository(&args.locator, context)?;
    let cwd = args.cwd.clone().unwrap_or_else(|| context.cwd.clone());
    let spec = PlanSpec {
        id: args.id.as_deref(),
        question: &args.question,
        related_claims: &args.claims,
        controlled: &args.controlled,
        variable: args.variable.as_deref(),
        interpretations: &interpretations,
        script: source.path(),
        interpreter: args.interpreter.as_deref(),
        cwd: &cwd,
    };
    plan_experiment(repository.case_dir(), &spec)?;
    let state = repository.load()?;
    Ok(Report::value(state.to_dict()))
}

/// The procedure file an Experiment plan reads, staging `-` stdin input.
///
/// A staged copy is removed when the plan returns, so only the copy stored
/// inside the Case survives.
struct ProcedureSource {
    path: PathBuf,
    staged: Option<PathBuf>,
}

impl ProcedureSource {
    /// Resolve `script`, reading stdin when it names the `-` convention.
    fn resolve(script: &Path) -> Result<Self, ZdebugError> {
        if script != Path::new("-") {
            return Ok(Self { path: script.to_path_buf(), staged: None });
        }
        let mut content = Vec::new();
        std::io::stdin().read_to_end(&mut content)?;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |delta| delta.as_nanos());
        let staged = env::temp_dir()
            .join(format!("zdebug-stdin.{}.{nanos}.tmp", std::process::id()));
        fs::write(&staged, &content)?;
        Ok(Self { path: staged.clone(), staged: Some(staged) })
    }

    /// Return the path the plan should read.
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ProcedureSource {
    fn drop(&mut self) {
        if let Some(staged) = &self.staged {
            let _ = fs::remove_file(staged);
        }
    }
}

/// Run one Attempt of an Experiment.
fn experiment_run(
    context: &Context,
    args: &ExperimentRunArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let env = parse_key_values(&args.env)?;
    let metadata = run_experiment(
        repository.case_dir(),
        &args.experiment,
        args.cwd.as_deref(),
        &env,
    )?;
    Ok(Report::value(metadata))
}

// ── Evidence handlers ────────────────────────────────────────────────────────

/// Record an Evidence observation and its provenance.
fn evidence_add(
    context: &Context,
    args: &EvidenceAddArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let snapshot_state = repository.load()?;
    let mut context_value = load_json_arg(args.context.as_deref(), json!({}))?;
    if is_empty_object(&context_value) && !snapshot_state.workspaces.is_empty()
    {
        let exclude = [repository.case_dir().to_path_buf()];
        let snapshots: Vec<Value> = snapshot_state
            .workspaces
            .iter()
            .filter_map(Value::as_str)
            .map(|path| capture_snapshot(Path::new(path), &exclude))
            .collect();
        context_value = json!({"workspace_snapshots": snapshots});
    }
    let state = repository.append_with(|state| {
        let id = resolve_id(args.id.as_ref(), "EV", &state.evidence);
        let provenance = if let Some(experiment_id) = &args.from_experiment {
            experiment_provenance(
                state,
                experiment_id,
                args.attempt.as_deref(),
            )?
        } else {
            json!({
                "kind": "external",
                "source": args.source.clone().unwrap_or_default(),
            })
        };
        Ok((
            "evidence-created".to_owned(),
            json!({
                "id": id,
                "statement": args.statement,
                "provenance": provenance,
                "context": context_value,
                "attachments": args.attachments,
            }),
        ))
    })?;
    Ok(Report::value(state.to_dict()))
}

/// Relate Evidence to a Claim.
fn evidence_relate(
    context: &Context,
    args: &EvidenceRelateArgs,
) -> Result<Report, ZdebugError> {
    let payload = json!({
        "evidence_id": args.evidence,
        "relation": args.relation,
        "claim_id": args.claim,
        "reason": args.reason,
    });
    let state = repository(&args.locator, context)?
        .append("evidence-related", &payload)?;
    Ok(Report::value(state.to_dict()))
}

/// Invalidate an Evidence observation.
fn evidence_invalidate(
    context: &Context,
    args: &EvidenceInvalidateArgs,
) -> Result<Report, ZdebugError> {
    let payload = json!({"evidence_id": args.evidence, "reason": args.reason});
    let state = repository(&args.locator, context)?
        .append("evidence-invalidated", &payload)?;
    Ok(Report::value(state.to_dict()))
}

// ── Artifact handlers ────────────────────────────────────────────────────────

/// Capture an Artifact into the Case.
fn artifact_add(
    context: &Context,
    args: &ArtifactAddArgs,
) -> Result<Report, ZdebugError> {
    let repository = repository(&args.locator, context)?;
    let case_dir = repository.case_dir().to_path_buf();
    let storage = Storage::parse(&args.storage)?;
    let options = ArtifactOptions {
        destination_name: args.name.clone(),
        availability: args.availability.clone(),
    };
    let state = repository.append_with(|state| {
        let id = resolve_id(args.id.as_ref(), "AR", &state.artifacts);
        guard_artifact_write(state, &id)?;
        let payload = create_artifact_payload(
            &case_dir, &id, &args.path, storage, &options,
        )?;
        Ok(("artifact-created".to_owned(), payload))
    })?;
    Ok(Report::value(state.to_dict()))
}

/// Reject an Artifact write the model would refuse *before* the caller
/// copies bytes into the Case.
///
/// The model validates `artifact-created` only after the builder passed to
/// [`CaseRepository::append_with`] returns, so a copy performed inside the
/// builder would otherwise leave an orphan file or overwrite an existing
/// Artifact once the event is rejected. This mirrors the model's
/// `CASE_CLOSED` gate and its `DUPLICATE_ARTIFACT` check.
///
/// # Errors
///
/// Returns `CASE_CLOSED` when the Case is closed, or `DUPLICATE_ARTIFACT`
/// when `id` is already registered.
fn guard_artifact_write(state: &State, id: &str) -> Result<(), ZdebugError> {
    if state.lifecycle == "CLOSED" {
        return Err(ZdebugError::new("CASE_CLOSED", "Case is closed"));
    }
    if state.artifacts.contains_key(id) {
        return Err(ZdebugError::new(
            "DUPLICATE_ARTIFACT",
            format!("Duplicate Artifact: {id}"),
        ));
    }
    Ok(())
}

/// Invalidate an Artifact.
fn artifact_invalidate(
    context: &Context,
    args: &ArtifactInvalidateArgs,
) -> Result<Report, ZdebugError> {
    let payload = invalidation_payload(&args.artifact, &args.reason);
    let state = repository(&args.locator, context)?
        .append("artifact-invalidated", &payload)?;
    Ok(Report::value(state.to_dict()))
}

// ── Doctor ───────────────────────────────────────────────────────────────────

/// Describe the runtime environment.
fn doctor() -> Report {
    let git = which_executable("git");
    let cwd = current_dir_string();
    let value = json!({
        "version": VERSION,
        "git": git.as_ref().map(|path| path.display().to_string()),
        "cwd": cwd,
        "platform": format!("{}-{}", env::consts::OS, env::consts::ARCH),
    });
    Report::with_human(value, doctor_report())
}

/// Describe git availability for the diagnostic report.
fn describe_git(git: Option<&Path>) -> String {
    git.map_or_else(
        || "未找到".to_owned(),
        |path| format!("{}（可用）", path.display()),
    )
}

/// Build the human-readable environment diagnostic report.
fn doctor_report() -> String {
    let cwd = current_dir_string();
    let git = which_executable("git");
    let git_line = describe_git(git.as_deref());
    format!(
        "zdebug 环境诊断\n\
         版本: {VERSION}\n\
         工作目录: {cwd}\n\
         git: {git_line}\n"
    )
}

/// Render the current working directory, or `?` when it is unavailable.
fn current_dir_string() -> String {
    env::current_dir()
        .map_or_else(|_| "?".to_owned(), |dir| dir.display().to_string())
}

// ── Case discovery ───────────────────────────────────────────────────────────

/// Resolve the Case directory the way the reference `locate_case` does.
///
/// An explicit `case_dir` wins (with a leading `~` expanded to `HOME`); a
/// `case_id` maps to `<cwd>/.zoo/debug/<case_id>`; otherwise the nearest
/// ancestor holding a `.zoo/debug` directory with exactly one Case is used.
///
/// # Errors
///
/// Returns `CASE_AMBIGUOUS` when an ancestor holds more than one Case,
/// `CASE_REQUIRED` when none is found, or `INVALID_ID` for a malformed
/// `case_id`.
fn locate_case(
    case_id: Option<&str>,
    case_dir: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf, ZdebugError> {
    if let Some(case_dir) = case_dir {
        return Ok(expand_user(case_dir));
    }
    if let Some(case_id) = case_id {
        validate_id(case_id, "case id")?;
        return Ok(cwd.join(CASE_ROOT).join(case_id));
    }
    let mut current = cwd.to_path_buf();
    loop {
        if let Some(found) = single_case(&current.join(CASE_ROOT))? {
            return Ok(found);
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Err(ZdebugError::new("CASE_REQUIRED", "Specify --case-id or --case-dir"))
}

/// Return the single Case under `root`, if exactly one exists.
///
/// # Errors
///
/// Returns `CASE_AMBIGUOUS` when more than one Case is present, or an I/O
/// error when `root` cannot be read.
fn single_case(root: &Path) -> Result<Option<PathBuf>, ZdebugError> {
    if !root.is_dir() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.join(CASE_FILE).is_file() {
            candidates.push(path);
        }
    }
    match candidates.len() {
        0 => Ok(None),
        1 => Ok(candidates.into_iter().next()),
        _ => Err(ZdebugError::new(
            "CASE_AMBIGUOUS",
            "Multiple Cases found; specify --case-id or --case-dir",
        )),
    }
}

/// Open the Case selected by `locator`.
fn repository(
    locator: &CaseLocator,
    context: &Context,
) -> Result<CaseRepository, ZdebugError> {
    let case_dir = locate_case(
        locator.id.as_deref(),
        locator.dir.as_deref(),
        &context.cwd,
    )?;
    Ok(CaseRepository::new(&case_dir))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Fail with `VERIFY_FAILED` unless every Artifact is intact.
fn ensure_artifacts(
    repository: &CaseRepository,
    message: &str,
) -> Result<(), ZdebugError> {
    let report = repository.verify()?;
    if report.ok {
        return Ok(());
    }
    Err(verify_failed(message, &report))
}

/// Build the `VERIFY_FAILED` error carrying the drift problems.
fn verify_failed(message: &str, report: &VerifyReport) -> ZdebugError {
    let problems: Vec<Value> =
        report.problems.iter().map(ArtifactProblem::to_dict).collect();
    ZdebugError::with_details(
        "VERIFY_FAILED",
        message,
        BTreeMap::from([("problems".to_owned(), Value::Array(problems))]),
    )
}

/// Build the error raised for a missing or malformed interpretation list.
fn missing_interpretations() -> ZdebugError {
    ZdebugError::new(
        "MISSING_INTERPRETATIONS",
        "Experiment requires at least one interpretation",
    )
}

/// Resolve an explicit identifier, or auto-assign the next free one.
fn resolve_id(
    explicit: Option<&String>,
    prefix: &str,
    mapping: &Map<String, Value>,
) -> String {
    explicit.map_or_else(|| next_id(prefix, mapping), Clone::clone)
}

/// Parse `--env` style `KEY=VALUE` pairs into an ordered map.
///
/// # Errors
///
/// Returns `INVALID_KEY_VALUE` for an entry without `=` or with an empty
/// key.
fn parse_key_values(
    values: &[String],
) -> Result<BTreeMap<String, String>, ZdebugError> {
    let mut result = BTreeMap::new();
    for value in values {
        let Some((key, item)) = value.split_once('=') else {
            return Err(ZdebugError::new(
                "INVALID_KEY_VALUE",
                format!("Expected KEY=VALUE: {value}"),
            ));
        };
        if key.is_empty() {
            return Err(ZdebugError::new(
                "INVALID_KEY_VALUE",
                format!("Expected non-empty key: {value}"),
            ));
        }
        result.insert(key.to_owned(), item.to_owned());
    }
    Ok(result)
}

/// Load a JSON-valued argument given either inline JSON or a file path.
///
/// # Errors
///
/// Returns `INVALID_JSON` when inline JSON fails to parse, or the
/// [`read_json`] errors when the value names a file.
fn load_json_arg(
    value: Option<&str>,
    default: Value,
) -> Result<Value, ZdebugError> {
    let Some(value) = value else {
        return Ok(default);
    };
    let trimmed = value.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return serde_json::from_str(value).map_err(|err| {
            ZdebugError::new("INVALID_JSON", format!("Invalid JSON: {err}"))
        });
    }
    read_json(Path::new(value))
}

/// Resolve the provenance of Evidence sourced from an Experiment.
///
/// # Errors
///
/// Returns `EXPERIMENT_NOT_FOUND` when the Experiment is unknown, or
/// `ATTEMPT_NOT_FOUND` when it has no recorded Attempt.
fn experiment_provenance(
    state: &State,
    experiment_id: &str,
    attempt: Option<&str>,
) -> Result<Value, ZdebugError> {
    let experiment = state.experiments.get(experiment_id).ok_or_else(|| {
        ZdebugError::new(
            "EXPERIMENT_NOT_FOUND",
            format!("Experiment not found: {experiment_id}"),
        )
    })?;
    let latest = experiment
        .get("attempts")
        .and_then(Value::as_array)
        .and_then(|attempts| attempts.last())
        .and_then(|attempt| attempt.get("attempt_id"))
        .and_then(Value::as_str);
    let attempt_id = attempt.or(latest).ok_or_else(|| {
        ZdebugError::new("ATTEMPT_NOT_FOUND", "Experiment has no attempt")
    })?;
    Ok(json!({
        "kind": "experiment",
        "experiment_id": experiment_id,
        "attempt_id": attempt_id,
    }))
}

/// Report whether `value` is an object with no members.
fn is_empty_object(value: &Value) -> bool {
    value.as_object().is_none_or(Map::is_empty)
}

// ── Output ───────────────────────────────────────────────────────────────────

/// Emit a successful result, either as the JSON envelope or for humans.
fn output(report: &Report, as_json: bool) {
    if as_json {
        let envelope = json!({"ok": true, "result": report.value.clone()});
        println!("{}", canonical_json(&envelope));
    } else if let Some(human) = &report.human {
        print!("{human}");
    } else if let Value::String(text) = &report.value {
        println!("{text}");
    } else {
        println!("{}", pretty(&report.value));
    }
}

/// Emit a failed result and return the business-error exit code.
fn output_error(err: &ZdebugError, as_json: bool) -> ExitCode {
    if as_json {
        let payload = json!({
            "ok": false,
            "code": err.code(),
            "message": err.message(),
            "details": err.details().clone(),
        });
        eprintln!("{}", canonical_json(&payload));
    } else {
        eprintln!("error[{}]: {}", err.code(), err.message());
        if !err.details().is_empty() {
            let details =
                serde_json::to_value(err.details()).unwrap_or(Value::Null);
            eprintln!("{}", pretty(&details));
        }
    }
    ExitCode::from(2)
}

/// Render `value` as indented JSON with sorted keys, like the reference.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(&sort_keys(value))
        .unwrap_or_else(|_| canonical_json(value))
}

/// Rebuild `value` with every object's keys sorted alphabetically.
///
/// The reference renders human-readable output with `sort_keys=True`, so
/// the serialization of the process-resident map cannot be relied upon to
/// order keys.
fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut sorted = Map::new();
            for (key, item) in entries {
                sorted.insert(key.clone(), sort_keys(item));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(sort_keys).collect())
        }
        other => other.clone(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse `args` as a `zdebug` invocation and return its command.
    fn parse(args: &[&str]) -> Command {
        let mut line = vec!["zdebug"];
        line.extend_from_slice(args);
        Cli::try_parse_from(line).unwrap().command
    }

    #[test]
    fn test_json_flag_is_position_independent() {
        let leading =
            Cli::try_parse_from(["zdebug", "--json", "case", "status"])
                .unwrap();
        let trailing =
            Cli::try_parse_from(["zdebug", "case", "status", "--json"])
                .unwrap();
        let nested = Cli::try_parse_from([
            "zdebug",
            "experiment",
            "run",
            "EX-001",
            "--json",
        ])
        .unwrap();
        assert!(leading.json);
        assert!(trailing.json);
        assert!(nested.json);
    }

    #[test]
    fn test_json_flag_defaults_to_false() {
        let cli = Cli::try_parse_from(["zdebug", "case", "status"]).unwrap();
        assert!(!cli.json);
    }

    #[test]
    fn test_case_subcommands_parse() {
        assert!(matches!(parse(&["doctor"]), Command::Doctor));
        let init = parse(&[
            "case",
            "init",
            "CASE-1",
            "--title",
            "t",
            "--objective",
            "o",
        ]);
        assert!(matches!(init, Command::Case(CaseCommand::Init(_))));
        assert!(matches!(
            parse(&["case", "status"]),
            Command::Case(CaseCommand::Status(_))
        ));
        assert!(matches!(
            parse(&["case", "close", "--reason", "completed"]),
            Command::Case(CaseCommand::Close(_))
        ));
        assert!(matches!(
            parse(&["case", "reopen", "--reason", "again"]),
            Command::Case(CaseCommand::Reopen(_))
        ));
        assert!(matches!(
            parse(&["case", "finalize"]),
            Command::Case(CaseCommand::Finalize(_))
        ));
        assert!(matches!(
            parse(&["case", "verify"]),
            Command::Case(CaseCommand::Verify(_))
        ));
        assert!(matches!(
            parse(&["case", "recover"]),
            Command::Case(CaseCommand::Recover(_))
        ));
        assert!(matches!(
            parse(&["case", "repair-view"]),
            Command::Case(CaseCommand::RepairView(_))
        ));
        let update = parse(&[
            "case",
            "update-verify",
            "--verify",
            "cmd",
            "--reason",
            "why",
        ]);
        assert!(matches!(update, Command::Case(CaseCommand::UpdateVerify(_))));
    }

    #[test]
    fn test_case_init_workspace_flag_is_repeatable() {
        let init = parse(&[
            "case",
            "init",
            "CASE-1",
            "--title",
            "t",
            "--objective",
            "o",
            "--workspace",
            "a",
            "--workspace",
            "b",
        ]);
        let Command::Case(CaseCommand::Init(args)) = init else {
            panic!("expected case init");
        };
        assert_eq!(args.workspaces, vec!["a", "b"]);
        // The pre-fix plural spelling is no longer accepted.
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "case",
                "init",
                "CASE-1",
                "--title",
                "t",
                "--objective",
                "o",
                "--workspaces",
                "a",
            ])
            .is_err()
        );
    }

    #[test]
    fn test_ledger_subcommands_parse() {
        let add = parse(&[
            "deliverable",
            "add",
            "--title",
            "t",
            "--contract",
            "c",
            "--criterion",
            "d",
        ]);
        assert!(matches!(
            add,
            Command::Deliverable(DeliverableCommand::Add(_))
        ));
        let dispose = parse(&[
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
        assert!(matches!(
            dispose,
            Command::Deliverable(DeliverableCommand::Dispose(_))
        ));
        let content = parse(&[
            "deliverable",
            "content",
            "--deliverable",
            "DL-001",
            "--file",
            "f.md",
            "--reference",
            "CL-001",
        ]);
        assert!(matches!(
            content,
            Command::Deliverable(DeliverableCommand::Content(_))
        ));

        assert!(matches!(
            parse(&["claim", "add", "--statement", "s"]),
            Command::Claim(ClaimCommand::Add(_))
        ));
        let assess = parse(&[
            "claim", "assess", "--claim", "CL-001", "--as", "open", "--reason",
            "r",
        ]);
        assert!(matches!(assess, Command::Claim(ClaimCommand::Assess(_))));
        let relate = parse(&[
            "claim",
            "relate",
            "--source",
            "CL-001",
            "--relation",
            "refines",
            "--target",
            "CL-002",
            "--reason",
            "r",
        ]);
        assert!(matches!(relate, Command::Claim(ClaimCommand::Relate(_))));
    }

    #[test]
    fn test_experiment_evidence_artifact_subcommands_parse() {
        let plan = parse(&[
            "experiment",
            "plan",
            "--question",
            "q",
            "--interpretations",
            "i.json",
            "--script",
            "s.sh",
        ]);
        assert!(matches!(
            plan,
            Command::Experiment(ExperimentCommand::Plan(_))
        ));
        assert!(matches!(
            parse(&["experiment", "run", "EX-001"]),
            Command::Experiment(ExperimentCommand::Run(_))
        ));

        let evidence =
            parse(&["evidence", "add", "--statement", "s", "--source", "x"]);
        assert!(matches!(evidence, Command::Evidence(EvidenceCommand::Add(_))));
        let relate = parse(&[
            "evidence",
            "relate",
            "--evidence",
            "EV-001",
            "--relation",
            "supports",
            "--claim",
            "CL-001",
            "--reason",
            "r",
        ]);
        assert!(matches!(
            relate,
            Command::Evidence(EvidenceCommand::Relate(_))
        ));
        let invalidate =
            parse(&["evidence", "invalidate", "EV-001", "--reason", "r"]);
        assert!(matches!(
            invalidate,
            Command::Evidence(EvidenceCommand::Invalidate(_))
        ));

        let artifact = parse(&["artifact", "add", "path", "--storage", "copy"]);
        assert!(matches!(artifact, Command::Artifact(ArtifactCommand::Add(_))));
        let invalidate =
            parse(&["artifact", "invalidate", "AR-001", "--reason", "r"]);
        assert!(matches!(
            invalidate,
            Command::Artifact(ArtifactCommand::Invalidate(_))
        ));
    }

    #[test]
    fn test_missing_required_arguments_error() {
        assert!(
            Cli::try_parse_from([
                "zdebug", "case", "init", "CASE-1", "--title", "t"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "deliverable",
                "add",
                "--contract",
                "c",
                "--criterion",
                "d",
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "case",
                "update-verify",
                "--reason",
                "r"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "evidence",
                "add",
                "--statement",
                "s"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "experiment",
                "plan",
                "--question",
                "q",
                "--script",
                "s.sh",
            ])
            .is_err()
        );
    }

    #[test]
    fn test_rejects_invalid_enum_value() {
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "artifact",
                "add",
                "p",
                "--storage",
                "zip"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug", "case", "close", "--reason", "nope"
            ])
            .is_err()
        );
    }

    #[test]
    fn test_group_requires_subcommand() {
        assert!(Cli::try_parse_from(["zdebug"]).is_err());
        assert!(Cli::try_parse_from(["zdebug", "case"]).is_err());
    }

    #[test]
    fn test_evidence_add_requires_provenance() {
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "evidence",
                "add",
                "--statement",
                "s"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "zdebug",
                "evidence",
                "add",
                "--statement",
                "s",
                "--source",
                "a",
                "--from-experiment",
                "EX-001",
            ])
            .is_err()
        );
    }

    #[test]
    fn test_script_dash_selects_stdin() {
        let command = parse(&[
            "experiment",
            "plan",
            "--question",
            "q",
            "--interpretations",
            "i.json",
            "--script",
            "-",
        ]);
        let Command::Experiment(ExperimentCommand::Plan(args)) = command else {
            panic!("expected experiment plan");
        };
        assert_eq!(args.script, PathBuf::from("-"));
    }

    #[test]
    fn test_next_id_increments_per_prefix() {
        let mut mapping = Map::new();
        mapping.insert("EV-001".to_owned(), Value::Null);
        mapping.insert("EV-004".to_owned(), Value::Null);
        mapping.insert("CL-002".to_owned(), Value::Null);
        assert_eq!(next_id("EV", &mapping), "EV-005");
        assert_eq!(next_id("CL", &mapping), "CL-003");
        assert_eq!(next_id("EX", &mapping), "EX-001");
    }

    #[test]
    fn test_locate_case_prefers_explicit_dir() {
        let dir = tempfile::tempdir().unwrap();
        let explicit = dir.path().join("explicit");
        let found = locate_case(None, Some(&explicit), dir.path()).unwrap();
        assert_eq!(found, explicit);
    }

    #[test]
    fn test_locate_case_maps_case_id_under_root() {
        let dir = tempfile::tempdir().unwrap();
        let found = locate_case(Some("CASE-9"), None, dir.path()).unwrap();
        assert_eq!(found, dir.path().join(".zoo/debug/CASE-9"));
    }

    #[test]
    fn test_locate_case_searches_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let case = dir.path().join(".zoo/debug/CASE-1");
        fs::create_dir_all(&case).unwrap();
        fs::write(case.join("case.jsonl"), "").unwrap();
        let nested = dir.path().join("a/b");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(locate_case(None, None, &nested).unwrap(), case);
    }

    #[test]
    fn test_locate_case_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".zoo/debug");
        for id in ["CASE-1", "CASE-2"] {
            let case = root.join(id);
            fs::create_dir_all(&case).unwrap();
            fs::write(case.join("case.jsonl"), "").unwrap();
        }
        let err = locate_case(None, None, dir.path()).unwrap_err();
        assert_eq!(err.code(), "CASE_AMBIGUOUS");
    }

    #[test]
    fn test_locate_case_required() {
        let dir = tempfile::tempdir().unwrap();
        let err = locate_case(None, None, dir.path()).unwrap_err();
        assert_eq!(err.code(), "CASE_REQUIRED");
    }

    #[test]
    fn test_parse_key_values() {
        let parsed =
            parse_key_values(&["A=1".to_owned(), "B=x=y".to_owned()]).unwrap();
        assert_eq!(parsed["A"], "1");
        assert_eq!(parsed["B"], "x=y");
        assert_eq!(
            parse_key_values(&["NOEQUALS".to_owned()]).unwrap_err().code(),
            "INVALID_KEY_VALUE"
        );
        assert_eq!(
            parse_key_values(&["=v".to_owned()]).unwrap_err().code(),
            "INVALID_KEY_VALUE"
        );
    }

    #[test]
    fn test_load_json_arg_accepts_inline_and_file() {
        let inline = load_json_arg(Some("{\"a\": 1}"), Value::Null).unwrap();
        assert_eq!(inline["a"], 1);
        let default = load_json_arg(None, json!({"d": true})).unwrap();
        assert_eq!(default["d"], true);
        assert_eq!(
            load_json_arg(Some("{bad"), Value::Null).unwrap_err().code(),
            "INVALID_JSON"
        );
    }

    /// Build an `artifact add` argument set targeting `case_dir`.
    fn artifact_args(
        case_dir: &Path,
        path: &Path,
        id: Option<&str>,
        name: Option<&str>,
    ) -> ArtifactAddArgs {
        ArtifactAddArgs {
            locator: CaseLocator {
                id: None,
                dir: Some(case_dir.to_path_buf()),
            },
            path: path.to_path_buf(),
            id: id.map(ToOwned::to_owned),
            storage: "copy".to_owned(),
            name: name.map(ToOwned::to_owned),
            availability: "durable".to_owned(),
        }
    }

    #[test]
    fn test_artifact_add_rejected_on_closed_case_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        let repository = CaseRepository::new(&case_dir);
        repository.initialize("CASE-1", "t", "o", &[], None, None).unwrap();
        repository
            .append("workspace-finalized", &json!({"snapshots": []}))
            .unwrap();
        repository
            .append("case-closed", &json!({"reason": "completed"}))
            .unwrap();
        assert_eq!(repository.status().unwrap().lifecycle, "CLOSED");

        let source = dir.path().join("payload.txt");
        fs::write(&source, "bytes").unwrap();
        let context = Context { cwd: dir.path().to_path_buf() };
        let Err(err) = artifact_add(
            &context,
            &artifact_args(&case_dir, &source, None, None),
        ) else {
            panic!("expected the closed-Case write to be rejected");
        };
        assert_eq!(err.code(), "CASE_CLOSED");
        assert!(!case_dir.join("artifacts").exists());
    }

    /// Build a `deliverable content` argument set targeting `case_dir`.
    fn content_args(
        case_dir: &Path,
        deliverable: &str,
        file: &Path,
    ) -> DeliverableContentArgs {
        DeliverableContentArgs {
            locator: CaseLocator {
                id: None,
                dir: Some(case_dir.to_path_buf()),
            },
            deliverable: deliverable.to_owned(),
            file: file.to_path_buf(),
            references: Vec::new(),
        }
    }

    #[test]
    fn test_deliverable_content_missing_deliverable_leaves_no_trace() {
        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        let repository = CaseRepository::new(&case_dir);
        repository.initialize("CASE-1", "t", "o", &[], None, None).unwrap();
        let log = case_dir.join(CASE_FILE);
        let before = fs::read_to_string(&log).unwrap().lines().count();

        let source = dir.path().join("payload.md");
        fs::write(&source, "bytes").unwrap();
        let context = Context { cwd: dir.path().to_path_buf() };
        let Err(err) = deliverable_content(
            &context,
            &content_args(&case_dir, "DL-404", &source),
        ) else {
            panic!("expected the missing Deliverable to be rejected");
        };
        assert_eq!(err.code(), "DELIVERABLE_NOT_FOUND");
        assert_eq!(err.to_string(), "Deliverable not found: DL-404");
        assert!(!case_dir.join("artifacts").exists());
        assert_eq!(fs::read_to_string(&log).unwrap().lines().count(), before);
    }

    #[test]
    fn test_artifact_add_duplicate_id_keeps_existing_bytes() {
        use zdebug::util::sha256_file;

        let dir = tempfile::tempdir().unwrap();
        let case_dir = dir.path().join("case");
        let repository = CaseRepository::new(&case_dir);
        repository.initialize("CASE-1", "t", "o", &[], None, None).unwrap();

        let original = dir.path().join("first.txt");
        fs::write(&original, "original").unwrap();
        let context = Context { cwd: dir.path().to_path_buf() };
        artifact_add(
            &context,
            &artifact_args(
                &case_dir,
                &original,
                Some("AR-001"),
                Some("kept.txt"),
            ),
        )
        .unwrap();
        let stored = case_dir.join("artifacts/imported/AR-001/kept.txt");
        let before = fs::read(&stored).unwrap();
        let digest = sha256_file(&stored).unwrap();

        let replacement = dir.path().join("second.txt");
        fs::write(&replacement, "different bytes").unwrap();
        let Err(err) = artifact_add(
            &context,
            &artifact_args(
                &case_dir,
                &replacement,
                Some("AR-001"),
                Some("kept.txt"),
            ),
        ) else {
            panic!("expected the duplicate Artifact write to be rejected");
        };
        assert_eq!(err.code(), "DUPLICATE_ARTIFACT");
        assert_eq!(fs::read(&stored).unwrap(), before);
        assert_eq!(sha256_file(&stored).unwrap(), digest);
        assert_eq!(
            repository.status().unwrap().artifacts["AR-001"]["sha256"].as_str(),
            Some(digest.as_str())
        );
    }
}
