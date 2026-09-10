use serde::{Deserialize, Serialize};

use crate::types::StepData;

pub const TEST_SESSION_SCHEMA_VERSION: u32 = 1;
pub const TEST_SESSION_KIND: &str = "reqcase.test-session";
pub const TEST_SESSION_EVENT_KIND: &str = "reqcase.test-session-event";
#[allow(dead_code)]
pub const TEST_SESSION_STEP_KIND: &str = "reqcase.test-session-step";
pub const TEST_SESSION_VIDEO_STREAM_KIND: &str = "reqcase.test-session-video-stream";
#[allow(dead_code)]
pub const TEST_SESSION_VIDEO_SEGMENT_KIND: &str = "reqcase.test-session-video-segment";
pub const DEFAULT_BUFFER_WINDOW_SECONDS: u32 = 90;
pub const DEFAULT_SEGMENT_DURATION_SECONDS: u32 = 5;
pub const DEFAULT_TARGET_CAPTURE_MODE: &str = "target_display";
pub const DEFAULT_RECORDING_PROFILE: &str = "balanced";
pub const DEFAULT_ENCODER_PREFERENCE: &str = "auto";
pub const DEFAULT_SHOW_MOUSE_IN_VIDEO: bool = false;
pub const DEFAULT_DEFECT_PRE_WINDOW_SECONDS: u32 = 60;
pub const DEFAULT_DEFECT_POST_WINDOW_SECONDS: u32 = 20;

fn default_show_mouse_in_video() -> bool {
    DEFAULT_SHOW_MOUSE_IN_VIDEO
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestSessionStatus {
    Active,
    Paused,
    Stopped,
}

impl TestSessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TestSessionStartOptions {
    pub name: Option<String>,
    pub storage_dir: Option<String>,
    pub target_process_name: Option<String>,
    pub target_pid: Option<u32>,
    pub target_hwnd: Option<String>,
    pub target_display_id: Option<String>,
    pub target_display_ids: Option<Vec<String>>,
    pub target_capture_mode: Option<String>,
    pub buffer_window_seconds: Option<u32>,
    pub segment_duration_seconds: Option<u32>,
    pub recording_profile: Option<String>,
    pub encoder_preference: Option<String>,
    pub show_mouse_in_video: Option<bool>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionRecord {
    pub schema_version: u32,
    pub kind: String,
    pub session_id: String,
    pub name: Option<String>,
    pub status: TestSessionStatus,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub storage_root_dir: Option<String>,
    pub session_dir: Option<String>,
    pub manifest_path: Option<String>,
    pub buffer_window_seconds: u32,
    pub segment_duration_seconds: u32,
    pub recording_profile: String,
    pub encoder_preference: String,
    #[serde(default = "default_show_mouse_in_video")]
    pub show_mouse_in_video: bool,
    pub notes: Option<String>,
    pub target_process_name: Option<String>,
    pub target_pid: Option<u32>,
    pub target_hwnd: Option<String>,
    pub target_display_id: Option<String>,
    pub target_display_ids: Option<Vec<String>>,
    pub target_capture_mode: String,
}

impl TestSessionRecord {
    pub fn from_start_options(
        session_id: String,
        started_at_ms: u64,
        options: TestSessionStartOptions,
        session_dir: Option<String>,
        manifest_path: Option<String>,
    ) -> Self {
        let normalized_name = normalize_optional_string(options.name);
        let normalized_notes = normalize_optional_string(options.notes);
        let normalized_storage_root_dir = normalize_optional_string(options.storage_dir);
        let normalized_target_process_name = normalize_optional_string(options.target_process_name);
        let normalized_target_hwnd = normalize_optional_string(options.target_hwnd);
        let normalized_target_display_ids =
            normalize_optional_string_vec(options.target_display_ids);
        let normalized_target_display_id = normalize_optional_string(options.target_display_id)
            .or_else(|| {
                normalized_target_display_ids
                    .as_ref()
                    .and_then(|display_ids| display_ids.first().cloned())
            });
        let normalized_capture_mode = normalize_capture_mode(options.target_capture_mode);
        let normalized_recording_profile = normalize_recording_profile(options.recording_profile);
        let normalized_encoder_preference =
            normalize_encoder_preference(options.encoder_preference);
        let show_mouse_in_video = options
            .show_mouse_in_video
            .unwrap_or(DEFAULT_SHOW_MOUSE_IN_VIDEO);
        let buffer_window_seconds =
            normalize_duration(options.buffer_window_seconds, DEFAULT_BUFFER_WINDOW_SECONDS);
        let segment_duration_seconds = normalize_duration(
            options.segment_duration_seconds,
            DEFAULT_SEGMENT_DURATION_SECONDS,
        );

        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_KIND.to_string(),
            session_id,
            name: normalized_name,
            status: TestSessionStatus::Active,
            started_at_ms,
            updated_at_ms: started_at_ms,
            ended_at_ms: None,
            storage_root_dir: normalized_storage_root_dir,
            session_dir,
            manifest_path,
            buffer_window_seconds,
            segment_duration_seconds,
            recording_profile: normalized_recording_profile,
            encoder_preference: normalized_encoder_preference,
            show_mouse_in_video,
            notes: normalized_notes,
            target_process_name: normalized_target_process_name,
            target_pid: options.target_pid,
            target_hwnd: normalized_target_hwnd,
            target_display_id: normalized_target_display_id,
            target_display_ids: normalized_target_display_ids,
            target_capture_mode: normalized_capture_mode,
        }
    }
}

fn normalize_duration(value: Option<u32>, default_value: u32) -> u32 {
    value.unwrap_or(default_value).max(1)
}

pub fn normalize_recording_profile(value: Option<String>) -> String {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("efficiency") => "efficiency".to_string(),
        Some("smooth") => "smooth".to_string(),
        _ => DEFAULT_RECORDING_PROFILE.to_string(),
    }
}

pub fn normalize_encoder_preference(value: Option<String>) -> String {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("hardware") => "hardware".to_string(),
        Some("software") => "software".to_string(),
        _ => DEFAULT_ENCODER_PREFERENCE.to_string(),
    }
}

pub fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|input| {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub fn normalize_optional_string_vec(values: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut normalized = values
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| normalize_optional_string(Some(value)))
        .fold(Vec::new(), |mut collected, value| {
            if !collected.contains(&value) {
                collected.push(value);
            }
            collected
        });

    if normalized.is_empty() {
        None
    } else {
        Some(std::mem::take(&mut normalized))
    }
}

pub fn normalize_capture_mode(value: Option<String>) -> String {
    match normalize_optional_string(value) {
        Some(mode) => match mode.to_ascii_lowercase().as_str() {
            "foreground_window" => "foreground_window".to_string(),
            "target_window" => "target_window".to_string(),
            "process_bind" => "process_bind".to_string(),
            "desktop" => "desktop".to_string(),
            "target_display" => "target_display".to_string(),
            "all_displays" => "all_displays".to_string(),
            _ => DEFAULT_TARGET_CAPTURE_MODE.to_string(),
        },
        None => DEFAULT_TARGET_CAPTURE_MODE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{TestSessionRecord, TestSessionStartOptions};

    #[test]
    fn from_start_options_hides_mouse_in_video_by_default() {
        let session = TestSessionRecord::from_start_options(
            "ts-1".to_string(),
            1_000,
            TestSessionStartOptions::default(),
            None,
            None,
        );

        assert!(!session.show_mouse_in_video);
    }

    #[test]
    fn from_start_options_preserves_mouse_visibility_override() {
        let session = TestSessionRecord::from_start_options(
            "ts-1".to_string(),
            1_000,
            TestSessionStartOptions {
                show_mouse_in_video: Some(true),
                ..TestSessionStartOptions::default()
            },
            None,
            None,
        );

        assert!(session.show_mouse_in_video);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestSessionVideoStreamStatus {
    Planned,
    Active,
    Stopped,
}

impl TestSessionVideoStreamStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Active => "active",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestSessionVideoSegmentStatus {
    Planned,
    Ready,
    Missing,
}

impl TestSessionVideoSegmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Ready => "ready",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionVideoStreamRecord {
    pub schema_version: u32,
    pub kind: String,
    pub stream_id: String,
    pub session_id: String,
    pub label: String,
    pub status: TestSessionVideoStreamStatus,
    pub target_capture_mode: String,
    pub display_id: Option<String>,
    pub display_label: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub monitor_left: Option<i32>,
    pub monitor_top: Option<i32>,
    pub monitor_right: Option<i32>,
    pub monitor_bottom: Option<i32>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub segment_duration_seconds: u32,
    pub segment_count: u32,
    #[serde(default)]
    pub playable_segment_count: u32,
    #[serde(default)]
    pub pending_segment_count: u32,
    #[serde(default)]
    pub total_segment_bytes: u64,
    #[serde(default)]
    pub retained_segment_bytes: u64,
    pub last_segment_bytes: Option<u64>,
    pub last_segment_duration_ms: Option<u32>,
    pub last_segment_frame_count: Option<u32>,
    pub last_capture_latency_ms: Option<u32>,
    pub last_encode_latency_ms: Option<u32>,
    #[serde(default)]
    pub sample_interval_ms: u32,
    #[serde(default)]
    pub target_fps: u32,
    #[serde(default)]
    pub encoder_available: bool,
    #[serde(default)]
    pub warning_count: u32,
    pub last_warning: Option<String>,
    pub stream_dir: Option<String>,
    pub manifest_path: Option<String>,
    pub playlist_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionVideoSegmentRecord {
    pub schema_version: u32,
    pub kind: String,
    pub segment_id: String,
    pub session_id: String,
    pub stream_id: String,
    pub status: TestSessionVideoSegmentStatus,
    pub display_id: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    pub duration_ms: u32,
    pub relative_path: Option<String>,
    pub file_path: Option<String>,
    pub manifest_path: Option<String>,
    pub size_bytes: Option<u64>,
    pub frame_count: Option<u32>,
    pub codec: Option<String>,
    pub container: Option<String>,
    pub mime_type: Option<String>,
    pub encoder_name: Option<String>,
    #[serde(default)]
    pub is_playable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestSessionEventType {
    SessionStarted,
    SessionPaused,
    SessionResumed,
    SessionStopped,
    StepCaptured,
    NoteAdded,
    AppLogAdded,
    WindowForegroundChanged,
    WindowFocusChanged,
    WindowShown,
    WindowHidden,
    WindowTitleChanged,
    ClipboardUpdated,
    DefectMarked,
    KeyboardSummary,
}

impl TestSessionEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SessionStarted => "session_started",
            Self::SessionPaused => "session_paused",
            Self::SessionResumed => "session_resumed",
            Self::SessionStopped => "session_stopped",
            Self::StepCaptured => "step_captured",
            Self::NoteAdded => "note_added",
            Self::AppLogAdded => "app_log_added",
            Self::WindowForegroundChanged => "window_foreground_changed",
            Self::WindowFocusChanged => "window_focus_changed",
            Self::WindowShown => "window_shown",
            Self::WindowHidden => "window_hidden",
            Self::WindowTitleChanged => "window_title_changed",
            Self::ClipboardUpdated => "clipboard_updated",
            Self::DefectMarked => "defect_marked",
            Self::KeyboardSummary => "keyboard_summary",
        }
    }

    pub fn log_category(&self) -> &'static str {
        match self {
            Self::SessionStarted
            | Self::SessionPaused
            | Self::SessionResumed
            | Self::SessionStopped => "recording",
            Self::StepCaptured | Self::NoteAdded | Self::DefectMarked | Self::KeyboardSummary => {
                "operation"
            }
            Self::AppLogAdded => "app",
            Self::WindowForegroundChanged
            | Self::WindowFocusChanged
            | Self::WindowShown
            | Self::WindowHidden
            | Self::WindowTitleChanged
            | Self::ClipboardUpdated => "system",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TestSessionNoteInput {
    pub title: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TestSessionDefectMarkInput {
    /// Optional session to mark. When recording has stopped, pass the review session id.
    pub session_id: Option<String>,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<u64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionStepRecord {
    pub schema_version: u32,
    pub kind: String,
    pub step_id: String,
    pub session_id: String,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    pub relative_ms_from_session_start: u64,
    pub step_type: String,
    pub title: String,
    pub summary: String,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub control_name: Option<String>,
    pub control_type: Option<String>,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub display_id: Option<String>,
    pub precision_level: String,
    pub confidence: f64,
    pub source_event_ids: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub full_image_path: Option<String>,
    pub thumb_image_path: Option<String>,
    /// True when title/summary was manually edited by the user.
    #[serde(default)]
    pub edited: bool,
    /// Original auto-generated title before manual edit (if any).
    #[serde(default)]
    pub original_title: Option<String>,
    /// Business alias applied from semantic profile (L4), if any.
    #[serde(default)]
    pub business_alias: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TestSessionStepEditInput {
    pub session_id: Option<String>,
    pub step_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionDefectMarkRecord {
    pub event: TestSessionEventRecord,
    pub marked_at_ms: u64,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub pre_window_seconds: u32,
    pub post_window_seconds: u32,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub step_count: u32,
}

#[derive(Debug, Clone, Default)]
pub struct TestSessionLogInput {
    pub level: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TestSessionSystemEventInput {
    pub event_type: TestSessionEventType,
    pub occurred_at_ms: u64,
    pub title: Option<String>,
    pub message: Option<String>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub window_hwnd: Option<String>,
    pub window_pid: Option<u32>,
    pub system_source: Option<String>,
    pub clipboard_content_type: Option<String>,
    pub action: Option<String>,
    pub control_name: Option<String>,
    pub control_type: Option<String>,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub precision_level: Option<String>,
    pub char_count: Option<u32>,
    pub is_password: Option<bool>,
    pub shortcut: Option<String>,
}

impl Default for TestSessionSystemEventInput {
    fn default() -> Self {
        Self {
            event_type: TestSessionEventType::WindowForegroundChanged,
            occurred_at_ms: 0,
            title: None,
            message: None,
            process_name: None,
            window_title: None,
            window_hwnd: None,
            window_pid: None,
            system_source: None,
            clipboard_content_type: None,
            action: None,
            control_name: None,
            control_type: None,
            automation_id: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionEventRecord {
    pub schema_version: u32,
    pub kind: String,
    pub event_id: String,
    pub session_id: String,
    pub event_type: TestSessionEventType,
    pub occurred_at_ms: u64,
    pub status: Option<TestSessionStatus>,
    pub step_id: Option<String>,
    pub action: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub logical_x: Option<i32>,
    pub logical_y: Option<i32>,
    pub window_left: Option<i32>,
    pub window_top: Option<i32>,
    pub window_right: Option<i32>,
    pub window_bottom: Option<i32>,
    pub logical_window_left: Option<i32>,
    pub logical_window_top: Option<i32>,
    pub logical_window_right: Option<i32>,
    pub logical_window_bottom: Option<i32>,
    pub display_id: Option<String>,
    pub dpi_scale: Option<f32>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub log_level: Option<String>,
    pub log_source: Option<String>,
    pub system_source: Option<String>,
    pub window_hwnd: Option<String>,
    pub window_pid: Option<u32>,
    pub clipboard_content_type: Option<String>,
    pub image_bytes: Option<u32>,
    pub capture_latency_ms: Option<u32>,
    pub encode_latency_ms: Option<u32>,
    pub source: Option<String>,
    pub capture_backend: Option<String>,
    pub full_image_path: Option<String>,
    pub thumb_image_path: Option<String>,
    #[serde(default)]
    pub control_name: Option<String>,
    #[serde(default)]
    pub automation_id: Option<String>,
    #[serde(default)]
    pub control_type: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub precision_level: Option<String>,
    #[serde(default)]
    pub char_count: Option<u32>,
    #[serde(default)]
    pub is_password: Option<bool>,
    #[serde(default)]
    pub shortcut: Option<String>,
}

impl TestSessionEventRecord {
    pub fn new_lifecycle(
        event_id: String,
        session_id: String,
        event_type: TestSessionEventType,
        occurred_at_ms: u64,
        status: TestSessionStatus,
    ) -> Self {
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type,
            occurred_at_ms,
            status: Some(status),
            step_id: None,
            action: None,
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
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
            window_title: None,
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
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

    pub fn new_step(
        event_id: String,
        session_id: String,
        step: &StepData,
        full_image_path: Option<String>,
        thumb_image_path: Option<String>,
    ) -> Self {
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type: TestSessionEventType::StepCaptured,
            occurred_at_ms: step.timestamp_ms,
            status: None,
            step_id: Some(step.id.to_string()),
            action: Some(step.action.clone()),
            x: Some(step.x),
            y: Some(step.y),
            logical_x: Some(step.logical_x),
            logical_y: Some(step.logical_y),
            window_left: Some(step.window_left),
            window_top: Some(step.window_top),
            window_right: Some(step.window_right),
            window_bottom: Some(step.window_bottom),
            logical_window_left: Some(step.logical_window_left),
            logical_window_top: Some(step.logical_window_top),
            logical_window_right: Some(step.logical_window_right),
            logical_window_bottom: Some(step.logical_window_bottom),
            display_id: Some(step.display_id.clone()),
            dpi_scale: Some(step.dpi_scale),
            process_name: Some(step.process_name.clone()),
            window_title: Some(step.window_title.clone()),
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
            clipboard_content_type: None,
            image_bytes: Some(u32::try_from(step.image_bytes).unwrap_or(u32::MAX)),
            capture_latency_ms: Some(step.capture_latency_ms),
            encode_latency_ms: Some(step.encode_latency_ms),
            source: Some(step.source.as_str().to_string()),
            capture_backend: Some(step.capture_backend.as_str().to_string()),
            full_image_path,
            thumb_image_path,
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

    pub fn with_uia(
        mut self,
        control_name: Option<String>,
        automation_id: Option<String>,
        control_type: Option<String>,
        class_name: Option<String>,
        precision_level: Option<String>,
    ) -> Self {
        self.control_name = normalize_optional_string(control_name);
        self.automation_id = normalize_optional_string(automation_id);
        self.control_type = normalize_optional_string(control_type);
        self.class_name = normalize_optional_string(class_name);
        self.precision_level = normalize_optional_string(precision_level);
        self
    }

    pub fn new_note(
        event_id: String,
        session_id: String,
        occurred_at_ms: u64,
        title: Option<String>,
        message: Option<String>,
    ) -> Self {
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type: TestSessionEventType::NoteAdded,
            occurred_at_ms,
            status: None,
            step_id: None,
            action: None,
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
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
            window_title: None,
            title,
            message,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
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

    #[allow(clippy::too_many_arguments)]
    pub fn new_defect_mark(
        event_id: String,
        session_id: String,
        occurred_at_ms: u64,
        note: Option<String>,
        expected: Option<String>,
        actual: Option<String>,
        window_start_ms: u64,
        window_end_ms: u64,
    ) -> Self {
        let message = {
            let mut parts = Vec::new();
            if let Some(note) = normalize_optional_string(note) {
                parts.push(note);
            }
            if let Some(expected) = normalize_optional_string(expected) {
                parts.push(format!("期望: {expected}"));
            }
            if let Some(actual) = normalize_optional_string(actual) {
                parts.push(format!("实际: {actual}"));
            }
            if parts.is_empty() {
                Some("已标记缺陷".to_string())
            } else {
                Some(parts.join("；"))
            }
        };
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type: TestSessionEventType::DefectMarked,
            occurred_at_ms,
            status: None,
            step_id: None,
            action: None,
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
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
            window_title: None,
            title: Some(format!("缺陷标记 {window_start_ms}-{window_end_ms}")),
            message,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
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

    pub fn new_app_log(
        event_id: String,
        session_id: String,
        occurred_at_ms: u64,
        level: Option<String>,
        source: Option<String>,
        message: Option<String>,
    ) -> Self {
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type: TestSessionEventType::AppLogAdded,
            occurred_at_ms,
            status: None,
            step_id: None,
            action: None,
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
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
            window_title: None,
            title: None,
            message,
            log_level: normalize_log_level(level),
            log_source: normalize_optional_string(source),
            system_source: None,
            window_hwnd: None,
            window_pid: None,
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

    pub fn new_system(
        event_id: String,
        session_id: String,
        input: TestSessionSystemEventInput,
    ) -> Self {
        Self {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: TEST_SESSION_EVENT_KIND.to_string(),
            event_id,
            session_id,
            event_type: input.event_type,
            occurred_at_ms: input.occurred_at_ms,
            status: None,
            step_id: None,
            // Keyboard type/key/shortcut and other system actions must persist;
            // operation builder classifies TypeSummary via action == "type".
            action: normalize_optional_string(input.action),
            x: None,
            y: None,
            logical_x: None,
            logical_y: None,
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
            process_name: normalize_optional_string(input.process_name),
            window_title: normalize_optional_string(input.window_title),
            title: normalize_optional_string(input.title),
            message: normalize_optional_string(input.message),
            log_level: None,
            log_source: None,
            system_source: normalize_system_source(input.system_source),
            window_hwnd: normalize_optional_string(input.window_hwnd),
            window_pid: input.window_pid,
            clipboard_content_type: normalize_clipboard_content_type(input.clipboard_content_type),
            image_bytes: None,
            capture_latency_ms: None,
            encode_latency_ms: None,
            source: None,
            capture_backend: None,
            full_image_path: None,
            thumb_image_path: None,
            control_name: normalize_optional_string(input.control_name),
            automation_id: normalize_optional_string(input.automation_id),
            control_type: normalize_optional_string(input.control_type),
            class_name: normalize_optional_string(input.class_name),
            precision_level: normalize_optional_string(input.precision_level),
            char_count: input.char_count,
            is_password: input.is_password,
            shortcut: normalize_optional_string(input.shortcut),
        }
    }
}

pub fn normalize_log_level(value: Option<String>) -> Option<String> {
    match normalize_optional_string(value) {
        Some(level) => match level.to_ascii_lowercase().as_str() {
            "trace" => Some("trace".to_string()),
            "debug" => Some("debug".to_string()),
            "info" => Some("info".to_string()),
            "warn" => Some("warn".to_string()),
            "error" => Some("error".to_string()),
            _ => Some("info".to_string()),
        },
        None => None,
    }
}

pub fn normalize_system_source(value: Option<String>) -> Option<String> {
    match normalize_optional_string(value) {
        Some(source) => match source.to_ascii_lowercase().as_str() {
            "win_event" => Some("win_event".to_string()),
            "clipboard" => Some("clipboard".to_string()),
            "keyboard" => Some("keyboard".to_string()),
            _ => Some("win_event".to_string()),
        },
        None => None,
    }
}

pub fn normalize_clipboard_content_type(value: Option<String>) -> Option<String> {
    match normalize_optional_string(value) {
        Some(kind) => match kind.to_ascii_lowercase().as_str() {
            "text" => Some("text".to_string()),
            "image" => Some("image".to_string()),
            "file_list" => Some("file_list".to_string()),
            "html" => Some("html".to_string()),
            "unknown" => Some("unknown".to_string()),
            _ => Some("unknown".to_string()),
        },
        None => None,
    }
}
