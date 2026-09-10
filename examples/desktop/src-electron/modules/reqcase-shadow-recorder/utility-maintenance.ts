import path from 'node:path';

import { utilityProcess } from 'electron';

import type {
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
} from './types';

const UTILITY_MAINTENANCE_TIMEOUT_MS = 120_000;

type ExportTuningSnapshotRequest = {
  kind: 'export-tuning-snapshot';
  requestId: string;
  input: ReqCaseShadowRecorderTuningSnapshotExportInput;
};

type MaintenanceRequest = ExportTuningSnapshotRequest;

type ExportTuningSnapshotSuccess = {
  kind: 'export-tuning-snapshot:result';
  requestId: string;
  ok: true;
  result: ReqCaseShadowRecorderTuningSnapshotExportResult;
};

type MaintenanceFailure = {
  kind: 'export-tuning-snapshot:result';
  requestId: string;
  ok: false;
  error: string;
  stack?: string;
};

type MaintenanceResponse = ExportTuningSnapshotSuccess | MaintenanceFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMaintenanceResponse(
  value: unknown,
  requestId: string,
  expectedKind: MaintenanceResponse['kind'],
): value is MaintenanceResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === expectedKind
    && value.requestId === requestId
    && typeof value.ok === 'boolean'
  );
}

async function runMaintenanceTask<T>(
  request: MaintenanceRequest,
  expectedKind: MaintenanceResponse['kind'],
): Promise<T> {
  const workerPath = path.resolve(__dirname, '../../utility/maintenance-worker.js');

  return new Promise<T>((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'reqcase-shadow-recorder-maintenance',
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error('Utility maintenance task timed out.'));
    }, UTILITY_MAINTENANCE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners();
    };

    child.once('spawn', () => {
      child.postMessage(request);
    });

    child.on('message', (message) => {
      if (!isMaintenanceResponse(message, request.requestId, expectedKind)) {
        return;
      }
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      child.kill();

      if (message.ok) {
        resolve((message as any).result as T);
      } else {
        const detail = message.stack ? `${message.error}\n${message.stack}` : message.error;
        reject(new Error(detail));
      }
    });

    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Utility maintenance process exited unexpectedly with code ${code}.`));
    });

    child.once('error', (type, location, report) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Utility maintenance fatal error: ${type} @ ${location}\n${report}`));
    });
  });
}

export async function exportTuningSnapshotInUtilityProcess(
  input: ReqCaseShadowRecorderTuningSnapshotExportInput,
): Promise<ReqCaseShadowRecorderTuningSnapshotExportResult> {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return runMaintenanceTask<ReqCaseShadowRecorderTuningSnapshotExportResult>(
    {
      kind: 'export-tuning-snapshot',
      requestId,
      input,
    },
    'export-tuning-snapshot:result',
  );
}
