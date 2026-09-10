import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveBundledFfmpegPath } from '../../ffmpeg-resource';
import { buildChecksumEntries as buildArchiveChecksumEntries, createZipArchive as createArchiveZip } from './evidence-archive';
import {
  renderEvidenceHtml,
  type EvidenceHtmlEventView,
  type EvidenceHtmlSegmentView,
  type EvidenceViewModel,
} from './evidence-html';
import { buildEvidenceManifest, buildEvidenceManifestV2 } from './evidence-manifest';

import type {
  ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ReqCaseShadowRecorderTestSessionEvidenceExportResult,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoStream,
} from './types';

const EVIDENCE_EXPORT_SCHEMA_VERSION = 1;
const OPERATION_RECORDS_SCHEMA_VERSION = 1;
const OPERATION_RECORDS_BUILDER_VERSION = 'evidence-timeline-v1';
const EVIDENCE_EXPORT_KIND = 'reqcase.test-session-evidence-export';
const OPERATION_RECORDS_KIND = 'reqcase.test-session-operation-records';
const SHA256_MANIFEST_KIND = 'reqcase.sha256-manifest';

type EvidenceExportContext = {
  session: ReqCaseShadowRecorderTestSessionState;
  events: ReqCaseShadowRecorderTestSessionTimelineEvent[];
  videoStreams: ReqCaseShadowRecorderTestSessionVideoStream[];
  videoSegments: ReqCaseShadowRecorderTestSessionVideoSegment[];
};

type CopyStats = {
  fileCount: number;
  byteCount: number;
};

type ChecksumEntry = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

type EvidenceExportLogRecord = {
  eventId: string;
  occurredAtMs: number;
  occurredAtIso: string;
  logCategory: string;
  level: string;
  eventType: string;
  summary: string;
  detail: string;
  status?: string;
  stepId?: string;
  action?: string;
  displayId?: string;
  processName?: string;
  windowTitle?: string;
  title?: string;
  message?: string;
  logSource?: string;
  systemSource?: string;
  windowHwnd?: string;
  windowPid?: number;
  clipboardContentType?: string;
  imageBytes?: number;
  captureLatencyMs?: number;
  encodeLatencyMs?: number;
  source?: string;
  captureBackend?: string;
  segmentId?: string;
  matchedVideoRelativePath?: string;
  seekSeconds?: number;
  matchLabel: string;
};

export async function exportTestSessionEvidence(
  input: ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  context: EvidenceExportContext,
): Promise<ReqCaseShadowRecorderTestSessionEvidenceExportResult> {
  const targetDir = input.targetDir.trim();
  if (!targetDir) {
    throw new Error('Evidence export targetDir is required.');
  }

  const orderedEvents = [...context.events].sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  const eventCount = orderedEvents.length;
  const stepEventCount = orderedEvents.filter((event) => event.eventType === 'step_captured').length;
  const privacyAcknowledgedAt = resolvePrivacyAcknowledgement(input, context, orderedEvents);

  const generatedAtMs = Date.now();
  const sourceSessionDir = await resolveSessionDir(context.session);
  const bundleName = buildBundleName(input.bundleName, context.session, generatedAtMs);
  const outputMode = input.outputMode ?? 'directory';
  const workingRoot =
    outputMode === 'zip'
      ? await mkdtemp(path.join(os.tmpdir(), 'shadowrecord-evidence-'))
      : targetDir;
  const exportDir = path.resolve(workingRoot, bundleName);

  assertExportTargetOutsideSource(sourceSessionDir, exportDir);

  await mkdir(exportDir, { recursive: true });
  const filteredVideoArtifacts = filterVideoArtifactsForSession(
    context.session,
    context.videoStreams,
    context.videoSegments,
  );
  const playableSegments = filteredVideoArtifacts.segments.filter(
    (segment) => segment.isPlayable && !!resolveCopiedSegmentRelativePath(segment, sourceSessionDir),
  );
  const videoDirRelativePath = 'video';
  const videoDirPath = path.resolve(exportDir, videoDirRelativePath);
  const videoCopyStats = await exportMergedPlaybackVideos(
    sourceSessionDir,
    videoDirPath,
    filteredVideoArtifacts.streams,
    playableSegments,
  );
  const eventsLogRelativePath = 'events-timeline.md';
  const eventsLogPath = path.resolve(exportDir, eventsLogRelativePath);
  const eventsCopyStats = await exportTimelineMarkdown(
    eventsLogPath,
    orderedEvents,
    filteredVideoArtifacts.streams,
    playableSegments,
    context.session,
  );
  const copyStats = {
    fileCount: videoCopyStats.fileCount + eventsCopyStats.fileCount,
    byteCount: videoCopyStats.byteCount + eventsCopyStats.byteCount,
  };

  const manifestRelativePath = 'manifest.json';
  const manifestV2RelativePath = 'manifest.v2.json';
  const summaryHtmlRelativePath = 'summary.html';
  const operationsJsonRelativePath = 'operations.json';
  const operationsCsvRelativePath = 'operations.csv';
  const checksumManifestRelativePath = 'sha256-manifest.json';

  const manifestPath = path.resolve(exportDir, manifestRelativePath);
  const manifestV2Path = path.resolve(exportDir, manifestV2RelativePath);
  const summaryHtmlPath = path.resolve(exportDir, summaryHtmlRelativePath);
  const operationsJsonPath = path.resolve(exportDir, operationsJsonRelativePath);
  const operationsCsvPath = path.resolve(exportDir, operationsCsvRelativePath);
  const checksumManifestPath = path.resolve(exportDir, checksumManifestRelativePath);

  const viewModel = buildEvidenceViewModel({
    events: orderedEvents,
    playableSegments,
    sourceSessionDir,
  });
  const operationRecords = orderedEvents.map((event) =>
    buildEvidenceExportLogRecord(event, viewModel.playableSegmentViews),
  );
  await writeFile(
    operationsJsonPath,
    JSON.stringify({
      schemaVersion: OPERATION_RECORDS_SCHEMA_VERSION,
      kind: OPERATION_RECORDS_KIND,
      builderVersion: OPERATION_RECORDS_BUILDER_VERSION,
      generatedAtMs,
      sessionId: context.session.sessionId,
      records: operationRecords,
    }, null, 2),
    'utf-8',
  );
  await writeFile(operationsCsvPath, buildOperationsCsv(operationRecords), 'utf-8');
  await writeFile(
    summaryHtmlPath,
    renderEvidenceHtml({
      session: context.session,
      generatedAtMs,
      copyStats,
      eventCount,
      stepEventCount,
      videoStreams: filteredVideoArtifacts.streams,
      videoSegments: filteredVideoArtifacts.segments,
      viewModel,
      manifestPath: manifestRelativePath,
      operationsJsonPath: operationsJsonRelativePath,
      operationsCsvPath: operationsCsvRelativePath,
      checksumManifestPath: checksumManifestRelativePath,
    }),
    'utf-8',
  );

  const checksumEntries = await buildArchiveChecksumEntries(exportDir);
  const manifest = buildEvidenceManifest({
    createdAt: new Date(generatedAtMs).toISOString(),
    app: { name: 'ReqCase Shadow Recorder' },
    session: {
      sessionId: context.session.sessionId,
      name: context.session.name,
      status: context.session.status,
      startedAtMs: context.session.startedAtMs,
      endedAtMs: context.session.endedAtMs,
      targetCaptureMode: context.session.targetCaptureMode,
      privacyAcknowledgedAt,
    },
    files: [
      { relativePath: videoDirRelativePath, role: 'video-directory' },
      { relativePath: eventsLogRelativePath, role: 'events-timeline' },
      { relativePath: manifestRelativePath, role: 'manifest' },
      { relativePath: manifestV2RelativePath, role: 'manifest-v2' },
      { relativePath: summaryHtmlRelativePath, role: 'summary-html' },
      { relativePath: operationsJsonRelativePath, role: 'operations-json' },
      { relativePath: operationsCsvRelativePath, role: 'operations-csv' },
      { relativePath: checksumManifestRelativePath, role: 'sha256-manifest' },
    ],
    checksums: checksumEntries,
    operations: {
      schemaVersion: OPERATION_RECORDS_SCHEMA_VERSION,
      builderVersion: OPERATION_RECORDS_BUILDER_VERSION,
      kind: OPERATION_RECORDS_KIND,
      jsonRelativePath: operationsJsonRelativePath,
      csvRelativePath: operationsCsvRelativePath,
    },
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  const checksumEntriesBeforeChecksumManifest = await buildArchiveChecksumEntries(exportDir);
  await writeFile(
    checksumManifestPath,
    JSON.stringify({
      schemaVersion: EVIDENCE_EXPORT_SCHEMA_VERSION,
      kind: SHA256_MANIFEST_KIND,
      generatedAtMs,
      files: checksumEntriesBeforeChecksumManifest,
    }, null, 2),
    'utf-8',
  );

  const finalChecksumEntries = await buildArchiveChecksumEntries(exportDir, { includeChecksumManifest: true });
  const manifestV2 = buildEvidenceManifestV2({
    sessionId: context.session.sessionId,
    createdAtMs: generatedAtMs,
    appVersion: '0.1.1',
    nativeVersion: '0.1.0',
    os: os.platform(),
    captureConfig: {
      recordingProfile: context.session.recordingProfile,
      encoderPreference: context.session.encoderPreference,
      targetCaptureMode: context.session.targetCaptureMode,
      targetDisplayId: context.session.targetDisplayId,
      targetDisplayIds: context.session.targetDisplayIds,
    },
    operationsSchemaVersion: OPERATION_RECORDS_SCHEMA_VERSION,
    operationsBuilderVersion: OPERATION_RECORDS_BUILDER_VERSION,
    operationsKind: OPERATION_RECORDS_KIND,
    operationsJsonRelativePath,
    operationsCsvRelativePath,
    checksums: finalChecksumEntries,
  });
  await writeFile(manifestV2Path, JSON.stringify(manifestV2, null, 2), 'utf-8');
  const checksumManifestStats = await stat(checksumManifestPath);
  const finalCopyStats = {
    fileCount: finalChecksumEntries.length + 1,
    byteCount: finalChecksumEntries.reduce((total, entry) => total + entry.sizeBytes, 0) + checksumManifestStats.size,
  };

  if (outputMode === 'zip') {
    const zipPath = path.resolve(targetDir, resolveZipFileName(input.zipFileName, bundleName));
    await createArchiveZip(exportDir, zipPath);
    await rm(workingRoot, { recursive: true, force: true });

    return {
      sessionId: context.session.sessionId,
      outputMode,
      bundleRootName: bundleName,
      artifactPath: zipPath,
      zipPath,
      videoDirRelativePath,
      eventsLogRelativePath,
      summaryHtmlRelativePath,
      operationsJsonRelativePath,
      operationsCsvRelativePath,
      manifestV2RelativePath,
      checksumManifestRelativePath,
      checksumEntryCount: finalChecksumEntries.length,
      generatedAtMs,
      eventCount,
      stepEventCount,
      videoStreamCount: filteredVideoArtifacts.streams.length,
      videoSegmentCount: filteredVideoArtifacts.segments.length,
      playableVideoSegmentCount: playableSegments.length,
      copiedFileCount: finalCopyStats.fileCount,
      copiedBytes: finalCopyStats.byteCount,
      privacyAcknowledgedAt,
    };
  }

  return {
    sessionId: context.session.sessionId,
    outputMode,
    bundleRootName: bundleName,
    artifactPath: exportDir,
    exportDir,
    videoDirPath,
    videoDirRelativePath,
    eventsLogPath,
    eventsLogRelativePath,
    manifestPath,
    manifestV2Path,
    manifestV2RelativePath,
    summaryHtmlPath,
    summaryHtmlRelativePath,
    operationsJsonPath,
    operationsJsonRelativePath,
    operationsCsvPath,
    operationsCsvRelativePath,
    checksumManifestPath,
    checksumManifestRelativePath,
    checksumEntryCount: finalChecksumEntries.length,
    generatedAtMs,
    eventCount,
    stepEventCount,
    videoStreamCount: filteredVideoArtifacts.streams.length,
    videoSegmentCount: filteredVideoArtifacts.segments.length,
    playableVideoSegmentCount: playableSegments.length,
    copiedFileCount: finalCopyStats.fileCount,
    copiedBytes: finalCopyStats.byteCount,
    privacyAcknowledgedAt,
  };
}

function resolvePrivacyAcknowledgement(
  input: ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  context: EvidenceExportContext,
  orderedEvents: ReqCaseShadowRecorderTestSessionTimelineEvent[],
): string | undefined {
  if (!requiresPrivacyAcknowledgement(context, orderedEvents)) {
    return input.privacyAcknowledgedAt?.trim() || undefined;
  }

  const acknowledgedAt = input.privacyAcknowledgedAt?.trim();
  if (!acknowledgedAt) {
    throw new Error('Evidence export privacy acknowledgement is required.');
  }

  return acknowledgedAt;
}

function requiresPrivacyAcknowledgement(
  context: EvidenceExportContext,
  orderedEvents: ReqCaseShadowRecorderTestSessionTimelineEvent[],
): boolean {
  return orderedEvents.some(hasScreenshotArtifact)
    || context.videoSegments.some((segment) => segment.isPlayable || !!segment.relativePath || !!segment.filePath);
}

function hasScreenshotArtifact(event: ReqCaseShadowRecorderTestSessionTimelineEvent): boolean {
  return event.eventType === 'step_captured'
    && (
      !!event.fullImagePath
      || !!event.thumbImagePath
      || (typeof event.imageBytes === 'number' && event.imageBytes > 0)
    );
}

function filterVideoArtifactsForSession(
  session: ReqCaseShadowRecorderTestSessionState,
  streams: ReqCaseShadowRecorderTestSessionVideoStream[],
  segments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): {
  streams: ReqCaseShadowRecorderTestSessionVideoStream[];
  segments: ReqCaseShadowRecorderTestSessionVideoSegment[];
} {
  const selectedDisplayIds = new Set(
    (session.targetDisplayIds ?? [])
      .map((displayId) => displayId.trim())
      .filter((displayId) => displayId.length > 0),
  );

  if (session.targetDisplayId?.trim()) {
    selectedDisplayIds.add(session.targetDisplayId.trim());
  }

  if (selectedDisplayIds.size === 0) {
    return { streams, segments };
  }

  const shouldFilterByDisplay =
    session.targetCaptureMode === 'all_displays'
    || session.targetCaptureMode === 'target_display'
    || session.targetCaptureMode === 'desktop'
    || session.targetCaptureMode === 'foreground_window'
    || session.targetCaptureMode === 'target_window';

  if (!shouldFilterByDisplay) {
    return { streams, segments };
  }

  const filteredStreams = streams.filter((stream) => {
    if (!stream.displayId) {
      return selectedDisplayIds.size === 0;
    }
    return selectedDisplayIds.has(stream.displayId);
  });

  const allowedStreamIds = new Set(filteredStreams.map((stream) => stream.streamId));
  const filteredSegments = segments.filter((segment) => {
    if (allowedStreamIds.has(segment.streamId)) {
      return true;
    }
    if (segment.displayId) {
      return selectedDisplayIds.has(segment.displayId);
    }
    return false;
  });

  if (filteredStreams.length === 0 && filteredSegments.length === 0) {
    return { streams, segments };
  }

  return {
    streams: filteredStreams.length > 0 ? filteredStreams : streams,
    segments: filteredSegments.length > 0 ? filteredSegments : segments,
  };
}

async function resolveSessionDir(
  session: ReqCaseShadowRecorderTestSessionState,
): Promise<string> {
  if (!session.sessionDir) {
    throw new Error(`Session ${session.sessionId} is missing sessionDir.`);
  }
  const stats = await stat(session.sessionDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Session directory does not exist: ${session.sessionDir}`);
  }
  return path.resolve(session.sessionDir);
}

function buildBundleName(
  bundleName: string | undefined,
  session: ReqCaseShadowRecorderTestSessionState,
  generatedAtMs: number,
): string {
  const base = (bundleName?.trim() || session.name?.trim() || session.sessionId || 'evidence')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `evidence-${base || 'bundle'}-${generatedAtMs}`;
}

function resolveZipFileName(zipFileName: string | undefined, fallbackBundleName: string): string {
  const fallbackName = `${fallbackBundleName}.zip`;
  const requestedName = zipFileName?.trim();
  if (!requestedName) {
    return fallbackName;
  }

  const baseName = path.basename(requestedName).trim();
  if (!baseName || baseName === '.' || baseName === '..') {
    return fallbackName;
  }

  const sanitized = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');

  if (!sanitized) {
    return fallbackName;
  }

  return sanitized.toLowerCase().endsWith('.zip') ? sanitized : `${sanitized}.zip`;
}

function assertExportTargetOutsideSource(sourceDir: string, exportDir: string): void {
  const relative = path.relative(sourceDir, exportDir);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Evidence export target must not be inside session source directory: ${exportDir}`);
  }
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<CopyStats> {
  await mkdir(targetDir, { recursive: true });
  let fileCount = 0;
  let byteCount = 0;
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.resolve(sourceDir, entry.name);
    const targetPath = path.resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyDirectoryRecursive(sourcePath, targetPath);
      fileCount += nested.fileCount;
      byteCount += nested.byteCount;
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const fileStats = await stat(sourcePath);
    fileCount += 1;
    byteCount += fileStats.size;
  }
  return { fileCount, byteCount };
}

async function exportEventsNdjson(
  sourceSessionDir: string,
  targetPath: string,
  events: ReqCaseShadowRecorderTestSessionTimelineEvent[],
): Promise<CopyStats> {
  const sourcePath = path.resolve(sourceSessionDir, 'events.ndjson');
  const sourceStats = await stat(sourcePath).catch(() => null);

  await mkdir(path.dirname(targetPath), { recursive: true });

  if (sourceStats?.isFile()) {
    await copyFile(sourcePath, targetPath);
    return {
      fileCount: 1,
      byteCount: sourceStats.size,
    };
  }

  const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}${events.length > 0 ? '\n' : ''}`;
  await writeFile(targetPath, payload, 'utf-8');
  return {
    fileCount: 1,
    byteCount: Buffer.byteLength(payload, 'utf-8'),
  };
}

async function exportTimelineMarkdown(
  targetPath: string,
  events: ReqCaseShadowRecorderTestSessionTimelineEvent[],
  videoStreams: ReqCaseShadowRecorderTestSessionVideoStream[],
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
  session: ReqCaseShadowRecorderTestSessionState,
): Promise<CopyStats> {
  const displayLabelById = new Map(
    videoStreams
      .filter((stream) => !!stream.displayId)
      .map((stream) => [stream.displayId as string, stream.displayLabel ?? stream.label]),
  );
  const streamFileNameById = buildExportedVideoFileNameMap(videoStreams, playableSegments);

  const matchedVideoByEventId = new Map(
    events.map((event) => {
      const matchedSegment = findBestMatchingSegmentRecord(event, playableSegments);
      return [
        event.eventId,
        {
          segmentId: matchedSegment?.segment.segmentId,
          streamId: matchedSegment?.segment.streamId,
          displayId: matchedSegment?.segment.displayId,
          videoFile: matchedSegment?.segment.streamId
            ? streamFileNameById.get(matchedSegment.segment.streamId)
            : undefined,
        },
      ] as const;
    }),
  );

  const records = events
    .slice()
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs)
    .map((event, index) => {
      const matchedVideo = matchedVideoByEventId.get(event.eventId);
      const displayId = event.displayId ?? matchedVideo?.displayId ?? '';
      return {
        sequence: index + 1,
        occurredAtIso: new Date(event.occurredAtMs).toISOString(),
        occurredAtLocal: new Date(event.occurredAtMs).toLocaleString('zh-CN', { hour12: false }),
        elapsedMs: Math.max(0, event.occurredAtMs - session.startedAtMs),
        displayId,
        displayLabel: displayId ? (displayLabelById.get(displayId) ?? displayId) : '',
        logCategory: event.logCategory,
        level: resolveLogLevel(event),
        eventType: event.eventType,
        summary: buildEventSummary(event),
        detail: buildEventDetail(event),
        processName: event.processName ?? '',
        windowTitle: event.windowTitle ?? '',
        action: event.action ?? '',
        streamId: matchedVideo?.streamId ?? '',
        segmentId: matchedVideo?.segmentId ?? '',
        videoFile: matchedVideo?.videoFile ?? '',
      };
    });

  const payload = buildTimelineMarkdown(session, records);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, payload, 'utf-8');

  return {
    fileCount: 1,
    byteCount: Buffer.byteLength(payload, 'utf-8'),
  };
}

function buildExportedVideoFileNameMap(
  videoStreams: ReqCaseShadowRecorderTestSessionVideoStream[],
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): Map<string, string> {
  const segmentsByStream = new Map<string, ReqCaseShadowRecorderTestSessionVideoSegment[]>();
  for (const segment of playableSegments) {
    const current = segmentsByStream.get(segment.streamId) ?? [];
    current.push(segment);
    segmentsByStream.set(segment.streamId, current);
  }

  const streamEntries = [...segmentsByStream.keys()]
    .map((streamId) => ({
      streamId,
      stream: videoStreams.find((item) => item.streamId === streamId),
    }));
  const multipleStreams = streamEntries.length > 1;

  return new Map(
    streamEntries.map((entry, index) => [
      entry.streamId,
      buildMergedVideoFileName(entry.stream, index, multipleStreams),
    ]),
  );
}

function buildTimelineMarkdown(
  session: ReqCaseShadowRecorderTestSessionState,
  records: Array<{
    sequence: number;
    occurredAtIso: string;
    occurredAtLocal: string;
    elapsedMs: number;
    displayId: string;
    displayLabel: string;
    logCategory: string;
    level: string;
    eventType: string;
    summary: string;
    detail: string;
    processName: string;
    windowTitle: string;
    action: string;
    streamId: string;
    segmentId: string;
    videoFile: string;
  }>,
): string {
  const lines: string[] = [];
  const title = session.name?.trim() || session.sessionId;
  lines.push(`# ${title} 事件时间线`);
  lines.push('');
  lines.push(`- 会话 ID: \`${session.sessionId}\``);
  lines.push(`- 录制目标: \`${session.targetCaptureMode}\``);
  lines.push(`- 开始时间: ${new Date(session.startedAtMs).toLocaleString('zh-CN', { hour12: false })}`);
  if (session.endedAtMs) {
    lines.push(`- 结束时间: ${new Date(session.endedAtMs).toLocaleString('zh-CN', { hour12: false })}`);
  }
  lines.push(`- 事件总数: ${records.length}`);
  lines.push('');

  if (records.length === 0) {
    lines.push('当前没有可导出的事件记录。');
    lines.push('');
    return lines.join('\n');
  }

  for (const record of records) {
    lines.push(`## ${record.sequence}. ${record.summary}`);
    lines.push('');
    lines.push(`- 时间: ${record.occurredAtLocal}`);
    lines.push(`- 相对录制时间: ${formatDurationSeconds(record.elapsedMs / 1000)}`);
    lines.push(`- 分类: ${formatLogCategoryLabel(record.logCategory)} / ${formatLogLevelLabel(record.level)}`);
    lines.push(`- 事件类型: \`${record.eventType}\``);
    if (record.displayId || record.displayLabel) {
      lines.push(`- 显示器: ${record.displayLabel || record.displayId}${record.displayId ? ` (\`${record.displayId}\`)` : ''}`);
    }
    if (record.processName) {
      lines.push(`- 进程: \`${record.processName}\``);
    }
    if (record.windowTitle) {
      lines.push(`- 窗口: ${record.windowTitle}`);
    }
    if (record.action) {
      lines.push(`- 动作: \`${record.action}\``);
    }
    if (record.detail) {
      lines.push(`- 详情: ${record.detail}`);
    }
    if (record.videoFile) {
      lines.push(`- 对应视频: \`video/${record.videoFile}\``);
    }
    if (record.streamId || record.segmentId) {
      lines.push(`- 片段定位: ${record.streamId ? `stream=\`${record.streamId}\`` : ''}${record.streamId && record.segmentId ? ' · ' : ''}${record.segmentId ? `segment=\`${record.segmentId}\`` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function exportMergedPlaybackVideos(
  sourceSessionDir: string,
  targetVideoDir: string,
  videoStreams: ReqCaseShadowRecorderTestSessionVideoStream[],
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): Promise<CopyStats> {
  const segmentsByStream = new Map<string, ReqCaseShadowRecorderTestSessionVideoSegment[]>();
  for (const segment of playableSegments) {
    const current = segmentsByStream.get(segment.streamId) ?? [];
    current.push(segment);
    segmentsByStream.set(segment.streamId, current);
  }

  const streamEntries = [...segmentsByStream.entries()]
    .map(([streamId, segments]) => ({
      streamId,
      stream: videoStreams.find((item) => item.streamId === streamId),
      segments: segments.slice().sort((left, right) => left.startedAtMs - right.startedAtMs),
    }))
    .filter((entry) => entry.segments.length > 0);

  let fileCount = 0;
  let byteCount = 0;
  const multipleStreams = streamEntries.length > 1;

  for (const [index, entry] of streamEntries.entries()) {
    const outputFileName = buildMergedVideoFileName(entry.stream, index, multipleStreams);
    const outputPath = path.resolve(targetVideoDir, outputFileName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const stats = await exportMergedStreamVideo(sourceSessionDir, entry.segments, outputPath);
    fileCount += stats.fileCount;
    byteCount += stats.byteCount;
  }

  return { fileCount, byteCount };
}

function buildMergedVideoFileName(
  stream: ReqCaseShadowRecorderTestSessionVideoStream | undefined,
  index: number,
  multipleStreams: boolean,
): string {
  if (!multipleStreams) {
    return 'recording.mp4';
  }

  const base = (stream?.displayLabel ?? stream?.label ?? stream?.displayId ?? `display-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `recording-${base || `display-${index + 1}`}.mp4`;
}

async function exportMergedStreamVideo(
  sourceSessionDir: string,
  segments: ReqCaseShadowRecorderTestSessionVideoSegment[],
  outputPath: string,
): Promise<CopyStats> {
  const resolvedSegments = [];
  for (const segment of segments) {
    const relativePath = resolveCopiedSegmentRelativePath(segment, sourceSessionDir);
    const directFilePath = segment.filePath
      ? path.resolve(segment.filePath)
      : undefined;
    const fallbackFilePath = relativePath
      ? path.resolve(sourceSessionDir, relativePath)
      : undefined;
    const sourceFilePath = directFilePath && await stat(directFilePath).catch(() => null)
      ? directFilePath
      : fallbackFilePath;

    if (!sourceFilePath) {
      continue;
    }

    const sourceStats = await stat(sourceFilePath).catch(() => null);
    if (!sourceStats?.isFile() || path.extname(sourceFilePath).toLowerCase() !== '.mp4') {
      continue;
    }

    resolvedSegments.push(sourceFilePath);
  }

  if (resolvedSegments.length === 0) {
    return { fileCount: 0, byteCount: 0 };
  }

  if (resolvedSegments.length === 1) {
    await copyFile(resolvedSegments[0], outputPath);
    const outputStats = await stat(outputPath);
    return { fileCount: 1, byteCount: outputStats.size };
  }

  const ffmpegPath = resolveBundledFfmpegPath() ?? process.env.REQCASE_SHADOWRECORDER_FFMPEG_PATH ?? null;
  if (!ffmpegPath) {
    throw new Error('Cannot export merged video because ffmpeg is unavailable.');
  }

  const concatListPath = path.resolve(path.dirname(outputPath), `${path.basename(outputPath, '.mp4')}.concat.txt`);
  const concatPayload = resolvedSegments
    .map((segmentPath) => `file '${segmentPath.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`)
    .join('\n');
  await writeFile(concatListPath, concatPayload, 'utf-8');

  await runFfmpegConcat(ffmpegPath, concatListPath, outputPath);
  await rm(concatListPath, { force: true });
  const outputStats = await stat(outputPath);
  return { fileCount: 1, byteCount: outputStats.size };
}

function runFfmpegConcat(
  ffmpegPath: string,
  concatListPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg concat failed with exit code ${code}.`));
    });
  });
}

async function exportPlayableMp4Segments(
  sourceSessionDir: string,
  targetVideoDir: string,
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): Promise<CopyStats> {
  let fileCount = 0;
  let byteCount = 0;

  for (const segment of playableSegments) {
    const relativePath = resolveCopiedSegmentRelativePath(segment, sourceSessionDir);
    const directFilePath = segment.filePath
      ? path.resolve(segment.filePath)
      : undefined;
    const fallbackFilePath = relativePath
      ? path.resolve(sourceSessionDir, relativePath)
      : undefined;
    const sourceFilePath = directFilePath && await stat(directFilePath).catch(() => null)
      ? directFilePath
      : fallbackFilePath;

    if (!sourceFilePath || !relativePath) {
      continue;
    }

    const extension = path.extname(sourceFilePath).toLowerCase();
    if (extension !== '.mp4') {
      continue;
    }

    const sourceStats = await stat(sourceFilePath).catch(() => null);
    if (!sourceStats?.isFile()) {
      continue;
    }

    const targetPath = path.resolve(targetVideoDir, stripVideoPrefix(relativePath));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourceFilePath, targetPath);
    fileCount += 1;
    byteCount += sourceStats.size;
  }

  return { fileCount, byteCount };
}

async function resolveCopiedOptionalPath(
  sourceSessionDir: string,
  relativePath: string,
): Promise<string | undefined> {
  const fullPath = path.resolve(sourceSessionDir, relativePath);
  const stats = await stat(fullPath).catch(() => null);
  if (!stats) {
    return undefined;
  }
  return toPosixRelative(relativePath);
}

function resolveSessionManifestRelativePath(
  session: ReqCaseShadowRecorderTestSessionState,
  sourceSessionDir: string,
): string | undefined {
  if (!session.manifestPath) {
    return undefined;
  }
  return resolveCopiedRelativePath(sourceSessionDir, session.manifestPath);
}

function resolveCopiedSegmentRelativePath(
  segment: ReqCaseShadowRecorderTestSessionVideoSegment,
  sourceSessionDir: string,
): string | undefined {
  if (segment.relativePath) {
    return toPosixRelative(segment.relativePath);
  }
  if (segment.filePath) {
    return resolveCopiedRelativePath(sourceSessionDir, segment.filePath);
  }
  return undefined;
}

function resolveCopiedRelativePath(sourceSessionDir: string, filePath: string): string | undefined {
  const resolvedFilePath = path.resolve(filePath);
  const relativePath = path.relative(sourceSessionDir, resolvedFilePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return toPosixRelative(relativePath);
}

function toPosixRelative(input: string): string {
  return input.replace(/\\/g, '/');
}

function stripVideoPrefix(relativePath: string): string {
  const normalized = toPosixRelative(relativePath);
  return normalized.startsWith('video/') ? normalized.slice('video/'.length) : normalized;
}

function buildOperationsCsv(records: EvidenceExportLogRecord[]): string {
  const header = [
    'occurredAtIso',
    'occurredAtMs',
    'logCategory',
    'level',
    'eventType',
    'summary',
    'detail',
    'status',
    'stepId',
    'action',
    'displayId',
    'processName',
    'windowTitle',
    'title',
    'message',
    'logSource',
    'systemSource',
    'windowPid',
    'windowHwnd',
    'clipboardContentType',
    'source',
    'captureBackend',
    'segmentId',
    'matchedVideoRelativePath',
    'seekSeconds',
    'matchLabel',
  ];
  const rows = records.map((record) => [
    record.occurredAtIso,
    `${record.occurredAtMs}`,
    record.logCategory,
    record.level,
    record.eventType,
    record.summary,
    record.detail,
    record.status ?? '',
    record.stepId ?? '',
    record.action ?? '',
    record.displayId ?? '',
    record.processName ?? '',
    record.windowTitle ?? '',
    record.title ?? '',
    record.message ?? '',
    record.logSource ?? '',
    record.systemSource ?? '',
    record.windowPid !== undefined ? `${record.windowPid}` : '',
    record.windowHwnd ?? '',
    record.clipboardContentType ?? '',
    record.source ?? '',
    record.captureBackend ?? '',
    record.segmentId ?? '',
    record.matchedVideoRelativePath ?? '',
    record.seekSeconds !== undefined ? `${record.seekSeconds}` : '',
    record.matchLabel,
  ]);
  return [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildEvidenceHtmlEventView(
  event: ReqCaseShadowRecorderTestSessionTimelineEvent,
  playableSegments: EvidenceHtmlSegmentView[],
): EvidenceHtmlEventView {
  const level = resolveLogLevel(event);
  const matchedSegment = findBestMatchingPlayableSegment(event, playableSegments);
  const seekSeconds =
    matchedSegment?.segment
      ? clamp(
        (event.occurredAtMs - matchedSegment.segment.startedAtMs) / 1000,
        0,
        Math.max(0, matchedSegment.segment.durationMs / 1000 - 0.05),
      )
      : undefined;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    logCategory: event.logCategory,
    logCategoryLabel: formatLogCategoryLabel(event.logCategory),
    level,
    levelLabel: formatLogLevelLabel(level),
    occurredAtMs: event.occurredAtMs,
    occurredAtLabel: new Date(event.occurredAtMs).toLocaleString('zh-CN', { hour12: false }),
    summary: buildEventSummary(event),
    detail: buildEventDetail(event),
    displayId: event.displayId,
    processName: event.processName,
    windowTitle: event.windowTitle,
    message: event.message,
    title: event.title,
    segmentIndex: matchedSegment?.index,
    seekSeconds,
    seekLabel: seekSeconds !== undefined ? formatDurationSeconds(seekSeconds) : undefined,
    matchLabel: matchedSegment?.segment
      ? `定位到 ${matchedSegment.segment.label} · 跳转 ${formatDurationSeconds(seekSeconds ?? 0)}`
      : '没有匹配到可播放视频段',
  };
}

function buildEvidenceExportLogRecord(
  event: ReqCaseShadowRecorderTestSessionTimelineEvent,
  playableSegments: EvidenceHtmlSegmentView[],
): EvidenceExportLogRecord {
  const level = resolveLogLevel(event);
  const matchedSegment = findBestMatchingPlayableSegment(event, playableSegments);
  const seekSeconds =
    matchedSegment?.segment
      ? clamp(
        (event.occurredAtMs - matchedSegment.segment.startedAtMs) / 1000,
        0,
        Math.max(0, matchedSegment.segment.durationMs / 1000 - 0.05),
      )
      : undefined;

  return {
    eventId: event.eventId,
    occurredAtMs: event.occurredAtMs,
    occurredAtIso: new Date(event.occurredAtMs).toISOString(),
    logCategory: event.logCategory,
    level,
    eventType: event.eventType,
    summary: buildEventSummary(event),
    detail: buildEventDetail(event),
    status: event.status,
    stepId: event.stepId,
    action: event.action,
    displayId: event.displayId,
    processName: event.processName,
    windowTitle: event.windowTitle,
    title: event.title,
    message: event.message,
    logSource: event.logSource,
    systemSource: event.systemSource,
    windowHwnd: event.windowHwnd,
    windowPid: event.windowPid,
    clipboardContentType: event.clipboardContentType,
    imageBytes: event.imageBytes,
    captureLatencyMs: event.captureLatencyMs,
    encodeLatencyMs: event.encodeLatencyMs,
    source: event.source,
    captureBackend: event.captureBackend,
    segmentId: matchedSegment?.segment.segmentId,
    matchedVideoRelativePath: matchedSegment?.segment.relativePath,
    seekSeconds,
    matchLabel: matchedSegment?.segment
      ? `定位到 ${matchedSegment.segment.label} · 跳转 ${formatDurationSeconds(seekSeconds ?? 0)}`
      : '没有匹配到可播放视频段',
  };
}

function findBestMatchingSegmentRecord(
  event: ReqCaseShadowRecorderTestSessionTimelineEvent,
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): { index: number; segment: ReqCaseShadowRecorderTestSessionVideoSegment } | null {
  const MAX_MATCH_DISTANCE_MS = 3_000;
  let bestMatch: {
    index: number;
    segment: ReqCaseShadowRecorderTestSessionVideoSegment;
    displayPenalty: number;
    distanceMs: number;
  } | null = null;

  for (const [index, segment] of playableSegments.entries()) {
    const distanceMs =
      event.occurredAtMs < segment.startedAtMs
        ? segment.startedAtMs - event.occurredAtMs
        : event.occurredAtMs > segment.endedAtMs
          ? event.occurredAtMs - segment.endedAtMs
          : 0;
    if (distanceMs > MAX_MATCH_DISTANCE_MS) {
      continue;
    }
    const displayPenalty =
      event.displayId && segment.displayId && event.displayId !== segment.displayId ? 1 : 0;
    if (
      !bestMatch
      || displayPenalty < bestMatch.displayPenalty
      || (displayPenalty === bestMatch.displayPenalty && distanceMs < bestMatch.distanceMs)
      || (displayPenalty === bestMatch.displayPenalty && distanceMs === bestMatch.distanceMs && segment.startedAtMs > bestMatch.segment.startedAtMs)
    ) {
      bestMatch = { index, segment, displayPenalty, distanceMs };
    }
  }

  return bestMatch ? { index: bestMatch.index, segment: bestMatch.segment } : null;
}

function findBestMatchingPlayableSegment(
  event: ReqCaseShadowRecorderTestSessionTimelineEvent,
  playableSegments: EvidenceHtmlSegmentView[],
): { index: number; segment: EvidenceHtmlSegmentView } | null {
  const MAX_MATCH_DISTANCE_MS = 3_000;
  let bestMatch: { index: number; segment: EvidenceHtmlSegmentView; displayPenalty: number; distanceMs: number } | null = null;
  for (const [index, segment] of playableSegments.entries()) {
    const distanceMs =
      event.occurredAtMs < segment.startedAtMs
        ? segment.startedAtMs - event.occurredAtMs
        : event.occurredAtMs > segment.endedAtMs
          ? event.occurredAtMs - segment.endedAtMs
          : 0;
    if (distanceMs > MAX_MATCH_DISTANCE_MS) {
      continue;
    }
    const displayPenalty =
      event.displayId && segment.displayId && event.displayId !== segment.displayId ? 1 : 0;
    if (
      !bestMatch
      || displayPenalty < bestMatch.displayPenalty
      || (displayPenalty === bestMatch.displayPenalty && distanceMs < bestMatch.distanceMs)
      || (displayPenalty === bestMatch.displayPenalty && distanceMs === bestMatch.distanceMs && segment.startedAtMs > bestMatch.segment.startedAtMs)
    ) {
      bestMatch = { index, segment, displayPenalty, distanceMs };
    }
  }
  return bestMatch ? { index: bestMatch.index, segment: bestMatch.segment } : null;
}

function buildEventSummary(event: ReqCaseShadowRecorderTestSessionTimelineEvent): string {
  return event.action ?? event.title ?? event.processName ?? event.windowTitle ?? event.eventType;
}

function buildEventDetail(event: ReqCaseShadowRecorderTestSessionTimelineEvent): string {
  const parts = [
    event.message,
    event.windowTitle,
    event.processName,
    event.displayId ? `display=${event.displayId}` : undefined,
    event.x !== undefined && event.y !== undefined ? `xy=${event.x},${event.y}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.join(' · ') || '没有更多详情';
}

function resolveLogLevel(event: ReqCaseShadowRecorderTestSessionTimelineEvent): string {
  if (event.logLevel) {
    return event.logLevel;
  }
  return 'info';
}

function formatLogCategoryLabel(category: string): string {
  switch (category) {
    case 'recording':
      return '录制';
    case 'operation':
      return '操作';
    case 'system':
      return '系统';
    case 'app':
      return '应用';
    default:
      return category;
  }
}

function formatLogLevelLabel(level: string): string {
  return level.toUpperCase();
}

function buildEvidenceViewModel(input: {
  events: ReqCaseShadowRecorderTestSessionTimelineEvent[];
  playableSegments: ReqCaseShadowRecorderTestSessionVideoSegment[];
  sourceSessionDir: string;
}): EvidenceViewModel {
  const playableSegmentViews = input.playableSegments.reduce<EvidenceHtmlSegmentView[]>((accumulator, segment) => {
    const relativePath = resolveCopiedSegmentRelativePath(segment, input.sourceSessionDir);
    if (!relativePath) {
      return accumulator;
    }
    accumulator.push({
      segmentId: segment.segmentId,
      streamId: segment.streamId,
      displayId: segment.displayId,
      relativePath,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs,
      durationMs: segment.durationMs,
      label: `${segment.streamId} · ${segment.displayId ?? 'default'} · ${formatDurationMsCompact(segment.durationMs)}`,
      meta: [new Date(segment.startedAtMs).toLocaleString('zh-CN', { hour12: false }), `${segment.codec ?? segment.container ?? 'segment'}`, `${segment.durationMs} ms`].join(' · '),
      fileLabel: relativePath,
    });
    return accumulator;
  }, []).sort((left, right) => left.startedAtMs - right.startedAtMs);

  const eventViews = [...input.events]
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs)
    .map((event) => buildEvidenceHtmlEventView(event, playableSegmentViews));

  const matchedEventIndex = eventViews.findIndex((event) => event.segmentIndex !== undefined);
  const defaultEventIndex = matchedEventIndex >= 0 ? matchedEventIndex : eventViews.length > 0 ? 0 : -1;
  const defaultSegmentIndex =
    defaultEventIndex >= 0 && eventViews[defaultEventIndex]?.segmentIndex !== undefined
      ? eventViews[defaultEventIndex]?.segmentIndex
      : playableSegmentViews.length > 0
        ? playableSegmentViews.length - 1
        : undefined;

  return {
    playableSegmentViews,
    eventViews,
    defaultEventIndex,
    defaultSegmentIndex,
    categoryOptions: ['recording', 'operation', 'system', 'app']
      .filter((value) => eventViews.some((event) => event.logCategory === value))
      .map((value) => ({ value, label: formatLogCategoryLabel(value) })),
    displayOptions: [...new Set(eventViews.map((event) => event.displayId).filter((displayId): displayId is string => Boolean(displayId)))].sort(),
  };
}

function formatDurationMsCompact(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return formatDurationSeconds(durationMs / 1000);
}

function formatDurationSeconds(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMilliseconds / 60000);
  const remainingMilliseconds = totalMilliseconds % 60000;
  const wholeSeconds = Math.floor(remainingMilliseconds / 1000);
  const millis = remainingMilliseconds % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
