import type { BrowserWindow } from 'electron';

import { filePathFromUrl, sameFilePath } from './trusted-sender';

export function isOwnEntryUrl(entryUrl: string, targetUrl: string): boolean {
  if (!entryUrl || !targetUrl) {
    return false;
  }
  const entryFile = filePathFromUrl(entryUrl);
  const targetFile = filePathFromUrl(targetUrl);
  if (entryFile || targetFile) {
    return entryFile !== null && targetFile !== null && sameFilePath(entryFile, targetFile);
  }
  try {
    const entry = new URL(entryUrl);
    const target = new URL(targetUrl);
    if (entry.protocol === 'data:' || target.protocol === 'data:') {
      return entry.href === target.href;
    }
    entry.hash = '';
    target.hash = '';
    return entry.href === target.href;
  } catch {
    return false;
  }
}

export function installEntryNavigationGuard(
  window: BrowserWindow,
  readEntryUrl: () => string,
): void {
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (!isOwnEntryUrl(readEntryUrl(), url)) {
      event.preventDefault();
    }
  };
  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
}
