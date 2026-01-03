import type {
  CandidateModel,
  ModelHealth,
  ProviderBudget,
  RoutingPolicy,
  TaskType,
} from './types';

export function scoreModel(
  model: CandidateModel,
  taskType: TaskType,
  health: ModelHealth,
  budget: ProviderBudget,
  policy: RoutingPolicy
): number {
  const weights = {
    capability: 1,
    reliability: 0.5,
    cost: 0.5,
    latency: 0.2,
    degradePenalty: 1.5,
    budgetPenalty: 1,
    ...policy.weights,
  };

  const capabilityScore = model.capabilities[taskType] ?? 0;
  let score = weights.capability * capabilityScore;

  score -= weights.cost * (model.costWeight ?? 1);

  if (health.degradedUntil > Date.now()) {
    score -= weights.degradePenalty;
  }

  if (budget.softLimitTokens && budget.usedTokens >= budget.softLimitTokens * 0.9) {
    score -= weights.budgetPenalty;
  }

  const successRate = health.rollingSuccessRate ?? 1;
  score += weights.reliability * successRate;

  const latencyMs = health.rollingLatencyMs ?? 0;
  if (latencyMs > 0) {
    const normalizedLatency = Math.min(latencyMs / 1000, 5);
    score -= weights.latency * normalizedLatency;
  }

  return score;
}
