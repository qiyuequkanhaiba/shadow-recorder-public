import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  getActiveTestSession,
  getRecorderMetrics,
  getTestSessionEvents,
  getTestSessionVideoSegments,
  getTestSessionVideoStreams,
  startTestSession,
  stopTestSession,
} from '../src-electron/native-binding';
import { configureBundledFfmpegEnv } from '../src-electron/ffmpeg-resource';
import type { ReqCaseShadowRecorderMetrics } from '../src-electron/modules/reqcase-shadow-recorder/types';

type CaptureMode = 'target_display' | 'foreground_window';
type RecordingProfile = 'efficiency' | 'balanced' | 'smooth';
type EncoderPreference = 'auto' | 'hardware' | 'software';

type CliOptions = {
  durationSeconds: number;
  segmentDurationSeconds: number;
  recordingWindowSeconds: number;
  mode: CaptureMode;
  outputRoot: string;
  keepArtifacts: boolean;
  sampleIntervalMs: number;
  profiles: RecordingProfile[];
  encoders: EncoderPreference[];
};

type ProcessSampleRow = {
  pid: number;
  name: string;
  cpuSeconds: number;
  workingSetBytes: number;
  privateBytes: number;
};

type ResourceSample = {
  capturedAtMs: number;
  node: ProcessSampleRow | null;
  ffmpeg: ProcessSampleRow[];
};

type ScenarioResult = {
  scenarioId: string;
  mode: CaptureMode;
  recordingProfile: RecordingProfile;
  encoderPreference: EncoderPreference;
  durationSeconds: number;
  sampleCount: number;
  sessionId: string;
  smokeRoot: string;
  streamCount: number;
  segmentCount: number;
  playableSegmentCount: number;
  totalPlayableDurationMs: number;
  eventCount: number;
  warningCount: number;
  selectedEncoders: string[];
  selectedCodecs: string[];
  captureP95Ms: number;
  encodeP95Ms: number;
  totalSegmentBytes: number;
  avgCombinedCpuPercent: number;
  peakCombinedCpuPercent: number;
  avgCombinedWorkingSetMb: number;
  peakCombinedWorkingSetMb: number;
  avgFfmpegWorkingSetMb: number;
  peakFfmpegWorkingSetMb: number;
  metricsDelta: {
    capturedStepsTotal: number;
    droppedStepsTotal: number;
    captureQueueDropTotal: number;
    encodeQueueDropTotal: number;
    inputChannelFullDropTotal: number;
    pushDispatchDropTotal: number;
    dirtyRegionFrameTotal: number;
    dirtyRegionEmptyFrameTotal: number;
    dirtyRegionCoverageAvg: number;
  };
  warnings: string[];
};

type HardwareMatrixRow = {
  matrix: 'NVIDIA' | 'Intel' | 'AMD' | 'RDP';
  profile: string;
  encoder: string;
  captureP95: number;
  encodeP95: number;
  dropTotal: number;
  fileSize: number;
  result: 'Passed' | 'Failed' | 'Skipped';
  notes: string;
};

type BenchmarkReport = {
  generatedAt: string;
  options: CliOptions;
  scenarios: ScenarioResult[];
};

function parseList<T extends string>(value: string | undefined, allowed: readonly T[], fallback: readonly T[]): T[] {
  if (!value || !value.trim()) {
    return [...fallback];
  }
  const normalized = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry): entry is T => allowed.includes(entry as T));
  return normalized.length > 0 ? normalized : [...fallback];
}

function parseArgs(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    durationSeconds: 15,
    segmentDurationSeconds: 5,
    recordingWindowSeconds: 60,
    mode: 'target_display',
    outputRoot: path.resolve(process.cwd(), 'reports', 'encoding-benchmark'),
    keepArtifacts: false,
    sampleIntervalMs: 1000,
    profiles: ['balanced'],
    encoders: ['auto', 'hardware', 'software'],
  };

  const positional = argv.filter((value) => !value.startsWith('--'));
  if (positional[0] === 'target_display' || positional[0] === 'foreground_window') {
    defaults.mode = positional[0];
  }
  if (positional[1]) {
    defaults.durationSeconds = Number.parseInt(positional[1], 10) || defaults.durationSeconds;
  }
  if (positional[2]) {
    defaults.segmentDurationSeconds =
      Number.parseInt(positional[2], 10) || defaults.segmentDurationSeconds;
  }
  if (positional[3]) {
    defaults.recordingWindowSeconds =
      Number.parseInt(positional[3], 10) || defaults.recordingWindowSeconds;
  }
  if (positional[4]) {
    defaults.profiles = parseList(
      positional[4],
      ['efficiency', 'balanced', 'smooth'] as const,
      defaults.profiles,
    );
  }
  if (positional.length > 5) {
    defaults.encoders = parseList(
      positional.slice(5).join(','),
      ['auto', 'hardware', 'software'] as const,
      defaults.encoders,
    );
  }

  for (let index = 0; index < argv.length; index += 1) {
    const rawValue = argv[index];
    const [value, inlineValue] = rawValue.includes('=')
      ? rawValue.split(/=(.*)/s, 2)
      : [rawValue, undefined];
    const next = inlineValue ?? argv[index + 1];
    const consumedNext = inlineValue === undefined;
    switch (value) {
      case '--mode':
        if (next === 'target_display' || next === 'foreground_window') {
          defaults.mode = next;
        }
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--duration':
        defaults.durationSeconds = Number.parseInt(next ?? '', 10) || defaults.durationSeconds;
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--segment-duration':
        defaults.segmentDurationSeconds =
          Number.parseInt(next ?? '', 10) || defaults.segmentDurationSeconds;
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--recording-window':
        defaults.recordingWindowSeconds =
          Number.parseInt(next ?? '', 10) || defaults.recordingWindowSeconds;
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--output-root':
        defaults.outputRoot = path.resolve(next ?? defaults.outputRoot);
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--sample-interval':
        defaults.sampleIntervalMs =
          Number.parseInt(next ?? '', 10) || defaults.sampleIntervalMs;
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--profiles':
        defaults.profiles = parseList(
          next,
          ['efficiency', 'balanced', 'smooth'] as const,
          defaults.profiles,
        );
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--encoders':
        defaults.encoders = parseList(
          next,
          ['auto', 'hardware', 'software'] as const,
          defaults.encoders,
        );
        if (consumedNext) {
          index += 1;
        }
        break;
      case '--keep-artifacts':
        defaults.keepArtifacts = true;
        break;
      default:
        break;
    }
  }

  return defaults;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ensureNoActiveSession(): void {
  const active = getActiveTestSession();
  if (!active) {
    return;
  }
  console.log(`[encoding-benchmark] stopping stale active session ${active.sessionId}`);
  stopTestSession();
}

function getProcessSampleRows(rootPid: number): ProcessSampleRow[] {
  const script = `
$rootId = ${rootPid}
$rows = @()
$root = Get-Process -Id $rootId -ErrorAction SilentlyContinue
if ($root) {
  $rootCpu = 0
  if ($null -ne $root.CPU) { $rootCpu = [double]$root.CPU }
  $rootWorkingSet = 0
  if ($null -ne $root.WorkingSet64) { $rootWorkingSet = [int64]$root.WorkingSet64 }
  $rootPrivate = 0
  if ($null -ne $root.PrivateMemorySize64) { $rootPrivate = [int64]$root.PrivateMemorySize64 }
  $rows += [pscustomobject]@{
    pid = $root.Id
    name = $root.ProcessName
    cpuSeconds = $rootCpu
    workingSetBytes = $rootWorkingSet
    privateBytes = $rootPrivate
  }
}
$ffmpegIds = @(
  Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ParentProcessId -eq $rootId } |
    Select-Object -ExpandProperty ProcessId
)
if ($ffmpegIds.Count -gt 0) {
  Get-Process -Id $ffmpegIds -ErrorAction SilentlyContinue | ForEach-Object {
    $rowCpu = 0
    if ($null -ne $_.CPU) { $rowCpu = [double]$_.CPU }
    $rowWorkingSet = 0
    if ($null -ne $_.WorkingSet64) { $rowWorkingSet = [int64]$_.WorkingSet64 }
    $rowPrivate = 0
    if ($null -ne $_.PrivateMemorySize64) { $rowPrivate = [int64]$_.PrivateMemorySize64 }
    $rows += [pscustomobject]@{
      pid = $_.Id
      name = $_.ProcessName
      cpuSeconds = $rowCpu
      workingSetBytes = $rowWorkingSet
      privateBytes = $rowPrivate
    }
  }
}
$rows | ConvertTo-Json -Compress
`;
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' },
  ).trim();
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output) as ProcessSampleRow | ProcessSampleRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function captureResourceSample(rootPid: number): ResourceSample {
  const rows = getProcessSampleRows(rootPid);
  const node = rows.find((row) => row.pid === rootPid) ?? null;
  const ffmpeg = rows.filter((row) => row.pid !== rootPid);
  return {
    capturedAtMs: Date.now(),
    node,
    ffmpeg,
  };
}

function sumCpuSeconds(sample: ResourceSample): number {
  const ffmpegCpu = sample.ffmpeg.reduce((sum, row) => sum + row.cpuSeconds, 0);
  return (sample.node?.cpuSeconds ?? 0) + ffmpegCpu;
}

function sumWorkingSetMb(sample: ResourceSample): number {
  const ffmpegBytes = sample.ffmpeg.reduce((sum, row) => sum + row.workingSetBytes, 0);
  return ((sample.node?.workingSetBytes ?? 0) + ffmpegBytes) / (1024 * 1024);
}

function ffmpegWorkingSetMb(sample: ResourceSample): number {
  return sample.ffmpeg.reduce((sum, row) => sum + row.workingSetBytes, 0) / (1024 * 1024);
}

function computeResourceSummary(samples: ResourceSample[]): {
  sampleCount: number;
  avgCombinedCpuPercent: number;
  peakCombinedCpuPercent: number;
  avgCombinedWorkingSetMb: number;
  peakCombinedWorkingSetMb: number;
  avgFfmpegWorkingSetMb: number;
  peakFfmpegWorkingSetMb: number;
} {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      avgCombinedCpuPercent: 0,
      peakCombinedCpuPercent: 0,
      avgCombinedWorkingSetMb: 0,
      peakCombinedWorkingSetMb: 0,
      avgFfmpegWorkingSetMb: 0,
      peakFfmpegWorkingSetMb: 0,
    };
  }

  const logicalCpuCount = Math.max(1, cpus().length);
  const cpuPercents: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedSeconds = Math.max(0.001, (current.capturedAtMs - previous.capturedAtMs) / 1000);
    const cpuDelta = Math.max(0, sumCpuSeconds(current) - sumCpuSeconds(previous));
    cpuPercents.push((cpuDelta / elapsedSeconds / logicalCpuCount) * 100);
  }

  const combinedWorkingSet = samples.map(sumWorkingSetMb);
  const ffmpegWorkingSet = samples.map(ffmpegWorkingSetMb);
  const avg = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    sampleCount: samples.length,
    avgCombinedCpuPercent: round(avg(cpuPercents)),
    peakCombinedCpuPercent: round(cpuPercents.length === 0 ? 0 : Math.max(...cpuPercents)),
    avgCombinedWorkingSetMb: round(avg(combinedWorkingSet)),
    peakCombinedWorkingSetMb: round(Math.max(...combinedWorkingSet)),
    avgFfmpegWorkingSetMb: round(avg(ffmpegWorkingSet)),
    peakFfmpegWorkingSetMb: round(Math.max(...ffmpegWorkingSet)),
  };
}

function diffMetrics(before: ReqCaseShadowRecorderMetrics, after: ReqCaseShadowRecorderMetrics) {
  return {
    capturedStepsTotal: Math.max(0, after.capturedStepsTotal - before.capturedStepsTotal),
    droppedStepsTotal: Math.max(0, after.droppedStepsTotal - before.droppedStepsTotal),
    captureQueueDropTotal: Math.max(
      0,
      (after.captureQueueDropTotal ?? 0) - (before.captureQueueDropTotal ?? 0),
    ),
    encodeQueueDropTotal: Math.max(
      0,
      (after.encodeQueueDropTotal ?? 0) - (before.encodeQueueDropTotal ?? 0),
    ),
    inputChannelFullDropTotal: Math.max(
      0,
      after.inputChannelFullDropTotal - before.inputChannelFullDropTotal,
    ),
    pushDispatchDropTotal: Math.max(
      0,
      after.pushDispatchDropTotal - before.pushDispatchDropTotal,
    ),
    dirtyRegionFrameTotal: Math.max(
      0,
      (after.dirtyRegionFrameTotal ?? 0) - (before.dirtyRegionFrameTotal ?? 0),
    ),
    dirtyRegionEmptyFrameTotal: Math.max(
      0,
      (after.dirtyRegionEmptyFrameTotal ?? 0) - (before.dirtyRegionEmptyFrameTotal ?? 0),
    ),
    dirtyRegionCoverageAvg: after.dirtyRegionCoverageAvg ?? 0,
  };
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return round(sorted[index]);
}

function getEncoderMatrix(encoder: string): HardwareMatrixRow['matrix'] | undefined {
  if (encoder.includes('nvenc')) {
    return 'NVIDIA';
  }
  if (encoder.includes('qsv')) {
    return 'Intel';
  }
  if (encoder.includes('amf')) {
    return 'AMD';
  }
  if (encoder.includes('libx264')) {
    return 'RDP';
  }
  return undefined;
}

function buildHardwareMatrixRows(scenarios: ScenarioResult[]): HardwareMatrixRow[] {
  const matrixTargets: Array<{ matrix: HardwareMatrixRow['matrix']; encoder: string; profile: EncoderPreference }> = [
    { matrix: 'NVIDIA', encoder: 'h264_nvenc', profile: 'hardware' },
    { matrix: 'Intel', encoder: 'h264_qsv', profile: 'hardware' },
    { matrix: 'AMD', encoder: 'h264_amf', profile: 'hardware' },
    { matrix: 'RDP', encoder: 'libx264', profile: 'software' },
  ];

  return matrixTargets.map((target) => {
    const matching = scenarios.find((scenario) =>
      scenario.encoderPreference === target.profile
      && scenario.selectedEncoders.some((encoder) => getEncoderMatrix(encoder) === target.matrix),
    );
    if (!matching) {
      return {
        matrix: target.matrix,
        profile: target.profile,
        encoder: target.encoder,
        captureP95: 0,
        encodeP95: 0,
        dropTotal: 0,
        fileSize: 0,
        result: 'Skipped',
        notes: 'No matching hardware result in this run',
      };
    }

    const dropTotal = matching.metricsDelta.droppedStepsTotal
      + matching.metricsDelta.captureQueueDropTotal
      + matching.metricsDelta.encodeQueueDropTotal;
    return {
      matrix: target.matrix,
      profile: matching.encoderPreference,
      encoder: target.encoder,
      captureP95: matching.captureP95Ms,
      encodeP95: matching.encodeP95Ms,
      dropTotal,
      fileSize: matching.totalSegmentBytes,
      result: matching.warningCount === 0 && matching.playableSegmentCount > 0 ? 'Passed' : 'Failed',
      notes: matching.selectedEncoders.join(', ') || 'unknown',
    };
  });
}

function buildMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# 编码专项 Benchmark');
  lines.push('');
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push(`- 模式: ${report.options.mode}`);
  lines.push(
    `- 录制参数: duration=${report.options.durationSeconds}s, segment=${report.options.segmentDurationSeconds}s, window=${report.options.recordingWindowSeconds}s`,
  );
  lines.push(
    `- 采样间隔: ${report.options.sampleIntervalMs}ms`,
  );
  lines.push('');
  lines.push('| 场景 | 实际编码器 | 可播片段 | 总时长(s) | 平均CPU(%) | 峰值CPU(%) | 平均内存(MB) | 峰值内存(MB) | 告警 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.recordingProfile}/${scenario.encoderPreference} | ${scenario.selectedEncoders.join(', ') || 'unknown'} | ${scenario.playableSegmentCount}/${scenario.segmentCount} | ${round(scenario.totalPlayableDurationMs / 1000, 1)} | ${scenario.avgCombinedCpuPercent} | ${scenario.peakCombinedCpuPercent} | ${scenario.avgCombinedWorkingSetMb} | ${scenario.peakCombinedWorkingSetMb} | ${scenario.warningCount} |`,
    );
  }
  lines.push('');
  lines.push('| Matrix | Profile | Encoder | Capture P95 | Encode P95 | Drop Total | File Size | Result | Notes |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const row of buildHardwareMatrixRows(report.scenarios)) {
    lines.push(`| ${row.matrix} | ${row.profile} | ${row.encoder} | ${row.captureP95} | ${row.encodeP95} | ${row.dropTotal} | ${row.fileSize} | ${row.result} | ${row.notes} |`);
  }
  lines.push('');
  lines.push('## 详细结果');
  lines.push('');
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.scenarioId}`);
    lines.push('');
    lines.push(`- Session: ${scenario.sessionId}`);
    lines.push(`- 实际编码器: ${scenario.selectedEncoders.join(', ') || 'unknown'}`);
    lines.push(`- 实际 codec: ${scenario.selectedCodecs.join(', ') || 'unknown'}`);
    lines.push(`- 可播片段: ${scenario.playableSegmentCount}/${scenario.segmentCount}`);
    lines.push(`- 总可播时长: ${round(scenario.totalPlayableDurationMs / 1000, 1)}s`);
    lines.push(`- 平均 CPU: ${scenario.avgCombinedCpuPercent}%`);
    lines.push(`- 峰值 CPU: ${scenario.peakCombinedCpuPercent}%`);
    lines.push(`- 平均内存: ${scenario.avgCombinedWorkingSetMb} MB`);
    lines.push(`- 峰值内存: ${scenario.peakCombinedWorkingSetMb} MB`);
    lines.push(`- 指标增量: captured=${scenario.metricsDelta.capturedStepsTotal}, dropped=${scenario.metricsDelta.droppedStepsTotal}, captureQueueDrop=${scenario.metricsDelta.captureQueueDropTotal}, encodeQueueDrop=${scenario.metricsDelta.encodeQueueDropTotal}`);
    lines.push(`- Dirty region frames: ${scenario.metricsDelta.dirtyRegionFrameTotal}, empty frames: ${scenario.metricsDelta.dirtyRegionEmptyFrameTotal}, average coverage: ${scenario.metricsDelta.dirtyRegionCoverageAvg}`);
    if (scenario.warnings.length > 0) {
      lines.push(`- 告警: ${scenario.warnings.join(' | ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function runScenario(
  options: CliOptions,
  outputRoot: string,
  mode: CaptureMode,
  recordingProfile: RecordingProfile,
  encoderPreference: EncoderPreference,
): Promise<ScenarioResult> {
  ensureNoActiveSession();

  const scenarioId = `${recordingProfile}-${encoderPreference}-${Date.now()}`;
  const smokeRoot = path.resolve(outputRoot, scenarioId);
  mkdirSync(smokeRoot, { recursive: true });

  const metricsBefore = getRecorderMetrics();
  const session = startTestSession({
    name: `encoding-benchmark ${scenarioId}`,
    storageDir: smokeRoot,
    targetCaptureMode: mode,
    bufferWindowSeconds: options.recordingWindowSeconds,
    segmentDurationSeconds: options.segmentDurationSeconds,
    recordingProfile,
    encoderPreference,
  });

  console.log(
    `[encoding-benchmark] started session=${session.sessionId} profile=${recordingProfile} encoder=${encoderPreference} mode=${mode}`,
  );

  const samples: ResourceSample[] = [captureResourceSample(process.pid)];
  const startedAt = Date.now();
  let elapsedSeconds = 0;
  while (elapsedSeconds < options.durationSeconds) {
    await sleep(options.sampleIntervalMs);
    samples.push(captureResourceSample(process.pid));
    elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    console.log(
      `[encoding-benchmark] ${scenarioId} elapsed=${elapsedSeconds}s/${options.durationSeconds}s`,
    );
  }

  const stopped = stopTestSession();
  const samplesAfterStop = captureResourceSample(process.pid);
  samples.push(samplesAfterStop);
  console.log(`[encoding-benchmark] stopped session=${stopped.sessionId}`);

  const streams = getTestSessionVideoStreams(stopped.sessionId);
  const segments = getTestSessionVideoSegments(stopped.sessionId, undefined, 512);
  const events = getTestSessionEvents(stopped.sessionId, 2048);
  const metricsAfter = getRecorderMetrics();

  const playableSegments = segments.filter((segment) => segment.isPlayable);
  const totalPlayableDurationMs = playableSegments.reduce(
    (sum, segment) => sum + segment.durationMs,
    0,
  );
  const warningMessages = [
    ...streams
      .map((stream) => stream.lastWarning)
      .filter((warning): warning is string => Boolean(warning)),
    ...events
      .filter((event) => event.logLevel === 'warn' || event.logLevel === 'error')
      .map((event) => event.message || event.title || event.eventType),
  ];

  assert.ok(streams.length >= 1, 'expected at least one video stream');
  assert.ok(playableSegments.length >= 1, 'expected at least one playable video segment');

  const resourceSummary = computeResourceSummary(samples);
  const selectedEncoders = Array.from(
    new Set(
      segments
        .map((segment) => segment.encoderName)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const selectedCodecs = Array.from(
    new Set(
      segments
        .map((segment) => segment.codec)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const captureP95Ms = percentile(
    events
      .map((event) => event.captureLatencyMs)
      .filter((value): value is number => typeof value === 'number'),
    95,
  );
  const encodeP95Ms = percentile(
    events
      .map((event) => event.encodeLatencyMs)
      .filter((value): value is number => typeof value === 'number'),
    95,
  );
  const totalSegmentBytes = playableSegments.reduce(
    (sum, segment) => sum + (segment.sizeBytes ?? 0),
    0,
  );

  const result: ScenarioResult = {
    scenarioId,
    mode,
    recordingProfile,
    encoderPreference,
    durationSeconds: options.durationSeconds,
    sampleCount: resourceSummary.sampleCount,
    sessionId: stopped.sessionId,
    smokeRoot,
    streamCount: streams.length,
    segmentCount: segments.length,
    playableSegmentCount: playableSegments.length,
    totalPlayableDurationMs,
    eventCount: events.length,
    warningCount: warningMessages.length,
    selectedEncoders,
    selectedCodecs,
    captureP95Ms,
    encodeP95Ms,
    totalSegmentBytes,
    avgCombinedCpuPercent: resourceSummary.avgCombinedCpuPercent,
    peakCombinedCpuPercent: resourceSummary.peakCombinedCpuPercent,
    avgCombinedWorkingSetMb: resourceSummary.avgCombinedWorkingSetMb,
    peakCombinedWorkingSetMb: resourceSummary.peakCombinedWorkingSetMb,
    avgFfmpegWorkingSetMb: resourceSummary.avgFfmpegWorkingSetMb,
    peakFfmpegWorkingSetMb: resourceSummary.peakFfmpegWorkingSetMb,
    metricsDelta: diffMetrics(metricsBefore, metricsAfter),
    warnings: warningMessages,
  };

  if (!options.keepArtifacts) {
    rmSync(smokeRoot, { recursive: true, force: true });
  }

  return result;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  configureBundledFfmpegEnv();
  mkdirSync(options.outputRoot, { recursive: true });
  ensureNoActiveSession();

  const scenarios: ScenarioResult[] = [];
  for (const recordingProfile of options.profiles) {
    for (const encoderPreference of options.encoders) {
      const result = await runScenario(
        options,
        options.outputRoot,
        options.mode,
        recordingProfile,
        encoderPreference,
      );
      scenarios.push(result);
      console.log(`[encoding-benchmark] summary ${JSON.stringify(result, null, 2)}`);
      await sleep(1000);
    }
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    options,
    scenarios,
  };
  const reportRoot = path.resolve(options.outputRoot, `report-${Date.now()}`);
  mkdirSync(reportRoot, { recursive: true });
  const jsonPath = path.resolve(reportRoot, 'encoding-benchmark.json');
  const markdownPath = path.resolve(reportRoot, 'encoding-benchmark.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(markdownPath, buildMarkdownReport(report), 'utf8');

  console.log(`[encoding-benchmark] wrote ${jsonPath}`);
  console.log(`[encoding-benchmark] wrote ${markdownPath}`);
}

void run().catch((error) => {
  console.error('[encoding-benchmark] FAIL', error);
  process.exitCode = 1;
});
