import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPERATION_PAGE_LIMIT,
  adaptLegacyStepToOperation,
  buildOperationReproText,
  buildOperationReviewModel,
  filterOperationsByWindow,
  formatActionKindLabel,
  listManualOutcomeChoices,
  mergeOperationPages,
  normalizeOperationRecord,
  operationStatusPresentation,
  shouldShowConfidenceBadge,
} from '../src-react/lib/operation-adapter';

function main(): void {
  assert.equal(OPERATION_PAGE_LIMIT, 80);

  const legacy = adaptLegacyStepToOperation(
    {
      stepId: 'step-1',
      sessionId: 'ts-1',
      title: '单击按钮“保存”',
      startedAtMs: 1000,
      endedAtMs: 1100,
      relativeMsFromSessionStart: 1000,
    },
    'ts-1',
    0,
  );
  assert.equal(legacy.outcome.status, 'legacyUnknown');
  assert.match(legacy.resultSummary, /旧记录未采集操作结果/);

  const confirmed = normalizeOperationRecord(
    {
      operationId: 'op-1',
      sessionId: 'ts-1',
      sequence: 1,
      startedAtMs: 1000,
      endedAtMs: 1420,
      relativeMsFromSessionStart: 1000,
      title: '单击按钮“保存”',
      resultSummary: '“保存成功”提示出现',
      displaySummary: '单击按钮“保存” -> “保存成功”提示出现，耗时 420ms',
      precisionLevel: 'l3',
      action: {
        actionId: 'a1',
        kind: 'click',
        occurredAtMs: 1000,
        sourceEventIds: ['e1'],
        targetReasonCodes: ['point-hit'],
        confidence: { overall: 0.9 },
      },
      outcome: {
        outcomeId: 'o1',
        status: 'confirmed',
        summary: '“保存成功”提示出现',
        observedAtMs: 1420,
        latencyMs: 420,
        primaryTransitionId: 't1',
        candidateTransitionIds: ['t1'],
        reasonCodes: ['popup-appeared'],
        confidence: { overall: 0.91 },
      },
      transitions: [
        {
          transitionId: 't1',
          kind: 'lifecycle',
          occurredAtMs: 1420,
          property: 'popup',
          before: null,
          after: 'appeared',
          privacyClass: 'not-sensitive',
          sourceEventIds: ['sem-1'],
          reasonCodes: ['popup-appeared'],
          confidence: {},
        },
      ],
      completionCandidates: [],
      evidence: [
        {
          evidenceId: 'ev1',
          kind: 'stateTransition',
          role: 'supportsOutcome',
          sourceId: 't1',
          occurredAtMs: 1420,
        },
      ],
      outcomeSelectionSource: 'auto',
      edited: false,
      ignored: false,
    },
    'ts-1',
    0,
  );
  assert.equal(confirmed.outcome.status, 'confirmed');
  assert.equal(formatActionKindLabel(confirmed.action.kind), '单击');
  assert.equal(shouldShowConfidenceBadge(confirmed), false);
  assert.equal(operationStatusPresentation('incomplete').shortLabel, '未完成');
  assert.equal(operationStatusPresentation('observerDegraded').tone, 'danger');

  const incomplete = normalizeOperationRecord({
    ...confirmed,
    operationId: 'op-2',
    outcome: {
      ...confirmed.outcome,
      status: 'incomplete',
      summary: '未观测到明确结果',
      confidence: { overall: 0.2 },
    },
    resultSummary: '未观测到明确结果',
  });
  assert.equal(shouldShowConfidenceBadge(incomplete), true);

  const choices = listManualOutcomeChoices(confirmed);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]?.transitionId, 't1');

  const model = buildOperationReviewModel(
    {
      items: [confirmed],
      nextCursor: 'op-1',
      reset: true,
      totalCount: 2,
      diagnostics: [],
    },
    [],
    'ts-1',
  );
  assert.equal(model.status, 'ready');
  assert.equal(model.operations.length, 1);

  const merged = mergeOperationPages(model.operations, [incomplete], false);
  assert.equal(merged.length, 2);

  const windowed = filterOperationsByWindow(merged, 900, 1100);
  assert.equal(windowed.length, 2);

  const repro = buildOperationReproText({
    sessionId: 'ts-1',
    operations: [confirmed, incomplete],
    defectNote: '金额未刷新',
    markedAtMs: 2000,
    windowStartMs: 0,
    windowEndMs: 3000,
  });
  assert.match(repro, /单击按钮“保存” -> “保存成功”提示出现/);
  assert.match(repro, /未观测到明确结果/);
  assert.doesNotMatch(repro, /保存成功提示出现成功/);
  assert.match(repro, /金额未刷新/);

  const panelSource = readFileSync(
    join(__dirname, '../src-react/features/evidence/RecordingReviewPanel.tsx'),
    'utf8',
  );
  assert.match(panelSource, /记录与回顾/);
  assert.match(panelSource, /getTestSessionOperations/);
  assert.match(panelSource, /aria-expanded/);
  assert.match(panelSource, /技术详情/);
  assert.match(panelSource, /恢复自动判断/);
  assert.match(panelSource, /recording-op-node/);
  assert.doesNotMatch(panelSource, /defect-step-card/);

  const pageSource = readFileSync(join(__dirname, '../src-react/pages/RecorderPage.tsx'), 'utf8');
  assert.match(pageSource, /RecordingReviewPanel/);

  const cssSource = readFileSync(join(__dirname, '../src-react/styles/evidence.css'), 'utf8');
  assert.match(cssSource, /recording-op-node/);
  assert.match(cssSource, /prefers-reduced-motion/);

  console.log('recording-review-interaction-test: ok');
}

main();
