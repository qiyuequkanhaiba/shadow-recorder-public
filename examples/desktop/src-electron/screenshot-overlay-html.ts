export function createScreenshotOverlayHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; cursor: crosshair; user-select: none; -webkit-user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    #dim { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.38); }
    #box { position: fixed; display: none; border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.85), 0 12px 40px rgba(0, 0, 0, 0.18); box-sizing: border-box; }
    #draw { display: none; width: 100%; height: 100%; touch-action: none; -webkit-user-drag: none; }
    #size { position: absolute; right: 8px; bottom: 8px; padding: 3px 8px; border-radius: 999px; color: #fff; background: rgba(15, 23, 42, 0.82); font: 12px/1.4 sans-serif; letter-spacing: 0.02em; pointer-events: none; }
    #editor { position: absolute; z-index: 5; display: none; min-width: 120px; max-width: 280px; padding: 4px 8px; border: 1px solid #fff; border-radius: 8px; background: rgba(15, 23, 42, 0.94); color: #fff; caret-color: #fff; font: 16px/1.4 sans-serif; outline: none; cursor: text; user-select: text; -webkit-user-select: text; }
    #chrome { position: absolute; left: 0; top: calc(100% + 10px); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    #tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; width: max-content; max-width: calc(100vw - 16px); padding: 4px; border-radius: 12px; background: rgba(15, 23, 42, 0.88); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28); box-sizing: border-box; }
    #colors { display: flex; align-items: center; flex: 0 0 auto; flex-wrap: nowrap; gap: 4px; margin-left: 2px; }
    #colors button { width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
    #tools button { flex: 0 0 auto; color: #e2e8f0; background: transparent; border: 0; border-radius: 8px; padding: 6px 8px; font: 12px/1.4 sans-serif; cursor: pointer; white-space: nowrap; }
    #tools button:hover { background: rgba(255, 255, 255, 0.08); }
    #tools button[data-active="true"] { color: #fff; background: #0284c7; }
    #colors button[data-active="true"] { border-color: #fff; }
    #pin { margin-left: 4px; background: rgba(255, 255, 255, 0.08); }
    #accept, #dismiss { font: 16px/1 sans-serif; min-width: 28px; }
    #accept { color: #4ade80; }
    #dismiss { color: #f87171; }
    #hint { padding: 4px 8px; border-radius: 999px; color: #cbd5e1; background: rgba(15, 23, 42, 0.82); font: 12px/1.4 sans-serif; white-space: nowrap; }
  </style>
</head>
<body>
  <div id="dim"></div>
  <div id="box" role="img" aria-label="截图选区">
    <canvas id="draw"></canvas>
    <div id="size" hidden></div>
    <input id="editor" type="text" aria-label="输入文字" placeholder="输入文字，Enter 确认" />
    <div id="chrome" hidden>
      <div id="tools">
        <button type="button" data-tool="rect" data-active="true">矩形</button>
        <button type="button" data-tool="ellipse">椭圆</button>
        <button type="button" data-tool="line">直线</button>
        <button type="button" data-tool="arrow">箭头</button>
        <button type="button" data-tool="pen">画笔</button>
        <button type="button" data-tool="text">文字</button>
        <button type="button" data-tool="mosaic">马赛克</button>
        <button type="button" data-tool="censor">打码</button>
        <button type="button" id="undo">撤销</button>
        <button type="button" id="pin">贴在屏幕上</button>
        <div id="colors">
          <button type="button" data-color="#ff3b30" data-active="true" style="background:#ff3b30" aria-label="红色"></button>
          <button type="button" data-color="#ffcc00" style="background:#ffcc00" aria-label="黄色"></button>
          <button type="button" data-color="#34c759" style="background:#34c759" aria-label="绿色"></button>
          <button type="button" data-color="#0a84ff" style="background:#0a84ff" aria-label="蓝色"></button>
          <button type="button" data-color="#ffffff" style="background:#ffffff" aria-label="白色"></button>
        </div>
        <button type="button" id="accept" title="复制" aria-label="复制">✓</button>
        <button type="button" id="dismiss" title="取消" aria-label="取消">✕</button>
      </div>
      <div id="hint">Enter 复制 · Ctrl+S 保存 · Ctrl+Z 撤销 · Esc 取消</div>
    </div>
  </div>
  <script>
    const api = window.screenshotOverlay;
    const box = document.getElementById('box');
    const hint = document.getElementById('hint');
    const chrome = document.getElementById('chrome');
    const tools = document.getElementById('tools');
    const size = document.getElementById('size');
    const editor = document.getElementById('editor');
    const canvas = document.getElementById('draw');
    const ctx = canvas.getContext('2d');
    let drag = null;
    let freeDrag = false;
    let hoverRect = null;
    let hoverToken = 0;
    let hoverPending = false;
    let hoverQueued = null;
    const DRAG_THRESHOLD = 6;
    let dragToken = 0;
    let remoteHold = false;
    let drawStart = null;
    let drawCurrent = null;
    let drawHeld = false;
    let frozen = false;
    let pending = false;
    const colors = document.getElementById('colors');
    let tool = 'rect';
    let color = '#ff3b30';
    let snapshot = null;
    let history = [];
    let editing = null;
    let penLast = null;
    let pendingEditor = null;
    let baseReady = false;

    function placeChrome() {
      const rect = box.getBoundingClientRect();
      if (!chrome.hidden) {
        tools.style.width = 'max-content';
        const contentWidth = tools.offsetWidth;
        const limit = Math.max(180, Math.min(Math.round(rect.width) || contentWidth, window.innerWidth - 16));
        tools.style.width = contentWidth > limit ? limit + 'px' : 'max-content';
      }
      const chromeHeight = chrome.offsetHeight || 84;
      const chromeWidth = chrome.offsetWidth || Math.round(rect.width) || 320;
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

    async function refreshHover(x, y) {
      if (!api.windowAtPoint || frozen || drag || remoteHold) return;
      hoverQueued = { x, y };
      if (hoverPending) return;
      hoverPending = true;
      while (hoverQueued && !frozen && !drag && !remoteHold) {
        const point = hoverQueued;
        hoverQueued = null;
        const token = ++hoverToken;
        let rect = null;
        try {
          rect = await api.windowAtPoint(point.x, point.y);
        } catch (error) {
          rect = null;
        }
        if (token !== hoverToken || frozen || drag) break;
        hoverRect = rect && rect.width >= 2 && rect.height >= 2 ? rect : null;
        if (!drag) paint(hoverRect);
      }
      hoverPending = false;
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
      if (rect.pixelWidth && rect.pixelHeight) {
        size.textContent = Math.round(rect.pixelWidth) + ' × ' + Math.round(rect.pixelHeight);
      }
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
      if (!canvas.width) return;
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function commitHistory() {
      remember();
      if (!snapshot) return;
      history.push(snapshot);
      if (history.length > 20) history.shift();
    }

    function undo() {
      if (history.length < 2) return;
      history.pop();
      snapshot = history[history.length - 1];
      ctx.putImageData(snapshot, 0, 0);
    }

    function pixelate(start, end) {
      const x = Math.max(0, Math.floor(Math.min(start.x, end.x)));
      const y = Math.max(0, Math.floor(Math.min(start.y, end.y)));
      const width = Math.min(canvas.width - x, Math.ceil(Math.abs(end.x - start.x)));
      const height = Math.min(canvas.height - y, Math.ceil(Math.abs(end.y - start.y)));
      if (width < 4 || height < 4) return false;
      const block = Math.max(8, Math.round(Math.min(width, height) / 12));
      const image = ctx.getImageData(x, y, width, height);
      const data = image.data;
      for (let by = 0; by < height; by += block) {
        for (let bx = 0; bx < width; bx += block) {
          const origin = (by * width + bx) * 4;
          const red = data[origin];
          const green = data[origin + 1];
          const blue = data[origin + 2];
          const alpha = data[origin + 3];
          for (let iy = 0; iy < block && by + iy < height; iy += 1) {
            for (let ix = 0; ix < block && bx + ix < width; ix += 1) {
              const pixel = ((by + iy) * width + (bx + ix)) * 4;
              data[pixel] = red;
              data[pixel + 1] = green;
              data[pixel + 2] = blue;
              data[pixel + 3] = alpha;
            }
          }
        }
      }
      ctx.putImageData(image, x, y);
      return true;
    }

    function restore() {
      if (snapshot) ctx.putImageData(snapshot, 0, 0);
    }

    function commitText() {
      if (!editing) return;
      const value = editor.value.trim();
      const point = editing;
      editing = null;
      editor.style.display = 'none';
      editor.value = '';
      if (!value || !canvas.width) return;
      const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      ctx.fillStyle = color;
      ctx.font = Math.max(16, Math.round(16 * scale)) + 'px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(value, point.x, point.y);
      commitHistory();
    }

    function openTextEditor(point) {
      const canvasRect = canvas.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const scaleX = canvasRect.width / Math.max(1, canvas.width);
      const scaleY = canvasRect.height / Math.max(1, canvas.height);
      editing = point;
      editor.value = '';
      editor.style.display = 'block';
      editor.style.left = (canvasRect.left - boxRect.left + point.x * scaleX) + 'px';
      editor.style.top = (canvasRect.top - boxRect.top + point.y * scaleY) + 'px';
      editor.focus();
      setTimeout(() => editor.focus(), 0);
    }

    function strokeShape(start, end, commit) {
      restore();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.lineCap = 'round';
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = end.x - start.x;
      const height = end.y - start.y;
      if (tool === 'censor') {
        ctx.fillStyle = '#000';
        ctx.fillRect(x, y, Math.abs(width), Math.abs(height));
      } else if (tool === 'mosaic') {
        if (!pixelate(start, end)) return;
      } else if (tool === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(x + Math.abs(width) / 2, y + Math.abs(height) / 2, Math.max(1, Math.abs(width) / 2), Math.max(1, Math.abs(height) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
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
        ctx.strokeRect(start.x, start.y, width, height);
      }
      if (commit) commitHistory();
    }

    function finishAnnotate(end) {
      if (!drawStart) return;
      const start = drawStart;
      const point = end || drawCurrent || start;
      const activeTool = tool;
      drawStart = null;
      drawCurrent = null;
      drawHeld = false;
      penLast = null;
      if (activeTool === 'text') {
        if (baseReady) openTextEditor(point);
        else pendingEditor = point;
        return;
      }
      if (activeTool === 'pen') {
        commitHistory();
        return;
      }
      strokeShape(start, point, true);
    }

    function beginAnnotate(event) {
      if (drawStart) {
        finishAnnotate(drawCurrent);
        return;
      }
      event.preventDefault();
      drawHeld = false;
      drawStart = bitmapPoint(event);
      drawCurrent = drawStart;
      penLast = drawStart;
      if (tool !== 'text') remember();
    }

    function previewAnnotate(point) {
      drawCurrent = point;
      if (tool === 'pen' && penLast) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, canvas.width / 400);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(penLast.x, penLast.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        penLast = point;
        return;
      }
      if (tool !== 'text') strokeShape(drawStart, point, false);
    }

    function showFrozen(result) {
      frozen = true;
      paint({
        x: result.dipX,
        y: result.dipY,
        width: result.dipWidth,
        height: result.dipHeight,
        pixelWidth: result.pixelWidth,
        pixelHeight: result.pixelHeight,
      });
      const image = new Image();
      image.onload = () => {
        if (baseReady) return;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.style.display = 'block';
        ctx.drawImage(image, 0, 0);
        commitHistory();
        baseReady = true;
        if (pendingEditor) {
          openTextEditor(pendingEditor);
          pendingEditor = null;
        }
      };
      image.src = 'data:image/png;base64,' + result.pngBase64;
      chrome.hidden = false;
      hint.textContent = 'Enter 复制 · Ctrl+S 保存 · Ctrl+Z 撤销 · Esc 取消';
      placeChrome();
    }

    async function pngBase64() {
      if (!frozen || !canvas.width) return undefined;
      const url = canvas.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    }

    chrome.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      event.stopPropagation();
      if (editing) commitText();
      if (button.id === 'accept') {
        if (editing) commitText();
        await api.copyFrozen(await pngBase64());
        return;
      }
      if (button.id === 'dismiss') {
        await api.cancel();
        return;
      }
      if (button.id === 'pin') {
        await api.pinFrozen(await pngBase64());
        return;
      }
      if (button.id === 'undo') {
        undo();
        return;
      }
      if (button.dataset.color) {
        color = button.dataset.color;
        for (const item of colors.querySelectorAll('[data-color]')) {
          item.dataset.active = item === button ? 'true' : 'false';
        }
        return;
      }
      if (!button.dataset.tool) return;
      tool = button.dataset.tool;
      for (const item of tools.querySelectorAll('[data-tool]')) {
        item.dataset.active = item === button ? 'true' : 'false';
      }
    });

    function annotationHost(event) {
      const target = event.target;
      if (!target || target === editor) return null;
      if (target.closest && target.closest('#chrome')) return null;
      return target.closest ? target : canvas;
    }

    window.addEventListener('pointerdown', (event) => {
      if (!frozen || pending || event.button !== 0) return;
      const host = annotationHost(event);
      if (!host || !host.setPointerCapture) return;
      try { host.setPointerCapture(event.pointerId); } catch { /* The pointer can already be gone. */ }
    }, true);
    window.addEventListener('pointerup', (event) => {
      if (!frozen || !drawStart) return;
      if (event.button !== 0 && (event.buttons & 1) !== 0) return;
      finishAnnotate(bitmapPoint(event));
    }, true);
    window.addEventListener('pointercancel', (event) => {
      if (!frozen || !drawStart) return;
      finishAnnotate(bitmapPoint(event));
    }, true);
    window.addEventListener('dragstart', (event) => {
      if (frozen) event.preventDefault();
    });
    window.addEventListener('blur', () => {
      if (frozen && drawStart) finishAnnotate(drawCurrent);
    });
    window.addEventListener('mousedown', (event) => {
      if (pending || event.button !== 0 || event.target === editor) return;
      if (editing) commitText();
      if (event.target.closest('#chrome')) return;
      if (frozen) {
        beginAnnotate(event);
        return;
      }
      drag = { x: event.clientX, y: event.clientY, cx: event.clientX, cy: event.clientY };
      freeDrag = false;
      remoteHold = false;
      chrome.hidden = true;
      if (api.dragStart) void api.dragStart(event.clientX, event.clientY);
    });
    window.addEventListener('mousemove', (event) => {
      if (frozen && drawStart) {
        const point = bitmapPoint(event);
        if ((event.buttons & 1) === 1) {
          drawHeld = true;
          previewAnnotate(point);
          return;
        }
        if ((event.buttons & 1) === 0 && drawHeld) {
          if (tool === 'pen') previewAnnotate(point);
          finishAnnotate(point);
        }
        return;
      }
      if (!drag || frozen) {
        if (!frozen && !drag && !remoteHold) void refreshHover(event.clientX, event.clientY);
        return;
      }
      drag.cx = event.clientX;
      drag.cy = event.clientY;
      if (!freeDrag && Math.hypot(drag.cx - drag.x, drag.cy - drag.y) >= DRAG_THRESHOLD) {
        freeDrag = true;
      }
      if (!freeDrag) return;
      const local = normalize(drag.x, drag.y, drag.cx, drag.cy);
      if (!api.dragMove) {
        paint(local);
        return;
      }
      const token = ++dragToken;
      void api.dragMove().then((preview) => {
        if (token !== dragToken || !drag || frozen) return;
        if (preview && preview.cross) {
          paint(preview.local
            ? Object.assign({}, preview.local, {
              pixelWidth: preview.pixelWidth,
              pixelHeight: preview.pixelHeight,
            })
            : null);
          return;
        }
        paint(local);
      }).catch(() => {});
    });
    window.addEventListener('mouseup', async (event) => {
      if (frozen && drawStart && (event.button === 0 || (event.buttons & 1) === 0)) {
        finishAnnotate(bitmapPoint(event));
        return;
      }
      if (!drag || frozen || pending || event.button !== 0) return;
      const wasFree = freeDrag;
      const origin = drag;
      const endX = event.clientX;
      const endY = event.clientY;
      drag = null;
      freeDrag = false;
      dragToken += 1;
      const rect = wasFree ? normalize(origin.x, origin.y, endX, endY) : hoverRect;
      if (wasFree && api.dragMove && api.confirmCross) {
        pending = true;
        let preview = null;
        try {
          preview = await api.dragMove();
        } catch (error) {
          preview = null;
        }
        if (preview && preview.cross) {
          let crossed = null;
          try {
            crossed = await api.confirmCross();
          } catch (error) {
            pending = false;
            paint(rect);
            chrome.hidden = false;
            hint.textContent = '截图失败';
            placeChrome();
            return;
          }
          if (crossed && crossed.ok) {
            pending = false;
            if (crossed.showHere === false) {
              paint(null);
              return;
            }
            showFrozen(crossed);
            return;
          }
          if (crossed && crossed.cross !== false) {
            pending = false;
            paint(rect || (preview.local
              ? Object.assign({}, preview.local, {
                pixelWidth: preview.pixelWidth,
                pixelHeight: preview.pixelHeight,
              })
              : null));
            chrome.hidden = false;
            hint.textContent = (crossed && crossed.message) || '截图失败';
            placeChrome();
            return;
          }
        }
        pending = false;
      }
      if (!rect) {
        paint(hoverRect);
        return;
      }
      pending = true;
      const result = await api.confirmSelection(rect);
      pending = false;
      if (!result || !result.ok) {
        paint(rect);
        chrome.hidden = false;
        hint.textContent = (result && result.message) || '截图失败';
        placeChrome();
        return;
      }
      showFrozen(result);
    });
    editor.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commitText();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        editing = null;
        editor.style.display = 'none';
        editor.value = '';
      }
    });
    window.addEventListener('keydown', async (event) => {
      if (editing || event.target === editor) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        await api.cancel();
        return;
      }
      if (!frozen) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        await api.copyFrozen(await pngBase64());
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await api.saveFrozen(await pngBase64());
      }
    });
    if (api.onPinRequest) {
      api.onPinRequest(async () => {
        if (!frozen) return;
        await api.pinFrozen(await pngBase64());
      });
    }
    if (api.onRemoteSegment) {
      api.onRemoteSegment((segment) => {
        if (drag || frozen || pending) return;
        remoteHold = Boolean(segment);
        paint(segment);
      });
    }
    if (api.onShowFrozen) {
      api.onShowFrozen((result) => {
        if (!result || !result.ok || frozen) return;
        remoteHold = false;
        showFrozen(result);
      });
    }
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

export function createPinHtml(id: string, imageName: string): string {
  const pinId = JSON.stringify(id);
  const imageSrc = imageName.replace(/[^A-Za-z0-9._-]/g, '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111111; cursor: grab; user-select: none; }
    body.is-dragging { cursor: grabbing; }
    img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
    #menu { position: fixed; z-index: 2; min-width: 148px; padding: 4px; border-radius: 10px; background: rgba(15, 23, 42, 0.94); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); }
    #menu button { display: block; width: 100%; text-align: left; color: #e2e8f0; background: transparent; border: 0; border-radius: 6px; padding: 6px 8px; font: 12px/1.4 sans-serif; cursor: pointer; }
    #menu button:hover { background: rgba(255, 255, 255, 0.08); }
  </style>
</head>
<body>
  <img id="shot" src="${imageSrc}" alt="贴在屏幕上的截图" title="拖动移动，滚轮缩放，右键打开菜单" />
  <div id="menu" hidden>
    <button type="button" data-act="copy">复制</button>
    <button type="button" data-act="save">另存为</button>
    <button type="button" data-act="reset">还原大小</button>
    <button type="button" data-act="through">鼠标穿透</button>
    <button type="button" data-act="close">关闭</button>
    <button type="button" data-act="close-all">关闭全部</button>
  </div>
  <script>
    const api = window.screenshotOverlay;
    const id = ${pinId};
    const menu = document.getElementById('menu');
    let dragging = false;
    function hideMenu() {
      menu.hidden = true;
    }
    function showMenu(x, y) {
      menu.hidden = false;
      menu.style.left = '0px';
      menu.style.top = '0px';
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - width)) + 'px';
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - height)) + 'px';
    }
    window.addEventListener('mousedown', (event) => {
      if (event.button === 2) {
        event.preventDefault();
        return;
      }
      if (menu.contains(event.target)) return;
      hideMenu();
      if (event.button !== 0) return;
      dragging = true;
      document.body.classList.add('is-dragging');
      api.beginPinDrag(id, event.screenX, event.screenY);
    });
    window.addEventListener('mousemove', (event) => {
      if (event.ctrlKey) api.setPinClickThrough(id, false);
      if (!dragging) return;
      api.movePin(id, event.screenX, event.screenY);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-dragging');
      api.endPinDrag(id);
    });
    window.addEventListener('wheel', (event) => {
      event.preventDefault();
      api.scalePin(id, event.deltaY, event.screenX, event.screenY);
    }, { passive: false });
    window.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY);
    });
    menu.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const action = button.dataset.act;
      hideMenu();
      if (action === 'copy') await api.copyPin(id);
      else if (action === 'save') await api.savePin(id);
      else if (action === 'reset') api.resetPin(id);
      else if (action === 'through') api.setPinClickThrough(id, true);
      else if (action === 'close') api.closePin(id);
      else if (action === 'close-all') api.closeAllPins();
    });
    window.addEventListener('keydown', async (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        hideMenu();
        return;
      }
      if (event.key === 'Escape' || event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        api.closePin(id);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        await api.copyPin(id);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await api.savePin(id);
      }
    });
  </script>
</body>
</html>`;
}
