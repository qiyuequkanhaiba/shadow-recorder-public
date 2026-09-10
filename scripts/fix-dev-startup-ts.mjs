import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

// 1) Fix native-binding: loadNativeBinding -> getBinding
{
  const p = path.join(root, 'src-electron/native-binding.ts');
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace(/loadNativeBinding\(\)/g, 'getBinding()');
  // add types for untyped params
  t = t.replace(
    'export function updateTestSessionStep(input) {',
    'export function updateTestSessionStep(input?: any) {',
  );
  t = t.replace(
    'export function setSemanticAliasProfile(profile) {',
    'export function setSemanticAliasProfile(profile?: any) {',
  );
  fs.writeFileSync(p, t, 'utf8');
  console.log('fixed native-binding getBinding');
}

// 2) Fix ipc.ts structure: ensure phase-c handlers are inside register function
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  let t = fs.readFileSync(p, 'utf8');

  // Extract any orphan handlers after a premature function close near end.
  // Pattern observed:
  //   });
  // }
  //
  //   ipcMain.handle(...update...
  //   return service;
  //
  // Target:
  //   });
  //   ipcMain.handle(...update...
  //   return service;
  // }

  // If there is a premature `}\n\n  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep`
  const bad = `\n}\n\n  \n  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep`;
  const bad2 = `\n}\n\n  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep`;
  if (t.includes(bad) || t.includes(bad2) || /}\s*\n\s*ipcMain\.handle\(REQCASE_SHADOW_RECORDER_CHANNELS\.updateTestSessionStep/.test(t)) {
    t = t.replace(
      /}\s*\n\s*ipcMain\.handle\(REQCASE_SHADOW_RECORDER_CHANNELS\.updateTestSessionStep/,
      '  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep',
    );
    // Ensure file ends with return service + closing brace once
    if (!t.trimEnd().endsWith('}')) {
      // no-op
    }
    // If return service is missing close brace after it
    if (/return service;\s*$/.test(t.trimEnd())) {
      t = `${t.trimEnd()}\n}\n`;
    }
    // Remove duplicate return service if any
    const parts = t.split('return service;');
    if (parts.length > 2) {
      t = parts[0] + 'return service;' + parts.slice(1).join('').replace(/return service;/g, '');
    }
    fs.writeFileSync(p, t, 'utf8');
    console.log('fixed ipc premature close');
  } else {
    // Alternative cleanup: if update handlers exist after last function close before return
    const returnIdx = t.lastIndexOf('return service;');
    const closeBefore = t.lastIndexOf('\n}', returnIdx);
    // check if update handle is after a close that is after exportDefect
    const updateIdx = t.indexOf('REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep');
    if (updateIdx > 0 && returnIdx > updateIdx) {
      // Look for `}\n` immediately before update handle block
      const beforeUpdate = t.slice(0, updateIdx);
      const m = beforeUpdate.match(/\n}\s*$/);
      if (m) {
        t = beforeUpdate.replace(/\n}\s*$/, '\n') + t.slice(updateIdx);
        if (!/return service;\s*\n}\s*$/.test(t.trimEnd() + '\n')) {
          // ensure closing
          if (t.includes('return service;')) {
            t = t.replace(/return service;\s*$/, 'return service;\n}\n');
          }
        }
        fs.writeFileSync(p, t, 'utf8');
        console.log('fixed ipc by removing close before update handlers');
      } else {
        console.log('ipc structure may already be ok; manual check');
      }
    } else {
      console.log('ipc no update handler pattern found or order unexpected');
    }
  }

  // Final normalize end
  t = fs.readFileSync(p, 'utf8');
  // remove trailing orphan braces mess
  t = t.replace(/\n}\s*\n\s*ipcMain\.handle\(REQCASE_SHADOW_RECORDER_CHANNELS\.updateTestSessionStep/g,
    '\n  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep');
  if (t.includes('return service;') && !/return service;\s*\n}\s*$/.test(t)) {
    // if return service not followed by closing of function
    const ri = t.lastIndexOf('return service;');
    const after = t.slice(ri + 'return service;'.length);
    if (!after.trim().startsWith('}')) {
      t = t.slice(0, ri) + 'return service;\n}\n';
    }
  }
  fs.writeFileSync(p, t, 'utf8');

  // Verify roughly: update handler before last return, and function closes after
  t = fs.readFileSync(p, 'utf8');
  const updateIdx = t.indexOf('updateTestSessionStep');
  const retIdx = t.lastIndexOf('return service;');
  console.log('ipc update<return', updateIdx > 0 && updateIdx < retIdx, 'update', updateIdx, 'ret', retIdx);
  console.log('ends with close', t.trimEnd().endsWith('}'));
}

// 3) Fix service profile any
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/service.ts');
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace(
    'public setSemanticAliasProfile(profile) {',
    'public setSemanticAliasProfile(profile?: any) {',
  );
  t = t.replace(
    'public updateTestSessionStep(input = {}) {',
    'public updateTestSessionStep(input: any = {}) {',
  );
  fs.writeFileSync(p, t, 'utf8');
  console.log('fixed service types');
}

// 4) Preload API type + input any types
{
  const p = path.join(root, 'src-electron/preload.ts');
  let t = fs.readFileSync(p, 'utf8');

  // Add API fields if missing in type
  if (t.includes('export type ReqCaseShadowRecorderRendererApi') && !t.includes('markTestDefect?:')) {
    t = t.replace(
      'exportTestSessionEvidence?: (',
      `markTestDefect?: (input?: any) => Promise<any>;
  getTestSessionSteps?: (input?: any) => Promise<any[]>;
  rebuildTestSessionSteps?: (input?: any) => Promise<any[]>;
  renderTestSessionReproSteps?: (input?: any) => Promise<string>;
  exportTestDefectPack?: (input?: any) => Promise<any>;
  updateTestSessionStep?: (input?: any) => Promise<any>;
  setSemanticAliasProfile?: (input?: any) => Promise<void>;
  getSemanticAliasProfile?: () => Promise<any>;
  exportTestSessionEvidence?: (`,
    );
  }

  // Type input params in api object
  t = t.replace(/markTestDefect: \(input\) =>/g, 'markTestDefect: (input?: any) =>');
  t = t.replace(/getTestSessionSteps: \(input\) =>/g, 'getTestSessionSteps: (input?: any) =>');
  t = t.replace(/rebuildTestSessionSteps: \(input\) =>/g, 'rebuildTestSessionSteps: (input?: any) =>');
  t = t.replace(/renderTestSessionReproSteps: \(input\) =>/g, 'renderTestSessionReproSteps: (input?: any) =>');
  t = t.replace(/exportTestDefectPack: \(input\) =>/g, 'exportTestDefectPack: (input?: any) =>');
  t = t.replace(/updateTestSessionStep: \(input\) =>/g, 'updateTestSessionStep: (input?: any) =>');
  t = t.replace(/setSemanticAliasProfile: \(input\) =>/g, 'setSemanticAliasProfile: (input?: any) =>');

  fs.writeFileSync(p, t, 'utf8');
  console.log('fixed preload types');
}

// 5) DefectEvidencePanel sessionId type
{
  const p = path.join(root, 'src-react/features/evidence/DefectEvidencePanel.tsx');
  let t = fs.readFileSync(p, 'utf8');
  // playback focus sessionId should allow undefined or cast
  t = t.replace(
    'sessionId: step.sessionId || sessionId || undefined,',
    'sessionId: (step.sessionId || sessionId || undefined) as string | undefined,',
  );
  // if TestSessionPlaybackFocus requires string, use empty fallback
  if (t.includes('TestSessionPlaybackFocus')) {
    t = t.replace(
      'sessionId: (step.sessionId || sessionId || undefined) as string | undefined,',
      "sessionId: step.sessionId || sessionId || '',",
    );
  }
  fs.writeFileSync(p, t, 'utf8');
  console.log('fixed DefectEvidencePanel sessionId');
}

// 6) Ensure ipc-channels is complete and not truncated
{
  const p = path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts');
  let t = fs.readFileSync(p, 'utf8');
  const required = [
    'markTestDefect',
    'getTestSessionSteps',
    'rebuildTestSessionSteps',
    'renderTestSessionReproSteps',
    'exportTestDefectPack',
    'updateTestSessionStep',
    'setSemanticAliasProfile',
    'getSemanticAliasProfile',
  ];
  for (const key of required) {
    if (!t.includes(`${key}:`)) {
      console.warn('missing channel', key);
    }
  }
  console.log('channels ok checks done');
}

console.log('fix-dev-startup-ts done');
