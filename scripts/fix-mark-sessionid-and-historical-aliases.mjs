/**
 * Fix:
 * 1) mark-test-defect IPC drops sessionId → pass through
 * 2) historical rebuild only re-reads disk → re-apply profile aliases
 * 3) mark on historical sessions not in native memory via disk-safe path
 * 4) UI prefers businessAlias for display
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/desktop');
const read = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');
const write = (rel, s) => fs.writeFileSync(path.join(desktop, rel), s, 'utf8');

// ---- Create shared alias apply util ----
const utilPath = 'src-electron/modules/reqcase-shadow-recorder/semantic-alias-apply.ts';
write(
  utilPath,
  `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type AliasRule = {
  alias?: string | null;
  automationId?: string | null;
  matchAutomationId?: string | null;
  controlName?: string | null;
  matchControlName?: string | null;
  controlType?: string | null;
  priority?: number;
};

type ProfileLike = {
  enabled?: boolean;
  aliasRules?: AliasRule[];
};

export type OperationLike = {
  title?: string;
  displaySummary?: string;
  resultSummary?: string;
  businessAlias?: string | null;
  precisionLevel?: string;
  outcome?: { latencyMs?: number };
  action?: {
    target?: {
      automationId?: string | null;
      name?: string | null;
      controlType?: string | null;
    } | null;
  } | null;
  [key: string]: unknown;
};

function automationIdMatches(expected: string, actual: string): boolean {
  const exp = expected.trim();
  const act = actual.trim();
  if (!exp || !act) return false;
  if (act.toLowerCase() === exp.toLowerCase()) return true;
  const expL = exp.toLowerCase();
  const actL = act.toLowerCase();
  if (actL.endsWith(expL)) {
    const prefixLen = actL.length - expL.length;
    return prefixLen === 0 || actL[prefixLen - 1] === '.';
  }
  if (expL.endsWith(actL)) {
    const prefixLen = expL.length - actL.length;
    return prefixLen === 0 || expL[prefixLen - 1] === '.';
  }
  return false;
}

export function loadSemanticProfileSnapshot(sessionDir: string): ProfileLike | null {
  const candidates = [
    path.join(sessionDir, 'config.semantic-profile.snapshot.json'),
    path.join(sessionDir, 'semantic-profile.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const profile = raw?.profile && typeof raw.profile === 'object' ? raw.profile : raw;
      if (profile && Array.isArray(profile.aliasRules)) {
        return profile as ProfileLike;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function resolveBusinessAlias(
  profile: ProfileLike | null | undefined,
  automationId?: string | null,
  controlName?: string | null,
  controlType?: string | null,
): string | null {
  if (!profile || profile.enabled === false) return null;
  const rules = Array.isArray(profile.aliasRules) ? profile.aliasRules : [];
  let best: { alias: string; score: number } | null = null;
  for (const rule of rules) {
    const expectedAuto = (rule.matchAutomationId || rule.automationId || '').trim();
    const expectedName = (rule.matchControlName || rule.controlName || '').trim();
    const expectedType = (rule.controlType || '').trim();
    const alias = (rule.alias || '').trim();
    if (!alias) continue;

    let matched = false;
    let score = Number(rule.priority ?? 0) * 10_000;

    if (expectedAuto) {
      if (!automationId || !automationIdMatches(expectedAuto, automationId)) {
        continue;
      }
      matched = true;
      score += expectedAuto.length;
    } else {
      if (expectedName) {
        if (!controlName || controlName.toLowerCase() !== expectedName.toLowerCase()) continue;
        matched = true;
        score += 100;
      }
      if (expectedType) {
        if (!controlType || controlType.toLowerCase() !== expectedType.toLowerCase()) continue;
        matched = true;
        score += 10;
      }
    }

    if (!matched) continue;
    if (!best || score > best.score) {
      best = { alias, score };
    }
  }
  return best?.alias ?? null;
}

export function applyProfileAliasesToOperations<T extends OperationLike>(
  operations: T[],
  profile: ProfileLike | null | undefined,
): T[] {
  if (!profile || !Array.isArray(operations) || operations.length === 0) {
    return operations;
  }
  return operations.map((operation) => {
    const target = operation.action?.target;
    const alias = resolveBusinessAlias(
      profile,
      target?.automationId,
      target?.name,
      target?.controlType,
    );
    if (!alias) return operation;
    const latency = operation.outcome?.latencyMs;
    const resultSummary = operation.resultSummary || '结果待确认';
    const next: T = {
      ...operation,
      businessAlias: alias,
      title: alias,
      displaySummary:
        typeof latency === 'number'
          ? \`\${alias} -> \${resultSummary}，耗时 \${latency}ms\`
          : \`\${alias} -> \${resultSummary}\`,
      precisionLevel:
        operation.precisionLevel === 'l2' || operation.precisionLevel === 'l3'
          ? 'l4'
          : operation.precisionLevel,
    };
    return next;
  });
}

export function applyAndPersistHistoricalOperationAliases(
  sessionDir: string,
  operations: OperationLike[],
): OperationLike[] {
  const profile = loadSemanticProfileSnapshot(sessionDir);
  const next = applyProfileAliasesToOperations(operations, profile);
  const opsPath = path.join(sessionDir, 'operations.ndjson');
  if (existsSync(opsPath) && next.length > 0) {
    try {
      writeFileSync(
        opsPath,
        \`\${next.map((item) => JSON.stringify(item)).join('\\n')}\\n\`,
        'utf8',
      );
    } catch {
      // best-effort persistence
    }
  }
  return next;
}
`,
);
console.log('wrote semantic-alias-apply.ts');

// ---- Patch service.ts ----
{
  let s = read('src-electron/modules/reqcase-shadow-recorder/service.ts');

  if (!s.includes('semantic-alias-apply')) {
    // add import near historical imports
    if (s.includes("from './historical-session-reader'")) {
      s = s.replace(
        "from './historical-session-reader';",
        `from './historical-session-reader';
import {
  applyAndPersistHistoricalOperationAliases,
  applyProfileAliasesToOperations,
  loadSemanticProfileSnapshot,
} from './semantic-alias-apply';`,
      );
    } else {
      s = `import {
  applyAndPersistHistoricalOperationAliases,
  applyProfileAliasesToOperations,
  loadSemanticProfileSnapshot,
} from './semantic-alias-apply';\n` + s;
    }
  }

  // markTestDefect with sessionId
  s = s.replace(
    /markTestDefect\(input: \{[\s\S]*?\} = \{\}\) \{\s*return nativeMarkTestDefect\(input\);\s*\}/,
    `markTestDefect(input: {
    sessionId?: string;
    note?: string;
    expected?: string;
    actual?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
  } = {}) {
    // Always forward sessionId so stopped sessions can be marked without requiring active recording.
    return nativeMarkTestDefect({
      sessionId: input.sessionId,
      note: input.note,
      expected: input.expected,
      actual: input.actual,
      markedAtMs: input.markedAtMs,
      preWindowSeconds: input.preWindowSeconds,
      postWindowSeconds: input.postWindowSeconds,
    });
  }`,
  );

  // getSessionOperations: apply aliases for historical path
  const getHistBlock = `if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
    }`;
  const getHistFixed = `if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      const tail = readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
      const sessionDir = historical.sessionDir || '';
      if (sessionDir) {
        const enriched = applyAndPersistHistoricalOperationAliases(sessionDir, tail.items || []);
        return { ...tail, items: enriched as typeof tail.items };
      }
      return tail;
    }`;
  if (s.includes(getHistBlock)) {
    s = s.replace(getHistBlock, getHistFixed);
    console.log('getSessionOperations historical alias apply');
  } else {
    console.warn('getSessionOperations hist block not exact');
  }

  // rebuildSessionOperations: apply aliases instead of fake no-op rebuild
  const rebHist = `if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionOperationsTail(historical, undefined, 1000).items;
    }`;
  const rebHistFixed = `if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      const items = readHistoricalSessionOperationsTail(historical, undefined, 1000).items || [];
      const sessionDir = historical.sessionDir || '';
      if (sessionDir) {
        return applyAndPersistHistoricalOperationAliases(sessionDir, items) as typeof items;
      }
      return items;
    }`;
  if (s.includes(rebHist)) {
    s = s.replace(rebHist, rebHistFixed);
    console.log('rebuildSessionOperations historical alias apply');
  } else {
    console.warn('rebuild hist block not exact');
  }

  // After native rebuild, also re-apply snapshot aliases as safety net
  if (s.includes('return nativeRebuildTestSessionOperations(input.sessionId);')) {
    s = s.replace(
      'return nativeRebuildTestSessionOperations(input.sessionId);',
      `const rebuilt = nativeRebuildTestSessionOperations(input.sessionId);
      const sessionDir = historical?.sessionDir
        || this.findHistoricalSession(input.sessionId)?.sessionDir
        || '';
      if (sessionDir) {
        return applyAndPersistHistoricalOperationAliases(sessionDir, rebuilt || []) as typeof rebuilt;
      }
      return rebuilt;`,
    );
    console.log('native rebuild alias safety net');
  }

  write('src-electron/modules/reqcase-shadow-recorder/service.ts', s);
  console.log('service.ts patched');
}

// ---- Patch ipc.ts mark handler ----
{
  let s = read('src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  const re =
    /ipcMain\.handle\('reqcase:shadow-recorder:mark-test-defect', async \(_event, input\) => \{[\s\S]*?\n  \}\);/;
  const m = re.exec(s);
  if (!m) {
    console.warn('mark ipc handler not found');
  } else {
    const next = `ipcMain.handle('reqcase:shadow-recorder:mark-test-defect', async (_event, input) => {
    const record = isRecord(input) ? input : {};
    return service.markTestDefect({
      sessionId: optionalString(record, 'sessionId'),
      note: optionalString(record, 'note') ?? optionalString(record, 'message'),
      expected: optionalString(record, 'expected'),
      actual: optionalString(record, 'actual'),
      markedAtMs: optionalNumber(record, 'markedAtMs'),
      preWindowSeconds: optionalNumber(record, 'preWindowSeconds'),
      postWindowSeconds: optionalNumber(record, 'postWindowSeconds'),
    });
  });`;
    s = s.slice(0, m.index) + next + s.slice(m.index + m[0].length);
    write('src-electron/modules/reqcase-shadow-recorder/ipc.ts', s);
    console.log('ipc mark sessionId fixed');
  }
}

// ---- native-binding markTestDefect types ----
{
  let s = read('src-electron/native-binding.ts');
  s = s.replace(
    /markTestDefect\(input\?: \{\s*note\?: string;\s*expected\?: string;\s*actual\?: string;\s*markedAtMs\?: number;\s*preWindowSeconds\?: number;\s*postWindowSeconds\?: number;\s*\}/,
    `markTestDefect(input?: {
  sessionId?: string;
  note?: string;
  expected?: string;
  actual?: string;
  markedAtMs?: number;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
}`,
  );
  write('src-electron/native-binding.ts', s);
  console.log('native-binding mark type updated');
}

// ---- UI: show businessAlias prominently; mark does not imply video loss ----
{
  let s = read('src-react/features/evidence/RecordingReviewPanel.tsx');
  // display title
  if (!s.includes('operation.businessAlias || operation.title')) {
    s = s.replace(
      '<strong className="recording-op-title">{operation.title}</strong>',
      `<strong className="recording-op-title">{operation.businessAlias || operation.title}</strong>
                            {operation.businessAlias && operation.businessAlias !== operation.title ? (
                              <span className="recording-op-alias-tag">业务别名</span>
                            ) : operation.businessAlias ? (
                              <span className="recording-op-alias-tag">业务别名</span>
                            ) : null}`,
    );
  }
  // ensure mark message clarifies video not deleted
  s = s.replace(
    `setStatus(
        \`已添加问题标记：前后 \${mapped.preWindowSeconds}s/\${mapped.postWindowSeconds}s，窗内操作 \${mapped.stepCount} 条。\`,
      );`,
    `setStatus(
        \`已添加问题标记：前后 \${mapped.preWindowSeconds}s/\${mapped.postWindowSeconds}s，窗内操作 \${mapped.stepCount} 条。录像文件不会因标记删除。\`,
      );`,
  );
  // on mark, rebuild then reload; if rebuild fails still show ops
  s = s.replace(
    `setDefect(mapped);
      await loadOperationsPage({ rebuild: true });`,
    `setDefect(mapped);
      try {
        await loadOperationsPage({ rebuild: true });
      } catch {
        await loadOperationsPage({ rebuild: false });
      }`,
  );
  write('src-react/features/evidence/RecordingReviewPanel.tsx', s);
  console.log('UI alias display + mark messaging');
}

// small CSS for alias tag
{
  const cssPath = 'src-react/styles/evidence.css';
  let css = read(cssPath);
  if (!css.includes('recording-op-alias-tag')) {
    css += `

.recording-op-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.4;
}

.recording-op-alias-tag {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--accent-secondary) 35%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent-secondary) 12%, transparent);
  color: var(--accent-secondary);
  font-size: 11px;
  font-weight: 650;
  vertical-align: middle;
}
`;
    write(cssPath, css);
    console.log('css alias tag');
  }
}

console.log('ALL DONE');
