use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use shadow_recorder::operation_semantic_test_api::{
    PrivacyClass, SemanticEventRecord as RuntimeSemanticEventRecord, SemanticEventType,
    TEST_SESSION_SCHEMA_VERSION, TEST_SESSION_SEMANTIC_EVENT_KIND, TestSessionEventRecord,
    TestSessionEventType, TestSessionOperationRecord, TestSessionStatus,
    build_operation_records_from_events,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenManifest {
    schema_version: u32,
    kind: String,
    cases_file: String,
    minimum_case_count: usize,
    required_technologies: Vec<String>,
    required_outcome_statuses: Vec<String>,
    privacy_forbidden_values: Vec<String>,
    target_window_ms: u64,
    outcome_window_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    case_id: String,
    technology: String,
    session_id: String,
    input_events: Vec<GoldenEvent>,
    semantic_events: Vec<GoldenEvent>,
    expected_operations: Vec<ExpectedOperation>,
    #[serde(default)]
    boundary_assertions: Vec<BoundaryAssertion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenEvent {
    event_id: String,
    event_type: String,
    occurred_at_ms: u64,
    #[serde(default)]
    source_event_id: Option<String>,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedOperation {
    operation_id: String,
    source_event_ids: Vec<String>,
    action: ExpectedAction,
    outcome: ExpectedOutcome,
    expected_evidence_roles: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedAction {
    kind: String,
    occurred_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedOutcome {
    status: String,
    #[serde(default)]
    observed_at_ms: Option<u64>,
    #[serde(default)]
    latency_ms: Option<u64>,
    reason_codes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundaryAssertion {
    window: String,
    offset_ms: u64,
    accepted: bool,
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("operations")
}

#[test]
fn operation_golden_manifest_and_cases_are_coherent() {
    let root = fixture_root();
    let manifest_text =
        fs::read_to_string(root.join("manifest.json")).expect("golden manifest should be readable");
    let manifest: GoldenManifest =
        serde_json::from_str(&manifest_text).expect("golden manifest should be valid JSON");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.kind, "reqcase.operation-golden-manifest");
    assert_eq!(manifest.target_window_ms, 300);
    assert_eq!(manifest.outcome_window_ms, 3000);

    let cases_text = fs::read_to_string(root.join(&manifest.cases_file))
        .expect("golden cases should be readable");
    let cases: Vec<GoldenCase> =
        serde_json::from_str(&cases_text).expect("golden cases should be valid JSON");
    assert!(cases.len() >= manifest.minimum_case_count);

    for forbidden in &manifest.privacy_forbidden_values {
        assert!(
            !cases_text.contains(forbidden),
            "fixture contains forbidden privacy sentinel: {forbidden}"
        );
    }

    let mut case_ids = HashSet::new();
    let technologies = cases
        .iter()
        .map(|case| case.technology.as_str())
        .collect::<HashSet<_>>();
    for required in &manifest.required_technologies {
        assert!(
            technologies.contains(required.as_str()),
            "missing technology: {required}"
        );
    }

    let mut observed_statuses = HashSet::new();
    for case in &cases {
        assert!(
            case_ids.insert(case.case_id.as_str()),
            "duplicate case id: {}",
            case.case_id
        );
        assert!(!case.session_id.trim().is_empty());
        assert!(
            !case.input_events.is_empty(),
            "{} has no input events",
            case.case_id
        );
        assert!(
            !case.expected_operations.is_empty(),
            "{} has no expected operations",
            case.case_id
        );

        let input_ids = case
            .input_events
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            input_ids.len(),
            case.input_events.len(),
            "duplicate input event id"
        );

        let semantic_ids = case
            .semantic_events
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            semantic_ids.len(),
            case.semantic_events.len(),
            "duplicate semantic event id"
        );

        for event in &case.input_events {
            assert!(!event.event_type.trim().is_empty());
            assert!(event.occurred_at_ms > 0);
        }
        for event in &case.semantic_events {
            assert!(!event.event_type.trim().is_empty());
            assert!(event.occurred_at_ms > 0);
            if let Some(source_event_id) = event.source_event_id.as_deref() {
                assert!(
                    input_ids.contains(source_event_id),
                    "unknown semantic source event id"
                );
            }
            if event.payload.get("isPassword") == Some(&Value::Bool(true)) {
                assert!(event.payload.get("value").is_none());
                assert!(event.payload.get("valueLength").is_none());
                assert_eq!(
                    event.payload.get("privacyClass").and_then(Value::as_str),
                    Some("password-redacted")
                );
            }
        }

        let mut operation_ids = HashSet::new();
        for operation in &case.expected_operations {
            assert!(
                operation_ids.insert(operation.operation_id.as_str()),
                "duplicate operation id in {}",
                case.case_id
            );
            assert!(!operation.action.kind.trim().is_empty());
            for source_event_id in &operation.source_event_ids {
                assert!(
                    input_ids.contains(source_event_id.as_str()),
                    "unknown operation source event"
                );
            }
            assert!(
                manifest
                    .required_outcome_statuses
                    .contains(&operation.outcome.status),
                "unknown outcome status: {}",
                operation.outcome.status
            );
            observed_statuses.insert(operation.outcome.status.as_str());
            if let Some(observed_at_ms) = operation.outcome.observed_at_ms {
                assert!(observed_at_ms >= operation.action.occurred_at_ms);
                assert_eq!(
                    operation.outcome.latency_ms,
                    Some(observed_at_ms - operation.action.occurred_at_ms)
                );
            }
            assert!(!operation.outcome.reason_codes.is_empty());
            assert!(
                operation
                    .expected_evidence_roles
                    .contains(&"supportsTarget".to_string())
            );
            if operation.outcome.status == "confirmed" {
                assert!(
                    operation
                        .expected_evidence_roles
                        .contains(&"supportsOutcome".to_string())
                );
            }
        }
    }

    for required in &manifest.required_outcome_statuses {
        assert!(
            observed_statuses.contains(required.as_str()),
            "missing status: {required}"
        );
    }
}

#[test]
fn operation_golden_freezes_target_and_outcome_boundaries() {
    let root = fixture_root();
    let cases: Vec<GoldenCase> = serde_json::from_str(
        &fs::read_to_string(root.join("cases.json")).expect("golden cases should be readable"),
    )
    .expect("golden cases should be valid JSON");
    let boundary_case = cases
        .iter()
        .find(|case| case.case_id == "temporal-boundaries")
        .expect("temporal boundary case should exist");

    let expected = [
        ("target", 299, true),
        ("target", 300, true),
        ("target", 301, false),
        ("outcome", 2999, true),
        ("outcome", 3000, true),
        ("outcome", 3001, false),
    ];
    for (window, offset_ms, accepted) in expected {
        assert!(boundary_case.boundary_assertions.iter().any(|assertion| {
            assertion.window == window
                && assertion.offset_ms == offset_ms
                && assertion.accepted == accepted
        }));
    }
}

#[test]
fn operation_golden_replays_builder_against_expected_operations() {
    let root = fixture_root();
    let cases: Vec<GoldenCase> = serde_json::from_str(
        &fs::read_to_string(root.join("cases.json")).expect("golden cases should be readable"),
    )
    .expect("golden cases should be valid JSON");
    let mut checked_operations = 0usize;

    for case in &cases {
        let input_events = runtime_input_events(case);
        let semantic_events = case
            .semantic_events
            .iter()
            .map(|event| runtime_semantic_event(case, event))
            .collect::<Vec<_>>();
        let actual = build_operation_records_from_events(
            &case.session_id,
            0,
            &input_events,
            &semantic_events,
        );

        assert_eq!(
            actual.len(),
            case.expected_operations.len(),
            "{} operation count",
            case.case_id
        );
        for (index, (actual_operation, expected_operation)) in actual
            .iter()
            .zip(case.expected_operations.iter())
            .enumerate()
        {
            checked_operations += 1;
            assert_expected_operation(case, index, actual_operation, expected_operation);
        }
    }

    assert_eq!(checked_operations, 30);
}

fn runtime_input_events(case: &GoldenCase) -> Vec<TestSessionEventRecord> {
    let expected_kind_by_source = case
        .expected_operations
        .iter()
        .flat_map(|operation| {
            operation
                .source_event_ids
                .iter()
                .map(|source_id| (source_id.as_str(), operation.action.kind.as_str()))
        })
        .collect::<HashMap<_, _>>();

    case.input_events
        .iter()
        .map(|event| {
            runtime_input_event(
                case,
                event,
                expected_kind_by_source
                    .get(event.event_id.as_str())
                    .copied(),
            )
        })
        .collect()
}

fn runtime_input_event(
    case: &GoldenCase,
    event: &GoldenEvent,
    expected_action_kind: Option<&str>,
) -> TestSessionEventRecord {
    let mut record = TestSessionEventRecord::new_lifecycle(
        event.event_id.clone(),
        case.session_id.clone(),
        TestSessionEventType::SessionStarted,
        event.occurred_at_ms,
        TestSessionStatus::Active,
    );
    record.status = None;
    match event.event_type.as_str() {
        "keyboard_summary" => {
            record.event_type = TestSessionEventType::KeyboardSummary;
            if expected_action_kind == Some("shortcut") {
                record.action = Some("shortcut".to_string());
                record.shortcut = Some("Ctrl+S".to_string());
            } else {
                record.action = Some("type".to_string());
                record.char_count = Some(1);
            }
        }
        "mouse_double_click" => {
            record.event_type = TestSessionEventType::StepCaptured;
            record.action = Some("WM_LBUTTONDBLCLK".to_string());
        }
        "mouse_right_click" => {
            record.event_type = TestSessionEventType::StepCaptured;
            record.action = Some("WM_RBUTTONUP".to_string());
        }
        "mouse_wheel" => {
            record.event_type = TestSessionEventType::StepCaptured;
            record.action = Some("WM_MOUSEWHEEL".to_string());
        }
        _ => {
            record.event_type = TestSessionEventType::StepCaptured;
            record.action = Some("WM_LBUTTONUP".to_string());
        }
    }
    record
}

fn runtime_semantic_event(case: &GoldenCase, event: &GoldenEvent) -> RuntimeSemanticEventRecord {
    RuntimeSemanticEventRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
        event_id: event.event_id.clone(),
        session_id: case.session_id.clone(),
        event_type: SemanticEventType::from_wire(event.event_type.clone()),
        occurred_at_ms: event.occurred_at_ms,
        monotonic_offset_ms: Some(event.occurred_at_ms),
        source_event_id: event.source_event_id.clone(),
        target: None,
        payload: event.payload.clone(),
        privacy_class: PrivacyClass::NotSensitive,
        reason_codes: Vec::new(),
    }
}

fn assert_expected_operation(
    case: &GoldenCase,
    index: usize,
    actual: &TestSessionOperationRecord,
    expected: &ExpectedOperation,
) {
    assert_eq!(
        actual.sequence,
        index as u32 + 1,
        "{} sequence",
        case.case_id
    );
    assert_eq!(
        actual.operation_id,
        expected_stable_operation_id(case, expected),
        "{} stable operation id",
        case.case_id
    );
    assert_eq!(
        actual.action.source_event_ids, expected.source_event_ids,
        "{} source event ids",
        case.case_id
    );
    assert_eq!(
        actual.action.kind.as_str(),
        expected.action.kind,
        "{} action kind",
        case.case_id
    );
    assert_eq!(
        actual.action.occurred_at_ms, expected.action.occurred_at_ms,
        "{} action timestamp",
        case.case_id
    );
    assert_eq!(
        actual.outcome.status.as_str(),
        expected.outcome.status,
        "{} outcome status",
        case.case_id
    );
    if let Some(observed_at_ms) = expected.outcome.observed_at_ms {
        assert_eq!(
            actual.outcome.observed_at_ms, observed_at_ms,
            "{} observedAtMs",
            case.case_id
        );
    }
    if let Some(latency_ms) = expected.outcome.latency_ms {
        assert_eq!(
            actual.outcome.latency_ms, latency_ms,
            "{} latencyMs",
            case.case_id
        );
    }

    let actual_reason_codes = actual
        .outcome
        .reason_codes
        .iter()
        .map(|code| code.as_str())
        .collect::<HashSet<_>>();
    for expected_reason_code in &expected.outcome.reason_codes {
        assert!(
            actual_reason_codes.contains(expected_reason_code.as_str()),
            "{} missing reason code {} in {:?}",
            case.case_id,
            expected_reason_code,
            actual.outcome.reason_codes
        );
    }

    let actual_evidence_roles = actual
        .evidence
        .iter()
        .map(|evidence| evidence.role.as_str())
        .collect::<HashSet<_>>();
    for expected_role in &expected.expected_evidence_roles {
        assert!(
            actual_evidence_roles.contains(expected_role.as_str()),
            "{} missing evidence role {} in {:?}",
            case.case_id,
            expected_role,
            actual.evidence
        );
    }
}

fn expected_stable_operation_id(case: &GoldenCase, expected: &ExpectedOperation) -> String {
    let source = expected
        .source_event_ids
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    format!(
        "operation-{}-{}",
        stable_id_part(&case.session_id),
        stable_id_part(source)
    )
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
