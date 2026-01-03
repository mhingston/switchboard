export type TaskType = 'code' | 'reasoning' | 'research' | 'rewrite' | 'default';

export type RouterRequest = {
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  taskType: TaskType;
  qualityThreshold: number;
  maxWaitMs: number;
  attemptBudget: number;
  requestId: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  allowDegrade?: boolean;
  resume?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
};

export type CandidateModel = {
  id: string;
  provider: string;
  aiProvider: string;
  name: string;
  context: number;
  capabilities: Record<string, number>;
  costWeight: number;
  enabled: boolean;
};

export type NormalizedResponse = {
  text: string;
  toolCalls?: unknown[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
};

export type RouteResult =
  | {
      type: 'text';
      response: NormalizedResponse;
      modelId: string;
      metadata?: RoutingMetadata;
    }
  | {
      type: 'stream';
      stream: AsyncIterable<string>;
      modelId: string;
      metadata?: RoutingMetadata;
    };

export type RoutingAttempt = {
  modelId: string;
  outcome: 'success' | 'eval_fail' | 'rate_limit' | 'transient' | 'quota' | 'permanent';
  score?: number;
};

export type RoutingMetadata = {
  attempts: RoutingAttempt[];
  selectedModelId?: string;
  taskType: TaskType;
};

export type AdapterGenerateParams = {
  model: CandidateModel;
  request: RouterRequest;
};

export type AdapterStreamParams = AdapterGenerateParams;

export type ProviderAdapter = {
  generate: (params: AdapterGenerateParams) => Promise<NormalizedResponse>;
  stream: (params: AdapterStreamParams) => Promise<AsyncIterable<string>>;
};

export type ModelHealth = {
  cooldownUntil: number;
  degradedUntil: number;
  rateLimitStrikes: number;
  lastRateLimitAt: number;
  rollingLatencyMs: number;
  rollingSuccessRate: number;
};

export type ProviderBudget = {
  usedTokens: number;
  softLimitTokens?: number;
  hardLimitTokens?: number;
};

export type RoutingPolicy = {
  preferred: string[];
  minCapability: number;
  qualityThreshold: number;
  maxAttemptsPerCycle: number;
  pollIntervalMs: number;
  maxWaitMs: number;
  weights?: {
    capability?: number;
    reliability?: number;
    cost?: number;
    latency?: number;
    degradePenalty?: number;
    budgetPenalty?: number;
  };
};

export type PoliciesConfig = {
  routing: Record<string, RoutingPolicy>;
  budgets?: {
    providers?: Record<
      string,
      { softLimitTokens?: number; hardLimitTokens?: number }
    >;
  };
  streaming?: {
    chunkSize?: number;
    chunkDelayMs?: number;
  };
  codeEvaluation?: {
    enabled: boolean;
    command: string;
    timeoutMs: number;
    weight: number;
    failurePenalty: number;
    cwd?: string;
  };
  evaluationJudge?: {
    enabled: boolean;
    modelId: string;
    prompt?: string;
    minScore?: number;
  };
};

export type ModelsConfig = {
  models: CandidateModel[];
};
