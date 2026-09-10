import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderTuningProfile,
  TestSessionDisplayTarget,
} from '../../types/contracts';
import {
  deriveInternalMaxSteps,
  resolveRecordingWindowSeconds,
  resolveSegmentDurationSeconds,
} from '../../types/recording-defaults';
import { DEFAULT_BUFFER_BYTES } from '../lib/tuning-advisor';
import { t } from '../lib/i18n';
import type { VideoEncoderSummary } from '../lib/video-encoder-summary';

export type ConfigApplyFeedback = {
  status: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

export type SettingsControlSection =
  | 'recording'
  | 'capture'
  | 'shortcuts'
  | 'performance';

type RecorderControlPanelProps = {
  section?: SettingsControlSection;
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  recommendation: { profile: RecorderTuningProfile; reason: string };
  profileLabels: Record<RecorderTuningProfile, string>;
  autoApplyRecommendedOnStartup: boolean;
  availableDisplays: TestSessionDisplayTarget[];
  displaysLoading: boolean;
  onToggleAutoApply: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onApplyProfile: (profile: RecorderTuningProfile) => Promise<void>;
  busy: boolean;
  error: string;
  applyFeedback: ConfigApplyFeedback;
  encoderSummary: VideoEncoderSummary;
};

export function RecorderControlPanel(props: RecorderControlPanelProps) {
  const availableDisplays = props.availableDisplays;
  const singleTargetDisplayId = (
    props.config.targetDisplayId
    ?? props.config.targetDisplayIds?.[0]
    ?? availableDisplays.find((display) => display.isPrimary)?.displayId
    ?? availableDisplays[0]?.displayId
    ?? ''
  );
  const selectedDisplayIds = Array.isArray(props.config.targetDisplayIds)
    ? props.config.targetDisplayIds.filter((displayId) =>
      availableDisplays.some((display) => display.displayId === displayId))
    : [];
  const allDisplayIds = availableDisplays.map((display) => display.displayId);
  const effectiveSelectedDisplayIds = selectedDisplayIds.length > 0
    ? selectedDisplayIds
    : allDisplayIds;
  const primaryDisplayId = availableDisplays.find((display) => display.isPrimary)?.displayId
    ?? availableDisplays[0]?.displayId
    ?? '';

  function formatDisplayLabel(display: TestSessionDisplayTarget): string {
    const primaryTag = display.isPrimary ? ' · 主显示器' : '';
    return `${display.label} · ${display.width}×${display.height}${primaryTag}`;
  }

  function formatDisplayMeta(display: TestSessionDisplayTarget): string {
    return `坐标 ${display.left}, ${display.top} · 区域 ${display.width}×${display.height}`;
  }

  function handleTargetModeChange(nextMode: RecorderConfigPayload['targetCaptureMode']): void {
    props.setConfig((current) => {
      const nextConfig: RecorderConfigPayload = {
        ...current,
        targetCaptureMode: nextMode,
      };

      if ((nextMode === 'target_display' || nextMode === 'desktop') && availableDisplays.length > 0) {
        const nextDisplayId = current.targetDisplayId
          ?? current.targetDisplayIds?.[0]
          ?? availableDisplays.find((display) => display.isPrimary)?.displayId
          ?? availableDisplays[0]?.displayId;
        nextConfig.targetDisplayId = nextDisplayId;
        nextConfig.targetDisplayIds = nextDisplayId ? [nextDisplayId] : undefined;
      }

      if (nextMode === 'all_displays' && availableDisplays.length > 0) {
        nextConfig.targetDisplayIds = current.targetDisplayIds?.length
          ? current.targetDisplayIds
          : availableDisplays.map((display) => display.displayId);
        nextConfig.targetDisplayId = nextConfig.targetDisplayIds[0];
      }

      return nextConfig;
    });
  }

  function handleSingleDisplayChange(nextDisplayId: string): void {
    props.setConfig((current) => ({
      ...current,
      targetDisplayId: nextDisplayId || undefined,
      targetDisplayIds: nextDisplayId ? [nextDisplayId] : undefined,
    }));
  }

  function handleMultiDisplayToggle(displayId: string): void {
    props.setConfig((current) => {
      const currentIds = Array.isArray(current.targetDisplayIds) && current.targetDisplayIds.length > 0
        ? current.targetDisplayIds
        : allDisplayIds;
      const nextIds = currentIds.includes(displayId)
        ? currentIds.filter((item) => item !== displayId)
        : [...currentIds, displayId];
      return {
        ...current,
        targetDisplayId: nextIds[0],
        targetDisplayIds: nextIds.length > 0 ? nextIds : undefined,
      };
    });
  }

  function applyMultiDisplaySelection(nextDisplayIds: string[]): void {
    props.setConfig((current) => ({
      ...current,
      targetDisplayId: nextDisplayIds[0],
      targetDisplayIds: nextDisplayIds.length > 0 ? nextDisplayIds : undefined,
    }));
  }

  const section = props.section ?? 'recording';

  const sectionMeta: Record<SettingsControlSection, { title: string; desc: string }> = {
    recording: {
      title: '录制参数',
      desc: '循环窗口、分段时长、画质档位与防抖等基础参数。',
    },
    capture: {
      title: '捕获目标',
      desc: '选择录制范围、显示器与捕获后端。',
    },
    shortcuts: {
      title: '快捷键',
      desc: '全局开始/停止录制快捷键。',
    },
    performance: {
      title: '性能与高级',
      desc: '性能预设与缓冲、传输、编码策略等进阶选项。',
    },
  };

  const meta = sectionMeta[section];

  return (
    <section className="settings-form settings-form-pane">
      <header className="settings-form-header">
        <div className="settings-form-header-copy">
          <h2>{meta.title}</h2>
          <p>{meta.desc}</p>
        </div>
        {section === 'recording' || section === 'performance' ? (
          <div className="meta-tags settings-form-status">
            <span className="meta-tag">
              <strong>编码</strong>
              <span title={props.encoderSummary.detailLabel}>{props.encoderSummary.encoderLabel}</span>
            </span>
            <span className="meta-tag">
              <strong>路径</strong>
              <span>
                {props.encoderSummary.pathLabel}
                {props.encoderSummary.isHardwareActive === true
                  ? ' · 硬编'
                  : props.encoderSummary.isHardwareActive === false
                    ? ' · 软编'
                    : ''}
              </span>
            </span>
            <span className="meta-tag">
              <strong>流</strong>
              <span>{props.encoderSummary.streamLabel}</span>
            </span>
          </div>
        ) : null}
      </header>

      {section === 'recording' ? (
      <section className="settings-section">
        <div className="settings-fields">
          <label className="settings-field">
            <span className="settings-field-label">{t('config.recordingWindowSeconds')}</span>
            <input
              type="number"
              min={30}
              max={3600}
              value={resolveRecordingWindowSeconds(props.config.recordingWindowSeconds)}
              onChange={(event) => {
                const recordingWindowSeconds = resolveRecordingWindowSeconds(Number(event.target.value));
                props.setConfig((current) => ({
                  ...current,
                  recordingWindowSeconds,
                  segmentDurationSeconds: resolveSegmentDurationSeconds(
                    current.segmentDurationSeconds,
                    recordingWindowSeconds,
                  ),
                  maxSteps: deriveInternalMaxSteps(recordingWindowSeconds),
                }));
              }}
            />
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.segmentDurationSeconds')}</span>
            <input
              type="number"
              min={2}
              max={60}
              value={resolveSegmentDurationSeconds(
                props.config.segmentDurationSeconds,
                props.config.recordingWindowSeconds,
              )}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  segmentDurationSeconds: resolveSegmentDurationSeconds(
                    Number(event.target.value),
                    current.recordingWindowSeconds,
                  ),
                }))
              }
            />
          </label>

          <label className="settings-field">
            <span className="settings-field-label">录制档位</span>
            <select
              value={props.config.recordingProfile ?? 'balanced'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  recordingProfile: event.target.value as RecorderConfigPayload['recordingProfile'],
                }))
              }
            >
              <option value="efficiency">省资源 · 7 FPS</option>
              <option value="balanced">标准 · 14 FPS</option>
              <option value="smooth">流畅 · 20 FPS</option>
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.showMouseInVideo')}</span>
            <select
              value={(props.config.showMouseInVideo ?? false) ? 'enabled' : 'disabled'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  showMouseInVideo: event.target.value === 'enabled',
                }))
              }
            >
              <option value="disabled">关闭</option>
              <option value="enabled">开启</option>
            </select>
            <small className="settings-field-hint">关闭可避免连续录屏时鼠标图标闪动。</small>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.debounce')}</span>
            <input
              type="number"
              min={20}
              max={2000}
              value={props.config.debounceMs ?? 90}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  debounceMs: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
      </section>
      ) : null}

      {section === 'capture' ? (
      <section className="settings-section">
        <div className="settings-fields">
          <label className="settings-field">
            <span className="settings-field-label">录制目标</span>
            <select
              value={props.config.targetCaptureMode ?? 'target_display'}
              onChange={(event) =>
                handleTargetModeChange(event.target.value as RecorderConfigPayload['targetCaptureMode'])
              }
            >
              <option value="target_display">当前显示器录制</option>
              <option value="desktop">当前桌面录制</option>
              <option value="all_displays">全部显示器</option>
              <option value="foreground_window">前台窗口跟随录制</option>
            </select>
          </label>

          {(props.config.targetCaptureMode ?? 'target_display') === 'target_display'
            || (props.config.targetCaptureMode ?? 'target_display') === 'desktop' ? (
            <label className="settings-field">
              <span className="settings-field-label">指定显示器</span>
              <select
                value={singleTargetDisplayId}
                disabled={props.displaysLoading || availableDisplays.length === 0}
                onChange={(event) => {
                  handleSingleDisplayChange(event.target.value);
                }}
              >
                {availableDisplays.length === 0 ? (
                  <option value="">未检测到显示器</option>
                ) : availableDisplays.map((display) => (
                  <option key={display.displayId} value={display.displayId}>
                    {formatDisplayLabel(display)}
                  </option>
                ))}
              </select>
              <small className="settings-field-hint">
                {props.displaysLoading
                  ? '正在检测显示器…'
                  : availableDisplays.length > 0
                    ? `已检测 ${availableDisplays.length} 台，仅录制当前选中显示器。`
                    : '未检测到显示器，将回退到主显示器。'}
              </small>
            </label>
          ) : null}

          <label className="settings-field">
            <span className="settings-field-label">{t('config.captureBackend')}</span>
            <select
              value={props.config.captureBackend ?? 'dxgi'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  captureBackend: event.target.value as RecorderConfigPayload['captureBackend'],
                }))
              }
            >
              <option value="dxgi">{t('config.backend.dxgi')}</option>
              <option value="wgc">{t('config.backend.wgc')}</option>
            </select>
            <small className="settings-field-hint">默认 DXGI，避免 WGC 黄色边框。</small>
          </label>
        </div>

        {(props.config.targetCaptureMode ?? 'target_display') === 'all_displays' ? (
          <div className="settings-subpanel">
            <div className="settings-subpanel-head">
              <div>
                <strong>同时录制的显示器</strong>
                <small>
                  {props.displaysLoading
                    ? '正在检测…'
                    : availableDisplays.length > 0
                      ? `已检测 ${availableDisplays.length} 台，可多选。`
                      : '未检测到显示器。'}
                </small>
              </div>
              <span className="meta-tag">
                {selectedDisplayIds.length > 0 ? `已选 ${selectedDisplayIds.length} 台` : '默认全部'}
              </span>
            </div>

            <div className="settings-check-grid">
              {availableDisplays.length === 0 ? (
                <div className="settings-empty">当前未检测到可用显示器。</div>
              ) : availableDisplays.map((display) => {
                const checked = effectiveSelectedDisplayIds.includes(display.displayId);
                return (
                  <label
                    key={display.displayId}
                    className={`settings-check ${checked ? 'is-active' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        handleMultiDisplayToggle(display.displayId);
                      }}
                    />
                    <span className="settings-check-copy">
                      <strong>{formatDisplayLabel(display)}</strong>
                      <small>{formatDisplayMeta(display)}</small>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="settings-inline-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={availableDisplays.length === 0}
                onClick={() => { applyMultiDisplaySelection(allDisplayIds); }}
              >
                全选
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!primaryDisplayId}
                onClick={() => {
                  applyMultiDisplaySelection(primaryDisplayId ? [primaryDisplayId] : []);
                }}
              >
                仅主屏
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={selectedDisplayIds.length === 0}
                onClick={() => { applyMultiDisplaySelection([]); }}
              >
                默认全部
              </button>
            </div>
          </div>
        ) : null}
      </section>
      ) : null}

      {section === 'shortcuts' ? (
      <section className="settings-section">
        <div className="settings-fields">
          <label className="settings-field settings-field-grow">
            <span className="settings-field-label">{t('config.shortcutStart')}</span>
            <input
              type="text"
              placeholder="e.g. CommandOrControl+Shift+R"
              value={props.config.shortcutStartRecording ?? ''}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  shortcutStartRecording: event.target.value || undefined,
                }))
              }
            />
          </label>
          <label className="settings-field settings-field-grow">
            <span className="settings-field-label">{t('config.shortcutStop')}</span>
            <input
              type="text"
              placeholder="e.g. CommandOrControl+Shift+S"
              value={props.config.shortcutStopRecording ?? ''}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  shortcutStopRecording: event.target.value || undefined,
                }))
              }
            />
          </label>
        </div>
      </section>
      ) : null}

      {section === 'performance' ? (
      <>
      <section className="settings-section settings-section-block">
        <h3 className="settings-section-title">性能预设</h3>
        <p className="settings-section-desc">
          {t('preset.recommendation')}: {props.profileLabels[props.recommendation.profile]} · {props.recommendation.reason}
        </p>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={props.autoApplyRecommendedOnStartup}
            onChange={props.onToggleAutoApply}
          />
          <span>{t('preset.autoApply')}</span>
        </label>
        <div className="settings-inline-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={props.busy} onClick={() => props.onApplyProfile('stability')}>
            {t('preset.apply')} {t('preset.stability')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={props.busy} onClick={() => props.onApplyProfile('latency')}>
            {t('preset.apply')} {t('preset.latency')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={props.busy} onClick={() => props.onApplyProfile('size')}>
            {t('preset.apply')} {t('preset.size')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm recommended"
            disabled={props.busy}
            onClick={() => props.onApplyProfile(props.recommendation.profile)}
          >
            {t('preset.applyRecommended')}
          </button>
        </div>
        <p className="settings-section-desc">
          桌面操作较频繁时，优先「流畅」档，防抖建议 60–90ms。
          {props.applyFeedback.message ? ` · ${props.applyFeedback.message}` : ''}
        </p>
      </section>
      )

      <section className="settings-section settings-section-block">
        <h3 className="settings-section-title">高级参数</h3>
        <div className="settings-fields settings-fields-advanced">
          <label className="settings-field">
            <span className="settings-field-label">{t('config.maxBuffer')}</span>
            <input
              type="number"
              min={10}
              max={1024}
              value={Math.round((props.config.maxBufferBytes ?? DEFAULT_BUFFER_BYTES) / (1024 * 1024))}
              onChange={(event) => {
                const valueMb = Number(event.target.value);
                props.setConfig((current) => ({
                  ...current,
                  maxBufferBytes: Math.max(10, valueMb) * 1024 * 1024,
                }));
              }}
            />
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.transportMode')}</span>
            <select
              value={props.config.transportMode ?? 'poll'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  transportMode: event.target.value as RecorderConfigPayload['transportMode'],
                }))
              }
            >
              <option value="poll">{t('config.transport.poll')}</option>
              <option value="push">{t('config.transport.push')}</option>
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">编码策略</span>
            <select
              value={props.config.encoderPreference ?? 'auto'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  encoderPreference: event.target.value as RecorderConfigPayload['encoderPreference'],
                }))
              }
            >
              <option value="auto">自动优先硬编</option>
              <option value="hardware">优先硬件编码</option>
              <option value="software">仅软件编码</option>
            </select>
            <small className="settings-field-hint">
              实际：{props.encoderSummary.encoderLabel} · {props.encoderSummary.pathLabel}
            </small>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.captureReuse')}</span>
            <select
              value={(props.config.captureReuseEnabled ?? true) ? 'enabled' : 'disabled'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  captureReuseEnabled: event.target.value === 'enabled',
                }))
              }
            >
              <option value="enabled">{t('config.reuse.enabled')}</option>
              <option value="disabled">{t('config.reuse.disabled')}</option>
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.webpQuality')}</span>
            <input
              type="number"
              min={10}
              max={95}
              value={props.config.webpQuality ?? 75}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  webpQuality: Number(event.target.value),
                }))
              }
            />
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('config.targetImage')}</span>
            <input
              type="number"
              min={30}
              max={4096}
              value={props.config.adaptiveTargetImageKb ?? 100}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  adaptiveTargetImageKb: Number(event.target.value),
                }))
              }
            />
          </label>

          <label className="settings-field settings-field-grow">
            <span className="settings-field-label">AI Replay Provider</span>
            <select
              value={props.config.aiReplayProvider ?? 'disabled'}
              onChange={(event) =>
                props.setConfig((current) => ({
                  ...current,
                  aiReplayProvider: event.target.value as RecorderConfigPayload['aiReplayProvider'],
                  aiReplayEnabled: event.target.value === 'openai_compatible'
                    ? current.aiReplayEnabled === true
                    : false,
                }))
              }
            >
              <option value="disabled">Disabled - default</option>
              <option value="mock">Mock - deterministic local</option>
              <option value="openai_compatible">OpenAI-compatible - cloud/local</option>
            </select>
            <small className="settings-field-hint">
              默认关闭。OpenAI-compatible 可用于 OpenAI / Ollama / LM Studio。
            </small>
          </label>

          {props.config.aiReplayProvider === 'openai_compatible' ? (
            <>
              <label className="settings-toggle settings-field-span">
                <input
                  type="checkbox"
                  checked={props.config.aiReplayEnabled === true}
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      aiReplayEnabled: event.target.checked,
                    }))
                  }
                />
                <span>启用 AI replay 生成</span>
              </label>

              <label className="settings-field settings-field-grow">
                <span className="settings-field-label">Base URL</span>
                <input
                  value={props.config.aiReplayOpenAiBaseUrl ?? ''}
                  placeholder="https://api.openai.com/v1/chat/completions"
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      aiReplayOpenAiBaseUrl: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label">Model</span>
                <input
                  value={props.config.aiReplayOpenAiModel ?? ''}
                  placeholder="gpt-4o-mini"
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      aiReplayOpenAiModel: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label">API Key</span>
                <input
                  type="password"
                  value={props.config.aiReplayOpenAiApiKey ?? ''}
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      aiReplayOpenAiApiKey: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label">Timeout (ms)</span>
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  value={props.config.aiReplayOpenAiTimeoutMs ?? 30000}
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      aiReplayOpenAiTimeoutMs: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </>
          ) : null}
        </div>
      </section>
      </>
      ) : null}

      {props.error ? <p className="error settings-form-error">{props.error}</p> : null}
    </section>
  );
}

