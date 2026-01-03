export type CodeEvaluationConfig = {
  enabled: boolean;
  command: string;
  timeoutMs: number;
  weight: number;
  failurePenalty: number;
  cwd?: string;
};

export type CodeEvalResult = {
  score: number;
  passed: boolean;
  durationMs: number;
};

export async function runCodeEvaluation(
  config: CodeEvaluationConfig
): Promise<CodeEvalResult> {
  const start = Date.now();
  const command = config.command.trim();
  if (!command) {
    return { score: 0, passed: false, durationMs: 0 };
  }

  const shell = process.env.SHELL ?? 'sh';
  const proc = Bun.spawn({
    cmd: [shell, '-c', command],
    cwd: config.cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore kill failures
    }
  }, config.timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const durationMs = Date.now() - start;
  const passed = exitCode === 0;
  return {
    score: passed ? 1 : 0,
    passed,
    durationMs,
  };
}
