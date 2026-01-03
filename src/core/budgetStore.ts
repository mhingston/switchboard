import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderBudget } from './types';

export interface BudgetStore {
  get(provider: string): Promise<ProviderBudget>;
  record(provider: string, tokens: number): Promise<void>;
  ensureLimits(
    provider: string,
    limits: { softLimitTokens?: number; hardLimitTokens?: number }
  ): Promise<void>;
}

const DEFAULT_BUDGET: ProviderBudget = { usedTokens: 0 };

export class BudgetStoreSqlite implements BudgetStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS provider_budget (
        provider TEXT PRIMARY KEY,
        used_tokens INTEGER NOT NULL,
        soft_limit_tokens INTEGER,
        hard_limit_tokens INTEGER,
        updated_at INTEGER NOT NULL
      )`
    );
  }

  async get(provider: string): Promise<ProviderBudget> {
    const row = this.db
      .query(
        'SELECT used_tokens AS usedTokens, soft_limit_tokens AS softLimitTokens, hard_limit_tokens AS hardLimitTokens FROM provider_budget WHERE provider = ?'
      )
      .get(provider) as ProviderBudget | undefined;

    if (!row) return { ...DEFAULT_BUDGET };

    return {
      usedTokens: row.usedTokens ?? 0,
      softLimitTokens: row.softLimitTokens ?? undefined,
      hardLimitTokens: row.hardLimitTokens ?? undefined,
    };
  }

  async record(provider: string, tokens: number): Promise<void> {
    const now = Date.now();
    this.db.run(
      `INSERT INTO provider_budget (provider, used_tokens, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         used_tokens = used_tokens + excluded.used_tokens,
         updated_at = excluded.updated_at`,
      provider,
      tokens,
      now
    );
  }

  async ensureLimits(
    provider: string,
    limits: { softLimitTokens?: number; hardLimitTokens?: number }
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.get(provider);
    this.db.run(
      `INSERT INTO provider_budget (provider, used_tokens, soft_limit_tokens, hard_limit_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         soft_limit_tokens = excluded.soft_limit_tokens,
         hard_limit_tokens = excluded.hard_limit_tokens,
         updated_at = excluded.updated_at`,
      provider,
      existing.usedTokens ?? 0,
      limits.softLimitTokens ?? null,
      limits.hardLimitTokens ?? null,
      now
    );
  }
}

export class BudgetStoreMemory implements BudgetStore {
  private store = new Map<string, ProviderBudget>();

  async get(provider: string): Promise<ProviderBudget> {
    return this.store.get(provider) ?? { ...DEFAULT_BUDGET };
  }

  async record(provider: string, tokens: number): Promise<void> {
    const existing = this.store.get(provider) ?? { ...DEFAULT_BUDGET };
    this.store.set(provider, {
      ...existing,
      usedTokens: existing.usedTokens + tokens,
    });
  }

  async ensureLimits(
    provider: string,
    limits: { softLimitTokens?: number; hardLimitTokens?: number }
  ): Promise<void> {
    const existing = this.store.get(provider) ?? { ...DEFAULT_BUDGET };
    this.store.set(provider, {
      ...existing,
      softLimitTokens: limits.softLimitTokens,
      hardLimitTokens: limits.hardLimitTokens,
    });
  }
}
