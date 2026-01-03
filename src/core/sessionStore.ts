import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoutingAttempt, TaskType } from './types';

export type SessionRecord = {
  requestId: string;
  taskType: TaskType;
  status: 'pending' | 'complete';
  responseText?: string;
  selectedModelId?: string;
  attempts: RoutingAttempt[];
  createdAt: number;
  updatedAt: number;
};

export interface SessionStore {
  get(requestId: string): Promise<SessionRecord | null>;
  recordAttempt(requestId: string, taskType: TaskType, attempt: RoutingAttempt): Promise<void>;
  recordResult(
    requestId: string,
    taskType: TaskType,
    modelId: string,
    responseText: string
  ): Promise<void>;
}

export class SessionStoreSqlite implements SessionStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS request_sessions (
        request_id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        response_text TEXT,
        selected_model_id TEXT,
        attempts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
  }

  async get(requestId: string): Promise<SessionRecord | null> {
    const row = this.db
      .query(
        `SELECT
          request_id AS requestId,
          task_type AS taskType,
          status,
          response_text AS responseText,
          selected_model_id AS selectedModelId,
          attempts_json AS attemptsJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM request_sessions WHERE request_id = ?`
      )
      .get(requestId) as
      | (Omit<SessionRecord, 'attempts'> & { attemptsJson?: string })
      | undefined;

    if (!row) return null;

    return {
      requestId: row.requestId,
      taskType: row.taskType,
      status: row.status as SessionRecord['status'],
      responseText: row.responseText ?? undefined,
      selectedModelId: row.selectedModelId ?? undefined,
      attempts: row.attemptsJson ? (JSON.parse(row.attemptsJson) as RoutingAttempt[]) : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async recordAttempt(
    requestId: string,
    taskType: TaskType,
    attempt: RoutingAttempt
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.get(requestId);
    const attempts = existing?.attempts ?? [];
    attempts.push(attempt);
    const status = existing?.status ?? 'pending';

    this.db.run(
      `INSERT INTO request_sessions (
        request_id,
        task_type,
        status,
        response_text,
        selected_model_id,
        attempts_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        task_type = excluded.task_type,
        status = excluded.status,
        response_text = excluded.response_text,
        selected_model_id = excluded.selected_model_id,
        attempts_json = excluded.attempts_json,
        updated_at = excluded.updated_at`,
      requestId,
      taskType,
      status,
      existing?.responseText ?? null,
      existing?.selectedModelId ?? null,
      JSON.stringify(attempts),
      existing?.createdAt ?? now,
      now
    );
  }

  async recordResult(
    requestId: string,
    taskType: TaskType,
    modelId: string,
    responseText: string
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.get(requestId);
    const attempts = existing?.attempts ?? [];

    this.db.run(
      `INSERT INTO request_sessions (
        request_id,
        task_type,
        status,
        response_text,
        selected_model_id,
        attempts_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        task_type = excluded.task_type,
        status = excluded.status,
        response_text = excluded.response_text,
        selected_model_id = excluded.selected_model_id,
        attempts_json = excluded.attempts_json,
        updated_at = excluded.updated_at`,
      requestId,
      taskType,
      'complete',
      responseText,
      modelId,
      JSON.stringify(attempts),
      existing?.createdAt ?? now,
      now
    );
  }
}

export class SessionStoreMemory implements SessionStore {
  private store = new Map<string, SessionRecord>();

  async get(requestId: string): Promise<SessionRecord | null> {
    return this.store.get(requestId) ?? null;
  }

  async recordAttempt(
    requestId: string,
    taskType: TaskType,
    attempt: RoutingAttempt
  ): Promise<void> {
    const existing = this.store.get(requestId);
    const attempts = existing?.attempts ?? [];
    attempts.push(attempt);
    const now = Date.now();
    this.store.set(requestId, {
      requestId,
      taskType,
      status: existing?.status ?? 'pending',
      responseText: existing?.responseText,
      selectedModelId: existing?.selectedModelId,
      attempts,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async recordResult(
    requestId: string,
    taskType: TaskType,
    modelId: string,
    responseText: string
  ): Promise<void> {
    const existing = this.store.get(requestId);
    const now = Date.now();
    this.store.set(requestId, {
      requestId,
      taskType,
      status: 'complete',
      responseText,
      selectedModelId: modelId,
      attempts: existing?.attempts ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}
