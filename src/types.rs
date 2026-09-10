use std::time::{SystemTime, UNIX_EPOCH};

use napi_derive::napi;

use crate::config::{
    CaptureBackendMode, DEFAULT_ADAPTIVE_BUFFER_HIGH_RATIO, DEFAULT_ADAPTIVE_BUFFER_LOW_RATIO,
    DEFAULT_ADAPTIVE_LATENCY_HIGH_MS, DEFAULT_ADAPTIVE_LATENCY_LOW_MS,
    DEFAULT_ADAPTIVE_MAX_QUALITY, DEFAULT_ADAPTIVE_MIN_QUALITY, DEFAULT_ADAPTIVE_QUALITY_ENABLED,
    DEFAULT_ADAPTIVE_STEP_DOWN, DEFAULT_ADAPTIVE_STEP_UP, DEFAULT_ADAPTIVE_TARGET_IMAGE_KB,
    DEFAULT_CAPTURE_REUSE_ENABLED, DEFAULT_DEBOUNCE_MS, DEFAULT_MAX_BUFFER_BYTES,
    DEFAULT_MAX_STEPS, DEFAULT_OPERATION_BUILDER_ENABLED, DEFAULT_OPERATION_REVIEW_V2_ENABLED,
    DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED, DEFAULT_SEMANTIC_RECORDING_ENABLED,
    DEFAULT_STRICT_BACKEND, DEFAULT_THUMB_WEBP_QUALITY, DEFAULT_UIA_OBSERVER_ENABLED,
    DEFAULT_WEBP_QUALITY, DeltaMode, InputMode, RecorderConfig, StreamPayloadMode, TransportMode,
};
use crate::metrics::RecorderMetrics;
use crate::privacy::MaskRegion;
use crate::session::{
    DefectPackResult, OperationAction, OperationActionConfidence, OperationCoordinate,
    OperationEvidence, OperationOutcome, OperationOutcomeConfidence, OperationReasonCode,
    OperationStoreDiagnostic, OperationVideoRange, SemanticAliasProfile, SemanticAliasRule,
    StateTransition, StateTransitionConfidence, TestSessionDefectMarkInput,
    TestSessionDefectMarkRecord, TestSessionDisplayTarget, TestSessionEventRecord,
    TestSessionLogInput, TestSessionNoteInput, TestSessionOperationRecord, TestSessionRecord,
    TestSessionStartOptions, TestSessionStepEditInput, TestSessionStepRecord,
    TestSessionVideoSegmentRecord, TestSessionVideoStreamRecord, UiBoundingRect, UiElementIdentity,
    UiElementPathEntry, UiStateSnapshot,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepSource {
    Hook,
    RawInput,
}

impl StepSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::RawInput => "raw_input",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureBackendUsed {
    Dxgi,
    Wgc,
}

impl CaptureBackendUsed {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dxgi => "dxgi",
            Self::Wgc => "wgc",
        }
    }
}

#[derive(Debug, Clone)]
pub struct StepData {
    pub id: u64,
    pub timestamp_ms: u64,
    pub action: String,
    pub x: i32,
    pub y: i32,
    pub logical_x: i32,
    pub logical_y: i32,
    pub window_left: i32,
    pub window_top: i32,
    pub window_right: i32,
    pub window_bottom: i32,
    pub logical_window_left: i32,
    pub logical_window_top: i32,
    pub logical_window_right: i32,
    pub logical_window_bottom: i32,
    pub display_id: String,
    pub dpi_scale: f32,
    pub process_name: String,
    pub window_title: String,
    pub image_webp: Vec<u8>,
    pub image_thumb_webp: Vec<u8>,
    pub image_bytes: usize,
    pub capture_latency_ms: u32,
    pub encode_latency_ms: u32,
    pub source: StepSource,
    pub capture_backend: CaptureBackendUsed,
}

impl StepData {
    pub fn now_timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }

    pub fn storage_bytes(&self) -> usize {
        self.image_webp
            .len()
            .saturating_add(self.image_thumb_webp.len())
    }
}

#[napi(object)]
pub struct JsStepData {
    pub id: String,
    pub timestamp_ms: f64,
    pub action: String,
    pub x: i32,
    pub y: i32,
    pub logical_x: i32,
    pub logical_y: i32,
    pub window_left: i32,
    pub window_top: i32,
    pub window_right: i32,
    pub window_bottom: i32,
    pub logical_window_left: i32,
    pub logical_window_top: i32,
    pub logical_window_right: i32,
    pub logical_window_bottom: i32,
    pub display_id: String,
    pub dpi_scale: f64,
    pub process_name: String,
    pub window_title: String,
    pub image_webp_base64: String,
    pub image_bytes: u32,
    pub capture_latency_ms: u32,
    pub encode_latency_ms: u32,
    pub source: String,
    pub capture_backend: String,
}

impl From<StepData> for JsStepData {
    fn from(value: StepData) -> Self {
        use base64::Engine;
        use base64::engine::general_purpose::STANDARD;

        Self {
            id: value.id.to_string(),
            timestamp_ms: value.timestamp_ms as f64,
            action: value.action,
            x: value.x,
            y: value.y,
            logical_x: value.logical_x,
            logical_y: value.logical_y,
            window_left: value.window_left,
            window_top: value.window_top,
            window_right: value.window_right,
            window_bottom: value.window_bottom,
            logical_window_left: value.logical_window_left,
            logical_window_top: value.logical_window_top,
            logical_window_right: value.logical_window_right,
            logical_window_bottom: value.logical_window_bottom,
            display_id: value.display_id,
            dpi_scale: value.dpi_scale as f64,
            process_name: value.process_name,
            window_title: value.window_title,
            image_webp_base64: STANDARD.encode(value.image_webp),
            image_bytes: u32::try_from(value.image_bytes).unwrap_or(u32::MAX),
            capture_latency_ms: value.capture_latency_ms,
            encode_latency_ms: value.encode_latency_ms,
            source: value.source.as_str().to_string(),
            capture_backend: value.capture_backend.as_str().to_string(),
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct JsMaskRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub label: String,
}

impl From<JsMaskRegion> for MaskRegion {
    fn from(value: JsMaskRegion) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
            label: value.label,
        }
    }
}

#[napi(object)]
pub struct JsRecorderConfig {
    pub max_steps: Option<u32>,
    pub max_buffer_bytes: Option<u32>,
    pub debounce_ms: Option<u32>,
    pub webp_quality: Option<f64>,
    pub thumb_webp_quality: Option<f64>,
    pub adaptive_quality_enabled: Option<bool>,
    pub adaptive_buffer_high_ratio: Option<f64>,
    pub adaptive_buffer_low_ratio: Option<f64>,
    pub adaptive_latency_high_ms: Option<u32>,
    pub adaptive_latency_low_ms: Option<u32>,
    pub adaptive_target_image_kb: Option<u32>,
    pub adaptive_step_down: Option<f64>,
    pub adaptive_step_up: Option<f64>,
    pub adaptive_min_quality: Option<f64>,
    pub adaptive_max_quality: Option<f64>,
    pub input_mode: Option<String>,
    pub capture_backend: Option<String>,
    pub strict_backend: Option<bool>,
    pub delta_mode: Option<String>,
    pub transport_mode: Option<String>,
    pub stream_payload: Option<String>,
    pub capture_reuse_enabled: Option<bool>,
    pub privacy_enabled: Option<bool>,
    pub defect_evidence_enabled: Option<bool>,
    pub semantic_recording_enabled: Option<bool>,
    pub uia_observer_enabled: Option<bool>,
    pub operation_builder_enabled: Option<bool>,
    pub operation_review_v2_enabled: Option<bool>,
    pub semantic_plaintext_input_enabled: Option<bool>,
    pub defect_pre_window_seconds: Option<u32>,
    pub defect_post_window_seconds: Option<u32>,
    pub excluded_window_title_keywords: Option<Vec<String>>,
    pub excluded_process_names: Option<Vec<String>>,
    pub mask_regions: Option<Vec<JsMaskRegion>>,
}

impl Default for JsRecorderConfig {
    fn default() -> Self {
        Self {
            max_steps: Some(DEFAULT_MAX_STEPS as u32),
            max_buffer_bytes: Some(DEFAULT_MAX_BUFFER_BYTES as u32),
            debounce_ms: Some(DEFAULT_DEBOUNCE_MS as u32),
            webp_quality: Some(DEFAULT_WEBP_QUALITY as f64),
            thumb_webp_quality: Some(DEFAULT_THUMB_WEBP_QUALITY as f64),
            adaptive_quality_enabled: Some(DEFAULT_ADAPTIVE_QUALITY_ENABLED),
            adaptive_buffer_high_ratio: Some(DEFAULT_ADAPTIVE_BUFFER_HIGH_RATIO as f64),
            adaptive_buffer_low_ratio: Some(DEFAULT_ADAPTIVE_BUFFER_LOW_RATIO as f64),
            adaptive_latency_high_ms: Some(DEFAULT_ADAPTIVE_LATENCY_HIGH_MS),
            adaptive_latency_low_ms: Some(DEFAULT_ADAPTIVE_LATENCY_LOW_MS),
            adaptive_target_image_kb: Some(DEFAULT_ADAPTIVE_TARGET_IMAGE_KB),
            adaptive_step_down: Some(DEFAULT_ADAPTIVE_STEP_DOWN as f64),
            adaptive_step_up: Some(DEFAULT_ADAPTIVE_STEP_UP as f64),
            adaptive_min_quality: Some(DEFAULT_ADAPTIVE_MIN_QUALITY as f64),
            adaptive_max_quality: Some(DEFAULT_ADAPTIVE_MAX_QUALITY as f64),
            input_mode: Some("auto".to_string()),
            capture_backend: Some("auto".to_string()),
            strict_backend: Some(DEFAULT_STRICT_BACKEND),
            delta_mode: Some("hash_dedup".to_string()),
            transport_mode: Some("push".to_string()),
            stream_payload: Some("meta_only".to_string()),
            capture_reuse_enabled: Some(DEFAULT_CAPTURE_REUSE_ENABLED),
            privacy_enabled: Some(false),
            defect_evidence_enabled: Some(false),
            semantic_recording_enabled: Some(DEFAULT_SEMANTIC_RECORDING_ENABLED),
            uia_observer_enabled: Some(DEFAULT_UIA_OBSERVER_ENABLED),
            operation_builder_enabled: Some(DEFAULT_OPERATION_BUILDER_ENABLED),
            operation_review_v2_enabled: Some(DEFAULT_OPERATION_REVIEW_V2_ENABLED),
            semantic_plaintext_input_enabled: Some(DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED),
            defect_pre_window_seconds: Some(60),
            defect_post_window_seconds: Some(20),
            excluded_window_title_keywords: Some(Vec::new()),
            excluded_process_names: Some(Vec::new()),
            mask_regions: Some(Vec::new()),
        }
    }
}

impl From<JsRecorderConfig> for RecorderConfig {
    fn from(value: JsRecorderConfig) -> Self {
        let defect_evidence_enabled = value.defect_evidence_enabled.unwrap_or(false);
        let semantic_recording_enabled = value
            .semantic_recording_enabled
            .unwrap_or(defect_evidence_enabled);
        RecorderConfig {
            max_steps: value.max_steps.unwrap_or(DEFAULT_MAX_STEPS as u32) as usize,
            max_buffer_bytes: value
                .max_buffer_bytes
                .unwrap_or(DEFAULT_MAX_BUFFER_BYTES as u32) as usize,
            debounce_ms: value.debounce_ms.unwrap_or(DEFAULT_DEBOUNCE_MS as u32) as u64,
            webp_quality: value.webp_quality.unwrap_or(DEFAULT_WEBP_QUALITY as f64) as f32,
            thumb_webp_quality: value
                .thumb_webp_quality
                .unwrap_or(DEFAULT_THUMB_WEBP_QUALITY as f64)
                as f32,
            adaptive_quality_enabled: value
                .adaptive_quality_enabled
                .unwrap_or(DEFAULT_ADAPTIVE_QUALITY_ENABLED),
            adaptive_buffer_high_ratio: value
                .adaptive_buffer_high_ratio
                .unwrap_or(DEFAULT_ADAPTIVE_BUFFER_HIGH_RATIO as f64)
                as f32,
            adaptive_buffer_low_ratio: value
                .adaptive_buffer_low_ratio
                .unwrap_or(DEFAULT_ADAPTIVE_BUFFER_LOW_RATIO as f64)
                as f32,
            adaptive_latency_high_ms: value
                .adaptive_latency_high_ms
                .unwrap_or(DEFAULT_ADAPTIVE_LATENCY_HIGH_MS),
            adaptive_latency_low_ms: value
                .adaptive_latency_low_ms
                .unwrap_or(DEFAULT_ADAPTIVE_LATENCY_LOW_MS),
            adaptive_target_image_kb: value
                .adaptive_target_image_kb
                .unwrap_or(DEFAULT_ADAPTIVE_TARGET_IMAGE_KB),
            adaptive_step_down: value
                .adaptive_step_down
                .unwrap_or(DEFAULT_ADAPTIVE_STEP_DOWN as f64)
                as f32,
            adaptive_step_up: value
                .adaptive_step_up
                .unwrap_or(DEFAULT_ADAPTIVE_STEP_UP as f64) as f32,
            adaptive_min_quality: value
                .adaptive_min_quality
                .unwrap_or(DEFAULT_ADAPTIVE_MIN_QUALITY as f64)
                as f32,
            adaptive_max_quality: value
                .adaptive_max_quality
                .unwrap_or(DEFAULT_ADAPTIVE_MAX_QUALITY as f64)
                as f32,
            input_mode: parse_input_mode(value.input_mode.as_deref()),
            capture_backend: parse_capture_backend(value.capture_backend.as_deref()),
            strict_backend: value.strict_backend.unwrap_or(DEFAULT_STRICT_BACKEND),
            delta_mode: parse_delta_mode(value.delta_mode.as_deref()),
            transport_mode: parse_transport_mode(value.transport_mode.as_deref()),
            stream_payload: parse_stream_payload_mode(value.stream_payload.as_deref()),
            capture_reuse_enabled: value
                .capture_reuse_enabled
                .unwrap_or(DEFAULT_CAPTURE_REUSE_ENABLED),
            privacy_enabled: value.privacy_enabled.unwrap_or(false),
            defect_evidence_enabled,
            semantic_recording_enabled,
            uia_observer_enabled: value
                .uia_observer_enabled
                .unwrap_or(DEFAULT_UIA_OBSERVER_ENABLED),
            operation_builder_enabled: value
                .operation_builder_enabled
                .unwrap_or(DEFAULT_OPERATION_BUILDER_ENABLED),
            operation_review_v2_enabled: value
                .operation_review_v2_enabled
                .unwrap_or(DEFAULT_OPERATION_REVIEW_V2_ENABLED),
            semantic_plaintext_input_enabled: value
                .semantic_plaintext_input_enabled
                .unwrap_or(DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED),
            defect_pre_window_seconds: value.defect_pre_window_seconds.unwrap_or(60),
            defect_post_window_seconds: value.defect_post_window_seconds.unwrap_or(20),
            excluded_window_title_keywords: value
                .excluded_window_title_keywords
                .unwrap_or_default(),
            excluded_process_names: value.excluded_process_names.unwrap_or_default(),
            mask_regions: value
                .mask_regions
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
        }
        .normalized()
    }
}

fn parse_input_mode(input: Option<&str>) -> InputMode {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "hook" => InputMode::Hook,
        "raw_input" => InputMode::RawInput,
        _ => InputMode::Auto,
    }
}

fn parse_capture_backend(input: Option<&str>) -> CaptureBackendMode {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "dxgi" => CaptureBackendMode::Dxgi,
        "wgc" => CaptureBackendMode::Wgc,
        _ => CaptureBackendMode::Auto,
    }
}

fn parse_transport_mode(input: Option<&str>) -> TransportMode {
    match input.unwrap_or("push").to_ascii_lowercase().as_str() {
        "push" => TransportMode::Push,
        _ => TransportMode::Poll,
    }
}

fn parse_delta_mode(input: Option<&str>) -> DeltaMode {
    match input.unwrap_or("hash_dedup").to_ascii_lowercase().as_str() {
        "off" => DeltaMode::Off,
        "dirty_rect" => DeltaMode::DirtyRect,
        _ => DeltaMode::HashDedup,
    }
}

fn parse_stream_payload_mode(input: Option<&str>) -> StreamPayloadMode {
    match input.unwrap_or("meta_only").to_ascii_lowercase().as_str() {
        "meta_plus_thumb" => StreamPayloadMode::MetaPlusThumb,
        "full" => StreamPayloadMode::Full,
        _ => StreamPayloadMode::MetaOnly,
    }
}

#[napi(object)]
pub struct JsRecorderMetrics {
    pub captured_steps_total: u32,
    pub dropped_steps_total: u32,
    pub input_channel_full_drop_total: u32,
    pub capture_queue_drop_total: u32,
    pub encode_queue_drop_total: u32,
    pub push_dispatch_drop_total: u32,
    pub buffer_steps: u32,
    pub buffer_bytes: u32,
    pub last_capture_latency_ms: u32,
    pub last_encode_latency_ms: u32,
    pub stream_backpressure_ms: u32,
    pub last_image_bytes: u32,
    pub current_effective_quality: f64,
    pub quality_adjust_down_count: u32,
    pub quality_adjust_up_count: u32,
    pub wgc_capture_count: u32,
    pub dxgi_capture_count: u32,
    pub effective_input_mode: Option<String>,
    pub effective_delta_mode: Option<String>,
    pub dirty_rect_supported: bool,
    pub dirty_rect_update_frames_total: u32,
    pub dirty_rect_empty_frames_total: u32,
    pub dirty_rect_encode_skip_total: u32,
    pub dirty_region_frame_total: u32,
    pub dirty_region_empty_frame_total: u32,
    pub dirty_region_coverage_avg: f64,
    pub backend_fallback_total: u32,
    pub capture_context_reset_total: u32,
    pub uia_observer_queue_depth: u32,
    pub uia_observer_dropped_total: u32,
    pub uia_observer_duplicate_drop_total: u32,
    pub uia_observer_rate_limit_drop_total: u32,
    pub uia_observer_queue_overflow_total: u32,
    pub uia_observer_timeout_total: u32,
    pub uia_observer_restart_total: u32,
    pub uia_observer_circuit_open: bool,
    pub uia_observer_polling_attempt_total: u32,
}

impl From<RecorderMetrics> for JsRecorderMetrics {
    fn from(value: RecorderMetrics) -> Self {
        Self {
            captured_steps_total: u32::try_from(value.captured_steps_total).unwrap_or(u32::MAX),
            dropped_steps_total: u32::try_from(value.dropped_steps_total).unwrap_or(u32::MAX),
            input_channel_full_drop_total: u32::try_from(value.input_channel_full_drop_total)
                .unwrap_or(u32::MAX),
            capture_queue_drop_total: u32::try_from(value.capture_queue_drop_total)
                .unwrap_or(u32::MAX),
            encode_queue_drop_total: u32::try_from(value.encode_queue_drop_total)
                .unwrap_or(u32::MAX),
            push_dispatch_drop_total: u32::try_from(value.push_dispatch_drop_total)
                .unwrap_or(u32::MAX),
            buffer_steps: value.buffer_steps,
            buffer_bytes: u32::try_from(value.buffer_bytes).unwrap_or(u32::MAX),
            last_capture_latency_ms: value.last_capture_latency_ms,
            last_encode_latency_ms: value.last_encode_latency_ms,
            stream_backpressure_ms: value.stream_backpressure_ms,
            last_image_bytes: value.last_image_bytes,
            current_effective_quality: value.current_effective_quality as f64,
            quality_adjust_down_count: value.quality_adjust_down_count,
            quality_adjust_up_count: value.quality_adjust_up_count,
            wgc_capture_count: u32::try_from(value.wgc_capture_count).unwrap_or(u32::MAX),
            dxgi_capture_count: u32::try_from(value.dxgi_capture_count).unwrap_or(u32::MAX),
            effective_input_mode: if value.effective_input_mode.is_empty() {
                None
            } else {
                Some(value.effective_input_mode)
            },
            effective_delta_mode: if value.effective_delta_mode.is_empty() {
                None
            } else {
                Some(value.effective_delta_mode)
            },
            dirty_rect_supported: value.dirty_rect_supported,
            dirty_rect_update_frames_total: u32::try_from(value.dirty_rect_update_frames_total)
                .unwrap_or(u32::MAX),
            dirty_rect_empty_frames_total: u32::try_from(value.dirty_rect_empty_frames_total)
                .unwrap_or(u32::MAX),
            dirty_rect_encode_skip_total: u32::try_from(value.dirty_rect_encode_skip_total)
                .unwrap_or(u32::MAX),
            dirty_region_frame_total: u32::try_from(value.dirty_region_frame_total)
                .unwrap_or(u32::MAX),
            dirty_region_empty_frame_total: u32::try_from(value.dirty_region_empty_frame_total)
                .unwrap_or(u32::MAX),
            dirty_region_coverage_avg: value.dirty_region_coverage_avg.clamp(0.0, 1.0) as f64,
            backend_fallback_total: u32::try_from(value.backend_fallback_total).unwrap_or(u32::MAX),
            capture_context_reset_total: u32::try_from(value.capture_context_reset_total)
                .unwrap_or(u32::MAX),
            uia_observer_queue_depth: value.uia_observer_queue_depth,
            uia_observer_dropped_total: u32::try_from(value.uia_observer_dropped_total)
                .unwrap_or(u32::MAX),
            uia_observer_duplicate_drop_total: u32::try_from(
                value.uia_observer_duplicate_drop_total,
            )
            .unwrap_or(u32::MAX),
            uia_observer_rate_limit_drop_total: u32::try_from(
                value.uia_observer_rate_limit_drop_total,
            )
            .unwrap_or(u32::MAX),
            uia_observer_queue_overflow_total: u32::try_from(
                value.uia_observer_queue_overflow_total,
            )
            .unwrap_or(u32::MAX),
            uia_observer_timeout_total: u32::try_from(value.uia_observer_timeout_total)
                .unwrap_or(u32::MAX),
            uia_observer_restart_total: u32::try_from(value.uia_observer_restart_total)
                .unwrap_or(u32::MAX),
            uia_observer_circuit_open: value.uia_observer_circuit_open,
            uia_observer_polling_attempt_total: u32::try_from(
                value.uia_observer_polling_attempt_total,
            )
            .unwrap_or(u32::MAX),
        }
    }
}

#[derive(Default)]
#[napi(object)]
pub struct JsTestSessionStartOptions {
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

impl From<JsTestSessionStartOptions> for TestSessionStartOptions {
    fn from(value: JsTestSessionStartOptions) -> Self {
        Self {
            name: value.name,
            storage_dir: value.storage_dir,
            target_process_name: value.target_process_name,
            target_pid: value.target_pid,
            target_hwnd: value.target_hwnd,
            target_display_id: value.target_display_id,
            target_display_ids: value.target_display_ids,
            target_capture_mode: value.target_capture_mode,
            buffer_window_seconds: value.buffer_window_seconds,
            segment_duration_seconds: value.segment_duration_seconds,
            recording_profile: value.recording_profile,
            encoder_preference: value.encoder_preference,
            show_mouse_in_video: value.show_mouse_in_video,
            notes: value.notes,
        }
    }
}

#[derive(Default)]
#[napi(object)]
pub struct JsActiveTestSessionVideoConfig {
    pub recording_profile: Option<String>,
    pub encoder_preference: Option<String>,
    pub show_mouse_in_video: Option<bool>,
}

#[napi(object)]
pub struct JsTestSessionRecord {
    pub schema_version: u32,
    pub kind: String,
    pub session_id: String,
    pub name: Option<String>,
    pub status: String,
    pub started_at_ms: f64,
    pub updated_at_ms: f64,
    pub ended_at_ms: Option<f64>,
    pub storage_root_dir: Option<String>,
    pub session_dir: Option<String>,
    pub manifest_path: Option<String>,
    pub buffer_window_seconds: u32,
    pub segment_duration_seconds: u32,
    pub recording_profile: String,
    pub encoder_preference: String,
    pub show_mouse_in_video: bool,
    pub notes: Option<String>,
    pub target_process_name: Option<String>,
    pub target_pid: Option<u32>,
    pub target_hwnd: Option<String>,
    pub target_display_id: Option<String>,
    pub target_display_ids: Option<Vec<String>>,
    pub target_capture_mode: String,
}

impl From<TestSessionRecord> for JsTestSessionRecord {
    fn from(value: TestSessionRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            session_id: value.session_id,
            name: value.name,
            status: value.status.as_str().to_string(),
            started_at_ms: value.started_at_ms as f64,
            updated_at_ms: value.updated_at_ms as f64,
            ended_at_ms: value.ended_at_ms.map(|timestamp| timestamp as f64),
            storage_root_dir: value.storage_root_dir,
            session_dir: value.session_dir,
            manifest_path: value.manifest_path,
            buffer_window_seconds: value.buffer_window_seconds,
            segment_duration_seconds: value.segment_duration_seconds,
            recording_profile: value.recording_profile,
            encoder_preference: value.encoder_preference,
            show_mouse_in_video: value.show_mouse_in_video,
            notes: value.notes,
            target_process_name: value.target_process_name,
            target_pid: value.target_pid,
            target_hwnd: value.target_hwnd,
            target_display_id: value.target_display_id,
            target_display_ids: value.target_display_ids,
            target_capture_mode: value.target_capture_mode,
        }
    }
}

#[napi(object)]
pub struct JsTestSessionDisplayTarget {
    pub display_id: String,
    pub label: String,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

impl From<TestSessionDisplayTarget> for JsTestSessionDisplayTarget {
    fn from(value: TestSessionDisplayTarget) -> Self {
        Self {
            display_id: value.display_id,
            label: value.label,
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            width: value.width,
            height: value.height,
            is_primary: value.is_primary,
        }
    }
}

#[napi(object)]
pub struct JsTestSessionVideoStreamRecord {
    pub schema_version: u32,
    pub kind: String,
    pub stream_id: String,
    pub session_id: String,
    pub label: String,
    pub status: String,
    pub target_capture_mode: String,
    pub display_id: Option<String>,
    pub display_label: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub monitor_left: Option<i32>,
    pub monitor_top: Option<i32>,
    pub monitor_right: Option<i32>,
    pub monitor_bottom: Option<i32>,
    pub started_at_ms: f64,
    pub updated_at_ms: f64,
    pub segment_duration_seconds: u32,
    pub segment_count: u32,
    pub playable_segment_count: u32,
    pub pending_segment_count: u32,
    pub total_segment_bytes: f64,
    pub retained_segment_bytes: f64,
    pub last_segment_bytes: Option<f64>,
    pub last_segment_duration_ms: Option<u32>,
    pub last_segment_frame_count: Option<u32>,
    pub last_capture_latency_ms: Option<u32>,
    pub last_encode_latency_ms: Option<u32>,
    pub sample_interval_ms: u32,
    pub target_fps: u32,
    pub encoder_available: bool,
    pub warning_count: u32,
    pub last_warning: Option<String>,
    pub stream_dir: Option<String>,
    pub manifest_path: Option<String>,
    pub playlist_path: Option<String>,
}

impl From<TestSessionVideoStreamRecord> for JsTestSessionVideoStreamRecord {
    fn from(value: TestSessionVideoStreamRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            stream_id: value.stream_id,
            session_id: value.session_id,
            label: value.label,
            status: value.status.as_str().to_string(),
            target_capture_mode: value.target_capture_mode,
            display_id: value.display_id,
            display_label: value.display_label,
            width: value.width,
            height: value.height,
            monitor_left: value.monitor_left,
            monitor_top: value.monitor_top,
            monitor_right: value.monitor_right,
            monitor_bottom: value.monitor_bottom,
            started_at_ms: value.started_at_ms as f64,
            updated_at_ms: value.updated_at_ms as f64,
            segment_duration_seconds: value.segment_duration_seconds,
            segment_count: value.segment_count,
            playable_segment_count: value.playable_segment_count,
            pending_segment_count: value.pending_segment_count,
            total_segment_bytes: value.total_segment_bytes as f64,
            retained_segment_bytes: value.retained_segment_bytes as f64,
            last_segment_bytes: value.last_segment_bytes.map(|bytes| bytes as f64),
            last_segment_duration_ms: value.last_segment_duration_ms,
            last_segment_frame_count: value.last_segment_frame_count,
            last_capture_latency_ms: value.last_capture_latency_ms,
            last_encode_latency_ms: value.last_encode_latency_ms,
            sample_interval_ms: value.sample_interval_ms,
            target_fps: value.target_fps,
            encoder_available: value.encoder_available,
            warning_count: value.warning_count,
            last_warning: value.last_warning,
            stream_dir: value.stream_dir,
            manifest_path: value.manifest_path,
            playlist_path: value.playlist_path,
        }
    }
}

#[napi(object)]
pub struct JsTestSessionVideoSegmentRecord {
    pub schema_version: u32,
    pub kind: String,
    pub segment_id: String,
    pub session_id: String,
    pub stream_id: String,
    pub status: String,
    pub display_id: Option<String>,
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
    pub duration_ms: u32,
    pub relative_path: Option<String>,
    pub file_path: Option<String>,
    pub manifest_path: Option<String>,
    pub size_bytes: Option<f64>,
    pub frame_count: Option<u32>,
    pub codec: Option<String>,
    pub container: Option<String>,
    pub mime_type: Option<String>,
    pub encoder_name: Option<String>,
    pub is_playable: bool,
}

#[napi(object)]
pub struct JsTestSessionVideoSegmentTailResult {
    pub items: Vec<JsTestSessionVideoSegmentRecord>,
    pub next_cursor: Option<String>,
    pub reset: bool,
    pub total_count: u32,
}

impl From<TestSessionVideoSegmentRecord> for JsTestSessionVideoSegmentRecord {
    fn from(value: TestSessionVideoSegmentRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            segment_id: value.segment_id,
            session_id: value.session_id,
            stream_id: value.stream_id,
            status: value.status.as_str().to_string(),
            display_id: value.display_id,
            started_at_ms: value.started_at_ms as f64,
            ended_at_ms: value.ended_at_ms as f64,
            duration_ms: value.duration_ms,
            relative_path: value.relative_path,
            file_path: value.file_path,
            manifest_path: value.manifest_path,
            size_bytes: value.size_bytes.map(|bytes| bytes as f64),
            frame_count: value.frame_count,
            codec: value.codec,
            container: value.container,
            mime_type: value.mime_type,
            encoder_name: value.encoder_name,
            is_playable: value.is_playable,
        }
    }
}

#[derive(Default)]
#[napi(object)]
pub struct JsTestSessionNoteInput {
    pub title: Option<String>,
    pub message: Option<String>,
}

impl From<JsTestSessionNoteInput> for TestSessionNoteInput {
    fn from(value: JsTestSessionNoteInput) -> Self {
        Self {
            title: value.title,
            message: value.message,
        }
    }
}

#[derive(Default)]
#[napi(object)]
pub struct JsTestSessionLogInput {
    pub level: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
}

impl From<JsTestSessionLogInput> for TestSessionLogInput {
    fn from(value: JsTestSessionLogInput) -> Self {
        Self {
            level: value.level,
            source: value.source,
            message: value.message,
        }
    }
}

#[napi(object)]
pub struct JsTestSessionEventRecord {
    pub schema_version: u32,
    pub kind: String,
    pub event_id: String,
    pub session_id: String,
    pub event_type: String,
    pub log_category: String,
    pub occurred_at_ms: f64,
    pub status: Option<String>,
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
    pub dpi_scale: Option<f64>,
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
    pub control_name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub class_name: Option<String>,
    pub precision_level: Option<String>,
    pub char_count: Option<u32>,
    pub is_password: Option<bool>,
    pub shortcut: Option<String>,
}

#[napi(object)]
pub struct JsTestSessionEventTailResult {
    pub items: Vec<JsTestSessionEventRecord>,
    pub next_cursor: Option<String>,
    pub reset: bool,
    pub total_count: u32,
}

#[napi(object)]
pub struct JsUiElementPathEntry {
    pub control_type: Option<String>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
}

#[napi(object)]
pub struct JsUiBoundingRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct JsUiElementIdentity {
    pub runtime_id: Option<Vec<i32>>,
    pub process_id: Option<u32>,
    pub window_hwnd: Option<String>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub localized_control_type: Option<String>,
    pub class_name: Option<String>,
    pub framework_id: Option<String>,
    pub parent_path: Vec<JsUiElementPathEntry>,
    pub bounding_rect: Option<JsUiBoundingRect>,
}

#[napi(object)]
pub struct JsUiStateSnapshot {
    pub snapshot_id: String,
    pub captured_at_ms: f64,
    pub element: Option<JsUiElementIdentity>,
    pub is_enabled: Option<bool>,
    pub has_keyboard_focus: Option<bool>,
    pub is_offscreen: Option<bool>,
    pub value_length: Option<u32>,
    pub value_text: Option<String>,
    pub value_fingerprint: Option<String>,
    pub toggle_state: Option<String>,
    pub selection_state: Option<String>,
    pub selected_names: Option<Vec<String>>,
    pub expand_collapse_state: Option<String>,
    pub range_value: Option<f64>,
    pub privacy_class: String,
    pub source: Option<String>,
}

#[napi(object)]
pub struct JsOperationCoordinate {
    pub x: i32,
    pub y: i32,
    pub display_id: Option<String>,
}

#[napi(object)]
pub struct JsOperationActionConfidence {
    pub target: Option<f64>,
    pub temporal: Option<f64>,
    pub overall: Option<f64>,
}

#[napi(object)]
pub struct JsOperationAction {
    pub action_id: String,
    pub kind: String,
    pub occurred_at_ms: f64,
    pub ended_at_ms: Option<f64>,
    pub target: Option<JsUiElementIdentity>,
    pub state_before: Option<JsUiStateSnapshot>,
    pub coordinate: Option<JsOperationCoordinate>,
    pub source_event_ids: Vec<String>,
    pub target_reason_codes: Vec<String>,
    pub confidence: JsOperationActionConfidence,
    pub content_preview: Option<String>,
}

#[napi(object)]
pub struct JsStateTransitionConfidence {
    pub identity: Option<f64>,
    pub temporal: Option<f64>,
    pub transition: Option<f64>,
    pub overall: Option<f64>,
}

#[napi(object)]
pub struct JsStateTransition {
    pub transition_id: String,
    pub kind: String,
    pub occurred_at_ms: f64,
    pub element: Option<JsUiElementIdentity>,
    pub property: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub privacy_class: String,
    pub source_event_ids: Vec<String>,
    pub reason_codes: Vec<String>,
    pub confidence: JsStateTransitionConfidence,
}

#[napi(object)]
pub struct JsOperationOutcomeConfidence {
    pub temporal: Option<f64>,
    pub identity: Option<f64>,
    pub transition: Option<f64>,
    pub evidence: Option<f64>,
    pub overall: Option<f64>,
}

#[napi(object)]
pub struct JsOperationOutcome {
    pub outcome_id: String,
    pub status: String,
    pub summary: Option<String>,
    pub observed_at_ms: f64,
    pub latency_ms: f64,
    pub primary_transition_id: Option<String>,
    pub candidate_transition_ids: Vec<String>,
    pub reason_codes: Vec<String>,
    pub confidence: JsOperationOutcomeConfidence,
}

#[napi(object)]
pub struct JsOperationVideoRange {
    pub stream_id: String,
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
}

#[napi(object)]
pub struct JsOperationEvidence {
    pub evidence_id: String,
    pub kind: String,
    pub role: String,
    pub source_id: String,
    pub occurred_at_ms: f64,
    pub artifact_ref: Option<String>,
    pub video_range: Option<JsOperationVideoRange>,
    pub reason_code: Option<String>,
}

#[napi(object)]
pub struct JsTestSessionOperationRecord {
    pub schema_version: u32,
    pub kind: String,
    pub operation_id: String,
    pub session_id: String,
    pub sequence: u32,
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
    pub relative_ms_from_session_start: f64,
    pub action: JsOperationAction,
    pub outcome: JsOperationOutcome,
    pub completion_candidates: Vec<JsOperationOutcome>,
    pub transitions: Vec<JsStateTransition>,
    pub evidence: Vec<JsOperationEvidence>,
    pub title: String,
    pub result_summary: String,
    pub display_summary: String,
    pub precision_level: String,
    pub outcome_selection_source: String,
    pub edited: bool,
    pub ignored: bool,
    pub business_alias: Option<String>,
    pub manual_note: Option<String>,
}

#[napi(object)]
pub struct JsTestSessionOperationTailResult {
    pub items: Vec<JsTestSessionOperationRecord>,
    pub next_cursor: Option<String>,
    pub reset: bool,
    pub total_count: u32,
    pub diagnostics: Vec<JsOperationCompatibilityDiagnostic>,
}

#[napi(object)]
pub struct JsOperationCompatibilityDiagnostic {
    pub code: String,
    pub severity: String,
    pub line_number: Option<u32>,
    pub schema_version: Option<u32>,
    pub message: String,
}

#[derive(Default)]
#[napi(object)]
pub struct JsTestSessionOperationUpdateInput {
    pub session_id: Option<String>,
    pub operation_id: Option<String>,
    pub title: Option<String>,
    pub result_summary: Option<String>,
    pub selected_outcome_status: Option<String>,
    pub selected_transition_id: Option<String>,
    pub ignored: Option<bool>,
    pub business_alias: Option<String>,
    pub note: Option<String>,
    pub reason: Option<String>,
    pub occurred_at_ms: Option<f64>,
}

#[napi(object)]
pub struct JsTestSessionStepRecord {
    pub schema_version: u32,
    pub kind: String,
    pub step_id: String,
    pub session_id: String,
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
    pub relative_ms_from_session_start: f64,
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
    pub edited: bool,
    pub original_title: Option<String>,
    pub business_alias: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct JsTestSessionStepEditInput {
    pub session_id: Option<String>,
    pub step_id: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct JsSemanticAliasRule {
    pub match_control_name: Option<String>,
    pub match_automation_id: Option<String>,
    pub match_window_title_contains: Option<String>,
    pub match_title_contains: Option<String>,
    pub alias: Option<String>,
    pub alias_prefix: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct JsSemanticAliasProfile {
    pub profile_id: Option<String>,
    pub rules: Option<Vec<JsSemanticAliasRule>>,
}

#[napi(object)]
#[derive(Default)]
pub struct JsTestSessionDefectMarkInput {
    pub session_id: Option<String>,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<f64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}

#[napi(object)]
pub struct JsTestSessionDefectMarkRecord {
    pub event: JsTestSessionEventRecord,
    pub marked_at_ms: f64,
    pub window_start_ms: f64,
    pub window_end_ms: f64,
    pub pre_window_seconds: u32,
    pub post_window_seconds: u32,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub step_count: u32,
}

#[napi(object)]
#[derive(Default)]
pub struct JsTestSessionDefectPackExportInput {
    pub session_id: Option<String>,
    pub target_dir: Option<String>,
    pub marked_at_ms: Option<f64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

#[napi(object)]
pub struct JsTestSessionDefectPackResult {
    pub pack_dir: String,
    pub repro_steps_path: String,
    pub summary_path: String,
    pub steps_path: String,
    pub manifest_path: String,
    pub step_count: u32,
    pub screenshot_count: u32,
    pub video_segment_count: u32,
    pub clip_path: Option<String>,
    pub clip_built: bool,
}

impl From<TestSessionEventRecord> for JsTestSessionEventRecord {
    fn from(value: TestSessionEventRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            event_id: value.event_id,
            session_id: value.session_id,
            event_type: value.event_type.as_str().to_string(),
            log_category: value.event_type.log_category().to_string(),
            occurred_at_ms: value.occurred_at_ms as f64,
            status: value.status.map(|status| status.as_str().to_string()),
            step_id: value.step_id,
            action: value.action,
            x: value.x,
            y: value.y,
            logical_x: value.logical_x,
            logical_y: value.logical_y,
            window_left: value.window_left,
            window_top: value.window_top,
            window_right: value.window_right,
            window_bottom: value.window_bottom,
            logical_window_left: value.logical_window_left,
            logical_window_top: value.logical_window_top,
            logical_window_right: value.logical_window_right,
            logical_window_bottom: value.logical_window_bottom,
            display_id: value.display_id,
            dpi_scale: value.dpi_scale.map(|scale| scale as f64),
            process_name: value.process_name,
            window_title: value.window_title,
            title: value.title,
            message: value.message,
            log_level: value.log_level,
            log_source: value.log_source,
            system_source: value.system_source,
            window_hwnd: value.window_hwnd,
            window_pid: value.window_pid,
            clipboard_content_type: value.clipboard_content_type,
            image_bytes: value.image_bytes,
            capture_latency_ms: value.capture_latency_ms,
            encode_latency_ms: value.encode_latency_ms,
            source: value.source,
            capture_backend: value.capture_backend,
            full_image_path: value.full_image_path,
            thumb_image_path: value.thumb_image_path,
            control_name: value.control_name,
            automation_id: value.automation_id,
            control_type: value.control_type,
            class_name: value.class_name,
            precision_level: value.precision_level,
            char_count: value.char_count,
            is_password: value.is_password,
            shortcut: value.shortcut,
        }
    }
}

impl From<UiElementPathEntry> for JsUiElementPathEntry {
    fn from(value: UiElementPathEntry) -> Self {
        Self {
            control_type: value.control_type,
            name: value.name,
            automation_id: value.automation_id,
        }
    }
}

impl From<UiBoundingRect> for JsUiBoundingRect {
    fn from(value: UiBoundingRect) -> Self {
        Self {
            left: value.left,
            top: value.top,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<UiElementIdentity> for JsUiElementIdentity {
    fn from(value: UiElementIdentity) -> Self {
        Self {
            runtime_id: value.runtime_id,
            process_id: value.process_id,
            window_hwnd: value.window_hwnd,
            name: value.name,
            automation_id: value.automation_id,
            control_type: value.control_type,
            localized_control_type: value.localized_control_type,
            class_name: value.class_name,
            framework_id: value.framework_id,
            parent_path: value.parent_path.into_iter().map(Into::into).collect(),
            bounding_rect: value.bounding_rect.map(Into::into),
        }
    }
}

impl From<UiStateSnapshot> for JsUiStateSnapshot {
    fn from(value: UiStateSnapshot) -> Self {
        Self {
            snapshot_id: value.snapshot_id,
            captured_at_ms: value.captured_at_ms as f64,
            element: value.element.map(Into::into),
            is_enabled: value.is_enabled,
            has_keyboard_focus: value.has_keyboard_focus,
            is_offscreen: value.is_offscreen,
            value_length: value.value_length,
            value_text: value.value_text,
            value_fingerprint: value.value_fingerprint,
            toggle_state: value.toggle_state.map(|state| state.as_str().to_string()),
            selection_state: value
                .selection_state
                .map(|state| state.as_str().to_string()),
            selected_names: value.selected_names,
            expand_collapse_state: value
                .expand_collapse_state
                .map(|state| state.as_str().to_string()),
            range_value: value.range_value,
            privacy_class: value.privacy_class.as_str().to_string(),
            source: value.source.map(|source| source.as_str().to_string()),
        }
    }
}

impl From<OperationCoordinate> for JsOperationCoordinate {
    fn from(value: OperationCoordinate) -> Self {
        Self {
            x: value.x,
            y: value.y,
            display_id: value.display_id,
        }
    }
}

impl From<OperationActionConfidence> for JsOperationActionConfidence {
    fn from(value: OperationActionConfidence) -> Self {
        Self {
            target: value.target,
            temporal: value.temporal,
            overall: value.overall,
        }
    }
}

impl From<OperationAction> for JsOperationAction {
    fn from(value: OperationAction) -> Self {
        Self {
            action_id: value.action_id,
            kind: value.kind.as_str().to_string(),
            occurred_at_ms: value.occurred_at_ms as f64,
            ended_at_ms: value.ended_at_ms.map(|timestamp| timestamp as f64),
            target: value.target.map(Into::into),
            state_before: value.state_before.map(Into::into),
            coordinate: value.coordinate.map(Into::into),
            source_event_ids: value.source_event_ids,
            target_reason_codes: operation_reason_codes_to_strings(value.target_reason_codes),
            confidence: value.confidence.into(),
            content_preview: value.content_preview,
        }
    }
}

impl From<StateTransitionConfidence> for JsStateTransitionConfidence {
    fn from(value: StateTransitionConfidence) -> Self {
        Self {
            identity: value.identity,
            temporal: value.temporal,
            transition: value.transition,
            overall: value.overall,
        }
    }
}

impl From<StateTransition> for JsStateTransition {
    fn from(value: StateTransition) -> Self {
        Self {
            transition_id: value.transition_id,
            kind: value.kind.as_str().to_string(),
            occurred_at_ms: value.occurred_at_ms as f64,
            element: value.element.map(Into::into),
            property: value.property,
            before: value.before.map(json_value_to_string),
            after: value.after.map(json_value_to_string),
            privacy_class: value.privacy_class.as_str().to_string(),
            source_event_ids: value.source_event_ids,
            reason_codes: operation_reason_codes_to_strings(value.reason_codes),
            confidence: value.confidence.into(),
        }
    }
}

impl From<OperationOutcomeConfidence> for JsOperationOutcomeConfidence {
    fn from(value: OperationOutcomeConfidence) -> Self {
        Self {
            temporal: value.temporal,
            identity: value.identity,
            transition: value.transition,
            evidence: value.evidence,
            overall: value.overall,
        }
    }
}

impl From<OperationOutcome> for JsOperationOutcome {
    fn from(value: OperationOutcome) -> Self {
        Self {
            outcome_id: value.outcome_id,
            status: value.status.as_str().to_string(),
            summary: value.summary,
            observed_at_ms: value.observed_at_ms as f64,
            latency_ms: value.latency_ms as f64,
            primary_transition_id: value.primary_transition_id,
            candidate_transition_ids: value.candidate_transition_ids,
            reason_codes: operation_reason_codes_to_strings(value.reason_codes),
            confidence: value.confidence.into(),
        }
    }
}

impl From<OperationVideoRange> for JsOperationVideoRange {
    fn from(value: OperationVideoRange) -> Self {
        Self {
            stream_id: value.stream_id,
            started_at_ms: value.started_at_ms as f64,
            ended_at_ms: value.ended_at_ms as f64,
        }
    }
}

impl From<OperationEvidence> for JsOperationEvidence {
    fn from(value: OperationEvidence) -> Self {
        Self {
            evidence_id: value.evidence_id,
            kind: value.kind.as_str().to_string(),
            role: value.role.as_str().to_string(),
            source_id: value.source_id,
            occurred_at_ms: value.occurred_at_ms as f64,
            artifact_ref: value.artifact_ref,
            video_range: value.video_range.map(Into::into),
            reason_code: value.reason_code.map(|code| code.as_str().to_string()),
        }
    }
}

impl From<TestSessionOperationRecord> for JsTestSessionOperationRecord {
    fn from(value: TestSessionOperationRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            operation_id: value.operation_id,
            session_id: value.session_id,
            sequence: value.sequence,
            started_at_ms: value.started_at_ms as f64,
            ended_at_ms: value.ended_at_ms as f64,
            relative_ms_from_session_start: value.relative_ms_from_session_start as f64,
            action: value.action.into(),
            outcome: value.outcome.into(),
            completion_candidates: value
                .completion_candidates
                .into_iter()
                .map(Into::into)
                .collect(),
            transitions: value.transitions.into_iter().map(Into::into).collect(),
            evidence: value.evidence.into_iter().map(Into::into).collect(),
            title: value.title,
            result_summary: value.result_summary,
            display_summary: value.display_summary,
            precision_level: value.precision_level,
            outcome_selection_source: value.outcome_selection_source.as_str().to_string(),
            edited: value.edited,
            ignored: value.ignored,
            business_alias: value.business_alias,
            manual_note: value.manual_note,
        }
    }
}

impl From<OperationStoreDiagnostic> for JsOperationCompatibilityDiagnostic {
    fn from(value: OperationStoreDiagnostic) -> Self {
        Self {
            code: value.code,
            severity: value.severity,
            line_number: value
                .line_number
                .and_then(|line_number| u32::try_from(line_number).ok()),
            schema_version: value.schema_version,
            message: value.message,
        }
    }
}

impl From<TestSessionStepRecord> for JsTestSessionStepRecord {
    fn from(value: TestSessionStepRecord) -> Self {
        Self {
            schema_version: value.schema_version,
            kind: value.kind,
            step_id: value.step_id,
            session_id: value.session_id,
            started_at_ms: value.started_at_ms as f64,
            ended_at_ms: value.ended_at_ms as f64,
            relative_ms_from_session_start: value.relative_ms_from_session_start as f64,
            step_type: value.step_type,
            title: value.title,
            summary: value.summary,
            process_name: value.process_name,
            window_title: value.window_title,
            control_name: value.control_name,
            control_type: value.control_type,
            automation_id: value.automation_id,
            class_name: value.class_name,
            x: value.x,
            y: value.y,
            display_id: value.display_id,
            precision_level: value.precision_level,
            confidence: value.confidence,
            source_event_ids: value.source_event_ids,
            artifact_refs: value.artifact_refs,
            full_image_path: value.full_image_path,
            thumb_image_path: value.thumb_image_path,
            edited: value.edited,
            original_title: value.original_title,
            business_alias: value.business_alias,
        }
    }
}

impl From<JsTestSessionStepEditInput> for TestSessionStepEditInput {
    fn from(value: JsTestSessionStepEditInput) -> Self {
        Self {
            session_id: value.session_id,
            step_id: value.step_id.unwrap_or_default(),
            title: value.title,
            summary: value.summary,
        }
    }
}

impl From<JsSemanticAliasProfile> for SemanticAliasProfile {
    fn from(value: JsSemanticAliasProfile) -> Self {
        Self {
            profile_id: value.profile_id,
            rules: value
                .rules
                .unwrap_or_default()
                .into_iter()
                .map(|rule| SemanticAliasRule {
                    match_control_name: rule.match_control_name,
                    match_automation_id: rule.match_automation_id,
                    match_window_title_contains: rule.match_window_title_contains,
                    match_title_contains: rule.match_title_contains,
                    alias: rule.alias,
                    alias_prefix: rule.alias_prefix,
                })
                .collect(),
        }
    }
}

impl From<SemanticAliasProfile> for JsSemanticAliasProfile {
    fn from(value: SemanticAliasProfile) -> Self {
        Self {
            profile_id: value.profile_id,
            rules: Some(
                value
                    .rules
                    .into_iter()
                    .map(|rule| JsSemanticAliasRule {
                        match_control_name: rule.match_control_name,
                        match_automation_id: rule.match_automation_id,
                        match_window_title_contains: rule.match_window_title_contains,
                        match_title_contains: rule.match_title_contains,
                        alias: rule.alias,
                        alias_prefix: rule.alias_prefix,
                    })
                    .collect(),
            ),
        }
    }
}

impl From<JsTestSessionDefectMarkInput> for TestSessionDefectMarkInput {
    fn from(value: JsTestSessionDefectMarkInput) -> Self {
        Self {
            session_id: value.session_id,
            note: value.note,
            expected: value.expected,
            actual: value.actual,
            marked_at_ms: value.marked_at_ms.map(|ms| ms.max(0.0) as u64),
            pre_window_seconds: value.pre_window_seconds,
            post_window_seconds: value.post_window_seconds,
        }
    }
}

impl From<TestSessionDefectMarkRecord> for JsTestSessionDefectMarkRecord {
    fn from(value: TestSessionDefectMarkRecord) -> Self {
        Self {
            event: value.event.into(),
            marked_at_ms: value.marked_at_ms as f64,
            window_start_ms: value.window_start_ms as f64,
            window_end_ms: value.window_end_ms as f64,
            pre_window_seconds: value.pre_window_seconds,
            post_window_seconds: value.post_window_seconds,
            note: value.note,
            expected: value.expected,
            actual: value.actual,
            step_count: value.step_count,
        }
    }
}

impl From<DefectPackResult> for JsTestSessionDefectPackResult {
    fn from(value: DefectPackResult) -> Self {
        Self {
            pack_dir: value.pack_dir,
            repro_steps_path: value.repro_steps_path,
            summary_path: value.summary_path,
            steps_path: value.steps_path,
            manifest_path: value.manifest_path,
            step_count: value.step_count,
            screenshot_count: value.screenshot_count,
            video_segment_count: value.video_segment_count,
            clip_path: value.clip_path,
            clip_built: value.clip_built,
        }
    }
}

fn operation_reason_codes_to_strings(values: Vec<OperationReasonCode>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.as_str().to_string())
        .collect()
}

fn json_value_to_string(value: serde_json::Value) -> String {
    serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        JsActiveTestSessionVideoConfig, JsMaskRegion, JsRecorderConfig, JsRecorderMetrics,
        JsTestSessionDisplayTarget, JsTestSessionEventRecord, JsTestSessionRecord,
        JsTestSessionVideoSegmentRecord, JsTestSessionVideoStreamRecord,
    };
    use crate::config::DEFAULT_CAPTURE_REUSE_ENABLED;
    use crate::metrics::RecorderMetrics;
    use crate::session::{
        TestSessionDisplayTarget, TestSessionEventRecord, TestSessionEventType, TestSessionRecord,
        TestSessionStatus, TestSessionVideoSegmentRecord, TestSessionVideoSegmentStatus,
        TestSessionVideoStreamRecord, TestSessionVideoStreamStatus,
    };

    #[test]
    fn metrics_mapping_saturates_large_observability_counters() {
        let metrics = RecorderMetrics {
            captured_steps_total: u64::MAX,
            dropped_steps_total: u64::MAX,
            input_channel_full_drop_total: u64::MAX,
            capture_queue_drop_total: u64::MAX,
            encode_queue_drop_total: u64::MAX,
            push_dispatch_drop_total: u64::MAX,
            buffer_steps: u32::MAX,
            buffer_bytes: u64::MAX,
            last_capture_latency_ms: 123,
            last_encode_latency_ms: 45,
            stream_backpressure_ms: 321,
            last_image_bytes: 4096,
            current_effective_quality: 72.0,
            quality_adjust_down_count: u32::MAX,
            quality_adjust_up_count: u32::MAX,
            wgc_capture_count: u64::MAX,
            dxgi_capture_count: u64::MAX,
            effective_input_mode: "raw_input".to_string(),
            effective_delta_mode: "dirty_rect".to_string(),
            dirty_rect_supported: true,
            dirty_rect_update_frames_total: u64::MAX,
            dirty_rect_empty_frames_total: u64::MAX,
            dirty_rect_encode_skip_total: u64::MAX,
            dirty_region_frame_total: u64::MAX,
            dirty_region_empty_frame_total: u64::MAX,
            dirty_region_coverage_avg: 0.375,
            backend_fallback_total: u64::MAX,
            capture_context_reset_total: u64::MAX,
            uia_observer_queue_depth: u32::MAX,
            uia_observer_dropped_total: u64::MAX,
            uia_observer_duplicate_drop_total: u64::MAX,
            uia_observer_rate_limit_drop_total: u64::MAX,
            uia_observer_queue_overflow_total: u64::MAX,
            uia_observer_timeout_total: u64::MAX,
            uia_observer_restart_total: u64::MAX,
            uia_observer_circuit_open: true,
            uia_observer_polling_attempt_total: u64::MAX,
        };

        let mapped: JsRecorderMetrics = metrics.into();
        assert_eq!(mapped.backend_fallback_total, u32::MAX);
        assert_eq!(mapped.capture_context_reset_total, u32::MAX);
        assert_eq!(mapped.input_channel_full_drop_total, u32::MAX);
        assert_eq!(mapped.capture_queue_drop_total, u32::MAX);
        assert_eq!(mapped.encode_queue_drop_total, u32::MAX);
        assert_eq!(mapped.push_dispatch_drop_total, u32::MAX);
        assert_eq!(mapped.effective_delta_mode.as_deref(), Some("dirty_rect"));
        assert!(mapped.dirty_rect_supported);
        assert_eq!(mapped.dirty_rect_update_frames_total, u32::MAX);
        assert_eq!(mapped.dirty_rect_empty_frames_total, u32::MAX);
        assert_eq!(mapped.dirty_rect_encode_skip_total, u32::MAX);
        assert_eq!(mapped.dirty_region_frame_total, u32::MAX);
        assert_eq!(mapped.dirty_region_empty_frame_total, u32::MAX);
        assert_eq!(mapped.dirty_region_coverage_avg, 0.375);
        assert_eq!(mapped.uia_observer_queue_depth, u32::MAX);
        assert_eq!(mapped.uia_observer_dropped_total, u32::MAX);
        assert_eq!(mapped.uia_observer_duplicate_drop_total, u32::MAX);
        assert_eq!(mapped.uia_observer_rate_limit_drop_total, u32::MAX);
        assert_eq!(mapped.uia_observer_queue_overflow_total, u32::MAX);
        assert_eq!(mapped.uia_observer_timeout_total, u32::MAX);
        assert_eq!(mapped.uia_observer_restart_total, u32::MAX);
        assert!(mapped.uia_observer_circuit_open);
        assert_eq!(mapped.uia_observer_polling_attempt_total, u32::MAX);
    }

    #[test]
    fn metrics_mapping_omits_empty_effective_modes() {
        let metrics = RecorderMetrics {
            effective_input_mode: String::new(),
            effective_delta_mode: String::new(),
            ..RecorderMetrics::default()
        };

        let mapped: JsRecorderMetrics = metrics.into();
        assert_eq!(mapped.effective_input_mode, None);
        assert_eq!(mapped.effective_delta_mode, None);
    }

    #[test]
    fn config_mapping_defaults_capture_reuse_enabled() {
        let config: crate::config::RecorderConfig = JsRecorderConfig {
            capture_reuse_enabled: None,
            ..JsRecorderConfig::default()
        }
        .into();
        assert_eq!(config.capture_reuse_enabled, DEFAULT_CAPTURE_REUSE_ENABLED);
    }

    #[test]
    fn config_mapping_respects_capture_reuse_override() {
        let config: crate::config::RecorderConfig = JsRecorderConfig {
            capture_reuse_enabled: Some(false),
            ..JsRecorderConfig::default()
        }
        .into();
        assert!(!config.capture_reuse_enabled);
    }

    #[test]
    fn config_mapping_uses_legacy_defect_flag_for_semantic_default() {
        let config: crate::config::RecorderConfig = JsRecorderConfig {
            defect_evidence_enabled: Some(true),
            semantic_recording_enabled: None,
            ..JsRecorderConfig::default()
        }
        .into();
        assert!(config.defect_evidence_enabled);
        assert!(config.semantic_recording_enabled);
    }

    #[test]
    fn config_mapping_keeps_semantic_rollout_flags_independent() {
        let config: crate::config::RecorderConfig = JsRecorderConfig {
            semantic_recording_enabled: Some(true),
            uia_observer_enabled: Some(true),
            operation_builder_enabled: Some(false),
            operation_review_v2_enabled: Some(true),
            semantic_plaintext_input_enabled: Some(false),
            ..JsRecorderConfig::default()
        }
        .into();
        assert!(config.semantic_recording_enabled);
        assert!(config.uia_observer_enabled);
        assert!(!config.operation_builder_enabled);
        assert!(config.operation_review_v2_enabled);
        assert!(!config.semantic_plaintext_input_enabled);
    }

    #[test]
    fn config_mapping_preserves_privacy_rules() {
        let config: crate::config::RecorderConfig = JsRecorderConfig {
            privacy_enabled: Some(true),
            excluded_window_title_keywords: Some(vec!["Password".to_string()]),
            excluded_process_names: Some(vec!["secret.exe".to_string()]),
            mask_regions: Some(vec![JsMaskRegion {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
                label: "token".to_string(),
            }]),
            ..JsRecorderConfig::default()
        }
        .into();

        assert!(config.privacy_enabled);
        assert_eq!(config.excluded_window_title_keywords, vec!["Password"]);
        assert_eq!(config.excluded_process_names, vec!["secret.exe"]);
        assert_eq!(config.mask_regions[0].label, "token");
    }

    #[test]
    fn test_session_mapping_preserves_flattened_fields() {
        let session = TestSessionRecord {
            schema_version: 1,
            kind: "reqcase.test-session".to_string(),
            session_id: "ts-1-1".to_string(),
            name: Some("Smoke".to_string()),
            status: TestSessionStatus::Paused,
            started_at_ms: 1,
            updated_at_ms: 2,
            ended_at_ms: Some(3),
            storage_root_dir: Some("D:/sessions".to_string()),
            session_dir: Some("D:/sessions/ts-1-1".to_string()),
            manifest_path: Some("D:/sessions/ts-1-1/session.json".to_string()),
            buffer_window_seconds: 90,
            segment_duration_seconds: 5,
            recording_profile: "smooth".to_string(),
            encoder_preference: "hardware".to_string(),
            show_mouse_in_video: true,
            notes: Some("notes".to_string()),
            target_process_name: Some("demo.exe".to_string()),
            target_pid: Some(42),
            target_hwnd: Some("100".to_string()),
            target_display_id: Some("display-1".to_string()),
            target_display_ids: Some(vec!["display-1".to_string(), "display-2".to_string()]),
            target_capture_mode: "foreground_window".to_string(),
        };

        let mapped: JsTestSessionRecord = session.into();
        assert_eq!(mapped.status, "paused");
        assert_eq!(mapped.target_pid, Some(42));
        assert_eq!(mapped.target_display_id.as_deref(), Some("display-1"));
        assert_eq!(
            mapped.target_display_ids,
            Some(vec!["display-1".to_string(), "display-2".to_string()]),
        );
        assert_eq!(mapped.recording_profile, "smooth");
        assert_eq!(mapped.encoder_preference, "hardware");
        assert!(mapped.show_mouse_in_video);
        assert_eq!(mapped.target_capture_mode, "foreground_window");
    }

    #[test]
    fn active_test_session_video_config_defaults_to_none() {
        let config = JsActiveTestSessionVideoConfig::default();
        assert_eq!(config.recording_profile, None);
        assert_eq!(config.encoder_preference, None);
        assert_eq!(config.show_mouse_in_video, None);
    }

    #[test]
    fn test_session_display_target_mapping_preserves_monitor_fields() {
        let display = TestSessionDisplayTarget {
            display_id: "display-primary".to_string(),
            label: "Primary Display".to_string(),
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1440,
            width: 2560,
            height: 1440,
            is_primary: true,
        };

        let mapped: JsTestSessionDisplayTarget = display.into();
        assert_eq!(mapped.display_id, "display-primary");
        assert_eq!(mapped.label, "Primary Display");
        assert_eq!(mapped.width, 2560);
        assert!(mapped.is_primary);
    }

    #[test]
    fn test_session_video_stream_mapping_preserves_display_fields() {
        let stream = TestSessionVideoStreamRecord {
            schema_version: 1,
            kind: "reqcase.test-session-video-stream".to_string(),
            stream_id: "vs-1".to_string(),
            session_id: "ts-1-1".to_string(),
            label: "Primary Display".to_string(),
            status: TestSessionVideoStreamStatus::Planned,
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            display_label: Some("Primary Display".to_string()),
            width: Some(1920),
            height: Some(1080),
            monitor_left: Some(0),
            monitor_top: Some(0),
            monitor_right: Some(1920),
            monitor_bottom: Some(1080),
            started_at_ms: 1,
            updated_at_ms: 2,
            segment_duration_seconds: 3,
            segment_count: 0,
            playable_segment_count: 0,
            pending_segment_count: 0,
            total_segment_bytes: 0,
            retained_segment_bytes: 0,
            last_segment_bytes: Some(2048),
            last_segment_duration_ms: Some(3000),
            last_segment_frame_count: Some(12),
            last_capture_latency_ms: Some(32),
            last_encode_latency_ms: Some(180),
            sample_interval_ms: 66,
            target_fps: 15,
            encoder_available: true,
            warning_count: 1,
            last_warning: Some("segment bytes exceeded soft limit".to_string()),
            stream_dir: Some("D:/sessions/ts-1-1/video/streams/vs-1".to_string()),
            manifest_path: Some("D:/sessions/ts-1-1/video/streams/vs-1/stream.json".to_string()),
            playlist_path: Some("D:/sessions/ts-1-1/video/streams/vs-1/playlist.m3u8".to_string()),
        };

        let mapped: JsTestSessionVideoStreamRecord = stream.into();
        assert_eq!(mapped.status, "planned");
        assert_eq!(mapped.display_id.as_deref(), Some("display-1"));
        assert_eq!(mapped.segment_duration_seconds, 3);
        assert_eq!(mapped.sample_interval_ms, 66);
        assert!(mapped.encoder_available);
        assert_eq!(mapped.warning_count, 1);
    }

    #[test]
    fn test_session_video_segment_mapping_preserves_media_fields() {
        let segment = TestSessionVideoSegmentRecord {
            schema_version: 1,
            kind: "reqcase.test-session-video-segment".to_string(),
            segment_id: "seg-1".to_string(),
            session_id: "ts-1-1".to_string(),
            stream_id: "vs-1".to_string(),
            status: TestSessionVideoSegmentStatus::Ready,
            display_id: Some("display-1".to_string()),
            started_at_ms: 10,
            ended_at_ms: 15,
            duration_ms: 5000,
            relative_path: Some("video/streams/vs-1/segment-0001.mp4".to_string()),
            file_path: Some("D:/sessions/ts-1-1/video/streams/vs-1/segment-0001.mp4".to_string()),
            manifest_path: Some(
                "D:/sessions/ts-1-1/video/streams/vs-1/segment-0001.json".to_string(),
            ),
            size_bytes: Some(2048),
            frame_count: Some(48),
            codec: Some("h264".to_string()),
            container: Some("mp4".to_string()),
            mime_type: Some("video/mp4".to_string()),
            encoder_name: Some("ffmpeg:libx264".to_string()),
            is_playable: true,
        };

        let mapped: JsTestSessionVideoSegmentRecord = segment.into();
        assert_eq!(mapped.status, "ready");
        assert_eq!(mapped.container.as_deref(), Some("mp4"));
        assert_eq!(mapped.size_bytes, Some(2048.0));
        assert_eq!(mapped.mime_type.as_deref(), Some("video/mp4"));
        assert_eq!(mapped.encoder_name.as_deref(), Some("ffmpeg:libx264"));
        assert!(mapped.is_playable);
    }

    #[test]
    fn test_session_event_mapping_preserves_step_fields() {
        let event = TestSessionEventRecord {
            schema_version: 1,
            kind: "reqcase.test-session-event".to_string(),
            event_id: "evt-1-1".to_string(),
            session_id: "ts-1-1".to_string(),
            event_type: TestSessionEventType::StepCaptured,
            occurred_at_ms: 5,
            status: None,
            step_id: Some("9".to_string()),
            action: Some("WM_LBUTTONDOWN".to_string()),
            x: Some(1),
            y: Some(2),
            logical_x: Some(1),
            logical_y: Some(2),
            window_left: Some(0),
            window_top: Some(0),
            window_right: Some(10),
            window_bottom: Some(10),
            logical_window_left: Some(0),
            logical_window_top: Some(0),
            logical_window_right: Some(10),
            logical_window_bottom: Some(10),
            display_id: Some("display-1".to_string()),
            dpi_scale: Some(1.0),
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            title: None,
            message: None,
            log_level: None,
            log_source: None,
            system_source: None,
            window_hwnd: None,
            window_pid: None,
            clipboard_content_type: None,
            image_bytes: Some(128),
            capture_latency_ms: Some(11),
            encode_latency_ms: Some(12),
            source: Some("hook".to_string()),
            capture_backend: Some("dxgi".to_string()),
            full_image_path: Some("D:/tmp/full.webp".to_string()),
            thumb_image_path: Some("D:/tmp/thumb.webp".to_string()),
            control_name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,
        };

        let mapped: JsTestSessionEventRecord = event.into();
        assert_eq!(mapped.event_type, "step_captured");
        assert_eq!(mapped.log_category, "operation");
        assert_eq!(mapped.step_id.as_deref(), Some("9"));
        assert_eq!(mapped.full_image_path.as_deref(), Some("D:/tmp/full.webp"));
    }

    #[test]
    fn test_session_event_mapping_preserves_note_and_log_fields() {
        let event = TestSessionEventRecord {
            schema_version: 1,
            kind: "reqcase.test-session-event".to_string(),
            event_id: "evt-2-1".to_string(),
            session_id: "ts-1-1".to_string(),
            event_type: TestSessionEventType::AppLogAdded,
            occurred_at_ms: 9,
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
            title: Some("Checkpoint".to_string()),
            message: Some("fallback path used".to_string()),
            log_level: Some("warn".to_string()),
            log_source: Some("benchmark".to_string()),
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
        };

        let mapped: JsTestSessionEventRecord = event.into();
        assert_eq!(mapped.log_category, "app");
        assert_eq!(mapped.title.as_deref(), Some("Checkpoint"));
        assert_eq!(mapped.message.as_deref(), Some("fallback path used"));
        assert_eq!(mapped.log_level.as_deref(), Some("warn"));
        assert_eq!(mapped.log_source.as_deref(), Some("benchmark"));
    }

    #[test]
    fn test_session_event_mapping_preserves_system_event_fields() {
        let event = TestSessionEventRecord {
            schema_version: 1,
            kind: "reqcase.test-session-event".to_string(),
            event_id: "evt-3-1".to_string(),
            session_id: "ts-1-1".to_string(),
            event_type: TestSessionEventType::ClipboardUpdated,
            occurred_at_ms: 13,
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
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            title: Some("剪贴板已更新".to_string()),
            message: Some("clipboard type: text".to_string()),
            log_level: None,
            log_source: None,
            system_source: Some("clipboard".to_string()),
            window_hwnd: Some("0x100".to_string()),
            window_pid: Some(42),
            clipboard_content_type: Some("text".to_string()),
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
        };

        let mapped: JsTestSessionEventRecord = event.into();
        assert_eq!(mapped.event_type, "clipboard_updated");
        assert_eq!(mapped.log_category, "system");
        assert_eq!(mapped.system_source.as_deref(), Some("clipboard"));
        assert_eq!(mapped.window_hwnd.as_deref(), Some("0x100"));
        assert_eq!(mapped.window_pid, Some(42));
        assert_eq!(mapped.clipboard_content_type.as_deref(), Some("text"));
    }

    #[test]
    fn test_session_event_mapping_preserves_additional_window_event_types() {
        let event = TestSessionEventRecord {
            schema_version: 1,
            kind: "reqcase.test-session-event".to_string(),
            event_id: "evt-4-1".to_string(),
            session_id: "ts-1-1".to_string(),
            event_type: TestSessionEventType::WindowHidden,
            occurred_at_ms: 21,
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
            process_name: Some("demo.exe".to_string()),
            window_title: Some("Demo".to_string()),
            title: Some("窗口已隐藏".to_string()),
            message: Some("window hidden".to_string()),
            log_level: None,
            log_source: None,
            system_source: Some("win_event".to_string()),
            window_hwnd: Some("0x222".to_string()),
            window_pid: Some(84),
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
        };

        let mapped: JsTestSessionEventRecord = event.into();
        assert_eq!(mapped.event_type, "window_hidden");
        assert_eq!(mapped.log_category, "system");
        assert_eq!(mapped.system_source.as_deref(), Some("win_event"));
        assert_eq!(mapped.window_hwnd.as_deref(), Some("0x222"));
    }
}
