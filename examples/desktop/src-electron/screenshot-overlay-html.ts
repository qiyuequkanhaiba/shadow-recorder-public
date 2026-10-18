export function createScreenshotOverlayHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; cursor: crosshair; }
    #dim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); }
    #box { position: fixed; display: none; border: 2px solid #ffffff; box-sizing: border-box; }
    #shot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
    #hint { position: absolute; left: 0; top: calc(100% + 8px); white-space: nowrap; color: #fff; background: rgba(0, 0, 0, 0.72); border-radius: 6px; padding: 4px 8px; font: 12px/1.4 sans-serif; }
  </style>
</head>
<body>
  <div id="dim"></div>
  <div id="box" role="img" aria-label="截图选区">
    <img id="shot" alt="" />
    <div id="hint" hidden>Enter 复制 · Ctrl+S 保存 · Esc 取消</div>
  </div>
  <script>
    const api = window.screenshotOverlay;
    const box = document.getElementById('box');
    const hint = document.getElementById('hint');
    const shot = document.getElementById('shot');
    let drag = null;
    let frozen = false;
    let pending = false;

    function paint(rect) {
      if (!rect) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.left = rect.x + 'px';
      box.style.top = rect.y + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
    }

    function normalize(x1, y1, x2, y2) {
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      if (width < 2 || height < 2) return null;
      return { x, y, width, height };
    }

    window.addEventListener('mousedown', (event) => {
      if (frozen || pending || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, cx: event.clientX, cy: event.clientY };
      paint(normalize(drag.x, drag.y, drag.cx, drag.cy));
    });
    window.addEventListener('mousemove', (event) => {
      if (!drag || frozen) return;
      drag.cx = event.clientX;
      drag.cy = event.clientY;
      paint(normalize(drag.x, drag.y, drag.cx, drag.cy));
    });
    window.addEventListener('mouseup', async (event) => {
      if (!drag || frozen || pending || event.button !== 0) return;
      const rect = normalize(drag.x, drag.y, event.clientX, event.clientY);
      drag = null;
      if (!rect) {
        paint(null);
        return;
      }
      pending = true;
      const result = await api.confirmSelection(rect);
      pending = false;
      if (!result || !result.ok) {
        paint(rect);
        hint.hidden = false;
        hint.textContent = (result && result.message) || '截图失败';
        return;
      }
      frozen = true;
      paint({ x: result.dipX, y: result.dipY, width: result.dipWidth, height: result.dipHeight });
      shot.src = 'data:image/png;base64,' + result.pngBase64;
      hint.hidden = false;
      hint.textContent = 'Enter 复制 · Ctrl+S 保存 · Esc 取消';
    });
    window.addEventListener('keydown', async (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        await api.cancel();
        return;
      }
      if (!frozen) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        await api.copyFrozen();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await api.saveFrozen();
      }
    });
  </script>
</body>
</html>`;
}
