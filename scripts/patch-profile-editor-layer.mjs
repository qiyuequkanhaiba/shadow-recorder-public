/**
 * Wire setSemanticProfileJson + improve import error + profile editor UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/desktop');
const read = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');
const write = (rel, s) => fs.writeFileSync(path.join(desktop, rel), s, 'utf8');

// --- native-binding.ts ---
{
  const rel = 'src-electron/native-binding.ts';
  let s = read(rel);
  if (!s.includes('export function setSemanticProfileJson')) {
    const anchor = `export function clearSemanticProfile() {
  const binding = getNativeBinding();
  if (typeof binding.clearSemanticProfile !== 'function') {
    throw new Error('clearSemanticProfile is unavailable in native binding');
  }
  return binding.clearSemanticProfile();
}`;
    if (!s.includes(anchor)) {
      // looser
      const idx = s.indexOf('export function clearSemanticProfile');
      if (idx < 0) throw new Error('clearSemanticProfile not found in native-binding');
      // find end of function
      const end = s.indexOf('\nexport function', idx + 10);
      const insertAt = end > 0 ? end : s.length;
      const snippet = `

export function setSemanticProfileJson(content: string): string {
  const binding = getNativeBinding();
  if (typeof binding.setSemanticProfileJson !== 'function') {
    throw new Error('setSemanticProfileJson is unavailable in native binding');
  }
  return binding.setSemanticProfileJson(content);
}
`;
      s = s.slice(0, insertAt) + snippet + s.slice(insertAt);
    } else {
      s = s.replace(
        anchor,
        `${anchor}

export function setSemanticProfileJson(content: string): string {
  const binding = getNativeBinding();
  if (typeof binding.setSemanticProfileJson !== 'function') {
    throw new Error('setSemanticProfileJson is unavailable in native binding');
  }
  return binding.setSemanticProfileJson(content);
}`,
      );
    }
    write(rel, s);
    console.log('native-binding patched');
  } else console.log('native-binding skip');
}

// --- service.ts ---
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/service.ts';
  let s = read(rel);
  if (!s.includes('nativeSetSemanticProfileJson') && !s.includes('setSemanticProfileJson')) {
    s = s.replace(
      'clearSemanticProfile as nativeClearSemanticProfile,',
      'clearSemanticProfile as nativeClearSemanticProfile,\n  setSemanticProfileJson as nativeSetSemanticProfileJson,',
    );
    // if import line failed due to formatting
    if (!s.includes('nativeSetSemanticProfileJson')) {
      s = s.replace(
        'clearSemanticProfile as nativeClearSemanticProfile',
        'clearSemanticProfile as nativeClearSemanticProfile,\n  setSemanticProfileJson as nativeSetSemanticProfileJson',
      );
    }
    s = s.replace(
      `  clearSemanticProfile() {
    nativeClearSemanticProfile();
    try {
      const activePath = this.resolveSemanticProfileActivePath();
      if (existsSync(activePath)) {
        unlinkSync(activePath);
      }
    } catch {
      // best-effort cleanup of managed copy
    }
  }`,
      `  clearSemanticProfile() {
    nativeClearSemanticProfile();
    try {
      const activePath = this.resolveSemanticProfileActivePath();
      if (existsSync(activePath)) {
        unlinkSync(activePath);
      }
    } catch {
      // best-effort cleanup of managed copy
    }
  }

  /**
   * Activate profile from JSON content (profile object or elements_selected array) and pin managed copy.
   */
  setSemanticProfileJson(content: string): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    const profileJson = nativeSetSemanticProfileJson(content);
    const profile = JSON.parse(profileJson) as Record<string, unknown>;
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    nativeLoadSemanticProfile(activePath);
    return {
      profileJson: nativeGetSemanticProfileJson() ?? profileJson,
      profile,
      activePath,
    };
  }

  saveSemanticProfileObject(profile: Record<string, unknown>): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    return this.setSemanticProfileJson(JSON.stringify(profile));
  }`,
    );
    write(rel, s);
    console.log('service patched');
  } else console.log('service skip or partial');
}

// --- ipc-channels ---
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts';
  let s = read(rel);
  if (!s.includes('setSemanticProfileJson')) {
    s = s.replace(
      "importSemanticProfile: 'reqcase:shadow-recorder:import-semantic-profile',",
      "importSemanticProfile: 'reqcase:shadow-recorder:import-semantic-profile',\n  setSemanticProfileJson: 'reqcase:shadow-recorder:set-semantic-profile-json',",
    );
    write(rel, s);
    console.log('channels patched');
  }
}

// --- ipc.ts handlers ---
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc.ts';
  let s = read(rel);
  if (!s.includes('set-semantic-profile-json')) {
    const clearHandler =
      /ipcMain\.handle\('reqcase:shadow-recorder:clear-semantic-profile', async \(\) => \{[\s\S]*?\}\);/;
    if (!clearHandler.test(s)) throw new Error('clear handler not found');
    s = s.replace(
      clearHandler,
      (match) => `${match}

  ipcMain.handle('reqcase:shadow-recorder:set-semantic-profile-json', async (_event, input) => {
    const content =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && typeof input.json === 'string'
          ? input.json
          : input && typeof input === 'object' && input.profile
            ? JSON.stringify(input.profile)
            : null;
    if (!content || typeof content !== 'string') {
      throw new Error('semantic profile JSON content is required');
    }
    const saved = service.setSemanticProfileJson(content);
    const prev = runtimeSettings.semanticProfile;
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: {
        sourceFileName:
          (prev && typeof prev === 'object' && 'sourceFileName' in prev && typeof (prev as any).sourceFileName === 'string'
            ? (prev as any).sourceFileName
            : 'edited-profile.json'),
        sourcePath:
          prev && typeof prev === 'object' && 'sourcePath' in prev && typeof (prev as any).sourcePath === 'string'
            ? (prev as any).sourcePath
            : undefined,
        importedAtMs:
          prev && typeof prev === 'object' && 'importedAtMs' in prev && typeof (prev as any).importedAtMs === 'number'
            ? (prev as any).importedAtMs
            : Date.now(),
        profile: saved.profile,
      },
    };
    // Mark as edited
    runtimeSettings.semanticProfile = {
      ...runtimeSettings.semanticProfile,
      sourceFileName: runtimeSettings.semanticProfile.sourceFileName || 'edited-profile.json',
      importedAtMs: Date.now(),
      profile: saved.profile,
    } as any;
    await saveRecorderSettings(runtimeSettings);
    return saved.profileJson;
  });`,
    );
    write(rel, s);
    console.log('ipc set handler patched');
  } else console.log('ipc set skip');
}

// --- preload ---
{
  const rel = 'src-electron/preload.ts';
  let s = read(rel);
  if (!s.includes('setSemanticProfileJson')) {
    s = s.replace(
      'importSemanticProfile?: () => Promise<string | null>;',
      "importSemanticProfile?: () => Promise<string | null>;\n  setSemanticProfileJson?: (input: string | { json?: string; profile?: unknown }) => Promise<string>;",
    );
    s = s.replace(
      "importSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:import-semantic-profile'),",
      "importSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:import-semantic-profile'),\n    setSemanticProfileJson: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:set-semantic-profile-json', input),",
    );
    write(rel, s);
    console.log('preload patched');
  }
}

// --- d.ts ---
{
  const rel = 'types/native-shadow-recorder.d.ts';
  let s = read(rel);
  if (!s.includes('setSemanticProfileJson')) {
    s = s.replace(
      'importSemanticProfile?(): string | null;',
      'importSemanticProfile?(): string | null;\n  setSemanticProfileJson?(content: string): string;',
    );
    write(rel, s);
    console.log('d.ts patched');
  }
}

console.log('layer patch done');
