import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

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

function assertUntrustedEvidenceTextIsNotExecutable(): void {
  const imagePayload = '<img src=x onerror=alert(1)>';
  const scriptPayload = '</script><script>alert(1)</script>';
  const combined = `${imagePayload}${scriptPayload}`;
  const html = renderEvidenceHtml({
    session: {
      sessionId: 'html-xss',
      name: 'XSS Smoke',
      status: 'stopped',
      targetCaptureMode: 'target_display',
    },
    generatedAtMs: 1710000000000,
    copyStats: { fileCount: 1, byteCount: 12 },
    eventCount: 1,
    stepEventCount: 1,
    videoStreams: [],
    videoSegments: [],
    viewModel: {
      playableSegmentViews: [{
        segmentId: 'seg-xss',
        streamId: 'vs-xss',
        relativePath: 'video/segment.mp4',
        startedAtMs: 1710000000000,
        endedAtMs: 1710000005000,
        durationMs: 5000,
        label: combined,
        meta: combined,
        fileLabel: combined,
      }],
      eventViews: [{
        eventId: 'evt-xss',
        eventType: 'step_captured',
        logCategory: 'operation',
        logCategoryLabel: '操作',
        level: 'info',
        levelLabel: 'INFO',
        occurredAtMs: 1710000001000,
        occurredAtLabel: '2024-03-09 20:00:01',
        summary: combined,
        detail: [combined, combined, combined].join(' · '),
        processName: combined,
        windowTitle: combined,
        message: combined,
        segmentIndex: 0,
        seekSeconds: 1,
        matchLabel: combined,
      }],
      defaultEventIndex: 0,
      defaultSegmentIndex: 0,
      categoryOptions: [{ value: 'operation', label: '操作' }],
      displayOptions: [],
    },
    manifestPath: 'manifest.json',
    operationsJsonPath: 'operations.json',
    operationsCsvPath: 'operations.csv',
    checksumManifestPath: 'sha256-manifest.json',
  });

  const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.ok(pageScript.length > 0);
  assert.equal(pageScript.includes('innerHTML'), false);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(/<\/script>\s*<script/i.test(html), false);
  assert.ok(html.includes('onerror=alert(1)'));
  assert.ok(html.includes('alert(1)'));

  const rendered = executeEvidencePage(html);
  assert.equal(rendered.tags.includes('IMG'), false);
  assert.equal(rendered.tags.includes('SCRIPT'), false);
  assert.ok(rendered.text.includes(imagePayload));
  assert.ok(rendered.text.includes(scriptPayload));
  assert.ok(rendered.text.includes(combined));
}

function executeEvidencePage(html: string): { tags: string[]; text: string } {
  const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!pageScript) {
    throw new Error('evidence page is missing its script');
  }

  class FakeElement {
    tagName: string;
    children: FakeElement[] = [];
    leafText = '';
    attrs: Record<string, string> = {};
    className = '';
    type = '';
    value = '';
    checked = false;
    hidden = false;
    src = '';

    constructor(tagName: string) {
      this.tagName = tagName.toUpperCase();
    }

    set textContent(value: string) {
      this.leafText = value == null ? '' : String(value);
      this.children = [];
    }

    get textContent(): string {
      if (this.children.length === 0) {
        return this.leafText;
      }
      return this.children.map((child) => child.textContent).join('');
    }

    set innerHTML(value: string) {
      const htmlValue = String(value ?? '');
      this.children = [];
      this.leafText = '';
      if (!htmlValue) {
        return;
      }
      const found = htmlValue.match(/<\s*([a-zA-Z0-9]+)/g) ?? [];
      for (const token of found) {
        this.children.push(new FakeElement(token.replace(/<\s*/, '')));
      }
      this.leafText = htmlValue.replace(/<[^>]*>/g, '');
    }

    appendChild(child: FakeElement): FakeElement {
      this.children.push(child);
      return child;
    }

    replaceChildren(...nodes: FakeElement[]): void {
      this.children = [...nodes];
      this.leafText = '';
    }

    addEventListener(): void {}

    setAttribute(name: string, value: string): void {
      this.attrs[name] = String(value);
    }

    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }

    load(): void {}
  }

  class HTMLVideoElement extends FakeElement {
    constructor() {
      super('video');
    }
  }

  const elements = new Map<string, FakeElement>();
  for (const id of [
    'evidence-player',
    'segment-list',
    'event-list',
    'event-empty',
    'segment-title',
    'segment-meta',
    'event-title',
    'event-meta',
    'log-category-filter',
    'display-filter',
    'event-search',
    'matched-only',
  ]) {
    elements.set(id, id === 'evidence-player' ? new HTMLVideoElement() : new FakeElement('div'));
  }

  const documentStub = {
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    createElement(tag: string) {
      return new FakeElement(tag);
    },
  };
  const context = vm.createContext({
    document: documentStub,
    HTMLVideoElement,
    console,
  });
  vm.runInContext(pageScript, context, { filename: 'evidence.html' });

  const tags: string[] = [];
  const walk = (element: FakeElement): void => {
    tags.push(element.tagName);
    for (const child of element.children) {
      walk(child);
    }
  };
  for (const element of elements.values()) {
    walk(element);
  }
  return {
    tags,
    text: [...elements.values()].map((element) => element.textContent).join('\n'),
  };
}

async function run(): Promise<void> {
  assertUntrustedEvidenceTextIsNotExecutable();
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
    const progressEvents: Array<{ percent: number; message: string }> = [];
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
      (progress) => progressEvents.push(progress),
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
    assert.equal(result.eventsLogRelativePath, 'events.json');
    assert.ok(result.operationsJsonPath && existsSync(result.operationsJsonPath));
    assert.equal(result.operationsJsonRelativePath, 'operations.json');
    assert.equal(existsSync(path.join(result.exportDir!, 'summary.html')), false);
    assert.equal(existsSync(path.join(result.exportDir!, 'operations.csv')), false);
    assert.equal(existsSync(path.join(result.exportDir!, 'manifest.json')), false);
    assert.equal(existsSync(path.join(result.exportDir!, 'manifest.v2.json')), false);
    assert.equal(existsSync(path.join(result.exportDir!, 'sha256-manifest.json')), false);
    assert.equal(progressEvents.at(-1)?.percent, 100);
    assert.equal(progressEvents.at(-1)?.message, '已完成导出');

    const exportedEvents = JSON.parse(readFileSync(result.eventsLogPath!, 'utf-8')) as {
      records: Array<{ eventType: string; videoFile: string }>;
    };
    assert.ok(exportedEvents.records.some((record) => record.eventType === 'session_started'));
    assert.ok(exportedEvents.records.some((record) => record.eventType === 'step_captured' && record.videoFile === 'video/recording.mp4'));
    assert.equal(result.eventCount, 2);
    assert.equal(result.stepEventCount, 1);
    assert.equal(result.playableVideoSegmentCount, 1);

    const operations = JSON.parse(readFileSync(result.operationsJsonPath!, 'utf-8')) as {
      schemaVersion: number;
      kind: string;
      records: unknown[];
    };
    assert.equal(operations.schemaVersion, 1);
    assert.equal(operations.kind, 'reqcase.test-session-operation-records');
    assert.deepEqual(operations.records, []);

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
    assert.ok(directChecksums.some((entry) => entry.relativePath === 'events.json'));

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
    assert.equal(zipResult.eventsLogRelativePath, 'events.json');
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


    // Range Export Test (Multi-segment filtering + videoOffsetMs remapping + paddingMs)
    writeFileSync(
      path.join(sourceSessionDir, 'video', 'streams', 'vs-primary', 'segment-0002.mp4'),
      Buffer.from([10, 11, 12, 13, 14, 15]),
    );
    const multiSegments: ReqCaseShadowRecorderTestSessionVideoSegment[] = [
      ...segments,
      {
        ...segments[0],
        segmentId: 'seg-2',
        startedAtMs: 1710000005000,
        endedAtMs: 1710000010000,
        durationMs: 5000,
        relativePath: 'video/streams/vs-primary/segment-0002.mp4',
        filePath: `D:/tmp/${session.sessionId}/video/streams/vs-primary/segment-0002.mp4`,
      },
    ];
    const multiEvents: ReqCaseShadowRecorderTestSessionTimelineEvent[] = [
      ...events,
      {
        schemaVersion: 1,
        kind: 'reqcase.test-session-event',
        eventId: 'evt-3',
        sessionId: session.sessionId,
        eventType: 'step_captured',
        logCategory: 'operation',
        occurredAtMs: 1710000007000,
        stepId: '43',
        action: 'WM_LBUTTONUP',
        processName: 'demo.exe',
        windowTitle: 'Demo Window',
        displayId: 'display-primary',
      },
    ];

    const rangeDir = path.resolve(tempRoot, 'range-export-out');
    mkdirSync(rangeDir, { recursive: true });
    const rangeResult = await exportTestSessionEvidence(
      {
        targetDir: rangeDir,
        outputMode: 'directory',
        range: {
          startMs: session.startedAtMs + 6000,
          endMs: session.startedAtMs + 8000,
        },
        paddingMs: 500,
        clipMode: 'fast',
        privacyAcknowledgedAt: new Date(session.startedAtMs).toISOString(),
      },
      {
        session,
        events: multiEvents,
        videoStreams: streams,
        videoSegments: multiSegments,
      },
    );

    assert.ok(rangeResult.range);
    // requestedStartMs / requestedEndMs preserve caller's exact input even when paddingMs is applied
    assert.equal(rangeResult.range.requestedStartMs, session.startedAtMs + 6000);
    assert.equal(rangeResult.range.requestedEndMs, session.startedAtMs + 8000);
    // In fast mode, aligned to seg-2 boundaries (5000..10000)
    assert.equal(rangeResult.range.actualStartMs, session.startedAtMs + 5000);
    assert.equal(rangeResult.range.actualEndMs, session.startedAtMs + 10000);
    assert.equal(rangeResult.clipMode, 'fast');
    assert.equal(rangeResult.exportedDurationMs, 5000);
    assert.equal(rangeResult.videoSegmentCount, 2);
    assert.equal(rangeResult.playableVideoSegmentCount, 1);
    assert.equal(rangeResult.eventCount, 1);
    assert.equal(rangeResult.stepEventCount, 1);

    // Verify exported events.json contains range and remapped videoOffsetMs relative to clipped video
    const eventsJson = JSON.parse(readFileSync(rangeResult.eventsLogPath!, 'utf-8')) as {
      range?: { requestedStartMs: number; requestedEndMs: number; actualStartMs: number; actualEndMs: number };
      records: Array<{ eventId: string; videoOffsetMs?: number; segmentId?: string }>;
    };
    assert.ok(eventsJson.range);
    assert.equal(eventsJson.range.requestedStartMs, session.startedAtMs + 6000);
    assert.equal(eventsJson.records.length, 1);
    assert.equal(eventsJson.records[0].eventId, 'evt-3');
    assert.equal(eventsJson.records[0].segmentId, 'seg-2');
    // evt-3 occurred at +7000ms, which is 2000ms into seg-2 (5000..10000ms)
    assert.equal(eventsJson.records[0].videoOffsetMs, 2000);

    // Lookback Range Export Test (lookbackSeconds = 4 seconds before session endedAtMs 1710000010000)
    const lookbackDir = path.resolve(tempRoot, "lookback-export-out");
    mkdirSync(lookbackDir, { recursive: true });
    const lookbackResult = await exportTestSessionEvidence(
      {
        targetDir: lookbackDir,
        outputMode: "directory",
        lookbackSeconds: 4,
        clipMode: "fast",
        privacyAcknowledgedAt: new Date(session.startedAtMs).toISOString(),
      },
      {
        session,
        events: multiEvents,
        videoStreams: streams,
        videoSegments: multiSegments,
      },
    );

    assert.ok(lookbackResult.range);
    assert.equal(lookbackResult.range.requestedStartMs, (session.endedAtMs ?? 0) - 4000);
    assert.equal(lookbackResult.range.requestedEndMs, session.endedAtMs);
    assert.equal(lookbackResult.bundleRootName.includes("last-4s"), true);

    console.log('[evidence-export-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[evidence-export-test] FAIL', error);
  process.exitCode = 1;
});
