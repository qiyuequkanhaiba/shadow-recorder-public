import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  getActiveTestSession,
  getRecorderMetrics,
  getTestSessionEvents,
  getTestSessionVideoSegments,
  getTestSessionVideoStreams,
  listAvailableDisplays,
  startTestSession,
  stopTestSession,
} from '../src-electron/native-binding';
import { configureBundledFfmpegEnv } from '../src-electron/ffmpeg-resource';
import { createSmokeMatrixMetadata, type CaptureMode } from './recording-smoke-metadata';


type CliOptions = {
  durationSeconds: number;
  segmentDurationSeconds: number;
  recordingWindowSeconds: number;
  mode: CaptureMode;
  outputRoot: string;
  keepArtifacts: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    durationSeconds: 75,
    segmentDurationSeconds: 5,
    recordingWindowSeconds: 120,
    mode: 'target_display',
    outputRoot: path.resolve(process.cwd(), 'reports', 'recording-smoke'),
    keepArtifacts: false,
  };

  const positional = argv.filter((value) => !value.startsWith('--'));
  if (positional[0] === 'target_display' || positional[0] === 'foreground_window') {
    defaults.mode = positional[0];
  }
  if (positional[1]) {
    defaults.durationSeconds = Number.parseInt(positional[1], 10) || defaults.durationSeconds;
  }
  if (positional[2]) {
    defaults.segmentDurationSeconds =
      Number.parseInt(positional[2], 10) || defaults.segmentDurationSeconds;
  }
  if (positional[3]) {
    defaults.recordingWindowSeconds =
      Number.parseInt(positional[3], 10) || defaults.recordingWindowSeconds;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    switch (value) {
      case '--duration':
        defaults.durationSeconds = Number.parseInt(next ?? '', 10) || defaults.durationSeconds;
        index += 1;
        break;
      case '--segment-duration':
        defaults.segmentDurationSeconds =
          Number.parseInt(next ?? '', 10) || defaults.segmentDurationSeconds;
        index += 1;
        break;
      case '--recording-window':
        defaults.recordingWindowSeconds =
          Number.parseInt(next ?? '', 10) || defaults.recordingWindowSeconds;
        index += 1;
        break;
      case '--mode':
        if (next === 'target_display' || next === 'foreground_window') {
          defaults.mode = next;
        }
        index += 1;
        break;
      case '--output-root':
        defaults.outputRoot = path.resolve(next ?? defaults.outputRoot);
        index += 1;
        break;
      case '--keep-artifacts':
        defaults.keepArtifacts = true;
        break;
      default:
        break;
    }
  }

  return defaults;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureNoActiveSession(): Promise<void> {
  const active = getActiveTestSession();
  if (!active) {
    return;
  }
  console.log(`[recording-smoke] stopping stale active session ${active.sessionId}`);
  stopTestSession();
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  configureBundledFfmpegEnv();
  mkdirSync(options.outputRoot, { recursive: true });
  await ensureNoActiveSession();

  const smokeRoot = path.resolve(
    options.outputRoot,
    `${options.mode}-${Date.now()}`,
  );
  mkdirSync(smokeRoot, { recursive: true });

  const session = startTestSession({
    name: `recording-smoke ${options.mode}`,
    storageDir: smokeRoot,
    targetCaptureMode: options.mode,
    bufferWindowSeconds: options.recordingWindowSeconds,
    segmentDurationSeconds: options.segmentDurationSeconds,
  });
  console.log(
    `[recording-smoke] started session=${session.sessionId} mode=${options.mode} ` +
      `duration=${options.durationSeconds}s root=${smokeRoot}`,
  );

  const startedAt = Date.now();
  let elapsedSeconds = 0;
  while (elapsedSeconds < options.durationSeconds) {
    await sleep(1000);
    elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    console.log(`[recording-smoke] elapsed=${elapsedSeconds}s/${options.durationSeconds}s`);
  }

  const stopped = stopTestSession();
  console.log(`[recording-smoke] stopped session=${stopped.sessionId}`);

  const streams = getTestSessionVideoStreams(stopped.sessionId);
  const segments = getTestSessionVideoSegments(stopped.sessionId, undefined, 512);
  const events = getTestSessionEvents(stopped.sessionId, 2048);
  const matrix = createSmokeMatrixMetadata({
    mode: options.mode,
    displays: listAvailableDisplays(),
    streams,
    segments,
    events,
    metrics: getRecorderMetrics(),
  });
  const playableSegments = segments.filter((segment) => segment.isPlayable);
  const totalPlayableDurationMs = playableSegments.reduce(
    (sum, segment) => sum + segment.durationMs,
    0,
  );
  const warningMessages = streams
    .map((stream) => stream.lastWarning)
    .filter((warning): warning is string => Boolean(warning));

  assert.ok(streams.length >= 1, 'expected at least one video stream');
  assert.ok(playableSegments.length >= 1, 'expected at least one playable video segment');
  assert.ok(totalPlayableDurationMs >= options.segmentDurationSeconds * 1000,
    `expected playable duration >= ${options.segmentDurationSeconds}s, got ${totalPlayableDurationMs}ms`);
  assert.ok(events.some((event) => event.eventType === 'session_started'), 'expected session_started event');
  assert.ok(events.some((event) => event.eventType === 'session_stopped'), 'expected session_stopped event');

  if (options.mode === 'foreground_window') {
    assert.ok(
      streams.some((stream) => stream.displayId || stream.width || stream.height),
      'expected foreground window stream metadata to be resolved',
    );
  }

  const summary = {
    sessionId: stopped.sessionId,
    mode: options.mode,
    durationSeconds: options.durationSeconds,
    smokeRoot,
    streamCount: streams.length,
    segmentCount: segments.length,
    playableSegmentCount: playableSegments.length,
    totalPlayableDurationMs,
    eventCount: events.length,
    matrix,
    warnings: warningMessages,
  };

  console.log(`[recording-smoke] summary ${JSON.stringify(summary, null, 2)}`);

  if (!options.keepArtifacts) {
    rmSync(smokeRoot, { recursive: true, force: true });
    console.log(`[recording-smoke] cleaned ${smokeRoot}`);
  }
}

void run().catch((error) => {
  console.error('[recording-smoke] FAIL', error);
  process.exitCode = 1;
});
