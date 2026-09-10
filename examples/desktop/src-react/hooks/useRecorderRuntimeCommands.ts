import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderResourceUsage,
} from '../../types/contracts';

type UseRecorderRuntimeCommandsInput = {
  config: RecorderConfigPayload;
  setIsRecording: Dispatch<SetStateAction<boolean>>;
  setIsPaused: Dispatch<SetStateAction<boolean>>;
  setMetrics: Dispatch<SetStateAction<RecorderMetrics | null>>;
  setResourceUsage: Dispatch<SetStateAction<RecorderResourceUsage | null>>;
};

export type UseRecorderRuntimeCommandsResult = {
  refreshBufferAndMetrics: () => Promise<void>;
  applyConfig: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  clearBuffer: () => Promise<void>;
  hideToTray: () => Promise<void>;
};

export function useRecorderRuntimeCommands(
  input: UseRecorderRuntimeCommandsInput,
): UseRecorderRuntimeCommandsResult {
  const refreshBufferAndMetrics = useCallback(async (): Promise<void> => {
    const [latestMetrics, paused] = await Promise.all([
      window.reqcaseShadowRecorder.getMetrics().catch(() => null),
      window.reqcaseShadowRecorder.isPaused().catch(() => false),
    ]);
    input.setMetrics(latestMetrics);
    input.setIsPaused(paused);
  }, [input.setIsPaused, input.setMetrics]);

  const applyConfig = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.setConfig(input.config);
  }, [input.config]);

  const startRecording = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.setConfig(input.config);
    await window.reqcaseShadowRecorder.start();
    input.setIsRecording(true);
    input.setIsPaused(false);
    input.setResourceUsage(null);
  }, [input.config, input.setIsPaused, input.setIsRecording]);

  const stopRecording = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.stop();
    input.setIsRecording(false);
    input.setIsPaused(false);
    input.setResourceUsage(null);
    await refreshBufferAndMetrics();
  }, [input.setIsPaused, input.setIsRecording, input.setResourceUsage, refreshBufferAndMetrics]);

  const pauseRecording = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.pause();
    input.setIsPaused(true);
    input.setResourceUsage(null);
  }, [input.setIsPaused, input.setResourceUsage]);

  const resumeRecording = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.resume();
    input.setIsPaused(false);
    input.setResourceUsage(null);
  }, [input.setIsPaused, input.setResourceUsage]);

  const clearBuffer = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.clearBuffer();
    await refreshBufferAndMetrics();
  }, [refreshBufferAndMetrics]);

  const hideToTray = useCallback(async (): Promise<void> => {
    await window.reqcaseShadowRecorder.hideToTray();
  }, []);

  return {
    refreshBufferAndMetrics,
    applyConfig,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    clearBuffer,
    hideToTray,
  };
}
