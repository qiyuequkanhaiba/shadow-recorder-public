import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

// Fix service methods
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/service.ts');
  let t = fs.readFileSync(p, 'utf8');
  if (!t.includes('public markTestDefect(')) {
    const methods = `
  public markTestDefect(input: {
    note?: string;
    expected?: string;
    actual?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
  } = {}) {
    return nativeMarkTestDefect(input);
  }

  public getTestSessionSteps(sessionId?: string, limit?: number) {
    return nativeGetTestSessionSteps(sessionId, limit);
  }

  public rebuildTestSessionSteps(sessionId?: string) {
    return nativeRebuildTestSessionSteps(sessionId);
  }

  public renderTestSessionReproSteps(
    sessionId?: string,
    windowStartMs?: number,
    windowEndMs?: number,
    defectNote?: string,
  ) {
    return nativeRenderTestSessionReproSteps(sessionId, windowStartMs, windowEndMs, defectNote);
  }

  public exportTestDefectPack(input: {
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
    if (!t.includes('public async exportSessionEvidence')) {
      throw new Error('exportSessionEvidence not found in service.ts');
    }
    t = t.replace(
      '  public async exportSessionEvidence',
      `${methods}  public async exportSessionEvidence`,
    );
    fs.writeFileSync(p, t, 'utf8');
    console.log('service methods fixed');
  } else {
    console.log('service methods already present');
  }
}

// Fix ipc handlers placement: move after-return handlers before return service
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  let t = fs.readFileSync(p, 'utf8');
  const returnIdx = t.indexOf('return service;');
  const deadStart = t.indexOf('ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.markTestDefect');
  if (returnIdx >= 0 && deadStart > returnIdx) {
    // extract dead handlers until end of file before final braces
    const dead = t.slice(deadStart).trim();
    // remove dead section from after return
    t = t.slice(0, deadStart).trimEnd() + '\n';
    // ensure we still have closing of function - re-read structure
    // Insert handlers before return service
    t = t.replace('return service;', `${dead}\n\n  return service;`);
    fs.writeFileSync(p, t, 'utf8');
    console.log('ipc handlers moved before return');
  } else if (t.includes('CHANNELS.markTestDefect') || t.includes('markTestDefect,')) {
    // check if already before return
    const markIdx = t.indexOf('markTestDefect');
    const ret = t.indexOf('return service;');
    console.log('ipc mark position', markIdx, 'return', ret, 'ok', markIdx < ret);
  }

  // Fix dialog import/usage
  t = fs.readFileSync(p, 'utf8');
  if (t.includes('electron_1.dialog')) {
    t = t.replace(/electron_1\.dialog/g, 'dialog');
    fs.writeFileSync(p, t, 'utf8');
    console.log('fixed electron_1.dialog');
  }
  if (t.includes('dialog.showOpenDialog') && !/\bdialog\b/.test(t.match(/import \{[^}]+\} from 'electron';/)?.[0] ?? '')) {
    t = t.replace(/import \{([^}]+)\} from 'electron';/, (full, body) => {
      if (body.includes('dialog')) return full;
      return `import { ${body.trim().replace(/,?$/, '')}, dialog } from 'electron';`;
    });
    fs.writeFileSync(p, t, 'utf8');
    console.log('dialog imported');
  }

  // Verify
  t = fs.readFileSync(p, 'utf8');
  const markIdx = t.indexOf('REQCASE_SHADOW_RECORDER_CHANNELS.markTestDefect');
  const ret = t.indexOf('return service;');
  console.log('final mark<return', markIdx >= 0 && markIdx < ret);
  console.log('has exportTestDefectPack handle', t.includes('exportTestDefectPack'));
}
