import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exportTuningSnapshot } from './tuning-snapshot';
import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderStep,
} from './types';

type StepImageSourceMap = Map<string, string>;

export async function exportShadowRecorderReport(
  input: ReqCaseShadowRecorderExportInput,
  steps: ReqCaseShadowRecorderStep[],
): Promise<ReqCaseShadowRecorderExportResult> {
  const manifestMode = input.manifestMode ?? 'full';
  const generatedAtMs = input.generatedAtMs ?? Date.now();
  const title = input.title ?? '影子录制器报告';
  const reportId = `report-${generatedAtMs}`;
  const reportDir = path.resolve(input.targetDir, reportId);

  await mkdir(reportDir, { recursive: true });

  const htmlPath = path.resolve(reportDir, 'report.html');
  const manifestPath = path.resolve(reportDir, 'manifest.json');
  const imageSourceByStepId = new Map<string, string>();

  if (manifestMode === 'lite') {
    await exportLiteImages(reportDir, steps, imageSourceByStepId);
  }

  const tuningSnapshotPath = await writeTuningSnapshotIfNeeded(reportDir, input, generatedAtMs);
  const html = buildHtml(title, generatedAtMs, steps, input.tuningSummary, imageSourceByStepId);
  await writeFile(htmlPath, html, 'utf-8');

  const manifest = {
    id: reportId,
    title,
    manifestMode,
    generatedAtMs,
    generatedAtIso: new Date(generatedAtMs).toISOString(),
    stepCount: steps.length,
    tuningSummary: input.tuningSummary,
    tuningSnapshotPath,
    steps: manifestMode === 'full' ? steps : undefined,
    stepIndex:
      manifestMode === 'lite'
        ? steps.map((step) => ({
          id: step.id,
          timestampMs: step.timestampMs,
          action: step.action,
          processName: step.processName,
          windowTitle: step.windowTitle,
          captureBackend: step.captureBackend,
          imageBytes: step.imageBytes,
        }))
        : undefined,
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    htmlPath,
    manifestPath,
    imageCount: steps.length,
    tuningSnapshotPath,
  };
}

async function exportLiteImages(
  reportDir: string,
  steps: ReqCaseShadowRecorderStep[],
  imageSourceByStepId: StepImageSourceMap,
): Promise<void> {
  const imagesDir = path.resolve(reportDir, 'images');
  await mkdir(imagesDir, { recursive: true });

  for (const step of steps) {
    const safeId = step.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `step-${safeId}.webp`;
    const fullPath = path.resolve(imagesDir, fileName);
    await writeFile(fullPath, Buffer.from(step.imageWebpBase64, 'base64'));
    imageSourceByStepId.set(step.id, `images/${fileName}`);
  }
}

async function writeTuningSnapshotIfNeeded(
  reportDir: string,
  input: ReqCaseShadowRecorderExportInput,
  generatedAtMs: number,
): Promise<string | undefined> {
  if (!input.tuningSummary) {
    return undefined;
  }

  if (input.tuningSummary.config && input.tuningSummary.metrics) {
    const snapshot = await exportTuningSnapshot({
      targetDir: reportDir,
      profile: input.tuningSummary.profile,
      reason: input.tuningSummary.reason,
      triggerTags: input.tuningSummary.triggerTags,
      config: input.tuningSummary.config,
      metrics: input.tuningSummary.metrics,
      autoApplyLastRecommendedProfile: input.tuningSummary.autoApplyLastRecommendedProfile,
      notes: input.tuningSummary.notes,
      generatedAtMs,
    });
    return snapshot.snapshotPath;
  }

  const tuningSnapshotPath = path.resolve(reportDir, 'tuning-summary.json');
  await writeFile(
    tuningSnapshotPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAtMs,
        generatedAtIso: new Date(generatedAtMs).toISOString(),
        ...input.tuningSummary,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return tuningSnapshotPath;
}

function buildHtml(
  title: string,
  generatedAtMs: number,
  steps: ReqCaseShadowRecorderStep[],
  tuningSummary?: ReqCaseShadowRecorderExportInput['tuningSummary'],
  imageSourceByStepId?: StepImageSourceMap,
): string {
  const rows = steps
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((step, index) => {
      const width = Math.max(1, step.windowRight - step.windowLeft);
      const height = Math.max(1, step.windowBottom - step.windowTop);
      const markerX = (((step.x - step.windowLeft) / width) * 100).toFixed(2);
      const markerY = (((step.y - step.windowTop) / height) * 100).toFixed(2);
      const backend = step.captureBackend ? ` [${step.captureBackend}]` : '';
      const imageSrc =
        imageSourceByStepId?.get(step.id) ?? `data:image/webp;base64,${step.imageWebpBase64}`;

      return `
        <article class="step">
          <div class="meta">
            <strong>步骤 ${index + 1}</strong>
            <span>${new Date(step.timestampMs).toLocaleString()}</span>
            <span>${escapeHtml(step.action)}${escapeHtml(backend)}</span>
            <span>${escapeHtml(step.processName)} · ${escapeHtml(step.windowTitle)}</span>
          </div>
          <div class="preview">
            <img src="${escapeHtml(imageSrc)}" alt="step-${escapeHtml(step.id)}" />
            <span class="marker" style="left:${markerX}%;top:${markerY}%;"></span>
          </div>
        </article>
      `;
    })
    .join('\n');

  const tuningBlock = tuningSummary
    ? `
      <section class="tuning">
        <h2>录制调优摘要</h2>
        <p><strong>配置文件:</strong> ${escapeHtml(tuningSummary.profile)}</p>
        <p><strong>原因:</strong> ${escapeHtml(tuningSummary.reason)}</p>
        <p><strong>触发标签:</strong> ${escapeHtml((tuningSummary.triggerTags ?? []).join(', ') || '无')}</p>
        <p><strong>启动时自动应用:</strong> ${tuningSummary.autoApplyLastRecommendedProfile ? '是' : '否'}</p>
        <p><strong>捕获上下文复用:</strong> ${resolveCaptureReuseText(tuningSummary.config)}</p>
        ${tuningSummary.notes ? `<p><strong>备注:</strong> ${escapeHtml(tuningSummary.notes)}</p>` : ''}
        ${tuningSummary.config ? `
          <details>
            <summary>配置快照</summary>
            <pre>${escapeHtml(JSON.stringify(tuningSummary.config, null, 2))}</pre>
          </details>
        ` : ''}
        ${tuningSummary.metrics ? `
          <details>
            <summary>指标快照</summary>
            <pre>${escapeHtml(JSON.stringify(tuningSummary.metrics, null, 2))}</pre>
          </details>
        ` : ''}
      </section>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1117;
      --panel: #12202b;
      --panel-alt: #182734;
      --line: rgba(255, 255, 255, 0.08);
      --text: #ebf1f5;
      --muted: #9fb1be;
      --accent: #69d2b5;
      --danger: #ff8f7f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(105, 210, 181, 0.18), transparent 30%),
        linear-gradient(180deg, #091018 0%, #0b1117 100%);
      color: var(--text);
    }
    main {
      width: min(1200px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 48px;
    }
    .hero,
    .tuning,
    .steps {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(18, 32, 43, 0.9);
      backdrop-filter: blur(12px);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
      padding: 20px 22px;
      margin-bottom: 16px;
    }
    .hero h1,
    .tuning h2,
    .steps h2 {
      margin: 0 0 10px;
      font-size: 22px;
    }
    .hero p,
    .tuning p {
      margin: 6px 0;
      color: var(--muted);
    }
    .step {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(24, 39, 52, 0.7);
      overflow: hidden;
      margin-bottom: 14px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
    }
    .preview {
      position: relative;
      background: #081017;
    }
    .preview img {
      display: block;
      width: 100%;
      height: auto;
    }
    .marker {
      position: absolute;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: rgba(255, 143, 127, 0.9);
      border: 2px solid rgba(255, 255, 255, 0.9);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 6px rgba(255, 143, 127, 0.2);
    }
    details {
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(9, 16, 24, 0.55);
      padding: 12px 14px;
    }
    summary {
      cursor: pointer;
      color: var(--text);
      font-weight: 600;
    }
    pre {
      margin: 12px 0 0;
      padding: 12px;
      border-radius: 12px;
      overflow: auto;
      background: rgba(0, 0, 0, 0.28);
      color: #d8e4ec;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>${escapeHtml(title)}</h1>
      <p><strong>生成时间:</strong> ${new Date(generatedAtMs).toLocaleString()}</p>
      <p><strong>步骤数:</strong> ${steps.length}</p>
    </section>
    ${tuningBlock}
    <section class="steps">
      <h2>步骤回顾</h2>
      ${rows || '<p>当前没有可导出的步骤。</p>'}
    </section>
  </main>
</body>
</html>`;
}

function resolveCaptureReuseText(
  config?: ReqCaseShadowRecorderConfig,
): string {
  if (!config || config.captureReuseEnabled === undefined) {
    return '未配置';
  }
  return config.captureReuseEnabled ? '已启用' : '已禁用';
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
