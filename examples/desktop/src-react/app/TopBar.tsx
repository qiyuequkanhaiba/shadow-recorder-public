import clsx from 'clsx';
import {
  FileText,
  MonitorUp,
  Moon,
  Pause,
  Play,
  Settings,
  Square,
  Sun,
  Video,
} from 'lucide-react';

import { Button, IconButton } from '../ui';
import styles from './TopBar.module.css';

export type WorkspaceTabId = 'main' | 'evidence' | 'settings';

export type TopBarProps = {
  activeTab: WorkspaceTabId;
  onSelectTab: (tab: WorkspaceTabId) => void;
  historicalSessionCount: number;
  recPillState: 'recording' | 'paused' | 'idle';
  recPillLabel: string;
  recPillAction: string;
  isRecording: boolean;
  busy: boolean;
  onRecPillClick: () => void;
  onStopClick: () => void;
  onFloatingIslandClick: () => void;
  themeResolved: 'dark' | 'light';
  themeLabel: string;
  onCycleTheme: () => void;
};

export function TopBar({
  activeTab,
  onSelectTab,
  historicalSessionCount,
  recPillState,
  recPillLabel,
  recPillAction,
  isRecording,
  busy,
  onRecPillClick,
  onStopClick,
  onFloatingIslandClick,
  themeResolved,
  themeLabel,
  onCycleTheme,
}: TopBarProps) {
  return (
    <header data-ui-scope="shell" className={styles.topBar}>
      <div className={styles.brandGroup} aria-label="影子录制器">
        <span className={styles.brandMark} aria-hidden="true">
          S
        </span>
        <div className={styles.brandCopy}>
          <strong className={styles.brandTitle}>影子录制器</strong>
          <span className={styles.brandSub}>桌面端</span>
        </div>
      </div>

      <nav className={styles.tabList} role="tablist" aria-label="主功能切换">
        <button
          type="button"
          role="tab"
          id="tab-main"
          aria-selected={activeTab === 'main'}
          aria-controls="panel-main"
          className={clsx(styles.tabButton, activeTab === 'main' && styles.tabButtonActive)}
          onClick={() => onSelectTab('main')}
        >
          <Video size={15} aria-hidden="true" />
          <span>录制工作台</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-evidence"
          aria-selected={activeTab === 'evidence'}
          aria-controls="panel-evidence"
          className={clsx(
            styles.tabButton,
            activeTab === 'evidence' && styles.tabButtonActive,
          )}
          onClick={() => onSelectTab('evidence')}
        >
          <FileText size={15} aria-hidden="true" />
          <span>记录与回顾</span>
          {historicalSessionCount > 0 ? (
            <span className={styles.tabCount}>{historicalSessionCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-settings"
          aria-selected={activeTab === 'settings'}
          aria-controls="panel-settings"
          className={clsx(
            styles.tabButton,
            activeTab === 'settings' && styles.tabButtonActive,
          )}
          onClick={() => onSelectTab('settings')}
        >
          <Settings size={15} aria-hidden="true" />
          <span>偏好设置</span>
        </button>
      </nav>

      <div className={styles.rightGroup}>
        <div className={styles.statusToolbar} role="toolbar" aria-label="录制状态">
          <button
            type="button"
            className={clsx(
              styles.recButton,
              recPillState === 'recording' && styles.recStateRecording,
              recPillState === 'paused' && styles.recStatePaused,
            )}
            disabled={busy}
            title={`点击${recPillAction}`}
            aria-label={recPillAction}
            onClick={onRecPillClick}
          >
            <span className={styles.recDot} aria-hidden="true" />
            {recPillState === 'recording' ? (
              <Pause size={14} aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            <span className={styles.recLabel}>{recPillLabel}</span>
          </button>

          {isRecording ? (
            <Button
              variant="danger"
              size="md"
              disabled={busy}
              aria-label="停止录制"
              title="停止录制"
              icon={<Square size={14} />}
              onClick={onStopClick}
            >
              停止
            </Button>
          ) : null}

          <IconButton
            aria-label="唤起悬浮岛"
            title="唤起悬浮岛"
            disabled={busy}
            onClick={onFloatingIslandClick}
          >
            <MonitorUp size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <IconButton
          aria-label={`切换主题，当前为${themeLabel}`}
          title={`当前主题：${themeLabel}（点击切换）`}
          onClick={onCycleTheme}
        >
          {themeResolved === 'dark' ? (
            <Moon size={16} aria-hidden="true" />
          ) : (
            <Sun size={16} aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </header>
  );
}
