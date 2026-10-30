//! Defect evidence pack export (time-window video + steps + screenshots + repro text).

use std::cell::RefCell;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::session::ffmpeg_loop_runtime::{build_hidden_command, resolve_ffmpeg_executable};
use crate::session::models::{
    TestSessionRecord, TestSessionStepRecord, TestSessionVideoSegmentRecord,
};
use crate::session::operation_models::{
    OperationAction, OperationActionConfidence, OperationActionKind, OperationCoordinate,
    OperationEvidence, OperationEvidenceKind, OperationEvidenceRole, OperationOutcome,
    OperationOutcomeConfidence, OperationOutcomeSelectionSource, OperationOutcomeStatus,
    OperationReasonCode, TEST_SESSION_OPERATION_KIND, TestSessionOperationRecord,
    UiElementIdentity, operation_schema_version,
};
use crate::session::operation_summary::{OPERATION_BUILDER_VERSION, render_repro_operations_text};
use crate::session::step_builder::render_repro_steps_text;

pub const LEGACY_OPERATION_RESULT_SUMMARY: &str = "旧记录未采集操作结果";

#[derive(Debug)]
pub enum DefectPackError {
    Io(io::Error),
    Serialize(serde_json::Error),
    MissingSessionDir,
    Ffmpeg(String),
    DiskSpace(String),
}

const FFMPEG_STREAM_COPY_TIMEOUT: Duration = Duration::from_secs(120);
const FFMPEG_REENCODE_TIMEOUT: Duration = Duration::from_secs(600);
const FFMPEG_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const FFMPEG_VALIDATE_TIMEOUT: Duration = Duration::from_secs(120);
const FFMPEG_QUIT_GRACE: Duration = Duration::from_secs(2);
const FFMPEG_STDERR_TAIL_BYTES: usize = 4096;
const FFMPEG_STDERR_HEAD_BYTES: usize = 16384;

#[derive(Clone, Copy)]
struct FfmpegLimits {
    probe: Duration,
    copy: Duration,
    reencode: Duration,
    validate: Duration,
}

thread_local! {
    static FFMPEG_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static FFMPEG_LIMITS_OVERRIDE: RefCell<Option<FfmpegLimits>> = const { RefCell::new(None) };
}

fn ffmpeg_limits() -> FfmpegLimits {
    FFMPEG_LIMITS_OVERRIDE.with(|slot| {
        (*slot.borrow()).unwrap_or(FfmpegLimits {
            probe: FFMPEG_PROBE_TIMEOUT,
            copy: FFMPEG_STREAM_COPY_TIMEOUT,
            reencode: FFMPEG_REENCODE_TIMEOUT,
            validate: FFMPEG_VALIDATE_TIMEOUT,
        })
    })
}

fn ffmpeg_for_pack() -> Option<PathBuf> {
    let overridden = FFMPEG_OVERRIDE.with(|slot| slot.borrow().clone());
    overridden.or_else(resolve_ffmpeg_executable)
}

impl std::fmt::Display for DefectPackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "defect pack io failed: {err}"),
            Self::Serialize(err) => write!(f, "defect pack serialize failed: {err}"),
            Self::MissingSessionDir => write!(f, "session directory is unavailable"),
            Self::Ffmpeg(message) => write!(f, "defect pack ffmpeg failed: {message}"),
            Self::DiskSpace(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for DefectPackError {}

impl From<io::Error> for DefectPackError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for DefectPackError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialize(value)
    }
}

#[derive(Debug, Clone)]
pub struct DefectPackRequest {
    pub target_dir: String,
    pub marked_at_ms: u64,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectPackSummary {
    pub session_id: String,
    pub marked_at_ms: u64,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub pre_window_seconds: u32,
    pub post_window_seconds: u32,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub step_count: u32,
    pub screenshot_count: u32,
    pub video_segment_count: u32,
    pub clip_built: bool,
    pub clip_path: Option<String>,
    pub target_process_name: Option<String>,
    pub target_capture_mode: String,
    pub recording_profile: String,
    pub privacy: DefectPackPrivacyFlags,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectPackPrivacyFlags {
    pub includes_screenshots: bool,
    pub includes_video: bool,
    pub keyboard_mode: String,
    pub stores_click_snapshot: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectPackResult {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefectPackManifest {
    schema_version: u32,
    kind: String,
    session_id: String,
    created_at_ms: u64,
    files: Vec<DefectPackFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefectPackFileEntry {
    relative_path: String,
    bytes: u64,
    #[serde(default)]
    sha256: String,
}

/// Clamp defect mark / pre-post window so a late mark still covers the recorded session.
///
/// Returns `(effective_marked_at_ms, window_start_ms, window_end_ms)`.
pub fn clamp_defect_time_window(
    session_started_at_ms: u64,
    session_ended_at_ms: Option<u64>,
    marked_at_ms: u64,
    pre_window_seconds: u32,
    post_window_seconds: u32,
) -> (u64, u64, u64) {
    let session_start = session_started_at_ms.max(1);
    let session_end = session_ended_at_ms
        .unwrap_or(marked_at_ms.max(session_start))
        .max(session_start);
    // Late marks after stop re-anchor to session end so pre-window covers recording.
    let effective_mark = marked_at_ms.clamp(session_start, session_end);
    let pre_ms = u64::from(pre_window_seconds).saturating_mul(1000);
    let post_ms = u64::from(post_window_seconds).saturating_mul(1000);
    let mut window_start = effective_mark.saturating_sub(pre_ms);
    let mut window_end = effective_mark.saturating_add(post_ms);
    if window_start < session_start {
        window_start = session_start;
    }
    // Keep a small post-stop tail for mark bookkeeping, but never start after session end.
    if window_end < session_start {
        window_end = session_end.saturating_add(post_ms);
    }
    if window_end < window_start {
        window_end = window_start;
    }
    (effective_mark, window_start, window_end)
}

/// Project legacy steps into operation records with honest `legacyUnknown` outcomes.
pub fn legacy_operations_from_steps(
    session_id: &str,
    steps: &[TestSessionStepRecord],
) -> Vec<TestSessionOperationRecord> {
    steps
        .iter()
        .enumerate()
        .map(|(index, step)| legacy_operation_from_step(session_id, step, index))
        .collect()
}

fn legacy_operation_from_step(
    session_id: &str,
    step: &TestSessionStepRecord,
    index: usize,
) -> TestSessionOperationRecord {
    let operation_id = if step.step_id.trim().is_empty() {
        format!("legacy-step-{}", index + 1)
    } else {
        step.step_id.clone()
    };
    let source_id = step
        .source_event_ids
        .first()
        .cloned()
        .unwrap_or_else(|| operation_id.clone());
    let kind = legacy_action_kind(&step.step_type, &step.title);
    let target = if step.window_title.is_some()
        || step.process_name.is_some()
        || step.control_name.is_some()
    {
        Some(UiElementIdentity {
            runtime_id: None,
            process_id: None,
            window_hwnd: None,
            name: step
                .control_name
                .clone()
                .or_else(|| step.window_title.clone())
                .or_else(|| step.process_name.clone()),
            automation_id: step.automation_id.clone(),
            control_type: step.control_type.clone(),
            localized_control_type: None,
            class_name: step.class_name.clone(),
            framework_id: None,
            parent_path: Vec::new(),
            bounding_rect: None,
        })
    } else {
        None
    };
    let coordinate = match (step.x, step.y) {
        (Some(x), Some(y)) => Some(OperationCoordinate {
            x,
            y,
            display_id: step.display_id.clone(),
        }),
        _ => None,
    };
    let title = if step.title.trim().is_empty() {
        format!("步骤 {}", index + 1)
    } else {
        step.title.clone()
    };
    let result_summary = LEGACY_OPERATION_RESULT_SUMMARY.to_string();
    let latency_ms = step.ended_at_ms.saturating_sub(step.started_at_ms);

    TestSessionOperationRecord {
        schema_version: operation_schema_version(),
        kind: TEST_SESSION_OPERATION_KIND.to_string(),
        operation_id: operation_id.clone(),
        session_id: session_id.to_string(),
        sequence: u32::try_from(index + 1).unwrap_or(u32::MAX),
        started_at_ms: step.started_at_ms,
        ended_at_ms: step.ended_at_ms,
        relative_ms_from_session_start: step.relative_ms_from_session_start,
        action: OperationAction {
            action_id: format!("legacy-action-{operation_id}"),
            kind,
            occurred_at_ms: step.started_at_ms,
            ended_at_ms: Some(step.ended_at_ms),
            target,
            state_before: None,
            coordinate,
            source_event_ids: if step.source_event_ids.is_empty() {
                vec![source_id.clone()]
            } else {
                step.source_event_ids.clone()
            },
            target_reason_codes: vec![OperationReasonCode::CoordinateFallback],
            confidence: OperationActionConfidence {
                target: None,
                temporal: None,
                overall: Some(step.confidence),
            },
            content_preview: None,
        },
        outcome: OperationOutcome {
            outcome_id: format!("legacy-outcome-{operation_id}"),
            status: OperationOutcomeStatus::LegacyUnknown,
            summary: Some(result_summary.clone()),
            observed_at_ms: step.ended_at_ms,
            latency_ms,
            primary_transition_id: None,
            candidate_transition_ids: Vec::new(),
            reason_codes: vec![OperationReasonCode::NoObservableChange],
            confidence: OperationOutcomeConfidence::default(),
        },
        completion_candidates: Vec::new(),
        transitions: Vec::new(),
        evidence: vec![OperationEvidence {
            evidence_id: format!("legacy-evidence-{operation_id}"),
            kind: OperationEvidenceKind::RawEvent,
            role: OperationEvidenceRole::Context,
            source_id,
            occurred_at_ms: step.started_at_ms,
            artifact_ref: step
                .full_image_path
                .clone()
                .or_else(|| step.thumb_image_path.clone()),
            video_range: None,
            reason_code: Some(OperationReasonCode::CoordinateFallback),
        }],
        title: title.clone(),
        result_summary: result_summary.clone(),
        display_summary: format!("{title} -> {result_summary}"),
        precision_level: if step.precision_level.trim().is_empty() {
            "legacy-step-adapter".to_string()
        } else {
            step.precision_level.clone()
        },
        outcome_selection_source: OperationOutcomeSelectionSource::Auto,
        edited: step.edited,
        ignored: false,
        business_alias: step.business_alias.clone(),
        manual_note: None,
    }
}

fn legacy_action_kind(step_type: &str, title: &str) -> OperationActionKind {
    let normalized = format!("{step_type} {title}").to_ascii_lowercase();
    if normalized.contains("double") {
        OperationActionKind::DoubleClick
    } else if normalized.contains("right") {
        OperationActionKind::RightClick
    } else if normalized.contains("scroll")
        || normalized.contains("wheel")
        || normalized.contains("滚轮")
    {
        OperationActionKind::Scroll
    } else if normalized.contains("window") || normalized.contains("切换") {
        OperationActionKind::WindowSwitch
    } else if normalized.contains("type")
        || normalized.contains("key")
        || normalized.contains("输入")
    {
        OperationActionKind::TypeSummary
    } else if normalized.contains("click") || normalized.contains("点击") {
        OperationActionKind::Click
    } else {
        OperationActionKind::Other(step_type.to_string())
    }
}

#[allow(dead_code)]
pub fn export_defect_pack(
    session: &TestSessionRecord,
    steps: &[TestSessionStepRecord],
    segments: &[TestSessionVideoSegmentRecord],
    request: &DefectPackRequest,
) -> Result<DefectPackResult, DefectPackError> {
    export_defect_pack_with_operations(session, steps, &[], segments, request)
}

pub fn export_defect_pack_with_operations(
    session: &TestSessionRecord,
    steps: &[TestSessionStepRecord],
    operations: &[TestSessionOperationRecord],
    segments: &[TestSessionVideoSegmentRecord],
    request: &DefectPackRequest,
) -> Result<DefectPackResult, DefectPackError> {
    let session_dir = session
        .session_dir
        .as_deref()
        .ok_or(DefectPackError::MissingSessionDir)?;
    let session_dir = Path::new(session_dir);

    let pack_name = format!(
        "defect-{}-{}",
        short_session_id(&session.session_id),
        request.marked_at_ms
    );
    let pack_dir = PathBuf::from(&request.target_dir).join(pack_name);
    let created_new = !pack_dir.exists();
    let export_result = (|| -> Result<DefectPackResult, DefectPackError> {
    fs::create_dir_all(&pack_dir)?;
    fs::create_dir_all(pack_dir.join("video").join("segments"))?;
    fs::create_dir_all(pack_dir.join("screenshots"))?;

    let window_steps = steps
        .iter()
        .filter(|step| {
            step.started_at_ms >= request.window_start_ms
                && step.started_at_ms <= request.window_end_ms
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut window_operations = operations
        .iter()
        .filter(|operation| {
            !operation.ignored
                && operation.started_at_ms >= request.window_start_ms
                && operation.started_at_ms <= request.window_end_ms
        })
        .cloned()
        .collect::<Vec<_>>();
    // Steps-only sessions: still emit honest legacyUnknown operations for export consumers.
    if window_operations.is_empty() && !window_steps.is_empty() {
        window_operations = legacy_operations_from_steps(&session.session_id, &window_steps);
    }

    let target_stream_id = segments
        .iter()
        .find(|s| {
            if let Some(target_d) = session.target_display_id.as_deref() {
                s.display_id.as_deref() == Some(target_d)
            } else {
                false
            }
        })
        .map(|s| s.stream_id.clone())
        .or_else(|| segments.first().map(|s| s.stream_id.clone()));

    let window_segments = segments
        .iter()
        .filter(|segment| {
            let stream_matches = target_stream_id
                .as_ref()
                .map(|t| t == &segment.stream_id)
                .unwrap_or(true);
            stream_matches
                && segment.ended_at_ms >= request.window_start_ms
                && segment.started_at_ms <= request.window_end_ms
                && (segment.is_playable
                    || segment.file_path.is_some()
                    || segment.relative_path.is_some())
        })
        .cloned()
        .collect::<Vec<_>>();

    let defect_note = request.note.as_deref().or(request.actual.as_deref());
    let repro_text = if !window_operations.is_empty() {
        render_repro_operations_text(
            &session.session_id,
            Some(request.marked_at_ms),
            Some(request.window_start_ms),
            Some(request.window_end_ms),
            defect_note,
            &window_operations,
        )
    } else {
        render_repro_steps_text(
            &session.session_id,
            Some(request.marked_at_ms),
            Some(request.window_start_ms),
            Some(request.window_end_ms),
            defect_note,
            &window_steps,
        )
    };
    let repro_steps_path = pack_dir.join("repro_steps.txt");
    fs::write(&repro_steps_path, repro_text.as_bytes())?;

    let steps_path = pack_dir.join("steps.json");
    write_json(&steps_path, &window_steps)?;

    let operations_path = pack_dir.join("operations.json");
    let operations_payload = serde_json::json!({
        "schemaVersion": operation_schema_version(),
        "builderVersion": OPERATION_BUILDER_VERSION,
        "kind": "reqcase.test-session-operations-export",
        "sessionId": session.session_id,
        "windowStartMs": request.window_start_ms,
        "windowEndMs": request.window_end_ms,
        "items": window_operations,
        "legacyAdapted": operations.is_empty() && !window_steps.is_empty(),
    });
    write_json(&operations_path, &operations_payload)?;

    let mut screenshot_count = 0u32;
    for (index, step) in window_steps.iter().enumerate() {
        if let Some(source) = step
            .full_image_path
            .as_deref()
            .or(step.thumb_image_path.as_deref())
        {
            let source_path = Path::new(source);
            if !source_path.exists() {
                // Try relative to session dir.
                let alt = session_dir.join(source);
                if alt.exists() {
                    let dest = pack_dir.join("screenshots").join(format!(
                        "{:02}-{}.webp",
                        index + 1,
                        sanitize_file_stem(&step.step_id)
                    ));
                    fs::copy(&alt, &dest)?;
                    screenshot_count = screenshot_count.saturating_add(1);
                }
                continue;
            }
            let dest = pack_dir.join("screenshots").join(format!(
                "{:02}-{}.webp",
                index + 1,
                sanitize_file_stem(&step.step_id)
            ));
            fs::copy(source_path, &dest)?;
            screenshot_count = screenshot_count.saturating_add(1);
        }
    }

    let source_bytes = segment_source_bytes(session_dir, &window_segments);
    ensure_export_space(Path::new(&request.target_dir), source_bytes)?;

    let mut video_segment_count = 0u32;
    let mut segment_index_lines = Vec::new();
    for (index, segment) in window_segments.iter().enumerate() {
        let Some(source_path) = segment_source_path(session_dir, segment) else {
            continue;
        };
        if !source_path.exists() {
            continue;
        }
        let ext = source_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp4");
        let dest_name = format!(
            "{:02}-{}.{}",
            index + 1,
            sanitize_file_stem(&segment.segment_id),
            ext
        );
        let dest = pack_dir.join("video").join("segments").join(&dest_name);
        fs::copy(&source_path, &dest)?;
        segment_index_lines.push(format!(
            "{}\t{}\t{}\t{}",
            segment.segment_id, segment.started_at_ms, segment.ended_at_ms, dest_name
        ));
        video_segment_count = video_segment_count.saturating_add(1);
    }
    let playlist_path = pack_dir.join("video").join("segments.txt");
    fs::write(
        &playlist_path,
        if segment_index_lines.is_empty() {
            "no playable segments in window\n".to_string()
        } else {
            segment_index_lines.join("\n") + "\n"
        },
    )?;

    let segment_files = collect_segment_files(&pack_dir.join("video").join("segments"))?;
    let clip_path = pack_dir.join("video").join("clip.mp4");
    let clip_built = try_build_clip_mp4(&segment_files, &clip_path)?;
    let clip_path_str = if clip_built && clip_path.exists() {
        Some(path_to_string(&clip_path))
    } else {
        None
    };

    let pre_window_seconds =
        ((request.marked_at_ms.saturating_sub(request.window_start_ms)) / 1000) as u32;
    let post_window_seconds =
        ((request.window_end_ms.saturating_sub(request.marked_at_ms)) / 1000) as u32;

    let summary = DefectPackSummary {
        session_id: session.session_id.clone(),
        marked_at_ms: request.marked_at_ms,
        window_start_ms: request.window_start_ms,
        window_end_ms: request.window_end_ms,
        pre_window_seconds,
        post_window_seconds,
        note: request.note.clone(),
        expected: request.expected.clone(),
        actual: request.actual.clone(),
        step_count: u32::try_from(window_steps.len()).unwrap_or(u32::MAX),
        screenshot_count,
        video_segment_count,
        clip_built,
        clip_path: clip_path_str.clone(),
        target_process_name: session.target_process_name.clone(),
        target_capture_mode: session.target_capture_mode.clone(),
        recording_profile: session.recording_profile.clone(),
        privacy: DefectPackPrivacyFlags {
            includes_screenshots: screenshot_count > 0,
            includes_video: video_segment_count > 0 || clip_built,
            keyboard_mode: "summary".to_string(),
            stores_click_snapshot: true,
        },
    };
    let summary_path = pack_dir.join("summary.json");
    write_json(&summary_path, &summary)?;

    let mut files = vec![
        file_entry(&pack_dir, "repro_steps.txt")?,
        file_entry(&pack_dir, "steps.json")?,
        file_entry(&pack_dir, "operations.json")?,
        file_entry(&pack_dir, "summary.json")?,
        file_entry(&pack_dir, "video/segments.txt")?,
    ];
    if clip_built {
        files.push(file_entry(&pack_dir, "video/clip.mp4")?);
    }
    append_dir_entries(
        &pack_dir,
        pack_dir.join("screenshots"),
        "screenshots",
        &mut files,
    )?;
    append_dir_entries(
        &pack_dir,
        pack_dir.join("video").join("segments"),
        "video/segments",
        &mut files,
    )?;

    let manifest = DefectPackManifest {
        schema_version: 1,
        kind: "reqcase.defect-pack".to_string(),
        session_id: session.session_id.clone(),
        created_at_ms: request.marked_at_ms,
        files,
    };
    let manifest_path = pack_dir.join("manifest.json");
    write_json(&manifest_path, &manifest)?;

    Ok(DefectPackResult {
        pack_dir: path_to_string(&pack_dir),
        repro_steps_path: path_to_string(&repro_steps_path),
        summary_path: path_to_string(&summary_path),
        steps_path: path_to_string(&steps_path),
        manifest_path: path_to_string(&manifest_path),
        step_count: summary.step_count,
        screenshot_count,
        clip_path: clip_path_str,
        clip_built,
        video_segment_count,
    })
    })();
    if export_result.is_err() && created_new {
        let _ = fs::remove_dir_all(&pack_dir);
    }
    export_result
}

fn segment_source_path(
    session_dir: &Path,
    segment: &TestSessionVideoSegmentRecord,
) -> Option<PathBuf> {
    segment.file_path.as_deref().map(PathBuf::from).or_else(|| {
        segment
            .relative_path
            .as_ref()
            .map(|relative| session_dir.join(relative))
    })
}

fn segment_source_bytes(session_dir: &Path, segments: &[TestSessionVideoSegmentRecord]) -> u64 {
    segments.iter().fold(0, |total, segment| {
        let Some(path) = segment_source_path(session_dir, segment) else {
            return total;
        };
        let len = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        total.saturating_add(len)
    })
}

fn ensure_export_space(target_dir: &Path, source_bytes: u64) -> Result<(), DefectPackError> {
    let needed = crate::disk_space::estimated_export_bytes(source_bytes);
    let free = crate::disk_space::disk_free_bytes(target_dir).map_err(|err| {
        DefectPackError::DiskSpace(format!("无法读取磁盘剩余空间，无法导出：{err}"))
    })?;
    if !crate::disk_space::can_export(free, source_bytes) {
        return Err(DefectPackError::DiskSpace(
            crate::disk_space::export_refused_message(needed),
        ));
    }
    Ok(())
}

fn collect_segment_files(segments_dir: &Path) -> Result<Vec<PathBuf>, DefectPackError> {
    if !segments_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(segments_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| {
                        let lower = ext.to_ascii_lowercase();
                        lower == "mp4" || lower == "webm" || lower == "mkv"
                    })
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

/// Best-effort concat into one playable clip.mp4.
/// Stream-copy only when every segment reports the same codec, size, pixel format, and frame rate.
/// Otherwise re-encode with libx264. A timeout deletes the list and the clip and returns an error.
fn try_build_clip_mp4(segment_files: &[PathBuf], output: &Path) -> Result<bool, DefectPackError> {
    let result = try_build_clip_mp4_inner(segment_files, output);
    if result.is_err() {
        let _ = fs::remove_file(output.with_extension("concat.txt"));
        let _ = fs::remove_file(output);
    }
    result
}

fn try_build_clip_mp4_inner(
    segment_files: &[PathBuf],
    output: &Path,
) -> Result<bool, DefectPackError> {
    if segment_files.is_empty() {
        return Ok(false);
    }
    let Some(ffmpeg) = ffmpeg_for_pack() else {
        return Ok(false);
    };

    if segment_files.len() == 1 {
        let copied = fs::copy(&segment_files[0], output).is_ok() && output.exists();
        if !copied {
            let _ = fs::remove_file(output);
        }
        return Ok(copied);
    }

    let list_path = output.with_extension("concat.txt");
    let mut list_body = String::new();
    for file in segment_files {
        let text = file.to_string_lossy();
        list_body.push_str(&ffmpeg_concat_file_line(&text));
        list_body.push('\n');
    }
    if fs::write(&list_path, &list_body).is_err() {
        let _ = fs::remove_file(&list_path);
        return Ok(false);
    }

    let limits = ffmpeg_limits();
    let probed = probe_segments(&ffmpeg, segment_files, limits.probe);
    let compatible = probed
        .as_ref()
        .is_some_and(|items| items.windows(2).all(|pair| pair[0] == pair[1]));

    if compatible {
        let copy_ok =
            run_ffmpeg_concat_with_timeout(&ffmpeg, &list_path, output, true, limits.copy)?;
        if copy_ok {
            let _ = fs::remove_file(&list_path);
            return Ok(true);
        }
    } else if probed.is_none() {
        let copy_ok =
            run_ffmpeg_concat_with_timeout(&ffmpeg, &list_path, output, true, limits.copy)?;
        if copy_ok {
            match validate_clip(&ffmpeg, output, limits.validate)? {
                true => {
                    let _ = fs::remove_file(&list_path);
                    return Ok(true);
                }
                false => {
                    let _ = fs::remove_file(output);
                }
            }
        }
    }

    let _ = fs::remove_file(output);
    let reencode_ok =
        run_ffmpeg_concat_with_timeout(&ffmpeg, &list_path, output, false, limits.reencode)?;
    let _ = fs::remove_file(&list_path);
    if !reencode_ok {
        let _ = fs::remove_file(output);
    }
    Ok(reencode_ok)
}

fn ffmpeg_concat_file_line(path: &str) -> String {
    let normalized = path.replace('\\', "/").replace('\'', "'\\''");
    format!("file '{normalized}'")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VideoParams {
    codec: String,
    width: u32,
    height: u32,
    pix_fmt: String,
    fps_millis: u32,
}

fn probe_segments(ffmpeg: &Path, files: &[PathBuf], timeout: Duration) -> Option<Vec<VideoParams>> {
    let mut params = Vec::with_capacity(files.len());
    for file in files {
        params.push(probe_video(ffmpeg, file, timeout)?);
    }
    Some(params)
}

fn probe_video(ffmpeg: &Path, file: &Path, timeout: Duration) -> Option<VideoParams> {
    let args = [
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        file.as_os_str().to_os_string(),
    ];
    let finished = match run_ffmpeg(ffmpeg, &args, timeout, "probe", true) {
        Ok(FfmpegRun::Finished { stderr, .. }) => stderr,
        _ => return None,
    };
    parse_video_params(&String::from_utf8_lossy(&finished))
}

fn parse_video_params(stderr: &str) -> Option<VideoParams> {
    let line = stderr.lines().find(|line| line.contains("Video:"))?;
    let rest = line.split_once("Video:")?.1.trim();
    let fields = split_top_level_commas(rest);
    let codec = leading_token(fields.first()?.trim());
    let pix_fmt = leading_token(fields.get(1)?.trim());
    if codec.is_empty() || pix_fmt.is_empty() {
        return None;
    }
    let (width, height) = find_wxh(rest)?;
    let fps_millis = find_fps_millis(rest)?;
    Some(VideoParams {
        codec: codec.to_string(),
        width,
        height,
        pix_fmt: pix_fmt.to_string(),
        fps_millis,
    })
}

fn split_top_level_commas(value: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                fields.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    fields.push(&value[start..]);
    fields
}

fn leading_token(value: &str) -> &str {
    let trimmed = value.trim();
    let end = trimmed
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .unwrap_or(trimmed.len());
    &trimmed[..end]
}

fn find_wxh(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if index < bytes.len() && bytes[index] == b'x' {
                let width: u32 = value[start..index].parse().ok()?;
                index += 1;
                let height_start = index;
                while index < bytes.len() && bytes[index].is_ascii_digit() {
                    index += 1;
                }
                if height_start < index {
                    let height: u32 = value[height_start..index].parse().ok()?;
                    if width > 0 && height > 0 {
                        return Some((width, height));
                    }
                }
            }
        } else {
            index += 1;
        }
    }
    None
}

fn find_fps_millis(value: &str) -> Option<u32> {
    let index = value.find(" fps")?;
    let before = value[..index].trim_end();
    let token = before
        .rsplit(|ch: char| ch.is_whitespace() || ch == ',')
        .next()?;
    let fps: f64 = token.parse().ok()?;
    if !fps.is_finite() || fps <= 0.0 {
        return None;
    }
    Some((fps * 1000.0).round() as u32)
}

fn validate_clip(ffmpeg: &Path, clip: &Path, timeout: Duration) -> Result<bool, DefectPackError> {
    let args = [
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-i"),
        clip.as_os_str().to_os_string(),
        OsString::from("-f"),
        OsString::from("null"),
        OsString::from("-"),
    ];
    match run_ffmpeg(ffmpeg, &args, timeout, "decode check", false)? {
        FfmpegRun::SpawnFailed => Ok(false),
        FfmpegRun::Finished { success, .. } => Ok(success),
    }
}

enum FfmpegRun {
    Finished { success: bool, stderr: Vec<u8> },
    SpawnFailed,
}

fn run_ffmpeg_concat_with_timeout(
    ffmpeg: &Path,
    list_path: &Path,
    output: &Path,
    stream_copy: bool,
    timeout: Duration,
) -> Result<bool, DefectPackError> {
    let mut args = vec![
        OsString::from("-y"),
        OsString::from("-f"),
        OsString::from("concat"),
        OsString::from("-safe"),
        OsString::from("0"),
        OsString::from("-i"),
        list_path.as_os_str().to_os_string(),
    ];
    if stream_copy {
        args.extend([OsString::from("-c"), OsString::from("copy")]);
    } else {
        args.extend([
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("veryfast"),
            OsString::from("-crf"),
            OsString::from("23"),
            OsString::from("-an"),
        ]);
    }
    args.push(output.as_os_str().to_os_string());
    let mode = if stream_copy {
        "stream copy"
    } else {
        "libx264 re-encode"
    };
    match run_ffmpeg(ffmpeg, &args, timeout, mode, false)? {
        FfmpegRun::SpawnFailed => Ok(false),
        FfmpegRun::Finished { success, .. } => Ok(success && output.exists()),
    }
}

fn run_ffmpeg(
    ffmpeg: &Path,
    args: &[OsString],
    timeout: Duration,
    mode: &str,
    keep_stderr_head: bool,
) -> Result<FfmpegRun, DefectPackError> {
    let mut command = build_hidden_command(ffmpeg);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(FfmpegRun::SpawnFailed),
    };
    let stderr_pipe = child.stderr.take();
    let stderr_handle = thread::spawn(move || read_stderr(stderr_pipe, keep_stderr_head));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr = join_stderr(stderr_handle);
                return Ok(FfmpegRun::Finished {
                    success: status.success(),
                    stderr,
                });
            }
            Ok(None) if started.elapsed() >= timeout => {
                return Err(finish_timed_out_ffmpeg(
                    &mut child,
                    stderr_handle,
                    timeout,
                    mode,
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_stderr(stderr_handle);
                return Ok(FfmpegRun::SpawnFailed);
            }
        }
    }
}

fn finish_timed_out_ffmpeg(
    child: &mut Child,
    stderr_handle: thread::JoinHandle<Vec<u8>>,
    timeout: Duration,
    mode: &str,
) -> DefectPackError {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    let grace_started = Instant::now();
    while grace_started.elapsed() < FFMPEG_QUIT_GRACE {
        match child.try_wait() {
            Ok(Some(_)) => {
                let tail = join_stderr(stderr_handle);
                return ffmpeg_timeout_error(timeout, mode, &tail);
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let tail = join_stderr(stderr_handle);
    ffmpeg_timeout_error(timeout, mode, &tail)
}

fn ffmpeg_timeout_error(timeout: Duration, mode: &str, tail: &[u8]) -> DefectPackError {
    let stderr = String::from_utf8_lossy(tail);
    DefectPackError::Ffmpeg(format!(
        "{mode} timed out after {} seconds\n{stderr}",
        timeout.as_secs()
    ))
}

fn read_stderr(pipe: Option<ChildStderr>, keep_head: bool) -> Vec<u8> {
    let Some(mut pipe) = pipe else {
        return Vec::new();
    };
    let limit = if keep_head {
        FFMPEG_STDERR_HEAD_BYTES
    } else {
        FFMPEG_STDERR_TAIL_BYTES
    };
    let mut stored = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if keep_head {
                    if stored.len() < limit {
                        let room = limit - stored.len();
                        stored.extend_from_slice(&buf[..n.min(room)]);
                    }
                } else {
                    stored.extend_from_slice(&buf[..n]);
                    if stored.len() > limit {
                        let extra = stored.len() - limit;
                        stored.drain(..extra);
                    }
                }
            }
        }
    }
    stored
}

fn join_stderr(handle: thread::JoinHandle<Vec<u8>>) -> Vec<u8> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(2) {
        if handle.is_finished() {
            return handle.join().unwrap_or_default();
        }
        thread::sleep(Duration::from_millis(10));
    }
    Vec::new()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DefectPackError> {
    let content = serde_json::to_vec_pretty(value)?;
    fs::write(path, content)?;
    Ok(())
}

fn file_entry(pack_dir: &Path, relative: &str) -> Result<DefectPackFileEntry, DefectPackError> {
    let path = pack_dir.join(relative);
    let relative_path = relative.replace('\\', "/");
    if !path.is_file() {
        return Ok(DefectPackFileEntry {
            relative_path,
            bytes: 0,
            sha256: String::new(),
        });
    }
    let bytes = fs::metadata(&path)?.len();
    let sha256 = crate::sha256::sha256_file_hex(&path)?;
    Ok(DefectPackFileEntry {
        relative_path,
        bytes,
        sha256,
    })
}

fn append_dir_entries(
    pack_dir: &Path,
    dir: PathBuf,
    prefix: &str,
    files: &mut Vec<DefectPackFileEntry>,
) -> Result<(), DefectPackError> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = format!("{prefix}/{name}");
        files.push(file_entry(pack_dir, &relative)?);
    }
    Ok(())
}

fn short_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn sanitize_file_stem(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
            _ => '_',
        })
        .take(64)
        .collect();
    if sanitized.is_empty() {
        "item".to_string()
    } else {
        sanitized
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[allow(dead_code)]
fn append_line(path: &Path, line: &str) -> Result<(), DefectPackError> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::models::{
        TestSessionVideoSegmentStatus, TEST_SESSION_SCHEMA_VERSION,
    };

    fn sample_step(started_at_ms: u64, title: &str) -> TestSessionStepRecord {
        TestSessionStepRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: "reqcase.test-session-step".to_string(),
            step_id: format!("step-{started_at_ms}"),
            session_id: "ts-1".to_string(),
            started_at_ms,
            ended_at_ms: started_at_ms + 10,
            relative_ms_from_session_start: started_at_ms.saturating_sub(1_000),
            step_type: "click".to_string(),
            title: title.to_string(),
            summary: title.to_string(),
            process_name: Some("ChatGPT.exe".to_string()),
            window_title: Some("ChatGPT".to_string()),
            control_name: None,
            control_type: None,
            automation_id: None,
            class_name: None,
            x: Some(100),
            y: Some(200),
            display_id: Some("display-1".to_string()),
            precision_level: "l1".to_string(),
            confidence: 0.55,
            source_event_ids: vec![format!("evt-{started_at_ms}")],
            artifact_refs: Vec::new(),
            full_image_path: None,
            thumb_image_path: None,
            edited: false,
            original_title: None,
            business_alias: None,
        }
    }

    #[test]
    fn clamp_defect_time_window_reanchors_late_mark_to_session_end() {
        let session_start = 1_000_u64;
        let session_end = 12_000_u64;
        let late_mark = 90_000_u64;
        let (effective, start, end) =
            clamp_defect_time_window(session_start, Some(session_end), late_mark, 60, 20);

        assert_eq!(effective, session_end);
        assert_eq!(start, session_start);
        assert!(end >= session_end);
        // Pre-window from re-anchored mark covers the short session fully.
        assert!(start <= session_start);
        assert!(end >= session_end);
    }

    #[test]
    fn legacy_operations_from_steps_are_honest_legacy_unknown() {
        let steps = vec![
            sample_step(2_000, "在窗口「ChatGPT」点击 (577,754)"),
            sample_step(3_000, "切换到窗口「ChatGPT」"),
        ];
        let operations = legacy_operations_from_steps("ts-1", &steps);
        assert_eq!(operations.len(), 2);
        assert!(operations.iter().all(|op| {
            op.outcome.status == OperationOutcomeStatus::LegacyUnknown
                && op.result_summary == LEGACY_OPERATION_RESULT_SUMMARY
                && op.display_summary.contains("旧记录未采集操作结果")
        }));
        assert_eq!(operations[0].action.kind, OperationActionKind::Click);
        assert_eq!(operations[1].action.kind, OperationActionKind::WindowSwitch);
    }

    #[test]
    fn ffmpeg_concat_timeout_reaps_spawned_child() {
        assert_eq!(FFMPEG_STREAM_COPY_TIMEOUT, Duration::from_secs(120));
        assert_eq!(FFMPEG_REENCODE_TIMEOUT, Duration::from_secs(600));
        assert_eq!(FFMPEG_QUIT_GRACE, Duration::from_secs(2));
        assert_eq!(FFMPEG_STDERR_TAIL_BYTES, 4096);

        let dir = std::env::temp_dir().join(format!(
            "s2-fake-ffmpeg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("sleeper.rs");
        fs::write(
            &source,
            r#"fn main() {
    let mut body = vec![b'A'; 8192];
    let marker = format!("\nTAIL-MARKER pid={}\n", std::process::id());
    body.extend_from_slice(marker.as_bytes());
    let _ = std::io::Write::write_all(&mut std::io::stderr(), &body);
    let _ = std::io::Write::flush(&mut std::io::stderr());
    std::thread::sleep(std::time::Duration::from_secs(30));
}
"#,
        )
        .unwrap();
        let exe = dir.join(if cfg!(windows) {
            "sleeper.exe"
        } else {
            "sleeper"
        });
        let compiled = std::process::Command::new("rustc")
            .arg("--edition")
            .arg("2021")
            .arg("-O")
            .arg(&source)
            .arg("-o")
            .arg(&exe)
            .status()
            .expect("rustc sleeper");
        assert!(compiled.success(), "rustc sleeper failed");

        let list = dir.join("list.txt");
        let output = dir.join("out.mp4");
        fs::write(&list, "file 'missing.mp4'\n").unwrap();
        let started = Instant::now();
        let err =
            run_ffmpeg_concat_with_timeout(&exe, &list, &output, true, Duration::from_secs(1))
                .expect_err("timeout must be an error");
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_secs(1),
            "returned before the timeout: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(8),
            "timeout did not stop the child: {elapsed:?}"
        );
        let message = err.to_string();
        assert!(message.contains("timed out"), "{message}");
        assert!(message.contains("TAIL-MARKER"), "{message}");
        assert!(
            message.matches('A').count() <= FFMPEG_STDERR_TAIL_BYTES,
            "{message}"
        );
        let pid = message
            .split("pid=")
            .nth(1)
            .and_then(|rest| rest.split(|ch: char| !ch.is_ascii_digit()).next())
            .and_then(|value| value.parse::<u32>().ok())
            .expect("pid in stderr tail");
        let _guard = ReapGuard(pid);
        assert!(
            !process_is_running(pid),
            "spawned sleeper {pid} is still running"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    struct ReapGuard(u32);

    impl Drop for ReapGuard {
        fn drop(&mut self) {
            if !process_is_running_once(self.0) {
                return;
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &self.0.to_string(), "/F"])
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill")
                    .arg(self.0.to_string())
                    .status();
            }
        }
    }

    fn process_is_running(pid: u32) -> bool {
        for _ in 0..5 {
            if !process_is_running_once(pid) {
                return false;
            }
            thread::sleep(Duration::from_millis(100));
        }
        true
    }

    fn process_is_running_once(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output();
            match output {
                Ok(output) => {
                    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
                }
                Err(_) => false,
            }
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
    }

    struct FfmpegOverrideGuard;

    impl FfmpegOverrideGuard {
        fn set(ffmpeg: PathBuf, limits: FfmpegLimits) -> Self {
            FFMPEG_OVERRIDE.with(|slot| *slot.borrow_mut() = Some(ffmpeg));
            FFMPEG_LIMITS_OVERRIDE.with(|slot| *slot.borrow_mut() = Some(limits));
            Self
        }
    }

    impl Drop for FfmpegOverrideGuard {
        fn drop(&mut self) {
            FFMPEG_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
            FFMPEG_LIMITS_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
        }
    }

    fn fast_limits() -> FfmpegLimits {
        FfmpegLimits {
            probe: Duration::from_secs(1),
            copy: Duration::from_secs(1),
            reencode: Duration::from_secs(1),
            validate: Duration::from_secs(1),
        }
    }

    fn compile_fake(dir: &Path, name: &str, source: &str) -> PathBuf {
        let source_path = dir.join(format!("{name}.rs"));
        fs::write(&source_path, source).unwrap();
        let exe = dir.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        });
        let compiled = std::process::Command::new("rustc")
            .arg("--edition")
            .arg("2021")
            .arg("-O")
            .arg(&source_path)
            .arg("-o")
            .arg(&exe)
            .status()
            .expect("rustc fake ffmpeg");
        assert!(compiled.success(), "rustc {name} failed");
        exe
    }

    fn reap_recorded_pids(exe: &Path) {
        let pid_path = exe.with_extension("pid");
        let Ok(text) = fs::read_to_string(pid_path) else {
            return;
        };
        for line in text.lines() {
            let Some(pid) = line.trim().parse::<u32>().ok() else {
                continue;
            };
            let _guard = ReapGuard(pid);
            assert!(!process_is_running(pid), "spawned fake {pid} is still running");
        }
    }

    fn sample_export_session(session_dir: &Path) -> TestSessionRecord {
        TestSessionRecord::from_start_options(
            "abcd1234".to_string(),
            1_000,
            crate::session::models::TestSessionStartOptions {
                target_capture_mode: Some("desktop".to_string()),
                ..crate::session::models::TestSessionStartOptions::default()
            },
            Some(session_dir.to_string_lossy().to_string()),
            None,
        )
    }

    fn sample_segment(path: &Path, started_at_ms: u64) -> TestSessionVideoSegmentRecord {
        TestSessionVideoSegmentRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: "reqcase.test-session-video-segment".to_string(),
            segment_id: format!("seg-{started_at_ms}"),
            session_id: "abcd1234".to_string(),
            stream_id: "stream-1".to_string(),
            status: TestSessionVideoSegmentStatus::Ready,
            display_id: None,
            started_at_ms,
            ended_at_ms: started_at_ms + 1_000,
            duration_ms: 1_000,
            relative_path: None,
            file_path: Some(path.to_string_lossy().to_string()),
            manifest_path: None,
            size_bytes: Some(4),
            frame_count: None,
            codec: None,
            container: Some("mp4".to_string()),
            mime_type: None,
            encoder_name: None,
            is_playable: true,
            retention_tier: None,
        }
    }

    fn export_request(target: &Path) -> DefectPackRequest {
        DefectPackRequest {
            target_dir: target.to_string_lossy().to_string(),
            marked_at_ms: 5_000,
            window_start_ms: 1_000,
            window_end_ms: 9_000,
            note: Some("s3".to_string()),
            expected: None,
            actual: None,
        }
    }

    fn write_two_segments(session_dir: &Path) -> Vec<TestSessionVideoSegmentRecord> {
        fs::create_dir_all(session_dir).unwrap();
        let first = session_dir.join("a.mp4");
        let second = session_dir.join("b.mp4");
        fs::write(&first, b"seg-a").unwrap();
        fs::write(&second, b"seg-b").unwrap();
        vec![
            sample_segment(&first, 1_500),
            sample_segment(&second, 2_500),
        ]
    }

    #[test]
    fn concat_list_escapes_backslash_before_quote() {
        assert_eq!(
            ffmpeg_concat_file_line(r"C:\a\O'B\x.mp4"),
            "file 'C:/a/O'\\''B/x.mp4'"
        );
    }

    #[test]
    fn parse_video_params_reads_codec_size_pix_fmt_and_fps() {
        let stderr = "Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1198x770 [SAR 1:1 DAR 599:385], 14 fps, 14 tbr\n";
        let params = parse_video_params(stderr).expect("video line");
        assert_eq!(params.codec, "h264");
        assert_eq!(params.pix_fmt, "yuv420p");
        assert_eq!((params.width, params.height), (1198, 770));
        assert_eq!(params.fps_millis, 14_000);

        let mpeg4 = "Stream #0:0: Video: mpeg4 (Simple Profile), yuv420p, 640x360, 25 fps, 25 tbr\n";
        let other = parse_video_params(mpeg4).expect("mpeg4");
        assert_eq!(other.codec, "mpeg4");
        assert_ne!(params.codec, other.codec);
    }

    #[test]
    fn old_manifest_without_sha256_still_deserializes() {
        let raw = r#"{"schemaVersion":1,"kind":"reqcase.defect-pack","sessionId":"old","createdAtMs":1,"files":[{"relativePath":"repro_steps.txt","bytes":3}]}"#;
        let manifest: DefectPackManifest = serde_json::from_str(raw).expect("old manifest");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].relative_path, "repro_steps.txt");
        assert_eq!(manifest.files[0].bytes, 3);
        assert_eq!(manifest.files[0].sha256, "");
    }

    #[test]
    fn reencode_failure_removes_clip_and_keeps_preexisting_target_file() {
        let root = std::env::temp_dir().join(format!(
            "s3-fail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        let target = root.join("target");
        let session_dir = root.join("session");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep-me").unwrap();
        let segments = write_two_segments(&session_dir);
        let fake = compile_fake(
            &root,
            "fail-ffmpeg",
            r#"fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let is_concat = args.windows(2).any(|pair| pair[0] == "-f" && pair[1] == "concat");
    if is_concat {
        if let Some(last) = args.last() {
            let _ = std::fs::write(last, b"partial-clip");
        }
    }
    std::process::exit(1);
}
"#,
        );
        let _guard = FfmpegOverrideGuard::set(fake, fast_limits());
        let result = export_defect_pack_with_operations(
            &sample_export_session(&session_dir),
            &[],
            &[],
            &segments,
            &export_request(&target),
        )
        .expect("soft ffmpeg failure still exports");
        assert!(!result.clip_built);
        assert!(result.clip_path.is_none());
        let pack = target.join("defect-abcd1234-5000");
        assert!(pack.is_dir(), "pack stays when re-encode fails softly");
        assert!(!pack.join("video").join("clip.mp4").exists());
        assert!(!pack.join("video").join("clip.concat.txt").exists());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep-me");
        let manifest: DefectPackManifest =
            serde_json::from_slice(&fs::read(pack.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert!(!manifest.files.is_empty());
        for entry in &manifest.files {
            assert!(!entry.sha256.is_empty(), "missing sha256 for {}", entry.relative_path);
            let hashed = crate::sha256::sha256_file_hex(&pack.join(&entry.relative_path)).unwrap();
            assert_eq!(entry.sha256, hashed, "{}", entry.relative_path);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn timeout_removes_new_pack_and_keeps_preexisting_target_file() {
        let root = std::env::temp_dir().join(format!(
            "s3-timeout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        let target = root.join("target");
        let session_dir = root.join("session");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep-me").unwrap();
        let segments = write_two_segments(&session_dir);
        let fake = compile_fake(
            &root,
            "sleep-ffmpeg",
            r#"fn main() {
    let exe = std::env::current_exe().unwrap();
    let mut pid_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exe.with_extension("pid"))
        .unwrap();
    let _ = std::io::Write::write_all(
        &mut pid_file,
        format!("{}\n", std::process::id()).as_bytes(),
    );
    let mut body = vec![b'A'; 8192];
    body.extend_from_slice(format!("\nTAIL-MARKER pid={}\n", std::process::id()).as_bytes());
    let _ = std::io::Write::write_all(&mut std::io::stderr(), &body);
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    if line.is_empty() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
"#,
        );
        let _guard = FfmpegOverrideGuard::set(fake.clone(), fast_limits());
        let err = export_defect_pack_with_operations(
            &sample_export_session(&session_dir),
            &[],
            &[],
            &segments,
            &export_request(&target),
        )
        .expect_err("timeout is an error");
        assert!(err.to_string().contains("timed out"), "{err}");
        let pack = target.join("defect-abcd1234-5000");
        assert!(!pack.exists(), "new pack directory must be removed");
        assert!(!target.join("clip.mp4").exists());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep-me");
        assert!(target.is_dir());
        reap_recorded_pids(&fake);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn timeout_keeps_preexisting_pack_file_and_removes_partial_clip() {
        let root = std::env::temp_dir().join(format!(
            "s3-existing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        let target = root.join("target");
        let session_dir = root.join("session");
        let pack = target.join("defect-abcd1234-5000");
        fs::create_dir_all(&pack).unwrap();
        fs::write(pack.join("already.txt"), b"already").unwrap();
        fs::write(target.join("keep.txt"), b"keep-me").unwrap();
        let segments = write_two_segments(&session_dir);
        let fake = compile_fake(
            &root,
            "sleep-ffmpeg",
            r#"fn main() {
    let exe = std::env::current_exe().unwrap();
    let mut pid_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exe.with_extension("pid"))
        .unwrap();
    let _ = std::io::Write::write_all(
        &mut pid_file,
        format!("{}\n", std::process::id()).as_bytes(),
    );
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    if line.is_empty() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
"#,
        );
        let _guard = FfmpegOverrideGuard::set(fake.clone(), fast_limits());
        let _err = export_defect_pack_with_operations(
            &sample_export_session(&session_dir),
            &[],
            &[],
            &segments,
            &export_request(&target),
        )
        .expect_err("timeout is an error");
        assert!(pack.is_dir(), "pre-existing pack directory stays");
        assert_eq!(fs::read(pack.join("already.txt")).unwrap(), b"already");
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep-me");
        assert!(!pack.join("video").join("clip.mp4").exists());
        assert!(!pack.join("video").join("clip.concat.txt").exists());
        reap_recorded_pids(&fake);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn validate_timeout_removes_new_pack() {
        let root = std::env::temp_dir().join(format!(
            "s3-validate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        let target = root.join("target");
        let session_dir = root.join("session");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep-me").unwrap();
        let segments = write_two_segments(&session_dir);
        let fake = compile_fake(
            &root,
            "validate-ffmpeg",
            r#"fn main() {
    let exe = std::env::current_exe().unwrap();
    let mut pid_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exe.with_extension("pid"))
        .unwrap();
    let _ = std::io::Write::write_all(
        &mut pid_file,
        format!("{}\n", std::process::id()).as_bytes(),
    );
    let args: Vec<String> = std::env::args().skip(1).collect();
    let is_validate = args.windows(2).any(|pair| pair[0] == "-f" && pair[1] == "null");
    let is_concat = args.windows(2).any(|pair| pair[0] == "-f" && pair[1] == "concat");
    if is_validate {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        if line.is_empty() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        return;
    }
    if is_concat {
        if let Some(last) = args.last() {
            let _ = std::fs::write(last, b"copied");
        }
        std::process::exit(0);
    }
    std::process::exit(1);
}
"#,
        );
        let _guard = FfmpegOverrideGuard::set(fake.clone(), fast_limits());
        let err = export_defect_pack_with_operations(
            &sample_export_session(&session_dir),
            &[],
            &[],
            &segments,
            &export_request(&target),
        )
        .expect_err("validate timeout is an error");
        assert!(err.to_string().contains("timed out"), "{err}");
        assert!(!target.join("defect-abcd1234-5000").exists());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep-me");
        reap_recorded_pids(&fake);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mismatched_segments_reencode_to_a_decodable_clip() {
        let Some(ffmpeg) = resolve_ffmpeg_executable() else {
            if std::env::var("S3_REQUIRE_FFMPEG").ok().as_deref() == Some("1") {
                panic!("S3_REQUIRE_FFMPEG=1 but ffmpeg was not found");
            }
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "s3-mismatch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let h264 = root.join("h264.mp4");
        let mpeg4 = root.join("mpeg4.mp4");
        let clip = root.join("clip.mp4");
        for (path, codec_args) in [
            (
                &h264,
                vec!["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"],
            ),
            (&mpeg4, vec!["-c:v", "mpeg4", "-q:v", "8", "-pix_fmt", "yuv420p"]),
        ] {
            let mut args = vec![
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=10",
                "-t",
                "0.4",
                "-an",
            ];
            args.extend(codec_args);
            args.push(path.to_str().unwrap());
            let status = std::process::Command::new(&ffmpeg)
                .args(&args)
                .status()
                .expect("spawn ffmpeg");
            assert!(status.success(), "encode {} failed", path.display());
        }
        let built = try_build_clip_mp4(&[h264.clone(), mpeg4.clone()], &clip)
            .expect("concat should not time out");
        assert!(built, "mismatched segments must re-encode into a clip");
        let decoded = std::process::Command::new(&ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&clip)
            .args(["-f", "null", "-"])
            .status()
            .expect("decode");
        assert!(decoded.success(), "clip did not decode completely");
        let probe = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-i"])
            .arg(&clip)
            .output()
            .expect("probe clip");
        let stderr = String::from_utf8_lossy(&probe.stderr);
        let params = parse_video_params(&stderr).expect("clip video line");
        assert_eq!(params.codec, "h264");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn low_disk_refuses_export_and_keeps_preexisting_file() {
        let root = std::env::temp_dir().join(format!(
            "s3-disk-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        let target = root.join("target");
        let session_dir = root.join("session");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep-me").unwrap();
        let segments = write_two_segments(&session_dir);
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                crate::disk_space::set_free_bytes_override_for_test(None);
            }
        }
        let _guard = Guard;
        crate::disk_space::set_free_bytes_override_for_test(Some(10));
        let err = export_defect_pack_with_operations(
            &sample_export_session(&session_dir),
            &[],
            &[],
            &segments,
            &export_request(&target),
        )
        .expect_err("low disk must refuse export");
        let message = err.to_string();
        assert!(message.contains("无法导出"), "{message}");
        assert!(!message.contains("defect pack failed"), "{message}");
        assert!(!target.join("defect-abcd1234-5000").exists());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep-me");
        let _ = fs::remove_dir_all(&root);
    }
}
