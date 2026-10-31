/** ffmpeg concat-demuxer list line. Backslashes first, then single quotes. */
export function ffmpegConcatFileLine(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}
