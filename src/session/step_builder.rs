//! Offline aggregation: timeline events → semantic StepRecords.

use crate::session::models::{
    TEST_SESSION_SCHEMA_VERSION, TestSessionEventRecord, TestSessionEventType,
    TestSessionStepRecord, normalize_optional_string,
};
use crate::session::operation_models::{
    OperationAction, OperationActionKind, TestSessionOperationRecord, UiElementIdentity,
};
use crate::session::semantic_alias::{SemanticAliasProfile, apply_aliases_to_steps};
use crate::session::uia_enricher::UiaSnapshot;

const CLICK_MERGE_WINDOW_MS: u64 = 120;
const FOREGROUND_DEBOUNCE_MS: u64 = 400;
const TYPE_MERGE_WINDOW_MS: u64 = 2_500;
const PASTE_ASSOCIATION_WINDOW_MS: u64 = 2_000;

#[allow(dead_code)]
pub fn build_steps_from_events(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
) -> Vec<TestSessionStepRecord> {
    build_steps_from_events_with_aliases(session_id, session_started_at_ms, events, None)
}

pub fn build_steps_from_events_with_aliases(
    session_id: &str,
    session_started_at_ms: u64,
    events: &[TestSessionEventRecord],
    alias_profile: Option<&SemanticAliasProfile>,
) -> Vec<TestSessionStepRecord> {
    let mut ordered = events.to_vec();
    ordered.sort_by_key(|event| (event.occurred_at_ms, event.event_id.clone()));

    let mut steps = Vec::new();
    let mut index = 0usize;
    while index < ordered.len() {
        let event = &ordered[index];
        match event.event_type {
            TestSessionEventType::StepCaptured => {
                let (merged, consumed) = merge_click_cluster(&ordered, index);
                if let Some(step) =
                    build_click_step(session_id, session_started_at_ms, &merged, steps.len() + 1)
                {
                    steps.push(step);
                }
                index += consumed.max(1);
            }
            TestSessionEventType::WindowForegroundChanged => {
                if should_emit_foreground(&ordered, index)
                    && let Some(step) = build_foreground_step(
                        session_id,
                        session_started_at_ms,
                        event,
                        steps.len() + 1,
                    )
                {
                    steps.push(step);
                }
                index += 1;
            }
            TestSessionEventType::KeyboardSummary => {
                let (merged, consumed) = merge_type_cluster(&ordered, index);
                if let Some(step) = build_keyboard_step(
                    session_id,
                    session_started_at_ms,
                    &merged,
                    &ordered,
                    index,
                    steps.len() + 1,
                ) {
                    steps.push(step);
                }
                index += consumed.max(1);
            }
            TestSessionEventType::ClipboardUpdated => {
                // Clipboard alone is noise unless later associated with paste shortcut/step.
                // Still emit a light step only if no nearby paste will consume it.
                if !has_nearby_paste(&ordered, index)
                    && let Some(step) = build_clipboard_step(
                        session_id,
                        session_started_at_ms,
                        event,
                        steps.len() + 1,
                    )
                {
                    steps.push(step);
                }
                index += 1;
            }
            TestSessionEventType::DefectMarked | TestSessionEventType::NoteAdded => {
                if let Some(step) =
                    build_note_like_step(session_id, session_started_at_ms, event, steps.len() + 1)
                {
                    steps.push(step);
                }
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }

    apply_aliases_to_steps(&mut steps, alias_profile);
    steps
}

#[allow(dead_code)]
pub fn build_steps_from_operations(
    session_id: &str,
    session_started_at_ms: u64,
    operations: &[TestSessionOperationRecord],
) -> Vec<TestSessionStepRecord> {
    build_steps_from_operations_with_aliases(session_id, session_started_at_ms, operations, None)
}

pub fn build_steps_from_operations_with_aliases(
    session_id: &str,
    session_started_at_ms: u64,
    operations: &[TestSessionOperationRecord],
    alias_profile: Option<&SemanticAliasProfile>,
) -> Vec<TestSessionStepRecord> {
    let mut steps = operations
        .iter()
        .filter(|operation| !operation.ignored)
        .map(|operation| project_operation_to_step(session_id, session_started_at_ms, operation))
        .collect::<Vec<_>>();
    apply_aliases_to_steps(&mut steps, alias_profile);
    steps
}

#[allow(dead_code)]
pub fn filter_steps_in_window(
    steps: &[TestSessionStepRecord],
    window_start_ms: u64,
    window_end_ms: u64,
) -> Vec<TestSessionStepRecord> {
    steps
        .iter()
        .filter(|step| step.started_at_ms >= window_start_ms && step.started_at_ms <= window_end_ms)
        .cloned()
        .collect()
}

fn project_operation_to_step(
    session_id: &str,
    session_started_at_ms: u64,
    operation: &TestSessionOperationRecord,
) -> TestSessionStepRecord {
    let target = operation.action.target.as_ref();
    let coordinate = operation.action.coordinate.as_ref();
    TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{}", operation.operation_id),
        session_id: session_id.to_string(),
        started_at_ms: operation.started_at_ms,
        ended_at_ms: operation.ended_at_ms,
        relative_ms_from_session_start: operation
            .started_at_ms
            .saturating_sub(session_started_at_ms),
        step_type: projected_step_type(&operation.action).to_string(),
        title: operation.title.clone(),
        summary: operation.display_summary.clone(),
        process_name: None,
        window_title: projected_window_title(target),
        control_name: target.and_then(|target| target.name.clone()),
        control_type: target.and_then(|target| target.control_type.clone()),
        automation_id: target.and_then(|target| target.automation_id.clone()),
        class_name: target.and_then(|target| target.class_name.clone()),
        x: coordinate.map(|coordinate| coordinate.x),
        y: coordinate.map(|coordinate| coordinate.y),
        display_id: coordinate.and_then(|coordinate| coordinate.display_id.clone()),
        precision_level: operation.precision_level.clone(),
        confidence: projected_confidence(operation),
        source_event_ids: operation.action.source_event_ids.clone(),
        artifact_refs: projected_artifact_refs(operation),
        full_image_path: None,
        thumb_image_path: None,
        edited: operation.edited,
        original_title: None,
        business_alias: operation.business_alias.clone(),
    }
}

fn projected_step_type(action: &OperationAction) -> &'static str {
    match action.kind {
        OperationActionKind::Click => "click",
        OperationActionKind::DoubleClick => "double_click",
        OperationActionKind::RightClick => "right_click",
        OperationActionKind::Toggle => "toggle",
        OperationActionKind::Select => "select",
        OperationActionKind::Expand => "expand",
        OperationActionKind::Collapse => "collapse",
        OperationActionKind::TypeSummary => "type",
        OperationActionKind::Shortcut => "key",
        OperationActionKind::Scroll => "wheel",
        OperationActionKind::WindowSwitch => "window_switch",
        OperationActionKind::ManualMark => "note",
        OperationActionKind::Other(_) => "operation",
    }
}

fn projected_window_title(target: Option<&UiElementIdentity>) -> Option<String> {
    let target = target?;
    target
        .parent_path
        .iter()
        .find(|entry| {
            entry
                .control_type
                .as_deref()
                .map(|value| value.eq_ignore_ascii_case("window"))
                .unwrap_or(false)
        })
        .and_then(|entry| entry.name.clone())
}

fn projected_confidence(operation: &TestSessionOperationRecord) -> f64 {
    operation
        .outcome
        .confidence
        .overall
        .or(operation.action.confidence.overall)
        .unwrap_or(0.30)
        .clamp(0.0, 1.0)
}

fn projected_artifact_refs(operation: &TestSessionOperationRecord) -> Vec<String> {
    let mut refs = operation
        .evidence
        .iter()
        .filter_map(|evidence| evidence.artifact_ref.clone())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}

pub fn render_repro_steps_text(
    session_id: &str,
    marked_at_ms: Option<u64>,
    window_start_ms: Option<u64>,
    window_end_ms: Option<u64>,
    defect_note: Option<&str>,
    steps: &[TestSessionStepRecord],
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
    if steps.is_empty() {
        lines.push("1. （时间窗内未聚合到可复现操作步骤，请结合视频与截图确认）".to_string());
    } else {
        for (index, step) in steps.iter().enumerate() {
            lines.push(format!("{}. {}", index + 1, step.title));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn merge_click_cluster(
    events: &[TestSessionEventRecord],
    start: usize,
) -> (TestSessionEventRecord, usize) {
    let base = events[start].clone();
    let mut best = base.clone();
    let mut consumed = 1usize;

    for event in events.iter().skip(start + 1) {
        if event.event_type != TestSessionEventType::StepCaptured {
            break;
        }
        let delta = event.occurred_at_ms.saturating_sub(base.occurred_at_ms);
        if delta > CLICK_MERGE_WINDOW_MS {
            break;
        }
        let same_point = matches!((base.x, event.x, base.y, event.y), (Some(x1), Some(x2), Some(y1), Some(y2)) if (x1 - x2).abs() <= 2 && (y1 - y2).abs() <= 2)
            || (base.x.is_none() && event.x.is_none());
        if !same_point {
            break;
        }
        // Prefer event with richer UIA identity / double-click action.
        if event_score(event) >= event_score(&best) {
            best = event.clone();
        }
        consumed += 1;
    }

    (best, consumed)
}

fn event_score(event: &TestSessionEventRecord) -> i32 {
    let mut score = 0;
    if event
        .control_name
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 100;
    }
    if event
        .automation_id
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 80;
    }
    if event
        .action
        .as_ref()
        .map(|action| action.contains("DBLCLK") || action.to_ascii_lowercase().contains("double"))
        .unwrap_or(false)
    {
        score += 30;
    }
    score
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

fn build_click_step(
    session_id: &str,
    session_started_at_ms: u64,
    event: &TestSessionEventRecord,
    ordinal: usize,
) -> Option<TestSessionStepRecord> {
    let started_at_ms = event.occurred_at_ms;
    let step_type = classify_click_type(event.action.as_deref());
    let window_title = normalize_optional_string(event.window_title.clone());
    let control_name = normalize_optional_string(event.control_name.clone());
    let control_type = normalize_optional_string(event.control_type.clone());
    let automation_id = normalize_optional_string(event.automation_id.clone());
    let class_name = normalize_optional_string(event.class_name.clone());
    let process_name = normalize_optional_string(event.process_name.clone());

    let snapshot = UiaSnapshot {
        control_name: control_name.clone(),
        automation_id: automation_id.clone(),
        control_type: control_type.clone(),
        class_name: class_name.clone(),
        ..UiaSnapshot::default()
    };
    let precision_level = snapshot
        .precision_level(
            window_title
                .as_ref()
                .map(|value| !value.is_empty())
                .unwrap_or(false),
        )
        .to_string();
    let confidence = match precision_level.as_str() {
        "l2" => 0.86,
        "l1" => 0.55,
        _ => 0.30,
    };

    let title = build_click_title(
        step_type,
        control_name.as_deref(),
        control_type.as_deref(),
        window_title.as_deref(),
        event.x,
        event.y,
    );
    let summary = match window_title.as_deref() {
        Some(window) => format!("在「{window}」中{title}"),
        None => title.clone(),
    };

    let mut artifact_refs = Vec::new();
    if let Some(path) = event.full_image_path.clone() {
        artifact_refs.push(path);
    }
    if let Some(path) = event.thumb_image_path.clone() {
        artifact_refs.push(path);
    }

    Some(TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{session_id}-{ordinal}"),
        session_id: session_id.to_string(),
        started_at_ms,
        ended_at_ms: started_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        step_type: step_type.to_string(),
        title,
        summary,
        process_name,
        window_title,
        control_name,
        control_type,
        automation_id,
        class_name,
        x: event.x,
        y: event.y,
        display_id: event.display_id.clone(),
        precision_level,
        confidence,
        source_event_ids: vec![event.event_id.clone()],
        artifact_refs,
        full_image_path: event.full_image_path.clone(),
        thumb_image_path: event.thumb_image_path.clone(),
        edited: false,
        original_title: None,
        business_alias: None,
    })
}

fn build_foreground_step(
    session_id: &str,
    session_started_at_ms: u64,
    event: &TestSessionEventRecord,
    ordinal: usize,
) -> Option<TestSessionStepRecord> {
    let window_title =
        normalize_optional_string(event.window_title.clone().or_else(|| event.title.clone()))?;
    let started_at_ms = event.occurred_at_ms;
    let title = format!("切换到窗口「{window_title}」");
    Some(TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{session_id}-{ordinal}"),
        session_id: session_id.to_string(),
        started_at_ms,
        ended_at_ms: started_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        step_type: "window_switch".to_string(),
        title: title.clone(),
        summary: title,
        process_name: event.process_name.clone(),
        window_title: Some(window_title),
        control_name: None,
        control_type: None,
        automation_id: None,
        class_name: None,
        x: None,
        y: None,
        display_id: event.display_id.clone(),
        precision_level: "l1".to_string(),
        confidence: 0.70,
        source_event_ids: vec![event.event_id.clone()],
        artifact_refs: Vec::new(),
        full_image_path: None,
        thumb_image_path: None,
        edited: false,
        original_title: None,
        business_alias: None,
    })
}

fn build_note_like_step(
    session_id: &str,
    session_started_at_ms: u64,
    event: &TestSessionEventRecord,
    ordinal: usize,
) -> Option<TestSessionStepRecord> {
    let started_at_ms = event.occurred_at_ms;
    let is_defect = event.event_type == TestSessionEventType::DefectMarked;
    let note = event
        .message
        .clone()
        .or_else(|| event.title.clone())
        .unwrap_or_else(|| {
            if is_defect {
                "已标记缺陷".to_string()
            } else {
                "备注".to_string()
            }
        });
    let title = if is_defect {
        format!("【缺陷】{note}")
    } else {
        format!("备注：{note}")
    };
    Some(TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{session_id}-{ordinal}"),
        session_id: session_id.to_string(),
        started_at_ms,
        ended_at_ms: started_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        step_type: if is_defect {
            "defect_mark".to_string()
        } else {
            "note".to_string()
        },
        title: title.clone(),
        summary: title,
        process_name: event.process_name.clone(),
        window_title: event.window_title.clone(),
        control_name: None,
        control_type: None,
        automation_id: None,
        class_name: None,
        x: None,
        y: None,
        display_id: event.display_id.clone(),
        precision_level: "l1".to_string(),
        confidence: 1.0,
        source_event_ids: vec![event.event_id.clone()],
        artifact_refs: Vec::new(),
        full_image_path: None,
        thumb_image_path: None,
        edited: false,
        original_title: None,
        business_alias: None,
    })
}

fn merge_type_cluster(
    events: &[TestSessionEventRecord],
    start: usize,
) -> (TestSessionEventRecord, usize) {
    let base = events[start].clone();
    let action = base.action.as_deref().unwrap_or("");
    if action != "type" {
        return (base, 1);
    }

    let mut merged = base.clone();
    let mut consumed = 1usize;
    let mut total_chars = base.char_count.unwrap_or(0);
    let mut event_ids = vec![base.event_id.clone()];

    for event in events.iter().skip(start + 1) {
        if event.event_type != TestSessionEventType::KeyboardSummary {
            break;
        }
        if event.action.as_deref() != Some("type") {
            break;
        }
        let delta = event.occurred_at_ms.saturating_sub(merged.occurred_at_ms);
        if delta > TYPE_MERGE_WINDOW_MS {
            break;
        }
        total_chars = total_chars.saturating_add(event.char_count.unwrap_or(0));
        merged.char_count = Some(total_chars);
        if merged.control_name.is_none() {
            merged.control_name = event.control_name.clone();
        }
        if merged.window_title.is_none() {
            merged.window_title = event.window_title.clone();
        }
        if event.is_password == Some(true) {
            merged.is_password = Some(true);
        }
        merged.message = Some(if merged.is_password == Some(true) {
            format!("在密码框输入 {total_chars} 个字符")
        } else if let Some(control) = merged.control_name.as_deref() {
            format!("在「{control}」输入 {total_chars} 个字符")
        } else {
            format!("输入 {total_chars} 个字符")
        });
        event_ids.push(event.event_id.clone());
        consumed += 1;
    }

    merged.event_id = event_ids.join(",");
    (merged, consumed)
}

fn build_keyboard_step(
    session_id: &str,
    session_started_at_ms: u64,
    event: &TestSessionEventRecord,
    ordered: &[TestSessionEventRecord],
    index: usize,
    ordinal: usize,
) -> Option<TestSessionStepRecord> {
    let started_at_ms = event.occurred_at_ms;
    let action = event.action.as_deref().unwrap_or("key");
    let source_event_ids = event
        .event_id
        .split(',')
        .map(|value| value.to_string())
        .collect::<Vec<_>>();

    let (step_type, title, precision_level, confidence) = match action {
        "shortcut" => {
            let label = event
                .shortcut
                .clone()
                .or_else(|| event.title.clone())
                .unwrap_or_else(|| "快捷键".to_string());
            let clean = label.trim().trim_start_matches("快捷键").trim().to_string();
            let title = if is_paste_shortcut(&clean) {
                build_paste_title(event, ordered, index)
            } else {
                format!("使用快捷键 {clean}")
            };
            ("shortcut", title, "l2".to_string(), 0.88)
        }
        "type" => {
            let count = event.char_count.unwrap_or(0).max(1);
            let title = if event.is_password == Some(true) {
                format!("在密码框输入 {count} 个字符")
            } else if let Some(control) = event.control_name.as_deref() {
                format!("在「{control}」输入 {count} 个字符")
            } else if let Some(window) = event.window_title.as_deref() {
                format!("在窗口「{window}」输入 {count} 个字符")
            } else {
                format!("输入 {count} 个字符")
            };
            let precision = if event.control_name.is_some() || event.is_password == Some(true) {
                "l3"
            } else {
                "l1"
            };
            ("type", title, precision.to_string(), 0.80)
        }
        _ => {
            let key = event
                .shortcut
                .clone()
                .or_else(|| event.title.clone())
                .unwrap_or_else(|| "按键".to_string());
            let clean = key.trim().trim_start_matches("按键").trim().to_string();
            ("key", format!("按下 {clean}"), "l1".to_string(), 0.70)
        }
    };

    Some(TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{session_id}-{ordinal}"),
        session_id: session_id.to_string(),
        started_at_ms,
        ended_at_ms: started_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        step_type: step_type.to_string(),
        title: title.clone(),
        summary: title,
        process_name: event.process_name.clone(),
        window_title: event.window_title.clone(),
        control_name: event.control_name.clone(),
        control_type: event.control_type.clone(),
        automation_id: event.automation_id.clone(),
        class_name: event.class_name.clone(),
        x: event.x,
        y: event.y,
        display_id: event.display_id.clone(),
        precision_level,
        confidence,
        source_event_ids,
        artifact_refs: Vec::new(),
        full_image_path: None,
        thumb_image_path: None,
        edited: false,
        original_title: None,
        business_alias: None,
    })
}

fn build_clipboard_step(
    session_id: &str,
    session_started_at_ms: u64,
    event: &TestSessionEventRecord,
    ordinal: usize,
) -> Option<TestSessionStepRecord> {
    let kind = event.clipboard_content_type.as_deref().unwrap_or("unknown");
    let title = format!("剪贴板更新（{kind}）");
    let started_at_ms = event.occurred_at_ms;
    Some(TestSessionStepRecord {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.test-session-step".to_string(),
        step_id: format!("step-{session_id}-{ordinal}"),
        session_id: session_id.to_string(),
        started_at_ms,
        ended_at_ms: started_at_ms,
        relative_ms_from_session_start: started_at_ms.saturating_sub(session_started_at_ms),
        step_type: "clipboard".to_string(),
        title: title.clone(),
        summary: title,
        process_name: event.process_name.clone(),
        window_title: event.window_title.clone(),
        control_name: None,
        control_type: None,
        automation_id: None,
        class_name: None,
        x: None,
        y: None,
        display_id: event.display_id.clone(),
        precision_level: "l1".to_string(),
        confidence: 0.60,
        source_event_ids: vec![event.event_id.clone()],
        artifact_refs: Vec::new(),
        full_image_path: None,
        thumb_image_path: None,
        edited: false,
        original_title: None,
        business_alias: None,
    })
}

fn has_nearby_paste(events: &[TestSessionEventRecord], clipboard_index: usize) -> bool {
    let clip_at = events[clipboard_index].occurred_at_ms;
    events.iter().skip(clipboard_index + 1).any(|event| {
        if event.occurred_at_ms.saturating_sub(clip_at) > PASTE_ASSOCIATION_WINDOW_MS {
            return false;
        }
        if event.event_type == TestSessionEventType::KeyboardSummary
            && let Some(shortcut) = event.shortcut.as_deref()
        {
            return is_paste_shortcut(shortcut);
        }
        false
    })
}

fn is_paste_shortcut(label: &str) -> bool {
    let normalized = label.replace(' ', "").to_ascii_lowercase();
    normalized == "ctrl+v" || normalized.ends_with("+v") && normalized.contains("ctrl")
}

fn build_paste_title(
    event: &TestSessionEventRecord,
    ordered: &[TestSessionEventRecord],
    index: usize,
) -> String {
    let clipboard_type = ordered
        .iter()
        .take(index)
        .rev()
        .find(|item| {
            item.event_type == TestSessionEventType::ClipboardUpdated
                && event.occurred_at_ms.saturating_sub(item.occurred_at_ms)
                    <= PASTE_ASSOCIATION_WINDOW_MS
        })
        .and_then(|item| item.clipboard_content_type.clone())
        .unwrap_or_else(|| "content".to_string());

    let type_label = match clipboard_type.as_str() {
        "text" => "文本",
        "image" => "图片",
        "file_list" => "文件",
        "html" => "HTML",
        _ => "内容",
    };

    if let Some(control) = event.control_name.as_deref() {
        format!("粘贴{type_label}到「{control}」")
    } else if let Some(window) = event.window_title.as_deref() {
        format!("在窗口「{window}」粘贴{type_label}")
    } else {
        format!("粘贴{type_label}")
    }
}

fn classify_click_type(action: Option<&str>) -> &'static str {
    let action = action.unwrap_or("").to_ascii_uppercase();
    if action.contains("DBLCLK") || action.contains("DOUBLE") {
        "double_click"
    } else if action.contains("RBUTTON") || action.contains("RIGHT") {
        "right_click"
    } else if action.contains("MBUTTON") || action.contains("MIDDLE") {
        "middle_click"
    } else if action.contains("WHEEL") {
        "wheel"
    } else {
        "click"
    }
}

fn build_click_title(
    step_type: &str,
    control_name: Option<&str>,
    control_type: Option<&str>,
    window_title: Option<&str>,
    x: Option<i32>,
    y: Option<i32>,
) -> String {
    let verb = match step_type {
        "double_click" => "双击",
        "right_click" => "右键",
        "middle_click" => "中键点击",
        "wheel" => "滚轮",
        _ => "点击",
    };

    if let Some(name) = control_name.filter(|value| !value.is_empty()) {
        if let Some(control_type) = control_type.filter(|value| !value.is_empty()) {
            return format!("{verb}{control_type}「{name}」");
        }
        return format!("{verb}「{name}」");
    }

    if let Some(window) = window_title.filter(|value| !value.is_empty()) {
        if let (Some(x), Some(y)) = (x, y) {
            return format!("在窗口「{window}」{verb} ({x},{y})");
        }
        return format!("在窗口「{window}」{verb}");
    }

    if let (Some(x), Some(y)) = (x, y) {
        return format!("{verb}坐标 ({x},{y})");
    }
    format!("{verb}屏幕")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::models::TestSessionEventRecord;
    use serde_json::json;

    fn step_event(
        id: &str,
        at: u64,
        action: &str,
        x: i32,
        y: i32,
        window: &str,
        control: Option<&str>,
    ) -> TestSessionEventRecord {
        let mut event = TestSessionEventRecord::new_lifecycle(
            id.to_string(),
            "ts-1".to_string(),
            TestSessionEventType::SessionStarted,
            at,
            crate::session::models::TestSessionStatus::Active,
        );
        event.event_type = TestSessionEventType::StepCaptured;
        event.action = Some(action.to_string());
        event.x = Some(x);
        event.y = Some(y);
        event.window_title = Some(window.to_string());
        event.control_name = control.map(|value| value.to_string());
        event.control_type = control.map(|_| "Button".to_string());
        event
    }

    #[test]
    fn merges_close_click_pair_and_prefers_control_name() {
        let events = vec![
            step_event("e1", 1000, "WM_LBUTTONDOWN", 10, 10, "订单", None),
            step_event("e2", 1050, "WM_LBUTTONUP", 10, 10, "订单", Some("保存")),
        ];
        let steps = build_steps_from_events("ts-1", 0, &events);
        assert_eq!(steps.len(), 1);
        assert!(steps[0].title.contains("保存"));
        assert_eq!(steps[0].precision_level, "l2");
    }

    #[test]
    fn renders_repro_text() {
        let steps = build_steps_from_events(
            "ts-1",
            0,
            &[step_event(
                "e1",
                1000,
                "WM_LBUTTONDOWN",
                1,
                2,
                "窗口A",
                Some("新建"),
            )],
        );
        let text = render_repro_steps_text(
            "ts-1",
            Some(2000),
            Some(1000),
            Some(2000),
            Some("金额未刷新"),
            &steps,
        );
        assert!(text.contains("复现步骤"));
        assert!(text.contains("新建"));
        assert!(text.contains("金额未刷新"));
    }

    fn keyboard_event(
        id: &str,
        at: u64,
        action: &str,
        message: &str,
        char_count: Option<u32>,
        shortcut: Option<&str>,
        control: Option<&str>,
    ) -> TestSessionEventRecord {
        let mut event = TestSessionEventRecord::new_lifecycle(
            id.to_string(),
            "ts-1".to_string(),
            TestSessionEventType::SessionStarted,
            at,
            crate::session::models::TestSessionStatus::Active,
        );
        event.event_type = TestSessionEventType::KeyboardSummary;
        event.action = Some(action.to_string());
        event.message = Some(message.to_string());
        event.char_count = char_count;
        event.shortcut = shortcut.map(|value| value.to_string());
        event.control_name = control.map(|value| value.to_string());
        event.precision_level = Some(if action == "type" { "l3" } else { "l2" }.to_string());
        event
    }

    #[test]
    fn merges_type_summaries_and_builds_l3_step() {
        let events = vec![
            keyboard_event(
                "k1",
                1000,
                "type",
                "输入 3 个字符",
                Some(3),
                None,
                Some("客户名称"),
            ),
            keyboard_event(
                "k2",
                1500,
                "type",
                "输入 5 个字符",
                Some(5),
                None,
                Some("客户名称"),
            ),
        ];
        let steps = build_steps_from_events("ts-1", 0, &events);
        assert_eq!(steps.len(), 1);
        assert!(steps[0].title.contains("8 个字符"));
        assert_eq!(steps[0].precision_level, "l3");
    }

    #[test]
    fn associates_clipboard_with_paste_shortcut() {
        let mut clipboard = TestSessionEventRecord::new_lifecycle(
            "c1".to_string(),
            "ts-1".to_string(),
            TestSessionEventType::SessionStarted,
            1000,
            crate::session::models::TestSessionStatus::Active,
        );
        clipboard.event_type = TestSessionEventType::ClipboardUpdated;
        clipboard.clipboard_content_type = Some("text".to_string());
        clipboard.title = Some("剪贴板已更新".to_string());

        let paste = keyboard_event(
            "k1",
            1200,
            "shortcut",
            "使用快捷键 Ctrl+V",
            None,
            Some("Ctrl+V"),
            Some("备注"),
        );
        let steps = build_steps_from_events("ts-1", 0, &[clipboard, paste]);
        assert_eq!(steps.len(), 1);
        assert!(steps[0].title.contains("粘贴"));
        assert!(steps[0].title.contains("备注") || steps[0].title.contains("文本"));
    }

    #[test]
    fn step_projection_builds_legacy_steps_from_operations() {
        let kept = operation_record("operation-ts-1-input-save", false);
        let ignored = operation_record("operation-ts-1-input-ignore", true);

        let steps = build_steps_from_operations("ts-1", 500, &[kept, ignored]);

        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step_id, "step-operation-ts-1-input-save");
        assert_eq!(steps[0].step_type, "toggle");
        assert_eq!(steps[0].title, "勾选复选框“Enable sync”");
        assert!(steps[0].summary.contains("已开启"));
        assert_eq!(steps[0].relative_ms_from_session_start, 500);
        assert_eq!(steps[0].window_title.as_deref(), Some("Settings"));
        assert_eq!(steps[0].control_name.as_deref(), Some("Enable sync"));
        assert_eq!(steps[0].automation_id.as_deref(), Some("sync"));
        assert_eq!(steps[0].artifact_refs, vec!["screenshots/sync.webp"]);
    }

    fn operation_record(id: &str, ignored: bool) -> TestSessionOperationRecord {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": "reqcase.test-session-operation",
            "operationId": id,
            "sessionId": "ts-1",
            "sequence": 1,
            "startedAtMs": 1000,
            "endedAtMs": 1080,
            "relativeMsFromSessionStart": 500,
            "action": {
                "actionId": format!("action-{id}"),
                "kind": "toggle",
                "occurredAtMs": 1000,
                "endedAtMs": 1000,
                "target": {
                    "runtimeId": [7, 1],
                    "name": "Enable sync",
                    "automationId": "sync",
                    "controlType": "CheckBox",
                    "parentPath": [
                        { "controlType": "Window", "name": "Settings", "automationId": null }
                    ]
                },
                "coordinate": { "x": 10, "y": 20, "displayId": "display-1" },
                "sourceEventIds": ["input-save"]
            },
            "outcome": {
                "outcomeId": format!("outcome-{id}"),
                "status": "confirmed",
                "summary": "已开启",
                "observedAtMs": 1080,
                "latencyMs": 80,
                "confidence": { "overall": 0.91 }
            },
            "evidence": [
                {
                    "evidenceId": "evidence-screenshot",
                    "kind": "screenshot",
                    "role": "supportsOutcome",
                    "sourceId": "artifact-sync",
                    "occurredAtMs": 1080,
                    "artifactRef": "screenshots/sync.webp",
                    "videoRange": null,
                    "reasonCode": null
                }
            ],
            "title": "勾选复选框“Enable sync”",
            "resultSummary": "已开启",
            "displaySummary": "勾选复选框“Enable sync” -> 已开启，耗时 80ms",
            "precisionLevel": "l3",
            "ignored": ignored,
            "businessAlias": null
        }))
        .expect("operation record should deserialize")
    }
}
