use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::models::normalize_optional_string;
use super::operation_models::{
    OperationOutcome, OperationOutcomeSelectionSource, OperationOutcomeStatus,
    OperationOverrideRecord, OperationReasonCode, TestSessionOperationRecord,
};
use super::operation_summary::summarize_outcome;

pub const OPERATION_OVERRIDES_FILE_NAME: &str = "operation-overrides.ndjson";

#[derive(Debug)]
pub enum OperationOverrideError {
    Io(io::Error),
    Serialize(serde_json::Error),
    ParseLine {
        line_number: usize,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for OperationOverrideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "operation override store io failed: {err}"),
            Self::Serialize(err) => {
                write!(f, "operation override serialization failed: {err}")
            }
            Self::ParseLine {
                line_number,
                source,
            } => {
                write!(
                    f,
                    "operation override parse failed at line {line_number}: {source}"
                )
            }
        }
    }
}

impl std::error::Error for OperationOverrideError {}

impl From<io::Error> for OperationOverrideError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug, Clone)]
pub struct OperationOverrideStore {
    path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct OperationOverrideReadReport {
    pub overrides: Vec<OperationOverrideRecord>,
    pub ignored_truncated_tail: bool,
    pub malformed_line_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OperationOverrideApplyReport {
    pub operations: Vec<TestSessionOperationRecord>,
    pub orphan_overrides: Vec<OrphanOperationOverride>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrphanOperationOverride {
    pub override_record: OperationOverrideRecord,
    pub reason: OperationOverrideOrphanReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationOverrideOrphanReason {
    OperationMissing,
    SessionMismatch,
}

impl OperationOverrideStore {
    pub fn for_session_dir(session_dir: impl AsRef<Path>) -> Self {
        Self {
            path: session_dir.as_ref().join(OPERATION_OVERRIDES_FILE_NAME),
        }
    }

    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(
        &self,
        override_record: &OperationOverrideRecord,
    ) -> Result<(), OperationOverrideError> {
        self.append_batch(std::slice::from_ref(override_record))
    }

    pub fn append_batch(
        &self,
        overrides: &[OperationOverrideRecord],
    ) -> Result<(), OperationOverrideError> {
        if overrides.is_empty() {
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        for override_record in overrides {
            serde_json::to_writer(&mut file, override_record)
                .map_err(OperationOverrideError::Serialize)?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
        Ok(())
    }

    pub fn read(&self) -> Result<OperationOverrideReadReport, OperationOverrideError> {
        if !self.path.exists() {
            return Ok(OperationOverrideReadReport::default());
        }

        let content = fs::read_to_string(&self.path)?;
        let ends_with_newline = content.ends_with('\n') || content.ends_with('\r');
        let lines = content.lines().collect::<Vec<_>>();
        let last_index = lines.len().saturating_sub(1);
        let mut report = OperationOverrideReadReport::default();

        for (index, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<OperationOverrideRecord>(line) {
                Ok(override_record) => report.overrides.push(override_record),
                Err(_) if index == last_index && !ends_with_newline => {
                    report.ignored_truncated_tail = true;
                    report.malformed_line_count = report.malformed_line_count.saturating_add(1);
                    break;
                }
                Err(source) => {
                    return Err(OperationOverrideError::ParseLine {
                        line_number: index + 1,
                        source,
                    });
                }
            }
        }

        Ok(report)
    }
}

pub fn apply_operation_overrides(
    mut operations: Vec<TestSessionOperationRecord>,
    overrides: &[OperationOverrideRecord],
) -> OperationOverrideApplyReport {
    let index_by_operation_id = operations
        .iter()
        .enumerate()
        .map(|(index, operation)| (operation.operation_id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut ordered_overrides = overrides.to_vec();
    ordered_overrides.sort_by_key(|override_record| {
        (
            override_record.occurred_at_ms,
            override_record.override_id.clone(),
        )
    });

    let mut orphan_overrides = Vec::new();
    for override_record in ordered_overrides {
        let Some(operation_index) = index_by_operation_id
            .get(&override_record.operation_id)
            .copied()
        else {
            orphan_overrides.push(OrphanOperationOverride {
                override_record,
                reason: OperationOverrideOrphanReason::OperationMissing,
            });
            continue;
        };

        if !override_record.session_id.trim().is_empty()
            && override_record.session_id != operations[operation_index].session_id
        {
            orphan_overrides.push(OrphanOperationOverride {
                override_record,
                reason: OperationOverrideOrphanReason::SessionMismatch,
            });
            continue;
        }

        apply_override_to_operation(&mut operations[operation_index], &override_record);
    }

    OperationOverrideApplyReport {
        operations,
        orphan_overrides,
    }
}

fn apply_override_to_operation(
    operation: &mut TestSessionOperationRecord,
    override_record: &OperationOverrideRecord,
) {
    let changes = &override_record.changes;
    let mut refresh_display_summary = false;

    if let Some(title) = normalize_optional_string(changes.title.clone()) {
        operation.title = title;
        operation.edited = true;
        refresh_display_summary = true;
    }

    let result_summary_overridden =
        if let Some(result_summary) = normalize_optional_string(changes.result_summary.clone()) {
            operation.result_summary = result_summary.clone();
            operation.outcome.summary = Some(result_summary);
            operation.edited = true;
            refresh_display_summary = true;
            true
        } else {
            false
        };

    let outcome_changed =
        changes.selected_outcome_status.is_some() || changes.selected_transition_id.is_some();
    if outcome_changed {
        preserve_auto_outcome(operation);
        operation.outcome_selection_source = OperationOutcomeSelectionSource::Manual;
        operation.edited = true;
        let selected_status = changes.selected_outcome_status.clone();
        let promote_selected_transition = selected_status.is_none();
        apply_selected_outcome(operation, selected_status);
        apply_selected_transition(
            operation,
            changes.selected_transition_id.clone(),
            promote_selected_transition,
        );
        push_unique(
            &mut operation.outcome.reason_codes,
            OperationReasonCode::ExplicitCompletion,
        );
        if !result_summary_overridden {
            operation.result_summary =
                summarize_outcome(&operation.outcome, &operation.transitions);
        }
        refresh_display_summary = true;
    }

    if let Some(ignored) = changes.ignored {
        operation.ignored = ignored;
        operation.edited = true;
    }

    if changes.business_alias.is_some() {
        operation.business_alias = normalize_optional_string(changes.business_alias.clone());
        operation.edited = true;
    }

    if changes.note.is_some() {
        operation.manual_note = normalize_optional_string(changes.note.clone());
        operation.edited = true;
    }

    if refresh_display_summary {
        operation.display_summary = format!(
            "{} -> {}，耗时 {}ms",
            operation.title, operation.result_summary, operation.outcome.latency_ms
        );
    }
}

fn apply_selected_outcome(
    operation: &mut TestSessionOperationRecord,
    selected_status: Option<OperationOutcomeStatus>,
) {
    let Some(selected_status) = selected_status else {
        return;
    };

    if matches!(
        selected_status,
        OperationOutcomeStatus::Ambiguous
            | OperationOutcomeStatus::Incomplete
            | OperationOutcomeStatus::ObserverDegraded
            | OperationOutcomeStatus::LegacyUnknown
    ) {
        operation.outcome.primary_transition_id = None;
    }
    operation.outcome.status = selected_status;
}

fn apply_selected_transition(
    operation: &mut TestSessionOperationRecord,
    selected_id: Option<String>,
    promote_to_confirmed: bool,
) {
    let Some(selected_id) = normalize_optional_string(selected_id) else {
        return;
    };

    let selected_transition = operation
        .transitions
        .iter()
        .find(|transition| transition.transition_id == selected_id);

    operation.outcome.primary_transition_id = Some(selected_id.clone());
    if !operation
        .outcome
        .candidate_transition_ids
        .iter()
        .any(|candidate_id| candidate_id == &selected_id)
    {
        operation.outcome.candidate_transition_ids.push(selected_id);
        operation.outcome.candidate_transition_ids.sort();
        operation.outcome.candidate_transition_ids.dedup();
    }

    if let Some(selected_transition) = selected_transition {
        operation.outcome.observed_at_ms = selected_transition.occurred_at_ms;
        operation.outcome.latency_ms = selected_transition
            .occurred_at_ms
            .saturating_sub(operation.action.occurred_at_ms);
        operation.outcome.reason_codes = selected_transition.reason_codes.clone();
        if promote_to_confirmed {
            operation.outcome.status = OperationOutcomeStatus::Confirmed;
        }
    }
}

fn preserve_auto_outcome(operation: &mut TestSessionOperationRecord) {
    let original = operation.outcome.clone();
    if !operation
        .completion_candidates
        .iter()
        .any(|candidate| same_outcome_identity(candidate, &original))
    {
        operation.completion_candidates.push(original);
    }
}

fn same_outcome_identity(left: &OperationOutcome, right: &OperationOutcome) -> bool {
    left.outcome_id == right.outcome_id
        && left.status == right.status
        && left.primary_transition_id == right.primary_transition_id
        && left.candidate_transition_ids == right.candidate_transition_ids
}

fn push_unique(reason_codes: &mut Vec<OperationReasonCode>, reason_code: OperationReasonCode) {
    if !reason_codes.contains(&reason_code) {
        reason_codes.push(reason_code);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;
    use crate::session::models::{
        TEST_SESSION_EVENT_KIND, TEST_SESSION_SCHEMA_VERSION, TestSessionEventRecord,
        TestSessionEventType,
    };
    use crate::session::operation_builder::build_operation_records_from_events;
    use crate::session::operation_models::{
        OperationOverrideChanges, OperationOverrideSource, PrivacyClass, SemanticEventRecord,
        SemanticEventType, TEST_SESSION_OPERATION_OVERRIDE_KIND, TEST_SESSION_SEMANTIC_EVENT_KIND,
    };

    #[test]
    fn operation_rebuild_keeps_stable_ids_and_applies_manual_override() {
        let events = vec![click_event("input-save", 1_000)];
        let semantic_events = vec![
            semantic_event(
                "sem-save-target",
                SemanticEventType::UiaSnapshot,
                990,
                Some("input-save"),
                json!({
                    "runtimeId": [1, 10],
                    "processId": 42,
                    "name": "Save",
                    "controlType": "Button"
                }),
            ),
            semantic_event(
                "sem-save-toast",
                SemanticEventType::PopupAppeared,
                1_420,
                Some("input-save"),
                json!({
                    "runtimeId": [1, 20],
                    "processId": 42,
                    "name": "Saved",
                    "controlType": "Text"
                }),
            ),
        ];
        let first = build_operation_records_from_events("ts-1", 500, &events, &semantic_events);
        let stable_operation_id = first[0].operation_id.clone();
        let override_record = override_record(
            "override-1",
            "ts-1",
            &stable_operation_id,
            OperationOverrideChanges {
                title: Some("人工确认保存".to_string()),
                result_summary: Some("人工选择：保存提示出现".to_string()),
                selected_outcome_status: Some(OperationOutcomeStatus::Confirmed),
                selected_transition_id: first[0].outcome.primary_transition_id.clone(),
                ignored: Some(false),
                business_alias: Some("保存订单".to_string()),
                note: Some("人工复核通过".to_string()),
            },
        );

        for _ in 0..10 {
            let rebuilt =
                build_operation_records_from_events("ts-1", 500, &events, &semantic_events);
            assert_eq!(rebuilt[0].operation_id, stable_operation_id);
            let report = apply_operation_overrides(rebuilt, std::slice::from_ref(&override_record));
            assert!(report.orphan_overrides.is_empty());
            let operation = &report.operations[0];
            assert_eq!(operation.operation_id, stable_operation_id);
            assert_eq!(operation.title, "人工确认保存");
            assert_eq!(operation.result_summary, "人工选择：保存提示出现");
            assert_eq!(
                operation.outcome_selection_source,
                OperationOutcomeSelectionSource::Manual
            );
            assert!(operation.edited);
            assert!(!operation.ignored);
            assert_eq!(operation.business_alias.as_deref(), Some("保存订单"));
            assert_eq!(operation.manual_note.as_deref(), Some("人工复核通过"));
            assert_eq!(operation.completion_candidates.len(), 1);
            assert!(
                operation
                    .outcome
                    .reason_codes
                    .contains(&OperationReasonCode::ExplicitCompletion)
            );
        }
    }

    #[test]
    fn operation_override_reports_orphan_without_dropping_diagnostics() {
        let operations = Vec::new();
        let orphan = override_record(
            "override-orphan",
            "ts-1",
            "operation-missing",
            OperationOverrideChanges {
                title: Some("lost".to_string()),
                ..OperationOverrideChanges::default()
            },
        );

        let report = apply_operation_overrides(operations, std::slice::from_ref(&orphan));

        assert!(report.operations.is_empty());
        assert_eq!(report.orphan_overrides.len(), 1);
        assert_eq!(
            report.orphan_overrides[0].reason,
            OperationOverrideOrphanReason::OperationMissing
        );
        assert_eq!(
            report.orphan_overrides[0].override_record.override_id,
            "override-orphan"
        );
    }

    #[test]
    fn operation_override_store_appends_and_reads_ndjson() {
        let temp_dir = unique_temp_dir("shadowrecord-operation-override-store");
        let store = OperationOverrideStore::for_session_dir(&temp_dir);
        let first = override_record(
            "override-1",
            "ts-1",
            "operation-1",
            OperationOverrideChanges {
                title: Some("标题一".to_string()),
                ..OperationOverrideChanges::default()
            },
        );
        let second = override_record(
            "override-2",
            "ts-1",
            "operation-1",
            OperationOverrideChanges {
                ignored: Some(true),
                ..OperationOverrideChanges::default()
            },
        );

        store
            .append_batch(&[first.clone(), second.clone()])
            .expect("append override records");
        let report = store.read().expect("read override records");

        assert_eq!(
            store.path().file_name().and_then(|name| name.to_str()),
            Some(OPERATION_OVERRIDES_FILE_NAME)
        );
        assert_eq!(report.overrides, vec![first, second]);
        assert!(!report.ignored_truncated_tail);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    fn click_event(id: &str, at: u64) -> TestSessionEventRecord {
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
            x: Some(120),
            y: Some(220),
            logical_x: Some(120),
            logical_y: Some(220),
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
            window_title: Some("Editor".to_string()),
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
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
        payload: serde_json::Value,
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

    fn override_record(
        override_id: &str,
        session_id: &str,
        operation_id: &str,
        changes: OperationOverrideChanges,
    ) -> OperationOverrideRecord {
        OperationOverrideRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_OPERATION_OVERRIDE_KIND.to_string(),
            override_id: override_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            occurred_at_ms: 10_000,
            source: OperationOverrideSource::User,
            changes,
            reason: Some("manual-review".to_string()),
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }
}
