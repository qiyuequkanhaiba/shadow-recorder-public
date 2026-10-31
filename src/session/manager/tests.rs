use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use super::SessionManager;
use crate::session::models::{
    TestSessionDefectMarkInput, TestSessionEventType, TestSessionLogInput,
    TestSessionNoteInput, TestSessionRecord, TestSessionStartOptions, TestSessionStatus,
    TestSessionStepEditInput, TestSessionSystemEventInput,
};
use crate::session::operation_models::{
    OperationOutcomeStatus, OperationOverrideChanges, TestSessionOperationEditInput,
};
use crate::session::semantic_event::{
    OperationReasonCode, PrivacyClass, SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord,
    SemanticEventType, TEST_SESSION_SEMANTIC_EVENT_KIND,
};
use crate::types::{CaptureBackendUsed, StepData, StepSource};
use serde_json::json;

static DEFECT_EVIDENCE_CONFIG_LOCK: Mutex<()> = Mutex::new(());
static SEMANTIC_FEATURE_CONFIG_LOCK: Mutex<()> = Mutex::new(());

struct DefectEvidenceConfigGuard {
    _lock: MutexGuard<'static, ()>,
}

struct SemanticFeatureConfigGuard {
    _lock: MutexGuard<'static, ()>,
}

impl Drop for DefectEvidenceConfigGuard {
    fn drop(&mut self) {
        crate::session::set_defect_evidence_enabled(false);
        crate::session::set_defect_windows(60, 20);
    }
}

impl Drop for SemanticFeatureConfigGuard {
    fn drop(&mut self) {
        crate::session::set_semantic_feature_flags(false, false, false, false, false);
    }
}

fn lock_semantic_feature_config() -> MutexGuard<'static, ()> {
    SEMANTIC_FEATURE_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn enable_defect_evidence_for_test() -> DefectEvidenceConfigGuard {
    let lock = DEFECT_EVIDENCE_CONFIG_LOCK
        .lock()
        .expect("lock defect evidence config");
    crate::session::set_defect_evidence_enabled(true);
    crate::session::set_defect_windows(60, 20);
    DefectEvidenceConfigGuard { _lock: lock }
}

fn enable_semantic_features_for_test() -> SemanticFeatureConfigGuard {
    let lock = lock_semantic_feature_config();
    crate::session::set_semantic_feature_flags(true, true, false, false, false);
    SemanticFeatureConfigGuard { _lock: lock }
}

fn disable_semantic_features_for_test() -> SemanticFeatureConfigGuard {
    let lock = lock_semantic_feature_config();
    crate::session::set_semantic_feature_flags(false, false, false, false, false);
    SemanticFeatureConfigGuard { _lock: lock }
}

fn enable_semantic_features_for_locked_test() {
    crate::session::set_semantic_feature_flags(true, true, false, false, false);
}

fn enable_operation_builder_for_locked_test() {
    crate::session::set_semantic_feature_flags(true, true, true, false, false);
}

#[test]
fn session_start_should_resolve_semantic_target_pid_for_display_capture() {
    let options = TestSessionStartOptions {
        target_process_name: Some("demo.exe".to_string()),
        target_capture_mode: Some("target_display".to_string()),
        ..TestSessionStartOptions::default()
    };

    assert!(super::should_resolve_target_pid_from_process_name(&options));
}

#[test]
fn session_start_pid_resolution_requires_missing_pid_and_process_name() {
    let explicit_pid = TestSessionStartOptions {
        target_process_name: Some("demo.exe".to_string()),
        target_pid: Some(42),
        target_capture_mode: Some("target_display".to_string()),
        ..TestSessionStartOptions::default()
    };
    let blank_process = TestSessionStartOptions {
        target_process_name: Some("  ".to_string()),
        target_capture_mode: Some("process_bind".to_string()),
        ..TestSessionStartOptions::default()
    };

    assert!(!super::should_resolve_target_pid_from_process_name(
        &explicit_pid
    ));
    assert!(!super::should_resolve_target_pid_from_process_name(
        &blank_process
    ));
}

#[test]
fn mouse_button_down_actions_cover_left_right_and_double_click() {
    assert!(super::is_mouse_button_down_action("WM_LBUTTONDOWN"));
    assert!(super::is_mouse_button_down_action("WM_RBUTTONDOWN"));
    assert!(super::is_mouse_button_down_action("wm_lbuttondblclk"));
    assert!(!super::is_mouse_button_down_action("WM_MOUSEWHEEL"));
    assert!(!super::is_mouse_button_down_action("WM_LBUTTONUP"));
}

#[test]
fn unbound_sessions_follow_foreground_observer_pid() {
    let unbound = TestSessionRecord {
        target_process_name: None,
        target_pid: Some(11),
        ..TestSessionRecord::from_start_options(
            "ts-follow".to_string(),
            1,
            TestSessionStartOptions::default(),
            None,
            None,
        )
    };
    let bound = TestSessionRecord {
        target_process_name: Some("cc3.exe".to_string()),
        ..unbound.clone()
    };
    assert!(super::should_follow_foreground_observer_pid(&unbound));
    assert!(!super::should_follow_foreground_observer_pid(&bound));
}

#[test]
fn foreground_pid_follows_any_process_unless_session_is_bound() {
    let unbound = TestSessionStartOptions::default();
    let bound = TestSessionStartOptions {
        target_process_name: Some("cc3.exe".to_string()),
        ..TestSessionStartOptions::default()
    };
    assert!(super::foreground_process_matches_session(
        &unbound,
        "notepad.exe"
    ));
    assert!(super::foreground_process_matches_session(&bound, "CC3.EXE"));
    assert!(!super::foreground_process_matches_session(
        &bound,
        "notepad.exe"
    ));
}

fn semantic_test_event(
    session_id: &str,
    event_id: &str,
    occurred_at_ms: u64,
) -> SemanticEventRecord {
    SemanticEventRecord {
        schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
        kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
        event_id: event_id.to_string(),
        session_id: session_id.to_string(),
        event_type: SemanticEventType::UiaPropertyChanged,
        occurred_at_ms,
        monotonic_offset_ms: Some(occurred_at_ms),
        source_event_id: Some(format!("source-{event_id}")),
        target: None,
        payload: json!({
            "property": "toggleState",
            "before": "off",
            "after": "on"
        }),
        privacy_class: PrivacyClass::NotSensitive,
        reason_codes: vec![OperationReasonCode::ToggleStateChanged],
    }
}

fn semantic_operation_event(
    session_id: &str,
    event_id: &str,
    event_type: SemanticEventType,
    occurred_at_ms: u64,
    source_event_id: &str,
    payload: serde_json::Value,
) -> SemanticEventRecord {
    SemanticEventRecord {
        schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
        kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
        event_id: event_id.to_string(),
        session_id: session_id.to_string(),
        event_type,
        occurred_at_ms,
        monotonic_offset_ms: Some(occurred_at_ms),
        source_event_id: Some(source_event_id.to_string()),
        target: None,
        payload,
        privacy_class: PrivacyClass::NotSensitive,
        reason_codes: Vec::new(),
    }
}

fn append_basic_save_semantics(
    manager: &SessionManager,
    session_id: &str,
    source_event_id: &str,
    occurred_at_ms: u64,
    label: &str,
) {
    manager
        .append_semantic_event(semantic_operation_event(
            session_id,
            &format!("sem-{label}-target"),
            SemanticEventType::UiaSnapshot,
            occurred_at_ms.saturating_sub(10),
            source_event_id,
            json!({
                "runtimeId": [21, 1],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Save",
                "automationId": "btnSave",
                "controlType": "Button",
                "boundingRect": { "left": 0, "top": 0, "width": 10, "height": 10 },
                "parentPath": [
                    { "controlType": "Window", "name": "Editor", "automationId": null }
                ]
            }),
        ))
        .expect("append target semantic event")
        .expect("semantic target should be recorded");
    manager
        .append_semantic_event(semantic_operation_event(
            session_id,
            &format!("sem-{label}-toast"),
            SemanticEventType::PopupAppeared,
            occurred_at_ms + 420,
            source_event_id,
            json!({
                "runtimeId": [21, 2],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Saved",
                "controlType": "Text"
            }),
        ))
        .expect("append outcome semantic event")
        .expect("semantic outcome should be recorded");
}

#[test]
fn session_manager_tracks_lifecycle_and_persists_manifest() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-manager");
    let options = TestSessionStartOptions {
        name: Some("Smoke".to_string()),
        storage_dir: Some(temp_root.to_string_lossy().into_owned()),
        target_process_name: Some("demo.exe".to_string()),
        ..TestSessionStartOptions::default()
    };

    let started = manager.start(options).expect("start session");
    assert_eq!(started.status, TestSessionStatus::Active);
    let manifest_path = PathBuf::from(
        started
            .manifest_path
            .clone()
            .expect("manifest path should be available"),
    );
    assert!(manifest_path.exists());

    let paused = manager.pause().expect("pause session");
    assert_eq!(paused.status, TestSessionStatus::Paused);

    let resumed = manager.resume().expect("resume session");
    assert_eq!(resumed.status, TestSessionStatus::Active);

    let stopped = manager.stop().expect("stop session");
    assert_eq!(stopped.status, TestSessionStatus::Stopped);
    assert!(stopped.ended_at_ms.is_some());
    assert!(manager.get_active().expect("get active").is_none());

    let manifest = fs::read_to_string(&manifest_path).expect("read manifest");
    assert!(manifest.contains("\"status\": \"stopped\""));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn list_returns_active_first_then_history() {
    let manager = SessionManager::default();
    let first = manager
        .start(TestSessionStartOptions::default())
        .expect("start first");
    assert_eq!(
        manager.list().expect("list active")[0].session_id,
        first.session_id
    );

    manager.stop().expect("stop first");
    let second = manager
        .start(TestSessionStartOptions {
            name: Some("Second".to_string()),
            ..TestSessionStartOptions::default()
        })
        .expect("start second");

    let listed = manager.list().expect("list records");
    assert_eq!(listed[0].session_id, second.session_id);
    assert_eq!(listed[1].session_id, first.session_id);

    manager.stop().expect("stop second");
}

#[test]
fn record_step_persists_event_and_artifacts() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-events");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let step = fake_step(7);
    let event = manager
        .record_step(&step)
        .expect("record step")
        .expect("active session event");
    assert_eq!(
        event.event_type,
        crate::session::TestSessionEventType::StepCaptured
    );
    assert!(
        event
            .full_image_path
            .as_deref()
            .is_some_and(|path| Path::new(path).exists())
    );
    assert!(
        event
            .thumb_image_path
            .as_deref()
            .is_some_and(|path| Path::new(path).exists())
    );

    let events = manager
        .get_events(Some(&started.session_id), None)
        .expect("get events");
    assert_eq!(events.len(), 2);
    assert_eq!(
        events.last().and_then(|value| value.step_id.as_deref()),
        Some("7")
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn defect_workflow_marks_rebuilds_renders_and_exports_pack() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-defect-workflow");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            target_capture_mode: Some("target_display".to_string()),
            target_display_id: Some("display-primary".to_string()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let mut step = fake_step(7);
    step.timestamp_ms = started.started_at_ms + 1_000;
    step.window_title = "订单管理".to_string();
    step.display_id = "display-primary".to_string();
    manager
        .record_step(&step)
        .expect("record defect evidence step")
        .expect("active session event");

    let mark = {
        let _guard = enable_defect_evidence_for_test();
        manager.mark_defect(TestSessionDefectMarkInput {
            session_id: None,
            marked_at_ms: Some(step.timestamp_ms + 500),
            pre_window_seconds: Some(5),
            post_window_seconds: Some(5),
            note: Some("保存后金额未刷新".to_string()),
            expected: Some("金额刷新为最新值".to_string()),
            actual: Some("金额仍显示旧值".to_string()),
        })
    }
    .expect("mark defect");

    assert_eq!(mark.event.event_type, TestSessionEventType::DefectMarked);
    assert!(mark.window_start_ms <= step.timestamp_ms);
    assert!(mark.window_end_ms >= step.timestamp_ms);
    assert!(mark.step_count >= 1);

    let steps = manager
        .rebuild_steps(Some(&started.session_id))
        .expect("rebuild semantic steps");
    assert!(
        steps
            .iter()
            .any(|item| item.started_at_ms == step.timestamp_ms)
    );

    let session_dir = PathBuf::from(started.session_dir.clone().expect("session dir"));
    let steps_ndjson_path = session_dir.join("steps.ndjson");
    let steps_ndjson = fs::read_to_string(&steps_ndjson_path).expect("read steps.ndjson");
    assert!(steps_ndjson.contains("reqcase.test-session-step"));

    let repro_text = manager
        .render_repro_steps(
            Some(&started.session_id),
            Some(mark.window_start_ms),
            Some(mark.window_end_ms),
            mark.note.clone(),
        )
        .expect("render repro steps");
    assert!(repro_text.contains("复现步骤"));
    assert!(repro_text.contains("保存后金额未刷新"));

    let segment_relative = Path::new("video")
        .join("streams")
        .join("vs-display-primary")
        .join("seg-window.mp4");
    let segment_path = session_dir.join(&segment_relative);
    fs::create_dir_all(segment_path.parent().expect("segment parent"))
        .expect("create segment dir");
    fs::write(&segment_path, b"fake mp4 bytes").expect("write segment");
    let mut segment = fake_video_segment(
        &started.session_id,
        "seg-window",
        "vs-display-primary",
        Some("display-primary"),
        step.timestamp_ms.saturating_sub(500),
        step.timestamp_ms + 3_000,
    );
    segment.file_path = None;
    segment.relative_path = Some(segment_relative.to_string_lossy().replace('\\', "/"));
    let segments_path = session_dir.join("video").join("segments.ndjson");
    fs::write(
        &segments_path,
        format!(
            "{}\n",
            serde_json::to_string(&segment).expect("serialize segment")
        ),
    )
    .expect("write segment index");

    let pack_root = temp_root.join("defect-packs");
    let pack = manager
        .export_defect_pack(
            Some(&started.session_id),
            pack_root.to_string_lossy().into_owned(),
            Some(mark.marked_at_ms),
            Some(mark.pre_window_seconds),
            Some(mark.post_window_seconds),
            mark.note.clone(),
            mark.expected.clone(),
            mark.actual.clone(),
        )
        .expect("export defect pack");

    assert!(pack.step_count >= 1);
    assert!(pack.screenshot_count >= 1);
    assert_eq!(pack.video_segment_count, 1);
    let pack_dir = PathBuf::from(&pack.pack_dir);
    assert!(pack_dir.join("repro_steps.txt").exists());
    assert!(pack_dir.join("steps.json").exists());
    assert!(pack_dir.join("operations.json").exists());
    assert!(pack_dir.join("summary.json").exists());
    assert!(pack_dir.join("manifest.json").exists());
    let screenshot_count = fs::read_dir(pack_dir.join("screenshots"))
        .expect("read screenshot dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("webp"))
        .count();
    assert!(screenshot_count >= 1);
    assert!(
        pack_dir
            .join("video")
            .join("segments")
            .join("01-seg-window.mp4")
            .exists()
    );

    let exported_repro = fs::read_to_string(&pack.repro_steps_path).expect("read repro text");
    assert!(exported_repro.contains("保存后金额未刷新"));
    // Steps-only sessions should still export honest legacyUnknown operations.
    let operations_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(pack_dir.join("operations.json")).expect("read operations json"),
    )
    .expect("parse operations json");
    assert_eq!(operations_json["builderVersion"], "operation-builder-v1");
    assert!(
        operations_json["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty()),
        "operations.json should adapt steps when builder ops are missing"
    );
    assert_eq!(
        operations_json["items"][0]["outcome"]["status"],
        "legacyUnknown"
    );
    assert!(exported_repro.contains("旧记录未采集操作结果") || exported_repro.contains("->"));

    // Late mark after session end must still cover recorded steps.
    manager.stop().expect("stop before late export");
    let late_mark = started.started_at_ms + 120_000;
    let late_pack = manager
        .export_defect_pack(
            Some(&started.session_id),
            pack_root.to_string_lossy().into_owned(),
            Some(late_mark),
            Some(60),
            Some(20),
            Some("late mark".to_string()),
            None,
            None,
        )
        .expect("export late defect pack");
    assert!(
        late_pack.step_count >= 1,
        "late mark should clamp window onto the session"
    );

    let exported_steps: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&pack.steps_path).expect("read steps json"))
            .expect("parse exported steps");
    assert!(!exported_steps.is_empty());
    let summary: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&pack.summary_path).expect("read summary json"),
    )
    .expect("parse summary");
    assert_eq!(
        summary["stepCount"].as_u64(),
        Some(u64::from(pack.step_count))
    );
    assert_eq!(
        summary["screenshotCount"].as_u64(),
        Some(u64::from(pack.screenshot_count))
    );
    assert_eq!(summary["videoSegmentCount"].as_u64(), Some(1));
    assert_eq!(
        summary["privacy"]["includesScreenshots"].as_bool(),
        Some(true)
    );
    assert_eq!(summary["privacy"]["includesVideo"].as_bool(), Some(true));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn start_persists_bootstrapped_video_streams() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-streams");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            target_capture_mode: Some("target_display".to_string()),
            target_display_id: Some("display-primary".to_string()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let streams = manager
        .get_video_streams(Some(&started.session_id))
        .expect("get video streams");
    assert!(!streams.is_empty());
    assert!(streams[0].manifest_path.is_some());

    let streams_manifest = Path::new(
        started
            .session_dir
            .as_deref()
            .expect("session dir should exist"),
    )
    .join("video")
    .join("streams.json");
    assert!(streams_manifest.exists());

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn get_video_segments_for_timestamp_prefers_exact_display_match() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-lookup");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let mut step = fake_step(9);
    step.timestamp_ms = started.started_at_ms + 5_000;
    step.display_id = "display-primary".to_string();
    let event = manager
        .record_step(&step)
        .expect("record step")
        .expect("active session event");

    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let segments_path = session_dir.join("video").join("segments.ndjson");
    let matching_segment = serde_json::to_string(&fake_video_segment(
        &started.session_id,
        "seg-display-primary",
        "vs-display-primary",
        Some("display-primary"),
        step.timestamp_ms.saturating_sub(500),
        step.timestamp_ms.saturating_add(3_500),
    ))
    .expect("serialize segment");
    let competing_segment = serde_json::to_string(&fake_video_segment(
        &started.session_id,
        "seg-display-secondary",
        "vs-display-secondary",
        Some("display-secondary"),
        step.timestamp_ms.saturating_sub(500),
        step.timestamp_ms.saturating_add(3_500),
    ))
    .expect("serialize segment");
    fs::write(
        &segments_path,
        format!("{matching_segment}\n{competing_segment}\n"),
    )
    .expect("write segments");

    let related = manager
        .get_video_segments_for_timestamp(
            Some(&started.session_id),
            event.occurred_at_ms,
            event.display_id.as_deref(),
            Some(2),
        )
        .expect("lookup related segments");

    assert_eq!(related.len(), 2);
    assert_eq!(related[0].segment_id, "seg-display-primary");

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn get_video_segments_for_timestamp_filters_far_segments() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-lookup-far");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let segments_path = session_dir.join("video").join("segments.ndjson");
    let far_segment = serde_json::to_string(&fake_video_segment(
        &started.session_id,
        "seg-far",
        "vs-display-primary",
        Some("display-primary"),
        started.started_at_ms + 60_000,
        started.started_at_ms + 65_000,
    ))
    .expect("serialize segment");
    fs::write(&segments_path, format!("{far_segment}\n")).expect("write segments");

    let related = manager
        .get_video_segments_for_timestamp(
            Some(&started.session_id),
            started.started_at_ms + 500,
            Some("display-primary"),
            Some(2),
        )
        .expect("lookup related segments");

    assert!(related.is_empty());

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn get_events_limit_keeps_latest_entries() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-events-limit");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    manager.record_step(&fake_step(1)).expect("record first");
    manager.record_step(&fake_step(2)).expect("record second");
    manager.pause().expect("pause");

    let events = manager
        .get_events(Some(&started.session_id), Some(2))
        .expect("get limited events");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].step_id.as_deref(), Some("2"));
    assert_eq!(
        events[1].event_type,
        crate::session::TestSessionEventType::SessionPaused
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn get_events_tail_appends_after_cursor() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-events-tail");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    manager.record_step(&fake_step(1)).expect("record first");
    let initial = manager
        .get_events_tail(Some(&started.session_id), None, Some(8))
        .expect("initial tail");
    assert!(initial.reset);
    assert_eq!(initial.items.len(), 2);
    let after_event_id = initial
        .next_cursor
        .clone()
        .expect("tail cursor should exist");

    manager.record_step(&fake_step(2)).expect("record second");
    manager.pause().expect("pause session");

    let delta = manager
        .get_events_tail(Some(&started.session_id), Some(&after_event_id), Some(8))
        .expect("delta tail");
    assert!(!delta.reset);
    assert_eq!(delta.items.len(), 2);
    assert_eq!(delta.items[0].step_id.as_deref(), Some("2"));
    assert_eq!(
        delta.items[1].event_type,
        crate::session::TestSessionEventType::SessionPaused
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn get_video_segments_tail_appends_after_cursor() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-tail");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let segments_path = session_dir.join("video").join("segments.ndjson");
    let first_segment = serde_json::to_string(&fake_video_segment(
        &started.session_id,
        "seg-1",
        "vs-display-primary",
        Some("display-primary"),
        started.started_at_ms,
        started.started_at_ms + 5_000,
    ))
    .expect("serialize first segment");
    fs::write(&segments_path, format!("{first_segment}\n")).expect("write first segment");

    let initial = manager
        .get_video_segments_tail(Some(&started.session_id), None, None, Some(8))
        .expect("initial segment tail");
    assert!(initial.reset);
    assert_eq!(initial.items.len(), 1);
    let after_segment_id = initial
        .next_cursor
        .clone()
        .expect("segment tail cursor should exist");

    let second_segment = serde_json::to_string(&fake_video_segment(
        &started.session_id,
        "seg-2",
        "vs-display-primary",
        Some("display-primary"),
        started.started_at_ms + 5_000,
        started.started_at_ms + 10_000,
    ))
    .expect("serialize second segment");
    fs::write(
        &segments_path,
        format!("{first_segment}\n{second_segment}\n"),
    )
    .expect("write second segment");

    let delta = manager
        .get_video_segments_tail(
            Some(&started.session_id),
            None,
            Some(&after_segment_id),
            Some(8),
        )
        .expect("delta segment tail");
    assert!(!delta.reset);
    assert_eq!(delta.items.len(), 1);
    assert_eq!(delta.items[0].segment_id, "seg-2");

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn append_note_and_app_log_adds_events() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-note-log");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let note = manager
        .append_note(TestSessionNoteInput {
            title: Some("Checkpoint".to_string()),
            message: Some("Reached login page".to_string()),
        })
        .expect("append note");
    assert_eq!(
        note.event_type,
        crate::session::TestSessionEventType::NoteAdded
    );

    let log = manager
        .append_app_log(TestSessionLogInput {
            level: Some("warn".to_string()),
            source: Some("benchmark".to_string()),
            message: Some("fallback path used".to_string()),
        })
        .expect("append app log")
        .expect("active session log");
    assert_eq!(
        log.event_type,
        crate::session::TestSessionEventType::AppLogAdded
    );
    assert_eq!(log.log_level.as_deref(), Some("warn"));

    let events = manager
        .get_events(Some(&started.session_id), None)
        .expect("get events");
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[1].event_type,
        crate::session::TestSessionEventType::NoteAdded
    );
    assert_eq!(
        events[2].event_type,
        crate::session::TestSessionEventType::AppLogAdded
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn append_system_event_adds_window_and_clipboard_entries() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-system-events");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let foreground = manager
        .append_system_event(TestSessionSystemEventInput {
            event_type: crate::session::TestSessionEventType::WindowForegroundChanged,
            occurred_at_ms: 11,
            title: Some("前台窗口已切换".to_string()),
            message: Some("foreground switched".to_string()),
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            window_hwnd: Some("0x100".to_string()),
            window_pid: Some(42),
            system_source: Some("win_event".to_string()),
            clipboard_content_type: None,
            ..TestSessionSystemEventInput::default()
        })
        .expect("append window event")
        .expect("active system event");
    assert_eq!(
        foreground.event_type,
        crate::session::TestSessionEventType::WindowForegroundChanged
    );
    assert_eq!(foreground.system_source.as_deref(), Some("win_event"));

    let clipboard = manager
        .append_system_event(TestSessionSystemEventInput {
            event_type: crate::session::TestSessionEventType::ClipboardUpdated,
            occurred_at_ms: 12,
            title: Some("剪贴板已更新".to_string()),
            message: Some("clipboard type: text".to_string()),
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            window_hwnd: Some("0x100".to_string()),
            window_pid: Some(42),
            system_source: Some("clipboard".to_string()),
            clipboard_content_type: Some("text".to_string()),
            ..TestSessionSystemEventInput::default()
        })
        .expect("append clipboard event")
        .expect("active clipboard event");
    assert_eq!(
        clipboard.event_type,
        crate::session::TestSessionEventType::ClipboardUpdated
    );
    assert_eq!(clipboard.clipboard_content_type.as_deref(), Some("text"));

    let events = manager
        .get_events(Some(&started.session_id), None)
        .expect("get events");
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[1].event_type,
        crate::session::TestSessionEventType::WindowForegroundChanged
    );
    assert_eq!(
        events[2].event_type,
        crate::session::TestSessionEventType::ClipboardUpdated
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn window_foreground_change_follows_unbound_observer_pid() {
    let _guard = enable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-follow-pid");
    manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    manager
        .append_system_event(TestSessionSystemEventInput {
            event_type: crate::session::TestSessionEventType::WindowForegroundChanged,
            occurred_at_ms: 21,
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            window_hwnd: Some("0xabc".to_string()),
            window_pid: Some(4242),
            system_source: Some("win_event".to_string()),
            ..TestSessionSystemEventInput::default()
        })
        .expect("append foreground")
        .expect("active event");

    let active = manager
        .get_active()
        .expect("get active")
        .expect("active session");
    assert_eq!(active.target_pid, Some(4242));
    assert_eq!(active.target_hwnd.as_deref(), Some("0xabc"));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn append_semantic_event_respects_flags_and_supports_tail() {
    let _guard = disable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-semantic-events");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let semantic_events_path = session_dir.join("semantic-events.ndjson");

    let ignored = manager
        .append_semantic_event(semantic_test_event(
            "",
            "sem-disabled",
            started.started_at_ms,
        ))
        .expect("disabled semantic append should not error");
    assert!(ignored.is_none());
    assert!(!semantic_events_path.exists());

    enable_semantic_features_for_locked_test();
    let first = manager
        .append_semantic_event(semantic_test_event(
            "",
            "sem-enabled-1",
            started.started_at_ms + 10,
        ))
        .expect("append first semantic event")
        .expect("semantic event should be recorded");
    assert_eq!(first.session_id, started.session_id);

    manager
        .append_semantic_event(semantic_test_event(
            &started.session_id,
            "sem-enabled-2",
            started.started_at_ms + 20,
        ))
        .expect("append second semantic event")
        .expect("semantic event should be recorded");

    assert!(semantic_events_path.exists());
    let events = manager
        .get_semantic_events(Some(&started.session_id), None)
        .expect("get semantic events");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_id, "sem-enabled-1");
    assert_eq!(events[1].event_id, "sem-enabled-2");

    let tail = manager
        .get_semantic_events_tail(Some(&started.session_id), Some("sem-enabled-1"), Some(8))
        .expect("semantic event tail");
    assert!(!tail.reset);
    assert_eq!(tail.items.len(), 1);
    assert_eq!(tail.items[0].event_id, "sem-enabled-2");
    assert_eq!(tail.next_cursor.as_deref(), Some("sem-enabled-2"));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn rebuild_steps_persists_operations_and_projects_legacy_steps() {
    let _guard = disable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-rebuild");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let mut step = fake_step(started.started_at_ms + 100);
    step.action = "WM_LBUTTONUP".to_string();
    let input_event = manager
        .record_step(&step)
        .expect("record step")
        .expect("step event should be recorded");

    enable_operation_builder_for_locked_test();
    manager
        .append_semantic_event(semantic_operation_event(
            &started.session_id,
            "sem-save-target",
            SemanticEventType::UiaSnapshot,
            input_event.occurred_at_ms.saturating_sub(10),
            &input_event.event_id,
            json!({
                "runtimeId": [9, 1],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Save",
                "automationId": "btnSave",
                "controlType": "Button",
                "boundingRect": { "left": 0, "top": 0, "width": 10, "height": 10 },
                "parentPath": [
                    { "controlType": "Window", "name": "Editor", "automationId": null }
                ]
            }),
        ))
        .expect("append target semantic event")
        .expect("semantic target should be recorded");
    manager
        .append_semantic_event(semantic_operation_event(
            &started.session_id,
            "sem-save-toast",
            SemanticEventType::PopupAppeared,
            input_event.occurred_at_ms + 420,
            &input_event.event_id,
            json!({
                "runtimeId": [9, 2],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Saved",
                "controlType": "Text"
            }),
        ))
        .expect("append outcome semantic event")
        .expect("semantic outcome should be recorded");

    let semantic_events = manager
        .get_semantic_events(Some(&started.session_id), None)
        .expect("semantic events should be readable");
    let operation_semantic_events = semantic_events
        .iter()
        .filter(|event| event.event_id.starts_with("sem-save-"))
        .collect::<Vec<_>>();
    assert_eq!(operation_semantic_events.len(), 2);
    assert_eq!(
        operation_semantic_events
            .iter()
            .find(|event| event.event_id == "sem-save-target")
            .and_then(|event| event.payload.get("name"))
            .and_then(|value| value.as_str()),
        Some("Save")
    );

    let operations = manager
        .rebuild_operations(Some(&started.session_id))
        .expect("rebuild operations");
    assert_eq!(operations.len(), 1);
    assert_eq!(
        operations[0]
            .action
            .target
            .as_ref()
            .and_then(|target| target.name.as_deref()),
        Some("Save")
    );

    let steps = manager
        .rebuild_steps(Some(&started.session_id))
        .expect("rebuild operation projected steps");

    assert_eq!(steps.len(), 1);
    assert!(steps[0].step_id.starts_with("step-operation-"));
    assert_eq!(steps[0].step_type, "click");
    assert_eq!(steps[0].control_name.as_deref(), Some("Save"));
    assert!(steps[0].summary.contains("Saved"));
    assert!(steps[0].summary.contains("耗时 420ms"));

    let operations_ndjson =
        fs::read_to_string(session_dir.join("operations.ndjson")).expect("read operations");
    assert!(operations_ndjson.contains("reqcase.test-session-operation"));
    assert!(operations_ndjson.contains("operation-"));

    let steps_ndjson =
        fs::read_to_string(session_dir.join("steps.ndjson")).expect("read projected steps");
    assert!(steps_ndjson.contains("reqcase.test-session-step"));
    assert!(steps_ndjson.contains("step-operation-"));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn rebuild_steps_preserves_edited_legacy_ordinal_step_id() {
    let _feature_guard = disable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-legacy-edit");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let mut step = fake_step(started.started_at_ms + 100);
    step.action = "WM_LBUTTONUP".to_string();
    let input_event = manager
        .record_step(&step)
        .expect("record step")
        .expect("step event should be recorded");
    let legacy_steps = manager
        .rebuild_steps(Some(&started.session_id))
        .expect("rebuild legacy steps");
    assert_eq!(
        legacy_steps[0].step_id,
        format!("step-{}-1", started.session_id)
    );

    let edited = manager
        .update_step(TestSessionStepEditInput {
            session_id: Some(started.session_id.clone()),
            step_id: legacy_steps[0].step_id.clone(),
            title: Some("旧步骤人工标题".to_string()),
            summary: Some("旧步骤人工摘要".to_string()),
        })
        .expect("edit legacy step");
    assert!(edited.edited);

    enable_operation_builder_for_locked_test();
    append_basic_save_semantics(
        &manager,
        &started.session_id,
        &input_event.event_id,
        input_event.occurred_at_ms,
        "legacy-edit",
    );

    let projected_steps = manager
        .rebuild_steps(Some(&started.session_id))
        .expect("rebuild projected steps");
    assert_eq!(projected_steps.len(), 1);
    assert!(projected_steps[0].step_id.starts_with("step-operation-"));
    assert_ne!(projected_steps[0].step_id, legacy_steps[0].step_id);
    assert_eq!(projected_steps[0].title, "旧步骤人工标题");
    assert_eq!(projected_steps[0].summary, "旧步骤人工摘要");
    assert!(projected_steps[0].edited);

    let updated_by_legacy_id = manager
        .update_step(TestSessionStepEditInput {
            session_id: Some(started.session_id.clone()),
            step_id: legacy_steps[0].step_id.clone(),
            title: Some("旧 ID 再次编辑".to_string()),
            summary: None,
        })
        .expect("edit projected step by old ordinal id");
    assert_eq!(updated_by_legacy_id.step_id, projected_steps[0].step_id);
    assert_eq!(updated_by_legacy_id.title, "旧 ID 再次编辑");

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn update_operation_accepts_legacy_ordinal_step_id_alias() {
    let _guard = disable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-legacy-alias");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let mut step = fake_step(started.started_at_ms + 100);
    step.action = "WM_LBUTTONUP".to_string();
    let input_event = manager
        .record_step(&step)
        .expect("record step")
        .expect("step event should be recorded");

    enable_operation_builder_for_locked_test();
    append_basic_save_semantics(
        &manager,
        &started.session_id,
        &input_event.event_id,
        input_event.occurred_at_ms,
        "legacy-alias",
    );

    let operations = manager
        .rebuild_operations(Some(&started.session_id))
        .expect("rebuild operations");
    assert_eq!(operations.len(), 1);
    let operation_id = operations[0].operation_id.clone();

    let updated = manager
        .update_operation(TestSessionOperationEditInput {
            session_id: Some(started.session_id.clone()),
            operation_id: format!("step-{}-1", started.session_id),
            occurred_at_ms: Some(started.started_at_ms + 2_000),
            changes: OperationOverrideChanges {
                title: Some("旧 stepId 映射到操作".to_string()),
                result_summary: Some("通过旧 ID 写入 override".to_string()),
                selected_outcome_status: Some(OperationOutcomeStatus::Confirmed),
                selected_transition_id: operations[0].outcome.primary_transition_id.clone(),
                ignored: Some(false),
                business_alias: None,
                note: None,
            },
            reason: Some("legacy-step-id-alias".to_string()),
        })
        .expect("update operation by old ordinal step id");

    assert_eq!(updated.operation_id, operation_id);
    assert_eq!(updated.title, "旧 stepId 映射到操作");
    assert_eq!(updated.result_summary, "通过旧 ID 写入 override");

    let overrides_ndjson = fs::read_to_string(session_dir.join("operation-overrides.ndjson"))
        .expect("read operation overrides");
    assert!(overrides_ndjson.contains(&format!("\"operationId\":\"{operation_id}\"")));
    assert!(!overrides_ndjson.contains(&format!(
        "\"operationId\":\"step-{}-1\"",
        started.session_id
    )));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn operation_tail_and_update_operation_append_override() {
    let _guard = disable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-update");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let mut step = fake_step(started.started_at_ms + 100);
    step.action = "WM_LBUTTONUP".to_string();
    let input_event = manager
        .record_step(&step)
        .expect("record step")
        .expect("step event should be recorded");

    enable_operation_builder_for_locked_test();
    manager
        .append_semantic_event(semantic_operation_event(
            &started.session_id,
            "sem-update-target",
            SemanticEventType::UiaSnapshot,
            input_event.occurred_at_ms.saturating_sub(10),
            &input_event.event_id,
            json!({
                "runtimeId": [11, 1],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Save",
                "automationId": "btnSave",
                "controlType": "Button",
                "boundingRect": { "left": 0, "top": 0, "width": 10, "height": 10 },
                "parentPath": [
                    { "controlType": "Window", "name": "Editor", "automationId": null }
                ]
            }),
        ))
        .expect("append target semantic event")
        .expect("semantic target should be recorded");
    manager
        .append_semantic_event(semantic_operation_event(
            &started.session_id,
            "sem-update-toast",
            SemanticEventType::PopupAppeared,
            input_event.occurred_at_ms + 420,
            &input_event.event_id,
            json!({
                "runtimeId": [11, 2],
                "processId": 42,
                "windowHwnd": "0x100",
                "name": "Saved",
                "controlType": "Text"
            }),
        ))
        .expect("append outcome semantic event")
        .expect("semantic outcome should be recorded");

    let operations = manager
        .rebuild_operations(Some(&started.session_id))
        .expect("rebuild operations");
    assert_eq!(operations.len(), 1);
    let operation_id = operations[0].operation_id.clone();
    let selected_transition_id = operations[0].outcome.primary_transition_id.clone();

    let tail = manager
        .get_operations_tail(Some(&started.session_id), None, Some(8))
        .expect("get operation tail");
    assert!(tail.reset);
    assert_eq!(tail.total_count, 1);
    assert_eq!(tail.items[0].operation_id, operation_id);
    assert_eq!(tail.next_cursor.as_deref(), Some(operation_id.as_str()));

    let updated = manager
        .update_operation(TestSessionOperationEditInput {
            session_id: Some(started.session_id.clone()),
            operation_id: operation_id.clone(),
            occurred_at_ms: Some(started.started_at_ms + 2_000),
            changes: OperationOverrideChanges {
                title: Some("人工确认保存".to_string()),
                result_summary: Some("保存提示已人工确认".to_string()),
                selected_outcome_status: Some(OperationOutcomeStatus::Confirmed),
                selected_transition_id,
                ignored: Some(false),
                business_alias: Some("保存订单".to_string()),
                note: Some("manual review".to_string()),
            },
            reason: Some("manual-review".to_string()),
        })
        .expect("update operation");

    assert_eq!(updated.operation_id, operation_id);
    assert_eq!(updated.title, "人工确认保存");
    assert_eq!(updated.result_summary, "保存提示已人工确认");
    assert!(updated.edited);
    assert_eq!(updated.business_alias.as_deref(), Some("保存订单"));
    assert_eq!(updated.manual_note.as_deref(), Some("manual review"));

    let delta = manager
        .get_operations_tail(Some(&started.session_id), Some(&operation_id), Some(8))
        .expect("get operation tail after cursor");
    assert!(!delta.reset);
    assert!(delta.items.is_empty());
    assert_eq!(delta.next_cursor.as_deref(), Some(operation_id.as_str()));

    let overrides_ndjson = fs::read_to_string(session_dir.join("operation-overrides.ndjson"))
        .expect("read operation overrides");
    assert!(overrides_ndjson.contains("reqcase.test-session-operation-override"));
    assert!(overrides_ndjson.contains("人工确认保存"));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn operation_compatibility_tail_reads_legacy_prefix_and_corrupt_diagnostics() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-compat-tail");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let legacy_operation = json!({
        "schemaVersion": 0,
        "kind": "reqcase.test-session-operation",
        "operationId": "operation-legacy",
        "sessionId": started.session_id,
        "sequence": 1,
        "startedAtMs": started.started_at_ms + 100,
        "endedAtMs": started.started_at_ms + 200,
        "relativeMsFromSessionStart": 100,
        "action": {
            "actionId": "action-legacy",
            "kind": "click",
            "occurredAtMs": started.started_at_ms + 100
        },
        "outcome": {
            "outcomeId": "outcome-legacy",
            "status": "legacyUnknown",
            "summary": "旧记录未采集操作结果",
            "observedAtMs": started.started_at_ms + 200,
            "latencyMs": 100
        },
        "title": "Legacy click",
        "resultSummary": "旧记录未采集操作结果",
        "displaySummary": "Legacy click -> 旧记录未采集操作结果",
        "precisionLevel": "legacy-step-adapter",
        "businessAlias": null
    });
    let operation_text = format!(
        "{}\n{{\"schemaVersion\":1,\"kind\":\"reqcase.test-session-operation\"\n",
        serde_json::to_string(&legacy_operation).expect("serialize legacy operation")
    );
    fs::write(session_dir.join("operations.ndjson"), operation_text).expect("write operations");

    let tail = manager
        .get_operations_tail(Some(&started.session_id), None, Some(100))
        .expect("get operation tail");

    assert_eq!(tail.items.len(), 1);
    assert_eq!(tail.items[0].schema_version, 1);
    assert_eq!(tail.items[0].outcome.status.as_str(), "legacyUnknown");
    assert_eq!(tail.items[0].result_summary, "旧记录未采集操作结果");
    assert_eq!(
        tail.diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        vec!["legacySchema", "corruptTail"]
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn operation_compatibility_future_schema_is_read_only_for_rebuild() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-operation-future-schema");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    let session_dir = PathBuf::from(
        started
            .session_dir
            .clone()
            .expect("session dir should be available"),
    );
    let future_operation = json!({
        "schemaVersion": 999,
        "kind": "reqcase.test-session-operation",
        "operationId": "operation-future",
        "sessionId": started.session_id,
        "sequence": 1,
        "startedAtMs": started.started_at_ms + 100,
        "endedAtMs": started.started_at_ms + 200,
        "relativeMsFromSessionStart": 100,
        "action": {
            "actionId": "action-future",
            "kind": "click",
            "occurredAtMs": started.started_at_ms + 100
        },
        "outcome": {
            "outcomeId": "outcome-future",
            "status": "confirmed",
            "summary": "future",
            "observedAtMs": started.started_at_ms + 200,
            "latencyMs": 100
        },
        "title": "Future click",
        "resultSummary": "future",
        "displaySummary": "Future click -> future",
        "precisionLevel": "future",
        "businessAlias": null
    });
    fs::write(
        session_dir.join("operations.ndjson"),
        format!(
            "{}\n",
            serde_json::to_string(&future_operation).expect("serialize future operation")
        ),
    )
    .expect("write operations");

    let tail = manager
        .get_operations_tail(Some(&started.session_id), None, Some(100))
        .expect("get operation tail");
    assert_eq!(tail.items.len(), 1);
    assert_eq!(tail.items[0].schema_version, 999);
    assert_eq!(tail.diagnostics[0].code, "futureSchema");

    let error = manager
        .rebuild_operations(Some(&started.session_id))
        .expect_err("future schema rebuild should be read-only");
    assert!(error.to_string().contains("future schemaVersion"));

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn uia_observer_lifecycle_writes_health_and_drains_semantic_events() {
    let _guard = enable_semantic_features_for_test();
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-uia-observer-lifecycle");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    manager
        .append_semantic_event(semantic_test_event(
            &started.session_id,
            "sem-observer-drained",
            started.started_at_ms + 10,
        ))
        .expect("append observer event")
        .expect("semantic event should be accepted");
    manager.pause().expect("pause session");
    manager.resume().expect("resume session");
    manager.stop().expect("stop session");

    let events = manager
        .get_semantic_events(Some(&started.session_id), None)
        .expect("get semantic events");
    assert!(
        events
            .iter()
            .any(|event| event.event_id == "sem-observer-drained")
    );
    assert!(
        events
            .iter()
            .filter(|event| event.event_type == SemanticEventType::ObserverHealth)
            .count()
            >= 3
    );
    assert_eq!(
        events.last().map(|event| event.event_type.clone()),
        Some(SemanticEventType::ObserverHealth)
    );

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn append_system_event_ignores_paused_session() {
    let manager = SessionManager::default();
    manager
        .start(TestSessionStartOptions::default())
        .expect("start session");
    manager.pause().expect("pause session");

    let event = manager
        .append_system_event(TestSessionSystemEventInput {
            event_type: crate::session::TestSessionEventType::WindowTitleChanged,
            occurred_at_ms: 21,
            title: Some("窗口标题已变化".to_string()),
            message: Some("title changed".to_string()),
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Paused".to_string()),
            window_hwnd: Some("0x200".to_string()),
            window_pid: Some(77),
            system_source: Some("win_event".to_string()),
            clipboard_content_type: None,
            ..TestSessionSystemEventInput::default()
        })
        .expect("append paused event");

    assert!(event.is_none());
}

#[test]
fn update_active_video_config_persists_manifest_without_new_lifecycle_event() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-config");
    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            recording_profile: Some("balanced".to_string()),
            encoder_preference: Some("auto".to_string()),
            show_mouse_in_video: Some(false),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    let manifest_path = PathBuf::from(
        started
            .manifest_path
            .clone()
            .expect("manifest path should be available"),
    );
    let initial_events = manager
        .get_events(Some(&started.session_id), None)
        .expect("get initial events");
    assert_eq!(initial_events.len(), 1);
    assert_eq!(
        initial_events[0].event_type,
        TestSessionEventType::SessionStarted
    );

    let updated = manager
        .update_active_video_config(
            Some("smooth".to_string()),
            Some("hardware".to_string()),
            Some(true),
            None,
        )
        .expect("update active video config")
        .expect("active session should exist");

    assert_eq!(updated.recording_profile, "smooth");
    assert_eq!(updated.encoder_preference, "hardware");
    assert!(updated.show_mouse_in_video);
    assert!(updated.updated_at_ms >= started.updated_at_ms);

    let persisted: TestSessionRecord =
        serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read manifest"))
            .expect("deserialize manifest");
    assert_eq!(persisted.recording_profile, "smooth");
    assert_eq!(persisted.encoder_preference, "hardware");
    assert!(persisted.show_mouse_in_video);

    let events = manager
        .get_events(Some(&started.session_id), None)
        .expect("get events after update");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, TestSessionEventType::SessionStarted);

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn start_copies_staged_video_privacy_onto_the_session() {
    let manager = SessionManager::default();
    let temp_root = unique_temp_dir("shadowrecord-session-video-privacy");
    manager.stage_video_privacy(
        true,
        vec![crate::privacy::MaskRegion {
            x: 8,
            y: 12,
            width: 40,
            height: 24,
            label: "token".to_string(),
        }],
    );

    let started = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(temp_root.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");

    assert!(started.video_privacy_enabled);
    assert_eq!(started.video_privacy_masks.len(), 1);
    assert_eq!(started.video_privacy_masks[0].width, 40);
    let events = manager
        .get_events(Some(&started.session_id), None)
        .expect("events");
    assert_eq!(events.len(), 1);

    fs::remove_dir_all(temp_root).expect("cleanup temp dir");
}

#[test]
fn update_active_video_config_returns_none_without_active_session() {
    let manager = SessionManager::default();

    let updated = manager
        .update_active_video_config(
            Some("smooth".to_string()),
            Some("hardware".to_string()),
            Some(true),
            None,
        )
        .expect("update should succeed without active session");

    assert!(updated.is_none());
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("{prefix}-{unique}"))
}

fn fake_step(id: u64) -> StepData {
    StepData {
        id,
        timestamp_ms: id,
        action: "WM_LBUTTONDOWN".to_string(),
        x: 1,
        y: 2,
        logical_x: 1,
        logical_y: 2,
        window_left: 0,
        window_top: 0,
        window_right: 10,
        window_bottom: 10,
        logical_window_left: 0,
        logical_window_top: 0,
        logical_window_right: 10,
        logical_window_bottom: 10,
        display_id: "display-1".to_string(),
        dpi_scale: 1.0,
        process_name: "demo.exe".to_string(),
        window_title: "Demo".to_string(),
        image_webp: vec![1, 2, 3],
        image_thumb_webp: vec![4, 5],
        image_bytes: 3,
        capture_latency_ms: 11,
        encode_latency_ms: 12,
        source: StepSource::Hook,
        capture_backend: CaptureBackendUsed::Dxgi,
    }
}

fn fake_video_segment(
    session_id: &str,
    segment_id: &str,
    stream_id: &str,
    display_id: Option<&str>,
    started_at_ms: u64,
    ended_at_ms: u64,
) -> crate::session::models::TestSessionVideoSegmentRecord {
    crate::session::models::TestSessionVideoSegmentRecord {
        schema_version: 1,
        kind: "reqcase.test-session-video-segment".to_string(),
        segment_id: segment_id.to_string(),
        session_id: session_id.to_string(),
        stream_id: stream_id.to_string(),
        status: crate::session::TestSessionVideoSegmentStatus::Ready,
        display_id: display_id.map(str::to_string),
        started_at_ms,
        ended_at_ms,
        duration_ms: ended_at_ms.saturating_sub(started_at_ms) as u32,
        relative_path: Some(format!("video/streams/{stream_id}/{segment_id}.mp4")),
        file_path: Some(format!("D:/segments/{stream_id}/{segment_id}.mp4")),
        manifest_path: Some(format!("D:/segments/{stream_id}/{segment_id}.json")),
        size_bytes: Some(2048),
        frame_count: Some(12),
        codec: Some("h264".to_string()),
        container: Some("mp4".to_string()),
        mime_type: Some("video/mp4".to_string()),
        encoder_name: Some("ffmpeg:libx264".to_string()),
        is_playable: true,
        retention_tier: None,
    }
}

#[test]
fn start_refuses_when_free_space_is_below_the_threshold() {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            crate::disk_space::set_free_bytes_override_for_test(None);
        }
    }
    let _guard = Guard;
    crate::disk_space::set_free_bytes_override_for_test(Some(0));
    let manager = SessionManager::default();
    let err = manager
        .start(TestSessionStartOptions {
            storage_dir: Some(std::env::temp_dir().to_string_lossy().to_string()),
            target_capture_mode: Some("desktop".to_string()),
            ..TestSessionStartOptions::default()
        })
        .expect_err("low disk must refuse start");
    let message = err.to_string();
    assert!(message.contains("无法开始录制"), "{message}");
    assert!(!message.contains("defect pack failed"), "{message}");
}
