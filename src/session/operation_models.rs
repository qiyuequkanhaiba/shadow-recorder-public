use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use super::models::TEST_SESSION_SCHEMA_VERSION;

pub const TEST_SESSION_SEMANTIC_EVENT_KIND: &str = "reqcase.test-session-semantic-event";
pub const TEST_SESSION_OPERATION_KIND: &str = "reqcase.test-session-operation";
pub const TEST_SESSION_OPERATION_OVERRIDE_KIND: &str = "reqcase.test-session-operation-override";

fn empty_json_object() -> Value {
    Value::Object(Map::new())
}

fn default_privacy_class() -> PrivacyClass {
    PrivacyClass::Unknown
}

fn default_outcome_selection_source() -> OperationOutcomeSelectionSource {
    OperationOutcomeSelectionSource::Auto
}

fn is_auto_outcome_selection_source(value: &OperationOutcomeSelectionSource) -> bool {
    matches!(value, OperationOutcomeSelectionSource::Auto)
}

fn is_false(value: &bool) -> bool {
    !*value
}

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($variant:ident => $wire:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant,)+
            Other(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $wire,)+
                    Self::Other(value) => value.as_str(),
                }
            }

            pub fn from_wire(value: impl Into<String>) -> Self {
                let value = value.into();
                match value.as_str() {
                    $($wire => Self::$variant,)+
                    _ => Self::Other(value),
                }
            }

            pub fn is_known(&self) -> bool {
                !matches!(self, Self::Other(_))
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Ok(Self::from_wire(value))
            }
        }
    };
}

string_enum! {
    pub enum PrivacyClass {
        NotSensitive => "not-sensitive",
        TextLengthOnly => "text-length-only",
        PasswordRedacted => "password-redacted",
        SensitiveRedacted => "sensitive-redacted",
        Unknown => "unknown",
    }
}

#[allow(clippy::derivable_impls)]
impl Default for PrivacyClass {
    fn default() -> Self {
        Self::Unknown
    }
}

string_enum! {
    pub enum ToggleState {
        On => "on",
        Off => "off",
        Indeterminate => "indeterminate",
        Unknown => "unknown",
    }
}

string_enum! {
    pub enum SelectionState {
        Selected => "selected",
        NotSelected => "notSelected",
        Mixed => "mixed",
        Unknown => "unknown",
    }
}

string_enum! {
    pub enum ExpandCollapseState {
        Expanded => "expanded",
        Collapsed => "collapsed",
        PartiallyExpanded => "partiallyExpanded",
        LeafNode => "leafNode",
        Unknown => "unknown",
    }
}

string_enum! {
    pub enum UiStateSnapshotSource {
        UiaSnapshot => "uia-snapshot",
        UiaPropertyEvent => "uia-property-event",
        UiaFocusEvent => "uia-focus-event",
        DerivedFromEvent => "derived-from-event",
        Manual => "manual",
    }
}

string_enum! {
    pub enum SemanticEventType {
        UiaSnapshot => "uia_snapshot",
        UiaFocusChanged => "uia_focus_changed",
        UiaPropertyChanged => "uia_property_changed",
        UiaSelectionChanged => "uia_selection_changed",
        UiaStructureChanged => "uia_structure_changed",
        WindowOpened => "window_opened",
        WindowClosed => "window_closed",
        PopupAppeared => "popup_appeared",
        DialogAppeared => "dialog_appeared",
        ObserverHealth => "observer_health",
    }
}

string_enum! {
    pub enum ObserverHealthState {
        Healthy => "healthy",
        Timeout => "timeout",
        CircuitOpen => "circuitOpen",
        QueueOverflow => "queueOverflow",
        Restarted => "restarted",
        TargetProcessExited => "targetProcessExited",
    }
}

string_enum! {
    pub enum OperationActionKind {
        Click => "click",
        DoubleClick => "doubleClick",
        RightClick => "rightClick",
        Toggle => "toggle",
        Select => "select",
        Expand => "expand",
        Collapse => "collapse",
        TypeSummary => "typeSummary",
        Shortcut => "shortcut",
        Scroll => "scroll",
        WindowSwitch => "windowSwitch",
        ManualMark => "manualMark",
    }
}

string_enum! {
    pub enum StateTransitionKind {
        Property => "property",
        Lifecycle => "lifecycle",
        Structure => "structure",
        ObserverHealth => "observerHealth",
        Artifact => "artifact",
    }
}

string_enum! {
    pub enum OperationOutcomeStatus {
        Confirmed => "confirmed",
        Candidate => "candidate",
        Ambiguous => "ambiguous",
        Incomplete => "incomplete",
        ObserverDegraded => "observerDegraded",
        LegacyUnknown => "legacyUnknown",
    }
}

string_enum! {
    pub enum OperationOutcomeSelectionSource {
        Auto => "auto",
        Manual => "manual",
    }
}

#[allow(clippy::derivable_impls)]
impl Default for OperationOutcomeSelectionSource {
    fn default() -> Self {
        Self::Auto
    }
}

string_enum! {
    pub enum OperationEvidenceKind {
        RawEvent => "rawEvent",
        UiaSnapshot => "uiaSnapshot",
        StateTransition => "stateTransition",
        Screenshot => "screenshot",
        VideoRange => "videoRange",
        ManualNote => "manualNote",
    }
}

string_enum! {
    pub enum OperationEvidenceRole {
        SupportsTarget => "supportsTarget",
        SupportsOutcome => "supportsOutcome",
        Context => "context",
        Contradicts => "contradicts",
    }
}

impl OperationEvidenceRole {
    pub fn effective_role(&self) -> Self {
        match self {
            Self::Other(_) => Self::Context,
            known => known.clone(),
        }
    }
}

string_enum! {
    pub enum OperationOverrideSource {
        User => "user",
        System => "system",
        Migration => "migration",
    }
}

string_enum! {
    pub enum OperationReasonCode {
        RuntimeIdMatch => "runtime-id-match",
        AutomationPathMatch => "automation-path-match",
        FocusMatch => "focus-match",
        PointHit => "point-hit",
        AncestorSemanticMatch => "ancestor-semantic-match",
        CoordinateFallback => "coordinate-fallback",
        ValueLengthChanged => "value-length-changed",
        ToggleStateChanged => "toggle-state-changed",
        SelectionChanged => "selection-changed",
        ExpandStateChanged => "expand-state-changed",
        RangeValueChanged => "range-value-changed",
        EnabledStateChanged => "enabled-state-changed",
        FocusChanged => "focus-changed",
        WindowOpened => "window-opened",
        WindowClosed => "window-closed",
        PopupAppeared => "popup-appeared",
        DialogAppeared => "dialog-appeared",
        StructureChanged => "structure-changed",
        ExplicitCompletion => "explicit-completion",
        NextInputClosedWindow => "next-input-closed-window",
        ResultTimeout => "result-timeout",
        NoObservableChange => "no-observable-change",
        MultipleCandidates => "multiple-candidates",
        WeakCompletionSignal => "weak-completion-signal",
        NegativeCompletionSignal => "negative-completion-signal",
        NameMatchSuccessTerm => "name-match-success-term",
        UiaTimeout => "uia-timeout",
        UiaCircuitOpen => "uia-circuit-open",
        UiaDisabled => "uia-disabled",
        QueueOverflow => "queue-overflow",
        ObserverRestarted => "observer-restarted",
        TargetProcessMismatch => "target-process-mismatch",
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiElementPathEntry {
    pub control_type: Option<String>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiBoundingRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiElementIdentity {
    pub runtime_id: Option<Vec<i32>>,
    pub process_id: Option<u32>,
    pub window_hwnd: Option<String>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub localized_control_type: Option<String>,
    pub class_name: Option<String>,
    pub framework_id: Option<String>,
    #[serde(default)]
    pub parent_path: Vec<UiElementPathEntry>,
    pub bounding_rect: Option<UiBoundingRect>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiStateSnapshot {
    pub snapshot_id: String,
    pub captured_at_ms: u64,
    pub element: Option<UiElementIdentity>,
    pub is_enabled: Option<bool>,
    pub has_keyboard_focus: Option<bool>,
    pub is_offscreen: Option<bool>,
    pub value_length: Option<u32>,
    /// Control ValuePattern text when plaintext capture is enabled; never for passwords.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_text: Option<String>,
    pub value_fingerprint: Option<String>,
    pub toggle_state: Option<ToggleState>,
    pub selection_state: Option<SelectionState>,
    /// Names of currently selected items (combo/list/file picker labels).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_names: Option<Vec<String>>,
    pub expand_collapse_state: Option<ExpandCollapseState>,
    pub range_value: Option<f64>,
    #[serde(default = "default_privacy_class")]
    pub privacy_class: PrivacyClass,
    pub source: Option<UiStateSnapshotSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEventRecord {
    pub schema_version: u32,
    pub kind: String,
    pub event_id: String,
    pub session_id: String,
    pub event_type: SemanticEventType,
    pub occurred_at_ms: u64,
    pub monotonic_offset_ms: Option<u64>,
    pub source_event_id: Option<String>,
    pub target: Option<UiElementIdentity>,
    #[serde(default = "empty_json_object")]
    pub payload: Value,
    #[serde(default = "default_privacy_class")]
    pub privacy_class: PrivacyClass,
    #[serde(default)]
    pub reason_codes: Vec<OperationReasonCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObserverHealthPayload {
    pub state: ObserverHealthState,
    #[serde(default)]
    pub queue_overflow_count: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationCoordinate {
    pub x: i32,
    pub y: i32,
    pub display_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationActionConfidence {
    pub target: Option<f64>,
    pub temporal: Option<f64>,
    pub overall: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationAction {
    pub action_id: String,
    pub kind: OperationActionKind,
    pub occurred_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub target: Option<UiElementIdentity>,
    pub state_before: Option<UiStateSnapshot>,
    pub coordinate: Option<OperationCoordinate>,
    #[serde(default)]
    pub source_event_ids: Vec<String>,
    #[serde(default)]
    pub target_reason_codes: Vec<OperationReasonCode>,
    #[serde(default)]
    pub confidence: OperationActionConfidence,
    /// Typed text / selected option name / path value for repro steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_preview: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateTransitionConfidence {
    pub identity: Option<f64>,
    pub temporal: Option<f64>,
    pub transition: Option<f64>,
    pub overall: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateTransition {
    pub transition_id: String,
    pub kind: StateTransitionKind,
    pub occurred_at_ms: u64,
    pub element: Option<UiElementIdentity>,
    pub property: Option<String>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    #[serde(default = "default_privacy_class")]
    pub privacy_class: PrivacyClass,
    #[serde(default)]
    pub source_event_ids: Vec<String>,
    #[serde(default)]
    pub reason_codes: Vec<OperationReasonCode>,
    #[serde(default)]
    pub confidence: StateTransitionConfidence,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationOutcomeConfidence {
    pub temporal: Option<f64>,
    pub identity: Option<f64>,
    pub transition: Option<f64>,
    pub evidence: Option<f64>,
    pub overall: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationOutcome {
    pub outcome_id: String,
    pub status: OperationOutcomeStatus,
    pub summary: Option<String>,
    pub observed_at_ms: u64,
    pub latency_ms: u64,
    pub primary_transition_id: Option<String>,
    #[serde(default)]
    pub candidate_transition_ids: Vec<String>,
    #[serde(default)]
    pub reason_codes: Vec<OperationReasonCode>,
    #[serde(default)]
    pub confidence: OperationOutcomeConfidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationVideoRange {
    pub stream_id: String,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvidence {
    pub evidence_id: String,
    pub kind: OperationEvidenceKind,
    pub role: OperationEvidenceRole,
    pub source_id: String,
    pub occurred_at_ms: u64,
    pub artifact_ref: Option<String>,
    pub video_range: Option<OperationVideoRange>,
    pub reason_code: Option<OperationReasonCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionOperationRecord {
    pub schema_version: u32,
    pub kind: String,
    pub operation_id: String,
    pub session_id: String,
    pub sequence: u32,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    pub relative_ms_from_session_start: u64,
    pub action: OperationAction,
    pub outcome: OperationOutcome,
    #[serde(default)]
    pub completion_candidates: Vec<OperationOutcome>,
    #[serde(default)]
    pub transitions: Vec<StateTransition>,
    #[serde(default)]
    pub evidence: Vec<OperationEvidence>,
    pub title: String,
    pub result_summary: String,
    pub display_summary: String,
    pub precision_level: String,
    #[serde(
        default = "default_outcome_selection_source",
        skip_serializing_if = "is_auto_outcome_selection_source"
    )]
    pub outcome_selection_source: OperationOutcomeSelectionSource,
    #[serde(default)]
    pub edited: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ignored: bool,
    pub business_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationOverrideChanges {
    pub title: Option<String>,
    pub result_summary: Option<String>,
    pub selected_outcome_status: Option<OperationOutcomeStatus>,
    pub selected_transition_id: Option<String>,
    pub ignored: Option<bool>,
    pub business_alias: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationOverrideRecord {
    pub schema_version: u32,
    pub kind: String,
    pub override_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub occurred_at_ms: u64,
    pub source: OperationOverrideSource,
    #[serde(default)]
    pub changes: OperationOverrideChanges,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TestSessionOperationEditInput {
    pub session_id: Option<String>,
    pub operation_id: String,
    pub occurred_at_ms: Option<u64>,
    pub changes: OperationOverrideChanges,
    pub reason: Option<String>,
}

pub fn operation_schema_version() -> u32 {
    TEST_SESSION_SCHEMA_VERSION
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        OperationActionKind, OperationEvidenceRole, OperationOutcomeSelectionSource,
        OperationOutcomeStatus, OperationReasonCode, PrivacyClass, SemanticEventRecord,
        TEST_SESSION_OPERATION_KIND, TEST_SESSION_OPERATION_OVERRIDE_KIND,
        TEST_SESSION_SEMANTIC_EVENT_KIND, TestSessionOperationRecord,
    };

    #[test]
    fn operation_models_round_trip_preserves_schema_wire_values() {
        let value = json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_OPERATION_KIND,
            "operationId": "operation-save-click",
            "sessionId": "ts-1",
            "sequence": 12,
            "startedAtMs": 1000,
            "endedAtMs": 1420,
            "relativeMsFromSessionStart": 1000,
            "action": {
                "actionId": "action-save-click",
                "kind": "click",
                "occurredAtMs": 1000,
                "endedAtMs": 1000,
                "target": {
                    "runtimeId": [42, 7, 19],
                    "processId": 1234,
                    "windowHwnd": "0x000A12BC",
                    "name": "Save",
                    "automationId": "btnSave",
                    "controlType": "Button",
                    "localizedControlType": "button",
                    "className": "Button",
                    "frameworkId": "WPF",
                    "parentPath": [
                        { "controlType": "Window", "name": "Order editor", "automationId": null },
                        { "controlType": "Pane", "name": null, "automationId": "editorPane" }
                    ],
                    "boundingRect": { "left": 100, "top": 80, "width": 120, "height": 32 }
                },
                "stateBefore": {
                    "snapshotId": "state-before",
                    "capturedAtMs": 980,
                    "element": null,
                    "isEnabled": true,
                    "hasKeyboardFocus": false,
                    "isOffscreen": false,
                    "valueLength": 8,
                    "valueFingerprint": null,
                    "toggleState": "on",
                    "selectionState": "selected",
                    "expandCollapseState": "expanded",
                    "rangeValue": 35.0,
                    "privacyClass": "text-length-only",
                    "source": "uia-property-event"
                },
                "coordinate": { "x": 1203, "y": 456, "displayId": "display-1" },
                "sourceEventIds": ["evt-click"],
                "targetReasonCodes": ["runtime-id-match", "point-hit"],
                "confidence": { "target": 0.96, "temporal": 0.92, "overall": 0.94 }
            },
            "outcome": {
                "outcomeId": "outcome-save-toast",
                "status": "confirmed",
                "summary": "Saved toast appeared",
                "observedAtMs": 1420,
                "latencyMs": 420,
                "primaryTransitionId": "transition-toast",
                "candidateTransitionIds": ["transition-toast"],
                "reasonCodes": ["popup-appeared", "name-match-success-term"],
                "confidence": {
                    "temporal": 0.91,
                    "identity": 0.84,
                    "transition": 0.95,
                    "evidence": 0.90,
                    "overall": 0.90
                }
            },
            "completionCandidates": [],
            "transitions": [
                {
                    "transitionId": "transition-toast",
                    "kind": "lifecycle",
                    "occurredAtMs": 1420,
                    "element": null,
                    "property": "popup",
                    "before": null,
                    "after": { "visible": true },
                    "privacyClass": "unknown",
                    "sourceEventIds": ["sem-toast"],
                    "reasonCodes": ["popup-appeared"],
                    "confidence": {
                        "identity": 0.84,
                        "temporal": 0.91,
                        "transition": 0.95,
                        "overall": 0.90
                    }
                }
            ],
            "evidence": [
                {
                    "evidenceId": "evidence-target",
                    "kind": "uiaSnapshot",
                    "role": "supportsTarget",
                    "sourceId": "sem-target",
                    "occurredAtMs": 980,
                    "artifactRef": null,
                    "videoRange": null,
                    "reasonCode": "runtime-id-match"
                },
                {
                    "evidenceId": "evidence-outcome",
                    "kind": "stateTransition",
                    "role": "supportsOutcome",
                    "sourceId": "transition-toast",
                    "occurredAtMs": 1420,
                    "artifactRef": null,
                    "videoRange": { "streamId": "stream-1", "startedAtMs": 900, "endedAtMs": 1500 },
                    "reasonCode": "popup-appeared"
                }
            ],
            "title": "Click Save",
            "resultSummary": "Saved toast appeared",
            "displaySummary": "Click Save -> Saved toast appeared, 420ms",
            "precisionLevel": "l3",
            "edited": false,
            "businessAlias": null
        });

        let record: TestSessionOperationRecord =
            serde_json::from_value(value.clone()).expect("deserialize operation");
        assert_eq!(record.action.kind, OperationActionKind::Click);
        assert_eq!(record.outcome.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(
            record.outcome.reason_codes,
            vec![
                OperationReasonCode::PopupAppeared,
                OperationReasonCode::NameMatchSuccessTerm
            ]
        );
        assert_eq!(record.transitions[0].privacy_class, PrivacyClass::Unknown);

        let serialized = serde_json::to_value(&record).expect("serialize operation");
        assert_eq!(serialized, value);
    }

    #[test]
    fn operation_models_default_missing_optional_fields() {
        let record: TestSessionOperationRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_OPERATION_KIND,
            "operationId": "operation-incomplete",
            "sessionId": "ts-1",
            "sequence": 1,
            "startedAtMs": 10,
            "endedAtMs": 3010,
            "relativeMsFromSessionStart": 10,
            "action": {
                "actionId": "action-click",
                "kind": "click",
                "occurredAtMs": 10
            },
            "outcome": {
                "outcomeId": "outcome-incomplete",
                "status": "incomplete",
                "summary": null,
                "observedAtMs": 3010,
                "latencyMs": 3000
            },
            "title": "Click Refresh",
            "resultSummary": "No clear result observed",
            "displaySummary": "Click Refresh -> no clear result observed",
            "precisionLevel": "l1",
            "businessAlias": null
        }))
        .expect("deserialize minimal operation");

        assert!(record.action.source_event_ids.is_empty());
        assert!(record.action.target_reason_codes.is_empty());
        assert_eq!(record.action.confidence.overall, None);
        assert!(record.outcome.reason_codes.is_empty());
        assert!(record.outcome.candidate_transition_ids.is_empty());
        assert!(record.completion_candidates.is_empty());
        assert!(record.transitions.is_empty());
        assert!(record.evidence.is_empty());
        assert_eq!(
            record.outcome_selection_source,
            OperationOutcomeSelectionSource::Auto
        );
        assert!(!record.edited);
        assert!(!record.ignored);
        assert_eq!(record.manual_note, None);
    }

    #[test]
    fn operation_models_round_trip_golden_expected_operations() {
        let cases: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/operations/cases.json"))
                .expect("golden cases should parse");
        let cases = cases.as_array().expect("golden cases should be an array");
        let mut operation_count = 0usize;

        for test_case in cases {
            let case_id = test_case["caseId"]
                .as_str()
                .expect("golden case id should be a string");
            let session_id = test_case["sessionId"]
                .as_str()
                .expect("golden session id should be a string");
            let expected_operations = test_case["expectedOperations"]
                .as_array()
                .expect("golden expectedOperations should be an array");

            for (index, operation) in expected_operations.iter().enumerate() {
                operation_count += 1;
                let operation_id = operation["operationId"]
                    .as_str()
                    .expect("golden operation id should be a string");
                let source_event_ids = operation["sourceEventIds"].clone();
                let source_id = source_event_ids
                    .as_array()
                    .and_then(|ids| ids.first())
                    .and_then(Value::as_str)
                    .expect("golden operation source event should exist");
                let action_kind = operation["action"]["kind"]
                    .as_str()
                    .expect("golden action kind should be a string");
                let action_at = operation["action"]["occurredAtMs"]
                    .as_u64()
                    .expect("golden action timestamp should be a number");
                let outcome_status = operation["outcome"]["status"]
                    .as_str()
                    .expect("golden outcome status should be a string");
                let observed_at = operation["outcome"]["observedAtMs"]
                    .as_u64()
                    .expect("golden observedAtMs should be a number");
                let latency_ms = operation["outcome"]["latencyMs"]
                    .as_u64()
                    .expect("golden latencyMs should be a number");
                let reason_codes = operation["outcome"]["reasonCodes"].clone();
                let first_reason_code = reason_codes
                    .as_array()
                    .and_then(|codes| codes.first())
                    .cloned()
                    .expect("golden reason code should exist");
                let evidence: Vec<Value> = operation["expectedEvidenceRoles"]
                    .as_array()
                    .expect("golden evidence roles should be an array")
                    .iter()
                    .enumerate()
                    .map(|(evidence_index, role)| {
                        json!({
                            "evidenceId": format!("{operation_id}-evidence-{evidence_index}"),
                            "kind": "rawEvent",
                            "role": role,
                            "sourceId": source_id,
                            "occurredAtMs": action_at,
                            "artifactRef": null,
                            "videoRange": null,
                            "reasonCode": first_reason_code
                        })
                    })
                    .collect();

                let full_record = json!({
                    "schemaVersion": 1,
                    "kind": TEST_SESSION_OPERATION_KIND,
                    "operationId": operation_id,
                    "sessionId": session_id,
                    "sequence": index as u32,
                    "startedAtMs": action_at,
                    "endedAtMs": observed_at,
                    "relativeMsFromSessionStart": action_at,
                    "action": {
                        "actionId": format!("{operation_id}-action"),
                        "kind": action_kind,
                        "occurredAtMs": action_at,
                        "endedAtMs": null,
                        "target": null,
                        "stateBefore": null,
                        "coordinate": null,
                        "sourceEventIds": source_event_ids,
                        "targetReasonCodes": [],
                        "confidence": {
                            "target": null,
                            "temporal": null,
                            "overall": null
                        }
                    },
                    "outcome": {
                        "outcomeId": format!("{operation_id}-outcome"),
                        "status": outcome_status,
                        "summary": null,
                        "observedAtMs": observed_at,
                        "latencyMs": latency_ms,
                        "primaryTransitionId": null,
                        "candidateTransitionIds": [],
                        "reasonCodes": reason_codes,
                        "confidence": {
                            "temporal": null,
                            "identity": null,
                            "transition": null,
                            "evidence": null,
                            "overall": null
                        }
                    },
                    "completionCandidates": [],
                    "transitions": [],
                    "evidence": evidence,
                    "title": format!("Golden {operation_id}"),
                    "resultSummary": format!("Golden status {outcome_status}"),
                    "displaySummary": format!("Golden {operation_id} -> {outcome_status}"),
                    "precisionLevel": "golden",
                    "edited": false,
                    "businessAlias": null
                });

                let record: TestSessionOperationRecord =
                    serde_json::from_value(full_record.clone()).unwrap_or_else(|err| {
                        panic!("{case_id}/{operation_id} should deserialize: {err}")
                    });
                assert!(
                    record.action.kind.is_known(),
                    "{case_id}/{operation_id} action kind should be known"
                );
                assert!(
                    record.outcome.status.is_known(),
                    "{case_id}/{operation_id} outcome status should be known"
                );
                assert!(
                    record
                        .outcome
                        .reason_codes
                        .iter()
                        .all(OperationReasonCode::is_known),
                    "{case_id}/{operation_id} reason codes should be known"
                );

                let serialized =
                    serde_json::to_value(&record).expect("serialize golden operation model");
                assert_eq!(serialized, full_record, "{case_id}/{operation_id}");
            }
        }

        assert_eq!(operation_count, 30);
    }

    #[test]
    fn operation_models_keep_unknown_enum_wire_values() {
        let record: TestSessionOperationRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_OPERATION_KIND,
            "operationId": "operation-future",
            "sessionId": "ts-1",
            "sequence": 1,
            "startedAtMs": 10,
            "endedAtMs": 20,
            "relativeMsFromSessionStart": 10,
            "action": {
                "actionId": "action-future",
                "kind": "dragSelect",
                "occurredAtMs": 10,
                "sourceEventIds": ["evt-future"],
                "targetReasonCodes": ["future-target-reason"]
            },
            "outcome": {
                "outcomeId": "outcome-future",
                "status": "futureReview",
                "summary": "future summary",
                "observedAtMs": 20,
                "latencyMs": 10,
                "reasonCodes": ["future-outcome-reason"]
            },
            "evidence": [
                {
                    "evidenceId": "evidence-future",
                    "kind": "futureEvidence",
                    "role": "auditTrail",
                    "sourceId": "source-future",
                    "occurredAtMs": 20,
                    "artifactRef": null,
                    "videoRange": null,
                    "reasonCode": "future-evidence-reason"
                }
            ],
            "title": "Future action",
            "resultSummary": "Future result",
            "displaySummary": "Future action -> Future result",
            "precisionLevel": "future",
            "businessAlias": null
        }))
        .expect("deserialize future operation");

        assert!(matches!(
            record.action.kind,
            OperationActionKind::Other(ref value) if value == "dragSelect"
        ));
        assert!(matches!(
            record.outcome.status,
            OperationOutcomeStatus::Other(ref value) if value == "futureReview"
        ));
        assert!(matches!(
            record.action.target_reason_codes[0],
            OperationReasonCode::Other(ref value) if value == "future-target-reason"
        ));
        assert!(matches!(
            record.evidence[0].role,
            OperationEvidenceRole::Other(ref value) if value == "auditTrail"
        ));
        assert_eq!(
            record.evidence[0].role.effective_role(),
            OperationEvidenceRole::Context
        );

        let serialized = serde_json::to_value(&record).expect("serialize future operation");
        assert_eq!(serialized["action"]["kind"], "dragSelect");
        assert_eq!(serialized["outcome"]["status"], "futureReview");
        assert_eq!(serialized["evidence"][0]["role"], "auditTrail");
        assert_eq!(
            serialized["evidence"][0]["reasonCode"],
            "future-evidence-reason"
        );
    }

    #[test]
    fn semantic_event_defaults_are_forward_compatible_and_private() {
        let event: SemanticEventRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_SEMANTIC_EVENT_KIND,
            "eventId": "sem-password",
            "sessionId": "ts-1",
            "eventType": "observer_health",
            "occurredAtMs": 42,
            "monotonicOffsetMs": null,
            "sourceEventId": null,
            "target": null
        }))
        .expect("deserialize semantic event");

        assert_eq!(event.payload, json!({}));
        assert_eq!(event.privacy_class, PrivacyClass::Unknown);
        assert!(event.reason_codes.is_empty());

        let password_event: SemanticEventRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_SEMANTIC_EVENT_KIND,
            "eventId": "sem-password-snapshot",
            "sessionId": "ts-1",
            "eventType": "uia_snapshot",
            "occurredAtMs": 44,
            "payload": {
                "runtimeId": [12, 10],
                "controlType": "Edit",
                "isPassword": true,
                "privacyClass": "password-redacted"
            },
            "privacyClass": "password-redacted"
        }))
        .expect("deserialize password semantic event");

        assert_eq!(password_event.privacy_class, PrivacyClass::PasswordRedacted);
        assert!(password_event.payload.get("value").is_none());
        assert!(password_event.payload.get("valueLength").is_none());
    }

    #[test]
    fn operation_override_schema_values_are_stable() {
        let value = json!({
            "schemaVersion": 1,
            "kind": TEST_SESSION_OPERATION_OVERRIDE_KIND,
            "overrideId": "override-1",
            "sessionId": "ts-1",
            "operationId": "operation-1",
            "occurredAtMs": 50,
            "source": "user",
            "changes": {
                "title": "Click Save",
                "resultSummary": null,
                "selectedOutcomeStatus": "confirmed",
                "selectedTransitionId": "transition-1",
                "ignored": false,
                "businessAlias": "Save order",
                "note": null
            },
            "reason": "manual-review"
        });

        let override_record: super::OperationOverrideRecord =
            serde_json::from_value(value.clone()).expect("deserialize override");
        let serialized = serde_json::to_value(&override_record).expect("serialize override");
        assert_eq!(serialized, value);
    }
}
