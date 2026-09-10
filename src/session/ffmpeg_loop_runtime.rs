#![cfg_attr(test, allow(dead_code))]

use std::fs;
use std::io;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::dxgi::get_active_window_context;
use crate::session::models::{
    TEST_SESSION_SCHEMA_VERSION, TEST_SESSION_VIDEO_SEGMENT_KIND, TestSessionRecord,
    TestSessionStatus, TestSessionVideoSegmentRecord, TestSessionVideoSegmentStatus,
    TestSessionVideoStreamRecord, TestSessionVideoStreamStatus,
};
use crate::session::video_encoder::{
    VideoEncoderProfile, append_segmented_encoder_args, resolve_encoder_candidates,
};
use crate::session::video_ring::resolve_recording_profile_capture_params;

const FFMPEG_ENV_VAR: &str = "REQCASE_SHADOWRECORDER_FFMPEG_PATH";
const PROCESS_STOP_TIMEOUT_MS: u64 = 1_200;
const SUPERVISOR_POLL_INTERVAL_MS: u64 = 350;
const INDEX_REFRESH_INTERVAL_MS: u64 = 5_000;
const STREAM_PERSIST_INTERVAL_MS: u64 = 5_000;
const MIN_GDI_FRAMERATE: u32 = 6;
const DEFAULT_SEGMENT_DURATION_SECONDS: u32 = 5;
const ENCODER_EARLY_EXIT_WINDOW_MS: u64 = 2_500;
// `gdigrab -draw_mouse 1` can cause visible cursor flicker on the live desktop,
// so continuous capture hides the cursor unless the session explicitly enables it.
const GDI_DRAW_MOUSE_DISABLED_VALUE: &str = "0";
const GDI_DRAW_MOUSE_ENABLED_VALUE: &str = "1";
#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

#[derive(Debug)]
pub enum FfmpegLoopRuntimeError {
    AlreadyRunning,
    MissingExecutable,
    UnsupportedExecutable(String),
    ThreadStartFailed,
    Io(io::Error),
    Serialize(serde_json::Error),
}

impl std::fmt::Display for FfmpegLoopRuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => write!(f, "ffmpeg loop runtime is already running"),
            Self::MissingExecutable => write!(f, "ffmpeg executable is unavailable"),
            Self::UnsupportedExecutable(reason) => {
                write!(
                    f,
                    "ffmpeg executable is unsupported for loop capture: {reason}"
                )
            }
            Self::ThreadStartFailed => write!(f, "failed to start ffmpeg loop runtime"),
            Self::Io(err) => write!(f, "ffmpeg loop io failed: {err}"),
            Self::Serialize(err) => write!(f, "ffmpeg loop serialization failed: {err}"),
        }
    }
}

impl std::error::Error for FfmpegLoopRuntimeError {}

impl From<io::Error> for FfmpegLoopRuntimeError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for FfmpegLoopRuntimeError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialize(value)
    }
}

#[derive(Default)]
pub struct FfmpegLoopRuntime {
    worker: Option<FfmpegLoopWorker>,
}

struct FfmpegLoopWorker {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    session: Arc<Mutex<TestSessionRecord>>,
    handle: JoinHandle<()>,
}

struct StreamRuntimeState {
    stream: TestSessionVideoStreamRecord,
    max_segments: usize,
    run_counter: u32,
    last_index_refresh_at_ms: u64,
    last_segment_signature: Option<StreamSegmentSignature>,
    encoder_candidates: Vec<VideoEncoderProfile>,
    encoder_candidate_index: usize,
    current_target_identity: Option<String>,
    last_window_hwnd: Option<String>,
    last_window_title: Option<String>,
    last_process_name: Option<String>,
}

struct ActiveCaptureRun {
    child: Child,
    started_at_ms: u64,
    encoder_name: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionVideoConfigState {
    recording_profile: String,
    encoder_preference: String,
    show_mouse_in_video: bool,
}

impl From<&TestSessionRecord> for SessionVideoConfigState {
    fn from(value: &TestSessionRecord) -> Self {
        Self {
            recording_profile: value.recording_profile.clone(),
            encoder_preference: value.encoder_preference.clone(),
            show_mouse_in_video: value.show_mouse_in_video,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StreamSegmentSignature {
    count: usize,
    first_segment_id: Option<String>,
    last_segment_id: Option<String>,
    retained_segment_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegCaptureRunManifest {
    schema_version: u32,
    kind: String,
    run_id: String,
    session_id: String,
    stream_id: String,
    target_capture_mode: String,
    display_id: Option<String>,
    #[serde(default)]
    capture_input: String,
    #[serde(default)]
    show_mouse_in_video: bool,
    #[serde(default)]
    window_hwnd: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    #[serde(default)]
    process_name: Option<String>,
    started_at_ms: u64,
    segment_duration_seconds: u32,
    target_fps: u32,
    #[serde(default)]
    encoder_name: Option<String>,
    offset_x: i32,
    offset_y: i32,
    width: u32,
    height: u32,
    segment_list_relative_path: String,
    output_pattern_relative_path: String,
}

#[derive(Debug)]
struct ParsedSegmentRow {
    file_relative_path: String,
    started_at_ms: u64,
    ended_at_ms: u64,
}

#[derive(Debug, Clone)]
enum CaptureTarget {
    DesktopRegion {
        identity: String,
        display_id: Option<String>,
        offset_x: i32,
        offset_y: i32,
        width: u32,
        height: u32,
    },
    Window {
        identity: String,
        display_id: Option<String>,
        window_hwnd: String,
        window_title: Option<String>,
        process_name: Option<String>,
        offset_x: i32,
        offset_y: i32,
        width: u32,
        height: u32,
    },
}

impl CaptureTarget {
    fn identity(&self) -> &str {
        match self {
            Self::DesktopRegion { identity, .. } | Self::Window { identity, .. } => identity,
        }
    }

    fn display_id(&self) -> Option<&str> {
        match self {
            Self::DesktopRegion { display_id, .. } | Self::Window { display_id, .. } => {
                display_id.as_deref()
            }
        }
    }

    fn width(&self) -> u32 {
        match self {
            Self::DesktopRegion { width, .. } | Self::Window { width, .. } => *width,
        }
    }

    fn height(&self) -> u32 {
        match self {
            Self::DesktopRegion { height, .. } | Self::Window { height, .. } => *height,
        }
    }
}

#[cfg(test)]
fn should_use_ffmpeg_loop(session: &TestSessionRecord) -> bool {
    matches!(
        session.target_capture_mode.as_str(),
        "desktop"
            | "target_display"
            | "all_displays"
            | "process_bind"
            | "foreground_window"
            | "target_window"
    )
}

impl FfmpegLoopRuntime {
    pub fn ensure_started(
        &mut self,
        session: TestSessionRecord,
        streams: Vec<TestSessionVideoStreamRecord>,
    ) -> Result<(), FfmpegLoopRuntimeError> {
        if self.worker.is_some() {
            return Err(FfmpegLoopRuntimeError::AlreadyRunning);
        }

        if session.session_dir.is_none() || streams.is_empty() {
            return Ok(());
        }

        let ffmpeg =
            resolve_ffmpeg_executable().ok_or(FfmpegLoopRuntimeError::MissingExecutable)?;
        validate_ffmpeg_capture_support(&ffmpeg)?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(session.status == TestSessionStatus::Paused));
        let session_state = Arc::new(Mutex::new(session.clone()));
        let thread_stop_flag = Arc::clone(&stop_flag);
        let thread_pause_flag = Arc::clone(&pause_flag);
        let thread_session_state = Arc::clone(&session_state);
        let handle = thread::Builder::new()
            .name(format!("shadowrecord-ffmpeg-loop-{}", session.session_id))
            .spawn(move || {
                run_ffmpeg_loop(
                    session,
                    thread_session_state,
                    streams,
                    ffmpeg,
                    thread_stop_flag,
                    thread_pause_flag,
                );
            })
            .map_err(|_| FfmpegLoopRuntimeError::ThreadStartFailed)?;

        self.worker = Some(FfmpegLoopWorker {
            stop_flag,
            pause_flag,
            session: session_state,
            handle,
        });
        Ok(())
    }

    pub fn update_session(&self, session: TestSessionRecord) {
        if let Some(worker) = self.worker.as_ref()
            && let Ok(mut session_state) = worker.session.lock()
        {
            *session_state = session;
        }
    }

    pub fn set_paused(&self, paused: bool) {
        if let Some(worker) = self.worker.as_ref() {
            worker.pause_flag.store(paused, Ordering::SeqCst);
        }
    }

    pub fn stop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.stop_flag.store(true, Ordering::SeqCst);
            join_with_timeout(
                worker.handle,
                Duration::from_millis(PROCESS_STOP_TIMEOUT_MS),
            );
        }
    }
}

impl Drop for FfmpegLoopRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn recover_ffmpeg_loop_segments(
    session: &TestSessionRecord,
    streams: &mut [TestSessionVideoStreamRecord],
) -> Result<Vec<TestSessionVideoSegmentRecord>, FfmpegLoopRuntimeError> {
    let Some(session_dir) = session.session_dir.as_deref().map(PathBuf::from) else {
        return Ok(Vec::new());
    };

    let mut all_segments = Vec::new();
    for stream in streams.iter_mut() {
        let max_segments = compute_max_segments(
            session.buffer_window_seconds,
            stream
                .segment_duration_seconds
                .max(DEFAULT_SEGMENT_DURATION_SECONDS),
        );
        let mut segments = collect_stream_segments(&session_dir, stream)?;
        trim_segments_to_window(&mut segments, max_segments)?;
        update_stream_summary(
            stream,
            &segments,
            TestSessionVideoStreamStatus::Stopped,
            Some(session.ended_at_ms.unwrap_or_else(now_timestamp_ms)),
        );
        all_segments.extend(segments);
    }

    all_segments.sort_by_key(|segment| (segment.started_at_ms, segment.stream_id.clone()));
    rewrite_segments_index(&session_dir, &all_segments)?;
    persist_streams_snapshot(&session_dir, streams)?;
    Ok(all_segments)
}

fn run_ffmpeg_loop(
    session: TestSessionRecord,
    session_state: Arc<Mutex<TestSessionRecord>>,
    streams: Vec<TestSessionVideoStreamRecord>,
    ffmpeg: PathBuf,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
) {
    let mut active_session = session;
    let mut session_video_config = SessionVideoConfigState::from(&active_session);
    let mut encoder_candidates =
        resolve_encoder_candidates(&ffmpeg, &active_session.encoder_preference);
    let Some(session_dir) = active_session.session_dir.as_deref().map(PathBuf::from) else {
        return;
    };

    let mut states = streams
        .into_iter()
        .map(|mut stream| {
            stream.encoder_available = true;
            stream.status = if pause_flag.load(Ordering::SeqCst) {
                TestSessionVideoStreamStatus::Planned
            } else {
                TestSessionVideoStreamStatus::Active
            };
            stream.updated_at_ms = now_timestamp_ms();
            StreamRuntimeState {
                max_segments: compute_max_segments(
                    active_session.buffer_window_seconds,
                    stream
                        .segment_duration_seconds
                        .max(DEFAULT_SEGMENT_DURATION_SECONDS),
                ),
                run_counter: 0,
                last_index_refresh_at_ms: 0,
                last_segment_signature: None,
                encoder_candidates: encoder_candidates.clone(),
                encoder_candidate_index: 0,
                current_target_identity: None,
                last_window_hwnd: None,
                last_window_title: None,
                last_process_name: None,
                stream,
            }
        })
        .collect::<Vec<_>>();
    let _ = persist_stream_states(&session_dir, &states);
    let mut last_persist_at_ms = now_timestamp_ms();
    let mut streams_dirty = false;

    let mut active_runs: Vec<Option<ActiveCaptureRun>> = (0..states.len()).map(|_| None).collect();
    while !stop_flag.load(Ordering::SeqCst) {
        let paused = pause_flag.load(Ordering::SeqCst);
        let latest_session = session_state
            .lock()
            .map(|session| session.clone())
            .unwrap_or_else(|_| active_session.clone());
        let latest_session_video_config = SessionVideoConfigState::from(&latest_session);
        let session_video_config_changed = latest_session_video_config != session_video_config;
        if session_video_config_changed {
            active_session = latest_session;
            session_video_config = latest_session_video_config;
            encoder_candidates =
                resolve_encoder_candidates(&ffmpeg, &active_session.encoder_preference);
            for state in &mut states {
                state.encoder_candidates = encoder_candidates.clone();
                state.encoder_candidate_index = 0;
                state.stream.encoder_available = true;
                if apply_recording_profile_to_stream(
                    &mut state.stream,
                    &active_session.recording_profile,
                ) {
                    state.stream.updated_at_ms = now_timestamp_ms();
                    streams_dirty = true;
                }
            }
        }

        for index in 0..states.len() {
            let state = &mut states[index];

            if paused {
                if let Some(mut run) = active_runs[index].take() {
                    stop_capture_run(&mut run);
                    let _ = refresh_stream_index(&active_session, &session_dir, state);
                }
                state.current_target_identity = None;
                state.stream.status = TestSessionVideoStreamStatus::Planned;
                state.stream.updated_at_ms = now_timestamp_ms();
                streams_dirty = true;
                continue;
            }

            let capture_target = match resolve_capture_target(state) {
                Ok(target) => target,
                Err(err) => {
                    if let Some(mut run) = active_runs[index].take() {
                        stop_capture_run(&mut run);
                        let _ = refresh_stream_index(&active_session, &session_dir, state);
                    }
                    state.current_target_identity = None;
                    state.stream.status = TestSessionVideoStreamStatus::Stopped;
                    state.stream.updated_at_ms = now_timestamp_ms();
                    apply_stream_warning(
                        &mut state.stream,
                        format!("ffmpeg capture target is unavailable: {err}"),
                    );
                    streams_dirty = true;
                    continue;
                }
            };
            let target_changed =
                state.current_target_identity.as_deref() != Some(capture_target.identity());
            let should_restart = match active_runs[index].as_mut() {
                Some(run) => match run.child.try_wait() {
                    Ok(Some(_status)) => {
                        let now_ms = now_timestamp_ms();
                        let ended_early =
                            now_ms.saturating_sub(run.started_at_ms) < ENCODER_EARLY_EXIT_WINDOW_MS;
                        if ended_early
                            && state.encoder_candidate_index + 1 < state.encoder_candidates.len()
                        {
                            state.encoder_candidate_index += 1;
                            let next_encoder =
                                state.encoder_candidates[state.encoder_candidate_index];
                            apply_stream_warning(
                                &mut state.stream,
                                format!(
                                    "{} ended too quickly; retrying with {}",
                                    run.encoder_name,
                                    next_encoder.encoder_name()
                                ),
                            );
                            state.stream.encoder_available = true;
                        }
                        true
                    }
                    Ok(None) => target_changed || session_video_config_changed,
                    Err(_) => true,
                },
                None => true,
            };

            if should_restart {
                if let Some(mut run) = active_runs[index].take() {
                    stop_capture_run(&mut run);
                }
                let encoder_profile = state
                    .encoder_candidates
                    .get(state.encoder_candidate_index)
                    .copied()
                    .unwrap_or(VideoEncoderProfile::SoftwareX264);
                match spawn_capture_run(
                    &ffmpeg,
                    &active_session,
                    &state.stream,
                    &capture_target,
                    encoder_profile,
                    state.run_counter + 1,
                ) {
                    Ok(run) => {
                        state.run_counter = state.run_counter.saturating_add(1);
                        state.current_target_identity = Some(capture_target.identity().to_string());
                        state.stream.status = TestSessionVideoStreamStatus::Active;
                        state.stream.updated_at_ms = now_timestamp_ms();
                        state.stream.last_warning = None;
                        state.stream.encoder_available = true;
                        active_runs[index] = Some(run);
                        streams_dirty = true;
                    }
                    Err(err) => {
                        state.current_target_identity = None;
                        state.stream.status = TestSessionVideoStreamStatus::Stopped;
                        state.stream.updated_at_ms = now_timestamp_ms();
                        apply_stream_warning(
                            &mut state.stream,
                            format!("failed to spawn ffmpeg capture loop: {err}"),
                        );
                        streams_dirty = true;
                    }
                }
            }

            let now_ms = now_timestamp_ms();
            if now_ms.saturating_sub(state.last_index_refresh_at_ms) >= INDEX_REFRESH_INTERVAL_MS {
                if refresh_stream_index(&active_session, &session_dir, state).unwrap_or(false) {
                    streams_dirty = true;
                }
                state.last_index_refresh_at_ms = now_ms;
            }
        }

        let now_ms = now_timestamp_ms();
        if streams_dirty && now_ms.saturating_sub(last_persist_at_ms) >= STREAM_PERSIST_INTERVAL_MS
        {
            let _ = persist_stream_states(&session_dir, &states);
            last_persist_at_ms = now_ms;
            streams_dirty = false;
        }
        sleep_interruptible(
            &stop_flag,
            Duration::from_millis(SUPERVISOR_POLL_INTERVAL_MS),
        );
    }

    for active_run in &mut active_runs {
        if let Some(run) = active_run.as_mut() {
            stop_capture_run(run);
        }
        *active_run = None;
    }

    for state in &mut states {
        let _ = refresh_stream_index(&active_session, &session_dir, state);
        state.stream.status = TestSessionVideoStreamStatus::Stopped;
        state.stream.updated_at_ms = now_timestamp_ms();
    }
    let _ = persist_stream_states(&session_dir, &states);
}

fn refresh_stream_index(
    session: &TestSessionRecord,
    session_dir: &Path,
    state: &mut StreamRuntimeState,
) -> Result<bool, FfmpegLoopRuntimeError> {
    let mut segments = collect_stream_segments(session_dir, &state.stream)?;
    trim_segments_to_window(&mut segments, state.max_segments)?;
    let current_status = state.stream.status.clone();
    let next_signature = build_segment_signature(&segments);
    let segments_changed = state.last_segment_signature.as_ref() != Some(&next_signature);
    update_stream_summary(
        &mut state.stream,
        &segments,
        current_status,
        if segments_changed {
            Some(session.ended_at_ms.unwrap_or_else(now_timestamp_ms))
        } else {
            None
        },
    );
    state.last_segment_signature = Some(next_signature);
    if segments_changed {
        rewrite_all_segments_index(session_dir)?;
    }
    Ok(segments_changed)
}

fn apply_recording_profile_to_stream(
    stream: &mut TestSessionVideoStreamRecord,
    recording_profile: &str,
) -> bool {
    let (sample_interval_ms, target_fps) =
        resolve_recording_profile_capture_params(recording_profile);
    let changed =
        stream.sample_interval_ms != sample_interval_ms || stream.target_fps != target_fps;
    if changed {
        stream.sample_interval_ms = sample_interval_ms;
        stream.target_fps = target_fps;
    }
    changed
}

fn resolve_capture_target(
    state: &mut StreamRuntimeState,
) -> Result<CaptureTarget, FfmpegLoopRuntimeError> {
    match state.stream.target_capture_mode.as_str() {
        "foreground_window" | "target_window" => resolve_foreground_window_target(state),
        _ => resolve_display_capture_target(&state.stream),
    }
}

fn resolve_display_capture_target(
    stream: &TestSessionVideoStreamRecord,
) -> Result<CaptureTarget, FfmpegLoopRuntimeError> {
    let (width, height) = normalize_even_capture_size(
        stream.width.unwrap_or(1920).max(1),
        stream.height.unwrap_or(1080).max(1),
    )
    .ok_or_else(|| {
        FfmpegLoopRuntimeError::Io(io::Error::other(
            "display capture bounds are too small for H.264 encoding",
        ))
    })?;
    let offset_x = stream.monitor_left.unwrap_or(0);
    let offset_y = stream.monitor_top.unwrap_or(0);
    Ok(CaptureTarget::DesktopRegion {
        identity: format!(
            "desktop:{}:{}:{}:{}:{}",
            stream.display_id.as_deref().unwrap_or("default"),
            offset_x,
            offset_y,
            width,
            height
        ),
        display_id: stream.display_id.clone(),
        offset_x,
        offset_y,
        width,
        height,
    })
}

fn resolve_foreground_window_target(
    state: &mut StreamRuntimeState,
) -> Result<CaptureTarget, FfmpegLoopRuntimeError> {
    let context = get_active_window_context().map_err(|err| io::Error::other(err.to_string()))?;
    if is_ignored_foreground_process(&context.process_name) {
        return build_last_known_window_target(state).ok_or_else(|| {
            FfmpegLoopRuntimeError::Io(io::Error::other(format!(
                "foreground window '{}' is ignored for capture",
                context.process_name
            )))
        });
    }

    let capture_rect = normalize_foreground_capture_rect(
        context.rect.left,
        context.rect.top,
        context.rect.right,
        context.rect.bottom,
        context
            .monitor_rect
            .as_ref()
            .map(|monitor| (monitor.left, monitor.top, monitor.right, monitor.bottom)),
    )
    .ok_or_else(|| {
        FfmpegLoopRuntimeError::Io(io::Error::other(
            "foreground window bounds are outside the visible monitor region",
        ))
    })?;
    let width = (capture_rect.2 - capture_rect.0) as u32;
    let height = (capture_rect.3 - capture_rect.1) as u32;
    let window_title = normalize_string(&context.window_title);
    let process_name = normalize_string(&context.process_name);
    let display_id = Some(context.display_id.clone());

    state.stream.display_id = display_id.clone();
    state.stream.width = Some(width);
    state.stream.height = Some(height);
    state.stream.monitor_left = Some(capture_rect.0);
    state.stream.monitor_top = Some(capture_rect.1);
    state.stream.monitor_right = Some(capture_rect.2);
    state.stream.monitor_bottom = Some(capture_rect.3);
    state.stream.label = window_title
        .clone()
        .or(process_name.clone())
        .map(|value| format!("Foreground Window · {value}"))
        .unwrap_or_else(|| "Foreground Window".to_string());
    state.last_window_hwnd = Some(format!("0x{:x}", context.hwnd as usize));
    state.last_window_title = window_title.clone();
    state.last_process_name = process_name.clone();

    Ok(CaptureTarget::Window {
        identity: format!(
            "foreground:{}:{}:{}:{}:{}:{}",
            context.hwnd as usize,
            context.display_id,
            capture_rect.0,
            capture_rect.1,
            width,
            height
        ),
        display_id,
        window_hwnd: state.last_window_hwnd.clone().unwrap_or_default(),
        window_title,
        process_name,
        offset_x: capture_rect.0,
        offset_y: capture_rect.1,
        width,
        height,
    })
}

fn normalize_foreground_capture_rect(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    monitor_rect: Option<(i32, i32, i32, i32)>,
) -> Option<(i32, i32, i32, i32)> {
    let mut normalized_left = left;
    let mut normalized_top = top;
    let mut normalized_right = right;
    let mut normalized_bottom = bottom;

    if let Some((monitor_left, monitor_top, monitor_right, monitor_bottom)) = monitor_rect {
        normalized_left = normalized_left.max(monitor_left);
        normalized_top = normalized_top.max(monitor_top);
        normalized_right = normalized_right.min(monitor_right);
        normalized_bottom = normalized_bottom.min(monitor_bottom);
    }

    if normalized_right <= normalized_left || normalized_bottom <= normalized_top {
        return None;
    }

    if (normalized_right - normalized_left) % 2 != 0 {
        normalized_right -= 1;
    }
    if (normalized_bottom - normalized_top) % 2 != 0 {
        normalized_bottom -= 1;
    }

    if normalized_right <= normalized_left || normalized_bottom <= normalized_top {
        return None;
    }

    Some((
        normalized_left,
        normalized_top,
        normalized_right,
        normalized_bottom,
    ))
}

fn normalize_even_capture_size(width: u32, height: u32) -> Option<(u32, u32)> {
    let normalized_width = if width > 1 && !width.is_multiple_of(2) {
        width - 1
    } else {
        width
    };
    let normalized_height = if height > 1 && !height.is_multiple_of(2) {
        height - 1
    } else {
        height
    };

    if normalized_width == 0 || normalized_height == 0 {
        return None;
    }

    Some((normalized_width, normalized_height))
}

fn is_ignored_foreground_process(process_name: &str) -> bool {
    let normalized = process_name.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "ffmpeg.exe" | "ffmpeg")
}

fn build_last_known_window_target(state: &StreamRuntimeState) -> Option<CaptureTarget> {
    let window_hwnd = state.last_window_hwnd.clone()?;
    let width = state.stream.width?;
    let height = state.stream.height?;
    let display_id = state.stream.display_id.clone();

    Some(CaptureTarget::Window {
        identity: format!(
            "foreground:{}:{}:{}:{}:{}:{}",
            window_hwnd,
            display_id.as_deref().unwrap_or("unknown"),
            state.stream.monitor_left.unwrap_or(0),
            state.stream.monitor_top.unwrap_or(0),
            width,
            height
        ),
        display_id,
        window_hwnd,
        window_title: state.last_window_title.clone(),
        process_name: state.last_process_name.clone(),
        offset_x: state.stream.monitor_left.unwrap_or(0),
        offset_y: state.stream.monitor_top.unwrap_or(0),
        width,
        height,
    })
}

fn normalize_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn apply_stream_warning(stream: &mut TestSessionVideoStreamRecord, warning: String) {
    if stream.last_warning.as_deref() != Some(warning.as_str()) {
        stream.warning_count = stream.warning_count.saturating_add(1);
    }
    stream.last_warning = Some(warning);
}

fn rewrite_all_segments_index(session_dir: &Path) -> Result<(), FfmpegLoopRuntimeError> {
    let video_root = session_dir.join("video");
    let streams_root = video_root.join("streams");
    let mut all_segments = Vec::new();

    if streams_root.exists() {
        for entry in fs::read_dir(&streams_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let manifest_path = entry.path().join("stream.json");
            if !manifest_path.exists() {
                continue;
            }
            let stream = read_json_file::<TestSessionVideoStreamRecord>(&manifest_path)?;
            all_segments.extend(collect_stream_segments(session_dir, &stream)?);
        }
    }

    all_segments.sort_by_key(|segment| (segment.started_at_ms, segment.stream_id.clone()));
    rewrite_segments_index(session_dir, &all_segments)
}

fn spawn_capture_run(
    ffmpeg: &Path,
    session: &TestSessionRecord,
    stream: &TestSessionVideoStreamRecord,
    target: &CaptureTarget,
    encoder_profile: VideoEncoderProfile,
    run_index: u32,
) -> Result<ActiveCaptureRun, FfmpegLoopRuntimeError> {
    let _ = session
        .session_dir
        .as_deref()
        .ok_or_else(|| io::Error::other("session dir is unavailable"))?;
    let stream_dir = PathBuf::from(
        stream
            .stream_dir
            .as_deref()
            .ok_or_else(|| io::Error::other("stream dir is unavailable"))?,
    );
    let segments_dir = stream_dir.join("segments");
    let runs_dir = stream_dir.join("runs");
    fs::create_dir_all(&segments_dir)?;
    fs::create_dir_all(&runs_dir)?;

    let run_id = format!("run-{run_index:04}");
    let segment_list_relative_path = format!("runs\\{run_id}.csv");
    let output_pattern_relative_path = format!("segments\\{run_id}-%05d.mp4");
    let (capture_input, window_hwnd, window_title, process_name, offset_x, offset_y) = match target
    {
        CaptureTarget::DesktopRegion {
            offset_x, offset_y, ..
        } => (
            "desktop".to_string(),
            None,
            None,
            None,
            *offset_x,
            *offset_y,
        ),
        CaptureTarget::Window {
            window_hwnd,
            window_title,
            process_name,
            offset_x,
            offset_y,
            ..
        } => (
            "desktop".to_string(),
            Some(window_hwnd.clone()),
            window_title.clone(),
            process_name.clone(),
            *offset_x,
            *offset_y,
        ),
    };
    let manifest = FfmpegCaptureRunManifest {
        schema_version: TEST_SESSION_SCHEMA_VERSION,
        kind: "reqcase.ffmpeg-loop-run".to_string(),
        run_id: run_id.clone(),
        session_id: session.session_id.clone(),
        stream_id: stream.stream_id.clone(),
        target_capture_mode: stream.target_capture_mode.clone(),
        display_id: target.display_id().map(str::to_string),
        capture_input,
        show_mouse_in_video: session.show_mouse_in_video,
        window_hwnd,
        window_title,
        process_name,
        started_at_ms: now_timestamp_ms(),
        segment_duration_seconds: stream
            .segment_duration_seconds
            .max(DEFAULT_SEGMENT_DURATION_SECONDS),
        target_fps: stream.target_fps.max(MIN_GDI_FRAMERATE),
        encoder_name: Some(encoder_profile.encoder_name().to_string()),
        offset_x,
        offset_y,
        width: target.width(),
        height: target.height(),
        segment_list_relative_path: segment_list_relative_path.clone(),
        output_pattern_relative_path: output_pattern_relative_path.clone(),
    };
    let manifest_path = runs_dir.join(format!("{run_id}.json"));
    atomic_write_json(&manifest_path, &manifest)?;

    let gop = manifest
        .target_fps
        .saturating_mul(manifest.segment_duration_seconds.max(1));
    let force_key_frames = format!("expr:gte(t,n_forced*{})", manifest.segment_duration_seconds);
    let video_size = format!("{}x{}", manifest.width, manifest.height);
    let target_fps = manifest.target_fps.to_string();
    let offset_x = manifest.offset_x.to_string();
    let offset_y = manifest.offset_y.to_string();
    let gop_string = gop.to_string();
    let segment_duration_seconds = manifest.segment_duration_seconds.to_string();

    let mut command = build_hidden_command(ffmpeg);
    command
        .current_dir(&stream_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.args(build_gdigrab_input_args(
        &manifest,
        target,
        &target_fps,
        &offset_x,
        &offset_y,
        &video_size,
    ));

    let mut encoder_args = Vec::new();
    append_segmented_encoder_args(
        &mut encoder_args,
        encoder_profile,
        &session.recording_profile,
        &gop_string,
        &force_key_frames,
    );
    command.args(encoder_args);
    command.args([
        "-f",
        "segment",
        "-segment_time",
        &segment_duration_seconds,
        "-reset_timestamps",
        "1",
        "-segment_list_type",
        "csv",
        "-segment_list",
        &manifest.segment_list_relative_path,
        "-segment_format_options",
        "movflags=+faststart",
        &manifest.output_pattern_relative_path,
    ]);

    let child = command.spawn()?;
    Ok(ActiveCaptureRun {
        child,
        started_at_ms: now_timestamp_ms(),
        encoder_name: encoder_profile.encoder_name(),
    })
}

fn build_gdigrab_input_args(
    manifest: &FfmpegCaptureRunManifest,
    target: &CaptureTarget,
    target_fps: &str,
    offset_x: &str,
    offset_y: &str,
    video_size: &str,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-framerate".to_string(),
        target_fps.to_string(),
        "-draw_mouse".to_string(),
        gdigrab_draw_mouse_value(manifest.show_mouse_in_video).to_string(),
    ];

    if matches!(
        target,
        CaptureTarget::DesktopRegion { .. } | CaptureTarget::Window { .. }
    ) {
        args.extend([
            "-offset_x".to_string(),
            offset_x.to_string(),
            "-offset_y".to_string(),
            offset_y.to_string(),
            "-video_size".to_string(),
            video_size.to_string(),
        ]);
    }

    args.extend([
        "-i".to_string(),
        manifest.capture_input.clone(),
        "-an".to_string(),
    ]);
    args
}

fn gdigrab_draw_mouse_value(show_mouse_in_video: bool) -> &'static str {
    if show_mouse_in_video {
        GDI_DRAW_MOUSE_ENABLED_VALUE
    } else {
        GDI_DRAW_MOUSE_DISABLED_VALUE
    }
}

fn stop_capture_run(run: &mut ActiveCaptureRun) {
    if let Some(stdin) = run.child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(PROCESS_STOP_TIMEOUT_MS) {
        match run.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => break,
        }
    }

    let _ = run.child.kill();
    let _ = run.child.wait();
}

fn collect_stream_segments(
    session_dir: &Path,
    stream: &TestSessionVideoStreamRecord,
) -> Result<Vec<TestSessionVideoSegmentRecord>, FfmpegLoopRuntimeError> {
    let stream_dir = PathBuf::from(
        stream
            .stream_dir
            .as_deref()
            .ok_or_else(|| io::Error::other("stream dir is unavailable"))?,
    );
    let manifests = load_run_manifests(&stream_dir)?;
    let mut segments = Vec::new();

    for manifest in manifests {
        let segment_list_path =
            stream_dir.join(manifest.segment_list_relative_path.replace('/', "\\"));
        if !segment_list_path.exists() {
            continue;
        }

        let file = fs::File::open(&segment_list_path)?;
        for line in BufReader::new(file).lines() {
            let line = line?;
            let Some(parsed) = parse_segment_csv_line(&manifest, &line) else {
                continue;
            };
            let absolute_path = stream_dir.join(parsed.file_relative_path.replace('/', "\\"));
            if !absolute_path.exists() {
                continue;
            }
            let metadata = match fs::metadata(&absolute_path) {
                Ok(value) => value,
                Err(_) => continue,
            };

            let extension = absolute_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let encoder_name = manifest
                .encoder_name
                .clone()
                .unwrap_or_else(|| "ffmpeg:libx264".to_string());
            let (codec, container, mime_type) = match extension.as_str() {
                "webm" => (
                    "vp9".to_string(),
                    "webm".to_string(),
                    "video/webm".to_string(),
                ),
                _ => (
                    "h264".to_string(),
                    "mp4".to_string(),
                    "video/mp4".to_string(),
                ),
            };

            segments.push(TestSessionVideoSegmentRecord {
                schema_version: TEST_SESSION_SCHEMA_VERSION,
                kind: TEST_SESSION_VIDEO_SEGMENT_KIND.to_string(),
                segment_id: absolute_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&manifest.run_id)
                    .to_string(),
                session_id: stream.session_id.clone(),
                stream_id: stream.stream_id.clone(),
                status: TestSessionVideoSegmentStatus::Ready,
                display_id: manifest
                    .display_id
                    .clone()
                    .or_else(|| stream.display_id.clone()),
                started_at_ms: parsed.started_at_ms,
                ended_at_ms: parsed
                    .ended_at_ms
                    .max(parsed.started_at_ms.saturating_add(1)),
                duration_ms: parsed
                    .ended_at_ms
                    .max(parsed.started_at_ms.saturating_add(1))
                    .saturating_sub(parsed.started_at_ms) as u32,
                relative_path: Some(relative_path_string(session_dir, &absolute_path)),
                file_path: Some(path_to_string(&absolute_path)),
                manifest_path: None,
                size_bytes: Some(metadata.len()),
                frame_count: None,
                codec: Some(codec),
                container: Some(container),
                mime_type: Some(mime_type),
                encoder_name: Some(encoder_name),
                is_playable: true,
            });
        }
    }

    segments.sort_by_key(|segment| segment.started_at_ms);
    Ok(segments)
}

fn trim_segments_to_window(
    segments: &mut Vec<TestSessionVideoSegmentRecord>,
    max_segments: usize,
) -> Result<(), FfmpegLoopRuntimeError> {
    if segments.len() <= max_segments {
        return Ok(());
    }

    let overflow = segments.len().saturating_sub(max_segments);
    for obsolete in segments.iter().take(overflow) {
        if let Some(file_path) = obsolete.file_path.as_deref() {
            let _ = fs::remove_file(file_path);
        }
        if let Some(manifest_path) = obsolete.manifest_path.as_deref() {
            let _ = fs::remove_file(manifest_path);
        }
    }
    segments.drain(0..overflow);
    Ok(())
}

fn update_stream_summary(
    stream: &mut TestSessionVideoStreamRecord,
    segments: &[TestSessionVideoSegmentRecord],
    status: TestSessionVideoStreamStatus,
    updated_at_ms: Option<u64>,
) {
    let retained_segment_bytes = segments
        .iter()
        .filter_map(|segment| segment.size_bytes)
        .sum();
    let last_segment = segments.last();

    stream.status = status;
    if let Some(updated_at_ms) = updated_at_ms {
        stream.updated_at_ms = updated_at_ms;
    }
    stream.segment_count = segments.len() as u32;
    stream.playable_segment_count = segments.len() as u32;
    stream.pending_segment_count = 0;
    stream.total_segment_bytes = retained_segment_bytes;
    stream.retained_segment_bytes = retained_segment_bytes;
    stream.last_segment_bytes = last_segment.and_then(|segment| segment.size_bytes);
    stream.last_segment_duration_ms = last_segment.map(|segment| segment.duration_ms);
    stream.last_segment_frame_count = last_segment.and_then(|segment| segment.frame_count);
    stream.playlist_path = last_segment.and_then(|segment| segment.file_path.clone());
}

fn build_segment_signature(segments: &[TestSessionVideoSegmentRecord]) -> StreamSegmentSignature {
    StreamSegmentSignature {
        count: segments.len(),
        first_segment_id: segments.first().map(|segment| segment.segment_id.clone()),
        last_segment_id: segments.last().map(|segment| segment.segment_id.clone()),
        retained_segment_bytes: segments
            .iter()
            .filter_map(|segment| segment.size_bytes)
            .sum(),
    }
}

fn load_run_manifests(
    stream_dir: &Path,
) -> Result<Vec<FfmpegCaptureRunManifest>, FfmpegLoopRuntimeError> {
    let runs_dir = stream_dir.join("runs");
    if !runs_dir.exists() {
        return Ok(Vec::new());
    }

    let mut manifests = Vec::new();
    for entry in fs::read_dir(&runs_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        manifests.push(read_json_file::<FfmpegCaptureRunManifest>(&entry.path())?);
    }
    manifests.sort_by_key(|manifest| (manifest.started_at_ms, manifest.run_id.clone()));
    Ok(manifests)
}

fn parse_segment_csv_line(
    manifest: &FfmpegCaptureRunManifest,
    line: &str,
) -> Option<ParsedSegmentRow> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.splitn(3, ',');
    let raw_file_relative_path = parts.next()?.trim().trim_matches('"').replace('/', "\\");
    let file_relative_path = if raw_file_relative_path.contains('\\') {
        raw_file_relative_path
    } else {
        Path::new(&manifest.output_pattern_relative_path)
            .parent()
            .map(|parent| parent.join(&raw_file_relative_path))
            .map(|path| path.to_string_lossy().replace('/', "\\"))
            .unwrap_or(raw_file_relative_path)
    };
    let started_seconds = parts.next()?.trim().parse::<f64>().ok()?;
    let ended_seconds = parts.next()?.trim().parse::<f64>().ok()?;
    Some(ParsedSegmentRow {
        file_relative_path,
        started_at_ms: manifest
            .started_at_ms
            .saturating_add((started_seconds.max(0.0) * 1000.0).round() as u64),
        ended_at_ms: manifest
            .started_at_ms
            .saturating_add((ended_seconds.max(0.0) * 1000.0).round() as u64),
    })
}

fn persist_stream_states(
    session_dir: &Path,
    states: &[StreamRuntimeState],
) -> Result<(), FfmpegLoopRuntimeError> {
    let streams = states
        .iter()
        .map(|state| state.stream.clone())
        .collect::<Vec<_>>();
    persist_streams_snapshot(session_dir, &streams)
}

fn persist_streams_snapshot(
    session_dir: &Path,
    streams: &[TestSessionVideoStreamRecord],
) -> Result<(), FfmpegLoopRuntimeError> {
    let streams_path = session_dir.join("video").join("streams.json");
    atomic_write_json(&streams_path, streams)?;
    for stream in streams {
        if let Some(manifest_path) = stream.manifest_path.as_deref() {
            atomic_write_json(Path::new(manifest_path), stream)?;
        }
    }
    Ok(())
}

fn rewrite_segments_index(
    session_dir: &Path,
    segments: &[TestSessionVideoSegmentRecord],
) -> Result<(), FfmpegLoopRuntimeError> {
    let segments_path = session_dir.join("video").join("segments.ndjson");
    let temp_path = segments_path.with_extension("ndjson.tmp");
    let mut file = fs::File::create(&temp_path)?;
    for segment in segments {
        let line = serde_json::to_string(segment)?;
        writeln!(file, "{line}")?;
    }
    file.flush()?;
    fs::rename(temp_path, segments_path)?;
    Ok(())
}

fn atomic_write_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), FfmpegLoopRuntimeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(value)?;
    fs::write(&temp_path, data)?;
    fs::rename(temp_path, path)?;
    Ok(())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, FfmpegLoopRuntimeError> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn compute_max_segments(buffer_window_seconds: u32, segment_duration_seconds: u32) -> usize {
    let duration = segment_duration_seconds.max(1);
    let window = buffer_window_seconds.max(duration);
    let quotient = window / duration;
    let remainder = window % duration;
    (quotient + u32::from(remainder > 0)).max(1) as usize
}

fn relative_path_string(base_dir: &Path, path: &Path) -> String {
    path.strip_prefix(base_dir)
        .map(path_to_string)
        .unwrap_or_else(|_| path_to_string(path))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn join_with_timeout(handle: JoinHandle<()>, timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if handle.is_finished() {
            let _ = handle.join();
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn sleep_interruptible(stop_flag: &AtomicBool, duration: Duration) {
    let mut remaining = duration;
    while remaining > Duration::ZERO && !stop_flag.load(Ordering::SeqCst) {
        let slice = remaining.min(Duration::from_millis(50));
        thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub(crate) fn resolve_ffmpeg_executable() -> Option<PathBuf> {
    let env_path = std::env::var_os(FFMPEG_ENV_VAR)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists());
    if env_path.is_some() {
        return env_path;
    }

    let current_exe = std::env::current_exe().ok();
    if let Some(path) = current_exe
        .as_deref()
        .and_then(find_ffmpeg_near_current_exe)
    {
        return Some(path);
    }

    let current_dir = std::env::current_dir().ok();
    if let Some(path) = current_dir.and_then(find_ffmpeg_in_repo_root) {
        return Some(path);
    }

    if command_available(Path::new("ffmpeg")) {
        return Some(PathBuf::from("ffmpeg"));
    }

    None
}

fn find_ffmpeg_near_current_exe(current_exe: &Path) -> Option<PathBuf> {
    let exe_dir = current_exe.parent()?;
    [
        exe_dir
            .join("resources")
            .join("ffmpeg")
            .join("bin")
            .join("ffmpeg.exe"),
        exe_dir.join("ffmpeg").join("bin").join("ffmpeg.exe"),
    ]
    .into_iter()
    .find(|candidate| candidate.exists())
}

fn find_ffmpeg_in_repo_root(start_dir: PathBuf) -> Option<PathBuf> {
    let mut cursor = Some(start_dir.as_path());
    while let Some(dir) = cursor {
        for candidate in [
            dir.join("tools")
                .join("ffmpeg")
                .join("bin")
                .join("ffmpeg.exe"),
            dir.join("examples")
                .join("desktop")
                .join("build-resources")
                .join("ffmpeg")
                .join("bin")
                .join("ffmpeg.exe"),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
        cursor = dir.parent();
    }
    None
}

fn command_available(command: &Path) -> bool {
    build_hidden_command(command)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn validate_ffmpeg_capture_support(ffmpeg: &Path) -> Result<(), FfmpegLoopRuntimeError> {
    let output = build_hidden_command(ffmpeg)
        .args([
            "-f",
            "gdigrab",
            "-framerate",
            "1",
            "-i",
            "desktop",
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let reason = stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or("ffmpeg gdigrab probe failed");
    Err(FfmpegLoopRuntimeError::UnsupportedExecutable(
        reason.to_string(),
    ))
}

pub(crate) fn build_hidden_command(program: &Path) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW_FLAG);
        command
    }

    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        CaptureTarget, FfmpegCaptureRunManifest, StreamRuntimeState,
        apply_recording_profile_to_stream, build_gdigrab_input_args,
        build_last_known_window_target, compute_max_segments, is_ignored_foreground_process,
        normalize_even_capture_size, normalize_foreground_capture_rect,
        recover_ffmpeg_loop_segments, should_use_ffmpeg_loop,
    };
    use crate::session::models::{
        TEST_SESSION_VIDEO_STREAM_KIND, TestSessionRecord, TestSessionStatus,
        TestSessionVideoStreamRecord, TestSessionVideoStreamStatus,
    };
    use crate::session::video_encoder::VideoEncoderProfile;

    #[test]
    fn recover_ffmpeg_loop_segments_rebuilds_playable_segments_from_csv() {
        let root = unique_temp_dir("shadowrecord-ffmpeg-loop-recover");
        let session_dir = root.join("ts-1");
        let stream_id = "vs-display-primary";
        let stream_dir = session_dir.join("video").join("streams").join(stream_id);
        let runs_dir = stream_dir.join("runs");
        let segments_dir = stream_dir.join("segments");
        fs::create_dir_all(&runs_dir).expect("create runs dir");
        fs::create_dir_all(&segments_dir).expect("create segments dir");

        let run_manifest = FfmpegCaptureRunManifest {
            schema_version: 1,
            kind: "reqcase.ffmpeg-loop-run".to_string(),
            run_id: "run-0001".to_string(),
            session_id: "ts-1".to_string(),
            stream_id: stream_id.to_string(),
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            capture_input: "desktop".to_string(),
            show_mouse_in_video: false,
            window_hwnd: None,
            window_title: None,
            process_name: None,
            started_at_ms: 1_000,
            segment_duration_seconds: 5,
            target_fps: 12,
            encoder_name: Some("ffmpeg:libx264".to_string()),
            offset_x: 0,
            offset_y: 0,
            width: 1920,
            height: 1080,
            segment_list_relative_path: "runs\\run-0001.csv".to_string(),
            output_pattern_relative_path: "segments\\run-0001-%05d.mp4".to_string(),
        };
        fs::write(
            runs_dir.join("run-0001.json"),
            serde_json::to_vec_pretty(&run_manifest).expect("serialize manifest"),
        )
        .expect("write run manifest");
        fs::write(
            runs_dir.join("run-0001.csv"),
            "segments\\\\run-0001-00000.mp4,0.000000,5.000000\nsegments\\\\run-0001-00001.mp4,5.000000,10.000000\n",
        )
        .expect("write csv");
        fs::write(segments_dir.join("run-0001-00000.mp4"), b"segment-a").expect("write segment a");
        fs::write(segments_dir.join("run-0001-00001.mp4"), b"segment-b").expect("write segment b");

        let session = fake_session(&session_dir, 30, 5);
        let mut streams = vec![fake_stream(&session, stream_id)];
        let segments = recover_ffmpeg_loop_segments(&session, &mut streams).expect("recover");

        assert_eq!(segments.len(), 2);
        assert!(segments.iter().all(|segment| segment.is_playable));
        assert_eq!(segments[0].started_at_ms, 1_000);
        assert_eq!(segments[1].started_at_ms, 6_000);
        assert_eq!(streams[0].segment_count, 2);
        assert_eq!(streams[0].playable_segment_count, 2);

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn ignored_foreground_process_uses_last_known_window_target() {
        let session = fake_session(Path::new("D:\\temp\\ts-1"), 30, 5);
        let stream = fake_stream(&session, "vs-window-primary");
        let state = StreamRuntimeState {
            stream,
            max_segments: 6,
            run_counter: 1,
            last_index_refresh_at_ms: 0,
            last_segment_signature: None,
            encoder_candidates: vec![VideoEncoderProfile::SoftwareX264],
            encoder_candidate_index: 0,
            current_target_identity: Some("foreground:0x100:display-1:40:24:1280:720".to_string()),
            last_window_hwnd: Some("0x100".to_string()),
            last_window_title: Some("Codex".to_string()),
            last_process_name: Some("Codex.exe".to_string()),
        };

        assert!(is_ignored_foreground_process("ffmpeg.exe"));
        let target = build_last_known_window_target(&state).expect("fallback target");
        match target {
            super::CaptureTarget::Window {
                window_hwnd,
                window_title,
                process_name,
                offset_x,
                offset_y,
                ..
            } => {
                assert_eq!(window_hwnd, "0x100");
                assert_eq!(window_title.as_deref(), Some("Codex"));
                assert_eq!(process_name.as_deref(), Some("Codex.exe"));
                assert_eq!(offset_x, 0);
                assert_eq!(offset_y, 0);
            }
            _ => panic!("expected window target"),
        }
    }

    #[test]
    fn recover_ffmpeg_loop_segments_trims_old_segments_to_buffer_window() {
        let root = unique_temp_dir("shadowrecord-ffmpeg-loop-trim");
        let session_dir = root.join("ts-1");
        let stream_id = "vs-display-primary";
        let stream_dir = session_dir.join("video").join("streams").join(stream_id);
        let runs_dir = stream_dir.join("runs");
        let segments_dir = stream_dir.join("segments");
        fs::create_dir_all(&runs_dir).expect("create runs dir");
        fs::create_dir_all(&segments_dir).expect("create segments dir");

        let run_manifest = FfmpegCaptureRunManifest {
            schema_version: 1,
            kind: "reqcase.ffmpeg-loop-run".to_string(),
            run_id: "run-0001".to_string(),
            session_id: "ts-1".to_string(),
            stream_id: stream_id.to_string(),
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            capture_input: "desktop".to_string(),
            show_mouse_in_video: false,
            window_hwnd: None,
            window_title: None,
            process_name: None,
            started_at_ms: 1_000,
            segment_duration_seconds: 5,
            target_fps: 12,
            encoder_name: Some("ffmpeg:libx264".to_string()),
            offset_x: 0,
            offset_y: 0,
            width: 1920,
            height: 1080,
            segment_list_relative_path: "runs\\run-0001.csv".to_string(),
            output_pattern_relative_path: "segments\\run-0001-%05d.mp4".to_string(),
        };
        fs::write(
            runs_dir.join("run-0001.json"),
            serde_json::to_vec_pretty(&run_manifest).expect("serialize manifest"),
        )
        .expect("write run manifest");
        fs::write(
            runs_dir.join("run-0001.csv"),
            "segments\\\\run-0001-00000.mp4,0.000000,5.000000\nsegments\\\\run-0001-00001.mp4,5.000000,10.000000\nsegments\\\\run-0001-00002.mp4,10.000000,15.000000\n",
        )
        .expect("write csv");
        fs::write(segments_dir.join("run-0001-00000.mp4"), b"segment-a").expect("write segment a");
        fs::write(segments_dir.join("run-0001-00001.mp4"), b"segment-b").expect("write segment b");
        fs::write(segments_dir.join("run-0001-00002.mp4"), b"segment-c").expect("write segment c");

        let session = fake_session(&session_dir, 10, 5);
        let mut streams = vec![fake_stream(&session, stream_id)];
        let segments = recover_ffmpeg_loop_segments(&session, &mut streams).expect("recover");

        assert_eq!(compute_max_segments(10, 5), 2);
        assert_eq!(segments.len(), 2);
        assert!(!segments_dir.join("run-0001-00000.mp4").exists());
        assert!(segments_dir.join("run-0001-00001.mp4").exists());
        assert!(segments_dir.join("run-0001-00002.mp4").exists());

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn recover_ffmpeg_loop_segments_accepts_bare_segment_filenames_from_csv() {
        let root = unique_temp_dir("shadowrecord-ffmpeg-loop-bare");
        let session_dir = root.join("ts-1");
        let stream_id = "vs-display-primary";
        let stream_dir = session_dir.join("video").join("streams").join(stream_id);
        let runs_dir = stream_dir.join("runs");
        let segments_dir = stream_dir.join("segments");
        fs::create_dir_all(&runs_dir).expect("create runs dir");
        fs::create_dir_all(&segments_dir).expect("create segments dir");

        let run_manifest = FfmpegCaptureRunManifest {
            schema_version: 1,
            kind: "reqcase.ffmpeg-loop-run".to_string(),
            run_id: "run-0001".to_string(),
            session_id: "ts-1".to_string(),
            stream_id: stream_id.to_string(),
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            capture_input: "desktop".to_string(),
            show_mouse_in_video: false,
            window_hwnd: None,
            window_title: None,
            process_name: None,
            started_at_ms: 1_000,
            segment_duration_seconds: 5,
            target_fps: 12,
            encoder_name: Some("ffmpeg:libx264".to_string()),
            offset_x: 0,
            offset_y: 0,
            width: 1920,
            height: 1080,
            segment_list_relative_path: "runs\\run-0001.csv".to_string(),
            output_pattern_relative_path: "segments\\run-0001-%05d.mp4".to_string(),
        };
        fs::write(
            runs_dir.join("run-0001.json"),
            serde_json::to_vec_pretty(&run_manifest).expect("serialize manifest"),
        )
        .expect("write run manifest");
        fs::write(
            runs_dir.join("run-0001.csv"),
            "run-0001-00000.mp4,0.000000,5.000000\n",
        )
        .expect("write csv");
        fs::write(segments_dir.join("run-0001-00000.mp4"), b"segment-a").expect("write segment");

        let session = fake_session(&session_dir, 30, 5);
        let mut streams = vec![fake_stream(&session, stream_id)];
        let segments = recover_ffmpeg_loop_segments(&session, &mut streams).expect("recover");

        assert_eq!(segments.len(), 1);
        assert!(segments[0].is_playable);

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn should_use_ffmpeg_loop_supports_foreground_window_mode() {
        let session = fake_session(Path::new("D:/tmp/ts-1"), 30, 5);
        assert!(should_use_ffmpeg_loop(&TestSessionRecord {
            target_capture_mode: "foreground_window".to_string(),
            ..session
        }));
    }

    #[test]
    fn normalize_foreground_capture_rect_clamps_shadow_bounds_to_monitor() {
        assert_eq!(
            normalize_foreground_capture_rect(-11, -11, 2571, 1539, Some((0, 0, 2560, 1600))),
            Some((0, 0, 2560, 1538))
        );
    }

    #[test]
    fn normalize_foreground_capture_rect_returns_none_when_window_is_outside_monitor() {
        assert_eq!(
            normalize_foreground_capture_rect(-300, -200, -50, -20, Some((0, 0, 2560, 1600))),
            None
        );
    }

    #[test]
    fn normalize_even_capture_size_trims_odd_dimensions() {
        assert_eq!(normalize_even_capture_size(2560, 1539), Some((2560, 1538)));
        assert_eq!(normalize_even_capture_size(1921, 1081), Some((1920, 1080)));
    }

    #[test]
    fn gdigrab_input_args_disable_cursor_drawing_for_loop_capture() {
        let manifest = FfmpegCaptureRunManifest {
            schema_version: 1,
            kind: "reqcase.ffmpeg-loop-run".to_string(),
            run_id: "run-0001".to_string(),
            session_id: "ts-1".to_string(),
            stream_id: "vs-display-primary".to_string(),
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            capture_input: "desktop".to_string(),
            show_mouse_in_video: false,
            window_hwnd: None,
            window_title: None,
            process_name: None,
            started_at_ms: 1_000,
            segment_duration_seconds: 5,
            target_fps: 12,
            encoder_name: Some("ffmpeg:libx264".to_string()),
            offset_x: 40,
            offset_y: 24,
            width: 1280,
            height: 720,
            segment_list_relative_path: "runs\\run-0001.csv".to_string(),
            output_pattern_relative_path: "segments\\run-0001-%05d.mp4".to_string(),
        };
        let target = CaptureTarget::DesktopRegion {
            identity: "desktop:display-1:40:24:1280:720".to_string(),
            display_id: Some("display-1".to_string()),
            offset_x: 40,
            offset_y: 24,
            width: 1280,
            height: 720,
        };

        let args = build_gdigrab_input_args(&manifest, &target, "12", "40", "24", "1280x720");

        let draw_mouse_index = args
            .iter()
            .position(|value| value == "-draw_mouse")
            .expect("draw_mouse flag should exist");
        assert_eq!(
            args.get(draw_mouse_index + 1).map(String::as_str),
            Some("0")
        );
        assert!(args.windows(2).any(|window| window == ["-i", "desktop"]));
    }

    #[test]
    fn gdigrab_input_args_enable_cursor_drawing_when_requested() {
        let manifest = FfmpegCaptureRunManifest {
            schema_version: 1,
            kind: "reqcase.ffmpeg-loop-run".to_string(),
            run_id: "run-0001".to_string(),
            session_id: "ts-1".to_string(),
            stream_id: "vs-display-primary".to_string(),
            target_capture_mode: "target_display".to_string(),
            display_id: Some("display-1".to_string()),
            capture_input: "desktop".to_string(),
            show_mouse_in_video: true,
            window_hwnd: None,
            window_title: None,
            process_name: None,
            started_at_ms: 1_000,
            segment_duration_seconds: 5,
            target_fps: 12,
            encoder_name: Some("ffmpeg:libx264".to_string()),
            offset_x: 40,
            offset_y: 24,
            width: 1280,
            height: 720,
            segment_list_relative_path: "runs\\run-0001.csv".to_string(),
            output_pattern_relative_path: "segments\\run-0001-%05d.mp4".to_string(),
        };
        let target = CaptureTarget::DesktopRegion {
            identity: "desktop:display-1:40:24:1280:720".to_string(),
            display_id: Some("display-1".to_string()),
            offset_x: 40,
            offset_y: 24,
            width: 1280,
            height: 720,
        };

        let args = build_gdigrab_input_args(&manifest, &target, "12", "40", "24", "1280x720");

        let draw_mouse_index = args
            .iter()
            .position(|value| value == "-draw_mouse")
            .expect("draw_mouse flag should exist");
        assert_eq!(
            args.get(draw_mouse_index + 1).map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn apply_recording_profile_to_stream_updates_capture_plan() {
        let root = unique_temp_dir("shadowrecord-ffmpeg-loop-profile-sync");
        let session = fake_session(&root.join("ts-1"), 30, 5);
        let mut stream = fake_stream(&session, "vs-display-primary");

        assert_eq!(stream.sample_interval_ms, 83);
        assert_eq!(stream.target_fps, 12);

        assert!(apply_recording_profile_to_stream(&mut stream, "smooth"));
        assert_eq!(stream.sample_interval_ms, 50);
        assert_eq!(stream.target_fps, 20);

        assert!(!apply_recording_profile_to_stream(&mut stream, "smooth"));
        assert_eq!(stream.sample_interval_ms, 50);
        assert_eq!(stream.target_fps, 20);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

    fn fake_session(
        session_dir: &Path,
        buffer_window_seconds: u32,
        segment_duration_seconds: u32,
    ) -> TestSessionRecord {
        TestSessionRecord {
            schema_version: 1,
            kind: "reqcase.test-session".to_string(),
            session_id: "ts-1".to_string(),
            name: Some("ffmpeg loop".to_string()),
            status: TestSessionStatus::Active,
            started_at_ms: 1_000,
            updated_at_ms: 1_000,
            ended_at_ms: None,
            storage_root_dir: Some(
                session_dir
                    .parent()
                    .unwrap_or(session_dir)
                    .to_string_lossy()
                    .into_owned(),
            ),
            session_dir: Some(session_dir.to_string_lossy().into_owned()),
            manifest_path: Some(
                session_dir
                    .join("session.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            buffer_window_seconds,
            segment_duration_seconds,
            recording_profile: "balanced".to_string(),
            encoder_preference: "auto".to_string(),
            show_mouse_in_video: false,
            notes: None,
            target_process_name: None,
            target_pid: None,
            target_hwnd: None,
            target_display_id: Some("display-1".to_string()),
            target_display_ids: Some(vec!["display-1".to_string()]),
            target_capture_mode: "target_display".to_string(),
        }
    }

    fn fake_stream(session: &TestSessionRecord, stream_id: &str) -> TestSessionVideoStreamRecord {
        let stream_dir = PathBuf::from(
            session
                .session_dir
                .as_deref()
                .expect("session dir should exist"),
        )
        .join("video")
        .join("streams")
        .join(stream_id);

        TestSessionVideoStreamRecord {
            schema_version: 1,
            kind: TEST_SESSION_VIDEO_STREAM_KIND.to_string(),
            stream_id: stream_id.to_string(),
            session_id: session.session_id.clone(),
            label: "Primary Display".to_string(),
            status: TestSessionVideoStreamStatus::Planned,
            target_capture_mode: session.target_capture_mode.clone(),
            display_id: Some("display-1".to_string()),
            display_label: Some("Primary Display".to_string()),
            width: Some(1920),
            height: Some(1080),
            monitor_left: Some(0),
            monitor_top: Some(0),
            monitor_right: Some(1920),
            monitor_bottom: Some(1080),
            started_at_ms: session.started_at_ms,
            updated_at_ms: session.updated_at_ms,
            segment_duration_seconds: session.segment_duration_seconds,
            segment_count: 0,
            playable_segment_count: 0,
            pending_segment_count: 0,
            total_segment_bytes: 0,
            retained_segment_bytes: 0,
            last_segment_bytes: None,
            last_segment_duration_ms: None,
            last_segment_frame_count: None,
            last_capture_latency_ms: None,
            last_encode_latency_ms: None,
            sample_interval_ms: 83,
            target_fps: 12,
            encoder_available: false,
            warning_count: 0,
            last_warning: None,
            stream_dir: Some(stream_dir.to_string_lossy().into_owned()),
            manifest_path: Some(
                stream_dir
                    .join("stream.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            playlist_path: None,
        }
    }
}
