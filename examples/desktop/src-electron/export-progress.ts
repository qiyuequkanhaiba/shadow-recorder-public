export type ExportProgressStatus = 'running' | 'complete' | 'canceled' | 'failed';

export type ExportProgressEvent = {
  attemptId: number;
  percent: number;
  message: string;
  status: ExportProgressStatus;
};

export type ExportProgressState = {
  attemptId: number;
  phase: 'idle' | ExportProgressStatus;
  percent: number;
  message: string;
};

export const IDLE_EXPORT_PROGRESS: ExportProgressState = {
  attemptId: 0,
  phase: 'idle',
  percent: 0,
  message: '',
};

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function reduceExportProgress(
  state: ExportProgressState,
  event: ExportProgressEvent,
): { state: ExportProgressState; emit: boolean } {
  const percent = clampPercent(event.percent);
  if (event.attemptId < state.attemptId) {
    return { state, emit: false };
  }

  const sameAttempt = event.attemptId === state.attemptId;
  const terminal = state.phase === 'complete' || state.phase === 'canceled' || state.phase === 'failed';
  if (sameAttempt && terminal && event.status === 'running') {
    return { state, emit: false };
  }
  if (sameAttempt && state.phase === 'running' && event.status === 'running' && percent < state.percent) {
    return { state, emit: false };
  }

  return {
    state: {
      attemptId: event.attemptId,
      phase: event.status,
      percent,
      message: event.message,
    },
    emit: true,
  };
}
