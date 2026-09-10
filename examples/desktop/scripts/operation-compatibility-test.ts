import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEGACY_OPERATION_RESULT_SUMMARY,
  adaptLegacyStepToOperation,
  buildOperationReviewModel,
  resolveOperationReviewStatus,
} from '../src-react/lib/operation-adapter';
import type { TestSessionOperationTailResult } from '../types/operation-contracts';

function testLegacyStepAdapter(): void {
  const operation = adaptLegacyStepToOperation({
    id: 'step-1',
    sessionId: 'ts-legacy',
    timestampMs: 1000,
    action: 'WM_LBUTTONUP',
    x: 10,
    y: 20,
    windowTitle: 'Legacy Editor',
    processName: 'legacy.exe',
    summary: 'old summary should not become result',
  }, undefined, 0);

  assert.equal(operation.operationId, 'step-1');
  assert.equal(operation.sessionId, 'ts-legacy');
  assert.equal(operation.action.kind, 'click');
  assert.equal(operation.outcome.status, 'legacyUnknown');
  assert.equal(operation.outcome.summary, LEGACY_OPERATION_RESULT_SUMMARY);
  assert.equal(operation.resultSummary, LEGACY_OPERATION_RESULT_SUMMARY);
  assert.match(operation.displaySummary, /旧记录未采集操作结果/);
}

function testReviewModelDiagnostics(): void {
  const partial = buildOperationReviewModel({
    items: [adaptLegacyStepToOperation({ id: 'step-1', timestampMs: 1 }, 'ts-1')],
    reset: true,
    totalCount: 1,
    diagnostics: [{
      code: 'corruptTail',
      severity: 'warning',
      lineNumber: 2,
      message: 'bad line',
    }],
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.operations.length, 1);

  const corrupt = buildOperationReviewModel({
    items: [],
    reset: true,
    totalCount: 0,
    diagnostics: [{
      code: 'corruptTail',
      severity: 'warning',
      lineNumber: 1,
      message: 'bad first line',
    }],
  });
  assert.equal(corrupt.status, 'corrupt');

  const future = resolveOperationReviewStatus([], [{
    code: 'futureSchema',
    severity: 'warning',
    lineNumber: 1,
    schemaVersion: 999,
    message: 'future',
  }]);
  assert.equal(future, 'futureSchema');
}

function testLegacyFallbackModel(): void {
  const emptyTail: TestSessionOperationTailResult = {
    items: [],
    reset: true,
    totalCount: 0,
  };
  const model = buildOperationReviewModel(emptyTail, [{
    id: 'step-legacy',
    sessionId: 'ts-legacy',
    timestampMs: 10,
    action: 'keyboard',
  }]);

  assert.equal(model.status, 'ready');
  assert.equal(model.operations.length, 1);
  assert.equal(model.operations[0].outcome.status, 'legacyUnknown');
  assert.equal(model.diagnostics[0]?.code, 'legacyStepsAdapter');
}

function testMainProcessWiringHints(): void {
  const serviceSource = readFileSync(
    join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/service.ts'),
    'utf8',
  );
  assert.match(serviceSource, /旧记录未采集操作结果/);
  assert.match(serviceSource, /legacyStepsAdapter/);

  const nativeBindingSource = readFileSync(join(__dirname, '../src-electron/native-binding.ts'), 'utf8');
  assert.match(nativeBindingSource, /diagnostics: row\.diagnostics \?\? \[\]/);
}

function run(): void {
  testLegacyStepAdapter();
  testReviewModelDiagnostics();
  testLegacyFallbackModel();
  testMainProcessWiringHints();
  console.log('[operation-compatibility-test] PASS');
}

run();
