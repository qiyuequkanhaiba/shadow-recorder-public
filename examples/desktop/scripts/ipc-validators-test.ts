import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ExportEvidenceInputSchema,
  GetBufferPageInputSchema,
  RecorderConfigSchema,
  RecorderSettingsSchema,
  ReplayStepGenerateInputSchema,
  TestSessionStartInputSchema,
  parseIpcInput,
} from '../src-electron/modules/reqcase-shadow-recorder/ipc-validators';
import { sanitizeRecorderSettings } from '../src-electron/modules/reqcase-shadow-recorder/settings-store';

function assertThrowsValidation(label: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, new RegExp(`${label} validation failed`));
    return true;
  });
}

function run(): void {
  const pageDefaults = parseIpcInput(GetBufferPageInputSchema, null, 'getBufferPage');
  assert.deepEqual(pageDefaults, { cursor: '0', limit: 100, includeImage: false });

  const clampedPage = parseIpcInput(
    GetBufferPageInputSchema,
    { cursor: '42', limit: 100_000, includeImage: true },
    'getBufferPage',
  );
  assert.equal(clampedPage.cursor, '42');
  assert.equal(clampedPage.limit, 1000);
  assert.equal(clampedPage.includeImage, true);

  const invalidNumberPage = parseIpcInput(
    GetBufferPageInputSchema,
    { limit: Number.POSITIVE_INFINITY },
    'getBufferPage',
  );
  assert.equal(invalidNumberPage.limit, 100);

  assertThrowsValidation('recorderConfig', () => {
    parseIpcInput(RecorderConfigSchema, [], 'recorderConfig');
  });

  assertThrowsValidation('recorderConfig', () => {
    parseIpcInput(RecorderConfigSchema, { inputMode: 'mouse' }, 'recorderConfig');
  });

  const config = parseIpcInput(
    RecorderConfigSchema,
    {
      inputMode: 'raw_input',
      captureBackend: 'wgc',
      transportMode: 'push',
      maxSteps: 500,
      semanticRecordingEnabled: true,
      uiaObserverEnabled: false,
      operationBuilderEnabled: false,
      operationReviewV2Enabled: false,
      semanticPlaintextInputEnabled: false,
    },
    'recorderConfig',
  );
  assert.equal(config.inputMode, 'raw_input');
  assert.equal(config.captureBackend, 'wgc');
  assert.equal(config.maxSteps, 500);
  assert.equal(config.semanticRecordingEnabled, true);
  assert.equal(config.uiaObserverEnabled, false);
  assert.equal(config.operationBuilderEnabled, false);
  assert.equal(config.operationReviewV2Enabled, false);
  assert.equal(config.semanticPlaintextInputEnabled, false);

  const settings = parseIpcInput(
    RecorderSettingsSchema,
    { config, autoApplyLastRecommendedProfile: true, floatingToolbarCollapsed: false },
    'recorderSettings',
  );
  assert.equal(settings.autoApplyLastRecommendedProfile, true);
  assert.equal(settings.floatingToolbarCollapsed, false);

  const sanitizedAiSettings = sanitizeRecorderSettings({
    config: {
      aiReplayProvider: 'openai_compatible',
      aiReplayEnabled: true,
      aiReplayOpenAiBaseUrl: ' http://127.0.0.1:11434 ',
      aiReplayOpenAiApiKey: ' local-key ',
      aiReplayOpenAiModel: ' local-model ',
      aiReplayOpenAiTimeoutMs: 500,
    },
  });
  assert.equal(sanitizedAiSettings.config?.aiReplayProvider, 'openai_compatible');
  assert.equal(sanitizedAiSettings.config?.aiReplayEnabled, true);
  assert.equal(sanitizedAiSettings.config?.aiReplayOpenAiBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(sanitizedAiSettings.config?.aiReplayOpenAiApiKey, 'local-key');
  assert.equal(sanitizedAiSettings.config?.aiReplayOpenAiModel, 'local-model');
  assert.equal(sanitizedAiSettings.config?.aiReplayOpenAiTimeoutMs, 1000);

  const sanitizedSemanticSettings = sanitizeRecorderSettings({
    config: {
      defectEvidenceEnabled: true,
      semanticRecordingEnabled: true,
      uiaObserverEnabled: false,
      operationBuilderEnabled: false,
      operationReviewV2Enabled: false,
      semanticPlaintextInputEnabled: false,
      defectPreWindowSeconds: 601,
      defectPostWindowSeconds: -1,
    },
  });
  assert.equal(sanitizedSemanticSettings.config?.defectEvidenceEnabled, true);
  assert.equal(sanitizedSemanticSettings.config?.semanticRecordingEnabled, true);
  assert.equal(sanitizedSemanticSettings.config?.uiaObserverEnabled, false);
  assert.equal(sanitizedSemanticSettings.config?.operationBuilderEnabled, false);
  assert.equal(sanitizedSemanticSettings.config?.operationReviewV2Enabled, false);
  assert.equal(sanitizedSemanticSettings.config?.semanticPlaintextInputEnabled, false);
  assert.equal(sanitizedSemanticSettings.config?.defectPreWindowSeconds, 600);
  assert.equal(sanitizedSemanticSettings.config?.defectPostWindowSeconds, 0);

  assertThrowsValidation('exportEvidence', () => {
    parseIpcInput(ExportEvidenceInputSchema, { outputMode: 'tar' }, 'exportEvidence');
  });

  const defaultEvidence = parseIpcInput(ExportEvidenceInputSchema, null, 'exportEvidence');
  assert.deepEqual(defaultEvidence, { targetDir: '' });

  const evidence = parseIpcInput(
    ExportEvidenceInputSchema,
    { sessionId: 'session-123', targetDir: 'D:/tmp/evidence', outputMode: 'zip' },
    'exportEvidence',
  );
  assert.equal(evidence.sessionId, 'session-123');
  assert.equal(evidence.targetDir, 'D:/tmp/evidence');
  assert.equal(evidence.outputMode, 'zip');

  const evidenceWithCustomZipName = parseIpcInput(
    ExportEvidenceInputSchema,
    { sessionId: 'session-123', outputMode: 'zip', zipFileName: 'custom-name.zip' },
    'exportEvidence',
  );
  assert.equal(evidenceWithCustomZipName.zipFileName, 'custom-name.zip');

  const ipcSource = readFileSync(
    join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/ipc.ts'),
    'utf8',
  );
  assert.match(ipcSource, /showSaveDialog/);
  assert.match(ipcSource, /defaultPath:\s*resolveEvidenceZipSaveDialogDefaultPath/);

  const defaultReplay = parseIpcInput(ReplayStepGenerateInputSchema, null, 'generateReplaySteps');
  assert.equal(defaultReplay.provider, 'disabled');
  assert.deepEqual(defaultReplay.contexts, []);

  const mockReplay = parseIpcInput(
    ReplayStepGenerateInputSchema,
    {
      provider: 'mock',
      contexts: [{
        stepId: 'step-1',
        timestampMs: 1,
        action: 'click',
        position: { x: 1, y: 2 },
        hasImage: false,
        privacyFiltered: false,
      }],
    },
    'generateReplaySteps',
  );
  assert.equal(mockReplay.provider, 'mock');
  assert.equal(mockReplay.contexts?.[0]?.action, 'click');

  const session = parseIpcInput(
    TestSessionStartInputSchema,
    { name: 'smoke', targetDisplayIds: ['display-1'], segmentDurationSeconds: 10 },
    'testSessionStart',
  );
  assert.equal(session.name, 'smoke');
  assert.deepEqual(session.targetDisplayIds, ['display-1']);

  assertThrowsValidation('testSessionStart', () => {
    parseIpcInput(TestSessionStartInputSchema, { targetDisplayIds: ['ok', 1] }, 'testSessionStart');
  });
}

run();
