use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{Map, Number, Value};

use crate::privacy::{DEFAULT_SEMANTIC_LABEL_MAX_CHARS, PrivacyPolicy, truncate_semantic_label};

use super::defect_config;
use super::semantic_event::{PrivacyClass, SemanticEventRecord};

static SEMANTIC_PRIVACY_POLICY: Lazy<Mutex<PrivacyPolicy>> =
    Lazy::new(|| Mutex::new(PrivacyPolicy::default()));

const TEXT_VALUE_KEYS: &[&str] = &[
    "value",
    "text",
    "plaintext",
    "plainText",
    "inputValue",
    "valueText",
    "textPreview",
    "candidateText",
    "candidateTexts",
    "candidates",
    "pathValue",
    "filePath",
    "path",
    "clipboardText",
];
/// Selection/option labels require the plaintext opt-in outside sensitive/password contexts.
const SELECTION_LABEL_KEYS: &[&str] = &["selectedNames", "selectedName", "selectionLabel"];

const TEXT_LENGTH_KEYS: &[&str] = &["valueLength", "textLength", "candidateLength"];
const TEXT_FINGERPRINT_KEYS: &[&str] = &["valueFingerprint", "textFingerprint"];
const LABEL_KEYS: &[&str] = &["name", "title", "windowTitle", "controlName"];
const PROCESS_NAME_KEYS: &[&str] = &["processName", "process"];
const WINDOW_TITLE_KEYS: &[&str] = &["windowTitle", "title"];

#[derive(Debug, Clone)]
pub struct SemanticPrivacyOptions {
    pub allow_plaintext_input: bool,
    pub policy: PrivacyPolicy,
    pub max_label_chars: usize,
}

impl Default for SemanticPrivacyOptions {
    fn default() -> Self {
        Self {
            allow_plaintext_input: false,
            policy: PrivacyPolicy::default(),
            max_label_chars: DEFAULT_SEMANTIC_LABEL_MAX_CHARS,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SemanticPrivacyReport {
    pub password_redacted: bool,
    pub sensitive_redacted: bool,
    pub text_length_only: bool,
    pub label_truncated: bool,
}

pub fn set_semantic_privacy_policy(policy: PrivacyPolicy) {
    if let Ok(mut active) = SEMANTIC_PRIVACY_POLICY.lock() {
        *active = policy;
    }
}

pub fn sanitize_semantic_event_for_storage(event: &SemanticEventRecord) -> SemanticEventRecord {
    let policy = SEMANTIC_PRIVACY_POLICY
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let options = SemanticPrivacyOptions {
        allow_plaintext_input: defect_config::is_semantic_plaintext_input_enabled(),
        policy,
        max_label_chars: DEFAULT_SEMANTIC_LABEL_MAX_CHARS,
    };
    sanitize_semantic_event_with_options(event, &options).0
}

#[allow(dead_code)]
pub fn sanitize_semantic_event_for_diagnostics(event: &SemanticEventRecord) -> Value {
    serde_json::to_value(sanitize_semantic_event_for_storage(event)).unwrap_or(Value::Null)
}

pub fn sanitize_semantic_event_with_options(
    event: &SemanticEventRecord,
    options: &SemanticPrivacyOptions,
) -> (SemanticEventRecord, SemanticPrivacyReport) {
    let mut sanitized = event.clone();
    let mut report = SemanticPrivacyReport::default();

    sanitize_target_labels(&mut sanitized, options, &mut report);

    let process_name = extract_first_string(&sanitized.payload, PROCESS_NAME_KEYS);
    let window_title = extract_first_string(&sanitized.payload, WINDOW_TITLE_KEYS);
    let target_name = sanitized
        .target
        .as_ref()
        .and_then(|target| target.name.as_deref());
    let app_sensitive =
        options
            .policy
            .should_exclude_semantic_text(process_name, window_title, target_name);
    let password = sanitized.privacy_class == PrivacyClass::PasswordRedacted
        || target_looks_password(sanitized.target.as_ref())
        || payload_looks_password(&sanitized.payload);

    if password {
        sanitize_payload(&mut sanitized.payload, PayloadMode::Password, &mut report);
        sanitized.privacy_class = PrivacyClass::PasswordRedacted;
    } else if app_sensitive {
        sanitize_payload(&mut sanitized.payload, PayloadMode::Sensitive, &mut report);
        sanitized.privacy_class = PrivacyClass::SensitiveRedacted;
        redact_target_labels(&mut sanitized);
    } else {
        let mode = if options.allow_plaintext_input {
            PayloadMode::PlaintextAllowed
        } else {
            PayloadMode::TextLengthOnly
        };
        sanitize_payload(&mut sanitized.payload, mode, &mut report);
        if report.text_length_only {
            sanitized.privacy_class = PrivacyClass::TextLengthOnly;
        }
    }

    sync_payload_privacy_class(&mut sanitized.payload, &sanitized.privacy_class);
    (sanitized, report)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadMode {
    PlaintextAllowed,
    TextLengthOnly,
    Password,
    Sensitive,
}

fn sanitize_target_labels(
    event: &mut SemanticEventRecord,
    options: &SemanticPrivacyOptions,
    report: &mut SemanticPrivacyReport,
) {
    let Some(target) = event.target.as_mut() else {
        return;
    };
    truncate_optional_label(&mut target.name, options.max_label_chars, report);
    for parent in &mut target.parent_path {
        truncate_optional_label(&mut parent.name, options.max_label_chars, report);
    }
}

fn redact_target_labels(event: &mut SemanticEventRecord) {
    let Some(target) = event.target.as_mut() else {
        return;
    };
    target.name = None;
    for parent in &mut target.parent_path {
        parent.name = None;
    }
}

fn truncate_optional_label(
    value: &mut Option<String>,
    max_chars: usize,
    report: &mut SemanticPrivacyReport,
) {
    let Some(current) = value.as_mut() else {
        return;
    };
    let truncated = truncate_semantic_label(current, max_chars);
    if *current != truncated {
        *current = truncated;
        report.label_truncated = true;
    }
}

fn sanitize_payload(value: &mut Value, mode: PayloadMode, report: &mut SemanticPrivacyReport) {
    match value {
        Value::Object(map) => sanitize_object(map, mode, report),
        Value::Array(items) => {
            for item in items {
                sanitize_payload(item, mode, report);
            }
        }
        _ => {}
    }
}

fn sanitize_object(
    map: &mut Map<String, Value>,
    mode: PayloadMode,
    report: &mut SemanticPrivacyReport,
) {
    let property_is_text = map
        .get("property")
        .and_then(Value::as_str)
        .map(is_text_property)
        .unwrap_or(false);
    let keys = map.keys().cloned().collect::<Vec<_>>();
    let mut length_updates = Vec::new();
    let mut remove_keys = Vec::new();

    for key in keys {
        if let Some(child) = map.get_mut(&key) {
            sanitize_payload(child, mode, report);
        }

        if mode == PayloadMode::PlaintextAllowed && !is_unsupported_plaintext_key(&key) {
            continue;
        }

        if is_selection_label_key(&key) {
            match mode {
                PayloadMode::PlaintextAllowed => {}
                PayloadMode::TextLengthOnly => {
                    remove_keys.push(key);
                    report.text_length_only = true;
                }
                PayloadMode::Password => {
                    remove_keys.push(key);
                    report.password_redacted = true;
                }
                PayloadMode::Sensitive => {
                    remove_keys.push(key);
                    report.sensitive_redacted = true;
                }
            }
            continue;
        }

        if is_text_value_key(&key) {
            if matches!(mode, PayloadMode::Password | PayloadMode::Sensitive) {
                remove_keys.push(key);
                if mode == PayloadMode::Password {
                    report.password_redacted = true;
                } else {
                    report.sensitive_redacted = true;
                }
            } else if let Some(length) = map.get(&key).and_then(text_length_of_value) {
                length_updates.push((format!("{key}Length"), length));
                remove_keys.push(key);
                report.text_length_only = true;
            }
            continue;
        }

        if is_text_length_key(&key) || is_text_fingerprint_key(&key) {
            if matches!(mode, PayloadMode::Password | PayloadMode::Sensitive) {
                remove_keys.push(key);
                if mode == PayloadMode::Password {
                    report.password_redacted = true;
                } else {
                    report.sensitive_redacted = true;
                }
            }
            continue;
        }

        if matches!(key.as_str(), "before" | "after") && property_is_text {
            match mode {
                PayloadMode::Password => {
                    remove_keys.push(key);
                    report.password_redacted = true;
                }
                PayloadMode::Sensitive => {
                    remove_keys.push(key);
                    report.sensitive_redacted = true;
                }
                PayloadMode::TextLengthOnly => {
                    if let Some(length) = map.get(&key).and_then(text_length_of_value) {
                        length_updates.push((format!("{key}Length"), length));
                        remove_keys.push(key);
                        report.text_length_only = true;
                    }
                }
                PayloadMode::PlaintextAllowed => {}
            }
            continue;
        }

        if mode == PayloadMode::Sensitive && is_label_key(&key) {
            remove_keys.push(key);
            report.sensitive_redacted = true;
        }
    }

    for key in remove_keys {
        map.remove(&key);
    }
    for (key, length) in length_updates {
        map.insert(key, Value::Number(Number::from(length as u64)));
    }
}

fn sync_payload_privacy_class(value: &mut Value, privacy_class: &PrivacyClass) {
    if let Value::Object(map) = value {
        map.insert(
            "privacyClass".to_string(),
            Value::String(privacy_class.as_str().to_string()),
        );
    }
}

fn target_looks_password(target: Option<&super::semantic_event::UiElementIdentity>) -> bool {
    let Some(target) = target else {
        return false;
    };
    text_contains_password(target.control_type.as_deref())
        || text_contains_password(target.localized_control_type.as_deref())
        || text_contains_password(target.class_name.as_deref())
        || text_contains_password(target.name.as_deref())
}

fn payload_looks_password(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.get("isPassword")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || map
                    .get("is_password")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || map.iter().any(|(key, value)| {
                    (text_contains_password(Some(key))
                        && !matches!(value, Value::Bool(false) | Value::Null))
                        || value
                            .as_str()
                            .is_some_and(|text| text_contains_password(Some(text)))
                        || payload_looks_password(value)
                })
        }
        Value::Array(items) => items.iter().any(payload_looks_password),
        Value::String(text) => text_contains_password(Some(text)),
        _ => false,
    }
}

fn extract_first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let Value::Object(map) = value else {
        return None;
    };
    keys.iter()
        .find_map(|key| map.get(*key).and_then(Value::as_str))
}

fn text_length_of_value(value: &Value) -> Option<usize> {
    match value {
        Value::String(text) => Some(text.chars().count()),
        Value::Array(items) if items.iter().all(Value::is_string) => Some(items.len()),
        _ => None,
    }
}

fn is_text_value_key(key: &str) -> bool {
    TEXT_VALUE_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

fn is_selection_label_key(key: &str) -> bool {
    SELECTION_LABEL_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

/// Keys that must never bypass the plaintext gate even when the mode is
/// PlaintextAllowed... historically blocked valueText. Defect-evidence now
/// allows valueText / selectedNames when allow_plaintext_input is true; only
/// keep blocking legacy aliases that should always go through length-only path
/// when we intentionally do not want them. Empty set = all text keys allowed
/// under PlaintextAllowed.
fn is_unsupported_plaintext_key(_key: &str) -> bool {
    false
}

fn is_text_length_key(key: &str) -> bool {
    TEXT_LENGTH_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

fn is_text_fingerprint_key(key: &str) -> bool {
    TEXT_FINGERPRINT_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

fn is_label_key(key: &str) -> bool {
    LABEL_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

fn is_text_property(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "value" | "value.value" | "text" | "name" | "legacyiaccessible.value"
    )
}

fn text_contains_password(value: Option<&str>) -> bool {
    value
        .map(|text| {
            let normalized = text.to_ascii_lowercase();
            normalized.contains("password")
                || normalized.contains("passwd")
                || normalized.contains("pwd")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        SemanticPrivacyOptions, sanitize_semantic_event_for_diagnostics,
        sanitize_semantic_event_with_options,
    };
    use crate::privacy::PrivacyPolicy;
    use crate::session::semantic_event::{
        PrivacyClass, SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord, SemanticEventType,
        TEST_SESSION_SEMANTIC_EVENT_KIND, UiElementIdentity,
    };

    const SENTINEL_SECRET: &str = "SENTINEL_SECRET_VALUE_42";

    #[test]
    fn semantic_privacy_password_removes_value_length_and_fingerprint() {
        let event = sample_event(json!({
            "isPassword": true,
            "property": "Value.Value",
            "before": SENTINEL_SECRET,
            "after": "new-secret",
            "value": SENTINEL_SECRET,
            "valueLength": 24,
            "valueFingerprint": "hash-secret",
            "candidateText": SENTINEL_SECRET
        }));
        let options = SemanticPrivacyOptions {
            allow_plaintext_input: true,
            ..SemanticPrivacyOptions::default()
        };

        let (sanitized, report) = sanitize_semantic_event_with_options(&event, &options);
        let serialized = serde_json::to_string(&sanitized).expect("serialize sanitized event");

        assert!(report.password_redacted);
        assert_eq!(sanitized.privacy_class, PrivacyClass::PasswordRedacted);
        assert!(!serialized.contains(SENTINEL_SECRET));
        assert!(sanitized.payload.get("value").is_none());
        assert!(sanitized.payload.get("valueLength").is_none());
        assert!(sanitized.payload.get("valueFingerprint").is_none());
        assert_eq!(sanitized.payload["privacyClass"], "password-redacted");
    }

    #[test]
    fn semantic_privacy_text_defaults_to_lengths_without_plaintext() {
        let event = sample_event(json!({
            "property": "Value.Value",
            "before": "old text",
            "after": SENTINEL_SECRET,
            "value": SENTINEL_SECRET
        }));

        let (sanitized, report) =
            sanitize_semantic_event_with_options(&event, &SemanticPrivacyOptions::default());
        let serialized = serde_json::to_string(&sanitized).expect("serialize sanitized event");

        assert!(report.text_length_only);
        assert_eq!(sanitized.privacy_class, PrivacyClass::TextLengthOnly);
        assert!(!serialized.contains(SENTINEL_SECRET));
        assert_eq!(sanitized.payload["beforeLength"], 8);
        assert_eq!(
            sanitized.payload["afterLength"],
            SENTINEL_SECRET.chars().count()
        );
        assert_eq!(
            sanitized.payload["valueLength"],
            SENTINEL_SECRET.chars().count()
        );
    }

    #[test]
    fn semantic_privacy_disabled_plaintext_removes_non_password_export_fields() {
        let mut event = sample_event(json!({
            "controlType": "Edit",
            "value": "draft@example.invalid",
            "valueText": "draft@example.invalid",
            "selectedNames": ["Production"],
            "path": "C:/Users/example/Documents/draft.txt",
            "clipboardText": "copied draft"
        }));
        event.event_id = "sem-plaintext-disabled-export".to_string();
        event.occurred_at_ms = 1_710_000_000_123;
        event.privacy_class = PrivacyClass::NotSensitive;

        let (sanitized, report) =
            sanitize_semantic_event_with_options(&event, &SemanticPrivacyOptions::default());

        assert!(report.text_length_only);
        assert!(sanitized.payload.get("value").is_none());
        assert!(sanitized.payload.get("valueText").is_none());
        assert!(sanitized.payload.get("selectedNames").is_none());
        assert!(sanitized.payload.get("path").is_none());
        assert!(sanitized.payload.get("clipboardText").is_none());
        assert_eq!(sanitized.event_id, "sem-plaintext-disabled-export");
        assert_eq!(sanitized.occurred_at_ms, 1_710_000_000_123);
        assert_eq!(sanitized.payload["controlType"], "Edit");
        assert_eq!(sanitized.privacy_class, PrivacyClass::TextLengthOnly);
        assert_eq!(sanitized.payload["privacyClass"], "text-length-only");
    }

    #[test]
    fn semantic_privacy_false_password_flag_does_not_force_password_redaction() {
        let event = sample_event(json!({
            "isPassword": false,
            "property": "Value.Value",
            "value": SENTINEL_SECRET
        }));

        let (sanitized, report) =
            sanitize_semantic_event_with_options(&event, &SemanticPrivacyOptions::default());

        assert!(!report.password_redacted);
        assert!(report.text_length_only);
        assert_eq!(sanitized.privacy_class, PrivacyClass::TextLengthOnly);
        assert_eq!(
            sanitized.payload["valueLength"],
            SENTINEL_SECRET.chars().count()
        );
    }

    #[test]
    fn semantic_privacy_excluded_policy_redacts_labels_and_payload() {
        let mut event = sample_event(json!({
            "processName": "secret.exe",
            "windowTitle": "Payment Secret",
            "name": SENTINEL_SECRET,
            "value": SENTINEL_SECRET
        }));
        event.target = Some(UiElementIdentity {
            process_id: Some(42),
            name: Some(SENTINEL_SECRET.to_string()),
            ..UiElementIdentity::default()
        });
        let options = SemanticPrivacyOptions {
            policy: PrivacyPolicy {
                enabled: true,
                excluded_window_title_keywords: vec!["payment".to_string()],
                excluded_process_names: vec!["secret.exe".to_string()],
                mask_regions: Vec::new(),
            },
            ..SemanticPrivacyOptions::default()
        };

        let (sanitized, report) = sanitize_semantic_event_with_options(&event, &options);
        let serialized = serde_json::to_string(&sanitized).expect("serialize sanitized event");

        assert!(report.sensitive_redacted);
        assert_eq!(sanitized.privacy_class, PrivacyClass::SensitiveRedacted);
        assert!(!serialized.contains(SENTINEL_SECRET));
        assert!(
            sanitized
                .target
                .as_ref()
                .and_then(|target| target.name.as_ref())
                .is_none()
        );
        assert_eq!(sanitized.payload["privacyClass"], "sensitive-redacted");
    }

    #[test]
    fn semantic_privacy_truncates_locator_labels() {
        let long_label = "A".repeat(160);
        let mut event = sample_event(json!({}));
        event.target = Some(UiElementIdentity {
            name: Some(long_label),
            ..UiElementIdentity::default()
        });

        let (sanitized, report) =
            sanitize_semantic_event_with_options(&event, &SemanticPrivacyOptions::default());

        assert!(report.label_truncated);
        assert!(
            sanitized
                .target
                .as_ref()
                .and_then(|target| target.name.as_ref())
                .is_some_and(|name| name.chars().count() <= 120)
        );
    }

    #[test]
    fn semantic_privacy_diagnostics_use_same_sanitizer() {
        let event = sample_event(json!({
            "property": "Value.Value",
            "value": SENTINEL_SECRET
        }));

        let diagnostics = sanitize_semantic_event_for_diagnostics(&event);
        let serialized = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

        assert!(!serialized.contains(SENTINEL_SECRET));
        assert_eq!(diagnostics["privacyClass"], "text-length-only");
    }

    fn sample_event(payload: serde_json::Value) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: "sem-privacy".to_string(),
            session_id: "ts-privacy".to_string(),
            event_type: SemanticEventType::UiaPropertyChanged,
            occurred_at_ms: 1,
            monotonic_offset_ms: Some(1),
            source_event_id: Some("evt-privacy".to_string()),
            target: None,
            payload,
            privacy_class: PrivacyClass::Unknown,
            reason_codes: Vec::new(),
        }
    }
}
