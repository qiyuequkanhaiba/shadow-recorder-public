use serde_json::Value;

use super::operation_models::{
    OperationAction, OperationActionKind, OperationOutcome, OperationOutcomeStatus,
    StateTransition, TestSessionOperationRecord, UiElementIdentity,
};

pub const OPERATION_BUILDER_VERSION: &str = "operation-builder-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationSummaryParts {
    pub title: String,
    pub result_summary: String,
    pub display_summary: String,
    pub precision_level: String,
}

#[allow(dead_code)]
pub fn summarize_operation(
    action: &OperationAction,
    outcome: &OperationOutcome,
    transitions: &[StateTransition],
) -> OperationSummaryParts {
    let title = summarize_action(action);
    let result_summary = summarize_outcome(outcome, transitions);
    let display_summary = format!("{title} -> {result_summary}，耗时 {}ms", outcome.latency_ms);
    let precision_level = precision_level(action, outcome).to_string();

    OperationSummaryParts {
        title,
        result_summary,
        display_summary,
        precision_level,
    }
}

pub fn summarize_action(action: &OperationAction) -> String {
    let target = action.target.as_ref().and_then(element_label);
    let content = action
        .content_preview
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| content_from_state(action));
    match action.kind {
        OperationActionKind::Click => with_target("单击", target),
        OperationActionKind::DoubleClick => with_target("双击", target),
        OperationActionKind::RightClick => with_target("右键单击", target),
        OperationActionKind::Toggle => with_target("切换", target),
        OperationActionKind::Select => match content {
            Some(content) => match target {
                Some(target) => format!("在{target}选择「{content}」"),
                None => format!("选择「{content}」"),
            },
            None => with_target("选择", target),
        },
        OperationActionKind::Expand => with_target("展开", target),
        OperationActionKind::Collapse => with_target("折叠", target),
        OperationActionKind::TypeSummary => match content {
            Some(content) => match target {
                Some(target) => format!("在{target}输入「{content}」"),
                None => format!("输入「{content}」"),
            },
            None => with_target("输入文本到", target),
        },
        OperationActionKind::Shortcut => "使用快捷键".to_string(),
        OperationActionKind::Scroll => with_target("滚动", target),
        OperationActionKind::WindowSwitch => with_target("切换到", target),
        OperationActionKind::ManualMark => "人工标记".to_string(),
        OperationActionKind::Other(ref value) => format!("执行操作 {value}"),
    }
}

fn content_from_state(action: &OperationAction) -> Option<&str> {
    let state = action.state_before.as_ref()?;
    if let Some(text) = state
        .value_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text);
    }
    state
        .selected_names
        .as_ref()
        .and_then(|names| names.first())
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn summarize_outcome(outcome: &OperationOutcome, transitions: &[StateTransition]) -> String {
    match outcome.status {
        OperationOutcomeStatus::Confirmed => outcome
            .primary_transition_id
            .as_deref()
            .and_then(|id| find_transition(transitions, id))
            .map(summarize_transition)
            .unwrap_or_else(|| "结果已确认".to_string()),
        OperationOutcomeStatus::Candidate => first_candidate_transition(outcome, transitions)
            .map(|transition| format!("观测到可能相关变化：{}", summarize_transition(transition)))
            .unwrap_or_else(|| "观测到可能相关变化".to_string()),
        OperationOutcomeStatus::Ambiguous => "观测到多个可能结果，需人工确认".to_string(),
        OperationOutcomeStatus::Incomplete => "未观测到明确结果".to_string(),
        OperationOutcomeStatus::ObserverDegraded => "UIA 观测降级，无法判断结果".to_string(),
        OperationOutcomeStatus::LegacyUnknown => "旧记录未包含结果事实".to_string(),
        OperationOutcomeStatus::Other(ref value) => format!("结果状态 {value}"),
    }
}

fn summarize_transition(transition: &StateTransition) -> String {
    match transition.property.as_deref() {
        Some("popup") => appeared_summary("弹窗", transition),
        Some("dialog") => appeared_summary("对话框", transition),
        Some("window") => window_summary(transition),
        Some("structure") => "界面结构发生变化".to_string(),
        Some("valueLength") | Some("value") => value_change_summary(transition),
        Some("toggleState") => property_after_summary("开关状态变为", transition),
        Some("selectionState") => selection_change_summary(transition),
        Some("expandCollapseState") => property_after_summary("展开状态变为", transition),
        Some("rangeValue") => property_after_summary("数值变为", transition),
        Some("isEnabled") => property_after_summary("可用状态变为", transition),
        Some("hasKeyboardFocus") => "焦点发生变化".to_string(),
        Some("observerHealth") => "观测器状态变化".to_string(),
        Some(property) => format!("{property} 发生变化"),
        None => "状态发生变化".to_string(),
    }
}

fn value_change_summary(transition: &StateTransition) -> String {
    match transition.after.as_ref() {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            format!("内容变为「{}」", text.trim())
        }
        Some(Value::Number(number)) => format!("文本长度变为「{number}」"),
        _ => property_after_summary("文本长度变为", transition),
    }
}

fn selection_change_summary(transition: &StateTransition) -> String {
    match transition.after.as_ref() {
        Some(Value::String(text))
            if !matches!(
                text.as_str(),
                "selected" | "notSelected" | "mixed" | "unknown" | "on" | "off"
            ) && !text.trim().is_empty() =>
        {
            format!("选中「{}」", text.trim())
        }
        Some(Value::Array(items)) => {
            let names = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join("、");
            if names.is_empty() {
                property_after_summary("选择状态变为", transition)
            } else {
                format!("选中「{names}」")
            }
        }
        _ => property_after_summary("选择状态变为", transition),
    }
}

/// Plain-text repro lines: action -> honest result -> latency.
/// Never rewrites incomplete/degraded/ambiguous into success wording.
pub fn render_repro_operations_text(
    session_id: &str,
    marked_at_ms: Option<u64>,
    window_start_ms: Option<u64>,
    window_end_ms: Option<u64>,
    defect_note: Option<&str>,
    operations: &[TestSessionOperationRecord],
) -> String {
    let mut lines = Vec::new();
    lines.push(format!("会话: {session_id}"));
    if let Some(marked_at_ms) = marked_at_ms {
        lines.push(format!("缺陷标记时间: {marked_at_ms}"));
    }
    if let (Some(start), Some(end)) = (window_start_ms, window_end_ms) {
        lines.push(format!("时间窗: {start} ~ {end}"));
    }
    if let Some(note) = defect_note.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("缺陷说明: {note}"));
    }
    lines.push(String::new());
    lines.push("复现步骤:".to_string());

    let visible = operations
        .iter()
        .filter(|operation| !operation.ignored)
        .collect::<Vec<_>>();
    if visible.is_empty() {
        lines.push("1. （时间窗内未聚合到可复现操作，请结合视频与截图确认）".to_string());
    } else {
        for (index, operation) in visible.iter().enumerate() {
            let result = honest_result_line(operation);
            lines.push(format!(
                "{}. {} -> {}，耗时 {}ms",
                index + 1,
                operation.title,
                result,
                operation.outcome.latency_ms
            ));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn honest_result_line(operation: &TestSessionOperationRecord) -> String {
    match operation.outcome.status {
        OperationOutcomeStatus::Confirmed | OperationOutcomeStatus::Candidate => {
            if operation.result_summary.trim().is_empty() {
                summarize_outcome(&operation.outcome, &operation.transitions)
            } else {
                operation.result_summary.clone()
            }
        }
        OperationOutcomeStatus::Ambiguous => "观测到多个可能结果，需人工确认".to_string(),
        OperationOutcomeStatus::Incomplete => "未观测到明确结果".to_string(),
        OperationOutcomeStatus::ObserverDegraded => "UIA 观测降级，无法判断结果".to_string(),
        OperationOutcomeStatus::LegacyUnknown => "旧记录未采集操作结果".to_string(),
        OperationOutcomeStatus::Other(ref value) => format!("结果状态 {value}"),
    }
}

fn appeared_summary(kind: &str, transition: &StateTransition) -> String {
    if let Some(label) = transition.element.as_ref().and_then(element_name) {
        format!("{kind}“{label}”出现")
    } else {
        format!("{kind}出现")
    }
}

fn window_summary(transition: &StateTransition) -> String {
    let label = transition.element.as_ref().and_then(element_name);
    let visible = transition
        .after
        .as_ref()
        .and_then(|value| value.get("visible"))
        .and_then(Value::as_bool);
    let verb = match visible {
        Some(true) => "打开",
        Some(false) => "关闭",
        None => "变化",
    };
    match label {
        Some(label) => format!("窗口“{label}”{verb}"),
        None => format!("窗口{verb}"),
    }
}

fn property_after_summary(prefix: &str, transition: &StateTransition) -> String {
    transition
        .after
        .as_ref()
        .map(format_value)
        .map(|value| format!("{prefix}“{value}”"))
        .unwrap_or_else(|| format!("{prefix}未知值"))
}

fn with_target(verb: &str, target: Option<String>) -> String {
    match target {
        Some(target) => format!("{verb}{target}"),
        None => format!("{verb}目标"),
    }
}

fn element_label(element: &UiElementIdentity) -> Option<String> {
    let name = element_name(element);
    let control_type = element
        .localized_control_type
        .as_deref()
        .or(element.control_type.as_deref())
        .map(localized_control_type)
        .filter(|value| !value.is_empty());
    match (control_type, name) {
        (Some(control_type), Some(name)) => Some(format!("{control_type}“{name}”")),
        (None, Some(name)) => Some(format!("“{name}”")),
        (Some(control_type), None) => Some(control_type.to_string()),
        (None, None) => None,
    }
}

fn element_name(element: &UiElementIdentity) -> Option<String> {
    element
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn localized_control_type(control_type: &str) -> &str {
    match control_type {
        "Button" => "按钮",
        "CheckBox" => "复选框",
        "ComboBox" => "下拉框",
        "Edit" => "输入框",
        "ListItem" => "列表项",
        "MenuItem" => "菜单项",
        "TreeItem" => "树节点",
        "Window" => "窗口",
        "Text" => "文本",
        other => other,
    }
}

fn find_transition<'a>(
    transitions: &'a [StateTransition],
    transition_id: &str,
) -> Option<&'a StateTransition> {
    transitions
        .iter()
        .find(|transition| transition.transition_id == transition_id)
}

fn first_candidate_transition<'a>(
    outcome: &OperationOutcome,
    transitions: &'a [StateTransition],
) -> Option<&'a StateTransition> {
    outcome
        .candidate_transition_ids
        .iter()
        .find_map(|transition_id| find_transition(transitions, transition_id))
}

fn format_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => "已变化".to_string(),
    }
}

fn precision_level(action: &OperationAction, outcome: &OperationOutcome) -> &'static str {
    if action.target.is_some() && outcome.status == OperationOutcomeStatus::Confirmed {
        "l3"
    } else if action.target.is_some() {
        "l2"
    } else if action.coordinate.is_some() {
        "l1"
    } else {
        "l0"
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::operation_models::{
        OperationActionConfidence, OperationCoordinate, OperationOutcomeConfidence,
        OperationOutcomeSelectionSource, OperationReasonCode, PrivacyClass,
        StateTransitionConfidence, StateTransitionKind,
    };

    fn action(kind: OperationActionKind) -> OperationAction {
        OperationAction {
            action_id: "action-save".to_string(),
            kind,
            occurred_at_ms: 1_000,
            ended_at_ms: Some(1_000),
            target: Some(UiElementIdentity {
                runtime_id: Some(vec![1]),
                process_id: Some(42),
                name: Some("Save".to_string()),
                control_type: Some("Button".to_string()),
                ..UiElementIdentity::default()
            }),
            state_before: None,
            coordinate: Some(OperationCoordinate {
                x: 100,
                y: 200,
                display_id: None,
            }),
            source_event_ids: vec!["input-save".to_string()],
            target_reason_codes: Vec::new(),
            confidence: OperationActionConfidence::default(),
            content_preview: None,
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

    fn transition(property: &str) -> StateTransition {
        StateTransition {
            transition_id: "transition-toast".to_string(),
            kind: if property == "structure" {
                StateTransitionKind::Structure
            } else {
                StateTransitionKind::Lifecycle
            },
            occurred_at_ms: 1_420,
            element: Some(UiElementIdentity {
                name: Some("Saved".to_string()),
                control_type: Some("Text".to_string()),
                ..UiElementIdentity::default()
            }),
            property: Some(property.to_string()),
            before: Some(json!({ "visible": false })),
            after: Some(json!({ "visible": true })),
            privacy_class: PrivacyClass::NotSensitive,
            source_event_ids: vec!["sem-toast".to_string()],
            reason_codes: vec![OperationReasonCode::PopupAppeared],
            confidence: StateTransitionConfidence::default(),
        }
    }

    #[test]
    fn operation_summary_builds_confirmed_action_result_sentence() {
        let action = action(OperationActionKind::Click);
        let outcome = outcome(OperationOutcomeStatus::Confirmed);
        let transition = transition("popup");

        let summary = summarize_operation(&action, &outcome, &[transition]);

        assert_eq!(summary.title, "单击按钮“Save”");
        assert_eq!(summary.result_summary, "弹窗“Saved”出现");
        assert!(summary.display_summary.contains("耗时 420ms"));
        assert_eq!(summary.precision_level, "l3");
    }

    #[test]
    fn operation_summary_uses_honest_status_language() {
        let action = action(OperationActionKind::Click);
        let transitions = vec![transition("popup")];
        let statuses = [
            (OperationOutcomeStatus::Candidate, "观测到可能相关变化"),
            (OperationOutcomeStatus::Ambiguous, "需人工确认"),
            (OperationOutcomeStatus::Incomplete, "未观测到明确结果"),
            (OperationOutcomeStatus::ObserverDegraded, "观测降级"),
            (OperationOutcomeStatus::LegacyUnknown, "旧记录"),
        ];

        for (status, expected) in statuses {
            let mut outcome = outcome(status);
            if outcome.status != OperationOutcomeStatus::Candidate {
                outcome.primary_transition_id = None;
            }
            let summary = summarize_operation(&action, &outcome, &transitions);
            assert!(summary.result_summary.contains(expected), "{expected}");
        }
    }

    #[test]
    fn operation_summary_does_not_surface_coordinates_by_default() {
        let action = action(OperationActionKind::Click);
        let outcome = outcome(OperationOutcomeStatus::Confirmed);
        let transition = transition("popup");

        let summary = summarize_operation(&action, &outcome, &[transition]);

        assert!(!summary.title.contains("100"));
        assert!(!summary.display_summary.contains("200"));
    }

    #[test]
    fn render_repro_operations_keeps_honest_incomplete_language() {
        let mut incomplete_outcome = outcome(OperationOutcomeStatus::Incomplete);
        incomplete_outcome.primary_transition_id = None;
        incomplete_outcome.latency_ms = 3000;
        incomplete_outcome.summary = Some("未观测到明确结果".to_string());

        let record = TestSessionOperationRecord {
            schema_version: 1,
            kind: "reqcase.test-session-operation".to_string(),
            operation_id: "op-1".to_string(),
            session_id: "ts-1".to_string(),
            sequence: 1,
            started_at_ms: 100,
            ended_at_ms: 200,
            relative_ms_from_session_start: 100,
            action: action(OperationActionKind::Click),
            outcome: incomplete_outcome,
            completion_candidates: vec![],
            transitions: vec![],
            evidence: vec![],
            title: "单击按钮“提交”".to_string(),
            result_summary: "未观测到明确结果".to_string(),
            display_summary: "单击按钮“提交” -> 未观测到明确结果，耗时 420ms".to_string(),
            precision_level: "l2".to_string(),
            outcome_selection_source: OperationOutcomeSelectionSource::Auto,
            edited: false,
            ignored: false,
            business_alias: None,
            manual_note: None,
        };

        let text = render_repro_operations_text(
            "ts-1",
            Some(5000),
            Some(0),
            Some(6000),
            Some("提交无反馈"),
            &[record],
        );

        assert!(text.contains("单击按钮“提交” -> 未观测到明确结果"));
        assert!(!text.contains("提交成功"));
        assert!(text.contains("耗时 3000ms"));
        assert!(text.contains("提交无反馈"));
    }
}
