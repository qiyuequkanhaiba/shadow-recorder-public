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

// ipc-channels
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
  } else console.log('skip channels');
}

// native-binding
{
  let nb = read('src-electron/native-binding.ts');
  if (!nb.includes('export function updateTestSessionStep')) {
    nb += `

export function updateTestSessionStep(input?: {
  sessionId?: string;
  stepId?: string;
  title?: string;
  summary?: string;
}): any {
  const binding = loadNativeBinding() as any;
  if (typeof binding.updateTestSessionStep !== 'function') {
    throw new Error('updateTestSessionStep is unavailable in native binding');
  }
  return binding.updateTestSessionStep(input);
}

export function setSemanticAliasProfile(profile?: any): void {
  const binding = loadNativeBinding() as any;
  if (typeof binding.setSemanticAliasProfile !== 'function') {
    throw new Error('setSemanticAliasProfile is unavailable in native binding');
  }
  binding.setSemanticAliasProfile(profile ?? null);
}

export function getSemanticAliasProfile(): any {
  const binding = loadNativeBinding() as any;
  if (typeof binding.getSemanticAliasProfile !== 'function') {
    throw new Error('getSemanticAliasProfile is unavailable in native binding');
  }
  return binding.getSemanticAliasProfile();
}
`;
    write('src-electron/native-binding.ts', nb);
  } else console.log('skip native-binding');
}

// service
{
  let service = read('src-electron/modules/reqcase-shadow-recorder/service.ts');
  if (!service.includes('nativeUpdateTestSessionStep')) {
    service = service.replace(
      'exportTestDefectPack as nativeExportTestDefectPack,',
      `exportTestDefectPack as nativeExportTestDefectPack,
  updateTestSessionStep as nativeUpdateTestSessionStep,
  setSemanticAliasProfile as nativeSetSemanticAliasProfile,
  getSemanticAliasProfile as nativeGetSemanticAliasProfile,`,
    );
  }
  if (!service.includes('public updateTestSessionStep')) {
    const methods = `
  public updateTestSessionStep(input: {
    sessionId?: string;
    stepId?: string;
    title?: string;
    summary?: string;
  } = {}) {
    return nativeUpdateTestSessionStep(input);
  }

  public setSemanticAliasProfile(profile?: any) {
    return nativeSetSemanticAliasProfile(profile ?? null);
  }

  public getSemanticAliasProfile() {
    return nativeGetSemanticAliasProfile();
  }

`;
    service = service.replace(
      '  public markTestDefect(input: {',
      `${methods}  public markTestDefect(input: {`,
    );
    write('src-electron/modules/reqcase-shadow-recorder/service.ts', service);
  } else console.log('skip service methods');
}

// ipc handlers
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
    ipc = ipc.replace('return service;', `${handlers}\n  return service;`);
    write('src-electron/modules/reqcase-shadow-recorder/ipc.ts', ipc);
  } else console.log('skip ipc');
}

// preload
{
  let preload = read('src-electron/preload.ts');
  if (!preload.includes('updateTestSessionStep')) {
    preload = preload.replace(
      /exportTestDefectPack:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\([^)]+\),/,
      (m) => `${m}
    updateTestSessionStep: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionStep, input),
    setSemanticAliasProfile: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setSemanticAliasProfile, input),
    getSemanticAliasProfile: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getSemanticAliasProfile),`,
    );
    write('src-electron/preload.ts', preload);
  } else console.log('skip preload');
}

// DefectEvidencePanel enhancements
{
  const p = path.join(root, 'src-react/features/evidence/DefectEvidencePanel.tsx');
  let t = fs.readFileSync(p, 'utf8');
  if (!t.includes('handleEditStep')) {
    t = t.replace(
      '  const [packResult, setPackResult] = useState<DefectPackResult | null>(null);',
      `  const [packResult, setPackResult] = useState<DefectPackResult | null>(null);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');`,
    );
    t = t.replace(
      `type DefectPackResult = {
  packDir: string;
  reproStepsPath: string;
  stepCount: number;
  screenshotCount: number;
  videoSegmentCount: number;
};`,
      `type DefectPackResult = {
  packDir: string;
  reproStepsPath: string;
  stepCount: number;
  screenshotCount: number;
  videoSegmentCount: number;
  clipPath?: string;
  clipBuilt?: boolean;
};`,
    );
    t = t.replace(
      `      const mapped: DefectPackResult = {
        packDir: String(result?.packDir ?? ''),
        reproStepsPath: String(result?.reproStepsPath ?? ''),
        stepCount: Number(result?.stepCount ?? 0),
        screenshotCount: Number(result?.screenshotCount ?? 0),
        videoSegmentCount: Number(result?.videoSegmentCount ?? 0),
      };`,
      `      const mapped: DefectPackResult = {
        packDir: String(result?.packDir ?? ''),
        reproStepsPath: String(result?.reproStepsPath ?? ''),
        stepCount: Number(result?.stepCount ?? 0),
        screenshotCount: Number(result?.screenshotCount ?? 0),
        videoSegmentCount: Number(result?.videoSegmentCount ?? 0),
        clipPath: result?.clipPath ? String(result.clipPath) : undefined,
        clipBuilt: !!result?.clipBuilt,
      };`,
    );
    t = t.replace(
      '  function focusStep(step: SemanticStep): void {',
      `  async function handleEditStep(step: SemanticStep): Promise<void> {
    setEditingStepId(step.stepId);
    setEditingTitle(step.title);
  }

  async function handleSaveEdit(step: SemanticStep): Promise<void> {
    const api = getApi();
    if (!api?.updateTestSessionStep) {
      props.onError('当前原生模块不支持步骤编辑。');
      return;
    }
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      props.onError('步骤标题不能为空。');
      return;
    }
    setBusy(true);
    try {
      await api.updateTestSessionStep({
        sessionId: sessionId ?? undefined,
        stepId: step.stepId,
        title: nextTitle,
      });
      setEditingStepId(null);
      await refreshSteps();
      setStatus('步骤标题已更新。');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function focusStep(step: SemanticStep): void {`,
    );
    t = t.replace(
      `{packResult ? (
        <p className="defect-evidence-status">
          包路径: {packResult.packDir} · 步骤 {packResult.stepCount} · 截图 {packResult.screenshotCount} · 视频段{' '}
          {packResult.videoSegmentCount}
        </p>
      ) : null}`,
      `{packResult ? (
        <p className="defect-evidence-status">
          包路径: {packResult.packDir} · 步骤 {packResult.stepCount} · 截图 {packResult.screenshotCount} · 视频段{' '}
          {packResult.videoSegmentCount}
          {packResult.clipBuilt && packResult.clipPath ? ` · clip: ${packResult.clipPath}` : ''}
        </p>
      ) : null}`,
    );
    t = t.replace(
      `{visibleSteps.map((step, index) => (
              <li key={step.stepId || \`\${step.startedAtMs}-\${index}\`}>
                <button type="button" onClick={() => focusStep(step)}>
                  <strong>
                    {index + 1}. {step.title}
                  </strong>
                  <span className="defect-step-meta">
                    <span className={\`precision-badge precision-\${(step.precisionLevel ?? 'l0').toLowerCase()}\`}>
                      {(step.precisionLevel ?? 'l0').toUpperCase()}
                      {typeof step.confidence === 'number'
                        ? \` · \${Math.round(step.confidence * 100)}%\`
                        : ''}
                    </span>
                    <span>
                      {step.stepType}
                      {step.windowTitle ? \` · \${step.windowTitle}\` : ''}
                      {step.controlName ? \` · \${step.controlName}\` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}`,
      `{visibleSteps.map((step, index) => (
              <li key={step.stepId || \`\${step.startedAtMs}-\${index}\`}>
                {editingStepId === step.stepId ? (
                  <div className="defect-step-edit">
                    <input
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      disabled={busy}
                    />
                    <div className="defect-evidence-actions">
                      <button type="button" className="btn-primary" disabled={busy} onClick={() => void handleSaveEdit(step)}>
                        保存
                      </button>
                      <button type="button" disabled={busy} onClick={() => setEditingStepId(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button type="button" onClick={() => focusStep(step)}>
                      <strong>
                        {index + 1}. {step.title}
                      </strong>
                      <span className="defect-step-meta">
                        <span className={\`precision-badge precision-\${(step.precisionLevel ?? 'l0').toLowerCase()}\`}>
                          {(step.precisionLevel ?? 'l0').toUpperCase()}
                          {typeof step.confidence === 'number'
                            ? \` · \${Math.round(step.confidence * 100)}%\`
                            : ''}
                        </span>
                        <span>
                          {step.stepType}
                          {step.windowTitle ? \` · \${step.windowTitle}\` : ''}
                          {step.controlName ? \` · \${step.controlName}\` : ''}
                        </span>
                      </span>
                    </button>
                    <button type="button" className="defect-step-edit-btn" disabled={busy} onClick={() => void handleEditStep(step)}>
                      编辑
                    </button>
                  </>
                )}
              </li>
            ))}`,
    );
    fs.writeFileSync(p, t, 'utf8');
    console.log('DefectEvidencePanel enhanced');
  } else console.log('panel already enhanced');
}

// CSS
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
    console.log('css edit styles added');
  }
}

// sample semantic alias file
{
  const sample = path.resolve('examples/desktop/semantic-alias.sample.json');
  if (!fs.existsSync(sample)) {
    fs.writeFileSync(
      sample,
      JSON.stringify(
        {
          profileId: 'demo',
          rules: [
            {
              matchControlName: '保存',
              alias: '保存订单',
            },
            {
              matchAutomationId: 'btnNewOrder',
              alias: '新建订单',
            },
            {
              matchTitleContains: '登录',
              aliasPrefix: '业务·',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log('wrote semantic-alias.sample.json');
  }
}

console.log('phase-c frontend patch done');
