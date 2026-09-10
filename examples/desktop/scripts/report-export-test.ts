import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportShadowRecorderReport } from '../src-electron/modules/reqcase-shadow-recorder/report-export';
import type { ReqCaseShadowRecorderStep } from '../src-electron/modules/reqcase-shadow-recorder/types';

function buildStep(id: number, timestampMs: number): ReqCaseShadowRecorderStep {
  return {
    id: String(id),
    timestampMs,
    action: 'click',
    x: 200,
    y: 180,
    windowLeft: 100,
    windowTop: 100,
    windowRight: 900,
    windowBottom: 700,
    processName: 'demo.exe',
    windowTitle: 'Demo Window',
    imageWebpBase64: 'AAAA',
    captureBackend: 'wgc',
  };
}

async function run(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'shadow-recorder-report-export-test-'));
  try {
    const generatedAtMs = 1735689600000;

    const result = await exportShadowRecorderReport(
      {
        targetDir: tempRoot,
        title: 'report-export-basic-test',
        generatedAtMs,
      },
      [buildStep(1, generatedAtMs)],
    );

    assert.equal(existsSync(result.htmlPath), true, 'htmlPath should exist');
    assert.equal(existsSync(result.manifestPath), true, 'manifestPath should exist');
    assert.equal(result.imageCount, 1);

    const reportHtml = readFileSync(result.htmlPath, 'utf-8');
    assert.equal(reportHtml.includes('步骤回顾'), true, 'report html should include steps section');
    assert.equal(reportHtml.includes('Demo Window'), true, 'report html should include step window title');

    const reportWithTuning = await exportShadowRecorderReport(
      {
        targetDir: tempRoot,
        title: 'report-export-capture-reuse-flag-test',
        generatedAtMs: generatedAtMs + 11,
        tuningSummary: {
          profile: 'stability',
          reason: 'test tuning summary',
          config: {
            captureReuseEnabled: false,
          },
        },
      },
      [buildStep(21, generatedAtMs + 11)],
    );
    const htmlWithTuning = readFileSync(reportWithTuning.htmlPath, 'utf-8');
    assert.equal(
      htmlWithTuning.includes('<strong>捕获上下文复用:</strong> 已禁用'),
      true,
      'report html should include capture reuse status',
    );

    const liteResult = await exportShadowRecorderReport(
      {
        targetDir: tempRoot,
        title: 'report-export-lite-manifest-test',
        manifestMode: 'lite',
        generatedAtMs: generatedAtMs + 2,
      },
      [buildStep(3, generatedAtMs + 2)],
    );
    const liteManifest = JSON.parse(readFileSync(liteResult.manifestPath, 'utf-8')) as {
      manifestMode: 'full' | 'lite';
      steps?: unknown[];
      stepIndex?: unknown[];
    };
    assert.equal(liteManifest.manifestMode, 'lite');
    assert.equal(Array.isArray(liteManifest.steps), false);
    assert.equal(Array.isArray(liteManifest.stepIndex), true);
    assert.equal(liteManifest.stepIndex?.length, 1);

    const defaultManifestResult = await exportShadowRecorderReport(
      {
        targetDir: tempRoot,
        title: 'report-export-default-manifest-test',
        generatedAtMs: generatedAtMs + 3,
      },
      [buildStep(4, generatedAtMs + 3)],
    );
    const defaultManifest = JSON.parse(readFileSync(defaultManifestResult.manifestPath, 'utf-8')) as {
      manifestMode: 'full' | 'lite';
      steps?: unknown[];
      stepIndex?: unknown[];
    };
    assert.equal(defaultManifest.manifestMode, 'full');
    assert.equal(Array.isArray(defaultManifest.steps), true);
    assert.equal(defaultManifest.steps?.length, 1);
    assert.equal(defaultManifest.stepIndex, undefined);

    const reportWithSnapshot = await exportShadowRecorderReport(
      {
        targetDir: tempRoot,
        title: 'report-export-tuning-snapshot-test',
        generatedAtMs: generatedAtMs + 4,
        tuningSummary: {
          profile: 'latency',
          reason: 'snapshot validation',
          config: {
            captureReuseEnabled: true,
            webpQuality: 70,
          },
          metrics: {
            capturedStepsTotal: 2,
            droppedStepsTotal: 0,
            inputChannelFullDropTotal: 0,
            pushDispatchDropTotal: 0,
            bufferSteps: 2,
            bufferBytes: 4096,
            lastCaptureLatencyMs: 20,
            lastEncodeLatencyMs: 10,
            lastImageBytes: 1024,
            currentEffectiveQuality: 70,
            qualityAdjustDownCount: 0,
            qualityAdjustUpCount: 0,
            wgcCaptureCount: 2,
            dxgiCaptureCount: 0,
          },
        },
      },
      [buildStep(5, generatedAtMs + 4)],
    );
    assert.ok(reportWithSnapshot.tuningSnapshotPath, 'tuningSnapshotPath should be returned');
    assert.equal(existsSync(reportWithSnapshot.tuningSnapshotPath as string), true);

    console.log('[report-export-test] PASS');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error('[report-export-test] FAIL', error);
  process.exitCode = 1;
});
