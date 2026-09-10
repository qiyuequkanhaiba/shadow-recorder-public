import { exportShadowRecorderReport } from '../modules/reqcase-shadow-recorder/report-export';
import type {
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderStep,
} from '../modules/reqcase-shadow-recorder/types';

type ExportReportRequest = {
  kind: 'export-report';
  requestId: string;
  input: ReqCaseShadowRecorderExportInput;
  steps: ReqCaseShadowRecorderStep[];
};

type ExportReportResponse =
  | {
    kind: 'export-report:result';
    requestId: string;
    ok: true;
    result: ReqCaseShadowRecorderExportResult;
  }
  | {
    kind: 'export-report:result';
    requestId: string;
    ok: false;
    error: string;
    stack?: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isExportReportRequest(value: unknown): value is ExportReportRequest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'export-report'
    && typeof value.requestId === 'string'
    && isRecord(value.input)
    && Array.isArray(value.steps)
  );
}

function postToParent(payload: ExportReportResponse): void {
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
  if (!isExportReportRequest(message)) {
    return;
  }

  try {
    const result = await exportShadowRecorderReport(message.input, message.steps);
    postToParent({
      kind: 'export-report:result',
      requestId: message.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    const err = error as Error;
    postToParent({
      kind: 'export-report:result',
      requestId: message.requestId,
      ok: false,
      error: err?.message ?? String(error),
      stack: err?.stack,
    });
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

