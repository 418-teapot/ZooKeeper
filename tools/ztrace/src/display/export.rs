// ztrace display — JSON output for steps and tokens.

use std::collections::HashMap;

use serde_json::{Map, Number, Value, json};

// ── C. Export — Steps JSON ────────────────────────────────────────────────────

/// Build a single JSON object for one step row.
fn build_step_json_row(
    s: &Value,
    hook_overlays: &HashMap<i64, Vec<String>>,
) -> Value {
    let di = s
        .get("_display_index")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let mut m = Map::new();
    m.insert("step".to_string(), Value::Number(Number::from(di)));
    m.insert(
        "session_id".to_string(),
        s.get("_session_id")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    if let Some(v) = s.get("cache_read") {
        m.insert("cache_read".to_string(), v.clone());
    }
    if let Some(v) = s.get("delta_cache") {
        m.insert("delta_cache".to_string(), v.clone());
    }
    if let Some(v) = s.get("input_tokens") {
        m.insert("input_tokens".to_string(), v.clone());
    }
    if let Some(v) = s.get("output_tokens") {
        m.insert("output_tokens".to_string(), v.clone());
    }
    if let Some(v) = s.get("reasoning_tokens") {
        m.insert("reasoning_tokens".to_string(), v.clone());
    }
    let cache_pct =
        s.get("cache_pct").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    m.insert(
        "cache_pct".to_string(),
        Value::Number(
            Number::from_f64(cache_pct)
                .unwrap_or_else(|| Number::from_f64(0.0).unwrap()),
        ),
    );
    let duration =
        s.get("duration").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    m.insert(
        "duration_sec".to_string(),
        Value::Number(
            Number::from_f64(duration)
                .unwrap_or_else(|| Number::from_f64(0.0).unwrap()),
        ),
    );
    let hooks = hook_overlays.get(&di);
    m.insert(
        "hooks".to_string(),
        Value::Array(
            hooks
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    m.insert(
        "tools".to_string(),
        s.get("tools").cloned().unwrap_or(Value::Array(vec![])),
    );
    m.insert(
        "reason".to_string(),
        s.get("reason")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    m.insert(
        "time_created".to_string(),
        s.get("time_created")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    m.insert(
        "time_updated".to_string(),
        s.get("time_updated")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    Value::Object(m)
}

/// Compute the JSON summary object for steps output.
fn compute_steps_json_summary(
    steps: &[Value],
    hook_overlays: &HashMap<i64, Vec<String>>,
) -> Value {
    let n = f64::from(u32::try_from(steps.len()).unwrap_or(0));
    let total_input: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("input_tokens").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_output: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("output_tokens").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let total_cache_read: f64 = steps
        .iter()
        .filter_map(|s| s.get("cache_read").and_then(serde_json::Value::as_f64))
        .sum();
    let total_cache_delta: f64 = steps
        .iter()
        .filter_map(|s| {
            s.get("delta_cache").and_then(serde_json::Value::as_f64)
        })
        .sum();
    let avg_hit: f64 = if n > 0.0 {
        steps
            .iter()
            .filter_map(|s| {
                s.get("cache_pct").and_then(serde_json::Value::as_f64)
            })
            .sum::<f64>()
            / n
    } else {
        0.0
    };
    let total_dur: f64 = steps
        .iter()
        .filter_map(|s| s.get("duration").and_then(serde_json::Value::as_f64))
        .sum();
    let total_hooks: usize =
        hook_overlays.values().map(std::vec::Vec::len).sum();
    let total_tools: usize = steps
        .iter()
        .filter_map(|s| s.get("tools").and_then(|v| v.as_array()))
        .map(std::vec::Vec::len)
        .sum();

    json!({
        "total_steps": steps.len(),
        "total_input": total_input,
        "total_output": total_output,
        "total_cache_read": total_cache_read,
        "total_cache_delta": total_cache_delta,
        "avg_hit_rate": (avg_hit * 100.0).round() / 100.0,
        "total_duration_sec": (total_dur * 100.0).round() / 100.0,
        "total_hooks": total_hooks,
        "total_tools": total_tools,
    })
}

/// Output steps data as JSON.
pub fn output_steps_json(
    steps: &[Value],
    hook_overlays: &HashMap<i64, Vec<String>>,
) {
    let rows: Vec<Value> =
        steps.iter().map(|s| build_step_json_row(s, hook_overlays)).collect();
    let summary = compute_steps_json_summary(steps, hook_overlays);
    let output = json!({ "steps": rows, "summary": summary });
    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("JSON serialization")
    );
}

// ── C. Export — Tokens JSON ───────────────────────────────────────────────────

/// Output token distribution as JSON.
pub fn output_tokens_json(rows: &[Value]) {
    let total: f64 = rows
        .iter()
        .filter_map(|r| r.get("tokens").and_then(serde_json::Value::as_f64))
        .sum();
    let mut by_role: HashMap<String, f64> = HashMap::new();
    for r in rows {
        let role = r
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let tokens =
            r.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        *by_role.entry(role).or_insert(0.0) += tokens;
    }

    let by_role_json: Value = {
        let mut m = Map::new();
        for (role, count) in &by_role {
            m.insert(
                role.clone(),
                Value::Number(
                    Number::from_f64(*count).unwrap_or_else(|| Number::from(0)),
                ),
            );
        }
        Value::Object(m)
    };

    let mut sorted_rows: Vec<&Value> = rows.iter().collect();
    sorted_rows.sort_by(|a, b| {
        let ta =
            a.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let tb =
            b.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    let largest: Vec<Value> = sorted_rows
        .iter()
        .take(3)
        .map(|r| {
            let mut m = Map::new();
            m.insert(
                "tokens".to_string(),
                r.get("tokens")
                    .cloned()
                    .unwrap_or_else(|| Value::Number(Number::from(0))),
            );
            m.insert(
                "role".to_string(),
                r.get("role")
                    .cloned()
                    .unwrap_or_else(|| Value::String("?".to_string())),
            );
            m.insert(
                "id".to_string(),
                r.get("id")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
            Value::Object(m)
        })
        .collect();

    let empty_count = rows
        .iter()
        .filter(|r| {
            r.get("tokens").and_then(serde_json::Value::as_f64).unwrap_or(0.0)
                == 0.0
        })
        .count();
    let avg_tokens = if rows.is_empty() {
        0.0
    } else {
        total / f64::from(u32::try_from(rows.len()).unwrap_or(0))
    };
    let max_tokens = rows
        .iter()
        .filter_map(|r| r.get("tokens").and_then(serde_json::Value::as_f64))
        .fold(0.0_f64, f64::max);

    let output = json!({
        "messages": rows,
        "summary": {
            "total_tokens": total,
            "by_role": by_role_json,
            "avg_tokens_per_msg": (avg_tokens * 10.0).round() / 10.0,
            "max_tokens": max_tokens,
            "empty_parts_count": empty_count,
            "largest_messages": largest,
        },
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("JSON serialization")
    );
}
