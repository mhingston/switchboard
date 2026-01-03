import type { RouterRequest } from '../types';
import { heuristicScore } from './heuristics';
import { runCodeEvaluation, type CodeEvaluationConfig } from './codeEval';

export type EvaluationResult = {
  score: number;
  details?: {
    heuristicScore: number;
    codeEvalScore?: number;
    codeEvalPassed?: boolean;
  };
};

export async function evaluate(
  text: string,
  request: RouterRequest,
  codeEvalConfig?: CodeEvaluationConfig,
  options?: { hasToolCalls?: boolean }
): Promise<EvaluationResult> {
  const heuristic = heuristicScore(text, request.taskType, {
    hasToolCalls: options?.hasToolCalls,
  });
  let score = heuristic;
  let codeEvalScore: number | undefined;
  let codeEvalPassed: boolean | undefined;

  if (request.taskType === 'code' && codeEvalConfig?.enabled) {
    const result = await runCodeEvaluation(codeEvalConfig);
    codeEvalScore = result.score;
    codeEvalPassed = result.passed;
    if (result.passed) {
      score += codeEvalConfig.weight;
    } else {
      score -= codeEvalConfig.failurePenalty;
    }
  }

  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return {
    score,
    details: {
      heuristicScore: heuristic,
      codeEvalScore,
      codeEvalPassed,
    },
  };
}
