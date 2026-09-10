import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload, RecorderMetrics } from '../types/contracts';
import * as recorderPageBindings from '../src-react/lib/recorder-page-bindings';

const {
  createRecorderRuntimeInput,
  createTuningAdvisorInput,
} = recorderPageBindings;

function createSetStateDispatch<T>(): Dispatch<SetStateAction<T>> {
  return (() => undefined) as unknown as Dispatch<SetStateAction<T>>;
}

function createSetErrorDispatch(): Dispatch<SetStateAction<string>> {
  return createSetStateDispatch<string>();
}

function testCreateRecorderRuntimeInput(): void {
  const config: RecorderConfigPayload = { transportMode: 'push' };
  const setError = createSetErrorDispatch();
  const toUiErrorMessage = () => 'error';

  const mapped = createRecorderRuntimeInput({
    config,
    setError,
    toUiErrorMessage,
  });

  assert.equal(mapped.config, config);
  assert.equal(mapped.onError, setError);
  assert.equal(mapped.toUiErrorMessage, toUiErrorMessage);
}

function testCreateTuningAdvisorInput(): void {
  const config: RecorderConfigPayload = {};
  const metrics: RecorderMetrics | null = null;
  const setConfig = createSetStateDispatch<RecorderConfigPayload>();
  const setError = createSetErrorDispatch();
  const toUiErrorMessage = () => 'error';

  const mapped = createTuningAdvisorInput({
    config,
    setConfig,
    metrics,
    setError,
    toUiErrorMessage,
  });

  assert.equal(mapped.config, config);
  assert.equal(mapped.setConfig, setConfig);
  assert.equal(mapped.metrics, metrics);
  assert.equal(mapped.onError, setError);
  assert.equal(mapped.toUiErrorMessage, toUiErrorMessage);
}

function testSemanticRecordingEnabledUsesEitherCompatibilityFlag(): void {
  const resolve = (recorderPageBindings as Record<string, unknown>).isSemanticRecordingEnabled;
  assert.equal(typeof resolve, 'function', 'semantic recording state resolver must be exported');
  const isSemanticRecordingEnabled = resolve as (config: RecorderConfigPayload) => boolean;

  assert.equal(
    isSemanticRecordingEnabled({ semanticRecordingEnabled: false, defectEvidenceEnabled: true }),
    true,
    'legacy defect-evidence flag remains enabled when the newer semantic flag is explicitly false',
  );
  assert.equal(isSemanticRecordingEnabled({ semanticRecordingEnabled: true }), true);
  assert.equal(isSemanticRecordingEnabled({ defectEvidenceEnabled: true }), true);
  assert.equal(isSemanticRecordingEnabled({ semanticRecordingEnabled: false, defectEvidenceEnabled: false }), false);
}


function testRecorderPageMountsRecordingReviewPanel(): void {
  const source = readFileSync(new URL('../src-react/pages/RecorderPage.tsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /activeTab === 'evidence'\s*\?\s*\(\s*<section[\s\S]*id="panel-evidence"[\s\S]*aria-labelledby="tab-evidence"[\s\S]*<RecordingReviewPanel/,
  );
  assert.ok(source.includes('session={dashboard.selectedSession ?? dashboard.activeSession}'));
  assert.ok(source.includes('enabled={semanticRecordingEnabled}'));
  assert.ok(source.includes('preWindowSeconds={config.defectPreWindowSeconds}'));
  assert.ok(source.includes('postWindowSeconds={config.defectPostWindowSeconds}'));
  assert.ok(source.includes('onPlaybackFocusChange={setPlaybackFocus}'));
  assert.ok(source.includes("onOpenSettings={() => setActiveTab('settings')}"));
  assert.ok(source.includes('onClearEvents'));
  assert.ok(source.includes('onNotice={showToast}'));
  assert.ok(source.includes('dashboard.deleteSessions'));
  assert.ok(source.includes('删除所选'));
}
function testDefectEvidenceBridgeIsWired(): void {
  const panelSource = readFileSync(new URL('../src-react/features/evidence/RecordingReviewPanel.tsx', import.meta.url), 'utf8');
  const preloadSource = readFileSync(new URL('../src-electron/preload.ts', import.meta.url), 'utf8');
  const ipcSource = readFileSync(
    new URL('../src-electron/modules/reqcase-shadow-recorder/ipc.ts', import.meta.url),
    'utf8',
  );

  for (const snippet of [
    'api.markTestDefect',
    'api.getTestSessionSteps',
    'api.rebuildTestSessionSteps',
    'api.renderTestSessionReproSteps',
    'api.exportTestDefectPack',
    'api.updateTestSessionStep',
  ]) {
    assert.ok(panelSource.includes(snippet), snippet);
  }

  for (const snippet of [
    'markTestDefect',
    'purgeTestSessionEvents',
    'deleteTestSession',
    'getTestSessionSteps',
    'rebuildTestSessionSteps',
    'renderTestSessionReproSteps',
    'exportTestDefectPack',
    'updateTestSessionStep',
  ]) {
    assert.ok(preloadSource.includes(snippet), snippet);
  }

  for (const channel of [
    'mark-test-defect',
    'purge-test-session-events',
    'delete-test-session',
    'get-test-session-steps',
    'rebuild-test-session-steps',
    'render-test-session-repro-steps',
    'export-test-defect-pack',
    'update-test-session-step',
  ]) {
    assert.ok(ipcSource.includes(channel), channel);
  }
}
function run(): void {
  testCreateRecorderRuntimeInput();
  testCreateTuningAdvisorInput();
  testSemanticRecordingEnabledUsesEitherCompatibilityFlag();
  testRecorderPageMountsRecordingReviewPanel();
  testDefectEvidenceBridgeIsWired();
  console.log('[recorder-page-bindings-test] PASS');
}

run();
