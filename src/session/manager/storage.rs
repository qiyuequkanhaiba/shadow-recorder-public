//! Session storage on disk: manifests, events, steps, operations and video records.

use super::*;

pub(super) fn prepare_session_storage(
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

pub(super) fn persist_manifest(record: &TestSessionRecord) -> Result<(), SessionError> {
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

pub(super) fn append_event_to_storage(
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

pub(super) fn persist_steps_to_storage(
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

pub(super) fn persist_step_artifacts(
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

pub(super) fn push_event(
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

pub(super) fn resolve_session_record(
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

pub(super) fn build_tail_query_result<T, F>(
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

pub(super) fn events_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("events.ndjson")),
    )
}

pub(super) fn video_streams_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("video").join("streams.json")),
    )
}

pub(super) fn video_segments_storage_fingerprint(
    record: &TestSessionRecord,
) -> Result<Option<StorageFingerprint>, SessionError> {
    storage_fingerprint_for_path(
        record
            .session_dir
            .as_deref()
            .map(|session_dir| Path::new(session_dir).join("video").join("segments.ndjson")),
    )
}

pub(super) fn storage_fingerprint_for_path(
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

pub(super) fn load_events_from_storage(
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
pub(super) fn load_semantic_events_from_storage(
    record: &TestSessionRecord,
) -> Result<Vec<SemanticEventRecord>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(Vec::new());
    };

    let report = SemanticEventStore::for_session_dir(session_dir).read()?;
    Ok(report.events)
}

pub(super) fn load_operation_overrides_from_storage(
    record: &TestSessionRecord,
) -> Result<Vec<crate::session::OperationOverrideRecord>, SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(Vec::new());
    };

    Ok(OperationOverrideStore::for_session_dir(session_dir)
        .read()?
        .overrides)
}

pub(super) fn load_operations_from_storage(
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

pub(super) fn persist_operations_to_storage(
    record: &TestSessionRecord,
    operations: &[TestSessionOperationRecord],
) -> Result<(), SessionError> {
    let Some(session_dir) = record.session_dir.as_deref() else {
        return Ok(());
    };

    OperationStore::for_session_dir(session_dir).persist_atomic(operations)?;
    Ok(())
}

pub(super) fn has_operation_override_changes(changes: &OperationOverrideChanges) -> bool {
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

pub(super) fn resolve_operation_id_alias(
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

pub(super) fn resolve_step_index_alias(
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

pub(super) fn find_compatible_previous_step_edit<'a>(
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

pub(super) fn apply_previous_step_edit(
    step: &mut TestSessionStepRecord,
    edited: &TestSessionStepRecord,
) {
    let auto_title = step.title.clone();
    step.title = edited.title.clone();
    step.summary = edited.summary.clone();
    step.edited = true;
    step.original_title = edited.original_title.clone().or(Some(auto_title));
    step.business_alias = edited.business_alias.clone();
}

pub(super) fn step_source_events_overlap(
    left: &TestSessionStepRecord,
    right: &TestSessionStepRecord,
) -> bool {
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

pub(super) fn projected_step_id_for_operation(operation_id: &str) -> String {
    format!("step-{operation_id}")
}

pub(super) fn legacy_step_ordinal(session_id: &str, step_id: &str) -> Option<usize> {
    let prefix = format!("step-{session_id}-");
    let suffix = step_id.strip_prefix(&prefix)?;
    let ordinal = suffix.parse::<usize>().ok()?;
    (ordinal > 0).then_some(ordinal)
}

pub(super) fn bootstrap_video_streams(
    record: &TestSessionRecord,
) -> Vec<TestSessionVideoStreamRecord> {
    let displays = enumerate_display_targets();
    build_video_stream_plan(record, &displays)
}

pub(super) fn persist_video_streams(
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

pub(super) fn load_video_streams_from_storage(
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

pub(super) fn load_video_segments_from_storage(
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

pub(super) fn should_recover_video_segments(
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

pub(super) fn apply_event_limit<T>(events: &mut Vec<T>, limit: Option<usize>) {
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

pub(super) fn rank_video_segments_for_timestamp(
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

pub(super) fn segment_time_distance_ms(
    segment: &TestSessionVideoSegmentRecord,
    occurred_at_ms: u64,
) -> u64 {
    if occurred_at_ms < segment.started_at_ms {
        segment.started_at_ms.saturating_sub(occurred_at_ms)
    } else if occurred_at_ms > segment.ended_at_ms {
        occurred_at_ms.saturating_sub(segment.ended_at_ms)
    } else {
        0
    }
}

pub(super) fn display_match_rank(
    requested_display_id: Option<&str>,
    segment_display_id: Option<&str>,
) -> u8 {
    match (requested_display_id, segment_display_id) {
        (Some(requested), Some(candidate)) if requested == candidate => 0,
        (Some(_), Some(_)) => 1,
        (Some(_), None) => 2,
        (None, _) => 0,
    }
}

pub(super) fn push_history(history: &mut Vec<TestSessionRecord>, record: TestSessionRecord) {
    history.push(record);
    if history.len() > HISTORY_LIMIT {
        let overflow = history.len().saturating_sub(HISTORY_LIMIT);
        history.drain(0..overflow);
    }
}
