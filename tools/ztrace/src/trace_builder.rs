// Timeline builder — merge ZooKeeper + opencode logs into unified trace events.
//
// This is the heart of ztrace. It merges 4 data sources into a unified
// timeline: opencode log parsed entries, zoo JSONL log entries, DB messages,
// and DB tool calls.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;

use serde_json::{Map, Number, Value};

use zutil::format_number;
use zutil::get_zoo_log_dir;
use zutil::iso_to_epoch_ms;

use crate::db;
use crate::parser::{self, tool_type_and_icon};

// ── classify_opencode — helpers ──────────────────────────────────────────────

/// Build the detail map for a session-created event.
fn build_created_detail(
    entry: &HashMap<String, String>,
    slug: &str,
    agent: &str,
    model_id: &str,
    model_provider: &str,
) -> Map<String, Value> {
    let mut detail = Map::new();
    detail.insert(
        "id".to_string(),
        Value::String(entry.get("id").cloned().unwrap_or_default()),
    );
    detail.insert("slug".to_string(), Value::String(slug.to_string()));
    detail.insert("agent".to_string(), Value::String(agent.to_string()));
    detail.insert("model_id".to_string(), Value::String(model_id.to_string()));
    detail.insert(
        "model_provider".to_string(),
        Value::String(model_provider.to_string()),
    );
    detail.insert(
        "title".to_string(),
        Value::String(entry.get("title").cloned().unwrap_or_default()),
    );
    detail.insert(
        "parent_id".to_string(),
        Value::String(entry.get("parent_id").cloned().unwrap_or_default()),
    );
    detail.insert(
        "project_id".to_string(),
        Value::String(entry.get("projectID").cloned().unwrap_or_default()),
    );
    detail.insert(
        "cost".to_string(),
        Value::String(
            entry.get("cost").cloned().unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail.insert(
        "tokens_input".to_string(),
        Value::String(
            entry
                .get("tokens_input")
                .cloned()
                .unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail.insert(
        "tokens_output".to_string(),
        Value::String(
            entry
                .get("tokens_output")
                .cloned()
                .unwrap_or_else(|| "0".to_string()),
        ),
    );
    detail
}

/// Build a session-created event from an opencode log entry.
#[must_use]
fn classify_opencode_created(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let slug = entry.get("slug").map_or("", std::string::String::as_str);
    let agent = entry.get("agent").map_or("", std::string::String::as_str);
    let model_id =
        entry.get("model_id").map_or("", std::string::String::as_str);
    let model_provider =
        entry.get("model_providerID").map_or("", std::string::String::as_str);
    let title = entry
        .get("title")
        .map(std::string::String::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(slug);

    let mut parts: Vec<String> = Vec::new();
    if !slug.is_empty() {
        parts.push(slug.to_string());
    }
    if !agent.is_empty() {
        parts.push(format!("agent={agent}"));
    }
    if !model_id.is_empty() {
        parts.push(format!("model={model_id}"));
    }
    if !model_provider.is_empty() {
        parts.push(format!("provider={model_provider}"));
    }

    let summary = if parts.is_empty() {
        if title.is_empty() || title == slug {
            format!("Session {slug}")
        } else {
            format!("Session {slug}: {title}")
        }
    } else {
        format!("Session {} ({})", slug, parts.join(", "))
    };

    let detail =
        build_created_detail(entry, slug, agent, model_id, model_provider);

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a loop-step event from an opencode log entry.
#[must_use]
fn classify_opencode_loop(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let step = entry.get("step").cloned().unwrap_or_else(|| "0".to_string());
    let mut detail = Map::new();
    detail.insert("step".to_string(), Value::String(step.clone()));
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("Loop step={step}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a process-message event from an opencode log entry.
#[must_use]
fn classify_opencode_process(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let mut detail = Map::new();
    detail.insert(
        "message_id".to_string(),
        Value::String(entry.get("messageID").cloned().unwrap_or_default()),
    );
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("💬".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String("Process message".to_string()),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an exiting-loop event from an opencode log entry.
#[must_use]
fn classify_opencode_exiting_loop(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let mut detail = Map::new();
    detail.insert(
        "session_id".to_string(),
        Value::String(entry.get("session_id").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("session".to_string()));
    ev.insert("icon".to_string(), Value::String("◆".to_string()));
    ev.insert("summary".to_string(), Value::String("Exiting loop".to_string()));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an LLM-runtime-selected event from an opencode log entry.
#[must_use]
fn classify_opencode_llm_runtime(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let provider =
        entry.get("llm_provider").cloned().unwrap_or_else(|| "?".to_string());
    let model =
        entry.get("llm_model").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("provider".to_string(), Value::String(provider.clone()));
    detail.insert("model".to_string(), Value::String(model.clone()));
    detail.insert(
        "runtime".to_string(),
        Value::String(entry.get("llm_runtime").cloned().unwrap_or_default()),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("llm".to_string()));
    ev.insert("icon".to_string(), Value::String("▲".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("LLM {provider}/{model}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a stream event from an opencode log entry.
#[must_use]
fn classify_opencode_stream(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let provider =
        entry.get("providerID").cloned().unwrap_or_else(|| "?".to_string());
    let model =
        entry.get("modelID").cloned().unwrap_or_else(|| "?".to_string());
    let agent = entry.get("agent").cloned().unwrap_or_else(|| "?".to_string());
    let mode = entry.get("mode").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("provider".to_string(), Value::String(provider.clone()));
    detail.insert("model".to_string(), Value::String(model.clone()));
    detail.insert("agent".to_string(), Value::String(agent.clone()));
    detail.insert("mode".to_string(), Value::String(mode.clone()));

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("llm_stream".to_string()));
    ev.insert("icon".to_string(), Value::String("▲".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!(
            "Stream {provider}/{model} agent={agent} ({mode})"
        )),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build an evaluated event (permission check or tool call).
#[must_use]
fn classify_opencode_evaluated(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let permission =
        entry.get("permission").cloned().unwrap_or_else(|| "?".to_string());
    let pattern = entry.get("pattern").cloned().unwrap_or_default();
    let action =
        entry.get("action_action").cloned().unwrap_or_else(|| "?".to_string());

    let mut detail = Map::new();
    detail.insert("permission".to_string(), Value::String(permission.clone()));
    detail.insert("pattern".to_string(), Value::String(pattern.clone()));
    detail.insert("action".to_string(), Value::String(action.clone()));

    if action == "deny" {
        // Denied → permission event
        let mut ev = Map::new();
        ev.insert(
            "timestamp".to_string(),
            Value::String(timestamp.to_string()),
        );
        ev.insert("source".to_string(), Value::String("opencode".to_string()));
        ev.insert("type".to_string(), Value::String("permission".to_string()));
        ev.insert("icon".to_string(), Value::String("▼".to_string()));
        ev.insert(
            "summary".to_string(),
            Value::String(format!("permission=deny {permission} {pattern}")),
        );
        ev.insert("detail".to_string(), Value::Object(detail));
        return Value::Object(ev);
    }

    // Allowed → tool call (classified by permission)
    let (event_type, icon) = tool_type_and_icon(&permission);

    // Parse duration field if present
    if let Some(dur_str) = entry.get("duration")
        && let Ok(dur) = dur_str.parse::<f64>()
    {
        detail.insert(
            "duration_sec".to_string(),
            Number::from_f64(dur).map_or(Value::Null, Value::Number),
        );
    }

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String(event_type));
    ev.insert("icon".to_string(), Value::String(icon));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("{permission}: {pattern}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a file-touch event from an opencode log entry.
#[must_use]
fn classify_opencode_touching_file(
    entry: &HashMap<String, String>,
    timestamp: &str,
) -> Value {
    let file_path = entry.get("file").cloned().unwrap_or_default();
    let action =
        entry.get("action").cloned().unwrap_or_else(|| "edit".to_string());

    let mut detail = Map::new();
    detail.insert("file".to_string(), Value::String(file_path.clone()));
    detail.insert("action".to_string(), Value::String(action.clone()));

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("file".to_string()));
    ev.insert("icon".to_string(), Value::String("■".to_string()));
    ev.insert(
        "summary".to_string(),
        Value::String(format!("{action}: {file_path}")),
    );
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

/// Build a fallback hook event for unrecognised opencode messages.
#[must_use]
fn classify_opencode_fallback(
    entry: &HashMap<String, String>,
    timestamp: &str,
    msg: &str,
) -> Value {
    let summary = if msg.is_empty() {
        "opencode event".to_string()
    } else {
        format!("opencode: {msg}")
    };

    // Build detail from entire entry
    let mut detail = Map::new();
    for (k, v) in entry {
        detail.insert(k.clone(), Value::String(v.clone()));
    }

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    ev.insert("source".to_string(), Value::String("opencode".to_string()));
    ev.insert("type".to_string(), Value::String("hook".to_string()));
    ev.insert("icon".to_string(), Value::String("◈".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), Value::Object(detail));
    Value::Object(ev)
}

// ── classify_opencode ─────────────────────────────────────────────────────────

/// Convert a parsed opencode log entry to a unified timeline event dict.
///
/// Match on `entry["message"]`:
/// - `"created"` → session creation event
/// - `"loop"` → loop step event
/// - `"process"` → process message event
/// - `"exiting loop"` → loop exit event
/// - `"llm runtime selected"` → LLM runtime selection
/// - `"stream"` → LLM stream event
/// - `"evaluated"` → permission check or tool call
/// - `"touching file"` → file touch event
/// - fallback → hook event
#[must_use]
pub fn classify_opencode(entry: &HashMap<String, String>) -> Value {
    let msg = entry.get("message").map_or("", std::string::String::as_str);

    let timestamp = parser::normalize_timestamp(
        entry.get("timestamp").map_or("", std::string::String::as_str),
    );

    match msg {
        "created" => classify_opencode_created(entry, &timestamp),
        "loop" => classify_opencode_loop(entry, &timestamp),
        "process" => classify_opencode_process(entry, &timestamp),
        "exiting loop" => classify_opencode_exiting_loop(entry, &timestamp),
        "llm runtime selected" => {
            classify_opencode_llm_runtime(entry, &timestamp)
        }
        "stream" => classify_opencode_stream(entry, &timestamp),
        "evaluated" => classify_opencode_evaluated(entry, &timestamp),
        "touching file" => classify_opencode_touching_file(entry, &timestamp),
        _ => classify_opencode_fallback(entry, &timestamp, msg),
    }
}

// ── classify_zoo ──────────────────────────────────────────────────────────────

/// Convert a `ZooKeeper` log entry to a unified trace event.
///
/// Source is `"zoo"`, type is `"hook"`, icon is `"◈"`. Special summary for
/// `context-metrics` hook events.
#[must_use]
pub fn classify_zoo(entry: &Value) -> Value {
    let hook = entry.get("hook").and_then(Value::as_str).unwrap_or("?");
    let event_ = entry.get("event").and_then(Value::as_str).unwrap_or("?");
    let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");

    let summary = if hook == "context-metrics" && event_ == "context_measured" {
        let tokens = usize::try_from(
            entry.get("estimated_tokens").and_then(Value::as_u64).unwrap_or(0),
        )
        .unwrap_or(0);
        let msgs = usize::try_from(
            entry.get("message_count").and_then(Value::as_u64).unwrap_or(0),
        )
        .unwrap_or(0);
        let agent = entry.get("agent").and_then(Value::as_str).unwrap_or("");

        if agent.is_empty() {
            format!("context: {} tokens ({msgs} msgs)", format_number(tokens))
        } else {
            format!(
                "context [{agent}]: {} tokens ({msgs} msgs)",
                format_number(tokens)
            )
        }
    } else {
        format!("{hook}/{event_}")
    };

    let timestamp = parser::normalize_timestamp(
        entry.get("timestamp").and_then(Value::as_str).unwrap_or(""),
    );

    let mut ev = Map::new();
    ev.insert("timestamp".to_string(), Value::String(timestamp));
    ev.insert("source".to_string(), Value::String("zoo".to_string()));
    ev.insert("type".to_string(), Value::String("hook".to_string()));
    ev.insert("icon".to_string(), Value::String("◈".to_string()));
    ev.insert("summary".to_string(), Value::String(summary));
    ev.insert("detail".to_string(), entry.clone());
    ev.insert("level".to_string(), Value::String(level.to_string()));

    Value::Object(ev)
}

// ── parse_opencode_all ────────────────────────────────────────────────────────

/// Parse an entire opencode log file in a single scan.
///
/// Returns all parsed entry dicts. Returns an empty `Vec` if the file is not
/// found (with a warning printed to stderr).
#[must_use]
pub fn parse_opencode_all(oc_path: &str) -> Vec<HashMap<String, String>> {
    let path = Path::new(oc_path);
    if !path.exists() {
        eprintln!("[ztrace] Warning: opencode log file not found: {oc_path}");
        return Vec::new();
    }

    let content = match fs::read_to_string(oc_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ztrace] Warning: could not read opencode log: {e}");
            return Vec::new();
        }
    };

    let mut entries: Vec<HashMap<String, String>> = Vec::new();
    for line in content.lines() {
        if let Some(entry) = parser::parse_opencode_line(line) {
            entries.push(entry);
        }
    }
    entries
}

// ── discover_child_sessions_from_entries ──────────────────────────────────────

/// Discover child sessions from pre-parsed entries via BFS.
///
/// Builds a `parentID → [child IDs]` map from `message=created` lines,
/// then BFS-traverses from `root_session_id`.
///
/// Returns `Vec<(session_id, depth)>` including the root session (depth 0),
/// direct children (depth 1), etc., in BFS order.
#[must_use]
pub fn discover_child_sessions_from_entries(
    all_entries: &[HashMap<String, String>],
    root_session_id: &str,
) -> Vec<(String, i64)> {
    // Build parentID → [child IDs] map
    let mut children: HashMap<String, Vec<String>> = HashMap::new();

    for entry in all_entries {
        if entry.get("message").map(std::string::String::as_str)
            != Some("created")
        {
            continue;
        }
        let eid = match entry.get("id") {
            Some(id) if !id.is_empty() => id.clone(),
            _ => continue,
        };
        let pid = entry
            .get("parentID")
            .or_else(|| entry.get("parent_id"))
            .filter(|p| *p != "undefined" && !p.is_empty())
            .cloned();

        if let Some(parent_id) = pid {
            children.entry(parent_id).or_default().push(eid);
        }
    }

    // BFS from root_session_id
    let mut result: Vec<(String, i64)> = Vec::new();
    let mut queue: VecDeque<(String, i64)> = VecDeque::new();
    let mut visited: HashSet<String> = HashSet::new();

    result.push((root_session_id.to_string(), 0));
    queue.push_back((root_session_id.to_string(), 0));
    visited.insert(root_session_id.to_string());

    while let Some((current, depth)) = queue.pop_front() {
        if let Some(child_list) = children.get(&current) {
            for child in child_list {
                if visited.insert(child.clone()) {
                    let entry = (child.clone(), depth + 1);
                    result.push(entry.clone());
                    queue.push_back(entry);
                }
            }
        }
    }

    result
}

// ── build_session_agents ──────────────────────────────────────────────────────

/// Build a `session_id → agent` map from pre-parsed entries.
///
/// Only sessions present in `sids` are included. Agent field takes
/// priority, with `slug` as fallback.
#[must_use]
pub fn build_session_agents(
    all_entries: &[HashMap<String, String>],
    sids: &HashSet<&str>,
) -> HashMap<String, String> {
    let mut agents: HashMap<String, String> = HashMap::new();

    for entry in all_entries {
        if entry.get("message").map(std::string::String::as_str)
            != Some("created")
        {
            continue;
        }
        let eid = match entry.get("id") {
            Some(id) if !id.is_empty() => id.clone(),
            _ => continue,
        };
        if sids.contains(eid.as_str()) {
            let agent = entry
                .get("agent")
                .filter(|a| !a.is_empty())
                .cloned()
                .or_else(|| entry.get("slug").cloned())
                .unwrap_or_default();
            agents.insert(eid, agent);
        }
    }

    agents
}

// ── resolve_and_group_entries ─────────────────────────────────────────────────

/// Shared session-disambiguation logic for grouping entries by session ID.
///
/// Builds a `run → session_id` mapping from `message=created` lines,
/// maintains a `session_stack` for run-based disambiguation via
/// `loop`/`exiting loop` events, matches entries directly by
/// `session_id` or `id`, and falls back to run-based resolution.
///
/// Returns a dict mapping each `session_id` in `sids` to its list of entry dicts.
#[must_use]
pub fn resolve_and_group_entries(
    all_entries: &[HashMap<String, String>],
    sids: &HashSet<&str>,
) -> HashMap<String, Vec<HashMap<String, String>>> {
    if sids.is_empty() {
        return HashMap::new();
    }

    let mut run_to_session: HashMap<String, String> = HashMap::new();
    let mut session_stack: Vec<String> = Vec::new();
    let mut result: HashMap<String, Vec<HashMap<String, String>>> =
        HashMap::new();

    // Initialize result with empty vecs for all requested sids
    for sid in sids {
        result.insert(sid.to_string(), Vec::new());
    }

    for entry in all_entries {
        let msg = entry.get("message").map_or("", String::as_str);

        // Build run → session_id mapping from 'created' lines
        if msg == "created"
            && let (Some(id), Some(run)) = (entry.get("id"), entry.get("run"))
            && !id.is_empty()
            && !run.is_empty()
        {
            run_to_session.insert(run.clone(), id.clone());
        }

        // Active session stack: push on loop, pop on exiting loop
        if msg == "loop"
            && let Some(sid) = entry.get("session_id")
            && !sid.is_empty()
        {
            session_stack.push(sid.clone());
        }
        if msg == "exiting loop"
            && let Some(sid) = entry.get("session_id")
            && !sid.is_empty()
            && let Some(top) = session_stack.last()
            && top == sid
        {
            session_stack.pop();
        }

        // Check direct session_id / id match
        let matched_id = entry
            .get("session_id")
            .or_else(|| entry.get("id"))
            .cloned()
            .filter(|s| !s.is_empty());

        if let Some(ref mid) = matched_id
            && sids.contains(mid.as_str())
        {
            if let Some(vec) = result.get_mut(mid) {
                vec.push(entry.clone());
            }
            continue;
        }

        // Check run-based mapping (for entries without session_id)
        if let Some(run) = entry.get("run")
            && !run.is_empty()
            && run_to_session.contains_key(run)
        {
            let sid = if let Some(top) = session_stack.last()
                && sids.contains(top.as_str())
            {
                top.clone()
            } else {
                run_to_session[run].clone()
            };

            if sids.contains(sid.as_str())
                && let Some(vec) = result.get_mut(&sid)
            {
                vec.push(entry.clone());
            }
        }
    }

    result
}

// ── build_timeline — helpers ──────────────────────────────────────────────────

/// Read `ZooKeeper` log events and add them to the timeline.
///
/// The log file is named `opencode-{session_id}.log` in the zoo log dir.
/// Each event is tagged with the session it belongs to (by sessionId or
/// agent-name matching) and its depth in the session tree.
fn add_zoo_log_events(
    session_id: &str,
    timeline: &mut Vec<Value>,
    all_sids: &HashSet<String>,
    sessions: &[(String, i64)],
    session_agents: &HashMap<String, String>,
    session_depth_map: &HashMap<&str, i64>,
) {
    let zoo_dir = get_zoo_log_dir();
    let root_zoo_path =
        Path::new(&zoo_dir).join(format!("opencode-{session_id}.log"));
    if !root_zoo_path.exists() {
        return;
    }

    let zoo_events =
        parser::parse_zoo_log(root_zoo_path.to_str().unwrap_or(""));
    for zoo_ev in &zoo_events {
        // Determine which session this entry belongs to
        let mut target_sid: Option<String> = None;
        let zoo_sid = zoo_ev
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let zoo_agent = zoo_ev
            .get("agent")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        if !zoo_sid.is_empty() && all_sids.contains(&zoo_sid) {
            target_sid = Some(zoo_sid);
        } else if !zoo_agent.is_empty() {
            // Empty or unknown sessionId — match by agent name
            for (sid, _) in sessions {
                if session_agents.get(sid) == Some(&zoo_agent) {
                    target_sid = Some(sid.clone());
                    break;
                }
            }
        } else if zoo_sid.is_empty() && zoo_agent.is_empty() {
            // Both sessionId and agent empty — assign to root
            target_sid = Some(session_id.to_string());
        }

        if let Some(ref sid) = target_sid
            && all_sids.contains(sid)
        {
            let mut ev = classify_zoo(zoo_ev);
            if let Some(obj) = ev.as_object_mut() {
                obj.insert(
                    "session_id".to_string(),
                    Value::String(sid.clone()),
                );
                obj.insert(
                    "depth".to_string(),
                    Value::Number(Number::from(
                        session_depth_map
                            .get(sid.as_str())
                            .copied()
                            .unwrap_or(0),
                    )),
                );
            }
            timeline.push(ev);
        }
    }
}

/// Add DB tool-call events, deduplicating against existing opencode tool events.
///
/// Dedup uses ±3s proximity by tool name and session ID.
fn add_db_tool_call_events(
    timeline: &mut Vec<Value>,
    sid_vec: &[&str],
    session_depth_map: &HashMap<&str, i64>,
    db_path: &str,
) {
    let db_tool_events = db::query_db_tool_calls(sid_vec, db_path);
    if db_tool_events.is_empty() {
        return;
    }

    // Build dedup index from existing timeline (opencode log) tool events.
    // Each entry: (tool_name, epoch_ms, session_id)
    let mut existing_tool_times: Vec<(String, i64, String)> = Vec::new();

    for ev in timeline.iter() {
        let etype = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype.starts_with("tool_") {
            let ts_ms = iso_to_epoch_ms(
                ev.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
            );
            if ts_ms != 0 {
                let tool_name = ev
                    .get("detail")
                    .and_then(|d| d.get("permission"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !tool_name.is_empty() {
                    let ev_sid = ev
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    existing_tool_times.push((tool_name, ts_ms, ev_sid));
                }
            }
        }
    }

    for mut ev in db_tool_events {
        // Add depth
        let ev_sid = ev
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(obj) = ev.as_object_mut() {
            let depth =
                session_depth_map.get(ev_sid.as_str()).copied().unwrap_or(0);
            obj.insert("depth".to_string(), Value::Number(Number::from(depth)));
        }

        let ts_ms = iso_to_epoch_ms(
            ev.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
        );
        let tool_name = ev
            .get("detail")
            .and_then(|d| d.get("tool_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Check absolute proximity (≤ 3s) against existing events
        // with the same tool name and same session.
        let is_dup = if ts_ms != 0 && !tool_name.is_empty() {
            existing_tool_times.iter().any(|(name, existing_ts, sid)| {
                name == &tool_name
                    && sid == &ev_sid
                    && (existing_ts - ts_ms).unsigned_abs() <= 3000
            })
        } else {
            false
        };

        if !is_dup && ts_ms != 0 && !tool_name.is_empty() {
            existing_tool_times.push((tool_name, ts_ms, ev_sid));
        }
        if !is_dup {
            timeline.push(ev);
        }
    }
}

// ── build_timeline ────────────────────────────────────────────────────────────

/// Merge `ZooKeeper` + opencode logs + DB sources into a sorted timeline.
///
/// When `include_children` is `true`, automatically discovers and includes
/// all child sessions (transitive descendants) of the given session.
/// Each event is tagged with `session_id`, `depth`, and `session_agent`.
///
/// # Errors
///
/// Returns `Err` with a description if the opencode log file cannot be found
/// or parsed.
pub fn build_timeline(
    session_id: &str,
    opencode_path: &str,
    db_path: &str,
    include_children: bool,
) -> Result<Vec<Value>, String> {
    let oc_path = Path::new(opencode_path);
    if !oc_path.exists() {
        return Err(format!("Log file not found: {opencode_path}"));
    }

    // Single scan: parse opencode log once
    let all_entries = parse_opencode_all(opencode_path);

    // Discover sessions to include
    let sessions: Vec<(String, i64)> = if include_children {
        discover_child_sessions_from_entries(&all_entries, session_id)
    } else {
        vec![(session_id.to_string(), 0)]
    };

    // Pre-build session → agent map for child labeling
    let all_sids: HashSet<String> =
        sessions.iter().map(|(sid, _)| sid.clone()).collect();
    let all_sids_refs: HashSet<&str> =
        all_sids.iter().map(std::string::String::as_str).collect();
    let session_agents = build_session_agents(&all_entries, &all_sids_refs);

    // Group entries by session
    let oc_entries_by_sid =
        resolve_and_group_entries(&all_entries, &all_sids_refs);

    let mut timeline: Vec<Value> = Vec::new();
    let session_depth_map: HashMap<&str, i64> =
        sessions.iter().map(|(sid, depth)| (sid.as_str(), *depth)).collect();

    // ── ZooKeeper log ──
    add_zoo_log_events(
        session_id,
        &mut timeline,
        &all_sids,
        &sessions,
        &session_agents,
        &session_depth_map,
    );

    // ── Opencode log (from pre-parsed multi-session map) ──
    for (sid, depth) in &sessions {
        if let Some(oc_entries) = oc_entries_by_sid.get(sid.as_str()) {
            for oc_entry in oc_entries {
                let mut ev = classify_opencode(oc_entry);
                if let Some(obj) = ev.as_object_mut() {
                    obj.insert(
                        "session_id".to_string(),
                        Value::String(sid.clone()),
                    );
                    obj.insert(
                        "depth".to_string(),
                        Value::Number(Number::from(*depth)),
                    );
                }
                timeline.push(ev);
            }
        }
    }

    // ── Database messages (user / assistant) ──
    let sid_vec: Vec<&str> =
        all_sids.iter().map(std::string::String::as_str).collect();
    let db_msg_events = db::query_db_messages(&sid_vec, db_path);
    for mut ev in db_msg_events {
        if let Some(obj) = ev.as_object_mut() {
            let sid = obj
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let depth =
                session_depth_map.get(sid.as_str()).copied().unwrap_or(0);
            obj.insert("depth".to_string(), Value::Number(Number::from(depth)));
        }
        timeline.push(ev);
    }

    // ── Database tool calls (from part table) ──
    add_db_tool_call_events(
        &mut timeline,
        &sid_vec,
        &session_depth_map,
        db_path,
    );

    // Attach session_agent label for child events
    for ev in &mut timeline {
        if let Some(obj) = ev.as_object_mut() {
            let sid = obj
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(agent) = session_agents.get(&sid) {
                obj.insert(
                    "session_agent".to_string(),
                    Value::String(agent.clone()),
                );
            }
        }
    }

    // Sort by timestamp (missing timestamps last)
    timeline.sort_by(|a, b| {
        let ts_a = a.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let ts_b = b.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let src_a = a.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let src_b = b.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let type_a = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let type_b = b.get("type").and_then(|v| v.as_str()).unwrap_or("");

        ts_a.cmp(ts_b).then(src_a.cmp(src_b)).then(type_a.cmp(type_b))
    });

    Ok(timeline)
}

// ── sort_ops_by_session ───────────────────────────────────────────────────────

/// Sort ops: root events chronologically, child events grouped by session.
///
/// Root events appear at their own timestamp position.  Child events from
/// the same session form a contiguous block anchored at that session's
/// minimum timestamp, appearing right after any root event at that same
/// timestamp.
///
/// Each op is a dict with keys `"index"` (usize) and `"event"` (dict).
/// The event dict must contain `"depth"`, `"session_id"`, and `"timestamp"`
/// fields.
///
/// Returns a new sorted list.  Does NOT mutate the input.
#[must_use]
pub fn sort_ops_by_session(ops: &[Value]) -> Vec<Value> {
    // Collect timestamps per child session, then compute min
    let mut child_ts: HashMap<String, Vec<String>> = HashMap::new();

    for op in ops {
        if let Some(event) = op.get("event") {
            let depth = event.get("depth").and_then(Value::as_i64).unwrap_or(0);
            if depth > 0
                && let Some(sid) =
                    event.get("session_id").and_then(Value::as_str)
                && !sid.is_empty()
            {
                let ts = event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                child_ts.entry(sid.to_string()).or_default().push(ts);
            }
        }
    }

    let child_session_min_ts: HashMap<String, String> = child_ts
        .into_iter()
        .map(|(sid, ts_list)| {
            let min_ts = ts_list.into_iter().min().unwrap_or_default();
            (sid, min_ts)
        })
        .collect();

    let mut indexed_ops: Vec<(usize, &Value)> =
        ops.iter().enumerate().collect();

    indexed_ops.sort_by(|(idx_a, op_a), (idx_b, op_b)| {
        let event_a = op_a.get("event").and_then(|v| v.as_object());
        let event_b = op_b.get("event").and_then(|v| v.as_object());

        // Extract sort fields from event objects
        let extract =
            |event: Option<&Map<String, Value>>| -> (i64, String, String) {
                event.map_or_else(
                    || (0, String::new(), String::new()),
                    |obj| {
                        let depth = obj
                            .get("depth")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let ts = obj
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let sid = obj
                            .get("session_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        (depth, ts, sid)
                    },
                )
            };

        let (depth_a, ts_a, sid_a) = extract(event_a);
        let (depth_b, ts_b, sid_b) = extract(event_b);

        let group_key_a = if depth_a > 0 {
            child_session_min_ts
                .get(&sid_a)
                .cloned()
                .unwrap_or_else(|| ts_a.clone())
        } else {
            ts_a.clone()
        };

        let group_key_b = if depth_b > 0 {
            child_session_min_ts
                .get(&sid_b)
                .cloned()
                .unwrap_or_else(|| ts_b.clone())
        } else {
            ts_b.clone()
        };

        let depth_priority_a = i32::from(depth_a != 0);
        let depth_priority_b = i32::from(depth_b != 0);

        group_key_a
            .cmp(&group_key_b)
            .then(depth_priority_a.cmp(&depth_priority_b))
            .then(sid_a.cmp(&sid_b))
            .then(ts_a.cmp(&ts_b))
            .then(idx_a.cmp(idx_b))
    });

    indexed_ops.into_iter().map(|(_, op)| op.clone()).collect()
}

// ── mark_block_boundaries ─────────────────────────────────────────────────────

/// Block boundary maps: top events (depth + `session_id`) and bottom events (depth).
pub type BlockBoundaryMap =
    (HashMap<usize, Vec<(i64, String)>>, HashMap<usize, Vec<i64>>);

/// Pre-compute block start/end positions for child session box borders.
///
/// Each op must have `"event"` with `"depth"` and `"session_id"`.
///
/// Returns `(tops, bottoms)`:
/// - `tops`: top border BEFORE `ops[i]`, value is list of `(depth, session_id)`.
/// - `bottoms`: bottom border BEFORE `ops[i]` (or AFTER last event for
///   `index == len(ops)`), value is list of depths.
#[must_use]
pub fn mark_block_boundaries(ops: &[Value]) -> BlockBoundaryMap {
    let mut tops: HashMap<usize, Vec<(i64, String)>> = HashMap::new();
    let mut bottoms: HashMap<usize, Vec<i64>> = HashMap::new();
    // Stack of (depth, session_id)
    let mut stack: Vec<(i64, String)> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        let Some(event) = op.get("event").and_then(Value::as_object) else {
            continue;
        };
        let d = event.get("depth").and_then(Value::as_i64).unwrap_or(0);
        let s = event
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Close blocks whose depth >= current depth AND
        // (depth != current depth OR sid differs).
        // Skip closing when going deeper or continuing the same block.
        while let Some((top_depth, top_sid)) = stack.last() {
            if d > *top_depth {
                break; // going deeper — keep parent open
            }
            if d == *top_depth && s == *top_sid {
                break; // same block continuing
            }
            let closed_depth = stack.pop().unwrap().0;
            bottoms.entry(i).or_default().push(closed_depth);
        }

        // Open new block if depth > 0 and deeper than current deepest
        if d > 0 && (stack.is_empty() || d > stack.last().unwrap().0) {
            stack.push((d, s.clone()));
            tops.entry(i).or_default().push((d, s));
        }
    }

    // Close remaining open blocks at the end
    while let Some((closed_depth, _)) = stack.pop() {
        bottoms.entry(ops.len()).or_default().push(closed_depth);
    }

    (tops, bottoms)
}

// ── build_stats — helpers ────────────────────────────────────────────────────

/// Collect type and source distribution counts from the timeline.
fn collect_type_and_source_distributions(
    timeline: &[Value],
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut type_dist: HashMap<String, usize> = HashMap::new();
    let mut source_dist: HashMap<String, usize> = HashMap::new();

    for ev in timeline {
        let etype =
            ev.get("type").and_then(|v| v.as_str()).unwrap_or("?").to_string();
        let src = ev
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();

        *type_dist.entry(etype).or_insert(0) += 1;
        *source_dist.entry(src).or_insert(0) += 1;
    }

    (type_dist, source_dist)
}

/// Compute the time span (start / end / seconds) from timeline timestamps.
fn compute_stats_time_span(timeline: &[Value]) -> Option<Value> {
    let timestamps: Vec<&str> = timeline
        .iter()
        .filter_map(|ev| ev.get("timestamp").and_then(|v| v.as_str()))
        .filter(|ts| !ts.is_empty())
        .collect();

    if timestamps.len() < 2 {
        return None;
    }

    let first_ts = timestamps[0];
    let last_ts = timestamps[timestamps.len() - 1];

    let first_epoch_ms = iso_to_epoch_ms(first_ts);
    let last_epoch_ms = iso_to_epoch_ms(last_ts);

    if first_epoch_ms == 0 || last_epoch_ms == 0 {
        return None;
    }

    let seconds = (last_epoch_ms - first_epoch_ms) / 1000;
    let mut ts_map = Map::new();
    ts_map.insert("start".to_string(), Value::String(first_ts.to_string()));
    ts_map.insert("end".to_string(), Value::String(last_ts.to_string()));
    ts_map.insert("seconds".to_string(), Value::Number(Number::from(seconds)));
    Some(Value::Object(ts_map))
}

/// Build the tools breakdown map from type distribution.
fn build_tools_breakdown(type_dist: &HashMap<String, usize>) -> Value {
    let total = type_dist.get("tool_read").copied().unwrap_or(0)
        + type_dist.get("tool_write").copied().unwrap_or(0)
        + type_dist.get("tool_exec").copied().unwrap_or(0)
        + type_dist.get("tool_orch").copied().unwrap_or(0)
        + type_dist.get("tool_other").copied().unwrap_or(0);

    let mut tools_map = Map::new();
    tools_map
        .insert("total".to_string(), Value::Number(Number::from(total as u64)));
    tools_map.insert(
        "read".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_read").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "write".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_write").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "exec".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_exec").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "orch".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_orch").copied().unwrap_or(0) as u64,
        )),
    );
    tools_map.insert(
        "other".to_string(),
        Value::Number(Number::from(
            type_dist.get("tool_other").copied().unwrap_or(0) as u64,
        )),
    );
    Value::Object(tools_map)
}

/// Convert a `HashMap<String, usize>` to a JSON object Value (keys → u64).
fn dist_map_to_value(dist: &HashMap<String, usize>) -> Value {
    let mut m = Map::new();
    for (k, v) in dist {
        m.insert(k.clone(), Value::Number(Number::from(*v as u64)));
    }
    Value::Object(m)
}

// ── build_stats ───────────────────────────────────────────────────────────────

/// Extract statistics from a timeline.
///
/// # Arguments
///
/// * `timeline` — List of unified event dicts from `build_timeline()`.
/// * `child_sessions` — Optional list of child session info dicts
///   (each with keys `"session_id"`, `"depth"`, `"agent"`, `"event_count"`)
///   to include in the returned stats.
///
/// # Returns
///
/// Dict with fields:
/// - `total_events`, `total_turns`, `llm_calls`, `tool_calls`,
///   `permission_checks`, `zoo_interventions`, `session_events`,
///   `file_events`, `type_distribution`, `source_distribution`,
///   `time_span`, `tools` (breakdown)
#[must_use]
pub fn build_stats(
    timeline: &[Value],
    child_sessions: Option<&[Value]>,
) -> Value {
    let total = timeline.len();

    let (type_dist, source_dist) =
        collect_type_and_source_distributions(timeline);

    let time_span = compute_stats_time_span(timeline);

    let llm_calls = type_dist.get("llm").copied().unwrap_or(0)
        + type_dist.get("llm_stream").copied().unwrap_or(0);

    let tool_calls = type_dist.get("tool_read").copied().unwrap_or(0)
        + type_dist.get("tool_write").copied().unwrap_or(0)
        + type_dist.get("tool_exec").copied().unwrap_or(0)
        + type_dist.get("tool_orch").copied().unwrap_or(0)
        + type_dist.get("tool_other").copied().unwrap_or(0);

    let type_dist_val: Value = dist_map_to_value(&type_dist);
    let source_dist_val: Value = dist_map_to_value(&source_dist);

    let mut result = Map::new();
    result.insert(
        "total_events".to_string(),
        Value::Number(Number::from(total as u64)),
    );
    result.insert(
        "total_turns".to_string(),
        Value::Number(Number::from(
            timeline
                .iter()
                .filter(|ev| {
                    ev.get("source").and_then(|v| v.as_str())
                        == Some("opencode")
                        && ev.get("type").and_then(|v| v.as_str())
                            == Some("session")
                })
                .count() as u64,
        )),
    );
    result.insert(
        "llm_calls".to_string(),
        Value::Number(Number::from(llm_calls as u64)),
    );
    result.insert(
        "tool_calls".to_string(),
        Value::Number(Number::from(tool_calls as u64)),
    );
    result.insert(
        "permission_checks".to_string(),
        Value::Number(Number::from(
            type_dist.get("permission").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "zoo_interventions".to_string(),
        Value::Number(Number::from(
            source_dist.get("zoo").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "session_events".to_string(),
        Value::Number(Number::from(
            type_dist.get("session").copied().unwrap_or(0) as u64,
        )),
    );
    result.insert(
        "file_events".to_string(),
        Value::Number(Number::from(
            type_dist.get("file").copied().unwrap_or(0) as u64,
        )),
    );

    result.insert("type_distribution".to_string(), type_dist_val);
    result.insert("source_distribution".to_string(), source_dist_val);

    if let Some(ts) = time_span {
        result.insert("time_span".to_string(), ts);
    } else {
        result.insert("time_span".to_string(), Value::Null);
    }

    let tools_map = build_tools_breakdown(&type_dist);
    result.insert("tools".to_string(), tools_map);

    if let Some(children) = child_sessions {
        let child_vec: Vec<Value> = children.to_vec();
        let total_child_events: usize = children
            .iter()
            .filter_map(|cs| {
                cs.get("event_count")
                    .and_then(Value::as_u64)
                    .and_then(|v| usize::try_from(v).ok())
            })
            .sum();

        result.insert("child_sessions".to_string(), Value::Array(child_vec));
        result.insert(
            "total_child_sessions".to_string(),
            Value::Number(Number::from(children.len() as u64)),
        );
        result.insert(
            "total_child_events".to_string(),
            Value::Number(Number::from(total_child_events as u64)),
        );
    }

    Value::Object(result)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_opencode tests ────────────────────────────────────────────

    #[test]
    fn test_classify_opencode_created() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "created".to_string());
        entry.insert(
            "timestamp".to_string(),
            "2025-01-09T12:34:56Z".to_string(),
        );
        entry.insert("id".to_string(), "ses-001".to_string());
        entry.insert("slug".to_string(), "my-session".to_string());
        entry.insert("agent".to_string(), "general".to_string());
        entry.insert("model_id".to_string(), "gpt-4".to_string());
        entry.insert("title".to_string(), "Debug auth".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "session");
        assert_eq!(ev["source"].as_str().unwrap(), "opencode");
        assert_eq!(ev["icon"].as_str().unwrap(), "◆");
        assert_eq!(ev["timestamp"].as_str().unwrap(), "2025-01-09T12:34:56Z");
        assert!(ev["summary"].as_str().unwrap().contains("my-session"));

        let detail = ev["detail"].as_object().unwrap();
        assert_eq!(detail["id"].as_str().unwrap(), "ses-001");
        assert_eq!(detail["slug"].as_str().unwrap(), "my-session");
        assert_eq!(detail["agent"].as_str().unwrap(), "general");
        assert_eq!(detail["model_id"].as_str().unwrap(), "gpt-4");
    }

    #[test]
    fn test_classify_opencode_loop() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "loop".to_string());
        entry.insert(
            "timestamp".to_string(),
            "2025-01-09T12:34:56Z".to_string(),
        );
        entry.insert("step".to_string(), "3".to_string());
        entry.insert("session_id".to_string(), "ses-001".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "session");
        assert_eq!(ev["summary"].as_str().unwrap(), "Loop step=3");

        let detail = ev["detail"].as_object().unwrap();
        assert_eq!(detail["step"].as_str().unwrap(), "3");
        assert_eq!(detail["session_id"].as_str().unwrap(), "ses-001");
    }

    #[test]
    fn test_classify_opencode_process() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "process".to_string());
        entry.insert("messageID".to_string(), "msg-001".to_string());
        entry.insert("session_id".to_string(), "ses-001".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "session");
        assert_eq!(ev["icon"].as_str().unwrap(), "💬");
        assert_eq!(ev["summary"].as_str().unwrap(), "Process message");
    }

    #[test]
    fn test_classify_opencode_exiting_loop() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "exiting loop".to_string());
        entry.insert("session_id".to_string(), "ses-001".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["summary"].as_str().unwrap(), "Exiting loop");
    }

    #[test]
    fn test_classify_opencode_llm_runtime() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "llm runtime selected".to_string());
        entry.insert("llm_provider".to_string(), "openai".to_string());
        entry.insert("llm_model".to_string(), "gpt-4".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "llm");
        assert_eq!(ev["icon"].as_str().unwrap(), "▲");
        assert_eq!(ev["summary"].as_str().unwrap(), "LLM openai/gpt-4");
    }

    #[test]
    fn test_classify_opencode_stream() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "stream".to_string());
        entry.insert("providerID".to_string(), "openai".to_string());
        entry.insert("modelID".to_string(), "gpt-4".to_string());
        entry.insert("agent".to_string(), "general".to_string());
        entry.insert("mode".to_string(), "chat".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "llm_stream");
        assert!(
            ev["summary"].as_str().unwrap().contains("Stream openai/gpt-4")
        );
    }

    #[test]
    fn test_classify_opencode_evaluated_deny() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "evaluated".to_string());
        entry.insert("permission".to_string(), "bash".to_string());
        entry.insert("pattern".to_string(), "rm -rf /".to_string());
        entry.insert("action_action".to_string(), "deny".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "permission");
        assert_eq!(ev["icon"].as_str().unwrap(), "▼");
        assert!(ev["summary"].as_str().unwrap().contains("permission=deny"));
    }

    #[test]
    fn test_classify_opencode_evaluated_allow() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "evaluated".to_string());
        entry.insert("permission".to_string(), "read".to_string());
        entry.insert("pattern".to_string(), "src/main.rs".to_string());
        entry.insert("action_action".to_string(), "allow".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "tool_read");
        assert_eq!(ev["icon"].as_str().unwrap(), "▶");
        assert_eq!(ev["summary"].as_str().unwrap(), "read: src/main.rs");
    }

    #[test]
    fn test_classify_opencode_evaluated_with_duration() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "evaluated".to_string());
        entry.insert("permission".to_string(), "read".to_string());
        entry.insert("pattern".to_string(), "src/main.rs".to_string());
        entry.insert("action_action".to_string(), "allow".to_string());
        entry.insert("duration".to_string(), "1.5".to_string());

        let ev = classify_opencode(&entry);
        let detail = ev["detail"].as_object().unwrap();
        assert!((detail["duration_sec"].as_f64().unwrap() - 1.5).abs() < 0.001);
    }

    #[test]
    fn test_classify_opencode_touching_file() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "touching file".to_string());
        entry.insert("file".to_string(), "src/main.rs".to_string());
        entry.insert("action".to_string(), "edit".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "file");
        assert_eq!(ev["icon"].as_str().unwrap(), "■");
        assert_eq!(ev["summary"].as_str().unwrap(), "edit: src/main.rs");
    }

    #[test]
    fn test_classify_opencode_fallback() {
        let mut entry = HashMap::new();
        entry.insert("message".to_string(), "unknown".to_string());
        entry.insert("some_key".to_string(), "some_value".to_string());

        let ev = classify_opencode(&entry);
        assert_eq!(ev["type"].as_str().unwrap(), "hook");
        assert_eq!(ev["icon"].as_str().unwrap(), "◈");
        assert_eq!(ev["summary"].as_str().unwrap(), "opencode: unknown");
    }

    // ── classify_zoo tests ─────────────────────────────────────────────────

    #[test]
    fn test_classify_zoo_basic() {
        let mut entry = Map::new();
        entry.insert("hook".to_string(), Value::String("tool".to_string()));
        entry.insert(
            "event".to_string(),
            Value::String("bash_exec".to_string()),
        );
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(ev["source"].as_str().unwrap(), "zoo");
        assert_eq!(ev["type"].as_str().unwrap(), "hook");
        assert_eq!(ev["icon"].as_str().unwrap(), "◈");
        assert_eq!(ev["level"].as_str().unwrap(), "info");
        assert_eq!(ev["summary"].as_str().unwrap(), "tool/bash_exec");
    }

    #[test]
    fn test_classify_zoo_context_metrics() {
        let mut entry = Map::new();
        entry.insert(
            "hook".to_string(),
            Value::String("context-metrics".to_string()),
        );
        entry.insert(
            "event".to_string(),
            Value::String("context_measured".to_string()),
        );
        entry.insert(
            "estimated_tokens".to_string(),
            Value::Number(Number::from(1_500_u64)),
        );
        entry.insert(
            "message_count".to_string(),
            Value::Number(Number::from(5_u64)),
        );
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(
            ev["summary"].as_str().unwrap(),
            "context: 1,500 tokens (5 msgs)"
        );
    }

    #[test]
    fn test_classify_zoo_context_metrics_with_agent() {
        let mut entry = Map::new();
        entry.insert(
            "hook".to_string(),
            Value::String("context-metrics".to_string()),
        );
        entry.insert(
            "event".to_string(),
            Value::String("context_measured".to_string()),
        );
        entry.insert(
            "estimated_tokens".to_string(),
            Value::Number(Number::from(2_500_u64)),
        );
        entry.insert(
            "message_count".to_string(),
            Value::Number(Number::from(10_u64)),
        );
        entry.insert("agent".to_string(), Value::String("general".to_string()));
        entry.insert("level".to_string(), Value::String("info".to_string()));
        entry.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        let entry = Value::Object(entry);

        let ev = classify_zoo(&entry);
        assert_eq!(
            ev["summary"].as_str().unwrap(),
            "context [general]: 2,500 tokens (10 msgs)"
        );
    }

    // ── parse_opencode_all tests ───────────────────────────────────────────

    #[test]
    fn test_parse_opencode_all_file_not_found() {
        let result =
            parse_opencode_all("/tmp/nonexistent-opencode-test-xxxxx.log");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_opencode_all_from_temp_file() {
        let tmp = std::env::temp_dir().join("ztrace-test-parse-all.jsonl");
        let content = r#"message="created" id=ses-001 slug=test
message="loop" step=1
garbage_line
message="stream" providerID=openai"#;
        std::fs::write(&tmp, content).unwrap();

        let result = parse_opencode_all(tmp.to_str().unwrap());
        assert_eq!(result.len(), 3); // 3 valid lines, 1 skipped
        assert_eq!(result[0].get("message").unwrap(), "created");
        assert_eq!(result[1].get("message").unwrap(), "loop");
        assert_eq!(result[2].get("message").unwrap(), "stream");
        let _ = std::fs::remove_file(&tmp);
    }

    // ── discover_child_sessions_from_entries tests ─────────────────────────

    #[test]
    fn test_discover_child_sessions_no_children() {
        let entries = vec![];
        let result = discover_child_sessions_from_entries(&entries, "ses-001");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], ("ses-001".to_string(), 0));
    }

    #[test]
    fn test_discover_child_sessions_with_children() {
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "created".to_string());
        e1.insert("id".to_string(), "ses-001".to_string());

        let mut e2 = HashMap::new();
        e2.insert("message".to_string(), "created".to_string());
        e2.insert("id".to_string(), "ses-002".to_string());
        e2.insert("parentID".to_string(), "ses-001".to_string());

        let mut e3 = HashMap::new();
        e3.insert("message".to_string(), "created".to_string());
        e3.insert("id".to_string(), "ses-003".to_string());
        e3.insert("parent_id".to_string(), "ses-002".to_string());

        let entries = vec![e1, e2, e3];
        let result = discover_child_sessions_from_entries(&entries, "ses-001");

        // Result: root + 2 children in BFS order
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], ("ses-001".to_string(), 0));
        // ses-002 is child of root (depth 1)
        assert!(result.contains(&("ses-002".to_string(), 1)));
        // ses-003 is grandchild (depth 2)
        assert!(result.contains(&("ses-003".to_string(), 2)));
    }

    #[test]
    fn test_discover_child_sessions_skips_undefined_parent() {
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "created".to_string());
        e1.insert("id".to_string(), "ses-001".to_string());
        e1.insert("parentID".to_string(), "undefined".to_string());

        let entries = vec![e1];
        let result = discover_child_sessions_from_entries(&entries, "ses-001");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_discover_child_sessions_circular_ref_protection() {
        // ses-001 is parent of ses-002, ses-002 is parent of ses-001 (circular)
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "created".to_string());
        e1.insert("id".to_string(), "ses-001".to_string());
        e1.insert("parentID".to_string(), "ses-002".to_string());

        let mut e2 = HashMap::new();
        e2.insert("message".to_string(), "created".to_string());
        e2.insert("id".to_string(), "ses-002".to_string());
        e2.insert("parentID".to_string(), "ses-001".to_string());

        let entries = vec![e1, e2];
        let result = discover_child_sessions_from_entries(&entries, "ses-001");
        // BFS from ses-001 discovers ses-002 (child via parentID), then
        // ses-002's children include ses-001 which is already visited.
        // Both sessions are found with no infinite loop.
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], ("ses-001".to_string(), 0));
        assert!(result.contains(&("ses-002".to_string(), 1)));
    }

    // ── build_session_agents tests ─────────────────────────────────────────

    #[test]
    fn test_build_session_agents_basic() {
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "created".to_string());
        e1.insert("id".to_string(), "ses-001".to_string());
        e1.insert("agent".to_string(), "general".to_string());

        let mut e2 = HashMap::new();
        e2.insert("message".to_string(), "created".to_string());
        e2.insert("id".to_string(), "ses-002".to_string());
        e2.insert("slug".to_string(), "explore".to_string());

        let entries = vec![e1, e2];
        let mut sids = HashSet::new();
        sids.insert("ses-001");
        sids.insert("ses-002");

        let agents = build_session_agents(&entries, &sids);
        assert_eq!(agents.get("ses-001").unwrap(), "general");
        assert_eq!(agents.get("ses-002").unwrap(), "explore");
    }

    #[test]
    fn test_build_session_agents_agent_preferred_over_slug() {
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "created".to_string());
        e1.insert("id".to_string(), "ses-001".to_string());
        e1.insert("agent".to_string(), "general".to_string());
        e1.insert("slug".to_string(), "my-slug".to_string());

        let entries = vec![e1];
        let mut sids = HashSet::new();
        sids.insert("ses-001");

        let agents = build_session_agents(&entries, &sids);
        assert_eq!(agents.get("ses-001").unwrap(), "general");
    }

    // ── resolve_and_group_entries tests ────────────────────────────────────

    #[test]
    fn test_resolve_and_group_entries_empty_sids() {
        let entries = vec![];
        let sids = HashSet::new();
        let result = resolve_and_group_entries(&entries, &sids);
        assert!(result.is_empty());
    }

    #[test]
    fn test_resolve_and_group_entries_by_session_id() {
        let mut e1 = HashMap::new();
        e1.insert("message".to_string(), "loop".to_string());
        e1.insert("session_id".to_string(), "ses-001".to_string());

        let mut e2 = HashMap::new();
        e2.insert("message".to_string(), "loop".to_string());
        e2.insert("session_id".to_string(), "ses-002".to_string());

        let entries = vec![e1.clone(), e2.clone()];
        let mut sids = HashSet::new();
        sids.insert("ses-001");
        sids.insert("ses-002");

        let result = resolve_and_group_entries(&entries, &sids);
        assert_eq!(result.get("ses-001").unwrap().len(), 1);
        assert_eq!(result.get("ses-002").unwrap().len(), 1);
    }

    #[test]
    fn test_resolve_and_group_entries_by_run_mapping() {
        // Entry with run but no session_id should map via run→session mapping
        let mut created = HashMap::new();
        created.insert("message".to_string(), "created".to_string());
        created.insert("id".to_string(), "ses-001".to_string());
        created.insert("run".to_string(), "run-01".to_string());

        let mut evaluated = HashMap::new();
        evaluated.insert("message".to_string(), "evaluated".to_string());
        evaluated.insert("run".to_string(), "run-01".to_string());
        evaluated.insert("permission".to_string(), "read".to_string());

        let entries = vec![created, evaluated];
        let mut sids = HashSet::new();
        sids.insert("ses-001");

        let result = resolve_and_group_entries(&entries, &sids);
        assert_eq!(result.get("ses-001").unwrap().len(), 2);
    }

    // ── sort_ops_by_session tests ─────────────────────────────────────────

    #[test]
    fn test_sort_ops_by_session_root_only() {
        let mut ev1 = Map::new();
        ev1.insert("depth".to_string(), Value::Number(Number::from(0)));
        ev1.insert(
            "session_id".to_string(),
            Value::String("ses-001".to_string()),
        );
        ev1.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );

        let mut ev2 = Map::new();
        ev2.insert("depth".to_string(), Value::Number(Number::from(0)));
        ev2.insert(
            "session_id".to_string(),
            Value::String("ses-001".to_string()),
        );
        ev2.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:57Z".to_string()),
        );

        let op1 = Value::Object({
            let mut m = Map::new();
            m.insert("index".to_string(), Value::Number(Number::from(0)));
            m.insert("event".to_string(), Value::Object(ev1));
            m
        });
        let op2 = Value::Object({
            let mut m = Map::new();
            m.insert("index".to_string(), Value::Number(Number::from(1)));
            m.insert("event".to_string(), Value::Object(ev2));
            m
        });

        let ops = vec![op2, op1]; // intentionally reversed
        let sorted = sort_ops_by_session(&ops);
        assert_eq!(sorted.len(), 2);
        // Should be sorted by timestamp
        assert_eq!(
            sorted[0]["event"]["timestamp"].as_str().unwrap(),
            "2025-01-09T12:34:56Z"
        );
    }

    // ── mark_block_boundaries tests ────────────────────────────────────────

    #[test]
    fn test_mark_block_boundaries_single_child_block() {
        let mut event = Map::new();
        event.insert("depth".to_string(), Value::Number(Number::from(1)));
        event.insert(
            "session_id".to_string(),
            Value::String("ses-child".to_string()),
        );

        let op = Value::Object({
            let mut m = Map::new();
            m.insert("event".to_string(), Value::Object(event));
            m
        });

        let (tops, bottoms) = mark_block_boundaries(&[op]);
        // Should have a top at index 0 and a bottom at index 1 (end)
        assert!(tops.contains_key(&0));
        assert!(bottoms.contains_key(&1));
    }

    // ── build_stats tests ─────────────────────────────────────────────────

    #[test]
    fn test_build_stats_empty() {
        let timeline = vec![];
        let stats = build_stats(&timeline, None);
        assert_eq!(stats["total_events"].as_u64().unwrap(), 0);
        assert!(stats["time_span"].is_null());
    }

    #[test]
    fn test_build_stats_basic() {
        let mut ev1 = Map::new();
        ev1.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        ev1.insert("source".to_string(), Value::String("opencode".to_string()));
        ev1.insert("type".to_string(), Value::String("session".to_string()));

        let mut ev2 = Map::new();
        ev2.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:35:00Z".to_string()),
        );
        ev2.insert("source".to_string(), Value::String("opencode".to_string()));
        ev2.insert("type".to_string(), Value::String("tool_read".to_string()));

        let timeline = vec![Value::Object(ev1), Value::Object(ev2)];
        let stats = build_stats(&timeline, None);

        assert_eq!(stats["total_events"].as_u64().unwrap(), 2);
        assert_eq!(stats["total_turns"].as_u64().unwrap(), 1);
        assert_eq!(stats["tool_calls"].as_u64().unwrap(), 1);
        assert_eq!(stats["tools"]["read"].as_u64().unwrap(), 1);

        let time_span = stats["time_span"].as_object().unwrap();
        assert_eq!(time_span["seconds"].as_i64().unwrap(), 4);
    }

    #[test]
    fn test_build_stats_with_child_sessions() {
        let timeline = vec![];
        let child = Value::Object({
            let mut m = Map::new();
            m.insert(
                "session_id".to_string(),
                Value::String("child-001".to_string()),
            );
            m.insert("event_count".to_string(), Value::Number(Number::from(5)));
            m
        });
        let children = vec![child];

        let stats = build_stats(&timeline, Some(&children));
        assert_eq!(stats["total_child_sessions"].as_u64().unwrap(), 1);
        assert_eq!(stats["total_child_events"].as_u64().unwrap(), 5);
    }
}
