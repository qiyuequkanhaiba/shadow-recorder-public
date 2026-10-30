import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBundledFfmpegPath } from '../../ffmpeg-resource';
import type { StreamClipPlan } from './clip-planner';
import { ffmpegConcatFileLine } from './ffmpeg-concat-list';

export type ClipRenderProgress = {
  percent: number;
  message: string;
};

export type ClipRenderOptions = {
  plan: StreamClipPlan;
  outputPath: string;
  onProgress?: (progress: ClipRenderProgress) => void;
  signal?: AbortSignal;
};

export async function renderStreamClipVideo(options: ClipRenderOptions): Promise<{ fileCount: number; byteCount: number }> {
  const { plan, outputPath, onProgress, signal } = options;

  if (plan.pieces.length === 0) {
    return { fileCount: 0, byteCount: 0 };
  }

  // Fast mode (or precise mode where requiresReencode === false) with 1 piece can simply copyFile
  const requiresReencode = plan.requiresReencode ?? plan.isPrecise;
  if (!requiresReencode && plan.pieces.length === 1) {
    if (signal?.aborted) {
      throw new Error('Clip rendering aborted');
    }
    await copyFile(plan.pieces[0].filePath, outputPath);
    const outputStats = await stat(outputPath);
    return { fileCount: 1, byteCount: outputStats.size };
  }

  const ffmpegPath = resolveBundledFfmpegPath() ?? process.env.REQCASE_SHADOWRECORDER_FFMPEG_PATH ?? null;
  if (!ffmpegPath) {
    throw new Error('Cannot export clipped video because ffmpeg is unavailable.');
  }

  // Build concat list file
  const concatListPath = path.resolve(
    path.dirname(outputPath),
    `${path.basename(outputPath, '.mp4')}.${Date.now()}-${Math.random().toString(16).slice(2)}.concat.txt`,
  );

  const lines: string[] = [];
  for (const piece of plan.pieces) {
    lines.push(ffmpegConcatFileLine(piece.filePath));
    if (requiresReencode) {
      if (typeof piece.inpointSeconds === 'number' && piece.inpointSeconds > 0) {
        lines.push(`inpoint ${piece.inpointSeconds.toFixed(3)}`);
      }
      if (typeof piece.outpointSeconds === 'number' && piece.outpointSeconds > 0) {
        lines.push(`outpoint ${piece.outpointSeconds.toFixed(3)}`);
      }
    }
  }
  const concatPayload = lines.join('\n') + '\n';
  await writeFile(concatListPath, concatPayload, 'utf-8');

  try {
    if (signal?.aborted) {
      throw new Error('Clip rendering aborted');
    }

    const requiresReencode = plan.requiresReencode ?? plan.isPrecise;
    const preferredEncoder = plan.preferredEncoder ?? "libx264";
    try {
      await executeFfmpegConcat({
        ffmpegPath,
        concatListPath,
        outputPath,
        isPrecise: requiresReencode,
        encoder: preferredEncoder,
        totalDurationMs: plan.totalDurationMs,
        onProgress,
        signal,
      });
    } catch (err) {
      if (preferredEncoder !== "libx264" && !signal?.aborted) {
        console.warn("[ffmpeg-clip] Hardware encoder " + preferredEncoder + " failed, falling back to libx264:", err);
        await executeFfmpegConcat({
          ffmpegPath,
          concatListPath,
          outputPath,
          isPrecise: requiresReencode,
          encoder: "libx264",
          totalDurationMs: plan.totalDurationMs,
          onProgress,
          signal,
        });
      } else {
        throw err;
      }
    }

    const outputStats = await stat(outputPath);
    return { fileCount: 1, byteCount: outputStats.size };
  } finally {
    await rm(concatListPath, { force: true }).catch(() => {});
  }
}

interface ExecuteConcatOptions {
  ffmpegPath: string;
  concatListPath: string;
  outputPath: string;
  isPrecise: boolean;
  encoder?: "h264_nvenc" | "h264_qsv" | "h264_amf" | "libx264";
  totalDurationMs: number;
  onProgress?: (progress: ClipRenderProgress) => void;
  signal?: AbortSignal;
}

function executeFfmpegConcat(opts: ExecuteConcatOptions): Promise<void> {
  const { ffmpegPath, concatListPath, outputPath, isPrecise, encoder = "libx264", totalDurationMs, onProgress, signal } = opts;

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Clip rendering aborted'));
      return;
    }

    const args = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
    ];

    if (!isPrecise) {
      // Stream copy mode (fast or whole segments)
      args.push('-c', 'copy');
    } else {
      // Precise re-encoding with preferred hardware encoder or libx264
      if (encoder === "h264_nvenc") {
        args.push('-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '24', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1');
      } else if (encoder === "h264_qsv") {
        args.push('-c:v', 'h264_qsv', '-global_quality', '24', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1');
      } else if (encoder === "h264_amf") {
        args.push('-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1');
      } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1');
      }
    }

    args.push('-movflags', '+faststart', outputPath);

    let child: ChildProcess;
    try {
      child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = '';
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      reject(new Error('Clip rendering aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout?.on('data', (chunk) => {
      if (!onProgress || totalDurationMs <= 0) return;
      const text = chunk.toString();
      // Parse out_time_us or out_time=00:00:01.234567
      const usMatch = /out_time_us=(\d+)/.exec(text);
      if (usMatch) {
        const currentMs = Number(usMatch[1]) / 1000;
        const percent = Math.min(99, Math.max(0, Math.round((currentMs / totalDurationMs) * 100)));
        onProgress({ percent, message: `正在裁切编码视频 (${percent}%)` });
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg concat failed with exit code ${code}`));
      }
    });
  });
}
