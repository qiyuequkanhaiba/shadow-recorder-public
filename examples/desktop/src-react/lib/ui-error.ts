export function toUiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('Invalid report targetDir')) {
    return 'Report targetDir must be under desktop reports root (for example: reports).';
  }
  return raw;
}
