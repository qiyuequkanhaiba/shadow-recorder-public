import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportTestSessionEvidence } from '../src-electron/modules/reqcase-shadow-recorder/evidence-export';
import {
  findHistoricalVideoSegmentsForTimestamp,
  readHistoricalSessionEvents,
  readHistoricalSessionEventsTail,
  readHistoricalSessionOperationsTail,
  readHistoricalSessionSteps,
  readHistoricalSessionVideoSegments,
  readHistoricalSessionVideoSegmentsTail,
  readHistoricalSessionVideoStreams,
  readHistoricalTestSessionFromDir,
  renderHistoricalReproSteps,
} from '../src-electron/modules/reqcase-shadow-recorder/historical-session-reader';
import type {
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
} from '../src-electron/modules/reqcase-shadow-recorder/types';

type HistoricalVersion = 'v1.1' | 'v1.2' | 'v1.3';

type Options = {
  sessionsRoot: string;
  requiredVersions: HistoricalVersion[];
  reportPath?: string;
};

type SessionValidation = {
  sessionId: string;
  sessionDir: string;
  version: HistoricalVersion | 'unknown';
  versionSource?: string;
  eventCount: number;
  stepCount: number;
  operationCount: number;
  operationDiagnostics: string[];
  streamCount: number;
  segmentCount: number;
  playableSegmentCount: number;
  seek: 'PASS' | 'N/A';
  repro: 'PASS';
  export: 'PASS';
  sourceUnchanged: 'PASS';
};

type SessionFailure = {
  sessionDir: string;
  message: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSIONS_ROOT = path.resolve(
  SCRIPT_DIR,
  '..',
  'dist-electron',
  'reports',
  'test-sessions',
);
const SUPPORTED_VERSIONS = new Set<HistoricalVersion>(['v1.1', 'v1.2', 'v1.3']);

function printUsage(): void {
  console.log([
    'Usage:',
    '  npm run test:historical-session-real-packs -- --sessions-root <path>',
    '    [--require-versions v1.1,v1.2,v1.3] [--report <path>]',
    '  npm run test:historical-session-real-packs -- <path> [v1.1,v1.2,v1.3] [report.json]',
    '',
    'The input tree is opened read-only. Session directories may be nested.',
    'Version labels are accepted only from manifest metadata or directory names;',
    'unlabelled sessions remain "unknown" and are never guessed from timestamps.',
  ].join('\n'));
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    requiredVersions: [],
  };
  const positional: string[] = [];

  const applyRequiredVersions = (value: string): void => {
    const versions = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const version of versions) {
      assert(SUPPORTED_VERSIONS.has(version as HistoricalVersion), `unsupported version label: ${version}`);
    }
    options.requiredVersions = versions as HistoricalVersion[];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--sessions-root=')) {
      options.sessionsRoot = path.resolve(argument.slice('--sessions-root='.length));
      continue;
    }
    if (argument.startsWith('--require-versions=')) {
      applyRequiredVersions(argument.slice('--require-versions='.length));
      continue;
    }
    if (argument.startsWith('--report=')) {
      options.reportPath = path.resolve(argument.slice('--report='.length));
      continue;
    }
    switch (argument) {
      case '--sessions-root': {
        const value = argv[index + 1];
        assert(value, '--sessions-root requires a path');
        options.sessionsRoot = path.resolve(value);
        index += 1;
        break;
      }
      case '--require-versions': {
        const value = argv[index + 1];
        assert(value, '--require-versions requires a comma-separated value');
        applyRequiredVersions(value);
        index += 1;
        break;
      }
      case '--report': {
        const value = argv[index + 1];
        assert(value, '--report requires a path');
        options.reportPath = path.resolve(value);
        index += 1;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (argument.startsWith('-')) {
          throw new Error(`unknown argument: ${argument}`);
        }
        positional.push(argument);
    }
  }

  if (positional.length > 0) {
    options.sessionsRoot = path.resolve(positional[0]);
  }
  if (positional.length > 1) {
    if (positional[1].split(',').every((value) => SUPPORTED_VERSIONS.has(value as HistoricalVersion))) {
      applyRequiredVersions(positional[1]);
      if (positional[2]) {
        options.reportPath = path.resolve(positional[2]);
      }
    } else {
      options.reportPath = path.resolve(positional[1]);
    }
  }
  assert(positional.length <= 3, `too many positional arguments: ${positional.slice(3).join(' ')}`);

  return options;
}

function discoverSessionDirs(rootDir: string): string[] {
  const sessions: string[] = [];
  const pending = [path.resolve(rootDir)];

  while (pending.length > 0) {
    const currentDir = pending.pop()!;
    if (existsSync(path.join(currentDir, 'session.json'))) {
      sessions.push(currentDir);
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path.join(currentDir, entry.name));
      }
    }
  }

  return sessions.sort((left, right) => left.localeCompare(right));
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fingerprintDirectory(rootDir: string): Map<string, string> {
  const fingerprint = new Map<string, string>();
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop()!;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const stats = statSync(fullPath);
      fingerprint.set(relativePath, `${stats.size}:${hashFile(fullPath)}`);
    }
  }

  return fingerprint;
}

function normalizeVersionLabel(value: unknown): HistoricalVersion | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const directMatch = normalized.match(/^v?1[._-]([123])$/);
  if (directMatch) {
    return `v1.${directMatch[1]}` as HistoricalVersion;
  }
  const packageMatch = normalized.match(/^v?0[._-]1[._-]([123])$/);
  if (packageMatch) {
    return `v1.${packageMatch[1]}` as HistoricalVersion;
  }
  return undefined;
}

function detectVersion(sessionDir: string, manifestPath: string): {
  version: HistoricalVersion | 'unknown';
  source?: string;
} {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  for (const key of ['appVersion', 'version', 'releaseVersion', 'formatVersion']) {
    const version = normalizeVersionLabel(manifest[key]);
    if (version) {
      return { version, source: `session.json:${key}` };
    }
  }

  for (const segment of path.resolve(sessionDir).split(path.sep).reverse()) {
    const version = normalizeVersionLabel(segment);
    if (version) {
      return { version, source: `directory:${segment}` };
    }
  }

  return { version: 'unknown' };
}

function numberField(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildSeekAnchors(
  steps: ReqCaseShadowRecorderStep[],
  events: ReqCaseShadowRecorderTestSessionTimelineEvent[],
): Array<{ occurredAtMs: number; displayId?: string }> {
  const anchors: Array<{ occurredAtMs: number; displayId?: string }> = [];
  for (const step of steps) {
    const occurredAtMs = numberField(step, ['timestampMs', 'startedAtMs', 'occurredAtMs']);
    if (occurredAtMs !== undefined) {
      anchors.push({
        occurredAtMs,
        displayId: typeof step.displayId === 'string' ? step.displayId : undefined,
      });
    }
  }
  for (const event of events) {
    if (event.eventType === 'step_captured') {
      anchors.push({
        occurredAtMs: event.occurredAtMs,
        displayId: event.displayId,
      });
    }
  }
  return anchors;
}

async function validateSession(
  sessionsRoot: string,
  sessionDir: string,
  exportRoot: string,
): Promise<SessionValidation> {
  const before = fingerprintDirectory(sessionDir);
  const session = readHistoricalTestSessionFromDir(sessionsRoot, sessionDir);
  assert(session, `could not open ${path.join(sessionDir, 'session.json')}`);

  try {
    const events = readHistoricalSessionEvents(session);
    const steps = readHistoricalSessionSteps(session);
    const streams = readHistoricalSessionVideoStreams(session);
    const segments = readHistoricalSessionVideoSegments(session);
    const operationTail = readHistoricalSessionOperationsTail(session, undefined, Number.MAX_SAFE_INTEGER);

    if (events.length > 0) {
      const eventTail = readHistoricalSessionEventsTail(session, events[0].eventId, Number.MAX_SAFE_INTEGER);
      assert.equal(eventTail.reset, false, 'event tail cursor should be recognized');
      assert.equal(eventTail.items.length, Math.max(0, events.length - 1), 'event tail count mismatch');
    }
    if (segments.length > 0) {
      const segmentTail = readHistoricalSessionVideoSegmentsTail(
        session,
        undefined,
        segments[0].segmentId,
        Number.MAX_SAFE_INTEGER,
      );
      assert.equal(segmentTail.reset, false, 'video segment tail cursor should be recognized');
      assert.equal(segmentTail.items.length, Math.max(0, segments.length - 1), 'video segment tail count mismatch');
    }

    const anchors = buildSeekAnchors(steps, events);
    const playableSegments = segments.filter((segment) => segment.isPlayable);
    let seek: SessionValidation['seek'] = 'N/A';
    if (anchors.length > 0 && playableSegments.length > 0) {
      const match = anchors.find((anchor) =>
        findHistoricalVideoSegmentsForTimestamp(
          session,
          anchor.occurredAtMs,
          anchor.displayId,
          3,
        ).length > 0);
      assert(match, 'no step/event timestamp could seek to a retained playable segment');
      seek = 'PASS';
    }

    const reproText = renderHistoricalReproSteps(
      session,
      session.startedAtMs,
      session.endedAtMs,
      'real historical pack validation',
    );
    assert.match(reproText, /复现步骤/, 'repro text is missing its heading');
    assert(reproText.trim().length > 0, 'repro text is empty');

    const exportResult = await exportTestSessionEvidence(
      {
        sessionId: session.sessionId,
        targetDir: exportRoot,
        bundleName: `${session.sessionId}-real-pack-validation`,
        privacyAcknowledgedAt: new Date().toISOString(),
      },
      {
        session,
        events,
        videoStreams: streams,
        videoSegments: segments,
      },
    );
    assert(exportResult.exportDir, 'evidence export did not return an export directory');
    for (const relativePath of [
      'summary.html',
      'operations.json',
      'operations.csv',
      'manifest.json',
      'manifest.v2.json',
    ]) {
      assert(
        existsSync(path.join(exportResult.exportDir, relativePath)),
        `evidence export is missing ${relativePath}`,
      );
    }

    const version = detectVersion(sessionDir, session.manifestPath!);
    return {
      sessionId: session.sessionId,
      sessionDir,
      version: version.version,
      versionSource: version.source,
      eventCount: events.length,
      stepCount: steps.length,
      operationCount: operationTail.items.length,
      operationDiagnostics: (operationTail.diagnostics ?? []).map((diagnostic) => diagnostic.code),
      streamCount: streams.length,
      segmentCount: segments.length,
      playableSegmentCount: playableSegments.length,
      seek,
      repro: 'PASS',
      export: 'PASS',
      sourceUnchanged: 'PASS',
    };
  } finally {
    assert.deepEqual(
      [...fingerprintDirectory(sessionDir).entries()].sort(),
      [...before.entries()].sort(),
      `source session changed during validation: ${sessionDir}`,
    );
  }
}

function printResults(results: SessionValidation[], failures: SessionFailure[]): void {
  console.table(results.map((result) => ({
    version: result.version,
    sessionId: result.sessionId,
    events: result.eventCount,
    steps: result.stepCount,
    operations: result.operationCount,
    diagnostics: result.operationDiagnostics.join(',') || '-',
    segments: result.segmentCount,
    playable: result.playableSegmentCount,
    seek: result.seek,
    repro: result.repro,
    export: result.export,
    unchanged: result.sourceUnchanged,
  })));
  if (failures.length > 0) {
    console.table(failures);
  }
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  assert(existsSync(options.sessionsRoot), `sessions root does not exist: ${options.sessionsRoot}`);

  const sessionDirs = discoverSessionDirs(options.sessionsRoot);
  assert(sessionDirs.length > 0, `no session.json files found under ${options.sessionsRoot}`);

  const exportRoot = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-real-pack-exports-'));
  const results: SessionValidation[] = [];
  const failures: SessionFailure[] = [];
  try {
    for (const sessionDir of sessionDirs) {
      try {
        results.push(await validateSession(options.sessionsRoot, sessionDir, exportRoot));
      } catch (error) {
        failures.push({
          sessionDir,
          message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    }
  } finally {
    rmSync(exportRoot, { recursive: true, force: true });
  }

  printResults(results, failures);
  const detectedVersions = new Set(results.map((result) => result.version));
  const missingVersions = options.requiredVersions.filter((version) => !detectedVersions.has(version));
  if (missingVersions.length > 0) {
    failures.push({
      sessionDir: options.sessionsRoot,
      message: `required version labels not found: ${missingVersions.join(', ')}`,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sessionsRoot: options.sessionsRoot,
    requiredVersions: options.requiredVersions,
    detectedVersions: [...detectedVersions].sort(),
    passCount: results.length,
    failureCount: failures.length,
    results,
    failures,
  };
  if (options.reportPath) {
    mkdirSync(path.dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[historical-session-real-pack-test] report: ${options.reportPath}`);
  }

  assert.equal(failures.length, 0, `${failures.length} historical session validation failure(s)`);
  console.log(`[historical-session-real-pack-test] PASS (${results.length} session(s))`);
}

void run().catch((error) => {
  console.error('[historical-session-real-pack-test] FAIL', error);
  process.exitCode = 1;
});
