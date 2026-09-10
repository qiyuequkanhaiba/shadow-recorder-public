import type { ReplayStepGenerateResult, StructuredStepContext } from '../../../types/contracts';

export interface ReplayStepInput {
  contexts: StructuredStepContext[];
  aiEnabled?: boolean;
  privacyAcknowledgedAt?: string;
}

export type ReplayStepResult = ReplayStepGenerateResult;

export interface ReplayStepProvider {
  name: 'disabled' | 'mock' | 'openai_compatible';
  generate(input: ReplayStepInput): Promise<ReplayStepResult>;
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    text?: unknown;
  }>;
};

export function createDisabledReplayStepProvider(): ReplayStepProvider {
  return {
    name: 'disabled',
    async generate(): Promise<ReplayStepResult> {
      throw new Error('AI replay generation is disabled.');
    },
  };
}

export function createMockReplayStepProvider(): ReplayStepProvider {
  return {
    name: 'mock',
    async generate(input): Promise<ReplayStepResult> {
      return {
        provider: 'mock',
        generatedAtMs: Date.now(),
        steps: input.contexts.map(formatMockReplayStep),
      };
    },
  };
}

export function createOpenAiCompatibleReplayStepProvider(
  config: OpenAiCompatibleConfig,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): ReplayStepProvider {
  return {
    name: 'openai_compatible',
    async generate(input): Promise<ReplayStepResult> {
      requireAiSafetyGate(input);
      const endpoint = resolveChatCompletionsEndpoint(config.baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, config.timeoutMs));

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: buildOpenAiCompatibleHeaders(config),
          body: JSON.stringify(buildChatCompletionPayload(config.model, input.contexts)),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `OpenAI-compatible replay generation failed (${response.status} ${response.statusText}): ${body}`.trim(),
          );
        }

        const payload = await response.json() as ChatCompletionResponse;
        return {
          provider: 'openai_compatible',
          generatedAtMs: Date.now(),
          model: config.model,
          steps: parseReplaySteps(payload),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function requireAiSafetyGate(input: ReplayStepInput): void {
  if (input.aiEnabled !== true) {
    throw new Error('OpenAI-compatible replay generation requires explicit enablement.');
  }
  if (!input.privacyAcknowledgedAt?.trim()) {
    throw new Error('OpenAI-compatible replay generation requires privacy acknowledgement.');
  }
}

function resolveChatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('OpenAI-compatible baseUrl is required.');
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function buildOpenAiCompatibleHeaders(config: OpenAiCompatibleConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey?.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }
  return headers;
}

function buildChatCompletionPayload(model: string, contexts: StructuredStepContext[]): Record<string, unknown> {
  return {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Generate concise replay steps from image-free structured recorder contexts. Return JSON only: {"steps":["..."]}.',
      },
      {
        role: 'user',
        content: JSON.stringify({ contexts: contexts.map(stripContextForAi) }),
      },
    ],
  };
}

function stripContextForAi(context: StructuredStepContext): StructuredStepContext {
  return {
    stepId: context.stepId,
    timestampMs: context.timestampMs,
    action: context.action,
    position: { ...context.position },
    windowTitle: context.windowTitle,
    processName: context.processName,
    captureBackend: context.captureBackend,
    hasImage: context.hasImage,
    privacyFiltered: context.privacyFiltered,
  };
}

function parseReplaySteps(response: ChatCompletionResponse): string[] {
  const content = response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text;
  const text = Array.isArray(content)
    ? content.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    : String(content ?? '').trim();

  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as { steps?: unknown };
    if (Array.isArray(parsed.steps)) {
      return parsed.steps.map((step) => String(step).trim()).filter(Boolean);
    }
  } catch {
    // Fall through to line parsing for local OpenAI-compatible servers that return plain text.
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
}

function formatMockReplayStep(context: StructuredStepContext, index: number): string {
  const target = [context.processName, context.windowTitle].filter(Boolean).join(' · ') || 'unknown target';
  const imageState = context.privacyFiltered
    ? 'privacy-filtered'
    : context.hasImage
      ? 'image-available'
      : 'image-free';
  return `${index + 1}. ${context.action} at (${context.position.x}, ${context.position.y}) on ${target} [${imageState}]`;
}
