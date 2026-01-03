# Implementation Plan: Transparent, Quality-Aware LLM Router

## Goals

1. **Transparent to client**: client calls `POST /v1/chat/completions` (or equivalent) and gets either:

   * a response meeting a quality threshold, or
   * a controlled wait (blocking) until a suitable model is available, or
   * a timeout with an explicit error.
2. **Rate-limit aware**: detect provider/model rate limits and set cooldowns.
3. **Quality-aware fallback**: only return outputs that pass quality gates; otherwise retry another model or wait.
4. **Policy-driven routing**: choose models based on task type, capability, context window needs, subscription budgets, and current health.
5. **Long-running safe**: support resumable requests with internal checkpoints for multi-step tasks (optional v1).

---

# 1) Architecture

### Services

* **router-api** (HTTP): exposes OpenAI-compatible endpoints (or your internal API)
* **router-core** (library): routing + health + eval logic
* **adapters** (library): provider integrations (OpenAI, Gemini, Perplexity, Copilot/0x, local Llama)
* **state store**: Redis (preferred) or SQLite/Postgres
* **observability**: logs + metrics (Prometheus), traces optional

### High-level flow

1. Client request hits `router-api`
2. `router-core` selects best candidate model(s) given policy + health + budget
3. Call provider adapter
4. Run internal eval(s)
5. If pass: return to client
6. If fail: mark model degraded, try next; if none meet minimum: wait/poll until one does or timeout

---

# 2) External API (transparent)

Implement an OpenAI-compatible subset:

### Endpoint

* `POST /v1/chat/completions` (required for `ai` SDK/OpenAI Chat Completions clients)
* `POST /v1/responses` (optional; for clients using the newer OpenAI Responses API) (done)

### Request extensions (optional, but recommended)

Allow optional headers/fields—client doesn’t need them, but power users can tune:

* `x-router-task-type`: `code|reasoning|research|rewrite|tooling`
* `x-router-quality-threshold`: `0..1` or `1..5`
* `x-router-max-wait-ms`: default e.g. 60000
* `x-router-allow-degrade`: boolean (default false)
* `x-router-request-id`: for idempotency
* `task_type` in JSON body can override (same values as header)

If absent, infer `task_type` from content heuristics.

### Response behavior

* Default is **blocking** up to `max_wait_ms`.
* If no acceptable model becomes available before timeout: return `503` with error:

  * `code: "no_suitable_model_available"`
  * include `retry_after_ms` suggestion

Streaming:

* Support both streaming and non-streaming.
* For v1: buffer the chosen model output for evaluation, then stream that buffered text to the client (preserves quality gating without a second provider call).
* Make stream chunk size and delay configurable in `policies.yaml` (done).
* If quality gating fails, do not stream; retry internally until a passing model is selected or timeout occurs.
* Add unit tests for streaming chunking and delay (done).

---

# 3) Data model

### 3.1 Model registry

Static config (YAML/JSON) checked into repo:

```yaml
models:
  - id: openai:gpt-5.2
    provider: openai
    capabilities: { code: 5, reasoning: 5, research: 5 }
    context_window: 128000
    cost_weight: 1.0
    reliability: 0.98
    enabled: true

  - id: local:llama-3
    provider: local
    capabilities: { code: 2, reasoning: 3, research: 2 }
    context_window: 16000
    cost_weight: 0.2
    reliability: 0.80
    enabled: true
```

### 3.2 Health state (stored in Redis)

Keyed by `(model_id)`:

```json
{
  "cooldown_until": 1735790000000,
  "last_error": "rate_limit",
  "error_count_5m": 3,
  "rolling_latency_ms": 1200,
  "rolling_success_rate": 0.93,
  "degraded_until": 1735790100000
}
```

### 3.3 Budget state (stored in Redis)

Keyed by `(provider)` and/or `(model_id)`:

```json
{
  "tokens_used_today": 123456,
  "requests_used_today": 234,
  "soft_limit_tokens": 500000,
  "hard_limit_tokens": 600000
}
```

### 3.4 Request session (optional v1)

If you support resumable long tasks:

```json
{
  "request_id": "...",
  "task_type": "code",
  "history": [...],
  "attempts": [
    {"model_id": "...", "quality": 0.62, "error": null}
  ],
  "checkpoint": {...},
  "created_at": ...
}
```

Implemented: request session persistence with resume-by-request-id (done).

---

# 4) Routing algorithm

## 4.1 Candidate filtering

Given `task_type`, request properties, and policy constraints:

* enabled models only
* `context_window >= required_context` (estimate tokens)
* `capability[task_type] >= min_capability` (policy-defined)
* not in cooldown (`now < cooldown_until`)

## 4.2 Scoring function

Compute a score for each candidate:

```
score = (capability_weight * capability_score(task_type))
      + (reliability_weight * rolling_success_rate)
      - (cost_weight * model.cost_weight)
      - (latency_weight * rolling_latency_ms_normalized)
      - (budget_penalty if near provider limits)
      - (degrade_penalty if degraded_until > now)
```

Implemented with rolling success rate and latency weighting (done).

Pick top K (e.g. 3) as an ordered fallback list.

## 4.3 Execution loop (transparent)

Pseudo:

1. Build ordered candidate list
2. For each candidate:

   * call adapter
   * if rate limit: set cooldown based on `Retry-After` or exponential backoff; continue
   * if transient error: small backoff; continue
   * run eval; if pass: return
   * if fail: mark `degraded_until = now + degrade_penalty_time`; continue
3. If none pass:

   * if within `max_wait_ms`: sleep `poll_interval` and retry from step 1
   * else timeout with 503

### Cooldown strategy

* If `Retry-After` present: cooldown that duration
* Else exponential: `base * 2^n` capped (e.g. 60s)
* Maintain per-model `rate_limit_strikes` in rolling window

Implemented exponential backoff + strike tracking (done).

### Degrade strategy

* If model output fails eval: `degraded_until = now + 30s` (tunable)
* If repeated failures: longer degrade window

---

# 5) Evaluation (quality gating)

You need **cheap, deterministic evals** first, then optional stronger checks.

## 5.1 Fast heuristics (always on)

Return a score 0..1.

* Minimum length / completeness check vs expected format
* For code tasks:

  * must include code blocks or patch format if requested
  * compile/lint if feasible (optional)
* Refusal / non-answer detection:

  * if response contains “I can’t” or irrelevant disclaimers, penalize
* Hallucination risk heuristic:

  * if includes many unverifiable specifics (URLs, numbers) without citations (for research tasks), penalize

## 5.2 Task-specific executable eval (recommended for coding)

If the task is code and you have a repo/workspace:

* apply patch to a temp working tree
* run unit tests / build
* scoring:

  * tests pass => +0.6
  * build passes => +0.3
  * lint ok => +0.1
    This is the most reliable “quality gate”.

## 5.3 Cross-model critique (optional, high-signal)

Only when needed:

* If primary is unavailable and fallback is weak, you can ask a stronger evaluator model to rate the candidate output.
* But this might be impossible if the strong model is rate limited—so treat as best-effort.

Optional judge-based scoring implemented (configurable, default disabled) (done).

## 5.4 Policy thresholds

Define thresholds by task type:

```yaml
quality_thresholds:
  code: 0.75
  reasoning: 0.70
  research: 0.65
  rewrite: 0.60
```

If `allow_degrade=false` and no candidate reaches threshold → wait.

---

# 6) Provider adapters

Create a common interface:

```ts
interface ProviderAdapter {
  id: string
  chatCompletions(req: NormalizedRequest): Promise<NormalizedResponse>
  supports: { streaming: boolean, tools: boolean, images: boolean }
}
```

### NormalizedRequest

* messages
* temperature/top_p
* max_tokens
* tool schema (optional)
* metadata (task_type, request_id)

### NormalizedResponse

* text
* tool_calls
* usage (input_tokens, output_tokens)
* raw provider response (for debugging, not returned)

### Error normalization

Adapters must map provider errors into:

* `RATE_LIMIT` (with optional retry_after_ms)
* `QUOTA_EXCEEDED`
* `TRANSIENT` (timeouts, 5xx)
* `PERMANENT` (invalid request)

---

# 7) State store and concurrency

Use embedded SQLite as the default for v1; Redis can be added later for multi-instance.

* model health keys
* provider budgets
* per-request sessions (optional)

Concurrency issues:

* multiple router instances will update cooldown/health concurrently
* use atomic operations:

  * Redis `SET` with TTL
  * `HINCRBY` for strike counters
  * Lua script if needed for “compare-and-set cooldown_until”

Single-instance deployment: Redis and multi-instance coordination are deferred (not needed for v1).

---

# 8) Configuration & policies

Ship a `policies.yaml`:

* candidate sets by task type (ordered preferences)
* min capability per task type
* thresholds
* max attempts before waiting
* max_wait_ms defaults
* per-provider budgets

Example:

```yaml
routing:
  code:
    preferred_models:
      - openai:gpt-5.2
      - google:gemini-pro
      - github:copilot-0x
      - local:llama-3
    min_capability: 3
    quality_threshold: 0.75
    max_attempts_per_cycle: 3
    poll_interval_ms: 2000
    max_wait_ms: 60000
```

---

# 9) Observability

### Logs (structured JSON)

* request_id
* chosen model sequence
* eval scores
* cooldown events
* time waited
* final outcome

Implemented structured routing logs with attempts + outcomes (done).

### Metrics

* `router_requests_total{status}`
* `model_calls_total{model_id, outcome}`
* `model_cooldown_seconds{model_id}`
* `eval_score_histogram{task_type, model_id}`
* `wait_time_ms_histogram{task_type}`
* Implement `/metrics` endpoint and in-memory counters/histograms (done)

---

# 10) Acceptance tests

Implement end-to-end tests with mock adapters:

1. **Rate limit failover**

   * primary returns RATE_LIMIT with Retry-After=10s
   * fallback returns good output
   * router returns fallback output; primary cooldown set (done)

2. **Quality gating**

   * fallback returns output that scores < threshold
   * router does not return it; tries next
   * if none: waits until primary available; returns primary (done)

3. **Transparent behavior**

   * client sees only final acceptable output
   * no provider/model info leaked unless debug mode enabled (done)

4. **Budget constraints**

   * provider near hard limit → router avoids it even if available
   * (done)

5. **Timeout behavior**

   * all models below threshold, max_wait_ms exceeded
   * returns 503 with `retry_after_ms` (done)

---

# 11) Implementation steps (ordered)

## Phase 0 (scaffolding)

* Repo structure: `router-api/`, `router-core/`, `adapters/`, `configs/`, `tests/`
* Runtime: Bun + `ai` SDK

## Phase 1 (routing without eval)

* Implement:

  * model registry load
  * health store (cooldown + strikes) (done)
  * adapter interface + at least 2 adapters (done)
  * scoring and selection (done)
  * rate-limit interception and cooldown setting (done)

## Phase 2 (quality gating)

* Implement fast heuristics evaluator (done)
* Integrate gating into execution loop (done)
* Implement degraded_until tracking (done)

## Phase 3 (waiting/pause)

* Implement poll loop respecting max_wait_ms (done)
* Implement 503 timeout error response (done)

## Phase 4 (budgets)

* Implement provider budget tracking and score penalties (done)
* Add config knobs (done)

## Phase 5 (coding-specific executable eval) — optional but recommended

* Patch apply + run tests in sandbox (done: configurable command, optional)
* Integrate scores into evaluator (done)

## Phase 6 (streaming) — optional

* Implement buffered streaming from evaluated text (done)

---

# 12) Notes / edge cases

* **Avoid infinite loops**: cap attempts per cycle + cap total wait time
* **Avoid burning tokens on eval**: keep heuristics cheap; only run heavy eval when needed
* **Tool calls**: if your agent uses tools, include tool-calling support in normalized schema and eval
  * (done)
* **Context overflow**: fallback models with smaller context require message trimming/summarization (done: trimming oldest non-system messages)
* **Debug mode**: optionally allow returning routing metadata behind an auth’d header
* Add `/health` and `/admin/reload` endpoints (done)
* Add debug metadata via `x-router-debug` header (done)

---

Great — Node/Bun + Vercel `ai` SDK is a nice fit because you can make the router **look like a normal OpenAI-compatible endpoint**, and all clients keep using `ai` unchanged (just swap `baseURL` / `apiKey`).

Below is a **Codex handoff plan** tailored to:

* Bun runtime
* `ai` SDK + provider libraries
* Transparent routing + quality gating + “wait instead of returning crap”

---

# 0) Key decision: where the transparency lives

### ✅ Best option: run a router HTTP service that is OpenAI-compatible

* Clients continue using `ai` SDK (or OpenAI SDK) pointing at your router.
* The router internally calls real providers via `ai` provider libs.
* The router never returns low-quality outputs; it retries/falls back/waits.

**Client change:** only `baseURL` (and apiKey) changes. No new logic.

---

# 1) Repo layout (Bun)

```
llm-router/
  src/
    server.ts
    routes/
      chatCompletions.ts
    core/
      router.ts
      policy.ts
      registry.ts
      scoring.ts
      healthStore.ts
      budgetStore.ts
      evaluator/
        index.ts
        heuristics.ts
        codeEval.ts (optional)
    adapters/
      aiProviderAdapter.ts
      errors.ts
      types.ts
    util/
      tokens.ts
      sleep.ts
      logger.ts
  config/
    models.yaml
    policies.yaml
  tests/
    e2e/
      rateLimitFailover.test.ts
      qualityGatingWait.test.ts
    unit/
      scoring.test.ts
  package.json
  bunfig.toml
```

---

# 2) External API: OpenAI-compatible `POST /v1/chat/completions`

Implement the OpenAI endpoint shape that `ai` SDK can hit.

### Request (supported subset)

* `model` is **ignored** or treated as “hint”
* `messages`, `temperature`, `top_p`, `max_tokens`, `stream` (optional)
* You can support `tools` later; start with plain text.

### Response

Return a standard Chat Completions response with:

* `choices[0].message.content`
* `usage`

### Timeout / waiting behavior

* Default `max_wait_ms` (e.g. 60s)
* If only low-quality models are available, **wait internally**
* If time runs out: return `503`:

  ```json
  { "error": { "code":"no_suitable_model_available", "retry_after_ms": 10000 } }
  ```

---

# 3) Model registry + policy config

## `config/models.yaml`

Define what exists + what it’s good at (capability scores are your “prior”).

```yaml
models:
  - id: openai:gpt-5.2
    provider: openai
    aiProvider: openai
    name: gpt-5.2
    context: 128000
    capabilities: { code: 5, reasoning: 5, research: 5, rewrite: 5 }
    costWeight: 1.0
    enabled: true

  - id: google:gemini-2.5
    provider: google
    aiProvider: google
    name: gemini-2.5-pro
    context: 100000
    capabilities: { code: 4, reasoning: 4, research: 5, rewrite: 4 }
    costWeight: 0.9
    enabled: true

  - id: local:llama3
    provider: local
    aiProvider: ollama
    name: llama3
    context: 16000
    capabilities: { code: 2, reasoning: 3, research: 2, rewrite: 3 }
    costWeight: 0.2
    enabled: true
```

## `config/policies.yaml`

Routing preferences + minimum acceptable quality per task type.

```yaml
routing:
  default:
    preferred:
      - openai:gpt-5.2
      - google:gemini-2.5
      - github:copilot-0x
      - local:llama3
    minCapability: 3
    qualityThreshold: 0.72
    maxAttemptsPerCycle: 3
    pollIntervalMs: 2000
    maxWaitMs: 60000

  code:
    preferred:
      - openai:gpt-5.2
      - google:gemini-2.5
      - github:copilot-0x
      - local:llama3
    minCapability: 4
    qualityThreshold: 0.78
```

---

# 4) Internals: Router core loop (transparent)

## Types

```ts
export type TaskType = 'code'|'reasoning'|'research'|'rewrite'|'default';

export type NormalizedRequest = {
  messages: { role: 'system'|'user'|'assistant'; content: string }[];
  taskType: TaskType;
  qualityThreshold: number;
  maxWaitMs: number;
  attemptBudget: number;
  requestId: string;
};

export type CandidateModel = {
  id: string;
  provider: string;
  name: string;          // provider model name
  context: number;
  capabilities: Record<TaskType, number>;
  costWeight: number;
};
```

## Router algorithm (must implement)

Pseudo:

```ts
export async function route(req: NormalizedRequest): Promise<NormalizedResponse> {
  const start = Date.now();
  while (Date.now() - start < req.maxWaitMs) {
    const candidates = await getCandidates(req); // filter enabled + not cooled down + meets context/capability
    const ordered = await scoreAndSort(candidates, req);

    let attempts = 0;
    for (const model of ordered) {
      if (attempts++ >= req.attemptBudget) break;

      const res = await callModel(model, req).catch(err => normalizeAndHandle(err, model));
      if (!res) continue; // rate-limited/transient handled internally

      const q = await evaluate(res, req);
      await recordAttempt(req.requestId, model.id, q);

      if (q >= req.qualityThreshold) return res;

      // output “crap”: mark temporarily degraded so we don’t keep hitting it
      await healthStore.markDegraded(model.id, /*ms*/ 30000);
    }

    // no acceptable output this cycle -> wait and retry from top
    await sleep(policy.pollIntervalMs);
  }

  throw new NoSuitableModelError({ retryAfterMs: 10_000 });
}
```

Important: **client never sees low-quality outputs** because you only return on `q >= threshold`.

---

# 5) Health store: cooldown + degraded windows

Use embedded SQLite as the default for v1. Redis is easiest for multi-instance if/when you scale.

## Keys per model

* `cooldown_until` (rate limit)
* `degraded_until` (quality fail)
* rolling strike counters

Interface:

```ts
export interface HealthStore {
  get(modelId: string): Promise<{ cooldownUntil: number; degradedUntil: number }>;
  markRateLimited(modelId: string, cooldownMs: number): Promise<void>;
  markDegraded(modelId: string, degradeMs: number): Promise<void>;
}
```

Cooldown ms:

* if upstream returns `Retry-After`: use it
* else exponential backoff per-model

---

# 6) Adapters using `ai` SDK (important implementation detail)

You’ll be using the `ai` provider libraries internally to talk to upstream models. Codex should implement an adapter that wraps `generateText` and normalizes errors.

### Adapter function

```ts
import { generateText } from 'ai';
// import { openai } from '@ai-sdk/openai';
// import { google } from '@ai-sdk/google';
// import etc

export async function callModel(model: CandidateModel, req: NormalizedRequest) {
  const providerModel = providerFor(model); // returns something like openai(model.name)

  const result = await generateText({
    model: providerModel,
    messages: req.messages,
    temperature: /* from client */,
    maxTokens: /* from client */,
  });

  return normalizeResponse(result);
}
```

### Error normalization

Codex must map any provider error into:

* RATE_LIMIT (429, resource exhausted, etc)
* QUOTA
* TRANSIENT
* PERMANENT

And extract `Retry-After` if available.

---

# 7) Evaluation (quality gate) that works in practice

You need something cheap and reliable. Don’t overcomplicate v1.

## 7.1 Heuristic evaluator (always on)

Return `score 0..1` from:

* completeness: length threshold, contains “final answer” signal if required
* refusal detection: phrases like “I can’t help” -> heavy penalty
* task-shape checks:

  * for `code`: must include code block or diff if asked; penalize if vague
  * for `research`: must cite sources if the prompt expects them (optional)

Implement:

```ts
export function heuristicScore(text: string, taskType: TaskType): number;
```

## 7.2 Optional “executable” code eval (high signal)

If your tasks involve codebases:

* apply patch to temp dir
* run `bun test` or `npm test`
* incorporate results into score

This is optional but extremely effective.

## 7.3 Optional cross-model critique (defer)

You can add later:

* ask a “judge” model to rate the output
  But it may be unavailable when you need it (rate limited), so don’t depend on it.

---

# 8) Intelligent routing with subscription limits

Implement budget tracking per provider:

* tokens/day, requests/day (soft/hard limits)
* penalize models near soft limit; exclude at hard limit

Budget store interface:

```ts
export interface BudgetStore {
  get(provider: string): Promise<{ usedTokens: number; soft: number; hard: number }>;
  record(provider: string, tokens: number): Promise<void>;
}
```

Scoring penalty:

* if `used/soft > 0.9` apply negative weight
* if `used >= hard` exclude provider

---

# 9) Task type inference (so clients don’t need to tell you)

Implement a simple classifier:

* if prompt contains code fences, filenames, stack traces, “implement”, “refactor” → `code`
* if “summarize”, “rewrite”, “tone” → `rewrite`
* if “find sources”, “latest”, “compare” → `research`
* else `reasoning/default`

Allow override via header `x-router-task-type` for power users.

---

# 10) Server implementation (Bun)

Use Hono or Fastify (Hono is clean on Bun).

`src/server.ts`:

* parse request JSON
* normalize to `NormalizedRequest`
* call `route()`
* format OpenAI response JSON

Streaming: implement in v1, only for the final chosen model. If a candidate fails quality gating, do not stream; retry internally.

---

# 11) Testing plan (Codex should implement)

Mock adapters with deterministic behavior.

### E2E: rate limit failover

* primary -> throws RATE_LIMIT w/ retry-after 10s
* fallback -> returns high score
* expect router returns fallback and sets cooldown key for primary

### E2E: quality gating wait

* only available models return low heuristic scores (< threshold)
* then after a simulated cooldown expiry, primary becomes available and returns good
* expect router waits and returns good

### E2E: timeout

* no suitable model for entire maxWaitMs
* expect 503 error with retry_after_ms

---

# 12) Implementation checklist for Codex (do this in order)

1. Scaffold server + endpoint `/v1/chat/completions`
2. Load `models.yaml` + `policies.yaml`
3. Implement `HealthStore` (Redis or in-memory for tests)
4. Implement `BudgetStore` (optional for v1 but recommended)
5. Implement `scoreAndSort()` with policy + health + budget
6. Implement `aiProviderAdapter` that calls `generateText()`
7. Implement error normalization + cooldown marking
8. Implement `heuristicScore()` evaluator and quality gating
9. Implement wait loop + timeout behavior
10. Add tests + fixtures
11. Add structured logging + metrics counters

---

# 13) What to explicitly NOT do in v1 (avoid rabbit holes)

* Full OpenAI streaming compatibility (unless you must)
* Tool calling / function calling (add later)
* Fancy LLM-based judging (add later)
* Context summarization/trimming (add later; v1 can reject if too long)

---

## Small note: “gpt-5.2” naming

Your router should treat model names as **opaque config strings**. You can call it `gpt-5.2` in config and map to the actual provider model identifier in `providerFor()`.

---

Lets use **embedded SQLite** as the default for health/budget state
