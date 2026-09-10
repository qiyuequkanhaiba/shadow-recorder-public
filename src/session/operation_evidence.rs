use std::collections::HashSet;

use super::operation_models::{
    OperationAction, OperationEvidence, OperationEvidenceKind, OperationEvidenceRole,
    OperationOutcome, OperationOutcomeStatus, OperationReasonCode, StateTransition,
};

#[allow(dead_code)]
pub fn build_operation_evidence(
    action: &OperationAction,
    outcome: &OperationOutcome,
    transitions: &[StateTransition],
) -> Vec<OperationEvidence> {
    let mut evidence = Vec::new();

    for source_event_id in &action.source_event_ids {
        push_evidence(
            &mut evidence,
            action,
            OperationEvidenceKind::RawEvent,
            OperationEvidenceRole::SupportsTarget,
            source_event_id.clone(),
            action.occurred_at_ms,
            action.target_reason_codes.first().cloned(),
        );
    }

    if let Some(state_before) = action.state_before.as_ref() {
        push_evidence(
            &mut evidence,
            action,
            OperationEvidenceKind::UiaSnapshot,
            OperationEvidenceRole::SupportsTarget,
            state_before.snapshot_id.clone(),
            state_before.captured_at_ms,
            action.target_reason_codes.first().cloned(),
        );
    }

    let outcome_transition_ids = outcome_transition_ids(outcome);
    let primary_id = outcome.primary_transition_id.as_deref();
    let primary_transition = primary_id.and_then(|id| {
        transitions
            .iter()
            .find(|transition| transition.transition_id == id)
    });

    for transition in transitions
        .iter()
        .filter(|transition| outcome_transition_ids.contains(&transition.transition_id))
    {
        let role = if is_contradicting_transition(outcome, primary_transition, transition) {
            OperationEvidenceRole::Contradicts
        } else {
            outcome_evidence_role(outcome, transition, primary_id)
        };
        push_evidence(
            &mut evidence,
            action,
            OperationEvidenceKind::StateTransition,
            role,
            transition.transition_id.clone(),
            transition.occurred_at_ms,
            transition.reason_codes.first().cloned(),
        );
    }

    if should_add_outcome_context_evidence(outcome, transitions) {
        push_evidence(
            &mut evidence,
            action,
            OperationEvidenceKind::RawEvent,
            OperationEvidenceRole::Context,
            action
                .source_event_ids
                .first()
                .cloned()
                .unwrap_or_else(|| action.action_id.clone()),
            outcome.observed_at_ms,
            outcome.reason_codes.first().cloned(),
        );
    }

    evidence
}

fn outcome_transition_ids(outcome: &OperationOutcome) -> HashSet<String> {
    let mut ids = outcome
        .candidate_transition_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if let Some(primary_transition_id) = outcome.primary_transition_id.clone() {
        ids.insert(primary_transition_id);
    }
    ids
}

fn outcome_evidence_role(
    outcome: &OperationOutcome,
    transition: &StateTransition,
    primary_id: Option<&str>,
) -> OperationEvidenceRole {
    match outcome.status {
        OperationOutcomeStatus::Confirmed
            if primary_id == Some(transition.transition_id.as_str()) =>
        {
            OperationEvidenceRole::SupportsOutcome
        }
        OperationOutcomeStatus::Confirmed => OperationEvidenceRole::Context,
        OperationOutcomeStatus::Candidate
        | OperationOutcomeStatus::Ambiguous
        | OperationOutcomeStatus::Incomplete
        | OperationOutcomeStatus::ObserverDegraded
        | OperationOutcomeStatus::LegacyUnknown
        | OperationOutcomeStatus::Other(_) => OperationEvidenceRole::Context,
    }
}

/// Confirmed primary result is contradicted by another candidate that flips the
/// same property to a different after-value (or reverses a toggle/selection).
fn is_contradicting_transition(
    outcome: &OperationOutcome,
    primary: Option<&StateTransition>,
    candidate: &StateTransition,
) -> bool {
    if outcome.status != OperationOutcomeStatus::Confirmed {
        return false;
    }
    let Some(primary) = primary else {
        return false;
    };
    if primary.transition_id == candidate.transition_id {
        return false;
    }
    let Some(primary_property) = primary.property.as_deref() else {
        return false;
    };
    if candidate.property.as_deref() != Some(primary_property) {
        return false;
    }
    matches!(
        (primary.after.as_ref(), candidate.after.as_ref()),
        (Some(left), Some(right)) if left != right
    )
}

fn should_add_outcome_context_evidence(
    outcome: &OperationOutcome,
    transitions: &[StateTransition],
) -> bool {
    transitions.is_empty()
        && matches!(
            outcome.status,
            OperationOutcomeStatus::Incomplete
                | OperationOutcomeStatus::LegacyUnknown
                | OperationOutcomeStatus::Other(_)
        )
}

fn push_evidence(
    evidence: &mut Vec<OperationEvidence>,
    action: &OperationAction,
    kind: OperationEvidenceKind,
    role: OperationEvidenceRole,
    source_id: String,
    occurred_at_ms: u64,
    reason_code: Option<OperationReasonCode>,
) {
    let evidence_id = format!("evidence-{}-{}", action.action_id, evidence.len());
    evidence.push(OperationEvidence {
        evidence_id,
        kind,
        role,
        source_id,
        occurred_at_ms,
        artifact_ref: None,
        video_range: None,
        reason_code,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::operation_models::{
        OperationActionConfidence, OperationActionKind, OperationOutcomeConfidence, PrivacyClass,
        StateTransitionConfidence, StateTransitionKind, UiStateSnapshot,
    };

    fn action() -> OperationAction {
        OperationAction {
            action_id: "action-save".to_string(),
            kind: OperationActionKind::Click,
            occurred_at_ms: 1_000,
            ended_at_ms: Some(1_000),
            target: None,
            state_before: Some(UiStateSnapshot {
                snapshot_id: "state-before".to_string(),
                captured_at_ms: 980,
                element: None,
                is_enabled: Some(true),
                has_keyboard_focus: None,
                is_offscreen: None,
                value_length: None,
                value_text: None,
                value_fingerprint: None,
                toggle_state: None,
                selection_state: None,
                selected_names: None,
                expand_collapse_state: None,
                range_value: None,
                privacy_class: PrivacyClass::NotSensitive,
                source: None,
            }),
            coordinate: None,
            source_event_ids: vec!["input-save".to_string()],
            target_reason_codes: vec![OperationReasonCode::RuntimeIdMatch],
            confidence: OperationActionConfidence::default(),
            content_preview: None,
        }
    }

    fn transition() -> StateTransition {
        StateTransition {
            transition_id: "transition-toast".to_string(),
            kind: StateTransitionKind::Lifecycle,
            occurred_at_ms: 1_420,
            element: None,
            property: Some("popup".to_string()),
            before: None,
            after: None,
            privacy_class: PrivacyClass::NotSensitive,
            source_event_ids: vec!["sem-toast".to_string()],
            reason_codes: vec![OperationReasonCode::PopupAppeared],
            confidence: StateTransitionConfidence::default(),
        }
    }

    fn outcome(status: OperationOutcomeStatus) -> OperationOutcome {
        OperationOutcome {
            outcome_id: "outcome-save".to_string(),
            status,
            summary: None,
            observed_at_ms: 1_420,
            latency_ms: 420,
            primary_transition_id: Some("transition-toast".to_string()),
            candidate_transition_ids: vec!["transition-toast".to_string()],
            reason_codes: vec![OperationReasonCode::PopupAppeared],
            confidence: OperationOutcomeConfidence::default(),
        }
    }

    #[test]
    fn operation_evidence_links_action_state_and_confirmed_outcome() {
        let action = action();
        let transition = transition();
        let outcome = outcome(OperationOutcomeStatus::Confirmed);

        let evidence = build_operation_evidence(&action, &outcome, &[transition]);

        assert_eq!(evidence.len(), 3);
        assert_eq!(evidence[0].kind, OperationEvidenceKind::RawEvent);
        assert_eq!(evidence[0].role, OperationEvidenceRole::SupportsTarget);
        assert_eq!(evidence[1].kind, OperationEvidenceKind::UiaSnapshot);
        assert_eq!(evidence[1].role, OperationEvidenceRole::SupportsTarget);
        assert_eq!(evidence[2].kind, OperationEvidenceKind::StateTransition);
        assert_eq!(evidence[2].role, OperationEvidenceRole::SupportsOutcome);
        assert_eq!(
            evidence[2].reason_code,
            Some(OperationReasonCode::PopupAppeared)
        );
    }

    #[test]
    fn operation_evidence_keeps_ambiguous_transition_as_context() {
        let action = action();
        let transition = transition();
        let mut outcome = outcome(OperationOutcomeStatus::Ambiguous);
        outcome.primary_transition_id = None;

        let evidence = build_operation_evidence(&action, &outcome, &[transition]);

        assert_eq!(evidence[2].role, OperationEvidenceRole::Context);
    }

    #[test]
    fn operation_evidence_keeps_candidate_transition_as_context() {
        let action = action();
        let transition = transition();
        let outcome = outcome(OperationOutcomeStatus::Candidate);

        let evidence = build_operation_evidence(&action, &outcome, &[transition]);

        assert_eq!(evidence[2].role, OperationEvidenceRole::Context);
    }

    #[test]
    fn operation_evidence_does_not_inline_binary_artifacts() {
        let action = action();
        let transition = transition();
        let outcome = outcome(OperationOutcomeStatus::Confirmed);

        let evidence = build_operation_evidence(&action, &outcome, &[transition]);

        assert!(
            evidence
                .iter()
                .all(|item| item.artifact_ref.is_none() && item.video_range.is_none())
        );
    }

    #[test]
    fn operation_evidence_adds_context_for_incomplete_without_transition() {
        let action = action();
        let mut outcome = outcome(OperationOutcomeStatus::Incomplete);
        outcome.primary_transition_id = None;
        outcome.candidate_transition_ids.clear();
        outcome.reason_codes = vec![
            OperationReasonCode::ResultTimeout,
            OperationReasonCode::NoObservableChange,
        ];

        let evidence = build_operation_evidence(&action, &outcome, &[]);

        assert!(
            evidence
                .iter()
                .any(|item| item.role == OperationEvidenceRole::Context
                    && item.reason_code == Some(OperationReasonCode::ResultTimeout))
        );
    }

    #[test]
    fn operation_evidence_marks_conflicting_candidate_as_contradicts() {
        let action = action();
        let primary = StateTransition {
            transition_id: "transition-on".to_string(),
            kind: StateTransitionKind::Property,
            occurred_at_ms: 1_100,
            element: None,
            property: Some("toggleState".to_string()),
            before: Some(serde_json::json!("off")),
            after: Some(serde_json::json!("on")),
            privacy_class: PrivacyClass::NotSensitive,
            source_event_ids: vec!["sem-on".to_string()],
            reason_codes: vec![OperationReasonCode::ToggleStateChanged],
            confidence: StateTransitionConfidence::default(),
        };
        let conflict = StateTransition {
            transition_id: "transition-off".to_string(),
            kind: StateTransitionKind::Property,
            occurred_at_ms: 1_200,
            element: None,
            property: Some("toggleState".to_string()),
            before: Some(serde_json::json!("on")),
            after: Some(serde_json::json!("off")),
            privacy_class: PrivacyClass::NotSensitive,
            source_event_ids: vec!["sem-off".to_string()],
            reason_codes: vec![OperationReasonCode::ToggleStateChanged],
            confidence: StateTransitionConfidence::default(),
        };
        let mut outcome = outcome(OperationOutcomeStatus::Confirmed);
        outcome.primary_transition_id = Some("transition-on".to_string());
        outcome.candidate_transition_ids =
            vec!["transition-on".to_string(), "transition-off".to_string()];

        let evidence = build_operation_evidence(&action, &outcome, &[primary, conflict]);

        assert!(
            evidence.iter().any(|item| {
                item.source_id == "transition-on"
                    && item.role == OperationEvidenceRole::SupportsOutcome
            }),
            "primary should support outcome"
        );
        assert!(
            evidence.iter().any(|item| {
                item.source_id == "transition-off"
                    && item.role == OperationEvidenceRole::Contradicts
            }),
            "conflicting same-property candidate should contradict"
        );
    }
}
