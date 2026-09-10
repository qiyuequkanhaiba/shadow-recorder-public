import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

const map = {
  markTestDefect: 'reqcase:shadow-recorder:mark-test-defect',
  getTestSessionSteps: 'reqcase:shadow-recorder:get-test-session-steps',
  rebuildTestSessionSteps: 'reqcase:shadow-recorder:rebuild-test-session-steps',
  renderTestSessionReproSteps: 'reqcase:shadow-recorder:render-test-session-repro-steps',
  exportTestDefectPack: 'reqcase:shadow-recorder:export-test-defect-pack',
  updateTestSessionStep: 'reqcase:shadow-recorder:update-test-session-step',
  setSemanticAliasProfile: 'reqcase:shadow-recorder:set-semantic-alias-profile',
  getSemanticAliasProfile: 'reqcase:shadow-recorder:get-semantic-alias-profile',
};

// preload
{
  const p = path.join(root, 'src-electron/preload.ts');
  let t = fs.readFileSync(p, 'utf8');
  for (const [key, channel] of Object.entries(map)) {
    t = t.replaceAll(
      `REQCASE_SHADOW_RECORDER_CHANNELS.${key}`,
      `'${channel}'`,
    );
  }
  fs.writeFileSync(p, t, 'utf8');
  console.log('preload channel literals');
}

// ipc
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  let t = fs.readFileSync(p, 'utf8');
  for (const [key, channel] of Object.entries(map)) {
    t = t.replaceAll(
      `REQCASE_SHADOW_RECORDER_CHANNELS.${key}`,
      `'${channel}'`,
    );
    t = t.replaceAll(
      `(REQCASE_SHADOW_RECORDER_CHANNELS as any).${key}`,
      `'${channel}'`,
    );
  }
  fs.writeFileSync(p, t, 'utf8');
  console.log('ipc channel literals');
}

// native-binding
{
  const p = path.join(root, 'src-electron/native-binding.ts');
  let t = fs.readFileSync(p, 'utf8');
  t = t.replaceAll('getBinding()', 'getBinding() as any');
  // undo double cast
  t = t.replaceAll('getBinding() as any as any', 'getBinding() as any');
  fs.writeFileSync(p, t, 'utf8');
  console.log('native-binding getBinding cast');
}

console.log('done');
