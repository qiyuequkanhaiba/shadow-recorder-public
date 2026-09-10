import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

interface GoldenManifest {
  schemaVersion: number;
  kind: string;
  casesFile: string;
  minimumCaseCount: number;
  requiredTechnologies: string[];
  requiredOutcomeStatuses: string[];
  privacyForbiddenValues: string[];
  targetWindowMs: number;
  outcomeWindowMs: number;
}

interface GoldenEvent {
  eventId: string;
  eventType: string;
  occurredAtMs: number;
  sourceEventId?: string;
  payload?: JsonRecord;
}

interface GoldenOperation {
  operationId: string;
  sourceEventIds: string[];
  action: {
    kind: string;
    occurredAtMs: number;
  };
  outcome: {
    status: string;
    observedAtMs: number;
    latencyMs: number;
    reasonCodes: string[];
  };
  expectedEvidenceRoles: string[];
}

interface GoldenCase {
  caseId: string;
  technology: string;
  sessionId: string;
  inputEvents: GoldenEvent[];
  semanticEvents: GoldenEvent[];
  expectedOperations: GoldenOperation[];
  boundaryAssertions?: Array<{
    window: 'target' | 'outcome';
    offsetMs: number;
    accepted: boolean;
  }>;
}

const FORBIDDEN_PASSWORD_PAYLOAD_KEYS = new Set([
  'value',
  'text',
  'plaintext',
  'plainText',
  'inputValue',
  'valueText',
  'secret',
]);

function asRecord(value: unknown, label: string): JsonRecord {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  assert(typeof value === 'string', `${label} must be a string`);
  assert(value.trim().length > 0, `${label} must not be empty`);
  return value;
}

function asFiniteNumber(value: unknown, label: string): number {
  assert(typeof value === 'number', `${label} must be a number`);
  assert(Number.isFinite(value), `${label} must be finite`);
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => asString(item, `${label}[${index}]`));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function resolveFixtureRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'tests', 'fixtures', 'operations'),
    path.resolve(process.cwd(), '..', '..', 'tests', 'fixtures', 'operations'),
  ];
  const fixtureRoot = candidates.find((candidate) => existsSync(path.join(candidate, 'manifest.json')));
  assert(fixtureRoot, 'Unable to locate tests/fixtures/operations/manifest.json');
  return fixtureRoot;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assert(!seen.has(value), `${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function assertNoForbiddenValues(value: unknown, forbiddenValues: string[], pathLabel: string): void {
  if (typeof value === 'string') {
    assert(
      !forbiddenValues.includes(value),
      `${pathLabel} contains forbidden privacy fixture value: ${value}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenValues(item, forbiddenValues, `${pathLabel}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nestedValue] of Object.entries(value)) {
      assertNoForbiddenValues(nestedValue, forbiddenValues, `${pathLabel}.${key}`);
    }
  }
}

function assertPasswordPayloadIsRedacted(event: GoldenEvent, caseId: string): void {
  if (!event.payload || event.payload.isPassword !== true) {
    return;
  }
  for (const key of Object.keys(event.payload)) {
    assert(
      !FORBIDDEN_PASSWORD_PAYLOAD_KEYS.has(key),
      `${caseId}/${event.eventId} password payload must not include ${key}`,
    );
  }
}

function readRepoSource(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, '../../..', relativePath), 'utf8');
}

function extractRustTestSource(source: string, testName: string): string {
  const start = source.indexOf(`fn ${testName}()`);
  assert(start >= 0, `native sanitizer regression test not found: ${testName}`);
  const nextTest = source.indexOf('\n    #[test]', start + testName.length);
  return source.slice(start, nextTest >= 0 ? nextTest : undefined);
}

function assertPrivacyFirstCaptureBoundaries(): void {
  const configSource = readRepoSource('src/config.rs');
  const recorderSource = readRepoSource('src/recorder.rs');
  const ipcSource = readRepoSource('examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts');
  const privacyPanelSource = readRepoSource('examples/desktop/src-react/features/privacy/PrivacySettingsPanel.tsx');
  const semanticPrivacySource = readRepoSource('src/session/semantic_privacy.rs');
  const nativeRegressionSource = extractRustTestSource(
    semanticPrivacySource,
    'semantic_privacy_disabled_plaintext_removes_non_password_export_fields',
  );

  assert.match(
    configSource,
    /pub const DEFAULT_SEMANTIC_PLAINTEXT_INPUT_ENABLED: bool = false;/,
    'plaintext capture must default to opt-in',
  );
  assert.match(
    recorderSource,
    /let semantic_plaintext_input_enabled\s*=\s*semantic_recording_enabled && config\.semantic_plaintext_input_enabled;/,
    'plaintext capture must require semantic recording and explicit opt-in',
  );
  assert.match(
    ipcSource,
    /privacyEnabled: true,[\s\S]*semanticPlaintextInputEnabled: false,/,
    'Electron baseline must enable privacy and disable plaintext capture',
  );
  assert.match(
    semanticPrivacySource,
    /"path",\s*"clipboardText",/,
    'native sanitizer must classify path and clipboardText as plaintext values',
  );
  for (const plaintextField of ['value', 'valueText', 'selectedNames', 'path', 'clipboardText']) {
    assert.match(
      nativeRegressionSource,
      new RegExp(`"${plaintextField}":`),
      `native sanitizer regression must start with ${plaintextField}`,
    );
    assert.match(
      nativeRegressionSource,
      new RegExp(`get\\("${plaintextField}"\\)\\.is_none\\(\\)`),
      `native sanitizer regression must remove ${plaintextField}`,
    );
  }
  assert.match(
    nativeRegressionSource,
    /event\.event_id = [\s\S]*event\.occurred_at_ms = [\s\S]*"controlType": "Edit"|"controlType": "Edit"[\s\S]*event\.event_id = [\s\S]*event\.occurred_at_ms = /,
    'native sanitizer regression must use stable identity, timestamp, and control metadata',
  );
  assert.match(
    nativeRegressionSource,
    /sanitize_semantic_event_with_options\(&event, &SemanticPrivacyOptions::default\(\)\)[\s\S]*sanitized\.event_id[\s\S]*sanitized\.occurred_at_ms[\s\S]*payload\["controlType"\][\s\S]*PrivacyClass::TextLengthOnly/,
    'native sanitizer regression must retain metadata and classify disabled plaintext as text-length-only',
  );
  assert.match(privacyPanelSource, /允许采集非密码文本/, 'privacy panel must provide plaintext consent');
  assert.match(
    privacyPanelSource,
    /关闭时只记录非文本语义元数据。开启后，输入内容、选项名称或路径可能出现在本地会话和导出文件中；密码字段仍不记录文本。/,
    'privacy panel must explain plaintext capture consequences',
  );
  assert.match(
    privacyPanelSource,
    /遮罩和排除规则仅影响后续采集，不会修改已写入的视频或导出文件。/,
    'privacy panel must explain the non-retroactive scope of masking and exclusion',
  );
  assert.match(
    privacyPanelSource,
    /import \{ isSemanticRecordingEnabled \} from '\.\.\/\.\.\/lib\/recorder-page-bindings';/,
    'privacy panel must use the shared semantic-recording compatibility resolver',
  );
  assert.match(
    privacyPanelSource,
    /const semanticRecordingEnabled = isSemanticRecordingEnabled\(props\.config\);/,
    'plaintext consent must be available whenever either semantic recording flag is enabled',
  );
}

function assertManifest(value: unknown): GoldenManifest {
  const manifest = asRecord(value, 'manifest') as unknown as GoldenManifest;
  assert.equal(manifest.schemaVersion, 1, 'manifest schemaVersion');
  assert.equal(manifest.kind, 'reqcase.operation-golden-manifest', 'manifest kind');
  asString(manifest.casesFile, 'manifest.casesFile');
  assert(asFiniteNumber(manifest.minimumCaseCount, 'manifest.minimumCaseCount') >= 10);
  assert(asStringArray(manifest.requiredTechnologies, 'manifest.requiredTechnologies').length >= 5);
  assert(asStringArray(manifest.requiredOutcomeStatuses, 'manifest.requiredOutcomeStatuses').length >= 5);
  assert(asStringArray(manifest.privacyForbiddenValues, 'manifest.privacyForbiddenValues').length > 0);
  assert(asFiniteNumber(manifest.targetWindowMs, 'manifest.targetWindowMs') > 0);
  assert(
    asFiniteNumber(manifest.outcomeWindowMs, 'manifest.outcomeWindowMs') > manifest.targetWindowMs,
    'outcomeWindowMs must be larger than targetWindowMs',
  );
  return manifest;
}

function assertEvent(value: unknown, label: string): GoldenEvent {
  const event = asRecord(value, label) as unknown as GoldenEvent;
  asString(event.eventId, `${label}.eventId`);
  asString(event.eventType, `${label}.eventType`);
  assert(asFiniteNumber(event.occurredAtMs, `${label}.occurredAtMs`) >= 0);
  if (event.sourceEventId !== undefined) {
    asString(event.sourceEventId, `${label}.sourceEventId`);
  }
  if (event.payload !== undefined) {
    asRecord(event.payload, `${label}.payload`);
  }
  return event;
}

function assertOperation(value: unknown, label: string): GoldenOperation {
  const operation = asRecord(value, label) as unknown as GoldenOperation;
  asString(operation.operationId, `${label}.operationId`);
  assert(asStringArray(operation.sourceEventIds, `${label}.sourceEventIds`).length > 0);
  asRecord(operation.action, `${label}.action`);
  asString(operation.action.kind, `${label}.action.kind`);
  assert(asFiniteNumber(operation.action.occurredAtMs, `${label}.action.occurredAtMs`) >= 0);
  asRecord(operation.outcome, `${label}.outcome`);
  asString(operation.outcome.status, `${label}.outcome.status`);
  assert(asFiniteNumber(operation.outcome.observedAtMs, `${label}.outcome.observedAtMs`) >= 0);
  assert(asFiniteNumber(operation.outcome.latencyMs, `${label}.outcome.latencyMs`) >= 0);
  assert(asStringArray(operation.outcome.reasonCodes, `${label}.outcome.reasonCodes`).length > 0);
  assert(asStringArray(operation.expectedEvidenceRoles, `${label}.expectedEvidenceRoles`).length > 0);
  assert.equal(
    operation.outcome.latencyMs,
    operation.outcome.observedAtMs - operation.action.occurredAtMs,
    `${label}.outcome.latencyMs must equal observedAtMs - action.occurredAtMs`,
  );
  return operation;
}

function assertBoundaryAssertions(testCase: GoldenCase, manifest: GoldenManifest): void {
  for (const assertion of testCase.boundaryAssertions ?? []) {
    const limit = assertion.window === 'target' ? manifest.targetWindowMs : manifest.outcomeWindowMs;
    assert.equal(
      assertion.accepted,
      assertion.offsetMs <= limit,
      `${testCase.caseId} ${assertion.window} boundary offset ${assertion.offsetMs} expected accepted=${assertion.offsetMs <= limit}`,
    );
  }
}

function assertCase(value: unknown, manifest: GoldenManifest): GoldenCase {
  const testCase = asRecord(value, 'case') as unknown as GoldenCase;
  asString(testCase.caseId, 'case.caseId');
  asString(testCase.technology, `${testCase.caseId}.technology`);
  asString(testCase.sessionId, `${testCase.caseId}.sessionId`);
  assert(Array.isArray(testCase.inputEvents), `${testCase.caseId}.inputEvents must be an array`);
  assert(Array.isArray(testCase.semanticEvents), `${testCase.caseId}.semanticEvents must be an array`);
  assert(Array.isArray(testCase.expectedOperations), `${testCase.caseId}.expectedOperations must be an array`);
  assert(testCase.inputEvents.length > 0, `${testCase.caseId} must include input events`);
  assert(testCase.expectedOperations.length > 0, `${testCase.caseId} must include expected operations`);

  const inputEvents = testCase.inputEvents.map((event, index) =>
    assertEvent(event, `${testCase.caseId}.inputEvents[${index}]`),
  );
  const semanticEvents = testCase.semanticEvents.map((event, index) =>
    assertEvent(event, `${testCase.caseId}.semanticEvents[${index}]`),
  );
  const operations = testCase.expectedOperations.map((operation, index) =>
    assertOperation(operation, `${testCase.caseId}.expectedOperations[${index}]`),
  );
  const inputEventIds = new Set(inputEvents.map((event) => event.eventId));
  const semanticEventIds = new Set(semanticEvents.map((event) => event.eventId));
  assertUnique(inputEvents.map((event) => event.eventId), `${testCase.caseId}.inputEvents.eventId`);
  assertUnique(semanticEvents.map((event) => event.eventId), `${testCase.caseId}.semanticEvents.eventId`);
  assertUnique(operations.map((operation) => operation.operationId), `${testCase.caseId}.expectedOperations.operationId`);

  for (const event of semanticEvents) {
    if (event.sourceEventId) {
      assert(inputEventIds.has(event.sourceEventId), `${testCase.caseId}/${event.eventId} sourceEventId not found`);
    }
    assertPasswordPayloadIsRedacted(event, testCase.caseId);
  }

  for (const operation of operations) {
    assert(
      manifest.requiredOutcomeStatuses.includes(operation.outcome.status),
      `${testCase.caseId}/${operation.operationId} uses unexpected outcome status ${operation.outcome.status}`,
    );
    for (const sourceEventId of operation.sourceEventIds) {
      assert(inputEventIds.has(sourceEventId), `${testCase.caseId}/${operation.operationId} source event not found`);
    }
    const hasOutcomeRole = operation.expectedEvidenceRoles.includes('supportsOutcome');
    if (operation.outcome.status === 'confirmed') {
      assert(hasOutcomeRole, `${testCase.caseId}/${operation.operationId} confirmed outcome must support outcome`);
    }
    if (hasOutcomeRole) {
      const hasMatchingSemanticEvidence = semanticEvents.some((event) =>
        event.occurredAtMs === operation.outcome.observedAtMs
        && (event.sourceEventId === undefined || operation.sourceEventIds.includes(event.sourceEventId))
        && semanticEventIds.has(event.eventId),
      );
      assert(
        hasMatchingSemanticEvidence,
        `${testCase.caseId}/${operation.operationId} outcome role must point to semantic evidence at observedAtMs`,
      );
    }
  }

  assertBoundaryAssertions(testCase, manifest);
  return testCase;
}

function run(): void {
  assertPrivacyFirstCaptureBoundaries();
  const fixtureRoot = resolveFixtureRoot();
  const manifestPath = path.join(fixtureRoot, 'manifest.json');
  const manifest = assertManifest(readJson<unknown>(manifestPath));
  const casesPath = path.join(fixtureRoot, manifest.casesFile);
  assert(existsSync(casesPath), `cases file not found: ${casesPath}`);

  const casesValue = readJson<unknown>(casesPath);
  assert(Array.isArray(casesValue), 'cases file must contain an array');
  assert(casesValue.length >= manifest.minimumCaseCount, 'cases length must satisfy minimumCaseCount');
  assertNoForbiddenValues(casesValue, manifest.privacyForbiddenValues, 'cases');

  const cases = casesValue.map((testCase) => assertCase(testCase, manifest));
  assertUnique(cases.map((testCase) => testCase.caseId), 'caseId');
  assertUnique(cases.map((testCase) => testCase.sessionId), 'sessionId');

  const technologies = new Set(cases.map((testCase) => testCase.technology));
  for (const technology of manifest.requiredTechnologies) {
    assert(technologies.has(technology), `missing required technology case: ${technology}`);
  }

  const outcomeStatuses = new Set(
    cases.flatMap((testCase) =>
      testCase.expectedOperations.map((operation) => operation.outcome.status),
    ),
  );
  for (const status of manifest.requiredOutcomeStatuses) {
    assert(outcomeStatuses.has(status), `missing required outcome status: ${status}`);
  }

  const operationCount = cases.reduce((total, testCase) => total + testCase.expectedOperations.length, 0);
  console.log(
    `[operation-golden-contract] cases=${cases.length} operations=${operationCount} technologies=${technologies.size} statuses=${outcomeStatuses.size}`,
  );
}

run();
