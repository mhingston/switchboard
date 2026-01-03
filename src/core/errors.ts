export class NoSuitableModelError extends Error {
  retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('No suitable model available');
    this.retryAfterMs = retryAfterMs;
  }
}
