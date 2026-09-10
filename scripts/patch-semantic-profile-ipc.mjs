import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'examples/desktop');

function read(rel) {
  return readFileSync(path.join(desktop, rel), 'utf8');
}

function write(rel, content) {
  writeFileSync(path.join(desktop, rel), content, 'utf8');
}

function patchNativeBinding() {
  const rel = 'src-electron/native-binding.ts';
  let s = read(rel);
  if (s.includes('export function loadSemanticProfile')) {
    console.log('native-binding.ts already patched');
    return;
  }
  const anchor = 'export function getSemanticAliasProfile()';
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('getSemanticAliasProfile not found in native-binding.ts');
  let brace = 0;
  let started = false;
  let end = idx;
  for (let i = idx; i < s.length; i += 1) {
    if (s[i] === '{') {
      brace += 1;
      started = true;
    } else if (s[i] === '}') {
      brace -= 1;
      if (started && brace === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const insert = `

export function loadSemanticProfile(profilePath: string) {
  const binding = getBinding() as any;
  if (typeof binding.loadSemanticProfile !== 'function') {
    throw new Error('loadSemanticProfile is unavailable in native binding');
  }
  return binding.loadSemanticProfile(profilePath);
}

export function getSemanticProfileJson() {
  const binding = getBinding() as any;
  if (typeof binding.getSemanticProfileJson !== 'function') {
    return null;
  }
  return binding.getSemanticProfileJson();
}

export function clearSemanticProfile() {
  const binding = getBinding() as any;
  if (typeof binding.clearSemanticProfile !== 'function') {
    throw new Error('clearSemanticProfile is unavailable in native binding');
  }
  return binding.clearSemanticProfile();
}
`;
  s = `${s.slice(0, end)}${insert}${s.slice(end)}`;
  write(rel, s);
  console.log('patched native-binding.ts');
}

function patchChannels() {
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts';
  let s = read(rel);
  if (s.includes('loadSemanticProfile:')) {
    console.log('ipc-channels.ts already patched');
    return;
  }
  s = s.replace(
    "getSemanticAliasProfile: 'reqcase:shadow-recorder:get-semantic-alias-profile',",
    `getSemanticAliasProfile: 'reqcase:shadow-recorder:get-semantic-alias-profile',
  loadSemanticProfile: 'reqcase:shadow-recorder:load-semantic-profile',
  getSemanticProfileJson: 'reqcase:shadow-recorder:get-semantic-profile-json',
  clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',`,
  );
  write(rel, s);
  console.log('patched ipc-channels.ts');
}

function patchService() {
  const rel = 'src-electron/modules/reqcase-shadow-recorder/service.ts';
  let s = read(rel);
  if (!s.includes('nativeLoadSemanticProfile')) {
    s = s.replace(
      'getSemanticAliasProfile as nativeGetSemanticAliasProfile,',
      `getSemanticAliasProfile as nativeGetSemanticAliasProfile,
  loadSemanticProfile as nativeLoadSemanticProfile,
  getSemanticProfileJson as nativeGetSemanticProfileJson,
  clearSemanticProfile as nativeClearSemanticProfile,`,
    );
  }
  if (!s.includes('loadSemanticProfile(profilePath')) {
    const replacements = [
      [
        `getSemanticAliasProfile() {
    return nativeGetSemanticAliasProfile();
  }`,
        `getSemanticAliasProfile() {
    return nativeGetSemanticAliasProfile();
  }

  loadSemanticProfile(profilePath: string) {
    return nativeLoadSemanticProfile(profilePath);
  }

  getSemanticProfileJson() {
    return nativeGetSemanticProfileJson();
  }

  clearSemanticProfile() {
    return nativeClearSemanticProfile();
  }`,
      ],
      [
        `getSemanticAliasProfile() {
    return (0, native_binding_1.getSemanticAliasProfile)();
  }`,
        `getSemanticAliasProfile() {
    return (0, native_binding_1.getSemanticAliasProfile)();
  }

  loadSemanticProfile(profilePath) {
    return (0, native_binding_1.loadSemanticProfile)(profilePath);
  }

  getSemanticProfileJson() {
    return (0, native_binding_1.getSemanticProfileJson)();
  }

  clearSemanticProfile() {
    return (0, native_binding_1.clearSemanticProfile)();
  }`,
      ],
    ];
    let applied = false;
    for (const [from, to] of replacements) {
      if (s.includes(from)) {
        s = s.replace(from, to);
        applied = true;
        break;
      }
    }
    if (!applied) {
      // fallback: append methods near getSemanticAliasProfile body end
      const marker = 'getSemanticAliasProfile()';
      const idx = s.indexOf(marker);
      if (idx < 0) throw new Error('getSemanticAliasProfile method not found in service.ts');
      let brace = 0;
      let started = false;
      let end = idx;
      for (let i = idx; i < s.length; i += 1) {
        if (s[i] === '{') {
          brace += 1;
          started = true;
        } else if (s[i] === '}') {
          brace -= 1;
          if (started && brace === 0) {
            end = i + 1;
            break;
          }
        }
      }
      s = `${s.slice(0, end)}

  loadSemanticProfile(profilePath: string) {
    return nativeLoadSemanticProfile(profilePath);
  }

  getSemanticProfileJson() {
    return nativeGetSemanticProfileJson();
  }

  clearSemanticProfile() {
    return nativeClearSemanticProfile();
  }
${s.slice(end)}`;
    }
  }
  write(rel, s);
  console.log('patched service.ts');
}

function patchIpc() {
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc.ts';
  let s = read(rel);
  if (s.includes('load-semantic-profile')) {
    console.log('ipc.ts already patched');
    return;
  }
  const from = `ipcMain.handle('reqcase:shadow-recorder:get-semantic-alias-profile', async () => {
    return service.getSemanticAliasProfile();
  });

  return service;
}`;
  const to = `ipcMain.handle('reqcase:shadow-recorder:get-semantic-alias-profile', async () => {
    return service.getSemanticAliasProfile();
  });

  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
    const profilePath = typeof input === 'string' ? input : input?.path;
    if (!profilePath || typeof profilePath !== 'string') {
      throw new Error('semantic profile path is required');
    }
    return service.loadSemanticProfile(profilePath);
  });

  ipcMain.handle('reqcase:shadow-recorder:get-semantic-profile-json', async () => {
    return service.getSemanticProfileJson();
  });

  ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {
    return service.clearSemanticProfile();
  });

  return service;
}`;
  if (!s.includes(from)) {
    throw new Error('ipc alias handler block not found');
  }
  s = s.replace(from, to);
  write(rel, s);
  console.log('patched ipc.ts');
}

function patchPreload() {
  const rel = 'src-electron/preload.ts';
  let s = read(rel);
  if (!s.includes('loadSemanticProfile?:')) {
    s = s.replace(
      'getSemanticAliasProfile?: () => Promise<any>;',
      `getSemanticAliasProfile?: () => Promise<any>;
  loadSemanticProfile?: (input: string | { path: string }) => Promise<string>;
  getSemanticProfileJson?: () => Promise<string | null>;
  clearSemanticProfile?: () => Promise<void>;`,
    );
  }
  if (!s.includes('load-semantic-profile')) {
    const patterns = [
      /getSemanticAliasProfile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]reqcase:shadow-recorder:get-semantic-alias-profile['"]\),?/,
      /getSemanticAliasProfile:\s*\(\)\s*=>\s*electron_1\.ipcRenderer\.invoke\(['"]reqcase:shadow-recorder:get-semantic-alias-profile['"]\),?/,
    ];
    if (!s.includes('load-semantic-profile')) {
      const idx = s.indexOf('getSemanticAliasProfile:');
      if (idx < 0) throw new Error('preload getSemanticAliasProfile impl missing');
      // Find the invoke line for getSemanticAliasProfile in the api object.
      const lineEnd = s.indexOf('\n', idx);
      const line = s.slice(idx, lineEnd);
      const usesElectron1 = line.includes('electron_1');
      const invoker = usesElectron1 ? 'electron_1.ipcRenderer' : 'ipcRenderer';
      const insert = `
    loadSemanticProfile: (input) => ${invoker}.invoke('reqcase:shadow-recorder:load-semantic-profile', input),
    getSemanticProfileJson: () => ${invoker}.invoke('reqcase:shadow-recorder:get-semantic-profile-json'),
    clearSemanticProfile: () => ${invoker}.invoke('reqcase:shadow-recorder:clear-semantic-profile'),`;
      s = `${s.slice(0, lineEnd)}${insert}${s.slice(lineEnd)}`;
    }
    if (!s.includes('load-semantic-profile')) {
      throw new Error('failed to patch preload implementation');
    }
  }
  write(rel, s);
  console.log('patched preload.ts');
}

patchNativeBinding();
patchChannels();
patchService();
patchIpc();
patchPreload();
console.log('semantic profile IPC patch complete');
