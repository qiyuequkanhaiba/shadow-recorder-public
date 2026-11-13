import { useEffect, useRef, useState } from 'react';

import type { TestSessionDisplayTarget } from '../../types/contracts';
import type { ShowToastFn } from './toast';

export function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function useElapsedRecordingClock(input: {
  isRecording: boolean;
  isPaused: boolean;
  startedAtMs?: number;
}): number {
  const { isRecording, isPaused, startedAtMs } = input;
  const elapsedMsRef = useRef(0);
  const lastElapsedTickRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      elapsedMsRef.current = 0;
      lastElapsedTickRef.current = null;
      setElapsedMs(0);
      return;
    }

    if (elapsedMsRef.current === 0 && startedAtMs) {
      elapsedMsRef.current = Math.max(0, Date.now() - startedAtMs);
      setElapsedMs(elapsedMsRef.current);
    }

    if (isPaused) {
      lastElapsedTickRef.current = null;
      return;
    }

    lastElapsedTickRef.current = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const last = lastElapsedTickRef.current ?? now;
      elapsedMsRef.current += now - last;
      lastElapsedTickRef.current = now;
      setElapsedMs(elapsedMsRef.current);
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [startedAtMs, isPaused, isRecording]);

  return elapsedMs;
}

export function useExportProgressToast(showToast: ShowToastFn): void {
  useEffect(() => {
    const unsubscribe = window.reqcaseShadowRecorder.onExportProgress?.((progress) => {
      if (progress.phase === 'complete') {
        showToast(progress.message || '已完成导出', 'success');
        return;
      }
      if (progress.phase === 'canceled') {
        showToast(progress.message || '已取消导出', 'info');
        return;
      }
      if (progress.phase === 'failed') {
        showToast(progress.message || '导出失败', 'error');
        return;
      }
      showToast(progress.message, 'progress', progress.percent);
    });
    return () => {
      unsubscribe?.();
    };
  }, [showToast]);
}

export function useAvailableDisplays(activeTab: string): {
  availableDisplays: TestSessionDisplayTarget[];
  displaysLoading: boolean;
} {
  const [availableDisplays, setAvailableDisplays] = useState<TestSessionDisplayTarget[]>([]);
  const [displaysLoading, setDisplaysLoading] = useState(true);

  useEffect(() => {
    let disposed = false;

    const loadDisplays = async (): Promise<void> => {
      if (!window.reqcaseShadowRecorder.listAvailableDisplays) {
        if (!disposed) {
          setAvailableDisplays([]);
          setDisplaysLoading(false);
        }
        return;
      }

      setDisplaysLoading(true);
      try {
        const displays = await window.reqcaseShadowRecorder.listAvailableDisplays();
        if (!disposed) {
          setAvailableDisplays(displays);
        }
      } catch (loadError) {
        console.warn('[shadow-recorder] failed to enumerate displays', loadError);
        if (!disposed) {
          setAvailableDisplays([]);
        }
      } finally {
        if (!disposed) {
          setDisplaysLoading(false);
        }
      }
    };

    void loadDisplays();

    return () => {
      disposed = true;
    };
  }, [activeTab]);

  return { availableDisplays, displaysLoading };
}
