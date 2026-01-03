import { generateText, streamText } from 'ai';
import createCopilot from 'ai-sdk-provider-github';
import { createGeminiProvider } from 'ai-sdk-provider-gemini-cli';
import { codexCli } from 'ai-sdk-provider-codex-cli';
import { perplexity } from '@ai-sdk/perplexity';
import type { ProviderAdapter, AdapterGenerateParams, AdapterStreamParams } from '../core/types';
import { AdapterError, normalizeAdapterError } from './errors';

const githubProvider = createCopilot();
const geminiCliProvider = createGeminiProvider();

function providerFor(aiProvider: string, modelName: string) {
  switch (aiProvider) {
    case 'github':
      return githubProvider(modelName);
    case 'gemini-cli':
      return geminiCliProvider(modelName);
    case 'codex-cli':
      return codexCli(modelName);
    case 'perplexity':
      return perplexity(modelName);
    default:
      throw new AdapterError('PERMANENT', `Unknown aiProvider: ${aiProvider}`);
  }
}

export const aiProviderAdapter: ProviderAdapter = {
  async generate({ model, request }: AdapterGenerateParams) {
    try {
      const providerModel = providerFor(model.aiProvider, model.name);
      const result = await generateText({
        model: providerModel,
        messages: request.messages,
        temperature: request.temperature,
        topP: request.topP,
        maxTokens: request.maxTokens,
        tools: request.tools,
        toolChoice: request.toolChoice,
      });

      return {
        text: result.text,
        toolCalls: result.toolCalls ?? undefined,
        usage: {
          inputTokens: result.usage?.promptTokens,
          outputTokens: result.usage?.completionTokens,
          totalTokens: result.usage?.totalTokens,
        },
        raw: result,
      };
    } catch (error) {
      throw normalizeAdapterError(error);
    }
  },

  async stream({ model, request }: AdapterStreamParams) {
    try {
      const providerModel = providerFor(model.aiProvider, model.name);
      const result = await streamText({
        model: providerModel,
        messages: request.messages,
        temperature: request.temperature,
        topP: request.topP,
        maxTokens: request.maxTokens,
        tools: request.tools,
        toolChoice: request.toolChoice,
      });

      return result.textStream;
    } catch (error) {
      throw normalizeAdapterError(error);
    }
  },
};
