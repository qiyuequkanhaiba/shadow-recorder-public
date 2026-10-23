import assert from 'node:assert/strict';
import {
  IDLE_EXPORT_PROGRESS,
  reduceExportProgress,
  type ExportProgressEvent,
} from '../src-electron/export-progress';

function apply(events: ExportProgressEvent[]) {
  let state = IDLE_EXPORT_PROGRESS;
  const emitted: ExportProgressEvent[] = [];
  for (const event of events) {
    const next = reduceExportProgress(state, event);
    state = next.state;
    if (next.emit) {
      emitted.push(event);
    }
  }
  return { state, emitted };
}

const started = apply([
  { attemptId: 1, percent: 8, message: '正在准备导出', status: 'running' },
  { attemptId: 1, percent: 93, message: '正在打包', status: 'running' },
  { attemptId: 1, percent: 74, message: '迟到的合成进度', status: 'running' },
  { attemptId: 1, percent: 100, message: '已完成导出', status: 'complete' },
]);
assert.equal(started.state.phase, 'complete');
assert.equal(started.state.percent, 100);
assert.equal(started.emitted.length, 3);
assert.equal(started.emitted.at(-1)?.status, 'complete');

const stale = apply([
  { attemptId: 1, percent: 93, message: '正在打包', status: 'running' },
  { attemptId: 1, percent: 100, message: '已完成导出', status: 'complete' },
  { attemptId: 1, percent: 93, message: '正在打包', status: 'running' },
]);
assert.equal(stale.state.phase, 'complete');
assert.equal(stale.emitted.length, 2);

const again = apply([
  { attemptId: 1, percent: 100, message: '已完成导出', status: 'complete' },
  { attemptId: 2, percent: 8, message: '正在准备导出', status: 'running' },
]);
assert.equal(again.state.phase, 'running');
assert.equal(again.state.percent, 8);
assert.equal(again.state.attemptId, 2);

const canceled = apply([
  { attemptId: 3, percent: 12, message: '正在准备录像', status: 'running' },
  { attemptId: 3, percent: 0, message: '已取消导出', status: 'canceled' },
]);
assert.equal(canceled.state.phase, 'canceled');
assert.equal(canceled.state.percent, 0);

console.log('export-progress-test passed');
