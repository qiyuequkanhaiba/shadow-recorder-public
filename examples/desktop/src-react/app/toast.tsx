import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'error' | 'progress';

export type ShowToastFn = (
  message: string,
  tone?: ToastTone,
  percent?: number,
) => void;

export type ToastState = {
  message: string | null;
  tone: ToastTone;
  percent: number | null;
};

export function useToast(timeoutMs = 2600): {
  toast: ToastState;
  showToast: ShowToastFn;
  clearToast: () => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<ToastTone>('info');
  const [percent, setPercent] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearToast = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setMessage(null);
    setPercent(null);
    setTone('info');
  }, []);

  const showToast = useCallback<ShowToastFn>(
    (nextMessage, nextTone = 'info', nextPercent) => {
      setMessage(nextMessage);
      setTone(nextTone);
      setPercent(typeof nextPercent === 'number' ? nextPercent : null);

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (nextTone !== 'progress') {
        timerRef.current = window.setTimeout(() => {
          setMessage(null);
          setPercent(null);
          setTone('info');
          timerRef.current = null;
        }, timeoutMs);
      }
    },
    [timeoutMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    toast: { message, tone, percent },
    showToast,
    clearToast,
  };
}

const toneClassMap: Record<ToastTone, string> = {
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  error: styles.toneError,
  progress: styles.toneProgress,
};

export function ToastBanner({ toast }: { toast: ToastState }) {
  if (!toast.message) {
    return null;
  }

  return (
    <div
      data-ui-scope="shell"
      className={clsx(styles.toast, toneClassMap[toast.tone], `is-${toast.tone}`)}
      role="status"
      aria-live="polite"
    >
      <span>{toast.message}</span>
      {toast.tone === 'progress' ? (
        <span className={styles.progressTrack} aria-hidden="true">
          <span
            className={styles.progressFill}
            style={{ width: `${Math.max(0, Math.min(100, toast.percent ?? 0))}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
