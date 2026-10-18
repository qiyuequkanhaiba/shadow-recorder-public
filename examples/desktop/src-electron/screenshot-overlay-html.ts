export function createScreenshotOverlayHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; cursor: crosshair; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    #dim { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.38); }
    #box { position: fixed; display: none; border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.85), 0 12px 40px rgba(0, 0, 0, 0.18); box-sizing: border-box; }
    #draw { display: none; width: 100%; height: 100%; }
    #size { position: absolute; right: 8px; bottom: 8px; padding: 3px 8px; border-radius: 999px; color: #fff; background: rgba(15, 23, 42, 0.82); font: 12px/1.4 sans-serif; letter-spacing: 0.02em; }
    #chrome { position: absolute; left: 0; top: calc(100% + 10px); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    #tools { display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 12px; background: rgba(15, 23, 42, 0.88); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28); }
    #tools button, #hint { color: #e2e8f0; background: transparent; border: 0; border-radius: 8px; padding: 6px 10px; font: 12px/1.4 sans-serif; cursor: pointer; }
    #tools button:hover { background: rgba(255, 255, 255, 0.08); }
    #tools button[data-active="true"] { color: #fff; background: #0284c7; }
    #pin { margin-left: 4px; background: rgba(255, 255, 255, 0.08); }
    #hint { padding: 4px 8px; border-radius: 999px; color: #cbd5e1; background: rgba(15, 23, 42, 0.82); white-space: nowrap; }
  </style>
</head>
<body>
  <div id="dim"></div>
  <div id="box" role="img" aria-label="截图选区">
    <canvas id="draw"></canvas>
    <div id="size" hidden></div>
    <div id="chrome" hidden>
      <div id="tools">
        <button type="button" data-tool="rect" data-active="true">矩形</button>
        <button type="button" data-tool="arrow">箭头</button>
        <button type="button" data-tool="text">文字</button>
        <button type="button" data-tool="censor">打码</button>
        <button type="button" id="pin">贴在屏幕上</button>
      </div>
      <div id="hint">Enter 复制 · Ctrl+S 保存 · Esc 取消</div>
    </div>
  </div>
  <script>
    const api = window.screenshotOverlay;
    const box = document.getElementById('box');
    const hint = document.getElementById('hint');
    const chrome = document.getElementById('chrome');
    const tools = document.getElementById('tools');
    const size = document.getElementById('size');
    const canvas = document.getElementById('draw');
    const ctx = canvas.getContext('2d');
    let drag = null;
    let drawStart = null;
    let frozen = false;
    let pending = false;
    let tool = 'rect';
    let snapshot = null;

    function placeChrome() {
      const rect = box.getBoundingClientRect();
      const chromeHeight = 78;
      const chromeWidth = 360;
      const below = window.innerHeight - rect.bottom;
      if (below < chromeHeight && rect.top > chromeHeight) {
        chrome.style.top = 'auto';
        chrome.style.bottom = 'calc(100% + 10px)';
      } else {
        chrome.style.top = 'calc(100% + 10px)';
        chrome.style.bottom = 'auto';
      }
      if (rect.left + chromeWidth > window.innerWidth) {
        chrome.style.left = 'auto';
        chrome.style.right = '0';
        chrome.style.alignItems = 'flex-end';
      } else {
        chrome.style.left = '0';
        chrome.style.right = 'auto';
        chrome.style.alignItems = 'flex-start';
      }
    }

    function paint(rect) {
      if (!rect) {
        box.style.display = 'none';
        size.hidden = true;
        return;
      }
      box.style.display = 'block';
      box.style.left = rect.x + 'px';
      box.style.top = rect.y + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      size.hidden = false;
      size.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
      placeChrome();
    }

    function normalize(x1, y1, x2, y2) {
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      if (width < 2 || height < 2) return null;
      return { x, y, width, height };
    }

    function bitmapPoint(event) {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - bounds.left) * canvas.width / Math.max(1, bounds.width),
        y: (event.clientY - bounds.top) * canvas.height / Math.max(1, bounds.height),
      };
    }

    function remember() {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function restore() {
      if (snapshot) ctx.putImageData(snapshot, 0, 0);
    }

    function strokeShape(start, end, commit) {
      restore();
      ctx.strokeStyle = '#ff3b30';
      ctx.fillStyle = '#ff3b30';
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      if (tool === 'censor') {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        ctx.fillStyle = '#000';
        ctx.fillRect(x, y, Math.abs(end.x - start.x), Math.abs(end.y - start.y));
      } else if (tool === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = Math.max(10, Math.hypot(end.x - start.x, end.y - start.y) * 0.18);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle - 0.45), end.y - head * Math.sin(angle - 0.45));
        ctx.lineTo(end.x - head * Math.cos(angle + 0.45), end.y - head * Math.sin(angle + 0.45));
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      }
      if (commit) remember();
    }

    function showFrozen(result) {
      frozen = true;
      paint({ x: result.dipX, y: result.dipY, width: result.dipWidth, height: result.dipHeight });
      const image = new Image();
      image.onload = () => {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.style.display = 'block';
        ctx.drawImage(image, 0, 0);
        remember();
      };
      image.src = 'data:image/png;base64,' + result.pngBase64;
      chrome.hidden = false;
      hint.textContent = 'Enter 复制 · Ctrl+S 保存 · Esc 取消';
    }

    async function pngBase64() {
      if (!frozen || !canvas.width) return undefined;
      const url = canvas.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    }

    tools.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      event.stopPropagation();
      if (button.id === 'pin') {
        await api.pinFrozen(await pngBase64());
        return;
      }
      tool = button.dataset.tool || 'rect';
      for (const item of tools.querySelectorAll('[data-tool]')) {
        item.dataset.active = item === button ? 'true' : 'false';
      }
    });

    window.addEventListener('mousedown', (event) => {
      if (pending || event.button !== 0 || event.target.closest('#chrome')) return;
      if (frozen) {
        drawStart = bitmapPoint(event);
        if (tool !== 'text') remember();
        return;
      }
      drag = { x: event.clientX, y: event.clientY, cx: event.clientX, cy: event.clientY };
      chrome.hidden = true;
      paint(normalize(drag.x, drag.y, drag.cx, drag.cy));
    });
    window.addEventListener('mousemove', (event) => {
      if (frozen && drawStart && tool !== 'text') {
        strokeShape(drawStart, bitmapPoint(event), false);
        return;
      }
      if (!drag || frozen) return;
      drag.cx = event.clientX;
      drag.cy = event.clientY;
      paint(normalize(drag.x, drag.y, drag.cx, drag.cy));
    });
    window.addEventListener('mouseup', async (event) => {
      if (frozen && drawStart && event.button === 0) {
        const end = bitmapPoint(event);
        if (tool === 'text') {
          const value = window.prompt('文字', '');
          if (value) {
            ctx.fillStyle = '#ff3b30';
            ctx.font = Math.max(16, Math.round(canvas.width / 28)) + 'px sans-serif';
            ctx.fillText(value, end.x, end.y);
            remember();
          }
        } else {
          strokeShape(drawStart, end, true);
        }
        drawStart = null;
        return;
      }
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
        chrome.hidden = false;
        hint.textContent = (result && result.message) || '截图失败';
        return;
      }
      showFrozen(result);
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
        await api.copyFrozen(await pngBase64());
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await api.saveFrozen(await pngBase64());
      }
    });
  </script>
</body>
</html>`;
}

export function createCountdownHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
    #n { width: 140px; height: 140px; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(15, 23, 42, 0.88); border-radius: 28px; box-shadow: 0 0 0 8px rgba(2, 132, 199, 0.28), 0 16px 40px rgba(0, 0, 0, 0.28); font: 64px/1 sans-serif; }
  </style>
</head>
<body>
  <div id="n" aria-label="截图倒计时">3</div>
  <script>
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.screenshotOverlay.cancelDelay();
      }
    });
  </script>
</body>
</html>`;
}

export function createPinHtml(id: string, pngBase64: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    header { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font: 12px/1 sans-serif; background: #111827; -webkit-app-region: drag; }
    button { color: #e2e8f0; background: transparent; border: 0; border-radius: 6px; padding: 2px 8px; -webkit-app-region: no-drag; cursor: pointer; }
    button:hover { background: rgba(255, 255, 255, 0.08); }
    img { display: block; width: 100%; height: calc(100vh - 28px); object-fit: contain; background: #020617; }
  </style>
</head>
<body>
  <header><span>截图</span><button type="button" id="close">关闭</button></header>
  <img alt="贴在屏幕上的截图" src="data:image/png;base64,${pngBase64}" />
  <script>
    document.getElementById('close').addEventListener('click', () => {
      window.screenshotOverlay.closePin(${JSON.stringify(id)});
    });
  </script>
</body>
</html>`;
}
