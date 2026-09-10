import path from 'node:path';

import {
  BUNDLED_FFMPEG_DOWNLOAD_URL,
  BUNDLED_FFMPEG_SHA256_URL,
  BUNDLED_FFMPEG_VERSION,
  REQCASE_FFMPEG_ENV_VAR,
  resolveBundledFfmpegPath,
  resolveBundledFfmpegOutputPath,
  stageBundledFfmpeg,
} from '../src-electron/ffmpeg-resource';

const optional = process.argv.includes('--optional');
const desktopRoot = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  let staged = null;
  try {
    staged = await stageBundledFfmpeg(__dirname, { allowDownload: true });
  } catch (error) {
    if (optional) {
      console.warn(`[prepare-ffmpeg-resource] failed to provision ffmpeg automatically: ${error}`);
      process.exit(0);
    }
    throw error;
  }

  if (!staged) {
    const destination = resolveBundledFfmpegOutputPath(__dirname);
    const configured = resolveBundledFfmpegPath(__dirname);
    const message =
      `[prepare-ffmpeg-resource] Cannot find a supported ffmpeg.exe for bundling.\n` +
      `Expected one of:\n` +
      `- env ${REQCASE_FFMPEG_ENV_VAR}\n` +
      `- ${path.resolve(desktopRoot, '../../tools/ffmpeg/bin/ffmpeg.exe')}\n` +
      `Or an automatic download from:\n` +
      `- ${BUNDLED_FFMPEG_DOWNLOAD_URL}\n` +
      `Expected archive SHA256 metadata:\n` +
      `- ${BUNDLED_FFMPEG_SHA256_URL}\n` +
      `Pinned build:\n` +
      `- ${BUNDLED_FFMPEG_VERSION}\n` +
      `Target bundle path:\n` +
      `- ${destination}` +
      (configured ? `\nResolved runtime ffmpeg candidate:\n- ${configured}` : '');

    if (optional) {
      console.warn(`${message}\nProceeding without bundled ffmpeg for this command.`);
      process.exit(0);
    }

    throw new Error(
      `${message}\nPlace a modern ffmpeg.exe under tools/ffmpeg/bin or set ${REQCASE_FFMPEG_ENV_VAR}.`,
    );
  }

  const versionLine = staged.executableInfo.version
    ? `\n- version: ${staged.executableInfo.version}`
    : '';
  const downloadLine = staged.downloaded ? '\n- auto-download: yes' : '\n- auto-download: no';
  if (staged.copied) {
    console.log(
      `[prepare-ffmpeg-resource] staged ffmpeg.exe:\n- source: ${staged.source}\n- destination: ${staged.destination}${versionLine}${downloadLine}`,
    );
  } else {
    console.log(
      `[prepare-ffmpeg-resource] ffmpeg.exe already staged at ${staged.destination}${versionLine}${downloadLine}`,
    );
  }
}

main().catch((error) => {
  console.error('[prepare-ffmpeg-resource] failed:', error);
  process.exit(1);
});
