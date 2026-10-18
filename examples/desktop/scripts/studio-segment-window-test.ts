import assert from 'node:assert/strict';
import { resolveStudioSegmentLimit, STUDIO_SEGMENT_LIMIT } from '../src-react/lib/studio-segment-window.ts';

assert.equal(STUDIO_SEGMENT_LIMIT, 2000);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 30,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'count',
  historyRetentionMaxSegments: 200,
}), 206);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 600,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'count',
  historyRetentionMaxSegments: 2000,
}), 2000);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 30,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'age',
  historyRetentionHours: 24,
}), 2000);

assert.ok(resolveStudioSegmentLimit(null) > 72);

console.log('studio-segment-window-test passed');
