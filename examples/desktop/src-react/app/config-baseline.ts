import type {
  RecorderConfigPayload,
  RecorderMaskRegionPayload,
} from '../../types/contracts';
import {
  resolveRecordingWindowSeconds,
  resolveSegmentDurationSeconds,
} from '../../types/recording-defaults';

export function cloneConfig(config: RecorderConfigPayload): RecorderConfigPayload {
  if (typeof structuredClone === 'function') {
    return structuredClone(config);
  }
  return JSON.parse(JSON.stringify(config)) as RecorderConfigPayload;
}

function resolvePrimaryMaskRegion(config: RecorderConfigPayload): RecorderMaskRegionPayload {
  const [region] = Array.isArray(config.maskRegions) ? config.maskRegions : [];
  return {
    x: Math.max(0, Math.trunc(region?.x ?? 0)),
    y: Math.max(0, Math.trunc(region?.y ?? 0)),
    width: Math.max(0, Math.trunc(region?.width ?? 0)),
    height: Math.max(0, Math.trunc(region?.height ?? 0)),
    label: region?.label ?? '固定遮罩区域',
  };
}

function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = stripUndefinedDeep((value as Record<string, unknown>)[key]);
      if (child !== undefined) {
        out[key] = child;
      }
    }
    return out;
  }
  return value;
}

function normalizeForComparison(
  config: RecorderConfigPayload,
  otherConfig: RecorderConfigPayload,
  referenceBaseline: RecorderConfigPayload,
  isCurrent: boolean,
): Record<string, unknown> {
  const cloned = cloneConfig(config) as Record<string, unknown>;

  // 1. Always ignore internal derived maxSteps
  delete cloned.maxSteps;

  // 2. Ignore auto-derived segmentDurationSeconds when recordingWindowSeconds changed
  if (
    isCurrent &&
    config.recordingWindowSeconds !== referenceBaseline.recordingWindowSeconds
  ) {
    const nextWindow = resolveRecordingWindowSeconds(config.recordingWindowSeconds);
    const autoSegment = resolveSegmentDurationSeconds(
      referenceBaseline.segmentDurationSeconds,
      nextWindow,
    );
    if (config.segmentDurationSeconds === autoSegment) {
      cloned.segmentDurationSeconds = referenceBaseline.segmentDurationSeconds;
    }
  }

  // 3. Synchronize semanticRecordingEnabled & defectEvidenceEnabled into one canonical key
  if (
    config.semanticRecordingEnabled !== undefined ||
    config.defectEvidenceEnabled !== undefined ||
    otherConfig.semanticRecordingEnabled !== undefined ||
    otherConfig.defectEvidenceEnabled !== undefined
  ) {
    cloned.semanticRecordingEnabled = Boolean(
      config.semanticRecordingEnabled ?? config.defectEvidenceEnabled,
    );
    delete cloned.defectEvidenceEnabled;
  }

  // 4. Canonicalize targetDisplayId & targetDisplayIds and ignore companion updates on mode change symmetrically
  delete cloned.targetDisplayId;
  delete cloned.targetDisplayIds;
  if (config.targetCaptureMode === otherConfig.targetCaptureMode) {
    const ids =
      Array.isArray(config.targetDisplayIds) && config.targetDisplayIds.length > 0
        ? config.targetDisplayIds.join(',')
        : config.targetDisplayId ?? '';
    const otherIds =
      Array.isArray(otherConfig.targetDisplayIds) &&
      otherConfig.targetDisplayIds.length > 0
        ? otherConfig.targetDisplayIds.join(',')
        : otherConfig.targetDisplayId ?? '';
    if (ids || otherIds) {
      cloned.__displaySelection = ids;
    }
  }

  // 5. Ignore companion aiReplayEnabled forced to false when aiReplayProvider changes away from openai_compatible
  if (
    isCurrent &&
    config.aiReplayProvider !== referenceBaseline.aiReplayProvider &&
    config.aiReplayProvider !== 'openai_compatible' &&
    !config.aiReplayEnabled
  ) {
    cloned.aiReplayEnabled = referenceBaseline.aiReplayEnabled;
  }

  // 6. Normalize maskRegions so editing 1 field on an empty array only counts the changed field
  delete cloned.maskRegions;
  const primaryMask = resolvePrimaryMaskRegion(config);
  cloned.__maskRegion0 = primaryMask;
  if (Array.isArray(config.maskRegions) && config.maskRegions.length > 1) {
    cloned.__maskRegionsExtra = config.maskRegions.slice(1);
  }

  return stripUndefinedDeep(cloned) as Record<string, unknown>;
}

function countLeafDiffs(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLen = Math.max(left.length, right.length);
    let diffs = 0;
    for (let i = 0; i < maxLen; i += 1) {
      diffs += countLeafDiffs(left[i], right[i]);
    }
    return diffs;
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    let diffs = 0;
    for (const key of keys) {
      diffs += countLeafDiffs(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      );
    }
    return diffs;
  }
  return JSON.stringify(left) === JSON.stringify(right) ? 0 : 1;
}

export function countUnsavedConfigChanges(
  current: RecorderConfigPayload,
  baseline: RecorderConfigPayload | null,
): number {
  if (!baseline) {
    return 0;
  }
  const normalizedCurrent = normalizeForComparison(current, baseline, baseline, true);
  const normalizedBaseline = normalizeForComparison(baseline, current, baseline, false);
  return countLeafDiffs(normalizedCurrent, normalizedBaseline);
}
