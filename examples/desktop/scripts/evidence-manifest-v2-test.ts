import { strict as assert } from 'node:assert';

import { buildEvidenceManifestV2 } from '../src-electron/modules/reqcase-shadow-recorder/evidence-manifest';

function run(): void {
  const manifest = buildEvidenceManifestV2({
    sessionId: 42,
    createdAtMs: 1_710_000_000_000,
    appVersion: '0.1.1',
    nativeVersion: '0.1.0',
    os: 'windows',
    captureConfig: { captureMode: 'target_display' },
    operationsSchemaVersion: 1,
    operationsBuilderVersion: 'evidence-timeline-v1',
    operationsKind: 'reqcase.test-session-operation-records',
    operationsJsonRelativePath: 'operations.json',
    operationsCsvRelativePath: 'operations.csv',
    checksums: [
      { relativePath: 'manifest.json', sizeBytes: 256, sha256: 'manifest-hash' },
      { relativePath: 'sha256-manifest.json', sizeBytes: 128, sha256: 'checksum-hash' },
      { relativePath: 'summary.html', sizeBytes: 12, sha256: 'summary-hash' },
    ],
  });

  assert.equal(manifest.version, 2);
  assert.equal(manifest.session_id, 42);
  assert.equal(manifest.created_at_ms, 1_710_000_000_000);
  assert.equal(manifest.app_version, '0.1.1');
  assert.equal(manifest.native_version, '0.1.0');
  assert.equal(manifest.os, 'windows');
  assert.deepEqual(manifest.capture_config, { captureMode: 'target_display' });
  assert.equal(manifest.operations_schema_version, 1);
  assert.equal(manifest.operations_builder_version, 'evidence-timeline-v1');
  assert.equal(manifest.operations_kind, 'reqcase.test-session-operation-records');
  assert.equal(manifest.operations_json_path, 'operations.json');
  assert.equal(manifest.operations_csv_path, 'operations.csv');
  assert.deepEqual(manifest.files, [
    { relative_path: 'manifest.json', bytes: 256, sha256: 'manifest-hash' },
    { relative_path: 'sha256-manifest.json', bytes: 128, sha256: 'checksum-hash' },
    { relative_path: 'summary.html', bytes: 12, sha256: 'summary-hash' },
  ]);

  console.log('[evidence-manifest-v2-test] PASS');
}

run();
