import {
  createMockSession,
  createMockVideoSegment,
  installMockShadowRecorderBridge,
} from './test-env';
import { strict as assert } from 'node:assert';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CONFIG } from '../../src-react/lib/tuning-advisor';
import { STUDIO_SEGMENT_LIMIT } from '../../src-react/lib/studio-segment-window';
import { RecorderPlaybackStage } from '../../src-react/components/RecorderPlaybackStage';
import { HistorySessionPanel } from '../../src-react/features/evidence/HistorySessionPanel';
import type { TestSessionState, TestSessionVideoSegment } from '../../types/contracts';

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}

const sampleSession: TestSessionState = createMockSession({
  sessionId: 'session-player-1',
  name: '播放器测试会话',
  status: 'stopped',
});

const sampleSegment: TestSessionVideoSegment = createMockVideoSegment({
  segmentId: 'seg-player-1',
  sessionId: 'session-player-1',
});

async function testWorkbenchPlayerStates(): Promise<void> {
  installMockShadowRecorderBridge();

  const baseProps = {
    isRecording: false,
    isPaused: false,
    metrics: null,
    resourceUsage: null,
    activeSession: null,
    playbackSession: sampleSession,
    videoStreams: [],
    recentSegments: [] as TestSessionVideoSegment[],
    matchedSegments: [] as TestSessionVideoSegment[],
    playbackFocus: null,
    timelineEvents: [],
    config: DEFAULT_CONFIG,
    onNotice: () => {},
    onMarked: () => {},
    onPlaybackFocusChange: () => {},
    onExportSession: async () => {},
    isExporting: false,
    onClearEvents: async () => {},
  };

  // 1. P5 首次数据加载中：当前会话还没有片段列表且 loading === true 时，显示独立加载提示，不显示空状态或失败
  const { rerender, container } = render(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      loading: true,
      recentSegments: [],
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('正在读取录像切片…'));
  assert.equal(screen.queryByText('暂无可回放录像'), null);
  assert.equal(screen.queryByText('正在写入当前切片'), null);
  assert.equal(screen.queryByText('当前录像加载失败'), null);

  // 加载完成无片段：显示「暂无可回放录像」，清除加载提示
  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      loading: false,
      recentSegments: [],
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('暂无可回放录像'));
  assert.equal(screen.queryByText('正在读取录像切片…'), null);
  assert.equal(screen.queryByText('正在写入当前切片'), null);

  // 后台刷新：已有画面时再次 loading === true 不替换当前画面（仍显示「暂无可回放录像」，不被加载提示遮盖）
  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      loading: true,
      recentSegments: [],
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('暂无可回放录像'));
  assert.equal(screen.queryByText('正在读取录像切片…'), null);

  // 2. 录制写入中：仅在 isRecording && !isPaused 时显示「正在写入当前切片」
  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      isRecording: true,
      isPaused: false,
      activeSession: { ...sampleSession, status: 'active' },
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('正在写入当前切片'));

  // 暂停时不显示「正在写入当前切片」
  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      isRecording: true,
      isPaused: true,
      activeSession: { ...sampleSession, status: 'paused' },
    }),
  );
  await flushMicrotasks();

  assert.equal(screen.queryByText('正在写入当前切片'), null);

  // 3. 正常播放与加载失败：有可播片段时渲染 <video>，触发 onError 后显示「当前录像加载失败」
  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      isRecording: false,
      isPaused: false,
      recentSegments: [sampleSegment],
    }),
  );
  await flushMicrotasks();

  const videoEl = container.querySelector('video');
  assert.ok(videoEl, 'workbench should render <video> when playable segment exists');

  await act(async () => {
    fireEvent.error(videoEl);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('当前录像加载失败'));
  assert.equal(screen.queryByText('暂无可回放录像'), null);

  // 4. 清除失败：onLoadedMetadata 清掉播放错误
  await act(async () => {
    fireEvent.loadedMetadata(videoEl);
  });
  await flushMicrotasks();

  assert.equal(screen.queryByText('当前录像加载失败'), null);

  // 再次触发错误后，进入录制写入中也会清掉错误
  await act(async () => {
    fireEvent.error(videoEl);
  });
  await flushMicrotasks();
  assert.ok(screen.getByText('当前录像加载失败'));

  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      isRecording: true,
      isPaused: false,
      activeSession: { ...sampleSession, status: 'active' },
      recentSegments: [],
    }),
  );
  await flushMicrotasks();

  assert.equal(screen.queryByText('当前录像加载失败'), null);
  assert.ok(screen.getByText('正在写入当前切片'));

  // 5. P5 作用域与遥测状态条按需渲染
  assert.ok(container.querySelector('[data-ui-scope="workbench"]'), 'workbench should have data-ui-scope="workbench"');
  assert.equal(screen.queryByLabelText('实时核心指标'), null, 'telemetry bar should only render when data exists');

  rerender(
    React.createElement(RecorderPlaybackStage, {
      ...baseProps,
      isRecording: true,
      isPaused: false,
      activeSession: { ...sampleSession, status: 'active' },
      resourceUsage: { totalWorkingSetMb: 128 } as any,
    }),
  );
  await flushMicrotasks();
  assert.ok(screen.getByLabelText('实时核心指标'), 'telemetry bar should render when metrics or resourceUsage exists');

  cleanup();
}

async function testReviewPlayerStates(): Promise<void> {
  // 1. 数据加载中：「正在读取录像切片…」
  let resolveSegments!: (segments: TestSessionVideoSegment[]) => void;
  const bridge = installMockShadowRecorderBridge({
    sessions: [sampleSession],
    videoSegments: [],
  });
  bridge.overrides.getTestSessionVideoSegments = () =>
    new Promise<TestSessionVideoSegment[]>((resolve) => {
      resolveSegments = resolve;
    });

  const { rerender, container } = render(
    React.createElement(HistorySessionPanel, {
      session: sampleSession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );

  assert.ok(screen.getByText('正在读取录像切片…'));

  // 2. 非写入中无片段：「当前会话没有可播放的视频切片。」
  await act(async () => {
    resolveSegments([]);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('当前会话没有可播放的视频切片。'));
  assert.equal(screen.queryByText('暂无可回放录像'), null);

  // 3. 正在录制或暂停且无片段：「正在写入当前切片，已封口的片段将在此就绪。」
  delete bridge.overrides.getTestSessionVideoSegments;
  bridge.setVideoSegments([]);

  rerender(
    React.createElement(HistorySessionPanel, {
      session: { ...sampleSession, sessionId: 'session-live-writing', status: 'active' },
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('正在写入当前切片，已封口的片段将在此就绪。'));

  // 4. 正常播放与 P0 现况（当前回顾页 <video> 没有 onError）
  bridge.setVideoSegments([sampleSegment]);
  rerender(
    React.createElement(HistorySessionPanel, {
      session: sampleSession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  const videoEl = container.querySelector('video');
  assert.ok(videoEl, 'review panel should render <video> when playable segment exists');

  await act(async () => {
    fireEvent.error(videoEl);
  });
  await flushMicrotasks();

  // P4 回顾页具备 onError：触发 error 后出现加载失败提示
  assert.ok(screen.getByText('当前录像加载失败'));

  // 成功加载元数据（如切换片段）后清除加载失败错误
  await act(async () => {
    fireEvent.loadedMetadata(videoEl);
  });
  await flushMicrotasks();

  assert.equal(screen.queryByText('当前录像加载失败'), null);

  cleanup();
}

async function testReviewPlayerSegmentPlaybackRangeLimitAndErrorReset(): Promise<void> {
  const seg1 = createMockVideoSegment({
    segmentId: 'seg-1',
    sessionId: 'session-seg-range',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000010000,
    durationMs: 10000,
  });
  const seg2 = createMockVideoSegment({
    segmentId: 'seg-2',
    sessionId: 'session-seg-range',
    startedAtMs: 1700000010000,
    endedAtMs: 1700000020000,
    durationMs: 10000,
  });
  const seg3 = createMockVideoSegment({
    segmentId: 'seg-3',
    sessionId: 'session-seg-range',
    startedAtMs: 1700000020000,
    endedAtMs: 1700000030000,
    durationMs: 10000,
  });
  const unplayableSeg = createMockVideoSegment({
    segmentId: 'seg-bad',
    sessionId: 'session-seg-range',
    startedAtMs: 1700000030000,
    endedAtMs: 1700000040000,
    durationMs: 10000,
    isPlayable: false,
    playbackUrl: undefined,
  });

  const multiSession = createMockSession({
    sessionId: 'session-seg-range',
    name: '多切片会话',
    status: 'stopped',
  });
  const emptySession = createMockSession({
    sessionId: 'session-empty',
    name: '空切片会话',
    status: 'stopped',
  });

  const bridge = installMockShadowRecorderBridge({
    sessions: [multiSession, emptySession],
    videoSegments: [seg1, seg2, seg3, unplayableSeg],
  });

  const { rerender, container } = render(
    React.createElement(HistorySessionPanel, {
      session: multiSession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  // Issue #6: Uses STUDIO_SEGMENT_LIMIT (2000) instead of hardcoded 100
  const segCalls = bridge.callsFor('getTestSessionVideoSegments');
  assert.equal((segCalls[0]?.args[0] as { limit?: number })?.limit, STUDIO_SEGMENT_LIMIT);

  // Issue #7a: Unplayable segment is filtered out (3 playable chips instead of 4)
  assert.match(screen.getByTitle('视频切片总数').textContent ?? '', /3\s*个切片/);
  assert.equal(screen.queryByRole('button', { name: /#4/ }), null);

  // Issue #4: Clicking segment #2 sets src to seg-2 and calls play() on seg-2 (not seg-1)
  const videoEl = container.querySelector('video')!;
  const playedSrcs: string[] = [];
  const origPlay = videoEl.play.bind(videoEl);
  videoEl.play = async function spyPlay() {
    playedSrcs.push(videoEl.getAttribute('src') ?? videoEl.src);
    return origPlay();
  };

  const chip2 = screen.getByRole('button', { name: /#2/ });
  await act(async () => {
    fireEvent.click(chip2);
  });
  await flushMicrotasks();

  assert.match(videoEl.src, /seg-2/);
  assert.ok(playedSrcs.some((src) => src.includes('seg-2')), `expected play() on seg-2, got: ${JSON.stringify(playedSrcs)}`);

  // Issue #5: Shift-select range #1 - #2 stops at #2 on ended and preserves #1 - #2 export range
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /#1/ }));
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /#2/ }), { shiftKey: true });
  });
  await flushMicrotasks();

  // Ends #1 -> auto-advances to #2
  await act(async () => {
    fireEvent.ended(videoEl);
  });
  await flushMicrotasks();
  assert.match(videoEl.src, /seg-2/);

  // Ends #2 -> MUST NOT advance past range end into #3
  await act(async () => {
    fireEvent.ended(videoEl);
  });
  await flushMicrotasks();
  assert.match(videoEl.src, /seg-2/);

  // Open export menu and verify label still says (#1-#2), not (#2-#3)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
  });
  await flushMicrotasks();
  assert.ok(screen.getByText(/导出切片 \(#1-#2\)/));

  // Issue #7b: Trigger error then switch to empty session (<video> unmounts); error must be cleared
  await act(async () => {
    fireEvent.error(videoEl);
  });
  await flushMicrotasks();
  assert.ok(screen.getByText('当前录像加载失败'));

  bridge.setVideoSegments([]);
  rerender(
    React.createElement(HistorySessionPanel, {
      session: emptySession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  assert.equal(screen.queryByText('当前录像加载失败'), null);
  assert.ok(screen.getByText('当前会话没有可播放的视频切片。'));

  cleanup();
}

async function testReviewPlayerPrevNextResumeAndEmptyReset(): Promise<void> {
  const seg1 = createMockVideoSegment({
    segmentId: 'seg-nav-1',
    sessionId: 'session-nav',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000010000,
    durationMs: 10000,
  });
  const seg2 = createMockVideoSegment({
    segmentId: 'seg-nav-2',
    sessionId: 'session-nav',
    startedAtMs: 1700000010000,
    endedAtMs: 1700000020000,
    durationMs: 10000,
  });

  const navSession = createMockSession({
    sessionId: 'session-nav',
    name: '上下段导航会话',
    status: 'stopped',
  });
  const emptySession = createMockSession({
    sessionId: 'session-nav-empty',
    name: '空导航会话',
    status: 'stopped',
  });

  const bridge = installMockShadowRecorderBridge({
    sessions: [navSession, emptySession],
    videoSegments: [seg1, seg2],
  });

  const { rerender, container } = render(
    React.createElement(HistorySessionPanel, {
      session: navSession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  const videoEl = container.querySelector('video')!;
  const playedSrcs: string[] = [];
  const origPlay = videoEl.play.bind(videoEl);
  videoEl.play = async function spyPlay() {
    playedSrcs.push(videoEl.getAttribute('src') ?? videoEl.src);
    return origPlay();
  };

  // Round 3 #1a: When paused initially, clicking "下一段" and "上一段" switches src but stays paused (does NOT call play())
  const nextBtn = screen.getByRole('button', { name: '下一段' });
  await act(async () => {
    fireEvent.click(nextBtn);
  });
  await flushMicrotasks();

  assert.match(videoEl.src, /seg-nav-2/);
  assert.equal(playedSrcs.length, 0, `expected no play() while paused, got: ${JSON.stringify(playedSrcs)}`);
  assert.ok(screen.getByRole('button', { name: '播放' }));

  const prevBtn = screen.getByRole('button', { name: '上一段' });
  await act(async () => {
    fireEvent.click(prevBtn);
  });
  await flushMicrotasks();

  assert.match(videoEl.src, /seg-nav-1/);
  assert.equal(playedSrcs.length, 0, `expected no play() while paused on prev, got: ${JSON.stringify(playedSrcs)}`);
  assert.ok(screen.getByRole('button', { name: '播放' }));

  // Round 3 #1b: Start playback, then clicking "下一段" and "上一段" keeps playing on the new segment URL
  const startPlayBtn = screen.getByRole('button', { name: '播放' });
  await act(async () => {
    fireEvent.click(startPlayBtn);
  });
  await flushMicrotasks();
  assert.ok(screen.getByRole('button', { name: '暂停' }));

  playedSrcs.length = 0;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '下一段' }));
  });
  await flushMicrotasks();

  assert.match(videoEl.src, /seg-nav-2/);
  assert.ok(
    playedSrcs.some((src) => src.includes('seg-nav-2')),
    `expected play() on seg-nav-2 while playing, got: ${JSON.stringify(playedSrcs)}`,
  );
  assert.ok(screen.getByRole('button', { name: '暂停' }));

  playedSrcs.length = 0;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '上一段' }));
  });
  await flushMicrotasks();

  assert.match(videoEl.src, /seg-nav-1/);
  assert.ok(
    playedSrcs.some((src) => src.includes('seg-nav-1')),
    `expected play() on seg-nav-1 while playing, got: ${JSON.stringify(playedSrcs)}`,
  );
  assert.ok(screen.getByRole('button', { name: '暂停' }));

  // Round 2 #4: Advance video to 00:07 / 00:10 while playing (Pause button visible), then switch to empty session
  Object.defineProperty(videoEl, 'duration', { configurable: true, value: 10 });
  Object.defineProperty(videoEl, 'currentTime', { configurable: true, writable: true, value: 7 });
  await act(async () => {
    fireEvent.loadedMetadata(videoEl);
    fireEvent.timeUpdate(videoEl);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('00:07 / 00:10'));
  assert.ok(screen.getByRole('button', { name: '暂停' }));

  bridge.setVideoSegments([]);
  rerender(
    React.createElement(HistorySessionPanel, {
      session: emptySession,
      semanticEnabled: true,
      onOpenSemanticReview: () => {},
      onError: () => {},
      onNotice: () => {},
      onMetaSaved: () => {},
    }),
  );
  await flushMicrotasks();

  assert.equal(screen.queryByText('00:07 / 00:10'), null);
  assert.ok(screen.getByText('00:00 / 00:00'));
  assert.equal(screen.queryByRole('button', { name: '暂停' }), null);
  const playBtn = screen.getByRole('button', { name: '播放' }) as HTMLButtonElement;
  assert.equal(playBtn.disabled, true);

  cleanup();
}

async function main(): Promise<void> {
  await testWorkbenchPlayerStates();
  await testReviewPlayerStates();
  await testReviewPlayerSegmentPlaybackRangeLimitAndErrorReset();
  await testReviewPlayerPrevNextResumeAndEmptyReset();
  console.log('[ui-behavior:player-states] PASS');
  process.exit(0);
}

void main();
