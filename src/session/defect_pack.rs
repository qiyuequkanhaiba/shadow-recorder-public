//! Defect evidence pack export (time-window video + steps + screenshots + repro text).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

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
    #[allow(dead_code)]
    Ffmpeg(String),
}

impl std::fmt::Display for DefectPackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "defect pack io failed: {err}"),
            Self::Serialize(err) => write!(f, "defect pack serialize failed: {err}"),
            Self::MissingSessionDir => write!(f, "session directory is unavailable"),
            Self::Ffmpeg(message) => write!(f, "defect pack ffmpeg failed: {message}"),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefectPackManifest {
    schema_version: u32,
    kind: String,
    session_id: String,
    created_at_ms: u64,
    files: Vec<DefectPackFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefectPackFileEntry {
    relative_path: String,
    bytes: u64,
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

    let window_segments = segments
        .iter()
        .filter(|segment| {
            segment.ended_at_ms >= request.window_start_ms
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

    let mut video_segment_count = 0u32;
    let mut segment_index_lines = Vec::new();
    for (index, segment) in window_segments.iter().enumerate() {
        let source = segment.file_path.as_deref().map(PathBuf::from).or_else(|| {
            segment
                .relative_path
                .as_ref()
                .map(|relative| session_dir.join(relative))
        });
        let Some(source_path) = source else {
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
    let clip_built = try_build_clip_mp4(&segment_files, &clip_path);
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

/// Best-effort concat into a single playable clip.mp4.
/// Strategy: copy-concat first; on failure, re-encode with libx264.
fn try_build_clip_mp4(segment_files: &[PathBuf], output: &Path) -> bool {
    if segment_files.is_empty() {
        return false;
    }
    let Some(ffmpeg) = resolve_ffmpeg_executable() else {
        return false;
    };

    if segment_files.len() == 1 {
        return fs::copy(&segment_files[0], output).is_ok() && output.exists();
    }

    let list_path = output.with_extension("concat.txt");
    let mut list_body = String::new();
    for file in segment_files {
        let escaped = file
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list_body.push_str(&format!("file '{escaped}'\n"));
    }
    if fs::write(&list_path, list_body).is_err() {
        return false;
    }

    // Prefer stream copy for speed/quality.
    let copy_ok = run_ffmpeg_concat(&ffmpeg, &list_path, output, true);
    if copy_ok {
        let _ = fs::remove_file(&list_path);
        return true;
    }
    let _ = fs::remove_file(output);
    let reencode_ok = run_ffmpeg_concat(&ffmpeg, &list_path, output, false);
    let _ = fs::remove_file(&list_path);
    reencode_ok
}

fn run_ffmpeg_concat(ffmpeg: &Path, list_path: &Path, output: &Path, stream_copy: bool) -> bool {
    let mut command = build_hidden_command(ffmpeg);
    command
        .arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(list_path);
    if stream_copy {
        command.args(["-c", "copy"]);
    } else {
        command.args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an",
        ]);
    }
    command
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command
        .status()
        .map(|status| status.success() && output.exists())
        .unwrap_or(false)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DefectPackError> {
    let content = serde_json::to_vec_pretty(value)?;
    fs::write(path, content)?;
    Ok(())
}

fn file_entry(pack_dir: &Path, relative: &str) -> Result<DefectPackFileEntry, DefectPackError> {
    let path = pack_dir.join(relative);
    let bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(DefectPackFileEntry {
        relative_path: relative.replace('\\', "/"),
        bytes,
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
        let bytes = entry.metadata()?.len();
        let _ = pack_dir;
        files.push(DefectPackFileEntry {
            relative_path: relative,
            bytes,
        });
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
    use crate::session::models::TEST_SESSION_SCHEMA_VERSION;

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
}
