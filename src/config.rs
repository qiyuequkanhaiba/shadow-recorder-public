pub const DEFAULT_MAX_STEPS: usize = 20;
pub const MIN_MAX_STEPS: usize = 5;
pub const MAX_MAX_STEPS: usize = 100;

pub const DEFAULT_MAX_BUFFER_BYTES: usize = 150 * 1024 * 1024;
pub const MIN_MAX_BUFFER_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_MAX_BUFFER_BYTES: usize = 1024 * 1024 * 1024;

pub const DEFAULT_DEBOUNCE_MS: u64 = 90;
pub const DEFAULT_WEBP_QUALITY: f32 = 75.0;

pub const DEFAULT_ADAPTIVE_QUALITY_ENABLED: bool = true;
pub const DEFAULT_ADAPTIVE_BUFFER_HIGH_RATIO: f32 = 0.80;
pub const DEFAULT_ADAPTIVE_BUFFER_LOW_RATIO: f32 = 0.55;
pub const DEFAULT_ADAPTIVE_LATENCY_HIGH_MS: u32 = 90;
pub const DEFAULT_ADAPTIVE_LATENCY_LOW_MS: u32 = 45;
pub const DEFAULT_ADAPTIVE_TARGET_IMAGE_KB: u32 = 100;
pub const DEFAULT_ADAPTIVE_STEP_DOWN: f32 = 6.0;
pub const DEFAULT_ADAPTIVE_STEP_UP: f32 = 2.0;
pub const DEFAULT_ADAPTIVE_MIN_QUALITY: f32 = 25.0;
pub const DEFAULT_ADAPTIVE_MAX_QUALITY: f32 = 90.0;
pub const DEFAULT_CAPTURE_REUSE_ENABLED: bool = true;
pub const DEFAULT_STRICT_BACKEND: bool = false;
pub const DEFAULT_THUMB_WEBP_QUALITY: f32 = 45.0;
pub const DEFAULT_SEMANTIC_RECORDING_ENABLED: bool = false;
pub const DEFAULT_UIA_OBSERVER_ENABLED: bool = false;
pub const DEFAULT_OPERATION_BUILDER_ENABLED: bool = false;
pub const DEFAULT_OPERATION_REVIEW_V2_ENABLED: bool = false;
/// Plaintext semantic input capture requires an explicit opt-in. Password controls are never stored.
pub const DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED: bool = false;
pub const DEFAULT_UIA_OBSERVER_DEDUP_MS: u64 = 50;
pub const DEFAULT_UIA_OBSERVER_EVENT_BUDGET_PER_SECOND: u32 = 240;
pub const DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND: u32 = 80;
pub const DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK: u32 = 768;
#[cfg_attr(any(test, not(windows)), allow(dead_code))]
pub const DEFAULT_UIA_OBSERVER_POLLING_DELAYS_MS: [u64; 5] = [100, 300, 700, 1500, 3000];

use crate::privacy::MaskRegion;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureBackendMode {
    #[default]
    Auto,
    Dxgi,
    Wgc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransportMode {
    #[default]
    Poll,
    Push,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InputMode {
    #[default]
    Auto,
    Hook,
    RawInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeltaMode {
    Off,
    #[default]
    HashDedup,
    DirtyRect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamPayloadMode {
    #[default]
    MetaOnly,
    MetaPlusThumb,
    Full,
}

#[derive(Debug, Clone)]
pub struct RecorderConfig {
    pub max_steps: usize,
    pub max_buffer_bytes: usize,
    pub debounce_ms: u64,
    pub webp_quality: f32,
    pub thumb_webp_quality: f32,
    pub adaptive_quality_enabled: bool,
    pub adaptive_buffer_high_ratio: f32,
    pub adaptive_buffer_low_ratio: f32,
    pub adaptive_latency_high_ms: u32,
    pub adaptive_latency_low_ms: u32,
    pub adaptive_target_image_kb: u32,
    pub adaptive_step_down: f32,
    pub adaptive_step_up: f32,
    pub adaptive_min_quality: f32,
    pub adaptive_max_quality: f32,
    pub input_mode: InputMode,
    pub capture_backend: CaptureBackendMode,
    pub strict_backend: bool,
    pub delta_mode: DeltaMode,
    pub transport_mode: TransportMode,
    pub stream_payload: StreamPayloadMode,
    pub capture_reuse_enabled: bool,
    pub privacy_enabled: bool,
    pub defect_evidence_enabled: bool,
    pub semantic_recording_enabled: bool,
    #[allow(dead_code)]
    pub uia_observer_enabled: bool,
    #[allow(dead_code)]
    pub operation_builder_enabled: bool,
    pub operation_review_v2_enabled: bool,
    #[allow(dead_code)]
    pub semantic_plaintext_input_enabled: bool,
    pub defect_pre_window_seconds: u32,
    pub defect_post_window_seconds: u32,
    pub excluded_window_title_keywords: Vec<String>,
    pub excluded_process_names: Vec<String>,
    pub mask_regions: Vec<MaskRegion>,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            max_steps: DEFAULT_MAX_STEPS,
            max_buffer_bytes: DEFAULT_MAX_BUFFER_BYTES,
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            webp_quality: DEFAULT_WEBP_QUALITY,
            thumb_webp_quality: DEFAULT_THUMB_WEBP_QUALITY,
            adaptive_quality_enabled: DEFAULT_ADAPTIVE_QUALITY_ENABLED,
            adaptive_buffer_high_ratio: DEFAULT_ADAPTIVE_BUFFER_HIGH_RATIO,
            adaptive_buffer_low_ratio: DEFAULT_ADAPTIVE_BUFFER_LOW_RATIO,
            adaptive_latency_high_ms: DEFAULT_ADAPTIVE_LATENCY_HIGH_MS,
            adaptive_latency_low_ms: DEFAULT_ADAPTIVE_LATENCY_LOW_MS,
            adaptive_target_image_kb: DEFAULT_ADAPTIVE_TARGET_IMAGE_KB,
            adaptive_step_down: DEFAULT_ADAPTIVE_STEP_DOWN,
            adaptive_step_up: DEFAULT_ADAPTIVE_STEP_UP,
            adaptive_min_quality: DEFAULT_ADAPTIVE_MIN_QUALITY,
            adaptive_max_quality: DEFAULT_ADAPTIVE_MAX_QUALITY,
            input_mode: InputMode::default(),
            capture_backend: CaptureBackendMode::default(),
            strict_backend: DEFAULT_STRICT_BACKEND,
            delta_mode: DeltaMode::default(),
            transport_mode: TransportMode::default(),
            stream_payload: StreamPayloadMode::default(),
            capture_reuse_enabled: DEFAULT_CAPTURE_REUSE_ENABLED,
            privacy_enabled: false,
            defect_evidence_enabled: false,
            semantic_recording_enabled: DEFAULT_SEMANTIC_RECORDING_ENABLED,
            uia_observer_enabled: DEFAULT_UIA_OBSERVER_ENABLED,
            operation_builder_enabled: DEFAULT_OPERATION_BUILDER_ENABLED,
            operation_review_v2_enabled: DEFAULT_OPERATION_REVIEW_V2_ENABLED,
            semantic_plaintext_input_enabled: DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED,
            defect_pre_window_seconds: 60,
            defect_post_window_seconds: 20,
            excluded_window_title_keywords: Vec::new(),
            excluded_process_names: Vec::new(),
            mask_regions: Vec::new(),
        }
    }
}

impl RecorderConfig {
    pub fn normalized(mut self) -> Self {
        self.max_steps = self.max_steps.clamp(MIN_MAX_STEPS, MAX_MAX_STEPS);
        self.max_buffer_bytes = self
            .max_buffer_bytes
            .clamp(MIN_MAX_BUFFER_BYTES, MAX_MAX_BUFFER_BYTES);
        self.adaptive_buffer_high_ratio = self.adaptive_buffer_high_ratio.clamp(0.55, 0.98);
        self.adaptive_buffer_low_ratio = self
            .adaptive_buffer_low_ratio
            .clamp(0.20, (self.adaptive_buffer_high_ratio - 0.05).max(0.20));

        self.adaptive_latency_high_ms = self.adaptive_latency_high_ms.clamp(20, 5000);
        self.adaptive_latency_low_ms = self
            .adaptive_latency_low_ms
            .clamp(10, self.adaptive_latency_high_ms.saturating_sub(5).max(10));
        self.adaptive_target_image_kb = self.adaptive_target_image_kb.clamp(30, 4096);

        self.adaptive_step_down = self.adaptive_step_down.clamp(1.0, 30.0);
        self.adaptive_step_up = self.adaptive_step_up.clamp(0.5, 20.0);

        self.adaptive_min_quality = self.adaptive_min_quality.clamp(10.0, 94.0);
        self.adaptive_max_quality = self
            .adaptive_max_quality
            .clamp(self.adaptive_min_quality + 1.0, 95.0);
        self.webp_quality = self
            .webp_quality
            .clamp(self.adaptive_min_quality, self.adaptive_max_quality);
        self.thumb_webp_quality = self.thumb_webp_quality.clamp(10.0, 90.0);
        self.excluded_window_title_keywords =
            normalize_keywords(self.excluded_window_title_keywords);
        self.excluded_process_names = normalize_keywords(self.excluded_process_names);
        self.mask_regions
            .retain(|region| region.width > 0 && region.height > 0);
        self
    }
}

fn normalize_keywords(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .fold(Vec::new(), |mut collected, value| {
            if !collected.contains(&value) {
                collected.push(value);
            }
            collected
        })
}
