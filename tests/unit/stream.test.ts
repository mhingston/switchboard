import { expect, test } from 'bun:test';
import { streamFromText } from '../../src/util/stream';

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

test('streamFromText chunks text by size', async () => {
  const text = 'abcdefghij';
  const chunks = await collect(streamFromText(text, { chunkSize: 3 }));
  expect(chunks.join('')).toBe(text);
  expect(chunks.every((chunk) => chunk.length <= 3)).toBe(true);
});

test('streamFromText applies delay between chunks', async () => {
  const text = 'abcdefghij';
  const delayMs = 5;
  const start = Date.now();
  await collect(streamFromText(text, { chunkSize: 5, delayMs }));
  const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(delayMs);
});
