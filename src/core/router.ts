import type {
  CandidateModel,
  PoliciesConfig,
  ProviderAdapter,
  RouteResult,
  RouterRequest,
  RoutingAttempt,
  RoutingMetadata,
  RoutingPolicy,
} from './types';
import type { HealthStore } from './healthStore';
import type { BudgetStore } from './budgetStore';
import type { SessionStore } from './sessionStore';
import { evaluate } from './evaluator/index';
import { scoreModel } from './scoring';
import { estimateTokens } from '../util/tokens';
import { sleep } from '../util/sleep';
import { AdapterError } from '../adapters/errors';
import { NoSuitableModelError } from './errors';
import { streamFromText } from '../util/stream';
import type { Metrics } from '../util/metrics';
import { logError, logInfo } from '../util/logger';

export type RouterDeps = {
  models: CandidateModel[];
  policies: PoliciesConfig;
  healthStore: HealthStore;
  budgetStore: BudgetStore;
  adapter: ProviderAdapter;
  sessionStore?: SessionStore;
  metrics?: Metrics;
};

const RATE_LIMIT_BASE_MS = 2000;
const RATE_LIMIT_CAP_MS = 60000;
const RATE_LIMIT_WINDOW_MS = 60000;

function policyForTask(policies: PoliciesConfig, taskType: string): RoutingPolicy {
  return policies.routing[taskType] ?? policies.routing.default;
}

function requiredContextTokens(request: RouterRequest): number {
  const combined = request.messages.map((m) => m.content).join('\n');
  return estimateTokens(combined) + (request.maxTokens ?? 0);
}

export async function route(
  request: RouterRequest,
  deps: RouterDeps
): Promise<RouteResult> {
  const policy = policyForTask(deps.policies, request.taskType);
  const maxWaitMs = request.maxWaitMs || policy.maxWaitMs;
  const attemptBudget = request.attemptBudget || policy.maxAttemptsPerCycle;
  const threshold = request.qualityThreshold ?? policy.qualityThreshold;
  const preferred = policy.preferred ?? [];

  const start = Date.now();
  const attemptsLog: RoutingAttempt[] = [];
  if (request.resume && deps.sessionStore) {
    const session = await deps.sessionStore.get(request.requestId);
    if (session?.status === 'complete' && session.responseText) {
      logInfo('router_resume_hit', {
        requestId: request.requestId,
        modelId: session.selectedModelId,
      });
      return {
        type: 'text',
        response: { text: session.responseText },
        modelId: session.selectedModelId ?? 'unknown',
        metadata: buildMetadata(session.attempts, session.selectedModelId ?? 'unknown', request.taskType),
      };
    }
  }

  while (Date.now() - start < maxWaitMs) {
    const eligibleModels = deps.models.filter((model) => {
      if (!model.enabled) return false;
      if (preferred.length > 0 && !preferred.includes(model.id)) return false;
      const capability = model.capabilities[request.taskType] ?? 0;
      if (capability < policy.minCapability) return false;
      return true;
    });

    const candidates = await Promise.all(
      eligibleModels.map(async (model) => {
        const health = await deps.healthStore.get(model.id);
        if (health.cooldownUntil > Date.now()) return null;
        const budget = await deps.budgetStore.get(model.provider);
        if (budget.hardLimitTokens && budget.usedTokens >= budget.hardLimitTokens) {
          return null;
        }
        const score = scoreModel(model, request.taskType, health, budget, policy);
        return { model, score };
      })
    );

    const ordered = candidates
      .filter((entry): entry is { model: CandidateModel; score: number } => !!entry)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const indexA = preferred.indexOf(a.model.id);
        const indexB = preferred.indexOf(b.model.id);
        const safeA = indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA;
        const safeB = indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB;
        return safeA - safeB;
      })
      .map((entry) => entry.model);

    let attempts = 0;
    for (const model of ordered) {
      if (attempts++ >= attemptBudget) break;

      const attemptStart = Date.now();
      const fittedMessages = fitMessagesToContext(
        request.messages,
        model.context,
        request.maxTokens ?? 0
      );
      if (!fittedMessages) {
        attemptsLog.push({ modelId: model.id, outcome: 'permanent' });
        await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
          modelId: model.id,
          outcome: 'permanent',
        });
        logInfo('router_context_unfit', {
          requestId: request.requestId,
          modelId: model.id,
        });
        continue;
      }
      try {
        if (fittedMessages.trimmedCount > 0) {
          logInfo('router_context_trim', {
            requestId: request.requestId,
            modelId: model.id,
            trimmedCount: fittedMessages.trimmedCount,
          });
        }
        if (request.stream && request.allowDegrade) {
          const providerStream = await deps.adapter.stream({
            model,
            request: { ...request, messages: fittedMessages.messages },
          });
          const streamWithTracking = streamWithMetrics({
            textStream: providerStream,
            request,
            deps,
            model,
            attemptsLog,
            startMs: start,
          });
          attemptsLog.push({ modelId: model.id, outcome: 'success' });
          await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
            modelId: model.id,
            outcome: 'success',
          });
          return {
            type: 'stream',
            stream: streamWithTracking,
            modelId: model.id,
            metadata: buildMetadata(attemptsLog, model.id, request.taskType),
          };
        }

        const response = await deps.adapter.generate({
          model,
          request: { ...request, messages: fittedMessages.messages },
        });
        const latencyMs = Date.now() - attemptStart;
        const evalResult = await evaluate(
          response.text,
          request,
          deps.policies.codeEvaluation,
          { hasToolCalls: Array.isArray(response.toolCalls) && response.toolCalls.length > 0 }
        );
        const score = evalResult.score;

        deps.metrics?.observeHistogram('eval_score_histogram', score, {
          task_type: request.taskType,
          model_id: model.id,
        });

        if (request.allowDegrade) {
          await deps.healthStore.recordResult(model.id, {
            success: score >= threshold,
            latencyMs,
          });
          deps.metrics?.incCounter('model_calls_total', {
            model_id: model.id,
            outcome: 'success',
          });
          attemptsLog.push({ modelId: model.id, outcome: 'success', score });
          await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
            modelId: model.id,
            outcome: 'success',
            score,
          });
          return await finalizeResult(
            request,
            deps,
            model,
            response,
            attemptsLog,
            start
          );
        }

        if (score >= threshold) {
          await deps.healthStore.recordResult(model.id, {
            success: true,
            latencyMs,
          });
          deps.metrics?.incCounter('model_calls_total', {
            model_id: model.id,
            outcome: 'success',
          });
          attemptsLog.push({ modelId: model.id, outcome: 'success', score });
          await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
            modelId: model.id,
            outcome: 'success',
            score,
          });
          return await finalizeResult(
            request,
            deps,
            model,
            response,
            attemptsLog,
            start
          );
        }

        const judgeResult = await maybeJudgeScore({
          responseText: response.text,
          request,
          deps,
          candidateModel: model,
          score,
          threshold,
        });

        if (judgeResult?.score !== undefined) {
          const judgedScore = judgeResult.score;
          deps.metrics?.observeHistogram('eval_score_histogram', judgedScore, {
            task_type: request.taskType,
            model_id: model.id,
          });
          if (judgedScore >= threshold) {
            await deps.healthStore.recordResult(model.id, {
              success: true,
              latencyMs,
            });
            deps.metrics?.incCounter('model_calls_total', {
              model_id: model.id,
              outcome: 'success',
            });
            attemptsLog.push({ modelId: model.id, outcome: 'success', score: judgedScore });
            await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
              modelId: model.id,
              outcome: 'success',
              score: judgedScore,
            });
            return await finalizeResult(
              request,
              deps,
              model,
              response,
              attemptsLog,
              start
            );
          }
        }

        await deps.healthStore.recordResult(model.id, {
          success: false,
          latencyMs,
        });
        deps.metrics?.incCounter('model_calls_total', {
          model_id: model.id,
          outcome: 'eval_fail',
        });
        attemptsLog.push({ modelId: model.id, outcome: 'eval_fail', score });
        await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
          modelId: model.id,
          outcome: 'eval_fail',
          score,
        });
        logInfo('router_eval_fail', {
          requestId: request.requestId,
          modelId: model.id,
          score,
        });
        await deps.healthStore.markDegraded(model.id, 30_000);
      } catch (error) {
        const latencyMs = Date.now() - attemptStart;
        if (error instanceof AdapterError) {
          if (error.type === 'RATE_LIMIT') {
            const now = Date.now();
            const health = await deps.healthStore.get(model.id);
            const withinWindow =
              now - (health.lastRateLimitAt ?? 0) <= RATE_LIMIT_WINDOW_MS;
            const strikes = withinWindow ? health.rateLimitStrikes + 1 : 1;
            const cooldownMs =
              error.retryAfterMs ??
              Math.min(RATE_LIMIT_BASE_MS * 2 ** (strikes - 1), RATE_LIMIT_CAP_MS);
            await deps.healthStore.markRateLimited(model.id, cooldownMs, {
              strikes,
              lastRateLimitAt: now,
            });
            deps.metrics?.incCounter('model_calls_total', {
              model_id: model.id,
              outcome: 'rate_limit',
            });
            deps.metrics?.setGauge('model_cooldown_seconds', cooldownMs / 1000, {
              model_id: model.id,
            });
            attemptsLog.push({ modelId: model.id, outcome: 'rate_limit' });
            await deps.healthStore.recordResult(model.id, {
              success: false,
              latencyMs,
            });
            await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
              modelId: model.id,
              outcome: 'rate_limit',
            });
            logInfo('router_rate_limit', {
              requestId: request.requestId,
              modelId: model.id,
              cooldownMs,
              strikes,
            });
            continue;
          }
          if (error.type === 'TRANSIENT') {
            deps.metrics?.incCounter('model_calls_total', {
              model_id: model.id,
              outcome: 'transient',
            });
            attemptsLog.push({ modelId: model.id, outcome: 'transient' });
            await deps.healthStore.recordResult(model.id, {
              success: false,
              latencyMs,
            });
            await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
              modelId: model.id,
              outcome: 'transient',
            });
            continue;
          }
          if (error.type === 'QUOTA_EXCEEDED') {
            deps.metrics?.incCounter('model_calls_total', {
              model_id: model.id,
              outcome: 'quota',
            });
            attemptsLog.push({ modelId: model.id, outcome: 'quota' });
            await deps.healthStore.recordResult(model.id, {
              success: false,
              latencyMs,
            });
            await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
              modelId: model.id,
              outcome: 'quota',
            });
            continue;
          }
          deps.metrics?.incCounter('model_calls_total', {
            model_id: model.id,
            outcome: 'permanent',
          });
          attemptsLog.push({ modelId: model.id, outcome: 'permanent' });
          if (error.message === 'context_length_exceeded') {
            await deps.healthStore.markDegraded(model.id, 60_000);
            logInfo('router_context_too_long', {
              requestId: request.requestId,
              modelId: model.id,
            });
          }
          await deps.healthStore.recordResult(model.id, {
            success: false,
            latencyMs,
          });
          await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
            modelId: model.id,
            outcome: 'permanent',
          });
        }
        if (!(error instanceof AdapterError)) {
          logError('router_unhandled_error', {
            requestId: request.requestId,
            modelId: model.id,
            error: error instanceof Error ? error.message : 'unknown',
          });
          deps.metrics?.incCounter('model_calls_total', {
            model_id: model.id,
            outcome: 'permanent',
          });
          attemptsLog.push({ modelId: model.id, outcome: 'permanent' });
          await deps.healthStore.recordResult(model.id, {
            success: false,
            latencyMs,
          });
          await deps.sessionStore?.recordAttempt(request.requestId, request.taskType, {
            modelId: model.id,
            outcome: 'permanent',
          });
        }
      }
    }

    if (Date.now() - start >= maxWaitMs) break;
    await sleep(policy.pollIntervalMs);
  }

  throw new NoSuitableModelError(10_000);
}

async function finalizeResult(
  request: RouterRequest,
  deps: RouterDeps,
  model: CandidateModel,
  response: { text: string; usage?: { totalTokens?: number }; toolCalls?: unknown[] },
  attemptsLog: RoutingAttempt[],
  startMs: number
): Promise<RouteResult> {
  const totalTokens = response.usage?.totalTokens ?? 0;
  if (totalTokens > 0) {
    await deps.budgetStore.record(model.provider, totalTokens);
  }

  if (request.stream && (!response.toolCalls || response.toolCalls.length === 0)) {
    const chunkSize = deps.policies.streaming?.chunkSize ?? 60;
    const delayMs = deps.policies.streaming?.chunkDelayMs ?? 0;
    const textStream = streamFromText(response.text, { chunkSize, delayMs });
    await deps.sessionStore?.recordResult(
      request.requestId,
      request.taskType,
      model.id,
      response.text
    );
    logInfo('router_complete', {
      requestId: request.requestId,
      modelId: model.id,
      elapsedMs: Date.now() - startMs,
      attempts: attemptsLog.length,
      attemptLog: attemptsLog,
    });
    return {
      type: 'stream',
      stream: textStream,
      modelId: model.id,
      metadata: buildMetadata(attemptsLog, model.id, request.taskType),
    };
  }

  if (request.stream && response.toolCalls?.length) {
    logInfo('router_stream_tool_calls_disabled', {
      requestId: request.requestId,
      modelId: model.id,
    });
  }

  await deps.sessionStore?.recordResult(
    request.requestId,
    request.taskType,
    model.id,
    response.text
  );
  logInfo('router_complete', {
    requestId: request.requestId,
    modelId: model.id,
    elapsedMs: Date.now() - startMs,
    attempts: attemptsLog.length,
    attemptLog: attemptsLog,
  });
  return {
    type: 'text',
    response,
    modelId: model.id,
    metadata: buildMetadata(attemptsLog, model.id, request.taskType),
  };
}

function fitMessagesToContext(
  messages: RouterRequest['messages'],
  maxContext: number,
  maxTokens: number
): { messages: RouterRequest['messages']; trimmedCount: number } | null {
  const trimmed = [...messages];
  let totalLength = trimmed.reduce((sum, msg) => sum + msg.content.length, 0);
  if (trimmed.length > 1) totalLength += trimmed.length - 1;
  let trimmedCount = 0;
  while (true) {
    const estimated = Math.ceil(totalLength / 4) + maxTokens;
    if (estimated <= maxContext) {
      return { messages: trimmed, trimmedCount };
    }

    const removableIndex = trimmed.findIndex(
      (msg) => msg.role !== 'system'
    );
    if (removableIndex === -1) {
      return null;
    }

    const [removed] = trimmed.splice(removableIndex, 1);
    totalLength -= removed.content.length;
    if (trimmed.length >= 1) totalLength -= 1;
    trimmedCount += 1;
  }
}

async function maybeJudgeScore(params: {
  responseText: string;
  request: RouterRequest;
  deps: RouterDeps;
  candidateModel: CandidateModel;
  score: number;
  threshold: number;
}): Promise<{ score: number } | null> {
  const judgeConfig = params.deps.policies.evaluationJudge;
  if (!judgeConfig?.enabled) return null;
  if (params.candidateModel.id === judgeConfig.modelId) return null;

  const minScore = judgeConfig.minScore ?? Math.max(0, params.threshold - 0.2);
  if (params.score < minScore) return null;

  const judgeModel = params.deps.models.find((m) => m.id === judgeConfig.modelId);
  if (!judgeModel) return null;

  const prompt =
    judgeConfig.prompt ??
    'You are a strict evaluator. Return only a number between 0 and 1.';

  const judgeRequest: RouterRequest = {
    ...params.request,
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content:
          `Task type: ${params.request.taskType}\n` +
          `Candidate response:\n${params.responseText}\n\n` +
          'Score (0-1):',
      },
    ],
    stream: false,
  };

  try {
    const response = await params.deps.adapter.generate({
      model: judgeModel,
      request: judgeRequest,
    });
    const match = response.text.match(/0(?:\.\d+)?|1(?:\.0+)?/);
    if (!match) return null;
    const score = Number(match[0]);
    if (Number.isNaN(score)) return null;
    logInfo('router_judge_score', {
      requestId: params.request.requestId,
      modelId: params.candidateModel.id,
      judgeModelId: judgeModel.id,
      score,
    });
    return { score };
  } catch (error) {
    logInfo('router_judge_failed', {
      requestId: params.request.requestId,
      modelId: params.candidateModel.id,
      judgeModelId: judgeModel.id,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

function buildMetadata(
  attempts: RoutingAttempt[],
  selectedModelId: string,
  taskType: RouterRequest['taskType']
): RoutingMetadata {
  return {
    attempts: [...attempts],
    selectedModelId,
    taskType,
  };
}

function streamWithMetrics(params: {
  textStream: AsyncIterable<string>;
  request: RouterRequest;
  deps: RouterDeps;
  model: CandidateModel;
  attemptsLog: RoutingAttempt[];
  startMs: number;
}): AsyncIterable<string> {
  const { textStream, request, deps, model, attemptsLog, startMs } = params;
  const threshold =
    request.qualityThreshold ??
    policyForTask(deps.policies, request.taskType).qualityThreshold;

  async function* generator() {
    let combinedText = '';
    const attemptStart = Date.now();
    for await (const chunk of textStream) {
      combinedText += chunk;
      yield chunk;
    }

    const latencyMs = Date.now() - attemptStart;
    const evalResult = await evaluate(
      combinedText,
      request,
      deps.policies.codeEvaluation,
      { hasToolCalls: false }
    );
    const score = evalResult.score;
    await deps.healthStore.recordResult(model.id, {
      success: score >= threshold,
      latencyMs,
    });
    deps.metrics?.observeHistogram('eval_score_histogram', score, {
      task_type: request.taskType,
      model_id: model.id,
    });
    deps.metrics?.incCounter('model_calls_total', {
      model_id: model.id,
      outcome: 'success',
    });
    const inputTokens = estimateTokens(
      request.messages.map((m) => m.content).join('\n')
    );
    const outputTokens = estimateTokens(combinedText);
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens > 0) {
      await deps.budgetStore.record(model.provider, totalTokens);
    }

    await deps.sessionStore?.recordResult(
      request.requestId,
      request.taskType,
      model.id,
      combinedText
    );
    logInfo('router_complete', {
      requestId: request.requestId,
      modelId: model.id,
      elapsedMs: Date.now() - startMs,
      attempts: attemptsLog.length,
      attemptLog: attemptsLog,
    });
  }

  return generator();
}
