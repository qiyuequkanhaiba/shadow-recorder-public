import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import path from 'node:path';

type CaptureBackend = 'auto' | 'wgc' | 'dxgi';
type InputMode = 'auto' | 'hook' | 'raw_input';
type TransportMode = 'poll' | 'push';
type DeltaMode = 'none' | 'hash_dedup' | 'dirty_rect';

interface CliOptions {
  outputRoot: string;
  captureBackend: CaptureBackend;
  inputMode: InputMode;
  transportMode: TransportMode;
  deltaMode: DeltaMode;
  captureLatencyP50Ms: number;
  captureLatencyP95Ms: number;
  encodeLatencyP50Ms: number;
  encodeLatencyP95Ms: number;
  droppedStepsTotal: number;
  captureQueueDropTotal: number;
  encodeQueueDropTotal: number;
  maxRssMb: number;
}

interface PerformanceBaselineReport {
  version: 1;
  createdAt: string;
  gitCommit: string;
  host: {
    os: string;
    arch: string;
    cpu: string;
    gpu: string;
    memoryMb: number;
  };
  native: {
    captureBackend: CaptureBackend;
    inputMode: InputMode;
    transportMode: TransportMode;
    deltaMode: DeltaMode;
  };
  metrics: {
    captureLatencyP50Ms: number;
    captureLatencyP95Ms: number;
    encodeLatencyP50Ms: number;
    encodeLatencyP95Ms: number;
    droppedStepsTotal: number;
    captureQueueDropTotal: number;
    encodeQueueDropTotal: number;
    maxRssMb: number;
  };
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outputRoot: path.resolve(process.cwd(), '.ci-artifacts', 'performance-baseline'),
    captureBackend: 'auto',
    inputMode: 'auto',
    transportMode: 'poll',
    deltaMode: 'none',
    captureLatencyP50Ms: 0,
    captureLatencyP95Ms: 0,
    encodeLatencyP50Ms: 0,
    encodeLatencyP95Ms: 0,
    droppedStepsTotal: 0,
    captureQueueDropTotal: 0,
    encodeQueueDropTotal: 0,
    maxRssMb: 0,
  };
  const positionalArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    switch (value) {
      case '--output-root':
        options.outputRoot = path.resolve(next ?? options.outputRoot);
        index += 1;
        break;
      case '--capture-backend':
        options.captureBackend = parseEnum(next, ['auto', 'wgc', 'dxgi'] as const, options.captureBackend);
        index += 1;
        break;
      case '--input-mode':
        options.inputMode = parseEnum(next, ['auto', 'hook', 'raw_input'] as const, options.inputMode);
        index += 1;
        break;
      case '--transport-mode':
        options.transportMode = parseEnum(next, ['poll', 'push'] as const, options.transportMode);
        index += 1;
        break;
      case '--delta-mode':
        options.deltaMode = parseEnum(next, ['none', 'hash_dedup', 'dirty_rect'] as const, options.deltaMode);
        index += 1;
        break;
      case '--capture-p50':
        options.captureLatencyP50Ms = readNumber(next, options.captureLatencyP50Ms);
        index += 1;
        break;
      case '--capture-p95':
        options.captureLatencyP95Ms = readNumber(next, options.captureLatencyP95Ms);
        index += 1;
        break;
      case '--encode-p50':
        options.encodeLatencyP50Ms = readNumber(next, options.encodeLatencyP50Ms);
        index += 1;
        break;
      case '--encode-p95':
        options.encodeLatencyP95Ms = readNumber(next, options.encodeLatencyP95Ms);
        index += 1;
        break;
      case '--dropped-steps':
        options.droppedStepsTotal = readNumber(next, options.droppedStepsTotal);
        index += 1;
        break;
      case '--capture-drops':
        options.captureQueueDropTotal = readNumber(next, options.captureQueueDropTotal);
        index += 1;
        break;
      case '--encode-drops':
        options.encodeQueueDropTotal = readNumber(next, options.encodeQueueDropTotal);
        index += 1;
        break;
      case '--max-rss':
        options.maxRssMb = readNumber(next, options.maxRssMb);
        index += 1;
        break;
      default:
        if (!value.startsWith('--')) {
          positionalArgs.push(value);
        }
        break;
    }
  }

  if (positionalArgs.length > 0) {
    const [
      outputRoot,
      captureBackend,
      inputMode,
      transportMode,
      deltaMode,
      captureLatencyP50Ms,
      captureLatencyP95Ms,
      encodeLatencyP50Ms,
      encodeLatencyP95Ms,
      droppedStepsTotal,
      captureQueueDropTotal,
      encodeQueueDropTotal,
      maxRssMb,
    ] = positionalArgs;

    options.outputRoot = outputRoot ? path.resolve(process.cwd(), outputRoot) : options.outputRoot;
    options.captureBackend = parseEnum(captureBackend, ['auto', 'wgc', 'dxgi'] as const, options.captureBackend);
    options.inputMode = parseEnum(inputMode, ['auto', 'hook', 'raw_input'] as const, options.inputMode);
    options.transportMode = parseEnum(transportMode, ['poll', 'push'] as const, options.transportMode);
    options.deltaMode = parseEnum(deltaMode, ['none', 'hash_dedup', 'dirty_rect'] as const, options.deltaMode);
    options.captureLatencyP50Ms = readNumber(captureLatencyP50Ms, options.captureLatencyP50Ms);
    options.captureLatencyP95Ms = readNumber(captureLatencyP95Ms, options.captureLatencyP95Ms);
    options.encodeLatencyP50Ms = readNumber(encodeLatencyP50Ms, options.encodeLatencyP50Ms);
    options.encodeLatencyP95Ms = readNumber(encodeLatencyP95Ms, options.encodeLatencyP95Ms);
    options.droppedStepsTotal = readNumber(droppedStepsTotal, options.droppedStepsTotal);
    options.captureQueueDropTotal = readNumber(captureQueueDropTotal, options.captureQueueDropTotal);
    options.encodeQueueDropTotal = readNumber(encodeQueueDropTotal, options.encodeQueueDropTotal);
    options.maxRssMb = readNumber(maxRssMb, options.maxRssMb);
  }

  return options;
}

function getGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getGpuSummary(): string {
  if (process.platform !== 'win32') {
    return '';
  }

  try {
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!output) {
      return '';
    }
    const parsed = JSON.parse(output) as string | string[];
    return Array.isArray(parsed) ? parsed.join('; ') : parsed;
  } catch {
    return '';
  }
}

function buildReport(options: CliOptions): PerformanceBaselineReport {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
    host: {
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? '',
      gpu: getGpuSummary(),
      memoryMb: Math.round(totalmem() / 1024 / 1024),
    },
    native: {
      captureBackend: options.captureBackend,
      inputMode: options.inputMode,
      transportMode: options.transportMode,
      deltaMode: options.deltaMode,
    },
    metrics: {
      captureLatencyP50Ms: options.captureLatencyP50Ms,
      captureLatencyP95Ms: options.captureLatencyP95Ms,
      encodeLatencyP50Ms: options.encodeLatencyP50Ms,
      encodeLatencyP95Ms: options.encodeLatencyP95Ms,
      droppedStepsTotal: options.droppedStepsTotal,
      captureQueueDropTotal: options.captureQueueDropTotal,
      encodeQueueDropTotal: options.encodeQueueDropTotal,
      maxRssMb: options.maxRssMb,
    },
  };
}

function buildMarkdown(report: PerformanceBaselineReport): string {
  return [
    '# Shadow Recorder Performance Baseline',
    '',
    '## Environment',
    `- Created at: ${report.createdAt}`,
    `- Git commit: ${report.gitCommit || 'unknown'}`,
    `- OS: ${report.host.os}`,
    `- Arch: ${report.host.arch}`,
    `- CPU: ${report.host.cpu || 'unknown'}`,
    `- GPU: ${report.host.gpu || 'unknown'}`,
    `- Memory: ${report.host.memoryMb} MB`,
    '',
    '## Native Configuration',
    `- Capture backend: ${report.native.captureBackend}`,
    `- Input mode: ${report.native.inputMode}`,
    `- Transport mode: ${report.native.transportMode}`,
    `- Delta mode: ${report.native.deltaMode}`,
    '',
    '## Latency',
    `- Capture latency p50: ${report.metrics.captureLatencyP50Ms} ms`,
    `- Capture latency p95: ${report.metrics.captureLatencyP95Ms} ms`,
    `- Encode latency p50: ${report.metrics.encodeLatencyP50Ms} ms`,
    `- Encode latency p95: ${report.metrics.encodeLatencyP95Ms} ms`,
    '',
    '## Queue Drops',
    `- Dropped steps: ${report.metrics.droppedStepsTotal}`,
    `- Capture queue drops: ${report.metrics.captureQueueDropTotal}`,
    `- Encode queue drops: ${report.metrics.encodeQueueDropTotal}`,
    '',
    '## Memory',
    `- Max RSS: ${report.metrics.maxRssMb} MB`,
    '',
    '## Regression Notes',
    '- Baseline captured for future candidate comparison.',
    '',
  ].join('\n');
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  const reportRoot = path.resolve(options.outputRoot, `report-${Date.now()}`);
  mkdirSync(reportRoot, { recursive: true });

  const jsonPath = path.resolve(reportRoot, 'performance-baseline.json');
  const markdownPath = path.resolve(reportRoot, 'performance-baseline.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(markdownPath, buildMarkdown(report), 'utf8');

  console.log(`[performance-baseline] wrote ${jsonPath}`);
  console.log(`[performance-baseline] wrote ${markdownPath}`);
}

run();
