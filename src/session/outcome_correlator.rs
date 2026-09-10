use super::operation_models::{
    OperationAction, OperationActionKind, OperationOutcome, OperationOutcomeConfidence,
    OperationOutcomeStatus, OperationReasonCode, StateTransition, StateTransitionKind,
    UiElementIdentity,
};
use super::semantic_profile::{
    SemanticProfile, apply_scenario_to_outcome, match_scenario_completion,
    resolve_alias_for_identity,
};
use super::uia_state_cache::state_cache_key;

pub const DEFAULT_OUTCOME_WINDOW_MS: u64 = 3_000;

#[derive(Debug, Clone, PartialEq)]
pub struct OutcomeCorrelationOptions {
    pub window_ms: u64,
    pub confirmed_score_threshold: f64,
    pub candidate_score_threshold: f64,
    pub ambiguous_score_delta: f64,
    pub observer_facts_present: bool,
}

impl Default for OutcomeCorrelationOptions {
    fn default() -> Self {
        Self {
            window_ms: DEFAULT_OUTCOME_WINDOW_MS,
            confirmed_score_threshold: 60.0,
            candidate_score_threshold: 35.0,
            ambiguous_score_delta: 5.0,
            observer_facts_present: true,
        }
    }
}

#[derive(Debug, Clone)]
struct OutcomeCandidate<'a> {
    transition: &'a StateTransition,
    score: f64,
    temporal_confidence: f64,
    identity_confidence: Option<f64>,
    transition_confidence: f64,
}

#[allow(dead_code)]
pub fn correlate_outcomes_for_actions(
    actions: &[OperationAction],
    transitions: &[StateTransition],
) -> Vec<OperationOutcome> {
    correlate_outcomes_for_actions_with_profile(actions, transitions, None, true)
}

pub fn correlate_outcomes_for_actions_with_profile(
    actions: &[OperationAction],
    transitions: &[StateTransition],
    profile: Option<&SemanticProfile>,
    observer_facts_present: bool,
) -> Vec<OperationOutcome> {
    let mut options = OutcomeCorrelationOptions::default();
    options.observer_facts_present = observer_facts_present;
    let mut ordered_actions = actions.to_vec();
    ordered_actions.sort_by_key(|action| (action.occurred_at_ms, action.action_id.clone()));
    ordered_actions
        .iter()
        .enumerate()
        .map(|(index, action)| {
            let next_input_at_ms = ordered_actions
                .iter()
                .skip(index + 1)
                .map(|next| next.occurred_at_ms)
                .find(|next_at| *next_at >= action.occurred_at_ms);
            correlate_outcome_for_action_with_profile(
                action,
                transitions,
                next_input_at_ms,
                &options,
                profile,
            )
        })
        .collect()
}

pub fn correlate_outcome_for_action(
    action: &OperationAction,
    transitions: &[StateTransition],
    next_input_at_ms: Option<u64>,
    options: &OutcomeCorrelationOptions,
) -> OperationOutcome {
    correlate_outcome_for_action_with_profile(action, transitions, next_input_at_ms, options, None)
}

pub fn correlate_outcome_for_action_with_profile(
    action: &OperationAction,
    transitions: &[StateTransition],
    next_input_at_ms: Option<u64>,
    options: &OutcomeCorrelationOptions,
    profile: Option<&SemanticProfile>,
) -> OperationOutcome {
    let window_end_ms = outcome_window_end(action, next_input_at_ms, options.window_ms);
    let action_alias = profile.and_then(|item| {
        resolve_alias_for_identity(item, action.target.as_ref(), None, None).map(|m| m.alias)
    });
    let scenario = profile.and_then(|item| {
        match_scenario_completion(
            item,
            action,
            action_alias.as_deref(),
            transitions,
            window_end_ms,
        )
    });

    let mut candidates = transitions
        .iter()
        .filter(|transition| transition.occurred_at_ms >= action.occurred_at_ms)
        .filter(|transition| transition.occurred_at_ms <= window_end_ms)
        .filter_map(|transition| candidate_for_transition(action, transition, options.window_ms))
        .filter(|candidate| candidate.score >= options.candidate_score_threshold)
        .collect::<Vec<_>>();

    if let Some(scenario) = scenario.as_ref() {
        if !candidates
            .iter()
            .any(|candidate| candidate.transition.transition_id == scenario.transition_id)
            && let Some(transition) = transitions
                .iter()
                .find(|item| item.transition_id == scenario.transition_id)
            && let Some(candidate) = candidate_for_transition(action, transition, options.window_ms)
        {
            candidates.push(candidate);
        }
        for candidate in &mut candidates {
            if candidate.transition.transition_id == scenario.transition_id {
                candidate.score = (candidate.score + scenario.score_boost).min(100.0);
                candidate.transition_confidence = (candidate.transition_confidence + 0.25).min(1.0);
            }
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.transition
                    .occurred_at_ms
                    .cmp(&right.transition.occurred_at_ms)
            })
            .then_with(|| {
                left.transition
                    .transition_id
                    .cmp(&right.transition.transition_id)
            })
    });

    let Some(top) = candidates.first() else {
        if !options.observer_facts_present {
            return observer_absent_outcome(action, window_end_ms);
        }
        return incomplete_outcome(action, window_end_ms, next_input_at_ms);
    };

    if is_observer_degraded_candidate(top.transition) {
        return observer_degraded_outcome(action, top);
    }

    let ambiguous = candidates
        .iter()
        .filter(|candidate| {
            top.score - candidate.score <= options.ambiguous_score_delta
                && candidate.transition.transition_id != top.transition.transition_id
                && !is_weak_candidate(candidate, options)
                && !is_observer_degraded_candidate(candidate.transition)
        })
        .collect::<Vec<_>>();
    if !ambiguous.is_empty() && !is_weak_candidate(top, options) {
        let mut candidate_ids = vec![top.transition.transition_id.clone()];
        candidate_ids.extend(
            ambiguous
                .iter()
                .map(|candidate| candidate.transition.transition_id.clone()),
        );
        candidate_ids.sort();
        candidate_ids.dedup();
        let observed_at_ms = ambiguous
            .iter()
            .fold(top.transition.occurred_at_ms, |latest, candidate| {
                latest.max(candidate.transition.occurred_at_ms)
            });
        return OperationOutcome {
            outcome_id: stable_outcome_id(action),
            status: OperationOutcomeStatus::Ambiguous,
            summary: None,
            observed_at_ms,
            latency_ms: observed_at_ms.saturating_sub(action.occurred_at_ms),
            primary_transition_id: None,
            candidate_transition_ids: candidate_ids,
            reason_codes: vec![OperationReasonCode::MultipleCandidates],
            confidence: outcome_confidence(top),
        };
    }

    let status = if is_weak_candidate(top, options) {
        OperationOutcomeStatus::Candidate
    } else {
        OperationOutcomeStatus::Confirmed
    };
    let mut reason_codes = top.transition.reason_codes.clone();
    append_observer_recovery_reasons(&mut reason_codes, &candidates);
    if status == OperationOutcomeStatus::Candidate {
        push_unique(&mut reason_codes, OperationReasonCode::WeakCompletionSignal);
    }
    if top.transition.property.as_deref() == Some("dialog") {
        push_unique(
            &mut reason_codes,
            OperationReasonCode::NegativeCompletionSignal,
        );
    }

    let mut outcome = OperationOutcome {
        outcome_id: stable_outcome_id(action),
        status,
        summary: None,
        observed_at_ms: top.transition.occurred_at_ms,
        latency_ms: top
            .transition
            .occurred_at_ms
            .saturating_sub(action.occurred_at_ms),
        primary_transition_id: if top.score >= options.confirmed_score_threshold
            && !is_weak_candidate(top, options)
        {
            Some(top.transition.transition_id.clone())
        } else {
            None
        },
        candidate_transition_ids: candidates
            .iter()
            .map(|candidate| candidate.transition.transition_id.clone())
            .collect(),
        reason_codes,
        confidence: outcome_confidence(top),
    };
    if let Some(scenario) = scenario.as_ref() {
        apply_scenario_to_outcome(&mut outcome, scenario);
    }
    outcome
}

fn candidate_for_transition<'a>(
    action: &OperationAction,
    transition: &'a StateTransition,
    window_ms: u64,
) -> Option<OutcomeCandidate<'a>> {
    if is_focus_context_only_transition(action, transition) {
        return None;
    }

    let latency_ms = transition
        .occurred_at_ms
        .saturating_sub(action.occurred_at_ms);
    let temporal_confidence = if window_ms == 0 {
        if latency_ms == 0 { 1.0 } else { 0.0 }
    } else {
        1.0 - ((latency_ms as f64 / window_ms as f64) * 0.40)
    }
    .clamp(0.0, 1.0);
    let transition_confidence = transition_strength(transition);
    let identity_confidence =
        identity_confidence(action.target.as_ref(), transition.element.as_ref());
    let compatibility = semantic_compatibility(action, transition);

    let mut score = temporal_confidence * 25.0 + transition_confidence * 30.0 + compatibility;
    if let Some(identity_confidence) = identity_confidence {
        score += identity_confidence * 25.0;
    }
    if is_observer_degraded_candidate(transition) {
        score += 25.0;
    }

    Some(OutcomeCandidate {
        transition,
        score: score.clamp(0.0, 100.0),
        temporal_confidence,
        identity_confidence,
        transition_confidence,
    })
}

fn outcome_window_end(
    action: &OperationAction,
    next_input_at_ms: Option<u64>,
    window_ms: u64,
) -> u64 {
    let timeout_end = action.occurred_at_ms.saturating_add(window_ms);
    next_input_at_ms
        .filter(|next_at| *next_at >= action.occurred_at_ms)
        .map(|next_at| next_at.min(timeout_end))
        .unwrap_or(timeout_end)
}

fn observer_absent_outcome(action: &OperationAction, observed_at_ms: u64) -> OperationOutcome {
    OperationOutcome {
        outcome_id: stable_outcome_id(action),
        status: OperationOutcomeStatus::ObserverDegraded,
        summary: None,
        observed_at_ms,
        latency_ms: observed_at_ms.saturating_sub(action.occurred_at_ms),
        primary_transition_id: None,
        candidate_transition_ids: Vec::new(),
        reason_codes: vec![
            OperationReasonCode::UiaDisabled,
            OperationReasonCode::NoObservableChange,
        ],
        confidence: OperationOutcomeConfidence {
            temporal: Some(1.0),
            identity: None,
            transition: Some(0.0),
            evidence: Some(0.0),
            overall: Some(0.20),
        },
    }
}

fn incomplete_outcome(
    action: &OperationAction,
    observed_at_ms: u64,
    next_input_at_ms: Option<u64>,
) -> OperationOutcome {
    let mut reason_codes = Vec::new();
    if next_input_at_ms
        .filter(|next_at| *next_at >= action.occurred_at_ms && *next_at == observed_at_ms)
        .is_some()
    {
        reason_codes.push(OperationReasonCode::NextInputClosedWindow);
    } else {
        reason_codes.push(OperationReasonCode::ResultTimeout);
    }
    reason_codes.push(OperationReasonCode::NoObservableChange);

    OperationOutcome {
        outcome_id: stable_outcome_id(action),
        status: OperationOutcomeStatus::Incomplete,
        summary: None,
        observed_at_ms,
        latency_ms: observed_at_ms.saturating_sub(action.occurred_at_ms),
        primary_transition_id: None,
        candidate_transition_ids: Vec::new(),
        reason_codes,
        confidence: OperationOutcomeConfidence {
            temporal: Some(1.0),
            identity: None,
            transition: Some(0.0),
            evidence: Some(0.0),
            overall: Some(0.20),
        },
    }
}

fn observer_degraded_outcome(
    action: &OperationAction,
    candidate: &OutcomeCandidate<'_>,
) -> OperationOutcome {
    let mut reason_codes = candidate.transition.reason_codes.clone();
    if reason_codes.is_empty() {
        reason_codes.push(OperationReasonCode::UiaCircuitOpen);
    }

    OperationOutcome {
        outcome_id: stable_outcome_id(action),
        status: OperationOutcomeStatus::ObserverDegraded,
        summary: None,
        observed_at_ms: candidate.transition.occurred_at_ms,
        latency_ms: candidate
            .transition
            .occurred_at_ms
            .saturating_sub(action.occurred_at_ms),
        primary_transition_id: None,
        candidate_transition_ids: vec![candidate.transition.transition_id.clone()],
        reason_codes,
        confidence: outcome_confidence(candidate),
    }
}

fn transition_strength(transition: &StateTransition) -> f64 {
    match transition.kind {
        StateTransitionKind::Property => 0.95,
        StateTransitionKind::Lifecycle => 0.90,
        StateTransitionKind::Structure => 0.55,
        StateTransitionKind::ObserverHealth => 0.80,
        StateTransitionKind::Artifact => 0.45,
        StateTransitionKind::Other(_) => 0.35,
    }
}

fn semantic_compatibility(action: &OperationAction, transition: &StateTransition) -> f64 {
    let property = transition.property.as_deref();
    match (&action.kind, transition.kind.clone(), property) {
        (OperationActionKind::Toggle, StateTransitionKind::Property, Some("toggleState")) => 25.0,
        (OperationActionKind::Select, StateTransitionKind::Property, Some("selectionState")) => {
            25.0
        }
        (
            OperationActionKind::Expand | OperationActionKind::Collapse,
            StateTransitionKind::Property,
            Some("expandCollapseState"),
        ) => 25.0,
        (OperationActionKind::TypeSummary, StateTransitionKind::Property, Some("valueLength")) => {
            25.0
        }
        (
            OperationActionKind::Click
            | OperationActionKind::DoubleClick
            | OperationActionKind::RightClick
            | OperationActionKind::Shortcut,
            StateTransitionKind::Lifecycle,
            Some("popup" | "dialog" | "window"),
        ) => 25.0,
        (OperationActionKind::Scroll, StateTransitionKind::Structure, _) => 15.0,
        (_, StateTransitionKind::ObserverHealth, _) => 20.0,
        (_, StateTransitionKind::Structure, _) => 8.0,
        _ => 0.0,
    }
}

fn is_focus_context_only_transition(
    action: &OperationAction,
    transition: &StateTransition,
) -> bool {
    transition.property.as_deref() == Some("hasKeyboardFocus")
        && action.kind != OperationActionKind::WindowSwitch
}

fn append_observer_recovery_reasons(
    reason_codes: &mut Vec<OperationReasonCode>,
    candidates: &[OutcomeCandidate<'_>],
) {
    for candidate in candidates {
        if candidate
            .transition
            .reason_codes
            .contains(&OperationReasonCode::ObserverRestarted)
        {
            push_unique(reason_codes, OperationReasonCode::ObserverRestarted);
        }
    }
}

fn identity_confidence(
    action_target: Option<&UiElementIdentity>,
    transition_element: Option<&UiElementIdentity>,
) -> Option<f64> {
    let action_target = action_target?;
    let transition_element = transition_element?;

    if runtime_id_matches(action_target, transition_element) {
        return Some(0.96);
    }
    if state_cache_key(action_target)
        .zip(state_cache_key(transition_element))
        .map(|(left, right)| left == right)
        .unwrap_or(false)
    {
        return Some(0.88);
    }
    if same_window(action_target, transition_element) {
        return Some(0.65);
    }
    if action_target.process_id.is_some()
        && transition_element.process_id.is_some()
        && action_target.process_id == transition_element.process_id
    {
        return Some(0.50);
    }
    None
}

fn runtime_id_matches(left: &UiElementIdentity, right: &UiElementIdentity) -> bool {
    match (
        left.runtime_id.as_ref().filter(|value| !value.is_empty()),
        right.runtime_id.as_ref().filter(|value| !value.is_empty()),
    ) {
        (Some(left_runtime_id), Some(right_runtime_id)) => {
            left.process_id == right.process_id && left_runtime_id == right_runtime_id
        }
        _ => false,
    }
}

fn same_window(left: &UiElementIdentity, right: &UiElementIdentity) -> bool {
    match (left.window_hwnd.as_deref(), right.window_hwnd.as_deref()) {
        (Some(left_hwnd), Some(right_hwnd)) => left_hwnd.eq_ignore_ascii_case(right_hwnd),
        _ => false,
    }
}

fn is_weak_candidate(
    candidate: &OutcomeCandidate<'_>,
    options: &OutcomeCorrelationOptions,
) -> bool {
    candidate.transition.kind == StateTransitionKind::Structure
        || candidate.score < options.confirmed_score_threshold
}

fn is_observer_degraded_candidate(transition: &StateTransition) -> bool {
    transition.kind == StateTransitionKind::ObserverHealth
        && transition.reason_codes.iter().any(|reason| {
            matches!(
                reason,
                OperationReasonCode::UiaCircuitOpen
                    | OperationReasonCode::UiaTimeout
                    | OperationReasonCode::QueueOverflow
                    | OperationReasonCode::TargetProcessMismatch
            )
        })
}

fn outcome_confidence(candidate: &OutcomeCandidate<'_>) -> OperationOutcomeConfidence {
    OperationOutcomeConfidence {
        temporal: Some(round_confidence(candidate.temporal_confidence)),
        identity: candidate.identity_confidence.map(round_confidence),
        transition: Some(round_confidence(candidate.transition_confidence)),
        evidence: Some(round_confidence(candidate.score / 100.0)),
        overall: Some(round_confidence(candidate.score / 100.0)),
    }
}

fn stable_outcome_id(action: &OperationAction) -> String {
    let suffix = action
        .action_id
        .strip_prefix("action-")
        .unwrap_or(action.action_id.as_str());
    format!("outcome-{suffix}")
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
        OperationActionConfidence, OperationCoordinate, PrivacyClass, StateTransitionConfidence,
        UiElementIdentity,
    };

    fn target(runtime_id: &[i32]) -> UiElementIdentity {
        UiElementIdentity {
            runtime_id: Some(runtime_id.to_vec()),
            process_id: Some(42),
            window_hwnd: Some("0x100".to_string()),
            name: Some("Target".to_string()),
            ..UiElementIdentity::default()
        }
    }

    fn action(id: &str, kind: OperationActionKind, at: u64) -> OperationAction {
        OperationAction {
            action_id: id.to_string(),
            kind,
            occurred_at_ms: at,
            ended_at_ms: Some(at),
            target: Some(target(&[1, 1])),
            state_before: None,
            coordinate: Some(OperationCoordinate {
                x: 10,
                y: 20,
                display_id: None,
            }),
            source_event_ids: vec![id.trim_start_matches("action-").to_string()],
            target_reason_codes: Vec::new(),
            confidence: OperationActionConfidence::default(),
            content_preview: None,
        }
    }

    fn transition(
        id: &str,
        kind: StateTransitionKind,
        at: u64,
        property: &str,
        element: Option<UiElementIdentity>,
        reason_codes: Vec<OperationReasonCode>,
    ) -> StateTransition {
        StateTransition {
            transition_id: id.to_string(),
            kind,
            occurred_at_ms: at,
            element,
            property: Some(property.to_string()),
            before: None,
            after: None,
            privacy_class: PrivacyClass::NotSensitive,
            source_event_ids: vec![id.trim_start_matches("transition-").to_string()],
            reason_codes,
            confidence: StateTransitionConfidence::default(),
        }
    }

    #[test]
    fn outcome_correlator_confirms_stateful_action_on_same_element() {
        let action = action("action-toggle", OperationActionKind::Toggle, 1_000);
        let transitions = vec![transition(
            "transition-toggle",
            StateTransitionKind::Property,
            1_080,
            "toggleState",
            Some(target(&[1, 1])),
            vec![OperationReasonCode::ToggleStateChanged],
        )];

        let outcome = correlate_outcome_for_action(
            &action,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(
            outcome.primary_transition_id.as_deref(),
            Some("transition-toggle")
        );
        assert_eq!(outcome.latency_ms, 80);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::ToggleStateChanged)
        );
    }

    #[test]
    fn outcome_correlator_confirms_popup_and_marks_dialog_negative_signal() {
        let click = action("action-submit", OperationActionKind::Click, 2_000);
        let popup = transition(
            "transition-popup",
            StateTransitionKind::Lifecycle,
            2_120,
            "popup",
            None,
            vec![OperationReasonCode::PopupAppeared],
        );
        let dialog = transition(
            "transition-dialog",
            StateTransitionKind::Lifecycle,
            2_100,
            "dialog",
            None,
            vec![OperationReasonCode::DialogAppeared],
        );

        let popup_outcome = correlate_outcome_for_action(
            &click,
            &[popup],
            None,
            &OutcomeCorrelationOptions::default(),
        );
        let dialog_outcome = correlate_outcome_for_action(
            &click,
            &[dialog],
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(popup_outcome.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(dialog_outcome.status, OperationOutcomeStatus::Confirmed);
        assert!(
            dialog_outcome
                .reason_codes
                .contains(&OperationReasonCode::NegativeCompletionSignal)
        );
    }

    #[test]
    fn outcome_correlator_keeps_structure_as_weak_candidate() {
        let scroll = action("action-scroll", OperationActionKind::Scroll, 3_000);
        let transitions = vec![transition(
            "transition-grid",
            StateTransitionKind::Structure,
            3_480,
            "structure",
            Some(target(&[9, 9])),
            vec![OperationReasonCode::StructureChanged],
        )];

        let outcome = correlate_outcome_for_action(
            &scroll,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::Candidate);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::WeakCompletionSignal)
        );
    }

    #[test]
    fn outcome_correlator_closes_window_at_next_input_or_timeout() {
        let first = action("action-first", OperationActionKind::Click, 4_000);
        let timeout = action("action-timeout", OperationActionKind::Click, 10_000);

        let closed_by_next = correlate_outcome_for_action(
            &first,
            &[],
            Some(4_200),
            &OutcomeCorrelationOptions::default(),
        );
        let timed_out = correlate_outcome_for_action(
            &timeout,
            &[],
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(closed_by_next.status, OperationOutcomeStatus::Incomplete);
        assert_eq!(closed_by_next.observed_at_ms, 4_200);
        assert!(
            closed_by_next
                .reason_codes
                .contains(&OperationReasonCode::NextInputClosedWindow)
        );
        assert_eq!(timed_out.observed_at_ms, 13_000);
        assert!(
            timed_out
                .reason_codes
                .contains(&OperationReasonCode::ResultTimeout)
        );
    }

    #[test]
    fn outcome_correlator_marks_close_scored_candidates_ambiguous() {
        let click = action("action-rapid", OperationActionKind::Click, 5_000);
        let transitions = vec![
            transition(
                "transition-a",
                StateTransitionKind::Lifecycle,
                5_280,
                "popup",
                None,
                vec![OperationReasonCode::PopupAppeared],
            ),
            transition(
                "transition-b",
                StateTransitionKind::Lifecycle,
                5_290,
                "popup",
                None,
                vec![OperationReasonCode::PopupAppeared],
            ),
        ];

        let outcome = correlate_outcome_for_action(
            &click,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::Ambiguous);
        assert_eq!(outcome.observed_at_ms, 5_290);
        assert_eq!(outcome.candidate_transition_ids.len(), 2);
        assert_eq!(
            outcome.reason_codes,
            vec![OperationReasonCode::MultipleCandidates]
        );
    }

    #[test]
    fn outcome_correlator_reports_observer_degraded() {
        let click = action("action-weak", OperationActionKind::Click, 6_000);
        let transitions = vec![transition(
            "transition-health",
            StateTransitionKind::ObserverHealth,
            6_080,
            "observerHealth",
            None,
            vec![
                OperationReasonCode::UiaCircuitOpen,
                OperationReasonCode::QueueOverflow,
            ],
        )];

        let outcome = correlate_outcome_for_action(
            &click,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::ObserverDegraded);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::UiaCircuitOpen)
        );
    }

    #[test]
    fn outcome_correlator_does_not_use_action_target_name_as_completion_fact() {
        let mut click = action("action-save", OperationActionKind::Click, 6_500);
        click.target = Some(UiElementIdentity {
            runtime_id: Some(vec![8, 8]),
            process_id: Some(42),
            name: Some("Saved successfully".to_string()),
            ..UiElementIdentity::default()
        });

        let outcome =
            correlate_outcome_for_action(&click, &[], None, &OutcomeCorrelationOptions::default());

        assert_eq!(outcome.status, OperationOutcomeStatus::Incomplete);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::NoObservableChange)
        );
    }

    #[test]
    fn outcome_correlator_marks_missing_observer_facts_as_degraded() {
        let click = action("action-no-observer", OperationActionKind::Click, 6_800);
        let mut options = OutcomeCorrelationOptions::default();
        options.observer_facts_present = false;

        let outcome = correlate_outcome_for_action(&click, &[], None, &options);

        assert_eq!(outcome.status, OperationOutcomeStatus::ObserverDegraded);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::UiaDisabled)
        );
    }

    #[test]
    fn outcome_correlator_includes_exact_3000ms_boundary_only() {
        let click = action("action-boundary", OperationActionKind::Click, 7_000);
        let inside = transition(
            "transition-inside",
            StateTransitionKind::Lifecycle,
            10_000,
            "popup",
            None,
            vec![OperationReasonCode::PopupAppeared],
        );
        let outside = transition(
            "transition-outside",
            StateTransitionKind::Lifecycle,
            10_001,
            "popup",
            None,
            vec![OperationReasonCode::PopupAppeared],
        );

        let included = correlate_outcome_for_action(
            &click,
            &[inside],
            None,
            &OutcomeCorrelationOptions::default(),
        );
        let excluded = correlate_outcome_for_action(
            &click,
            &[outside],
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(included.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(included.observed_at_ms, 10_000);
        assert_eq!(excluded.status, OperationOutcomeStatus::Incomplete);
    }

    #[test]
    fn outcome_correlator_treats_focus_change_as_target_context_not_completion() {
        let click = action("action-focus-only", OperationActionKind::Click, 8_000);
        let transitions = vec![transition(
            "transition-focus",
            StateTransitionKind::Property,
            8_080,
            "hasKeyboardFocus",
            Some(target(&[1, 1])),
            vec![OperationReasonCode::FocusChanged],
        )];

        let outcome = correlate_outcome_for_action(
            &click,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::Incomplete);
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::NoObservableChange)
        );
    }

    #[test]
    fn outcome_correlator_keeps_observer_restarted_as_secondary_reason() {
        let click = action("action-recovered", OperationActionKind::Click, 9_000);
        let transitions = vec![
            transition(
                "transition-restart",
                StateTransitionKind::ObserverHealth,
                9_005,
                "observerHealth",
                None,
                vec![OperationReasonCode::ObserverRestarted],
            ),
            transition(
                "transition-popup",
                StateTransitionKind::Lifecycle,
                9_300,
                "popup",
                None,
                vec![OperationReasonCode::PopupAppeared],
            ),
        ];

        let outcome = correlate_outcome_for_action(
            &click,
            &transitions,
            None,
            &OutcomeCorrelationOptions::default(),
        );

        assert_eq!(outcome.status, OperationOutcomeStatus::Confirmed);
        assert_eq!(
            outcome.primary_transition_id.as_deref(),
            Some("transition-popup")
        );
        assert!(
            outcome
                .reason_codes
                .contains(&OperationReasonCode::ObserverRestarted)
        );
    }
}
