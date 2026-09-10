import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log('patched', rel);
}

// 1) ipc-channels
{
  let ch = read('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts');
  if (!ch.includes('markTestDefect')) {
    ch = ch.replace(
      "appendTestSessionLog: 'reqcase:shadow-recorder:append-test-session-log',",
      [
        "appendTestSessionLog: 'reqcase:shadow-recorder:append-test-session-log',",
        "  markTestDefect: 'reqcase:shadow-recorder:mark-test-defect',",
        "  getTestSessionSteps: 'reqcase:shadow-recorder:get-test-session-steps',",
        "  rebuildTestSessionSteps: 'reqcase:shadow-recorder:rebuild-test-session-steps',",
        "  renderTestSessionReproSteps: 'reqcase:shadow-recorder:render-test-session-repro-steps',",
        "  exportTestDefectPack: 'reqcase:shadow-recorder:export-test-defect-pack',",
      ].join('\n'),
    );
    write('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts', ch);
  } else {
    console.log('skip ipc-channels');
  }
}

// 2) native-binding
{
  let nb = read('src-electron/native-binding.ts');
  if (!nb.includes('export function markTestDefect')) {
    // Ensure loadNativeBinding maps camelCase from napi
    // NAPI exports snake_case typically converted by napi-rs to camelCase
    const extras = `

export function markTestDefect(input?: {
  note?: string;
  expected?: string;
  actual?: string;
  markedAtMs?: number;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
}): {
  event: any;
  markedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  preWindowSeconds: number;
  postWindowSeconds: number;
  note?: string;
  expected?: string;
  actual?: string;
  stepCount: number;
} {
  const binding = loadNativeBinding() as any;
  if (typeof binding.markTestDefect !== 'function') {
    throw new Error('markTestDefect is unavailable in native binding');
  }
  return binding.markTestDefect(input);
}

export function getTestSessionSteps(sessionId?: string, limit?: number): any[] {
  const binding = loadNativeBinding() as any;
  if (typeof binding.getTestSessionSteps !== 'function') {
    throw new Error('getTestSessionSteps is unavailable in native binding');
  }
  return binding.getTestSessionSteps(sessionId, limit) ?? [];
}

export function rebuildTestSessionSteps(sessionId?: string): any[] {
  const binding = loadNativeBinding() as any;
  if (typeof binding.rebuildTestSessionSteps !== 'function') {
    throw new Error('rebuildTestSessionSteps is unavailable in native binding');
  }
  return binding.rebuildTestSessionSteps(sessionId) ?? [];
}

export function renderTestSessionReproSteps(
  sessionId?: string,
  windowStartMs?: number,
  windowEndMs?: number,
  defectNote?: string,
): string {
  const binding = loadNativeBinding() as any;
  if (typeof binding.renderTestSessionReproSteps !== 'function') {
    throw new Error('renderTestSessionReproSteps is unavailable in native binding');
  }
  return binding.renderTestSessionReproSteps(sessionId, windowStartMs, windowEndMs, defectNote) ?? '';
}

export function exportTestDefectPack(input?: {
  sessionId?: string;
  targetDir?: string;
  markedAtMs?: number;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
  note?: string;
  expected?: string;
  actual?: string;
}): any {
  const binding = loadNativeBinding() as any;
  if (typeof binding.exportTestDefectPack !== 'function') {
    throw new Error('exportTestDefectPack is unavailable in native binding');
  }
  return binding.exportTestDefectPack(input);
}
`;
    nb = `${nb.trimEnd()}\n${extras}\n`;
    write('src-electron/native-binding.ts', nb);
  } else {
    console.log('skip native-binding');
  }
}

// 3) service.ts - wrap native calls
{
  let service = read('src-electron/modules/reqcase-shadow-recorder/service.ts');
  if (!service.includes('markTestDefect')) {
    // add imports
    if (service.includes('appendTestSessionLog,')) {
      service = service.replace(
        'appendTestSessionLog,',
        `appendTestSessionLog,\n  markTestDefect as nativeMarkTestDefect,\n  getTestSessionSteps as nativeGetTestSessionSteps,\n  rebuildTestSessionSteps as nativeRebuildTestSessionSteps,\n  renderTestSessionReproSteps as nativeRenderTestSessionReproSteps,\n  exportTestDefectPack as nativeExportTestDefectPack,`,
      );
    } else if (service.includes("from '../../native-binding'")) {
      service = service.replace(
        "from '../../native-binding';",
        `from '../../native-binding';\n// defect phase-a imports injected below`,
      );
      // fallback: inject import block
      service = service.replace(
        /import \{([\s\S]*?)\} from '\.\.\/\.\.\/native-binding';/,
        (full, body) => {
          if (body.includes('markTestDefect')) return full;
          return `import {${body}  markTestDefect as nativeMarkTestDefect,\n  getTestSessionSteps as nativeGetTestSessionSteps,\n  rebuildTestSessionSteps as nativeRebuildTestSessionSteps,\n  renderTestSessionReproSteps as nativeRenderTestSessionReproSteps,\n  exportTestDefectPack as nativeExportTestDefectPack,\n} from '../../native-binding';`;
        },
      );
    }

    const methods = `
  async markTestDefect(input: {
    note?: string;
    expected?: string;
    actual?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
  } = {}) {
    return nativeMarkTestDefect(input);
  }

  async getTestSessionSteps(sessionId?: string, limit?: number) {
    return nativeGetTestSessionSteps(sessionId, limit);
  }

  async rebuildTestSessionSteps(sessionId?: string) {
    return nativeRebuildTestSessionSteps(sessionId);
  }

  async renderTestSessionReproSteps(
    sessionId?: string,
    windowStartMs?: number,
    windowEndMs?: number,
    defectNote?: string,
  ) {
    return nativeRenderTestSessionReproSteps(sessionId, windowStartMs, windowEndMs, defectNote);
  }

  async exportTestDefectPack(input: {
    sessionId?: string;
    targetDir?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
    note?: string;
    expected?: string;
    actual?: string;
  }) {
    return nativeExportTestDefectPack(input);
  }
`;
    // insert before last closing brace of class if possible
    const classEnd = service.lastIndexOf('}');
    // better: after appendTestSessionLog method
    if (service.includes('appendTestSessionLog(') && !service.includes('async markTestDefect')) {
      service = service.replace(
        /async appendTestSessionLog\([\s\S]*?\n  \}/,
        (m) => `${m}\n${methods}`,
      );
      write('src-electron/modules/reqcase-shadow-recorder/service.ts', service);
    } else {
      console.log('service append pattern not found; dumping markers');
      console.log('has import native', service.includes('native-binding'));
      console.log('has appendTestSessionLog', service.includes('appendTestSessionLog'));
    }
  } else {
    console.log('skip service');
  }
}

// 4) ipc.ts handlers
{
  let ipc = read('src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  if (!ipc.includes('markTestDefect')) {
    const handlers = `
  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.markTestDefect, async (_event, input) => {
    const record = isRecord(input) ? input : {};
    return service.markTestDefect({
      note: optionalString(record, 'note') ?? optionalString(record, 'message'),
      expected: optionalString(record, 'expected'),
      actual: optionalString(record, 'actual'),
      markedAtMs: optionalNumber(record, 'markedAtMs'),
      preWindowSeconds: optionalNumber(record, 'preWindowSeconds'),
      postWindowSeconds: optionalNumber(record, 'postWindowSeconds'),
    });
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionSteps, async (_event, input) => {
    if (input === undefined || input === null) {
      return service.getTestSessionSteps();
    }
    if (typeof input === 'string') {
      return service.getTestSessionSteps(input);
    }
    const record = requireRecord(input, 'getTestSessionSteps');
    return service.getTestSessionSteps(optionalString(record, 'sessionId'), optionalNumber(record, 'limit'));
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.rebuildTestSessionSteps, async (_event, input) => {
    if (typeof input === 'string') {
      return service.rebuildTestSessionSteps(input);
    }
    if (input && typeof input === 'object') {
      const record = requireRecord(input, 'rebuildTestSessionSteps');
      return service.rebuildTestSessionSteps(optionalString(record, 'sessionId'));
    }
    return service.rebuildTestSessionSteps();
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.renderTestSessionReproSteps, async (_event, input) => {
    const record = input && typeof input === 'object' ? requireRecord(input, 'renderTestSessionReproSteps') : {};
    return service.renderTestSessionReproSteps(
      optionalString(record, 'sessionId'),
      optionalNumber(record, 'windowStartMs'),
      optionalNumber(record, 'windowEndMs'),
      optionalString(record, 'defectNote') ?? optionalString(record, 'note'),
    );
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestDefectPack, async (event, input) => {
    const record = requireRecord(input, 'exportTestDefectPack');
    let targetDir = optionalString(record, 'targetDir');
    if (!targetDir) {
      const result = await electron_1.dialog.showOpenDialog({
        title: '选择缺陷证据包导出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) {
        throw new Error('export canceled');
      }
      targetDir = result.filePaths[0];
    }
    return service.exportTestDefectPack({
      sessionId: optionalString(record, 'sessionId'),
      targetDir,
      markedAtMs: optionalNumber(record, 'markedAtMs'),
      preWindowSeconds: optionalNumber(record, 'preWindowSeconds'),
      postWindowSeconds: optionalNumber(record, 'postWindowSeconds'),
      note: optionalString(record, 'note'),
      expected: optionalString(record, 'expected'),
      actual: optionalString(record, 'actual'),
    });
  });
`;
    // Prefer electron dialog import pattern
    if (!ipc.includes('dialog')) {
      // try use require electron dialog from existing electron import
    }
    // Fix dialog reference - use existing app/dialog imports if present
    let handlersFixed = handlers;
    if (ipc.includes('dialog.showOpenDialog') || ipc.includes('from \'electron\'')) {
      handlersFixed = handlersFixed.replace(/electron_1\.dialog/g, 'dialog');
      if (!ipc.includes('dialog') && ipc.includes("from 'electron'")) {
        ipc = ipc.replace(/from 'electron';/, (m) => m);
      }
    }
    // Insert before end of register function - look for unsubscribeMetrics or exportTestSessionEvidence handler end
    if (ipc.includes('exportTestSessionEvidence')) {
      // append handlers before final closing of register function
      const marker = 'exportTestSessionEvidence';
      const idx = ipc.lastIndexOf(marker);
      // find a late insertion point: last ipcMain.handle block
      const lastHandle = ipc.lastIndexOf('ipcMain.handle');
      const brace = ipc.indexOf('\n}', ipc.indexOf('{', lastHandle));
      // safer: before `}` of export function register...
      const registerMatch = ipc.match(/export function registerReqCaseShadowRecorderIpc[\s\S]*$/);
      if (registerMatch) {
        // insert before final two closing braces
        const insertAt = ipc.lastIndexOf('\n}');
        ipc = ipc.slice(0, insertAt) + '\n' + handlersFixed + ipc.slice(insertAt);
        // fix dialog import
        if (handlersFixed.includes('dialog.showOpenDialog') && !/,\s*dialog/.test(ipc) && !/dialog\s*,/.test(ipc)) {
          ipc = ipc.replace(
            /import \{([^}]+)\} from 'electron';/,
            (full, body) => {
              if (body.includes('dialog')) return full;
              return `import {${body.trim().replace(/,?$/, '')}, dialog } from 'electron';`;
            },
          );
        }
        write('src-electron/modules/reqcase-shadow-recorder/ipc.ts', ipc);
      } else {
        console.log('register function not found');
      }
    } else {
      console.log('exportTestSessionEvidence not found in ipc');
    }
  } else {
    console.log('skip ipc');
  }
}

// 5) preload.ts
{
  let preload = read('src-electron/preload.ts');
  if (!preload.includes('markTestDefect')) {
    const api = `
    markTestDefect: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.markTestDefect, input),
    getTestSessionSteps: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionSteps, input),
    rebuildTestSessionSteps: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.rebuildTestSessionSteps, input),
    renderTestSessionReproSteps: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.renderTestSessionReproSteps, input),
    exportTestDefectPack: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestDefectPack, input),
`;
    if (preload.includes('appendTestSessionLog:')) {
      preload = preload.replace(
        /appendTestSessionLog:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\([^)]+\),/,
        (m) => `${m}\n${api}`,
      );
      write('src-electron/preload.ts', preload);
    } else {
      console.log('preload appendTestSessionLog pattern missing');
    }
  } else {
    console.log('skip preload');
  }
}

console.log('patch script done');
