import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { MockAdapter } from '../mocks/mockAdapter';

const models: CandidateModel[] = [
  {
    id: 'model:a',
    provider: 'a',
    aiProvider: 'openai',
    name: 'a',
    context: 8000,
    capabilities: { reasoning: 3 },
    costWeight: 1,
    enabled: true,
  },
  {
    id: 'model:b',
    provider: 'b',
    aiProvider: 'openai',
    name: 'b',
    context: 8000,
    capabilities: { reasoning: 3 },
    costWeight: 1,
    enabled: true,
  },
];

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['model:b', 'model:a'],
      minCapability: 1,
      qualityThreshold: 0.1,
      maxAttemptsPerCycle: 2,
      pollIntervalMs: 5,
      maxWaitMs: 50,
    },
  },
};

const request: RouterRequest = {
  messages: [{ role: 'user', content: 'Explain briefly.' }],
  taskType: 'reasoning',
  qualityThreshold: 0.1,
  maxWaitMs: 50,
  attemptBudget: 2,
  requestId: 'req_order',
  stream: false,
};

test('routing honors preferred order when scores are tied', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  adapter.queue('model:a', {
    generate: async () => ({ text: 'ok from a' }),
  });
  adapter.queue('model:b', {
    generate: async () => ({ text: 'ok from b' }),
  });

  await route(request, {
    models,
    policies,
    healthStore,
    budgetStore,
    adapter,
  });

  expect(adapter.getCalls()[0]).toBe('model:b');
});
