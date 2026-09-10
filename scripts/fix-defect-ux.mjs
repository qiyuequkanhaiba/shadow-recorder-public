import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log('wrote', rel);
}

// 1) Revert playback seek markers
{
  let t = read('src-react/components/RecorderPlaybackStage.tsx').replace(/\r\n/g, '\n');

  // Remove helper functions
  t = t.replace(
    /\nfunction mapEventToGlobalPlaybackMs\([\s\S]*?\nfunction resolveEventMarkerLabel\([\s\S]*?\n\}\n/,
    '\n',
  );

  // Remove eventMarkers useMemo
  t = t.replace(
    /\n  const eventMarkers = useMemo\(\(\) => \{[\s\S]*?\}, \[continuousSegments, props\.timelineEvents\]\);\n/,
    '\n',
  );

  // Remove props
  t = t.replace(
    /\n  timelineEvents\?: TestSessionTimelineEvent\[\];\n  onEventMarkerSelect\?: \(event: TestSessionTimelineEvent\) => void;/,
    '',
  );
  t = t.replace(/,?\n  TestSessionTimelineEvent/, '');

  // Restore plain seek input
  if (t.includes('recorder-stage-seek-track')) {
    t = t.replace(
      /\{!isFullscreen \? \(\n\s*<div className="recorder-stage-seek-track"[\s\S]*?onChange=\{handleSeekBarInput\}\n\s*\/>\n\s*<\/div>\n\s*\) : null\}/,
      `{!isFullscreen ? (
                    <input
                      className="recorder-stage-inline-seek"
                      type="range"
                      min={0}
                      max={Math.max(totalDurationMs, 1)}
                      step={100}
                      value={Math.min(globalPlaybackMs, Math.max(totalDurationMs, 1))}
                      disabled={continuousSegments.length === 0}
                      aria-label="播放进度"
                      onChange={handleSeekBarInput}
                    />
                  ) : null}`,
    );
  }

  write('src-react/components/RecorderPlaybackStage.tsx', t);
  console.log('seek-track left?', t.includes('recorder-stage-seek-track'));
}

// 2) RecorderPage: remove timelineEvents from playback; gate evidence tab; pass config/steps
{
  let t = read('src-react/pages/RecorderPage.tsx').replace(/\r\n/g, '\n');

  // Remove timelineEvents props from playback
  t = t.replace(
    /\n\s*timelineEvents=\{dashboard\.events\}\n\s*onEventMarkerSelect=\{\(event\) => \{[\s\S]*?\}\}\n/,
    '\n',
  );

  // Gate evidence tab visibility? User wants optional feature - still show tab but disabled content when off.
  // Pass defectEvidenceEnabled into DefectEvidencePanel
  t = t.replace(
    `<DefectEvidencePanel
                    session={dashboard.selectedSession ?? dashboard.activeSession}
                    isRecording={runtime.isRecording}
                    onPlaybackFocusChange={setPlaybackFocus}
                    onError={setError}
                    toUiErrorMessage={toUiErrorMessage}
                  />`,
    `<DefectEvidencePanel
                    session={dashboard.selectedSession ?? dashboard.activeSession}
                    isRecording={runtime.isRecording}
                    enabled={!!config.defectEvidenceEnabled}
                    preWindowSeconds={config.defectPreWindowSeconds}
                    postWindowSeconds={config.defectPostWindowSeconds}
                    onPlaybackFocusChange={setPlaybackFocus}
                    onError={setError}
                    toUiErrorMessage={toUiErrorMessage}
                    onOpenSettings={() => setActiveTab('settings')}
                  />`,
  );

  // Compact timeline: pass defect enabled + semantic merge flag
  t = t.replace(
    `variant="compact"
                      sessions={dashboard.sessions}`,
    `variant="compact"
                      defectEvidenceEnabled={!!config.defectEvidenceEnabled}
                      sessions={dashboard.sessions}`,
  );

  write('src-react/pages/RecorderPage.tsx', t);
}

// 3) Contracts + DEFAULT_CONFIG
{
  // contracts may be TSD encrypted for some tools; use node write
  let contracts = read('types/contracts.ts');
  if (!contracts.includes('defectEvidenceEnabled')) {
    contracts = contracts.replace(
      'privacyEnabled?: boolean;',
      `privacyEnabled?: boolean;
  /** When true, capture UIA/keyboard summaries and build defect steps. Default false. */
  defectEvidenceEnabled?: boolean;
  defectPreWindowSeconds?: number;
  defectPostWindowSeconds?: number;`,
    );
    write('types/contracts.ts', contracts);
  }

  let defaults = read('src-react/lib/tuning-advisor.ts');
  if (!defaults.includes('defectEvidenceEnabled')) {
    defaults = defaults.replace(
      'privacyEnabled:',
      `defectEvidenceEnabled: false,
  defectPreWindowSeconds: 60,
  defectPostWindowSeconds: 20,
  privacyEnabled:`,
    );
    // if privacyEnabled not in DEFAULT_CONFIG, append near end of object
    if (!defaults.includes('defectEvidenceEnabled')) {
      defaults = defaults.replace(
        'showMouseInVideo: false,',
        `showMouseInVideo: false,
  defectEvidenceEnabled: false,
  defectPreWindowSeconds: 60,
  defectPostWindowSeconds: 20,`,
      );
    }
    write('src-react/lib/tuning-advisor.ts', defaults);
  }
}

// 4) Settings workspace nav + panel
{
  let sw = read('src-react/features/settings/SettingsWorkspace.tsx').replace(/\r\n/g, '\n');
  if (!sw.includes("id: 'defect'")) {
    sw = sw.replace(
      "export type SettingsNavId = SettingsControlSection | 'privacy';",
      "export type SettingsNavId = SettingsControlSection | 'privacy' | 'defect';",
    );
    sw = sw.replace(
      "{ id: 'privacy', label: '隐私规则', hint: '遮罩 / 排除' },\n];",
      `{ id: 'privacy', label: '隐私规则', hint: '遮罩 / 排除' },
  { id: 'defect', label: '缺陷证据', hint: '可选 · 步骤语义' },
];`,
    );
    sw = sw.replace(
      "import { PrivacySettingsPanel } from '../privacy/PrivacySettingsPanel';",
      `import { PrivacySettingsPanel } from '../privacy/PrivacySettingsPanel';
import { DefectEvidenceSettingsPanel } from '../evidence/DefectEvidenceSettingsPanel';`,
    );
    sw = sw.replace(
      `{activeNav === 'privacy' ? (
          <PrivacySettingsPanel config={props.config} setConfig={props.setConfig} />
        ) : (
          <RecorderControlPanel`,
      `{activeNav === 'privacy' ? (
          <PrivacySettingsPanel config={props.config} setConfig={props.setConfig} />
        ) : activeNav === 'defect' ? (
          <DefectEvidenceSettingsPanel config={props.config} setConfig={props.setConfig} />
        ) : (
          <RecorderControlPanel`,
    );
    write('src-react/features/settings/SettingsWorkspace.tsx', sw);
  }
}

// 5) New settings panel file
{
  const panel = `import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload } from '../../../types/contracts';

type DefectEvidenceSettingsPanelProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
};

function clampSeconds(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function DefectEvidenceSettingsPanel(props: DefectEvidenceSettingsPanelProps) {
  const enabled = !!props.config.defectEvidenceEnabled;
  const pre = props.config.defectPreWindowSeconds ?? 60;
  const post = props.config.defectPostWindowSeconds ?? 20;

  function update<K extends keyof RecorderConfigPayload>(key: K, value: RecorderConfigPayload[K]) {
    props.setConfig((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="settings-form-panel" aria-label="缺陷证据设置">
      <header className="settings-form-header">
        <h3>缺陷证据</h3>
        <p>
          可选功能。开启后才会在录制过程中补充控件识别、键盘摘要，并生成可导出的语义步骤。
          关闭时仅保留循环录像与基础事件日志，开销更低。
        </p>
      </header>

      <label className="settings-toggle-row">
        <span>
          <strong>启用缺陷证据记录</strong>
          <small>UIA 控件补全 · 键盘摘要 · 步骤聚合 · 缺陷包导出</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            update('defectEvidenceEnabled', event.target.checked);
          }}
        />
      </label>

      <div className={\`settings-form-grid \${enabled ? '' : 'is-disabled'}\`}>
        <label>
          <span>缺陷前窗口（秒）</span>
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
          <span>缺陷后窗口（秒）</span>
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

      <div className="settings-form-note">
        <p>建议：日常长时巡检可关闭；需要提单/复现时再开启。</p>
        <p>开启后请点击设置页的「保存并应用」，新录制会话会按配置采集。</p>
      </div>
    </section>
  );
}
`;
  write('src-react/features/evidence/DefectEvidenceSettingsPanel.tsx', panel);
}

// 6) settings-store sanitize keep defect fields
{
  let t = read('src-electron/modules/reqcase-shadow-recorder/settings-store.ts');
  if (!t.includes('defectEvidenceEnabled')) {
    // ensure we don't delete the new fields - settings may strip unknown. Add explicit preserve.
    if (t.includes('delete output.privacyEnabled;')) {
      t = t.replace(
        'delete output.privacyEnabled;',
        `// preserve defect evidence flags
  if (typeof input.defectEvidenceEnabled === 'boolean') {
    output.defectEvidenceEnabled = input.defectEvidenceEnabled;
  }
  if (typeof input.defectPreWindowSeconds === 'number' && Number.isFinite(input.defectPreWindowSeconds)) {
    output.defectPreWindowSeconds = Math.max(5, Math.min(600, Math.trunc(input.defectPreWindowSeconds)));
  }
  if (typeof input.defectPostWindowSeconds === 'number' && Number.isFinite(input.defectPostWindowSeconds)) {
    output.defectPostWindowSeconds = Math.max(0, Math.min(300, Math.trunc(input.defectPostWindowSeconds)));
  }

  delete output.privacyEnabled;`,
      );
      write('src-electron/modules/reqcase-shadow-recorder/settings-store.ts', t);
    }
  }
}

console.log('fix-defect-ux base done');
