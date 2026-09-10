import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export type ChecksumEntry = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type ChecksumEntryOptions = {
  includeChecksumManifest?: boolean;
};

export async function createZipArchive(sourceDir: string, destinationZipPath: string): Promise<void> {
  await mkdir(path.dirname(destinationZipPath), { recursive: true });
  await runPowerShellZip(sourceDir, destinationZipPath);
}

export async function buildChecksumEntries(
  rootDir: string,
  options: ChecksumEntryOptions = {},
): Promise<ChecksumEntry[]> {
  const files = await collectFilesRecursive(rootDir);
  const entries = await Promise.all(
    files
      .filter((filePath) => !shouldSkipChecksum(path.basename(filePath), options))
      .map(async (filePath) => {
        const stats = await stat(filePath);
        return {
          relativePath: toPosixRelative(path.relative(rootDir, filePath)),
          sizeBytes: stats.size,
          sha256: await hashFileSha256(filePath),
        };
      }),
  );
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function shouldSkipChecksum(fileName: string, options: ChecksumEntryOptions): boolean {
  if (fileName === 'manifest.v2.json') {
    return true;
  }
  return fileName === 'sha256-manifest.json' && !options.includeChecksumManifest;
}

function runPowerShellZip(sourceDir: string, destinationZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = [
      '$ErrorActionPreference = "Stop"',
      `if (Test-Path -LiteralPath '${escapePowerShellLiteral(destinationZipPath)}') { Remove-Item -LiteralPath '${escapePowerShellLiteral(destinationZipPath)}' -Force }`,
      `Compress-Archive -LiteralPath '${escapePowerShellLiteral(sourceDir)}' -DestinationPath '${escapePowerShellLiteral(destinationZipPath)}' -CompressionLevel Optimal`,
    ].join('; ');

    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
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
      reject(new Error(stderr.trim() || `Compress-Archive failed with exit code ${code}.`));
    });
  });
}

async function collectFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function escapePowerShellLiteral(input: string): string {
  return input.replaceAll("'", "''");
}

function toPosixRelative(input: string): string {
  return input.replace(/\\/g, '/');
}
