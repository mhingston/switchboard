import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { MockAdapter } from '../mocks/mockAdapter';
import { NoSuitableModelError } from '../../src/core/errors';

const models: CandidateModel[] = [
  {
    id: 'openai:gpt-5.2',
    provider: 'openai',
    aiProvider: 'openai',
    name: 'gpt-5.2',
    context: 8000,
    capabilities: { code: 5 },
    costWeight: 1,
    enabled: true,
  },
  {
    id: 'local:llama3',
    provider: 'local',
    aiProvider: 'ollama',
    name: 'llama3',
    context: 8000,
    capabilities: { code: 3 },
    costWeight: 0.2,
    enabled: true,
  },
];

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['openai:gpt-5.2', 'local:llama3'],
      minCapability: 1,
      qualityThreshold: 0.9,
      maxAttemptsPerCycle: 2,
      pollIntervalMs: 5,
      maxWaitMs: 20,
    },
  },
};

const request: RouterRequest = {
  messages: [{ role: 'user', content: 'Write code.' }],
  taskType: 'code',
  qualityThreshold: 0.9,
  maxWaitMs: 20,
  attemptBudget: 2,
  requestId: 'req_test',
  stream: false,
};

test('timeout returns no suitable model error', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  adapter.queue('openai:gpt-5.2', {
    generate: async () => ({ text: 'no' }),
  });
  adapter.queue('local:llama3', {
    generate: async () => ({ text: 'nope' }),
  });
  adapter.queue('openai:gpt-5.2', {
    generate: async () => ({ text: 'still no' }),
  });
  adapter.queue('local:llama3', {
    generate: async () => ({ text: 'nope again' }),
  });

  try {
    await route(request, {
      models,
      policies,
      healthStore,
      budgetStore,
      adapter,
    });
    throw new Error('expected to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(NoSuitableModelError);
  }
});
