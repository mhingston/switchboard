import type { TaskType } from '../types';

const REFUSAL_PATTERNS = [
  "i can't",
  'i cannot',
  'i am not able',
  "i'm not able",
  'as an ai',
  'i do not have the ability',
  'i cannot comply',
  'unable to help',
];

export function heuristicScore(
  text: string,
  taskType: TaskType,
  options?: { hasToolCalls?: boolean }
): number {
  const normalized = text.trim().toLowerCase();
  const hasToolCalls = options?.hasToolCalls ?? false;
  if (!normalized && !hasToolCalls) return 0;

  let score = hasToolCalls ? 0.45 : 0.35;

  if (normalized.length >= 120) score += 0.15;
  if (normalized.length >= 400) score += 0.2;
  if (normalized.length < 40) score -= 0.2;

  if (REFUSAL_PATTERNS.some((p) => normalized.includes(p))) {
    score -= 0.7;
  }

  if (taskType === 'code') {
    const hasCodeBlock = /```[\s\S]*```/.test(text);
    const hasDiff = /^diff --git|^\+\+\+|^\-\-\-|^\@\@/m.test(text);
    const hasFileHint = /\b(src\/|lib\/|tests?\/|\.ts|\.js|\.py|\.go)\b/i.test(text);
    if (hasCodeBlock || hasDiff) score += 0.25;
    else if (!hasToolCalls) score -= 0.3;
    if (hasFileHint) score += 0.05;
  }

  if (taskType === 'research') {
    const hasLink = /(https?:\/\/|www\.)/.test(text);
    if (hasLink) score += 0.1;
  }

  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}
