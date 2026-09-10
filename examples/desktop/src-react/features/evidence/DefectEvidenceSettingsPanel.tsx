import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';

import type { RecorderConfigPayload, SemanticProfileImportRecord } from '../../../types/contracts';
import { isSemanticRecordingEnabled } from '../../lib/recorder-page-bindings';
import {
  SemanticProfileEditor,
  type EditableSemanticProfile,
} from './SemanticProfileEditor';

type DefectEvidenceSettingsPanelProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
};

type ProfileLibraryItem = SemanticProfileImportRecord;

function getApi(): any {
  return (window as any).reqcaseShadowRecorder;
}

function clampSeconds(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function asProfile(raw: unknown): EditableSemanticProfile | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as EditableSemanticProfile;
  } catch {
    return null;
  }
}

function recordId(item: ProfileLibraryItem, index: number): string {
  if (item.id && String(item.id).trim()) return String(item.id);
  const p = item.profile as EditableSemanticProfile | undefined;
  if (p?.profileId) return String(p.profileId);
  if (p?.name) return `name:${p.name}`;
  return item.sourceFileName || `profile-${index + 1}`;
}

function tabLabel(item: ProfileLibraryItem): string {
  const p = item.profile as EditableSemanticProfile | undefined;
  const process = p?.targetProcessName ? String(p.targetProcessName) : '';
  const name = p?.name || p?.profileId || item.sourceFileName || item.id || '未命名';
  if (process && process !== name) {
    return `${name}`;
  }
  return String(name);
}

function tabSubLabel(item: ProfileLibraryItem): string {
  const p = item.profile as EditableSemanticProfile | undefined;
  const parts: string[] = [];
  if (p?.targetProcessName) parts.push(String(p.targetProcessName));
  const aliasCount = Array.isArray(p?.aliasRules) ? p!.aliasRules!.length : 0;
  parts.push(`${aliasCount} 别名`);
  return parts.join(' · ');
}

export function DefectEvidenceSettingsPanel(props: DefectEvidenceSettingsPanelProps) {
  const enabled = isSemanticRecordingEnabled(props.config);
  const pre = props.config.defectPreWindowSeconds ?? 60;
  const post = props.config.defectPostWindowSeconds ?? 20;

  const [library, setLibrary] = useState<ProfileLibraryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<EditableSemanticProfile | null>(null);
  const [profileStatus, setProfileStatus] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

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

  const activeItem = useMemo(() => {
    if (!library.length) return null;
    return library.find((item, i) => recordId(item, i) === activeId) ?? library[0];
  }, [library, activeId]);

  const refreshLibrary = useCallback(async () => {
    const api = getApi();
    try {
      let nextLibrary: ProfileLibraryItem[] = [];
      let nextActive: string | null = null;

      if (typeof api?.getSettings === 'function') {
        const settings = await api.getSettings();
        const list = Array.isArray(settings?.semanticProfiles)
          ? (settings.semanticProfiles as ProfileLibraryItem[])
          : [];
        if (list.length > 0) {
          nextLibrary = list.map((item, index) => ({
            ...item,
            id: recordId(item, index),
          }));
        } else if (settings?.semanticProfile?.profile) {
          const legacy = settings.semanticProfile as ProfileLibraryItem;
          nextLibrary = [{ ...legacy, id: recordId(legacy, 0) }];
        }
        nextActive =
          typeof settings?.activeSemanticProfileId === 'string'
            ? settings.activeSemanticProfileId
            : nextLibrary[0]?.id ?? null;
      }

      setLibrary(nextLibrary);
      setActiveId(nextActive);

      const selected =
        nextLibrary.find((item, i) => recordId(item, i) === nextActive) ?? nextLibrary[0] ?? null;
      if (selected?.profile) {
        setProfileDraft(selected.profile as EditableSemanticProfile);
      } else if (typeof api?.getSemanticProfileJson === 'function') {
        const raw = await api.getSemanticProfileJson();
        setProfileDraft(asProfile(raw));
      } else {
        setProfileDraft(null);
      }
    } catch {
      setLibrary([]);
      setActiveId(null);
      setProfileDraft(null);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

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
      const parsed = asProfile(raw);
      await refreshLibrary();
      setEditorOpen(true);
      if (parsed) {
        setProfileDraft(parsed);
        const id = String(parsed.profileId || '');
        if (id) setActiveId(id);
      }
      setProfileStatus(
        `已导入「${parsed?.name || parsed?.profileId || 'unnamed'}」` +
          (parsed?.targetProcessName ? `（${parsed.targetProcessName}）` : '') +
          `，别名 ${parsed?.aliasRules?.length ?? 0} 条。可切换 Tab 管理多个软件画像。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileStatus(message);
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleSelectTab(id: string): Promise<void> {
    if (id === activeId || profileBusy) return;
    const api = getApi();
    setProfileBusy(true);
    setProfileStatus('');
    try {
      if (typeof api?.setActiveSemanticProfile === 'function') {
        const raw = await api.setActiveSemanticProfile(id);
        const parsed = asProfile(raw);
        setActiveId(id);
        if (parsed) setProfileDraft(parsed);
        else {
          const item = library.find((entry, i) => recordId(entry, i) === id);
          setProfileDraft((item?.profile as EditableSemanticProfile) ?? null);
        }
        setProfileStatus(`已切换到画像「${parsed?.name || id}」，录制将使用该画像。`);
      } else {
        // fallback: local only
        const item = library.find((entry, i) => recordId(entry, i) === id);
        setActiveId(id);
        setProfileDraft((item?.profile as EditableSemanticProfile) ?? null);
      }
      await refreshLibrary();
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleSaveProfile(): Promise<void> {
    const api = getApi();
    if (!profileDraft) {
      setProfileStatus('没有可保存的画像。');
      return;
    }
    if (typeof api?.setSemanticProfileJson !== 'function') {
      setProfileStatus('当前版本不支持保存语义画像，请重新构建 desktop 应用。');
      return;
    }
    setProfileBusy(true);
    setProfileStatus('');
    try {
      const raw = await api.setSemanticProfileJson({
        id: activeId ?? undefined,
        profile: profileDraft,
      });
      const parsed = asProfile(raw) ?? profileDraft;
      setProfileDraft(parsed);
      await refreshLibrary();
      setProfileStatus(
        `已保存「${parsed?.name || parsed?.profileId || 'unnamed'}」` +
          (parsed?.targetProcessName ? `，目标进程 ${parsed.targetProcessName}` : '') +
          `，别名 ${parsed?.aliasRules?.length ?? 0} 条。`,
      );
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleRemoveActive(): Promise<void> {
    const api = getApi();
    if (!activeId) return;
    if (typeof api?.removeSemanticProfile !== 'function') {
      setProfileStatus('当前版本不支持删除画像。');
      return;
    }
    setProfileBusy(true);
    try {
      await api.removeSemanticProfile(activeId);
      setEditorOpen(false);
      await refreshLibrary();
      setProfileStatus('已从库中移除该画像。');
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleClearAll(): Promise<void> {
    const api = getApi();
    if (typeof api?.clearSemanticProfile !== 'function') {
      setProfileStatus('当前版本不支持清除语义画像。');
      return;
    }
    setProfileBusy(true);
    try {
      await api.clearSemanticProfile();
      setLibrary([]);
      setActiveId(null);
      setProfileDraft(null);
      setEditorOpen(false);
      setProfileStatus('已清空全部语义画像。');
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <section className="settings-form-panel settings-form-panel-fluid" aria-label="步骤记录设置">
      <header className="settings-form-header">
        <h3>步骤记录</h3>
        <p>
          可选功能。开启后在录制中补充控件识别与语义步骤。可导入多个软件的画像 JSON，用 Tab 切换当前生效画像。
        </p>
      </header>

      <div className="steps-settings-section">
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

        <div
          className={`settings-form-grid settings-form-grid-fluid ${enabled ? '' : 'is-disabled'}`}
          style={{ marginTop: 14 }}
        >
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
      </div>

      <div className={`steps-settings-section ${enabled ? '' : 'is-disabled'}`}>
        <div className="profile-library-header">
          <div>
            <h4 className="steps-settings-section-title">语义画像库</h4>
            <p className="steps-settings-section-desc">
              支持导入多个软件的 semantic-profile / qttimer 快照 /{' '}
              <code>elements_selected_*.json</code>。每个软件一个 Tab；当前 Tab 为录制时生效的画像。
            </p>
          </div>
          <div className="defect-evidence-actions profile-library-actions">
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
              className="btn btn-secondary btn-sm"
              disabled={!enabled || profileBusy || !profileDraft}
              onClick={() => setEditorOpen((open) => !open)}
            >
              {editorOpen ? '收起编辑' : '编辑当前'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!enabled || profileBusy || !activeId}
              onClick={() => void handleRemoveActive()}
            >
              移除当前
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!enabled || profileBusy || library.length === 0}
              onClick={() => void handleClearAll()}
            >
              清空全部
            </button>
          </div>
        </div>

        {library.length > 0 ? (
          <div className="profile-tabs" role="tablist" aria-label="已导入的语义画像">
            {library.map((item, index) => {
              const id = recordId(item, index);
              const selected = id === (activeId ?? recordId(library[0], 0));
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`profile-tab${selected ? ' is-active' : ''}`}
                  disabled={!enabled || profileBusy}
                  onClick={() => void handleSelectTab(id)}
                  title={tabSubLabel(item)}
                >
                  <span className="profile-tab-title">{tabLabel(item)}</span>
                  <span className="profile-tab-meta">{tabSubLabel(item)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="steps-settings-section-desc" style={{ marginTop: 4 }}>
            尚未导入画像。导入后可在此以 Tab 管理多款被测软件。
          </p>
        )}

        {activeItem && profileDraft ? (
          <div className="profile-active-summary" aria-label="当前生效画像">
            <div className="profile-active-summary-main">
              <strong>{profileDraft.name || profileDraft.profileId || activeItem.id}</strong>
              <span className="profile-active-badge">当前生效</span>
            </div>
            <div className="profile-active-summary-meta">
              目标进程 {profileDraft.targetProcessName || '未指定'}
              {' · '}
              别名 {profileDraft.aliasRules?.length ?? 0}
              {' · '}
              场景{' '}
              {Array.isArray(profileDraft.scenarioRules) ? profileDraft.scenarioRules.length : 0}
              {profileDraft.source ? ` · ${profileDraft.source}` : ''}
              {activeItem.sourceFileName ? ` · ${activeItem.sourceFileName}` : ''}
            </div>
          </div>
        ) : null}

        {enabled && editorOpen && profileDraft ? (
          <SemanticProfileEditor
            profile={profileDraft}
            disabled={!enabled}
            busy={profileBusy}
            onChange={setProfileDraft}
            onSave={() => void handleSaveProfile()}
          />
        ) : null}

        {profileStatus ? <p className="defect-evidence-status">{profileStatus}</p> : null}
      </div>

      <div className="steps-settings-section">
        <p className="steps-settings-section-desc" style={{ marginBottom: 0 }}>
          切换 Tab 会立即对应画像；录制开始时使用当前生效画像。请在设置页点击「保存并应用」以同步语义记录开关等配置。
        </p>
      </div>
    </section>
  );
}
