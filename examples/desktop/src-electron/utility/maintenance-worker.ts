import { exportTuningSnapshot } from '../modules/reqcase-shadow-recorder/tuning-snapshot';
import type {
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
} from '../modules/reqcase-shadow-recorder/types';

type ExportTuningSnapshotRequest = {
  kind: 'export-tuning-snapshot';
  requestId: string;
  input: ReqCaseShadowRecorderTuningSnapshotExportInput;
};

type MaintenanceRequest = ExportTuningSnapshotRequest;

type MaintenanceResponse =
  {
    kind: 'export-tuning-snapshot:result';
    requestId: string;
    ok: true;
    result: ReqCaseShadowRecorderTuningSnapshotExportResult;
  }
  | {
    kind: 'export-tuning-snapshot:result';
    requestId: string;
    ok: false;
    error: string;
    stack?: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isExportTuningSnapshotRequest(value: unknown): value is ExportTuningSnapshotRequest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'export-tuning-snapshot'
    && typeof value.requestId === 'string'
    && isRecord(value.input)
  );
}

function postToParent(payload: MaintenanceResponse): void {
  const parentPort = (process as any).parentPort;
  if (parentPort && typeof parentPort.postMessage === 'function') {
    parentPort.postMessage(payload);
    return;
  }

  if (typeof process.send === 'function') {
    process.send(payload);
  }
}

async function handleRequest(message: unknown): Promise<void> {
  if (isExportTuningSnapshotRequest(message)) {
    try {
      const result = await exportTuningSnapshot(message.input);
      postToParent({
        kind: 'export-tuning-snapshot:result',
        requestId: message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      const err = error as Error;
      postToParent({
        kind: 'export-tuning-snapshot:result',
        requestId: message.requestId,
        ok: false,
        error: err?.message ?? String(error),
        stack: err?.stack,
      });
    }
  }
}

const parentPort = (process as any).parentPort;
if (parentPort && typeof parentPort.on === 'function') {
  parentPort.on('message', (message: unknown) => {
    void handleRequest(message);
  });
} else {
  process.on('message', (message: unknown) => {
    void handleRequest(message);
  });
}
