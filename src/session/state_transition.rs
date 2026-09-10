use serde_json::{Value, json};

use super::action_correlator::{extract_event_target, extract_state_snapshot};
use super::operation_models::{
    ObserverHealthState, OperationReasonCode, PrivacyClass, SemanticEventRecord, SemanticEventType,
    StateTransition, StateTransitionConfidence, StateTransitionKind, UiElementIdentity,
    UiStateSnapshot,
};

const RANGE_VALUE_EPSILON: f64 = 0.0001;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PropertyFact {
    ValueLength,
    ToggleState,
    SelectionState,
    ExpandCollapseState,
    RangeValue,
    IsEnabled,
    HasKeyboardFocus,
}

impl PropertyFact {
    fn as_str(self) -> &'static str {
        match self {
            Self::ValueLength => "valueLength",
            Self::ToggleState => "toggleState",
            Self::SelectionState => "selectionState",
            Self::ExpandCollapseState => "expandCollapseState",
            Self::RangeValue => "rangeValue",
            Self::IsEnabled => "isEnabled",
            Self::HasKeyboardFocus => "hasKeyboardFocus",
        }
    }

    fn reason_code(self) -> OperationReasonCode {
        match self {
            Self::ValueLength => OperationReasonCode::ValueLengthChanged,
            Self::ToggleState => OperationReasonCode::ToggleStateChanged,
            Self::SelectionState => OperationReasonCode::SelectionChanged,
            Self::ExpandCollapseState => OperationReasonCode::ExpandStateChanged,
            Self::RangeValue => OperationReasonCode::RangeValueChanged,
            Self::IsEnabled => OperationReasonCode::EnabledStateChanged,
            Self::HasKeyboardFocus => OperationReasonCode::FocusChanged,
        }
    }
}

#[allow(dead_code)]
pub fn build_state_transitions_from_events(
    semantic_events: &[SemanticEventRecord],
) -> Vec<StateTransition> {
    let mut ordered = semantic_events.to_vec();
    ordered.sort_by_key(|event| (event.occurred_at_ms, event.event_id.clone()));
    ordered
        .iter()
        .filter_map(build_state_transition_from_event)
        .collect()
}

pub fn build_state_transition_from_event(event: &SemanticEventRecord) -> Option<StateTransition> {
    match event.event_type {
        SemanticEventType::UiaPropertyChanged
        | SemanticEventType::UiaSelectionChanged
        | SemanticEventType::UiaFocusChanged => property_transition(event),
        SemanticEventType::WindowOpened
        | SemanticEventType::WindowClosed
        | SemanticEventType::PopupAppeared
        | SemanticEventType::DialogAppeared => lifecycle_transition(event),
        SemanticEventType::UiaStructureChanged => structure_transition(event),
        SemanticEventType::ObserverHealth => observer_health_transition(event),
        SemanticEventType::UiaSnapshot | SemanticEventType::Other(_) => None,
    }
}

fn property_transition(event: &SemanticEventRecord) -> Option<StateTransition> {
    let fact = property_fact_for_event(event)?;
    let (before, after) = property_before_after(event, fact);
    if !is_observed_or_changed(fact, before.as_ref(), after.as_ref()) {
        return None;
    }

    let element = transition_element(event);
    let mut reason_codes = event.reason_codes.clone();
    push_unique(&mut reason_codes, fact.reason_code());

    Some(StateTransition {
        transition_id: transition_id(event, fact.as_str()),
        kind: StateTransitionKind::Property,
        occurred_at_ms: event.occurred_at_ms,
        element: element.clone(),
        property: Some(fact.as_str().to_string()),
        before,
        after,
        privacy_class: transition_privacy_class(event),
        source_event_ids: vec![event.event_id.clone()],
        reason_codes,
        confidence: confidence_for_transition(element.as_ref(), 0.95),
    })
}

fn lifecycle_transition(event: &SemanticEventRecord) -> Option<StateTransition> {
    let (property, before_visible, after_visible, reason_code) = match event.event_type {
        SemanticEventType::WindowOpened => {
            ("window", false, true, OperationReasonCode::WindowOpened)
        }
        SemanticEventType::WindowClosed => {
            ("window", true, false, OperationReasonCode::WindowClosed)
        }
        SemanticEventType::PopupAppeared => {
            ("popup", false, true, OperationReasonCode::PopupAppeared)
        }
        SemanticEventType::DialogAppeared => {
            ("dialog", false, true, OperationReasonCode::DialogAppeared)
        }
        _ => return None,
    };
    let element = transition_element(event);
    let mut reason_codes = event.reason_codes.clone();
    push_unique(&mut reason_codes, reason_code);

    Some(StateTransition {
        transition_id: transition_id(event, property),
        kind: StateTransitionKind::Lifecycle,
        occurred_at_ms: event.occurred_at_ms,
        element: element.clone(),
        property: Some(property.to_string()),
        before: Some(json!({ "visible": before_visible })),
        after: Some(json!({ "visible": after_visible })),
        privacy_class: transition_privacy_class(event),
        source_event_ids: vec![event.event_id.clone()],
        reason_codes,
        confidence: confidence_for_transition(element.as_ref(), 0.90),
    })
}

fn structure_transition(event: &SemanticEventRecord) -> Option<StateTransition> {
    let element = transition_element(event);
    let mut reason_codes = event.reason_codes.clone();
    push_unique(&mut reason_codes, OperationReasonCode::StructureChanged);
    let after = if event
        .payload
        .as_object()
        .map(|payload| payload.is_empty())
        .unwrap_or(true)
    {
        json!({ "changed": true })
    } else {
        event.payload.clone()
    };

    Some(StateTransition {
        transition_id: transition_id(event, "structure"),
        kind: StateTransitionKind::Structure,
        occurred_at_ms: event.occurred_at_ms,
        element: element.clone(),
        property: Some("structure".to_string()),
        before: None,
        after: Some(after),
        privacy_class: transition_privacy_class(event),
        source_event_ids: vec![event.event_id.clone()],
        reason_codes,
        confidence: confidence_for_transition(element.as_ref(), 0.60),
    })
}

fn observer_health_transition(event: &SemanticEventRecord) -> Option<StateTransition> {
    let state = event
        .payload
        .get("state")
        .cloned()
        .and_then(|value| serde_json::from_value::<ObserverHealthState>(value).ok());
    let mut reason_codes = event.reason_codes.clone();
    if let Some(state) = state.as_ref() {
        match state {
            ObserverHealthState::Timeout => {
                push_unique(&mut reason_codes, OperationReasonCode::UiaTimeout)
            }
            ObserverHealthState::CircuitOpen => {
                push_unique(&mut reason_codes, OperationReasonCode::UiaCircuitOpen)
            }
            ObserverHealthState::QueueOverflow => {
                push_unique(&mut reason_codes, OperationReasonCode::QueueOverflow)
            }
            ObserverHealthState::Restarted => {
                push_unique(&mut reason_codes, OperationReasonCode::ObserverRestarted)
            }
            ObserverHealthState::TargetProcessExited => push_unique(
                &mut reason_codes,
                OperationReasonCode::TargetProcessMismatch,
            ),
            ObserverHealthState::Healthy | ObserverHealthState::Other(_) => {}
        }
    }
    if event
        .payload
        .get("queueOverflowCount")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        push_unique(&mut reason_codes, OperationReasonCode::QueueOverflow);
    }

    if reason_codes.is_empty() && state == Some(ObserverHealthState::Healthy) {
        return None;
    }

    Some(StateTransition {
        transition_id: transition_id(event, "observerHealth"),
        kind: StateTransitionKind::ObserverHealth,
        occurred_at_ms: event.occurred_at_ms,
        element: None,
        property: Some("observerHealth".to_string()),
        before: None,
        after: Some(event.payload.clone()),
        privacy_class: transition_privacy_class(event),
        source_event_ids: vec![event.event_id.clone()],
        reason_codes,
        confidence: StateTransitionConfidence {
            identity: None,
            temporal: Some(1.0),
            transition: Some(0.80),
            overall: Some(0.90),
        },
    })
}

fn property_fact_for_event(event: &SemanticEventRecord) -> Option<PropertyFact> {
    if event.event_type == SemanticEventType::UiaFocusChanged {
        return Some(PropertyFact::HasKeyboardFocus);
    }
    if event.event_type == SemanticEventType::UiaSelectionChanged {
        return Some(PropertyFact::SelectionState);
    }

    for reason in &event.reason_codes {
        match reason {
            OperationReasonCode::ValueLengthChanged => return Some(PropertyFact::ValueLength),
            OperationReasonCode::ToggleStateChanged => return Some(PropertyFact::ToggleState),
            OperationReasonCode::SelectionChanged => return Some(PropertyFact::SelectionState),
            OperationReasonCode::ExpandStateChanged => {
                return Some(PropertyFact::ExpandCollapseState);
            }
            OperationReasonCode::RangeValueChanged => return Some(PropertyFact::RangeValue),
            OperationReasonCode::EnabledStateChanged => return Some(PropertyFact::IsEnabled),
            OperationReasonCode::FocusChanged => return Some(PropertyFact::HasKeyboardFocus),
            _ => {}
        }
    }

    event
        .payload
        .get("property")
        .and_then(Value::as_str)
        .and_then(canonical_property_fact)
        .or_else(|| snapshot_property_fact(event))
}

fn canonical_property_fact(value: &str) -> Option<PropertyFact> {
    let normalized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized.contains("toggle") {
        Some(PropertyFact::ToggleState)
    } else if normalized.contains("selection") || normalized.contains("isselected") {
        Some(PropertyFact::SelectionState)
    } else if normalized.contains("expandcollapse") || normalized.contains("expand") {
        Some(PropertyFact::ExpandCollapseState)
    } else if normalized.contains("rangevalue") || normalized.contains("range") {
        Some(PropertyFact::RangeValue)
    } else if normalized.contains("isenabled") || normalized.ends_with("enabled") {
        Some(PropertyFact::IsEnabled)
    } else if normalized.contains("keyboardfocus") || normalized.contains("focus") {
        Some(PropertyFact::HasKeyboardFocus)
    } else if normalized.contains("valuelength") || normalized.contains("value") {
        Some(PropertyFact::ValueLength)
    } else {
        None
    }
}

fn snapshot_property_fact(event: &SemanticEventRecord) -> Option<PropertyFact> {
    let snapshot = extract_state_snapshot(event)?;
    if snapshot.value_text.is_some() || snapshot.value_length.is_some() {
        Some(PropertyFact::ValueLength)
    } else if snapshot.toggle_state.is_some() {
        Some(PropertyFact::ToggleState)
    } else if snapshot.selected_names.is_some() || snapshot.selection_state.is_some() {
        Some(PropertyFact::SelectionState)
    } else if snapshot.expand_collapse_state.is_some() {
        Some(PropertyFact::ExpandCollapseState)
    } else if snapshot.range_value.is_some() {
        Some(PropertyFact::RangeValue)
    } else if snapshot.is_enabled.is_some() {
        Some(PropertyFact::IsEnabled)
    } else if snapshot.has_keyboard_focus.is_some() {
        Some(PropertyFact::HasKeyboardFocus)
    } else {
        None
    }
}

fn property_before_after(
    event: &SemanticEventRecord,
    fact: PropertyFact,
) -> (Option<Value>, Option<Value>) {
    let before_snapshot = payload_snapshot(&event.payload, "stateBefore");
    let after_snapshot =
        payload_snapshot(&event.payload, "stateAfter").or_else(|| extract_state_snapshot(event));
    let privacy_class = transition_privacy_class(event);

    let before = event
        .payload
        .get("before")
        .cloned()
        .or_else(|| event.payload.get("beforeLength").cloned())
        .or_else(|| {
            before_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot_value(snapshot, fact))
        })
        .and_then(|value| normalize_property_value(fact, value, &privacy_class));
    let after = event
        .payload
        .get("after")
        .cloned()
        .or_else(|| event.payload.get("afterLength").cloned())
        .or_else(|| event.payload.get(fact.as_str()).cloned())
        .or_else(|| {
            after_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot_value(snapshot, fact))
        })
        .or_else(|| focus_after_value(event, fact))
        .and_then(|value| normalize_property_value(fact, value, &privacy_class));

    (before, after)
}

fn payload_snapshot(payload: &Value, key: &str) -> Option<UiStateSnapshot> {
    payload
        .get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .and_then(|value| serde_json::from_value::<UiStateSnapshot>(value).ok())
}

fn transition_privacy_class(event: &SemanticEventRecord) -> PrivacyClass {
    [
        Some(event.privacy_class.clone()),
        payload_privacy_class(&event.payload),
        payload_snapshot(&event.payload, "stateBefore").map(|snapshot| snapshot.privacy_class),
        payload_snapshot(&event.payload, "stateAfter").map(|snapshot| snapshot.privacy_class),
    ]
    .into_iter()
    .flatten()
    .max_by_key(privacy_rank)
    .unwrap_or(PrivacyClass::Unknown)
}

fn payload_privacy_class(payload: &Value) -> Option<PrivacyClass> {
    payload
        .get("privacyClass")
        .and_then(Value::as_str)
        .map(PrivacyClass::from_wire)
}

fn privacy_rank(value: &PrivacyClass) -> u8 {
    match value {
        PrivacyClass::PasswordRedacted => 5,
        PrivacyClass::SensitiveRedacted => 4,
        PrivacyClass::TextLengthOnly => 3,
        PrivacyClass::NotSensitive => 2,
        PrivacyClass::Unknown => 1,
        PrivacyClass::Other(_) => 0,
    }
}

fn snapshot_value(snapshot: &UiStateSnapshot, fact: PropertyFact) -> Option<Value> {
    match fact {
        // Prefer concrete text / selection labels for defect-evidence repro steps.
        PropertyFact::ValueLength => snapshot
            .value_text
            .as_ref()
            .filter(|text| !text.is_empty())
            .map(|text| Value::String(text.clone()))
            .or_else(|| snapshot.value_length.map(Value::from)),
        PropertyFact::ToggleState => snapshot
            .toggle_state
            .as_ref()
            .and_then(|value| serde_json::to_value(value).ok()),
        PropertyFact::SelectionState => snapshot
            .selected_names
            .as_ref()
            .filter(|names| !names.is_empty())
            .map(|names| {
                if names.len() == 1 {
                    Value::String(names[0].clone())
                } else {
                    Value::Array(names.iter().cloned().map(Value::String).collect())
                }
            })
            .or_else(|| {
                snapshot
                    .selection_state
                    .as_ref()
                    .and_then(|value| serde_json::to_value(value).ok())
            }),
        PropertyFact::ExpandCollapseState => snapshot
            .expand_collapse_state
            .as_ref()
            .and_then(|value| serde_json::to_value(value).ok()),
        PropertyFact::RangeValue => snapshot.range_value.map(Value::from),
        PropertyFact::IsEnabled => snapshot.is_enabled.map(Value::from),
        PropertyFact::HasKeyboardFocus => snapshot.has_keyboard_focus.map(Value::from),
    }
}

fn normalize_property_value(
    fact: PropertyFact,
    value: Value,
    privacy_class: &PrivacyClass,
) -> Option<Value> {
    if value.is_null() {
        return None;
    }
    match fact {
        PropertyFact::ValueLength => normalize_value_length(value, privacy_class),
        PropertyFact::SelectionState => normalize_selection_state(value),
        PropertyFact::ToggleState
        | PropertyFact::ExpandCollapseState
        | PropertyFact::RangeValue
        | PropertyFact::IsEnabled
        | PropertyFact::HasKeyboardFocus => Some(value),
    }
}

fn normalize_value_length(value: Value, privacy_class: &PrivacyClass) -> Option<Value> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if matches!(privacy_class, PrivacyClass::TextLengthOnly) {
                Some(Value::from(trimmed.chars().count() as u64))
            } else if matches!(
                privacy_class,
                PrivacyClass::PasswordRedacted | PrivacyClass::SensitiveRedacted
            ) {
                None
            } else if trimmed.is_empty() {
                Some(Value::from(0u64))
            } else {
                Some(Value::String(trimmed.to_string()))
            }
        }
        Value::Number(number) => Some(Value::Number(number)),
        Value::Object(map) => map
            .get("valueText")
            .cloned()
            .and_then(|value| normalize_value_length(value, privacy_class))
            .or_else(|| {
                map.get("valueLength")
                    .or_else(|| map.get("length"))
                    .cloned()
                    .and_then(|value| normalize_value_length(value, privacy_class))
            }),
        _ => None,
    }
}

fn normalize_selection_state(value: Value) -> Option<Value> {
    match value {
        Value::Bool(true) => Some(Value::String("selected".to_string())),
        Value::Bool(false) => Some(Value::String("notSelected".to_string())),
        other => Some(other),
    }
}

fn focus_after_value(event: &SemanticEventRecord, fact: PropertyFact) -> Option<Value> {
    if fact == PropertyFact::HasKeyboardFocus
        && event.event_type == SemanticEventType::UiaFocusChanged
    {
        Some(Value::Bool(true))
    } else {
        None
    }
}

fn is_observed_or_changed(
    fact: PropertyFact,
    before: Option<&Value>,
    after: Option<&Value>,
) -> bool {
    let Some(after) = after else {
        return false;
    };
    let Some(before) = before else {
        return !is_unknown_value(after);
    };
    if is_unknown_value(after) {
        return false;
    }
    if is_unknown_value(before) {
        return true;
    }
    !values_equal(fact, before, after)
}

fn is_unknown_value(value: &Value) -> bool {
    value
        .as_str()
        .map(|text| text.trim().eq_ignore_ascii_case("unknown"))
        .unwrap_or(false)
}

fn values_equal(fact: PropertyFact, before: &Value, after: &Value) -> bool {
    if fact == PropertyFact::RangeValue {
        match (before.as_f64(), after.as_f64()) {
            (Some(left), Some(right)) => (left - right).abs() <= RANGE_VALUE_EPSILON,
            _ => before == after,
        }
    } else {
        before == after
    }
}

fn transition_element(event: &SemanticEventRecord) -> Option<UiElementIdentity> {
    extract_event_target(event)
        .or_else(|| {
            payload_snapshot(&event.payload, "stateAfter").and_then(|snapshot| snapshot.element)
        })
        .or_else(|| {
            payload_snapshot(&event.payload, "stateBefore").and_then(|snapshot| snapshot.element)
        })
}

fn transition_id(event: &SemanticEventRecord, property: &str) -> String {
    format!("transition-{}-{property}", event.event_id)
}

fn confidence_for_transition(
    element: Option<&UiElementIdentity>,
    transition_confidence: f64,
) -> StateTransitionConfidence {
    let identity = element.map(|element| {
        if element
            .runtime_id
            .as_ref()
            .map(|runtime_id| !runtime_id.is_empty())
            .unwrap_or(false)
        {
            0.95
        } else {
            0.72
        }
    });
    let temporal = Some(1.0);
    let transition = Some(transition_confidence);
    let overall = Some(round_confidence(
        [identity, temporal, transition]
            .into_iter()
            .flatten()
            .sum::<f64>()
            / if identity.is_some() { 3.0 } else { 2.0 },
    ));

    StateTransitionConfidence {
        identity,
        temporal,
        transition,
        overall,
    }
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
    use super::*;
    use crate::session::operation_models::{
        ExpandCollapseState, PrivacyClass, SelectionState, TEST_SESSION_SEMANTIC_EVENT_KIND,
        ToggleState, UiStateSnapshotSource,
    };

    fn semantic_event(
        id: &str,
        event_type: SemanticEventType,
        at: u64,
        payload: Value,
        reason_codes: Vec<OperationReasonCode>,
    ) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: 1,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: id.to_string(),
            session_id: "ts-1".to_string(),
            event_type,
            occurred_at_ms: at,
            monotonic_offset_ms: Some(at),
            source_event_id: None,
            target: None,
            payload,
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes,
        }
    }

    #[test]
    fn state_transition_builds_first_batch_property_facts() {
        let events = vec![
            semantic_event(
                "value",
                SemanticEventType::UiaPropertyChanged,
                100,
                json!({ "runtimeId": [1], "property": "valueLength", "before": 1, "after": 2 }),
                Vec::new(),
            ),
            semantic_event(
                "toggle",
                SemanticEventType::UiaPropertyChanged,
                110,
                json!({ "runtimeId": [2], "property": "toggleState", "before": "off", "after": "on" }),
                Vec::new(),
            ),
            semantic_event(
                "select",
                SemanticEventType::UiaSelectionChanged,
                120,
                json!({ "runtimeId": [3], "before": false, "after": true }),
                Vec::new(),
            ),
            semantic_event(
                "expand",
                SemanticEventType::UiaPropertyChanged,
                130,
                json!({ "runtimeId": [4], "property": "expandCollapseState", "before": "collapsed", "after": "expanded" }),
                Vec::new(),
            ),
            semantic_event(
                "range",
                SemanticEventType::UiaPropertyChanged,
                140,
                json!({ "runtimeId": [5], "property": "rangeValue", "before": 1.0, "after": 2.5 }),
                Vec::new(),
            ),
            semantic_event(
                "enabled",
                SemanticEventType::UiaPropertyChanged,
                150,
                json!({ "runtimeId": [6], "property": "isEnabled", "before": false, "after": true }),
                Vec::new(),
            ),
            semantic_event(
                "focus",
                SemanticEventType::UiaFocusChanged,
                160,
                json!({ "runtimeId": [7], "hasKeyboardFocus": true }),
                Vec::new(),
            ),
        ];

        let transitions = build_state_transitions_from_events(&events);
        let properties = transitions
            .iter()
            .map(|transition| transition.property.as_deref().unwrap_or(""))
            .collect::<Vec<_>>();

        assert_eq!(
            properties,
            vec![
                "valueLength",
                "toggleState",
                "selectionState",
                "expandCollapseState",
                "rangeValue",
                "isEnabled",
                "hasKeyboardFocus"
            ]
        );
        assert_eq!(transitions[2].after, Some(json!("selected")));
        assert!(
            transitions[0]
                .reason_codes
                .contains(&OperationReasonCode::ValueLengthChanged)
        );
        assert!(
            transitions[6]
                .reason_codes
                .contains(&OperationReasonCode::FocusChanged)
        );
    }

    #[test]
    fn state_transition_maps_window_popup_dialog_and_structure_lifecycle() {
        let events = vec![
            semantic_event(
                "window-opened",
                SemanticEventType::WindowOpened,
                100,
                json!({ "runtimeId": [10], "name": "Editor" }),
                Vec::new(),
            ),
            semantic_event(
                "window-closed",
                SemanticEventType::WindowClosed,
                110,
                json!({ "runtimeId": [10], "name": "Editor" }),
                Vec::new(),
            ),
            semantic_event(
                "popup",
                SemanticEventType::PopupAppeared,
                120,
                json!({ "runtimeId": [11], "name": "Saved" }),
                Vec::new(),
            ),
            semantic_event(
                "dialog",
                SemanticEventType::DialogAppeared,
                130,
                json!({ "runtimeId": [12], "name": "Validation error" }),
                Vec::new(),
            ),
            semantic_event(
                "structure",
                SemanticEventType::UiaStructureChanged,
                140,
                json!({ "runtimeId": [13], "change": "childrenInvalidated" }),
                Vec::new(),
            ),
        ];

        let transitions = build_state_transitions_from_events(&events);

        assert_eq!(transitions.len(), 5);
        assert_eq!(transitions[0].kind, StateTransitionKind::Lifecycle);
        assert_eq!(transitions[0].property.as_deref(), Some("window"));
        assert_eq!(transitions[0].after, Some(json!({ "visible": true })));
        assert_eq!(transitions[1].after, Some(json!({ "visible": false })));
        assert_eq!(transitions[2].property.as_deref(), Some("popup"));
        assert_eq!(transitions[3].property.as_deref(), Some("dialog"));
        assert_eq!(transitions[4].kind, StateTransitionKind::Structure);
        assert!(
            transitions[4]
                .reason_codes
                .contains(&OperationReasonCode::StructureChanged)
        );
    }

    #[test]
    fn state_transition_skips_duplicate_values_and_range_noise() {
        let events = vec![
            semantic_event(
                "same-toggle",
                SemanticEventType::UiaPropertyChanged,
                100,
                json!({ "runtimeId": [1], "property": "toggleState", "before": "on", "after": "on" }),
                Vec::new(),
            ),
            semantic_event(
                "range-noise",
                SemanticEventType::UiaPropertyChanged,
                110,
                json!({ "runtimeId": [2], "property": "rangeValue", "before": 10.0, "after": 10.00005 }),
                Vec::new(),
            ),
        ];

        let transitions = build_state_transitions_from_events(&events);

        assert!(transitions.is_empty());
    }

    #[test]
    fn state_transition_keeps_unknown_to_known_observation() {
        let event = semantic_event(
            "unknown-toggle",
            SemanticEventType::UiaPropertyChanged,
            100,
            json!({ "runtimeId": [1], "property": "toggleState", "before": "unknown", "after": "on" }),
            Vec::new(),
        );

        let transition = build_state_transition_from_event(&event).expect("observed transition");

        assert_eq!(transition.before, Some(json!("unknown")));
        assert_eq!(transition.after, Some(json!("on")));
    }

    #[test]
    fn state_transition_orders_out_of_order_events() {
        let events = vec![
            semantic_event(
                "b",
                SemanticEventType::UiaPropertyChanged,
                200,
                json!({ "runtimeId": [2], "property": "isEnabled", "before": false, "after": true }),
                Vec::new(),
            ),
            semantic_event(
                "a",
                SemanticEventType::UiaPropertyChanged,
                100,
                json!({ "runtimeId": [1], "property": "toggleState", "before": "off", "after": "on" }),
                Vec::new(),
            ),
        ];

        let transitions = build_state_transitions_from_events(&events);

        assert_eq!(
            transitions
                .iter()
                .map(|transition| transition.source_event_ids[0].as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn state_transition_uses_state_cache_snapshots_for_before_after() {
        let element = UiElementIdentity {
            runtime_id: Some(vec![42, 7]),
            process_id: Some(100),
            name: Some("Enable sync".to_string()),
            ..UiElementIdentity::default()
        };
        let before = state_snapshot(
            "before",
            90,
            element.clone(),
            Some(ToggleState::Off),
            None,
            None,
        );
        let after = state_snapshot("after", 100, element, Some(ToggleState::On), None, None);
        let event = semantic_event(
            "cache-toggle",
            SemanticEventType::UiaPropertyChanged,
            100,
            json!({
                "property": "toggleState",
                "stateBefore": before,
                "stateAfter": after
            }),
            Vec::new(),
        );

        let transition = build_state_transition_from_event(&event).expect("snapshot transition");

        assert_eq!(transition.before, Some(json!("off")));
        assert_eq!(transition.after, Some(json!("on")));
        assert_eq!(
            transition
                .element
                .as_ref()
                .and_then(|element| element.runtime_id.clone()),
            Some(vec![42, 7])
        );
    }

    #[test]
    fn state_transition_does_not_store_raw_text_values() {
        let event = semantic_event(
            "value-redacted",
            SemanticEventType::UiaPropertyChanged,
            100,
            json!({
                "runtimeId": [1],
                "property": "Value.Value",
                "before": "secret",
                "after": "secret-updated",
                "privacyClass": "text-length-only"
            }),
            vec![OperationReasonCode::ValueLengthChanged],
        );

        let transition = build_state_transition_from_event(&event).expect("value transition");

        assert_eq!(transition.property.as_deref(), Some("valueLength"));
        assert_eq!(transition.before, Some(json!(6)));
        assert_eq!(transition.after, Some(json!(14)));
        assert_eq!(transition.privacy_class, PrivacyClass::TextLengthOnly);
        assert_ne!(transition.after, Some(json!("secret-updated")));
    }

    #[test]
    fn state_transition_maps_observer_health_degradation_reason() {
        let event = semantic_event(
            "health",
            SemanticEventType::ObserverHealth,
            100,
            json!({ "state": "circuitOpen", "queueOverflowCount": 2 }),
            Vec::new(),
        );

        let transition = build_state_transition_from_event(&event).expect("health transition");

        assert_eq!(transition.kind, StateTransitionKind::ObserverHealth);
        assert!(
            transition
                .reason_codes
                .contains(&OperationReasonCode::UiaCircuitOpen)
        );
        assert!(
            transition
                .reason_codes
                .contains(&OperationReasonCode::QueueOverflow)
        );
    }

    fn state_snapshot(
        snapshot_id: &str,
        captured_at_ms: u64,
        element: UiElementIdentity,
        toggle_state: Option<ToggleState>,
        selection_state: Option<SelectionState>,
        expand_collapse_state: Option<ExpandCollapseState>,
    ) -> UiStateSnapshot {
        UiStateSnapshot {
            snapshot_id: snapshot_id.to_string(),
            captured_at_ms,
            element: Some(element),
            is_enabled: Some(true),
            has_keyboard_focus: Some(false),
            is_offscreen: Some(false),
            value_length: None,
            value_text: None,
            value_fingerprint: None,
            toggle_state,
            selection_state,
            selected_names: None,
            expand_collapse_state,
            range_value: None,
            privacy_class: PrivacyClass::NotSensitive,
            source: Some(UiStateSnapshotSource::UiaPropertyEvent),
        }
    }
}
