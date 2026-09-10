import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type NativeOperationTailResult = {
  items?: unknown[];
  nextCursor?: string;
  reset?: boolean;
  totalCount?: number;
  diagnostics?: unknown[];
};

type NativeBinding = {
  getTestSessionOperations?: (
    sessionId?: string,
    cursor?: string,
    limit?: number,
  ) => NativeOperationTailResult;
  rebuildTestSessionOperations?: (sessionId?: string) => unknown[];
  updateTestSessionOperation?: (input?: Record<string, unknown>) => unknown;
  getTestSessionSteps?: (sessionId?: string, limit?: number) => unknown[];
};

const requireNative = createRequire(import.meta.url);

function resolveNativeBindingPath(): string {
  const explicitPath = process.env.SHADOW_RECORDER_NODE?.trim();
  const candidates = [
    explicitPath,
    path.resolve(__dirname, '../../../target/debug/shadow_recorder.node'),
    path.resolve(__dirname, '../../../target/x86_64-pc-windows-msvc/debug/shadow_recorder.node'),
  ].filter((candidate): candidate is string => !!candidate);

  const bindingPath = candidates.find((candidate) => existsSync(candidate));
  assert(bindingPath, `native binding not found in candidates: ${candidates.join(', ')}`);
  return bindingPath;
}

function assertThrowsNative(label: string, action: () => unknown, expected: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error, `${label} should throw an Error`);
    assert.match(error.message, expected, `${label} error message`);
    return true;
  });
}

function run(): void {
  const bindingPath = resolveNativeBindingPath();
  const native = requireNative(bindingPath) as NativeBinding;

  assert.equal(typeof native.getTestSessionOperations, 'function', 'getTestSessionOperations export');
  assert.equal(typeof native.rebuildTestSessionOperations, 'function', 'rebuildTestSessionOperations export');
  assert.equal(typeof native.updateTestSessionOperation, 'function', 'updateTestSessionOperation export');
  assert.equal(typeof native.getTestSessionSteps, 'function', 'legacy getTestSessionSteps export');

  const tail = native.getTestSessionOperations?.(undefined, undefined, 5);
  assert(tail, 'getTestSessionOperations should return a tail result');
  assert.deepEqual(tail.items, [], 'idle operation tail should be empty');
  assert.equal(tail.reset, true, 'idle operation tail should request reset');
  assert.equal(tail.totalCount, 0, 'idle operation tail totalCount');
  assert.equal(tail.nextCursor, undefined, 'idle operation tail nextCursor');
  assert.deepEqual(tail.diagnostics, [], 'idle operation tail diagnostics');

  const legacySteps = native.getTestSessionSteps?.(undefined, 5);
  assert(Array.isArray(legacySteps), 'legacy getTestSessionSteps should still be callable');

  assertThrowsNative(
    'updateTestSessionOperation invalid timestamp',
    () => native.updateTestSessionOperation?.({
      operationId: 'operation-missing',
      title: 'manual title',
      occurredAtMs: Number.POSITIVE_INFINITY,
    }),
    /occurredAtMs must be a finite timestamp/,
  );

  assertThrowsNative(
    'rebuildTestSessionOperations without active session',
    () => native.rebuildTestSessionOperations?.(undefined),
    /active|session|Session/i,
  );

  console.log('[operation-native-contract-test] PASS');
}

run();
