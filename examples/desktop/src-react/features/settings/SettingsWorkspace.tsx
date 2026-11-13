import { useState } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import clsx from 'clsx';
import {
  Camera,
  Check,
  Disc,
  EyeOff,
  Sliders,
  Sparkles,
  Zap,
} from 'lucide-react';

import type {
  RecorderConfigPayload,
  RecorderTuningProfile,
  TestSessionDisplayTarget,
} from '../../../types/contracts';
import type { VideoEncoderSummary } from '../../lib/video-encoder-summary';
import { Button } from '../../ui';
import { DefectEvidenceSettingsPanel } from '../evidence/DefectEvidenceSettingsPanel';
import { PrivacySettingsPanel } from '../privacy/PrivacySettingsPanel';
import { CaptureSettingsSection } from './CaptureSettingsSection';
import { PerformanceSettingsSection } from './PerformanceSettingsSection';
import { RecordingSettingsSection } from './RecordingSettingsSection';
import styles from './SettingsWorkspace.module.css';
import { ShortcutsSettingsSection } from './ShortcutsSettingsSection';

export type SettingsNavId =
  | 'recording'
  | 'capture'
  | 'shortcuts'
  | 'performance'
  | 'privacy'
  | 'defect';

type SettingsNavItem = {
  id: SettingsNavId;
  label: string;
  hint: string;
  icon: typeof Disc;
};

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'recording', label: '录制参数', hint: '窗口 / 档位 / 防抖', icon: Disc },
  { id: 'capture', label: '捕获目标', hint: '显示器 / 后端', icon: Camera },
  { id: 'shortcuts', label: '快捷键', hint: '开始 / 停止 / 截图', icon: Zap },
  { id: 'performance', label: '性能与高级', hint: '预设 / 缓冲 / 编码', icon: Sliders },
  { id: 'privacy', label: '隐私规则', hint: '遮罩 / 排除', icon: EyeOff },
  { id: 'defect', label: '步骤记录', hint: '语义步骤 / 标记', icon: Sparkles },
];

export type ConfigApplyFeedback = {
  status: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

export type SettingsWorkspaceProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  unsavedCount: number;
  onApplyConfig: () => Promise<void>;
  onDiscardConfig: () => void;
  recommendation: {
    profile: RecorderTuningProfile;
    reason: string;
  };
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

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavId>('recording');

  const {
    config,
    setConfig,
    unsavedCount,
    onApplyConfig,
    onDiscardConfig,
    recommendation,
    profileLabels,
    autoApplyRecommendedOnStartup,
    availableDisplays,
    displaysLoading,
    onToggleAutoApply,
    onApplyProfile,
    busy,
    error,
    applyFeedback,
    encoderSummary,
  } = props;

  return (
    <div data-ui-scope="settings" className={styles.workspace}>
      <aside className={styles.nav} aria-label="设置分类">
        <div className={styles.navTitle}>配置分类</div>
        <nav className={styles.navList} role="tablist" aria-orientation="vertical">
          {NAV_ITEMS.map((item) => {
            const active = activeNav === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={clsx(styles.navItem, active && styles.navItemActive)}
                onClick={() => setActiveNav(item.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon size={14} aria-hidden="true" />
                  <span className={styles.navItemLabel}>{item.label}</span>
                </div>
                <span className={styles.navItemHint}>{item.hint}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className={styles.mainColumn}>
        <div className={styles.contentScroll} role="tabpanel">
          {activeNav === 'recording' && (
            <RecordingSettingsSection
              config={config}
              setConfig={setConfig}
              encoderSummary={encoderSummary}
              error={error}
            />
          )}

          {activeNav === 'capture' && (
            <CaptureSettingsSection
              config={config}
              setConfig={setConfig}
              availableDisplays={availableDisplays}
              displaysLoading={displaysLoading}
              error={error}
            />
          )}

          {activeNav === 'shortcuts' && (
            <ShortcutsSettingsSection
              config={config}
              setConfig={setConfig}
              error={error}
            />
          )}

          {activeNav === 'performance' && (
            <PerformanceSettingsSection
              config={config}
              setConfig={setConfig}
              recommendation={recommendation}
              profileLabels={profileLabels}
              autoApplyRecommendedOnStartup={autoApplyRecommendedOnStartup}
              onToggleAutoApply={onToggleAutoApply}
              onApplyProfile={onApplyProfile}
              busy={busy}
              encoderSummary={encoderSummary}
              error={error}
            />
          )}

          {activeNav === 'privacy' && (
            <PrivacySettingsPanel
              config={config}
              setConfig={setConfig}
              error={error}
            />
          )}

          {activeNav === 'defect' && (
            <DefectEvidenceSettingsPanel
              config={config}
              setConfig={setConfig}
              error={error}
            />
          )}
        </div>

        <div className={styles.saveBar} role="toolbar" aria-label="配置保存工具栏">
          <div className={styles.saveBarMeta}>
            {unsavedCount > 0 ? (
              <span className={styles.unsavedCount}>有 {unsavedCount} 项未保存</span>
            ) : (
              <span className={styles.unsavedClean}>
                <Check size={14} style={{ display: 'inline', marginRight: 4 }} />
                配置已同步
              </span>
            )}

            {applyFeedback.status !== 'idle' ? (
              <span
                className={clsx(
                  styles.feedbackStatus,
                  applyFeedback.status === 'success' && styles.feedbackSuccess,
                  applyFeedback.status === 'error' && styles.feedbackError,
                )}
                role="status"
                aria-live="polite"
              >
                {applyFeedback.message}
              </span>
            ) : null}
          </div>

          <div className={styles.saveBarActions}>
            <Button
              variant="ghost"
              size="md"
              disabled={busy || unsavedCount === 0}
              onClick={onDiscardConfig}
            >
              放弃
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={busy}
              onClick={() => {
                void onApplyConfig();
              }}
            >
              {applyFeedback.status === 'saving'
                ? '应用中...'
                : applyFeedback.status === 'success'
                  ? '已保存'
                  : '保存并应用配置'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
