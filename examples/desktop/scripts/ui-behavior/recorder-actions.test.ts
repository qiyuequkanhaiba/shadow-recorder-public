import {
  createMockSession,
  createMockVideoSegment,
  installMockShadowRecorderBridge,
} from './test-env';
import { strict as assert } from 'node:assert';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CONFIG } from '../../src-react/lib/tuning-advisor';
import { selectionToWallClockRange } from '../../src-react/lib/export-range';
import type { ContinuousPlaybackSegment } from '../../src-react/components/StudioTimelineDock';
import { countUnsavedConfigChanges } from '../../src-react/app/config-baseline';
import { RecordingReviewPanel } from '../../src-react/features/evidence/RecordingReviewPanel';
import { OperationUpdateInputSchema } from '../../src-electron/modules/reqcase-shadow-recorder/operation-ipc-validators';
import { normalizeOperationRecord } from '../../src-react/lib/operation-adapter';
import { RecorderPlaybackStage } from '../../src-react/components/RecorderPlaybackStage';
import { RecorderPage } from '../../src-react/pages/RecorderPage';
import type { TestSessionPlaybackFocus } from '../../types/contracts';

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}

async function testRecordPauseResumeStopAndIslandActions(): Promise<void> {
  const bridge = installMockShadowRecorderBridge();
  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  bridge.clearCalls();

  // 1. 未录制时点开始：setConfig 1 次（参数等于当时配置），start 1 次，不调用 pause
  const recButtonIdle = screen.getByRole('button', { name: '开始录制' });
  await act(async () => {
    fireEvent.click(recButtonIdle);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('setConfig').length, 1);
  assert.deepEqual(bridge.callsFor('setConfig')[0]?.args[0], DEFAULT_CONFIG);
  assert.equal(bridge.callsFor('start').length, 1);
  assert.equal(bridge.callsFor('pause').length, 0);

  bridge.clearCalls();

  // 2. 录制中点录制按钮：pause 1 次，不调用 start 或 stop
  const recButtonRecording = screen.getByRole('button', { name: '暂停录制' });
  await act(async () => {
    fireEvent.click(recButtonRecording);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('pause').length, 1);
  assert.equal(bridge.callsFor('start').length, 0);
  assert.equal(bridge.callsFor('stop').length, 0);

  bridge.clearCalls();

  // 3. 暂停时点录制按钮：resume 1 次
  const recButtonPaused = screen.getByRole('button', { name: '继续录制' });
  await act(async () => {
    fireEvent.click(recButtonPaused);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('resume').length, 1);
  assert.equal(bridge.callsFor('stop').length, 0);

  bridge.clearCalls();

  // 4. 录制中点停止：stop 1 次（独立停止按钮，录制按钮不可代替）
  const stopButton = screen.getByRole('button', { name: /停止/ });
  await act(async () => {
    fireEvent.click(stopButton);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('stop').length, 1);

  bridge.clearCalls();

  // 唤起悬浮岛：hideToTray 1 次
  const islandButton = screen.getByRole('button', { name: /唤起悬浮岛/ });
  await act(async () => {
    fireEvent.click(islandButton);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('hideToTray').length, 1);

  cleanup();
}

async function testDeleteNotCalledWithoutConfirmation(): Promise<void> {
  const bridge = installMockShadowRecorderBridge({
    sessions: [
      createMockSession({
        sessionId: 'hist-session-1',
        name: '历史会话一',
        status: 'stopped',
        startedAtMs: 1700000000000,
        endedAtMs: 1700000030000,
        updatedAtMs: 1700000030000,
      }),
    ],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const evidenceTab = document.getElementById('tab-evidence')!;
  await act(async () => {
    fireEvent.click(evidenceTab);
  });
  await flushMicrotasks();

  const selectModeBtn = screen.queryByRole('button', { name: '选择模式' });
  if (selectModeBtn) {
    await act(async () => {
      fireEvent.click(selectModeBtn);
    });
    await flushMicrotasks();
  }

  // 选中但取消选择或不点确认删除：不调用 deleteTestSession
  const checkbox = screen.queryByRole('checkbox', { name: /选择 历史会话一/ });
  if (checkbox) {
    await act(async () => {
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
    });
  }

  assert.equal(bridge.callsFor('deleteTestSession').length, 0);
  cleanup();
}

async function testExportRangeAndExportProgressToast(): Promise<void> {
  const segment1 = createMockVideoSegment({
    segmentId: 'seg-1',
    sessionId: 'hist-export-1',
    streamId: 'stream-1',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000010000,
    durationMs: 10000,
  });
  const segment2 = createMockVideoSegment({
    segmentId: 'seg-2',
    sessionId: 'hist-export-1',
    streamId: 'stream-1',
    startedAtMs: 1700000010000,
    endedAtMs: 1700000020000,
    durationMs: 10000,
  });

  // Verify export-range.ts ms wall-clock calculation consistency
  const continuousSegments: ContinuousPlaybackSegment[] = [
    {
      ...segment1,
      index: 0,
      accumulatedStartMs: 0,
      accumulatedEndMs: 10000,
    },
    {
      ...segment2,
      index: 1,
      accumulatedStartMs: 10000,
      accumulatedEndMs: 20000,
    },
  ];
  const expectedRange = selectionToWallClockRange(
    { inPlaybackMs: 2500, outPlaybackMs: 14500 },
    continuousSegments,
  );
  assert.deepEqual(expectedRange, {
    startMs: 1700000002500,
    endMs: 1700000014500,
  });

  const bridge = installMockShadowRecorderBridge({
    activeSession: createMockSession({
      sessionId: 'hist-export-1',
      name: '导出测试会话',
      status: 'stopped',
      startedAtMs: 1700000000000,
      endedAtMs: 1700000020000,
      updatedAtMs: 1700000020000,
    }),
    videoSegments: [segment1, segment2],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  // 12. 导出选区：点击设置入点并点导出选区，验证 bridge 收到的 range.startMs 和 range.endMs 为毫秒墙钟
  const setInBtn = screen.getByRole('button', { name: /入点/ });
  await act(async () => {
    fireEvent.click(setInBtn);
  });
  await flushMicrotasks();

  const exportSelectionBtn = screen.getByRole('button', { name: '导出选区' });
  await act(async () => {
    fireEvent.click(exportSelectionBtn);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('exportTestSessionEvidence').length, 1);
  const exportArg = bridge.callsFor('exportTestSessionEvidence')[0]?.args[0] as {
    range?: { startMs: number; endMs: number };
  };
  const fullSelectionRange = selectionToWallClockRange(
    { inPlaybackMs: 0, outPlaybackMs: 20000 },
    continuousSegments,
  );
  assert.deepEqual(exportArg?.range, fullSelectionRange);

  // 13. 导出进度 canceled 和 failed：各出现一次对应语气的 showToast，不把取消显示成成功
  await act(async () => {
    bridge.emitExportProgress({
      percent: 45,
      message: '用户已取消导出',
      phase: 'canceled',
    });
  });
  await flushMicrotasks();

  const canceledToast = screen.getByText('用户已取消导出').closest('[role="status"]');
  assert.ok(canceledToast, 'canceled toast should be rendered');
  assert.ok(
    !canceledToast.className.includes('success'),
    'canceled toast must not have success tone',
  );

  await act(async () => {
    bridge.emitExportProgress({
      percent: 60,
      message: '导出失败：磁盘空间不足',
      phase: 'failed',
    });
  });
  await flushMicrotasks();

  const failedToast = screen.getByText('导出失败：磁盘空间不足').closest('[role="status"]');
  assert.ok(failedToast, 'failed toast should be rendered');
  assert.ok(
    failedToast.className.includes('error'),
    'failed toast must have error tone',
  );

  cleanup();
}

async function testQuickMarkDefectIncludesSessionId(): Promise<void> {
  const activeSession = createMockSession({
    sessionId: 'session-defect-99',
    name: '缺陷标记会话',
    status: 'active',
    startedAtMs: 1700000000000,
    updatedAtMs: 1700000005000,
  });
  const segment = createMockVideoSegment({
    segmentId: 'seg-defect-1',
    sessionId: 'session-defect-99',
    streamId: 'stream-1',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000005000,
    durationMs: 5000,
  });

  const bridge = installMockShadowRecorderBridge({
    activeSession,
    sessions: [activeSession],
    videoSegments: [segment],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const quickDefectBtn = screen.getByRole('button', { name: '标记当前回放位置为缺陷' });
  await act(async () => {
    fireEvent.click(quickDefectBtn);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('markTestDefect').length, 1);
  assert.equal(
    (bridge.callsFor('markTestDefect')[0]?.args[0] as { sessionId?: string })?.sessionId,
    'session-defect-99',
  );

  cleanup();
}

async function testCase5SaveSuccessAndInFlightEdits(): Promise<void> {
  const bridge = installMockShadowRecorderBridge();
  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const settingsTab = document.getElementById('tab-settings')!;
  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('配置已同步'));

  // 改变防抖时间
  const debounceInput = screen.getByLabelText(/防抖/);
  await act(async () => {
    fireEvent.change(debounceInput, { target: { value: '180' } });
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('有 1 项未保存'));

  // 切换标签，未保存状态保留
  const mainTab = document.getElementById('tab-main')!;
  await act(async () => {
    fireEvent.click(mainTab);
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('有 1 项未保存'));

  // 保存成功：setConfig 1 次，参数等于提交副本，未保存项数变为 0
  bridge.clearCalls();
  const saveBtn = screen.getByRole('button', { name: '保存并应用配置' });
  await act(async () => {
    fireEvent.click(saveBtn);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('setConfig').length, 1);
  const committed = bridge.callsFor('setConfig')[0]?.args[0] as { debounceMs?: number };
  assert.equal(committed?.debounceMs, 180);
  assert.ok(screen.getByText('配置已同步'));

  // 测试在途保存时用户又修改：延迟 setConfig 完成
  let resolveInFlight: (() => void) | null = null;
  const inFlightPromise = new Promise<void>((res) => {
    resolveInFlight = res;
  });
  const origSetConfig = window.reqcaseShadowRecorder.setConfig;
  window.reqcaseShadowRecorder.setConfig = async (cfg) => {
    await inFlightPromise;
    return origSetConfig(cfg);
  };

  const reDebounceInput = screen.getByLabelText(/防抖/);
  await act(async () => {
    fireEvent.change(reDebounceInput, { target: { value: '240' } });
  });
  await flushMicrotasks();
  assert.ok(screen.getByText('有 1 项未保存'));

  // 触发保存（此时在途）
  const saveBtn2 = screen.getByRole('button', { name: /保存/ });
  fireEvent.click(saveBtn2);

  // 保存请求在途期间用户又改了一个字段
  const windowInput = screen.getByLabelText(/最大录制时长/);
  fireEvent.change(windowInput, { target: { value: '300' } });

  // 放行在途保存
  resolveInFlight!();
  await flushMicrotasks();
  window.reqcaseShadowRecorder.setConfig = origSetConfig;

  // 虽第一次保存（debounceMs: 240）已落地，但之后改动的 window 仍未保存
  assert.ok(screen.getByText('有 1 项未保存'));

  cleanup();
}

async function testCase6SetConfigRejectionAndDiscard(): Promise<void> {
  const bridge = installMockShadowRecorderBridge();
  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const settingsTab = document.getElementById('tab-settings')!;
  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  const debounceInput = screen.getByLabelText(/防抖/);
  await act(async () => {
    fireEvent.change(debounceInput, { target: { value: '160' } });
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('有 1 项未保存'));

  // setConfig 失败：错误反馈出现，基线不更新，仍有 1 项未保存
  const origSetConfig = window.reqcaseShadowRecorder.setConfig;
  window.reqcaseShadowRecorder.setConfig = async () => {
    throw new Error('disk write protected');
  };

  const saveBtn = screen.getByRole('button', { name: '保存并应用配置' });
  await act(async () => {
    fireEvent.click(saveBtn);
  });
  await flushMicrotasks();

  window.reqcaseShadowRecorder.setConfig = origSetConfig;

  assert.ok(screen.getByText(/配置保存失败：disk write protected/));
  assert.ok(screen.getByText('有 1 项未保存'));

  // 放弃操作：回到基线，未保存项数清零，不调用 bridge
  bridge.clearCalls();
  const discardBtn = screen.getByRole('button', { name: '放弃' });
  await act(async () => {
    fireEvent.click(discardBtn);
  });
  await flushMicrotasks();

  assert.equal(bridge.callsFor('setConfig').length, 0);
  assert.ok(screen.getByText('配置已同步'));
  assert.equal((debounceInput as HTMLInputElement).value, '90');

  cleanup();
}

async function testCase7SetConfigSucceedsThenStartFails(): Promise<void> {
  const bridge = installMockShadowRecorderBridge();
  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const settingsTab = document.getElementById('tab-settings')!;
  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  const debounceInput = screen.getByLabelText(/防抖/);
  await act(async () => {
    fireEvent.change(debounceInput, { target: { value: '210' } });
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('有 1 项未保存'));

  // 切回录制工作台，start 抛错
  const mainTab = document.getElementById('tab-main')!;
  await act(async () => {
    fireEvent.click(mainTab);
  });
  await flushMicrotasks();

  const origStart = window.reqcaseShadowRecorder.start;
  window.reqcaseShadowRecorder.start = async () => {
    throw new Error('start device busy');
  };

  const startBtn = screen.getByRole('button', { name: '开始录制' });
  await act(async () => {
    fireEvent.click(startBtn);
  });
  await flushMicrotasks();

  window.reqcaseShadowRecorder.start = origStart;

  // setConfig 已经写入提交副本，此时即使 start 失败基线也不回滚
  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  assert.ok(screen.getByText('配置已同步'));

  cleanup();
}

async function testCase8ApplyProfileSetConfigSucceedsThenSetSettingsFails(): Promise<void> {
  const bridge = installMockShadowRecorderBridge();
  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const settingsTab = document.getElementById('tab-settings')!;
  await act(async () => {
    fireEvent.click(settingsTab);
  });
  await flushMicrotasks();

  const perfNavBtn = screen.getByRole('tab', { name: /性能与高级/ });
  await act(async () => {
    fireEvent.click(perfNavBtn);
  });
  await flushMicrotasks();

  const origSetSettings = window.reqcaseShadowRecorder.setSettings;
  window.reqcaseShadowRecorder.setSettings = async () => {
    throw new Error('setSettings failed: permission denied');
  };

  const applyStabilityBtn = screen.getByRole('button', { name: /应用 稳定性优先/ });
  await act(async () => {
    fireEvent.click(applyStabilityBtn);
  });
  await flushMicrotasks();

  window.reqcaseShadowRecorder.setSettings = origSetSettings;

  // setConfig 成功，基线已经更新为 nextConfig，未保存为 0，同时显示了 setSettings 的错误
  assert.ok(screen.getByText('配置已同步'));
  assert.ok(screen.getByText(/permission denied/));

  cleanup();
}

async function testCase9CancelOrExitSelectionModeDoesNotCallDelete(): Promise<void> {
  const bridge = installMockShadowRecorderBridge({
    sessions: [
      createMockSession({
        sessionId: 'session-case-9',
        name: '用例九会话',
        status: 'stopped',
        startedAtMs: 1700000000000,
        endedAtMs: 1700000010000,
      }),
    ],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const evidenceTab = document.getElementById('tab-evidence')!;
  await act(async () => {
    fireEvent.click(evidenceTab);
  });
  await flushMicrotasks();

  // 点击选择模式进入多选
  const selectModeBtn = screen.getByRole('button', { name: '选择模式' });
  await act(async () => {
    fireEvent.click(selectModeBtn);
  });
  await flushMicrotasks();

  // 勾选会话
  const checkbox = screen.getByRole('checkbox', { name: /选择 用例九会话/ });
  await act(async () => {
    fireEvent.click(checkbox);
  });
  await flushMicrotasks();

  // 退出选择模式
  const exitSelectBtn = screen.getByRole('button', { name: '退出选择' });
  await act(async () => {
    fireEvent.click(exitSelectBtn);
  });
  await flushMicrotasks();

  // 验证不调用 deleteTestSession，且退出后回到选择模式按钮
  assert.equal(bridge.callsFor('deleteTestSession').length, 0);
  assert.ok(screen.getByRole('button', { name: '选择模式' }));

  cleanup();
}

async function testCase10ConfirmDeleteRespectsHiddenSelectedIds(): Promise<void> {
  const bridge = installMockShadowRecorderBridge({
    sessions: [
      createMockSession({
        sessionId: 'session-alpha',
        name: 'Alpha会话',
        status: 'stopped',
        startedAtMs: 1700000000000,
      }),
      createMockSession({
        sessionId: 'session-beta',
        name: 'Beta会话',
        status: 'stopped',
        startedAtMs: 1700000010000,
      }),
    ],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const evidenceTab = document.getElementById('tab-evidence')!;
  await act(async () => {
    fireEvent.click(evidenceTab);
  });
  await flushMicrotasks();

  // 进入选择模式
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '选择模式' }));
  });
  await flushMicrotasks();

  // 勾选 Alpha
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 Alpha会话/ }));
  });
  await flushMicrotasks();

  // 搜索 "Beta"，使 Alpha 从列表中被过滤隐藏
  const searchInput = screen.getByRole('textbox', { name: '搜索会话' });
  await act(async () => {
    fireEvent.change(searchInput, { target: { value: 'Beta' } });
  });
  await flushMicrotasks();

  // 此时列表中只有 Beta，勾选 Beta
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 Beta会话/ }));
  });
  await flushMicrotasks();

  // 点击删除所选
  const deleteBtn = screen.getByRole('button', { name: /删除所选/ });
  await act(async () => {
    fireEvent.click(deleteBtn);
  });
  await flushMicrotasks();

  // 确认传给 bridge.deleteTestSession 的 sessionIds 包含被搜索隐藏的 Alpha 以及可见的 Beta
  const deleteCalls = bridge.callsFor('deleteTestSession');
  assert.equal(deleteCalls.length, 1);
  const deleteArg = deleteCalls[0]?.args[0] as { sessionIds?: string[] };
  assert.ok(deleteArg.sessionIds?.includes('session-alpha'));
  assert.ok(deleteArg.sessionIds?.includes('session-beta'));

  cleanup();
}

async function testCase11PartialDeleteRetainsSkippedIdsAndShowsToast(): Promise<void> {
  const bridge = installMockShadowRecorderBridge({
    sessions: [
      createMockSession({
        sessionId: 'session-del-1',
        name: '可删除会话',
        status: 'stopped',
        startedAtMs: 1700000000000,
      }),
      createMockSession({
        sessionId: 'session-locked-2',
        name: '锁定会话',
        status: 'stopped',
        startedAtMs: 1700000010000,
      }),
    ],
  });

  // 模拟部分删除结果：session-del-1 被删除，session-locked-2 被跳过
  bridge.setDeleteResult({
    deleted: ['session-del-1'],
    skipped: ['session-locked-2'],
  });

  render(React.createElement(RecorderPage));
  await flushMicrotasks();

  const evidenceTab = document.getElementById('tab-evidence')!;
  await act(async () => {
    fireEvent.click(evidenceTab);
  });
  await flushMicrotasks();

  // 进入选择模式
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '选择模式' }));
  });
  await flushMicrotasks();

  // 勾选两项
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 可删除会话/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 锁定会话/ }));
  });
  await flushMicrotasks();

  // 执行删除
  const deleteBtn = screen.getByRole('button', { name: /删除所选/ });
  await act(async () => {
    fireEvent.click(deleteBtn);
  });
  await flushMicrotasks();

  // 验证提示同时包含删除数和跳过数
  assert.ok(screen.getByText(/已删除 1 条，1 条跳过/));

  // 不退出选择模式，且锁定会话仍保持选中并在会话列表中可见
  assert.ok(screen.getByRole('button', { name: '退出选择' }));
  const lockedCheckbox = screen.getByRole('checkbox', { name: /选择 锁定会话/ }) as HTMLInputElement;
  assert.equal(lockedCheckbox.checked, true);

  cleanup();
}

async function testPartialDeleteCrossFilterRevealsSkippedAndKeyboardSessionRow(): Promise<void> {
  const bridge = installMockShadowRecorderBridge({
    sessions: [
      createMockSession({
        sessionId: 'session-alpha',
        name: 'Alpha会话',
        status: 'stopped',
        startedAtMs: 1700000000000,
      }),
      createMockSession({
        sessionId: 'session-beta',
        name: 'Beta会话',
        status: 'stopped',
        startedAtMs: 1700000010000,
      }),
    ],
  });

  bridge.setDeleteResult({
    deleted: ['session-beta'],
    skipped: ['session-alpha'],
  });

  const { container } = render(React.createElement(RecorderPage));
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(document.getElementById('tab-evidence')!);
  });
  await flushMicrotasks();

  // Issue #8a: Session row is keyboard focusable (tabIndex === 0) and activates on Enter / Space
  const betaRow = container.querySelector('[data-session-id="session-beta"]') as HTMLElement;
  assert.ok(betaRow, 'beta session row should exist');
  assert.equal(betaRow.tabIndex, 0);
  await act(async () => {
    fireEvent.keyDown(betaRow, { key: 'Enter' });
  });
  await flushMicrotasks();
  assert.equal(betaRow.getAttribute('aria-pressed'), 'true');

  // Issue #9: Select Alpha, search Beta to hide Alpha, select Beta, delete -> Alpha is skipped & must become visible
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '选择模式' }));
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 Alpha会话/ }));
  });
  await flushMicrotasks();

  const searchInput = screen.getByRole('textbox', { name: '搜索会话' }) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(searchInput, { target: { value: 'Beta' } });
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: /选择 Beta会话/ }));
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /删除所选/ }));
  });
  await flushMicrotasks();

  assert.equal(searchInput.value, '');
  const alphaCheckbox = screen.getByRole('checkbox', { name: /选择 Alpha会话/ }) as HTMLInputElement;
  assert.equal(alphaCheckbox.checked, true);

  cleanup();
}

function testConfigBaselineSingleTargetCaptureModeChangeCount(): void {
  const baseline = {
    ...DEFAULT_CONFIG,
    targetCaptureMode: 'target_display' as const,
    targetDisplayId: 'display-1',
    targetDisplayIds: ['display-1'],
  };
  const next = {
    ...baseline,
    targetCaptureMode: 'all_displays' as const,
    targetDisplayId: undefined,
    targetDisplayIds: ['display-1', 'display-2'],
  };
  assert.equal(countUnsavedConfigChanges(next, baseline), 1);
}

async function testRecordingReviewContractsSearchTimeAndKeyboard(): Promise<void> {
  const session = createMockSession({
    sessionId: 'session-rev-1',
    name: '审查契约测试会话',
    status: 'stopped',
    startedAtMs: 1700000000000,
  });

  const op1 = normalizeOperationRecord(
    {
      operationId: 'op-1',
      sessionId: session.sessionId,
      sequence: 1,
      startedAtMs: 1700000002000,
      endedAtMs: 1700000002500,
      relativeMsFromSessionStart: 2000,
      title: '点击提交',
      resultSummary: '订单提交完成',
      action: {
        actionId: 'act-1',
        kind: 'click',
        occurredAtMs: 1700000002000,
        target: { name: 'FirstSubmitBtn', controlType: 'Button' },
        sourceEventIds: ['e1'],
        targetReasonCodes: ['uia-hit'],
        confidence: { target: 0.9, temporal: 0.9, overall: 0.9 },
      },
      outcome: {
        outcomeId: 'out-1',
        status: 'confirmed',
        summary: '订单提交完成',
        observedAtMs: 1700000002500,
        latencyMs: 500,
        primaryTransitionId: 'tr-1',
        candidateTransitionIds: ['tr-1', 'tr-2'],
        reasonCodes: ['popup'],
        confidence: { temporal: 0.9, identity: 0.9, transition: 0.9, evidence: 0.9, overall: 0.9 },
      },
      transitions: [
        {
          transitionId: 'tr-1',
          kind: 'property',
          occurredAtMs: 1700000002400,
          property: 'Name',
          before: 'A',
          after: '已提交',
          privacyClass: 'not-sensitive',
          sourceEventIds: ['e1'],
          reasonCodes: [],
          confidence: {},
        },
        {
          transitionId: 'tr-2',
          kind: 'lifecycle',
          occurredAtMs: 1700000002500,
          property: 'Dialog',
          before: null,
          after: '已弹出确认框',
          privacyClass: 'not-sensitive',
          sourceEventIds: ['e2'],
          reasonCodes: [],
          confidence: {},
        },
      ],
      completionCandidates: [],
      evidence: [],
    },
    session.sessionId,
    0,
  );

  const op2 = normalizeOperationRecord(
    {
      operationId: 'op-2',
      sessionId: session.sessionId,
      sequence: 2,
      startedAtMs: 1700000005000,
      endedAtMs: 1700000005200,
      relativeMsFromSessionStart: 5000,
      title: '点击特定按钮',
      resultSummary: '列表刷新',
      action: {
        actionId: 'act-2',
        kind: 'click',
        occurredAtMs: 1700000005000,
        target: { name: 'UniqueControlTargetX', controlType: 'Button' },
        sourceEventIds: ['e3'],
        targetReasonCodes: ['uia-hit'],
        confidence: { target: 0.9, temporal: 0.9, overall: 0.9 },
      },
      outcome: {
        outcomeId: 'out-2',
        status: 'confirmed',
        summary: '列表刷新',
        observedAtMs: 1700000005200,
        latencyMs: 200,
        primaryTransitionId: null,
        candidateTransitionIds: [],
        reasonCodes: [],
        confidence: { temporal: 0.9, identity: 0.9, transition: 0.9, evidence: 0.9, overall: 0.9 },
      },
      transitions: [],
      completionCandidates: [],
      evidence: [],
    },
    session.sessionId,
    1,
  );

  const bridge = installMockShadowRecorderBridge({
    sessions: [session],
    operations: [op1, op2],
  });
  bridge.overrides.renderTestSessionReproSteps = async () => 'NATIVE_REPRO_STEPS_FROM_RUST';
  bridge.overrides.markTestDefect = async () => ({
    markedAtMs: 1700000004000,
    windowStartMs: 1699999989000,
    windowEndMs: 1700000014000,
    preWindowSeconds: 15,
    postWindowSeconds: 10,
    stepCount: 2,
  });

  const { container } = render(
    React.createElement(RecordingReviewPanel, {
      session,
      isRecording: false,
      enabled: true,
      preWindowSeconds: 15,
      postWindowSeconds: 10,
      onError: (msg) => {
        throw new Error(`unexpected error: ${msg}`);
      },
      toUiErrorMessage: (err) => String(err),
      onNotice: () => {},
    }),
  );
  await flushMicrotasks();

  // Issue #10a: Before filtering, op-2 shows +5.0s relative to session start
  assert.ok(screen.getByText('+5.0s'));

  // Issue #10b: Searching by target.name finds op-2, and its relative time remains +5.0s (not +0.0s)
  const opSearchInput = screen.getByPlaceholderText('搜索操作、控件或结果…');
  await act(async () => {
    fireEvent.change(opSearchInput, { target: { value: 'UniqueControlTargetX' } });
  });
  await flushMicrotasks();
  assert.equal(container.querySelectorAll('[data-operation-id]').length, 1);
  assert.ok(container.querySelector('[data-operation-id="op-2"]'));
  assert.ok(screen.getByText('+5.0s'));

  // Clear search back
  await act(async () => {
    fireEvent.change(opSearchInput, { target: { value: '' } });
  });
  await flushMicrotasks();

  // Issue #8b: Operation rows are keyboard focusable & Enter selects op-2
  const op2Row = container.querySelector('[data-operation-id="op-2"]') as HTMLElement;
  assert.equal(op2Row.tabIndex, 0);
  await act(async () => {
    fireEvent.keyDown(op2Row, { key: 'Enter' });
  });
  await flushMicrotasks();
  assert.equal(op2Row.getAttribute('aria-pressed'), 'true');

  // Switch back to op-1 to test Issue #2 (candidates with same 'confirmed' status keep distinct transitionId)
  const op1Row = container.querySelector('[data-operation-id="op-1"]') as HTMLElement;
  await act(async () => {
    fireEvent.click(op1Row);
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '状态转变' }));
  });
  await flushMicrotasks();

  const secondCandidateBtn = screen.getByRole('button', { name: /Dialog: 已弹出确认框/ });
  await act(async () => {
    fireEvent.click(secondCandidateBtn);
  });
  await flushMicrotasks();

  const updateCalls = bridge.callsFor('updateTestSessionOperation');
  assert.equal(updateCalls.length, 1);
  const updatePayload = updateCalls[0]?.args[0] as Record<string, unknown>;
  assert.equal(updatePayload.selectedOutcomeStatus, 'confirmed');
  assert.equal(updatePayload.selectedTransitionId, 'tr-2');
  // Validate with real IPC zod schema!
  OperationUpdateInputSchema.parse(updatePayload);

  // Issue #1 & #3: Mark defect, generate native repro steps (string + defectNote), export defect pack with markedAtMs/expected/actual
  const noteInput = screen.getByPlaceholderText(/点击提交订单按钮/);
  const expectedInput = screen.getByPlaceholderText(/弹出支付成功/);
  const actualInput = screen.getByPlaceholderText(/按钮保持 loading/);
  await act(async () => {
    fireEvent.change(noteInput, { target: { value: '提交按钮卡死' } });
    fireEvent.change(expectedInput, { target: { value: '跳转成功页' } });
    fireEvent.change(actualInput, { target: { value: '一直转圈' } });
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '标记问题时间窗' }));
  });
  await flushMicrotasks();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '生成复现步骤' }));
  });
  await flushMicrotasks();

  const reproCalls = bridge.callsFor('renderTestSessionReproSteps');
  assert.equal(reproCalls.length, 1);
  assert.equal((reproCalls[0]?.args[0] as { defectNote?: string })?.defectNote, '提交按钮卡死');
  assert.ok(screen.getByText('NATIVE_REPRO_STEPS_FROM_RUST'));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '导出缺陷证据包' }));
  });
  await flushMicrotasks();

  const packCalls = bridge.callsFor('exportTestDefectPack');
  assert.equal(packCalls.length, 1);
  const packPayload = packCalls[0]?.args[0] as Record<string, unknown>;
  assert.equal(packPayload.markedAtMs, 1700000004000);
  assert.equal(packPayload.preWindowSeconds, 15);
  assert.equal(packPayload.postWindowSeconds, 10);
  assert.equal(packPayload.expected, '跳转成功页');
  assert.equal(packPayload.actual, '一直转圈');
  assert.equal('windowStartMs' in packPayload, false);

  cleanup();
}

async function testRound2ReviewFocusSeekAutoRebuildAndLegacySteps(): Promise<void> {
  const session = createMockSession({
    sessionId: 'session-r2-rev',
    name: '二轮复审测试会话',
    status: 'active',
    startedAtMs: 1700000000000,
  });
  const segment = createMockVideoSegment({
    segmentId: 'seg-r2-1',
    sessionId: session.sessionId,
    streamId: 'stream-1',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000020000,
    durationMs: 20000,
    displayId: 'display-primary',
  });
  const op1 = normalizeOperationRecord(
    {
      operationId: 'op-r2-1',
      sessionId: session.sessionId,
      sequence: 1,
      startedAtMs: 1700000006000,
      endedAtMs: 1700000006500,
      relativeMsFromSessionStart: 6000,
      title: '点击目标控件',
      resultSummary: '状态更新',
      action: {
        actionId: 'act-r2-1',
        kind: 'click',
        occurredAtMs: 1700000006000,
        coordinate: { x: 120, y: 240, displayId: 'display-primary' },
        target: { name: 'TargetBtn', controlType: 'Button' },
        sourceEventIds: ['e1'],
        targetReasonCodes: ['uia-hit'],
        confidence: { target: 0.9, temporal: 0.9, overall: 0.9 },
      },
      outcome: {
        outcomeId: 'out-r2-1',
        status: 'confirmed',
        summary: '状态更新',
        observedAtMs: 1700000006500,
        latencyMs: 500,
        primaryTransitionId: null,
        candidateTransitionIds: [],
        reasonCodes: [],
        confidence: { temporal: 0.9, identity: 0.9, transition: 0.9, evidence: 0.9, overall: 0.9 },
      },
      transitions: [],
      completionCandidates: [],
      evidence: [],
    },
    session.sessionId,
    0,
  );

  const bridge = installMockShadowRecorderBridge({
    sessions: [session],
    operations: [op1],
    videoSegments: [segment],
  });

  // Round 2 #1 & #2: Auto rebuild on mount & isRecording change, plus full playbackFocus seeking stage video
  const receivedFocus: Array<TestSessionPlaybackFocus | null> = [];
  function FocusHarness({ isRecording }: { isRecording: boolean }) {
    const [focus, setFocus] = React.useState<TestSessionPlaybackFocus | null>(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(RecordingReviewPanel, {
        session,
        isRecording,
        enabled: true,
        onPlaybackFocusChange: (next) => {
          receivedFocus.push(next);
          setFocus(next);
        },
        onError: (msg) => {
          throw new Error(`unexpected error: ${msg}`);
        },
        toUiErrorMessage: (err) => String(err),
      }),
      React.createElement(RecorderPlaybackStage, {
        isRecording: false,
        isPaused: false,
        metrics: null,
        resourceUsage: null,
        activeSession: null,
        playbackSession: session,
        videoStreams: [],
        recentSegments: [segment],
        matchedSegments: [segment],
        playbackFocus: focus,
        timelineEvents: [],
        config: DEFAULT_CONFIG,
        onNotice: () => {},
        onMarked: () => {},
        onPlaybackFocusChange: () => {},
        onExportSession: async () => {},
        isExporting: false,
        onClearEvents: async () => {},
      }),
    );
  }

  const { container, rerender } = render(React.createElement(FocusHarness, { isRecording: true }));
  await flushMicrotasks();

  assert.equal(bridge.callsFor('rebuildTestSessionOperations').length, 1);

  const opRow = container.querySelector('[data-operation-id="op-r2-1"]') as HTMLElement;
  await act(async () => {
    fireEvent.click(opRow);
  });
  await flushMicrotasks();

  assert.equal(receivedFocus.length, 1);
  assert.deepEqual(receivedFocus[0], {
    eventId: 'op-r2-1',
    sessionId: session.sessionId,
    occurredAtMs: 1700000006000,
    displayId: 'display-primary',
  });
  const stageVideo = container.querySelector('video') as HTMLVideoElement;
  assert.equal(stageVideo.currentTime, 6);

  // Clicking "刷新" while isRecording === true also triggers rebuild
  const refreshBtn = screen.getByRole('button', { name: '刷新' });
  await act(async () => {
    fireEvent.click(refreshBtn);
  });
  await flushMicrotasks();
  assert.equal(bridge.callsFor('rebuildTestSessionOperations').length, 2);

  // Switching isRecording from true -> false triggers rebuild automatically
  rerender(React.createElement(FocusHarness, { isRecording: false }));
  await flushMicrotasks();
  assert.equal(bridge.callsFor('rebuildTestSessionOperations').length, 3);

  cleanup();

  // Round 2 #5: Legacy getTestSessionSteps fallback preserves >80 steps, original stepId, coordinates, and legacyUnknown status
  const legacyBridge = installMockShadowRecorderBridge({ sessions: [session] });
  delete (legacyBridge.overrides as any).getTestSessionOperations;
  (window as any).reqcaseShadowRecorder.getTestSessionOperations = undefined;
  const legacySteps = Array.from({ length: 85 }, (_, index) => ({
    stepId: `legacy-step-${index + 1}`,
    sessionId: session.sessionId,
    occurredAtMs: 1700000001000 + index * 1000,
    title: `旧步骤 ${index + 1}`,
    action: 'click',
    x: 300 + index,
    y: 400 + index,
  }));
  (window as any).reqcaseShadowRecorder.getTestSessionSteps = async () => legacySteps;

  const { container: legacyContainer } = render(
    React.createElement(RecordingReviewPanel, {
      session: { ...session, status: 'stopped' },
      isRecording: false,
      enabled: true,
      onError: (msg) => {
        throw new Error(`unexpected error: ${msg}`);
      },
      toUiErrorMessage: (err) => String(err),
    }),
  );
  await flushMicrotasks();

  const rows = legacyContainer.querySelectorAll('[data-operation-id]');
  assert.equal(rows.length, 85);
  assert.ok(legacyContainer.querySelector('[data-operation-id="legacy-step-1"]'));
  assert.ok(legacyContainer.querySelector('[data-operation-id="legacy-step-85"]'));
  assert.ok(screen.getAllByText('旧记录').length > 0);
  assert.ok(screen.getByText('X: 300, Y: 400'));

  cleanup();
}

async function testSmokeTabSwitchMountAndSelectSession(): Promise<void> {
  const sessionA = createMockSession({
    sessionId: 'smoke-session-a',
    name: '烟测会话 A',
    status: 'stopped',
  });
  const sessionB = createMockSession({
    sessionId: 'smoke-session-b',
    name: '烟测会话 B',
    status: 'stopped',
  });
  installMockShadowRecorderBridge({
    sessions: [sessionA, sessionB],
  });

  const { container } = render(React.createElement(RecorderPage));
  await flushMicrotasks();

  assert.ok(container.querySelector('#panel-main'));
  assert.equal(container.querySelector('#panel-evidence'), null);

  await act(async () => {
    fireEvent.click(document.getElementById('tab-evidence')!);
  });
  await flushMicrotasks();

  assert.equal(container.querySelector('#panel-main'), null);
  assert.ok(container.querySelector('#panel-evidence'));
  const targetRow = container.querySelector('[data-ui-scope="review"] [data-session-id="smoke-session-b"]') as HTMLElement;
  assert.ok(targetRow);
  await act(async () => {
    fireEvent.click(targetRow);
  });
  await flushMicrotasks();

  assert.equal(targetRow.getAttribute('aria-pressed'), 'true');
  assert.ok(container.querySelector('#panel-evidence'));

  cleanup();
}

async function testOperationReviewDiagnosticsBanner(): Promise<void> {
  const session = createMockSession({
    sessionId: 'session-diag-1',
    name: '诊断提示测试会话',
    status: 'stopped',
    startedAtMs: 1700000000000,
  });
  const op1 = normalizeOperationRecord(
    {
      operationId: 'op-diag-1',
      sessionId: session.sessionId,
      sequence: 1,
      startedAtMs: 1700000001000,
      endedAtMs: 1700000001200,
      relativeMsFromSessionStart: 1000,
      title: '可读前缀步骤',
      resultSummary: '完成',
      action: { kind: 'click', target: { name: 'OkBtn' } },
      outcome: { status: 'confirmed', summary: '完成' },
    },
    session.sessionId,
    0,
  );

  // Case 1: Readable prefix + corruptTail warning -> shows partial banner + corruptTail code + operation row
  const bridge = installMockShadowRecorderBridge({
    sessions: [session],
    operations: [op1],
  });
  bridge.overrides.getTestSessionOperations = async () => ({
    items: [op1],
    nextCursor: undefined,
    reset: true,
    totalCount: 1,
    diagnostics: [
      {
        code: 'corruptTail',
        severity: 'warning',
        message: 'tail line corrupt',
      },
    ],
  });

  render(
    React.createElement(RecordingReviewPanel, {
      session,
      isRecording: false,
      enabled: true,
      onError: (msg) => {
        throw new Error(`unexpected error: ${msg}`);
      },
      toUiErrorMessage: (err) => String(err),
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getAllByText('可读前缀步骤').length > 0);
  assert.ok(screen.getByText('操作记录部分可读：检测到损坏尾行，已加载完整前缀。'));
  assert.ok(screen.getByText('corruptTail'));

  cleanup();

  // Case 2: futureSchema diagnostic -> shows futureSchema readonly banner + code
  const futureBridge = installMockShadowRecorderBridge({
    sessions: [session],
    operations: [],
  });
  futureBridge.overrides.getTestSessionOperations = async () => ({
    items: [],
    nextCursor: undefined,
    reset: true,
    totalCount: 0,
    diagnostics: [
      {
        code: 'futureSchema',
        severity: 'warning',
        message: 'newer schema',
      },
    ],
  });

  render(
    React.createElement(RecordingReviewPanel, {
      session,
      isRecording: false,
      enabled: true,
      onError: (msg) => {
        throw new Error(`unexpected error: ${msg}`);
      },
      toUiErrorMessage: (err) => String(err),
    }),
  );
  await flushMicrotasks();

  assert.ok(screen.getByText('该会话使用了更高版本 schema，当前版本只读打开，禁止覆盖重建。'));
  assert.ok(screen.getByText('futureSchema'));

  cleanup();
}

async function main(): Promise<void> {
  await testRecordPauseResumeStopAndIslandActions();
  await testDeleteNotCalledWithoutConfirmation();
  await testExportRangeAndExportProgressToast();
  await testQuickMarkDefectIncludesSessionId();
  await testCase5SaveSuccessAndInFlightEdits();
  await testCase6SetConfigRejectionAndDiscard();
  await testCase7SetConfigSucceedsThenStartFails();
  await testCase8ApplyProfileSetConfigSucceedsThenSetSettingsFails();
  await testCase9CancelOrExitSelectionModeDoesNotCallDelete();
  await testCase10ConfirmDeleteRespectsHiddenSelectedIds();
  await testCase11PartialDeleteRetainsSkippedIdsAndShowsToast();
  await testPartialDeleteCrossFilterRevealsSkippedAndKeyboardSessionRow();
  testConfigBaselineSingleTargetCaptureModeChangeCount();
  await testRecordingReviewContractsSearchTimeAndKeyboard();
  await testRound2ReviewFocusSeekAutoRebuildAndLegacySteps();
  await testSmokeTabSwitchMountAndSelectSession();
  await testOperationReviewDiagnosticsBanner();
  console.log('[ui-behavior:recorder-actions] PASS');
  process.exit(0);
}

void main();
