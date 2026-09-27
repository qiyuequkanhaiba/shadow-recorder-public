import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportTestSessionEvidence } from '../src-electron/modules/reqcase-shadow-recorder/evidence-export';
import type {
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
} from '../src-electron/modules/reqcase-shadow-recorder/types';

async function run(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-manifest-v2-test-'));

  try {
    const sourceSessionDir = path.join(tempRoot, 'source-session');
    mkdirSync(sourceSessionDir, { recursive: true });
    writeFileSync(
      path.join(sourceSessionDir, 'session.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'reqcase.test-session' }, null, 2),
      'utf-8',
    );

    const session: ReqCaseShadowRecorderTestSessionState = {
      schemaVersion: 1,
      kind: 'reqcase.test-session',
      sessionId: '42',
      name: 'Manifest V2 Smoke',
      status: 'stopped',
      startedAtMs: 1710000000000,
      updatedAtMs: 1710000005000,
      endedAtMs: 1710000010000,
      storageRootDir: tempRoot,
      sessionDir: sourceSessionDir,
      manifestPath: path.join(sourceSessionDir, 'session.json'),
      bufferWindowSeconds: 90,
      segmentDurationSeconds: 5,
      recordingProfile: 'balanced',
      encoderPreference: 'auto',
      targetCaptureMode: 'target_display',
      targetDisplayId: 'display-primary',
    };
    const events: ReqCaseShadowRecorderTestSessionTimelineEvent[] = [
      {
        schemaVersion: 1,
        kind: 'reqcase.test-session-event',
        eventId: 'evt-1',
        sessionId: session.sessionId,
        eventType: 'session_started',
        logCategory: 'recording',
        occurredAtMs: 1710000000000,
        status: 'active',
        message: 'session started',
      },
    ];

    const result = await exportTestSessionEvidence(
      {
        sessionId: session.sessionId,
        targetDir: path.join(tempRoot, 'exports'),
        bundleName: 'manifest-v2-smoke',
      },
      { session, events, videoStreams: [], videoSegments: [] },
    );

    assert.equal(existsSync(path.join(result.exportDir!, 'manifest.v2.json')), false);
    assert.equal(existsSync(path.join(result.exportDir!, 'summary.html')), false);
    assert.equal(result.eventsLogRelativePath, 'events.json');
    const exportedEvents = JSON.parse(readFileSync(result.eventsLogPath!, 'utf-8')) as {
      sessionId: string;
      records: Array<{ eventId: string }>;
    };
    assert.equal(exportedEvents.sessionId, session.sessionId);
    assert.equal(exportedEvents.records[0]?.eventId, 'evt-1');
    const operations = JSON.parse(readFileSync(result.operationsJsonPath!, 'utf-8')) as {
      records: unknown[];
    };
    assert.deepEqual(operations.records, []);

    console.log('[evidence-export-manifest-v2-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[evidence-export-manifest-v2-test] FAIL', error);
  process.exitCode = 1;
});
