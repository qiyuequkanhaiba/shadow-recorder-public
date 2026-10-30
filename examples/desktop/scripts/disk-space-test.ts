import { strict as assert } from 'node:assert';

import {
  MIN_FREE_BYTES_TO_START,
  MIN_FREE_BYTES_WHILE_RECORDING,
  bytesToGiB,
  canExport,
  canStartRecording,
  estimatedExportBytes,
  giBToBytes,
  shouldStopForDisk,
} from '../src-electron/modules/reqcase-shadow-recorder/disk-space';

assert.equal(canStartRecording(MIN_FREE_BYTES_TO_START, MIN_FREE_BYTES_TO_START), true);
assert.equal(canStartRecording(MIN_FREE_BYTES_TO_START - 1, MIN_FREE_BYTES_TO_START), false);
assert.equal(shouldStopForDisk(MIN_FREE_BYTES_WHILE_RECORDING, MIN_FREE_BYTES_WHILE_RECORDING), false);
assert.equal(shouldStopForDisk(MIN_FREE_BYTES_WHILE_RECORDING - 1, MIN_FREE_BYTES_WHILE_RECORDING), true);
assert.equal(estimatedExportBytes(1000), 1200);
assert.equal(estimatedExportBytes(0), 0);
assert.equal(canExport(1200, 1000), true);
assert.equal(canExport(1199, 1000), false);
assert.equal(bytesToGiB(MIN_FREE_BYTES_TO_START), 2);
assert.equal(giBToBytes(1.5, MIN_FREE_BYTES_WHILE_RECORDING), Math.round(1.5 * 1024 * 1024 * 1024));
assert.equal(giBToBytes(Number.NaN, 7), 7);

console.log('disk-space-test ok');
