import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { MockAdapter } from '../mocks/mockAdapter';

const models: CandidateModel[] = [
  {
    id: 'openai:gpt-5.2',
    provider: 'openai',
    aiProvider: 'openai',
    name: 'gpt-5.2',
    context: 8000,
    capabilities: { reasoning: 5 },
    costWeight: 1,
    enabled: true,
  },
  {
    id: 'google:gemini-2.5',
    provider: 'google',
    aiProvider: 'google',
    name: 'gemini-2.5-pro',
    context: 8000,
    capabilities: { reasoning: 4 },
    costWeight: 0.9,
    enabled: true,
  },
];

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['openai:gpt-5.2', 'google:gemini-2.5'],
      minCapability: 1,
      qualityThreshold: 0.2,
      maxAttemptsPerCycle: 2,
      pollIntervalMs: 5,
      maxWaitMs: 50,
    },
  },
};

const request: RouterRequest = {
  messages: [{ role: 'user', content: 'Explain briefly.' }],
  taskType: 'reasoning',
  qualityThreshold: 0.2,
  maxWaitMs: 50,
  attemptBudget: 2,
  requestId: 'req_budget',
  stream: false,
};

test('budget constraints skip providers at hard limit', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  await budgetStore.ensureLimits('openai', { hardLimitTokens: 10 });
  await budgetStore.record('openai', 10);

  adapter.queue('google:gemini-2.5', {
    generate: async () => ({
      text:
        'Here is a detailed response that should pass heuristic checks by being long enough ' +
        'and well-formed. It includes sufficient content to clear the quality threshold.',
    }),
  });

  await route(request, {
    models,
    policies,
    healthStore,
    budgetStore,
    adapter,
  });

  expect(adapter.getCalls()[0]).toBe('google:gemini-2.5');
});
