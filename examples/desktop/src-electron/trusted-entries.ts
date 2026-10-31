import { fileUrlForPath } from './trusted-sender';

const allowedFileUrls = new Set<string>();
const allowedDataUrls = new Set<string>();

export function allowExactFile(filePath: string): () => void {
  const url = fileUrlForPath(filePath);
  allowedFileUrls.add(url);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    allowedFileUrls.delete(url);
  };
}

export function allowExactDataUrl(dataUrl: string): () => void {
  let key: string;
  try {
    key = new URL(dataUrl).href;
  } catch {
    key = dataUrl;
  }
  allowedDataUrls.add(key);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    allowedDataUrls.delete(key);
  };
}

export function listAllowedFileUrls(): string[] {
  return [...allowedFileUrls];
}

export function listAllowedDataUrls(): string[] {
  return [...allowedDataUrls];
}
