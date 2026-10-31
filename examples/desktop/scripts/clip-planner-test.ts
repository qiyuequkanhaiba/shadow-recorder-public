import assert from 'node:assert/strict';
import {
  planStreamClip,
  planSessionClips,
  mapWallClockToVideoOffsetMs,
} from '../src-electron/modules/reqcase-shadow-recorder/clip-planner';
import type {
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoStream,
} from '../src-electron/modules/reqcase-shadow-recorder/types';

const mockStream: any = {
  schemaVersion: 1,
  kind: 'reqcase.test-session-video-stream',
  streamId: 'stream-1',
  sessionId: 'session-1',
  targetCaptureMode: 'desktop',
  displayId: 'display-1',
  label: 'Display 1',
  startedAtMs: 1000,
  segmentDurationSeconds: 5,
  targetFps: 15,
};

const mockSegments: ReqCaseShadowRecorderTestSessionVideoSegment[] = [
  {
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    segmentId: 'seg-1',
    sessionId: 'session-1',
    streamId: 'stream-1',
    status: 'ready',
    startedAtMs: 10000,
    endedAtMs: 15000,
    durationMs: 5000,
    filePath: '/tmp/seg-1.mp4',
    isPlayable: true,
  },
  {
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    segmentId: 'seg-2',
    sessionId: 'session-1',
    streamId: 'stream-1',
    status: 'ready',
    startedAtMs: 15000,
    endedAtMs: 20000,
    durationMs: 5000,
    filePath: '/tmp/seg-2.mp4',
    isPlayable: true,
  },
  {
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    segmentId: 'seg-3',
    sessionId: 'session-1',
    streamId: 'stream-1',
    status: 'ready',
    startedAtMs: 20000,
    endedAtMs: 25000,
    durationMs: 5000,
    filePath: '/tmp/seg-3.mp4',
    isPlayable: true,
  },
];

// Test 1: Full session (no range)
const fullPlan = planStreamClip('stream-1', mockSegments);
assert.equal(fullPlan.pieces.length, 3);
assert.equal(fullPlan.totalDurationMs, 15000);
assert.equal(fullPlan.actualStartMs, 10000);
assert.equal(fullPlan.actualEndMs, 25000);
assert.equal(fullPlan.pieces[0].inpointSeconds, undefined);
assert.equal(fullPlan.pieces[2].outpointSeconds, undefined);

// Test 2: Precise clip across middle of seg-1 to middle of seg-2 (12000 to 18000 = 6000ms)
const precisePlan = planStreamClip('stream-1', mockSegments, { startMs: 12000, endMs: 18000 }, 'precise');
assert.equal(precisePlan.pieces.length, 2);
assert.equal(precisePlan.totalDurationMs, 6000);
assert.equal(precisePlan.actualStartMs, 12000);
assert.equal(precisePlan.actualEndMs, 18000);
assert.equal(precisePlan.pieces[0].segmentId, 'seg-1');
assert.equal(precisePlan.pieces[0].inpointSeconds, 2); // 12000 - 10000 = 2s
assert.equal(precisePlan.pieces[0].outpointSeconds, undefined); // seg-1 ends at 15000, which is < reqEnd (18000)
assert.equal(precisePlan.pieces[0].pieceDurationMs, 3000); // 15000 - 12000

assert.equal(precisePlan.pieces[1].segmentId, 'seg-2');
assert.equal(precisePlan.pieces[1].inpointSeconds, undefined);
assert.equal(precisePlan.pieces[1].outpointSeconds, 3); // 18000 - 15000 = 3s
assert.equal(precisePlan.pieces[1].pieceDurationMs, 3000); // 18000 - 15000
assert.equal(precisePlan.pieces[1].outputOffsetMs, 3000);

// Test 3: Fast clip for the same range (snaps outward to whole segment boundaries)
const fastPlan = planStreamClip('stream-1', mockSegments, { startMs: 12000, endMs: 18000 }, 'fast');
assert.equal(fastPlan.pieces.length, 2);
assert.equal(fastPlan.totalDurationMs, 10000); // 5000 + 5000
assert.equal(fastPlan.actualStartMs, 10000);
assert.equal(fastPlan.actualEndMs, 20000);
assert.equal(fastPlan.pieces[0].inpointSeconds, undefined);
assert.equal(fastPlan.pieces[1].outpointSeconds, undefined);

// Test 4: Single segment internal slice (12000 to 14000 = 2000ms inside seg-1)
const singleSegPlan = planStreamClip('stream-1', mockSegments, { startMs: 12000, endMs: 14000 }, 'precise');
assert.equal(singleSegPlan.pieces.length, 1);
assert.equal(singleSegPlan.totalDurationMs, 2000);
assert.equal(singleSegPlan.pieces[0].inpointSeconds, 2);
assert.equal(singleSegPlan.pieces[0].outpointSeconds, 4);

// Test 5: Wall clock offset mapping
const offsetAt12000 = mapWallClockToVideoOffsetMs(12000, precisePlan);
assert.equal(offsetAt12000, 0);
const offsetAt14000 = mapWallClockToVideoOffsetMs(14000, precisePlan);
assert.equal(offsetAt14000, 2000);
const offsetAt16000 = mapWallClockToVideoOffsetMs(16000, precisePlan);
assert.equal(offsetAt16000, 4000);
const offsetOutside = mapWallClockToVideoOffsetMs(22000, precisePlan);
assert.equal(offsetOutside, undefined);

// Test 6: Multi-stream session clip
const sessionPlan = planSessionClips([mockStream], mockSegments, { startMs: 12000, endMs: 18000 }, 'precise');
assert.equal(sessionPlan.streamPlans.length, 1);
assert.equal(sessionPlan.actualStartMs, 12000);
assert.equal(sessionPlan.actualEndMs, 18000);

// Test 7: Zero-reencode fast-path on exact segment boundaries in precise mode (including <= 50ms boundary tolerance)
const wholeSegPlan = planStreamClip("stream-1", mockSegments, { startMs: 15000, endMs: 20000 }, "precise");
assert.equal(wholeSegPlan.requiresReencode, false);
const nearBoundaryPlan = planStreamClip("stream-1", mockSegments, { startMs: 15030, endMs: 19975 }, "precise");
assert.equal(nearBoundaryPlan.requiresReencode, false);
assert.equal(nearBoundaryPlan.pieces[0]?.inpointSeconds, undefined);
assert.equal(nearBoundaryPlan.pieces[0]?.outpointSeconds, undefined);
assert.equal(precisePlan.requiresReencode, true);
assert.equal(fastPlan.requiresReencode, false);

// Test 8: Preferred hardware encoder detection
const nvencSegs = mockSegments.map((s) => ({ ...s, encoderName: "ffmpeg:h264_nvenc" }));
const nvencPlan = planStreamClip("stream-1", nvencSegs, { startMs: 12000, endMs: 14000 }, "precise");
assert.equal(nvencPlan.preferredEncoder, "h264_nvenc");

console.log('clip-planner-test PASS');
