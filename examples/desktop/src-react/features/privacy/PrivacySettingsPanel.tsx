import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMaskRegionPayload,
} from '../../../types/contracts';
import { isSemanticRecordingEnabled } from '../../lib/recorder-page-bindings';
import { Field, TextareaField } from '../../ui';
import styles from '../settings/SettingsSection.module.css';

type PrivacySettingsPanelProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  error?: string;
};

const KEYWORD_SPLIT_RE = /[,，\n]+/;

function parseKeywords(value: string): string[] {
  return value
    .split(KEYWORD_SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index);
}

function formatKeywords(values: string[] | undefined): string {
  return Array.isArray(values) ? values.join('\n') : '';
}

function normalizeNumberInput(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveMaskRegion(config: RecorderConfigPayload): RecorderMaskRegionPayload {
  const [region] = Array.isArray(config.maskRegions) ? config.maskRegions : [];
  return {
    x: Math.max(0, Math.trunc(region?.x ?? 0)),
    y: Math.max(0, Math.trunc(region?.y ?? 0)),
    width: Math.max(0, Math.trunc(region?.width ?? 0)),
    height: Math.max(0, Math.trunc(region?.height ?? 0)),
    label: region?.label ?? '固定遮罩区域',
  };
}

export function PrivacySettingsPanel(props: PrivacySettingsPanelProps) {
  const maskRegion = resolveMaskRegion(props.config);
  const semanticRecordingEnabled = isSemanticRecordingEnabled(props.config);

  function updateKeywords(
    key: 'excludedWindowTitleKeywords' | 'excludedProcessNames',
    event: ChangeEvent<HTMLTextAreaElement>,
  ): void {
    const values = parseKeywords(event.target.value);
    props.setConfig((current) => ({
      ...current,
      [key]: values,
    }));
  }

  function updateMaskRegion(nextRegion: RecorderMaskRegionPayload): void {
    props.setConfig((current) => ({
      ...current,
      maskRegions: [nextRegion],
    }));
  }

  function updateMaskField(
    key: keyof RecorderMaskRegionPayload,
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    const nextValue =
      key === 'label' ? event.target.value : normalizeNumberInput(event.target.value);
    updateMaskRegion({
      ...maskRegion,
      [key]: nextValue,
    });
  }

  return (
    <section className={styles.pane} aria-label="隐私规则">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.headerTitle}>隐私规则</h2>
          <p className={styles.headerDesc}>
            启用后，新的录像片段会把遮罩画进视频。已经写好的片段不会改。命中排除规则时仅保留步骤元数据。
          </p>
        </div>
      </header>

      <div className={styles.section}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={!!props.config.privacyEnabled}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                privacyEnabled: event.target.checked,
              }))
            }
          />
          <span className={styles.toggleCopy}>
            <strong className={styles.toggleTitle}>启用隐私保护</strong>
            <small className={styles.toggleSub}>仅影响新帧，不回溯修改缓存。</small>
          </span>
        </label>

        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={!!props.config.semanticPlaintextInputEnabled}
            disabled={!semanticRecordingEnabled}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                semanticPlaintextInputEnabled: event.target.checked,
              }))
            }
          />
          <span className={styles.toggleCopy}>
            <strong className={styles.toggleTitle}>允许采集非密码文本</strong>
            <small className={styles.toggleSub}>
              关闭时只记录非文本语义元数据。开启后，输入内容、选项名称或路径可能出现在本地会话和导出文件中；密码字段仍不记录文本。
            </small>
          </span>
        </label>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>排除规则</h3>
        <p className={styles.sectionDesc}>
          遮罩和排除规则仅影响后续采集，不会修改已写入的视频或导出文件。
        </p>

        <div className={styles.fieldGrid}>
          <TextareaField
            label="排除进程名"
            rows={3}
            value={formatKeywords(props.config.excludedProcessNames)}
            placeholder={'password-manager.exe\nwechat'}
            hint="每行或逗号分隔；匹配后不保存截图。"
            onChange={(event) => updateKeywords('excludedProcessNames', event)}
          />

          <TextareaField
            label="排除窗口标题"
            rows={3}
            value={formatKeywords(props.config.excludedWindowTitleKeywords)}
            placeholder={'Secret\nPayment'}
            hint="适合密钥、支付、隐私会话等窗口。"
            onChange={(event) => updateKeywords('excludedWindowTitleKeywords', event)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>固定区域遮罩</h3>
        <p className={styles.sectionDesc}>坐标基于采集帧左上角；宽或高为 0 时不启用。</p>

        <div className={styles.fieldGridMask}>
          <Field
            label="X"
            type="number"
            min={0}
            value={maskRegion.x}
            onChange={(event) => updateMaskField('x', event)}
          />
          <Field
            label="Y"
            type="number"
            min={0}
            value={maskRegion.y}
            onChange={(event) => updateMaskField('y', event)}
          />
          <Field
            label="宽"
            type="number"
            min={0}
            value={maskRegion.width}
            onChange={(event) => updateMaskField('width', event)}
          />
          <Field
            label="高"
            type="number"
            min={0}
            value={maskRegion.height}
            onChange={(event) => updateMaskField('height', event)}
          />
          <Field
            label="标签"
            type="text"
            value={maskRegion.label ?? ''}
            onChange={(event) => updateMaskField('label', event)}
          />
        </div>
      </div>

      {props.error ? <p className={styles.errorBanner}>{props.error}</p> : null}
    </section>
  );
}
