use serde_json::Value;

use super::action_correlator::{
    TargetCorrelationOptions, correlate_action_target_for_sources, extract_state_snapshot,
};
use super::models::{TestSessionEventRecord, TestSessionEventType};
use super::operation_evidence::build_operation_evidence;
use super::operation_models::{
    ExpandCollapseState, OperationAction, OperationActionKind, OperationCoordinate,
    OperationOutcome, OperationOutcomeSelectionSource, OperationReasonCode, SemanticEventRecord,
    SemanticEventType, TEST_SESSION_OPERATION_KIND, TestSessionOperationRecord,
    operation_schema_version,
};
use super::operation_override::{OperationOverrideApplyReport, apply_operation_overrides};
use super::operation_summary::summarize_operation;
use super::outcome_correlator::correlate_outcomes_for_actions_with_profile;
use super::semantic_profile::{
    SemanticProfile, apply_profile_to_operations, load_semantic_profile_for_session,
};
use super::state_transition::build_state_transitions_from_events;

const CLICK_MERGE_WINDOW_MS: u64 = 120;
const FOREGROUND_DEBOUNCE_MS: u64 = 400;
const TYPE_MERGE_WINDOW_MS: u64 = 2_500;
const STATE_ACTION_INFERENCE_WINDOW_MS: u64 = 300;

#[derive(Debug, Clone)]
struct ActionSeed {
    anchor: TestSessionEventRecord,
    source_event_ids: Vec<String>,
    ended_at_ms: Option<u64>,
}

#[allow(dead_code)]
pub fn build_actions_from_events(
    events: &[TestSessionEventRecord],
    semantic_events: &[SemanticEventRecord],
) -> Vec<OperationAction> {
    let mut ordered = events.to_vec();
    ordered.sort_by_key(|event| (event.occurred_at_ms, event.event_id.clone()));

    let mut actions = Vec::new();
    let mut index = 0usize;
    while index < ordered.len() {
        match ordered[index].event_type {
            TestSessionEventType::StepCaptured => {
                let (seed, consumed) = merge_mouse_cluster(&ordered, index);
                if let Some(action) = build_action_from_seed(seed, semantic_events) {
                    actions.push(action);
                }
                index += consumed.max(1);
            }
            TestSessionEventType::KeyboardSummary => {
                let (seed, consumed) = merge_keyboard_cluster(&ordered, index);
                if let Some(action) = build_action_from_seed(seed, semantic_events) {
                    actions.push(action);
                }
                index += consumed.max(1);
            }
            TestSessionEventType::WindowForegroundChanged => {
                if should_emit_foreground(&ordered, index) {
                    let seed = ActionSeed {
                        anchor: ordered[index].clone(),
                        source_event_ids: vec![ordered[index].event_id.clone()],
                        ended_at_ms: Some(ordered[index].occurred_at_ms),
                    };
                    if let Some(action) = build_action_from_seed(seed, semantic_events) {
                        actions.push(action);
                    }
                }
                index += 1;
            }
            TestSessionEventType::NoteAdded | TestSessionEventType::DefectMarked => {
                let seed = ActionSeed {
                    anchor: ordered[index].clone(),
                    source_event_ids: vec![ordered[index].event_id.clone()],
                    ended_at_ms: Some(ordered[index].occurred_at_ms),
                };
                if let Some(action) = build_action_from_seed(seed, semantic_events) {
                    actions.push(action);
                }
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }

    actions
}

#[allow(dead_code)]
pub fn build_operation_records_from_events(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
    semantic_events: &[SemanticEventRecord],
) -> Vec<TestSessionOperationRecord> {
    build_operation_records_from_events_with_profile(
        session_id,
        session_started_at_ms,
        events,
        semantic_events,
        load_semantic_profile_for_session(None).as_ref(),
    )
}

pub fn build_operation_records_from_events_with_profile(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
    semantic_events: &[SemanticEventRecord],
    profile: Option<&SemanticProfile>,
) -> Vec<TestSessionOperationRecord> {
    let actions = build_actions_from_events(events, semantic_events);
    let transitions = build_state_transitions_from_events(semantic_events);
    let observer_facts_present = semantic_events
        .iter()
        .any(|event| !matches!(event.event_type, SemanticEventType::ObserverHealth));
    let outcomes = correlate_outcomes_for_actions_with_profile(
        &actions,
        &transitions,
        profile,
        observer_facts_present,
    );

    let mut operations = actions
        .into_iter()
        .zip(outcomes)
        .enumerate()
        .map(|(index, (action, outcome))| {
            operation_record_from_parts(
                session_id,
                session_started_at_ms,
                index as u32 + 1,
                action,
                outcome,
                &transitions,
            )
        })
        .collect::<Vec<_>>();
    apply_profile_to_operations(&mut operations, profile);
    operations
}

#[allow(dead_code)]
pub fn rebuild_operation_records_with_overrides(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
    semantic_events: &[SemanticEventRecord],
    overrides: &[super::operation_models::OperationOverrideRecord],
) -> OperationOverrideApplyReport {
    rebuild_operation_records_with_overrides_and_profile(
        session_id,
        session_started_at_ms,
        events,
        semantic_events,
        overrides,
        load_semantic_profile_for_session(None).as_ref(),
    )
}

pub fn rebuild_operation_records_with_overrides_and_profile(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
    semantic_events: &[SemanticEventRecord],
    overrides: &[super::operation_models::OperationOverrideRecord],
    profile: Option<&SemanticProfile>,
) -> OperationOverrideApplyReport {
    let operations = build_operation_records_from_events_with_profile(
        session_id,
        session_started_at_ms,
        events,
        semantic_events,
        profile,
    );
    apply_operation_overrides(operations, overrides)
}

fn operation_record_from_parts(
    session_id: &str,
    session_started_at_ms: u64,
    sequence: u32,
    action: OperationAction,
    outcome: OperationOutcome,
    all_transitions: &[super::operation_models::StateTransition],
) -> TestSessionOperationRecord {
    let operation_transitions = transitions_for_outcome(&outcome, all_transitions);
    let evidence = build_operation_evidence(&action, &outcome, &operation_transitions);
    let summary = summarize_operation(&action, &outcome, &operation_transitions);
    let started_at_ms = action.occurred_at_ms;
    let action_end = action.ended_at_ms.unwrap_or(action.occurred_at_ms);
    let ended_at_ms = action_end.max(outcome.observed_at_ms);
    let operation_id = stable_operation_id(session_id, &action.source_event_ids);

    TestSessionOperationRecord {
        schema_version: operation_schema_version(),
        kind: TEST_SESSION_OPERATION_KIND.to_string(),
        operation_id,
        session_id: session_id.to_string(),
        sequence,
        started_at_ms,
        ended_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        action,
        outcome,
        completion_candidates: Vec::new(),
        transitions: operation_transitions,
        evidence,
        title: summary.title,
        result_summary: summary.result_summary,
        display_summary: summary.display_summary,
        precision_level: summary.precision_level,
        outcome_selection_source: OperationOutcomeSelectionSource::Auto,
        edited: false,
        ignored: false,
        business_alias: None,
        manual_note: None,
    }
}

fn transitions_for_outcome(
    outcome: &OperationOutcome,
    transitions: &[super::operation_models::StateTransition],
) -> Vec<super::operation_models::StateTransition> {
    transitions
        .iter()
        .filter(|transition| {
            outcome.primary_transition_id.as_deref() == Some(transition.transition_id.as_str())
                || outcome
                    .candidate_transition_ids
                    .iter()
                    .any(|id| id == &transition.transition_id)
        })
        .cloned()
        .collect()
}

fn build_action_from_seed(
    seed: ActionSeed,
    semantic_events: &[SemanticEventRecord],
) -> Option<OperationAction> {
    let base_kind = classify_action_kind(&seed.anchor)?;
    let kind = infer_stateful_click_kind(
        base_kind,
        &seed.anchor,
        &seed.source_event_ids,
        semantic_events,
    );
    let mut correlation_anchor = seed.anchor.clone();
    if let Some(ended_at_ms) = seed.ended_at_ms {
        correlation_anchor.occurred_at_ms = ended_at_ms;
    }
    let correlation = correlate_action_target_for_sources(
        &correlation_anchor,
        &seed.source_event_ids,
        semantic_events,
        &TargetCorrelationOptions::default(),
    );

    let content_preview = extract_action_content_preview(&seed, &kind, semantic_events);

    Some(OperationAction {
        action_id: stable_action_id(&seed.anchor.session_id, &seed.source_event_ids),
        kind,
        occurred_at_ms: seed.anchor.occurred_at_ms,
        ended_at_ms: seed.ended_at_ms,
        target: correlation.target,
        state_before: correlation.state_before,
        coordinate: operation_coordinate(&seed.anchor),
        source_event_ids: seed.source_event_ids,
        target_reason_codes: correlation.reason_codes,
        confidence: correlation.confidence,
        content_preview,
    })
}

/// Pull concrete operation content (typed value, selected option, path) for repro titles.
fn extract_action_content_preview(
    seed: &ActionSeed,
    kind: &OperationActionKind,
    semantic_events: &[SemanticEventRecord],
) -> Option<String> {
    // 1) Keyboard summary message already embeds 「content」 when UIA value is available.
    //    Prefer this over nearby selection noise (combo/list names around the same time).
    if (matches!(
        kind,
        OperationActionKind::TypeSummary | OperationActionKind::Shortcut
    ) || seed.anchor.event_type == TestSessionEventType::KeyboardSummary)
        && let Some(content) = content_from_keyboard_message(seed.anchor.message.as_deref())
    {
        return Some(content);
    }

    // 2) Nearby semantic events with valueText / selectedNames.
    let anchor_at = seed.ended_at_ms.unwrap_or(seed.anchor.occurred_at_ms);
    let start = seed.anchor.occurred_at_ms.saturating_sub(500);
    let end = anchor_at.saturating_add(1_500);
    let target_auto = seed.anchor.automation_id.as_deref();
    let mut best_value: Option<(u64, i32, String)> = None;
    let mut best_selection: Option<(u64, i32, String)> = None;

    for event in semantic_events {
        if event.occurred_at_ms < start || event.occurred_at_ms > end {
            continue;
        }
        let distance = event.occurred_at_ms.abs_diff(anchor_at);
        let auto_match = event
            .target
            .as_ref()
            .and_then(|target| target.automation_id.as_deref())
            .zip(target_auto)
            .is_some_and(|(left, right)| {
                left == right || left.ends_with(right) || right.ends_with(left)
            });
        // Prefer same AutomationId; also check flattened payload / nested snapshot.
        let score_bonus = if auto_match { 0 } else { 10_000 };
        let rank = |distance: u64| distance.saturating_add(score_bonus as u64);

        if let Some(text) = event_value_text(event) {
            let key = rank(distance);
            if best_value
                .as_ref()
                .is_none_or(|(best_key, _, _)| key <= *best_key)
            {
                best_value = Some((key, if auto_match { 0 } else { 1 }, text));
            }
        }

        // Only attach selection labels for select/click-like actions, not pure typing.
        if !matches!(kind, OperationActionKind::TypeSummary)
            && let Some(label) = event_selected_names_label(event)
        {
            let key = rank(distance);
            if best_selection
                .as_ref()
                .is_none_or(|(best_key, _, _)| key <= *best_key)
            {
                best_selection = Some((key, if auto_match { 0 } else { 1 }, label));
            }
        }
    }

    best_value
        .map(|(_, _, text)| text)
        .or_else(|| best_selection.map(|(_, _, text)| text))
}

fn event_value_text(event: &SemanticEventRecord) -> Option<String> {
    event
        .payload
        .get("valueText")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| {
            event
                .payload
                .get("stateSnapshot")
                .and_then(|snapshot| snapshot.get("valueText"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
}

fn event_selected_names_label(event: &SemanticEventRecord) -> Option<String> {
    let names = event.payload.get("selectedNames").or_else(|| {
        event
            .payload
            .get("stateSnapshot")
            .and_then(|snapshot| snapshot.get("selectedNames"))
    })?;
    match names {
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join("、");
            if joined.is_empty() {
                None
            } else {
                Some(joined)
            }
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn content_from_keyboard_message(message: Option<&str>) -> Option<String> {
    let message = message?.trim();
    // "输入「内容」" / "在「控件」输入「内容」"
    if let Some(idx) = message.find("输入「") {
        let after = &message[idx + "输入「".len()..];
        if let Some(end) = after.find('」') {
            let content = after[..end].trim();
            if !content.is_empty() && !content.contains("个字符") {
                return Some(content.to_string());
            }
        }
    }
    None
}

fn merge_mouse_cluster(events: &[TestSessionEventRecord], start: usize) -> (ActionSeed, usize) {
    let base = events[start].clone();
    let mut cluster = vec![base.clone()];
    let mut consumed = 1usize;

    for event in events.iter().skip(start + 1) {
        if event.event_type != TestSessionEventType::StepCaptured {
            break;
        }
        let delta = event.occurred_at_ms.saturating_sub(base.occurred_at_ms);
        if delta > CLICK_MERGE_WINDOW_MS || !same_point(&base, event) {
            break;
        }
        cluster.push(event.clone());
        consumed += 1;
    }

    let anchor = cluster
        .iter()
        .max_by_key(|event| mouse_anchor_score(event))
        .cloned()
        .unwrap_or(base);
    let ended_at_ms = cluster
        .iter()
        .map(|event| event.occurred_at_ms)
        .max()
        .or(Some(anchor.occurred_at_ms));
    let source_event_ids = cluster
        .iter()
        .map(|event| event.event_id.clone())
        .collect::<Vec<_>>();

    (
        ActionSeed {
            anchor,
            source_event_ids,
            ended_at_ms,
        },
        consumed,
    )
}

fn merge_keyboard_cluster(events: &[TestSessionEventRecord], start: usize) -> (ActionSeed, usize) {
    let base = events[start].clone();
    if !is_typing_keyboard_event(&base) {
        return (
            ActionSeed {
                ended_at_ms: Some(base.occurred_at_ms),
                source_event_ids: vec![base.event_id.clone()],
                anchor: base,
            },
            1,
        );
    }

    let mut merged = base.clone();
    let mut consumed = 1usize;
    let mut source_event_ids = vec![base.event_id.clone()];
    let mut total_chars = base.char_count.unwrap_or(0);
    let mut ended_at_ms = base.occurred_at_ms;

    for event in events.iter().skip(start + 1) {
        if event.event_type != TestSessionEventType::KeyboardSummary
            || !is_typing_keyboard_event(event)
        {
            break;
        }
        let delta = event.occurred_at_ms.saturating_sub(ended_at_ms);
        if delta > TYPE_MERGE_WINDOW_MS {
            break;
        }

        total_chars = total_chars.saturating_add(event.char_count.unwrap_or(0));
        merged.char_count = Some(total_chars);
        if merged.control_name.is_none() {
            merged.control_name = event.control_name.clone();
        }
        if merged.automation_id.is_none() {
            merged.automation_id = event.automation_id.clone();
        }
        if merged.control_type.is_none() {
            merged.control_type = event.control_type.clone();
        }
        if merged.window_title.is_none() {
            merged.window_title = event.window_title.clone();
        }
        if event.is_password == Some(true) {
            merged.is_password = Some(true);
        }
        ended_at_ms = event.occurred_at_ms;
        source_event_ids.push(event.event_id.clone());
        consumed += 1;
    }

    (
        ActionSeed {
            anchor: merged,
            source_event_ids,
            ended_at_ms: Some(ended_at_ms),
        },
        consumed,
    )
}

fn classify_action_kind(event: &TestSessionEventRecord) -> Option<OperationActionKind> {
    match event.event_type {
        TestSessionEventType::StepCaptured => Some(classify_mouse_kind(event.action.as_deref())),
        TestSessionEventType::KeyboardSummary => {
            // Prefer explicit action; fall back to char_count / message so older
            // sessions (or events that lost action) still become type summaries.
            if is_typing_keyboard_event(event) {
                Some(OperationActionKind::TypeSummary)
            } else {
                Some(OperationActionKind::Shortcut)
            }
        }
        TestSessionEventType::WindowForegroundChanged => Some(OperationActionKind::WindowSwitch),
        TestSessionEventType::NoteAdded | TestSessionEventType::DefectMarked => {
            Some(OperationActionKind::ManualMark)
        }
        _ => None,
    }
}

fn is_typing_keyboard_event(event: &TestSessionEventRecord) -> bool {
    match event.action.as_deref() {
        Some("type") => true,
        Some("key") | Some("shortcut") => false,
        _ => {
            event.char_count.is_some_and(|count| count > 0)
                || event
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("输入"))
                || event
                    .title
                    .as_deref()
                    .is_some_and(|title| title.contains("输入") && !title.contains("快捷键"))
        }
    }
}

fn classify_mouse_kind(action: Option<&str>) -> OperationActionKind {
    let action = action.unwrap_or("").to_ascii_uppercase();
    if action.contains("DBLCLK") || action.contains("DOUBLE") {
        OperationActionKind::DoubleClick
    } else if action.contains("RBUTTON") || action.contains("RIGHT") {
        OperationActionKind::RightClick
    } else if action.contains("WHEEL") || action.contains("SCROLL") {
        OperationActionKind::Scroll
    } else {
        OperationActionKind::Click
    }
}

fn infer_stateful_click_kind(
    base_kind: OperationActionKind,
    action_event: &TestSessionEventRecord,
    source_event_ids: &[String],
    semantic_events: &[SemanticEventRecord],
) -> OperationActionKind {
    if base_kind != OperationActionKind::Click {
        return base_kind;
    }

    semantic_events
        .iter()
        .filter(|event| same_session_or_unspecified(action_event, event))
        .filter(|event| source_is_relevant(event, source_event_ids))
        .filter(|event| event.occurred_at_ms >= action_event.occurred_at_ms)
        .filter(|event| {
            event
                .occurred_at_ms
                .saturating_sub(action_event.occurred_at_ms)
                <= STATE_ACTION_INFERENCE_WINDOW_MS
        })
        .filter_map(|event| {
            infer_kind_from_semantic_event(event).map(|kind| {
                (
                    event
                        .occurred_at_ms
                        .saturating_sub(action_event.occurred_at_ms),
                    state_action_priority(&kind),
                    kind,
                )
            })
        })
        .min_by_key(|(delta, priority, _)| (*delta, *priority))
        .map(|(_, _, kind)| kind)
        .unwrap_or(base_kind)
}

fn infer_kind_from_semantic_event(event: &SemanticEventRecord) -> Option<OperationActionKind> {
    if event
        .reason_codes
        .contains(&OperationReasonCode::ToggleStateChanged)
        || property_matches(&event.payload, "toggleState")
        || event.payload.get("toggleState").is_some()
    {
        return Some(OperationActionKind::Toggle);
    }

    if event
        .reason_codes
        .contains(&OperationReasonCode::SelectionChanged)
        || event.event_type == SemanticEventType::UiaSelectionChanged
        || property_matches(&event.payload, "selectionState")
        || event.payload.get("selectionState").is_some()
    {
        return Some(OperationActionKind::Select);
    }

    if event
        .reason_codes
        .contains(&OperationReasonCode::ExpandStateChanged)
        || property_matches(&event.payload, "expandCollapseState")
        || event.payload.get("expandCollapseState").is_some()
    {
        return Some(infer_expand_or_collapse(event));
    }

    None
}

fn infer_expand_or_collapse(event: &SemanticEventRecord) -> OperationActionKind {
    let after_state = event
        .payload
        .get("after")
        .cloned()
        .filter(|_| property_matches(&event.payload, "expandCollapseState"))
        .or_else(|| event.payload.get("expandCollapseState").cloned())
        .and_then(|value| serde_json::from_value::<ExpandCollapseState>(value).ok())
        .or_else(|| {
            extract_state_snapshot(event).and_then(|snapshot| snapshot.expand_collapse_state)
        });

    match after_state {
        Some(ExpandCollapseState::Collapsed) => OperationActionKind::Collapse,
        _ => OperationActionKind::Expand,
    }
}

fn state_action_priority(kind: &OperationActionKind) -> u8 {
    match kind {
        OperationActionKind::Toggle => 0,
        OperationActionKind::Select => 1,
        OperationActionKind::Expand | OperationActionKind::Collapse => 2,
        _ => 10,
    }
}

fn should_emit_foreground(events: &[TestSessionEventRecord], index: usize) -> bool {
    let current = &events[index];
    let title = current
        .window_title
        .as_deref()
        .or(current.title.as_deref())
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        return false;
    }

    for prev in events.iter().take(index).rev() {
        if prev.event_type != TestSessionEventType::WindowForegroundChanged {
            continue;
        }
        let delta = current.occurred_at_ms.saturating_sub(prev.occurred_at_ms);
        if delta > FOREGROUND_DEBOUNCE_MS {
            break;
        }
        let prev_title = prev
            .window_title
            .as_deref()
            .or(prev.title.as_deref())
            .unwrap_or("")
            .trim();
        if prev_title == title {
            return false;
        }
    }
    true
}

fn same_point(left: &TestSessionEventRecord, right: &TestSessionEventRecord) -> bool {
    matches!((left.x, right.x, left.y, right.y), (Some(x1), Some(x2), Some(y1), Some(y2)) if (x1 - x2).abs() <= 2 && (y1 - y2).abs() <= 2)
        || (left.x.is_none() && right.x.is_none())
}

fn mouse_anchor_score(event: &TestSessionEventRecord) -> i32 {
    let action = event.action.as_deref().unwrap_or("").to_ascii_uppercase();
    let mut score = 0;
    if action.contains("UP") {
        score += 100;
    }
    if action.contains("DBLCLK") || action.contains("DOUBLE") {
        score += 80;
    }
    if action.contains("WHEEL") || action.contains("SCROLL") {
        score += 70;
    }
    if event.control_name.is_some() {
        score += 20;
    }
    if event.automation_id.is_some() {
        score += 20;
    }
    score
}

fn operation_coordinate(event: &TestSessionEventRecord) -> Option<OperationCoordinate> {
    let (Some(x), Some(y)) = (event.logical_x.or(event.x), event.logical_y.or(event.y)) else {
        return None;
    };

    Some(OperationCoordinate {
        x,
        y,
        display_id: event.display_id.clone(),
    })
}

fn stable_action_id(session_id: &str, source_event_ids: &[String]) -> String {
    format!(
        "action-{}-{}",
        stable_id_part(session_id),
        stable_anchor_id(source_event_ids)
    )
}

fn stable_operation_id(session_id: &str, source_event_ids: &[String]) -> String {
    format!(
        "operation-{}-{}",
        stable_id_part(session_id),
        stable_anchor_id(source_event_ids)
    )
}

fn stable_anchor_id(source_event_ids: &[String]) -> String {
    source_event_ids
        .first()
        .map(|value| stable_id_part(value))
        .unwrap_or_else(|| "unknown".to_string())
}

fn stable_id_part(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    }
}

fn same_session_or_unspecified(
    event: &TestSessionEventRecord,
    semantic_event: &SemanticEventRecord,
) -> bool {
    semantic_event.session_id.trim().is_empty() || semantic_event.session_id == event.session_id
}

fn source_is_relevant(semantic_event: &SemanticEventRecord, source_event_ids: &[String]) -> bool {
    match semantic_event
        .source_event_id
        .as_deref()
        .filter(|source_id| !source_id.trim().is_empty())
    {
        Some(source_id) => source_event_ids.iter().any(|id| id == source_id),
        None => true,
    }
}

fn property_matches(payload: &Value, expected: &str) -> bool {
    payload
        .get("property")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::models::{
        TEST_SESSION_EVENT_KIND, TEST_SESSION_SCHEMA_VERSION, TestSessionStatus,
    };
    use crate::session::operation_models::{
        OperationEvidenceKind, OperationEvidenceRole, OperationOutcomeStatus, PrivacyClass,
        TEST_SESSION_SEMANTIC_EVENT_KIND, ToggleState, UiBoundingRect, UiElementIdentity,
        UiStateSnapshot, UiStateSnapshotSource,
    };

    fn base_event(id: &str, event_type: TestSessionEventType, at: u64) -> TestSessionEventRecord {
        TestSessionEventRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id: id.to_string(),
            session_id: "ts-1".to_string(),
            event_type,
            occurred_at_ms: at,
            status: None,
            step_id: None,
            action: None,
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
            window_left: None,
            window_top: None,
            window_right: None,
            window_bottom: None,
            logical_window_left: None,
            logical_window_top: None,
            logical_window_right: None,
            logical_window_bottom: None,
            display_id: None,
            dpi_scale: None,
            process_name: None,
            window_title: None,
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
            clipboard_content_type: None,
            image_bytes: None,
            capture_latency_ms: None,
            encode_latency_ms: None,
            source: None,
            capture_backend: None,
            full_image_path: None,
            thumb_image_path: None,
            control_name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,
        }
    }

    fn click_event(id: &str, at: u64, action: &str) -> TestSessionEventRecord {
        let mut event = base_event(id, TestSessionEventType::StepCaptured, at);
        event.action = Some(action.to_string());
        event.x = Some(120);
        event.y = Some(220);
        event.logical_x = Some(120);
        event.logical_y = Some(220);
        event.window_pid = Some(42);
        event.window_hwnd = Some("0x100".to_string());
        event.window_title = Some("Editor".to_string());
        event
    }

    fn keyboard_event(
        id: &str,
        at: u64,
        action: &str,
        char_count: Option<u32>,
    ) -> TestSessionEventRecord {
        let mut event = base_event(id, TestSessionEventType::KeyboardSummary, at);
        event.action = Some(action.to_string());
        event.char_count = char_count;
        event.control_name = Some("Description".to_string());
        event.window_pid = Some(42);
        event
    }

    fn semantic_event(
        id: &str,
        event_type: SemanticEventType,
        at: u64,
        source_event_id: Option<&str>,
        payload: Value,
        reason_codes: Vec<OperationReasonCode>,
    ) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: id.to_string(),
            session_id: "ts-1".to_string(),
            event_type,
            occurred_at_ms: at,
            monotonic_offset_ms: Some(at),
            source_event_id: source_event_id.map(str::to_string),
            target: None,
            payload,
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes,
        }
    }

    #[test]
    fn operation_builder_action_correlates_mouse_click_to_semantic_target() {
        let events = vec![click_event("input-save", 1_000, "WM_LBUTTONUP")];
        let semantic_events = vec![semantic_event(
            "sem-save-target",
            SemanticEventType::UiaSnapshot,
            990,
            Some("input-save"),
            json!({
                "runtimeId": [1, 10],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Save",
                "automationId": "btnSave",
                "controlType": "Button",
                "boundingRect": { "left": 100, "top": 200, "width": 80, "height": 40 }
            }),
            Vec::new(),
        )];

        let actions = build_actions_from_events(&events, &semantic_events);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, OperationActionKind::Click);
        assert_eq!(
            actions[0]
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Save")
        );
        assert!(
            actions[0]
                .target_reason_codes
                .contains(&OperationReasonCode::RuntimeIdMatch)
        );
        assert_eq!(
            actions[0]
                .coordinate
                .as_ref()
                .map(|point| (point.x, point.y)),
            Some((120, 220))
        );
    }

    #[test]
    fn operation_builder_action_infers_toggle_select_expand_and_collapse() {
        let inputs = vec![
            (
                "toggle",
                SemanticEventType::UiaPropertyChanged,
                json!({ "runtimeId": [2, 1], "property": "toggleState", "before": "off", "after": "on" }),
                vec![OperationReasonCode::ToggleStateChanged],
                OperationActionKind::Toggle,
            ),
            (
                "select",
                SemanticEventType::UiaSelectionChanged,
                json!({ "runtimeId": [2, 2], "before": "notSelected", "after": "selected" }),
                vec![OperationReasonCode::SelectionChanged],
                OperationActionKind::Select,
            ),
            (
                "expand",
                SemanticEventType::UiaPropertyChanged,
                json!({ "runtimeId": [2, 3], "property": "expandCollapseState", "before": "collapsed", "after": "expanded" }),
                vec![OperationReasonCode::ExpandStateChanged],
                OperationActionKind::Expand,
            ),
            (
                "collapse",
                SemanticEventType::UiaPropertyChanged,
                json!({ "runtimeId": [2, 4], "property": "expandCollapseState", "before": "expanded", "after": "collapsed" }),
                vec![OperationReasonCode::ExpandStateChanged],
                OperationActionKind::Collapse,
            ),
        ];

        for (label, event_type, payload, reason_codes, expected_kind) in inputs {
            let input_id = format!("input-{label}");
            let events = vec![click_event(&input_id, 2_000, "WM_LBUTTONUP")];
            let semantic_events = vec![semantic_event(
                &format!("sem-{label}"),
                event_type,
                2_080,
                Some(&input_id),
                payload,
                reason_codes,
            )];

            let actions = build_actions_from_events(&events, &semantic_events);

            assert_eq!(actions.len(), 1, "{label}");
            assert_eq!(actions[0].kind, expected_kind, "{label}");
        }
    }

    #[test]
    fn operation_builder_action_keeps_continuous_typing_as_one_summary() {
        let events = vec![
            keyboard_event("key-1", 3_000, "type", Some(3)),
            keyboard_event("key-2", 3_800, "type", Some(5)),
        ];
        let semantic_events = vec![semantic_event(
            "sem-text-length",
            SemanticEventType::UiaPropertyChanged,
            3_900,
            Some("key-2"),
            json!({
                "runtimeId": [3, 1],
                "processId": 42,
                "property": "valueLength",
                "before": 0,
                "after": 8,
                "privacyClass": "text-length-only"
            }),
            vec![OperationReasonCode::ValueLengthChanged],
        )];

        let actions = build_actions_from_events(&events, &semantic_events);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, OperationActionKind::TypeSummary);
        assert_eq!(actions[0].source_event_ids, vec!["key-1", "key-2"]);
        assert_eq!(actions[0].ended_at_ms, Some(3_800));
        assert_eq!(
            actions[0]
                .target
                .as_ref()
                .and_then(|target| target.runtime_id.clone()),
            Some(vec![3, 1])
        );
    }

    #[test]
    fn operation_builder_types_even_when_action_field_missing_and_keeps_message_content() {
        // Regression: system events used to drop action="type", so typing became shortcut
        // and contentPreview was lost even though message already had 「输入内容」.
        let mut event = base_event("key-typed", TestSessionEventType::KeyboardSummary, 6_000);
        event.action = None;
        event.char_count = Some(5);
        event.message = Some("输入「新建项目20260731220820」".to_string());
        event.control_type = Some("Edit".to_string());
        event.automation_id = Some("NewProjectUI.txt.CreateNewProject.ProjectName".to_string());
        event.window_pid = Some(42);

        let actions = build_actions_from_events(&[event], &[]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, OperationActionKind::TypeSummary);
        assert_eq!(
            actions[0].content_preview.as_deref(),
            Some("新建项目20260731220820")
        );
    }

    #[test]
    fn operation_builder_action_falls_back_to_coordinate_without_semantic_target() {
        let events = vec![click_event("input-fallback", 4_000, "WM_LBUTTONUP")];

        let actions = build_actions_from_events(&events, &[]);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, OperationActionKind::Click);
        assert_eq!(
            actions[0]
                .coordinate
                .as_ref()
                .map(|point| (point.x, point.y)),
            Some((120, 220))
        );
        assert!(
            actions[0]
                .target_reason_codes
                .contains(&OperationReasonCode::CoordinateFallback)
        );
    }

    #[test]
    fn operation_builder_uses_same_timestamp_pre_state_as_target_and_before() {
        let events = vec![click_event("input-save", 8_000, "WM_LBUTTONDOWN")];
        let semantic_events = vec![semantic_event(
            "sem-pre-input-save",
            SemanticEventType::UiaSnapshot,
            8_000,
            Some("input-save"),
            json!({
                "source": "mouse-down-pre-state",
                "runtimeId": [9, 1],
                "processId": 42,
                "name": "保存",
                "automationId": "btnSave",
                "controlType": "Button",
                "boundingRect": { "left": 110, "top": 210, "width": 80, "height": 28 },
                "toggleState": "off",
                "stateSnapshot": {
                    "snapshotId": "state-pre-input-save",
                    "capturedAtMs": 8000,
                    "element": {
                        "runtimeId": [9, 1],
                        "processId": 42,
                        "name": "保存",
                        "automationId": "btnSave",
                        "controlType": "Button",
                        "boundingRect": { "left": 110, "top": 210, "width": 80, "height": 28 }
                    },
                    "toggleState": "off",
                    "privacyClass": "not-sensitive"
                }
            }),
            vec![OperationReasonCode::PointHit],
        )];

        let actions = build_actions_from_events(&events, &semantic_events);
        assert_eq!(actions.len(), 1);
        assert_eq!(
            actions[0]
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("保存")
        );
        assert_eq!(
            actions[0]
                .state_before
                .as_ref()
                .and_then(|snapshot| snapshot.toggle_state.clone()),
            Some(crate::session::operation_models::ToggleState::Off)
        );
        assert!(
            actions[0]
                .target_reason_codes
                .contains(&OperationReasonCode::PointHit)
        );
    }

    #[test]
    fn operation_builder_action_records_multiple_candidate_target_reason() {
        let events = vec![click_event("input-menu", 5_000, "WM_LBUTTONUP")];
        let semantic_events = vec![
            semantic_event(
                "sem-menu-pane",
                SemanticEventType::UiaSnapshot,
                4_990,
                None,
                json!({ "name": "Pane", "controlType": "Pane", "processId": 42 }),
                Vec::new(),
            ),
            semantic_event(
                "sem-menu-item",
                SemanticEventType::UiaFocusChanged,
                5_010,
                None,
                json!({
                    "runtimeId": [5, 1],
                    "processId": 42,
                    "name": "Open issues",
                    "automationId": "openIssues",
                    "controlType": "MenuItem"
                }),
                Vec::new(),
            ),
        ];

        let actions = build_actions_from_events(&events, &semantic_events);

        assert_eq!(
            actions[0]
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Open issues")
        );
        assert!(
            actions[0]
                .target_reason_codes
                .contains(&OperationReasonCode::MultipleCandidates)
        );
    }

    #[test]
    fn operation_builder_action_maps_mouse_variants_and_window_switch() {
        let mut foreground = base_event(
            "win-1",
            TestSessionEventType::WindowForegroundChanged,
            6_000,
        );
        foreground.window_title = Some("Settings".to_string());
        foreground.status = Some(TestSessionStatus::Active);

        let events = vec![
            click_event("double", 6_500, "WM_LBUTTONDBLCLK"),
            click_event("right", 7_000, "WM_RBUTTONUP"),
            click_event("wheel", 7_500, "WM_MOUSEWHEEL"),
            foreground,
        ];

        let actions = build_actions_from_events(&events, &[]);
        let kinds = actions
            .iter()
            .map(|action| action.kind.clone())
            .collect::<Vec<_>>();

        assert!(kinds.contains(&OperationActionKind::WindowSwitch));
        assert!(kinds.contains(&OperationActionKind::DoubleClick));
        assert!(kinds.contains(&OperationActionKind::RightClick));
        assert!(kinds.contains(&OperationActionKind::Scroll));
    }

    #[test]
    fn operation_builder_action_prefers_pre_state_snapshot_before_anchor() {
        let down = click_event("down", 7_000, "WM_LBUTTONDOWN");
        let up = click_event("up", 7_050, "WM_LBUTTONUP");
        let element = UiElementIdentity {
            runtime_id: Some(vec![7, 1]),
            process_id: Some(42),
            name: Some("Enable sync".to_string()),
            bounding_rect: Some(UiBoundingRect {
                left: 100,
                top: 200,
                width: 80,
                height: 40,
            }),
            ..UiElementIdentity::default()
        };
        let before = UiStateSnapshot {
            snapshot_id: "state-down-pre".to_string(),
            captured_at_ms: 7_010,
            element: Some(element),
            is_enabled: Some(true),
            has_keyboard_focus: Some(false),
            is_offscreen: Some(false),
            value_length: None,
            value_text: None,
            value_fingerprint: None,
            toggle_state: Some(ToggleState::Off),
            selection_state: None,
            selected_names: None,
            expand_collapse_state: None,
            range_value: None,
            privacy_class: PrivacyClass::NotSensitive,
            source: Some(UiStateSnapshotSource::UiaSnapshot),
        };
        let semantic_events = vec![semantic_event(
            "sem-down-pre",
            SemanticEventType::UiaSnapshot,
            7_010,
            Some("down"),
            json!({ "stateSnapshot": before }),
            Vec::new(),
        )];

        let actions = build_actions_from_events(&[down, up], &semantic_events);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].source_event_ids, vec!["down", "up"]);
        assert_eq!(
            actions[0]
                .state_before
                .as_ref()
                .and_then(|state| state.toggle_state.clone()),
            Some(ToggleState::Off)
        );
    }

    #[test]
    fn operation_builder_record_links_action_outcome_evidence_and_summary() {
        let events = vec![click_event("input-save", 1_000, "WM_LBUTTONUP")];
        let semantic_events = vec![
            semantic_event(
                "sem-save-target",
                SemanticEventType::UiaSnapshot,
                990,
                Some("input-save"),
                json!({
                    "runtimeId": [1, 10],
                    "processId": 42,
                    "windowHwnd": "0x100",
                    "name": "Save",
                    "automationId": "btnSave",
                    "controlType": "Button",
                    "boundingRect": { "left": 100, "top": 200, "width": 80, "height": 40 },
                    "isEnabled": true
                }),
                Vec::new(),
            ),
            semantic_event(
                "sem-save-toast",
                SemanticEventType::PopupAppeared,
                1_420,
                Some("input-save"),
                json!({
                    "runtimeId": [1, 20],
                    "processId": 42,
                    "windowHwnd": "0x100",
                    "name": "Saved",
                    "controlType": "Text"
                }),
                Vec::new(),
            ),
        ];

        let records = build_operation_records_from_events("ts-1", 500, &events, &semantic_events);

        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.session_id, "ts-1");
        assert_eq!(record.sequence, 1);
        assert_eq!(record.relative_ms_from_session_start, 500);
        assert_eq!(record.action.kind, OperationActionKind::Click);
        assert_eq!(record.outcome.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(record.outcome.latency_ms, 420);
        assert!(
            record
                .outcome
                .reason_codes
                .contains(&OperationReasonCode::PopupAppeared)
        );
        assert_eq!(record.transitions.len(), 1);
        assert_eq!(
            record.outcome.primary_transition_id.as_deref(),
            Some(record.transitions[0].transition_id.as_str())
        );
        assert!(
            record
                .evidence
                .iter()
                .any(|evidence| evidence.kind == OperationEvidenceKind::RawEvent
                    && evidence.role == OperationEvidenceRole::SupportsTarget)
        );
        assert!(record.evidence.iter().any(|evidence| evidence.kind
            == OperationEvidenceKind::UiaSnapshot
            && evidence.role == OperationEvidenceRole::SupportsTarget));
        assert!(record.evidence.iter().any(|evidence| evidence.kind
            == OperationEvidenceKind::StateTransition
            && evidence.role == OperationEvidenceRole::SupportsOutcome));
        assert!(
            record
                .evidence
                .iter()
                .all(|evidence| evidence.artifact_ref.is_none() && evidence.video_range.is_none())
        );
        assert_eq!(record.title, "单击按钮“Save”");
        assert_eq!(record.result_summary, "弹窗“Saved”出现");
        assert!(record.display_summary.contains("耗时 420ms"));
        assert_eq!(record.precision_level, "l3");
    }
}
