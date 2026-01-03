import type {
  AdapterGenerateParams,
  AdapterStreamParams,
  NormalizedResponse,
  ProviderAdapter,
} from '../../src/core/types';

export type MockBehavior = {
  generate?: (params: AdapterGenerateParams) => Promise<NormalizedResponse>;
  stream?: (params: AdapterStreamParams) => Promise<AsyncIterable<string>>;
};

export class MockAdapter implements ProviderAdapter {
  private behaviors = new Map<string, MockBehavior[]>();
  private calls: string[] = [];
  private requests: AdapterGenerateParams[] = [];

  queue(modelId: string, behavior: MockBehavior) {
    const list = this.behaviors.get(modelId) ?? [];
    list.push(behavior);
    this.behaviors.set(modelId, list);
  }

  async generate(params: AdapterGenerateParams): Promise<NormalizedResponse> {
    this.calls.push(params.model.id);
    this.requests.push(params);
    const behavior = this.shift(params.model.id);
    if (!behavior?.generate) {
      throw new Error(`No generate behavior queued for ${params.model.id}`);
    }
    return behavior.generate(params);
  }

  async stream(params: AdapterStreamParams): Promise<AsyncIterable<string>> {
    this.calls.push(params.model.id);
    const behavior = this.shift(params.model.id);
    if (!behavior?.stream) {
      async function* fallback() {
        yield 'stream not configured';
      }
      return fallback();
    }
    return behavior.stream(params);
  }

  private shift(modelId: string): MockBehavior | undefined {
    const list = this.behaviors.get(modelId) ?? [];
    const next = list.shift();
    if (list.length === 0) this.behaviors.delete(modelId);
    else this.behaviors.set(modelId, list);
    return next;
  }

  getCalls(): string[] {
    return [...this.calls];
  }

  getRequests(): AdapterGenerateParams[] {
    return [...this.requests];
  }
}

export function streamFromText(text: string): AsyncIterable<string> {
  async function* generator() {
    const chunks = text.split(' ');
    for (const chunk of chunks) {
      yield `${chunk} `;
    }
  }
  return generator();
}
