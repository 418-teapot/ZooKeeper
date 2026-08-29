// Display-preprocessing helper functions for ztrace.
//
// Each function operates on `serde_json::Value` event/timeline dicts or on
// the host-agnostic session provider.

use std::collections::HashMap;
use std::io;

use serde_json::{Map, Number, Value};

use zutil::iso_to_epoch_ms;
use zutil::session::SessionProvider;

// ── cache_bar ───────────────────────────────────────────────────────────────

/// Render a cache hit rate bar.
///
/// Each `█` = 100/width percentage points.  Sub-steps: ▏▎▍▌▋▊▉ (each = 1/8 of
/// block).  Remaining width filled with `░`.  Width defaults to 20.
#[must_use]
pub fn cache_bar(pct: f64, width: usize) -> String {
    let width = if width == 0 { 20 } else { width };
    let pct = pct.clamp(0.0, 100.0);

    // Convert width to f64 via u32 to avoid clippy::cast_precision_loss
    // (u32→f64 is exact; width for a bar display is always small).
    let safe_w = u32::try_from(width).unwrap_or(20);
    let step = 100.0 / f64::from(safe_w);

    let mut bar = String::with_capacity(width);
    let mut next_threshold = step;

    for _ in 0..width {
        if pct >= next_threshold {
            bar.push('█');
        } else if pct >= next_threshold - step {
            let frac = (pct - (next_threshold - step)) / step; // [0, 1)
            let scaled = frac * 8.0;
            // Compare f64 thresholds to pick the right fractional character
            // instead of casting to an integer index.
            if scaled >= 7.0 {
                bar.push('▉');
            } else if scaled >= 6.0 {
                bar.push('▊');
            } else if scaled >= 5.0 {
                bar.push('▋');
            } else if scaled >= 4.0 {
                bar.push('▌');
            } else if scaled >= 3.0 {
                bar.push('▍');
            } else if scaled >= 2.0 {
                bar.push('▎');
            } else if scaled >= 1.0 {
                bar.push('▏');
            } else {
                bar.push('░');
            }
        } else {
            bar.push('░');
        }
        next_threshold += step;
    }

    bar
}

// ── match_hooks_to_steps ────────────────────────────────────────────────────

/// Match zoo hook events to steps by timestamp proximity.
///
/// A hook belongs to step *N* if its timestamp falls between
/// `step[N-1].time_created` and `step[N].time_created` (steps must have
/// `_display_index` and `time_created` keys).  Returns a `HashMap` mapping
/// `display_index` → list of hook names.
///
/// Timestamps from zoo logs may have no sub-second precision
/// (e.g. `2024-05-06T12:53:30Z`) while DB step timestamps use 6-digit
/// microsecond precision (`2024-05-06T12:53:30.000000Z`).  Both are
/// normalised to epoch milliseconds via `iso_to_epoch_ms` before
/// comparison to avoid string-ordering fence-post errors.
#[must_use]
pub fn match_hooks_to_steps(
    steps: &[Value],
    zoo_events: &[Value],
) -> HashMap<i64, Vec<String>> {
    let mut result: HashMap<i64, Vec<String>> = HashMap::new();

    for ev in zoo_events {
        let hook = ev.get("hook").and_then(|v| v.as_str()).unwrap_or("");
        if hook.is_empty() {
            continue;
        }
        let ts = ev.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let ts_ms = iso_to_epoch_ms(ts);

        let mut matched = false;
        for (i, step) in steps.iter().enumerate() {
            let di = step
                .get("_display_index")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0);
            let step_start =
                step.get("time_created").and_then(|v| v.as_str()).unwrap_or("");
            let step_start_ms = iso_to_epoch_ms(step_start);

            if i == 0 {
                if ts_ms <= step_start_ms {
                    result.entry(di).or_default().push(hook.to_string());
                    matched = true;
                    break;
                }
            } else {
                let prev_end = steps[i - 1]
                    .get("time_created")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let prev_end_ms = iso_to_epoch_ms(prev_end);
                if prev_end_ms < ts_ms && ts_ms <= step_start_ms {
                    result.entry(di).or_default().push(hook.to_string());
                    matched = true;
                    break;
                }
            }
        }

        // Hook after the last step
        if !matched && !steps.is_empty() {
            let last_di = steps
                .last()
                .and_then(|s| {
                    s.get("_display_index").and_then(serde_json::Value::as_i64)
                })
                .unwrap_or(0);
            let last_ts = steps
                .last()
                .and_then(|s| s.get("time_created").and_then(|v| v.as_str()))
                .unwrap_or("");
            let last_ts_ms = iso_to_epoch_ms(last_ts);
            if ts_ms > last_ts_ms {
                result.entry(last_di).or_default().push(hook.to_string());
            }
        }
    }

    result
}

// ── build_model_map ─────────────────────────────────────────────────────────

/// Build a parallel list of active model names for each timeline index.
///
/// Walks the timeline and tracks the most recent LLM model name.
/// For LLM events: uses `detail.model`.  For session events: uses
/// `detail.model_id` or `detail.model`.  Returns parallel `Vec` of active
/// model names for each index (empty string before any model is known).
#[must_use]
pub fn build_model_map(timeline: &[Value]) -> Vec<String> {
    let mut current = String::new();
    let mut models: Vec<String> = Vec::with_capacity(timeline.len());

    for e in timeline {
        let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match etype {
            "llm" => {
                if let Some(detail) =
                    e.get("detail").and_then(|v| v.as_object())
                    && let Some(m) = detail
                        .get("model")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                {
                    current = m.to_string();
                }
            }
            "session" => {
                if let Some(detail) =
                    e.get("detail").and_then(|v| v.as_object())
                {
                    let m = detail
                        .get("model_id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .or_else(|| {
                            detail.get("model").and_then(|v| v.as_str())
                        })
                        .unwrap_or("");
                    if !m.is_empty() && current.is_empty() {
                        current = m.to_string();
                    }
                }
            }
            // A usage event records the model that produced one concrete
            // LLM turn, so it both seeds the column for host-less sessions
            // (pi) and tracks mid-session model switches.
            "usage" => {
                if let Some(detail) =
                    e.get("detail").and_then(|v| v.as_object())
                    && let Some(m) = detail
                        .get("model")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                {
                    current = m.to_string();
                }
            }
            _ => {}
        }
        models.push(current.clone());
    }

    models
}

// ── find_session_info ───────────────────────────────────────────────────────

/// Find the first session event with a `slug` in the timeline.
///
/// Returns a dict with `slug`, `agent`, `model` (from `model_id`/`model`),
/// `provider` (from `model_provider`/`provider`), `project_id`, `title`.
/// Returns `None` if no qualifying session event is found.
#[must_use]
pub fn find_session_info(timeline: &[Value]) -> Option<Value> {
    for e in timeline {
        if e.get("type").and_then(|v| v.as_str()) != Some("session") {
            continue;
        }
        let detail = e.get("detail").and_then(|v| v.as_object())?;
        let slug = detail.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        if slug.is_empty() {
            continue;
        }

        let mut m = Map::new();
        m.insert("slug".to_string(), Value::String(slug.to_string()));
        m.insert(
            "agent".to_string(),
            Value::String(
                detail
                    .get("agent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        m.insert(
            "model".to_string(),
            Value::String(
                detail
                    .get("model_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| detail.get("model").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        m.insert(
            "provider".to_string(),
            Value::String(
                detail
                    .get("model_provider")
                    .and_then(|v| v.as_str())
                    .or_else(|| detail.get("provider").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        m.insert(
            "project_id".to_string(),
            Value::String(
                detail
                    .get("project_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        m.insert(
            "title".to_string(),
            Value::String(
                detail
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
        );

        return Some(Value::Object(m));
    }

    None
}

// ── collect_child_sessions_info ─────────────────────────────────────────────

/// Collect per-child-session stats from a timeline.
///
/// Returns a list of dicts with: `session_id`, `depth`, `agent` (from
/// `session_agent`), `event_count`.  Sorted by `depth` then `session_id`.
#[must_use]
pub fn collect_child_sessions_info(
    timeline: &[Value],
    root_session_id: &str,
) -> Vec<Value> {
    // session_id → (depth, agent, event_count)
    let mut seen: HashMap<String, (i64, String, i64)> = HashMap::new();

    for e in timeline {
        let sid = e.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        if sid.is_empty() || sid == root_session_id {
            continue;
        }

        let entry = seen.entry(sid.to_string()).or_insert_with(|| {
            let depth =
                e.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
            let agent = e
                .get("session_agent")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            (depth, agent, 0)
        });
        entry.2 += 1;
    }

    let mut result: Vec<Value> = seen
        .into_iter()
        .map(|(sid, (depth, agent, count))| {
            let mut m = Map::new();
            m.insert("session_id".to_string(), Value::String(sid));
            m.insert("depth".to_string(), Value::Number(Number::from(depth)));
            m.insert("agent".to_string(), Value::String(agent));
            m.insert(
                "event_count".to_string(),
                Value::Number(Number::from(count)),
            );
            Value::Object(m)
        })
        .collect();

    result.sort_by(|a, b| {
        let a_depth =
            a.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
        let b_depth =
            b.get("depth").and_then(serde_json::Value::as_i64).unwrap_or(0);
        let a_sid = a.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        let b_sid = b.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        a_depth.cmp(&b_depth).then_with(|| a_sid.cmp(b_sid))
    });

    result
}

// ── attach_durations ────────────────────────────────────────────────────────

/// Attach `duration_sec` to timeline events IN-PLACE.
///
/// **Phase 1**: For `tool_*` events with `detail.duration_sec` already set
/// (embedded by the timeline builder from the `ToolUse`/`ToolResult`
/// timestamp delta, or by the opencode log evaluation events), forward
/// them to the top level.
///
/// **Phase 3**: For `assistant_reply` events, match the provider-reported
/// usage duration (`detail.duration_ms` on the `usage` event billing that
/// turn) back through the shared `message_id`, so `OpenCode` reply lines
/// display `[x.xs]` and `pi` (which records no duration) shows none.
pub fn attach_durations(timeline: &mut [Value]) {
    phase1_forward_durations(timeline);
    phase3_match_message_durations(timeline);
}

/// Phase 1: Forward tool durations from detail.
fn phase1_forward_durations(timeline: &mut [Value]) {
    for e in timeline.iter_mut() {
        let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype.starts_with("tool_")
            && let Some(dur) = e
                .get("detail")
                .and_then(|d| d.get("duration_sec"))
                .and_then(serde_json::Value::as_f64)
            && let Some(obj) = e.as_object_mut()
            && let Some(num) = Number::from_f64(dur)
        {
            obj.insert("duration_sec".to_string(), Value::Number(num));
        }
    }
}

/// Phase 3: Attach provider-reported LLM durations to assistant replies.
///
/// A `usage` timeline event bills one assistant turn and, when the host
/// recorded one, exports `detail.message_id` plus `detail.duration_ms`
/// (`OpenCode` reports a real per-message duration; `pi` reports none).
/// Match that duration back to the `assistant_reply` row carrying the
/// same message id so the message line displays `[x.xs]`.
fn phase3_match_message_durations(timeline: &mut [Value]) {
    let mut durations: HashMap<String, f64> = HashMap::new();
    for e in timeline.iter() {
        if e.get("type").and_then(|v| v.as_str()) != Some("usage") {
            continue;
        }
        let Some(detail) = e.get("detail").and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(mid) = detail.get("message_id").and_then(|v| v.as_str())
        else {
            continue;
        };
        let Some(dur_ms) =
            detail.get("duration_ms").and_then(serde_json::Value::as_i64)
        else {
            continue;
        };
        if dur_ms <= 0 {
            continue;
        }
        // Durations fit an i32; convert via f64::from(i32) which loses no
        // precision (crate-wide convention for this conversion).
        let dur = f64::from(i32::try_from(dur_ms).unwrap_or(0)) / 1000.0;
        durations.insert(mid.to_string(), dur);
    }
    for e in timeline.iter_mut() {
        if e.get("type").and_then(|v| v.as_str()) != Some("assistant_reply") {
            continue;
        }
        let Some(mid) = e.get("message_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(dur) = durations.get(mid).copied() else {
            continue;
        };
        if let Some(obj) = e.as_object_mut()
            && let Some(num) = Number::from_f64(dur)
        {
            obj.insert("duration_sec".to_string(), Value::Number(num));
        }
    }
}

// ── discover_child_sessions ─────────────────────────────────────────────────

/// Discover child sessions transitively from the provider's session list.
///
/// Builds a `parent_id → [child ids]` map from [`SessionMeta::parent_id`]
/// and BFS-traverses from `root_session_id`. Returns `(session_id, depth)`
/// pairs including the direct children (depth 1), grandchildren (depth 2),
/// and so on, in discovery order.
///
/// # Errors
///
/// Returns an I/O error when the provider cannot list its sessions.
pub fn discover_child_sessions(
    provider: &dyn SessionProvider,
    root_session_id: &str,
) -> io::Result<Vec<(String, i64)>> {
    let metas = provider.list()?;
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for meta in &metas {
        if let Some(parent) = &meta.parent_id {
            children.entry(parent.clone()).or_default().push(meta.id.clone());
        }
    }

    let mut out: Vec<(String, i64)> = Vec::new();
    let mut queue: std::collections::VecDeque<(String, i64)> =
        std::collections::VecDeque::new();
    let mut visited: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    queue.push_back((root_session_id.to_string(), 0));
    visited.insert(root_session_id.to_string());

    while let Some((current, depth)) = queue.pop_front() {
        if let Some(child_list) = children.get(&current) {
            for child in child_list {
                if visited.insert(child.clone()) {
                    let entry = (child.clone(), depth + 1);
                    out.push(entry.clone());
                    queue.push_back(entry);
                }
            }
        }
    }
    Ok(out)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── cache_bar ───────────────────────────────────────────────────────

    #[test]
    fn test_cache_bar_zero() {
        let bar = cache_bar(0.0, 20);
        assert_eq!(bar.chars().count(), 20);
        assert!(bar.chars().all(|c| c == '░'));
    }

    #[test]
    fn test_cache_bar_full() {
        let bar = cache_bar(100.0, 20);
        assert_eq!(bar.chars().count(), 20);
        assert!(bar.chars().all(|c| c == '█'));
    }

    #[test]
    fn test_cache_bar_half() {
        let bar = cache_bar(50.0, 20);
        assert_eq!(bar.chars().count(), 20);
        // 50% = 10 full blocks
        let filled: usize = bar.chars().take_while(|&c| c == '█').count();
        assert_eq!(filled, 10);
    }

    #[test]
    fn test_cache_bar_with_partial() {
        // 50.0 / 5.0 = 10 full blocks, then test a fractional value
        let bar = cache_bar(51.0, 20);
        assert_eq!(bar.chars().count(), 20);
        // 51%: full = 10, remainder = 1.0, frac_idx = 1 -> ▏
        let filled: usize = bar.chars().take_while(|&c| c == '█').count();
        assert_eq!(filled, 10);
        let remaining: String =
            bar.chars().skip(filled).take_while(|&c| c != '░').collect();
        assert_eq!(remaining, "▏");
    }

    #[test]
    fn test_cache_bar_exact_partial_eighth() {
        // 50.0 + 5.0/8 = 50.625%: frac_idx = 1 -> ▏
        let bar = cache_bar(50.625, 20);
        assert_eq!(bar.chars().count(), 20);
        let filled: usize = bar.chars().take_while(|&c| c == '█').count();
        assert_eq!(filled, 10);
        let remaining: String =
            bar.chars().skip(filled).take_while(|&c| c != '░').collect();
        assert_eq!(remaining, "▏");
    }

    #[test]
    fn test_cache_bar_width_default() {
        let bar = cache_bar(50.0, 0);
        assert_eq!(bar.chars().count(), 20);
        // 50% of 20 = 10 full blocks
        let filled: usize = bar.chars().take_while(|&c| c == '█').count();
        assert_eq!(filled, 10);
    }

    #[test]
    fn test_cache_bar_custom_width() {
        let bar = cache_bar(50.0, 10);
        assert_eq!(bar.chars().count(), 10);
        // 50% of 10 = 5 full blocks
        let filled: usize = bar.chars().take_while(|&c| c == '█').count();
        assert_eq!(filled, 5);
    }

    #[test]
    fn test_cache_bar_over_full() {
        let bar = cache_bar(150.0, 20);
        assert_eq!(bar.chars().count(), 20);
        assert!(bar.chars().all(|c| c == '█'));
    }

    // ── match_hooks_to_steps ────────────────────────────────────────────

    fn make_step(display_index: i64, time_created: &str) -> Value {
        let mut m = Map::new();
        m.insert(
            "_display_index".to_string(),
            Value::Number(Number::from(display_index)),
        );
        m.insert(
            "time_created".to_string(),
            Value::String(time_created.to_string()),
        );
        Value::Object(m)
    }

    fn make_hook_event(hook: &str, timestamp: &str) -> Value {
        let mut m = Map::new();
        m.insert("hook".to_string(), Value::String(hook.to_string()));
        m.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
        Value::Object(m)
    }

    #[test]
    fn test_match_hooks_before_first_step() {
        let steps = vec![make_step(1, "2025-01-09T12:34:56Z")];
        let events = vec![make_hook_event("pre-hook", "2025-01-09T12:34:55Z")];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&1);
        assert!(hooks.is_some());
        assert_eq!(hooks.unwrap().len(), 1);
        assert_eq!(hooks.unwrap()[0], "pre-hook");
    }

    #[test]
    fn test_match_hooks_between_steps() {
        let steps = vec![
            make_step(1, "2025-01-09T12:34:56Z"),
            make_step(2, "2025-01-09T12:35:00Z"),
        ];
        let events = vec![make_hook_event("mid-hook", "2025-01-09T12:34:58Z")];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&2);
        assert!(hooks.is_some());
        assert_eq!(hooks.unwrap()[0], "mid-hook");
    }

    #[test]
    fn test_match_hooks_after_last_step() {
        let steps = vec![make_step(1, "2025-01-09T12:34:56Z")];
        let events = vec![make_hook_event("post-hook", "2025-01-09T12:35:00Z")];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&1);
        assert!(hooks.is_some());
        assert_eq!(hooks.unwrap()[0], "post-hook");
    }

    #[test]
    fn test_match_hooks_no_hook_field() {
        let steps = vec![make_step(1, "2025-01-09T12:34:56Z")];
        let events = vec![{
            let mut m = Map::new();
            m.insert(
                "timestamp".to_string(),
                Value::String("2025-01-09T12:34:55Z".to_string()),
            );
            Value::Object(m)
        }];

        let result = match_hooks_to_steps(&steps, &events);
        assert!(result.is_empty());
    }

    #[test]
    fn test_match_hooks_multiple() {
        let steps = vec![make_step(1, "2025-01-09T12:34:56Z")];
        let events = vec![
            make_hook_event("hook-a", "2025-01-09T12:34:55Z"),
            make_hook_event("hook-b", "2025-01-09T12:34:50Z"),
        ];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&1);
        assert!(hooks.is_some());
        assert_eq!(hooks.unwrap().len(), 2);
    }

    #[test]
    fn test_match_hooks_fence_post_same_second() {
        // Hook timestamp is "2024-05-06T12:53:30Z" (no sub-second precision).
        // Step 1 timestamp is "2024-05-06T12:53:30.000000Z" (6-digit microsecond).
        // These represent the same moment, but string comparison would fail:
        // 'Z'(0x5A) > '.'(0x2E) at position 19, making the hook appear AFTER.
        let steps = vec![
            make_step(1, "2024-05-06T12:53:30.000000Z"),
            make_step(2, "2024-05-06T12:53:31.000000Z"),
        ];
        let events =
            vec![make_hook_event("same-sec-hook", "2024-05-06T12:53:30Z")];

        let result = match_hooks_to_steps(&steps, &events);
        // Should match to step 1 (ts == step_start at same second)
        let hooks = result.get(&1);
        assert!(hooks.is_some(), "hook should match step 1");
        assert_eq!(hooks.unwrap()[0], "same-sec-hook");
        // Should NOT be in step 2
        assert!(!result.contains_key(&2), "hook should NOT match step 2");
    }

    #[test]
    fn test_match_hooks_fence_post_mixed_formats() {
        // Hook ts = "2024-05-06T12:53:30Z" (second-only)
        // Step 1: "2024-05-06T12:53:29.123456Z"
        // Step 2: "2024-05-06T12:53:30.000000Z"
        // Hook at 12:53:30 should match step 2 (prev_end < ts <= step_start).
        // String compare would fail: "29.123456Z" > "30Z" because '9' > '0'.
        let steps = vec![
            make_step(1, "2024-05-06T12:53:29.123456Z"),
            make_step(2, "2024-05-06T12:53:30.000000Z"),
        ];
        let events =
            vec![make_hook_event("fence-hook", "2024-05-06T12:53:30Z")];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&2);
        assert!(hooks.is_some(), "hook should match step 2");
        assert_eq!(hooks.unwrap()[0], "fence-hook");
        assert!(!result.contains_key(&1), "hook should NOT match step 1");
    }

    #[test]
    fn test_match_hooks_fence_post_after_last() {
        // Hook after last step with mixed formats
        let steps = vec![make_step(1, "2024-05-06T12:53:30.000000Z")];
        let events = vec![make_hook_event("post-hook", "2024-05-06T12:53:31Z")];

        let result = match_hooks_to_steps(&steps, &events);
        let hooks = result.get(&1);
        assert!(hooks.is_some(), "post-hook should match step 1");
        assert_eq!(hooks.unwrap()[0], "post-hook");
    }

    // ── build_model_map ─────────────────────────────────────────────────

    fn make_llm_event(model: &str) -> Value {
        let mut detail = Map::new();
        detail.insert("model".to_string(), Value::String(model.to_string()));
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("llm".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));
        Value::Object(m)
    }

    fn make_session_event(
        model_id: Option<&str>,
        model: Option<&str>,
    ) -> Value {
        let mut detail = Map::new();
        if let Some(mid) = model_id {
            detail
                .insert("model_id".to_string(), Value::String(mid.to_string()));
        }
        if let Some(m) = model {
            detail.insert("model".to_string(), Value::String(m.to_string()));
        }
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("session".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));
        Value::Object(m)
    }

    fn make_other_event() -> Value {
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("tool_read".to_string()));
        Value::Object(m)
    }

    #[test]
    fn test_build_model_map_empty() {
        let result = build_model_map(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_build_model_map_no_model_events() {
        let timeline = vec![make_other_event(), make_other_event()];
        let result = build_model_map(&timeline);
        assert_eq!(result.len(), 2);
        assert!(result[0].is_empty());
        assert!(result[1].is_empty());
    }

    #[test]
    fn test_build_model_map_llm_sets_model() {
        let timeline: Vec<Value> = vec![
            make_other_event(),
            make_llm_event("gpt-4"),
            make_other_event(),
        ];

        let result = build_model_map(&timeline);
        assert_eq!(result.len(), 3);
        assert!(result[0].is_empty());
        assert_eq!(result[1], "gpt-4");
        assert_eq!(result[2], "gpt-4");
    }

    #[test]
    fn test_build_model_map_session_sets_model_when_empty() {
        let timeline: Vec<Value> = vec![
            make_session_event(Some("claude-3"), None),
            make_other_event(),
        ];

        let result = build_model_map(&timeline);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "claude-3");
        assert_eq!(result[1], "claude-3");
    }

    #[test]
    fn test_build_model_map_session_model_does_not_override() {
        let timeline: Vec<Value> = vec![
            make_session_event(Some("claude-3"), None),
            make_llm_event("gpt-4"),
            // Session after LLM should not override
            make_session_event(Some("claude-3.5"), None),
        ];

        let result = build_model_map(&timeline);
        assert_eq!(result[0], "claude-3");
        assert_eq!(result[1], "gpt-4");
        assert_eq!(result[2], "gpt-4"); // not overridden
    }

    #[test]
    fn test_build_model_map_llm_with_empty_model() {
        let timeline: Vec<Value> = vec![
            make_llm_event(""), // empty model should not set
            make_llm_event("gpt-4"),
        ];

        let result = build_model_map(&timeline);
        assert!(result[0].is_empty());
        assert_eq!(result[1], "gpt-4");
    }

    #[test]
    fn test_build_model_map_session_model_id_fallback() {
        // session with model (not model_id) should work when no model_id
        let timeline: Vec<Value> =
            vec![make_session_event(None, Some("gpt-4"))];

        let result = build_model_map(&timeline);
        assert_eq!(result[0], "gpt-4");
    }

    fn make_usage_event(model: &str) -> Value {
        let mut detail = Map::new();
        detail.insert("model".to_string(), Value::String(model.to_string()));
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("usage".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));
        Value::Object(m)
    }

    #[test]
    fn test_build_model_map_usage_seeds_and_switches_model() {
        // A usage event (pi host has no lifecycle events) seeds the model
        // column, and a later usage with a different model switches it.
        let timeline: Vec<Value> = vec![
            make_usage_event("MoonShot/k3-256k"),
            make_other_event(),
            make_usage_event("MoonShot/k3-1024k"),
        ];
        let result = build_model_map(&timeline);
        assert_eq!(result[0], "MoonShot/k3-256k");
        assert_eq!(result[1], "MoonShot/k3-256k");
        assert_eq!(result[2], "MoonShot/k3-1024k");
    }

    // ── find_session_info ───────────────────────────────────────────────

    fn make_session_event_with_slug(
        slug: &str,
        agent: &str,
        model_id: Option<&str>,
        model: Option<&str>,
        provider: Option<&str>,
        title: &str,
    ) -> Value {
        let mut detail = Map::new();
        detail.insert("slug".to_string(), Value::String(slug.to_string()));
        detail.insert("agent".to_string(), Value::String(agent.to_string()));
        if let Some(mid) = model_id {
            detail
                .insert("model_id".to_string(), Value::String(mid.to_string()));
        }
        if let Some(m) = model {
            detail.insert("model".to_string(), Value::String(m.to_string()));
        }
        if let Some(p) = provider {
            detail.insert(
                "model_provider".to_string(),
                Value::String(p.to_string()),
            );
        }
        detail.insert(
            "project_id".to_string(),
            Value::String("proj-1".to_string()),
        );
        detail.insert("title".to_string(), Value::String(title.to_string()));

        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("session".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));
        Value::Object(m)
    }

    #[test]
    fn test_find_session_info_found() {
        let timeline = vec![make_session_event_with_slug(
            "auth-debug",
            "beaver",
            Some("gpt-4"),
            None,
            Some("openai"),
            "Auth Debug Session",
        )];

        let info = find_session_info(&timeline);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(
            info.get("slug").and_then(|v| v.as_str()),
            Some("auth-debug")
        );
        assert_eq!(info.get("agent").and_then(|v| v.as_str()), Some("beaver"));
        assert_eq!(info.get("model").and_then(|v| v.as_str()), Some("gpt-4"));
        assert_eq!(
            info.get("provider").and_then(|v| v.as_str()),
            Some("openai")
        );
        assert_eq!(
            info.get("project_id").and_then(|v| v.as_str()),
            Some("proj-1")
        );
        assert_eq!(
            info.get("title").and_then(|v| v.as_str()),
            Some("Auth Debug Session")
        );
    }

    #[test]
    fn test_find_session_info_not_found() {
        let timeline = vec![];
        assert!(find_session_info(&timeline).is_none());
    }

    #[test]
    fn test_find_session_info_no_slug() {
        let mut detail = Map::new();
        detail.insert("agent".to_string(), Value::String("beaver".to_string()));
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("session".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));

        let timeline = vec![Value::Object(m)];
        assert!(find_session_info(&timeline).is_none());
    }

    #[test]
    fn test_find_session_info_skips_non_session() {
        let timeline = vec![{
            let mut m = Map::new();
            m.insert("type".to_string(), Value::String("llm".to_string()));
            m.insert(
                "detail".to_string(),
                Value::Object({
                    let mut d = Map::new();
                    d.insert(
                        "slug".to_string(),
                        Value::String("test".to_string()),
                    );
                    d
                }),
            );
            Value::Object(m)
        }];
        assert!(find_session_info(&timeline).is_none());
    }

    #[test]
    fn test_find_session_info_model_fallback() {
        let timeline = vec![make_session_event_with_slug(
            "test",
            "beaver",
            None,
            Some("claude-3"),
            None,
            "Test",
        )];

        let info = find_session_info(&timeline);
        assert!(info.is_some());
        assert_eq!(
            info.unwrap().get("model").and_then(|v| v.as_str()),
            Some("claude-3")
        );
    }

    // ── collect_child_sessions_info ─────────────────────────────────────

    fn make_event(session_id: &str, depth: i64, agent: &str) -> Value {
        let mut m = Map::new();
        m.insert(
            "session_id".to_string(),
            Value::String(session_id.to_string()),
        );
        m.insert("depth".to_string(), Value::Number(Number::from(depth)));
        m.insert("session_agent".to_string(), Value::String(agent.to_string()));
        Value::Object(m)
    }

    #[test]
    fn test_collect_child_sessions_empty() {
        let result = collect_child_sessions_info(&[], "ses-001");
        assert!(result.is_empty());
    }

    #[test]
    fn test_collect_child_sessions_excludes_root() {
        let timeline = vec![
            make_event("ses-001", 0, "beaver"),
            make_event("ses-001", 0, "beaver"),
        ];
        let result = collect_child_sessions_info(&timeline, "ses-001");
        assert!(result.is_empty());
    }

    #[test]
    fn test_collect_child_sessions_counts_events() {
        let timeline = vec![
            make_event("ses-002", 1, "lynx"),
            make_event("ses-002", 1, "lynx"),
            make_event("ses-003", 2, "dolphin"),
        ];
        let result = collect_child_sessions_info(&timeline, "ses-001");
        assert_eq!(result.len(), 2);

        // Sorted by depth then session_id: ses-002 (depth 1), ses-003 (depth 2)
        assert_eq!(
            result[0].get("session_id").and_then(|v| v.as_str()),
            Some("ses-002")
        );
        assert_eq!(
            result[0].get("event_count").and_then(serde_json::Value::as_i64),
            Some(2)
        );
        assert_eq!(
            result[1].get("session_id").and_then(|v| v.as_str()),
            Some("ses-003")
        );
        assert_eq!(
            result[1].get("event_count").and_then(serde_json::Value::as_i64),
            Some(1)
        );
    }

    #[test]
    fn test_collect_child_sessions_agent_default() {
        let mut m = Map::new();
        m.insert(
            "session_id".to_string(),
            Value::String("ses-002".to_string()),
        );
        m.insert("depth".to_string(), Value::Number(Number::from(1)));
        // No session_agent field
        let timeline = vec![Value::Object(m)];
        let result = collect_child_sessions_info(&timeline, "ses-001");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].get("agent").and_then(|v| v.as_str()), Some("?"));
    }

    // ── attach_durations (Phase 1 + Phase 3, no DB) ────────────────────

    #[test]
    fn test_attach_durations_phase1_keeps_existing() {
        let mut detail = Map::new();
        detail.insert(
            "duration_sec".to_string(),
            serde_json::Number::from_f64(1.5)
                .map_or(Value::Null, Value::Number),
        );
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String("tool_read".to_string()));
        ev.insert("detail".to_string(), Value::Object(detail));

        let mut timeline = vec![Value::Object(ev)];
        attach_durations(&mut timeline);

        assert_eq!(
            timeline[0].get("duration_sec").and_then(serde_json::Value::as_f64),
            Some(1.5)
        );
    }

    #[test]
    fn test_attach_durations_phase1_skips_non_tool() {
        let mut ev = Map::new();
        ev.insert("type".to_string(), Value::String("llm".to_string()));
        ev.insert(
            "detail".to_string(),
            Value::Object({
                let mut d = Map::new();
                d.insert(
                    "duration_sec".to_string(),
                    Value::Number(Number::from_f64(2.0).unwrap()),
                );
                d
            }),
        );

        let mut timeline = vec![Value::Object(ev)];
        attach_durations(&mut timeline);

        assert!(timeline[0].get("duration_sec").is_none());
    }

    /// Build an `assistant_reply` timeline row (as the timeline builder
    /// emits it, carrying the provider message id).
    fn make_assistant_reply(message_id: &str) -> Value {
        let mut m = Map::new();
        m.insert(
            "type".to_string(),
            Value::String("assistant_reply".to_string()),
        );
        m.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );
        m.insert(
            "message_id".to_string(),
            Value::String(message_id.to_string()),
        );
        Value::Object(m)
    }

    /// Build a `usage` timeline row whose detail exports the provider
    /// message id and duration (`OpenCode`) or neither (`pi`).
    fn make_usage(message_id: Option<&str>, duration_ms: Option<i64>) -> Value {
        let mut detail = Map::new();
        if let Some(mid) = message_id {
            detail.insert(
                "message_id".to_string(),
                Value::String(mid.to_string()),
            );
        }
        if let Some(d) = duration_ms {
            detail.insert(
                "duration_ms".to_string(),
                Value::Number(Number::from(d)),
            );
        }
        let mut m = Map::new();
        m.insert("type".to_string(), Value::String("usage".to_string()));
        m.insert("detail".to_string(), Value::Object(detail));
        Value::Object(m)
    }

    #[test]
    fn test_attach_durations_matches_usage_duration_by_message_id() {
        // Phase 3 restore: the usage event bills the assistant turn with a
        // real duration (OpenCode); the matching assistant reply row must
        // surface it as `[x.xs]` via `duration_sec`.
        let mut timeline = vec![
            make_assistant_reply("msg-1"),
            make_usage(Some("msg-1"), Some(5_000)),
            make_assistant_reply("msg-2"),
        ];
        attach_durations(&mut timeline);
        assert_eq!(
            timeline[0].get("duration_sec").and_then(serde_json::Value::as_f64),
            Some(5.0)
        );
        assert!(timeline[2].get("duration_sec").is_none());
    }

    #[test]
    fn test_attach_durations_pi_usage_without_duration_shows_nothing() {
        // pi reports no per-message duration: no `duration_sec` must be
        // attached and the reply line keeps no `[x.xs]` prefix.
        let mut timeline = vec![
            make_assistant_reply("msg-1"),
            make_usage(Some("msg-1"), None),
        ];
        attach_durations(&mut timeline);
        assert!(timeline[0].get("duration_sec").is_none());
    }

    #[test]
    fn test_attach_durations_usage_without_message_id_matches_nothing() {
        // A usage that does not name its message cannot be matched back to
        // a reply row.
        let mut timeline =
            vec![make_assistant_reply("msg-1"), make_usage(None, Some(5_000))];
        attach_durations(&mut timeline);
        assert!(timeline[0].get("duration_sec").is_none());
    }

    #[test]
    fn test_attach_durations_no_usage_leaves_replies_unchanged() {
        let mut timeline = vec![make_assistant_reply("msg-1")];
        attach_durations(&mut timeline);
        assert!(timeline[0].get("duration_sec").is_none());
    }

    // ── discover_child_sessions ─────────────────────────────────────────

    /// Write a pi session file with the given header fields under `dir`.
    fn write_pi_session(dir: &std::path::Path, id: &str, parent: Option<&str>) {
        let sessions = dir.join("sessions").join("--dir--");
        std::fs::create_dir_all(&sessions).expect("create pi sessions dir");
        let parent_field = parent
            .map(|p| format!(",\"parentSession\":\"{p}\""))
            .unwrap_or_default();
        let content = format!(
            r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2026-08-29T04:22:13.268Z","cwd":"/w"{parent_field}}}"#
        );
        std::fs::write(sessions.join(format!("{id}.jsonl")), content)
            .expect("write pi session file");
    }

    #[test]
    fn test_discover_child_sessions_transitive() {
        let dir = std::env::temp_dir()
            .join(format!("ztrace-helper-children-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).expect("create root");
        write_pi_session(&dir, "a-root-id", None);
        write_pi_session(&dir, "b-child-id", Some("a-root-id"));
        write_pi_session(&dir, "c-grand-id", Some("b-child-id"));
        write_pi_session(&dir, "d-other-id", None);

        let provider = zutil::session::PiSessionProvider::with_data_dir(
            dir.to_string_lossy(),
        );
        let result =
            discover_child_sessions(&provider, "a-root-id").expect("discover");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, "b-child-id");
        assert_eq!(result[0].1, 1);
        assert_eq!(result[1].0, "c-grand-id");
        assert_eq!(result[1].1, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_discover_child_sessions_no_children() {
        let dir = std::env::temp_dir()
            .join(format!("ztrace-helper-nokids-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).expect("create root");
        write_pi_session(&dir, "only-session", None);

        let provider = zutil::session::PiSessionProvider::with_data_dir(
            dir.to_string_lossy(),
        );
        let result = discover_child_sessions(&provider, "only-session")
            .expect("discover");
        assert!(result.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
