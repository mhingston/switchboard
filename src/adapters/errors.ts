export type AdapterErrorType =
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'TRANSIENT'
  | 'PERMANENT';

export class AdapterError extends Error {
  type: AdapterErrorType;
  retryAfterMs?: number;

  constructor(type: AdapterErrorType, message: string, retryAfterMs?: number) {
    super(message);
    this.type = type;
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeAdapterError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;

  const anyErr = error as { status?: number; statusCode?: number; message?: string; headers?: Record<string, string> };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const message = anyErr?.message ?? 'Provider error';
  const normalizedMessage = message.toLowerCase();

  const retryAfterHeader = anyErr?.headers?.['retry-after'];
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

  if (
    normalizedMessage.includes('context length') ||
    normalizedMessage.includes('context window') ||
    normalizedMessage.includes('maximum context') ||
    normalizedMessage.includes('max context') ||
    normalizedMessage.includes('token limit') ||
    normalizedMessage.includes('too many tokens') ||
    normalizedMessage.includes('prompt too long') ||
    normalizedMessage.includes('input is too long')
  ) {
    return new AdapterError('PERMANENT', 'context_length_exceeded');
  }

  if (status === 429) {
    return new AdapterError('RATE_LIMIT', message, retryAfterMs);
  }

  if (status === 402) {
    return new AdapterError('QUOTA_EXCEEDED', message);
  }

  if (status && status >= 500) {
    return new AdapterError('TRANSIENT', message);
  }

  return new AdapterError('PERMANENT', message);
}
