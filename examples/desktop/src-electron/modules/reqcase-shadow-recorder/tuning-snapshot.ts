import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
} from './types';

export async function exportTuningSnapshot(
  input: ReqCaseShadowRecorderTuningSnapshotExportInput,
): Promise<ReqCaseShadowRecorderTuningSnapshotExportResult> {
  const generatedAtMs = input.generatedAtMs ?? Date.now();
  const snapshotDir = path.resolve(input.targetDir);
  await mkdir(snapshotDir, { recursive: true });

  const safeProfile = input.profile;
  const filename = `tuning-snapshot-${safeProfile}-${generatedAtMs}.json`;
  const snapshotPath = path.resolve(snapshotDir, filename);

  const payload = {
    schemaVersion: 1,
    generatedAtMs,
    generatedAtIso: new Date(generatedAtMs).toISOString(),
    profile: input.profile,
    reason: input.reason,
    triggerTags: input.triggerTags ?? [],
    autoApplyLastRecommendedProfile: !!input.autoApplyLastRecommendedProfile,
    notes: input.notes ?? '',
    config: input.config,
    metrics: input.metrics,
  };

  await writeFile(snapshotPath, JSON.stringify(payload, null, 2), 'utf-8');

  return {
    snapshotPath,
    generatedAtMs,
    profile: input.profile,
  };
}
