import assert from 'node:assert/strict';

import {
  frameStepMs,
  nextPlaybackRate,
  playbackFrameRate,
} from '../src-react/lib/playback-review';

assert.equal(nextPlaybackRate(1), 1.5);
assert.equal(nextPlaybackRate(1.5), 2);
assert.equal(nextPlaybackRate(2), 1);
assert.equal(nextPlaybackRate(0), 1.5);

assert.equal(playbackFrameRate('efficiency'), 7);
assert.equal(playbackFrameRate('balanced'), 14);
assert.equal(playbackFrameRate('smooth'), 20);
assert.equal(playbackFrameRate(null), 14);

assert.equal(frameStepMs(14, 1), 71);
assert.equal(frameStepMs(14, -1), -71);
assert.equal(frameStepMs(7, 1), 143);
assert.equal(frameStepMs(20, 1), 50);

console.log('playback-review-test passed');
