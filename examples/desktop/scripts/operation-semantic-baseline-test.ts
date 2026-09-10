import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

interface CliOptions {
  sessionsRoot: string;
  outputRoot: string;
  minimumSessions: number;
  limit: number | null;
  includeActive: boolean;
}

interface ParseResult {
  records: JsonRecord[];
  errorCount: number;
}

interface SessionMetrics {
  sessionId: string;
  status: string;
  durationMs: number | null;
  eventCount: number;
  uiaProbeEventCount: number;
  uiaTimeoutEventCount: number;
  stepCount: number;
  targetableStepCount: number;
  coordinateOnlyCount: number;
  semanticTargetCount: number;
  unidentifiedTargetCount: number;
  l2OrHigherCount: number;
  precisionCounts: Record<string, number>;
  stepTypeCounts: Record<string, number>;
  sourceEventReferenceCount: number;
  resolvedSourceEventReferenceCount: number;
  sourceTimestampDeltaMs: number[];
  artifactReferenceCount: number;
  existingArtifactReferenceCount: number;
  parseErrorCount: number;
  observedStepFields: string[];
}

interface MetricSamplingContract {
  status: 'measured' | 'archive-derived-proxy' | 'requires-native-long-run' | 'requires-annotations' | 'unavailable-before-operations-v1';
  source: string;
  method: string;
}

interface RuntimeMetric extends MetricSamplingContract {
  value: number | null;
  unit: string;
}

interface StepFieldMapping {
  sourceField: string;
  apiField: string;
  reviewUsage: string;
}

interface BaselineReport {
  schemaVersion: 1;
  kind: 'reqcase.operation-semantic-baseline';
  generatedAt: string;
  sessionsRoot: string;
  selection: {
    discoveredSessionCount: number;
    eligibleSessionCount: number;
    analyzedSessionCount: number;
    minimumRequired: number;
    includeActive: boolean;
    limit: number | null;
  };
  definitions: {
    targetableStep: string;
    coordinateOnly: string;
    semanticTarget: string;
    resultMetrics: string;
    seekMetrics: string;
  };
  totals: {
    eventCount: number;
    analyzedDurationMs: number;
    uiaProbeEventCount: number;
    uiaTimeoutEventCount: number;
    stepCount: number;
    targetableStepCount: number;
    coordinateOnlyCount: number;
    semanticTargetCount: number;
    unidentifiedTargetCount: number;
    precisionCounts: Record<string, number>;
    stepTypeCounts: Record<string, number>;
    sourceEventReferenceCount: number;
    resolvedSourceEventReferenceCount: number;
    artifactReferenceCount: number;
    existingArtifactReferenceCount: number;
    parseErrorCount: number;
  };
  rates: {
    coordinateOnlyRate: number | null;
    semanticTargetRate: number | null;
    unidentifiedTargetRate: number | null;
    l2OrHigherRate: number | null;
    sourceEventResolutionRate: number | null;
    artifactResolutionRate: number | null;
  };
  timing: {
    sourceTimestampDeltaSampleCount: number;
    sourceTimestampDeltaP50Ms: number | null;
    sourceTimestampDeltaP95Ms: number | null;
    sourceTimestampDeltaMaxMs: number | null;
  };
  availability: {
    targetRecognition: 'available';
    operationOutcome: 'unavailable-before-operations-v1';
    confirmedOutcomeAccuracy: 'requires-golden-annotations';
    incompleteHonesty: 'requires-golden-annotations';
    videoSeekAlignment: 'requires-manual-video-annotations';
    runtimePerformance: 'measured-by-performance-baseline';
  };
  runtimeBaseline: {
    eventRatePerMinute: RuntimeMetric;
    uiaTimeoutRate: RuntimeMetric;
    cpuP95Percent: RuntimeMetric;
    maxRssMb: RuntimeMetric;
    oneHourStabilityPass: RuntimeMetric;
  };
  acceptanceMetricMethods: Record<string, MetricSamplingContract>;
  contract: {
    stepSchemaVersions: number[];
    observedStepFields: string[];
    stepNdjsonSchema: {
      fileName: 'steps.ndjson';
      recordKind: 'reqcase.test-session-step';
      requiredFields: string[];
      optionalFields: string[];
      privacyNotes: string[];
    };
    napiApi: {
      functionName: 'get_test_session_steps';
      jsBinding: 'getTestSessionSteps';
      returnType: 'JsTestSessionStepRecord[]';
      fieldNaming: 'snake_case in native NAPI object; preload maps to camelCase for React';
    };
    reviewPageFieldMapping: StepFieldMapping[];
  };
  sessions: SessionMetrics[];
}

const NON_TARGETABLE_STEP_TYPES = new Set([
  'window_switch',
  'note',
  'defect_mark',
  'manual_mark',
  'session_started',
  'session_stopped',
]);

const STEP_REQUIRED_FIELDS = [
  'schemaVersion',
  'kind',
  'stepId',
  'sessionId',
  'startedAtMs',
  'endedAtMs',
  'relativeMsFromSessionStart',
  'stepType',
  'title',
  'summary',
  'precisionLevel',
  'confidence',
  'sourceEventIds',
  'artifactRefs',
];

const STEP_OPTIONAL_FIELDS = [
  'processName',
  'windowTitle',
  'controlName',
  'controlType',
  'automationId',
  'className',
  'x',
  'y',
  'displayId',
  'fullImagePath',
  'thumbImagePath',
  'edited',
  'originalTitle',
  'businessAlias',
];

const REVIEW_PAGE_FIELD_MAPPING: StepFieldMapping[] = [
  { sourceField: 'stepId', apiField: 'stepId', reviewUsage: 'stable row key and edit target' },
  { sourceField: 'startedAtMs', apiField: 'startedAtMs', reviewUsage: 'timeline ordering and timestamp' },
  { sourceField: 'stepType', apiField: 'stepType', reviewUsage: 'timeline item kind and filtering' },
  { sourceField: 'title', apiField: 'title', reviewUsage: 'primary operation sentence' },
  { sourceField: 'summary', apiField: 'summary', reviewUsage: 'secondary detail / export text' },
  { sourceField: 'precisionLevel', apiField: 'precisionLevel', reviewUsage: 'small badge in RecorderSessionTimelinePanel' },
  { sourceField: 'sourceEventIds', apiField: 'sourceEventIds', reviewUsage: 'folded technical detail and traceability' },
  { sourceField: 'artifactRefs', apiField: 'artifactRefs', reviewUsage: 'screenshot/video evidence lookup' },
  { sourceField: 'businessAlias', apiField: 'businessAlias', reviewUsage: 'optional user/domain alias' },
];

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv: string[]): CliOptions {
  const developmentRoot = path.resolve(process.cwd(), 'dist-electron', 'reports', 'test-sessions');
  const fallbackRoot = path.resolve(process.cwd(), 'reports', 'test-sessions');
  const options: CliOptions = {
    sessionsRoot: existsSync(developmentRoot) ? developmentRoot : fallbackRoot,
    outputRoot: path.resolve(process.cwd(), '.ci-artifacts', 'operation-semantic-baseline'),
    minimumSessions: 5,
    limit: null,
    includeActive: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    switch (value) {
      case '--sessions-root':
        options.sessionsRoot = path.resolve(next ?? options.sessionsRoot);
        index += 1;
        break;
      case '--output-root':
        options.outputRoot = path.resolve(next ?? options.outputRoot);
        index += 1;
        break;
      case '--minimum-sessions':
        options.minimumSessions = Math.max(1, parseInteger(next, options.minimumSessions));
        index += 1;
        break;
      case '--limit': {
        const parsed = parseInteger(next, 0);
        options.limit = parsed > 0 ? parsed : null;
        index += 1;
        break;
      }
      case '--include-active':
        options.includeActive = true;
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  return options;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readJsonRecord(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return asRecord(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function readNdjson(filePath: string): ParseResult {
  if (!existsSync(filePath)) {
    return { records: [], errorCount: 0 };
  }

  const records: JsonRecord[] = [];
  let errorCount = 0;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line));
      if (record) {
        records.push(record);
      } else {
        errorCount += 1;
      }
    } catch {
      errorCount += 1;
    }
  }
  return { records, errorCount };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function isTargetableStep(step: JsonRecord): boolean {
  const stepType = asString(step.stepType) ?? asString(step.step_type) ?? 'unknown';
  return !NON_TARGETABLE_STEP_TYPES.has(stepType);
}

function hasControlIdentity(step: JsonRecord): boolean {
  return [
    step.controlName,
    step.control_name,
    step.automationId,
    step.automation_id,
    step.controlType,
    step.control_type,
  ].some((value) => asString(value) !== null);
}

function hasCoordinate(step: JsonRecord): boolean {
  return asNumber(step.x) !== null && asNumber(step.y) !== null;
}

function eventIdOf(event: JsonRecord): string | null {
  return asString(event.eventId) ?? asString(event.event_id);
}

function eventTimestampOf(event: JsonRecord): number | null {
  return asNumber(event.occurredAtMs)
    ?? asNumber(event.occurred_at_ms)
    ?? asNumber(event.timestampMs)
    ?? asNumber(event.timestamp_ms);
}

function eventText(event: JsonRecord): string {
  return [
    event.eventType,
    event.event_type,
    event.logSource,
    event.log_source,
    event.systemSource,
    event.system_source,
    event.precisionLevel,
    event.precision_level,
    event.message,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function eventLooksLikeUiaProbe(event: JsonRecord): boolean {
  const precision = asString(event.precisionLevel) ?? asString(event.precision_level);
  return eventText(event).includes('uia')
    || ['controlName', 'control_name', 'automationId', 'automation_id', 'controlType', 'control_type']
      .some((key) => asString(event[key]) !== null)
    || precision === 'l2'
    || precision === 'l3'
    || precision === 'l4';
}

function eventLooksLikeUiaTimeout(event: JsonRecord): boolean {
  const text = eventText(event);
  return text.includes('uia') && (text.includes('timeout') || text.includes('timed out'));
}

function stepTimestampOf(step: JsonRecord): number | null {
  return asNumber(step.startedAtMs)
    ?? asNumber(step.started_at_ms)
    ?? asNumber(step.timestampMs)
    ?? asNumber(step.timestamp_ms);
}

function sourceEventIdsOf(step: JsonRecord): string[] {
  const value = step.sourceEventIds ?? step.source_event_ids;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function artifactRefsOf(step: JsonRecord): string[] {
  const value = step.artifactRefs ?? step.artifact_refs;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function analyzeSession(sessionDir: string): SessionMetrics | null {
  const manifest = readJsonRecord(path.join(sessionDir, 'session.json')) ?? {};
  const events = readNdjson(path.join(sessionDir, 'events.ndjson'));
  const steps = readNdjson(path.join(sessionDir, 'steps.ndjson'));
  if (steps.records.length === 0) {
    return null;
  }

  const sessionId = asString(manifest.sessionId)
    ?? asString(manifest.session_id)
    ?? path.basename(sessionDir);
  const status = asString(manifest.status) ?? 'unknown';
  const startedAtMs = asNumber(manifest.startedAtMs) ?? asNumber(manifest.started_at_ms);
  const endedAtMs = asNumber(manifest.endedAtMs) ?? asNumber(manifest.ended_at_ms);
  const eventsById = new Map<string, JsonRecord>();
  for (const event of events.records) {
    const eventId = eventIdOf(event);
    if (eventId) {
      eventsById.set(eventId, event);
    }
  }

  const metrics: SessionMetrics = {
    sessionId,
    status,
    durationMs: startedAtMs !== null && endedAtMs !== null
      ? Math.max(0, endedAtMs - startedAtMs)
      : null,
    eventCount: events.records.length,
    uiaProbeEventCount: 0,
    uiaTimeoutEventCount: 0,
    stepCount: steps.records.length,
    targetableStepCount: 0,
    coordinateOnlyCount: 0,
    semanticTargetCount: 0,
    unidentifiedTargetCount: 0,
    l2OrHigherCount: 0,
    precisionCounts: {},
    stepTypeCounts: {},
    sourceEventReferenceCount: 0,
    resolvedSourceEventReferenceCount: 0,
    sourceTimestampDeltaMs: [],
    artifactReferenceCount: 0,
    existingArtifactReferenceCount: 0,
    parseErrorCount: events.errorCount + steps.errorCount,
    observedStepFields: [],
  };
  const observedStepFields = new Set<string>();

  for (const event of events.records) {
    if (eventLooksLikeUiaProbe(event)) {
      metrics.uiaProbeEventCount += 1;
    }
    if (eventLooksLikeUiaTimeout(event)) {
      metrics.uiaTimeoutEventCount += 1;
    }
  }

  for (const step of steps.records) {
    Object.keys(step).forEach((key) => observedStepFields.add(key));
    const precision = asString(step.precisionLevel) ?? asString(step.precision_level) ?? 'unknown';
    const stepType = asString(step.stepType) ?? asString(step.step_type) ?? 'unknown';
    increment(metrics.precisionCounts, precision);
    increment(metrics.stepTypeCounts, stepType);

    if (isTargetableStep(step)) {
      metrics.targetableStepCount += 1;
      if (precision === 'l2' || precision === 'l3' || precision === 'l4') {
        metrics.l2OrHigherCount += 1;
      }
      if (hasControlIdentity(step)) {
        metrics.semanticTargetCount += 1;
      } else if (hasCoordinate(step)) {
        metrics.coordinateOnlyCount += 1;
      } else {
        metrics.unidentifiedTargetCount += 1;
      }
    }

    const stepTimestamp = stepTimestampOf(step);
    for (const sourceEventId of sourceEventIdsOf(step)) {
      metrics.sourceEventReferenceCount += 1;
      const sourceEvent = eventsById.get(sourceEventId);
      if (!sourceEvent) {
        continue;
      }
      metrics.resolvedSourceEventReferenceCount += 1;
      const eventTimestamp = eventTimestampOf(sourceEvent);
      if (stepTimestamp !== null && eventTimestamp !== null) {
        metrics.sourceTimestampDeltaMs.push(Math.abs(stepTimestamp - eventTimestamp));
      }
    }

    for (const artifactRef of artifactRefsOf(step)) {
      metrics.artifactReferenceCount += 1;
      const resolved = path.isAbsolute(artifactRef) ? artifactRef : path.resolve(sessionDir, artifactRef);
      if (existsSync(resolved)) {
        metrics.existingArtifactReferenceCount += 1;
      }
    }
  }

  metrics.observedStepFields = [...observedStepFields].sort();
  return metrics;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

function mergeCounts(sessions: SessionMetrics[], key: 'precisionCounts' | 'stepTypeCounts'): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const session of sessions) {
    for (const [name, count] of Object.entries(session[key])) {
      merged[name] = (merged[name] ?? 0) + count;
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

function sum(sessions: SessionMetrics[], select: (session: SessionMetrics) => number): number {
  return sessions.reduce((total, session) => total + select(session), 0);
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function buildRuntimeBaseline(sessions: SessionMetrics[]): BaselineReport['runtimeBaseline'] {
  const analyzedDurationMs = sum(sessions, (session) => session.durationMs ?? 0);
  const eventCount = sum(sessions, (session) => session.eventCount);
  const uiaProbeEventCount = sum(sessions, (session) => session.uiaProbeEventCount);
  const uiaTimeoutEventCount = sum(sessions, (session) => session.uiaTimeoutEventCount);
  return {
    eventRatePerMinute: {
      value: analyzedDurationMs > 0 ? roundMetric(eventCount / (analyzedDurationMs / 60_000)) : null,
      unit: 'events/minute',
      status: analyzedDurationMs > 0 ? 'archive-derived-proxy' : 'requires-native-long-run',
      source: 'session.json duration and events.ndjson count',
      method: 'sum eventCount across analyzed sessions / sum stopped-session duration minutes',
    },
    uiaTimeoutRate: {
      value: ratio(uiaTimeoutEventCount, uiaProbeEventCount),
      unit: 'ratio',
      status: uiaProbeEventCount > 0 ? 'archive-derived-proxy' : 'requires-native-long-run',
      source: 'events.ndjson textual proxy until observer_health semantic events exist',
      method: 'count events mentioning UIA and timeout / count UIA-enriched or UIA-mentioned events',
    },
    cpuP95Percent: {
      value: null,
      unit: 'percent',
      status: 'requires-native-long-run',
      source: 'examples/desktop/scripts/performance-baseline-test.ts or native long-run harness',
      method: 'sample process CPU during a 60-minute recording and report p95 after warmup',
    },
    maxRssMb: {
      value: null,
      unit: 'MiB',
      status: 'requires-native-long-run',
      source: 'examples/desktop/scripts/performance-baseline-test.ts or native long-run harness',
      method: 'sample resident memory during a 60-minute recording and report max RSS',
    },
    oneHourStabilityPass: {
      value: null,
      unit: 'boolean-as-0-or-1',
      status: 'requires-native-long-run',
      source: 'native recorder long-run smoke',
      method: 'record for 60 minutes, then verify no crash, no corrupted middle NDJSON line, clean stop, and readable manifests',
    },
  };
}

function buildAcceptanceMetricMethods(): Record<string, MetricSamplingContract> {
  return {
    targetRecognitionCorrect: {
      status: 'requires-annotations',
      source: 'Golden operation annotations and reviewer labels',
      method: 'manual reviewer marks target identity correct when locator identifies the actual interacted control without relying only on coordinates',
    },
    resultAssociationCorrect: {
      status: 'unavailable-before-operations-v1',
      source: 'operations.ndjson outcome plus Golden annotations',
      method: 'compare selected outcome transition against annotated expected UI state change within the outcome window',
    },
    incompleteHonesty: {
      status: 'unavailable-before-operations-v1',
      source: 'operations.ndjson incomplete/degraded outcomes plus annotations',
      method: 'verify incomplete is used only when no observable completion signal exists and observer degraded cases are separated',
    },
    coordinateOnlyRate: {
      status: 'measured',
      source: 'steps.ndjson',
      method: 'targetable steps without control identity but with x/y divided by all targetable steps',
    },
    l2OrHigherRate: {
      status: 'measured',
      source: 'steps.ndjson precisionLevel',
      method: 'targetable steps with precisionLevel l2/l3/l4 divided by all targetable steps',
    },
    videoSeekAlignment: {
      status: 'requires-annotations',
      source: 'manual video timestamp annotations',
      method: 'compare replay seek target against annotated operation time; pass target is p95 within +/-500ms and max within 1s',
    },
    eventRate: {
      status: 'archive-derived-proxy',
      source: 'session duration and events.ndjson count',
      method: 'sum eventCount / sum stopped-session duration minutes; use native long-run counter after M2 observer lands',
    },
    cpuAndMemory: {
      status: 'requires-native-long-run',
      source: 'performance-baseline / native long-run harness',
      method: 'sample CPU p95 and max RSS during 60-minute recording under fixed capture settings',
    },
  };
}

function buildReport(options: CliOptions): BaselineReport {
  assert(existsSync(options.sessionsRoot), `Session root does not exist: ${options.sessionsRoot}`);
  const discovered = readdirSync(options.sessionsRoot)
    .map((name) => path.join(options.sessionsRoot, name))
    .filter((candidate) => statSync(candidate).isDirectory())
    .map((sessionDir) => ({
      sessionDir,
      manifest: readJsonRecord(path.join(sessionDir, 'session.json')),
    }))
    .sort((left, right) => {
      const leftStarted = asNumber(left.manifest?.startedAtMs) ?? asNumber(left.manifest?.started_at_ms) ?? 0;
      const rightStarted = asNumber(right.manifest?.startedAtMs) ?? asNumber(right.manifest?.started_at_ms) ?? 0;
      return rightStarted - leftStarted;
    });

  const eligible = discovered.filter(({ sessionDir, manifest }) => {
    const stepsPath = path.join(sessionDir, 'steps.ndjson');
    if (!existsSync(stepsPath) || statSync(stepsPath).size === 0) {
      return false;
    }
    return options.includeActive || asString(manifest?.status) !== 'active';
  });
  const selected = options.limit === null ? eligible : eligible.slice(0, options.limit);
  const sessions = selected
    .map(({ sessionDir }) => analyzeSession(sessionDir))
    .filter((session): session is SessionMetrics => session !== null);

  assert(
    sessions.length >= options.minimumSessions,
    `Expected at least ${options.minimumSessions} sessions with semantic steps, found ${sessions.length}`,
  );

  const targetableStepCount = sum(sessions, (session) => session.targetableStepCount);
  const coordinateOnlyCount = sum(sessions, (session) => session.coordinateOnlyCount);
  const semanticTargetCount = sum(sessions, (session) => session.semanticTargetCount);
  const unidentifiedTargetCount = sum(sessions, (session) => session.unidentifiedTargetCount);
  const sourceEventReferenceCount = sum(sessions, (session) => session.sourceEventReferenceCount);
  const resolvedSourceEventReferenceCount = sum(
    sessions,
    (session) => session.resolvedSourceEventReferenceCount,
  );
  const artifactReferenceCount = sum(sessions, (session) => session.artifactReferenceCount);
  const existingArtifactReferenceCount = sum(
    sessions,
    (session) => session.existingArtifactReferenceCount,
  );
  const precisionCounts = mergeCounts(sessions, 'precisionCounts');
  const l2OrHigherCount = sum(sessions, (session) => session.l2OrHigherCount);
  const sourceTimestampDeltaMs = sessions.flatMap((session) => session.sourceTimestampDeltaMs);
  const observedStepFields = [...new Set(sessions.flatMap((session) => session.observedStepFields))].sort();
  const stepSchemaVersions = [...new Set(
    selected.flatMap(({ sessionDir }) => readNdjson(path.join(sessionDir, 'steps.ndjson')).records)
      .map((step) => asNumber(step.schemaVersion) ?? asNumber(step.schema_version))
      .filter((version): version is number => version !== null),
  )].sort((left, right) => left - right);

  return {
    schemaVersion: 1,
    kind: 'reqcase.operation-semantic-baseline',
    generatedAt: new Date().toISOString(),
    sessionsRoot: options.sessionsRoot,
    selection: {
      discoveredSessionCount: discovered.length,
      eligibleSessionCount: eligible.length,
      analyzedSessionCount: sessions.length,
      minimumRequired: options.minimumSessions,
      includeActive: options.includeActive,
      limit: options.limit,
    },
    definitions: {
      targetableStep: 'A step other than window/session/note/defect lifecycle context.',
      coordinateOnly: 'A targetable step without control identity that retains x/y coordinates.',
      semanticTarget: 'A targetable step with controlName, automationId, or controlType.',
      resultMetrics: 'Unavailable until operations.ndjson and annotated Golden outcomes exist.',
      seekMetrics: 'Requires manual video annotations; source-event timestamp deltas are diagnostic only.',
    },
    totals: {
      eventCount: sum(sessions, (session) => session.eventCount),
      analyzedDurationMs: sum(sessions, (session) => session.durationMs ?? 0),
      uiaProbeEventCount: sum(sessions, (session) => session.uiaProbeEventCount),
      uiaTimeoutEventCount: sum(sessions, (session) => session.uiaTimeoutEventCount),
      stepCount: sum(sessions, (session) => session.stepCount),
      targetableStepCount,
      coordinateOnlyCount,
      semanticTargetCount,
      unidentifiedTargetCount,
      precisionCounts,
      stepTypeCounts: mergeCounts(sessions, 'stepTypeCounts'),
      sourceEventReferenceCount,
      resolvedSourceEventReferenceCount,
      artifactReferenceCount,
      existingArtifactReferenceCount,
      parseErrorCount: sum(sessions, (session) => session.parseErrorCount),
    },
    rates: {
      coordinateOnlyRate: ratio(coordinateOnlyCount, targetableStepCount),
      semanticTargetRate: ratio(semanticTargetCount, targetableStepCount),
      unidentifiedTargetRate: ratio(unidentifiedTargetCount, targetableStepCount),
      l2OrHigherRate: ratio(l2OrHigherCount, targetableStepCount),
      sourceEventResolutionRate: ratio(resolvedSourceEventReferenceCount, sourceEventReferenceCount),
      artifactResolutionRate: ratio(existingArtifactReferenceCount, artifactReferenceCount),
    },
    timing: {
      sourceTimestampDeltaSampleCount: sourceTimestampDeltaMs.length,
      sourceTimestampDeltaP50Ms: percentile(sourceTimestampDeltaMs, 0.50),
      sourceTimestampDeltaP95Ms: percentile(sourceTimestampDeltaMs, 0.95),
      sourceTimestampDeltaMaxMs: sourceTimestampDeltaMs.length > 0 ? Math.max(...sourceTimestampDeltaMs) : null,
    },
    availability: {
      targetRecognition: 'available',
      operationOutcome: 'unavailable-before-operations-v1',
      confirmedOutcomeAccuracy: 'requires-golden-annotations',
      incompleteHonesty: 'requires-golden-annotations',
      videoSeekAlignment: 'requires-manual-video-annotations',
      runtimePerformance: 'measured-by-performance-baseline',
    },
    runtimeBaseline: buildRuntimeBaseline(sessions),
    acceptanceMetricMethods: buildAcceptanceMetricMethods(),
    contract: {
      stepSchemaVersions,
      observedStepFields,
      stepNdjsonSchema: {
        fileName: 'steps.ndjson',
        recordKind: 'reqcase.test-session-step',
        requiredFields: STEP_REQUIRED_FIELDS,
        optionalFields: STEP_OPTIONAL_FIELDS,
        privacyNotes: [
          'windowTitle and controlName may contain business labels and are aggregated only in this baseline report',
          'artifactRefs are checked for existence but screenshot and video contents are never opened by this script',
          'plain keyboard text is not part of TestSessionStepRecord',
        ],
      },
      napiApi: {
        functionName: 'get_test_session_steps',
        jsBinding: 'getTestSessionSteps',
        returnType: 'JsTestSessionStepRecord[]',
        fieldNaming: 'snake_case in native NAPI object; preload maps to camelCase for React',
      },
      reviewPageFieldMapping: REVIEW_PAGE_FIELD_MAPPING,
    },
    sessions,
  };
}

function formatPercent(value: number | null): string {
  return value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`;
}

function buildMarkdown(report: BaselineReport): string {
  return [
    '# Operation Semantic Baseline',
    '',
    `- Generated at: ${report.generatedAt}`,
    `- Sessions root: ${report.sessionsRoot}`,
    `- Sessions: ${report.selection.analyzedSessionCount}/${report.selection.eligibleSessionCount} eligible`,
    `- Events: ${report.totals.eventCount}`,
    `- Steps: ${report.totals.stepCount}`,
    `- Targetable steps: ${report.totals.targetableStepCount}`,
    '',
    '## Target Quality',
    '',
    `- Coordinate-only: ${report.totals.coordinateOnlyCount} (${formatPercent(report.rates.coordinateOnlyRate)})`,
    `- Semantic target: ${report.totals.semanticTargetCount} (${formatPercent(report.rates.semanticTargetRate)})`,
    `- Unidentified target: ${report.totals.unidentifiedTargetCount} (${formatPercent(report.rates.unidentifiedTargetRate)})`,
    `- L2 or higher: ${formatPercent(report.rates.l2OrHigherRate)}`,
    '',
    '## Integrity',
    '',
    `- NDJSON parse errors: ${report.totals.parseErrorCount}`,
    `- Source event references resolved: ${formatPercent(report.rates.sourceEventResolutionRate)}`,
    `- Artifact references resolved: ${formatPercent(report.rates.artifactResolutionRate)}`,
    `- Step/source timestamp delta p95: ${report.timing.sourceTimestampDeltaP95Ms ?? 'unavailable'} ms`,
    '',
    '## Runtime Baseline',
    '',
    `- Event rate: ${report.runtimeBaseline.eventRatePerMinute.value ?? 'unavailable'} ${report.runtimeBaseline.eventRatePerMinute.unit} (${report.runtimeBaseline.eventRatePerMinute.status})`,
    `- UIA timeout rate: ${formatPercent(report.runtimeBaseline.uiaTimeoutRate.value)} (${report.runtimeBaseline.uiaTimeoutRate.status})`,
    `- CPU p95: ${report.runtimeBaseline.cpuP95Percent.value ?? 'requires native long-run'} ${report.runtimeBaseline.cpuP95Percent.unit}`,
    `- Max RSS: ${report.runtimeBaseline.maxRssMb.value ?? 'requires native long-run'} ${report.runtimeBaseline.maxRssMb.unit}`,
    `- One-hour stability: ${report.runtimeBaseline.oneHourStabilityPass.value ?? 'requires native long-run'}`,
    '',
    '## Step Contract',
    '',
    `- Schema versions: ${report.contract.stepSchemaVersions.join(', ') || 'unavailable'}`,
    `- Observed fields: ${report.contract.observedStepFields.join(', ')}`,
    `- API: ${report.contract.napiApi.functionName} -> ${report.contract.napiApi.jsBinding} -> ${report.contract.napiApi.returnType}`,
    '',
    '## Unavailable Before Operations V1',
    '',
    '- Confirmed outcome accuracy',
    '- Incomplete honesty',
    '- Operation latency',
    '- Video seek alignment (requires manual annotations)',
    '',
  ].join('\n');
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  const reportName = `report-${report.generatedAt.replace(/[-:.]/g, '')}`;
  const reportDir = path.join(options.outputRoot, reportName);
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'operation-semantic-baseline.json');
  const markdownPath = path.join(reportDir, 'operation-semantic-baseline.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(markdownPath, buildMarkdown(report), 'utf8');

  console.log(`[operation-semantic-baseline] sessions=${report.selection.analyzedSessionCount}`);
  console.log(`[operation-semantic-baseline] coordinateOnlyRate=${formatPercent(report.rates.coordinateOnlyRate)}`);
  console.log(`[operation-semantic-baseline] semanticTargetRate=${formatPercent(report.rates.semanticTargetRate)}`);
  console.log(`[operation-semantic-baseline] wrote ${jsonPath}`);
  console.log(`[operation-semantic-baseline] wrote ${markdownPath}`);
}

run();
