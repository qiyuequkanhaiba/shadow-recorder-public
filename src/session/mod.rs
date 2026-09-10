#[allow(dead_code)]
mod action_correlator;
mod defect_config;
mod defect_pack;
mod ffmpeg_loop_runtime;
mod keyboard_summary;
mod manager;
mod models;
#[allow(dead_code)]
mod operation_builder;
#[allow(dead_code)]
mod operation_evidence;
#[allow(dead_code)]
mod operation_models;
#[allow(dead_code)]
mod operation_override;
#[allow(dead_code)]
mod operation_store;
#[allow(dead_code)]
mod operation_summary;
#[allow(dead_code)]
mod outcome_correlator;
mod semantic_alias;
mod semantic_event;
mod semantic_event_store;
mod semantic_privacy;
mod semantic_profile;
#[allow(dead_code)]
mod state_transition;
mod step_builder;
mod system_events;
pub(crate) mod uia_enricher;
mod uia_observer;
mod uia_state_cache;
mod video_encoder;
mod video_ring;

pub use defect_config::{
    defect_post_window_seconds, defect_pre_window_seconds, is_defect_evidence_enabled,
    set_defect_evidence_enabled, set_defect_windows, set_semantic_feature_flags,
};
pub use defect_pack::DefectPackResult;
pub use manager::{SessionError, TEST_SESSION_MANAGER};
pub use models::{
    TEST_SESSION_EVENT_KIND, TEST_SESSION_SCHEMA_VERSION, TestSessionDefectMarkInput,
    TestSessionDefectMarkRecord, TestSessionEventRecord, TestSessionEventType, TestSessionLogInput,
    TestSessionNoteInput, TestSessionRecord, TestSessionStartOptions, TestSessionStatus,
    TestSessionStepEditInput, TestSessionStepRecord, TestSessionSystemEventInput,
    TestSessionVideoSegmentRecord, TestSessionVideoStreamRecord,
};
#[cfg(test)]
pub use models::{TestSessionVideoSegmentStatus, TestSessionVideoStreamStatus};
#[allow(unused_imports)]
pub use operation_builder::{
    build_actions_from_events, build_operation_records_from_events,
    rebuild_operation_records_with_overrides,
};
#[allow(unused_imports)]
pub use operation_evidence::build_operation_evidence;
#[allow(unused_imports)]
pub use operation_models::{
    ExpandCollapseState, ObserverHealthPayload, ObserverHealthState, OperationAction,
    OperationActionConfidence, OperationActionKind, OperationCoordinate, OperationEvidence,
    OperationEvidenceKind, OperationEvidenceRole, OperationOutcome, OperationOutcomeConfidence,
    OperationOutcomeSelectionSource, OperationOutcomeStatus, OperationOverrideChanges,
    OperationOverrideRecord, OperationOverrideSource, OperationReasonCode, OperationVideoRange,
    PrivacyClass, SelectionState, SemanticEventRecord, SemanticEventType, StateTransition,
    StateTransitionConfidence, StateTransitionKind, TEST_SESSION_OPERATION_KIND,
    TEST_SESSION_OPERATION_OVERRIDE_KIND, TEST_SESSION_SEMANTIC_EVENT_KIND,
    TestSessionOperationEditInput, TestSessionOperationRecord, ToggleState, UiBoundingRect,
    UiElementIdentity, UiElementPathEntry, UiStateSnapshot, UiStateSnapshotSource,
};
#[allow(unused_imports)]
pub use operation_override::{
    OPERATION_OVERRIDES_FILE_NAME, OperationOverrideApplyReport, OperationOverrideError,
    OperationOverrideOrphanReason, OperationOverrideReadReport, OperationOverrideStore,
    OrphanOperationOverride, apply_operation_overrides,
};
#[allow(unused_imports)]
pub use operation_store::{OPERATIONS_FILE_NAME, OperationStore, OperationStoreError};
#[allow(unused_imports)]
pub use operation_store::{OperationStoreDiagnostic, OperationStoreReadReport};
#[allow(unused_imports)]
pub use operation_summary::{
    OperationSummaryParts, summarize_action, summarize_operation, summarize_outcome,
};
#[allow(unused_imports)]
pub use outcome_correlator::{
    DEFAULT_OUTCOME_WINDOW_MS, OutcomeCorrelationOptions, correlate_outcome_for_action,
    correlate_outcomes_for_actions,
};
pub use semantic_alias::{SemanticAliasProfile, SemanticAliasRule};
#[allow(unused_imports)]
pub use semantic_event::{SEMANTIC_EVENT_SCHEMA_VERSION, SEMANTIC_EVENTS_FILE_NAME};
#[allow(unused_imports)]
pub use semantic_event_store::{
    SemanticEventBatchWriter, SemanticEventReadReport, SemanticEventStore, SemanticEventStoreError,
};
pub use semantic_privacy::set_semantic_privacy_policy;
#[allow(unused_imports)]
pub use semantic_profile::{
    SEMANTIC_PROFILE_FILE_NAME, SEMANTIC_PROFILE_SNAPSHOT_FILE_NAME, SemanticProfile,
    SemanticProfileAliasRule, SemanticProfileSnapshot, SemanticScenarioRule,
    active_semantic_profile, apply_profile_to_operations, load_semantic_profile_for_session,
    load_semantic_profile_from_path, parse_semantic_profile_json, preferred_target_process_name,
    set_active_semantic_profile,
};
#[allow(unused_imports)]
pub use state_transition::{
    build_state_transition_from_event, build_state_transitions_from_events,
};
#[allow(unused_imports)]
pub use uia_observer::{UiaObserverError, UiaObserverRuntime, UiaObserverStopReport};
#[allow(unused_imports)]
pub use uia_state_cache::{UiaStateCache, UiaStateCacheUpdate};
pub use video_ring::TestSessionDisplayTarget;
