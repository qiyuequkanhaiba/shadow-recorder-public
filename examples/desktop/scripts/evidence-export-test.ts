import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { exportTestSessionEvidence } from '../src-electron/modules/reqcase-shadow-recorder/evidence-export';
import { buildChecksumEntries } from '../src-electron/modules/reqcase-shadow-recorder/evidence-archive';
import { renderEvidenceHtml } from '../src-electron/modules/reqcase-shadow-recorder/evidence-html';
import { buildEvidenceManifest } from '../src-electron/modules/reqcase-shadow-recorder/evidence-manifest';
import type {
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoStream,
} from '../src-electron/modules/reqcase-shadow-recorder/types';

function buildSession(sessionDir: string): ReqCaseShadowRecorderTestSessionState {
  return {
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId: 'ts-evidence-1',
    name: 'Evidence Smoke',
    status: 'stopped',
    startedAtMs: 1710000000000,
    updatedAtMs: 1710000005000,
    endedAtMs: 1710000010000,
    storageRootDir: path.dirname(sessionDir),
    sessionDir,
    manifestPath: path.join(sessionDir, 'session.json'),
    bufferWindowSeconds: 90,
    segmentDurationSeconds: 5,
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    notes: 'evidence export smoke test',
    targetCaptureMode: 'target_display',
    targetDisplayId: 'display-primary',
  };
}

function buildEvents(sessionId: string): ReqCaseShadowRecorderTestSessionTimelineEvent[] {
  return [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-1',
      sessionId,
      eventType: 'session_started',
      logCategory: 'recording',
      occurredAtMs: 1710000000000,
      status: 'active',
      message: 'session started',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-2',
      sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: 1710000002000,
      stepId: '42',
      action: 'WM_LBUTTONDOWN',
      processName: 'demo.exe',
      windowTitle: 'Demo Window',
      displayId: 'display-primary',
      fullImagePath: `D:/tmp/${sessionId}/step-42-full.webp`,
      thumbImagePath: `D:/tmp/${sessionId}/step-42-thumb.webp`,
    },
  ];
}

function buildStreams(sessionId: string): ReqCaseShadowRecorderTestSessionVideoStream[] {
  return [
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
      width: 1920,
      height: 1080,
      startedAtMs: 1710000000000,
      updatedAtMs: 1710000010000,
      segmentDurationSeconds: 5,
      segmentCount: 1,
      playableSegmentCount: 1,
      pendingSegmentCount: 0,
      totalSegmentBytes: 2048,
      retainedSegmentBytes: 2048,
      sampleIntervalMs: 250,
      targetFps: 4,
      encoderAvailable: true,
      warningCount: 0,
      streamDir: 'video/streams/vs-primary',
    },
  ];
}

function buildSegments(sessionId: string): ReqCaseShadowRecorderTestSessionVideoSegment[] {
  return [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      segmentId: 'seg-1',
      sessionId,
      streamId: 'vs-primary',
      status: 'ready',
      displayId: 'display-primary',
      startedAtMs: 1710000000000,
      endedAtMs: 1710000005000,
      durationMs: 5000,
      relativePath: 'video/streams/vs-primary/segment-0001.mp4',
      filePath: `D:/tmp/${sessionId}/video/streams/vs-primary/segment-0001.mp4`,
      sizeBytes: 2048,
      frameCount: 20,
      codec: 'h264',
      container: 'mp4',
      mimeType: 'video/mp4',
      encoderName: 'ffmpeg:libx264',
      isPlayable: true,
    },
  ];
}

async function run(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-evidence-export-test-'));

  try {
    const sourceSessionDir = path.join(tempRoot, 'source-session');
    mkdirSync(path.join(sourceSessionDir, 'video', 'streams', 'vs-primary'), { recursive: true });
    mkdirSync(path.join(sourceSessionDir, 'artifacts'), { recursive: true });

    writeFileSync(
      path.join(sourceSessionDir, 'session.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'reqcase.test-session' }, null, 2),
      'utf-8',
    );
    writeFileSync(
      path.join(sourceSessionDir, 'events.ndjson'),
      `${JSON.stringify({ eventId: 'evt-1' })}\n${JSON.stringify({ eventId: 'evt-2' })}\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(sourceSessionDir, 'artifacts', 'step-42-full.webp'),
      Buffer.from([1, 2, 3, 4]),
    );
    writeFileSync(
      path.join(sourceSessionDir, 'video', 'streams', 'vs-primary', 'segment-0001.mp4'),
      Buffer.from([5, 6, 7, 8, 9]),
    );

    const session = buildSession(sourceSessionDir);
    const events = buildEvents(session.sessionId);
    const streams = buildStreams(session.sessionId);
    const segments = buildSegments(session.sessionId);

    await assert.rejects(
      () => exportTestSessionEvidence(
        {
          sessionId: session.sessionId,
          targetDir: path.join(tempRoot, 'exports'),
          bundleName: 'bundle-smoke-unacknowledged',
        },
        {
          session,
          events,
          videoStreams: streams,
          videoSegments: segments,
        },
      ),
      /privacy acknowledgement is required/i,
    );

    const privacyAcknowledgedAt = '2026-05-17T12:00:00.000Z';
    const result = await exportTestSessionEvidence(
      {
        sessionId: session.sessionId,
        targetDir: path.join(tempRoot, 'exports'),
        bundleName: 'bundle-smoke',
        privacyAcknowledgedAt,
      },
      {
        session,
        events,
        videoStreams: streams,
        videoSegments: segments,
      },
    );

    assert.equal(result.privacyAcknowledgedAt, privacyAcknowledgedAt);
    assert.equal(result.sessionId, session.sessionId);
    assert.equal(result.outputMode, 'directory');
    assert.ok(result.exportDir && existsSync(result.exportDir));
    assert.ok(result.videoDirPath && existsSync(result.videoDirPath));
    assert.ok(result.eventsLogPath && existsSync(result.eventsLogPath));
    assert.ok(
      result.videoDirPath
      && existsSync(path.join(result.videoDirPath, 'recording.mp4')),
    );
    assert.equal(result.videoDirRelativePath, 'video');
    assert.equal(result.eventsLogRelativePath, 'events-timeline.md');
    assert.ok(result.manifestPath && existsSync(result.manifestPath));
    assert.ok(result.summaryHtmlPath && existsSync(result.summaryHtmlPath));
    assert.ok(result.operationsJsonPath && existsSync(result.operationsJsonPath));
    assert.ok(result.operationsCsvPath && existsSync(result.operationsCsvPath));
    assert.ok(result.checksumManifestPath && existsSync(result.checksumManifestPath));
    assert.equal(result.summaryHtmlRelativePath, 'summary.html');
    assert.equal(result.operationsJsonRelativePath, 'operations.json');
    assert.equal(result.operationsCsvRelativePath, 'operations.csv');
    assert.equal(result.checksumManifestRelativePath, 'sha256-manifest.json');
    assert.ok((result.checksumEntryCount ?? 0) >= 5);

    const exportedEvents = readFileSync(result.eventsLogPath!, 'utf-8');
    assert.match(exportedEvents, /^# Evidence Smoke 事件时间线/m);
    assert.match(exportedEvents, /显示器: Primary Display \(`display-primary`\)/);
    assert.match(exportedEvents, /事件类型: `session_started`/);
    assert.match(exportedEvents, /事件类型: `step_captured`/);
    assert.match(exportedEvents, /对应视频: `video\/recording\.mp4`/);
    assert.equal(result.eventCount, 2);
    assert.equal(result.stepEventCount, 1);
    assert.equal(result.playableVideoSegmentCount, 1);

    const manifest = JSON.parse(readFileSync(result.manifestPath!, 'utf-8')) as {
      version: number;
      session: {
        sessionId: string;
        privacyAcknowledgedAt?: string;
      };
      operations?: {
        schemaVersion: number;
        builderVersion: string;
        kind: string;
        jsonRelativePath: string;
        csvRelativePath: string;
      };
    };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.session.sessionId, session.sessionId);
    assert.equal(manifest.session.privacyAcknowledgedAt, privacyAcknowledgedAt);
    assert.deepEqual(manifest.operations, {
      schemaVersion: 1,
      builderVersion: 'evidence-timeline-v1',
      kind: 'reqcase.test-session-operation-records',
      jsonRelativePath: 'operations.json',
      csvRelativePath: 'operations.csv',
    });

    const operations = JSON.parse(readFileSync(result.operationsJsonPath!, 'utf-8')) as {
      schemaVersion: number;
      kind: string;
      builderVersion: string;
    };
    assert.equal(operations.schemaVersion, manifest.operations?.schemaVersion);
    assert.equal(operations.kind, manifest.operations?.kind);
    assert.equal(operations.builderVersion, manifest.operations?.builderVersion);

    const summaryHtml = readFileSync(result.summaryHtmlPath!, 'utf-8');
    assert.match(summaryHtml, /Evidence Smoke/);
    assert.match(summaryHtml, /operations\.json/);

    const checksumManifest = JSON.parse(readFileSync(result.checksumManifestPath!, 'utf-8')) as { files: Array<{ relativePath: string }> };
    assert.ok(checksumManifest.files.some((entry) => entry.relativePath === 'manifest.json'));
    assert.ok(checksumManifest.files.some((entry) => entry.relativePath === 'summary.html'));
    assert.ok(checksumManifest.files.some((entry) => entry.relativePath === 'operations.json'));

    const directManifest = buildEvidenceManifest({
      app: { name: 'shadow-recorder-test' },
      session: { sessionId: session.sessionId },
      files: [{ relativePath: 'summary.html' }],
      checksums: [{ relativePath: 'summary.html', sizeBytes: 12, sha256: 'abc' }],
      createdAt: '2024-01-02T03:04:05.000Z',
    });
    assert.equal(directManifest.version, 1);
    assert.equal(directManifest.createdAt, '2024-01-02T03:04:05.000Z');

    const directHtml = renderEvidenceHtml({
      session: {
        sessionId: 'html-session',
        name: 'HTML Smoke',
        status: 'recording',
        targetCaptureMode: 'display',
      },
      generatedAtMs: 1710000000000,
      copyStats: { fileCount: 1, byteCount: 12 },
      eventCount: 0,
      stepEventCount: 0,
      videoStreams: [],
      videoSegments: [],
      viewModel: {
        playableSegmentViews: [],
        eventViews: [],
        defaultEventIndex: -1,
        defaultSegmentIndex: undefined,
        categoryOptions: [],
        displayOptions: [],
      },
      manifestPath: 'manifest.json',
      operationsJsonPath: 'operations.json',
      operationsCsvPath: 'operations.csv',
      checksumManifestPath: 'sha256-manifest.json',
    });
    assert.match(directHtml, /HTML Smoke/);
    assert.match(directHtml, /evidence-player/);
    assert.match(directHtml, /log-category-filter/);
    assert.match(directHtml, /matched-only/);

    const directChecksums = await buildChecksumEntries(result.exportDir!);
    assert.ok(directChecksums.some((entry) => entry.relativePath === 'summary.html'));

    const zipResult = await exportTestSessionEvidence(
      {
        sessionId: session.sessionId,
        targetDir: path.join(tempRoot, 'exports'),
        bundleName: 'bundle-zip-smoke',
        outputMode: 'zip',
        privacyAcknowledgedAt,
      },
      {
        session,
        events,
        videoStreams: streams,
        videoSegments: segments,
      },
    );

    assert.equal(zipResult.privacyAcknowledgedAt, privacyAcknowledgedAt);
    assert.equal(zipResult.outputMode, 'zip');
    assert.ok(zipResult.zipPath);
    assert.ok(existsSync(zipResult.zipPath!));
    assert.equal(zipResult.artifactPath, zipResult.zipPath);
    assert.equal(zipResult.bundleRootName.startsWith('evidence-bundle-zip-smoke-'), true);
    assert.equal(zipResult.exportDir, undefined);
    assert.equal(zipResult.manifestPath, undefined);
    assert.equal(zipResult.videoDirPath, undefined);
    assert.equal(zipResult.eventsLogPath, undefined);
    assert.equal(zipResult.videoDirRelativePath, 'video');
    assert.equal(zipResult.eventsLogRelativePath, 'events-timeline.md');
    assert.equal(zipResult.summaryHtmlPath, undefined);
    assert.equal(zipResult.checksumManifestPath, undefined);
    assert.equal(zipResult.artifactSha256Path, undefined);

    const customZipResult = await exportTestSessionEvidence(
      {
        sessionId: session.sessionId,
        targetDir: path.join(tempRoot, 'exports'),
        bundleName: 'bundle-custom-zip-name',
        outputMode: 'zip',
        zipFileName: '\u7528\u6237\u81ea\u5b9a\u4e49\u8bc1\u636e\u5305',
        privacyAcknowledgedAt,
      },
      {
        session,
        events,
        videoStreams: streams,
        videoSegments: segments,
      },
    );

    const expectedCustomZipPath = path.join(tempRoot, 'exports', '\u7528\u6237\u81ea\u5b9a\u4e49\u8bc1\u636e\u5305.zip');
    assert.equal(customZipResult.zipPath, expectedCustomZipPath);
    assert.equal(customZipResult.artifactPath, expectedCustomZipPath);
    assert.ok(existsSync(expectedCustomZipPath));
    assert.equal(customZipResult.bundleRootName.startsWith('evidence-bundle-custom-zip-name-'), true);

    console.log('[evidence-export-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[evidence-export-test] FAIL', error);
  process.exitCode = 1;
});
