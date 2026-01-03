export function logInfo(message: string, meta?: Record<string, unknown>): void {
  if (process.env.LOG_SILENT === 'true') return;
  if (meta) {
    console.log(JSON.stringify({ level: 'info', message, ...meta }));
    return;
  }
  console.log(JSON.stringify({ level: 'info', message }));
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (process.env.LOG_SILENT === 'true') return;
  if (meta) {
    console.warn(JSON.stringify({ level: 'warn', message, ...meta }));
    return;
  }
  console.warn(JSON.stringify({ level: 'warn', message }));
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  if (process.env.LOG_SILENT === 'true') return;
  if (meta) {
    console.error(JSON.stringify({ level: 'error', message, ...meta }));
    return;
  }
  console.error(JSON.stringify({ level: 'error', message }));
}
