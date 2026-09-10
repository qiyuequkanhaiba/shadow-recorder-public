import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderResourceUsage,
  RecorderStep,
} from '../../types/contracts';
import { useRecorderRuntimeCommands } from './useRecorderRuntimeCommands';
import { useDocumentVisibility } from './useDocumentVisibility';

export type UseRecorderRuntimeInput = {
  config: RecorderConfigPayload;
  toUiErrorMessage: (error: unknown) => string;
  onError: (message: string) => void;
};

export type UseRecorderRuntimeResult = {
  isRecording: boolean;
  isPaused: boolean;
  steps: RecorderStep[];
  metrics: RecorderMetrics | null;
  resourceUsage: RecorderResourceUsage | null;
  setSteps: Dispatch<SetStateAction<RecorderStep[]>>;
  setMetrics: Dispatch<SetStateAction<RecorderMetrics | null>>;
  refreshBufferAndMetrics: () => Promise<void>;
  applyConfig: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  clearBuffer: () => Promise<void>;
  hideToTray: () => Promise<void>;
};

function metricsEqual(
  left: RecorderMetrics | null,
  right: RecorderMetrics | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.capturedStepsTotal === right.capturedStepsTotal
    && left.droppedStepsTotal === right.droppedStepsTotal
    && left.bufferSteps === right.bufferSteps
    && left.bufferBytes === right.bufferBytes
    && left.lastCaptureLatencyMs === right.lastCaptureLatencyMs
    && left.lastEncodeLatencyMs === right.lastEncodeLatencyMs
    && left.currentEffectiveQuality === right.currentEffectiveQuality
    && left.pushDispatchDropTotal === right.pushDispatchDropTotal
  );
}

function resourceUsageEqual(
  left: RecorderResourceUsage | null,
  right: RecorderResourceUsage | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.totalCpuPercent === right.totalCpuPercent
    && left.totalWorkingSetMb === right.totalWorkingSetMb
    && left.rootCpuPercent === right.rootCpuPercent
    && left.ffmpegCpuPercent === right.ffmpegCpuPercent
  );
}

export function useRecorderRuntime(input: UseRecorderRuntimeInput): UseRecorderRuntimeResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [steps, setSteps] = useState<RecorderStep[]>([]);
  const [metrics, setMetrics] = useState<RecorderMetrics | null>(null);
  const [resourceUsage, setResourceUsage] = useState<RecorderResourceUsage | null>(null);
  const pageVisible = useDocumentVisibility();

  const commands = useRecorderRuntimeCommands({
    config: input.config,
    setIsRecording,
    setIsPaused,
    setMetrics,
    setResourceUsage,
  });

  const syncRuntimeState = useCallback(async (): Promise<void> => {
    const health =
      await window.reqcaseShadowRecorder.getRuntimeHealth?.().catch(() => null)
      ?? null;

    if (health) {
      setIsRecording((prev) => (prev === health.recording ? prev : health.recording));
      setIsPaused((prev) => (prev === health.paused ? prev : health.paused));
      setMetrics((prev) => (metricsEqual(prev, health.metrics) ? prev : health.metrics));
      setResourceUsage((prev) => {
        const next = health.resourceUsage ?? null;
        return resourceUsageEqual(prev, next) ? prev : next;
      });
      return;
    }

    const paused = await window.reqcaseShadowRecorder.isPaused().catch(() => false);
    setIsPaused((prev) => (prev === paused ? prev : paused));
    const latestMetrics = await window.reqcaseShadowRecorder.getMetrics().catch(() => null);
    if (latestMetrics) {
      setMetrics((prev) => (metricsEqual(prev, latestMetrics) ? prev : latestMetrics));
    }
    setResourceUsage(null);
  }, []);

  useEffect(() => {
    if (!pageVisible) {
      return () => undefined;
    }

    let disposed = false;
    let unsubscribeMetrics: (() => void) | undefined;

    const sync = async (): Promise<void> => {
      try {
        await syncRuntimeState();
      } catch (error) {
        if (!disposed) {
          input.onError(input.toUiErrorMessage(error));
        }
      }
    };

    // Prefer push metrics when available — avoids frequent getMetrics IPC.
    const api = window.reqcaseShadowRecorder;
    if (api.subscribeMetrics && api.onMetrics) {
      void api.subscribeMetrics().catch(() => undefined);
      unsubscribeMetrics = api.onMetrics((metrics) => {
        if (disposed) return;
        setMetrics((prev) => (metricsEqual(prev, metrics) ? prev : metrics));
      });
    }

    void sync();
    // Health poll is only for recording/paused flags when push covers metrics.
    const interval = window.setInterval(() => {
      void sync();
    }, isRecording ? 4500 : 9000);

    return () => {
      disposed = true;
      clearInterval(interval);
      unsubscribeMetrics?.();
      void api.unsubscribeMetrics?.().catch(() => undefined);
    };
  }, [input.onError, input.toUiErrorMessage, isRecording, pageVisible, syncRuntimeState]);

  return {
    isRecording,
    isPaused,
    steps,
    metrics,
    resourceUsage,
    setSteps,
    setMetrics,
    refreshBufferAndMetrics: commands.refreshBufferAndMetrics,
    applyConfig: commands.applyConfig,
    startRecording: commands.startRecording,
    stopRecording: commands.stopRecording,
    pauseRecording: commands.pauseRecording,
    resumeRecording: commands.resumeRecording,
    clearBuffer: commands.clearBuffer,
    hideToTray: commands.hideToTray,
  };
}
