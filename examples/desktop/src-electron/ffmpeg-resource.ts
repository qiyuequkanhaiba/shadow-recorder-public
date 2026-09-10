import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

export const REQCASE_FFMPEG_ENV_VAR = 'REQCASE_SHADOWRECORDER_FFMPEG_PATH';
export const BUNDLED_FFMPEG_VERSION = '9.0-essentials';
export const BUNDLED_FFMPEG_DOWNLOAD_URL =
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
export const BUNDLED_FFMPEG_SHA256_URL = `${BUNDLED_FFMPEG_DOWNLOAD_URL}.sha256`;
export const BUNDLED_FFMPEG_GITHUB_MIRROR_DOWNLOAD_URL =
  'https://github.com/GyanD/codexffmpeg/releases/download/9.0/ffmpeg-9.0-essentials_build.zip';
export const BUNDLED_FFMPEG_GITHUB_MIRROR_SHA256 =
  'E6B54767A6065919048F1A098EB27211CA4E12B4348A05D88777A5855D0B6E71';
export const MIN_SUPPORTED_FFMPEG_MAJOR = 4;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export type FfmpegExecutableInfo = {
  path: string;
  exists: boolean;
  version: string | null;
  majorVersion: number | null;
  supported: boolean;
  reason: string;
};

export type BundledFfmpegStageResult = {
  source: string;
  destination: string;
  copied: boolean;
  downloaded: boolean;
  executableInfo: FfmpegExecutableInfo;
};

type FfmpegDownloadSource = {
  label: string;
  url: string;
  expectedArchiveHash: string;
};

export function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const cargoToml = path.join(current, 'Cargo.toml');
    const srcDir = path.join(current, 'src');
    if (existsSync(cargoToml) && existsSync(srcDir)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => path.resolve(value)),
    ),
  );
}

export function resolveDesktopRoot(startDir: string = __dirname): string {
  const repoRoot = findRepoRoot(startDir) ?? findRepoRoot(process.cwd());
  if (repoRoot) {
    return path.join(repoRoot, 'examples', 'desktop');
  }
  return path.resolve(startDir, '..');
}

export function resolveBundledFfmpegOutputPath(startDir: string = __dirname): string {
  return path.join(resolveDesktopRoot(startDir), 'build-resources', 'ffmpeg', 'bin', 'ffmpeg.exe');
}

export function resolveToolsFfmpegPath(startDir: string = __dirname): string {
  const repoRoot = findRepoRoot(startDir) ?? findRepoRoot(process.cwd());
  if (repoRoot) {
    return path.join(repoRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  }
  return path.resolve(startDir, '..', '..', '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
}

function resolveToolsFfmpegCacheZipPath(startDir: string = __dirname): string {
  const repoRoot = findRepoRoot(startDir) ?? findRepoRoot(process.cwd());
  const toolsRoot = repoRoot
    ? path.join(repoRoot, 'tools', 'ffmpeg')
    : path.resolve(startDir, '..', '..', '..', 'tools', 'ffmpeg');
  return path.join(toolsRoot, 'cache', `${BUNDLED_FFMPEG_VERSION}.zip`);
}

function resolveToolsFfmpegExtractDir(startDir: string = __dirname): string {
  const repoRoot = findRepoRoot(startDir) ?? findRepoRoot(process.cwd());
  const toolsRoot = repoRoot
    ? path.join(repoRoot, 'tools', 'ffmpeg')
    : path.resolve(startDir, '..', '..', '..', 'tools', 'ffmpeg');
  return path.join(toolsRoot, 'extract', BUNDLED_FFMPEG_VERSION);
}

function parseFfmpegVersion(output: string): { version: string | null; majorVersion: number | null } {
  const match = output.match(/ffmpeg version\s+([^\s]+)/i);
  const version = match?.[1] ?? null;
  if (!version) {
    return { version: null, majorVersion: null };
  }

  const majorMatch = version.match(/(\d+)/);
  const majorVersion = majorMatch ? Number.parseInt(majorMatch[1], 10) : null;
  return {
    version,
    majorVersion: Number.isFinite(majorVersion) ? majorVersion : null,
  };
}

function probeFfmpegHelpTopic(
  ffmpegPath: string,
  topicType: 'demuxer' | 'muxer',
  topicName: string,
): { ok: boolean; output: string } {
  try {
    const output = execFileSync(ffmpegPath, ['-h', `${topicType}=${topicName}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    return { ok: true, output };
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: Buffer | string }).stderr ?? '')
        : '';
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: Buffer | string }).stdout ?? '')
        : '';
    return { ok: false, output: `${stdout}\n${stderr}`.trim() };
  }
}

function validateFfmpegCapabilities(ffmpegPath: string): { ok: boolean; reason: string } {
  const gdigrabProbe = probeFfmpegHelpTopic(ffmpegPath, 'demuxer', 'gdigrab');
  if (!gdigrabProbe.ok || !/Demuxer\s+gdigrab/i.test(gdigrabProbe.output)) {
    return { ok: false, reason: 'missing-gdigrab-demuxer' };
  }

  const segmentProbe = probeFfmpegHelpTopic(ffmpegPath, 'muxer', 'segment');
  if (!segmentProbe.ok || !/Muxer\s+segment/i.test(segmentProbe.output)) {
    return { ok: false, reason: 'missing-segment-muxer' };
  }

  return { ok: true, reason: 'capabilities-ok' };
}

export function inspectFfmpegExecutable(ffmpegPath: string): FfmpegExecutableInfo {
  const resolvedPath = path.resolve(ffmpegPath);
  if (!existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      exists: false,
      version: null,
      majorVersion: null,
      supported: false,
      reason: 'missing',
    };
  }

  try {
    const output = execFileSync(resolvedPath, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    const { version, majorVersion } = parseFfmpegVersion(output);
    if (majorVersion === null) {
      return {
        path: resolvedPath,
        exists: true,
        version,
        majorVersion: null,
        supported: false,
        reason: 'unrecognized-version',
      };
    }
    if (majorVersion < MIN_SUPPORTED_FFMPEG_MAJOR) {
      return {
        path: resolvedPath,
        exists: true,
        version,
        majorVersion,
        supported: false,
        reason: `ffmpeg-major-${majorVersion}-too-old`,
      };
    }
    const capabilityCheck = validateFfmpegCapabilities(resolvedPath);
    if (!capabilityCheck.ok) {
      return {
        path: resolvedPath,
        exists: true,
        version,
        majorVersion,
        supported: false,
        reason: capabilityCheck.reason,
      };
    }
    return {
      path: resolvedPath,
      exists: true,
      version,
      majorVersion,
      supported: true,
      reason: 'supported',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: resolvedPath,
      exists: true,
      version: null,
      majorVersion: null,
      supported: false,
      reason: `probe-failed:${message}`,
    };
  }
}

function findSupportedFfmpegExecutable(
  candidates: Array<string | null | undefined>,
): FfmpegExecutableInfo | null {
  for (const candidate of uniquePaths(candidates)) {
    const info = inspectFfmpegExecutable(candidate);
    if (info.supported) {
      return info;
    }
  }
  return null;
}

export function resolveBundledFfmpegPath(startDir: string = __dirname): string | null {
  const desktopRoot = resolveDesktopRoot(startDir);
  const configured = process.env[REQCASE_FFMPEG_ENV_VAR];

  const supported = findSupportedFfmpegExecutable([
    configured,
    process.resourcesPath
      ? path.join(process.resourcesPath, 'ffmpeg', 'bin', 'ffmpeg.exe')
      : null,
    resolveToolsFfmpegPath(startDir),
    path.join(desktopRoot, 'build-resources', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ]);
  return supported?.path ?? null;
}

export function configureBundledFfmpegEnv(startDir: string = __dirname): string | null {
  const resolved = resolveBundledFfmpegPath(startDir);
  if (!resolved) {
    return null;
  }
  process.env[REQCASE_FFMPEG_ENV_VAR] = resolved;
  return resolved;
}

export function resolveFfmpegSourceForBundling(startDir: string = __dirname): string | null {
  const configured = process.env[REQCASE_FFMPEG_ENV_VAR];
  const supported = findSupportedFfmpegExecutable([
    configured,
    resolveToolsFfmpegPath(startDir),
    resolveBundledFfmpegOutputPath(startDir),
  ]);
  return supported?.path ?? null;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest('hex').toUpperCase();
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

async function downloadText(url: string): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const guardedResponse = await fetch(url, { signal: abortController.signal });
    if (!guardedResponse.ok) {
      throw new Error(`download failed: ${guardedResponse.status} ${guardedResponse.statusText}`);
    }
    return await guardedResponse.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadFile(url: string, destination: string): Promise<Buffer> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const guardedResponse = await fetch(url, { signal: abortController.signal });
    if (!guardedResponse.ok || !guardedResponse.body) {
      throw new Error(`download failed: ${guardedResponse.status} ${guardedResponse.statusText}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    rmSync(destination, { force: true });
    const archiveBuffer = Buffer.from(await guardedResponse.arrayBuffer());
    writeFileSync(destination, archiveBuffer);
    return archiveBuffer;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSha256(text: string): string {
  const match = text.match(/[a-fA-F0-9]{64}/);
  if (!match) {
    throw new Error('Downloaded ffmpeg checksum file did not contain a SHA256 hash.');
  }
  return match[0].toUpperCase();
}

async function resolveBundledFfmpegDownloadSources(): Promise<FfmpegDownloadSource[]> {
  const githubMirror = {
    label: 'gyan-github-mirror',
    url: BUNDLED_FFMPEG_GITHUB_MIRROR_DOWNLOAD_URL,
    expectedArchiveHash: BUNDLED_FFMPEG_GITHUB_MIRROR_SHA256,
  };

  try {
    return [
      {
        label: 'gyan-primary',
        url: BUNDLED_FFMPEG_DOWNLOAD_URL,
        expectedArchiveHash: parseSha256(await downloadText(BUNDLED_FFMPEG_SHA256_URL)),
      },
      githubMirror,
    ];
  } catch (error) {
    console.warn(`[ffmpeg-resource] failed to read primary ffmpeg checksum; using GitHub mirror: ${error}`);
    return [githubMirror];
  }
}

function findExtractedFfmpegBinary(rootDir: string): string {
  const candidates: string[] = [];

  function walk(currentDir: string, depth: number): void {
    if (depth > 5) {
      return;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') {
        candidates.push(entryPath);
      }
    }
  }

  walk(rootDir, 0);
  const preferred = candidates.find((candidate) =>
    candidate.toLowerCase().includes(`${path.sep}bin${path.sep}`),
  );
  return preferred ?? candidates[0] ?? '';
}

async function extractZipArchive(archivePath: string, destinationDir: string): Promise<void> {
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
    },
  );
}

async function provisionPinnedBundledFfmpeg(startDir: string = __dirname): Promise<FfmpegExecutableInfo> {
  const cachedZip = resolveToolsFfmpegCacheZipPath(startDir);
  const extractDir = resolveToolsFfmpegExtractDir(startDir);
  const toolBinary = resolveToolsFfmpegPath(startDir);

  const existing = inspectFfmpegExecutable(toolBinary);
  if (existing.supported) {
    return existing;
  }

  const downloadSources = await resolveBundledFfmpegDownloadSources();
  let extractedBinary = '';
  let lastProvisionError: unknown = null;
  for (const source of downloadSources) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!existsSync(cachedZip) || attempt > 0) {
          rmSync(cachedZip, { force: true });
          const archiveBuffer = await downloadFile(source.url, cachedZip);
          const downloadedArchiveHash = hashBuffer(archiveBuffer);
          if (downloadedArchiveHash !== source.expectedArchiveHash) {
            throw new Error(
              `Downloaded ffmpeg archive checksum mismatch from ${source.label}. Expected ${source.expectedArchiveHash}, got ${downloadedArchiveHash}.`,
            );
          }
        } else {
          const cachedArchiveHash = await hashFile(cachedZip);
          if (cachedArchiveHash !== source.expectedArchiveHash) {
            throw new Error(
              `Cached ffmpeg archive checksum mismatch for ${source.label}. Expected ${source.expectedArchiveHash}, got ${cachedArchiveHash}.`,
            );
          }
        }

        await extractZipArchive(cachedZip, extractDir);
        extractedBinary = findExtractedFfmpegBinary(extractDir);
        if (!existsSync(extractedBinary)) {
          throw new Error(`Downloaded archive from ${source.label} does not contain ffmpeg.exe.`);
        }
        break;
      } catch (error) {
        lastProvisionError = error;
        rmSync(cachedZip, { force: true });
      }
    }

    if (extractedBinary) {
      break;
    }
  }

  if (!extractedBinary) {
    throw lastProvisionError ?? new Error('Unable to provision bundled ffmpeg.exe.');
  }

  await mkdir(path.dirname(toolBinary), { recursive: true });
  copyFileSync(extractedBinary, toolBinary);

  const provisioned = inspectFfmpegExecutable(toolBinary);
  if (!provisioned.supported) {
    throw new Error(`Provisioned ffmpeg.exe is still unsupported: ${provisioned.reason}`);
  }

  return provisioned;
}

export async function stageBundledFfmpeg(
  startDir: string = __dirname,
  options: { allowDownload?: boolean } = {},
): Promise<BundledFfmpegStageResult | null> {
  const allowDownload = options.allowDownload ?? false;
  let source = resolveFfmpegSourceForBundling(startDir);

  let downloaded = false;
  if (!source && allowDownload) {
    const provisioned = await provisionPinnedBundledFfmpeg(startDir);
    source = provisioned.path;
    downloaded = true;
  }

  if (!source) {
    return null;
  }

  const executableInfo = inspectFfmpegExecutable(source);
  if (!executableInfo.supported) {
    return null;
  }

  const destination = resolveBundledFfmpegOutputPath(startDir);
  if (path.resolve(source) === path.resolve(destination)) {
    return { source, destination, copied: false, downloaded, executableInfo };
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { source, destination, copied: true, downloaded, executableInfo };
}
