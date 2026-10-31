use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::privacy::MaskRegion;
use crate::session::defect_pack::{
    DefectPackError, DefectPackRequest, DefectPackResult, clamp_defect_time_window,
    export_defect_pack_with_operations,
};
use crate::session::ffmpeg_loop_runtime::{
    FfmpegLoopRuntime, FfmpegLoopRuntimeError, recover_ffmpeg_loop_segments,
};
use crate::session::keyboard_summary::{KeyboardSummaryError, KeyboardSummaryRuntime};
use crate::session::models::TestSessionStepEditInput;
use crate::session::models::{
    DEFAULT_DEFECT_POST_WINDOW_SECONDS, DEFAULT_DEFECT_PRE_WINDOW_SECONDS,
    TEST_SESSION_SCHEMA_VERSION, TestSessionDefectMarkInput, TestSessionDefectMarkRecord,
    TestSessionEventRecord, TestSessionEventType, TestSessionLogInput, TestSessionNoteInput,
    ProtectedTimeRange, TestSessionRecord, TestSessionStartOptions, TestSessionStatus, TestSessionStepRecord,
    TestSessionSystemEventInput, TestSessionVideoSegmentRecord, TestSessionVideoStreamRecord,
    normalize_encoder_preference, normalize_optional_string, normalize_recording_profile,
};
use crate::session::operation_builder::rebuild_operation_records_with_overrides_and_profile;
use crate::session::operation_models::{
    OperationOverrideChanges, OperationOverrideRecord, OperationOverrideSource,
    TEST_SESSION_OPERATION_OVERRIDE_KIND, TestSessionOperationEditInput,
    TestSessionOperationRecord,
};
use crate::session::operation_override::{OperationOverrideError, OperationOverrideStore};
use crate::session::operation_store::{
    OperationStore, OperationStoreDiagnostic, OperationStoreError, OperationStoreReadReport,
};
use crate::session::operation_summary::render_repro_operations_text;
use crate::session::semantic_alias::{
    SemanticAliasProfile, load_profile_for_session, set_active_profile,
};
use crate::session::semantic_event::{
    SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord, SemanticEventType,
    TEST_SESSION_SEMANTIC_EVENT_KIND,
};
use crate::session::semantic_event_store::{SemanticEventStore, SemanticEventStoreError};
use crate::session::semantic_profile::{
    SemanticProfile, active_semantic_profile, alias_profile_from_semantic_profile,
    load_semantic_profile_for_session, load_semantic_profile_from_path,
    persist_semantic_profile_snapshot, preferred_target_process_name,
    semantic_profile_from_alias_profile, set_active_semantic_profile,
};
use crate::session::step_builder::{
    build_steps_from_events_with_aliases, build_steps_from_operations_with_aliases,
    render_repro_steps_text,
};
use crate::session::system_events::{
    SystemEventListenerError, SystemEventRuntime, find_visible_process_pid_by_name,
    process_names_match,
};
#[cfg(not(test))]
use crate::session::system_events::find_foreground_process;
use crate::session::uia_enricher;
use crate::session::uia_observer::{UiaObserverError, UiaObserverRuntime};
use crate::session::video_ring::{build_video_stream_plan, enumerate_display_targets};
use crate::types::StepData;

const HISTORY_LIMIT: usize = 32;
const EVENT_HISTORY_LIMIT_PER_SESSION: usize = 2048;

pub static TEST_SESSION_MANAGER: Lazy<SessionManager> = Lazy::new(SessionManager::default);

mod error;
mod storage;
#[cfg(test)]
mod tests;

pub use error::SessionError;
use storage::*;


pub struct SessionManager {
    state: Mutex<SessionState>,
    session_counter: AtomicU64,
    event_counter: AtomicU64,
    #[cfg_attr(test, allow(dead_code))]
    system_runtime: Mutex<SystemEventRuntime>,
    #[cfg_attr(test, allow(dead_code))]
    keyboard_runtime: Mutex<KeyboardSummaryRuntime>,
    #[cfg_attr(test, allow(dead_code))]
    ffmpeg_loop_runtime: Mutex<FfmpegLoopRuntime>,
    #[cfg_attr(test, allow(dead_code))]
    uia_observer_runtime: Mutex<UiaObserverRuntime>,
    staged_video_privacy: Mutex<(bool, Vec<MaskRegion>)>,
}

#[derive(Default)]
struct SessionState {
    active: Option<TestSessionRecord>,
    history: Vec<TestSessionRecord>,
    events_by_session: HashMap<String, Vec<TestSessionEventRecord>>,
    event_storage_versions: HashMap<String, StorageFingerprint>,
    video_streams_by_session: HashMap<String, Vec<TestSessionVideoStreamRecord>>,
    video_stream_storage_versions: HashMap<String, StorageFingerprint>,
    video_segments_by_session: HashMap<String, Vec<TestSessionVideoSegmentRecord>>,
    video_segment_storage_versions: HashMap<String, StorageFingerprint>,
    steps_by_session: HashMap<String, Vec<TestSessionStepRecord>>,
    operations_by_session: HashMap<String, Vec<TestSessionOperationRecord>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StorageFingerprint {
    len: u64,
    modified_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct TailQueryResult<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub reset: bool,
    pub total_count: usize,
}

#[derive(Debug, Clone)]
pub struct OperationTailQueryResult {
    pub items: Vec<TestSessionOperationRecord>,
    pub next_cursor: Option<String>,
    pub reset: bool,
    pub total_count: usize,
    pub diagnostics: Vec<OperationStoreDiagnostic>,
}

struct ResolvedOperations {
    operations: Vec<TestSessionOperationRecord>,
    diagnostics: Vec<OperationStoreDiagnostic>,
    loaded_from_storage: bool,
}

impl SessionManager {
    pub fn list_display_targets(&self) -> Vec<crate::session::TestSessionDisplayTarget> {
        enumerate_display_targets()
    }

    pub fn stage_video_privacy(&self, enabled: bool, masks: Vec<MaskRegion>) {
        if let Ok(mut staged) = self.staged_video_privacy.lock() {
            *staged = (enabled, masks);
        }
    }

    pub fn start(
        &self,
        options: TestSessionStartOptions,
    ) -> Result<TestSessionRecord, SessionError> {
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        if let Some(active) = state.active.as_ref() {
            return Err(SessionError::AlreadyActive(active.session_id.clone()));
        }

        let now_ms = now_timestamp_ms();
        let session_id = self.next_session_id(now_ms);
        let storage_root_dir = normalize_optional_string(options.storage_dir.clone());
        if let Some(storage) = storage_root_dir.as_deref() {
            let minimum = crate::disk_space::threshold_bytes(
                options.min_free_bytes_to_start,
                crate::disk_space::MIN_FREE_BYTES_TO_START,
            );
            match crate::disk_space::disk_free_bytes(Path::new(storage)) {
                Ok(free) if crate::disk_space::can_start_recording(free, minimum) => {}
                Ok(_) => {
                    return Err(SessionError::DiskSpace(
                        crate::disk_space::start_refused_message(minimum),
                    ));
                }
                Err(err) => {
                    return Err(SessionError::DiskSpace(format!(
                        "无法读取磁盘剩余空间，不能开始录制：{err}"
                    )));
                }
            }
        }
        let (session_dir, manifest_path) =
            prepare_session_storage(storage_root_dir.as_deref(), &session_id)?;

        let mut options = options;
        // Semantic mode prefers process-bound capture when profile declares a target process.
        if options
            .target_process_name
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
            && let Some(process_name) =
                preferred_target_process_name(active_semantic_profile().as_ref())
        {
            options.target_process_name = Some(process_name);
            if options
                .target_capture_mode
                .as_ref()
                .map(|mode| {
                    mode.eq_ignore_ascii_case("all_displays")
                        || mode.eq_ignore_ascii_case("desktop")
                })
                .unwrap_or(false)
            {
                options.target_capture_mode = Some("process_bind".to_string());
            }
        }
        if should_resolve_target_pid_from_process_name(&options)
            && let Some(process_name) = options.target_process_name.as_deref()
        {
            options.target_pid = find_visible_process_pid_by_name(process_name);
        }
        #[cfg(not(test))]
        if options.target_pid.is_none()
            && let Some(foreground) = find_foreground_process()
            && foreground_process_matches_session(&options, &foreground.process_name)
        {
            options.target_pid = Some(foreground.pid);
            if options
                .target_hwnd
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty())
            {
                options.target_hwnd = Some(foreground.window_hwnd);
            }
        }

        let mut record = TestSessionRecord::from_start_options(
            session_id,
            now_ms,
            options,
            session_dir,
            manifest_path,
        );
        if let Ok(staged) = self.staged_video_privacy.lock() {
            record.video_privacy_enabled = staged.0;
            record.video_privacy_masks = staged.1.clone();
        }
        let video_streams = bootstrap_video_streams(&record);
        persist_manifest(&record)?;
        persist_video_streams(&record, &video_streams)?;
        if let Some(profile) = load_semantic_profile_for_session(record.session_dir.as_deref())
            && let Some(session_dir) = record.session_dir.as_deref()
        {
            let _ = persist_semantic_profile_snapshot(
                Path::new(session_dir),
                &record.session_id,
                record.started_at_ms,
                &profile,
            );
        }
        let event = self.create_lifecycle_event(
            &record.session_id,
            TestSessionEventType::SessionStarted,
            record.started_at_ms,
            TestSessionStatus::Active,
        );
        append_event_to_storage(&record, &event)?;
        push_event(
            &mut state.events_by_session,
            record.session_id.clone(),
            event,
        );
        state
            .video_streams_by_session
            .insert(record.session_id.clone(), video_streams.clone());
        state
            .video_segments_by_session
            .entry(record.session_id.clone())
            .or_default();
        state.active = Some(record.clone());
        drop(state);
        self.on_session_started(&record, &video_streams);
        Ok(record)
    }

    pub fn pause(&self) -> Result<TestSessionRecord, SessionError> {
        let record = self.update_active(|record, now_ms| match record.status.clone() {
            TestSessionStatus::Active => {
                record.status = TestSessionStatus::Paused;
                record.updated_at_ms = now_ms;
                Ok(())
            }
            TestSessionStatus::Paused => Err(SessionError::AlreadyPaused),
            TestSessionStatus::Stopped => Err(SessionError::NoActiveSession),
        })?;
        self.set_video_runtime_paused(true);
        self.set_uia_observer_paused(true);
        Ok(record)
    }

    pub fn resume(&self) -> Result<TestSessionRecord, SessionError> {
        let record = self.update_active(|record, now_ms| match record.status.clone() {
            TestSessionStatus::Paused => {
                record.status = TestSessionStatus::Active;
                record.updated_at_ms = now_ms;
                Ok(())
            }
            TestSessionStatus::Active => Err(SessionError::NotPaused),
            TestSessionStatus::Stopped => Err(SessionError::NoActiveSession),
        })?;
        self.set_video_runtime_paused(false);
        self.set_uia_observer_paused(false);
        Ok(record)
    }

    pub fn stop(&self) -> Result<TestSessionRecord, SessionError> {
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let mut active = state.active.take().ok_or(SessionError::NoActiveSession)?;
        drop(state);
        let stop_requested_at_ms = now_timestamp_ms();
        self.stop_uia_observer_runtime();
        self.stop_video_runtime();

        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        active.status = TestSessionStatus::Stopped;
        active.updated_at_ms = stop_requested_at_ms;
        active.ended_at_ms = Some(stop_requested_at_ms);
        let event = self.create_lifecycle_event(
            &active.session_id,
            TestSessionEventType::SessionStopped,
            stop_requested_at_ms,
            TestSessionStatus::Stopped,
        );
        append_event_to_storage(&active, &event)?;
        push_event(
            &mut state.events_by_session,
            active.session_id.clone(),
            event,
        );
        persist_manifest(&active)?;
        let mut streams = load_video_streams_from_storage(&active)?
            .or_else(|| {
                state
                    .video_streams_by_session
                    .get(&active.session_id)
                    .cloned()
            })
            .unwrap_or_default();
        let persisted_segments = load_video_segments_from_storage(&active)?;
        let recovered_segments =
            if should_recover_video_segments(&active, persisted_segments.as_ref(), &streams) {
                Some(recover_ffmpeg_loop_segments(&active, &mut streams)?)
            } else {
                None
            };
        if !streams.is_empty() {
            persist_video_streams(&active, &streams)?;
            state
                .video_streams_by_session
                .insert(active.session_id.clone(), streams);
        }
        if let Some(segments) = persisted_segments.or(recovered_segments) {
            state
                .video_segments_by_session
                .insert(active.session_id.clone(), segments);
        }
        push_history(&mut state.history, active.clone());
        let session_for_steps = active.clone();
        drop(state);
        self.stop_system_event_runtime();
        if crate::session::is_defect_evidence_enabled()
            || crate::session::defect_config::is_operation_builder_enabled()
        {
            let _ = self.rebuild_steps_for_session(&session_for_steps.session_id);
        }
        Ok(active)
    }

    pub fn update_active_video_config(
        &self,
        recording_profile: Option<String>,
        encoder_preference: Option<String>,
        show_mouse_in_video: Option<bool>,
        video_privacy: Option<(bool, Vec<MaskRegion>)>,
    ) -> Result<Option<TestSessionRecord>, SessionError> {
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let Some(active) = state.active.as_mut() else {
            return Ok(None);
        };

        let mut changed = false;
        if let Some(recording_profile) = recording_profile {
            let normalized = normalize_recording_profile(Some(recording_profile));
            if active.recording_profile != normalized {
                active.recording_profile = normalized;
                changed = true;
            }
        }
        if let Some(encoder_preference) = encoder_preference {
            let normalized = normalize_encoder_preference(Some(encoder_preference));
            if active.encoder_preference != normalized {
                active.encoder_preference = normalized;
                changed = true;
            }
        }
        if let Some(show_mouse_in_video) = show_mouse_in_video
            && active.show_mouse_in_video != show_mouse_in_video
        {
            active.show_mouse_in_video = show_mouse_in_video;
            changed = true;
        }
        if let Some((enabled, masks)) = video_privacy
            && (active.video_privacy_enabled != enabled || active.video_privacy_masks != masks)
        {
            active.video_privacy_enabled = enabled;
            active.video_privacy_masks = masks;
            changed = true;
        }

        if !changed {
            return Ok(Some(active.clone()));
        }

        active.updated_at_ms = now_timestamp_ms();
        persist_manifest(active)?;
        let record = active.clone();
        drop(state);
        self.set_video_runtime_session(&record);
        Ok(Some(record))
    }

    pub fn get_active(&self) -> Result<Option<TestSessionRecord>, SessionError> {
        let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        Ok(state.active.clone())
    }

    pub fn list(&self) -> Result<Vec<TestSessionRecord>, SessionError> {
        let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let mut records =
            Vec::with_capacity(state.history.len() + if state.active.is_some() { 1 } else { 0 });
        if let Some(active) = state.active.as_ref() {
            records.push(active.clone());
        }
        records.extend(state.history.iter().rev().cloned());
        Ok(records)
    }

    pub fn record_step(
        &self,
        step: &StepData,
    ) -> Result<Option<TestSessionEventRecord>, SessionError> {
        {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            if state.active.is_none() {
                return Ok(None);
            }
        }

        // Next input closes the previous action window and cancels compensation polls.
        self.cancel_interaction_compensation_polls();
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let Some(_) = state.active.as_ref() else {
            return Ok(None);
        };

        // UIA enrichment is optional (defect evidence mode). Timestamps stay input-time.
        // Button-down keeps the hook path free of UIA waits; pre-state is requested async below.
        let is_button_down = is_mouse_button_down_action(&step.action);
        let uia = if crate::session::is_defect_evidence_enabled() && !is_button_down {
            uia_enricher::capture_at_point(step.x, step.y)
        } else {
            None
        };
        let has_window = !step.window_title.trim().is_empty();
        let precision_level = uia
            .as_ref()
            .map(|snapshot| snapshot.precision_level(has_window).to_string())
            .unwrap_or_else(|| {
                if has_window {
                    "l1".to_string()
                } else {
                    "l0".to_string()
                }
            });

        let (session_id, event) = {
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            active.updated_at_ms = active.updated_at_ms.max(step.timestamp_ms);
            let (full_image_path, thumb_image_path) = persist_step_artifacts(active, step)?;
            let session_id = active.session_id.clone();
            let mut event = TestSessionEventRecord::new_step(
                self.next_event_id(step.timestamp_ms),
                session_id.clone(),
                step,
                full_image_path,
                thumb_image_path,
            );
            if let Some(snapshot) = uia {
                event = event.with_uia(
                    snapshot.control_name,
                    snapshot.automation_id,
                    snapshot.control_type,
                    snapshot.class_name,
                    Some(precision_level),
                );
            } else {
                event.precision_level = Some(precision_level);
            }
            append_event_to_storage(active, &event)?;
            (session_id, event)
        };

        push_event(&mut state.events_by_session, session_id, event.clone());
        drop(state);

        // Hook never waits: button-down pre-state + interaction compensation polls run async.
        if is_button_down {
            self.request_mouse_down_pre_state_async(&event, step.x, step.y);
            self.schedule_interaction_compensation_poll(&event.event_id, step.x, step.y);
        }

        Ok(Some(event))
    }

    pub fn append_note(
        &self,
        input: TestSessionNoteInput,
    ) -> Result<TestSessionEventRecord, SessionError> {
        let now_ms = now_timestamp_ms();
        self.append_custom_event(now_ms, |session_id| {
            let title = normalize_optional_string(input.title.clone());
            let message = normalize_optional_string(input.message.clone());
            TestSessionEventRecord::new_note(
                self.next_event_id(now_ms),
                session_id,
                now_ms,
                title,
                message,
            )
        })
    }

    pub fn mark_defect(
        &self,
        input: TestSessionDefectMarkInput,
    ) -> Result<TestSessionDefectMarkRecord, SessionError> {
        if !crate::session::is_defect_evidence_enabled() {
            return Err(SessionError::InvalidLookup(
                "defect evidence capture is disabled; enable it in settings first".to_string(),
            ));
        }
        let now_ms = now_timestamp_ms();
        let marked_at_ms = input.marked_at_ms.unwrap_or(now_ms).max(1);
        let pre_window_seconds = input
            .pre_window_seconds
            .unwrap_or_else(crate::session::defect_pre_window_seconds)
            .clamp(5, 600);
        let post_window_seconds = input
            .post_window_seconds
            .unwrap_or_else(crate::session::defect_post_window_seconds)
            .clamp(0, 300);
        let note = normalize_optional_string(input.note.clone());
        let expected = normalize_optional_string(input.expected.clone());
        let actual = normalize_optional_string(input.actual.clone());
        let requested_session_id = input
            .session_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (event, window_start_ms, window_end_ms, updated_active) = {
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;

            // Prefer active session when recording; otherwise mark the reviewed/historical session.
            let use_active = state.active.as_ref().is_some_and(|active| {
                requested_session_id
                    .as_ref()
                    .map(|id| id == &active.session_id)
                    .unwrap_or(true)
            });

            if use_active {
                let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
                let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
                    active.started_at_ms,
                    active.ended_at_ms.or(Some(active.updated_at_ms)),
                    marked_at_ms,
                    pre_window_seconds,
                    post_window_seconds,
                );
                active.updated_at_ms = active.updated_at_ms.max(marked_at_ms);
                active.protected_ranges.push(ProtectedTimeRange {
                    start_ms: window_start_ms,
                    end_ms: window_end_ms,
                    label: note.clone(),
                });
                let event = TestSessionEventRecord::new_defect_mark(
                    self.next_event_id(marked_at_ms),
                    active.session_id.clone(),
                    marked_at_ms,
                    note.clone(),
                    expected.clone(),
                    actual.clone(),
                    window_start_ms,
                    window_end_ms,
                );
                append_event_to_storage(active, &event)?;
                persist_manifest(active)?;
                let session_id = active.session_id.clone();
                let active_record = active.clone();
                push_event(&mut state.events_by_session, session_id, event.clone());
                (event, window_start_ms, window_end_ms, Some(active_record))
            } else {
                let target_id = requested_session_id
                    .clone()
                    .or_else(|| state.history.last().map(|record| record.session_id.clone()));
                let Some(target_id) = target_id else {
                    return Err(SessionError::NoActiveSession);
                };
                let history_index = state
                    .history
                    .iter()
                    .position(|record| record.session_id == target_id)
                    .ok_or_else(|| SessionError::SessionNotFound(target_id.clone()))?;
                let record = &mut state.history[history_index];
                let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
                    record.started_at_ms,
                    record.ended_at_ms.or(Some(record.updated_at_ms)),
                    marked_at_ms,
                    pre_window_seconds,
                    post_window_seconds,
                );
                record.updated_at_ms = record.updated_at_ms.max(marked_at_ms);
                record.protected_ranges.push(ProtectedTimeRange {
                    start_ms: window_start_ms,
                    end_ms: window_end_ms,
                    label: note.clone(),
                });
                let event = TestSessionEventRecord::new_defect_mark(
                    self.next_event_id(marked_at_ms),
                    record.session_id.clone(),
                    marked_at_ms,
                    note.clone(),
                    expected.clone(),
                    actual.clone(),
                    window_start_ms,
                    window_end_ms,
                );
                append_event_to_storage(record, &event)?;
                persist_manifest(record)?;
                let session_id = record.session_id.clone();
                push_event(&mut state.events_by_session, session_id, event.clone());
                (event, window_start_ms, window_end_ms, None)
            }
        };
        if let Some(ref active_record) = updated_active {
            self.set_video_runtime_session(active_record);
        }

        // Rebuild is best-effort: marking must never fail or disrupt video retention.
        let steps = self
            .rebuild_steps_for_session(&event.session_id)
            .unwrap_or_default();
        let window_step_count = steps
            .iter()
            .filter(|step| {
                step.started_at_ms >= window_start_ms && step.started_at_ms <= window_end_ms
            })
            .count();

        Ok(TestSessionDefectMarkRecord {
            event,
            marked_at_ms,
            window_start_ms,
            window_end_ms,
            pre_window_seconds,
            post_window_seconds,
            note,
            expected,
            actual,
            step_count: u32::try_from(window_step_count).unwrap_or(u32::MAX),
        })
    }

    pub fn get_steps(
        &self,
        session_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<TestSessionStepRecord>, SessionError> {
        // Idle / missing session must not surface as a hard error to the UI.
        let resolved = match self.resolve_session_id(session_id) {
            Ok(id) => id,
            Err(SessionError::NoActiveSession) | Err(SessionError::SessionNotFound(_)) => {
                return Ok(Vec::new());
            }
            Err(err) => return Err(err),
        };
        let mut steps = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            state
                .steps_by_session
                .get(&resolved)
                .cloned()
                .unwrap_or_default()
        };
        if steps.is_empty() {
            steps = match self.rebuild_steps_for_session(&resolved) {
                Ok(value) => value,
                Err(SessionError::NoActiveSession) | Err(SessionError::SessionNotFound(_)) => {
                    Vec::new()
                }
                Err(err) => return Err(err),
            };
        }
        if let Some(limit) = limit
            && steps.len() > limit
        {
            let start = steps.len() - limit;
            steps = steps.split_off(start);
        }
        Ok(steps)
    }

    pub fn rebuild_steps(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<TestSessionStepRecord>, SessionError> {
        let resolved = self.resolve_session_id(session_id)?;
        self.rebuild_steps_for_session(&resolved)
    }

    pub fn get_operations_tail(
        &self,
        session_id: Option<&str>,
        after_operation_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<OperationTailQueryResult, SessionError> {
        let resolved = match self.resolve_session_id(session_id) {
            Ok(id) => id,
            Err(SessionError::NoActiveSession) | Err(SessionError::SessionNotFound(_)) => {
                return Ok(OperationTailQueryResult {
                    items: Vec::new(),
                    next_cursor: None,
                    reset: true,
                    total_count: 0,
                    diagnostics: Vec::new(),
                });
            }
            Err(err) => return Err(err),
        };

        let mut resolved_operations =
            self.resolve_operations_with_diagnostics_for_session(&resolved)?;
        if resolved_operations.operations.is_empty()
            && !resolved_operations.loaded_from_storage
            && crate::session::defect_config::is_operation_builder_enabled()
        {
            resolved_operations.operations = self.rebuild_operations(Some(&resolved))?;
        }

        let tail = build_tail_query_result(
            resolved_operations.operations,
            after_operation_id,
            limit,
            |operation| operation.operation_id.as_str(),
        );

        Ok(OperationTailQueryResult {
            items: tail.items,
            next_cursor: tail.next_cursor,
            reset: tail.reset,
            total_count: tail.total_count,
            diagnostics: resolved_operations.diagnostics,
        })
    }

    pub fn rebuild_operations(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<TestSessionOperationRecord>, SessionError> {
        let resolved = self.resolve_session_id(session_id)?;
        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(&resolved))?
        };
        if let Some(report) = load_operations_from_storage(&session)?
            && report.has_future_schema()
        {
            return Err(SessionError::InvalidLookup(
                "operation store has future schemaVersion; rebuild/update is read-only".to_string(),
            ));
        }

        if crate::session::defect_config::is_operation_builder_enabled() {
            self.rebuild_steps_for_session(&resolved)?;
        }
        self.resolve_operations_for_session(&resolved)
    }

    pub fn update_operation(
        &self,
        input: TestSessionOperationEditInput,
    ) -> Result<TestSessionOperationRecord, SessionError> {
        if !crate::session::defect_config::is_operation_builder_enabled() {
            return Err(SessionError::InvalidLookup(
                "operation builder is disabled".to_string(),
            ));
        }

        let resolved = self.resolve_session_id(input.session_id.as_deref())?;
        let requested_operation_id = input.operation_id.trim().to_string();
        if requested_operation_id.is_empty() {
            return Err(SessionError::InvalidLookup(
                "operation_id is required".to_string(),
            ));
        }
        if !has_operation_override_changes(&input.changes) {
            return Err(SessionError::InvalidLookup(
                "at least one operation change is required".to_string(),
            ));
        }

        let existing = self.rebuild_operations(Some(&resolved))?;
        let Some(operation_id) =
            resolve_operation_id_alias(&existing, &resolved, &requested_operation_id)
        else {
            return Err(SessionError::InvalidLookup(format!(
                "operation not found: {requested_operation_id}"
            )));
        };

        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(&resolved))?
        };
        let Some(session_dir) = session.session_dir.as_deref() else {
            return Err(SessionError::InvalidLookup(
                "session storage directory is unavailable".to_string(),
            ));
        };

        let occurred_at_ms = input.occurred_at_ms.unwrap_or_else(now_timestamp_ms).max(1);
        let override_record = OperationOverrideRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_OPERATION_OVERRIDE_KIND.to_string(),
            override_id: self.next_override_id(occurred_at_ms),
            session_id: resolved.clone(),
            operation_id: operation_id.clone(),
            occurred_at_ms,
            source: OperationOverrideSource::User,
            changes: input.changes,
            reason: normalize_optional_string(input.reason),
        };
        OperationOverrideStore::for_session_dir(session_dir).append(&override_record)?;

        self.rebuild_operations(Some(&resolved))?
            .into_iter()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| {
                SessionError::InvalidLookup(format!(
                    "operation not found after override: {operation_id}"
                ))
            })
    }

    fn validate_session_name(name: &str) -> bool {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 80 {
            return false;
        }
        if trimmed.contains('\\')
            || trimmed.contains('/')
            || trimmed.contains(':')
            || trimmed.contains('\n')
            || trimmed.contains('\r')
        {
            return false;
        }
        true
    }

    pub fn update_session_meta(
        &self,
        session_id: &str,
        name: Option<String>,
        notes: Option<String>,
        history_retention_mode: Option<String>,
        history_retention_hours: Option<u32>,
        history_retention_max_segments: Option<u32>,
    ) -> Result<TestSessionRecord, SessionError> {
        let mut guard = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let session = guard.active.as_mut().filter(|s| s.session_id == session_id)
            .ok_or_else(|| SessionError::SessionNotFound(session_id.to_string()))?;
        if let Some(n) = name {
            let trimmed = n.trim().to_string();
            if !Self::validate_session_name(&trimmed) {
                return Err(SessionError::InvalidLookup("Invalid session name".into()));
            }
            session.name = Some(trimmed);
        }
        let retention_config_changed = history_retention_mode.is_some()
            || history_retention_hours.is_some()
            || history_retention_max_segments.is_some();
        if let Some(n) = notes {
            if n.chars().count() > 2000 {
                return Err(SessionError::InvalidLookup("Session notes exceed 2000 characters".into()));
            }
            session.notes = Some(n);
        }
        if let Some(m) = history_retention_mode {
            let mode = m.trim();
            if mode != "age" && mode != "count" {
                return Err(SessionError::InvalidLookup("Invalid history retention mode".into()));
            }
            session.history_retention_mode = Some(mode.to_string());
        }
        if let Some(h) = history_retention_hours { session.history_retention_hours = Some(h.clamp(1, 168)); }
        if let Some(m) = history_retention_max_segments { session.history_retention_max_segments = Some(m.clamp(10, 2000)); }
        session.updated_at_ms = now_timestamp_ms();
        persist_manifest(session)?;
        let updated = session.clone();
        drop(guard);
        if retention_config_changed {
            self.set_video_runtime_session(&updated);
        }
        Ok(updated)
    }
    pub fn update_step(
        &self,
        input: TestSessionStepEditInput,
    ) -> Result<TestSessionStepRecord, SessionError> {
        let resolved = self.resolve_session_id(input.session_id.as_deref())?;
        let mut steps = self.get_steps(Some(&resolved), None)?;
        let step_id = input.step_id.trim();
        if step_id.is_empty() {
            return Err(SessionError::InvalidLookup(
                "step_id is required".to_string(),
            ));
        }

        let Some(index) = resolve_step_index_alias(&steps, &resolved, step_id) else {
            return Err(SessionError::InvalidLookup(format!(
                "step not found: {step_id}"
            )));
        };

        let title = normalize_optional_string(input.title);
        let summary = normalize_optional_string(input.summary);
        if title.is_none() && summary.is_none() {
            return Err(SessionError::InvalidLookup(
                "title or summary is required for step edit".to_string(),
            ));
        }

        if let Some(title) = title {
            if steps[index].original_title.is_none() {
                steps[index].original_title = Some(steps[index].title.clone());
            }
            steps[index].title = title.clone();
            if summary.is_none() {
                steps[index].summary = title;
            }
            steps[index].edited = true;
        }
        if let Some(summary) = summary {
            steps[index].summary = summary;
            steps[index].edited = true;
        }

        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(&resolved))?
        };
        persist_steps_to_storage(&session, &steps)?;
        let updated = steps[index].clone();
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        state.steps_by_session.insert(resolved, steps);
        Ok(updated)
    }

    pub fn set_semantic_alias_profile(
        &self,
        profile: Option<SemanticAliasProfile>,
    ) -> Result<(), SessionError> {
        set_active_profile(profile.clone());
        set_active_semantic_profile(profile.map(semantic_profile_from_alias_profile));
        Ok(())
    }

    pub fn get_semantic_alias_profile(&self) -> Option<SemanticAliasProfile> {
        if let Some(profile) = active_semantic_profile() {
            return Some(alias_profile_from_semantic_profile(&profile));
        }
        crate::session::semantic_alias::active_profile()
    }

    pub fn set_semantic_profile(
        &self,
        profile: Option<SemanticProfile>,
    ) -> Result<(), SessionError> {
        set_active_semantic_profile(profile.clone());
        set_active_profile(profile.as_ref().map(alias_profile_from_semantic_profile));
        Ok(())
    }

    pub fn get_semantic_profile(&self) -> Option<SemanticProfile> {
        active_semantic_profile().or_else(|| {
            crate::session::semantic_alias::active_profile()
                .map(semantic_profile_from_alias_profile)
        })
    }

    pub fn load_semantic_profile_file(
        &self,
        path: String,
    ) -> Result<SemanticProfile, SessionError> {
        let profile = load_semantic_profile_from_path(Path::new(&path)).ok_or_else(|| {
            SessionError::InvalidLookup(format!(
                "failed to load semantic profile from path: {path}. Supported: semantic-profile JSON, qttimer profile snapshot, or elements_selected array export."
            ))
        })?;
        self.set_semantic_profile(Some(profile.clone()))?;
        Ok(profile)
    }

    pub fn load_semantic_profile_json(
        &self,
        content: String,
    ) -> Result<SemanticProfile, SessionError> {
        use crate::session::semantic_profile::parse_semantic_profile_json;
        let profile = parse_semantic_profile_json(&content).ok_or_else(|| {
            SessionError::InvalidLookup(
                "failed to parse semantic profile JSON. Supported: semantic-profile object, qttimer snapshot, or elements_selected array export.".to_string(),
            )
        })?;
        self.set_semantic_profile(Some(profile.clone()))?;
        Ok(profile)
    }

    pub fn render_repro_steps(
        &self,
        session_id: Option<&str>,
        window_start_ms: Option<u64>,
        window_end_ms: Option<u64>,
        defect_note: Option<String>,
    ) -> Result<String, SessionError> {
        let resolved = self.resolve_session_id(session_id)?;
        let operations = self
            .resolve_operations_for_session(&resolved)
            .unwrap_or_default();
        let filtered_operations = match (window_start_ms, window_end_ms) {
            (Some(start), Some(end)) => operations
                .into_iter()
                .filter(|operation| {
                    !operation.ignored
                        && operation.started_at_ms >= start
                        && operation.started_at_ms <= end
                })
                .collect::<Vec<_>>(),
            _ => operations
                .into_iter()
                .filter(|operation| !operation.ignored)
                .collect::<Vec<_>>(),
        };
        if !filtered_operations.is_empty() {
            return Ok(render_repro_operations_text(
                &resolved,
                window_end_ms,
                window_start_ms,
                window_end_ms,
                defect_note.as_deref(),
                &filtered_operations,
            ));
        }

        let steps = self.get_steps(Some(&resolved), None)?;
        let filtered = match (window_start_ms, window_end_ms) {
            (Some(start), Some(end)) => steps
                .into_iter()
                .filter(|step| step.started_at_ms >= start && step.started_at_ms <= end)
                .collect::<Vec<_>>(),
            _ => steps,
        };
        Ok(render_repro_steps_text(
            &resolved,
            window_end_ms,
            window_start_ms,
            window_end_ms,
            defect_note.as_deref(),
            &filtered,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn export_defect_pack(
        &self,
        session_id: Option<&str>,
        target_dir: String,
        marked_at_ms: Option<u64>,
        pre_window_seconds: Option<u32>,
        post_window_seconds: Option<u32>,
        note: Option<String>,
        expected: Option<String>,
        actual: Option<String>,
    ) -> Result<DefectPackResult, SessionError> {
        let resolved = self.resolve_session_id(session_id)?;
        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(&resolved))?
        };
        let steps = self.rebuild_steps_for_session(&resolved)?;
        let operations = self
            .resolve_operations_for_session(&resolved)
            .or_else(|_| self.rebuild_operations(Some(&resolved)))
            .unwrap_or_default();
        let segments = self.get_video_segments(Some(&resolved), None, None)?;

        let marked_at_ms = marked_at_ms.unwrap_or_else(now_timestamp_ms).max(1);
        let pre_window_seconds = pre_window_seconds
            .unwrap_or(DEFAULT_DEFECT_PRE_WINDOW_SECONDS)
            .clamp(5, 600);
        let post_window_seconds = post_window_seconds
            .unwrap_or(DEFAULT_DEFECT_POST_WINDOW_SECONDS)
            .clamp(0, 300);
        let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
            session.started_at_ms,
            session.ended_at_ms.or(Some(session.updated_at_ms)),
            marked_at_ms,
            pre_window_seconds,
            post_window_seconds,
        );

        let request = DefectPackRequest {
            target_dir,
            marked_at_ms,
            window_start_ms,
            window_end_ms,
            note: normalize_optional_string(note),
            expected: normalize_optional_string(expected),
            actual: normalize_optional_string(actual),
        };
        // The manager lock is not held here. export_defect_pack_with_operations may run ffmpeg.
        export_defect_pack_with_operations(&session, &steps, &operations, &segments, &request)
            .map_err(Into::into)
    }

    fn resolve_operations_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TestSessionOperationRecord>, SessionError> {
        Ok(self
            .resolve_operations_with_diagnostics_for_session(session_id)?
            .operations)
    }

    fn resolve_operations_with_diagnostics_for_session(
        &self,
        session_id: &str,
    ) -> Result<ResolvedOperations, SessionError> {
        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(session_id))?
        };

        if let Some(report) = load_operations_from_storage(&session)? {
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            state
                .operations_by_session
                .insert(session_id.to_string(), report.operations.clone());
            return Ok(ResolvedOperations {
                operations: report.operations,
                diagnostics: report.diagnostics,
                loaded_from_storage: true,
            });
        }

        let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        Ok(ResolvedOperations {
            operations: state
                .operations_by_session
                .get(session_id)
                .cloned()
                .unwrap_or_default(),
            diagnostics: Vec::new(),
            loaded_from_storage: false,
        })
    }

    fn rebuild_steps_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TestSessionStepRecord>, SessionError> {
        let session = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, Some(session_id))?
        };
        let events = self.get_events(Some(session_id), None)?;
        let previous_edited_steps = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            state
                .steps_by_session
                .get(session_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|step| step.edited)
                .collect::<Vec<_>>()
        };
        let previous_edits = previous_edited_steps
            .iter()
            .cloned()
            .map(|step| (step.step_id.clone(), step))
            .collect::<HashMap<_, _>>();
        let semantic_profile = load_semantic_profile_for_session(session.session_dir.as_deref());
        let profile = semantic_profile
            .as_ref()
            .map(alias_profile_from_semantic_profile)
            .or_else(|| load_profile_for_session(session.session_dir.as_deref()));
        let mut steps = if crate::session::defect_config::is_operation_builder_enabled() {
            self.flush_uia_observer_runtime()?;
            let semantic_events = load_semantic_events_from_storage(&session)?;
            let overrides = load_operation_overrides_from_storage(&session)?;
            let report = rebuild_operation_records_with_overrides_and_profile(
                &session.session_id,
                session.started_at_ms,
                &events,
                &semantic_events,
                &overrides,
                semantic_profile.as_ref(),
            );
            let operations = report.operations;
            persist_operations_to_storage(&session, &operations)?;
            let steps = build_steps_from_operations_with_aliases(
                &session.session_id,
                session.started_at_ms,
                &operations,
                profile.as_ref(),
            );
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            state
                .operations_by_session
                .insert(session_id.to_string(), operations);
            steps
        } else {
            build_steps_from_events_with_aliases(
                &session.session_id,
                session.started_at_ms,
                &events,
                profile.as_ref(),
            )
        };
        // Preserve manual edits across rebuilds, including old ordinal step IDs
        // remapped to operation-projected step IDs.
        let mut applied_previous_step_ids = HashSet::new();
        for (index, step) in steps.iter_mut().enumerate() {
            if let Some(edited) = find_compatible_previous_step_edit(
                step,
                index,
                session_id,
                &previous_edits,
                &previous_edited_steps,
                &applied_previous_step_ids,
            ) {
                applied_previous_step_ids.insert(edited.step_id.clone());
                apply_previous_step_edit(step, edited);
            }
        }
        persist_steps_to_storage(&session, &steps)?;
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        state
            .steps_by_session
            .insert(session_id.to_string(), steps.clone());
        Ok(steps)
    }

    fn resolve_session_id(&self, session_id: Option<&str>) -> Result<String, SessionError> {
        let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let record = resolve_session_record(&state, session_id)?;
        Ok(record.session_id)
    }

    pub fn append_app_log(
        &self,
        input: TestSessionLogInput,
    ) -> Result<Option<TestSessionEventRecord>, SessionError> {
        let now_ms = now_timestamp_ms();
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let Some(_) = state.active.as_ref() else {
            return Ok(None);
        };

        let event = {
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            active.updated_at_ms = now_ms;
            let event = TestSessionEventRecord::new_app_log(
                self.next_event_id(now_ms),
                active.session_id.clone(),
                now_ms,
                input.level.clone(),
                input.source.clone(),
                normalize_optional_string(input.message.clone()),
            );
            append_event_to_storage(active, &event)?;
            persist_manifest(active)?;
            event
        };

        push_event(
            &mut state.events_by_session,
            event.session_id.clone(),
            event.clone(),
        );
        Ok(Some(event))
    }

    pub fn append_system_event(
        &self,
        input: TestSessionSystemEventInput,
    ) -> Result<Option<TestSessionEventRecord>, SessionError> {
        let now_ms = input.occurred_at_ms.max(now_timestamp_ms());
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let Some(_) = state.active.as_ref() else {
            return Ok(None);
        };

        let event = {
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            if active.status != TestSessionStatus::Active {
                return Ok(None);
            }
            active.updated_at_ms = active.updated_at_ms.max(now_ms);
            let event = TestSessionEventRecord::new_system(
                self.next_event_id(now_ms),
                active.session_id.clone(),
                input,
            );
            append_event_to_storage(active, &event)?;
            persist_manifest(active)?;
            event
        };

        push_event(
            &mut state.events_by_session,
            event.session_id.clone(),
            event.clone(),
        );
        drop(state);
        self.maybe_follow_observer_target(&event);
        Ok(Some(event))
    }

    #[allow(dead_code)]
    pub fn append_semantic_event(
        &self,
        mut event: SemanticEventRecord,
    ) -> Result<Option<SemanticEventRecord>, SessionError> {
        if !crate::session::defect_config::is_semantic_recording_enabled()
            || !crate::session::defect_config::is_uia_observer_enabled()
        {
            return Ok(None);
        }

        let session_dir = {
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            let Some(active) = state.active.as_mut() else {
                return Ok(None);
            };
            if active.status != TestSessionStatus::Active {
                return Ok(None);
            }

            if event.event_id.trim().is_empty() {
                return Err(SessionError::InvalidLookup(
                    "semantic event_id is required".to_string(),
                ));
            }
            if event.schema_version != SEMANTIC_EVENT_SCHEMA_VERSION {
                return Err(SessionError::InvalidLookup(format!(
                    "unsupported semantic event schema version: {}",
                    event.schema_version
                )));
            }
            if event.kind.trim().is_empty() {
                event.kind = TEST_SESSION_SEMANTIC_EVENT_KIND.to_string();
            }
            if event.kind != TEST_SESSION_SEMANTIC_EVENT_KIND {
                return Err(SessionError::InvalidLookup(format!(
                    "unsupported semantic event kind: {}",
                    event.kind
                )));
            }
            if event.session_id.trim().is_empty() {
                event.session_id = active.session_id.clone();
            } else if event.session_id != active.session_id {
                return Err(SessionError::InvalidLookup(format!(
                    "semantic event belongs to a different session: {}",
                    event.session_id
                )));
            }

            active.updated_at_ms = active.updated_at_ms.max(event.occurred_at_ms);
            persist_manifest(active)?;
            active.session_dir.clone()
        };

        if !self.enqueue_semantic_event_in_runtime(event.clone())?
            && let Some(session_dir) = session_dir.as_deref()
        {
            SemanticEventStore::for_session_dir(session_dir).append(&event)?;
        }
        Ok(Some(event))
    }

    #[allow(dead_code)]
    pub fn get_semantic_events(
        &self,
        session_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<SemanticEventRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        self.flush_uia_observer_runtime()?;
        let mut events = load_semantic_events_from_storage(&record)?;
        apply_event_limit(&mut events, limit);
        Ok(events)
    }

    #[allow(dead_code)]
    pub fn get_semantic_events_tail(
        &self,
        session_id: Option<&str>,
        after_event_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<TailQueryResult<SemanticEventRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        self.flush_uia_observer_runtime()?;
        let events = load_semantic_events_from_storage(&record)?;
        Ok(build_tail_query_result(
            events,
            after_event_id,
            limit,
            |event| event.event_id.as_str(),
        ))
    }

    pub fn get_events(
        &self,
        session_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<TestSessionEventRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        let mut events = self.resolve_cached_events(&record)?;
        apply_event_limit(&mut events, limit);
        Ok(events)
    }

    pub fn get_events_tail(
        &self,
        session_id: Option<&str>,
        after_event_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<TailQueryResult<TestSessionEventRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        let events = self.resolve_cached_events(&record)?;
        Ok(build_tail_query_result(
            events,
            after_event_id,
            limit,
            |event| event.event_id.as_str(),
        ))
    }

    pub fn get_video_streams(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<TestSessionVideoStreamRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        self.resolve_cached_video_streams(&record)
    }

    pub fn get_video_segments(
        &self,
        session_id: Option<&str>,
        stream_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<TestSessionVideoSegmentRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        let mut segments = self.resolve_cached_video_segments(&record)?;
        if let Some(stream_id) = stream_id {
            segments.retain(|segment| segment.stream_id == stream_id);
        }
        apply_event_limit(&mut segments, limit);
        Ok(segments)
    }

    pub fn get_video_segments_tail(
        &self,
        session_id: Option<&str>,
        stream_id: Option<&str>,
        after_segment_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<TailQueryResult<TestSessionVideoSegmentRecord>, SessionError> {
        let record = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            resolve_session_record(&state, session_id)?
        };

        let mut segments = self.resolve_cached_video_segments(&record)?;
        if let Some(stream_id) = stream_id {
            segments.retain(|segment| segment.stream_id == stream_id);
        }
        Ok(build_tail_query_result(
            segments,
            after_segment_id,
            limit,
            |segment| segment.segment_id.as_str(),
        ))
    }

    pub fn get_video_segments_for_timestamp(
        &self,
        session_id: Option<&str>,
        occurred_at_ms: u64,
        display_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<TestSessionVideoSegmentRecord>, SessionError> {
        if occurred_at_ms == 0 {
            return Err(SessionError::InvalidLookup(
                "occurred_at_ms must be greater than zero".to_string(),
            ));
        }

        let segments = self.get_video_segments(session_id, None, None)?;
        Ok(rank_video_segments_for_timestamp(
            segments,
            occurred_at_ms,
            display_id,
            limit,
        ))
    }

    pub fn sync_pause_if_active(&self) -> Result<Option<TestSessionRecord>, SessionError> {
        match self.pause() {
            Ok(record) => Ok(Some(record)),
            Err(SessionError::NoActiveSession) | Err(SessionError::AlreadyPaused) => Ok(None),
            Err(err) => Err(err),
        }
    }

    pub fn sync_resume_if_active(&self) -> Result<Option<TestSessionRecord>, SessionError> {
        match self.resume() {
            Ok(record) => Ok(Some(record)),
            Err(SessionError::NoActiveSession) | Err(SessionError::NotPaused) => Ok(None),
            Err(err) => Err(err),
        }
    }

    pub fn sync_stop_if_active(&self) -> Result<Option<TestSessionRecord>, SessionError> {
        match self.stop() {
            Ok(record) => Ok(Some(record)),
            Err(SessionError::NoActiveSession) => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn resolve_cached_events(
        &self,
        record: &TestSessionRecord,
    ) -> Result<Vec<TestSessionEventRecord>, SessionError> {
        let session_id = record.session_id.clone();
        {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            if let Some(events) = state.events_by_session.get(&session_id) {
                return Ok(events.clone());
            }
        }

        let events = load_events_from_storage(record)?.unwrap_or_default();
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        state
            .events_by_session
            .insert(session_id.clone(), events.clone());
        if let Some(fingerprint) = events_storage_fingerprint(record)? {
            state.event_storage_versions.insert(session_id, fingerprint);
        }
        Ok(events)
    }

    fn resolve_cached_video_streams(
        &self,
        record: &TestSessionRecord,
    ) -> Result<Vec<TestSessionVideoStreamRecord>, SessionError> {
        let session_id = record.session_id.clone();
        let cached = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            (
                state.video_streams_by_session.get(&session_id).cloned(),
                state
                    .video_stream_storage_versions
                    .get(&session_id)
                    .copied(),
            )
        };

        let storage_fingerprint = video_streams_storage_fingerprint(record)?;
        if let (Some(streams), Some(cached_fingerprint), Some(current_fingerprint)) =
            (&cached.0, cached.1, storage_fingerprint)
            && cached_fingerprint == current_fingerprint
        {
            return Ok(streams.clone());
        }

        let streams = load_video_streams_from_storage(record)?
            .or(cached.0)
            .unwrap_or_default();
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        state
            .video_streams_by_session
            .insert(session_id.clone(), streams.clone());
        if let Some(fingerprint) = storage_fingerprint {
            state
                .video_stream_storage_versions
                .insert(session_id, fingerprint);
        }
        Ok(streams)
    }

    fn resolve_cached_video_segments(
        &self,
        record: &TestSessionRecord,
    ) -> Result<Vec<TestSessionVideoSegmentRecord>, SessionError> {
        let session_id = record.session_id.clone();
        let (cached_segments, cached_segment_fingerprint) = {
            let state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            (
                state.video_segments_by_session.get(&session_id).cloned(),
                state
                    .video_segment_storage_versions
                    .get(&session_id)
                    .copied(),
            )
        };
        let mut streams = self.resolve_cached_video_streams(record)?;
        let segment_fingerprint = video_segments_storage_fingerprint(record)?;

        if let (Some(segments), Some(cached_fingerprint), Some(current_fingerprint)) = (
            &cached_segments,
            cached_segment_fingerprint,
            segment_fingerprint,
        ) && cached_fingerprint == current_fingerprint
        {
            return Ok(segments.clone());
        }

        let mut segments = load_video_segments_from_storage(record)?
            .or(cached_segments)
            .unwrap_or_default();
        if should_recover_video_segments(record, Some(&segments), &streams) {
            segments = recover_ffmpeg_loop_segments(record, &mut streams)?;
        }

        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        state
            .video_streams_by_session
            .insert(session_id.clone(), streams);
        state
            .video_segments_by_session
            .insert(session_id.clone(), segments.clone());
        if let Some(fingerprint) = video_streams_storage_fingerprint(record)? {
            state
                .video_stream_storage_versions
                .insert(session_id.clone(), fingerprint);
        }
        if let Some(fingerprint) = video_segments_storage_fingerprint(record)? {
            state
                .video_segment_storage_versions
                .insert(session_id, fingerprint);
        }
        Ok(segments)
    }

    fn update_active<F>(&self, mut updater: F) -> Result<TestSessionRecord, SessionError>
    where
        F: FnMut(&mut TestSessionRecord, u64) -> Result<(), SessionError>,
    {
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let now_ms = now_timestamp_ms();
        let (session_id, event, record) = {
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            updater(active, now_ms)?;
            let event_type = match active.status {
                TestSessionStatus::Active => TestSessionEventType::SessionResumed,
                TestSessionStatus::Paused => TestSessionEventType::SessionPaused,
                TestSessionStatus::Stopped => TestSessionEventType::SessionStopped,
            };
            let session_id = active.session_id.clone();
            let event =
                self.create_lifecycle_event(&session_id, event_type, now_ms, active.status.clone());
            append_event_to_storage(active, &event)?;
            persist_manifest(active)?;
            (session_id, event, active.clone())
        };

        push_event(&mut state.events_by_session, session_id, event);
        Ok(record)
    }

    fn next_session_id(&self, now_ms: u64) -> String {
        let suffix = self.session_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("ts-{now_ms}-{suffix}")
    }

    fn next_event_id(&self, now_ms: u64) -> String {
        let suffix = self.event_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("evt-{now_ms}-{suffix}")
    }

    fn next_override_id(&self, now_ms: u64) -> String {
        let suffix = self.event_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("override-{now_ms}-{suffix}")
    }

    fn create_lifecycle_event(
        &self,
        session_id: &str,
        event_type: TestSessionEventType,
        occurred_at_ms: u64,
        status: TestSessionStatus,
    ) -> TestSessionEventRecord {
        TestSessionEventRecord::new_lifecycle(
            self.next_event_id(occurred_at_ms),
            session_id.to_string(),
            event_type,
            occurred_at_ms,
            status,
        )
    }

    fn append_custom_event<F>(
        &self,
        now_ms: u64,
        build_event: F,
    ) -> Result<TestSessionEventRecord, SessionError>
    where
        F: FnOnce(String) -> TestSessionEventRecord,
    {
        let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
        let event = {
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            active.updated_at_ms = now_ms;
            let event = build_event(active.session_id.clone());
            append_event_to_storage(active, &event)?;
            persist_manifest(active)?;
            event
        };
        push_event(
            &mut state.events_by_session,
            event.session_id.clone(),
            event.clone(),
        );
        Ok(event)
    }

    fn on_session_started(
        &self,
        record: &TestSessionRecord,
        streams: &[TestSessionVideoStreamRecord],
    ) {
        if let Err(err) = self.start_video_runtime(record, streams) {
            let _ = self.append_app_log(TestSessionLogInput {
                level: Some("warn".to_string()),
                source: Some("video-runtime".to_string()),
                message: Some(format!(
                    "video runtime is unavailable; continuing without continuous segment capture: {err}"
                )),
            });
        }
        if let Err(err) = self.start_system_event_runtime() {
            let _ = self.append_app_log(TestSessionLogInput {
                level: Some("warn".to_string()),
                source: Some("system-events".to_string()),
                message: Some(format!(
                    "system event listeners are unavailable; continuing without WinEventHook/clipboard capture: {err}"
                )),
            });
        }
        if crate::session::is_defect_evidence_enabled()
            && let Err(err) = self.start_keyboard_summary_runtime()
        {
            let _ = self.append_app_log(TestSessionLogInput {
                level: Some("warn".to_string()),
                source: Some("keyboard-summary".to_string()),
                message: Some(format!(
                    "keyboard summary is unavailable; continuing without keyboard step capture: {err}"
                )),
            });
        }
        if crate::session::defect_config::is_semantic_recording_enabled()
            && crate::session::defect_config::is_uia_observer_enabled()
            && let Err(err) = self.start_uia_observer_runtime(record)
        {
            let _ = self.append_app_log(TestSessionLogInput {
                level: Some("warn".to_string()),
                source: Some("uia-observer".to_string()),
                message: Some(format!(
                    "UIA observer is unavailable; continuing without continuous semantic events: {err}"
                )),
            });
        }
    }

    #[cfg(not(test))]
    fn start_system_event_runtime(&self) -> Result<(), SystemEventListenerError> {
        let mut runtime = self
            .system_runtime
            .lock()
            .map_err(|_| SystemEventListenerError::ThreadStartFailed)?;
        runtime.ensure_started()
    }

    #[cfg(test)]
    fn start_system_event_runtime(&self) -> Result<(), SystemEventListenerError> {
        Ok(())
    }

    #[cfg(not(test))]
    fn start_keyboard_summary_runtime(&self) -> Result<(), KeyboardSummaryError> {
        let mut runtime = self
            .keyboard_runtime
            .lock()
            .map_err(|_| KeyboardSummaryError::ThreadStartFailed)?;
        runtime.ensure_started()
    }

    #[cfg(test)]
    fn start_keyboard_summary_runtime(&self) -> Result<(), KeyboardSummaryError> {
        Ok(())
    }

    fn maybe_follow_observer_target(&self, event: &TestSessionEventRecord) {
        if event.event_type != TestSessionEventType::WindowForegroundChanged {
            return;
        }
        if !crate::session::defect_config::is_semantic_recording_enabled()
            || !crate::session::defect_config::is_uia_observer_enabled()
        {
            return;
        }
        let Some(pid) = event.window_pid.filter(|value| *value != 0) else {
            return;
        };
        if pid == std::process::id() {
            return;
        }

        let record = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let Some(active) = state.active.as_mut() else {
                return;
            };
            if active.status != TestSessionStatus::Active {
                return;
            }
            if let Some(bound) = bound_target_process_name(active.target_process_name.as_deref()) {
                let Some(process_name) = event.process_name.as_deref() else {
                    return;
                };
                if !process_names_match(&bound, process_name) {
                    return;
                }
            } else if !should_follow_foreground_observer_pid(active) {
                return;
            }

            let hwnd_changed = event
                .window_hwnd
                .as_deref()
                .is_some_and(|hwnd| active.target_hwnd.as_deref() != Some(hwnd));
            if active.target_pid == Some(pid) && !hwnd_changed {
                return;
            }

            active.target_pid = Some(pid);
            if let Some(hwnd) = event.window_hwnd.clone() {
                active.target_hwnd = Some(hwnd);
            }
            let _ = persist_manifest(active);
            active.clone()
        };

        if let Err(err) = self.start_uia_observer_runtime(&record) {
            let _ = self.append_app_log(TestSessionLogInput {
                level: Some("warn".to_string()),
                source: Some("uia-observer".to_string()),
                message: Some(format!(
                    "UIA observer could not follow foreground pid {pid}: {err}"
                )),
            });
        }
    }

    fn start_uia_observer_runtime(
        &self,
        record: &TestSessionRecord,
    ) -> Result<(), UiaObserverError> {
        let mut runtime = self
            .uia_observer_runtime
            .lock()
            .map_err(|_| UiaObserverError::ThreadStartFailed)?;
        runtime.ensure_started(record)
    }

    fn flush_uia_observer_runtime(&self) -> Result<(), SessionError> {
        let mut runtime = self
            .uia_observer_runtime
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?;
        runtime.flush()?;
        Ok(())
    }

    fn set_uia_observer_paused(&self, paused: bool) {
        if let Ok(mut runtime) = self.uia_observer_runtime.lock() {
            let _ = runtime.set_paused(paused);
        }
    }

    fn cancel_interaction_compensation_polls(&self) {
        if let Ok(mut runtime) = self.uia_observer_runtime.lock() {
            let _ = runtime.cancel_interaction_polls();
        }
    }

    fn schedule_interaction_compensation_poll(&self, source_event_id: &str, x: i32, y: i32) {
        if !crate::session::defect_config::is_semantic_recording_enabled()
            || !crate::session::defect_config::is_uia_observer_enabled()
        {
            return;
        }
        if let Ok(mut runtime) = self.uia_observer_runtime.lock()
            && runtime.is_running()
        {
            let _ = runtime.schedule_interaction_poll(source_event_id, x, y);
        }
    }

    /// Fire-and-forget pre-state snapshot for mouse-down. Never blocks the input hook.
    fn request_mouse_down_pre_state_async(&self, event: &TestSessionEventRecord, x: i32, y: i32) {
        // Fire whenever semantic/defect capture is on. Builder flag alone used to gate this,
        // but Electron never enabled builder → no pre-state UIA, no alias match on clicks.
        if !crate::session::defect_config::is_semantic_recording_enabled()
            && !crate::session::is_defect_evidence_enabled()
        {
            return;
        }

        let session_id = event.session_id.clone();
        let source_event_id = event.event_id.clone();
        let occurred_at_ms = event.occurred_at_ms;
        // Capture Manager pointer lifetime via global singleton used by the process.
        std::thread::Builder::new()
            .name("shadow-uia-pre-state".to_string())
            .spawn(move || {
                let snapshot = uia_enricher::capture_at_point(x, y);
                let mut payload = serde_json::Map::new();
                payload.insert(
                    "source".to_string(),
                    serde_json::Value::String("mouse-down-pre-state".to_string()),
                );
                payload.insert("x".to_string(), serde_json::Value::from(x));
                payload.insert("y".to_string(), serde_json::Value::from(y));
                let (target, privacy_class) = if let Some(snapshot) = snapshot {
                    payload.insert(
                        "hitQuality".to_string(),
                        serde_json::Value::String(snapshot.hit_quality.as_str().to_string()),
                    );
                    if let Some(name) = snapshot.control_name.clone() {
                        payload.insert("name".to_string(), serde_json::Value::String(name));
                    }
                    if let Some(automation_id) = snapshot.automation_id.clone() {
                        payload.insert(
                            "automationId".to_string(),
                            serde_json::Value::String(automation_id),
                        );
                    }
                    if let Some(control_type) = snapshot.control_type.clone() {
                        payload.insert(
                            "controlType".to_string(),
                            serde_json::Value::String(control_type),
                        );
                    }
                    if let Some(class_name) = snapshot.class_name.clone() {
                        payload.insert(
                            "className".to_string(),
                            serde_json::Value::String(class_name),
                        );
                    }
                    if !snapshot.is_password {
                        if let Some(ref text) = snapshot.value_text {
                            payload.insert(
                                "valueText".to_string(),
                                serde_json::Value::String(text.clone()),
                            );
                        }
                        if let Some(length) = snapshot.value_length {
                            payload
                                .insert("valueLength".to_string(), serde_json::Value::from(length));
                        }
                        if let Some(ref names) = snapshot.selected_names {
                            payload.insert(
                                "selectedNames".to_string(),
                                serde_json::Value::Array(
                                    names
                                        .iter()
                                        .cloned()
                                        .map(serde_json::Value::String)
                                        .collect(),
                                ),
                            );
                        }
                    }
                    let identity = snapshot.to_identity();
                    let state = snapshot
                        .to_state_snapshot(format!("state-pre-{source_event_id}"), occurred_at_ms);
                    let privacy_class = state.privacy_class.clone();
                    if let Ok(value) = serde_json::to_value(&state) {
                        payload.insert("stateSnapshot".to_string(), value);
                    }
                    (Some(identity), privacy_class)
                } else {
                    (
                        None,
                        crate::session::operation_models::PrivacyClass::Unknown,
                    )
                };

                let semantic = SemanticEventRecord {
                    schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
                    kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
                    event_id: format!("sem-pre-{source_event_id}"),
                    session_id,
                    event_type: SemanticEventType::UiaSnapshot,
                    // Keep action-time so correlator can treat this as stateBefore.
                    occurred_at_ms,
                    monotonic_offset_ms: None,
                    source_event_id: Some(source_event_id),
                    target,
                    payload: serde_json::Value::Object(payload),
                    privacy_class,
                    reason_codes: vec![
                        crate::session::operation_models::OperationReasonCode::PointHit,
                    ],
                };
                let _ = TEST_SESSION_MANAGER.append_semantic_event(semantic);
            })
            .ok();
    }

    fn stop_uia_observer_runtime(&self) {
        if let Ok(mut runtime) = self.uia_observer_runtime.lock() {
            let _ = runtime.stop();
        }
    }

    fn enqueue_semantic_event_in_runtime(
        &self,
        event: SemanticEventRecord,
    ) -> Result<bool, SessionError> {
        let mut runtime = self
            .uia_observer_runtime
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?;
        if !runtime.is_running() {
            return Ok(false);
        }
        runtime.enqueue_event(event)?;
        Ok(true)
    }

    #[cfg(not(test))]
    fn stop_system_event_runtime(&self) {
        if let Ok(mut runtime) = self.system_runtime.lock() {
            runtime.stop();
        }
        if let Ok(mut runtime) = self.keyboard_runtime.lock() {
            runtime.stop();
        }
    }

    #[cfg(test)]
    fn stop_system_event_runtime(&self) {}

    #[cfg(not(test))]
    fn start_video_runtime(
        &self,
        record: &TestSessionRecord,
        streams: &[TestSessionVideoStreamRecord],
    ) -> Result<(), SessionError> {
        let mut runtime = self
            .ffmpeg_loop_runtime
            .lock()
            .map_err(|_| FfmpegLoopRuntimeError::ThreadStartFailed)?;
        runtime.ensure_started(record.clone(), streams.to_vec())?;
        Ok(())
    }

    #[cfg(test)]
    fn start_video_runtime(
        &self,
        _record: &TestSessionRecord,
        _streams: &[TestSessionVideoStreamRecord],
    ) -> Result<(), SessionError> {
        Ok(())
    }

    #[cfg(not(test))]
    fn stop_video_runtime(&self) {
        if let Ok(mut runtime) = self.ffmpeg_loop_runtime.lock() {
            runtime.stop();
        }
    }

    #[cfg(test)]
    fn stop_video_runtime(&self) {}

    #[cfg(not(test))]
    fn set_video_runtime_paused(&self, paused: bool) {
        if let Ok(runtime) = self.ffmpeg_loop_runtime.lock() {
            runtime.set_paused(paused);
        }
    }

    #[cfg(test)]
    fn set_video_runtime_paused(&self, _paused: bool) {}

    #[cfg(not(test))]
    fn set_video_runtime_session(&self, record: &TestSessionRecord) {
        if let Ok(runtime) = self.ffmpeg_loop_runtime.lock() {
            runtime.update_session(record.clone());
        }
    }

    #[cfg(test)]
    fn set_video_runtime_session(&self, _record: &TestSessionRecord) {}
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            session_counter: AtomicU64::new(0),
            event_counter: AtomicU64::new(0),
            system_runtime: Mutex::new(SystemEventRuntime::default()),
            keyboard_runtime: Mutex::new(KeyboardSummaryRuntime::default()),
            ffmpeg_loop_runtime: Mutex::new(FfmpegLoopRuntime::default()),
            uia_observer_runtime: Mutex::new(UiaObserverRuntime::default()),
            staged_video_privacy: Mutex::new((false, Vec::new())),
        }
    }
}

fn should_resolve_target_pid_from_process_name(options: &TestSessionStartOptions) -> bool {
    options.target_pid.is_none()
        && options
            .target_process_name
            .as_deref()
            .is_some_and(|process_name| !process_name.trim().is_empty())
}

fn bound_target_process_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn foreground_process_matches_session(
    options: &TestSessionStartOptions,
    process_name: &str,
) -> bool {
    match bound_target_process_name(options.target_process_name.as_deref()) {
        Some(bound) => process_names_match(&bound, process_name),
        None => true,
    }
}

fn should_follow_foreground_observer_pid(record: &TestSessionRecord) -> bool {
    bound_target_process_name(record.target_process_name.as_deref()).is_none()
}

fn is_mouse_button_down_action(action: &str) -> bool {
    action.eq_ignore_ascii_case("WM_LBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_RBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_MBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_LBUTTONDBLCLK")
}


fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
