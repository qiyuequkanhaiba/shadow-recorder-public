/**
 * M8-T2 performance skeleton for operation semantic recording.
 *
 * This script is intentionally lightweight: it freezes metric contracts and
 * sampling methods without requiring a 1h/8h long-run on every PR.
 *
 * Long-run execution remains a release sign-off step documented in
 * docs/operation-semantic-manual-test.md and docs/performance-baseline.md.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type ModeName = 'observer-off' | 'observer-on' | 'polling-degraded';

type ModeContract = {
  mode: ModeName;
  description: string;
  requiredCounters: string[];
  maxExtraCpuPoints: number;
  maxExtraRssMb: number;
};

const MODE_CONTRACTS: ModeContract[] = [
  {
    mode: 'observer-off',
    description: 'Semantic recording / UIA observer disabled; pure capture baseline.',
    requiredCounters: ['eventsPerMinute', 'cpuP95', 'rssMaxMb'],
    maxExtraCpuPoints: 0,
    maxExtraRssMb: 0,
  },
  {
    mode: 'observer-on',
    description: 'UIA observer + operation builder enabled under normal event rate.',
    requiredCounters: [
      'eventsPerMinute',
      'cpuP95',
      'rssMaxMb',
      'uiaObserverQueueDepth',
      'uiaObserverDroppedTotal',
      'uiaObserverDuplicateDropTotal',
      'uiaObserverRateLimitDropTotal',
    ],
    maxExtraCpuPoints: 3,
    maxExtraRssMb: 50,
  },
  {
    mode: 'polling-degraded',
    description: 'Observer degraded; interaction compensation polling active.',
    requiredCounters: [
      'cpuP95',
      'rssMaxMb',
      'uiaObserverPollingAttemptTotal',
      'uiaObserverCircuitOpen',
      'observerDegradedOutcomes',
    ],
    maxExtraCpuPoints: 3,
    maxExtraRssMb: 50,
  },
];

function main(): void {
  for (const contract of MODE_CONTRACTS) {
    assert.ok(contract.requiredCounters.length >= 3, `${contract.mode} counters`);
    assert.ok(contract.maxExtraCpuPoints <= 3, `${contract.mode} cpu budget`);
    assert.ok(contract.maxExtraRssMb <= 50, `${contract.mode} memory budget`);
  }

  const report = {
    kind: 'reqcase.operation-performance-skeleton',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: 'skeleton-ready',
    acceptance: {
      extraCpuPointsMax: 3,
      extraRssMbMax: 50,
      stormQueueBounded: true,
      stopMustFinish: true,
      longRunHours: [1, 8],
    },
    modes: MODE_CONTRACTS,
    stormInjection: {
      structureEventsPerSecond: 2_000,
      propertyEventsPerSecond: 1_000,
      expect: ['dedupe', 'rate-limit', 'high-value-retention', 'bounded-queue'],
    },
    recoveryScenarios: [
      'target-process-crash',
      'target-process-restart',
      'target-switch',
      'session-lock-screen',
      'observer-worker-crash-backoff',
    ],
    note:
      'Skeleton only. Populate measured values from native 60/480 minute runs before Release A sign-off.',
  };

  const outDir = path.join(__dirname, '../.ci-artifacts/operation-performance');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'operation-performance-skeleton.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[operation-performance-test] skeleton ok');
  console.log(`  report: ${outPath}`);
}

main();
