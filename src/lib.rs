mod capture_policy;
mod config;
mod context_reset;
mod dxgi;
mod error;
pub mod evidence_manifest;
mod hooks;
mod input;
mod metrics;
mod privacy;
mod quality_policy;
mod raw_input;
mod recorder;
mod retry;
mod session;
mod storage;
mod telemetry;
mod types;
mod wgc;

#[cfg(all(test, windows))]
mod live_semantic;

#[doc(hidden)]
pub mod operation_semantic_test_api {
    pub use crate::session::{
        OperationEvidenceRole, OperationOutcomeStatus, OperationReasonCode, PrivacyClass,
        SemanticEventRecord, SemanticEventType, TEST_SESSION_EVENT_KIND,
        TEST_SESSION_SCHEMA_VERSION, TEST_SESSION_SEMANTIC_EVENT_KIND, TestSessionEventRecord,
        TestSessionEventType, TestSessionOperationRecord, TestSessionStatus,
        build_operation_records_from_events,
    };
}

use napi::Result;
use napi_derive::napi;

use crate::config::{RecorderConfig, StreamPayloadMode};
use crate::error::RecorderError;
use crate::recorder::{RECORDER, create_step_tsfn_from_js};
use crate::session::{
    OperationOverrideChanges, SessionError, TEST_SESSION_MANAGER, TestSessionLogInput,
    TestSessionOperationEditInput,
};
use crate::types::{
    JsActiveTestSessionVideoConfig, JsRecorderConfig, JsRecorderMetrics, JsStepData,
    JsTestSessionDisplayTarget, JsTestSessionEventRecord, JsTestSessionEventTailResult,
    JsTestSessionLogInput, JsTestSessionNoteInput, JsTestSessionOperationRecord,
    JsTestSessionOperationTailResult, JsTestSessionOperationUpdateInput, JsTestSessionRecord,
    JsTestSessionStartOptions, JsTestSessionVideoSegmentRecord,
    JsTestSessionVideoSegmentTailResult, JsTestSessionVideoStreamRecord,
};

#[napi(object)]
pub struct JsSubscribeStepsV2Options {
    pub stream_payload: Option<String>,
}

const JS_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn parse_stream_payload_mode(input: Option<&str>) -> StreamPayloadMode {
    match input.unwrap_or("meta_only").to_ascii_lowercase().as_str() {
        "meta_plus_thumb" => StreamPayloadMode::MetaPlusThumb,
        "full" => StreamPayloadMode::Full,
        _ => StreamPayloadMode::MetaOnly,
    }
}

#[napi]
pub fn start_recording() -> Result<()> {
    RECORDER
        .start()
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn stop_recording() -> Result<()> {
    let result = RECORDER
        .stop()
        .map_err(|err| napi::Error::from_reason(err.to_string()));
    if result.is_ok() {
        sync_test_session_stop()?;
    }
    result
}

#[napi]
pub fn clear_buffer() -> Result<()> {
    RECORDER
        .clear_buffer()
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn get_buffer() -> Result<Vec<JsStepData>> {
    RECORDER
        .get_buffer()
        .map(|steps| steps.into_iter().map(Into::into).collect())
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn get_buffer_since(last_id: String) -> Result<Vec<JsStepData>> {
    let last_id: u64 = last_id.parse().unwrap_or(0);
    RECORDER
        .get_buffer_since(last_id)
        .map(|steps| steps.into_iter().map(Into::into).collect())
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn get_buffer_page(
    cursor: Option<String>,
    limit: Option<u32>,
    include_image: Option<bool>,
) -> Result<Vec<JsStepData>> {
    let cursor_id = cursor.as_deref().unwrap_or("0").parse::<u64>().unwrap_or(0);
    let take = usize::try_from(limit.unwrap_or(100)).unwrap_or(100).max(1);
    let include = include_image.unwrap_or(false);
    RECORDER
        .get_buffer_page(cursor_id, take, include)
        .map(|steps| steps.into_iter().map(Into::into).collect())
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn get_step_image(step_id: String, variant: Option<String>) -> Result<Option<String>> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    let step_id = step_id.parse::<u64>().unwrap_or(0);
    let variant = variant.unwrap_or_else(|| "full".to_string());
    RECORDER
        .get_step_image(step_id, &variant)
        .map(|bytes| bytes.map(|data| STANDARD.encode(data)))
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn set_config(config: JsRecorderConfig) -> Result<()> {
    let config: RecorderConfig = config.into();
    RECORDER
        .set_config(config)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn get_metrics() -> Result<JsRecorderMetrics> {
    RECORDER
        .get_metrics()
        .map(Into::into)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn subscribe_steps(callback: napi::JsFunction) -> Result<()> {
    let tsfn = create_step_tsfn_from_js(callback)?;
    RECORDER
        .subscribe_steps(tsfn)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn subscribe_steps_v2(
    options: Option<JsSubscribeStepsV2Options>,
    callback: napi::JsFunction,
) -> Result<()> {
    let tsfn = create_step_tsfn_from_js(callback)?;
    let stream_payload = parse_stream_payload_mode(
        options
            .as_ref()
            .and_then(|input| input.stream_payload.as_deref()),
    );
    RECORDER
        .subscribe_steps_v2(tsfn, stream_payload)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn unsubscribe_steps() -> Result<()> {
    RECORDER
        .clear_subscriptions()
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi]
pub fn pause_recording() -> Result<()> {
    RECORDER
        .pause()
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    sync_test_session_pause()?;
    Ok(())
}

#[napi]
pub fn resume_recording() -> Result<()> {
    RECORDER
        .resume()
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    sync_test_session_resume()?;
    Ok(())
}

#[napi]
pub fn is_recording_paused() -> bool {
    RECORDER.is_paused()
}

#[napi]
pub fn subscribe_steps_for_host(callback: napi::JsFunction) -> Result<()> {
    subscribe_steps(callback)
}

#[napi]
pub fn start_test_session(
    options: Option<JsTestSessionStartOptions>,
) -> Result<JsTestSessionRecord> {
    let session = TEST_SESSION_MANAGER
        .start(options.unwrap_or_default().into())
        .map_err(map_session_error)?;

    if let Err(err) = RECORDER.start() {
        let _ = TEST_SESSION_MANAGER.append_app_log(TestSessionLogInput {
            level: Some("warn".to_string()),
            source: Some("legacy-recorder".to_string()),
            message: Some(format!(
                "legacy step recorder is unavailable; continuing with video and event capture only: {err}"
            )),
        });
    }

    Ok(session.into())
}

#[napi]
pub fn stop_test_session() -> Result<JsTestSessionRecord> {
    let recorder_result = RECORDER.stop();
    let session = TEST_SESSION_MANAGER.stop().map_err(map_session_error)?;

    match recorder_result {
        Ok(()) | Err(RecorderError::NotRunning) => Ok(session.into()),
        Err(err) => Err(napi::Error::from_reason(format!(
            "test session stopped, but recorder stop failed: {err}"
        ))),
    }
}

#[napi]
pub fn pause_test_session() -> Result<JsTestSessionRecord> {
    let recorder_result = RECORDER.pause();
    let session = TEST_SESSION_MANAGER.pause().map_err(map_session_error)?;

    if let Err(err) = recorder_result
        && !matches!(err, RecorderError::NotRunning)
    {
        let _ = TEST_SESSION_MANAGER.append_app_log(TestSessionLogInput {
            level: Some("warn".to_string()),
            source: Some("legacy-recorder".to_string()),
            message: Some(format!(
                "legacy step recorder pause failed; session pause continued: {err}"
            )),
        });
    }

    Ok(session.into())
}

#[napi]
pub fn resume_test_session() -> Result<JsTestSessionRecord> {
    let recorder_result = RECORDER.resume();
    let session = TEST_SESSION_MANAGER.resume().map_err(map_session_error)?;

    if let Err(err) = recorder_result
        && !matches!(err, RecorderError::NotRunning)
    {
        let _ = TEST_SESSION_MANAGER.append_app_log(TestSessionLogInput {
            level: Some("warn".to_string()),
            source: Some("legacy-recorder".to_string()),
            message: Some(format!(
                "legacy step recorder resume failed; session resume continued: {err}"
            )),
        });
    }

    Ok(session.into())
}

#[napi]
pub fn get_active_test_session() -> Result<Option<JsTestSessionRecord>> {
    TEST_SESSION_MANAGER
        .get_active()
        .map(|session| session.map(Into::into))
        .map_err(map_session_error)
}

#[napi]
pub fn update_active_test_session_video_config(
    config: Option<JsActiveTestSessionVideoConfig>,
) -> Result<Option<JsTestSessionRecord>> {
    let config = config.unwrap_or_default();
    TEST_SESSION_MANAGER
        .update_active_video_config(
            config.recording_profile,
            config.encoder_preference,
            config.show_mouse_in_video,
        )
        .map(|session| session.map(Into::into))
        .map_err(map_session_error)
}

#[napi]
pub fn list_test_sessions() -> Result<Vec<JsTestSessionRecord>> {
    TEST_SESSION_MANAGER
        .list()
        .map(|sessions| sessions.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn list_test_session_display_targets() -> Result<Vec<JsTestSessionDisplayTarget>> {
    Ok(TEST_SESSION_MANAGER
        .list_display_targets()
        .into_iter()
        .map(Into::into)
        .collect())
}

#[napi]
pub fn get_test_session_events(
    session_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<JsTestSessionEventRecord>> {
    TEST_SESSION_MANAGER
        .get_events(
            session_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|events| events.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_events_tail(
    session_id: Option<String>,
    after_event_id: Option<String>,
    limit: Option<u32>,
) -> Result<JsTestSessionEventTailResult> {
    TEST_SESSION_MANAGER
        .get_events_tail(
            session_id.as_deref(),
            after_event_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|tail| JsTestSessionEventTailResult {
            items: tail.items.into_iter().map(Into::into).collect(),
            next_cursor: tail.next_cursor,
            reset: tail.reset,
            total_count: u32::try_from(tail.total_count).unwrap_or(u32::MAX),
        })
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_video_streams(
    session_id: Option<String>,
) -> Result<Vec<JsTestSessionVideoStreamRecord>> {
    TEST_SESSION_MANAGER
        .get_video_streams(session_id.as_deref())
        .map(|streams| streams.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_video_segments(
    session_id: Option<String>,
    stream_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<JsTestSessionVideoSegmentRecord>> {
    TEST_SESSION_MANAGER
        .get_video_segments(
            session_id.as_deref(),
            stream_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|segments| segments.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_video_segments_tail(
    session_id: Option<String>,
    stream_id: Option<String>,
    after_segment_id: Option<String>,
    limit: Option<u32>,
) -> Result<JsTestSessionVideoSegmentTailResult> {
    TEST_SESSION_MANAGER
        .get_video_segments_tail(
            session_id.as_deref(),
            stream_id.as_deref(),
            after_segment_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|tail| JsTestSessionVideoSegmentTailResult {
            items: tail.items.into_iter().map(Into::into).collect(),
            next_cursor: tail.next_cursor,
            reset: tail.reset,
            total_count: u32::try_from(tail.total_count).unwrap_or(u32::MAX),
        })
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_video_segments_for_timestamp(
    session_id: Option<String>,
    occurred_at_ms: f64,
    display_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<JsTestSessionVideoSegmentRecord>> {
    let occurred_at_ms = parse_js_timestamp(occurred_at_ms, "occurredAtMs")?;
    TEST_SESSION_MANAGER
        .get_video_segments_for_timestamp(
            session_id.as_deref(),
            occurred_at_ms,
            display_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|segments| segments.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn append_test_session_note(
    input: Option<JsTestSessionNoteInput>,
) -> Result<JsTestSessionEventRecord> {
    TEST_SESSION_MANAGER
        .append_note(input.unwrap_or_default().into())
        .map(Into::into)
        .map_err(map_session_error)
}

#[napi]
pub fn append_test_session_log(
    input: Option<JsTestSessionLogInput>,
) -> Result<Option<JsTestSessionEventRecord>> {
    TEST_SESSION_MANAGER
        .append_app_log(input.unwrap_or_default().into())
        .map(|event| event.map(Into::into))
        .map_err(map_session_error)
}

#[napi]
pub fn mark_test_defect(
    input: Option<crate::types::JsTestSessionDefectMarkInput>,
) -> Result<crate::types::JsTestSessionDefectMarkRecord> {
    let input = input.unwrap_or_default();
    let marked_at_ms = parse_optional_js_timestamp(input.marked_at_ms, "markedAtMs")?;
    TEST_SESSION_MANAGER
        .mark_defect(crate::session::TestSessionDefectMarkInput {
            session_id: input.session_id,
            note: input.note,
            expected: input.expected,
            actual: input.actual,
            marked_at_ms,
            pre_window_seconds: input.pre_window_seconds,
            post_window_seconds: input.post_window_seconds,
        })
        .map(Into::into)
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_steps(
    session_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<crate::types::JsTestSessionStepRecord>> {
    TEST_SESSION_MANAGER
        .get_steps(
            session_id.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|steps| steps.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn rebuild_test_session_steps(
    session_id: Option<String>,
) -> Result<Vec<crate::types::JsTestSessionStepRecord>> {
    TEST_SESSION_MANAGER
        .rebuild_steps(session_id.as_deref())
        .map(|steps| steps.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn get_test_session_operations(
    session_id: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<JsTestSessionOperationTailResult> {
    TEST_SESSION_MANAGER
        .get_operations_tail(
            session_id.as_deref(),
            cursor.as_deref(),
            limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX)),
        )
        .map(|tail| JsTestSessionOperationTailResult {
            items: tail.items.into_iter().map(Into::into).collect(),
            next_cursor: tail.next_cursor,
            reset: tail.reset,
            total_count: u32::try_from(tail.total_count).unwrap_or(u32::MAX),
            diagnostics: tail.diagnostics.into_iter().map(Into::into).collect(),
        })
        .map_err(map_session_error)
}

#[napi]
pub fn rebuild_test_session_operations(
    session_id: Option<String>,
) -> Result<Vec<JsTestSessionOperationRecord>> {
    TEST_SESSION_MANAGER
        .rebuild_operations(session_id.as_deref())
        .map(|operations| operations.into_iter().map(Into::into).collect())
        .map_err(map_session_error)
}

#[napi]
pub fn update_test_session_operation(
    input: Option<JsTestSessionOperationUpdateInput>,
) -> Result<JsTestSessionOperationRecord> {
    let input = input.unwrap_or_default();
    let occurred_at_ms = parse_optional_js_timestamp(input.occurred_at_ms, "occurredAtMs")?;
    TEST_SESSION_MANAGER
        .update_operation(TestSessionOperationEditInput {
            session_id: input.session_id,
            operation_id: input.operation_id.unwrap_or_default(),
            occurred_at_ms,
            changes: OperationOverrideChanges {
                title: input.title,
                result_summary: input.result_summary,
                selected_outcome_status: input
                    .selected_outcome_status
                    .map(crate::session::OperationOutcomeStatus::from_wire),
                selected_transition_id: input.selected_transition_id,
                ignored: input.ignored,
                business_alias: input.business_alias,
                note: input.note,
            },
            reason: input.reason,
        })
        .map(Into::into)
        .map_err(map_session_error)
}

#[napi]
pub fn render_test_session_repro_steps(
    session_id: Option<String>,
    window_start_ms: Option<f64>,
    window_end_ms: Option<f64>,
    defect_note: Option<String>,
) -> Result<String> {
    let window_start_ms = parse_optional_js_timestamp(window_start_ms, "windowStartMs")?;
    let window_end_ms = parse_optional_js_timestamp(window_end_ms, "windowEndMs")?;
    TEST_SESSION_MANAGER
        .render_repro_steps(
            session_id.as_deref(),
            window_start_ms,
            window_end_ms,
            defect_note,
        )
        .map_err(map_session_error)
}

#[napi]
pub fn export_test_defect_pack(
    input: Option<crate::types::JsTestSessionDefectPackExportInput>,
) -> Result<crate::types::JsTestSessionDefectPackResult> {
    let input = input.unwrap_or_default();
    let target_dir = input
        .target_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| napi::Error::from_reason("targetDir is required for defect pack export"))?;
    TEST_SESSION_MANAGER
        .export_defect_pack(
            input.session_id.as_deref(),
            target_dir,
            parse_optional_js_timestamp(input.marked_at_ms, "markedAtMs")?,
            input.pre_window_seconds,
            input.post_window_seconds,
            input.note,
            input.expected,
            input.actual,
        )
        .map(Into::into)
        .map_err(map_session_error)
}

#[napi]
pub fn update_test_session_step(
    input: Option<crate::types::JsTestSessionStepEditInput>,
) -> Result<crate::types::JsTestSessionStepRecord> {
    TEST_SESSION_MANAGER
        .update_step(input.unwrap_or_default().into())
        .map(Into::into)
        .map_err(map_session_error)
}

#[napi]
pub fn set_semantic_alias_profile(
    profile: Option<crate::types::JsSemanticAliasProfile>,
) -> Result<()> {
    TEST_SESSION_MANAGER
        .set_semantic_alias_profile(profile.map(Into::into))
        .map_err(map_session_error)
}

#[napi]
pub fn get_semantic_alias_profile() -> Result<Option<crate::types::JsSemanticAliasProfile>> {
    Ok(TEST_SESSION_MANAGER
        .get_semantic_alias_profile()
        .map(Into::into))
}

/// Load a Semantic Profile JSON (shadowrecord v1 or qttimer snapshot) and activate it.
#[napi]
pub fn load_semantic_profile(path: String) -> Result<String> {
    let profile = TEST_SESSION_MANAGER
        .load_semantic_profile_file(path)
        .map_err(map_session_error)?;
    serde_json::to_string(&profile).map_err(|err| {
        napi::Error::from_reason(format!("failed to serialize semantic profile: {err}"))
    })
}

#[napi]
pub fn get_semantic_profile_json() -> Result<Option<String>> {
    let Some(profile) = TEST_SESSION_MANAGER.get_semantic_profile() else {
        return Ok(None);
    };
    serde_json::to_string(&profile).map(Some).map_err(|err| {
        napi::Error::from_reason(format!("failed to serialize semantic profile: {err}"))
    })
}

#[napi]
pub fn clear_semantic_profile() -> Result<()> {
    TEST_SESSION_MANAGER
        .set_semantic_profile(None)
        .map_err(map_session_error)
}

/// Activate a Semantic Profile from JSON content (profile object or qttimer elements_selected array).
#[napi]
pub fn set_semantic_profile_json(content: String) -> Result<String> {
    let profile = TEST_SESSION_MANAGER
        .load_semantic_profile_json(content)
        .map_err(map_session_error)?;
    serde_json::to_string(&profile).map_err(|err| {
        napi::Error::from_reason(format!("failed to serialize semantic profile: {err}"))
    })
}

fn sync_test_session_pause() -> Result<()> {
    TEST_SESSION_MANAGER
        .sync_pause_if_active()
        .map(|_| ())
        .map_err(map_session_error)
}

fn sync_test_session_resume() -> Result<()> {
    TEST_SESSION_MANAGER
        .sync_resume_if_active()
        .map(|_| ())
        .map_err(map_session_error)
}

fn sync_test_session_stop() -> Result<()> {
    TEST_SESSION_MANAGER
        .sync_stop_if_active()
        .map(|_| ())
        .map_err(map_session_error)
}

fn parse_optional_js_timestamp(value: Option<f64>, field_name: &str) -> Result<Option<u64>> {
    value
        .map(|timestamp| parse_js_timestamp(timestamp, field_name))
        .transpose()
}

fn parse_js_timestamp(value: f64, field_name: &str) -> Result<u64> {
    if !value.is_finite() {
        return Err(napi::Error::from_reason(format!(
            "{field_name} must be a finite timestamp"
        )));
    }
    if value < 0.0 {
        return Err(napi::Error::from_reason(format!(
            "{field_name} must be non-negative"
        )));
    }
    if value > JS_MAX_SAFE_INTEGER {
        return Err(napi::Error::from_reason(format!(
            "{field_name} exceeds JavaScript safe integer range"
        )));
    }
    Ok(value.trunc() as u64)
}

fn map_session_error(err: SessionError) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}
