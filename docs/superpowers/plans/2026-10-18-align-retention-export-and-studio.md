# 对齐切片保留、导出进度与工作室时间轴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 0.1.17 的导出进度、工作室时间轴和滚出切片保留，与当前代码已经承诺的行为一致，并补回明文默认的守卫测试。

**Architecture:** 导出完成、失败、取消只由主进程发一条终态进度，渲染进程按这条事件显示唯一通知。工作室按「保留段数 + 直播环形窗口」加载切片，上限 2000，不再把已保留的旧切片裁成 72 段。切片搬移跳过仍可能被 ffmpeg 占用的新文件，缺失文件从索引里去掉，已有视频在搬移失败时不删除。

**Tech Stack:** Rust（`src/session/ffmpeg_loop_runtime.rs`）、Electron 主进程 IPC、React 工作室快照、tsx 脚本测试。

## Global Constraints

- 语义明文默认保持 `false`：`DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED` 不得改成 `true`。
- 证据 ZIP 继续只含合成视频、`events.json`、`operations.json`。不要把 `evidence.html`、`manifest.json`、`sha256-manifest.json` 加回去。
- 不修改 `release-notes-0.1.17.md` 里已有的安装包 SHA-256 和源码哈希。
- 悬浮窗保持 `focusable: false`。不要恢复 `window.setShape` 或 Win32 `SetWindowRgn`。
- 工作室和历史页的切片上限都是 2000，与 native `history_retention_max_segments` 的生产上限一致。
- 界面文案使用简体中文。
- 永久搬移失败时不删除已经写好的 mp4。

## 非目标

- 不重写 `docs/测试会话循环录制与事件时间线技术设计.md` 全文。
- 不为 age 模式超过 2000 段的历史做虚拟滚动。
- 不去掉 `trim_segments_to_window` 里 `cfg!(test)` 的段数下限旁路。

## 文件职责

- `examples/desktop/src-electron/export-progress.ts`：进度状态机。保证完成之后的旧百分比不会把导出重新标成进行中，也保证新的一次导出能从完成态重新开始。
- `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`：唯一向外发送终态进度的地方。
- `examples/desktop/src-electron/modules/reqcase-shadow-recorder/evidence-export.ts`：成功返回前发出 100%。
- `examples/desktop/src-electron/floating-toolbar.ts`：只根据终态改按钮和进度线，不再弹第二条文案。
- `examples/desktop/src-react/pages/RecorderPage.tsx`：主窗口上的唯一导出通知。
- `examples/desktop/src-react/lib/studio-segment-window.ts`：工作室切片窗口大小。
- `examples/desktop/src-react/hooks/useRecorderDashboardSnapshot.ts`：按这个窗口加载，不再写死 72。
- `src/session/ffmpeg_loop_runtime.rs`：搬移时跳过未稳定文件，丢掉缺失文件。
- `src/types.rs`：恢复明文缺省关闭测试。
- `release-notes-0.1.17.md` 与两份旧设计文档：只加当前行为说明，不改历史正文。

---

### Task 1: 导出进度有终态，且只有一条通知

**Files:**
- Create: `examples/desktop/src-electron/export-progress.ts`
- Create: `examples/desktop/scripts/export-progress-test.ts`
- Modify: `examples/desktop/package.json`（在 `test:evidence-export` 旁新增脚本）
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/evidence-export.ts`（两个成功 `return` 之前）
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts:963-1029`
- Modify: `examples/desktop/src-electron/preload.ts:168-170`
- Modify: `examples/desktop/src-electron/floating-toolbar.ts:1479-1550`
- Modify: `examples/desktop/src-react/pages/RecorderPage.tsx:128-152` 与 `395-423`
- Modify: `examples/desktop/src-react/features/evidence/HistorySessionPanel.tsx:250-278`
- Modify: `examples/desktop/scripts/evidence-export-test.ts`（现有 directory 导出断言之后）
- Test: `examples/desktop/scripts/export-progress-test.ts`

**Interfaces:**
- Consumes: 现有 `onProgress?: (progress: EvidenceExportProgress) => void`
- Produces:
  - `export type ExportProgressStatus = 'running' | 'complete' | 'canceled' | 'failed'`
  - `export type ExportProgressEvent = { attemptId: number; percent: number; message: string; status: ExportProgressStatus }`
  - `export type ExportProgressState = { attemptId: number; phase: 'idle' | ExportProgressStatus; percent: number; message: string }`
  - `export function reduceExportProgress(state: ExportProgressState, event: ExportProgressEvent): { state: ExportProgressState; emit: boolean }`
  - `export const IDLE_EXPORT_PROGRESS: ExportProgressState`

- [ ] **Step 1: Write the failing test**

创建 `examples/desktop/scripts/export-progress-test.ts`：

```ts
import assert from 'node:assert/strict';
import {
  IDLE_EXPORT_PROGRESS,
  reduceExportProgress,
  type ExportProgressEvent,
} from '../src-electron/export-progress.ts';

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
```

在 `examples/desktop/package.json` 的 `test:evidence-export` 下一行加入：

```json
"test:export-progress": "tsx scripts/export-progress-test.ts",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd examples/desktop && npx tsx scripts/export-progress-test.ts`

Expected: FAIL，`Cannot find module '../src-electron/export-progress.ts'`。

- [ ] **Step 3: Write minimal implementation**

创建 `examples/desktop/src-electron/export-progress.ts`。同一次导出共享 `attemptId`。完成后同一序号的迟到进度丢掉；下一次点击使用新序号，即使百分比从 8 重新开始也要接受。

```ts
export type ExportProgressStatus = 'running' | 'complete' | 'canceled' | 'failed';

export type ExportProgressEvent = {
  attemptId: number;
  percent: number;
  message: string;
  status: ExportProgressStatus;
};

export type ExportProgressState = {
  attemptId: number;
  phase: 'idle' | ExportProgressStatus;
  percent: number;
  message: string;
};

export const IDLE_EXPORT_PROGRESS: ExportProgressState = {
  attemptId: 0,
  phase: 'idle',
  percent: 0,
  message: '',
};

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function reduceExportProgress(
  state: ExportProgressState,
  event: ExportProgressEvent,
): { state: ExportProgressState; emit: boolean } {
  const percent = clampPercent(event.percent);
  if (event.attemptId < state.attemptId) {
    return { state, emit: false };
  }

  const sameAttempt = event.attemptId === state.attemptId;
  const terminal = state.phase === 'complete' || state.phase === 'canceled' || state.phase === 'failed';
  if (sameAttempt && terminal && event.status === 'running') {
    return { state, emit: false };
  }
  if (sameAttempt && state.phase === 'running' && event.status === 'running' && percent < state.percent) {
    return { state, emit: false };
  }

  return {
    state: {
      attemptId: event.attemptId,
      phase: event.status,
      percent,
      message: event.message,
    },
    emit: true,
  };
}
```

在 `exportTestSessionEvidence` 的 zip 成功分支 `return { sessionId: ... outputMode,` 之前，以及 directory 成功 `return` 之前，各加一行：

```ts
onProgress?.({ percent: 100, message: '已完成导出' });
```

`EvidenceExportProgress` 先保持 `{ percent; message }`。终态 `status` 由 IPC 包装，避免这个函数在抛错时发出完成。

在 `ipc.ts` 模块顶层保存进度状态。每次进入 `exportTestSessionEvidence` 处理函数时取一个新的 `attemptId`。同一序号的迟到进度会被丢掉，下一次点击因为序号更大而重新开始。文件顶部增加：

```ts
import {
  IDLE_EXPORT_PROGRESS,
  reduceExportProgress,
  type ExportProgressEvent,
  type ExportProgressState,
} from '../../export-progress';

let exportProgressState: ExportProgressState = IDLE_EXPORT_PROGRESS;
let nextExportAttemptId = 0;
```

处理函数开头：

```ts
const attemptId = ++nextExportAttemptId;
const emitProgress = (event: Omit<ExportProgressEvent, 'attemptId'>) => {
  const reduced = reduceExportProgress(exportProgressState, { ...event, attemptId });
  exportProgressState = reduced.state;
  if (!reduced.emit) {
    return;
  }
  reportProgress({
    percent: reduced.state.percent,
    message: reduced.state.message,
    phase: reduced.state.phase,
  });
};
```

现有 `reportProgress({ percent: 8, message: '正在准备导出' })` 改成：

```ts
emitProgress({ percent: 8, message: '正在准备导出', status: 'running' });
```

`service.exportSessionEvidence(..., reportProgress)` 改成传入适配器：

```ts
(progress) => emitProgress({
  percent: progress.percent,
  message: progress.message,
  status: progress.percent >= 100 ? 'complete' : 'running',
}),
```

两个导出调用都用 `try/catch` 包住。成功路径已经会通过适配器发出 `complete`。`catch` 里：

```ts
const message = error instanceof Error ? error.message : String(error);
const canceled = /cancel/i.test(message);
emitProgress({
  percent: 0,
  message: canceled ? '已取消导出' : '导出失败',
  status: canceled ? 'canceled' : 'failed',
});
throw error;
```

`preload.ts` 的进度类型改为：

```ts
onExportProgress?: (
  handler: (progress: { percent: number; message: string; phase: 'idle' | 'running' | 'complete' | 'canceled' | 'failed' }) => void,
) => () => void;
```

主进程 `reportProgress` 发送的对象使用 `phase` 字段，值来自 `reduced.state.phase`。渲染端不要再根据 `percent < 100` 推断仍在导出。

`RecorderPage.tsx` 的订阅改为：

```ts
const unsubscribe = window.reqcaseShadowRecorder.onExportProgress?.((progress) => {
  if (progress.phase === 'complete') {
    showToast(progress.message || '已完成导出', 'success');
    return;
  }
  if (progress.phase === 'canceled') {
    showToast(progress.message || '已取消导出', 'info');
    return;
  }
  if (progress.phase === 'failed') {
    showToast(progress.message || '导出失败', 'error');
    return;
  }
  showToast(progress.message, 'progress', progress.percent);
});
```

`handleExportCurrentSession` 的 `try` 成功分支删掉 `showToast('已导出：...')`。`catch` 里删掉取消和失败的 `showToast`，只保留 `setBusy(false)`。进度监听负责唯一通知。

`HistorySessionPanel.exportSession` 同样删掉成功、取消、失败三处 `props.onNotice`。`setBusy` 和 `setIsExporting` 保留。

`floating-toolbar.ts` 的 `onExportProgress` 改为：

```js
api.onExportProgress((progress) => {
  const phase = progress.phase || (progress.percent >= 100 ? 'complete' : 'running');
  if (phase === 'running') {
    isExporting = true;
    if (buttons.export) buttons.export.disabled = true;
    setExportButtonState('exporting', progress.percent + '% ' + progress.message);
  } else if (phase === 'complete') {
    isExporting = false;
    selfExporting = false;
    setExportButtonState('exported', '已完成导出');
  } else if (phase === 'canceled') {
    isExporting = false;
    selfExporting = false;
    setExportButtonState('idle');
  } else {
    isExporting = false;
    selfExporting = false;
    setExportButtonState('error', progress.message || '导出失败');
  }
  if (exportProgressFill) {
    exportProgressFill.style.width = (phase === 'canceled' || phase === 'failed')
      ? '0%'
      : Math.max(0, Math.min(100, progress.percent)) + '%';
  }
  if (statusToast) {
    statusToast.classList.remove('is-visible');
  }
});
```

`runExport` 的 `try/catch` 不再调用 `setExportButtonState`。按钮状态只走上面的监听。`finally` 只把 `selfExporting = false`，并调用 `refresh()`。不要在 `finally` 里把 `isExporting` 强行写成 `false`，否则终态事件晚到时会闪回可点击，随后又被失败事件盖住。监听收到终态时已经写过 `isExporting`。

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd examples/desktop
npx tsx scripts/export-progress-test.ts
npm run test:evidence-export
npm run test:floating-toolbar
```

在 `evidence-export-test.ts` 的 directory 成功调用上传入：

```ts
const progressEvents: Array<{ percent: number; message: string }> = [];
```

以及 `onProgress: (progress) => progressEvents.push(progress)`。断言：

```ts
assert.equal(progressEvents.at(-1)?.percent, 100);
assert.equal(progressEvents.at(-1)?.message, '已完成导出');
```

Expected: 三个命令都 PASS。`test:floating-toolbar` 若因 HTML 字符串断言失败，只补它实际检查的按钮 class，不要改悬浮窗几何。

- [ ] **Step 5: Commit**

```bash
git add examples/desktop/src-electron/export-progress.ts \
  examples/desktop/scripts/export-progress-test.ts \
  examples/desktop/package.json \
  examples/desktop/src-electron/modules/reqcase-shadow-recorder/evidence-export.ts \
  examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts \
  examples/desktop/src-electron/preload.ts \
  examples/desktop/src-electron/floating-toolbar.ts \
  examples/desktop/src-react/pages/RecorderPage.tsx \
  examples/desktop/src-react/features/evidence/HistorySessionPanel.tsx \
  examples/desktop/scripts/evidence-export-test.ts
git commit -m "$(cat <<'EOF'
fix: finish export progress with one terminal notice

EOF
)"
```

---

### Task 2: 工作室时间轴覆盖保留窗口

**Files:**
- Create: `examples/desktop/src-react/lib/studio-segment-window.ts`
- Create: `examples/desktop/scripts/studio-segment-window-test.ts`
- Modify: `examples/desktop/package.json`
- Modify: `examples/desktop/src-react/hooks/useRecorderDashboardSnapshot.ts:13` 与 `253-291`
- Modify: `examples/desktop/src-react/features/evidence/HistorySessionPanel.tsx:72-74`
- Modify: `examples/desktop/types/contracts.ts:271-296`
- Test: `examples/desktop/scripts/studio-segment-window-test.ts`

**Interfaces:**
- Consumes: `TestSessionState.bufferWindowSeconds`、`segmentDurationSeconds`，以及会话上的 `historyRetentionMode` / `historyRetentionMaxSegments`
- Produces:
  - `export const STUDIO_SEGMENT_LIMIT = 2000`
  - `export function resolveStudioSegmentLimit(session: StudioSegmentWindowInput | null | undefined): number`

- [ ] **Step 1: Write the failing test**

创建 `examples/desktop/scripts/studio-segment-window-test.ts`：

```ts
import assert from 'node:assert/strict';
import { resolveStudioSegmentLimit, STUDIO_SEGMENT_LIMIT } from '../src-react/lib/studio-segment-window.ts';

assert.equal(STUDIO_SEGMENT_LIMIT, 2000);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 30,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'count',
  historyRetentionMaxSegments: 200,
}), 206);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 600,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'count',
  historyRetentionMaxSegments: 2000,
}), 2000);

assert.equal(resolveStudioSegmentLimit({
  bufferWindowSeconds: 30,
  segmentDurationSeconds: 5,
  historyRetentionMode: 'age',
  historyRetentionHours: 24,
}), 2000);

assert.ok(resolveStudioSegmentLimit(null) > 72);

console.log('studio-segment-window-test passed');
```

`package.json` 增加：

```json
"test:studio-segment-window": "tsx scripts/studio-segment-window-test.ts",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd examples/desktop && npx tsx scripts/studio-segment-window-test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

创建 `examples/desktop/src-react/lib/studio-segment-window.ts`：

```ts
export const STUDIO_SEGMENT_LIMIT = 2000;

export type StudioSegmentWindowInput = {
  bufferWindowSeconds?: number;
  segmentDurationSeconds?: number;
  historyRetentionMode?: 'age' | 'count' | string;
  historyRetentionMaxSegments?: number;
};

function liveSegmentCount(bufferWindowSeconds: number, segmentDurationSeconds: number): number {
  const duration = Math.max(1, Math.trunc(segmentDurationSeconds) || 1);
  const windowSeconds = Math.max(duration, Math.trunc(bufferWindowSeconds) || duration);
  const quotient = Math.floor(windowSeconds / duration);
  const remainder = windowSeconds % duration;
  return Math.max(1, quotient + (remainder > 0 ? 1 : 0));
}

export function resolveStudioSegmentLimit(session?: StudioSegmentWindowInput | null): number {
  const live = liveSegmentCount(session?.bufferWindowSeconds ?? 30, session?.segmentDurationSeconds ?? 5);
  if (session?.historyRetentionMode === 'age') {
    return STUDIO_SEGMENT_LIMIT;
  }
  const retained = Math.max(10, Math.min(STUDIO_SEGMENT_LIMIT, Math.trunc(session?.historyRetentionMaxSegments ?? 200) || 200));
  return Math.min(STUDIO_SEGMENT_LIMIT, live + retained);
}
```

默认 `null` 会话：live = ceil(30/5) = 6，retained = 200，结果 206。测试 `> 72` 通过。count 模式 200 段、30 秒窗口、5 秒切片：live = 6，合计 206。2000 段保留加 600 秒窗口会被截到 2000。age 模式直接 2000。

在 `TestSessionState` 增加可选字段：

```ts
historyRetentionMode?: 'age' | 'count';
historyRetentionHours?: number;
historyRetentionMaxSegments?: number;
```

`useRecorderDashboardSnapshot.ts` 删除 `const SESSION_SEGMENT_LIMIT = 72`。导入 `resolveStudioSegmentLimit`。`loadSegments` 在请求前计算：

```ts
const playbackSessionForLimit = sessions.find((session) => session.sessionId === sessionId) ?? null;
const segmentLimit = resolveStudioSegmentLimit(playbackSessionForLimit);
```

`loadSegments` 目前拿不到 `sessions`。把 `sessionsRef` 已有的话直接用；若没有，给 `loadSegments` 增加参数 `segmentLimit: number`，由调用处用 `nextPlaybackSession` 计算后传入。三处 `SESSION_SEGMENT_LIMIT` 全部换成这个参数。

`HistorySessionPanel.tsx` 的 `limit: 2000` 改为 `limit: STUDIO_SEGMENT_LIMIT`。

- [ ] **Step 4: Run tests**

Run:

```bash
cd examples/desktop
npx tsx scripts/studio-segment-window-test.ts
npm run test:recorder-page-bindings
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add examples/desktop/src-react/lib/studio-segment-window.ts \
  examples/desktop/scripts/studio-segment-window-test.ts \
  examples/desktop/package.json \
  examples/desktop/src-react/hooks/useRecorderDashboardSnapshot.ts \
  examples/desktop/src-react/features/evidence/HistorySessionPanel.tsx \
  examples/desktop/types/contracts.ts
git commit -m "$(cat <<'EOF'
fix: show retained segments on the studio timeline

EOF
)"
```

---

### Task 3: 搬移失败时不再把缺失文件留在直播窗口

**Files:**
- Modify: `src/session/ffmpeg_loop_runtime.rs:1185-1263`
- Modify: `src/session/ffmpeg_loop_runtime.rs` 的 `test_trim_move_fails_keeps_source`
- Test: `cargo test --lib history_retention_tests -- --test-threads=8`

**Interfaces:**
- Consumes: `trim_segments_to_window(session, session_dir, segments, max_segments)`
- Produces: 同一函数。缺失源文件的切片从 `segments` 删除。修改时间距离现在不足 2 秒的源文件留在原路径，且 `retention_tier` 仍是 `None`。稳定文件仍按原逻辑 `rename` 到 `video/retained`。

- [ ] **Step 1: Write the failing test**

把 `test_trim_move_fails_keeps_source` 改成缺失文件必须离开索引：

```rust
#[test]
fn test_trim_missing_file_drops_segment() {
    let temp_dir = unique_temp_dir("shadowrecord-test-missing");
    let session_dir = temp_dir.join("session");
    let mut session = mock_session();
    session.session_dir = Some(session_dir.to_string_lossy().to_string());
    session.history_retention_mode = Some("count".to_string());

    let file_path = session_dir.join("1.mp4");
    let mut segments = vec![mock_segment(
        "seg-1",
        "test-stream",
        1000,
        Some(file_path.to_string_lossy().into()),
    )];

    super::trim_segments_to_window(&session, &session_dir, &mut segments, 0).unwrap();

    assert!(segments.is_empty());
    let _ = fs::remove_dir_all(&temp_dir);
}
```

在它后面新增未稳定文件测试。`mock_segment` 已接受 `file_path`。创建文件后把修改时间设成现在：

```rust
#[test]
fn test_trim_skips_unstable_live_file() {
    let temp_dir = unique_temp_dir("shadowrecord-test-unstable");
    let session_dir = temp_dir.join("session");
    fs::create_dir_all(&session_dir).unwrap();
    let mut session = mock_session();
    session.session_dir = Some(session_dir.to_string_lossy().to_string());
    session.history_retention_mode = Some("count".to_string());
    session.history_retention_max_segments = Some(10);

    let file_path = session_dir.join("fresh.mp4");
    fs::write(&file_path, b"fresh").unwrap();
    let mut segments = vec![mock_segment(
        "seg-fresh",
        "test-stream",
        now_timestamp_ms(),
        Some(file_path.to_string_lossy().into()),
    )];

    super::trim_segments_to_window(&session, &session_dir, &mut segments, 0).unwrap();

    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].retention_tier, None);
    assert!(file_path.exists());
    let retained = session_dir.join("video").join("retained").join("test-stream").join("fresh.mp4");
    assert!(!retained.exists());
    let _ = fs::remove_dir_all(&temp_dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib test_trim_missing_file_drops_segment -- --test-threads=8`

Expected: FAIL。当前实现保留这条缺失切片，`segments.len()` 仍是 1。

- [ ] **Step 3: Write minimal implementation**

在 `trim_segments_to_window` 顶部增加：

```rust
const RETAIN_MOVE_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(2);

fn source_file_is_stable(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return true;
    };
    modified.elapsed().map(|age| age >= RETAIN_MOVE_MIN_AGE).unwrap_or(true)
}
```

搬移循环里，`create_dir_all` 成功后：

```rust
if !old_path.exists() {
    seg.retention_tier = Some("missing".to_string());
    continue;
}
if !source_file_is_stable(old_path) {
    continue;
}
```

循环结束后、按保留策略删除之前，去掉缺失切片：

```rust
let mut missing = Vec::new();
for (idx, seg) in segments.iter().enumerate() {
    if seg.retention_tier.as_deref() == Some("missing") {
        missing.push(idx);
    }
}
for idx in missing.into_iter().rev() {
    segments.remove(idx);
}
```

稳定文件的 `rename` 成功路径保持不变。`rename` 失败时不设置 `retained`，不删除源文件。

`test_trim_move_fails_keeps_source` 删除，由上面两个测试代替。不要让缺失文件继续断言 `retention_tier == None`。

- [ ] **Step 4: Run tests**

Run: `cargo test --lib history_retention_tests -- --test-threads=8`

Expected: PASS，包含 `test_trim_missing_file_drops_segment`、`test_trim_skips_unstable_live_file` 和原有 `test_recover_keeps_retained_segments`。

- [ ] **Step 5: Commit**

```bash
git add src/session/ffmpeg_loop_runtime.rs
git commit -m "$(cat <<'EOF'
fix: keep the live segment window bounded when retain moves fail

EOF
)"
```

---

### Task 4: 恢复语义明文缺省关闭测试

**Files:**
- Modify: `src/types.rs`，紧挨 `config_mapping_defaults_capture_reuse_enabled`
- Test: `cargo test --lib config_mapping_defaults_semantic_plaintext_capture_to_opt_in -- --test-threads=8`

**Interfaces:**
- Consumes: `JsRecorderConfig::default()` 与 `From<JsRecorderConfig> for RecorderConfig`
- Produces: 测试 `config_mapping_defaults_semantic_plaintext_capture_to_opt_in`

- [ ] **Step 1: Write the failing test**

在 `config_mapping_defaults_capture_reuse_enabled` 后面加入。先临时把断言写成 `assert!(config.semantic_plaintext_input_enabled)`，确认测试文件能编译并失败；随即改回下面的正确断言。正确断言在当前代码上会直接通过，所以这一步的失败信号用这条临时断言制造，不要改产品默认值。

正确测试正文：

```rust
#[test]
fn config_mapping_defaults_semantic_plaintext_capture_to_opt_in() {
    let default_config: crate::config::RecorderConfig = JsRecorderConfig {
        semantic_plaintext_input_enabled: None,
        ..JsRecorderConfig::default()
    }
    .into();
    assert!(!default_config.semantic_plaintext_input_enabled);

    let opt_in_config: crate::config::RecorderConfig = JsRecorderConfig {
        semantic_plaintext_input_enabled: Some(true),
        ..JsRecorderConfig::default()
    }
    .into();
    assert!(opt_in_config.semantic_plaintext_input_enabled);
}
```

- [ ] **Step 2: Run the temporary failing assertion**

把 `assert!(!default_config.semantic_plaintext_input_enabled)` 临时换成 `assert!(default_config.semantic_plaintext_input_enabled)`。

Run: `cargo test --lib config_mapping_defaults_semantic_plaintext_capture_to_opt_in -- --test-threads=8`

Expected: FAIL，断言默认值为 `true`。然后立刻改回 `assert!(!...)`。

- [ ] **Step 3: Keep the production default**

确认 `src/config.rs` 中 `DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED` 仍是 `false`。不要为了让临时断言通过而修改它。

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib config_mapping_defaults_semantic_plaintext_capture_to_opt_in -- --test-threads=8`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/types.rs
git commit -m "$(cat <<'EOF'
test: guard semantic plaintext opt-in default

EOF
)"
```

---

### Task 5: 把对外说明改到当前实现

**Files:**
- Modify: `release-notes-0.1.17.md`（在「内容」一节末尾追加，不改已有哈希）
- Modify: `docs/测试会话循环录制与事件时间线技术设计.md`（标题下插入现状说明）
- Modify: `docs/v2-implementation-blueprint.md`（标题下插入现状说明）

**Interfaces:**
- Consumes: Task 1 到 Task 4 落地后的行为
- Produces: 三份文档里都能搜到 `当前实现（2026-10-18）`

- [ ] **Step 1: 写出现状，再核对旧句还在**

`docs/测试会话循环录制与事件时间线技术设计.md` 第一段之前插入：

```markdown
> 当前实现（2026-10-18）：循环视频已经由 ffmpeg segment 写出 mp4。滚出环形窗口的切片会挪到 `video/retained`，默认按最近 200 段保留，也可以按 1 到 168 小时保留。主工作室时间轴加载「保留段数 + 直播窗口」，最多 2000 段。下文关于「仓库没有视频编码链路」的句子是 2026 年初的设计背景，不是当前代码。
```

`docs/v2-implementation-blueprint.md` 标题下插入：

```markdown
> 当前实现（2026-10-18）：这份蓝图停在 2026-02-10。桌面端现在是 0.1.17 的工作室工作台，不再是当时的 Demo。下面的 Phase 状态不要当作当前进度。
```

`release-notes-0.1.17.md` 的「内容」列表末尾追加，不要改上面的 SHA-256：

```markdown
• 滚出环形窗口的录像切片会保留到 video/retained，可按段数或小时清理
• 主工作室时间轴显示保留窗口内的切片，不再只保留最新 72 段
• 历史回放和语义步骤分开打开
• 会话 ZIP 只包含合成视频、events.json 和 operations.json
• 导出进度会收到完成、取消或失败终态，主窗口只显示一条通知
• 语义明文采集默认仍然关闭
```

- [ ] **Step 2: 核对旧目标句没有被删掉，新说明已经出现**

Run:

```bash
rg -n "当前实现（2026-10-18）" docs/测试会话循环录制与事件时间线技术设计.md docs/v2-implementation-blueprint.md release-notes-0.1.17.md
rg -n "没有视频编码" docs/测试会话循环录制与事件时间线技术设计.md
rg -n "69bad1a4ff0f04e2b4e5675b8143ef23c4faded52ef167f0448a0073fdc6bc19" release-notes-0.1.17.md
```

Expected: 第一行三份文件都有匹配。第二行旧背景句仍在。第三行原安装包哈希仍在。

- [ ] **Step 3: Commit**

```bash
git add release-notes-0.1.17.md \
  docs/测试会话循环录制与事件时间线技术设计.md \
  docs/v2-implementation-blueprint.md
git commit -m "$(cat <<'EOF'
docs: record the 0.1.17 behavior next to the old goals

EOF
)"
```

## 验收清单

- [ ] 主窗口或历史页导出成功后，进度通知变成「已完成导出」并在约 2.6 秒后消失。
- [ ] 同一时刻悬浮条只有进度线和按钮状态，没有第二条文案。
- [ ] 导出成功、取消、失败之后，悬浮条导出按钮恢复可点；取消不会把按钮留在「正在导出」。
- [ ] 迟到的 93% 事件不会在完成后把按钮再次禁用。
- [ ] 默认保留 200 段时，主工作室能看到这 200 段加上当前直播窗口，而不是只看到 72 段。
- [ ] age 模式工作室最多加载 2000 段，和历史页相同。
- [ ] 源文件已经不存在的切片不会留在直播索引里。
- [ ] 刚写完不到 2 秒的 mp4 不会被搬进 `video/retained`，2 秒后再刷新仍会按原策略搬移。
- [ ] 搬移失败时源 mp4 还在。
- [ ] `semantic_plaintext_input_enabled` 缺省映射结果是 `false`，显式 `true` 仍然打开。
- [ ] 证据 ZIP 仍然没有 `manifest.json` 和 `sha256-manifest.json`。
- [ ] 发布说明里的两个安装包 SHA-256 字节不变。

## Self-Review

- 审查里的四项代码问题和一项文档漂移都有对应任务。
- 进度状态机用 `attemptId` 区分同一次导出的迟到进度和下一次导出的 8%。单靠百分比无法区分这两件事。
- 工作室上限公式与 Rust `compute_max_segments` 的进位方式一致：有余数则加 1，至少 1 段。
- 没有把精简 ZIP 或明文默认值改回去。
