// Event-stream aggregators for the `steps` and `tokens` subcommands.
//
// Both commands derive their rows from the host-agnostic event stream of a
// [`Session`]: one `Usage` event approximates one LLM step, so the two
// commands behave identically for OpenCode and pi sessions. Tool uses are
// attached to the step whose usage timestamp is closest in time (ties go to
// the later step), which reproduces the historical message-level grouping.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use zutil::epoch_ms_to_iso;
use zutil::session::{Session, SessionEvent};

/// Numeric payload of one [`SessionEvent::Usage`].
struct UsageData {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
    timestamp: i64,
    reasoning: i64,
    reason: Option<String>,
    message_id: Option<String>,
    duration_ms: Option<i64>,
    model: Option<String>,
}

/// Numeric payload of one [`SessionEvent::ToolUse`].
struct ToolData {
    name: String,
    timestamp: i64,
}

/// Convert an i64 token count to f64 without tripping precision-loss lints.
///
/// Token counts fit comfortably in an `i32`; the `i32` → `f64` conversion
/// is exact, matching the crate-wide convention.
fn i64_to_f64(v: i64) -> f64 {
    f64::from(i32::try_from(v).unwrap_or(0))
}

/// Extract the usage events of a session in stream order.
fn collect_usages(events: &[SessionEvent]) -> Vec<UsageData> {
    events
        .iter()
        .filter_map(|ev| match ev {
            SessionEvent::Usage {
                input,
                output,
                cache_read,
                cache_write,
                cost,
                timestamp,
                reasoning,
                reason,
                message_id,
                duration_ms,
                model,
            } => Some(UsageData {
                input: *input,
                output: *output,
                cache_read: *cache_read,
                cache_write: *cache_write,
                cost: cost.unwrap_or(0.0),
                timestamp: *timestamp,
                reasoning: *reasoning,
                reason: reason.clone(),
                message_id: message_id.clone(),
                duration_ms: *duration_ms,
                model: model.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// Extract the tool-use events of a session in stream order.
fn collect_tools(events: &[SessionEvent]) -> Vec<ToolData> {
    events
        .iter()
        .filter_map(|ev| match ev {
            SessionEvent::ToolUse { name, timestamp, .. } => {
                Some(ToolData { name: name.clone(), timestamp: *timestamp })
            }
            _ => None,
        })
        .collect()
}

/// Index of the usage whose timestamp is closest to `ts` among `usages`.
///
/// Ties resolve toward the later usage, so a tool call sharing its
/// message timestamp with an assistant usage attaches to that usage.
fn nearest_usage_index(ts: i64, usages: &[UsageData]) -> Option<usize> {
    let mut best: Option<(usize, u64)> = None;
    for (i, usage) in usages.iter().enumerate() {
        let dist = (ts - usage.timestamp).unsigned_abs();
        if best.is_none_or(|(_, best_dist)| dist <= best_dist) {
            best = Some((i, dist));
        }
    }
    best.map(|(i, _)| i)
}

/// Build the per-usage tool-name lists using nearest-usage attachment.
fn attach_tools(usages: &[UsageData], tools: &[ToolData]) -> Vec<Vec<String>> {
    let mut attached: Vec<Vec<String>> = vec![Vec::new(); usages.len()];
    for tool in tools {
        if let Some(idx) = nearest_usage_index(tool.timestamp, usages) {
            attached[idx].push(tool.name.clone());
        }
    }
    attached
}

/// Build step dicts for every session in `session_map` (order: `sessions`).
///
/// Each step carries the same key set the former DB query produced
/// (`step_index`, `session_id`, `message_id`, `time_created`,
/// `time_updated`, `cache_read`, `cache_write`, `input_tokens`,
/// `output_tokens`, `reasoning_tokens`, `cost`, `reason`, `tools`) plus a
/// `duration` (seconds) when the provider recorded one, so the display
/// and JSON layers stay unchanged.
#[must_use]
pub fn build_step_values(
    session_map: &HashMap<String, Session>,
    sessions: &[(String, i64)],
) -> Vec<Value> {
    let mut steps: Vec<Value> = Vec::new();
    for (sid, _) in sessions {
        let Some(session) = session_map.get(sid) else {
            continue;
        };
        steps.extend(build_session_steps(&session.events, sid));
    }
    steps
}

/// Build the step dicts for one session's event stream.
fn build_session_steps(events: &[SessionEvent], sid: &str) -> Vec<Value> {
    let usages = collect_usages(events);
    let tools = collect_tools(events);
    let attached = attach_tools(&usages, &tools);

    let mut steps: Vec<Value> = Vec::with_capacity(usages.len());
    for (i, usage) in usages.iter().enumerate() {
        let ts = epoch_ms_to_iso(usage.timestamp);
        let mut step = Map::new();
        step.insert(
            "step_index".to_string(),
            Value::Number(Number::from((i + 1) as u64)),
        );
        step.insert("session_id".to_string(), Value::String(sid.to_string()));
        step.insert(
            "message_id".to_string(),
            Value::String(usage.message_id.clone().unwrap_or_default()),
        );
        step.insert("time_created".to_string(), Value::String(ts.clone()));
        step.insert("time_updated".to_string(), Value::String(ts));
        step.insert(
            "cache_read".to_string(),
            Number::from_f64(i64_to_f64(usage.cache_read))
                .map_or(Value::Null, Value::Number),
        );
        step.insert(
            "cache_write".to_string(),
            Number::from_f64(i64_to_f64(usage.cache_write))
                .map_or(Value::Null, Value::Number),
        );
        step.insert(
            "input_tokens".to_string(),
            Number::from_f64(i64_to_f64(usage.input))
                .map_or(Value::Null, Value::Number),
        );
        step.insert(
            "output_tokens".to_string(),
            Number::from_f64(i64_to_f64(usage.output))
                .map_or(Value::Null, Value::Number),
        );
        step.insert(
            "reasoning_tokens".to_string(),
            Number::from_f64(i64_to_f64(usage.reasoning))
                .map_or(Value::Null, Value::Number),
        );
        step.insert(
            "cost".to_string(),
            Number::from_f64(usage.cost).map_or(Value::Null, Value::Number),
        );
        step.insert(
            "reason".to_string(),
            Value::String(usage.reason.clone().unwrap_or_default()),
        );
        if let Some(model) = &usage.model {
            step.insert("model".to_string(), Value::String(model.clone()));
        }
        // Provider-reported duration in seconds; the key stays absent when
        // the host records none so the metrics pass surfaces it as
        // unknown (`null`) instead of a fabricated 0.
        if let Some(duration_ms) = usage.duration_ms {
            step.insert(
                "duration".to_string(),
                Number::from_f64(i64_to_f64(duration_ms) / 1000.0)
                    .map_or(Value::Null, Value::Number),
            );
        }
        step.insert(
            "tools".to_string(),
            Value::Array(
                attached[i]
                    .iter()
                    .map(|name| Value::String(name.clone()))
                    .collect(),
            ),
        );
        steps.push(Value::Object(step));
    }
    steps
}

/// Collapse whitespace of a message text for preview display.
fn collapse_whitespace(text: &str) -> String {
    text.replace('\n', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build the token-distribution rows for one session.
///
/// One row per `Usage` event (an LLM turn): role `assistant`, tokens
/// `input + output`, `segments` = tool uses attached to that usage, and
/// `preview` = the latest assistant text preceding the usage.
#[must_use]
pub fn build_token_rows(session: &Session) -> Vec<Value> {
    let usages = collect_usages(&session.events);
    let tools = collect_tools(&session.events);
    let attached = attach_tools(&usages, &tools);

    let mut rows: Vec<Value> = Vec::with_capacity(usages.len());
    let mut usage_idx = 0usize;
    let mut last_assistant: Option<String> = None;

    for ev in &session.events {
        match ev {
            SessionEvent::Message { role, text, .. } if role == "assistant" => {
                last_assistant = Some(collapse_whitespace(text));
            }
            SessionEvent::Usage {
                input, output, model, message_id, ..
            } => {
                let preview = last_assistant.take().unwrap_or_default();
                let preview = zutil::truncate_width(&preview, 40);
                let mut row = Map::new();
                // Prefer the provider-reported message id (both hosts fill
                // it) so `zfind message <id>` can cross-reference tokens
                // rows; keep the synthetic id only as a fallback.
                row.insert(
                    "id".to_string(),
                    Value::String(
                        message_id.clone().unwrap_or_else(|| {
                            format!("usage-{}", usage_idx + 1)
                        }),
                    ),
                );
                row.insert(
                    "role".to_string(),
                    Value::String("assistant".to_string()),
                );
                if let Some(model) = model {
                    row.insert(
                        "model".to_string(),
                        Value::String(model.clone()),
                    );
                }
                row.insert(
                    "tokens".to_string(),
                    Value::Number(Number::from(
                        u64::try_from((*input + *output).max(0)).unwrap_or(0),
                    )),
                );
                row.insert(
                    "segments".to_string(),
                    Value::Number(Number::from(
                        attached.get(usage_idx).map_or(0, Vec::len) as u64,
                    )),
                );
                row.insert("preview".to_string(), Value::String(preview));
                rows.push(Value::Object(row));
                usage_idx += 1;
            }
            _ => {}
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use zutil::session::SessionMeta;

    fn session_meta() -> SessionMeta {
        SessionMeta {
            id: "ses-001".to_string(),
            parent_id: None,
            cwd: "/w".to_string(),
            started_at: 0,
            label: None,
            title: None,
            updated_at: None,
            model: None,
            agent: None,
        }
    }

    fn msg(role: &str, text: &str, ts: i64) -> SessionEvent {
        SessionEvent::Message {
            id: None,
            role: role.to_string(),
            text: text.to_string(),
            timestamp: ts,
        }
    }

    fn usage(
        ts: i64,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
    ) -> SessionEvent {
        SessionEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
            cost: Some(0.001),
            timestamp: ts,
            reasoning: 0,
            reason: None,
            message_id: None,
            duration_ms: None,
            model: None,
        }
    }

    fn tool(name: &str, ts: i64) -> SessionEvent {
        SessionEvent::ToolUse {
            id: None,
            name: name.to_string(),
            input: Value::Null,
            timestamp: ts,
        }
    }

    #[test]
    fn test_nearest_usage_tie_goes_later() {
        // Both usages at the same timestamp: the tool must attach to the
        // later one (matching the assistant message that declared it).
        let usages = vec![
            UsageData {
                input: 1,
                output: 1,
                cache_read: 0,
                cache_write: 0,
                cost: 0.0,
                timestamp: 100,
                reasoning: 0,
                reason: None,
                message_id: None,
                duration_ms: None,
                model: None,
            },
            UsageData {
                input: 2,
                output: 2,
                cache_read: 0,
                cache_write: 0,
                cost: 0.0,
                timestamp: 100,
                reasoning: 0,
                reason: None,
                message_id: None,
                duration_ms: None,
                model: None,
            },
        ];
        assert_eq!(nearest_usage_index(100, &usages), Some(1));
    }

    #[test]
    fn test_nearest_usage_picks_closest() {
        let usages = vec![
            UsageData {
                input: 1,
                output: 1,
                cache_read: 0,
                cache_write: 0,
                cost: 0.0,
                timestamp: 1000,
                reasoning: 0,
                reason: None,
                message_id: None,
                duration_ms: None,
                model: None,
            },
            UsageData {
                input: 2,
                output: 2,
                cache_read: 0,
                cache_write: 0,
                cost: 0.0,
                timestamp: 2000,
                reasoning: 0,
                reason: None,
                message_id: None,
                duration_ms: None,
                model: None,
            },
        ];
        assert_eq!(nearest_usage_index(2100, &usages), Some(1));
        // Equidistant (1500) ties toward the later step.
        assert_eq!(nearest_usage_index(1500, &usages), Some(1));
        assert_eq!(nearest_usage_index(1200, &usages), Some(0));
    }

    #[test]
    fn test_build_session_steps_usage_based() {
        let events = vec![
            msg("user", "hello", 1),
            usage(2, 100, 50, 30, 10),
            tool("read", 3),
            usage(4, 200, 100, 80, 20),
        ];
        let steps = build_session_steps(&events, "ses-001");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["session_id"].as_str().unwrap(), "ses-001");
        assert_eq!(steps[0]["step_index"].as_u64().unwrap(), 1);
        assert!((steps[0]["cache_read"].as_f64().unwrap() - 30.0).abs() < 0.01);
        assert!(
            (steps[0]["cache_write"].as_f64().unwrap() - 10.0).abs() < 0.01
        );
        assert!(
            (steps[0]["input_tokens"].as_f64().unwrap() - 100.0).abs() < 0.01
        );
        assert!(
            (steps[0]["output_tokens"].as_f64().unwrap() - 50.0).abs() < 0.01
        );
        assert!((steps[0]["cost"].as_f64().unwrap() - 0.001).abs() < 0.00001);
        // Tool use at ts=3 attaches to the nearer usage (step 2 at ts=4).
        assert_eq!(steps[1]["step_index"].as_u64().unwrap(), 2);
        let tools = steps[1]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].as_str().unwrap(), "read");
    }

    #[test]
    fn test_build_session_steps_no_usage_no_steps() {
        let events = vec![msg("user", "hello", 1)];
        assert!(build_session_steps(&events, "ses-001").is_empty());
    }

    #[test]
    fn test_build_session_steps_restores_reason_fields() {
        // The step dict must carry the provider-reported reasoning tokens,
        // finish reason, message id and duration instead of placeholders.
        let events = vec![
            msg("user", "hello", 1),
            SessionEvent::Usage {
                input: 100,
                output: 50,
                cache_read: 30,
                cache_write: 10,
                cost: Some(0.001),
                timestamp: 2,
                reasoning: 12,
                reason: Some("completed".to_string()),
                message_id: Some("msg-9".to_string()),
                duration_ms: Some(80_000),
                model: Some("openai/gpt-4".to_string()),
            },
        ];
        let steps = build_session_steps(&events, "ses-001");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["message_id"].as_str().unwrap(), "msg-9");
        assert!(
            (steps[0]["reasoning_tokens"].as_f64().unwrap() - 12.0).abs()
                < 0.01
        );
        assert_eq!(steps[0]["reason"].as_str().unwrap(), "completed");
        assert_eq!(steps[0]["model"].as_str().unwrap(), "openai/gpt-4");
        // duration_ms → seconds in the step dict (80_000 ms = 80 s).
        assert!((steps[0]["duration"].as_f64().unwrap() - 80.0).abs() < 0.01);
    }

    #[test]
    fn test_build_session_steps_none_fields_placeholder() {
        // Missing reason/message_id keep the historical empty placeholders,
        // and an absent duration_ms leaves no duration key for the metrics
        // pass to fall back on.
        let events = vec![usage(2, 100, 50, 30, 10)];
        let steps = build_session_steps(&events, "ses-001");
        assert_eq!(steps[0]["message_id"].as_str().unwrap(), "");
        assert!(
            (steps[0]["reasoning_tokens"].as_f64().unwrap() - 0.0).abs() < 0.01
        );
        assert_eq!(steps[0]["reason"].as_str().unwrap(), "");
        assert!(steps[0].get("duration").is_none());
    }

    #[test]
    fn test_build_token_rows_from_usages() {
        let events = vec![
            msg("user", "prompt text", 1),
            msg("assistant", "first reply", 2),
            usage(2, 100, 50, 0, 0),
            msg("assistant", "second reply with a tool", 3),
            tool("read", 3),
            usage(3, 200, 100, 0, 0),
        ];
        let session = Session { meta: session_meta(), events };
        let rows = build_token_rows(&session);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["role"].as_str().unwrap(), "assistant");
        assert_eq!(rows[0]["tokens"].as_u64().unwrap(), 150);
        assert_eq!(rows[0]["preview"].as_str().unwrap(), "first reply");
        assert_eq!(rows[0]["segments"].as_u64().unwrap(), 0);
        assert_eq!(rows[1]["tokens"].as_u64().unwrap(), 300);
        assert_eq!(
            rows[1]["preview"].as_str().unwrap(),
            "second reply with a tool"
        );
        assert_eq!(rows[1]["segments"].as_u64().unwrap(), 1);
    }

    #[test]
    fn test_build_token_rows_empty_session() {
        let session = Session { meta: session_meta(), events: vec![] };
        assert!(build_token_rows(&session).is_empty());
    }

    #[test]
    fn test_build_token_rows_uses_real_message_id() {
        // Both providers fill `Usage.message_id`; it must win over the
        // synthetic `usage-N` id so the `zfind message <id>` cross-workflow
        // keeps working.
        let events = vec![SessionEvent::Usage {
            input: 100,
            output: 50,
            cache_read: 0,
            cache_write: 0,
            cost: Some(0.001),
            timestamp: 2,
            reasoning: 0,
            reason: None,
            message_id: Some("msg-9".to_string()),
            duration_ms: None,
            model: None,
        }];
        let session = Session { meta: session_meta(), events };
        let rows = build_token_rows(&session);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"].as_str().unwrap(), "msg-9");
    }

    #[test]
    fn test_build_token_rows_falls_back_to_synthetic_id() {
        // A usage without a message id keeps the historical `usage-N` id.
        let session = Session {
            meta: session_meta(),
            events: vec![usage(2, 100, 50, 0, 0)],
        };
        let rows = build_token_rows(&session);
        assert_eq!(rows[0]["id"].as_str().unwrap(), "usage-1");
    }
}
