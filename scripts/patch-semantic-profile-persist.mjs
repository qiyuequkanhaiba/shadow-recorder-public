/**
 * Wire semantic profile import + settings persistence.
 * Run from repo root: node scripts/patch-semantic-profile-persist.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(__dirname, '../examples/desktop');

function read(rel) {
  return fs.readFileSync(path.join(desktop, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(desktop, rel), content, 'utf8');
}

function mustInclude(s, needle, label) {
  if (!s.includes(needle)) {
    throw new Error(`Missing needle in ${label}: ${JSON.stringify(needle.slice(0, 100))}`);
  }
}

// 1) contracts.ts
{
  const rel = 'types/contracts.ts';
  let s = read(rel);
  if (!s.includes('SemanticProfileImportRecord')) {
    const insert = `
/** Imported semantic profile persisted in app settings (survives restarts). */
export interface SemanticProfileImportRecord {
  sourceFileName: string;
  sourcePath?: string;
  importedAtMs: number;
  /** Normalized profile object (alias/scenario rules, target process, etc.). */
  profile: Record<string, unknown>;
}

`;
    s = s.replace(
      'export interface RecorderPersistedSettings {',
      `${insert}export interface RecorderPersistedSettings {`,
    );
    s = s.replace(
      `export interface RecorderPersistedSettings {
  config?: RecorderConfigPayload;
  autoApplyLastRecommendedProfile?: boolean;
  lastRecommendedProfile?: RecorderTuningProfile;
  lastRecommendationReason?: string;
  [key: string]: unknown;
}`,
      `export interface RecorderPersistedSettings {
  config?: RecorderConfigPayload;
  autoApplyLastRecommendedProfile?: boolean;
  lastRecommendedProfile?: RecorderTuningProfile;
  lastRecommendationReason?: string;
  /** Last imported semantic profile; restored into native on app start. */
  semanticProfile?: SemanticProfileImportRecord | null;
  [key: string]: unknown;
}`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 2) settings-store.ts
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/settings-store.ts';
  let s = read(rel);
  if (!s.includes('sanitizeSemanticProfileImport')) {
    s = s.replace(
      `import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderPersistedSettings,
} from './types';`,
      `import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderPersistedSettings,
} from './types';
import type { SemanticProfileImportRecord } from '../../../types/contracts';`,
    );
    const helper = `
function sanitizeSemanticProfileImport(value: unknown): SemanticProfileImportRecord | null | undefined {
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
  const sourceFileName =
    typeof input.sourceFileName === 'string' && input.sourceFileName.trim()
      ? input.sourceFileName.trim()
      : 'imported-profile.json';
  const importedAtMs =
    typeof input.importedAtMs === 'number' && Number.isFinite(input.importedAtMs)
      ? Math.trunc(input.importedAtMs)
      : Date.now();
  const record: SemanticProfileImportRecord = {
    sourceFileName,
    importedAtMs,
    profile: input.profile as Record<string, unknown>,
  };
  if (typeof input.sourcePath === 'string' && input.sourcePath.trim()) {
    record.sourcePath = input.sourcePath.trim();
  }
  return record;
}

`;
    s = s.replace(
      'function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {',
      `${helper}function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {`,
    );
    s = s.replace(
      `  if (typeof input.updatedAtMs === 'number') {
    output.updatedAtMs = input.updatedAtMs;
  }

  return output;
}`,
      `  if (typeof input.updatedAtMs === 'number') {
    output.updatedAtMs = input.updatedAtMs;
  }

  if ('semanticProfile' in input) {
    const semanticProfile = sanitizeSemanticProfileImport(input.semanticProfile);
    if (semanticProfile !== undefined) {
      output.semanticProfile = semanticProfile;
    }
  }

  return output;
}`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 3) service.ts
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/service.ts';
  let s = read(rel);
  if (!s.includes('importSemanticProfileFromPath')) {
    if (!s.includes("from 'node:fs'")) {
      s = s.replace(
        "import path from 'node:path';",
        "import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';",
      );
    }
    s = s.replace(
      `  loadSemanticProfile(profilePath: string) {
    return nativeLoadSemanticProfile(profilePath);
  }

  getSemanticProfileJson() {
    return nativeGetSemanticProfileJson();
  }

  clearSemanticProfile() {
    return nativeClearSemanticProfile();
  }`,
      `  resolveSemanticProfileActivePath(): string {
    return path.join(app.getPath('userData'), 'semantic-profiles', 'active.json');
  }

  loadSemanticProfile(profilePath: string) {
    return nativeLoadSemanticProfile(profilePath);
  }

  /**
   * Import a profile file: validate via native load, copy into userData, return normalized JSON.
   */
  importSemanticProfileFromPath(sourcePath: string): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    const profileJson = nativeLoadSemanticProfile(sourcePath);
    const profile = JSON.parse(profileJson) as Record<string, unknown>;
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    // Reload from managed copy so runtime always pins to userData path.
    nativeLoadSemanticProfile(activePath);
    return {
      profileJson: nativeGetSemanticProfileJson() ?? profileJson,
      profile,
      activePath,
    };
  }

  restoreSemanticProfileObject(profile: Record<string, unknown>): string {
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    return nativeLoadSemanticProfile(activePath);
  }

  getSemanticProfileJson() {
    return nativeGetSemanticProfileJson();
  }

  clearSemanticProfile() {
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
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 4) ipc-channels.ts
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts';
  let s = read(rel);
  if (!s.includes('importSemanticProfile')) {
    s = s.replace(
      `  loadSemanticProfile: 'reqcase:shadow-recorder:load-semantic-profile',
  getSemanticProfileJson: 'reqcase:shadow-recorder:get-semantic-profile-json',
  clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',`,
      `  loadSemanticProfile: 'reqcase:shadow-recorder:load-semantic-profile',
  importSemanticProfile: 'reqcase:shadow-recorder:import-semantic-profile',
  getSemanticProfileJson: 'reqcase:shadow-recorder:get-semantic-profile-json',
  clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 5) ipc.ts
{
  const rel = 'src-electron/modules/reqcase-shadow-recorder/ipc.ts';
  let s = read(rel);
  if (!s.includes('import-semantic-profile')) {
    // Detect path import alias
    const pathImport = s.match(/import\s+(\w+)\s+from\s+['"]node:path['"]/);
    const pathId = pathImport ? pathImport[1] : 'path';
    if (!pathImport) {
      s = s.replace(/^import /, "import path from 'node:path';\nimport ");
    }

    const restoreBlock = `
  const restorePersistedSemanticProfile = (): void => {
    const record = runtimeSettings.semanticProfile;
    if (!record || !record.profile || typeof record.profile !== 'object') {
      return;
    }
    try {
      service.restoreSemanticProfileObject(record.profile as Record<string, unknown>);
    } catch (error) {
      console.error('Failed to restore persisted semantic profile', error);
    }
  };
  restorePersistedSemanticProfile();
`;
    const marker = '  service.setPushPublisher((step) => {';
    mustInclude(s, marker, 'ipc setPushPublisher');
    s = s.replace(marker, `${restoreBlock}\n${marker}`);

    const oldHandlers = `  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
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
  });`;

    const newHandlers = `  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
    const profilePath = typeof input === 'string' ? input : input?.path;
    if (!profilePath || typeof profilePath !== 'string') {
      throw new Error('semantic profile path is required');
    }
    const imported = service.importSemanticProfileFromPath(profilePath);
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: {
        sourceFileName: ${pathId}.basename(profilePath),
        sourcePath: profilePath,
        importedAtMs: Date.now(),
        profile: imported.profile,
      },
    };
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });
  ipcMain.handle('reqcase:shadow-recorder:import-semantic-profile', async () => {
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
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: {
        sourceFileName: ${pathId}.basename(profilePath),
        sourcePath: profilePath,
        importedAtMs: Date.now(),
        profile: imported.profile,
      },
    };
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });
  ipcMain.handle('reqcase:shadow-recorder:get-semantic-profile-json', async () => {
    return service.getSemanticProfileJson();
  });
  ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {
    service.clearSemanticProfile();
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: null,
    };
    await saveRecorderSettings(runtimeSettings);
  });`;

    mustInclude(s, oldHandlers, 'ipc old handlers');
    s = s.replace(oldHandlers, newHandlers);
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 6) preload.ts
{
  const rel = 'src-electron/preload.ts';
  let s = read(rel);
  if (!s.includes('importSemanticProfile')) {
    s = s.replace(
      `  loadSemanticProfile?: (input: string | { path: string }) => Promise<string>;
  getSemanticProfileJson?: () => Promise<string | null>;
  clearSemanticProfile?: () => Promise<void>;`,
      `  loadSemanticProfile?: (input: string | { path: string }) => Promise<string>;
  importSemanticProfile?: () => Promise<string | null>;
  getSemanticProfileJson?: () => Promise<string | null>;
  clearSemanticProfile?: () => Promise<void>;`,
    );
    s = s.replace(
      `    loadSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:load-semantic-profile', input),
    getSemanticProfileJson: () => ipcRenderer.invoke('reqcase:shadow-recorder:get-semantic-profile-json'),
    clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),`,
      `    loadSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:load-semantic-profile', input),
    importSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:import-semantic-profile'),
    getSemanticProfileJson: () => ipcRenderer.invoke('reqcase:shadow-recorder:get-semantic-profile-json'),
    clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 7) d.ts
{
  const rel = 'types/native-shadow-recorder.d.ts';
  let s = read(rel);
  if (!s.includes('importSemanticProfile')) {
    s = s.replace(
      `  loadSemanticProfile?(path: string): string;
  getSemanticProfileJson?(): string | null;
  clearSemanticProfile?(): void;`,
      `  loadSemanticProfile?(path: string): string;
  importSemanticProfile?(): string | null;
  getSemanticProfileJson?(): string | null;
  clearSemanticProfile?(): void;`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

// 8) UI panel
{
  const rel = 'src-react/features/evidence/DefectEvidenceSettingsPanel.tsx';
  const content = `import { useCallback, useEffect, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';

import type { RecorderConfigPayload, SemanticProfileImportRecord } from '../../../types/contracts';

type DefectEvidenceSettingsPanelProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
};

type SemanticProfileSummary = {
  profileId?: string;
  name?: string;
  targetProcessName?: string | null;
  aliasRules?: unknown[];
  scenarioRules?: unknown[];
};

function getApi(): any {
  return (window as any).reqcaseShadowRecorder;
}

function clampSeconds(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toSummary(raw: unknown): SemanticProfileSummary | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as SemanticProfileSummary;
  } catch {
    return null;
  }
}

export function DefectEvidenceSettingsPanel(props: DefectEvidenceSettingsPanelProps) {
  const enabled = props.config.semanticRecordingEnabled ?? !!props.config.defectEvidenceEnabled;
  const pre = props.config.defectPreWindowSeconds ?? 60;
  const post = props.config.defectPostWindowSeconds ?? 20;
  const [profileSummary, setProfileSummary] = useState<SemanticProfileSummary | null>(null);
  const [importMeta, setImportMeta] = useState<Pick<
    SemanticProfileImportRecord,
    'sourceFileName' | 'sourcePath' | 'importedAtMs'
  > | null>(null);
  const [profileStatus, setProfileStatus] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);

  function update<K extends keyof RecorderConfigPayload>(key: K, value: RecorderConfigPayload[K]) {
    props.setConfig((current) => ({ ...current, [key]: value }));
  }

  function updateSemanticRecordingEnabled(value: boolean) {
    props.setConfig((current) => ({
      ...current,
      defectEvidenceEnabled: value,
      semanticRecordingEnabled: value,
    }));
  }

  const refreshProfile = useCallback(async () => {
    const api = getApi();
    try {
      let fromSettings: SemanticProfileSummary | null = null;
      if (typeof api?.getSettings === 'function') {
        const settings = await api.getSettings();
        const record = settings?.semanticProfile as SemanticProfileImportRecord | null | undefined;
        if (record && record.profile) {
          setImportMeta({
            sourceFileName: record.sourceFileName,
            sourcePath: record.sourcePath,
            importedAtMs: record.importedAtMs,
          });
          fromSettings = record.profile as SemanticProfileSummary;
          setProfileSummary(fromSettings);
        } else {
          setImportMeta(null);
        }
      }
      if (typeof api?.getSemanticProfileJson === 'function') {
        const raw = await api.getSemanticProfileJson();
        const summary = toSummary(raw);
        if (summary) {
          setProfileSummary(summary);
        } else if (!fromSettings) {
          setProfileSummary(null);
        }
      }
    } catch {
      setProfileSummary(null);
      setImportMeta(null);
    }
  }, []);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  async function handleImportProfile(): Promise<void> {
    const api = getApi();
    if (typeof api?.importSemanticProfile !== 'function') {
      setProfileStatus('当前版本不支持导入语义画像，请重新构建 desktop 应用。');
      return;
    }
    setProfileBusy(true);
    setProfileStatus('');
    try {
      const raw = await api.importSemanticProfile();
      if (raw == null) {
        setProfileStatus('已取消导入。');
        return;
      }
      const parsed = toSummary(raw);
      setProfileSummary(parsed);
      if (typeof api.getSettings === 'function') {
        const settings = await api.getSettings();
        const record = settings?.semanticProfile as SemanticProfileImportRecord | null | undefined;
        if (record) {
          setImportMeta({
            sourceFileName: record.sourceFileName,
            sourcePath: record.sourcePath,
            importedAtMs: record.importedAtMs,
          });
        }
      }
      setProfileStatus(
        \`已导入并保存画像「\${parsed?.name || parsed?.profileId || 'unnamed'}」\` +
          (parsed?.targetProcessName ? \`，目标进程 \${parsed.targetProcessName}\` : '') +
          '。已写入本地配置，下次启动自动加载。',
      );
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleClearProfile(): Promise<void> {
    const api = getApi();
    if (typeof api?.clearSemanticProfile !== 'function') {
      setProfileStatus('当前版本不支持清除语义画像。');
      return;
    }
    setProfileBusy(true);
    try {
      await api.clearSemanticProfile();
      setProfileSummary(null);
      setImportMeta(null);
      setProfileStatus('已清除活动语义画像，并已从本地配置移除。');
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <section className="settings-form-panel" aria-label="步骤记录设置">
      <header className="settings-form-header">
        <h3>步骤记录</h3>
        <p>
          可选功能。开启后才会在录制过程中补充控件识别、键盘摘要，并生成可导出的语义步骤。
          关闭时仅保留循环录像与基础事件日志，开销更低。
        </p>
      </header>

      <label className="settings-toggle">
        <span>
          <strong>启用语义记录</strong>
          <small>UIA 控件补全 · 键盘摘要 · 步骤聚合 · 记录包导出</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            updateSemanticRecordingEnabled(event.target.checked);
          }}
        />
      </label>

      <div className={\`settings-form-grid \${enabled ? '' : 'is-disabled'}\`}>
        <label>
          <span>标记前窗口（秒）</span>
          <input
            type="number"
            min={5}
            max={600}
            value={pre}
            disabled={!enabled}
            onChange={(event) => {
              update(
                'defectPreWindowSeconds',
                clampSeconds(Number(event.target.value), 5, 600, 60),
              );
            }}
          />
        </label>
        <label>
          <span>标记后窗口（秒）</span>
          <input
            type="number"
            min={0}
            max={300}
            value={post}
            disabled={!enabled}
            onChange={(event) => {
              update(
                'defectPostWindowSeconds',
                clampSeconds(Number(event.target.value), 0, 300, 20),
              );
            }}
          />
        </label>
      </div>

      <div className={\`settings-form-note \${enabled ? '' : 'is-disabled'}\`} style={{ marginTop: 12 }}>
        <p>
          <strong>被测软件语义画像</strong>
        </p>
        <p>
          通过文件导入 JSON 画像（含 qttimer 快照）。导入后写入本地配置，应用重启后自动恢复，无需每次重新选择。
        </p>
      </div>

      <div className="defect-evidence-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!enabled || profileBusy}
          onClick={() => void handleImportProfile()}
        >
          导入画像…
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!enabled || profileBusy || !profileSummary}
          onClick={() => void handleClearProfile()}
        >
          清除画像
        </button>
      </div>

      {profileSummary ? (
        <div className="settings-form-note" aria-label="当前画像">
          <p>
            <strong>当前画像：</strong>
            {profileSummary.name || profileSummary.profileId || 'unnamed'}
          </p>
          <p>
            目标进程：{profileSummary.targetProcessName || '（未指定）'} · 别名规则{' '}
            {profileSummary.aliasRules?.length ?? 0} · 场景规则{' '}
            {profileSummary.scenarioRules?.length ?? 0}
          </p>
          {importMeta ? (
            <p>
              来源：{importMeta.sourceFileName}
              {importMeta.importedAtMs
                ? \` · 导入于 \${new Date(importMeta.importedAtMs).toLocaleString()}\`
                : ''}
              （已持久化）
            </p>
          ) : (
            <p>已加载（会话内）。建议使用「导入画像」以写入配置。</p>
          )}
        </div>
      ) : (
        <div className="settings-form-note">
          <p>未导入画像时使用通用操作语义。可导入 qttimer 的 semantic-profile 快照以提升特定软件精度。</p>
        </div>
      )}

      {profileStatus ? <p className="defect-evidence-status">{profileStatus}</p> : null}

      <div className="settings-form-note">
        <p>建议：日常长时巡检可关闭；需要提单/复现时再开启。</p>
        <p>针对特定软件：导入画像后，录制将优先绑定画像中的目标进程，并用别名/场景规则解释操作结果。</p>
        <p>开启语义记录后请点击设置页的「保存并应用」，新录制会话会按配置采集。</p>
      </div>
    </section>
  );
}
`;
  write(rel, content);
  console.log('wrote', rel);
}

// 9) contract test extension
{
  const rel = 'scripts/semantic-profile-contract-test.ts';
  let s = read(rel);
  if (!s.includes('SemanticProfileImportRecord')) {
    s = s.replace(
      `  assert.match(libSource, /get_semantic_profile_json/);

  console.log('semantic-profile-contract-test: ok');`,
      `  assert.match(libSource, /get_semantic_profile_json/);

  const contractsSource = readFileSync(path.join(__dirname, '../types/contracts.ts'), 'utf8');
  assert.match(contractsSource, /SemanticProfileImportRecord/);
  assert.match(contractsSource, /semanticProfile\\?:/);

  const settingsStore = readFileSync(
    path.join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/settings-store.ts'),
    'utf8',
  );
  assert.match(settingsStore, /sanitizeSemanticProfileImport/);

  const ipcSource = readFileSync(
    path.join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/ipc.ts'),
    'utf8',
  );
  assert.match(ipcSource, /import-semantic-profile/);
  assert.match(ipcSource, /restorePersistedSemanticProfile/);

  console.log('semantic-profile-contract-test: ok');`,
    );
    write(rel, s);
    console.log('patched', rel);
  } else {
    console.log('skip', rel);
  }
}

console.log('ALL DONE');
