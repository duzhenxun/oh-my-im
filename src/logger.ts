type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const minLevel = parseLevel(process.env.LOG_LEVEL);

  function emit(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const prefix = `[${new Date().toISOString()}] [${scope}] [${level.toUpperCase()}]`;
    const line = `${prefix} ${message}`;
    if (level === "error") console.error(line, ...args);
    else if (level === "warn") console.warn(line, ...args);
    else console.log(line, ...args);
  }

  return {
    debug: (message, ...args) => emit("debug", message, ...args),
    info: (message, ...args) => emit("info", message, ...args),
    warn: (message, ...args) => emit("warn", message, ...args),
    error: (message, ...args) => emit("error", message, ...args),
  };
}

