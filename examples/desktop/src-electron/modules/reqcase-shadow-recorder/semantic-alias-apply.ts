import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  outcome?: { latencyMs?: number | null } | null;
  action?: {
    target?: {
      automationId?: string | null;
      name?: string | null;
      controlType?: string | null;
    } | null;
  } | null;
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
  const expLeaf = expL.split('.').pop() || '';
  const actLeaf = actL.split('.').pop() || '';
  if (expLeaf && expLeaf === actLeaf && expLeaf.length >= 6) {
    return true;
  }
  // Truncation-tolerant: captured id may cut mid-token (old 256-char cap).
  const markers = ['btn.', 'txt.', 'rad.', 'chk.', 'cmb.', 'spin.', 'lbl.', 'menu.', 'radio.'];
  let suffixIdx = -1;
  for (const marker of markers) {
    const idx = actL.lastIndexOf(marker);
    if (idx > suffixIdx) suffixIdx = idx;
  }
  if (suffixIdx >= 0) {
    const actualSuffix = actL.slice(suffixIdx);
    if (
      actualSuffix.length >= 18 &&
      (expL === actualSuffix || expL.startsWith(actualSuffix))
    ) {
      return true;
    }
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
      // ignore bad snapshot
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
    return {
      ...operation,
      businessAlias: alias,
      title: alias,
      displaySummary:
        typeof latency === 'number'
          ? `${alias} -> ${resultSummary}，耗时 ${latency}ms`
          : `${alias} -> ${resultSummary}`,
      precisionLevel:
        operation.precisionLevel === 'l2' || operation.precisionLevel === 'l3'
          ? 'l4'
          : operation.precisionLevel,
    } as T;
  });
}

export function applyAndPersistHistoricalOperationAliases<T extends OperationLike>(
  sessionDir: string,
  operations: T[],
): T[] {
  const profile = loadSemanticProfileSnapshot(sessionDir);
  const next = applyProfileAliasesToOperations(operations, profile);
  const opsPath = path.join(sessionDir, 'operations.ndjson');
  if (existsSync(opsPath) && next.length > 0) {
    try {
      writeFileSync(
        opsPath,
        `${next.map((item) => JSON.stringify(item)).join('\n')}\n`,
        'utf8',
      );
    } catch {
      // best-effort persistence
    }
  }
  return next;
}
