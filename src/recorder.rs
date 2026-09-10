use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use std::{collections::hash_map::DefaultHasher, hash::Hash, hash::Hasher};

use base64::Engine;
use crossbeam_channel::{Receiver, Sender, bounded};
use napi::Status as NapiStatus;
use napi::threadsafe_function::{
    ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use once_cell::sync::Lazy;

use crate::capture_policy::capture_with_backend_policy;
use crate::config::{
    CaptureBackendMode, DeltaMode, RecorderConfig, StreamPayloadMode, TransportMode,
};
use crate::dxgi::{CaptureOutput, capture_active_window_webp, release_dxgi_capture_resources};
use crate::error::RecorderError;
use crate::hooks::{MouseEvent, reset_stop_flag, uninstall_hook, update_debounce_ms};
use crate::input::run_input_thread;
use crate::metrics::RecorderMetrics;
use crate::privacy::PrivacyPolicy;
use crate::quality_policy::{AdaptiveInputs, compute_effective_quality};
use crate::raw_input::update_raw_input_debounce_ms;
use crate::session::TEST_SESSION_MANAGER;
use crate::storage::RingBuffer;
use crate::telemetry::{
    inc_backend_fallback, inc_encode_queue_drop, read_backend_fallback_total,
    read_capture_context_reset_total, read_capture_queue_drop_total, read_effective_input_mode,
    read_encode_queue_drop_total, read_input_channel_full_drop_total,
    read_uia_observer_circuit_open, read_uia_observer_dropped_total,
    read_uia_observer_duplicate_drop_total, read_uia_observer_polling_attempt_total,
    read_uia_observer_queue_depth, read_uia_observer_queue_overflow_total,
    read_uia_observer_rate_limit_drop_total, read_uia_observer_restart_total,
    read_uia_observer_timeout_total,
};
use crate::types::{CaptureBackendUsed, StepData, StepSource};
use crate::wgc::{capture_active_window_wgc_webp, release_wgc_capture_resources};

const THUMB_MAX_EDGE: u32 = 320;

#[derive(Clone)]
struct StepSubscriber {
    callback: ThreadsafeFunction<StepData>,
    payload_mode: StreamPayloadMode,
}

fn hash_bytes_fingerprint(input: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}

fn encode_webp_from_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    quality: f32,
) -> Result<Vec<u8>, RecorderError> {
    if width == 0 || height == 0 || rgba.is_empty() {
        return Err(RecorderError::DxgiCaptureFailed(
            "cannot encode empty frame".to_string(),
        ));
    }

    let expected = usize::try_from(width)
        .unwrap_or(0)
        .saturating_mul(usize::try_from(height).unwrap_or(0))
        .saturating_mul(4);
    if rgba.len() < expected {
        return Err(RecorderError::DxgiCaptureFailed(
            "frame buffer smaller than expected".to_string(),
        ));
    }

    let encoder = webp::Encoder::from_rgba(rgba, width, height);
    Ok(encoder.encode(quality).to_vec())
}

fn physical_to_logical(value: i32, dpi_scale: f32) -> i32 {
    let scale = if dpi_scale <= 0.0 { 1.0 } else { dpi_scale };
    ((value as f32) / scale).round() as i32
}

fn step_source_for_input_mode(input_mode: crate::config::InputMode) -> StepSource {
    match input_mode {
        crate::config::InputMode::RawInput => StepSource::RawInput,
        crate::config::InputMode::Hook => StepSource::Hook,
        crate::config::InputMode::Auto => {
            if read_effective_input_mode() == "raw_input" {
                StepSource::RawInput
            } else {
                StepSource::Hook
            }
        }
    }
}

fn capture_backend_used_for_failure(capture_backend: CaptureBackendMode) -> CaptureBackendUsed {
    match capture_backend {
        CaptureBackendMode::Wgc => CaptureBackendUsed::Wgc,
        CaptureBackendMode::Auto | CaptureBackendMode::Dxgi => CaptureBackendUsed::Dxgi,
    }
}

fn build_capture_failed_step(
    event: MouseEvent,
    id: u64,
    source: StepSource,
    capture_backend: CaptureBackendUsed,
) -> StepData {
    StepData {
        id,
        timestamp_ms: event.timestamp_ms,
        action: event.action,
        x: event.x,
        y: event.y,
        logical_x: event.x,
        logical_y: event.y,
        window_left: 0,
        window_top: 0,
        window_right: 0,
        window_bottom: 0,
        logical_window_left: 0,
        logical_window_top: 0,
        logical_window_right: 0,
        logical_window_bottom: 0,
        display_id: String::new(),
        dpi_scale: 1.0,
        process_name: String::new(),
        window_title: String::new(),
        image_webp: Vec::new(),
        image_thumb_webp: Vec::new(),
        image_bytes: 0,
        capture_latency_ms: 0,
        encode_latency_ms: 0,
        source,
        capture_backend,
    }
}

fn downscale_rgba_nearest(
    rgba: &[u8],
    width: u32,
    height: u32,
    max_edge: u32,
) -> (Vec<u8>, u32, u32) {
    if width == 0 || height == 0 || rgba.is_empty() {
        return (Vec::new(), 0, 0);
    }

    let max_dim = width.max(height);
    if max_dim <= max_edge {
        return (rgba.to_vec(), width, height);
    }

    let scale = max_edge as f32 / max_dim as f32;
    let target_width = ((width as f32 * scale).round() as u32).max(1);
    let target_height = ((height as f32 * scale).round() as u32).max(1);
    let mut out = vec![0u8; (target_width * target_height * 4) as usize];

    let src_w = width as usize;
    let dst_w = target_width as usize;
    let dst_h = target_height as usize;
    for y in 0..dst_h {
        let src_y = ((y as f32 * height as f32 / target_height as f32).floor() as u32)
            .min(height.saturating_sub(1)) as usize;
        for x in 0..dst_w {
            let src_x = ((x as f32 * width as f32 / target_width as f32).floor() as u32)
                .min(width.saturating_sub(1)) as usize;

            let src_offset = (src_y * src_w + src_x) * 4;
            let dst_offset = (y * dst_w + x) * 4;
            out[dst_offset..dst_offset + 4].copy_from_slice(&rgba[src_offset..src_offset + 4]);
        }
    }

    (out, target_width, target_height)
}

#[derive(Clone)]
struct RecorderState {
    config: RecorderConfig,
    buffer: RingBuffer,
    running: bool,
    metrics: RecorderMetrics,
}

impl Default for RecorderState {
    fn default() -> Self {
        let config = RecorderConfig::default();
        let metrics = RecorderMetrics {
            current_effective_quality: config.webp_quality,
            effective_delta_mode: match config.delta_mode {
                DeltaMode::Off => "off".to_string(),
                DeltaMode::HashDedup => "hash_dedup".to_string(),
                DeltaMode::DirtyRect => "dirty_rect".to_string(),
            },
            dirty_rect_supported: false,
            ..RecorderMetrics::default()
        };
        Self {
            config: config.clone(),
            buffer: RingBuffer::with_capacity(config.max_steps),
            running: false,
            metrics,
        }
    }
}

struct CapturePayload {
    output: CaptureOutput,
    capture_backend_used: CaptureBackendUsed,
    event: MouseEvent,
    id: u64,
    source: StepSource,
    effective_quality: f32,
    thumb_webp_quality: f32,
    delta_mode: DeltaMode,
    quality_decreased: bool,
    quality_increased: bool,
    max_steps: usize,
    max_buffer_bytes: usize,
    transport_mode: TransportMode,
    privacy_policy: PrivacyPolicy,
    enqueued_at: Instant,
}

pub static RECORDER: Lazy<Recorder> = Lazy::new(Recorder::new);

pub struct Recorder {
    state: Arc<Mutex<RecorderState>>,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    step_id: Arc<AtomicU64>,
    hook_thread: Mutex<Option<JoinHandle<()>>>,
    worker_thread: Mutex<Option<JoinHandle<()>>>,
    encode_thread: Mutex<Option<JoinHandle<()>>>,
    event_tx: Mutex<Option<Sender<MouseEvent>>>,
    step_subscribers: Arc<Mutex<Vec<StepSubscriber>>>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RecorderState::default())),
            stop_flag: Arc::new(AtomicBool::new(false)),
            pause_flag: Arc::new(AtomicBool::new(false)),
            step_id: Arc::new(AtomicU64::new(1)),
            hook_thread: Mutex::new(None),
            worker_thread: Mutex::new(None),
            encode_thread: Mutex::new(None),
            event_tx: Mutex::new(None),
            step_subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start(&self) -> Result<(), RecorderError> {
        {
            let mut state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
            if state.running {
                return Err(RecorderError::AlreadyRunning);
            }
            state.metrics.current_effective_quality = state.config.webp_quality;
            state.running = true;
        }

        reset_stop_flag(&self.stop_flag);
        self.pause_flag.store(false, Ordering::SeqCst);

        let (tx, rx): (Sender<MouseEvent>, Receiver<MouseEvent>) = bounded(256);
        {
            let mut slot = self
                .event_tx
                .lock()
                .map_err(|_| RecorderError::LockPoisoned)?;
            *slot = Some(tx.clone());
        }

        let state_for_worker = Arc::clone(&self.state);
        let stop_for_worker = Arc::clone(&self.stop_flag);
        let pause_for_worker = Arc::clone(&self.pause_flag);
        let step_id = Arc::clone(&self.step_id);

        // 管线通道：capture → encode
        let (encode_tx, encode_rx): (Sender<CapturePayload>, Receiver<CapturePayload>) =
            bounded(16);

        // ── encode_thread：从通道接收 payload → 存储 + metrics + Push ──
        let state_for_encode = Arc::clone(&self.state);
        let stop_for_encode = Arc::clone(&self.stop_flag);
        let subs_for_encode = Arc::clone(&self.step_subscribers);

        let encode_handle = match thread::Builder::new()
            .name("shadow-recorder-encode".to_string())
            .spawn(move || {
                let mut last_frame_hash: Option<u64> = None;
                while !stop_for_encode.load(Ordering::SeqCst) {
                    let payload = match encode_rx.recv_timeout(std::time::Duration::from_millis(40))
                    {
                        Ok(p) => p,
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };

                    let dirty_rect_effective = matches!(payload.delta_mode, DeltaMode::DirtyRect)
                        && payload.output.frame_delta_hint.dirty_regions_supported;
                    let needs_full_push_image = if payload.transport_mode == TransportMode::Push {
                        if let Ok(subscribers) = subs_for_encode.lock() {
                            subscribers.iter().any(|subscriber| {
                                subscriber.payload_mode == StreamPayloadMode::Full
                            })
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    let skip_encode_for_clean_frame = dirty_rect_effective
                        && !payload.output.frame_delta_hint.has_updates
                        && !needs_full_push_image;

                    let mut output = payload.output;
                    let privacy_excluded = payload.privacy_policy.should_exclude_window(
                        &output.window.process_name,
                        &output.window.window_title,
                    );
                    if !privacy_excluded {
                        payload.privacy_policy.apply_masks(
                            &mut output.rgba,
                            output.width,
                            output.height,
                        );
                    }

                    let encode_started = Instant::now();
                    let full_webp = if skip_encode_for_clean_frame || privacy_excluded {
                        Vec::new()
                    } else {
                        match encode_webp_from_rgba(
                            &output.rgba,
                            output.width,
                            output.height,
                            payload.effective_quality,
                        ) {
                            Ok(bytes) => bytes,
                            Err(_) => {
                                if let Ok(mut state) = state_for_encode.lock() {
                                    state.metrics.dropped_steps_total =
                                        state.metrics.dropped_steps_total.saturating_add(1);
                                }
                                continue;
                            }
                        }
                    };
                    let encode_latency_ms = if skip_encode_for_clean_frame || privacy_excluded {
                        0
                    } else {
                        u32::try_from(encode_started.elapsed().as_millis()).unwrap_or(u32::MAX)
                    };
                    let full_image_bytes = full_webp.len();

                    let (thumb_rgba, thumb_width, thumb_height) = downscale_rgba_nearest(
                        &output.rgba,
                        output.width,
                        output.height,
                        THUMB_MAX_EDGE,
                    );
                    let thumb_webp = if thumb_rgba.is_empty() || full_webp.is_empty() {
                        Vec::new()
                    } else {
                        encode_webp_from_rgba(
                            &thumb_rgba,
                            thumb_width,
                            thumb_height,
                            payload.thumb_webp_quality,
                        )
                        .unwrap_or_default()
                    };

                    let mut stored_webp = full_webp.clone();
                    let mut stored_thumb_webp = thumb_webp.clone();
                    let mut stored_bytes = full_image_bytes;
                    if dirty_rect_effective {
                        if !output.frame_delta_hint.has_updates {
                            stored_webp.clear();
                            stored_thumb_webp.clear();
                            stored_bytes = 0;
                        }
                        last_frame_hash = None;
                    } else if matches!(
                        payload.delta_mode,
                        DeltaMode::HashDedup | DeltaMode::DirtyRect
                    ) {
                        let current_hash = hash_bytes_fingerprint(&full_webp);
                        if Some(current_hash) == last_frame_hash {
                            stored_webp.clear();
                            stored_thumb_webp.clear();
                            stored_bytes = 0;
                        } else {
                            last_frame_hash = Some(current_hash);
                        }
                    } else {
                        last_frame_hash = None;
                    }

                    let effective_delta_mode = if matches!(payload.delta_mode, DeltaMode::Off) {
                        "off"
                    } else if dirty_rect_effective {
                        "dirty_rect"
                    } else {
                        "hash_dedup"
                    };

                    let window = output.window;
                    let dpi_scale = window.dpi_scale.max(0.5);
                    let logical_x = physical_to_logical(payload.event.x, dpi_scale);
                    let logical_y = physical_to_logical(payload.event.y, dpi_scale);

                    let step = StepData {
                        id: payload.id,
                        timestamp_ms: payload.event.timestamp_ms,
                        action: payload.event.action,
                        x: payload.event.x,
                        y: payload.event.y,
                        logical_x,
                        logical_y,
                        window_left: window.rect.left,
                        window_top: window.rect.top,
                        window_right: window.rect.right,
                        window_bottom: window.rect.bottom,
                        logical_window_left: window.logical_rect.left,
                        logical_window_top: window.logical_rect.top,
                        logical_window_right: window.logical_rect.right,
                        logical_window_bottom: window.logical_rect.bottom,
                        display_id: window.display_id,
                        dpi_scale,
                        process_name: window.process_name,
                        window_title: window.window_title,
                        image_bytes: stored_bytes,
                        image_webp: stored_webp,
                        image_thumb_webp: stored_thumb_webp,
                        capture_latency_ms: output.capture_latency_ms,
                        encode_latency_ms,
                        source: payload.source,
                        capture_backend: payload.capture_backend_used,
                    };

                    let _ = TEST_SESSION_MANAGER.record_step(&step);

                    if let Ok(mut state) = state_for_encode.lock() {
                        let stream_backpressure_ms =
                            u32::try_from(payload.enqueued_at.elapsed().as_millis())
                                .unwrap_or(u32::MAX);
                        state.buffer.push_and_trim(
                            step.clone(),
                            payload.max_steps,
                            payload.max_buffer_bytes,
                        );
                        state.metrics.captured_steps_total =
                            state.metrics.captured_steps_total.saturating_add(1);
                        state.metrics.buffer_steps = state.buffer.len() as u32;
                        state.metrics.buffer_bytes = state.buffer.total_bytes() as u64;
                        state.metrics.last_capture_latency_ms = output.capture_latency_ms;
                        state.metrics.last_encode_latency_ms = encode_latency_ms;
                        state.metrics.stream_backpressure_ms = stream_backpressure_ms;
                        state.metrics.last_image_bytes =
                            u32::try_from(full_image_bytes).unwrap_or(u32::MAX);
                        state.metrics.current_effective_quality = payload.effective_quality;
                        state.metrics.effective_delta_mode = effective_delta_mode.to_string();
                        state.metrics.dirty_rect_supported =
                            output.frame_delta_hint.dirty_regions_supported;
                        if dirty_rect_effective {
                            state.metrics.dirty_region_frame_total =
                                state.metrics.dirty_region_frame_total.saturating_add(1);
                            let previous_dirty_region_frame_count =
                                state.metrics.dirty_region_frame_total.saturating_sub(1);
                            let coverage = output.frame_delta_hint.coverage.clamp(0.0, 1.0);
                            state.metrics.dirty_region_coverage_avg =
                                if previous_dirty_region_frame_count == 0 {
                                    coverage
                                } else {
                                    ((state.metrics.dirty_region_coverage_avg
                                        * previous_dirty_region_frame_count as f32)
                                        + coverage)
                                        / state.metrics.dirty_region_frame_total as f32
                                };
                            if output.frame_delta_hint.has_updates {
                                state.metrics.dirty_rect_update_frames_total = state
                                    .metrics
                                    .dirty_rect_update_frames_total
                                    .saturating_add(1);
                            } else {
                                state.metrics.dirty_rect_empty_frames_total = state
                                    .metrics
                                    .dirty_rect_empty_frames_total
                                    .saturating_add(1);
                                state.metrics.dirty_region_empty_frame_total = state
                                    .metrics
                                    .dirty_region_empty_frame_total
                                    .saturating_add(1);
                            }
                            if skip_encode_for_clean_frame {
                                state.metrics.dirty_rect_encode_skip_total =
                                    state.metrics.dirty_rect_encode_skip_total.saturating_add(1);
                            }
                        }

                        if payload.quality_decreased {
                            state.metrics.quality_adjust_down_count =
                                state.metrics.quality_adjust_down_count.saturating_add(1);
                        }
                        if payload.quality_increased {
                            state.metrics.quality_adjust_up_count =
                                state.metrics.quality_adjust_up_count.saturating_add(1);
                        }

                        match payload.capture_backend_used {
                            CaptureBackendUsed::Wgc => {
                                state.metrics.wgc_capture_count =
                                    state.metrics.wgc_capture_count.saturating_add(1);
                            }
                            CaptureBackendUsed::Dxgi => {
                                state.metrics.dxgi_capture_count =
                                    state.metrics.dxgi_capture_count.saturating_add(1);
                            }
                        }

                        if payload.transport_mode == TransportMode::Push {
                            let latest = step.clone();
                            drop(state);

                            if let Ok(subscribers) = subs_for_encode.lock() {
                                for subscriber in subscribers.iter() {
                                    let mut outbound = latest.clone();
                                    match subscriber.payload_mode {
                                        StreamPayloadMode::MetaOnly => {
                                            outbound.image_webp.clear();
                                            outbound.image_bytes = u32::try_from(full_image_bytes)
                                                .unwrap_or(u32::MAX)
                                                as usize;
                                            outbound.image_thumb_webp.clear();
                                        }
                                        StreamPayloadMode::MetaPlusThumb => {
                                            if thumb_webp.is_empty() {
                                                outbound.image_webp.clear();
                                                outbound.image_bytes =
                                                    u32::try_from(full_image_bytes)
                                                        .unwrap_or(u32::MAX)
                                                        as usize;
                                            } else {
                                                outbound.image_webp = thumb_webp.clone();
                                                outbound.image_bytes = outbound.image_webp.len();
                                            }
                                            outbound.image_thumb_webp.clear();
                                        }
                                        StreamPayloadMode::Full => {
                                            outbound.image_webp = full_webp.clone();
                                            outbound.image_bytes = full_image_bytes;
                                            outbound.image_thumb_webp.clear();
                                        }
                                    }

                                    if subscriber
                                        .callback
                                        .call(Ok(outbound), ThreadsafeFunctionCallMode::NonBlocking)
                                        != NapiStatus::Ok
                                        && let Ok(mut state) = state_for_encode.lock()
                                    {
                                        state.metrics.push_dispatch_drop_total = state
                                            .metrics
                                            .push_dispatch_drop_total
                                            .saturating_add(1);
                                    }
                                }
                            }
                        }
                    }
                }
            }) {
            Ok(handle) => handle,
            Err(_) => {
                if let Ok(mut tx_slot) = self.event_tx.lock() {
                    tx_slot.take();
                }
                if let Ok(mut state) = self.state.lock() {
                    state.running = false;
                }
                return Err(RecorderError::ThreadStartFailed);
            }
        };

        {
            let mut slot = self
                .encode_thread
                .lock()
                .map_err(|_| RecorderError::LockPoisoned)?;
            *slot = Some(encode_handle);
        }

        // ── capture_thread：截图 + 发送 payload 到 encode 通道 ──
        let worker_handle = match thread::Builder::new()
            .name("shadow-recorder-capture".to_string())
            .spawn(move || {
                while !stop_for_worker.load(Ordering::SeqCst) {
                    let event = match rx.recv_timeout(std::time::Duration::from_millis(40)) {
                        Ok(event) => event,
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };

                    let (
                        quality,
                        thumb_webp_quality,
                        adaptive_quality_enabled,
                        adaptive_buffer_high_ratio,
                        adaptive_buffer_low_ratio,
                        adaptive_latency_high_ms,
                        adaptive_latency_low_ms,
                        adaptive_target_image_kb,
                        adaptive_step_down,
                        adaptive_step_up,
                        adaptive_min_quality,
                        adaptive_max_quality,
                        max_steps,
                        max_buffer_bytes,
                        capture_backend,
                        strict_backend,
                        delta_mode,
                        input_mode,
                        transport_mode,
                        privacy_policy,
                        _stream_payload,
                        capture_reuse_enabled,
                        running,
                    ) = {
                        let state = match state_for_worker.lock() {
                            Ok(state) => state,
                            Err(_) => break,
                        };
                        (
                            state.config.webp_quality,
                            state.config.thumb_webp_quality,
                            state.config.adaptive_quality_enabled,
                            state.config.adaptive_buffer_high_ratio,
                            state.config.adaptive_buffer_low_ratio,
                            state.config.adaptive_latency_high_ms,
                            state.config.adaptive_latency_low_ms,
                            state.config.adaptive_target_image_kb,
                            state.config.adaptive_step_down,
                            state.config.adaptive_step_up,
                            state.config.adaptive_min_quality,
                            state.config.adaptive_max_quality,
                            state.config.max_steps,
                            state.config.max_buffer_bytes,
                            state.config.capture_backend,
                            state.config.strict_backend,
                            state.config.delta_mode,
                            state.config.input_mode,
                            state.config.transport_mode,
                            PrivacyPolicy {
                                enabled: state.config.privacy_enabled,
                                excluded_window_title_keywords: state
                                    .config
                                    .excluded_window_title_keywords
                                    .clone(),
                                excluded_process_names: state.config.excluded_process_names.clone(),
                                mask_regions: state.config.mask_regions.clone(),
                            },
                            state.config.stream_payload,
                            state.config.capture_reuse_enabled,
                            state.running,
                        )
                    };

                    if !running || pause_for_worker.load(Ordering::SeqCst) {
                        continue;
                    }

                    let (effective_quality, quality_decreased, quality_increased) =
                        if let Ok(state) = state_for_worker.lock() {
                            let usage_ratio = if max_buffer_bytes == 0 {
                                0.0
                            } else {
                                state.buffer.total_bytes() as f32 / max_buffer_bytes as f32
                            };
                            compute_effective_quality(
                                &state.metrics,
                                AdaptiveInputs {
                                    base_quality: quality,
                                    min_quality: adaptive_min_quality,
                                    max_quality: adaptive_max_quality,
                                    adaptive_enabled: adaptive_quality_enabled,
                                    buffer_high_ratio: adaptive_buffer_high_ratio,
                                    buffer_low_ratio: adaptive_buffer_low_ratio,
                                    latency_high_ms: adaptive_latency_high_ms,
                                    latency_low_ms: adaptive_latency_low_ms,
                                    target_image_bytes: (adaptive_target_image_kb as usize)
                                        .saturating_mul(1024),
                                    step_down: adaptive_step_down,
                                    step_up: adaptive_step_up,
                                },
                                usage_ratio,
                            )
                        } else {
                            (
                                quality.clamp(adaptive_min_quality, adaptive_max_quality),
                                false,
                                false,
                            )
                        };

                    let enable_dirty_rect = matches!(delta_mode, DeltaMode::DirtyRect);
                    let (capture_result, fallback_attempted) = capture_with_backend_policy(
                        capture_backend,
                        strict_backend,
                        || {
                            capture_active_window_wgc_webp(
                                effective_quality,
                                capture_reuse_enabled,
                                enable_dirty_rect,
                            )
                        },
                        || {
                            capture_active_window_webp(
                                effective_quality,
                                capture_reuse_enabled,
                                enable_dirty_rect,
                            )
                        },
                    );
                    if fallback_attempted {
                        inc_backend_fallback();
                    }

                    if let Ok((output, capture_backend_used)) = capture_result {
                        let id = step_id.fetch_add(1, Ordering::SeqCst);
                        let source = step_source_for_input_mode(input_mode);

                        if encode_tx
                            .try_send(CapturePayload {
                                enqueued_at: Instant::now(),
                                output,
                                capture_backend_used,
                                event,
                                id,
                                source,
                                effective_quality,
                                thumb_webp_quality,
                                delta_mode,
                                quality_decreased,
                                quality_increased,
                                max_steps,
                                max_buffer_bytes,
                                transport_mode,
                                privacy_policy,
                            })
                            .is_err()
                        {
                            inc_encode_queue_drop();
                            if let Ok(mut state) = state_for_worker.lock() {
                                state.metrics.dropped_steps_total =
                                    state.metrics.dropped_steps_total.saturating_add(1);
                            }
                        }
                    } else if let Ok(mut state) = state_for_worker.lock() {
                        let id = step_id.fetch_add(1, Ordering::SeqCst);
                        let step = build_capture_failed_step(
                            event,
                            id,
                            step_source_for_input_mode(input_mode),
                            capture_backend_used_for_failure(capture_backend),
                        );
                        let _ = TEST_SESSION_MANAGER.record_step(&step);
                        state
                            .buffer
                            .push_and_trim(step, max_steps, max_buffer_bytes);
                        state.metrics.buffer_steps = state.buffer.len() as u32;
                        state.metrics.buffer_bytes = state.buffer.total_bytes() as u64;
                        state.metrics.dropped_steps_total =
                            state.metrics.dropped_steps_total.saturating_add(1);
                    }
                }
            }) {
            Ok(handle) => handle,
            Err(_) => {
                if let Ok(mut tx_slot) = self.event_tx.lock() {
                    tx_slot.take();
                }
                if let Ok(mut state) = self.state.lock() {
                    state.running = false;
                }
                return Err(RecorderError::ThreadStartFailed);
            }
        };

        {
            let mut slot = self
                .worker_thread
                .lock()
                .map_err(|_| RecorderError::LockPoisoned)?;
            *slot = Some(worker_handle);
        }

        let stop_for_hook = Arc::clone(&self.stop_flag);
        let (debounce_ms, input_mode) = self
            .state
            .lock()
            .map(|state| (state.config.debounce_ms, state.config.input_mode))
            .unwrap_or((120, crate::config::InputMode::Auto));
        let hook_handle = match run_input_thread(stop_for_hook, tx, debounce_ms, input_mode) {
            Ok(handle) => handle,
            Err(err) => {
                self.stop_flag.store(true, Ordering::SeqCst);

                if let Ok(mut worker) = self.worker_thread.lock()
                    && let Some(handle) = worker.take()
                {
                    let _ = handle.join();
                }

                if let Ok(mut tx_slot) = self.event_tx.lock() {
                    tx_slot.take();
                }

                if let Ok(mut state) = self.state.lock() {
                    state.running = false;
                }

                return Err(err);
            }
        };

        {
            let mut slot = self
                .hook_thread
                .lock()
                .map_err(|_| RecorderError::LockPoisoned)?;
            *slot = Some(hook_handle);
        }

        Ok(())
    }

    pub fn stop(&self) -> Result<(), RecorderError> {
        {
            let mut state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
            if !state.running {
                return Err(RecorderError::NotRunning);
            }
            state.running = false;
        }

        self.stop_flag.store(true, Ordering::SeqCst);
        uninstall_hook();

        {
            let mut tx_slot = self
                .event_tx
                .lock()
                .map_err(|_| RecorderError::LockPoisoned)?;
            tx_slot.take();
        }

        // 使用带超时的线程等待，避免死锁
        const JOIN_TIMEOUT: Duration = Duration::from_secs(5);

        if let Ok(mut hook) = self.hook_thread.lock()
            && let Some(handle) = hook.take()
        {
            // 尝试等待线程结束，带超时
            let start = std::time::Instant::now();
            while start.elapsed() < JOIN_TIMEOUT {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        if let Ok(mut worker) = self.worker_thread.lock()
            && let Some(handle) = worker.take()
        {
            // 尝试等待线程结束，带超时
            let start = std::time::Instant::now();
            while start.elapsed() < JOIN_TIMEOUT {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        if let Ok(mut encode) = self.encode_thread.lock()
            && let Some(handle) = encode.take()
        {
            let start = std::time::Instant::now();
            while start.elapsed() < JOIN_TIMEOUT {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        // Graceful teardown: release capture backends without counting as fault resets.
        release_dxgi_capture_resources();
        release_wgc_capture_resources();

        Ok(())
    }

    pub fn clear_buffer(&self) -> Result<(), RecorderError> {
        let mut state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        state.buffer.clear();
        state.metrics.buffer_steps = 0;
        state.metrics.buffer_bytes = 0;
        Ok(())
    }

    pub fn get_buffer(&self) -> Result<Vec<StepData>, RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        Ok(state.buffer.to_vec())
    }

    pub fn get_buffer_since(&self, last_id: u64) -> Result<Vec<StepData>, RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        Ok(state.buffer.to_vec_since(last_id))
    }

    pub fn get_metrics(&self) -> Result<RecorderMetrics, RecorderError> {
        let mut metrics = {
            let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
            state.metrics.clone()
        };
        metrics.input_channel_full_drop_total = read_input_channel_full_drop_total();
        metrics.capture_queue_drop_total = read_capture_queue_drop_total();
        metrics.encode_queue_drop_total = read_encode_queue_drop_total();
        metrics.backend_fallback_total = read_backend_fallback_total();
        metrics.capture_context_reset_total = read_capture_context_reset_total();
        metrics.effective_input_mode = read_effective_input_mode().to_string();
        metrics.uia_observer_queue_depth = read_uia_observer_queue_depth();
        metrics.uia_observer_dropped_total = read_uia_observer_dropped_total();
        metrics.uia_observer_duplicate_drop_total = read_uia_observer_duplicate_drop_total();
        metrics.uia_observer_rate_limit_drop_total = read_uia_observer_rate_limit_drop_total();
        metrics.uia_observer_queue_overflow_total = read_uia_observer_queue_overflow_total();
        metrics.uia_observer_timeout_total = read_uia_observer_timeout_total();
        metrics.uia_observer_restart_total = read_uia_observer_restart_total();
        metrics.uia_observer_circuit_open = read_uia_observer_circuit_open();
        metrics.uia_observer_polling_attempt_total = read_uia_observer_polling_attempt_total();
        Ok(metrics)
    }

    pub fn get_buffer_page(
        &self,
        cursor: u64,
        limit: usize,
        include_image: bool,
    ) -> Result<Vec<StepData>, RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        let mut page = state.buffer.to_vec_page_since(cursor, limit.max(1));
        if !include_image {
            for step in &mut page {
                step.image_webp.clear();
                step.image_thumb_webp.clear();
            }
        }
        Ok(page)
    }

    pub fn get_step_image(
        &self,
        step_id: u64,
        variant: &str,
    ) -> Result<Option<Vec<u8>>, RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        if let Some(step) = state.buffer.find_by_id(step_id) {
            if variant.eq_ignore_ascii_case("thumb") {
                if !step.image_thumb_webp.is_empty() {
                    return Ok(Some(step.image_thumb_webp));
                }
            } else if !step.image_webp.is_empty() {
                return Ok(Some(step.image_webp));
            }
        }

        let steps = state.buffer.to_vec();
        let mut index = None;
        for (idx, step) in steps.iter().enumerate() {
            if step.id == step_id {
                index = Some(idx);
                break;
            }
        }

        let Some(mut idx) = index else {
            return Ok(None);
        };

        while let Some(step) = steps.get(idx) {
            if variant.eq_ignore_ascii_case("thumb") {
                if !step.image_thumb_webp.is_empty() {
                    return Ok(Some(step.image_thumb_webp.clone()));
                }
            } else if !step.image_webp.is_empty() {
                return Ok(Some(step.image_webp.clone()));
            }
            if idx == 0 {
                break;
            }
            idx = idx.saturating_sub(1);
        }

        Ok(None)
    }

    pub fn subscribe_steps(
        &self,
        callback: ThreadsafeFunction<StepData>,
    ) -> Result<(), RecorderError> {
        self.subscribe_steps_v2(callback, StreamPayloadMode::Full)
    }

    pub fn subscribe_steps_v2(
        &self,
        callback: ThreadsafeFunction<StepData>,
        payload_mode: StreamPayloadMode,
    ) -> Result<(), RecorderError> {
        let mut subscribers = self
            .step_subscribers
            .lock()
            .map_err(|_| RecorderError::LockPoisoned)?;
        subscribers.push(StepSubscriber {
            callback,
            payload_mode,
        });
        Ok(())
    }

    pub fn clear_subscriptions(&self) -> Result<(), RecorderError> {
        let mut subscribers = self
            .step_subscribers
            .lock()
            .map_err(|_| RecorderError::LockPoisoned)?;
        subscribers.clear();
        Ok(())
    }

    pub fn set_config(&self, config: RecorderConfig) -> Result<(), RecorderError> {
        let config = config.normalized();

        {
            let mut state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
            state.config = config.clone();
            state.metrics.current_effective_quality = config.webp_quality;
            state.metrics.effective_delta_mode = match config.delta_mode {
                DeltaMode::Off => "off".to_string(),
                DeltaMode::HashDedup => "hash_dedup".to_string(),
                DeltaMode::DirtyRect => "dirty_rect".to_string(),
            };
            if !matches!(config.delta_mode, DeltaMode::DirtyRect) {
                state.metrics.dirty_rect_supported = false;
            }
            state
                .buffer
                .trim_to_limits(config.max_steps, config.max_buffer_bytes);
            state.metrics.buffer_steps = state.buffer.len() as u32;
            state.metrics.buffer_bytes = state.buffer.total_bytes() as u64;
        }

        update_debounce_ms(config.debounce_ms);
        update_raw_input_debounce_ms(config.debounce_ms);
        let semantic_recording_enabled =
            config.semantic_recording_enabled || config.defect_evidence_enabled;
        crate::session::set_defect_evidence_enabled(semantic_recording_enabled);
        // Product rule: enabling semantic recording turns on the full operation-result
        // pipeline. Desktop currently exposes a single switch; UIA observer + operation
        // builder default to false and were not forwarded from Electron, so clicks stayed L1.
        let uia_observer_enabled = semantic_recording_enabled;
        let operation_builder_enabled = semantic_recording_enabled;
        // Product rule: semantic steps should include concrete content (typed text,
        // selected option names, path results). Password values remain redacted.
        // Desktop currently exposes a single semantic switch; couple content capture
        // to it so defect-evidence repro steps are useful by default.
        let semantic_plaintext_input_enabled = semantic_recording_enabled;
        crate::session::set_semantic_feature_flags(
            semantic_recording_enabled,
            uia_observer_enabled,
            operation_builder_enabled,
            config.operation_review_v2_enabled,
            semantic_plaintext_input_enabled,
        );
        crate::session::set_semantic_privacy_policy(PrivacyPolicy {
            enabled: config.privacy_enabled,
            excluded_window_title_keywords: config.excluded_window_title_keywords.clone(),
            excluded_process_names: config.excluded_process_names.clone(),
            mask_regions: Vec::new(),
        });
        crate::session::set_defect_windows(
            config.defect_pre_window_seconds,
            config.defect_post_window_seconds,
        );
        Ok(())
    }

    pub fn pause(&self) -> Result<(), RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        if !state.running {
            return Err(RecorderError::NotRunning);
        }
        self.pause_flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn resume(&self) -> Result<(), RecorderError> {
        let state = self.state.lock().map_err(|_| RecorderError::LockPoisoned)?;
        if !state.running {
            return Err(RecorderError::NotRunning);
        }
        self.pause_flag.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_paused(&self) -> bool {
        self.pause_flag.load(Ordering::SeqCst)
    }
}

pub fn create_step_tsfn_from_js(
    callback: napi::JsFunction,
) -> napi::Result<ThreadsafeFunction<StepData>> {
    callback.create_threadsafe_function(1024, |ctx: ThreadSafeCallContext<StepData>| {
        let value = ctx.value;
        let image_webp_base64 = base64::engine::general_purpose::STANDARD.encode(value.image_webp);
        ctx.env.create_object().and_then(|mut obj| {
            obj.set_named_property("id", ctx.env.create_double(value.id as f64)?)?;
            obj.set_named_property(
                "timestampMs",
                ctx.env.create_double(value.timestamp_ms as f64)?,
            )?;
            obj.set_named_property("action", ctx.env.create_string(&value.action)?)?;
            obj.set_named_property("x", ctx.env.create_int32(value.x)?)?;
            obj.set_named_property("y", ctx.env.create_int32(value.y)?)?;
            obj.set_named_property("logicalX", ctx.env.create_int32(value.logical_x)?)?;
            obj.set_named_property("logicalY", ctx.env.create_int32(value.logical_y)?)?;
            obj.set_named_property("windowLeft", ctx.env.create_int32(value.window_left)?)?;
            obj.set_named_property("windowTop", ctx.env.create_int32(value.window_top)?)?;
            obj.set_named_property("windowRight", ctx.env.create_int32(value.window_right)?)?;
            obj.set_named_property("windowBottom", ctx.env.create_int32(value.window_bottom)?)?;
            obj.set_named_property(
                "logicalWindowLeft",
                ctx.env.create_int32(value.logical_window_left)?,
            )?;
            obj.set_named_property(
                "logicalWindowTop",
                ctx.env.create_int32(value.logical_window_top)?,
            )?;
            obj.set_named_property(
                "logicalWindowRight",
                ctx.env.create_int32(value.logical_window_right)?,
            )?;
            obj.set_named_property(
                "logicalWindowBottom",
                ctx.env.create_int32(value.logical_window_bottom)?,
            )?;
            obj.set_named_property("displayId", ctx.env.create_string(&value.display_id)?)?;
            obj.set_named_property("dpiScale", ctx.env.create_double(value.dpi_scale as f64)?)?;
            obj.set_named_property("processName", ctx.env.create_string(&value.process_name)?)?;
            obj.set_named_property("windowTitle", ctx.env.create_string(&value.window_title)?)?;
            obj.set_named_property(
                "imageWebpBase64",
                ctx.env.create_string(&image_webp_base64)?,
            )?;
            obj.set_named_property(
                "imageBytes",
                ctx.env
                    .create_uint32(u32::try_from(value.image_bytes).unwrap_or(u32::MAX))?,
            )?;
            obj.set_named_property(
                "captureLatencyMs",
                ctx.env.create_uint32(value.capture_latency_ms)?,
            )?;
            obj.set_named_property(
                "encodeLatencyMs",
                ctx.env.create_uint32(value.encode_latency_ms)?,
            )?;
            obj.set_named_property("source", ctx.env.create_string(value.source.as_str())?)?;
            obj.set_named_property(
                "captureBackend",
                ctx.env.create_string(value.capture_backend.as_str())?,
            )?;
            Ok::<Vec<napi::JsObject>, napi::Error>(vec![obj])
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_capture_failed_step, capture_backend_used_for_failure, step_source_for_input_mode,
    };
    use crate::config::{CaptureBackendMode, InputMode};
    use crate::hooks::MouseEvent;
    use crate::types::{CaptureBackendUsed, StepSource};

    #[test]
    fn capture_failed_step_preserves_input_fact_without_image() {
        let event = MouseEvent {
            x: 120,
            y: 240,
            timestamp_ms: 1_234,
            action: "WM_LBUTTONDOWN".to_string(),
        };

        let step =
            build_capture_failed_step(event, 42, StepSource::RawInput, CaptureBackendUsed::Dxgi);

        assert_eq!(step.id, 42);
        assert_eq!(step.timestamp_ms, 1_234);
        assert_eq!(step.action, "WM_LBUTTONDOWN");
        assert_eq!((step.x, step.y), (120, 240));
        assert_eq!((step.logical_x, step.logical_y), (120, 240));
        assert_eq!(step.image_bytes, 0);
        assert!(step.image_webp.is_empty());
        assert!(step.image_thumb_webp.is_empty());
        assert_eq!(step.source, StepSource::RawInput);
        assert_eq!(step.capture_backend, CaptureBackendUsed::Dxgi);
    }

    #[test]
    fn capture_failure_backend_and_source_have_stable_fallbacks() {
        assert_eq!(
            capture_backend_used_for_failure(CaptureBackendMode::Wgc),
            CaptureBackendUsed::Wgc
        );
        assert_eq!(
            capture_backend_used_for_failure(CaptureBackendMode::Dxgi),
            CaptureBackendUsed::Dxgi
        );
        assert_eq!(
            capture_backend_used_for_failure(CaptureBackendMode::Auto),
            CaptureBackendUsed::Dxgi
        );
        assert_eq!(
            step_source_for_input_mode(InputMode::RawInput),
            StepSource::RawInput
        );
        assert_eq!(
            step_source_for_input_mode(InputMode::Hook),
            StepSource::Hook
        );
    }
}
