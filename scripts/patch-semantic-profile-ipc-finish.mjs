import { readFileSync, writeFileSync } from 'node:fs';

function patchIpc() {
  const p = 'examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts';
  let s = readFileSync(p, 'utf8');
  if (s.includes('load-semantic-profile')) {
    console.log('ipc.ts already patched');
    return;
  }
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  const from = [
    `ipcMain.handle('reqcase:shadow-recorder:get-semantic-alias-profile', async () => {`,
    `    return service.getSemanticAliasProfile();`,
    `  });`,
    ``,
    `  return service;`,
    `}`,
  ].join(nl);
  const to = [
    `ipcMain.handle('reqcase:shadow-recorder:get-semantic-alias-profile', async () => {`,
    `    return service.getSemanticAliasProfile();`,
    `  });`,
    ``,
    `  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {`,
    `    const profilePath = typeof input === 'string' ? input : input?.path;`,
    `    if (!profilePath || typeof profilePath !== 'string') {`,
    `      throw new Error('semantic profile path is required');`,
    `    }`,
    `    return service.loadSemanticProfile(profilePath);`,
    `  });`,
    ``,
    `  ipcMain.handle('reqcase:shadow-recorder:get-semantic-profile-json', async () => {`,
    `    return service.getSemanticProfileJson();`,
    `  });`,
    ``,
    `  ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {`,
    `    return service.clearSemanticProfile();`,
    `  });`,
    ``,
    `  return service;`,
    `}`,
  ].join(nl);
  if (!s.includes(from)) {
    throw new Error('ipc handler block not found');
  }
  writeFileSync(p, s.replace(from, to));
  console.log('patched ipc.ts');
}

function patchPreload() {
  const p = 'examples/desktop/src-electron/preload.ts';
  let s = readFileSync(p, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  if (!s.includes('loadSemanticProfile?:')) {
    s = s.replace(
      'getSemanticAliasProfile?: () => Promise<any>;',
      [
        'getSemanticAliasProfile?: () => Promise<any>;',
        '  loadSemanticProfile?: (input: string | { path: string }) => Promise<string>;',
        '  getSemanticProfileJson?: () => Promise<string | null>;',
        '  clearSemanticProfile?: () => Promise<void>;',
      ].join(nl),
    );
  }
  if (!s.includes('load-semantic-profile')) {
    const idx = s.indexOf('getSemanticAliasProfile:');
    if (idx < 0) throw new Error('preload impl missing');
    const lineEnd = s.indexOf('\n', idx);
    const line = s.slice(idx, lineEnd);
    const invoker = line.includes('electron_1') ? 'electron_1.ipcRenderer' : 'ipcRenderer';
    const insert = [
      '',
      `    loadSemanticProfile: (input) => ${invoker}.invoke('reqcase:shadow-recorder:load-semantic-profile', input),`,
      `    getSemanticProfileJson: () => ${invoker}.invoke('reqcase:shadow-recorder:get-semantic-profile-json'),`,
      `    clearSemanticProfile: () => ${invoker}.invoke('reqcase:shadow-recorder:clear-semantic-profile'),`,
    ].join(nl);
    s = `${s.slice(0, lineEnd)}${insert}${s.slice(lineEnd)}`;
  }
  writeFileSync(p, s);
  console.log('patched preload.ts');
}

patchIpc();
patchPreload();
console.log('finish ok');
