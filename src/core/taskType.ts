import type { TaskType } from './types';

export function inferTaskType(text: string): TaskType {
  const normalized = text.toLowerCase();

  if (/```|\b(stack trace|error|exception|refactor|implement|bug|typescript|javascript|bun)\b/.test(normalized)) {
    return 'code';
  }

  if (/\b(summarize|rewrite|rephrase|tone|polish)\b/.test(normalized)) {
    return 'rewrite';
  }

  if (/\b(latest|sources?|compare|research|cite)\b/.test(normalized)) {
    return 'research';
  }

  return 'reasoning';
}
