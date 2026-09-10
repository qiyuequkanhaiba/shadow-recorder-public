import type { Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  RecorderStep,
} from '../../types/contracts';

export type RecorderBootstrapSnapshot = {
  buffer: RecorderStep[];
  latestMetrics: RecorderMetrics | null;
  settings: RecorderPersistedSettings | null | undefined;
};

type ApplyRecorderBootstrapSnapshotInput = {
  snapshot: RecorderBootstrapSnapshot;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  setSteps?: Dispatch<SetStateAction<RecorderStep[]>>;
  setMetrics: Dispatch<SetStateAction<RecorderMetrics | null>>;
  hydrateTuningFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  hydrateBenchmarkFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  hydrateQueueFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
};

export function applyRecorderBootstrapSnapshot(
  input: ApplyRecorderBootstrapSnapshotInput,
): void {
  input.setSteps?.(input.snapshot.buffer);
  input.setMetrics(input.snapshot.latestMetrics);

  const settings = input.snapshot.settings;
  if (settings?.config) {
    input.setConfig((current) => ({ ...current, ...settings.config }));
  }

  input.hydrateTuningFromSettings(settings);
  input.hydrateBenchmarkFromSettings(settings);
  input.hydrateQueueFromSettings(settings);
}
