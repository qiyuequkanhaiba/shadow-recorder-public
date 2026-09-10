import { strict as assert } from 'node:assert';

import {
  createDisabledReplayStepProvider,
  createMockReplayStepProvider,
  createOpenAiCompatibleReplayStepProvider,
} from '../src-electron/modules/reqcase-shadow-recorder/ai-provider';
import type { StructuredStepContext } from '../types/contracts';

const contexts: StructuredStepContext[] = [
  {
    stepId: 'step-1',
    timestampMs: 1700000000000,
    action: 'click',
    position: { x: 10, y: 20 },
    windowTitle: 'Login',
    processName: 'app.exe',
    captureBackend: 'wgc',
    hasImage: true,
    privacyFiltered: false,
  },
  {
    stepId: 'step-2',
    timestampMs: 1700000001000,
    action: 'scroll',
    position: { x: 30, y: 40 },
    hasImage: false,
    privacyFiltered: true,
  },
];

async function testDisabledProviderReturnsExplicitError(): Promise<void> {
  const provider = createDisabledReplayStepProvider();
  await assert.rejects(
    () => provider.generate({ contexts }),
    /AI replay generation is disabled./,
  );
}

async function testMockProviderIsDeterministicAndImageFree(): Promise<void> {
  const provider = createMockReplayStepProvider();
  const first = await provider.generate({ contexts });
  const second = await provider.generate({ contexts });

  assert.deepEqual(first.steps, second.steps);
  assert.equal(first.provider, 'mock');
  assert.equal(first.steps.length, 2);
  assert.match(first.steps[0], /app.exe/);
  assert.match(first.steps[0], /click/);
  assert.equal(JSON.stringify(first).includes('imageWebpBase64'), false);
}

async function testOpenAiCompatibleRequiresExplicitEnablementAndPrivacyAcknowledgement(): Promise<void> {
  const provider = createOpenAiCompatibleReplayStepProvider({
    baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'local-model',
    timeoutMs: 1000,
  });

  await assert.rejects(
    () => provider.generate({ contexts, aiEnabled: false, privacyAcknowledgedAt: '2026-05-17T12:00:00.000Z' }),
    /requires explicit enablement/i,
  );
  await assert.rejects(
    () => provider.generate({ contexts, aiEnabled: true }),
    /requires privacy acknowledgement/i,
  );
}

async function testOpenAiCompatibleCallsChatCompletionsEndpoint(): Promise<void> {
  let requestUrl = '';
  let requestBody: any = null;
  let authorization = '';
  const provider = createOpenAiCompatibleReplayStepProvider(
    {
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'local-key',
      model: 'local-model',
      timeoutMs: 1000,
    },
    async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      authorization = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ steps: ['Open app', 'Click login'] }) } }] }),
        text: async () => '',
      };
    },
  );

  const result = await provider.generate({
    contexts,
    aiEnabled: true,
    privacyAcknowledgedAt: '2026-05-17T12:00:00.000Z',
  });

  assert.equal(requestUrl, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(requestBody.model, 'local-model');
  assert.equal(requestBody.messages.length, 2);
  assert.equal(authorization, 'Bearer local-key');
  assert.deepEqual(result.steps, ['Open app', 'Click login']);
  assert.equal(result.provider, 'openai_compatible');
}

async function run(): Promise<void> {
  await testDisabledProviderReturnsExplicitError();
  await testMockProviderIsDeterministicAndImageFree();
  await testOpenAiCompatibleRequiresExplicitEnablementAndPrivacyAcknowledgement();
  await testOpenAiCompatibleCallsChatCompletionsEndpoint();
  console.log('[ai-provider-test] PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
