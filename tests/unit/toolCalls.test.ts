import { expect, test } from 'bun:test';
import { route } from '../../src/core/router';
import { HealthStoreMemory } from '../../src/core/healthStore';
import { BudgetStoreMemory } from '../../src/core/budgetStore';
import type { CandidateModel, PoliciesConfig, RouterRequest } from '../../src/core/types';
import { MockAdapter } from '../mocks/mockAdapter';

const model: CandidateModel = {
  id: 'model:tools',
  provider: 'test',
  aiProvider: 'codex-cli',
  name: 'tools',
  context: 2000,
  capabilities: { reasoning: 5 },
  costWeight: 1,
  enabled: true,
};

const policies: PoliciesConfig = {
  routing: {
    default: {
      preferred: ['model:tools'],
      minCapability: 1,
      qualityThreshold: 0.1,
      maxAttemptsPerCycle: 1,
      pollIntervalMs: 5,
      maxWaitMs: 50,
    },
  },
};

test('tool calls disable streaming and return text response', async () => {
  const adapter = new MockAdapter();
  const healthStore = new HealthStoreMemory();
  const budgetStore = new BudgetStoreMemory();

  adapter.queue('model:tools', {
    generate: async () => ({
      text: 'tool response',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'do' } }],
    }),
  });

  const request: RouterRequest = {
    messages: [{ role: 'user', content: 'Use a tool.' }],
    taskType: 'reasoning',
    qualityThreshold: 0.1,
    maxWaitMs: 50,
    attemptBudget: 1,
    requestId: 'req_tools',
    stream: true,
    tools: [{ type: 'function', function: { name: 'do' } }],
  };

  const result = await route(request, {
    models: [model],
    policies,
    healthStore,
    budgetStore,
    adapter,
  });

  expect(result.type).toBe('text');
  if (result.type === 'text') {
    expect(result.response.toolCalls?.length).toBe(1);
  }
});
