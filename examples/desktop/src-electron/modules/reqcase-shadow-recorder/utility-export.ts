import path from 'node:path';

import { utilityProcess } from 'electron';

import type {
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderStep,
} from './types';

const UTILITY_EXPORT_TIMEOUT_MS = 120_000;

type ExportReportRequest = {
  kind: 'export-report';
  requestId: string;
  input: ReqCaseShadowRecorderExportInput;
  steps: ReqCaseShadowRecorderStep[];
};

type ExportReportSuccess = {
  kind: 'export-report:result';
  requestId: string;
  ok: true;
  result: ReqCaseShadowRecorderExportResult;
};

type ExportReportFailure = {
  kind: 'export-report:result';
  requestId: string;
  ok: false;
  error: string;
  stack?: string;
};

type ExportReportResponse = ExportReportSuccess | ExportReportFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isExportReportResponse(
  value: unknown,
  requestId: string,
): value is ExportReportResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'export-report:result'
    && value.requestId === requestId
    && typeof value.ok === 'boolean'
  );
}

export async function exportReportInUtilityProcess(
  input: ReqCaseShadowRecorderExportInput,
  steps: ReqCaseShadowRecorderStep[],
): Promise<ReqCaseShadowRecorderExportResult> {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workerPath = path.resolve(__dirname, '../../utility/report-export-worker.js');

  return new Promise<ReqCaseShadowRecorderExportResult>((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'reqcase-shadow-recorder-export',
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error('Utility export timed out.'));
    }, UTILITY_EXPORT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners();
    };

    child.once('spawn', () => {
      const payload: ExportReportRequest = {
        kind: 'export-report',
        requestId,
        input,
        steps,
      };
      child.postMessage(payload);
    });

    child.on('message', (message) => {
      if (!isExportReportResponse(message, requestId)) {
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill();

      if (message.ok) {
        resolve(message.result);
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
      reject(new Error(`Utility export process exited unexpectedly with code ${code}.`));
    });

    child.once('error', (type, location, report) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Utility export fatal error: ${type} @ ${location}\n${report}`));
    });
  });
}

