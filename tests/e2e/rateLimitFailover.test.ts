import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { AdapterError } from '../../src/adapters/errors';
import { MockAdapter } from '../mocks/mockAdapter';

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
      qualityThreshold: 0.5,
      maxAttemptsPerCycle: 2,
      pollIntervalMs: 5,
      maxWaitMs: 100,
    },
  },
};

const request: RouterRequest = {
  messages: [{ role: 'user', content: 'Write a function.' }],
  taskType: 'code',
  qualityThreshold: 0.5,
  maxWaitMs: 100,
  attemptBudget: 2,
  requestId: 'req_test',
  stream: false,
};

test('rate limit failover sets cooldown and returns fallback', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  adapter.queue('openai:gpt-5.2', {
    generate: async () => {
      throw new AdapterError('RATE_LIMIT', 'rate limited', 10000);
    },
  });

  adapter.queue('local:llama3', {
    generate: async () => ({
      text:
        '```ts\n' +
        'export function ok() {\n' +
        '  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];\n' +
        '  return values.map((v) => v * 2).filter((v) => v % 3 === 0);\n' +
        '}\n' +
        '```\n',
    }),
  });

  const result = await route(request, {
    models,
    policies,
    healthStore,
    budgetStore,
    adapter,
  });

  expect(result.type).toBe('text');
  const health = await healthStore.get('openai:gpt-5.2');
  expect(health.cooldownUntil).toBeGreaterThan(Date.now());
});
