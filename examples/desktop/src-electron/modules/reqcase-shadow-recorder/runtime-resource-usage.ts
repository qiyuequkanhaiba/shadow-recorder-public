import { execFile } from 'node:child_process';
import { cpus } from 'node:os';

import type { ReqCaseShadowRecorderResourceUsage } from './types';

type ProcessSampleRow = {
  pid: number;
  name: string;
  cpuSeconds: number;
  workingSetBytes: number;
};

type ProcessSampleResult = {
  capturedAtMs: number;
  root: ProcessSampleRow | null;
  ffmpeg: ProcessSampleRow[];
};

const SAMPLE_INTERVAL_MS = 5000;
const COMMAND_TIMEOUT_MS = 1000;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function execPowerShellJson(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function collectProcessSample(rootPid: number): Promise<ProcessSampleResult | null> {
  const command = `
$rootId = ${rootPid}
$rows = @()
$root = Get-Process -Id $rootId -ErrorAction SilentlyContinue
if ($root) {
  $rows += [pscustomobject]@{
    pid = $root.Id
    name = $root.ProcessName
    cpuSeconds = [double]($root.CPU ?? 0)
    workingSetBytes = [int64]($root.WorkingSet64 ?? 0)
  }
}
$ffmpegRows = @()
Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ParentProcessId -eq $rootId } |
  ForEach-Object {
    $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($proc) {
      $ffmpegRows += [pscustomobject]@{
        pid = $proc.Id
        name = $proc.ProcessName
        cpuSeconds = [double]($proc.CPU ?? 0)
        workingSetBytes = [int64]($proc.WorkingSet64 ?? 0)
      }
    }
  }
[pscustomobject]@{
  capturedAtMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  root = if ($rows.Count -gt 0) { $rows[0] } else { $null }
  ffmpeg = $ffmpegRows
} | ConvertTo-Json -Depth 4 -Compress
`.trim();

  try {
    const stdout = await execPowerShellJson(command);
    if (!stdout || !stdout.trim()) {
      return null;
    }
    const parsed = JSON.parse(stdout) as ProcessSampleResult;
    return {
      capturedAtMs: Number(parsed.capturedAtMs) || Date.now(),
      root: parsed.root
        ? {
          pid: Number(parsed.root.pid) || rootPid,
          name: String(parsed.root.name ?? 'electron'),
          cpuSeconds: Number(parsed.root.cpuSeconds) || 0,
          workingSetBytes: Number(parsed.root.workingSetBytes) || 0,
        }
        : null,
      ffmpeg: Array.isArray(parsed.ffmpeg)
        ? parsed.ffmpeg.map((row) => ({
          pid: Number(row.pid) || 0,
          name: String(row.name ?? 'ffmpeg'),
          cpuSeconds: Number(row.cpuSeconds) || 0,
          workingSetBytes: Number(row.workingSetBytes) || 0,
        }))
        : [],
    };
  } catch {
    return null;
  }
}

function sumCpuSeconds(rows: ProcessSampleRow[]): number {
  return rows.reduce((total, row) => total + row.cpuSeconds, 0);
}

function sumWorkingSetMb(rows: ProcessSampleRow[]): number {
  return rows.reduce((total, row) => total + row.workingSetBytes, 0) / (1024 * 1024);
}

export class RecorderResourceUsageMonitor {
  private readonly rootPid = process.pid;
  private readonly logicalCpuCount = Math.max(1, cpus().length);
  private previousSample: ProcessSampleResult | null = null;
  private lastSnapshot: ReqCaseShadowRecorderResourceUsage | null = null;
  private lastSampleRequestedAtMs = 0;
  private pendingSnapshot: Promise<ReqCaseShadowRecorderResourceUsage | null> | null = null;

  public async getSnapshot(recording: boolean): Promise<ReqCaseShadowRecorderResourceUsage | null> {
    if (!recording) {
      this.previousSample = null;
      this.lastSnapshot = null;
      this.lastSampleRequestedAtMs = 0;
      return null;
    }

    const now = Date.now();
    if (
      this.lastSnapshot
      && now - this.lastSampleRequestedAtMs < SAMPLE_INTERVAL_MS
    ) {
      return this.lastSnapshot;
    }

    if (this.pendingSnapshot) {
      return this.pendingSnapshot;
    }

    this.pendingSnapshot = this.collectSnapshot().finally(() => {
      this.pendingSnapshot = null;
    });
    return this.pendingSnapshot;
  }

  private async collectSnapshot(): Promise<ReqCaseShadowRecorderResourceUsage | null> {
    this.lastSampleRequestedAtMs = Date.now();
    const currentSample = await collectProcessSample(this.rootPid);
    if (!currentSample?.root) {
      return this.lastSnapshot;
    }

    const rootRows = [currentSample.root];
    const rootWorkingSetMb = round(sumWorkingSetMb(rootRows));
    const ffmpegWorkingSetMb = round(sumWorkingSetMb(currentSample.ffmpeg));
    const totalWorkingSetMb = round(rootWorkingSetMb + ffmpegWorkingSetMb);

    let sampleWindowMs = 0;
    let rootCpuPercent = 0;
    let ffmpegCpuPercent = 0;

    if (this.previousSample?.root) {
      sampleWindowMs = Math.max(
        0,
        currentSample.capturedAtMs - this.previousSample.capturedAtMs,
      );
      const elapsedSeconds = Math.max(sampleWindowMs / 1000, 0.1);
      rootCpuPercent = round(
        ((sumCpuSeconds(rootRows) - sumCpuSeconds([this.previousSample.root])) / elapsedSeconds / this.logicalCpuCount) * 100,
      );
      ffmpegCpuPercent = round(
        ((sumCpuSeconds(currentSample.ffmpeg) - sumCpuSeconds(this.previousSample.ffmpeg)) / elapsedSeconds / this.logicalCpuCount) * 100,
      );
    }

    const snapshot: ReqCaseShadowRecorderResourceUsage = {
      capturedAtMs: currentSample.capturedAtMs,
      sampleWindowMs,
      rootCpuPercent: Math.max(0, rootCpuPercent),
      ffmpegCpuPercent: Math.max(0, ffmpegCpuPercent),
      totalCpuPercent: round(Math.max(0, rootCpuPercent + ffmpegCpuPercent)),
      rootWorkingSetMb,
      ffmpegWorkingSetMb,
      totalWorkingSetMb,
      ffmpegProcessCount: currentSample.ffmpeg.length,
    };

    this.previousSample = currentSample;
    this.lastSnapshot = snapshot;
    return snapshot;
  }
}
