// Display-preprocessing helper functions for ztrace.
//
// Each function operates on `serde_json::Value` event/timeline dicts.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use zutil::db_helpers::open_db;
use zutil::iso_to_epoch_ms;

use crate::db::query_step_data_batch;
use crate::db::query_tool_durations_batch;

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
/// (from opencode log), keep them.
///
/// **Phase 2a**: For `tool_*` events WITHOUT duration, query
/// `crate::db::query_tool_durations_batch(all_sids, db_path)`.  Match by
/// `tool_name` + within 30 s time proximity **AND same `session_id`**.
///
/// **Phase 3**: For `LLM`/`llm_stream` events, find `assistant_reply` events
/// in the timeline, extract their `(msg_time_created, msg_time_completed,
/// duration)` ranges.  Match LLM events: first try exact containment (`ts_ms` in
/// [created, completed]), then closest midpoint within 5 s grace window.
pub fn attach_durations(
    timeline: &mut [Value],
    all_sids: &[&str],
    db_path: &str,
) {
    phase1_forward_durations(timeline);
    phase2_match_tool_durations(timeline, all_sids, db_path);
    phase3_match_llm_durations(timeline);
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

/// Phase 2a: Match tool events against DB tool durations.
fn phase2_match_tool_durations(
    timeline: &mut [Value],
    all_sids: &[&str],
    db_path: &str,
) {
    if all_sids.is_empty() {
        return;
    }
    let all_tool_durations = query_tool_durations_batch(all_sids, db_path);
    if all_tool_durations.is_empty() {
        return;
    }

    for e in timeline.iter_mut() {
        let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !etype.starts_with("tool_") {
            continue;
        }
        if e.get("duration_sec").and_then(serde_json::Value::as_f64).is_some() {
            continue;
        }

        let session_id =
            e.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        let summary = e.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let tool_name =
            summary.find(": ").map_or(summary, |pos| &summary[..pos]);
        if tool_name.is_empty() {
            continue;
        }

        let ts = e.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if ts.is_empty() {
            continue;
        }
        let ts_ms = iso_to_epoch_ms(ts);
        if ts_ms == 0 {
            continue;
        }

        // Find best match: same tool name, same session_id,
        // closest time_start within 30 s
        let mut best_match: Option<f64> = None;
        let mut best_diff = u64::MAX;

        for td in &all_tool_durations {
            let td_tool_name =
                td.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
            if td_tool_name != tool_name {
                continue;
            }
            // Filter by same session_id to avoid cross-session matches
            let td_session_id =
                td.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            if td_session_id != session_id {
                continue;
            }
            let time_start = td
                .get("time_start")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0);
            let diff = (time_start - ts_ms).unsigned_abs();
            if diff < best_diff && diff <= 30_000 {
                best_diff = diff;
                best_match =
                    td.get("duration_sec").and_then(serde_json::Value::as_f64);
            }
        }

        if let Some(dur) = best_match
            && let Some(obj) = e.as_object_mut()
            && let Some(num) = Number::from_f64(dur)
        {
            obj.insert("duration_sec".to_string(), Value::Number(num));
        }
    }
}

/// Phase 3: Match LLM events to `assistant_reply` durations.
fn phase3_match_llm_durations(timeline: &mut [Value]) {
    // Collect assistant_reply durations
    let mut assistant_ranges: Vec<(i64, i64, f64)> = Vec::new();
    for e in timeline.iter() {
        if e.get("type").and_then(|v| v.as_str()) == Some("assistant_reply") {
            let mc =
                e.get("msg_time_completed").and_then(serde_json::Value::as_i64);
            let mcr =
                e.get("msg_time_created").and_then(serde_json::Value::as_i64);
            if let (Some(completed), Some(created)) = (mc, mcr)
                && completed > created
            {
                // Use i32 for the duration diff (LLM call durations fit in i32)
                // then convert to f64 via f64::from(i32) which does not lose precision.
                let dur_ms = i32::try_from(completed - created).unwrap_or(0);
                let dur = f64::from(dur_ms) / 1000.0;
                assistant_ranges.push((created, completed, dur));
            }
        }
    }

    if assistant_ranges.is_empty() {
        return;
    }

    for e in timeline.iter_mut() {
        let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype != "llm" && etype != "llm_stream" {
            continue;
        }

        let ts = e.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if ts.is_empty() {
            continue;
        }
        let ts_ms = iso_to_epoch_ms(ts);
        if ts_ms == 0 {
            continue;
        }

        let exact_matches: Vec<&(i64, i64, f64)> = assistant_ranges
            .iter()
            .filter(|(cr, cc, _)| *cr <= ts_ms && ts_ms <= *cc)
            .collect();

        if exact_matches.len() == 1 {
            let dur = exact_matches[0].2;
            if dur > 0.0
                && let Some(obj) = e.as_object_mut()
                && let Some(num) = Number::from_f64(dur)
            {
                obj.insert("duration_sec".to_string(), Value::Number(num));
            }
        } else {
            let mut best_match: Option<f64> = None;
            let mut best_dist = u64::MAX;

            for (cr, cc, dur) in &assistant_ranges {
                if *cr <= ts_ms && ts_ms <= *cc + 5000 {
                    let midpoint = i64::midpoint(*cr, *cc);
                    let dist = (ts_ms - midpoint).unsigned_abs(); // u64
                    if dist < best_dist {
                        best_dist = dist;
                        best_match = Some(*dur);
                    }
                }
            }

            if let Some(dur) = best_match
                && dur > 0.0
                && let Some(obj) = e.as_object_mut()
                && let Some(num) = Number::from_f64(dur)
            {
                obj.insert("duration_sec".to_string(), Value::Number(num));
            }
        }
    }
}

// ── discover_child_steps ────────────────────────────────────────────────────

/// Discover child sessions and batch-query their step data.
///
/// Queries the `sessions` table for rows whose `parent_session_id` matches
/// the given `session_id`, then fetches step-finish data for all discovered
/// children via `query_step_data_batch`.  Returns a list of
/// `(child_session_id, depth, steps)` tuples where `depth` is always `1`
/// (single-level discovery).
#[must_use]
pub fn discover_child_steps(
    session_id: &str,
    db_path: &str,
) -> Vec<(String, i64, Vec<Value>)> {
    let Some(conn) = open_db(db_path) else {
        return vec![];
    };

    // Find child session IDs
    let mut stmt = conn
        .prepare("SELECT id FROM sessions WHERE parent_session_id = ?")
        .expect("SQL prepare failed");

    let child_ids: Vec<String> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            let id: String = row.get("id")?;
            Ok(id)
        })
        .expect("SQL query failed")
        .filter_map(std::result::Result::ok)
        .collect();

    if child_ids.is_empty() {
        return vec![];
    }

    // Batch-query step data for all children
    let sid_refs: Vec<&str> = child_ids.iter().map(String::as_str).collect();
    let all_steps = query_step_data_batch(&sid_refs, db_path);

    // Group steps by session_id
    let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
    for step in all_steps {
        if let Some(sid) = step.get("session_id").and_then(|v| v.as_str()) {
            grouped.entry(sid.to_string()).or_default().push(step);
        }
    }

    // Build result tuples in the same order as child_ids
    let mut results = Vec::with_capacity(child_ids.len());
    for cid in &child_ids {
        if let Some(steps) = grouped.remove(cid) {
            results.push((cid.clone(), 1_i64, steps));
        }
    }

    results
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
        attach_durations(&mut timeline, &[], "");

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
        attach_durations(&mut timeline, &[], "");

        assert!(timeline[0].get("duration_sec").is_none());
    }

    #[test]
    fn test_attach_durations_phase3_exact_match() {
        // Reply range: [1715000000000, 1715000005000] → duration = 5.0s
        // LLM timestamp inside range: 1715000001000 → 2024-05-06T12:53:21.000Z
        let mut llm_ev = Map::new();
        llm_ev.insert("type".to_string(), Value::String("llm".to_string()));
        llm_ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:21.000Z".to_string()),
        );

        let mut reply_ev = Map::new();
        reply_ev.insert(
            "type".to_string(),
            Value::String("assistant_reply".to_string()),
        );
        reply_ev.insert(
            "msg_time_created".to_string(),
            Value::Number(Number::from(1_715_000_000_000_i64)),
        );
        reply_ev.insert(
            "msg_time_completed".to_string(),
            Value::Number(Number::from(1_715_000_005_000_i64)),
        );

        let mut timeline = vec![Value::Object(llm_ev), Value::Object(reply_ev)];
        attach_durations(&mut timeline, &[], "");

        // ts_ms = 1715000001000 inside [1715000000000, 1715000005000]
        assert_eq!(
            timeline[0].get("duration_sec").and_then(serde_json::Value::as_f64),
            Some(5.0)
        );
    }

    #[test]
    fn test_attach_durations_phase3_exact_match_contained() {
        // Reply range: [1715000000000, 1715000005000] → duration = 5.0s
        // LLM timestamp inside range: 1715000003000 → 2024-05-06T12:53:23.000Z
        let mut llm_ev = Map::new();
        llm_ev.insert("type".to_string(), Value::String("llm".to_string()));
        llm_ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:23.000Z".to_string()),
        );

        let mut reply_ev = Map::new();
        reply_ev.insert(
            "type".to_string(),
            Value::String("assistant_reply".to_string()),
        );
        reply_ev.insert(
            "msg_time_created".to_string(),
            Value::Number(Number::from(1_715_000_000_000_i64)),
        );
        reply_ev.insert(
            "msg_time_completed".to_string(),
            Value::Number(Number::from(1_715_000_005_000_i64)),
        );

        let mut timeline = vec![Value::Object(llm_ev), Value::Object(reply_ev)];
        attach_durations(&mut timeline, &[], "");

        // ts_ms = 1715000003000 inside [1715000000000, 1715000005000]
        assert_eq!(
            timeline[0].get("duration_sec").and_then(serde_json::Value::as_f64),
            Some(5.0)
        );
    }

    #[test]
    fn test_attach_durations_phase3_within_grace_window() {
        // Reply range: [1715000000000, 1715000002000] → duration = 2.0s
        // Grace window upper bound: 1715000002000 + 5000 = 1715000007000
        // LLM timestamp = 1715000006000 → 2024-05-06T12:53:26.000Z
        // This is within the grace window (completed + 4000ms ≤ completed + 5000ms)
        let mut llm_ev = Map::new();
        llm_ev.insert("type".to_string(), Value::String("llm".to_string()));
        llm_ev.insert(
            "timestamp".to_string(),
            Value::String("2024-05-06T12:53:26.000Z".to_string()),
        );

        let mut reply_ev = Map::new();
        reply_ev.insert(
            "type".to_string(),
            Value::String("assistant_reply".to_string()),
        );
        reply_ev.insert(
            "msg_time_created".to_string(),
            Value::Number(Number::from(1_715_000_000_000_i64)),
        );
        reply_ev.insert(
            "msg_time_completed".to_string(),
            Value::Number(Number::from(1_715_000_002_000_i64)),
        );

        let mut timeline = vec![Value::Object(llm_ev), Value::Object(reply_ev)];
        attach_durations(&mut timeline, &[], "");

        // ts_ms = 1715000006000
        // Not inside [1715000000000, 1715000002000]
        // But inside grace window: cr=1715000000000 ≤ 1715000006000 ≤ 1715000002000+5000=1715000007000
        // Midpoint = (1715000000000 + 1715000002000) / 2 = 1715000001000
        // dist = |1715000006000 - 1715000001000| = 5000
        // Duration = 2000ms / 1000 = 2.0s
        assert_eq!(
            timeline[0].get("duration_sec").and_then(serde_json::Value::as_f64),
            Some(2.0)
        );
    }

    #[test]
    fn test_attach_durations_phase3_no_reply_for_llm() {
        let mut llm_ev = Map::new();
        llm_ev.insert(
            "type".to_string(),
            Value::String("llm_stream".to_string()),
        );
        llm_ev.insert(
            "timestamp".to_string(),
            Value::String("2025-01-09T12:34:56Z".to_string()),
        );

        let mut timeline = vec![Value::Object(llm_ev)];
        attach_durations(&mut timeline, &[], "");
        assert!(timeline[0].get("duration_sec").is_none());
    }

    // ── discover_child_steps ────────────────────────────────────────────

    #[test]
    fn test_discover_child_steps_returns_empty() {
        let result = discover_child_steps("ses-001", "/tmp/test.db");
        assert!(result.is_empty());
    }
}
