export function createScreenshotOverlayHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; cursor: crosshair; }
    #dim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); }
    #box { position: fixed; display: none; border: 2px solid #ffffff; box-sizing: border-box; }
    #draw { display: none; width: 100%; height: 100%; }
    #tools { position: absolute; left: 0; top: calc(100% + 8px); display: flex; gap: 6px; }
    #tools button, #hint { color: #fff; background: rgba(0, 0, 0, 0.72); border: 0; border-radius: 6px; padding: 4px 8px; font: 12px/1.4 sans-serif; }
    #hint { position: absolute; left: 0; top: calc(100% + 40px); white-space: nowrap; }
    #tools button[data-active="true"] { outline: 1px solid #fff; }
  </style>
</head>
<body>
  <div id="dim"></div>
  <div id="box" role="img" aria-label="截图选区">
    <canvas id="draw"></canvas>
    <div id="tools" hidden>
      <button type="button" data-tool="rect" data-active="true">矩形</button>
      <button type="button" data-tool="arrow">箭头</button>
      <button type="button" data-tool="text">文字</button>
      <button type="button" data-tool="censor">打码</button>
      <button type="button" id="pin">贴在屏幕上</button>
    </div>
    <div id="hint" hidden>Enter 复制 · Ctrl+S 保存 · Esc 取消</div>
  </div>
  <script>
    const api = window.screenshotOverlay;
    const box = document.getElementById('box');
    const hint = document.getElementById('hint');
    const tools = document.getElementById('tools');
    const canvas = document.getElementById('draw');
    const ctx = canvas.getContext('2d');
    let drag = null;
    let drawStart = null;
    let frozen = false;
    let pending = false;
    let tool = 'rect';
    let snapshot = null;

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
      tools.hidden = false;
      hint.hidden = false;
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
      if (pending || event.button !== 0 || event.target.closest('#tools')) return;
      if (frozen) {
        drawStart = bitmapPoint(event);
        if (tool !== 'text') remember();
        return;
      }
      drag = { x: event.clientX, y: event.clientY, cx: event.clientX, cy: event.clientY };
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
        hint.hidden = false;
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
    #n { width: 140px; height: 140px; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(0, 0, 0, 0.72); border-radius: 16px; font: 64px/1 sans-serif; }
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
    html, body { margin: 0; background: #111; color: #fff; }
    header { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font: 12px/1 sans-serif; }
    button { color: #fff; background: transparent; border: 0; }
    img { display: block; width: 100%; height: calc(100vh - 28px); object-fit: contain; }
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
