import type { Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload } from '../../types/contracts';
import type { UseRecorderRuntimeInput, UseRecorderRuntimeResult } from '../hooks/useRecorderRuntime';
import type { UseTuningAdvisorInput } from '../hooks/useTuningAdvisor';

type BaseUiInput = {
  toUiErrorMessage: (error: unknown) => string;
  setError: Dispatch<SetStateAction<string>>;
};

export function isSemanticRecordingEnabled(config: RecorderConfigPayload): boolean {
  return !!config.semanticRecordingEnabled || !!config.defectEvidenceEnabled;
}

export function createRecorderRuntimeInput(
  input: BaseUiInput & {
    config: RecorderConfigPayload;
  },
): UseRecorderRuntimeInput {
  return {
    config: input.config,
    toUiErrorMessage: input.toUiErrorMessage,
    onError: input.setError,
  };
}

export function createTuningAdvisorInput(
  input: BaseUiInput & {
    config: RecorderConfigPayload;
    setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
    metrics: UseRecorderRuntimeResult['metrics'];
  },
): UseTuningAdvisorInput {
  return {
    config: input.config,
    setConfig: input.setConfig,
    metrics: input.metrics,
    toUiErrorMessage: input.toUiErrorMessage,
    onError: input.setError,
  };
}
