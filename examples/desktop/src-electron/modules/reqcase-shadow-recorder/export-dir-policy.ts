import path from 'node:path';

type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'>;

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
): boolean {
  const roots = [
    allowlist.documentsDir,
    allowlist.desktopDir,
    allowlist.downloadsDir,
    ...allowlist.savedExportDirs,
  ].map((root) => root.trim()).filter(Boolean);
  return roots.some((root) => isWithinDirectory(root, targetDir, pathApi));
}

export function assertRendererExportDirAllowed(
  targetDir: string,
  allowlist: ExportDirAllowlist,
  pathApi: PathApi = path,
): void {
  if (isRendererExportDirAllowed(targetDir, allowlist, pathApi)) {
    return;
  }
  throw new Error(
    `导出目录不在允许范围内（${targetDir}）。请使用文档、桌面、下载目录，或设置里已保存的导出目录；其他位置请通过导出对话框选择。`,
  );
}
