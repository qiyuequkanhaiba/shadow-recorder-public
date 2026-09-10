import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderTuningProfile,
  TuningSnapshotExportResult,
} from '../../types/contracts';
import {
  buildPersistedTuningSettings,
  buildTuningSnapshotExportInput,
} from '../lib/tuning-advisor-commands';
import { createPresetConfig } from '../lib/tuning-advisor';

type Recommendation = {
  profile: RecorderTuningProfile;
  reason: string;
};

type UseTuningAdvisorCommandsInput = {
  config: RecorderConfigPayload;
  metrics: RecorderMetrics | null;
  recommendation: Recommendation;
  autoApplyRecommendedOnStartup: boolean;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  setAutoApplyRecommendedOnStartup: Dispatch<SetStateAction<boolean>>;
  setSnapshotResult: Dispatch<SetStateAction<TuningSnapshotExportResult | null>>;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
};

type UseTuningAdvisorCommandsResult = {
  toggleAutoApply: (checked: boolean) => Promise<void>;
  applyProfile: (profile: RecorderTuningProfile) => Promise<void>;
  exportTuningSnapshot: () => Promise<void>;
};

export function useTuningAdvisorCommands(
  input: UseTuningAdvisorCommandsInput,
): UseTuningAdvisorCommandsResult {
  const toggleAutoApply = useCallback(
    async (checked: boolean) => {
      input.setAutoApplyRecommendedOnStartup(checked);
      try {
        await window.reqcaseShadowRecorder.setSettings({
          autoApplyLastRecommendedProfile: checked,
        });
      } catch (err) {
        input.onError(input.toUiErrorMessage(err));
      }
    },
    [input.onError, input.setAutoApplyRecommendedOnStartup, input.toUiErrorMessage],
  );

  const applyProfile = useCallback(
    async (profile: RecorderTuningProfile) => {
      const nextConfig = createPresetConfig(input.config, profile);
      try {
        input.setConfig(nextConfig);
        await window.reqcaseShadowRecorder.setConfig(nextConfig);
        const settings = buildPersistedTuningSettings({
          nextConfig,
          profile,
          recommendation: input.recommendation,
          autoApplyRecommendedOnStartup: input.autoApplyRecommendedOnStartup,
        });
        await window.reqcaseShadowRecorder.setSettings(settings);
        input.setSnapshotResult(null);
      } catch (err) {
        input.onError(input.toUiErrorMessage(err));
      }
    },
    [
      input.autoApplyRecommendedOnStartup,
      input.config,
      input.onError,
      input.recommendation.profile,
      input.recommendation.reason,
      input.setConfig,
      input.setSnapshotResult,
      input.toUiErrorMessage,
    ],
  );

  const exportTuningSnapshot = useCallback(async () => {
    if (!input.metrics) {
      input.onError('No metrics available. Start recorder and generate activity first.');
      return;
    }

    try {
      const exportInput = buildTuningSnapshotExportInput({
        profile: input.recommendation.profile,
        recommendation: input.recommendation,
        config: input.config,
        metrics: input.metrics,
        autoApplyRecommendedOnStartup: input.autoApplyRecommendedOnStartup,
      });
      const result = await window.reqcaseShadowRecorder.exportTuningSnapshot(exportInput);
      input.setSnapshotResult(result);
    } catch (err) {
      input.onError(input.toUiErrorMessage(err));
    }
  }, [
    input.autoApplyRecommendedOnStartup,
    input.config,
    input.metrics,
    input.onError,
    input.recommendation.profile,
    input.recommendation.reason,
    input.setSnapshotResult,
    input.toUiErrorMessage,
  ]);

  return {
    toggleAutoApply,
    applyProfile,
    exportTuningSnapshot,
  };
}
