import type { Dispatch, SetStateAction } from 'react';
import clsx from 'clsx';

import type {
  RecorderConfigPayload,
  TestSessionDisplayTarget,
} from '../../../types/contracts';
import { t } from '../../lib/i18n';
import { Badge, Button, SelectField } from '../../ui';
import styles from './SettingsSection.module.css';

export type CaptureSettingsSectionProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  availableDisplays: TestSessionDisplayTarget[];
  displaysLoading: boolean;
  error?: string;
};

export function CaptureSettingsSection(props: CaptureSettingsSectionProps) {
  const availableDisplays = props.availableDisplays;
  const singleTargetDisplayId =
    props.config.targetDisplayId ??
    props.config.targetDisplayIds?.[0] ??
    availableDisplays.find((display) => display.isPrimary)?.displayId ??
    availableDisplays[0]?.displayId ??
    '';
  const selectedDisplayIds = Array.isArray(props.config.targetDisplayIds)
    ? props.config.targetDisplayIds.filter((displayId) =>
        availableDisplays.some((display) => display.displayId === displayId),
      )
    : [];
  const allDisplayIds = availableDisplays.map((display) => display.displayId);
  const effectiveSelectedDisplayIds =
    selectedDisplayIds.length > 0 ? selectedDisplayIds : allDisplayIds;
  const primaryDisplayId =
    availableDisplays.find((display) => display.isPrimary)?.displayId ??
    availableDisplays[0]?.displayId ??
    '';

  function formatDisplayLabel(display: TestSessionDisplayTarget): string {
    const primaryTag = display.isPrimary ? ' · 主显示器' : '';
    return `${display.label} · ${display.width}×${display.height}${primaryTag}`;
  }

  function formatDisplayMeta(display: TestSessionDisplayTarget): string {
    return `坐标 ${display.left}, ${display.top} · 区域 ${display.width}×${display.height}`;
  }

  function handleTargetModeChange(
    nextMode: RecorderConfigPayload['targetCaptureMode'],
  ): void {
    props.setConfig((current) => {
      const nextConfig: RecorderConfigPayload = {
        ...current,
        targetCaptureMode: nextMode,
      };

      if (
        (nextMode === 'target_display' || nextMode === 'desktop') &&
        availableDisplays.length > 0
      ) {
        const nextDisplayId =
          current.targetDisplayId ??
          current.targetDisplayIds?.[0] ??
          availableDisplays.find((display) => display.isPrimary)?.displayId ??
          availableDisplays[0]?.displayId;
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
      const currentIds =
        Array.isArray(current.targetDisplayIds) && current.targetDisplayIds.length > 0
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

  const mode = props.config.targetCaptureMode ?? 'target_display';

  return (
    <section className={styles.pane} aria-label="捕获目标">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.headerTitle}>捕获目标</h2>
          <p className={styles.headerDesc}>选择录制范围、显示器与捕获后端。</p>
        </div>
      </header>

      <div className={styles.section}>
        <div className={styles.fieldGrid}>
          <SelectField
            label="录制目标"
            value={mode}
            onChange={(event) =>
              handleTargetModeChange(
                event.target.value as RecorderConfigPayload['targetCaptureMode'],
              )
            }
          >
            <option value="target_display">当前显示器录制</option>
            <option value="desktop">当前桌面录制</option>
            <option value="all_displays">全部显示器</option>
            <option value="foreground_window">前台窗口跟随录制</option>
          </SelectField>

          {mode === 'target_display' || mode === 'desktop' ? (
            <SelectField
              label="指定显示器"
              value={singleTargetDisplayId}
              disabled={props.displaysLoading || availableDisplays.length === 0}
              hint={
                props.displaysLoading
                  ? '正在检测显示器…'
                  : availableDisplays.length > 0
                    ? `已检测 ${availableDisplays.length} 台，仅录制当前选中显示器。`
                    : '未检测到显示器，将回退到主显示器。'
              }
              onChange={(event) => {
                handleSingleDisplayChange(event.target.value);
              }}
            >
              {availableDisplays.length === 0 ? (
                <option value="">未检测到显示器</option>
              ) : (
                availableDisplays.map((display) => (
                  <option key={display.displayId} value={display.displayId}>
                    {formatDisplayLabel(display)}
                  </option>
                ))
              )}
            </SelectField>
          ) : null}

          <SelectField
            label={t('config.captureBackend')}
            hint="默认 DXGI，避免 WGC 黄色边框。"
            value={props.config.captureBackend ?? 'dxgi'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                captureBackend: event.target
                  .value as RecorderConfigPayload['captureBackend'],
              }))
            }
          >
            <option value="dxgi">{t('config.backend.dxgi')}</option>
            <option value="wgc">{t('config.backend.wgc')}</option>
          </SelectField>
        </div>

        {mode === 'all_displays' ? (
          <div className={styles.subpanel}>
            <div className={styles.subpanelHead}>
              <div>
                <strong className={styles.sectionTitle}>同时录制的显示器</strong>
                <p className={styles.hintText}>
                  {props.displaysLoading
                    ? '正在检测…'
                    : availableDisplays.length > 0
                      ? `已检测 ${availableDisplays.length} 台，可多选。`
                      : '未检测到显示器。'}
                </p>
              </div>
              <Badge tone="neutral">
                {selectedDisplayIds.length > 0
                  ? `已选 ${selectedDisplayIds.length} 台`
                  : '默认全部'}
              </Badge>
            </div>

            <div className={styles.checkGrid}>
              {availableDisplays.length === 0 ? (
                <p className={styles.hintText}>当前未检测到可用显示器。</p>
              ) : (
                availableDisplays.map((display) => {
                  const checked = effectiveSelectedDisplayIds.includes(display.displayId);
                  return (
                    <label
                      key={display.displayId}
                      className={clsx(styles.checkCard, checked && styles.checkCardActive)}
                    >
                      <input
                        type="checkbox"
                        className={styles.toggleInput}
                        checked={checked}
                        onChange={() => {
                          handleMultiDisplayToggle(display.displayId);
                        }}
                      />
                      <span className={styles.toggleCopy}>
                        <strong className={styles.toggleTitle}>
                          {formatDisplayLabel(display)}
                        </strong>
                        <small className={styles.toggleSub}>
                          {formatDisplayMeta(display)}
                        </small>
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            <div className={styles.actionRow}>
              <Button
                variant="ghost"
                size="sm"
                disabled={availableDisplays.length === 0}
                onClick={() => {
                  applyMultiDisplaySelection(allDisplayIds);
                }}
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!primaryDisplayId}
                onClick={() => {
                  applyMultiDisplaySelection(primaryDisplayId ? [primaryDisplayId] : []);
                }}
              >
                仅主屏
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedDisplayIds.length === 0}
                onClick={() => {
                  applyMultiDisplaySelection([]);
                }}
              >
                默认全部
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {props.error ? <p className={styles.errorBanner}>{props.error}</p> : null}
    </section>
  );
}
