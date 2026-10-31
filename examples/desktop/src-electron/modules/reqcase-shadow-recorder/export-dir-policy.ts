import { realpathSync } from 'node:fs';
import path from 'node:path';

type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'dirname' | 'join'>;
type RealpathFn = (value: string) => string;

/**
 * Resolve symlinks and junctions on the deepest existing ancestor, then re-append the
 * part that does not exist yet. A target that does not exist can still be checked.
 */
export function canonicalizeDirectory(
  value: string,
  pathApi: PathApi = path,
  realpath: RealpathFn | null = pathApi === path ? realpathSync.native : null,
): string {
  const resolved = pathApi.resolve(value);
  if (!realpath) {
    return resolved;
  }
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpath(current);
      return missing.length > 0 ? pathApi.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = pathApi.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missing.push(pathApi.relative(parent, current));
      current = parent;
    }
  }
}

const SAVED_EXPORT_DIR_KEYS = ['exportDirectory', 'lastExportDirectory', 'savedExportDir'] as const;

export type ExportDirAllowlist = {
  documentsDir: string;
  desktopDir: string;
  downloadsDir: string;
  savedExportDirs: readonly string[];
};

export function collectSavedExportDirs(settings: object | null | undefined): string[] {
  if (!settings) {
    return [];
  }
  const record = settings as Record<string, unknown>;
  const found: string[] = [];
  for (const key of SAVED_EXPORT_DIR_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      found.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          found.push(item.trim());
        }
      }
    }
  }
  return [...new Set(found)];
}

export function isWithinDirectory(
  rootDir: string,
  targetDir: string,
  pathApi: PathApi = path,
): boolean {
  const root = pathApi.resolve(rootDir);
  const target = pathApi.resolve(targetDir);
  const relative = pathApi.relative(root, target);
  if (relative === '') {
    return true;
  }
  if (pathApi.isAbsolute(relative)) {
    return false;
  }
  return !relative.split(/[\\/]+/).includes('..');
}

export function isRendererExportDirAllowed(
  targetDir: string,
  allowlist: ExportDirAllowlist,
  pathApi: PathApi = path,
  realpath: RealpathFn | null = pathApi === path ? realpathSync.native : null,
): boolean {
  const roots = [
    allowlist.documentsDir,
    allowlist.desktopDir,
    allowlist.downloadsDir,
    ...allowlist.savedExportDirs,
  ].map((root) => root.trim()).filter(Boolean);
  const target = canonicalizeDirectory(targetDir, pathApi, realpath);
  return roots.some((root) => isWithinDirectory(
    canonicalizeDirectory(root, pathApi, realpath),
    target,
    pathApi,
  ));
}

export function assertRendererExportDirAllowed(
  targetDir: string,
  allowlist: ExportDirAllowlist,
  pathApi: PathApi = path,
  realpath: RealpathFn | null = pathApi === path ? realpathSync.native : null,
): void {
  if (isRendererExportDirAllowed(targetDir, allowlist, pathApi, realpath)) {
    return;
  }
  throw new Error(
    `导出目录不在允许范围内（${targetDir}）。请使用文档、桌面、下载目录，或设置里已保存的导出目录；其他位置请通过导出对话框选择。`,
  );
}
