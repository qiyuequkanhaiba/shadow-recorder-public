import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload } from '../../../types/contracts';
import {
  DEFAULT_SCREENSHOT_SHORTCUTS,
  acceleratorFromKeyboardEvent,
  canAssignScreenshotShortcut,
  formatScreenshotAccelerator,
  normalizeScreenshotDelaySeconds,
} from '../../../src-electron/screenshot-capture';
import { t } from '../../lib/i18n';
import { Button, Field, SelectField } from '../../ui';
import styles from './SettingsSection.module.css';

export type ShortcutsSettingsSectionProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  error?: string;
};

function ScreenshotShortcutField(props: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (value: string) => void;
  blocked: (accelerator: string) => boolean;
}) {
  const [listening, setListening] = useState(false);
  const [rejected, setRejected] = useState(false);
  const shown =
    props.value === ''
      ? '关闭'
      : formatScreenshotAccelerator(props.value ?? props.fallback);

  return (
    <Field
      label={props.label}
      readOnly
      value={listening ? '请按下组合键' : shown}
      hint={rejected ? '这个组合键已被占用' : undefined}
      className={
        listening
          ? styles.shortcutInputListening
          : rejected
            ? styles.shortcutInputRejected
            : undefined
      }
      onFocus={() => {
        setListening(true);
        setRejected(false);
        void window.reqcaseShadowRecorder.suspendScreenshotHotkeys?.();
      }}
      onBlur={() => {
        setListening(false);
        void window.reqcaseShadowRecorder.resumeScreenshotHotkeys?.();
      }}
      onKeyDown={(event) => {
        const next = acceleratorFromKeyboardEvent(event);
        if (next === null) {
          return;
        }
        event.preventDefault();
        if (next !== '' && props.blocked(next)) {
          setRejected(true);
          event.currentTarget.blur();
          return;
        }
        setRejected(false);
        props.onChange(next);
        event.currentTarget.blur();
      }}
    />
  );
}

export function ShortcutsSettingsSection(props: ShortcutsSettingsSectionProps) {
  const [screenshotHistory, setScreenshotHistory] = useState<
    Array<{
      id: string;
      createdAtMs: number;
      width: number;
      height: number;
    }>
  >([]);

  useEffect(() => {
    void window.reqcaseShadowRecorder.listScreenshotHistory?.().then((items) => {
      if (Array.isArray(items)) {
        setScreenshotHistory(items);
      }
    });
  }, []);

  return (
    <section className={styles.pane} aria-label="快捷键">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.headerTitle}>快捷键</h2>
          <p className={styles.headerDesc}>全局开始/停止录制快捷键与截图功能配置。</p>
        </div>
      </header>

      <div className={styles.section}>
        <div className={styles.fieldGrid}>
          <Field
            label={t('config.shortcutStart')}
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

          <Field
            label={t('config.shortcutStop')}
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

          <ScreenshotShortcutField
            label={t('config.shortcutCaptureArea')}
            value={props.config.shortcutCaptureArea}
            fallback={DEFAULT_SCREENSHOT_SHORTCUTS.area}
            blocked={(accelerator) =>
              !canAssignScreenshotShortcut('area', accelerator, props.config)
            }
            onChange={(value) =>
              props.setConfig((current) => ({
                ...current,
                shortcutCaptureArea: value,
              }))
            }
          />

          <ScreenshotShortcutField
            label={t('config.shortcutCaptureMonitor')}
            value={props.config.shortcutCaptureMonitor}
            fallback={DEFAULT_SCREENSHOT_SHORTCUTS.monitor}
            blocked={(accelerator) =>
              !canAssignScreenshotShortcut('monitor', accelerator, props.config)
            }
            onChange={(value) =>
              props.setConfig((current) => ({
                ...current,
                shortcutCaptureMonitor: value,
              }))
            }
          />

          <ScreenshotShortcutField
            label={t('config.shortcutCaptureWindow')}
            value={props.config.shortcutCaptureWindow}
            fallback={DEFAULT_SCREENSHOT_SHORTCUTS.window}
            blocked={(accelerator) =>
              !canAssignScreenshotShortcut('window', accelerator, props.config)
            }
            onChange={(value) =>
              props.setConfig((current) => ({
                ...current,
                shortcutCaptureWindow: value,
              }))
            }
          />

          <ScreenshotShortcutField
            label={t('config.shortcutCapturePin')}
            value={props.config.shortcutCapturePin}
            fallback={DEFAULT_SCREENSHOT_SHORTCUTS.pin}
            blocked={(accelerator) =>
              !canAssignScreenshotShortcut('pin', accelerator, props.config)
            }
            onChange={(value) =>
              props.setConfig((current) => ({
                ...current,
                shortcutCapturePin: value,
              }))
            }
          />

          <p className={styles.fieldSpan + ' ' + styles.hintText}>
            点一下后按下组合键。F1 到 F24 可以单独使用，默认 F3 一键贴图。退格或 Esc
            关闭。不要和开始或停止录制用同一个组合键。
          </p>

          <SelectField
            label={t('config.screenshotDelay')}
            value={normalizeScreenshotDelaySeconds(props.config.screenshotDelaySeconds)}
            onChange={(event) => {
              props.setConfig((current) => ({
                ...current,
                screenshotDelaySeconds: normalizeScreenshotDelaySeconds(
                  Number(event.target.value),
                ),
              }));
            }}
          >
            <option value={0}>关闭</option>
            <option value={3}>3 秒</option>
            <option value={5}>5 秒</option>
          </SelectField>

          <div className={styles.fieldSpan}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={props.config.hideScreenshotUiFromCapture !== false}
                onChange={(event) => {
                  props.setConfig((current) => ({
                    ...current,
                    hideScreenshotUiFromCapture: event.target.checked,
                  }));
                }}
              />
              <span className={styles.toggleCopy}>
                <strong className={styles.toggleTitle}>
                  {t('config.hideScreenshotUiFromCapture')}
                </strong>
                <small className={styles.toggleSub}>
                  {t('config.hideScreenshotUiFromCaptureHint')}
                </small>
              </span>
            </label>
          </div>

          <div className={styles.fieldSpan + ' ' + styles.actionRow}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void window.reqcaseShadowRecorder.beginAreaScreenshot?.();
              }}
            >
              框选截图
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void window.reqcaseShadowRecorder.revealScreenshotHistory?.();
              }}
            >
              打开截图目录
            </Button>
          </div>

          {screenshotHistory.length > 0 ? (
            <ul className={styles.fieldSpan + ' ' + styles.historyList}>
              {screenshotHistory.slice(0, 8).map((item) => (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void window.reqcaseShadowRecorder.pinScreenshotHistory?.(item.id);
                    }}
                  >
                    贴上 {item.width}×{item.height}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {props.error ? <p className={styles.errorBanner}>{props.error}</p> : null}
    </section>
  );
}
