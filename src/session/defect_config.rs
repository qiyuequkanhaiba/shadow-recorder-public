//! Runtime switch for optional defect-evidence capture (UIA / keyboard summary / step build).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static DEFECT_EVIDENCE_ENABLED: AtomicBool = AtomicBool::new(false);
static SEMANTIC_RECORDING_ENABLED: AtomicBool = AtomicBool::new(false);
static UIA_OBSERVER_ENABLED: AtomicBool = AtomicBool::new(false);
static OPERATION_BUILDER_ENABLED: AtomicBool = AtomicBool::new(false);
static OPERATION_REVIEW_V2_ENABLED: AtomicBool = AtomicBool::new(false);
static SEMANTIC_PLAINTEXT_INPUT_ENABLED: AtomicBool = AtomicBool::new(false);
static DEFECT_PRE_WINDOW_SECONDS: AtomicU32 = AtomicU32::new(60);
static DEFECT_POST_WINDOW_SECONDS: AtomicU32 = AtomicU32::new(20);

pub fn set_defect_evidence_enabled(enabled: bool) {
    DEFECT_EVIDENCE_ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn is_defect_evidence_enabled() -> bool {
    DEFECT_EVIDENCE_ENABLED.load(Ordering::SeqCst)
}

pub fn set_semantic_feature_flags(
    semantic_recording_enabled: bool,
    uia_observer_enabled: bool,
    operation_builder_enabled: bool,
    operation_review_v2_enabled: bool,
    semantic_plaintext_input_enabled: bool,
) {
    SEMANTIC_RECORDING_ENABLED.store(semantic_recording_enabled, Ordering::SeqCst);
    UIA_OBSERVER_ENABLED.store(
        semantic_recording_enabled && uia_observer_enabled,
        Ordering::SeqCst,
    );
    OPERATION_BUILDER_ENABLED.store(
        semantic_recording_enabled && operation_builder_enabled,
        Ordering::SeqCst,
    );
    OPERATION_REVIEW_V2_ENABLED.store(
        semantic_recording_enabled && operation_review_v2_enabled,
        Ordering::SeqCst,
    );
    SEMANTIC_PLAINTEXT_INPUT_ENABLED.store(
        semantic_recording_enabled && semantic_plaintext_input_enabled,
        Ordering::SeqCst,
    );
}

#[allow(dead_code)]
pub fn is_semantic_recording_enabled() -> bool {
    SEMANTIC_RECORDING_ENABLED.load(Ordering::SeqCst)
}

#[allow(dead_code)]
pub fn is_uia_observer_enabled() -> bool {
    UIA_OBSERVER_ENABLED.load(Ordering::SeqCst)
}

#[allow(dead_code)]
pub fn is_operation_builder_enabled() -> bool {
    OPERATION_BUILDER_ENABLED.load(Ordering::SeqCst)
}

#[allow(dead_code)]
pub fn is_operation_review_v2_enabled() -> bool {
    OPERATION_REVIEW_V2_ENABLED.load(Ordering::SeqCst)
}

#[allow(dead_code)]
pub fn is_semantic_plaintext_input_enabled() -> bool {
    SEMANTIC_PLAINTEXT_INPUT_ENABLED.load(Ordering::SeqCst)
}

pub fn set_defect_windows(pre_seconds: u32, post_seconds: u32) {
    DEFECT_PRE_WINDOW_SECONDS.store(pre_seconds.clamp(5, 600), Ordering::SeqCst);
    DEFECT_POST_WINDOW_SECONDS.store(post_seconds.clamp(0, 300), Ordering::SeqCst);
}

pub fn defect_pre_window_seconds() -> u32 {
    DEFECT_PRE_WINDOW_SECONDS.load(Ordering::SeqCst)
}

pub fn defect_post_window_seconds() -> u32 {
    DEFECT_POST_WINDOW_SECONDS.load(Ordering::SeqCst)
}
