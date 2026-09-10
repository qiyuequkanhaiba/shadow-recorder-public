import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

// native-binding
{
  const p = path.join(root, 'src-electron/native-binding.ts');
  let t = fs.readFileSync(p, 'utf8');
  const start = t.indexOf('export function getTestSessionSteps');
  if (start < 0) {
    throw new Error('getTestSessionSteps export not found');
  }
  const end = t.indexOf('export function rebuildTestSessionSteps', start);
  if (end < 0) {
    throw new Error('rebuildTestSessionSteps export not found');
  }
  const replacement = `export function getTestSessionSteps(
  sessionId?: string | { sessionId?: string; session_id?: string; limit?: number },
  limit?: number,
): any[] {
  try {
    const binding = getBinding() as any;
    if (typeof binding.getTestSessionSteps !== 'function') {
      warnMissingNativeApi('getTestSessionSteps');
      return [];
    }
    let sid: string | undefined;
    let lim: number | undefined = limit;
    if (sessionId && typeof sessionId === 'object') {
      sid = sessionId.sessionId ?? sessionId.session_id;
      lim = sessionId.limit ?? limit;
    } else if (typeof sessionId === 'string') {
      sid = sessionId;
    }
    const rows = binding.getTestSessionSteps(sid, lim);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not active|SessionNotFound|no active|not found/i.test(message)) {
      return [];
    }
    throw error;
  }
}

`;
  t = t.slice(0, start) + replacement + t.slice(end);
  fs.writeFileSync(p, t, 'utf8');
  console.log('native-binding getTestSessionSteps hardened');
}

// service
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/service.ts');
  let t = fs.readFileSync(p, 'utf8');
  const start = t.indexOf('public getTestSessionSteps');
  if (start >= 0) {
    // find method end: next "public " after start
    const next = t.indexOf('\n  public ', start + 1);
    const end = next >= 0 ? next : t.indexOf('\n  async ', start + 1);
    if (end < 0) throw new Error('cannot find end of getTestSessionSteps method');
    const replacement = `public getTestSessionSteps(sessionId?: any, limit?: number) {
    try {
      if (sessionId && typeof sessionId === 'object') {
        return nativeGetTestSessionSteps(sessionId.sessionId ?? sessionId.session_id, sessionId.limit ?? limit) ?? [];
      }
      return nativeGetTestSessionSteps(sessionId, limit) ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not active|SessionNotFound|no active|not found/i.test(message)) {
        return [];
      }
      throw error;
    }
  }
`;
    t = t.slice(0, start) + replacement + t.slice(end);
    fs.writeFileSync(p, t, 'utf8');
    console.log('service getTestSessionSteps hardened');
  } else {
    console.log('service method not found by name');
  }
}

// ipc: also catch
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  let t = fs.readFileSync(p, 'utf8');
  const needle = "ipcMain.handle('reqcase:shadow-recorder:get-test-session-steps'";
  const start = t.indexOf(needle);
  if (start >= 0) {
    const end = t.indexOf('});', start) + 3;
    const replacement = `ipcMain.handle('reqcase:shadow-recorder:get-test-session-steps', async (_event, input) => {
    try {
      if (input === undefined || input === null) {
        return service.getTestSessionSteps();
      }
      if (typeof input === 'string') {
        return service.getTestSessionSteps(input);
      }
      const record = requireRecord(input, 'getTestSessionSteps');
      return service.getTestSessionSteps(optionalString(record, 'sessionId'), optionalNumber(record, 'limit'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not active|SessionNotFound|no active|not found/i.test(message)) {
        return [];
      }
      throw error;
    }
  });`;
    t = t.slice(0, start) + replacement + t.slice(end);
    fs.writeFileSync(p, t, 'utf8');
    console.log('ipc get-test-session-steps hardened');
  } else {
    console.log('ipc handler not found');
  }
}

console.log('done');
