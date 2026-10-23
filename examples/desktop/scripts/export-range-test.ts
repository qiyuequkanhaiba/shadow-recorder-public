import assert from 'node:assert/strict';
import {
  playbackMsToWallClock,
  selectionToWallClockRange,
} from '../src-react/lib/export-range';
import type { ContinuousPlaybackSegment } from '../src-react/components/StudioTimelineDock';

const mockContinuousSegments: ContinuousPlaybackSegment[] = [
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
    isPlayable: true,
    accumulatedStartMs: 0,
    accumulatedEndMs: 5000,
  },
  {
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    segmentId: 'seg-2',
    sessionId: 'session-1',
    streamId: 'stream-1',
    status: 'ready',
    startedAtMs: 20000, // pause gap between 15000 and 20000
    endedAtMs: 25000,
    durationMs: 5000,
    isPlayable: true,
    accumulatedStartMs: 5000,
    accumulatedEndMs: 10000,
  },
];

// Test 1: playbackMs inside first segment
const wall1 = playbackMsToWallClock(2000, mockContinuousSegments);
assert.equal(wall1, 12000);

// Test 2: playbackMs inside second segment (across pause gap)
const wall2 = playbackMsToWallClock(7000, mockContinuousSegments);
assert.equal(wall2, 22000); // 20000 + 2000

// Test 3: Selection range to wall clock range
const range = selectionToWallClockRange(
  { inPlaybackMs: 2000, outPlaybackMs: 7000 },
  mockContinuousSegments,
);
assert.ok(range);
assert.equal(range.startMs, 12000);
assert.equal(range.endMs, 22000);

// Test 4: Inverted selection (out before in)
const inverted = selectionToWallClockRange(
  { inPlaybackMs: 7000, outPlaybackMs: 2000 },
  mockContinuousSegments,
);
assert.ok(inverted);
assert.equal(inverted.startMs, 12000);
assert.equal(inverted.endMs, 22000);

console.log('export-range-test PASS');
