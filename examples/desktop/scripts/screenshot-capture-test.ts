import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RecorderConfigSchema,
  ScreenshotDragCursorSchema,
  ScreenshotDragStartSchema,
} from '../src-electron/modules/reqcase-shadow-recorder/ipc-validators';
import {
  acceleratorFromKeyboardEvent,
  annotationFrameOnDisplay,
  canAssignScreenshotShortcut,
  chooseAnnotationDisplay,
  chooseAreaSelection,
  formatScreenshotAccelerator,
  localDipSegmentOnDisplay,
  normalizeScreenshotDelaySeconds,
  parseSelectionRect,
  physicalRectFromDipCorners,
  physicalSelectionOnDisplay,
  planAreaOverlayWindows,
  resolveScreenshotShortcuts,
  selectionSegmentsByDisplay,
  shouldHideScreenshotUiFromCapture,
  trimScreenshotHistory,
  unionDisplayBounds,
  type DisplayGeometry,
} from '../src-electron/screenshot-capture';
import { createPinHtml, createScreenshotOverlayHtml } from '../src-electron/screenshot-overlay-html';

const desktopRoot = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(path.resolve(desktopRoot, relativePath), 'utf8');
}

function near(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} !~ ${expected}`);
}

function run(): void {
  const defaults = resolveScreenshotShortcuts({});
  assert.equal(defaults.area, 'CommandOrControl+Shift+A');
  assert.equal(defaults.monitor, 'CommandOrControl+Shift+F');
  assert.equal(defaults.window, 'CommandOrControl+Shift+W');
  assert.equal(defaults.pin, 'F3');
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
  assert.equal(acceleratorFromKeyboardEvent({
    key: 'F3',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  }), 'F3');
  assert.equal(acceleratorFromKeyboardEvent({
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  }), null);
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

  const sideBySide = planAreaOverlayWindows([
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ]);
  assert.deepEqual(sideBySide, [
    { displayId: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { displayId: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ]);
  assert.deepEqual(physicalSelectionOnDisplay(
    {
      bounds: sideBySide[1].bounds,
      scaleFactor: sideBySide[1].scaleFactor,
      physicalOrigin: { x: 1920, y: 0 },
    },
    { x: 1180, y: 620, width: 100, height: 100 },
  ), { x: 3690, y: 930, width: 150, height: 150 });

  const secondaryOnLeft = planAreaOverlayWindows([
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ]);
  assert.equal(secondaryOnLeft[1].bounds.x, -1280);
  assert.deepEqual(physicalSelectionOnDisplay(
    {
      bounds: secondaryOnLeft[1].bounds,
      scaleFactor: secondaryOnLeft[1].scaleFactor,
      physicalOrigin: { x: -1920, y: 0 },
    },
    { x: 10, y: 20, width: 40, height: 30 },
  ), { x: -1905, y: 30, width: 60, height: 45 });

  const stacked = planAreaOverlayWindows([
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 0, y: 1080, width: 1536, height: 864 }, scaleFactor: 1.25 },
  ]);
  assert.equal(stacked[1].bounds.y, 1080);
  assert.equal(stacked[1].scaleFactor, 1.25);
  assert.deepEqual(physicalSelectionOnDisplay(
    {
      bounds: stacked[1].bounds,
      scaleFactor: stacked[1].scaleFactor,
      physicalOrigin: { x: 0, y: 1080 },
    },
    { x: 100, y: 40, width: 80, height: 16 },
  ), { x: 125, y: 1130, width: 100, height: 20 });
  assert.equal(physicalSelectionOnDisplay(
    {
      bounds: stacked[1].bounds,
      scaleFactor: stacked[1].scaleFactor,
      physicalOrigin: { x: 0, y: 1080 },
    },
    { x: 1, y: 1, width: 0, height: 4 },
  ), null);

  const leftScreen: DisplayGeometry = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    physicalOrigin: { x: 0, y: 0 },
  };
  const rightScreen: DisplayGeometry = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560 / 1.5, height: 1600 / 1.5 },
    scaleFactor: 1.5,
    physicalOrigin: { x: 1920, y: 0 },
  };
  const across = { x: 960, y: 540, width: 3520, height: 1060 };
  const acrossSegments = selectionSegmentsByDisplay(across, [leftScreen, rightScreen]);
  assert.deepEqual(acrossSegments.find((segment) => segment.displayId === 1)?.local, {
    x: 960,
    y: 540,
    width: 960,
    height: 540,
  });
  const rightSegment = acrossSegments.find((segment) => segment.displayId === 2)?.local;
  assert.ok(rightSegment);
  assert.equal(rightSegment.x, 0);
  assert.equal(rightSegment.y, 360);
  near(rightSegment.width * rightScreen.scaleFactor, 2560);
  near(rightSegment.height * rightScreen.scaleFactor, 1060);
  assert.equal(chooseAnnotationDisplay(across, [leftScreen, rightScreen]), 2);
  const acrossFrame = annotationFrameOnDisplay(across, rightScreen);
  assert.ok(acrossFrame);
  near(acrossFrame.x, 0);
  assert.ok(Math.abs(acrossFrame.width - rightScreen.bounds.width) < 1e-9);
  assert.ok(Math.abs((acrossFrame.width / acrossFrame.height) - (3520 / 1060)) < 1e-9);
  assert.ok(Math.abs(acrossFrame.y - (rightScreen.bounds.height - acrossFrame.height) / 2) < 1e-6);
  assert.ok(acrossFrame.width < 3520 / 1.5);

  const secondaryScreen: DisplayGeometry = {
    id: 2,
    bounds: { x: -1280, y: 0, width: 1280, height: 720 },
    scaleFactor: 1.5,
    physicalOrigin: { x: -1920, y: 0 },
  };
  const negative = { x: -960, y: 540, width: 2880, height: 540 };
  const negativeSegments = selectionSegmentsByDisplay(negative, [secondaryScreen, leftScreen]);
  assert.deepEqual(negativeSegments.find((segment) => segment.displayId === 2)?.local, {
    x: 640,
    y: 360,
    width: 640,
    height: 360,
  });
  assert.deepEqual(negativeSegments.find((segment) => segment.displayId === 1)?.local, {
    x: 0,
    y: 540,
    width: 1920,
    height: 540,
  });

  const lowerScreen: DisplayGeometry = {
    id: 2,
    bounds: { x: 0, y: 1080, width: 1536, height: 864 },
    scaleFactor: 1.25,
    physicalOrigin: { x: 0, y: 1080 },
  };
  const vertical = { x: 960, y: 540, width: 960, height: 1620 };
  const verticalSegments = selectionSegmentsByDisplay(vertical, [leftScreen, lowerScreen]);
  assert.deepEqual(verticalSegments.find((segment) => segment.displayId === 1)?.local, {
    x: 960,
    y: 540,
    width: 960,
    height: 540,
  });
  assert.deepEqual(verticalSegments.find((segment) => segment.displayId === 2)?.local, {
    x: 768,
    y: 0,
    width: 768,
    height: 864,
  });
  assert.equal(chooseAnnotationDisplay(vertical, [leftScreen, lowerScreen]), 2);

  const onlyScreen: DisplayGeometry = {
    id: 7,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    physicalOrigin: { x: 0, y: 0 },
  };
  const singleLocal = { x: 100, y: 80, width: 200, height: 50 };
  const singlePhysical = physicalSelectionOnDisplay(onlyScreen, singleLocal);
  assert.deepEqual(singlePhysical, singleLocal);
  assert.deepEqual(selectionSegmentsByDisplay(singlePhysical!, [onlyScreen]), [
    { displayId: 7, local: singleLocal },
  ]);
  assert.equal(chooseAnnotationDisplay(singlePhysical!, [onlyScreen]), 7);
  assert.deepEqual(annotationFrameOnDisplay(singlePhysical!, onlyScreen), singleLocal);

  const tiedA: DisplayGeometry = {
    id: 11,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    scaleFactor: 1,
    physicalOrigin: { x: 0, y: 0 },
  };
  const tiedB: DisplayGeometry = {
    id: 12,
    bounds: { x: 100, y: 0, width: 100, height: 100 },
    scaleFactor: 1,
    physicalOrigin: { x: 100, y: 0 },
  };
  const tied = { x: 50, y: 0, width: 100, height: 100 };
  assert.equal(chooseAnnotationDisplay(tied, [tiedA, tiedB]), 11);
  assert.equal(chooseAnnotationDisplay(tied, [tiedB, tiedA]), 12);

  const dipHeavy: DisplayGeometry = {
    id: 21,
    bounds: { x: 0, y: 0, width: 200, height: 200 },
    scaleFactor: 1,
    physicalOrigin: { x: 0, y: 0 },
  };
  const pixelHeavy: DisplayGeometry = {
    id: 22,
    bounds: { x: 200, y: 0, width: 100, height: 100 },
    scaleFactor: 3,
    physicalOrigin: { x: 200, y: 0 },
  };
  assert.equal(chooseAnnotationDisplay(
    { x: 0, y: 0, width: 500, height: 300 },
    [dipHeavy, pixelHeavy],
  ), 22);

  const spanned = { x: 1600, y: 100, width: 800, height: 400 };
  assert.deepEqual(localDipSegmentOnDisplay(leftScreen, spanned), {
    x: 1600,
    y: 100,
    width: 320,
    height: 400,
  });
  const spannedRight = localDipSegmentOnDisplay(rightScreen, spanned);
  assert.ok(spannedRight);
  assert.equal(spannedRight.x, 0);
  near(spannedRight.y * rightScreen.scaleFactor, 100);
  assert.equal(spannedRight.width, 320);
  near(spannedRight.height * rightScreen.scaleFactor, 400);
  assert.equal(localDipSegmentOnDisplay(leftScreen, { x: 5000, y: 0, width: 10, height: 10 }), null);
  assert.equal(chooseAnnotationDisplay({ x: 1, y: 1, width: 0, height: 4 }, [leftScreen]), null);

  assert.deepEqual(ScreenshotDragStartSchema.parse({ clientX: 12, clientY: 8 }), {
    clientX: 12,
    clientY: 8,
  });
  assert.equal(ScreenshotDragStartSchema.safeParse({ clientX: Number.NaN, clientY: 1 }).success, false);
  assert.equal(ScreenshotDragCursorSchema.safeParse(undefined).success, true);
  assert.equal(ScreenshotDragCursorSchema.safeParse({ clientX: 40 }).success, true);
  assert.deepEqual(ScreenshotDragCursorSchema.parse({ clientX: 40 }), {});
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

  const hover = { x: 10, y: 20, width: 300, height: 200 };
  assert.deepEqual(chooseAreaSelection({
    startX: 4,
    startY: 5,
    endX: 6,
    endY: 7,
    hover,
  }), hover);
  assert.deepEqual(chooseAreaSelection({
    startX: 0,
    startY: 0,
    endX: 40,
    endY: 18,
    hover,
  }), { x: 0, y: 0, width: 40, height: 18 });
  assert.equal(chooseAreaSelection({
    startX: 1,
    startY: 1,
    endX: 2,
    endY: 2,
    hover: null,
  }), null);

  const html = createScreenshotOverlayHtml();
  assert.match(html, /aria-label="截图选区"/);
  assert.match(html, /Enter 复制/);
  assert.match(html, /Esc 取消/);
  assert.match(html, /矩形/);
  assert.match(html, /箭头/);
  assert.match(html, /文字/);
  assert.match(html, /打码/);
  assert.match(html, /椭圆/);
  assert.match(html, /画笔/);
  assert.match(html, /马赛克/);
  assert.match(html, /撤销/);
  assert.match(html, /id="accept"[^>]*>✓/);
  assert.match(html, /id="dismiss"[^>]*>✕/);
  assert.match(html, /button\.id === 'accept'/);
  assert.match(html, /button\.id === 'dismiss'/);
  assert.match(html, /api\.windowAtPoint/);
  assert.match(html, /const DRAG_THRESHOLD = 6/);
  const toolsBlock = html.slice(html.indexOf('<div id="tools">'), html.indexOf('<div id="hint">'));
  assert.ok(toolsBlock.indexOf('id="accept"') > toolsBlock.indexOf('id="pin"'));
  assert.match(html, /#tools \{[^}]*flex-wrap:\s*wrap/);
  assert.ok(html.indexOf('<div id="hint">') > html.indexOf('<div id="tools">'));
  assert.equal(html.slice(html.indexOf('<div id="tools">'), html.indexOf('<div id="hint">')).includes('id="hint"'), false);
  assert.match(html, /id="editor"/);
  assert.match(html, /输入文字/);
  assert.doesNotMatch(html, /window\.prompt/);
  assert.match(html, /else if \(tool === 'mosaic'\) \{\s*if \(!pixelate\(start, end\)\) return;/);
  assert.doesNotMatch(html, /if \(commit\) pixelate/);
  assert.doesNotMatch(html, /tool === 'mosaic'[\s\S]{0,120}strokeRect/);
  assert.match(html, /function finishAnnotate/);
  assert.match(html, /function beginAnnotate/);
  assert.match(html, /setPointerCapture/);
  assert.match(html, /\(event\.buttons & 1\) === 0/);
  assert.match(html, /if \(drawStart\) \{\s*finishAnnotate\(drawCurrent\);/);
  assert.match(html, /addEventListener\('pointerup'/);
  assert.match(html, /addEventListener\('pointercancel'/);

  const pin = createPinHtml('pin-1', 'pin-1.png');
  assert.match(pin, /src="pin-1.png"/);
  assert.match(pin, /copyPin/);
  assert.match(pin, /savePin/);
  assert.doesNotMatch(pin, /screenshot-pin-image/);
  assert.match(pin, /beginPinDrag/);
  assert.match(pin, /movePin/);
  assert.match(pin, /contextmenu/);
  assert.match(pin, /Escape/);
  assert.match(pin, /Delete/);
  assert.doesNotMatch(pin, /<header/);

  const session = read('src-electron/screenshot-session.ts');
  assert.match(session, /thickFrame:\s*false/);
  assert.match(session, /beginPinnedDrag/);
  assert.match(pin, /鼠标穿透/);
  assert.match(pin, /scalePin/);
  assert.match(pin, /关闭全部/);
  assert.match(session, /loadFile/);
  assert.match(session, /transparent:\s*false/);
  assert.match(session, /copyPinnedScreenshot/);
  assert.match(session, /pinQuickScreenshot/);
  assert.match(session, /scalePinnedScreenshot/);
  assert.match(session, /focusable:\s*true/);
  assert.doesNotMatch(session, /setShape|SetWindowRgn/);
  assert.match(session, /windowSelectionAtClientPoint/);
  assert.match(session, /windowBoundsAtPoint/);
  assert.match(session, /planAreaOverlayWindows/);
  assert.match(session, /physicalSelectionOnDisplay/);
  assert.match(session, /localDipSegmentOnDisplay/);
  assert.match(session, /screen\.dipToScreenPoint\(screen\.getCursorScreenPoint\(\)\)/);
  assert.match(session, /function confirmCrossDisplaySelection/);
  const crossAt = session.indexOf('function confirmCrossDisplaySelection');
  const crossGrab = session.indexOf("grab({ mode: 'region'", crossAt);
  const crossHide = session.lastIndexOf('hideAreaOverlays()', crossGrab);
  assert.ok(crossAt > 0 && crossHide > crossAt && crossGrab > crossHide);
  assert.match(html, /api\.dragMove/);
  assert.match(html, /api\.confirmCross/);
  assert.match(html, /api\.onRemoteSegment/);
  assert.match(session, /bindTrustedDataDocument/);
  const ipc = read('src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  assert.match(ipc, /ScreenshotDragStartSchema\.safeParse/);
  assert.match(ipc, /ScreenshotDragCursorSchema\.safeParse/);
  assert.match(ipc, /reqcase:screenshot:drag-start/);
  assert.match(ipc, /reqcase:screenshot:confirm-cross/);
  assert.match(ipc, /handleTrusted\('reqcase:screenshot:drag-move'/);
  assert.match(ipc, /confirmAreaSelection\(rect, event\.sender\)/);
  assert.match(ipc, /windowSelectionAtClientPoint\(x, y, event\.sender\)/);
  assert.match(session, /function showExcludedFromCapture/);
  assert.match(session, /shouldHideScreenshotUiFromCapture\(readIsRecording\(\), hideScreenshotUiFromCaptureEnabled\(\)\)/);
  assert.match(session, /bindScreenshotRecordingState/);
  assert.match(ipc, /bindScreenshotRecordingState\(\(\) => service\.isRecording\(\)\)/);
  assert.equal(shouldHideScreenshotUiFromCapture(true, true), true);
  assert.equal(shouldHideScreenshotUiFromCapture(true, false), false);
  assert.equal(shouldHideScreenshotUiFromCapture(false, true), false);
  assert.equal(shouldHideScreenshotUiFromCapture(false, false), false);
  assert.match(read('src-react/lib/i18n.ts'), /截图界面不进录像/);
  assert.match(read('src-react/lib/i18n.ts'), /用远程桌面时，如果看不到截图框，请关掉/);
  assert.match(read('src-react/components/RecorderControlPanel.tsx'), /hideScreenshotUiFromCapture !== false/);
  const pinStart = session.indexOf('function openPin');
  const pinEnd = session.indexOf('export async function copyPinnedScreenshot');
  assert.ok(pinStart >= 0 && pinEnd > pinStart);
  assert.doesNotMatch(session.slice(pinStart, pinEnd), /setContentProtection|showExcludedFromCapture/);
  assert.doesNotMatch(read('src-electron/floating-toolbar.ts'), /setContentProtection/);
  assert.doesNotMatch(read('src-electron/main.ts'), /setContentProtection/);
  const hideAt = session.indexOf('window.hide()');
  const grabAt = session.indexOf("grab({ mode: 'region'");
  assert.ok(hideAt >= 0 && grabAt > hideAt, 'region capture must hide the overlay first');

  const parsed = RecorderConfigSchema.parse({
    shortcutCaptureArea: 'CommandOrControl+Shift+A',
    shortcutCaptureMonitor: 'CommandOrControl+Shift+F',
    shortcutCaptureWindow: 'CommandOrControl+Shift+W',
    shortcutCapturePin: 'F3',
  });
  assert.equal(parsed.shortcutCaptureArea, 'CommandOrControl+Shift+A');
  assert.ok(RecorderConfigSchema.shape.shortcutCapturePin);
  assert.ok(RecorderConfigSchema.shape.screenshotDelaySeconds);

  console.log('[screenshot-capture-test] PASS');
}

run();
