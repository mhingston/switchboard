import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelHealth } from './types';

export interface HealthStore {
  get(modelId: string): Promise<ModelHealth>;
  markRateLimited(
    modelId: string,
    cooldownMs: number,
    info?: { strikes?: number; lastRateLimitAt?: number }
  ): Promise<void>;
  markDegraded(modelId: string, degradeMs: number): Promise<void>;
  recordResult(
    modelId: string,
    result: { success: boolean; latencyMs?: number }
  ): Promise<void>;
}

const DEFAULT_HEALTH: ModelHealth = {
  cooldownUntil: 0,
  degradedUntil: 0,
  rateLimitStrikes: 0,
  lastRateLimitAt: 0,
  rollingLatencyMs: 0,
  rollingSuccessRate: 1,
};

const EMA_ALPHA = 0.2;

export class HealthStoreSqlite implements HealthStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS model_health (
        model_id TEXT PRIMARY KEY,
        cooldown_until INTEGER NOT NULL,
        degraded_until INTEGER NOT NULL,
        rate_limit_strikes INTEGER NOT NULL DEFAULT 0,
        last_rate_limit_at INTEGER NOT NULL DEFAULT 0,
        rolling_latency_ms REAL NOT NULL DEFAULT 0,
        rolling_success_rate REAL NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )`
    );
    this.ensureColumns();
  }

  async get(modelId: string): Promise<ModelHealth> {
    const row = this.db
      .query(
        `SELECT
          cooldown_until AS cooldownUntil,
          degraded_until AS degradedUntil,
          rate_limit_strikes AS rateLimitStrikes,
          last_rate_limit_at AS lastRateLimitAt,
          rolling_latency_ms AS rollingLatencyMs,
          rolling_success_rate AS rollingSuccessRate
        FROM model_health WHERE model_id = ?`
      )
      .get(modelId) as ModelHealth | undefined;

    if (!row) return { ...DEFAULT_HEALTH };

    return {
      cooldownUntil: row.cooldownUntil ?? 0,
      degradedUntil: row.degradedUntil ?? 0,
      rateLimitStrikes: row.rateLimitStrikes ?? 0,
      lastRateLimitAt: row.lastRateLimitAt ?? 0,
      rollingLatencyMs: row.rollingLatencyMs ?? 0,
      rollingSuccessRate: row.rollingSuccessRate ?? 1,
    };
  }

  async markRateLimited(
    modelId: string,
    cooldownMs: number,
    info?: { strikes?: number; lastRateLimitAt?: number }
  ): Promise<void> {
    const now = Date.now();
    const cooldownUntil = now + cooldownMs;
    const existing = await this.get(modelId);
    const strikes = info?.strikes ?? existing.rateLimitStrikes ?? 0;
    const lastRateLimitAt = info?.lastRateLimitAt ?? existing.lastRateLimitAt ?? 0;
    this.db.run(
      `INSERT INTO model_health (
        model_id,
        cooldown_until,
        degraded_until,
        rate_limit_strikes,
        last_rate_limit_at,
        rolling_latency_ms,
        rolling_success_rate,
        updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         cooldown_until = excluded.cooldown_until,
         rate_limit_strikes = excluded.rate_limit_strikes,
         last_rate_limit_at = excluded.last_rate_limit_at,
         rolling_latency_ms = excluded.rolling_latency_ms,
         rolling_success_rate = excluded.rolling_success_rate,
         updated_at = excluded.updated_at`,
      modelId,
      cooldownUntil,
      existing.degradedUntil ?? 0,
      strikes,
      lastRateLimitAt,
      existing.rollingLatencyMs ?? 0,
      existing.rollingSuccessRate ?? 1,
      now
    );
  }

  async markDegraded(modelId: string, degradeMs: number): Promise<void> {
    const now = Date.now();
    const degradedUntil = now + degradeMs;
    const existing = await this.get(modelId);
    this.db.run(
      `INSERT INTO model_health (
        model_id,
        cooldown_until,
        degraded_until,
        rate_limit_strikes,
        last_rate_limit_at,
        rolling_latency_ms,
        rolling_success_rate,
        updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         degraded_until = excluded.degraded_until,
         rate_limit_strikes = excluded.rate_limit_strikes,
         last_rate_limit_at = excluded.last_rate_limit_at,
         rolling_latency_ms = excluded.rolling_latency_ms,
         rolling_success_rate = excluded.rolling_success_rate,
         updated_at = excluded.updated_at`,
      modelId,
      existing.cooldownUntil ?? 0,
      degradedUntil,
      existing.rateLimitStrikes ?? 0,
      existing.lastRateLimitAt ?? 0,
      existing.rollingLatencyMs ?? 0,
      existing.rollingSuccessRate ?? 1,
      now
    );
  }

  async recordResult(
    modelId: string,
    result: { success: boolean; latencyMs?: number }
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.get(modelId);
    const nextSuccessRate =
      existing.rollingSuccessRate * (1 - EMA_ALPHA) +
      (result.success ? 1 : 0) * EMA_ALPHA;
    const latencyMs = result.latencyMs ?? existing.rollingLatencyMs;
    const nextLatency =
      latencyMs === undefined
        ? existing.rollingLatencyMs
        : existing.rollingLatencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;

    this.db.run(
      `INSERT INTO model_health (
        model_id,
        cooldown_until,
        degraded_until,
        rate_limit_strikes,
        last_rate_limit_at,
        rolling_latency_ms,
        rolling_success_rate,
        updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         rolling_latency_ms = excluded.rolling_latency_ms,
         rolling_success_rate = excluded.rolling_success_rate,
         updated_at = excluded.updated_at`,
      modelId,
      existing.cooldownUntil ?? 0,
      existing.degradedUntil ?? 0,
      existing.rateLimitStrikes ?? 0,
      existing.lastRateLimitAt ?? 0,
      nextLatency ?? 0,
      nextSuccessRate ?? 1,
      now
    );
  }

  private ensureColumns(): void {
    const rows = this.db.query('PRAGMA table_info(model_health)').all() as {
      name: string;
    }[];
    const columns = new Set(rows.map((row) => row.name));
    const maybeAdd = (name: string, definition: string) => {
      if (!columns.has(name)) {
        this.db.run(`ALTER TABLE model_health ADD COLUMN ${name} ${definition}`);
      }
    };
    maybeAdd('rate_limit_strikes', 'INTEGER NOT NULL DEFAULT 0');
    maybeAdd('last_rate_limit_at', 'INTEGER NOT NULL DEFAULT 0');
    maybeAdd('rolling_latency_ms', 'REAL NOT NULL DEFAULT 0');
    maybeAdd('rolling_success_rate', 'REAL NOT NULL DEFAULT 1');
  }
}

export class HealthStoreMemory implements HealthStore {
  private store = new Map<string, ModelHealth>();

  async get(modelId: string): Promise<ModelHealth> {
    return this.store.get(modelId) ?? { ...DEFAULT_HEALTH };
  }

  async markRateLimited(
    modelId: string,
    cooldownMs: number,
    info?: { strikes?: number; lastRateLimitAt?: number }
  ): Promise<void> {
    const now = Date.now();
    const existing = this.store.get(modelId) ?? { ...DEFAULT_HEALTH };
    this.store.set(modelId, {
      cooldownUntil: now + cooldownMs,
      degradedUntil: existing.degradedUntil ?? 0,
      rateLimitStrikes: info?.strikes ?? existing.rateLimitStrikes ?? 0,
      lastRateLimitAt: info?.lastRateLimitAt ?? existing.lastRateLimitAt ?? 0,
      rollingLatencyMs: existing.rollingLatencyMs ?? 0,
      rollingSuccessRate: existing.rollingSuccessRate ?? 1,
    });
  }

  async markDegraded(modelId: string, degradeMs: number): Promise<void> {
    const now = Date.now();
    const existing = this.store.get(modelId) ?? { ...DEFAULT_HEALTH };
    this.store.set(modelId, {
      cooldownUntil: existing.cooldownUntil ?? 0,
      degradedUntil: now + degradeMs,
      rateLimitStrikes: existing.rateLimitStrikes ?? 0,
      lastRateLimitAt: existing.lastRateLimitAt ?? 0,
      rollingLatencyMs: existing.rollingLatencyMs ?? 0,
      rollingSuccessRate: existing.rollingSuccessRate ?? 1,
    });
  }

  async recordResult(
    modelId: string,
    result: { success: boolean; latencyMs?: number }
  ): Promise<void> {
    const existing = this.store.get(modelId) ?? { ...DEFAULT_HEALTH };
    const nextSuccessRate =
      existing.rollingSuccessRate * (1 - EMA_ALPHA) +
      (result.success ? 1 : 0) * EMA_ALPHA;
    const latencyMs = result.latencyMs ?? existing.rollingLatencyMs;
    const nextLatency =
      latencyMs === undefined
        ? existing.rollingLatencyMs
        : existing.rollingLatencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;

    this.store.set(modelId, {
      ...existing,
      rollingLatencyMs: nextLatency ?? 0,
      rollingSuccessRate: nextSuccessRate ?? 1,
    });
  }
}
