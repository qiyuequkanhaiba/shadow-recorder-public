/**
 * Multi semantic profile IPC + contracts + settings + preload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/desktop');
const read = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');
const write = (rel, s) => fs.writeFileSync(path.join(desktop, rel), s, 'utf8');

// ---- contracts ----
{
  let c = read('types/contracts.ts');
  const newRec = `/** One imported semantic profile entry (multi-app library). */
export interface SemanticProfileImportRecord {
  /** Stable id for tabs / activation (defaults to profile.profileId or generated). */
  id: string;
  sourceFileName: string;
  sourcePath?: string;
  importedAtMs: number;
  updatedAtMs?: number;
  /** Normalized profile object (alias/scenario rules, target process, etc.). */
  profile: Record<string, unknown>;
}`;
  c = c.replace(
    /export interface SemanticProfileImportRecord \{[\s\S]*?\n\}/,
    newRec,
  );
  if (!c.includes('semanticProfiles?:')) {
    c = c.replace(
      /\/\*\* Last imported semantic profile; restored into native on app start\. \*\/\s*semanticProfile\?: SemanticProfileImportRecord \| null;/,
      `/**
   * @deprecated Prefer semanticProfiles + activeSemanticProfileId.
   * Kept for migration of single-profile settings.
   */
  semanticProfile?: SemanticProfileImportRecord | null;
  /** Library of imported profiles (one tab per entry / software). */
  semanticProfiles?: SemanticProfileImportRecord[];
  /** Currently active profile id (loaded into native binding). */
  activeSemanticProfileId?: string | null;`,
    );
  }
  if (!c.includes('semanticProfiles?:')) {
    c = c.replace(
      'semanticProfile?: SemanticProfileImportRecord | null;',
      `semanticProfile?: SemanticProfileImportRecord | null;
  semanticProfiles?: SemanticProfileImportRecord[];
  activeSemanticProfileId?: string | null;`,
    );
  }
  write('types/contracts.ts', c);
  console.log('contracts ok', c.includes('semanticProfiles?:'), c.includes('id: string'));
}

// ---- settings-store ----
{
  let st = read('src-electron/modules/reqcase-shadow-recorder/settings-store.ts');
  const helper = `
function makeProfileRecordId(profile: Record<string, unknown>, sourceFileName: string, fallbackIndex = 0): string {
  const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
  if (profileId) return profileId;
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  if (name) return \`name:\${name}\`;
  const base = sourceFileName.replace(/\\.json$/i, '').trim() || 'profile';
  return \`\${base}-\${fallbackIndex + 1}\`;
}

function sanitizeSemanticProfileImport(value: unknown, index = 0): SemanticProfileImportRecord | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (!input.profile || typeof input.profile !== 'object' || Array.isArray(input.profile)) {
    return undefined;
  }
  const profile = input.profile as Record<string, unknown>;
  const sourceFileName =
    typeof input.sourceFileName === 'string' && input.sourceFileName.trim()
      ? input.sourceFileName.trim()
      : 'imported-profile.json';
  const importedAtMs =
    typeof input.importedAtMs === 'number' && Number.isFinite(input.importedAtMs)
      ? Math.trunc(input.importedAtMs)
      : Date.now();
  const idRaw = typeof input.id === 'string' ? input.id.trim() : '';
  const id = idRaw || makeProfileRecordId(profile, sourceFileName, index);
  const record: SemanticProfileImportRecord = {
    id,
    sourceFileName,
    importedAtMs,
    profile,
  };
  if (typeof input.sourcePath === 'string' && input.sourcePath.trim()) {
    record.sourcePath = input.sourcePath.trim();
  }
  if (typeof input.updatedAtMs === 'number' && Number.isFinite(input.updatedAtMs)) {
    record.updatedAtMs = Math.trunc(input.updatedAtMs);
  }
  return record;
}

function sanitizeSemanticProfilesList(value: unknown): SemanticProfileImportRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: SemanticProfileImportRecord[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const rec = sanitizeSemanticProfileImport(item, index);
    if (!rec) return;
    if (seen.has(rec.id)) {
      const existing = out.findIndex((r) => r.id === rec.id);
      if (existing >= 0) out.splice(existing, 1);
    }
    seen.add(rec.id);
    out.push(rec);
  });
  return out;
}

`;

  if (!st.includes('sanitizeSemanticProfilesList')) {
    st = st.replace(
      /function sanitizeSemanticProfileImport\(value: unknown\): SemanticProfileImportRecord \| null \| undefined \{[\s\S]*?\n\}\n/,
      helper,
    );
    if (!st.includes('sanitizeSemanticProfilesList')) {
      st = st.replace(
        'function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {',
        `${helper}function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {`,
      );
    }
  }

  if (!st.includes('Migrate legacy')) {
    const inject = `
  if ('semanticProfiles' in input) {
    const semanticProfiles = sanitizeSemanticProfilesList(input.semanticProfiles);
    if (semanticProfiles !== undefined) {
      output.semanticProfiles = semanticProfiles;
    }
  }

  if ('activeSemanticProfileId' in input) {
    if (input.activeSemanticProfileId === null) {
      output.activeSemanticProfileId = null;
    } else if (typeof input.activeSemanticProfileId === 'string') {
      output.activeSemanticProfileId = input.activeSemanticProfileId.trim() || null;
    }
  }

  // Migrate legacy single semanticProfile → list
  if ((!output.semanticProfiles || output.semanticProfiles.length === 0) && output.semanticProfile?.profile) {
    const legacy = sanitizeSemanticProfileImport(output.semanticProfile, 0);
    if (legacy) {
      output.semanticProfiles = [legacy];
      if (!output.activeSemanticProfileId) {
        output.activeSemanticProfileId = legacy.id;
      }
    }
  }
`;
    st = st.replace(
      /if \('semanticProfile' in input\) \{[\s\S]*?\n  \}\n\n  return output;\n\}/,
      (m) => m.replace('\n  return output;\n}', `${inject}\n  return output;\n}`),
    );
  }
  write('src-electron/modules/reqcase-shadow-recorder/settings-store.ts', st);
  console.log('settings ok', st.includes('sanitizeSemanticProfilesList'), st.includes('Migrate legacy'));
}

// ---- channels ----
{
  let s = read('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts');
  if (!s.includes('setActiveSemanticProfile')) {
    s = s.replace(
      "clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',",
      "clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',\n  setActiveSemanticProfile: 'reqcase:shadow-recorder:set-active-semantic-profile',\n  removeSemanticProfile: 'reqcase:shadow-recorder:remove-semantic-profile',",
    );
    write('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts', s);
  }
  console.log('channels ok');
}

// ---- preload ----
{
  let s = read('src-electron/preload.ts');
  if (!s.includes('setActiveSemanticProfile')) {
    s = s.replace(
      'clearSemanticProfile?: () => Promise<void>;',
      "clearSemanticProfile?: () => Promise<void>;\n  setActiveSemanticProfile?: (input: string | { id: string }) => Promise<string | null>;\n  removeSemanticProfile?: (input: string | { id: string }) => Promise<void>;",
    );
    s = s.replace(
      "clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),",
      "clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),\n    setActiveSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:set-active-semantic-profile', input),\n    removeSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:remove-semantic-profile', input),",
    );
    write('src-electron/preload.ts', s);
  }
  console.log('preload ok');
}

// ---- ipc.ts ----
{
  let ipc = read('src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  const nl = ipc.includes('\r\n') ? '\r\n' : '\n';

  const helpers = `
  const profileRecordId = (
    profile: Record<string, unknown>,
    sourceFileName: string,
    fallbackIndex = 0,
  ): string => {
    const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
    if (profileId) return profileId;
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (name) return \`name:\${name}\`;
    const base = sourceFileName.replace(/\\.json$/i, '').trim() || 'profile';
    return \`\${base}-\${fallbackIndex + 1}\`;
  };

  const listSemanticProfiles = (): Array<{
    id: string;
    sourceFileName: string;
    sourcePath?: string;
    importedAtMs: number;
    updatedAtMs?: number;
    profile: Record<string, unknown>;
  }> => {
    const fromList = Array.isArray(runtimeSettings.semanticProfiles)
      ? (runtimeSettings.semanticProfiles as any[])
      : [];
    if (fromList.length > 0) {
      return fromList as any;
    }
    const legacy = runtimeSettings.semanticProfile as any;
    if (legacy?.profile && typeof legacy.profile === 'object') {
      const id =
        typeof legacy.id === 'string' && legacy.id.trim()
          ? legacy.id.trim()
          : profileRecordId(legacy.profile, legacy.sourceFileName || 'imported-profile.json', 0);
      return [
        {
          id,
          sourceFileName: legacy.sourceFileName || 'imported-profile.json',
          sourcePath: legacy.sourcePath,
          importedAtMs: legacy.importedAtMs || Date.now(),
          updatedAtMs: legacy.updatedAtMs,
          profile: legacy.profile,
        },
      ];
    }
    return [];
  };

  const upsertSemanticProfile = (entry: {
    id?: string;
    sourceFileName: string;
    sourcePath?: string;
    profile: Record<string, unknown>;
  }) => {
    const list = listSemanticProfiles();
    const id =
      (entry.id && entry.id.trim()) ||
      profileRecordId(entry.profile, entry.sourceFileName, list.length);
    const now = Date.now();
    const existingIndex = list.findIndex((item) => item.id === id);
    const nextEntry = {
      id,
      sourceFileName: entry.sourceFileName,
      sourcePath: entry.sourcePath,
      importedAtMs: existingIndex >= 0 ? list[existingIndex].importedAtMs : now,
      updatedAtMs: now,
      profile: entry.profile,
    };
    const nextList =
      existingIndex >= 0
        ? list.map((item, index) => (index === existingIndex ? nextEntry : item))
        : [...list, nextEntry];
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: nextList,
      activeSemanticProfileId: id,
      semanticProfile: nextEntry,
    };
    return nextEntry;
  };

  const activateSemanticProfileById = (id: string): string | null => {
    const list = listSemanticProfiles();
    const found = list.find((item) => item.id === id);
    if (!found?.profile) {
      return null;
    }
    const restored = service.restoreSemanticProfileObject(found.profile);
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId: found.id,
      semanticProfile: found,
    };
    return restored;
  };
`.replace(/\n/g, nl);

  if (!ipc.includes('listSemanticProfiles')) {
    const restoreRe =
      /  const restorePersistedSemanticProfile = \(\): void => \{[\s\S]*?  restorePersistedSemanticProfile\(\);/;
    const m = restoreRe.exec(ipc);
    if (!m) throw new Error('restore block not found');
    const newRestore = `  const restorePersistedSemanticProfile = (): void => {
    const fromList = Array.isArray(runtimeSettings.semanticProfiles)
      ? (runtimeSettings.semanticProfiles as any[])
      : [];
    const list =
      fromList.length > 0
        ? fromList
        : runtimeSettings.semanticProfile &&
            (runtimeSettings.semanticProfile as any).profile
          ? [runtimeSettings.semanticProfile as any]
          : [];
    if (list.length === 0) {
      return;
    }
    const activeId =
      typeof runtimeSettings.activeSemanticProfileId === 'string'
        ? runtimeSettings.activeSemanticProfileId
        : null;
    const selected =
      (activeId &&
        list.find(
          (item: any) => item?.id === activeId || item?.profile?.profileId === activeId,
        )) ||
      list[0];
    if (!selected?.profile || typeof selected.profile !== 'object') {
      return;
    }
    try {
      service.restoreSemanticProfileObject(selected.profile as Record<string, unknown>);
      if (!Array.isArray(runtimeSettings.semanticProfiles) || runtimeSettings.semanticProfiles.length === 0) {
        const id =
          typeof selected.id === 'string' && selected.id
            ? selected.id
            : String(selected.profile?.profileId || 'imported');
        runtimeSettings = {
          ...runtimeSettings,
          semanticProfiles: [{ ...selected, id }],
          activeSemanticProfileId: id,
        };
        void saveRecorderSettings(runtimeSettings);
      }
    } catch (error) {
      console.error('Failed to restore persisted semantic profile', error);
    }
  };
  restorePersistedSemanticProfile();
${helpers}`.replace(/\n/g, nl);
    ipc = ipc.slice(0, m.index) + newRestore + ipc.slice(m.index + m[0].length);
    console.log('helpers inserted');
  }

  function replaceHandler(channel, body) {
    const re = new RegExp(
      `ipcMain\\.handle\\('${channel}', async [\\s\\S]*?\\n  \\}\\);`,
    );
    const m = re.exec(ipc);
    if (!m) {
      console.warn('handler not found', channel);
      return false;
    }
    ipc = ipc.slice(0, m.index) + body.replace(/\n/g, nl) + ipc.slice(m.index + m[0].length);
    return true;
  }

  replaceHandler(
    'reqcase:shadow-recorder:load-semantic-profile',
    `ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
    const profilePath = typeof input === 'string' ? input : input?.path;
    if (!profilePath || typeof profilePath !== 'string') {
      throw new Error('semantic profile path is required');
    }
    const imported = service.importSemanticProfileFromPath(profilePath);
    upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });`,
  );

  replaceHandler(
    'reqcase:shadow-recorder:import-semantic-profile',
    `ipcMain.handle('reqcase:shadow-recorder:import-semantic-profile', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入语义画像',
      properties: ['openFile'],
      filters: [
        { name: 'Semantic Profile JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const profilePath = result.filePaths[0];
    const imported = service.importSemanticProfileFromPath(profilePath);
    const entry = upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });`,
  );

  replaceHandler(
    'reqcase:shadow-recorder:set-semantic-profile-json',
    `ipcMain.handle('reqcase:shadow-recorder:set-semantic-profile-json', async (_event, input) => {
    const content =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && typeof (input as any).json === 'string'
          ? (input as any).json
          : input && typeof input === 'object' && (input as any).profile
            ? JSON.stringify((input as any).profile)
            : null;
    if (!content || typeof content !== 'string') {
      throw new Error('semantic profile JSON content is required');
    }
    const saved = service.setSemanticProfileJson(content);
    const preferredId =
      input && typeof input === 'object' && typeof (input as any).id === 'string'
        ? String((input as any).id).trim()
        : typeof runtimeSettings.activeSemanticProfileId === 'string'
          ? runtimeSettings.activeSemanticProfileId
          : undefined;
    const list = listSemanticProfiles();
    const existing = preferredId ? list.find((p) => p.id === preferredId) : undefined;
    upsertSemanticProfile({
      id: preferredId || undefined,
      sourceFileName: existing?.sourceFileName || 'edited-profile.json',
      sourcePath: existing?.sourcePath,
      profile: saved.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return saved.profileJson;
  });`,
  );

  // clear + activate + remove (replace clear only once)
  if (!ipc.includes('remove-semantic-profile')) {
    replaceHandler(
      'reqcase:shadow-recorder:clear-semantic-profile',
      `ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {
    service.clearSemanticProfile();
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: null,
      semanticProfiles: [],
      activeSemanticProfileId: null,
    };
    await saveRecorderSettings(runtimeSettings);
  });

  ipcMain.handle('reqcase:shadow-recorder:set-active-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const restored = activateSemanticProfileById(id);
    if (!restored) {
      throw new Error(\`semantic profile not found: \${id}\`);
    }
    await saveRecorderSettings(runtimeSettings);
    return restored;
  });

  ipcMain.handle('reqcase:shadow-recorder:remove-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const list = listSemanticProfiles().filter((item) => item.id !== id);
    const activeId = runtimeSettings.activeSemanticProfileId;
    const nextActive = activeId === id ? (list[0]?.id ?? null) : ((activeId as string | null | undefined) ?? null);
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId: nextActive,
      semanticProfile: list.find((p) => p.id === nextActive) ?? list[0] ?? null,
    };
    if (activeId === id) {
      if (list[0]?.profile) {
        service.restoreSemanticProfileObject(list[0].profile);
        runtimeSettings = {
          ...runtimeSettings,
          activeSemanticProfileId: list[0].id,
          semanticProfile: list[0],
        };
      } else {
        service.clearSemanticProfile();
      }
    }
    await saveRecorderSettings(runtimeSettings);
  });`,
    );
  }

  write('src-electron/modules/reqcase-shadow-recorder/ipc.ts', ipc);
  console.log('ipc ok', {
    list: ipc.includes('listSemanticProfiles'),
    activate: ipc.includes('set-active-semantic-profile'),
    remove: ipc.includes('remove-semantic-profile'),
    upsert: ipc.includes('upsertSemanticProfile'),
  });
}

console.log('ALL DONE');
