// Database query functions for the ztrace tool.
//
// Uses `serde_json::Value` for flexible dict construction and `zutil::db_helpers::open_db`
// for read-only SQLite access.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use zutil::db_helpers::open_db;
use zutil::{epoch_ms_to_iso, safe_json_loads};

use crate::parser::tool_type_and_icon;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Extract the primary input field from a tool's state for summary display.
///
/// Priority: `filePath` > `pattern` > `command` (first 50 chars) >
/// `description` > first non-empty value > `""`.
fn primary_tool_input(state: &Value) -> String {
    let Some(inp) = state.get("input").and_then(|v| v.as_object()) else {
        return String::new();
    };

    // filePath
    if let Some(fp) = inp.get("filePath").and_then(|v| v.as_str())
        && !fp.is_empty()
    {
        return fp.to_string();
    }
    // pattern
    if let Some(pattern) = inp.get("pattern").and_then(|v| v.as_str())
        && !pattern.is_empty()
    {
        return pattern.to_string();
    }
    // command (first 50 chars)
    if let Some(cmd) = inp.get("command").and_then(|v| v.as_str())
        && !cmd.is_empty()
    {
        return cmd.chars().take(50).collect();
    }
    // description
    if let Some(desc) = inp.get("description").and_then(|v| v.as_str())
        && !desc.is_empty()
    {
        return desc.to_string();
    }
    // first non-empty value
    for val in inp.values() {
        if let Some(s) = val.as_str()
            && !s.trim().is_empty()
        {
            return s.to_string();
        }
    }
    String::new()
}

/// Truncate text with ellipsis if it exceeds `max_len` characters.
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.chars().count() > max_len {
        let truncated: String = text.chars().take(max_len).collect();
        format!("{truncated}...")
    } else {
        text.to_string()
    }
}

// ── Internal query helpers ────────────────────────────────────────────────────
//
// Structs and functions extracted from long functions to avoid `too_many_lines`
// clippy warnings.

#[derive(Clone)]
struct StepRow {
    message_id: String,
    session_id: String,
    time_created: Option<i64>,
    time_updated: Option<i64>,
    data: Value,
}

#[derive(Clone)]
struct ToolRow {
    message_id: String,
    session_id: String,
    data: Value,
}

#[derive(Clone)]
struct JoinRow {
    msg_id: String,
    msg_time: Option<i64>,
    msg_data: Value,
    session_id: String,
    part_data: Value,
}

/// Build placeholders string for IN clause.
fn build_placeholders(count: usize) -> String {
    (0..count).map(|_| "?").collect::<Vec<_>>().join(",")
}

/// Build rusqlite params from owned strings.
fn make_params(items: &[String]) -> Vec<Box<dyn rusqlite::types::ToSql>> {
    items
        .iter()
        .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::types::ToSql>)
        .collect()
}

/// Convenience to convert params to refs slice.
fn params_as_refs(
    params: &[Box<dyn rusqlite::types::ToSql>],
) -> Vec<&dyn rusqlite::types::ToSql> {
    params.iter().map(std::convert::AsRef::as_ref).collect()
}

/// Query step-finish parts for the given session IDs.
fn query_step_finish_parts(
    conn: &rusqlite::Connection,
    owned_ids: &[String],
) -> Vec<StepRow> {
    let placeholders = build_placeholders(owned_ids.len());
    let sql = format!(
        "SELECT id, message_id, session_id, time_created, time_updated, data \
         FROM part \
         WHERE session_id IN ({placeholders}) \
         AND json_extract(data, '$.type') = 'step-finish' \
         ORDER BY session_id, time_created ASC"
    );
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");
    let params = make_params(owned_ids);
    let refs = params_as_refs(&params);
    stmt.query_map(refs.as_slice(), |row| {
        let _: String = row.get("id")?;
        let message_id: String = row.get("message_id")?;
        let session_id: String = row.get("session_id")?;
        let tc: Option<i64> = row.get("time_created")?;
        let tu: Option<i64> = row.get("time_updated")?;
        let data_str: String = row.get("data")?;
        Ok(StepRow {
            message_id,
            session_id,
            time_created: tc,
            time_updated: tu,
            data: safe_json_loads(&data_str).unwrap_or(Value::Null),
        })
    })
    .expect("SQL query failed")
    .filter_map(std::result::Result::ok)
    .collect()
}

/// Query tool parts for the given session IDs.
fn query_tool_parts(
    conn: &rusqlite::Connection,
    owned_ids: &[String],
) -> Vec<ToolRow> {
    let placeholders = build_placeholders(owned_ids.len());
    let sql = format!(
        "SELECT id, message_id, session_id, time_created, data \
         FROM part \
         WHERE session_id IN ({placeholders}) \
         AND json_extract(data, '$.type') = 'tool' \
         ORDER BY session_id, time_created ASC"
    );
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");
    let params = make_params(owned_ids);
    let refs = params_as_refs(&params);
    stmt.query_map(refs.as_slice(), |row| {
        let _id: String = row.get("id")?;
        let message_id: String = row.get("message_id")?;
        let session_id: String = row.get("session_id")?;
        let data_str: String = row.get("data")?;
        Ok(ToolRow {
            message_id,
            session_id,
            data: safe_json_loads(&data_str).unwrap_or(Value::Null),
        })
    })
    .expect("SQL query failed")
    .filter_map(std::result::Result::ok)
    .collect()
}

/// Build a tool lookup map from tool rows, keyed by `session_id:message_id`.
fn build_tool_lookup(tool_rows: &[ToolRow]) -> HashMap<String, Vec<String>> {
    let mut tools_by_msg: HashMap<String, Vec<String>> = HashMap::new();
    for trow in tool_rows {
        if let Some(tool_name) = trow
            .data
            .get("tool")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            let key = format!("{}:{}", trow.session_id, trow.message_id);
            tools_by_msg.entry(key).or_default().push(tool_name.to_string());
        }
    }
    tools_by_msg
}

/// Query message time info (created, completed) for a set of message IDs.
fn query_message_times(
    conn: &rusqlite::Connection,
    msg_ids: &[String],
) -> HashMap<String, (Option<i64>, Option<i64>)> {
    let mut msg_time_map: HashMap<String, (Option<i64>, Option<i64>)> =
        HashMap::new();
    if msg_ids.is_empty() {
        return msg_time_map;
    }
    let placeholders = build_placeholders(msg_ids.len());
    let sql =
        format!("SELECT id, data FROM message WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");
    let params = make_params(msg_ids);
    let refs = params_as_refs(&params);
    let msg_rows = stmt
        .query_map(refs.as_slice(), |row| {
            let id: String = row.get("id")?;
            let data_str: String = row.get("data")?;
            Ok((id, safe_json_loads(&data_str).unwrap_or(Value::Null)))
        })
        .expect("SQL query failed");
    for msg_row in msg_rows.flatten() {
        let time_info = msg_row.1.get("time");
        let created =
            time_info.and_then(|t| t.get("created")).and_then(Value::as_i64);
        let completed =
            time_info.and_then(|t| t.get("completed")).and_then(Value::as_i64);
        msg_time_map.insert(msg_row.0, (created, completed));
    }
    msg_time_map
}

/// Build a single step entry from a step row.
fn build_step_entry(
    srow: &StepRow,
    sid_str: &str,
    step_index: usize,
    tools: Vec<Value>,
    msg_time_created: Option<Value>,
    msg_time_completed: Option<Value>,
) -> Value {
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

    let mut step = Map::new();
    step.insert(
        "step_index".to_string(),
        Value::Number(Number::from(step_index as u64)),
    );
    step.insert("session_id".to_string(), Value::String(sid_str.to_string()));
    step.insert(
        "message_id".to_string(),
        Value::String(srow.message_id.clone()),
    );
    step.insert("time_created".to_string(), Value::String(ts_created));
    step.insert("time_updated".to_string(), Value::String(ts_updated));
    step.insert(
        "cache_read".to_string(),
        Number::from_f64(cache_read).map_or(Value::Null, Value::Number),
    );
    step.insert(
        "cache_write".to_string(),
        Number::from_f64(cache_write).map_or(Value::Null, Value::Number),
    );
    step.insert(
        "input_tokens".to_string(),
        Number::from_f64(input_tokens).map_or(Value::Null, Value::Number),
    );
    step.insert(
        "output_tokens".to_string(),
        Number::from_f64(output_tokens).map_or(Value::Null, Value::Number),
    );
    step.insert(
        "reasoning_tokens".to_string(),
        Number::from_f64(reasoning_tokens).map_or(Value::Null, Value::Number),
    );
    step.insert(
        "cost".to_string(),
        Number::from_f64(cost).map_or(Value::Null, Value::Number),
    );
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

/// Build the final result list from all fetched data.
fn build_step_results(
    session_ids: &[&str],
    step_rows: &[StepRow],
    tools_by_msg: &HashMap<String, Vec<String>>,
    msg_time_map: &HashMap<String, (Option<i64>, Option<i64>)>,
) -> Vec<Value> {
    let mut steps_by_sid: HashMap<String, Vec<&StepRow>> = HashMap::new();
    for srow in step_rows {
        steps_by_sid.entry(srow.session_id.clone()).or_default().push(srow);
    }

    let mut results: Vec<Value> = Vec::new();
    for sid in session_ids {
        let sid_str = sid.to_string();
        let session_steps = steps_by_sid.get(&sid_str);
        let Some(session_steps) = session_steps else {
            continue;
        };

        for (idx, srow) in session_steps.iter().enumerate() {
            let step_index = idx + 1;
            let tool_key = format!("{sid_str}:{}", srow.message_id);
            let tools: Vec<Value> = tools_by_msg
                .get(&tool_key)
                .map(|v| v.iter().map(|s| Value::String(s.clone())).collect())
                .unwrap_or_default();

            let msg_times = msg_time_map.get(&srow.message_id);
            let msg_time_created = msg_times
                .and_then(|(c, _)| *c)
                .map(|ts| Value::Number(Number::from(ts)));
            let msg_time_completed = msg_times
                .and_then(|(_, c)| *c)
                .map(|ts| Value::Number(Number::from(ts)));

            results.push(build_step_entry(
                srow,
                &sid_str,
                step_index,
                tools,
                msg_time_created,
                msg_time_completed,
            ));
        }
    }

    results
}

/// Query joined message+part rows for the given session IDs.
fn query_join_rows(
    conn: &rusqlite::Connection,
    owned_ids: &[String],
) -> Vec<JoinRow> {
    let placeholders = build_placeholders(owned_ids.len());
    let sql = format!(
        "SELECT m.id AS msg_id, m.time_created AS msg_time, \
         m.data AS msg_data, m.session_id, \
         p.data AS part_data \
         FROM message m \
         JOIN part p ON p.message_id = m.id \
         WHERE m.session_id IN ({placeholders}) \
         ORDER BY m.session_id, m.time_created ASC, p.time_created ASC"
    );
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");
    let params = make_params(owned_ids);
    let refs = params_as_refs(&params);
    stmt.query_map(refs.as_slice(), |row| {
        let msg_id: String = row.get("msg_id")?;
        let msg_time: Option<i64> = row.get("msg_time")?;
        let msg_data_str: String = row.get("msg_data")?;
        let session_id: String = row.get("session_id")?;
        let part_data_str: String = row.get("part_data")?;
        Ok(JoinRow {
            msg_id,
            msg_time,
            msg_data: safe_json_loads(&msg_data_str).unwrap_or(Value::Null),
            session_id,
            part_data: safe_json_loads(&part_data_str).unwrap_or(Value::Null),
        })
    })
    .expect("SQL query failed")
    .filter_map(std::result::Result::ok)
    .collect()
}

/// Compute duration in seconds from two i64 millisecond timestamps.
///
/// Uses i32 intermediate arithmetic — the result is exact for any
/// duration up to 2^31 ms (~24 days), which covers all practical
/// tool-call durations.
fn duration_sec_from_ms(start_ms: i64, end_ms: i64) -> f64 {
    let diff_ms = end_ms - start_ms;
    // Split into whole seconds and fractional milliseconds; both fit in i32
    // for any realistic tool-call duration (seconds to hours).
    let secs: i32 = (diff_ms / 1000).try_into().unwrap_or(0);
    let millis: i32 = (diff_ms % 1000).try_into().unwrap_or(0);
    f64::from(secs) + f64::from(millis) / 1000.0
}

// ── Public Functions ─────────────────────────────────────────────────────────

/// Query step-finish parts for multiple sessions in one batch.
///
/// Returns steps sorted by `time_created` ascending. Within each session
/// the `step_index` is 1-based, resetting per session.
///
/// Each returned dict has keys:
/// `step_index`, `session_id`, `message_id`, `time_created` (ISO),
/// `time_updated` (ISO), `cache_read`, `cache_write`, `input_tokens`,
/// `output_tokens`, `reasoning_tokens`, `cost`, `reason`, `tools`,
/// `msg_time_created` (epoch ms or null), `msg_time_completed`.
pub fn query_step_data_batch(
    session_ids: &[&str],
    db_path: &str,
) -> Vec<Value> {
    if session_ids.is_empty() {
        return vec![];
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    let owned_ids: Vec<String> =
        session_ids.iter().map(std::string::ToString::to_string).collect();

    let step_rows = query_step_finish_parts(&conn, &owned_ids);
    let tool_rows = query_tool_parts(&conn, &owned_ids);

    let tools_by_msg = build_tool_lookup(&tool_rows);

    // Fetch message data for step-finish message_ids
    let msg_ids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        step_rows
            .iter()
            .filter(|s| seen.insert(s.message_id.clone()))
            .map(|s| s.message_id.clone())
            .collect()
    };
    let msg_time_map = query_message_times(&conn, &msg_ids);

    build_step_results(session_ids, &step_rows, &tools_by_msg, &msg_time_map)
}

/// Extract tool execution durations for multiple sessions in one query.
///
/// **Bugfix**: Each returned dict includes the `session_id` field.
///
/// Only rows with both `state.time.start` and `state.time.end` are included.
pub fn query_tool_durations_batch(
    session_ids: &[&str],
    db_path: &str,
) -> Vec<Value> {
    if session_ids.is_empty() {
        return vec![];
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    let owned_ids: Vec<String> =
        session_ids.iter().map(std::string::ToString::to_string).collect();
    let placeholders: String =
        owned_ids.iter().map(|_| "?".to_string()).collect::<Vec<_>>().join(",");

    let sql = format!(
        "SELECT session_id, data FROM part \
         WHERE session_id IN ({placeholders}) \
         AND json_extract(data, '$.type') = 'tool' \
         ORDER BY time_created ASC"
    );
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");

    let params: Vec<Box<dyn rusqlite::types::ToSql>> = owned_ids
        .iter()
        .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();

    let rows: Vec<(String, Value)> = stmt
        .query_map(param_refs.as_slice(), |row| {
            let sid: String = row.get("session_id")?;
            let data_str: String = row.get("data")?;
            Ok((sid, safe_json_loads(&data_str).unwrap_or(Value::Null)))
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    let mut results: Vec<Value> = Vec::new();
    for (session_id, data) in &rows {
        let tool_name = match data.get("tool").and_then(|v| v.as_str()) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => continue,
        };

        let state = match data.get("state") {
            Some(s) if s.is_object() => s,
            _ => continue,
        };

        let time_info = match state.get("time") {
            Some(t) if t.is_object() => t,
            _ => continue,
        };

        let start = time_info.get("start").and_then(Value::as_i64);
        let end = time_info.get("end").and_then(Value::as_i64);

        if let (Some(start_ms), Some(end_ms)) = (start, end) {
            let duration_sec = duration_sec_from_ms(start_ms, end_ms);

            let mut dict = Map::new();
            dict.insert(
                "session_id".to_string(),
                Value::String(session_id.clone()),
            );
            dict.insert("tool_name".to_string(), Value::String(tool_name));
            dict.insert(
                "time_start".to_string(),
                Value::Number(Number::from(start_ms)),
            );
            dict.insert(
                "time_end".to_string(),
                Value::Number(Number::from(end_ms)),
            );
            dict.insert(
                "duration_sec".to_string(),
                Number::from_f64(duration_sec)
                    .map_or(Value::Null, Value::Number),
            );
            results.push(Value::Object(dict));
        }
    }

    results
}

/// Query messages from the database for timeline event display.
///
/// Joins `message` + `part` tables. Extracts user messages (role='user',
/// type='text', not synthetic), assistant replies (role='assistant',
/// type='text'), and assistant reasoning (role='assistant',
/// type='reasoning').
///
/// Configuration for `build_db_message_event`.
struct DbMessageEventConfig<'a> {
    event_type: &'a str,
    icon: &'a str,
    summary: String,
    text: &'a str,
    timestamp: &'a str,
    model: &'a str,
    agent: &'a str,
    sid: &'a str,
    msg_time_created: Option<&'a Value>,
    msg_time_completed: Option<&'a Value>,
}

/// Build a single message event from common parts.
fn build_db_message_event(cfg: &DbMessageEventConfig) -> Value {
    let mut ev = Map::new();
    ev.insert(
        "timestamp".to_string(),
        Value::String(cfg.timestamp.to_string()),
    );
    ev.insert("source".to_string(), Value::String("db".to_string()));
    ev.insert("type".to_string(), Value::String(cfg.event_type.to_string()));
    ev.insert("icon".to_string(), Value::String(cfg.icon.to_string()));
    ev.insert("summary".to_string(), Value::String(cfg.summary.clone()));
    ev.insert("content".to_string(), Value::String(cfg.text.to_string()));
    ev.insert("model".to_string(), Value::String(cfg.model.to_string()));
    ev.insert("agent".to_string(), Value::String(cfg.agent.to_string()));
    ev.insert("session_id".to_string(), Value::String(cfg.sid.to_string()));
    ev.insert(
        "msg_time_created".to_string(),
        cfg.msg_time_created.cloned().unwrap_or(Value::Null),
    );
    ev.insert(
        "msg_time_completed".to_string(),
        cfg.msg_time_completed.cloned().unwrap_or(Value::Null),
    );
    Value::Object(ev)
}

/// Shared context for processing a group of part rows within one message.
struct PartRowCtx {
    timestamp: String,
    role: String,
    model: String,
    agent: String,
    sid: String,
    msg_time_created: Option<Value>,
    msg_time_completed: Option<Value>,
}

/// Process a single part row and push matching message events.
fn process_part_row(
    events: &mut Vec<Value>,
    ctx: &PartRowCtx,
    part_row: &JoinRow,
) {
    let part_data = &part_row.part_data;
    let part_type =
        part_data.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let text = part_data.get("text").and_then(|v| v.as_str()).unwrap_or("");

    if text.is_empty() {
        return;
    }

    let is_synthetic = part_data
        .get("synthetic")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let (event_type, icon, summary) =
        if ctx.role == "user" && part_type == "text" && !is_synthetic {
            ("user_msg", "👤", truncate_text(text, 80))
        } else if ctx.role == "assistant" && part_type == "text" {
            ("assistant_reply", "🤖", truncate_text(text, 80))
        } else if ctx.role == "assistant" && part_type == "reasoning" {
            (
                "assistant_reasoning",
                "🧠",
                format!("Reasoning: {}", truncate_text(text, 72)),
            )
        } else {
            return;
        };

    events.push(build_db_message_event(&DbMessageEventConfig {
        event_type,
        icon,
        summary,
        text,
        timestamp: &ctx.timestamp,
        model: &ctx.model,
        agent: &ctx.agent,
        sid: &ctx.sid,
        msg_time_created: ctx.msg_time_created.as_ref(),
        msg_time_completed: ctx.msg_time_completed.as_ref(),
    }));
}

pub fn query_db_messages(session_ids: &[&str], db_path: &str) -> Vec<Value> {
    if session_ids.is_empty() {
        return vec![];
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    let owned_ids: Vec<String> =
        session_ids.iter().map(std::string::ToString::to_string).collect();

    let rows = query_join_rows(&conn, &owned_ids);

    // Group by message_id
    let mut grouped: HashMap<String, Vec<JoinRow>> = HashMap::new();
    for row in rows {
        grouped.entry(row.msg_id.clone()).or_default().push(row);
    }

    let mut events: Vec<Value> = Vec::new();
    for part_rows in grouped.values() {
        let first = &part_rows[0];
        let msg_data = &first.msg_data;
        if !msg_data.is_object() {
            continue;
        }

        let role = msg_data.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }

        let ts_ms = first.msg_time;
        let timestamp = ts_ms.map(epoch_ms_to_iso).unwrap_or_default();

        let agent = msg_data
            .get("agent")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let model = if role == "assistant" {
            msg_data
                .get("modelID")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        let sid = first.session_id.clone();

        // Extract time info from message data for assistant messages
        let time_info =
            msg_data.get("time").and_then(|t| t.as_object()).cloned();
        let msg_time_created = time_info
            .as_ref()
            .and_then(|t| t.get("created"))
            .and_then(Value::as_i64)
            .map(|ts| Value::Number(Number::from(ts)));
        let msg_time_completed = time_info
            .as_ref()
            .and_then(|t| t.get("completed"))
            .and_then(Value::as_i64)
            .map(|ts| Value::Number(Number::from(ts)));

        let ctx = PartRowCtx {
            timestamp,
            role: role.to_string(),
            model,
            agent,
            sid,
            msg_time_created,
            msg_time_completed,
        };

        for part_row in part_rows {
            process_part_row(&mut events, &ctx, part_row);
        }
    }

    events
}

/// Query completed tool calls from the part table for timeline events.
///
/// Queries `part` where `type = 'tool'` and `status = 'completed'`.
/// Uses `parser::tool_type_and_icon` to map tool names to event types and
/// icons.
pub fn query_db_tool_calls(session_ids: &[&str], db_path: &str) -> Vec<Value> {
    if session_ids.is_empty() {
        return vec![];
    }

    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    let owned_ids: Vec<String> =
        session_ids.iter().map(std::string::ToString::to_string).collect();
    let placeholders: String =
        owned_ids.iter().map(|_| "?".to_string()).collect::<Vec<_>>().join(",");

    let sql = format!(
        "SELECT session_id, data FROM part \
         WHERE session_id IN ({placeholders}) \
         AND json_extract(data, '$.type') = 'tool' \
         AND json_extract(data, '$.state.status') = 'completed' \
         ORDER BY time_created ASC"
    );
    let mut stmt = conn.prepare(&sql).expect("SQL prepare failed");

    let params: Vec<Box<dyn rusqlite::types::ToSql>> = owned_ids
        .iter()
        .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();

    let rows: Vec<(String, Value)> = stmt
        .query_map(param_refs.as_slice(), |row| {
            let sid: String = row.get("session_id")?;
            let data_str: String = row.get("data")?;
            Ok((sid, safe_json_loads(&data_str).unwrap_or(Value::Null)))
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    let mut events: Vec<Value> = Vec::new();
    for (session_id, data) in &rows {
        let tool_name = match data.get("tool").and_then(|v| v.as_str()) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => continue,
        };

        let state = match data.get("state") {
            Some(s) if s.is_object() => s,
            _ => continue,
        };

        let time_info = match state.get("time") {
            Some(t) if t.is_object() => t,
            _ => continue,
        };

        let Some(start_ms) = time_info.get("start").and_then(Value::as_i64)
        else {
            continue;
        };

        let timestamp = epoch_ms_to_iso(start_ms);
        let (event_type, icon) = tool_type_and_icon(&tool_name);

        let primary = primary_tool_input(state);
        let summary = if primary.is_empty() {
            tool_name.clone()
        } else {
            format!("{tool_name}: {primary}")
        };

        let inp = state.get("input").and_then(|v| v.as_object());
        let input_keys: Vec<Value> = inp
            .map(|obj| obj.keys().map(|k| Value::String(k.clone())).collect())
            .unwrap_or_default();

        let mut detail = Map::new();
        detail
            .insert("tool_name".to_string(), Value::String(tool_name.clone()));
        detail.insert(
            "status".to_string(),
            Value::String(
                state
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        detail.insert("input_keys".to_string(), Value::Array(input_keys));

        let end_ms = time_info.get("end").and_then(Value::as_i64);
        if let Some(end) = end_ms {
            let duration_sec = duration_sec_from_ms(start_ms, end);
            detail.insert(
                "duration_sec".to_string(),
                Number::from_f64(duration_sec)
                    .map_or(Value::Null, Value::Number),
            );
        }

        let mut ev = Map::new();
        ev.insert("timestamp".to_string(), Value::String(timestamp));
        ev.insert("source".to_string(), Value::String("db".to_string()));
        ev.insert("type".to_string(), Value::String(event_type));
        ev.insert("icon".to_string(), Value::String(icon));
        ev.insert("summary".to_string(), Value::String(summary));
        ev.insert("detail".to_string(), Value::Object(detail));
        ev.insert("session_id".to_string(), Value::String(session_id.clone()));
        events.push(Value::Object(ev));
    }

    events
}

/// Get all messages and their parts for a single session, ordered by time.
///
/// Each returned dict contains the parsed `message.data` JSON and a list
/// of parsed `part.data` JSONs grouped by `message_id`.
pub fn query_message_parts(session_id: &str, db_path: &str) -> Vec<Value> {
    #[derive(Clone)]
    struct MsgRow {
        id: String,
        session_id: String,
        time_created: Option<i64>,
        data: Value,
    }

    #[derive(Clone)]
    struct PartRow {
        message_id: String,
        data: Value,
    }

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

    let msg_rows: Vec<MsgRow> = msg_stmt
        .query_map(rusqlite::params![session_id], |row| {
            let id: String = row.get("id")?;
            let sid: String = row.get("session_id")?;
            let tc: Option<i64> = row.get("time_created")?;
            let data_str: String = row.get("data")?;
            Ok(MsgRow {
                id,
                session_id: sid,
                time_created: tc,
                data: safe_json_loads(&data_str).unwrap_or(Value::Null),
            })
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

    let part_rows: Vec<PartRow> = part_stmt
        .query_map(rusqlite::params![session_id], |row| {
            let message_id: String = row.get("message_id")?;
            let data_str: String = row.get("data")?;
            Ok(PartRow {
                message_id,
                data: safe_json_loads(&data_str).unwrap_or(Value::Null),
            })
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    // Group parts by message_id
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    for prow in &part_rows {
        if prow.data.is_object() {
            parts_by_msg
                .entry(prow.message_id.clone())
                .or_default()
                .push(prow.data.clone());
        }
    }

    // Build results
    let mut results: Vec<Value> = Vec::new();
    for mrow in &msg_rows {
        if !mrow.data.is_object() {
            continue;
        }
        let ts_ms = mrow.time_created;
        let timestamp = ts_ms.map(epoch_ms_to_iso).unwrap_or_default();

        let role = mrow
            .data
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let parts = parts_by_msg.get(&mrow.id).cloned().unwrap_or_default();

        let mut dict = Map::new();
        dict.insert("id".to_string(), Value::String(mrow.id.clone()));
        dict.insert(
            "session_id".to_string(),
            Value::String(mrow.session_id.clone()),
        );
        dict.insert("role".to_string(), Value::String(role));
        dict.insert("time_created".to_string(), Value::String(timestamp));
        dict.insert("data".to_string(), mrow.data.clone());
        dict.insert("parts".to_string(), Value::Array(parts));
        results.push(Value::Object(dict));
    }

    results
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
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
            dir.join(format!("ztrace_db_test_{}.db", std::process::id()));
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
        insert_ses001_data(&conn);
        insert_ses002_data(&conn);

        conn.close().expect("close test db");
        path.to_str().unwrap().to_string()
    }

    /// Insert ses-001 messages and parts into the test database.
    fn insert_ses001_data(conn: &Connection) {
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-001",
                "ses-001",
                1_715_000_010_000_i64,
                r#"{"role":"user","agent":"general"}"#,
            ],
        )
        .expect("insert msg-001");

        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-002",
                "ses-001",
                1_715_000_020_000_i64,
                r#"{"role":"assistant","agent":"general","modelID":"gpt-4","time":{"created":1715000020000,"completed":1715000090000}}"#,
            ],
        )
        .expect("insert msg-002");

        // Parts for msg-002: step-finish + tool
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-001", "msg-002", "ses-001",
                1_715_000_020_000_i64, 1_715_000_025_000_i64,
                r#"{"type":"step-finish","tokens":{"input":100,"output":50,"cache":{"read":30,"write":10},"reasoning":5},"cost":0.005,"reason":"completed"}"#,
            ],
        )
        .expect("insert part-001");

        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-002", "msg-002", "ses-001",
                1_715_000_021_000_i64, 1_715_000_021_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"src/auth.ts"},"time":{"start":1715000021000,"end":1715000021500}}}"#,
            ],
        )
        .expect("insert part-002");

        // User message with text part (for query_db_messages tests)
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-005",
                "ses-001",
                1_715_000_005_000_i64,
                r#"{"role":"user","agent":"general"}"#,
            ],
        )
        .expect("insert msg-005");

        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-005", "msg-005", "ses-001",
                1_715_000_005_000_i64, 1_715_000_005_000_i64,
                r#"{"type":"text","text":"Hello, how do I fix auth?","synthetic":false}"#,
            ],
        )
        .expect("insert part-005");

        // Assistant reply with text and reasoning
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-006",
                "ses-001",
                1_715_000_030_000_i64,
                r#"{"role":"assistant","agent":"general","modelID":"gpt-4","time":{"created":1715000030000,"completed":1715000095000}}"#,
            ],
        )
        .expect("insert msg-006");

        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-006", "msg-006", "ses-001",
                1_715_000_030_000_i64, 1_715_000_030_000_i64,
                r#"{"type":"reasoning","text":"Let me think about this auth issue..."}"#,
            ],
        )
        .expect("insert part-006");

        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-007", "msg-006", "ses-001",
                1_715_000_031_000_i64, 1_715_000_031_000_i64,
                r#"{"type":"text","text":"You can fix auth by checking the middleware order.","synthetic":false}"#,
            ],
        )
        .expect("insert part-007");
    }

    /// Insert ses-002 messages and parts into the test database.
    fn insert_ses002_data(conn: &Connection) {
        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-003",
                "ses-002",
                1_715_000_210_000_i64,
                r#"{"role":"user","agent":"explore"}"#,
            ],
        )
        .expect("insert msg-003");

        conn.execute(
            "INSERT INTO message VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                "msg-004",
                "ses-002",
                1_715_000_220_000_i64,
                r#"{"role":"assistant","agent":"explore","modelID":"claude-3"}"#,
            ],
        )
        .expect("insert msg-004");

        // Parts for msg-003: step-finish only
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-003", "msg-003", "ses-002",
                1_715_000_210_000_i64, 1_715_000_220_000_i64,
                r#"{"type":"step-finish","tokens":{"input":200,"output":100,"cache":{"read":50,"write":20}},"cost":0.003,"reason":"completed"}"#,
            ],
        )
        .expect("insert part-003");

        // Tool part for ses-002 (completed tool call)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-004", "msg-004", "ses-002",
                1_715_000_221_000_i64, 1_715_000_221_000_i64,
                r#"{"type":"tool","tool":"bash","state":{"input":{"command":"ls -la /app"},"time":{"start":1715000221000,"end":1715000222000},"status":"completed"}}"#,
            ],
        )
        .expect("insert part-004");

        // Another tool part with no end time (should be excluded from durations)
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, \
             time_updated, data) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                "part-008", "msg-003", "ses-002",
                1_715_000_211_000_i64, 1_715_000_211_000_i64,
                r#"{"type":"tool","tool":"read","state":{"input":{"filePath":"/app/README.md"},"time":{"start":1715000211000},"status":"running"}}"#,
            ],
        )
        .expect("insert part-008");
    }

    // ── query_message_parts tests ─────────────────────────────────────────

    #[test]
    fn test_query_message_parts_returns_correct_structure() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let results = query_message_parts("ses-001", &db_path);

        // ses-001 has 3 messages: msg-005 (user), msg-001 (user), msg-002 (assistant), msg-006 (assistant)
        // In order: msg-005, msg-001, msg-002, msg-006
        assert!(!results.is_empty(), "should return messages");

        // Check structure of first result
        let first = &results[0];
        assert!(first.get("id").and_then(|v| v.as_str()).is_some());
        assert!(first.get("session_id").and_then(|v| v.as_str()).is_some());
        assert!(first.get("role").and_then(|v| v.as_str()).is_some());
        assert!(first.get("time_created").and_then(|v| v.as_str()).is_some());
        assert!(first.get("data").and_then(|v| v.as_object()).is_some());
        assert!(first.get("parts").and_then(|v| v.as_array()).is_some());

        // msg-005 (user) should have parts
        let msg_005 = results
            .iter()
            .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("msg-005"));
        assert!(msg_005.is_some(), "msg-005 should exist");
        let parts =
            msg_005.unwrap().get("parts").and_then(|v| v.as_array()).unwrap();
        assert_eq!(parts.len(), 1, "msg-005 should have 1 part");

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_message_parts_empty_session() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let results = query_message_parts("nonexistent", &db_path);
        assert!(results.is_empty());

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_message_parts_nonexistent_db() {
        let results =
            query_message_parts("ses-001", "/tmp/nonexistent_db_ztrace.db");
        assert!(results.is_empty());
    }

    // ── query_step_data_batch tests ────────────────────────────────────────

    #[test]
    fn test_query_step_data_batch_multiple_sessions() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids = ["ses-001", "ses-002"];
        let results = query_step_data_batch(&session_ids, &db_path);

        // ses-001 has 1 step-finish (part-001), ses-002 has 1 (part-003)
        assert_eq!(results.len(), 2);

        // First result should be from ses-001 (earlier time)
        assert_eq!(results[0]["session_id"].as_str().unwrap(), "ses-001");
        assert_eq!(results[0]["step_index"].as_u64().unwrap(), 1);
        let input = results[0]["input_tokens"].as_f64().unwrap();
        assert!((input - 100.0).abs() < 0.1, "got {input}, expected 100");
        let output = results[0]["output_tokens"].as_f64().unwrap();
        assert!((output - 50.0).abs() < 0.1, "got {output}, expected 50");
        let cache_read = results[0]["cache_read"].as_f64().unwrap();
        assert!(
            (cache_read - 30.0).abs() < 0.1,
            "got {cache_read}, expected 30"
        );
        let cache_write = results[0]["cache_write"].as_f64().unwrap();
        assert!(
            (cache_write - 10.0).abs() < 0.1,
            "got {cache_write}, expected 10"
        );
        let reasoning = results[0]["reasoning_tokens"].as_f64().unwrap();
        assert!((reasoning - 5.0).abs() < 0.1, "got {reasoning}, expected 5");
        assert_eq!(results[0]["reason"].as_str().unwrap(), "completed");
        assert!(
            (results[0]["cost"].as_f64().unwrap() - 0.005).abs() < f64::EPSILON
        );
        // Has tool "read" associated
        let tools = results[0]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].as_str().unwrap(), "read");

        // Second result should be from ses-002
        assert_eq!(results[1]["session_id"].as_str().unwrap(), "ses-002");
        assert_eq!(results[1]["step_index"].as_u64().unwrap(), 1);
        let input2 = results[1]["input_tokens"].as_f64().unwrap();
        assert!((input2 - 200.0).abs() < 0.1, "got {input2}, expected 200");

        // Check msg_time_created/msg_time_completed (from msg-002)
        assert!(
            results[0]["msg_time_created"].as_i64().is_some(),
            "ses-001 first step should have msg_time_created"
        );

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_step_data_batch_empty_session_ids() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids: [&str; 0] = [];
        let results = query_step_data_batch(&session_ids, &db_path);
        assert!(results.is_empty());

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_step_data_batch_nonexistent_db() {
        let session_ids = ["ses-001"];
        let results = query_step_data_batch(
            &session_ids,
            "/tmp/nonexistent_db_ztrace_step.db",
        );
        assert!(results.is_empty());
    }

    // ── query_tool_durations_batch tests ──────────────────────────────────

    #[test]
    fn test_query_tool_durations_batch_includes_session_id() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids = ["ses-001", "ses-002"];
        let results = query_tool_durations_batch(&session_ids, &db_path);

        // ses-001 has 1 tool with both start/end (part-002)
        // ses-002 has 1 tool with both start/end (part-004)
        // ses-002 has 1 tool without end (part-008) - excluded
        assert_eq!(results.len(), 2);

        // Check session_id is included
        for result in &results {
            assert!(
                result.get("session_id").and_then(|v| v.as_str()).is_some(),
                "each duration result should have session_id"
            );
        }

        // Check structure
        let first = &results[0];
        assert_eq!(
            first.get("session_id").and_then(|v| v.as_str()),
            Some("ses-001")
        );
        assert_eq!(
            first.get("tool_name").and_then(|v| v.as_str()),
            Some("read")
        );
        assert!(
            first
                .get("time_start")
                .and_then(serde_json::Value::as_i64)
                .is_some()
        );
        assert!(
            first.get("time_end").and_then(serde_json::Value::as_i64).is_some()
        );
        assert!(
            first
                .get("duration_sec")
                .and_then(serde_json::Value::as_f64)
                .is_some()
        );

        // ses-002 tool should be "bash"
        let second = &results[1];
        assert_eq!(
            second.get("tool_name").and_then(|v| v.as_str()),
            Some("bash")
        );

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_tool_durations_batch_empty_session_ids() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids: [&str; 0] = [];
        let results = query_tool_durations_batch(&session_ids, &db_path);
        assert!(results.is_empty());

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_tool_durations_batch_nonexistent_db() {
        let session_ids = ["ses-001"];
        let results = query_tool_durations_batch(
            &session_ids,
            "/tmp/nonexistent_db_ztrace_tool.db",
        );
        assert!(results.is_empty());
    }

    // ── query_db_messages tests ───────────────────────────────────────────

    #[test]
    fn test_query_db_messages_returns_all_types() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids = ["ses-001"];
        let results = query_db_messages(&session_ids, &db_path);

        // ses-001 has: 1 user_msg (msg-005 part-005), 1 assistant_reply (msg-006 part-007),
        // 1 assistant_reasoning (msg-006 part-006)
        // msg-001 is a user message with no parts with text (no text parts inserted) - skipped
        // msg-002 has no text parts either
        assert_eq!(results.len(), 3);

        // Check types
        let types: Vec<&str> = results
            .iter()
            .map(|r| r.get("type").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        assert!(types.contains(&"user_msg"));
        assert!(types.contains(&"assistant_reply"));
        assert!(types.contains(&"assistant_reasoning"));

        // Check user_msg
        let user_msgs: Vec<&Value> = results
            .iter()
            .filter(|r| {
                r.get("type").and_then(|v| v.as_str()) == Some("user_msg")
            })
            .collect();
        assert_eq!(user_msgs.len(), 1);
        let user_msg = user_msgs[0];
        assert_eq!(user_msg.get("icon").and_then(|v| v.as_str()), Some("👤"));
        assert_eq!(user_msg.get("source").and_then(|v| v.as_str()), Some("db"));
        assert_eq!(
            user_msg.get("summary").and_then(|v| v.as_str()),
            Some("Hello, how do I fix auth?")
        );
        assert_eq!(user_msg.get("model").and_then(|v| v.as_str()), Some(""));

        // Check assistant_reply
        let reply_msgs: Vec<&Value> = results
            .iter()
            .filter(|r| {
                r.get("type").and_then(|v| v.as_str())
                    == Some("assistant_reply")
            })
            .collect();
        assert_eq!(reply_msgs.len(), 1);
        let reply = reply_msgs[0];
        assert_eq!(reply.get("icon").and_then(|v| v.as_str()), Some("🤖"));
        assert_eq!(reply.get("model").and_then(|v| v.as_str()), Some("gpt-4"));
        assert!(
            reply
                .get("msg_time_created")
                .and_then(serde_json::Value::as_i64)
                .is_some()
        );

        // Check assistant_reasoning
        let reasoning_msgs: Vec<&Value> = results
            .iter()
            .filter(|r| {
                r.get("type").and_then(|v| v.as_str())
                    == Some("assistant_reasoning")
            })
            .collect();
        assert_eq!(reasoning_msgs.len(), 1);
        let reasoning = reasoning_msgs[0];
        assert_eq!(reasoning.get("icon").and_then(|v| v.as_str()), Some("🧠"));
        assert!(
            reasoning
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .starts_with("Reasoning: ")
        );

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_db_messages_empty_session_ids() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids: [&str; 0] = [];
        let results = query_db_messages(&session_ids, &db_path);
        assert!(results.is_empty());

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_db_messages_nonexistent_db() {
        let session_ids = ["ses-001"];
        let results = query_db_messages(
            &session_ids,
            "/tmp/nonexistent_db_ztrace_msg.db",
        );
        assert!(results.is_empty());
    }

    // ── query_db_tool_calls tests ─────────────────────────────────────────

    #[test]
    fn test_query_db_tool_calls_returns_completed() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids = ["ses-002"];
        let results = query_db_tool_calls(&session_ids, &db_path);

        // ses-002 has part-004 (tool bash, completed) and part-008 (tool read, running)
        // Only part-004 is completed
        assert_eq!(results.len(), 1);
        let call = &results[0];
        assert_eq!(
            call.get("session_id").and_then(|v| v.as_str()),
            Some("ses-002")
        );
        assert_eq!(call.get("source").and_then(|v| v.as_str()), Some("db"));
        assert!(call.get("timestamp").and_then(|v| v.as_str()).is_some());

        // Check detail
        let detail = call.get("detail").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            detail.get("tool_name").and_then(|v| v.as_str()),
            Some("bash")
        );
        assert_eq!(
            detail.get("status").and_then(|v| v.as_str()),
            Some("completed")
        );
        assert!(
            detail
                .get("duration_sec")
                .and_then(serde_json::Value::as_f64)
                .is_some()
        );

        // Summary should be "bash: ls -la /app"
        assert_eq!(
            call.get("summary").and_then(|v| v.as_str()),
            Some("bash: ls -la /app")
        );

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_db_tool_calls_empty_session_ids() {
        let _lock =
            DB_MUTEX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let db_path = create_test_db();

        let session_ids: [&str; 0] = [];
        let results = query_db_tool_calls(&session_ids, &db_path);
        assert!(results.is_empty());

        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn test_query_db_tool_calls_nonexistent_db() {
        let session_ids = ["ses-001"];
        let results = query_db_tool_calls(
            &session_ids,
            "/tmp/nonexistent_db_ztrace_tc.db",
        );
        assert!(results.is_empty());
    }
}
