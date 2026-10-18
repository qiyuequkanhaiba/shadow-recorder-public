import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RecorderConfigSchema } from '../src-electron/modules/reqcase-shadow-recorder/ipc-validators';
import {
  acceleratorFromKeyboardEvent,
  canAssignScreenshotShortcut,
  formatScreenshotAccelerator,
  normalizeScreenshotDelaySeconds,
  parseSelectionRect,
  physicalRectFromDipCorners,
  resolveScreenshotShortcuts,
  trimScreenshotHistory,
  unionDisplayBounds,
} from '../src-electron/screenshot-capture';
import { createScreenshotOverlayHtml } from '../src-electron/screenshot-overlay-html';

const desktopRoot = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(path.resolve(desktopRoot, relativePath), 'utf8');
}

function run(): void {
  const defaults = resolveScreenshotShortcuts({});
  assert.equal(defaults.area, 'CommandOrControl+Shift+A');
  assert.equal(defaults.monitor, 'CommandOrControl+Shift+F');
  assert.equal(defaults.window, 'CommandOrControl+Shift+W');
  assert.deepEqual(defaults.rejected, []);

  const conflict = resolveScreenshotShortcuts({
    shortcutStartRecording: 'CommandOrControl+Shift+A',
    shortcutStopRecording: 'CommandOrControl+Shift+S',
    shortcutCaptureArea: 'CommandOrControl+Shift+A',
    shortcutCaptureMonitor: '',
    shortcutCaptureWindow: 'CommandOrControl+Shift+F',
  });
  assert.equal(conflict.area, null);
  assert.equal(conflict.monitor, null);
  assert.equal(conflict.window, 'CommandOrControl+Shift+F');
  assert.deepEqual(conflict.rejected, ['CommandOrControl+Shift+A']);

  assert.equal(acceleratorFromKeyboardEvent({
    key: 'a',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  }), 'CommandOrControl+Shift+A');
  assert.equal(acceleratorFromKeyboardEvent({
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  }), null);
  assert.equal(acceleratorFromKeyboardEvent({
    key: 'Backspace',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  }), '');
  assert.equal(acceleratorFromKeyboardEvent({
    key: 'A',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    repeat: true,
  }), null);
  assert.equal(formatScreenshotAccelerator('CommandOrControl+Shift+A'), 'Ctrl+Shift+A');
  assert.equal(canAssignScreenshotShortcut('area', 'CommandOrControl+Shift+F', {
    shortcutCaptureMonitor: 'CommandOrControl+Shift+F',
  }), false);
  assert.equal(canAssignScreenshotShortcut('area', 'CommandOrControl+Shift+A', {
    shortcutStartRecording: 'CommandOrControl+Shift+A',
  }), false);
  assert.equal(canAssignScreenshotShortcut('monitor', 'CommandOrControl+Alt+F', {}), true);

  const duplicate = resolveScreenshotShortcuts({
    shortcutCaptureArea: 'CommandOrControl+Shift+1',
    shortcutCaptureMonitor: 'CommandOrControl+Shift+1',
  });
  assert.equal(duplicate.area, 'CommandOrControl+Shift+1');
  assert.equal(duplicate.monitor, null);
  assert.deepEqual(duplicate.rejected, ['CommandOrControl+Shift+1']);

  const physical = physicalRectFromDipCorners(
    { x: 10, y: 8 },
    { x: 2, y: 20 },
    (point) => ({ x: point.x * 2, y: point.y * 2 }),
  );
  assert.deepEqual(physical, { x: 4, y: 16, width: 16, height: 24 });
  assert.equal(
    physicalRectFromDipCorners({ x: 1, y: 1 }, { x: 1, y: 1 }, (point) => point),
    null,
  );

  assert.deepEqual(unionDisplayBounds([
    { x: 0, y: 0, width: 100, height: 80 },
    { x: -40, y: 10, width: 20, height: 30 },
  ]), { x: -40, y: 0, width: 140, height: 80 });
  assert.equal(parseSelectionRect({ x: 1, y: 2, width: 0, height: 4 }), null);
  assert.deepEqual(parseSelectionRect({ x: 1.2, y: 2.6, width: 3, height: 4 }), {
    x: 1,
    y: 3,
    width: 3,
    height: 4,
  });
  assert.equal(normalizeScreenshotDelaySeconds(3), 3);
  assert.equal(normalizeScreenshotDelaySeconds('5'), 5);
  assert.equal(normalizeScreenshotDelaySeconds(4), 0);
  assert.deepEqual(
    trimScreenshotHistory([
      { id: 'a', createdAtMs: 1 },
      { id: 'b', createdAtMs: 3 },
      { id: 'c', createdAtMs: 2 },
    ], 2),
    {
      kept: [
        { id: 'b', createdAtMs: 3 },
        { id: 'c', createdAtMs: 2 },
      ],
      removed: [{ id: 'a', createdAtMs: 1 }],
    },
  );

  const html = createScreenshotOverlayHtml();
  assert.match(html, /aria-label="截图选区"/);
  assert.match(html, /Enter 复制/);
  assert.match(html, /Esc 取消/);
  assert.match(html, /矩形/);
  assert.match(html, /箭头/);
  assert.match(html, /文字/);
  assert.match(html, /打码/);
  assert.match(html, /贴在屏幕上/);

  const session = read('src-electron/screenshot-session.ts');
  assert.match(session, /focusable:\s*true/);
  assert.doesNotMatch(session, /setShape|SetWindowRgn/);
  const hideAt = session.indexOf('window.hide()');
  const grabAt = session.indexOf("grab({ mode: 'region'");
  assert.ok(hideAt >= 0 && grabAt > hideAt, 'region capture must hide the overlay first');

  const parsed = RecorderConfigSchema.parse({
    shortcutCaptureArea: 'CommandOrControl+Shift+A',
    shortcutCaptureMonitor: 'CommandOrControl+Shift+F',
    shortcutCaptureWindow: 'CommandOrControl+Shift+W',
  });
  assert.equal(parsed.shortcutCaptureArea, 'CommandOrControl+Shift+A');
  assert.ok(RecorderConfigSchema.shape.shortcutCaptureWindow);
  assert.ok(RecorderConfigSchema.shape.screenshotDelaySeconds);

  console.log('[screenshot-capture-test] PASS');
}

run();
