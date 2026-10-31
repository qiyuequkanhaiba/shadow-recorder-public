export const MIN_FREE_BYTES_TO_START = 2 * 1024 * 1024 * 1024;
export const MIN_FREE_BYTES_WHILE_RECORDING = 1024 * 1024 * 1024;
// One GetDiskFreeSpaceExW call costs microseconds. A short interval keeps the
// 1 GiB stop margin from being eaten between two checks.
export const DISK_CHECK_INTERVAL_MS = 5_000;
export const DISK_RECORDING_STOPPED_MESSAGE = '磁盘剩余空间不足，录制已停止';

export function canStartRecording(freeBytes: number, minFreeBytes: number): boolean {
  return Number.isFinite(freeBytes) && Number.isFinite(minFreeBytes) && freeBytes >= minFreeBytes;
}

export function shouldStopForDisk(freeBytes: number, minFreeBytes: number): boolean {
  return Number.isFinite(freeBytes) && Number.isFinite(minFreeBytes) && freeBytes < minFreeBytes;
}

export function estimatedExportBytes(sourceBytes: number): number {
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) {
    return 0;
  }
  return Math.floor((sourceBytes * 6) / 5);
}

export function canExport(freeBytes: number, sourceBytes: number): boolean {
  return Number.isFinite(freeBytes) && freeBytes >= estimatedExportBytes(sourceBytes);
}

export function bytesToGiB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 0;
  }
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

export function giBToBytes(gib: number, fallback: number): number {
  if (!Number.isFinite(gib) || gib < 0) {
    return fallback;
  }
  return Math.round(gib * 1024 * 1024 * 1024);
}
