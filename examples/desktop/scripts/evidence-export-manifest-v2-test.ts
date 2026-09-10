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

    const manifestV2Path = path.join(result.exportDir!, 'manifest.v2.json');
    assert.ok(existsSync(manifestV2Path));
    assert.equal(result.manifestV2Path, manifestV2Path);
    assert.equal(result.manifestV2RelativePath, 'manifest.v2.json');

    const manifest = JSON.parse(readFileSync(manifestV2Path, 'utf-8')) as {
      version: number;
      session_id: string;
      created_at_ms: number;
      app_version: string;
      native_version: string;
      capture_config: { targetCaptureMode?: string };
      operations_schema_version: number;
      operations_builder_version: string;
      operations_kind: string;
      operations_json_path: string;
      operations_csv_path: string;
      files: Array<{ relative_path: string; bytes: number; sha256: string }>;
    };
    assert.equal(manifest.version, 2);
    assert.equal(manifest.session_id, session.sessionId);
    assert.equal(manifest.created_at_ms, result.generatedAtMs);
    assert.equal(manifest.app_version, '0.1.1');
    assert.equal(manifest.native_version, '0.1.0');
    assert.equal(manifest.capture_config.targetCaptureMode, 'target_display');
    assert.equal(manifest.operations_schema_version, 1);
    assert.equal(manifest.operations_builder_version, 'evidence-timeline-v1');
    assert.equal(manifest.operations_kind, 'reqcase.test-session-operation-records');
    assert.equal(manifest.operations_json_path, 'operations.json');
    assert.equal(manifest.operations_csv_path, 'operations.csv');
    assert.ok(manifest.files.some((entry) => entry.relative_path === 'manifest.json'));
    assert.ok(manifest.files.some((entry) => entry.relative_path === 'sha256-manifest.json'));
    assert.ok(manifest.files.every((entry) => entry.relative_path !== 'manifest.v2.json'));

    const operations = JSON.parse(readFileSync(result.operationsJsonPath!, 'utf-8')) as {
      schemaVersion: number;
      kind: string;
      builderVersion: string;
    };
    assert.equal(operations.schemaVersion, manifest.operations_schema_version);
    assert.equal(operations.kind, manifest.operations_kind);
    assert.equal(operations.builderVersion, manifest.operations_builder_version);

    const checksumManifest = JSON.parse(readFileSync(result.checksumManifestPath!, 'utf-8')) as {
      files: Array<{ relativePath: string }>;
    };
    assert.ok(checksumManifest.files.some((entry) => entry.relativePath === 'manifest.json'));
    assert.ok(checksumManifest.files.every((entry) => entry.relativePath !== 'manifest.v2.json'));

    console.log('[evidence-export-manifest-v2-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[evidence-export-manifest-v2-test] FAIL', error);
  process.exitCode = 1;
});
