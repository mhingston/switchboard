import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'yaml';
import type { ModelsConfig, PoliciesConfig } from './types';
import { logWarn } from '../util/logger';

const DEFAULT_CONFIG_DIR = 'config';

export type LoadedConfig = {
  models: ModelsConfig;
  policies: PoliciesConfig;
};

export async function loadConfig(
  configDir: string = DEFAULT_CONFIG_DIR
): Promise<LoadedConfig> {
  const modelsPath = join(configDir, 'models.yaml');
  const policiesPath = join(configDir, 'policies.yaml');

  const [modelsRaw, policiesRaw] = await Promise.all([
    readFile(modelsPath, 'utf8'),
    readFile(policiesPath, 'utf8'),
  ]);

  const models = yaml.parse(modelsRaw) as ModelsConfig;
  const policies = yaml.parse(policiesRaw) as PoliciesConfig;

  validateModels(models);
  return { models, policies };
}

function validateModels(models: ModelsConfig): void {
  const knownContexts: Record<string, number> = {
    'gpt-5.2-codex': 400000,
    'gemini-3-pro-preview': 1048576,
    'gemini-3-flash-preview': 1048576,
    'claude-opus-4.5': 200000,
    'gpt-5-mini': 400000,
    'sonar-reasoning-pro': 200000,
  };

  for (const model of models.models ?? []) {
    if (!Number.isFinite(model.context) || model.context <= 0) {
      logWarn('model_context_invalid', {
        modelId: model.id,
        context: model.context,
      });
      continue;
    }

    const expected = knownContexts[model.name];
    if (expected && model.context !== expected) {
      logWarn('model_context_mismatch', {
        modelId: model.id,
        modelName: model.name,
        configured: model.context,
        expected,
      });
    }
  }
}
