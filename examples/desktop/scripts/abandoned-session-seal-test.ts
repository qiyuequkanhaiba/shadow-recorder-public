import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  listHistoricalTestSessions,
  sealAbandonedRecordingSessions,
} from '../src-electron/modules/reqcase-shadow-recorder/historical-session-reader';

const root = mkdtempSync(path.join(tmpdir(), 'abandoned-session-seal-'));

function writeSession(sessionId: string, status: string, endedAtMs?: number): string {
  const sessionDir = path.join(root, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const manifestPath = path.join(sessionDir, 'session.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId,
    name: sessionId,
    status,
    startedAtMs: 1_000,
    updatedAtMs: 5_000,
    endedAtMs,
    storageRootDir: root,
    sessionDir,
    manifestPath,
  }, null, 2)}\n`);
  return manifestPath;
}

try {
  const orphanPath = writeSession('orphan-active', 'active');
  const pausedPath = writeSession('orphan-paused', 'paused');
  const livePath = writeSession('live-now', 'active');
  const stoppedPath = writeSession('already-stopped', 'stopped', 5_000);
  const stoppedBefore = statSync(stoppedPath).mtimeMs;

  const sealed = sealAbandonedRecordingSessions(root, new Set(['live-now']));
  assert.equal(sealed, 2);

  const orphan = JSON.parse(readFileSync(orphanPath, 'utf8')) as { status: string; endedAtMs: number };
  const paused = JSON.parse(readFileSync(pausedPath, 'utf8')) as { status: string; endedAtMs: number };
  const live = JSON.parse(readFileSync(livePath, 'utf8')) as { status: string; endedAtMs?: number };
  assert.equal(orphan.status, 'stopped');
  assert.equal(orphan.endedAtMs, 5_000);
  assert.equal(paused.status, 'stopped');
  assert.equal(paused.endedAtMs, 5_000);
  assert.equal(live.status, 'active');
  assert.equal(live.endedAtMs, undefined);
  assert.equal(statSync(stoppedPath).mtimeMs, stoppedBefore);

  const listed = listHistoricalTestSessions(root);
  assert.equal(listed.find((session) => session.sessionId === 'orphan-active')?.status, 'stopped');
  assert.equal(listed.find((session) => session.sessionId === 'live-now')?.status, 'active');

  const again = sealAbandonedRecordingSessions(root, new Set(['live-now']));
  assert.equal(again, 0);

  const serviceSource = readFileSync(
    path.join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/service.ts'),
    'utf8',
  );
  assert.match(serviceSource, /sealAbandonedRecordingSessions\(this\.resolveTestSessionsRoot\(\), liveSessionIds\)/);

  const mainSource = readFileSync(path.join(__dirname, '../src-electron/main.ts'), 'utf8');
  const quitHandler = mainSource.slice(mainSource.indexOf("app.on('before-quit'"));
  assert.match(quitHandler, /recorderService\?\.isRecording\(\)[\s\S]*recorderService\.stop\(\)/);

  console.log('abandoned-session-seal-test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
