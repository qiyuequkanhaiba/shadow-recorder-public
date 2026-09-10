import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop/src-react');

// ---------- DefectEvidencePanel overhaul ----------
{
  const p = path.join(root, 'features/evidence/DefectEvidencePanel.tsx');
  let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  // Extend props
  if (!t.includes('enabled?: boolean')) {
    t = t.replace(
      `type DefectEvidencePanelProps = {
  session: TestSessionState | null;
  isRecording: boolean;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
};`,
      `type DefectEvidencePanelProps = {
  session: TestSessionState | null;
  isRecording: boolean;
  enabled?: boolean;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
  onOpenSettings?: () => void;
};`,
    );
  }

  // Improve refreshSteps to rebuild then get
  t = t.replace(
    /const refreshSteps = useCallback\(async \(\) => \{[\s\S]*?\}, \[props, sessionId\]\);/,
    `const refreshSteps = useCallback(async () => {
    const api = getApi();
    if (!api?.getTestSessionSteps) {
      return;
    }
    if (!props.enabled) {
      setSteps([]);
      return;
    }
    if (!sessionId) {
      setSteps([]);
      return;
    }
    try {
      // Always rebuild from events so post-record / mid-record content shows up.
      if (typeof api.rebuildTestSessionSteps === 'function') {
        await api.rebuildTestSessionSteps({ sessionId });
      }
      const rows = await api.getTestSessionSteps({ sessionId });
      const list = Array.isArray(rows) ? rows : [];
      setSteps(list.map((row: any) => mapNativeStep(row ?? {})));
      if (list.length === 0) {
        setStatus((current) => current || '当前会话尚无语义步骤。请确认已开启缺陷证据并完成点击/输入后重建。');
      }
    } catch (error) {
      const message = props.toUiErrorMessage(error);
      if (!/not active|SessionNotFound|no active|not found|disabled/i.test(message)) {
        props.onError(message);
      } else {
        setSteps([]);
      }
    }
  }, [props, sessionId, props.enabled]);`,
  );

  // mark defect uses pre/post from props
  t = t.replace(
    `const result = await api.markTestDefect({
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
      });`,
    `const result = await api.markTestDefect({
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
        preWindowSeconds: props.preWindowSeconds,
        postWindowSeconds: props.postWindowSeconds,
      });`,
  );

  // Disabled UI banner at top of render when session exists path
  if (!t.includes('defect-evidence-disabled')) {
    t = t.replace(
      `if (!props.session) {
    return (
      <section className="defect-evidence-panel" aria-label="缺陷证据">
        <header className="defect-evidence-header">
          <h3>缺陷证据</h3>
          <p>开始录制后可标记缺陷并导出可复现步骤。</p>
        </header>
      </section>
    );
  }

  return (
    <section className="defect-evidence-panel" aria-label="缺陷证据">
      <header className="defect-evidence-header">
        <h3>缺陷证据</h3>
        <p>标记缺陷 → 聚合步骤 → 复制复现说明并导出证据包（与视频时间轴对齐）</p>
      </header>`,
      `if (!props.enabled) {
    return (
      <section className="defect-evidence-panel" aria-label="缺陷证据">
        <header className="defect-evidence-header">
          <h3>缺陷证据</h3>
          <p>该功能默认关闭，不会主动记录控件/键盘语义步骤。</p>
        </header>
        <div className="defect-evidence-disabled">
          <p>请到 <strong>设置 → 缺陷证据</strong> 开启「启用缺陷证据记录」，保存并应用后再开始录制。</p>
          {props.onOpenSettings ? (
            <button type="button" className="btn-primary" onClick={() => props.onOpenSettings?.()}>
              前往设置
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (!props.session) {
    return (
      <section className="defect-evidence-panel" aria-label="缺陷证据">
        <header className="defect-evidence-header">
          <h3>缺陷证据</h3>
          <p>功能已开启。开始录制后将采集语义步骤；停止或标记缺陷后可导出证据包。</p>
        </header>
      </section>
    );
  }

  return (
    <section className="defect-evidence-panel" aria-label="缺陷证据">
      <header className="defect-evidence-header">
        <h3>缺陷证据</h3>
        <p>标记缺陷 → 聚合步骤 → 复制复现说明并导出证据包（与视频时间轴对齐）</p>
      </header>`,
    );
  }

  fs.writeFileSync(p, t, 'utf8');
  console.log('DefectEvidencePanel updated');
}

// ---------- Timeline panel: merge semantic steps when enabled ----------
{
  const p = path.join(root, 'components/RecorderSessionTimelinePanel.tsx');
  let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  if (!t.includes('defectEvidenceEnabled')) {
    t = t.replace(
      "variant?: 'full' | 'compact';\n};",
      `variant?: 'full' | 'compact';
  defectEvidenceEnabled?: boolean;
};`,
    );
  }

  if (!t.includes('defectEvidenceEnabled =')) {
    t = t.replace(
      "variant = 'full',\n  } = props;\n  const isCompact = variant === 'compact';",
      `variant = 'full',
    defectEvidenceEnabled = false,
  } = props;
  const isCompact = variant === 'compact';`,
    );
  }

  // Add semantic steps state + load
  if (!t.includes('semanticSteps')) {
    t = t.replace(
      'const [pendingExportMode, setPendingExportMode] = useState<EvidenceExportMode | null>(null);',
      `const [pendingExportMode, setPendingExportMode] = useState<EvidenceExportMode | null>(null);
  const [semanticSteps, setSemanticSteps] = useState<Array<{
    stepId: string;
    startedAtMs: number;
    title: string;
    stepType: string;
    precisionLevel?: string;
  }>>([]);`,
    );

    // after deferredEvents, add effect to load steps
    t = t.replace(
      'const deferredEvents = useDeferredValue(events);',
      `const deferredEvents = useDeferredValue(events);

  useEffect(() => {
    let cancelled = false;
    async function loadSteps() {
      if (!defectEvidenceEnabled || !selectedSessionId) {
        if (!cancelled) setSemanticSteps([]);
        return;
      }
      const api = (window as any).reqcaseShadowRecorder;
      if (!api?.getTestSessionSteps) {
        return;
      }
      try {
        if (typeof api.rebuildTestSessionSteps === 'function') {
          await api.rebuildTestSessionSteps({ sessionId: selectedSessionId });
        }
        const rows = await api.getTestSessionSteps({ sessionId: selectedSessionId });
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setSemanticSteps(
          list.map((row: any) => ({
            stepId: String(row.stepId ?? row.step_id ?? ''),
            startedAtMs: Number(row.startedAtMs ?? row.started_at_ms ?? 0),
            title: String(row.title ?? '步骤'),
            stepType: String(row.stepType ?? row.step_type ?? 'step'),
            precisionLevel: row.precisionLevel ?? row.precision_level,
          })),
        );
      } catch {
        if (!cancelled) setSemanticSteps([]);
      }
    }
    void loadSteps();
    return () => {
      cancelled = true;
    };
  }, [defectEvidenceEnabled, selectedSessionId, events.length, loading]);`,
    );

    // Merge into filteredEvents display - replace filteredEvents useMemo if exists or build unified list
    // Find filteredEvents definition
    if (t.includes('const filteredEvents = useMemo')) {
      // After filteredEvents, create timelineItems for render
      t = t.replace(
        /const filteredEvents = useMemo\([\s\S]*?\}, \[[^\]]+\]\);/,
        (block) => `${block}

  const timelineItems = useMemo(() => {
    type Item = {
      key: string;
      occurredAtMs: number;
      kind: 'event' | 'step';
      title: string;
      badge: string;
      tone: string;
      event?: TestSessionTimelineEvent;
    };
    const items: Item[] = [];
    for (const event of filteredEvents) {
      // When defect mode on, prefer semantic steps over raw step_captured noise.
      if (defectEvidenceEnabled && event.eventType === 'step_captured') {
        continue;
      }
      items.push({
        key: event.eventId,
        occurredAtMs: event.occurredAtMs,
        kind: 'event',
        title: resolveEventSummary(event),
        badge: resolveEventLevel(event),
        tone: resolveEventTone(event),
        event,
      });
    }
    if (defectEvidenceEnabled) {
      for (const step of semanticSteps) {
        if (!step.stepId || !step.startedAtMs) continue;
        items.push({
          key: \`step:\${step.stepId}\`,
          occurredAtMs: step.startedAtMs,
          kind: 'step',
          title: step.title,
          badge: (step.precisionLevel ?? 'STEP').toUpperCase(),
          tone: 'operation',
        });
      }
    }
    items.sort((a, b) => b.occurredAtMs - a.occurredAtMs);
    return items;
  }, [filteredEvents, semanticSteps, defectEvidenceEnabled]);`,
      );
    }

    // Update render list to use timelineItems when compact or when defect enabled
    // Replace filteredEvents.map in list with timelineItems
    if (t.includes('filteredEvents.map') && t.includes('timelineItems')) {
      // replace the ol list mapping carefully - use timelineItems for compact
      t = t.replace(
        'filteredEvents.length === 0',
        'timelineItems.length === 0',
      );
      // replace map source - might break full mode details. Use timelineItems always once defined.
      t = t.replace(
        '{filteredEvents.map((event, index) => {',
        '{timelineItems.map((item, index) => {\n              const event = item.event;',
      );
      // Fix references inside map - active uses event.eventId
      // Need more careful edit of the map body - read current body
    }
  }

  fs.writeFileSync(p, t, 'utf8');
  console.log('timeline panel patched (partial)');
}

// CSS for settings + disabled
{
  const css = path.join(root, 'styles/evidence.css');
  let t = fs.readFileSync(css, 'utf8');
  if (!t.includes('defect-evidence-disabled')) {
    t += `
.defect-evidence-disabled {
  padding: 16px;
  border-radius: 12px;
  border: 1px dashed rgba(148, 163, 184, 0.35);
  display: grid;
  gap: 10px;
}
.settings-form-panel {
  display: grid;
  gap: 14px;
  padding: 8px 4px 20px;
}
.settings-form-header h3 {
  margin: 0 0 6px;
}
.settings-form-header p {
  margin: 0;
  opacity: 0.75;
  font-size: 12px;
  line-height: 1.5;
}
.settings-toggle-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.18);
}
.settings-toggle-row span {
  display: grid;
  gap: 4px;
}
.settings-toggle-row small {
  opacity: 0.7;
}
.settings-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.settings-form-grid.is-disabled {
  opacity: 0.45;
}
.settings-form-grid label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.settings-form-grid input[type='number'] {
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: transparent;
  color: inherit;
  padding: 8px;
}
.settings-form-note {
  font-size: 12px;
  opacity: 0.75;
}
.settings-form-note p {
  margin: 0 0 6px;
}
.event-timeline-item.kind-step .event-timeline-badge {
  background: rgba(34, 197, 94, 0.16);
}
`;
    fs.writeFileSync(css, t, 'utf8');
    console.log('css settings/disabled added');
  }
}

console.log('panel+timeline script done');
