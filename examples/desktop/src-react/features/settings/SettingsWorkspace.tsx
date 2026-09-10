import { useState } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload, RecorderTuningProfile, TestSessionDisplayTarget } from '../../../types/contracts';
import {
  RecorderControlPanel,
  type ConfigApplyFeedback,
  type SettingsControlSection,
} from '../../components/RecorderControlPanel';
import type { VideoEncoderSummary } from '../../lib/video-encoder-summary';
import { PrivacySettingsPanel } from '../privacy/PrivacySettingsPanel';
import { DefectEvidenceSettingsPanel } from '../evidence/DefectEvidenceSettingsPanel';

export type SettingsNavId = SettingsControlSection | 'privacy' | 'defect';

type SettingsNavItem = {
  id: SettingsNavId;
  label: string;
  hint: string;
};

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'recording', label: '录制参数', hint: '窗口 / 档位 / 防抖' },
  { id: 'capture', label: '捕获目标', hint: '显示器 / 后端' },
  { id: 'shortcuts', label: '快捷键', hint: '开始 / 停止' },
  { id: 'performance', label: '性能与高级', hint: '预设 / 缓冲 / 编码' },
  { id: 'privacy', label: '隐私规则', hint: '遮罩 / 排除' },
  { id: 'defect', label: '步骤记录', hint: '语义步骤 / 标记' },
];

type SettingsWorkspaceProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
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

  return (
    <div className="settings-workspace">
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-title">配置分类</div>
        <nav className="settings-nav-list" role="tablist" aria-orientation="vertical">
          {NAV_ITEMS.map((item) => {
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`settings-nav-item ${active ? 'is-active' : ''}`}
                onClick={() => setActiveNav(item.id)}
              >
                <span className="settings-nav-item-label">{item.label}</span>
                <span className="settings-nav-item-hint">{item.hint}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="settings-nav-content" role="tabpanel">
        {activeNav === 'privacy' ? (
          <PrivacySettingsPanel config={props.config} setConfig={props.setConfig} />
        ) : activeNav === 'defect' ? (
          <DefectEvidenceSettingsPanel config={props.config} setConfig={props.setConfig} />
        ) : (
          <RecorderControlPanel
            section={activeNav}
            config={props.config}
            setConfig={props.setConfig}
            recommendation={props.recommendation}
            profileLabels={props.profileLabels}
            autoApplyRecommendedOnStartup={props.autoApplyRecommendedOnStartup}
            availableDisplays={props.availableDisplays}
            displaysLoading={props.displaysLoading}
            onToggleAutoApply={props.onToggleAutoApply}
            onApplyProfile={props.onApplyProfile}
            busy={props.busy}
            error={props.error}
            applyFeedback={props.applyFeedback}
            encoderSummary={props.encoderSummary}
          />
        )}
      </div>
    </div>
  );
}
