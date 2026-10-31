import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);

export type TrustedSenderInput = {
  senderUrl: string;
  isPackaged: boolean;
  allowedFileUrls: readonly string[];
  allowedDataUrls: readonly string[];
};

export function fileUrlForPath(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function filePathFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password) {
    return null;
  }
  try {
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

export function sameFilePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function canonicalDataUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'data:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function isAllowedFileSender(senderUrl: string, allowedFileUrls: readonly string[]): boolean {
  const senderPath = filePathFromUrl(senderUrl);
  if (!senderPath) {
    return false;
  }
  return allowedFileUrls.some((allowed) => {
    const allowedPath = filePathFromUrl(allowed) ?? (path.isAbsolute(allowed) ? path.resolve(allowed) : null);
    return allowedPath !== null && sameFilePath(senderPath, allowedPath);
  });
}

function isHtmlDataUrl(url: string): boolean {
  const href = canonicalDataUrl(url);
  if (!href) {
    return false;
  }
  const comma = href.indexOf(',');
  const meta = (comma === -1 ? href : href.slice(0, comma)).toLowerCase();
  return meta === 'data:text/html' || meta.startsWith('data:text/html;');
}

function isAllowedDataSender(senderUrl: string, allowedDataUrls: readonly string[]): boolean {
  const senderKey = canonicalDataUrl(senderUrl);
  if (!senderKey || !isHtmlDataUrl(senderKey)) {
    return false;
  }
  return allowedDataUrls.some((allowed) => canonicalDataUrl(allowed) === senderKey);
}

function isDevSender(senderUrl: string): boolean {
  try {
    const parsed = new URL(senderUrl);
    return parsed.protocol === 'http:' && DEV_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

export function isTrustedIpcSender(input: TrustedSenderInput): boolean {
  const senderUrl = input.senderUrl.trim();
  if (!senderUrl) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(senderUrl);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    return isAllowedFileSender(senderUrl, input.allowedFileUrls);
  }
  if (parsed.protocol === 'data:') {
    return isAllowedDataSender(senderUrl, input.allowedDataUrls);
  }
  if (!input.isPackaged) {
    return isDevSender(senderUrl);
  }
  return false;
}
