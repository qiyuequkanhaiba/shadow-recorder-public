/**
 * Finish IPC wiring for semantic profile import + persist (CRLF-safe).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ipcPath = path.resolve(
  __dirname,
  '../examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts',
);

let s = fs.readFileSync(ipcPath, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';

if (!s.includes('restorePersistedSemanticProfile')) {
  const marker = '  service.setPushPublisher((step) => {';
  if (!s.includes(marker)) {
    throw new Error('setPushPublisher marker not found');
  }
  const restoreBlock = [
    '  const restorePersistedSemanticProfile = (): void => {',
    '    const record = runtimeSettings.semanticProfile;',
    "    if (!record || !record.profile || typeof record.profile !== 'object') {",
    '      return;',
    '    }',
    '    try {',
    '      service.restoreSemanticProfileObject(record.profile as Record<string, unknown>);',
    '    } catch (error) {',
    "      console.error('Failed to restore persisted semantic profile', error);",
    '    }',
    '  };',
    '  restorePersistedSemanticProfile();',
    '',
  ].join(nl);
  s = s.replace(marker, restoreBlock + marker);
  console.log('inserted restorePersistedSemanticProfile');
} else {
  console.log('restore already present');
}

const re =
  /  ipcMain\.handle\('reqcase:shadow-recorder:load-semantic-profile'[\s\S]*?ipcMain\.handle\('reqcase:shadow-recorder:clear-semantic-profile'[\s\S]*?\}\);/;

if (!re.test(s)) {
  throw new Error('handlers regex failed');
}

if (s.includes('import-semantic-profile') && s.includes('importSemanticProfileFromPath')) {
  console.log('handlers already patched');
} else {
  const newHandlers = [
    "  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {",
    "    const profilePath = typeof input === 'string' ? input : input?.path;",
    "    if (!profilePath || typeof profilePath !== 'string') {",
    "      throw new Error('semantic profile path is required');",
    '    }',
    '    const imported = service.importSemanticProfileFromPath(profilePath);',
    '    runtimeSettings = {',
    '      ...runtimeSettings,',
    '      semanticProfile: {',
    '        sourceFileName: path.basename(profilePath),',
    '        sourcePath: profilePath,',
    '        importedAtMs: Date.now(),',
    '        profile: imported.profile,',
    '      },',
    '    };',
    '    await saveRecorderSettings(runtimeSettings);',
    '    return imported.profileJson;',
    '  });',
    '',
    "  ipcMain.handle('reqcase:shadow-recorder:import-semantic-profile', async () => {",
    '    const result = await dialog.showOpenDialog({',
    "      title: '导入语义画像',",
    "      properties: ['openFile'],",
    '      filters: [',
    "        { name: 'Semantic Profile JSON', extensions: ['json'] },",
    "        { name: 'All Files', extensions: ['*'] },",
    '      ],',
    '    });',
    '    if (result.canceled || !result.filePaths[0]) {',
    '      return null;',
    '    }',
    '    const profilePath = result.filePaths[0];',
    '    const imported = service.importSemanticProfileFromPath(profilePath);',
    '    runtimeSettings = {',
    '      ...runtimeSettings,',
    '      semanticProfile: {',
    '        sourceFileName: path.basename(profilePath),',
    '        sourcePath: profilePath,',
    '        importedAtMs: Date.now(),',
    '        profile: imported.profile,',
    '      },',
    '    };',
    '    await saveRecorderSettings(runtimeSettings);',
    '    return imported.profileJson;',
    '  });',
    '',
    "  ipcMain.handle('reqcase:shadow-recorder:get-semantic-profile-json', async () => {",
    '    return service.getSemanticProfileJson();',
    '  });',
    '',
    "  ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {",
    '    service.clearSemanticProfile();',
    '    runtimeSettings = {',
    '      ...runtimeSettings,',
    '      semanticProfile: null,',
    '    };',
    '    await saveRecorderSettings(runtimeSettings);',
    '  });',
  ].join(nl);

  s = s.replace(re, newHandlers);
  console.log('replaced semantic profile handlers');
}

fs.writeFileSync(ipcPath, s, 'utf8');
console.log('ok', {
  import: s.includes('import-semantic-profile'),
  restore: s.includes('restorePersistedSemanticProfile'),
  persist: s.includes('importSemanticProfileFromPath'),
});
