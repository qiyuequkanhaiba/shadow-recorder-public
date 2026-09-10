import { strict as assert } from 'node:assert';
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
import { createHash } from 'node:crypto';

import { exportTestSessionEvidence } from '../src-electron/modules/reqcase-shadow-recorder/evidence-export';
import {
  findHistoricalVideoSegmentsForTimestamp,
  listHistoricalTestSessions,
  readHistoricalSessionEvents,
  readHistoricalSessionEventsTail,
  readHistoricalSessionOperationsTail,
  readHistoricalSessionSteps,
  readHistoricalSessionVideoSegments,
  readHistoricalSessionVideoSegmentsTail,
  readHistoricalSessionVideoStreams,
  renderHistoricalReproSteps,
} from '../src-electron/modules/reqcase-shadow-recorder/historical-session-reader';
import type { ReqCaseShadowRecorderTestSessionState } from '../src-electron/modules/reqcase-shadow-recorder/types';

type HistoricalFixtureVersion = 'v1.1' | 'v1.2' | 'v1.3';

const BASE_TIME_MS = 1710000000000;

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendNdjson(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function createHistoricalFixture(rootDir: string, version: HistoricalFixtureVersion): void {
  const sessionId = `historical-${version.replace('.', '-')}`;
  const sessionDir = path.join(rootDir, sessionId);
  const videoDir = path.join(sessionDir, 'video', 'streams', 'vs-primary');
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(path.join(sessionDir, 'artifacts'), { recursive: true });

  const startedAtMs = BASE_TIME_MS + (version === 'v1.1' ? 0 : version === 'v1.2' ? 60_000 : 120_000);
  const stepAtMs = startedAtMs + 1_250;
  writeJson(path.join(sessionDir, 'session.json'), {
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId,
    name: `Historical ${version}`,
    status: 'stopped',
    startedAtMs,
    updatedAtMs: startedAtMs + 8_000,
    endedAtMs: startedAtMs + 8_000,
    storageRootDir: rootDir,
    sessionDir,
    manifestPath: path.join(sessionDir, 'session.json'),
    bufferWindowSeconds: 90,
    segmentDurationSeconds: 5,
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    targetCaptureMode: 'target_display',
    targetDisplayId: 'display-primary',
  });

  appendNdjson(path.join(sessionDir, 'events.ndjson'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: `${sessionId}-event-start`,
      sessionId,
      eventType: 'session_started',
      logCategory: 'recording',
      occurredAtMs: startedAtMs,
      status: 'active',
      message: `started ${version}`,
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: `${sessionId}-event-step`,
      sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: stepAtMs,
      stepId: `step-${sessionId}-1`,
      action: version === 'v1.2' ? 'keyboard shortcut Ctrl+S' : 'WM_LBUTTONUP',
      x: 100,
      y: 160,
      displayId: 'display-primary',
      processName: 'legacy-app.exe',
      windowTitle: `Legacy ${version} Window`,
      fullImagePath: path.join(sessionDir, 'artifacts', 'step-1-full.webp'),
      thumbImagePath: path.join(sessionDir, 'artifacts', 'step-1-thumb.webp'),
      imageBytes: 4,
    },
  ]);

  appendNdjson(path.join(sessionDir, 'steps.ndjson'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-step',
      stepId: `step-${sessionId}-1`,
      id: `step-${sessionId}-1`,
      sessionId,
      sequence: 1,
      startedAtMs: stepAtMs,
      endedAtMs: stepAtMs + 80,
      timestampMs: stepAtMs,
      action: version === 'v1.2' ? 'keyboard shortcut Ctrl+S' : 'click',
      title: version === 'v1.2' ? '按下保存快捷键' : '点击保存按钮',
      summary: '历史步骤摘要不应冒充操作结果',
      x: 100,
      y: 160,
      displayId: 'display-primary',
      processName: 'legacy-app.exe',
      windowTitle: `Legacy ${version} Window`,
      fullImagePath: path.join(sessionDir, 'artifacts', 'step-1-full.webp'),
      thumbImagePath: path.join(sessionDir, 'artifacts', 'step-1-thumb.webp'),
      edited: version === 'v1.3',
    },
  ]);

  writeJson(path.join(sessionDir, 'video', 'streams.json'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-stream',
      streamId: 'vs-primary',
      sessionId,
      label: 'Primary Display',
      status: 'stopped',
      targetCaptureMode: 'target_display',
      displayId: 'display-primary',
      displayLabel: 'Primary Display',
      width: 1280,
      height: 720,
      startedAtMs,
      updatedAtMs: startedAtMs + 5_000,
      segmentDurationSeconds: 5,
      segmentCount: 1,
      playableSegmentCount: 1,
      pendingSegmentCount: 0,
      totalSegmentBytes: 5,
      retainedSegmentBytes: 5,
      sampleIntervalMs: 250,
      targetFps: 4,
      encoderAvailable: true,
      warningCount: 0,
    },
  ]);

  writeFileSync(path.join(videoDir, 'segment-0001.mp4'), Buffer.from([0, 1, 2, 3, 4]));
  appendNdjson(path.join(sessionDir, 'video', 'segments.ndjson'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      segmentId: `${sessionId}-segment-1`,
      sessionId,
      streamId: 'vs-primary',
      status: 'ready',
      displayId: 'display-primary',
      startedAtMs,
      endedAtMs: startedAtMs + 5_000,
      durationMs: 5_000,
      relativePath: 'video/streams/vs-primary/segment-0001.mp4',
      sizeBytes: 5,
      frameCount: 20,
      codec: 'h264',
      container: 'mp4',
      mimeType: 'video/mp4',
      encoderName: 'fixture',
      isPlayable: true,
    },
  ]);

  writeFileSync(path.join(sessionDir, 'artifacts', 'step-1-full.webp'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(sessionDir, 'artifacts', 'step-1-thumb.webp'), Buffer.from([1, 2]));

  if (version === 'v1.3') {
    appendNdjson(path.join(sessionDir, 'operations.ndjson'), [
      {
        schemaVersion: 0,
        kind: 'reqcase.test-session-operation',
        operationId: `operation-${sessionId}-save`,
        sessionId,
        sequence: 1,
        startedAtMs: stepAtMs,
        endedAtMs: stepAtMs + 120,
        relativeMsFromSessionStart: stepAtMs - startedAtMs,
        action: {
          actionId: `action-${sessionId}-save`,
          kind: 'click',
          occurredAtMs: stepAtMs,
          sourceEventIds: [`${sessionId}-event-step`],
        },
        outcome: {
          outcomeId: `outcome-${sessionId}-save`,
          status: 'legacyUnknown',
          summary: '旧记录未采集操作结果',
          observedAtMs: stepAtMs + 120,
          latencyMs: 120,
        },
        title: 'v1.3 历史操作',
        resultSummary: '旧记录未采集操作结果',
        displaySummary: 'v1.3 历史操作 -> 旧记录未采集操作结果',
        precisionLevel: 'legacy-schema-fixture',
        outcomeSelectionSource: 'auto',
        edited: true,
        ignored: false,
      },
    ]);
  }
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fingerprintDirectory(rootDir: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const stat = statSync(fullPath);
      result.set(relativePath, `${stat.size}:${hashFile(fullPath)}`);
    }
  };
  visit(rootDir);
  return result;
}

function assertFingerprintsEqual(before: Map<string, string>, after: Map<string, string>): void {
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
}

async function assertSessionMatrix(session: ReqCaseShadowRecorderTestSessionState, exportRoot: string): Promise<void> {
  const before = fingerprintDirectory(session.sessionDir!);
  const events = readHistoricalSessionEvents(session);
  const streams = readHistoricalSessionVideoStreams(session);
  const segments = readHistoricalSessionVideoSegments(session);
  const steps = readHistoricalSessionSteps(session);
  const operationTail = readHistoricalSessionOperationsTail(session, undefined, 20);

  assert.equal(events.length, 2);
  assert.equal(events[1].eventType, 'step_captured');
  assert.equal(streams.length, 1);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].isPlayable, true);
  assert.equal(steps.length, 1);
  assert.equal(operationTail.items.length, 1);

  if (!session.sessionId.endsWith('v1-3')) {
    assert.equal(operationTail.diagnostics?.[0]?.code, 'legacyStepsAdapter');
    assert.equal(operationTail.items[0].outcome.status, 'legacyUnknown');
    assert.equal(operationTail.items[0].resultSummary, '旧记录未采集操作结果');
  } else {
    assert.equal(operationTail.diagnostics?.[0]?.code, 'legacySchema');
  }

  const eventTail = readHistoricalSessionEventsTail(session, events[0].eventId, 10);
  assert.equal(eventTail.reset, false);
  assert.equal(eventTail.items.length, 1);

  const segmentTail = readHistoricalSessionVideoSegmentsTail(session, undefined, segments[0].segmentId, 10);
  assert.equal(segmentTail.reset, false);
  assert.equal(segmentTail.items.length, 0);

  const matchedSegments = findHistoricalVideoSegmentsForTimestamp(
    session,
    events[1].occurredAtMs,
    events[1].displayId,
    3,
  );
  assert.equal(matchedSegments[0].segmentId, segments[0].segmentId);

  const reproText = renderHistoricalReproSteps(session, session.startedAtMs, session.endedAtMs, 'matrix smoke');
  assert.match(reproText, /复现步骤/);
  assert.match(reproText, /matrix smoke/);
  // Prefer operation -> result wording; keep window/title anchors for fixture identity.
  assert.match(
    reproText,
    /点击保存按钮|按下保存快捷键|v1\.3 历史操作|Legacy v1\.[123] Window/,
  );
  assert.match(reproText, /旧记录未采集操作结果|未观测到明确结果/);

  const exportResult = await exportTestSessionEvidence(
    {
      sessionId: session.sessionId,
      targetDir: exportRoot,
      bundleName: `${session.sessionId}-export`,
      privacyAcknowledgedAt: '2026-07-31T00:00:00.000Z',
    },
    {
      session,
      events,
      videoStreams: streams,
      videoSegments: segments,
    },
  );

  assert.ok(exportResult.exportDir && existsSync(exportResult.exportDir));
  assert.equal(exportResult.eventCount, 2);
  assert.equal(exportResult.stepEventCount, 1);
  assert.equal(exportResult.playableVideoSegmentCount, 1);
  assert.ok(exportResult.operationsJsonPath && existsSync(exportResult.operationsJsonPath));

  const operationsJson = JSON.parse(readFileSync(exportResult.operationsJsonPath!, 'utf8')) as {
    records: Array<{ matchedVideoRelativePath?: string; seekSeconds?: number }>;
  };
  assert.equal(operationsJson.records[1].matchedVideoRelativePath, 'video/streams/vs-primary/segment-0001.mp4');
  assert.equal(operationsJson.records[1].seekSeconds, 1.25);

  assertFingerprintsEqual(before, fingerprintDirectory(session.sessionDir!));
}

async function run(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-historical-matrix-'));
  try {
    const sessionsRoot = path.join(tempRoot, 'reports', 'test-sessions');
    mkdirSync(sessionsRoot, { recursive: true });
    createHistoricalFixture(sessionsRoot, 'v1.1');
    createHistoricalFixture(sessionsRoot, 'v1.2');
    createHistoricalFixture(sessionsRoot, 'v1.3');

    const sessions = listHistoricalTestSessions(sessionsRoot);
    assert.deepEqual(
      sessions.map((session) => session.sessionId).sort(),
      ['historical-v1-1', 'historical-v1-2', 'historical-v1-3'],
    );

    const exportRoot = path.join(tempRoot, 'exports');
    for (const session of sessions) {
      await assertSessionMatrix(session, exportRoot);
    }

    console.log('[historical-session-matrix-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[historical-session-matrix-test] FAIL', error);
  process.exitCode = 1;
});
