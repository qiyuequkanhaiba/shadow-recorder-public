import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useMemo, useState } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  RecorderTuningProfile,
  TuningSnapshotExportResult,
} from '../../types/contracts';
import {
  PROFILE_LABELS,
  recommendTuningProfile,
} from '../lib/tuning-advisor';
import { useTuningAdvisorCommands } from './useTuningAdvisorCommands';

export type UseTuningAdvisorInput = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  metrics: RecorderMetrics | null;
  toUiErrorMessage: (error: unknown) => string;
  onError: (message: string) => void;
};

export type UseTuningAdvisorResult = {
  recommendation: ReturnType<typeof recommendTuningProfile>;
  autoApplyRecommendedOnStartup: boolean;
  snapshotResult: TuningSnapshotExportResult | null;
  profileLabels: typeof PROFILE_LABELS;
  hydrateFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  resetSnapshotResult: () => void;
  toggleAutoApply: (checked: boolean) => Promise<void>;
  applyProfile: (profile: RecorderTuningProfile) => Promise<void>;
  exportTuningSnapshot: () => Promise<void>;
};

export function useTuningAdvisor(input: UseTuningAdvisorInput): UseTuningAdvisorResult {
  const [autoApplyRecommendedOnStartup, setAutoApplyRecommendedOnStartup] = useState(false);
  const [snapshotResult, setSnapshotResult] = useState<TuningSnapshotExportResult | null>(null);

  const recommendation = useMemo(
    () => recommendTuningProfile(input.metrics, input.config),
    [input.config, input.metrics],
  );

  const hydrateFromSettings = useCallback((settings: RecorderPersistedSettings | null | undefined) => {
    setAutoApplyRecommendedOnStartup(!!settings?.autoApplyLastRecommendedProfile);
  }, []);

  const resetSnapshotResult = useCallback(() => {
    setSnapshotResult(null);
  }, []);

  const commands = useTuningAdvisorCommands({
    config: input.config,
    metrics: input.metrics,
    recommendation,
    autoApplyRecommendedOnStartup,
    setConfig: input.setConfig,
    setAutoApplyRecommendedOnStartup,
    setSnapshotResult,
    onError: input.onError,
    toUiErrorMessage: input.toUiErrorMessage,
  });

  return {
    recommendation,
    autoApplyRecommendedOnStartup,
    snapshotResult,
    profileLabels: PROFILE_LABELS,
    hydrateFromSettings,
    resetSnapshotResult,
    toggleAutoApply: commands.toggleAutoApply,
    applyProfile: commands.applyProfile,
    exportTuningSnapshot: commands.exportTuningSnapshot,
  };
}
