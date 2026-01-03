import { createHash } from 'node:crypto';
import { route, type RouterDeps } from '../core/router';
import { inferTaskType } from '../core/taskType';
import type { RouterRequest } from '../core/types';
import { NoSuitableModelError } from '../core/errors';
import { logError } from '../util/logger';

type HandlerParams = {
  routerDeps: RouterDeps;
  reloadConfig: () => Promise<void>;
};

export function createHandler({ routerDeps, reloadConfig }: HandlerParams) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/metrics') {
      return new Response(routerDeps.metrics?.render() ?? '', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        models: routerDeps.models.length,
        enabled_models: routerDeps.models.filter((m) => m.enabled).length,
        policies: Object.keys(routerDeps.policies.routing).length,
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/reload') {
      if (!isAdminAuthorized(req)) {
        return jsonResponse(
          { error: { code: 'unauthorized', message: 'Admin token required' } },
          401
        );
      }
      await reloadConfig();
      return jsonResponse({ status: 'reloaded' });
    }

    if (
      req.method !== 'POST' ||
      (url.pathname !== '/v1/chat/completions' && url.pathname !== '/v1/responses')
    ) {
      return new Response('Not Found', { status: 404 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch (error) {
      return new Response('Invalid JSON', { status: 400 });
    }

    const isResponsesRequest = url.pathname === '/v1/responses';
    const messages = isResponsesRequest
      ? normalizeResponsesInput(body?.input)
      : normalizeMessages(body?.messages);
    if (!messages || messages.length === 0) {
      return jsonResponse(
        {
          error: {
            code: 'invalid_request',
            message: isResponsesRequest
              ? 'input must be a string or array'
              : 'messages must be an array',
          },
        },
        400
      );
    }
    const combinedText = messages.map((m) => m.content).join('\n');
    const taskType = normalizeTaskType(
      req.headers.get('x-router-task-type'),
      body?.task_type,
      combinedText
    );

    const qualityThreshold = parseThreshold(
      req.headers.get('x-router-quality-threshold')
    );

    const maxWaitMs = parseNumber(req.headers.get('x-router-max-wait-ms'));
    const allowDegrade = parseBoolean(
      req.headers.get('x-router-allow-degrade')
    );
    const resume = parseBoolean(req.headers.get('x-router-resume'));

    const requestId =
      req.headers.get('x-router-request-id') ??
      body?.request_id ??
      createRequestId(combinedText);

    const routerRequest: RouterRequest = {
      messages,
      taskType,
      qualityThreshold: qualityThreshold ?? 0,
      maxWaitMs: maxWaitMs ?? 0,
      attemptBudget: 0,
      requestId,
      temperature: body?.temperature,
      topP: body?.top_p,
      maxTokens: body?.max_tokens,
      stream: Boolean(body?.stream),
      allowDegrade,
      resume,
      tools: Array.isArray(body?.tools) ? body.tools : undefined,
      toolChoice: body?.tool_choice,
    };

    if (routerRequest.resume && !isResumeAuthorized(req)) {
      return jsonResponse(
        { error: { code: 'unauthorized', message: 'Resume requires admin token' } },
        401
      );
    }

    try {
      if (url.pathname === '/v1/responses' && routerRequest.stream) {
        return jsonResponse(
          {
            error: {
              code: 'unsupported',
              message: 'Streaming is not supported for /v1/responses',
            },
          },
          400
        );
      }
      const start = Date.now();
      const result = await route(routerRequest, routerDeps);
      const modelName = 'router';
      const elapsed = Date.now() - start;
      routerDeps.metrics?.observeHistogram('wait_time_ms_histogram', elapsed, {
        task_type: taskType,
      });
      routerDeps.metrics?.incCounter('router_requests_total', { status: '200' });
      const debugHeader = req.headers.get('x-router-debug');
      const includeDebug = debugHeader?.toLowerCase() === 'true';

      if (result.type === 'stream') {
        const stream = openAiStream(result.stream, modelName, requestId);
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(includeDebug ? metadataHeaders(result.metadata) : {}),
          },
        });
      }

      const payload =
        url.pathname === '/v1/responses'
          ? formatResponses(result.response, modelName, requestId)
          : formatChatCompletions(result.response, modelName);
      if (includeDebug) {
        return jsonResponse(
          { ...payload, router: result.metadata },
          200,
          metadataHeaders(result.metadata)
        );
      }
      return jsonResponse(payload);
    } catch (error) {
      if (error instanceof NoSuitableModelError) {
        routerDeps.metrics?.incCounter('router_requests_total', { status: '503' });
        return jsonResponse(
          {
            error: {
              code: 'no_suitable_model_available',
              message: 'No suitable model available before timeout',
              retry_after_ms: error.retryAfterMs,
            },
          },
          503
        );
      }

      logError('router_failure', {
        requestId,
        error: error instanceof Error ? error.message : 'unknown',
      });

      routerDeps.metrics?.incCounter('router_requests_total', { status: '500' });
      return jsonResponse(
        {
          error: {
            code: 'router_error',
            message: 'Router failed to process request',
          },
        },
        500
      );
    }
  };
}

function normalizeMessages(
  raw: unknown
): { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const msg = message as {
        role?: string;
        content?: string | { type: string; text?: string }[];
      };
      const role =
        msg.role === 'system' ||
        msg.role === 'assistant' ||
        msg.role === 'tool'
          ? msg.role
          : 'user';
      const content = normalizeContent(msg.content ?? '');
      return { role, content };
    })
    .filter(
      (
        msg
      ): msg is { role: 'system' | 'user' | 'assistant' | 'tool'; content: string } =>
        !!msg && msg.content.length > 0
    );
}

function normalizeResponsesInput(
  input: unknown
): { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[] {
  if (!input) return [];
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    const maybeMessages = input.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        'role' in item &&
        'content' in item
    );
    if (maybeMessages) {
      return (
        normalizeMessages(
          input as { role: string; content: string | { type: string; text?: string }[] }[]
        ) ?? []
      );
    }
    const combined = input
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('\n');
    return [{ role: 'user', content: combined }];
  }
  return [{ role: 'user', content: JSON.stringify(input) }];
}

function normalizeContent(
  content: string | { type: string; text?: string }[]
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

function normalizeTaskType(
  header: string | null,
  bodyTaskType: unknown,
  text: string
): RouterRequest['taskType'] {
  const normalized = header?.toLowerCase();
  if (
    normalized &&
    ['code', 'reasoning', 'research', 'rewrite', 'default'].includes(normalized)
  ) {
    return normalized as RouterRequest['taskType'];
  }

  if (typeof bodyTaskType === 'string') {
    const bodyNormalized = bodyTaskType.toLowerCase();
    if (
      ['code', 'reasoning', 'research', 'rewrite', 'default'].includes(
        bodyNormalized
      )
    ) {
      return bodyNormalized as RouterRequest['taskType'];
    }
  }

  return inferTaskType(text);
}

function parseThreshold(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return undefined;
  if (numeric > 1) return Math.min(numeric / 5, 1);
  return Math.max(numeric, 0);
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return undefined;
  return numeric;
}

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function createRequestId(seed: string): string {
  const hash = createHash('sha256').update(seed + Date.now().toString()).digest('hex');
  return `req_${hash.slice(0, 12)}`;
}

function formatChatCompletions(
  response: {
    text: string;
    toolCalls?: unknown[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  },
  model: string
) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: response.text,
          ...(response.toolCalls ? { tool_calls: response.toolCalls } : {}),
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: response.usage?.inputTokens ?? 0,
      completion_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? 0,
    },
  };
}

function formatResponses(
  response: {
    text: string;
    toolCalls?: unknown[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  },
  model: string,
  requestId: string
) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${requestId}`,
    object: 'response',
    created,
    model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: response.text,
          },
        ],
        ...(response.toolCalls ? { tool_calls: response.toolCalls } : {}),
      },
    ],
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? 0,
    },
  };
}

function openAiStream(
  textStream: AsyncIterable<string>,
  model: string,
  requestId: string
) {
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of textStream) {
          const delta: { role?: string; content?: string } = {};
          if (!sentRole) {
            delta.role = 'assistant';
            sentRole = true;
          }
          delta.content = chunk;

          const payload = {
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
        }

        const finalPayload = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        };

        controller.enqueue(`data: ${JSON.stringify(finalPayload)}\n\n`);
        controller.enqueue('data: [DONE]\n\n');
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
  });
}

function isAdminAuthorized(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const header = req.headers.get('x-router-admin-token');
  return header === token;
}

function isResumeAuthorized(req: Request): boolean {
  if (process.env.ALLOW_INSECURE_RESUME === 'true') return true;
  return isAdminAuthorized(req);
}

function metadataHeaders(metadata?: unknown): Record<string, string> {
  if (!metadata) return {};
  const encoded = Buffer.from(JSON.stringify(metadata)).toString('base64');
  return { 'x-router-metadata': encoded };
}
