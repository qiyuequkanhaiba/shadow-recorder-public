import { strict as assert } from 'node:assert';

import { appendNoteForActiveQuickDefect } from '../src-react/lib/quick-defect-fallback';

type NoteInput = {
  title: string;
  message: string;
};

async function testDoesNotAppendNoteForHistoricalSession(): Promise<void> {
  const notes: NoteInput[] = [];

  const appended = await appendNoteForActiveQuickDefect(
    {
      getActiveTestSession: async () => ({ sessionId: 'active-session' }),
      appendTestSessionNote: async (input) => {
        notes.push(input);
      },
    },
    {
      sessionId: 'historical-session',
      title: '回放位置瞬时打标',
      message: '回放位置瞬时打标',
    },
  );

  assert.equal(appended, false);
  assert.deepEqual(notes, []);
}

async function testAppendsNoteForCurrentActiveSession(): Promise<void> {
  const notes: NoteInput[] = [];

  const appended = await appendNoteForActiveQuickDefect(
    {
      getActiveTestSession: async () => ({ sessionId: 'active-session' }),
      appendTestSessionNote: async (input) => {
        notes.push(input);
      },
    },
    {
      sessionId: 'active-session',
      title: '录制位置瞬时打标',
      message: '录制位置瞬时打标',
    },
  );

  assert.equal(appended, true);
  assert.deepEqual(notes, [{ title: '录制位置瞬时打标', message: '录制位置瞬时打标' }]);
}

async function testTreatsSessionStopAfterGuardAsNoFallback(): Promise<void> {
  const appended = await appendNoteForActiveQuickDefect(
    {
      getActiveTestSession: async () => ({ sessionId: 'active-session' }),
      appendTestSessionNote: async () => {
        throw new Error('test session is not active');
      },
    },
    {
      sessionId: 'active-session',
      title: '录制位置瞬时打标',
      message: '录制位置瞬时打标',
    },
  );

  assert.equal(appended, false);
}

async function main(): Promise<void> {
  await testDoesNotAppendNoteForHistoricalSession();
  await testAppendsNoteForCurrentActiveSession();
  await testTreatsSessionStopAfterGuardAsNoFallback();
  console.log('[quick-defect-fallback-test] PASS');
}

void main();
