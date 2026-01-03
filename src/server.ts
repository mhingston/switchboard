import { loadConfig } from './core/config';
import { HealthStoreSqlite } from './core/healthStore';
import { BudgetStoreSqlite } from './core/budgetStore';
import { SessionStoreSqlite } from './core/sessionStore';
import { aiProviderAdapter } from './adapters/aiProviderAdapter';
import { logError, logInfo } from './util/logger';
import { InMemoryMetrics } from './util/metrics';
import { createHandler } from './server/handler';

let config = await loadConfig();
const statePath = process.env.STATE_DB_PATH ?? 'data/state.sqlite';
const healthStore = new HealthStoreSqlite(statePath);
const budgetStore = new BudgetStoreSqlite(statePath);
const sessionStore = new SessionStoreSqlite(statePath);
const metrics = new InMemoryMetrics();

await applyBudgetLimits(config);

const routerDeps = {
  models: config.models.models,
  policies: config.policies,
  healthStore,
  budgetStore,
  adapter: aiProviderAdapter,
  sessionStore,
  metrics,
};

const port = Number(process.env.PORT ?? 3000);
const handler = createHandler({ routerDeps, reloadConfig });

Bun.serve({
  port,
  fetch: handler,
});

logInfo('router_started', { port });

async function reloadConfig(): Promise<void> {
  config = await loadConfig();
  routerDeps.models = config.models.models;
  routerDeps.policies = config.policies;
  await applyBudgetLimits(config);
}

async function applyBudgetLimits(currentConfig: typeof config): Promise<void> {
  if (currentConfig.policies.budgets?.providers) {
    const entries = Object.entries(currentConfig.policies.budgets.providers);
    for (const [provider, limits] of entries) {
      await budgetStore.ensureLimits(provider, limits);
    }
  }
}

process.on('SIGHUP', async () => {
  try {
    await reloadConfig();
    logInfo('config_reloaded');
  } catch (error) {
    logError('config_reload_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
});
