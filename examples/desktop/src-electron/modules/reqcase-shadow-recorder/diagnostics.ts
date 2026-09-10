import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createZipArchive } from './evidence-archive';

const DEFAULT_RECENT_ERROR_LIMIT = 30;
const MAX_RECENT_ERROR_LENGTH = 260;

export interface DiagnosticsBundle {
  createdAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  nativeLoaded: boolean;
  lastMetrics?: unknown;
  recentErrors: string[];
}

export type DiagnosticsBundleInput = {
  appVersion: string;
  nativeLoaded: boolean;
  lastMetrics?: unknown;
  recentErrors?: readonly string[];
  now?: Date;
  platform?: string;
  arch?: string;
};

export type DiagnosticsExportInput = DiagnosticsBundleInput & {
  targetDir: string;
};

export type DiagnosticsExportResult = {
  bundle: DiagnosticsBundle;
  bundlePath: string;
  zipPath: string;
};

export type RecentErrorLog = {
  record: (error: unknown, context?: string) => void;
  list: () => string[];
  clear: () => void;
};

export const recorderDiagnosticsErrorLog = createRecentErrorLog();

export function createRecentErrorLog(limit = DEFAULT_RECENT_ERROR_LIMIT): RecentErrorLog {
  const items: string[] = [];

  return {
    record(error: unknown, context?: string): void {
      items.push(formatDiagnosticError(error, context));
      while (items.length > limit) {
        items.shift();
      }
    },
    list(): string[] {
      return [...items];
    },
    clear(): void {
      items.length = 0;
    },
  };
}

export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): DiagnosticsBundle {
  const bundle: DiagnosticsBundle = {
    createdAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    platform: input.platform ?? os.platform(),
    arch: input.arch ?? os.arch(),
    nativeLoaded: input.nativeLoaded,
    recentErrors: [...(input.recentErrors ?? [])].map((error) => truncateDiagnosticText(error)),
  };

  if (input.lastMetrics !== undefined) {
    bundle.lastMetrics = input.lastMetrics;
  }

  return bundle;
}

export async function exportDiagnosticsBundle(
  input: DiagnosticsExportInput,
): Promise<DiagnosticsExportResult> {
  const bundle = buildDiagnosticsBundle(input);
  const bundleName = `shadow-recorder-diagnostics-${formatDiagnosticsTimestamp(bundle.createdAt)}`;
  const rootDir = path.resolve(input.targetDir, bundleName);
  const bundlePath = path.resolve(rootDir, 'diagnostics.json');
  const zipPath = path.resolve(input.targetDir, `${bundleName}.zip`);

  await mkdir(rootDir, { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
  await createZipArchive(rootDir, zipPath);

  return { bundle, bundlePath, zipPath };
}

function formatDiagnosticError(error: unknown, context?: string): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error) ?? String(error);
  const raw = context ? `${context}: ${message}` : message;
  return truncateDiagnosticText(raw);
}

function truncateDiagnosticText(input: string): string {
  const normalized = redactSensitiveDiagnosticText(input).replace(/[\r\n\t]+/g, ' ').trim();
  if (normalized.length <= MAX_RECENT_ERROR_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RECENT_ERROR_LENGTH - 1)}…`;
}

function redactSensitiveDiagnosticText(input: string): string {
  return input
    .replace(/imageWebpBase64\s*=\s*\S+/gi, '[image-redacted]')
    .replace(/clipboard(?:Text|Content)?\s*=\s*\S+/gi, '[clipboard-redacted]')
    .replace(/windowTitle\s*=\s*.*?(?=\s(?:clipboard|imageWebpBase64|video)\s*=|$)/gi, '[window-title-redacted]')
    .replace(/\b\S+\.(?:mp4|webm|mkv|avi|mov)\b/gi, '[video-path-redacted]');
}

function formatDiagnosticsTimestamp(createdAt: string): string {
  const date = createdAt.slice(0, 10).replaceAll('-', '');
  const time = createdAt.slice(11, 19).replaceAll(':', '');
  return `${date}-${time}`;
}
