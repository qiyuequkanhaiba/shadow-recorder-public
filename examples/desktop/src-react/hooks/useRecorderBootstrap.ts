import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
} from '../../types/contracts';
import { applyRecorderBootstrapSnapshot } from './useRecorderBootstrapBindings';
import { loadRecorderBootstrapSnapshot } from './useRecorderBootstrapLoader';

export type UseRecorderBootstrapInput = {
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  setMetrics: Dispatch<SetStateAction<RecorderMetrics | null>>;
  hydrateTuningFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  hydrateBenchmarkFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  hydrateQueueFromSettings: (settings: RecorderPersistedSettings | null | undefined) => void;
  setError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
};

export function useRecorderBootstrap(input: UseRecorderBootstrapInput): void {
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) {
      return () => undefined;
    }

    bootstrappedRef.current = true;

    async function bootstrap() {
      try {
        applyRecorderBootstrapSnapshot({
          snapshot: await loadRecorderBootstrapSnapshot(),
          setConfig: input.setConfig,
          setMetrics: input.setMetrics,
          hydrateTuningFromSettings: input.hydrateTuningFromSettings,
          hydrateBenchmarkFromSettings: input.hydrateBenchmarkFromSettings,
          hydrateQueueFromSettings: input.hydrateQueueFromSettings,
        });
      } catch (err) {
        input.setError(input.toUiErrorMessage(err));
      }
    }
    void bootstrap();
  }, [
    input.hydrateBenchmarkFromSettings,
    input.hydrateQueueFromSettings,
    input.hydrateTuningFromSettings,
    input.setConfig,
    input.setError,
    input.setMetrics,
    input.toUiErrorMessage,
  ]);
}
