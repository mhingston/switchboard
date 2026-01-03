import { expect, test } from 'bun:test';
import { createHandler } from '../../src/server/handler';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import { InMemoryMetrics } from '../../src/util/metrics';
import type { CandidateModel, PoliciesConfig } from '../../src/core/types';
import type { RouterDeps } from '../../src/core/router';
import { MockAdapter } from '../mocks/mockAdapter';

const model: CandidateModel = {
  id: 'model:debug',
  provider: 'test',
  aiProvider: 'codex-cli',
  name: 'debug',
  context: 8000,
  capabilities: { reasoning: 5 },
  costWeight: 1,
  enabled: true,
};

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['model:debug'],
      minCapability: 1,
      qualityThreshold: 0.2,
      maxAttemptsPerCycle: 1,
      pollIntervalMs: 5,
      maxWaitMs: 50,
    },
  },
};

const responseText =
  'This is a sufficiently long response for heuristics. '.repeat(6);

test('debug metadata only included when header is set', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();
  const metrics = new InMemoryMetrics();

  adapter.queue('model:debug', {
    generate: async () => ({ text: responseText }),
  });
  adapter.queue('model:debug', {
    generate: async () => ({ text: responseText }),
  });

  const routerDeps: RouterDeps = {
    models: [model],
    policies,
    healthStore,
    budgetStore,
    adapter,
    metrics,
  };

  const handler = createHandler({
    routerDeps,
    reloadConfig: async () => {},
  });

  const baseBody = JSON.stringify({
    messages: [{ role: 'user', content: 'Hello there.' }],
  });

  const request = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: baseBody,
  });

  const response = await handler(request);
  const payload = await response.json();
  expect(payload.router).toBeUndefined();
  expect(response.headers.get('x-router-metadata')).toBeNull();

  const debugRequest = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-router-debug': 'true' },
    body: baseBody,
  });

  const debugResponse = await handler(debugRequest);
  const debugPayload = await debugResponse.json();
  expect(debugPayload.router).toBeDefined();
  expect(debugResponse.headers.get('x-router-metadata')).toBeTruthy();
});
