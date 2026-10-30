import { strict as assert } from 'node:assert';

import { ffmpegConcatFileLine } from '../src-electron/modules/reqcase-shadow-recorder/ffmpeg-concat-list';

const line = ffmpegConcatFileLine(String.raw`C:\a\O'B\x.mp4`);
assert.equal(line, "file 'C:/a/O'\\''B/x.mp4'");

const plain = ffmpegConcatFileLine(String.raw`C:\videos\clip.mp4`);
assert.equal(plain, "file 'C:/videos/clip.mp4'");

console.log('concat-list-test ok');
