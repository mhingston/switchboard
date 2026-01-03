import { expect, test } from 'bun:test';
import { inferTaskType } from '../../src/core/taskType';

test('inferTaskType detects code prompts', () => {
  expect(inferTaskType('Please implement this function in TypeScript.')).toBe('code');
});

test('inferTaskType detects rewrite prompts', () => {
  expect(inferTaskType('Rewrite this paragraph with a friendly tone.')).toBe('rewrite');
});

test('inferTaskType detects research prompts', () => {
  expect(inferTaskType('Find sources and compare the latest benchmarks.')).toBe('research');
});

test('inferTaskType defaults to reasoning', () => {
  expect(inferTaskType('Explain why the sky is blue.')).toBe('reasoning');
});
