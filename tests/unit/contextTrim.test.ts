import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { MockAdapter } from '../mocks/mockAdapter';

const model: CandidateModel = {
  id: 'model:tiny',
  provider: 'test',
  aiProvider: 'codex-cli',
  name: 'tiny',
  context: 60,
  capabilities: { reasoning: 5 },
  costWeight: 1,
  enabled: true,
};

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['model:tiny'],
      minCapability: 1,
      qualityThreshold: 0.1,
      maxAttemptsPerCycle: 1,
      pollIntervalMs: 5,
      maxWaitMs: 50,
    },
  },
};

test('route trims oldest non-system messages to fit context', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  adapter.queue('model:tiny', {
    generate: async () => ({ text: 'ok response with enough length' }),
  });

  const firstMessage = 'first message should be dropped '.repeat(12);
  const secondMessage = 'second message should be dropped '.repeat(12);
  const request: RouterRequest = {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: firstMessage },
      { role: 'user', content: secondMessage },
      { role: 'user', content: 'keep me' },
    ],
    taskType: 'reasoning',
    qualityThreshold: 0.1,
    maxWaitMs: 50,
    attemptBudget: 1,
    requestId: 'req_trim',
    stream: false,
    maxTokens: 8,
  };

  await route(request, {
    models: [model],
    policies,
    healthStore,
    budgetStore,
    adapter,
  });

  const [call] = adapter.getRequests();
  expect(call).toBeDefined();
  const contents = call.request.messages.map((m) => m.content);
  expect(contents).toContain('system');
  expect(contents).toContain('keep me');
  expect(contents).not.toContain(firstMessage);
  expect(contents).not.toContain(secondMessage);
});
