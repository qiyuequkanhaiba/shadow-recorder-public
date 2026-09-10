import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildDiagnosticsBundle,
  createRecentErrorLog,
  exportDiagnosticsBundle,
} from '../src-electron/modules/reqcase-shadow-recorder/diagnostics';

function testBundleContainsOnlySafeFields(): void {
  const bundle = buildDiagnosticsBundle({
    appVersion: '0.1.1',
    nativeLoaded: true,
    lastMetrics: { capturedStepsTotal: 3, bufferBytes: 1024 },
    recentErrors: ['renderer crashed'],
    now: new Date('2026-05-17T00:00:00.000Z'),
    platform: 'win32',
    arch: 'x64',
  });

  assert.deepEqual(Object.keys(bundle).sort(), [
    'appVersion',
    'arch',
    'createdAt',
    'lastMetrics',
    'nativeLoaded',
    'platform',
    'recentErrors',
  ]);
  assert.equal(bundle.createdAt, '2026-05-17T00:00:00.000Z');
  assert.equal(bundle.appVersion, '0.1.1');
  assert.equal(bundle.platform, 'win32');
  assert.equal(bundle.arch, 'x64');
  assert.equal(bundle.nativeLoaded, true);
  assert.deepEqual(bundle.lastMetrics, { capturedStepsTotal: 3, bufferBytes: 1024 });
  assert.deepEqual(bundle.recentErrors, ['renderer crashed']);

  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes('imageWebpBase64'), false);
  assert.equal(serialized.includes('clipboard'), false);
  assert.equal(serialized.includes('windowTitle'), false);
  assert.equal(serialized.includes('.mp4'), false);
}

function testRecentErrorLogIsBoundedAndSanitized(): void {
  const log = createRecentErrorLog(2);

  log.record('first failure');
  log.record('second failure with secret window title that is deliberately very long'.repeat(8));
  log.record(new Error('third failure'));

  const errors = log.list();
  assert.equal(errors.length, 2);
  assert.equal(errors[0].startsWith('second failure'), true);
  assert.equal(errors[0].length <= 260, true);
  assert.equal(errors[1].includes('third failure'), true);

  log.clear();
  log.record('windowTitle=Sensitive Customer Portal clipboardText=secret imageWebpBase64=abc video=C:/tmp/a.mp4');
  const redactedError = log.list()[0];
  assert.equal(redactedError.includes('Sensitive Customer Portal'), false);
  assert.equal(redactedError.includes('secret'), false);
  assert.equal(redactedError.includes('imageWebpBase64'), false);
  assert.equal(redactedError.includes('.mp4'), false);
}

async function testExportWritesJsonAndZipOnlyWhenCalled(): Promise<void> {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-diagnostics-test-'));
  try {
    const result = await exportDiagnosticsBundle({
      targetDir,
      appVersion: '0.1.1',
      nativeLoaded: false,
      recentErrors: [],
      now: new Date('2026-05-17T00:00:00.000Z'),
      platform: 'win32',
      arch: 'x64',
    });

    assert.equal(existsSync(result.bundlePath), true);
    assert.equal(existsSync(result.zipPath), true);
    assert.equal(path.basename(result.zipPath), 'shadow-recorder-diagnostics-20260517-000000.zip');

    const parsed = JSON.parse(readFileSync(result.bundlePath, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed.nativeLoaded, false);
    assert.equal(parsed.createdAt, '2026-05-17T00:00:00.000Z');
    assert.equal(Object.hasOwn(parsed, 'screenshots'), false);
    assert.equal(Object.hasOwn(parsed, 'videos'), false);
    assert.equal(Object.hasOwn(parsed, 'clipboardText'), false);
    assert.equal(Object.hasOwn(parsed, 'windowTitle'), false);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  testBundleContainsOnlySafeFields();
  testRecentErrorLogIsBoundedAndSanitized();
  await testExportWritesJsonAndZipOnlyWhenCalled();
  console.log('[diagnostics-test] PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
