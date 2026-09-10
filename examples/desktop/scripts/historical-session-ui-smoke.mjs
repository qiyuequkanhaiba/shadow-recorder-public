import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(SCRIPT_DIR, '..');
const SESSIONS_ROOT = path.join(DESKTOP_ROOT, 'dist-electron', 'reports', 'test-sessions');
const ELECTRON_PATH = path.join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN_PATH = path.join(DESKTOP_ROOT, 'dist-electron', 'src-electron', 'main.js');

function parseOptions(argv) {
  const options = {
    outputDir: undefined,
    timeoutMs: 45_000,
    maxSessions: 0,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--output-dir=')) {
      options.outputDir = path.resolve(argument.slice('--output-dir='.length));
      continue;
    }
    if (argument.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number(argument.slice('--timeout-ms='.length));
      continue;
    }
    if (argument.startsWith('--max-sessions=')) {
      options.maxSessions = Number(argument.slice('--max-sessions='.length));
      continue;
    }
    switch (argument) {
      case '--output-dir':
        options.outputDir = path.resolve(argv[++index]);
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(argv[++index]);
        break;
      case '--max-sessions':
        options.maxSessions = Number(argv[++index]);
        break;
      case '--help':
      case '-h':
        console.log([
          'Usage:',
          '  npm run test:historical-session-ui-smoke --',
          '    [--output-dir <path>] [--timeout-ms 45000] [--max-sessions 0]',
          '',
          'Runs the built Electron app, switches the history UI through every session,',
          'and injects temporary corrupt/future/missing-video sessions for white-screen checks.',
        ].join('\n'));
        process.exit(0);
        break;
      default:
        if (argument.startsWith('-')) {
          throw new Error(`unknown argument: ${argument}`);
        }
        positional.push(argument);
    }
  }
  if (positional[0]) {
    options.outputDir = path.resolve(positional[0]);
  }
  if (positional[1]) {
    options.timeoutMs = Number(positional[1]);
  }
  if (positional[2]) {
    options.maxSessions = Number(positional[2]);
  }
  assert(positional.length <= 3, `too many positional arguments: ${positional.slice(3).join(' ')}`);
  assert(Number.isFinite(options.timeoutMs) && options.timeoutMs >= 5_000, 'invalid --timeout-ms');
  assert(Number.isInteger(options.maxSessions) && options.maxSessions >= 0, 'invalid --max-sessions');
  return options;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeNdjson(filePath, rows, corruptTail = false) {
  const valid = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(filePath, `${valid}\n${corruptTail ? '{"broken":\n' : ''}`, 'utf8');
}

function makeOperation(sessionId, occurredAtMs, schemaVersion) {
  return {
    schemaVersion,
    kind: 'reqcase.test-session-operation',
    operationId: `operation-${sessionId}-1`,
    sessionId,
    sequence: 1,
    startedAtMs: occurredAtMs,
    endedAtMs: occurredAtMs + 80,
    relativeMsFromSessionStart: 1_000,
    action: {
      actionId: `action-${sessionId}-1`,
      kind: 'click',
      occurredAtMs,
      endedAtMs: occurredAtMs + 40,
      target: null,
      stateBefore: null,
      coordinate: { x: 120, y: 180, displayId: null },
      sourceEventIds: [`event-${sessionId}-step`],
      targetReasonCodes: ['ui-smoke'],
      confidence: {},
    },
    outcome: {
      outcomeId: `outcome-${sessionId}-1`,
      status: 'legacyUnknown',
      summary: '旧记录未采集操作结果',
      observedAtMs: occurredAtMs + 80,
      latencyMs: 80,
      primaryTransitionId: null,
      candidateTransitionIds: [],
      reasonCodes: ['ui-smoke'],
      confidence: {},
    },
    completionCandidates: [],
    transitions: [],
    evidence: [],
    title: '历史兼容 UI 验收操作',
    resultSummary: '旧记录未采集操作结果',
    displaySummary: '历史兼容 UI 验收操作 -> 旧记录未采集操作结果',
    precisionLevel: 'ui-smoke',
    outcomeSelectionSource: 'auto',
    edited: false,
    ignored: false,
    businessAlias: null,
    manualNote: null,
  };
}

function createSmokeFixture(kind) {
  const suffix = `${process.pid}-${Date.now()}-${kind}`;
  const sessionId = `ui-smoke-${suffix}`;
  const sessionDir = path.join(SESSIONS_ROOT, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const startedAtMs = Date.now() - 10_000;
  const occurredAtMs = startedAtMs + 1_000;
  writeJson(path.join(sessionDir, 'session.json'), {
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId,
    name: `UI smoke ${kind}`,
    status: 'stopped',
    startedAtMs,
    updatedAtMs: startedAtMs + 5_000,
    endedAtMs: startedAtMs + 5_000,
    storageRootDir: SESSIONS_ROOT,
    sessionDir,
    manifestPath: path.join(sessionDir, 'session.json'),
    bufferWindowSeconds: 90,
    segmentDurationSeconds: 5,
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    showMouseInVideo: false,
    targetCaptureMode: 'target_display',
  });
  writeNdjson(path.join(sessionDir, 'events.ndjson'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: `event-${sessionId}-start`,
      sessionId,
      eventType: 'session_started',
      logCategory: 'recording',
      occurredAtMs: startedAtMs,
      status: 'stopped',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: `event-${sessionId}-step`,
      sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs,
      status: 'stopped',
      stepId: `step-${sessionId}-1`,
      action: 'click',
      title: `UI smoke ${kind} step`,
      x: 120,
      y: 180,
    },
  ], kind === 'corrupt');
  writeNdjson(path.join(sessionDir, 'steps.ndjson'), [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-step',
      stepId: `step-${sessionId}-1`,
      id: `step-${sessionId}-1`,
      sessionId,
      startedAtMs: occurredAtMs,
      endedAtMs: occurredAtMs + 80,
      timestampMs: occurredAtMs,
      action: 'click',
      title: `UI smoke ${kind} step`,
      summary: '历史兼容 UI 验收',
      x: 120,
      y: 180,
      edited: false,
    },
  ]);
  writeNdjson(
    path.join(sessionDir, 'operations.ndjson'),
    [makeOperation(sessionId, occurredAtMs, kind === 'future' ? 999 : 0)],
    kind === 'corrupt',
  );
  return { kind, sessionId, sessionDir };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDebuggerPage(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastTargets = [];
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `Electron exited before debugger attached (code ${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        lastTargets = targets.map((candidate) => ({
          type: candidate.type,
          title: candidate.title,
          url: candidate.url,
        }));
        const target = targets.find((candidate) =>
          candidate.type === 'page'
          && typeof candidate.webSocketDebuggerUrl === 'string'
          && /dist-react[\\/]index\.html(?:[?#]|$)/i.test(String(candidate.url)));
        if (target) {
          return target;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `timed out waiting for main Electron debugger target: ${lastError ?? JSON.stringify(lastTargets)}`,
  );
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect(timeoutMs) {
    this.socket = new WebSocket(this.url);
    await Promise.race([
      new Promise((resolve, reject) => {
        this.socket.addEventListener('open', resolve, { once: true });
        this.socket.addEventListener('error', reject, { once: true });
      }),
      delay(timeoutMs).then(() => {
        throw new Error('timed out connecting to DevTools websocket');
      }),
    ]);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    assert(this.socket && this.socket.readyState === WebSocket.OPEN, 'DevTools websocket is not open');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitForExpression(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(client, expression);
    if (lastValue) {
      return lastValue;
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for renderer expression; last value: ${JSON.stringify(lastValue)}`);
}

async function captureScreenshot(client, outputPath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
}

async function selectSession(client, sessionId) {
  return evaluate(client, `(() => {
    const select = document.querySelector('select.recorder-log-select');
    if (!(select instanceof HTMLSelectElement)) {
      return { changed: false, reason: 'session select missing' };
    }
    const option = Array.from(select.options).find((candidate) => candidate.value === ${JSON.stringify(sessionId)});
    if (!option) {
      return { changed: false, reason: 'session option missing' };
    }
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true };
  })()`);
}

async function readUiSnapshot(client) {
  return evaluate(client, `(() => {
    const root = document.getElementById('root');
    const sessionSelect = document.querySelector('select.recorder-log-select');
    const timelineItems = document.querySelectorAll('.event-timeline-item');
    const rootText = root?.innerText ?? '';
    return {
      readyState: document.readyState,
      rootTextLength: rootText.trim().length,
      bodyTextLength: (document.body?.innerText ?? '').trim().length,
      rootErrorVisible: !!document.querySelector('.root-error-panel'),
      mainPanelVisible: !!document.querySelector('#panel-main'),
      evidencePanelVisible: !!document.querySelector('#panel-evidence'),
      selectedSessionId: sessionSelect instanceof HTMLSelectElement ? sessionSelect.value : null,
      sessionOptionCount: sessionSelect instanceof HTMLSelectElement ? sessionSelect.options.length : 0,
      timelineItemCount: timelineItems.length,
      videoCount: document.querySelectorAll('video').length,
    };
  })()`);
}

function rendererProblems(events) {
  const exceptions = events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params?.exceptionDetails?.exception?.description
      ?? event.params?.exceptionDetails?.text
      ?? 'unknown renderer exception');
  const fatalConsole = events
    .filter((event) => event.method === 'Runtime.consoleAPICalled')
    .map((event) => ({
      type: event.params?.type,
      text: (event.params?.args ?? [])
        .map((argument) => argument.value ?? argument.description ?? '')
        .join(' '),
    }))
    .filter((entry) =>
      entry.type === 'error'
      && /\[shadow-recorder\]\[(renderer|renderer-root)\]|unhandled rejection|render failed|window error/i.test(entry.text))
    .map((entry) => entry.text);
  return [...exceptions, ...fatalConsole];
}

async function run() {
  const options = parseOptions(process.argv.slice(2));
  assert(existsSync(ELECTRON_PATH), `Electron executable not found: ${ELECTRON_PATH}`);
  assert(existsSync(MAIN_PATH), `built Electron entry not found: ${MAIN_PATH}; run npm run build first`);
  mkdirSync(SESSIONS_ROOT, { recursive: true });

  const outputDir = options.outputDir ?? mkdtempSync(path.join(tmpdir(), 'shadow-recorder-ui-smoke-'));
  mkdirSync(outputDir, { recursive: true });
  const fixtures = [createSmokeFixture('corrupt'), createSmokeFixture('future')];
  const port = await reservePort();
  const stdout = [];
  const stderr = [];
  let child;
  let client;

  try {
    child = spawn(
      ELECTRON_PATH,
      [`--remote-debugging-port=${port}`, '--disable-gpu', MAIN_PATH],
      {
        cwd: DESKTOP_ROOT,
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
          REQCASE_OPEN_MAIN_WINDOW: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      },
    );
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const target = await waitForDebuggerPage(port, options.timeoutMs, child);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect(options.timeoutMs);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await waitForExpression(
      client,
      `document.readyState === 'complete' && (document.getElementById('root')?.innerText ?? '').trim().length > 20`,
      options.timeoutMs,
    );

    await waitForExpression(
      client,
      `document.querySelector('#tab-main')?.getAttribute('aria-selected') === 'true'
        && document.querySelector('#panel-main')
        && document.querySelector('select.recorder-log-select') instanceof HTMLSelectElement`,
      options.timeoutMs,
    );

    await captureScreenshot(client, path.join(outputDir, 'history-initial.png'));
    const sessions = await evaluate(client, `(async () => {
      const rows = await window.reqcaseShadowRecorder.listTestSessions();
      return Array.isArray(rows) ? rows.map((row) => ({
        sessionId: String(row.sessionId ?? ''),
        name: String(row.name ?? ''),
        status: String(row.status ?? ''),
      })) : [];
    })()`);
    assert(Array.isArray(sessions) && sessions.length > 0, 'renderer bridge returned no historical sessions');
    const fixtureSessionIds = new Set(fixtures.map((fixture) => fixture.sessionId));
    const realSessions = sessions.filter((session) => !fixtureSessionIds.has(session.sessionId));
    const selectedSessions = options.maxSessions > 0 ? realSessions.slice(0, options.maxSessions) : realSessions;
    for (const session of selectedSessions) {
      const change = await selectSession(client, session.sessionId);
      assert(change.changed, `${session.sessionId}: ${change.reason}`);
      await delay(450);
      const snapshot = await readUiSnapshot(client);
      assert(snapshot.rootTextLength > 20, `${session.sessionId}: renderer root is blank`);
      assert.equal(snapshot.rootErrorVisible, false, `${session.sessionId}: root error boundary is visible`);
      assert.equal(snapshot.mainPanelVisible, true, `${session.sessionId}: main history panel disappeared`);
      assert.equal(snapshot.selectedSessionId, session.sessionId, `${session.sessionId}: selection did not settle`);
    }

    const firstTimelineClick = await evaluate(client, `(() => {
      const button = document.querySelector('.event-timeline-item');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (firstTimelineClick) {
      await delay(300);
    }

    for (const fixture of fixtures) {
      const change = await selectSession(client, fixture.sessionId);
      assert(change.changed, `${fixture.sessionId}: ${change.reason}`);
      await delay(500);
      const snapshot = await readUiSnapshot(client);
      assert(snapshot.rootTextLength > 20, `${fixture.kind}: renderer root is blank`);
      assert.equal(snapshot.rootErrorVisible, false, `${fixture.kind}: root error boundary is visible`);
      assert.equal(snapshot.mainPanelVisible, true, `${fixture.kind}: main history panel disappeared`);
      assert.equal(snapshot.selectedSessionId, fixture.sessionId, `${fixture.kind}: selection did not settle`);

      await evaluate(client, `document.getElementById('tab-evidence')?.click()`);
      await waitForExpression(
        client,
        `document.querySelector('#tab-evidence')?.getAttribute('aria-selected') === 'true'
          && !!document.querySelector('#panel-evidence')`,
        options.timeoutMs,
      );
      const evidenceSnapshot = await readUiSnapshot(client);
      assert(evidenceSnapshot.rootTextLength > 20, `${fixture.kind}: evidence renderer root is blank`);
      assert.equal(evidenceSnapshot.rootErrorVisible, false, `${fixture.kind}: evidence root error boundary is visible`);
      assert.equal(evidenceSnapshot.evidencePanelVisible, true, `${fixture.kind}: evidence panel disappeared`);
      await captureScreenshot(client, path.join(outputDir, `history-${fixture.kind}.png`));

      await evaluate(client, `document.getElementById('tab-main')?.click()`);
      await waitForExpression(
        client,
        `document.querySelector('#tab-main')?.getAttribute('aria-selected') === 'true'
          && document.querySelector('select.recorder-log-select') instanceof HTMLSelectElement`,
        options.timeoutMs,
      );
    }

    const problems = rendererProblems(client.events);
    assert.deepEqual(problems, [], `renderer reported fatal problems:\n${problems.join('\n')}`);
    const finalSnapshot = await readUiSnapshot(client);
    const report = {
      generatedAt: new Date().toISOString(),
      outputDir,
      checkedSessionCount: selectedSessions.length,
      fixtureSessionIds: fixtures.map((fixture) => fixture.sessionId),
      finalSnapshot,
      rendererProblemCount: problems.length,
      electronStdoutTail: stdout.join('').slice(-4_000),
      electronStderrTail: stderr.join('').slice(-4_000),
    };
    writeJson(path.join(outputDir, 'report.json'), report);
    rmSync(path.join(outputDir, 'failure-report.json'), { force: true });
    console.log(`[historical-session-ui-smoke] screenshots/report: ${outputDir}`);
    console.log(`[historical-session-ui-smoke] PASS (${selectedSessions.length} real session(s) + 2 degraded fixtures)`);
  } catch (error) {
    writeJson(path.join(outputDir, 'failure-report.json'), {
      generatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.stack ?? error.message : String(error),
      electronStdoutTail: stdout.join('').slice(-8_000),
      electronStderrTail: stderr.join('').slice(-8_000),
    });
    throw error;
  } finally {
    client?.close();
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(5_000),
      ]);
    }
    for (const fixture of fixtures) {
      const resolved = path.resolve(fixture.sessionDir);
      const expectedParent = `${path.resolve(SESSIONS_ROOT)}${path.sep}`;
      assert(
        resolved.startsWith(expectedParent) && path.basename(resolved).startsWith('ui-smoke-'),
        `refusing to clean unexpected fixture path: ${resolved}`,
      );
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error('[historical-session-ui-smoke] FAIL', error);
  process.exitCode = 1;
});
