use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

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
    TestSessionRecord, TestSessionStartOptions, TestSessionStatus, TestSessionStepRecord,
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

#[derive(Debug)]
pub enum SessionError {
    AlreadyActive(String),
    NoActiveSession,
    SessionNotFound(String),
    InvalidLookup(String),
    AlreadyPaused,
    NotPaused,
    LockPoisoned,
    Io(io::Error),
    Serialize(serde_json::Error),
    FfmpegLoopRuntime(FfmpegLoopRuntimeError),
    DefectPack(DefectPackError),
    SemanticEventStore(SemanticEventStoreError),
    UiaObserver(UiaObserverError),
    OperationStore(OperationStoreError),
    OperationOverride(OperationOverrideError),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyActive(session_id) => {
                write!(f, "test session is already active: {session_id}")
            }
            Self::NoActiveSession => write!(f, "test session is not active"),
            Self::SessionNotFound(session_id) => write!(f, "test session not found: {session_id}"),
            Self::InvalidLookup(message) => write!(f, "test session lookup is invalid: {message}"),
            Self::AlreadyPaused => write!(f, "test session is already paused"),
            Self::NotPaused => write!(f, "test session is not paused"),
            Self::LockPoisoned => write!(f, "test session state lock is poisoned"),
            Self::Io(err) => write!(f, "test session io failed: {err}"),
            Self::Serialize(err) => write!(f, "test session serialization failed: {err}"),
            Self::FfmpegLoopRuntime(err) => write!(f, "ffmpeg loop runtime failed: {err}"),
            Self::DefectPack(err) => write!(f, "defect pack failed: {err}"),
            Self::SemanticEventStore(err) => write!(f, "semantic event store failed: {err}"),
            Self::UiaObserver(err) => write!(f, "UIA observer failed: {err}"),
            Self::OperationStore(err) => write!(f, "operation store failed: {err}"),
            Self::OperationOverride(err) => write!(f, "operation override failed: {err}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<io::Error> for SessionError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for SessionError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialize(value)
    }
}

impl From<FfmpegLoopRuntimeError> for SessionError {
    fn from(value: FfmpegLoopRuntimeError) -> Self {
        Self::FfmpegLoopRuntime(value)
    }
}

impl From<DefectPackError> for SessionError {
    fn from(value: DefectPackError) -> Self {
        Self::DefectPack(value)
    }
}

impl From<SemanticEventStoreError> for SessionError {
    fn from(value: SemanticEventStoreError) -> Self {
        Self::SemanticEventStore(value)
    }
}

impl From<UiaObserverError> for SessionError {
    fn from(value: UiaObserverError) -> Self {
        Self::UiaObserver(value)
    }
}

impl From<OperationStoreError> for SessionError {
    fn from(value: OperationStoreError) -> Self {
        Self::OperationStore(value)
    }
}

impl From<OperationOverrideError> for SessionError {
    fn from(value: OperationOverrideError) -> Self {
        Self::OperationOverride(value)
    }
}

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

        let record = TestSessionRecord::from_start_options(
            session_id,
            now_ms,
            options,
            session_dir,
            manifest_path,
        );
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

        let (event, window_start_ms, window_end_ms) = {
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
                push_event(&mut state.events_by_session, session_id, event.clone());
                (event, window_start_ms, window_end_ms)
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
                (event, window_start_ms, window_end_ms)
            }
        };

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

fn prepare_session_storage(
    storage_root_dir: Option<&str>,
    session_id: &str,
) -> Result<(Option<String>, Option<String>), SessionError> {
    let Some(storage_root_dir) = storage_root_dir else {
        return Ok((None, None));
    };

    let root_dir = PathBuf::from(storage_root_dir);
    fs::create_dir_all(&root_dir)?;

    let session_dir = root_dir.join(session_id);
    fs::create_dir_all(&session_dir)?;
    fs::create_dir_all(session_dir.join("artifacts"))?;
    fs::create_dir_all(session_dir.join("events"))?;
    fs::create_dir_all(session_dir.join("segments"))?;
    fs::create_dir_all(session_dir.join("video"))?;
    fs::create_dir_all(session_dir.join("video").join("streams"))?;

    let events_index = session_dir.join("events.ndjson");
    if !events_index.exists() {
        fs::write(&events_index, b"")?;
    }

    let steps_index = session_dir.join("steps.ndjson");
    if !steps_index.exists() {
        fs::write(&steps_index, b"")?;
    }

    let video_streams_index = session_dir.join("video").join("streams.json");
    if !video_streams_index.exists() {
        fs::write(&video_streams_index, b"[]")?;
    }

    let video_segments_index = session_dir.join("video").join("segments.ndjson");
    if !video_segments_index.exists() {
        fs::write(&video_segments_index, b"")?;
    }

    let manifest_path = session_dir.join("session.json");
    Ok((
        Some(path_to_string(&session_dir)),
        Some(path_to_string(&manifest_path)),
    ))
}

fn persist_manifest(record: &TestSessionRecord) -> Result<(), SessionError> {
    let Some(manifest_path) = record.manifest_path.as_deref() else {
        return Ok(());
    };

    let manifest_path = Path::new(manifest_path);
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_vec_pretty(record)?;
    fs::write(manifest_path, content)?;
    Ok(())
}

fn append_event_to_storage(
    record: &TestSessionRecord,
    event: &TestSessionEventRecord,
) -> Result<(), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(());
    };

    let events_path = Path::new(session_dir).join("events.ndjson");
    if let Some(parent) = events_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path)?;
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn persist_steps_to_storage(
    record: &TestSessionRecord,
    steps: &[TestSessionStepRecord],
) -> Result<(), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(());
    };

    let steps_path = Path::new(session_dir).join("steps.ndjson");
    if let Some(parent) = steps_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = fs::File::create(steps_path)?;
    for step in steps {
        serde_json::to_writer(&mut file, step)?;
        file.write_all(b"\n")?;
    }
    Ok(())
}

fn persist_step_artifacts(
    record: &TestSessionRecord,
    step: &StepData,
) -> Result<(Option<String>, Option<String>), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok((None, None));
    };

    let artifacts_dir = Path::new(session_dir).join("artifacts");
    fs::create_dir_all(&artifacts_dir)?;

    let full_image_path = if step.image_webp.is_empty() {
        None
    } else {
        let path = artifacts_dir.join(format!("step-{}-full.webp", step.id));
        fs::write(&path, &step.image_webp)?;
        Some(path_to_string(&path))
    };

    let thumb_image_path = if step.image_thumb_webp.is_empty() {
        None
    } else {
        let path = artifacts_dir.join(format!("step-{}-thumb.webp", step.id));
        fs::write(&path, &step.image_thumb_webp)?;
        Some(path_to_string(&path))
    };

    Ok((full_image_path, thumb_image_path))
}

fn push_event(
    events_by_session: &mut HashMap<String, Vec<TestSessionEventRecord>>,
    session_id: String,
    event: TestSessionEventRecord,
) {
    let events = events_by_session.entry(session_id).or_default();
    events.push(event);
    if events.len() > EVENT_HISTORY_LIMIT_PER_SESSION {
        let overflow = events.len().saturating_sub(EVENT_HISTORY_LIMIT_PER_SESSION);
        events.drain(0..overflow);
    }
}

fn resolve_session_record(
    state: &SessionState,
    session_id: Option<&str>,
) -> Result<TestSessionRecord, SessionError> {
    match session_id {
        Some(target) => {
            if let Some(active) = state.active.as_ref()
                && active.session_id == target
            {
                return Ok(active.clone());
            }

            state
                .history
                .iter()
                .find(|record| record.session_id == target)
                .cloned()
                .ok_or_else(|| SessionError::SessionNotFound(target.to_string()))
        }
        None => state.active.clone().ok_or(SessionError::NoActiveSession),
    }
}

fn build_tail_query_result<T, F>(
    items: Vec<T>,
    after_id: Option<&str>,
    limit: Option<usize>,
    resolve_id: F,
) -> TailQueryResult<T>
where
    T: Clone,
    F: Fn(&T) -> &str,
{
    let total_count = items.len();
    let normalized_after_id = after_id.map(str::trim).filter(|value| !value.is_empty());

    if let Some(after_id) = normalized_after_id
        && let Some(position) = items.iter().position(|item| resolve_id(item) == after_id)
    {
        let mut tail_items = items.into_iter().skip(position + 1).collect::<Vec<_>>();
        apply_event_limit(&mut tail_items, limit);
        let next_cursor = tail_items
            .last()
            .map(|item| resolve_id(item).to_string())
            .or_else(|| Some(after_id.to_string()));
        return TailQueryResult {
            items: tail_items,
            next_cursor,
            reset: false,
            total_count,
        };
    }

    let mut snapshot_items = items;
    apply_event_limit(&mut snapshot_items, limit);
    TailQueryResult {
        next_cursor: snapshot_items
            .last()
            .map(|item| resolve_id(item).to_string()),
        items: snapshot_items,
        reset: true,
        total_count,
    }
}

fn events_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("events.ndjson")),
    )
}

fn video_streams_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("video").join("streams.json")),
    )
}

fn video_segments_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("video").join("segments.ndjson")),
    )
}

fn storage_fingerprint_for_path(
    path: Option<PathBuf>,
) -> Result<Option<StorageFingerprint>, SessionError> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(path)?;
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    Ok(Some(StorageFingerprint {
        len: metadata.len(),
        modified_at_ms,
    }))
}

fn load_events_from_storage(
    record: &TestSessionRecord,
) -> Result<Option<Vec<TestSessionEventRecord>>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(None);
    };

    let events_path = Path::new(session_dir).join("events.ndjson");
    if !events_path.exists() {
        return Ok(None);
    }

    let file = fs::File::open(events_path)?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: TestSessionEventRecord = serde_json::from_str(&line)?;
        events.push(event);
    }

    Ok(Some(events))
}

#[allow(dead_code)]
fn load_semantic_events_from_storage(
    record: &TestSessionRecord,
) -> Result<Vec<SemanticEventRecord>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(Vec::new());
    };

    let report = SemanticEventStore::for_session_dir(session_dir).read()?;
    Ok(report.events)
}

fn load_operation_overrides_from_storage(
    record: &TestSessionRecord,
) -> Result<Vec<crate::session::OperationOverrideRecord>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(Vec::new());
    };

    Ok(OperationOverrideStore::for_session_dir(session_dir)
        .read()?
        .overrides)
}

fn load_operations_from_storage(
    record: &TestSessionRecord,
) -> Result<Option<OperationStoreReadReport>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(None);
    };

    let store = OperationStore::for_session_dir(session_dir);
    if !store.path().exists() {
        return Ok(None);
    }

    Ok(Some(store.read_compatible()?))
}

fn persist_operations_to_storage(
    record: &TestSessionRecord,
    operations: &[TestSessionOperationRecord],
) -> Result<(), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(());
    };

    OperationStore::for_session_dir(session_dir).persist_atomic(operations)?;
    Ok(())
}

fn has_operation_override_changes(changes: &OperationOverrideChanges) -> bool {
    changes
        .title
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || changes
            .result_summary
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || changes.selected_outcome_status.is_some()
        || changes.selected_transition_id.is_some()
        || changes.ignored.is_some()
        || changes.business_alias.is_some()
        || changes.note.is_some()
}

fn resolve_operation_id_alias(
    operations: &[TestSessionOperationRecord],
    session_id: &str,
    requested_id: &str,
) -> Option<String> {
    let requested_id = requested_id.trim();
    if requested_id.is_empty() {
        return None;
    }

    if let Some(operation) = operations
        .iter()
        .find(|operation| operation.operation_id == requested_id)
    {
        return Some(operation.operation_id.clone());
    }

    if let Some(operation) = operations
        .iter()
        .find(|operation| projected_step_id_for_operation(&operation.operation_id) == requested_id)
    {
        return Some(operation.operation_id.clone());
    }

    if let Some(ordinal) = legacy_step_ordinal(session_id, requested_id) {
        if let Some(operation) = operations
            .iter()
            .find(|operation| usize::try_from(operation.sequence).ok() == Some(ordinal))
        {
            return Some(operation.operation_id.clone());
        }
        if let Some(operation) = operations.get(ordinal.saturating_sub(1)) {
            return Some(operation.operation_id.clone());
        }
    }

    None
}

fn resolve_step_index_alias(
    steps: &[TestSessionStepRecord],
    session_id: &str,
    requested_step_id: &str,
) -> Option<usize> {
    let requested_step_id = requested_step_id.trim();
    if requested_step_id.is_empty() {
        return None;
    }

    if let Some(index) = steps
        .iter()
        .position(|step| step.step_id == requested_step_id)
    {
        return Some(index);
    }

    let projected_from_operation_id = projected_step_id_for_operation(requested_step_id);
    if let Some(index) = steps
        .iter()
        .position(|step| step.step_id == projected_from_operation_id)
    {
        return Some(index);
    }

    legacy_step_ordinal(session_id, requested_step_id)
        .and_then(|ordinal| ordinal.checked_sub(1))
        .filter(|index| *index < steps.len())
}

fn find_compatible_previous_step_edit<'a>(
    step: &TestSessionStepRecord,
    step_index: usize,
    session_id: &str,
    previous_edits: &'a HashMap<String, TestSessionStepRecord>,
    previous_edited_steps: &'a [TestSessionStepRecord],
    applied_previous_step_ids: &HashSet<String>,
) -> Option<&'a TestSessionStepRecord> {
    if let Some(edited) = previous_edits.get(&step.step_id)
        && !applied_previous_step_ids.contains(&edited.step_id)
    {
        return Some(edited);
    }

    let source_matches = previous_edited_steps
        .iter()
        .filter(|edited| !applied_previous_step_ids.contains(&edited.step_id))
        .filter(|edited| step_source_events_overlap(step, edited))
        .collect::<Vec<_>>();
    if source_matches.len() == 1 {
        return source_matches.first().copied();
    }

    let legacy_step_id = format!("step-{session_id}-{}", step_index + 1);
    if let Some(edited) = previous_edits.get(&legacy_step_id)
        && !applied_previous_step_ids.contains(&edited.step_id)
    {
        return Some(edited);
    }

    None
}

fn apply_previous_step_edit(step: &mut TestSessionStepRecord, edited: &TestSessionStepRecord) {
    let auto_title = step.title.clone();
    step.title = edited.title.clone();
    step.summary = edited.summary.clone();
    step.edited = true;
    step.original_title = edited.original_title.clone().or(Some(auto_title));
    step.business_alias = edited.business_alias.clone();
}

fn step_source_events_overlap(left: &TestSessionStepRecord, right: &TestSessionStepRecord) -> bool {
    if left.source_event_ids.is_empty() || right.source_event_ids.is_empty() {
        return false;
    }
    left.source_event_ids.iter().any(|event_id| {
        right
            .source_event_ids
            .iter()
            .any(|candidate| candidate == event_id)
    })
}

fn projected_step_id_for_operation(operation_id: &str) -> String {
    format!("step-{operation_id}")
}

fn legacy_step_ordinal(session_id: &str, step_id: &str) -> Option<usize> {
    let prefix = format!("step-{session_id}-");
    let suffix = step_id.strip_prefix(&prefix)?;
    let ordinal = suffix.parse::<usize>().ok()?;
    (ordinal > 0).then_some(ordinal)
}

fn bootstrap_video_streams(record: &TestSessionRecord) -> Vec<TestSessionVideoStreamRecord> {
    let displays = enumerate_display_targets();
    build_video_stream_plan(record, &displays)
}

fn persist_video_streams(
    record: &TestSessionRecord,
    streams: &[TestSessionVideoStreamRecord],
) -> Result<(), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(());
    };

    let streams_path = Path::new(session_dir).join("video").join("streams.json");
    if let Some(parent) = streams_path.parent() {
        fs::create_dir_all(parent)?;
    }

    for stream in streams {
        if let Some(stream_dir) = stream.stream_dir.as_deref() {
            fs::create_dir_all(stream_dir)?;
        }
        if let Some(manifest_path) = stream.manifest_path.as_deref() {
            if let Some(parent) = Path::new(manifest_path).parent() {
                fs::create_dir_all(parent)?;
            }
            let content = serde_json::to_vec_pretty(stream)?;
            fs::write(manifest_path, content)?;
        }
    }

    let content = serde_json::to_vec_pretty(streams)?;
    fs::write(streams_path, content)?;
    Ok(())
}

fn load_video_streams_from_storage(
    record: &TestSessionRecord,
) -> Result<Option<Vec<TestSessionVideoStreamRecord>>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(None);
    };

    let streams_path = Path::new(session_dir).join("video").join("streams.json");
    if !streams_path.exists() {
        return Ok(None);
    }

    let content = fs::read(streams_path)?;
    let streams: Vec<TestSessionVideoStreamRecord> = serde_json::from_slice(&content)?;
    Ok(Some(streams))
}

fn load_video_segments_from_storage(
    record: &TestSessionRecord,
) -> Result<Option<Vec<TestSessionVideoSegmentRecord>>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(None);
    };

    let segments_path = Path::new(session_dir).join("video").join("segments.ndjson");
    if !segments_path.exists() {
        return Ok(None);
    }

    let file = fs::File::open(segments_path)?;
    let reader = BufReader::new(file);
    let mut segments = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let segment: TestSessionVideoSegmentRecord = serde_json::from_str(&line)?;
        segments.push(segment);
    }

    Ok(Some(segments))
}

fn should_recover_video_segments(
    record: &TestSessionRecord,
    persisted_segments: Option<&Vec<TestSessionVideoSegmentRecord>>,
    streams: &[TestSessionVideoStreamRecord],
) -> bool {
    if record.status != TestSessionStatus::Stopped || streams.is_empty() {
        return false;
    }

    match persisted_segments {
        None => true,
        Some(segments) => segments.is_empty(),
    }
}

fn apply_event_limit<T>(events: &mut Vec<T>, limit: Option<usize>) {
    if let Some(limit) = limit {
        if limit == 0 {
            events.clear();
            return;
        }

        if events.len() > limit {
            let start = events.len().saturating_sub(limit);
            events.drain(0..start);
        }
    }
}

fn rank_video_segments_for_timestamp(
    segments: Vec<TestSessionVideoSegmentRecord>,
    occurred_at_ms: u64,
    display_id: Option<&str>,
    limit: Option<usize>,
) -> Vec<TestSessionVideoSegmentRecord> {
    let mut ranked = segments
        .into_iter()
        .filter_map(|segment| {
            let distance_ms = segment_time_distance_ms(&segment, occurred_at_ms);
            let exact_overlap = distance_ms == 0;
            let display_rank = display_match_rank(display_id, segment.display_id.as_deref());
            let max_distance_ms = if exact_overlap {
                0
            } else {
                u64::from(segment.duration_ms.max(1))
                    .saturating_mul(2)
                    .max(15_000)
            };

            if !exact_overlap && distance_ms > max_distance_ms {
                return None;
            }

            Some((
                display_rank,
                distance_ms,
                std::cmp::Reverse(segment.started_at_ms),
                segment,
            ))
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });

    let mut resolved = ranked
        .into_iter()
        .map(|(_, _, _, segment)| segment)
        .collect::<Vec<_>>();
    if let Some(limit) = limit {
        if limit == 0 {
            resolved.clear();
        } else if resolved.len() > limit {
            resolved.truncate(limit);
        }
    }
    resolved
}

fn segment_time_distance_ms(segment: &TestSessionVideoSegmentRecord, occurred_at_ms: u64) -> u64 {
    if occurred_at_ms < segment.started_at_ms {
        segment.started_at_ms.saturating_sub(occurred_at_ms)
    } else if occurred_at_ms > segment.ended_at_ms {
        occurred_at_ms.saturating_sub(segment.ended_at_ms)
    } else {
        0
    }
}

fn display_match_rank(requested_display_id: Option<&str>, segment_display_id: Option<&str>) -> u8 {
    match (requested_display_id, segment_display_id) {
        (Some(requested), Some(candidate)) if requested == candidate => 0,
        (Some(_), Some(_)) => 1,
        (Some(_), None) => 2,
        (None, _) => 0,
    }
}

fn push_history(history: &mut Vec<TestSessionRecord>, record: TestSessionRecord) {
    history.push(record);
    if history.len() > HISTORY_LIMIT {
        let overflow = history.len().saturating_sub(HISTORY_LIMIT);
        history.drain(0..overflow);
    }
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

#[cfg(test)]
mod tests {
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
    fn update_active_video_config_returns_none_without_active_session() {
        let manager = SessionManager::default();

        let updated = manager
            .update_active_video_config(
                Some("smooth".to_string()),
                Some("hardware".to_string()),
                Some(true),
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
        }
    }
}
