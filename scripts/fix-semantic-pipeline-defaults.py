# -*- coding: utf-8 -*-
from pathlib import Path

root = Path(__file__).resolve().parents[1]

# --- recorder.rs ---
recorder = root / "src" / "recorder.rs"
rs = recorder.read_text(encoding="utf-8")
old = """        let semantic_recording_enabled =
            config.semantic_recording_enabled || config.defect_evidence_enabled;
        crate::session::set_defect_evidence_enabled(semantic_recording_enabled);
        crate::session::set_semantic_feature_flags(
            semantic_recording_enabled,
            config.uia_observer_enabled,
            config.operation_builder_enabled,
            config.operation_review_v2_enabled,
            config.semantic_plaintext_input_enabled,
        );"""
new = """        let semantic_recording_enabled =
            config.semantic_recording_enabled || config.defect_evidence_enabled;
        crate::session::set_defect_evidence_enabled(semantic_recording_enabled);
        // Product rule: enabling semantic recording turns on the full operation-result
        // pipeline. Desktop currently exposes a single switch; UIA observer + operation
        // builder default to false and were not forwarded from Electron, so clicks stayed L1.
        let uia_observer_enabled = semantic_recording_enabled;
        let operation_builder_enabled = semantic_recording_enabled;
        crate::session::set_semantic_feature_flags(
            semantic_recording_enabled,
            uia_observer_enabled,
            operation_builder_enabled,
            config.operation_review_v2_enabled,
            config.semantic_plaintext_input_enabled,
        );"""
if old not in rs:
    raise SystemExit("recorder.rs block not found")
recorder.write_text(rs.replace(old, new), encoding="utf-8")
print("recorder.rs ok")

# --- manager.rs: pre-state async when semantic or defect evidence on ---
manager = root / "src" / "session" / "manager.rs"
ms = manager.read_text(encoding="utf-8")
old_m = """        if !crate::session::defect_config::is_semantic_recording_enabled()
            || !crate::session::defect_config::is_operation_builder_enabled()
        {
            return;
        }

        let session_id = event.session_id.clone();
        let source_event_id = event.event_id.clone();
        let occurred_at_ms = event.occurred_at_ms;
        // Capture Manager pointer lifetime via global singleton used by the process.
        std::thread::Builder::new()
            .name("shadow-uia-pre-state".to_string())"""
new_m = """        // Fire whenever semantic/defect capture is on. Builder flag alone used to gate this,
        // but Electron never enabled builder → no pre-state UIA, no alias match on clicks.
        if !crate::session::defect_config::is_semantic_recording_enabled()
            && !crate::session::is_defect_evidence_enabled()
        {
            return;
        }

        let session_id = event.session_id.clone();
        let source_event_id = event.event_id.clone();
        let occurred_at_ms = event.occurred_at_ms;
        // Capture Manager pointer lifetime via global singleton used by the process.
        std::thread::Builder::new()
            .name("shadow-uia-pre-state".to_string())"""
if old_m not in ms:
    raise SystemExit("manager pre-state gate not found")
manager.write_text(ms.replace(old_m, new_m), encoding="utf-8")
print("manager.rs ok")

# --- native-binding.ts ---
nb = root / "examples" / "desktop" / "src-electron" / "native-binding.ts"
ns = nb.read_text(encoding="utf-8")
import re

re_fn = re.compile(r"function setRecorderConfig\([\s\S]*?\n\}")
m = re_fn.search(ns)
if not m:
    raise SystemExit("setRecorderConfig not found")
replacement = """function setRecorderConfig(config: ReqCaseShadowRecorderConfig): void {
  const semanticRecordingEnabled =
    !!(config.semanticRecordingEnabled ?? config.defectEvidenceEnabled);
  // Single UI switch enables full UIA + operation pipeline.
  const uiaObserverEnabled = semanticRecordingEnabled;
  const operationBuilderEnabled = semanticRecordingEnabled;
  (getBinding() as any).setConfig({
    maxSteps: config.maxSteps ?? deriveInternalMaxSteps(config.recordingWindowSeconds),
    maxBufferBytes: config.maxBufferBytes,
    debounceMs: config.debounceMs,
    webpQuality: config.webpQuality,
    thumbWebpQuality: config.thumbWebpQuality,
    adaptiveQualityEnabled: config.adaptiveQualityEnabled,
    adaptiveBufferHighRatio: config.adaptiveBufferHighRatio,
    adaptiveBufferLowRatio: config.adaptiveBufferLowRatio,
    adaptiveLatencyHighMs: config.adaptiveLatencyHighMs,
    adaptiveLatencyLowMs: config.adaptiveLatencyLowMs,
    adaptiveTargetImageKb: config.adaptiveTargetImageKb,
    adaptiveStepDown: config.adaptiveStepDown,
    adaptiveStepUp: config.adaptiveStepUp,
    adaptiveMinQuality: config.adaptiveMinQuality,
    adaptiveMaxQuality: config.adaptiveMaxQuality,
    inputMode: config.inputMode,
    captureBackend: config.captureBackend,
    strictBackend: config.strictBackend,
    deltaMode: config.deltaMode,
    transportMode: config.transportMode,
    streamPayload: config.streamPayload,
    captureReuseEnabled: config.captureReuseEnabled,
    privacyEnabled: config.privacyEnabled,
    defectEvidenceEnabled: config.defectEvidenceEnabled ?? semanticRecordingEnabled,
    semanticRecordingEnabled,
    uiaObserverEnabled,
    operationBuilderEnabled,
    operationReviewV2Enabled: config.operationReviewV2Enabled,
    semanticPlaintextInputEnabled: config.semanticPlaintextInputEnabled,
    defectPreWindowSeconds: config.defectPreWindowSeconds,
    defectPostWindowSeconds: config.defectPostWindowSeconds,
  });
}"""
ns = ns[: m.start()] + replacement + ns[m.end() :]
nb.write_text(ns, encoding="utf-8")
print("native-binding.ts ok")

print("DONE")
