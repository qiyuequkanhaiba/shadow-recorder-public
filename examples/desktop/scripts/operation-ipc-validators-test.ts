import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KNOWN_OPERATION_ACTION_KINDS,
  KNOWN_OPERATION_OUTCOME_STATUSES,
  type TestSessionOperationRecord,
} from '../types/operation-contracts';
import {
  OperationDetailInputSchema,
  OperationListInputSchema,
  OperationRebuildInputSchema,
  OperationUpdateInputSchema,
  parseOperationIpcInput,
} from '../src-electron/modules/reqcase-shadow-recorder/operation-ipc-validators';

function assertThrowsValidation(label: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, new RegExp(`${label} validation failed`));
    return true;
  });
}

function testKnownContractValues(): void {
  assert(KNOWN_OPERATION_ACTION_KINDS.includes('doubleClick'));
  assert(KNOWN_OPERATION_OUTCOME_STATUSES.includes('observerDegraded'));
  assert(KNOWN_OPERATION_OUTCOME_STATUSES.includes('legacyUnknown'));
}

function testOperationRecordContract(): void {
  const sample = {
    schemaVersion: 1,
    kind: 'reqcase.test-session-operation',
    operationId: 'operation-1',
    sessionId: 'ts-1',
    sequence: 1,
    startedAtMs: 1000,
    endedAtMs: 1420,
    relativeMsFromSessionStart: 1000,
    action: {
      actionId: 'action-1',
      kind: 'click',
      occurredAtMs: 1000,
      endedAtMs: null,
      target: {
        runtimeId: [42, 7],
        processId: 1234,
        windowHwnd: '0x000A12BC',
        name: 'Save',
        automationId: 'btnSave',
        controlType: 'Button',
        localizedControlType: 'button',
        className: 'Button',
        frameworkId: 'WPF',
        parentPath: [{ controlType: 'Window', name: 'Order Editor' }],
        boundingRect: { left: 100, top: 80, width: 120, height: 32 },
      },
      stateBefore: null,
      coordinate: { x: 120, y: 96, displayId: 'display-1' },
      sourceEventIds: ['evt-1'],
      targetReasonCodes: ['runtime-id-match'],
      confidence: { target: 0.96, temporal: 0.92, overall: 0.94 },
    },
    outcome: {
      outcomeId: 'outcome-1',
      status: 'confirmed',
      summary: '"Saved" toast appeared',
      observedAtMs: 1420,
      latencyMs: 420,
      primaryTransitionId: 'transition-1',
      candidateTransitionIds: ['transition-1'],
      reasonCodes: ['popup-appeared'],
      confidence: {
        temporal: 0.91,
        identity: 0.84,
        transition: 0.95,
        evidence: 0.9,
        overall: 0.9,
      },
    },
    completionCandidates: [],
    transitions: [{
      transitionId: 'transition-1',
      kind: 'lifecycle',
      occurredAtMs: 1420,
      element: null,
      property: null,
      before: null,
      after: '{"name":"Saved"}',
      privacyClass: 'not-sensitive',
      sourceEventIds: ['sem-1'],
      reasonCodes: ['popup-appeared'],
      confidence: { temporal: 0.91, identity: 0.84, transition: 0.95, overall: 0.9 },
    }],
    evidence: [{
      evidenceId: 'evidence-1',
      kind: 'stateTransition',
      role: 'supportsOutcome',
      sourceId: 'transition-1',
      occurredAtMs: 1420,
      artifactRef: null,
      videoRange: { streamId: 'vs-primary', startedAtMs: 900, endedAtMs: 1900 },
      reasonCode: 'popup-appeared',
    }],
    title: 'Click Save',
    resultSummary: '"Saved" toast appeared',
    displaySummary: 'Click Save -> "Saved" toast appeared, 420ms',
    precisionLevel: 'l3',
    outcomeSelectionSource: 'auto',
    edited: false,
    ignored: false,
    businessAlias: null,
    manualNote: null,
  } satisfies TestSessionOperationRecord;

  assert.equal(sample.transitions[0]?.after, '{"name":"Saved"}');
}

function testListInput(): void {
  const defaults = parseOperationIpcInput(OperationListInputSchema, null, 'getTestSessionOperations');
  assert.deepEqual(defaults, { limit: 100 });

  const clamped = parseOperationIpcInput(
    OperationListInputSchema,
    { sessionId: ' ts-1 ', cursor: ' operation-1 ', limit: 20_000 },
    'getTestSessionOperations',
  );
  assert.deepEqual(clamped, { sessionId: 'ts-1', cursor: 'operation-1', limit: 1000 });

  const minimum = parseOperationIpcInput(
    OperationListInputSchema,
    { limit: 0 },
    'getTestSessionOperations',
  );
  assert.equal(minimum.limit, 1);

  assertThrowsValidation('getTestSessionOperations', () => {
    parseOperationIpcInput(OperationListInputSchema, { cursor: 'x'.repeat(257) }, 'getTestSessionOperations');
  });

  assertThrowsValidation('getTestSessionOperations', () => {
    parseOperationIpcInput(OperationListInputSchema, { limit: Number.POSITIVE_INFINITY }, 'getTestSessionOperations');
  });
}

function testDetailInput(): void {
  const detail = parseOperationIpcInput(
    OperationDetailInputSchema,
    { sessionId: ' ts-1 ', operationId: ' operation-1 ' },
    'getTestSessionOperation',
  );
  assert.deepEqual(detail, { sessionId: 'ts-1', operationId: 'operation-1' });

  assertThrowsValidation('getTestSessionOperation', () => {
    parseOperationIpcInput(OperationDetailInputSchema, { sessionId: 'ts-1' }, 'getTestSessionOperation');
  });

  assertThrowsValidation('getTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationDetailInputSchema,
      { operationId: 'x'.repeat(257) },
      'getTestSessionOperation',
    );
  });
}

function testRebuildInput(): void {
  const fromString = parseOperationIpcInput(OperationRebuildInputSchema, ' ts-1 ', 'rebuildTestSessionOperations');
  assert.deepEqual(fromString, { sessionId: 'ts-1' });

  const defaults = parseOperationIpcInput(OperationRebuildInputSchema, undefined, 'rebuildTestSessionOperations');
  assert.deepEqual(defaults, {});
}

function testUpdateInput(): void {
  const update = parseOperationIpcInput(
    OperationUpdateInputSchema,
    {
      sessionId: ' ts-1 ',
      operationId: ' operation-1 ',
      title: ' Save ',
      selectedOutcomeStatus: 'confirmed',
      selectedTransitionId: ' transition-1 ',
      ignored: false,
      businessAlias: ' Save order ',
      note: ' reviewed ',
      reason: ' user-review ',
      occurredAtMs: 1710000000000.99,
    },
    'updateTestSessionOperation',
  );
  assert.equal(update.sessionId, 'ts-1');
  assert.equal(update.operationId, 'operation-1');
  assert.equal(update.title, 'Save');
  assert.equal(update.selectedOutcomeStatus, 'confirmed');
  assert.equal(update.selectedTransitionId, 'transition-1');
  assert.equal(update.businessAlias, 'Save order');
  assert.equal(update.note, 'reviewed');
  assert.equal(update.reason, 'user-review');
  assert.equal(update.occurredAtMs, 1710000000000.99);

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(OperationUpdateInputSchema, { operationId: 'operation-1' }, 'updateTestSessionOperation');
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: '', title: 'Save' },
      'updateTestSessionOperation',
    );
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: 'operation-1', selectedOutcomeStatus: 'succeeded' },
      'updateTestSessionOperation',
    );
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: 'operation-1', title: 'Save', occurredAtMs: Number.POSITIVE_INFINITY },
      'updateTestSessionOperation',
    );
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: 'operation-1', title: 'Save', occurredAtMs: -1 },
      'updateTestSessionOperation',
    );
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: 'operation-1', title: 'Save', occurredAtMs: Number.MAX_SAFE_INTEGER + 1 },
      'updateTestSessionOperation',
    );
  });

  assertThrowsValidation('updateTestSessionOperation', () => {
    parseOperationIpcInput(
      OperationUpdateInputSchema,
      { operationId: 'operation-1', title: 'x'.repeat(241) },
      'updateTestSessionOperation',
    );
  });
}

function testOperationIpcWiring(): void {
  const channelsSource = readFileSync(
    join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts'),
    'utf8',
  );
  assert.match(channelsSource, /getTestSessionOperations:/);
  assert.match(channelsSource, /getTestSessionOperation:/);
  assert.match(channelsSource, /rebuildTestSessionOperations:/);
  assert.match(channelsSource, /updateTestSessionOperation:/);

  const ipcSource = readFileSync(
    join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/ipc.ts'),
    'utf8',
  );
  assert.match(ipcSource, /OperationListInputSchema/);
  assert.match(ipcSource, /OperationDetailInputSchema/);
  assert.match(ipcSource, /OperationRebuildInputSchema/);
  assert.match(ipcSource, /OperationUpdateInputSchema/);
  assert.match(ipcSource, /service\.getSessionOperations/);
  assert.match(ipcSource, /service\.getSessionOperation/);
  assert.match(ipcSource, /service\.rebuildSessionOperations/);
  assert.match(ipcSource, /service\.updateSessionOperation/);

  const preloadSource = readFileSync(join(__dirname, '../src-electron/preload.ts'), 'utf8');
  assert.match(preloadSource, /getTestSessionOperations\?:/);
  assert.match(preloadSource, /getTestSessionOperation\?:/);
  assert.match(preloadSource, /rebuildTestSessionOperations\?:/);
  assert.match(preloadSource, /updateTestSessionOperation\?:/);
}

function run(): void {
  testKnownContractValues();
  testOperationRecordContract();
  testListInput();
  testDetailInput();
  testRebuildInput();
  testUpdateInput();
  testOperationIpcWiring();
  console.log('[operation-ipc-validators-test] PASS');
}

run();
