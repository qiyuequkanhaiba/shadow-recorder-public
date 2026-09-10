use serde_json::Value;

use super::models::TestSessionEventRecord;
use super::operation_models::{
    ExpandCollapseState, OperationActionConfidence, OperationReasonCode, PrivacyClass,
    SelectionState, SemanticEventRecord, SemanticEventType, ToggleState, UiBoundingRect,
    UiElementIdentity, UiStateSnapshot, UiStateSnapshotSource,
};
use super::uia_state_cache::state_cache_key;

pub const DEFAULT_TARGET_ASSOCIATION_WINDOW_MS: u64 = 300;
pub const DEFAULT_STATE_BEFORE_SLACK_MS: u64 = 80;

#[derive(Debug, Clone, PartialEq)]
pub struct TargetCorrelationOptions {
    pub window_ms: u64,
    pub min_target_confidence: f64,
}

impl Default for TargetCorrelationOptions {
    fn default() -> Self {
        Self {
            window_ms: DEFAULT_TARGET_ASSOCIATION_WINDOW_MS,
            min_target_confidence: 0.45,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TargetCorrelation {
    pub target: Option<UiElementIdentity>,
    pub state_before: Option<UiStateSnapshot>,
    pub reason_codes: Vec<OperationReasonCode>,
    pub confidence: OperationActionConfidence,
    pub supporting_semantic_event_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct TargetCandidate {
    target: UiElementIdentity,
    snapshot: Option<UiStateSnapshot>,
    event_id: String,
    occurred_at_ms: u64,
    score: f64,
    temporal_confidence: f64,
    reason_codes: Vec<OperationReasonCode>,
}

#[allow(dead_code)]
pub fn correlate_action_target(
    event: &TestSessionEventRecord,
    semantic_events: &[SemanticEventRecord],
) -> TargetCorrelation {
    correlate_action_target_for_sources(
        event,
        std::slice::from_ref(&event.event_id),
        semantic_events,
        &TargetCorrelationOptions::default(),
    )
}

pub fn correlate_action_target_for_sources(
    event: &TestSessionEventRecord,
    source_event_ids: &[String],
    semantic_events: &[SemanticEventRecord],
    options: &TargetCorrelationOptions,
) -> TargetCorrelation {
    let mut candidates = semantic_events
        .iter()
        .filter(|semantic_event| same_session_or_unspecified(event, semantic_event))
        .filter(|semantic_event| source_is_relevant(semantic_event, source_event_ids))
        .filter(|semantic_event| is_target_candidate_event(semantic_event))
        .filter(|semantic_event| {
            time_distance_ms(event.occurred_at_ms, semantic_event.occurred_at_ms)
                <= options.window_ms
        })
        .filter_map(|semantic_event| {
            build_candidate(event, source_event_ids, semantic_event, options.window_ms)
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.occurred_at_ms.cmp(&right.occurred_at_ms))
            .then_with(|| left.event_id.cmp(&right.event_id))
    });

    let Some(mut best) = candidates.into_iter().next() else {
        return fallback_correlation(event);
    };

    let target_confidence = (best.score / 100.0).clamp(0.0, 0.99);
    if target_confidence < options.min_target_confidence {
        return fallback_correlation(event);
    }

    if semantic_events
        .iter()
        .filter(|semantic_event| same_session_or_unspecified(event, semantic_event))
        .filter(|semantic_event| source_is_relevant(semantic_event, source_event_ids))
        .filter(|semantic_event| is_target_candidate_event(semantic_event))
        .filter(|semantic_event| {
            time_distance_ms(event.occurred_at_ms, semantic_event.occurred_at_ms)
                <= options.window_ms
        })
        .filter_map(extract_event_target)
        .take(2)
        .count()
        > 1
    {
        push_unique(
            &mut best.reason_codes,
            OperationReasonCode::MultipleCandidates,
        );
    }

    let state_before = best
        .snapshot
        .clone()
        .filter(|snapshot| {
            snapshot.captured_at_ms
                <= event
                    .occurred_at_ms
                    .saturating_add(DEFAULT_STATE_BEFORE_SLACK_MS)
        })
        .or_else(|| {
            nearest_state_before(
                event.occurred_at_ms,
                options.window_ms,
                &best.target,
                semantic_events,
            )
        });

    let mut supporting_semantic_event_ids = vec![best.event_id.clone()];
    if let Some(state_before) = state_before.as_ref()
        && let Some(source_id) = state_before
            .snapshot_id
            .strip_prefix("state-")
            .filter(|value| !value.is_empty())
        && source_id != best.event_id
    {
        supporting_semantic_event_ids.push(source_id.to_string());
    }
    supporting_semantic_event_ids.sort();
    supporting_semantic_event_ids.dedup();

    TargetCorrelation {
        target: Some(best.target),
        state_before,
        reason_codes: best.reason_codes,
        confidence: OperationActionConfidence {
            target: Some(round_confidence(target_confidence)),
            temporal: Some(round_confidence(best.temporal_confidence)),
            overall: Some(round_confidence(
                (target_confidence + best.temporal_confidence) / 2.0,
            )),
        },
        supporting_semantic_event_ids,
    }
}

pub(crate) fn extract_event_target(event: &SemanticEventRecord) -> Option<UiElementIdentity> {
    event.target.clone().or_else(|| {
        extract_state_snapshot(event)
            .and_then(|snapshot| snapshot.element)
            .or_else(|| payload_identity(&event.payload))
    })
}

pub(crate) fn extract_state_snapshot(event: &SemanticEventRecord) -> Option<UiStateSnapshot> {
    if let Some(snapshot_value) = event
        .payload
        .get("stateSnapshot")
        .filter(|value| !value.is_null())
        && let Ok(mut snapshot) = serde_json::from_value::<UiStateSnapshot>(snapshot_value.clone())
    {
        fill_snapshot_defaults(&mut snapshot, event);
        return Some(snapshot);
    }

    let element = event
        .target
        .clone()
        .or_else(|| payload_identity(&event.payload))?;
    if !event_looks_stateful(event) {
        return None;
    }

    Some(UiStateSnapshot {
        snapshot_id: format!("state-{}", event.event_id),
        captured_at_ms: event.occurred_at_ms,
        element: Some(element),
        is_enabled: bool_field(&event.payload, "isEnabled")
            .or_else(|| property_bool_after(&event.payload, "isEnabled")),
        has_keyboard_focus: bool_field(&event.payload, "hasKeyboardFocus"),
        is_offscreen: bool_field(&event.payload, "isOffscreen"),
        value_length: u32_field(&event.payload, "valueLength")
            .or_else(|| property_u32_after(&event.payload, "valueLength")),
        value_text: string_field(&event.payload, "valueText").or_else(|| {
            event
                .payload
                .get("after")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_string)
                .filter(|_| {
                    event
                        .payload
                        .get("property")
                        .and_then(Value::as_str)
                        .is_some_and(|property| {
                            let lower = property.to_ascii_lowercase();
                            lower.contains("value") && !lower.contains("range")
                        })
                })
        }),
        value_fingerprint: string_field(&event.payload, "valueFingerprint"),
        toggle_state: enum_field::<ToggleState>(&event.payload, "toggleState")
            .or_else(|| property_enum_after::<ToggleState>(&event.payload, "toggleState")),
        selection_state: enum_field::<SelectionState>(&event.payload, "selectionState")
            .or_else(|| property_enum_after::<SelectionState>(&event.payload, "selectionState")),
        selected_names: event
            .payload
            .get("selectedNames")
            .and_then(|value| match value {
                Value::Array(items) => {
                    let names = items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>();
                    if names.is_empty() { None } else { Some(names) }
                }
                Value::String(text) if !text.trim().is_empty() => Some(vec![text.clone()]),
                _ => None,
            }),
        expand_collapse_state: enum_field::<ExpandCollapseState>(
            &event.payload,
            "expandCollapseState",
        )
        .or_else(|| {
            property_enum_after::<ExpandCollapseState>(&event.payload, "expandCollapseState")
        }),
        range_value: f64_field(&event.payload, "rangeValue")
            .or_else(|| property_f64_after(&event.payload, "rangeValue")),
        privacy_class: payload_privacy_class(event),
        source: Some(snapshot_source_for_event(&event.event_type)),
    })
}

pub(crate) fn time_distance_ms(left: u64, right: u64) -> u64 {
    left.max(right) - left.min(right)
}

fn build_candidate(
    action_event: &TestSessionEventRecord,
    source_event_ids: &[String],
    semantic_event: &SemanticEventRecord,
    window_ms: u64,
) -> Option<TargetCandidate> {
    let target = extract_event_target(semantic_event)?;
    let snapshot = extract_state_snapshot(semantic_event);
    let delta = time_distance_ms(action_event.occurred_at_ms, semantic_event.occurred_at_ms);
    let temporal_confidence = if window_ms == 0 {
        if delta == 0 { 1.0 } else { 0.0 }
    } else {
        1.0 - ((delta as f64 / window_ms as f64) * 0.45)
    }
    .clamp(0.0, 1.0);

    let mut score = 25.0 * temporal_confidence;
    let mut reason_codes = Vec::new();

    if semantic_event
        .source_event_id
        .as_deref()
        .map(|source_id| source_event_ids.iter().any(|id| id == source_id))
        .unwrap_or(false)
    {
        score += 30.0;
    }

    if target
        .runtime_id
        .as_ref()
        .map(|runtime_id| !runtime_id.is_empty())
        .unwrap_or(false)
    {
        score += 25.0;
        push_unique(&mut reason_codes, OperationReasonCode::RuntimeIdMatch);
    }

    if has_automation_path_signal(&target) {
        score += 15.0;
        push_unique(&mut reason_codes, OperationReasonCode::AutomationPathMatch);
    }

    if semantic_event.event_type == SemanticEventType::UiaFocusChanged
        || snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.has_keyboard_focus)
            .unwrap_or(false)
    {
        score += 20.0;
        push_unique(&mut reason_codes, OperationReasonCode::FocusMatch);
    }

    if point_hits_target(action_event, &target) {
        score += 20.0;
        push_unique(&mut reason_codes, OperationReasonCode::PointHit);
    }

    match same_process_signal(action_event, &target) {
        MatchSignal::Match => {
            score += 8.0;
            push_unique(
                &mut reason_codes,
                OperationReasonCode::AncestorSemanticMatch,
            );
        }
        MatchSignal::Mismatch => {
            score -= 30.0;
            push_unique(
                &mut reason_codes,
                OperationReasonCode::TargetProcessMismatch,
            );
        }
        MatchSignal::Unknown => {}
    }

    if same_window_signal(action_event, &target) == MatchSignal::Match {
        score += 8.0;
        push_unique(
            &mut reason_codes,
            OperationReasonCode::AncestorSemanticMatch,
        );
    }

    if target
        .name
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || target
            .control_type
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    {
        score += 5.0;
    }

    Some(TargetCandidate {
        target,
        snapshot,
        event_id: semantic_event.event_id.clone(),
        occurred_at_ms: semantic_event.occurred_at_ms,
        score: score.max(0.0),
        temporal_confidence,
        reason_codes,
    })
}

fn fallback_correlation(event: &TestSessionEventRecord) -> TargetCorrelation {
    let target = fallback_target_from_event(event);
    let mut reason_codes = Vec::new();
    if target
        .as_ref()
        .map(has_automation_path_signal)
        .unwrap_or(false)
    {
        push_unique(&mut reason_codes, OperationReasonCode::AutomationPathMatch);
    }
    if event.x.is_some() && event.y.is_some() {
        push_unique(&mut reason_codes, OperationReasonCode::CoordinateFallback);
    }

    let target_confidence = if target
        .as_ref()
        .map(has_automation_path_signal)
        .unwrap_or(false)
    {
        0.55
    } else if target.is_some() {
        0.35
    } else if event.x.is_some() && event.y.is_some() {
        0.20
    } else {
        0.0
    };

    TargetCorrelation {
        target,
        state_before: None,
        reason_codes,
        confidence: OperationActionConfidence {
            target: Some(target_confidence),
            temporal: None,
            overall: Some(target_confidence),
        },
        supporting_semantic_event_ids: Vec::new(),
    }
}

fn fallback_target_from_event(event: &TestSessionEventRecord) -> Option<UiElementIdentity> {
    if has_legacy_control_identity(event)
        || event.window_hwnd.is_some()
        || event.window_pid.is_some()
        || event.window_title.is_some()
    {
        return Some(UiElementIdentity {
            runtime_id: None,
            process_id: event.window_pid,
            window_hwnd: event.window_hwnd.clone(),
            name: event
                .control_name
                .clone()
                .or_else(|| event.window_title.clone())
                .or_else(|| event.title.clone()),
            automation_id: event.automation_id.clone(),
            control_type: event
                .control_type
                .clone()
                .or_else(|| (!has_legacy_control_identity(event)).then_some("Window".to_string())),
            localized_control_type: None,
            class_name: event.class_name.clone(),
            framework_id: None,
            parent_path: Vec::new(),
            bounding_rect: fallback_bounding_rect_from_event(event),
        });
    }

    None
}

fn fallback_bounding_rect_from_event(event: &TestSessionEventRecord) -> Option<UiBoundingRect> {
    let left = event.logical_window_left.or(event.window_left)?;
    let top = event.logical_window_top.or(event.window_top)?;
    let right = event.logical_window_right.or(event.window_right)?;
    let bottom = event.logical_window_bottom.or(event.window_bottom)?;
    let width = u32::try_from(right.saturating_sub(left)).ok()?;
    let height = u32::try_from(bottom.saturating_sub(top)).ok()?;
    Some(UiBoundingRect {
        left,
        top,
        width,
        height,
    })
}

fn nearest_state_before(
    occurred_at_ms: u64,
    window_ms: u64,
    target: &UiElementIdentity,
    semantic_events: &[SemanticEventRecord],
) -> Option<UiStateSnapshot> {
    semantic_events
        .iter()
        .filter(|event| {
            event.occurred_at_ms <= occurred_at_ms.saturating_add(DEFAULT_STATE_BEFORE_SLACK_MS)
        })
        .filter(|event| {
            occurred_at_ms.saturating_add(DEFAULT_STATE_BEFORE_SLACK_MS) >= event.occurred_at_ms
                && occurred_at_ms.saturating_sub(event.occurred_at_ms.min(occurred_at_ms))
                    <= window_ms
        })
        .filter_map(extract_state_snapshot)
        .filter(|snapshot| {
            snapshot
                .element
                .as_ref()
                .map(|element| identity_matches(target, element))
                .unwrap_or(false)
        })
        .max_by_key(|snapshot| snapshot.captured_at_ms)
}

fn identity_matches(left: &UiElementIdentity, right: &UiElementIdentity) -> bool {
    if let (Some(left_runtime_id), Some(right_runtime_id)) = (
        left.runtime_id.as_ref().filter(|value| !value.is_empty()),
        right.runtime_id.as_ref().filter(|value| !value.is_empty()),
    ) {
        return left.process_id == right.process_id && left_runtime_id == right_runtime_id;
    }

    match (state_cache_key(left), state_cache_key(right)) {
        (Some(left_key), Some(right_key)) => left_key == right_key,
        _ => false,
    }
}

fn payload_identity(payload: &Value) -> Option<UiElementIdentity> {
    if let Some(element_value) = payload.get("element")
        && let Ok(identity) = serde_json::from_value::<UiElementIdentity>(element_value.clone())
        && identity_has_signal(&identity)
    {
        return Some(identity);
    }

    serde_json::from_value::<UiElementIdentity>(payload.clone())
        .ok()
        .filter(identity_has_signal)
}

fn fill_snapshot_defaults(snapshot: &mut UiStateSnapshot, event: &SemanticEventRecord) {
    if snapshot.snapshot_id.trim().is_empty() {
        snapshot.snapshot_id = format!("state-{}", event.event_id);
    }
    if snapshot.captured_at_ms == 0 {
        snapshot.captured_at_ms = event.occurred_at_ms;
    }
    if snapshot.element.is_none() {
        snapshot.element = event
            .target
            .clone()
            .or_else(|| payload_identity(&event.payload));
    }
    if snapshot.source.is_none() {
        snapshot.source = Some(snapshot_source_for_event(&event.event_type));
    }
}

fn snapshot_source_for_event(event_type: &SemanticEventType) -> UiStateSnapshotSource {
    match event_type {
        SemanticEventType::UiaSnapshot => UiStateSnapshotSource::UiaSnapshot,
        SemanticEventType::UiaFocusChanged => UiStateSnapshotSource::UiaFocusEvent,
        SemanticEventType::UiaPropertyChanged => UiStateSnapshotSource::UiaPropertyEvent,
        _ => UiStateSnapshotSource::DerivedFromEvent,
    }
}

fn event_looks_stateful(event: &SemanticEventRecord) -> bool {
    matches!(
        event.event_type,
        SemanticEventType::UiaSnapshot
            | SemanticEventType::UiaFocusChanged
            | SemanticEventType::UiaPropertyChanged
            | SemanticEventType::UiaSelectionChanged
    ) || [
        "isEnabled",
        "hasKeyboardFocus",
        "isOffscreen",
        "valueLength",
        "valueFingerprint",
        "toggleState",
        "selectionState",
        "expandCollapseState",
        "rangeValue",
        "property",
        "before",
        "after",
    ]
    .iter()
    .any(|key| event.payload.get(*key).is_some())
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

fn is_target_candidate_event(semantic_event: &SemanticEventRecord) -> bool {
    matches!(
        semantic_event.event_type,
        SemanticEventType::UiaSnapshot
            | SemanticEventType::UiaFocusChanged
            | SemanticEventType::UiaPropertyChanged
            | SemanticEventType::UiaSelectionChanged
    )
}

fn has_legacy_control_identity(event: &TestSessionEventRecord) -> bool {
    event
        .control_name
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || event
            .automation_id
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || event
            .control_type
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || event
            .class_name
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

fn identity_has_signal(identity: &UiElementIdentity) -> bool {
    identity
        .runtime_id
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
        || identity.process_id.is_some()
        || identity.window_hwnd.is_some()
        || identity.name.is_some()
        || identity.automation_id.is_some()
        || identity.control_type.is_some()
        || identity.localized_control_type.is_some()
        || identity.class_name.is_some()
        || identity.framework_id.is_some()
        || !identity.parent_path.is_empty()
        || identity.bounding_rect.is_some()
}

fn has_automation_path_signal(identity: &UiElementIdentity) -> bool {
    identity
        .automation_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || !identity.parent_path.is_empty()
}

fn point_hits_target(event: &TestSessionEventRecord, identity: &UiElementIdentity) -> bool {
    // UIA boundingRect is physical screen pixels. Prefer hook physical x/y.
    let (Some(x), Some(y), Some(rect)) = (
        event.x.or(event.logical_x),
        event.y.or(event.logical_y),
        identity.bounding_rect.as_ref(),
    ) else {
        return false;
    };
    let right = rect.left.saturating_add(rect.width as i32);
    let bottom = rect.top.saturating_add(rect.height as i32);
    x >= rect.left && x <= right && y >= rect.top && y <= bottom
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchSignal {
    Match,
    Mismatch,
    Unknown,
}

fn same_process_signal(
    event: &TestSessionEventRecord,
    identity: &UiElementIdentity,
) -> MatchSignal {
    match (event.window_pid, identity.process_id) {
        (Some(left), Some(right)) if left == right => MatchSignal::Match,
        (Some(_), Some(_)) => MatchSignal::Mismatch,
        _ => MatchSignal::Unknown,
    }
}

fn same_window_signal(event: &TestSessionEventRecord, identity: &UiElementIdentity) -> MatchSignal {
    match (
        event.window_hwnd.as_deref().map(normalize_match_part),
        identity.window_hwnd.as_deref().map(normalize_match_part),
    ) {
        (Some(left), Some(right)) if left == right => MatchSignal::Match,
        (Some(_), Some(_)) => MatchSignal::Mismatch,
        _ => MatchSignal::Unknown,
    }
}

fn normalize_match_part(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn payload_privacy_class(event: &SemanticEventRecord) -> PrivacyClass {
    event
        .payload
        .get("privacyClass")
        .cloned()
        .and_then(|value| serde_json::from_value::<PrivacyClass>(value).ok())
        .unwrap_or_else(|| event.privacy_class.clone())
}

fn bool_field(payload: &Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(Value::as_bool)
}

fn f64_field(payload: &Value, key: &str) -> Option<f64> {
    payload.get(key).and_then(Value::as_f64)
}

fn u32_field(payload: &Value, key: &str) -> Option<u32> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn enum_field<T>(payload: &Value, key: &str) -> Option<T>
where
    T: for<'de> serde::Deserialize<'de>,
{
    payload
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value::<T>(value).ok())
}

fn property_matches(payload: &Value, expected: &str) -> bool {
    payload
        .get("property")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn property_bool_after(payload: &Value, property: &str) -> Option<bool> {
    property_matches(payload, property)
        .then(|| payload.get("after").and_then(Value::as_bool))
        .flatten()
}

fn property_f64_after(payload: &Value, property: &str) -> Option<f64> {
    property_matches(payload, property)
        .then(|| payload.get("after").and_then(Value::as_f64))
        .flatten()
}

fn property_u32_after(payload: &Value, property: &str) -> Option<u32> {
    property_matches(payload, property)
        .then(|| {
            payload
                .get("after")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        })
        .flatten()
}

fn property_enum_after<T>(payload: &Value, property: &str) -> Option<T>
where
    T: for<'de> serde::Deserialize<'de>,
{
    property_matches(payload, property)
        .then(|| {
            payload
                .get("after")
                .cloned()
                .and_then(|value| serde_json::from_value::<T>(value).ok())
        })
        .flatten()
}

fn push_unique(reason_codes: &mut Vec<OperationReasonCode>, reason_code: OperationReasonCode) {
    if !reason_codes.contains(&reason_code) {
        reason_codes.push(reason_code);
    }
}

fn round_confidence(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::models::{
        TEST_SESSION_EVENT_KIND, TEST_SESSION_SCHEMA_VERSION, TestSessionEventType,
    };
    use crate::session::operation_models::{TEST_SESSION_SEMANTIC_EVENT_KIND, UiElementPathEntry};

    fn action_event(id: &str, at: u64) -> TestSessionEventRecord {
        TestSessionEventRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id: id.to_string(),
            session_id: "ts-1".to_string(),
            event_type: TestSessionEventType::StepCaptured,
            occurred_at_ms: at,
            status: None,
            step_id: None,
            action: Some("WM_LBUTTONUP".to_string()),
            x: Some(125),
            y: Some(220),
            logical_x: Some(125),
            logical_y: Some(220),
            window_left: Some(100),
            window_top: Some(200),
            window_right: Some(500),
            window_bottom: Some(500),
            logical_window_left: Some(100),
            logical_window_top: Some(200),
            logical_window_right: Some(500),
            logical_window_bottom: Some(500),
            display_id: Some("display-1".to_string()),
            dpi_scale: Some(1.0),
            process_name: Some("app.exe".to_string()),
            window_title: Some("Editor".to_string()),
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: Some("0x100".to_string()),
            window_pid: Some(42),
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

    fn semantic_event(
        id: &str,
        event_type: SemanticEventType,
        at: u64,
        source_event_id: Option<&str>,
        payload: Value,
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
            reason_codes: Vec::new(),
        }
    }

    #[test]
    fn chooses_runtime_focus_and_point_hit_target_with_state_before() {
        let event = action_event("input-save", 1_000);
        let semantic_events = vec![semantic_event(
            "sem-save-target",
            SemanticEventType::UiaFocusChanged,
            980,
            Some("input-save"),
            json!({
                "runtimeId": [1, 2, 3],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Save",
                "automationId": "btnSave",
                "controlType": "Button",
                "parentPath": [
                    { "controlType": "Window", "name": "Editor", "automationId": null }
                ],
                "boundingRect": { "left": 110, "top": 210, "width": 80, "height": 32 },
                "hasKeyboardFocus": true,
                "isEnabled": true
            }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);

        let target = correlation.target.expect("target");
        assert_eq!(target.name.as_deref(), Some("Save"));
        assert!(correlation.state_before.is_some());
        assert!(correlation.confidence.overall.unwrap() >= 0.80);
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::RuntimeIdMatch)
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::FocusMatch)
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::PointHit)
        );
    }

    #[test]
    fn chooses_nearest_richer_candidate_and_marks_multiple_candidates() {
        let event = action_event("input-select", 2_000);
        let semantic_events = vec![
            semantic_event(
                "sem-weak",
                SemanticEventType::UiaSnapshot,
                1_990,
                None,
                json!({
                    "name": "Generic pane",
                    "controlType": "Pane",
                    "processId": 42
                }),
            ),
            semantic_event(
                "sem-rich",
                SemanticEventType::UiaSnapshot,
                2_020,
                None,
                json!({
                    "runtimeId": [9, 9],
                    "processId": 42,
                    "windowHwnd": "0x100",
                    "name": "Balanced",
                    "automationId": "modeBalanced",
                    "controlType": "ListItem",
                    "parentPath": [
                        { "controlType": "ComboBox", "name": "Mode", "automationId": "mode" }
                    ],
                    "boundingRect": { "left": 100, "top": 200, "width": 120, "height": 40 }
                }),
            ),
        ];

        let correlation = correlate_action_target(&event, &semantic_events);

        assert_eq!(
            correlation
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Balanced")
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::MultipleCandidates)
        );
    }

    #[test]
    fn falls_back_to_window_and_coordinate_when_no_semantic_target() {
        let event = action_event("input-coordinate", 3_000);

        let correlation = correlate_action_target(&event, &[]);

        assert_eq!(
            correlation
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Editor")
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::CoordinateFallback)
        );
        assert!(correlation.confidence.overall.unwrap() < 0.50);
    }

    #[test]
    fn ignores_explicit_source_events_from_other_actions() {
        let event = action_event("input-current", 4_000);
        let semantic_events = vec![semantic_event(
            "sem-other",
            SemanticEventType::UiaFocusChanged,
            4_020,
            Some("input-other"),
            json!({
                "runtimeId": [7, 7],
                "processId": 42,
                "name": "Wrong"
            }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);

        assert_ne!(
            correlation
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Wrong")
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::CoordinateFallback)
        );
    }

    #[test]
    fn ignores_lifecycle_events_as_action_targets() {
        let event = action_event("input-open", 4_500);
        let semantic_events = vec![semantic_event(
            "sem-result-popup",
            SemanticEventType::PopupAppeared,
            4_620,
            Some("input-open"),
            json!({
                "runtimeId": [4, 20],
                "processId": 42,
                "name": "Opened"
            }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);

        assert_ne!(
            correlation
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Opened")
        );
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::CoordinateFallback)
        );
    }

    #[test]
    fn point_hit_uses_physical_coordinates_not_logical_dpi_scaled() {
        let mut event = action_event("input-dpi", 6_000);
        event.x = Some(250);
        event.y = Some(440);
        event.logical_x = Some(125);
        event.logical_y = Some(220);
        event.dpi_scale = Some(2.0);
        let semantic_events = vec![semantic_event(
            "sem-physical",
            SemanticEventType::UiaSnapshot,
            6_000,
            Some("input-dpi"),
            json!({
                "runtimeId": [3, 3],
                "processId": 42,
                "name": "Save",
                "controlType": "Button",
                "boundingRect": { "left": 240, "top": 420, "width": 40, "height": 32 }
            }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);
        assert!(
            correlation
                .reason_codes
                .contains(&OperationReasonCode::PointHit)
        );
        assert_eq!(
            correlation
                .target
                .as_ref()
                .and_then(|target| target.name.as_deref()),
            Some("Save")
        );
    }

    #[test]
    fn accepts_pre_state_captured_slightly_after_action_as_state_before() {
        let event = action_event("input-pre", 7_000);
        let semantic_events = vec![semantic_event(
            "sem-pre",
            SemanticEventType::UiaSnapshot,
            7_001,
            Some("input-pre"),
            json!({
                "runtimeId": [8, 8],
                "processId": 42,
                "name": "Enable sync",
                "controlType": "CheckBox",
                "toggleState": "off",
                "stateSnapshot": {
                    "snapshotId": "state-pre-input-pre",
                    "capturedAtMs": 7001,
                    "element": {
                        "runtimeId": [8, 8],
                        "processId": 42,
                        "name": "Enable sync",
                        "controlType": "CheckBox"
                    },
                    "toggleState": "off",
                    "privacyClass": "not-sensitive"
                }
            }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);
        assert_eq!(
            correlation
                .state_before
                .as_ref()
                .and_then(|snapshot| snapshot.toggle_state.clone()),
            Some(ToggleState::Off)
        );
    }

    #[test]
    fn parses_nested_state_snapshot_element() {
        let event = action_event("input-toggle", 5_000);
        let element = UiElementIdentity {
            runtime_id: Some(vec![5, 5]),
            process_id: Some(42),
            name: Some("Enable".to_string()),
            parent_path: vec![UiElementPathEntry {
                control_type: Some("Window".to_string()),
                name: Some("Editor".to_string()),
                automation_id: None,
            }],
            ..UiElementIdentity::default()
        };
        let snapshot = UiStateSnapshot {
            snapshot_id: "state-before-toggle".to_string(),
            captured_at_ms: 4_980,
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
            "sem-before",
            SemanticEventType::UiaSnapshot,
            4_980,
            Some("input-toggle"),
            json!({ "stateSnapshot": snapshot }),
        )];

        let correlation = correlate_action_target(&event, &semantic_events);

        assert_eq!(
            correlation
                .state_before
                .and_then(|state| state.toggle_state),
            Some(ToggleState::Off)
        );
    }
}
