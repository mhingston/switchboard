export function streamFromText(
  text: string,
  options?: { chunkSize?: number; delayMs?: number }
): AsyncIterable<string> {
  const chunkSize = options?.chunkSize ?? 40;
  const delayMs = options?.delayMs ?? 0;

  async function* generator() {
    const chunks = splitText(text, chunkSize);
    for (const chunk of chunks) {
      yield chunk;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  return generator();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}
