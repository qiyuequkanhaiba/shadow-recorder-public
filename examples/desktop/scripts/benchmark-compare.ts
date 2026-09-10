import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type BenchmarkReport = {
  metrics?: Record<string, unknown>;
};

type Comparison = {
  metric: string;
  baseline: number;
  candidate: number;
  increase: number;
  regressionRatio: number | null;
  regressionRatioLabel: string;
  threshold: number;
  status: 'pass' | 'fail';
};

type Options = {
  baseline: string;
  candidate: string;
  captureGoal: number;
  encodeGoal: number;
  dropGoal: number;
  resultJson: string;
  resultMd: string;
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  const required = ['--baseline', '--candidate', '--result-json', '--result-md'];
  for (const key of required) {
    assert.ok(values.has(key), `Missing required argument: ${key}`);
  }

  return {
    baseline: resolve(values.get('--baseline') ?? ''),
    candidate: resolve(values.get('--candidate') ?? ''),
    captureGoal: Number.parseFloat(values.get('--capture-goal') ?? '0.15'),
    encodeGoal: Number.parseFloat(values.get('--encode-goal') ?? '0.15'),
    dropGoal: Number.parseFloat(values.get('--drop-goal') ?? '0.30'),
    resultJson: resolve(values.get('--result-json') ?? ''),
    resultMd: resolve(values.get('--result-md') ?? ''),
  };
}

function assertRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number in [0,1], got ${value}`);
  }
}

function readReport(filePath: string): BenchmarkReport {
  return JSON.parse(readFileSync(filePath, 'utf8')) as BenchmarkReport;
}

function getMetric(report: BenchmarkReport, metricName: string): number {
  const value = report.metrics?.[metricName];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Benchmark report is missing numeric metrics.${metricName}.`);
  }
  return value;
}

function getDropTotal(report: BenchmarkReport): number {
  return (
    getMetric(report, 'droppedStepsTotal') +
    getMetric(report, 'captureQueueDropTotal') +
    getMetric(report, 'encodeQueueDropTotal')
  );
}

function compareMetric(
  metric: string,
  baseline: number,
  candidate: number,
  threshold: number,
): Comparison {
  const increase = candidate - baseline;
  let regressionRatio: number | null = null;
  let regressionRatioLabel = '0.00%';
  let failed = false;

  if (baseline <= 0) {
    if (candidate > baseline) {
      regressionRatioLabel = 'new regression from zero baseline';
      failed = true;
    }
  } else {
    const ratio = increase / baseline;
    regressionRatio = Number.parseFloat(ratio.toFixed(6));
    regressionRatioLabel = `${(ratio * 100).toFixed(2)}%`;
    failed = candidate > baseline && ratio > threshold;
  }

  return {
    metric,
    baseline,
    candidate,
    increase: Number.parseFloat(increase.toFixed(6)),
    regressionRatio,
    regressionRatioLabel,
    threshold,
    status: failed ? 'fail' : 'pass',
  };
}

function writeResults(options: Options, comparisons: Comparison[]): boolean {
  const failed = comparisons.filter((comparison) => comparison.status === 'fail');
  const passed = failed.length === 0;
  const result = {
    passed,
    createdAt: new Date().toISOString(),
    baselinePath: options.baseline,
    candidatePath: options.candidate,
    thresholds: {
      captureLatencyP95Ms: options.captureGoal,
      encodeLatencyP95Ms: options.encodeGoal,
      dropTotal: options.dropGoal,
    },
    comparisons,
  };

  mkdirSync(dirname(options.resultJson), { recursive: true });
  mkdirSync(dirname(options.resultMd), { recursive: true });
  writeFileSync(options.resultJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const markdown = [
    '# Benchmark Compare Result',
    '',
    `- Passed: ${passed}`,
    `- Baseline: ${options.baseline}`,
    `- Candidate: ${options.candidate}`,
    '',
    '| Metric | Baseline | Candidate | Increase | Regression | Threshold | Status |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...comparisons.map((comparison) => {
      const threshold = `${(comparison.threshold * 100).toFixed(2)}%`;
      return `| ${comparison.metric} | ${comparison.baseline} | ${comparison.candidate} | ${comparison.increase} | ${comparison.regressionRatioLabel} | ${threshold} | ${comparison.status} |`;
    }),
    '',
  ].join('\n');
  writeFileSync(options.resultMd, markdown, 'utf8');

  if (!passed) {
    console.error(`Benchmark compare failed: ${failed.map((comparison) => comparison.metric).join(', ')}`);
  }
  return passed;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  assertRatio('capture-goal', options.captureGoal);
  assertRatio('encode-goal', options.encodeGoal);
  assertRatio('drop-goal', options.dropGoal);

  const baseline = readReport(options.baseline);
  const candidate = readReport(options.candidate);
  const comparisons = [
    compareMetric(
      'captureLatencyP95Ms',
      getMetric(baseline, 'captureLatencyP95Ms'),
      getMetric(candidate, 'captureLatencyP95Ms'),
      options.captureGoal,
    ),
    compareMetric(
      'encodeLatencyP95Ms',
      getMetric(baseline, 'encodeLatencyP95Ms'),
      getMetric(candidate, 'encodeLatencyP95Ms'),
      options.encodeGoal,
    ),
    compareMetric('dropTotal', getDropTotal(baseline), getDropTotal(candidate), options.dropGoal),
  ];

  const passed = writeResults(options, comparisons);
  process.exit(passed ? 0 : 1);
}

main();
