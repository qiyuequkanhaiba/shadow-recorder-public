import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  RecorderTuningProfile,
  TuningSnapshotExportInput,
} from '../../types/contracts';
import { DEFAULT_REPORT_DIR } from './report-paths';
import { PROFILE_LABELS, buildTuningTriggerTags } from './tuning-advisor';

type Recommendation = {
  profile: RecorderTuningProfile;
  reason: string;
};

export function resolveRecommendationReason(
  profile: RecorderTuningProfile,
  recommendation: Recommendation,
): string {
  return profile === recommendation.profile
    ? recommendation.reason
    : `${PROFILE_LABELS[profile]} (manual selection)`;
}

export function buildPersistedTuningSettings(input: {
  nextConfig: RecorderConfigPayload;
  profile: RecorderTuningProfile;
  recommendation: Recommendation;
  autoApplyRecommendedOnStartup: boolean;
}): RecorderPersistedSettings {
  return {
    config: input.nextConfig,
    autoApplyLastRecommendedProfile: input.autoApplyRecommendedOnStartup,
    lastRecommendedProfile: input.profile,
    lastRecommendationReason: resolveRecommendationReason(input.profile, input.recommendation),
  };
}

export function buildTuningSnapshotExportInput(input: {
  profile: RecorderTuningProfile;
  recommendation: Recommendation;
  config: RecorderConfigPayload;
  metrics: RecorderMetrics;
  autoApplyRecommendedOnStartup: boolean;
  targetDir?: string;
}): TuningSnapshotExportInput {
  return {
    targetDir: input.targetDir ?? DEFAULT_REPORT_DIR,
    profile: input.profile,
    reason: input.recommendation.reason,
    config: input.config,
    metrics: input.metrics,
    autoApplyLastRecommendedProfile: input.autoApplyRecommendedOnStartup,
    triggerTags: buildTuningTriggerTags(input.metrics, input.config),
    notes: 'Exported from explainability panel.',
  };
}
