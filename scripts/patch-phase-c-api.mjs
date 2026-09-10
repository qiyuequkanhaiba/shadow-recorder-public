import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, content) => {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log('patched', rel);
};

// channels
{
  let ch = read('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts');
  if (!ch.includes('updateTestSessionStep')) {
    ch = ch.replace(
      "exportTestDefectPack: 'reqcase:shadow-recorder:export-test-defect-pack',",
      [
        "exportTestDefectPack: 'reqcase:shadow-recorder:export-test-defect-pack',",
        "  updateTestSessionStep: 'reqcase:shadow-recorder:update-test-session-step',",
        "  setSemanticAliasProfile: 'reqcase:shadow-recorder:set-semantic-alias-profile',",
        "  getSemanticAliasProfile: 'reqcase:shadow-recorder:get-semantic-alias-profile',",
      ].join('\n'),
    );
    write('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts', ch);
  }
}

// native-binding
{
  let nb = read('src-electron/native-binding.ts');
  if (!nb.includes('export function updateTestSessionStep')) {
    nb += `
export function updateTestSessionStep(input) {
  const binding = loadNativeBinding();
  if (typeof binding.updateTestSessionStep !== 'function') {
    throw new Error('updateTestSessionStep is unavailable in native binding');
  }
  return binding.updateTestSessionStep(input);
}

export function setSemanticAliasProfile(profile) {
  const binding = loadNativeBinding();
  if (typeof binding.setSemanticAliasProfile !== 'function') {
    throw new Error('setSemanticAliasProfile is unavailable in native binding');
  }
  return binding.setSemanticAliasProfile(profile ?? null);
}

export function getSemanticAliasProfile() {
  const binding = loadNativeBinding();
  if (typeof binding.getSemanticAliasProfile !== 'function') {
    throw new Error('getSemanticAliasProfile is unavailable in native binding');
  }
  return binding.getSemanticAliasProfile();
}
`;
    write('src-electron/native-binding.ts', nb);
  }
}

// service imports + methods
{
  let service = read('src-electron/modules/reqcase-shadow-recorder/service.ts');
  if (!service.includes('nativeUpdateTestSessionStep')) {
    service = service.replace(
      'exportTestDefectPack as nativeExportTestDefectPack,',
      'exportTestDefectPack as nativeExportTestDefectPack,\n  updateTestSessionStep as nativeUpdateTestSessionStep,\n  setSemanticAliasProfile as nativeSetSemanticAliasProfile,\n  getSemanticAliasProfile as nativeGetSemanticAliasProfile,',
    );
  }
  if (!service.includes('public updateTestSessionStep')) {
    const methods = `
  public updateTestSessionStep(input = {}) {
    return nativeUpdateTestSessionStep(input);
  }

  public setSemanticAliasProfile(profile) {
    return nativeSetSemanticAliasProfile(profile ?? null);
  }

  public getSemanticAliasProfile() {
    return nativeGetSemanticAliasProfile();
  }

`;
    if (service.includes('public markTestDefect(input: {')) {
      service = service.replace('  public markTestDefect(input: {', methods + '  public markTestDefect(input: {');
    } else if (service.includes('public markTestDefect(input')) {
      service = service.replace('  public markTestDefect(input', methods + '  public markTestDefect(input');
    } else {
      service = service.replace(
        '  public async exportSessionEvidence',
        methods + '  public async exportSessionEvidence',
      );
    }
    write('src-electron/modules/reqcase-shadow-recorder/service.ts', service);
  }
}

// ipc
{
  let ipc = read('src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  if (!ipc.includes('updateTestSessionStep')) {
    const handlers = `
  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep, async (_event, input) => {
    const record = isRecord(input) ? input : {};
    return service.updateTestSessionStep({
      sessionId: optionalString(record, 'sessionId'),
      stepId: optionalString(record, 'stepId'),
      title: optionalString(record, 'title'),
      summary: optionalString(record, 'summary'),
    });
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.setSemanticAliasProfile, async (_event, input) => {
    return service.setSemanticAliasProfile(input ?? null);
  });

  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.getSemanticAliasProfile, async () => {
    return service.getSemanticAliasProfile();
  });
`;
    ipc = ipc.replace('return service;', handlers + '\n  return service;');
    write('src-electron/modules/reqcase-shadow-recorder/ipc.ts', ipc);
  }
}

// preload
{
  let preload = read('src-electron/preload.ts');
  if (!preload.includes('updateTestSessionStep')) {
    preload = preload.replace(
      "exportTestDefectPack: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestDefectPack, input),",
      "exportTestDefectPack: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestDefectPack, input),\n    updateTestSessionStep: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep, input),\n    setSemanticAliasProfile: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setSemanticAliasProfile, input),\n    getSemanticAliasProfile: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getSemanticAliasProfile),",
    );
    write('src-electron/preload.ts', preload);
  }
}

// css
{
  const p = path.join(root, 'src-react/styles/evidence.css');
  let t = fs.readFileSync(p, 'utf8');
  if (!t.includes('defect-step-edit')) {
    t += `
.defect-step-edit {
  display: grid;
  gap: 6px;
  padding: 6px 0;
}
.defect-step-edit input {
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.12));
  background: transparent;
  color: inherit;
  padding: 6px 8px;
}
.defect-step-edit-btn {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.8;
}
.precision-l4 { background: rgba(168,85,247,0.18); color: #d8b4fe; }
`;
    fs.writeFileSync(p, t, 'utf8');
    console.log('css updated');
  }
}

// sample alias
{
  const sample = path.resolve('examples/desktop/semantic-alias.sample.json');
  if (!fs.existsSync(sample)) {
    fs.writeFileSync(
      sample,
      JSON.stringify(
        {
          profileId: 'demo',
          rules: [
            { matchControlName: '保存', alias: '保存订单' },
            { matchAutomationId: 'btnNewOrder', alias: '新建订单' },
            { matchTitleContains: '登录', aliasPrefix: '业务·' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log('sample alias written');
  }
}

console.log('phase-c api patch done');
