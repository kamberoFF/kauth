import config from "../config";

export type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * `JSON.stringify` drops `Error` objects to `{}` — their properties aren't
 * enumerable. Callers pass errors under an `error` field routinely, so this
 * unwraps them once here rather than making every call site remember to.
 */
function replacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * One JSON object per line on stdout, no logging library dependency: pino's
 * worker-thread transports are broken under Bun as of this writing, and its
 * synchronous fallback measures slower than plain `console.log` here anyway
 * — not worth the dependency for kauth's handful of call sites. Always
 * stdout, even for `error`: this is a fixed, greppable stream for log
 * aggregation, not a human staring at a terminal choosing which stream to
 * watch.
 */
function write(level: LogLevel, message: string, fields?: Fields) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.log_level]) {
    return;
  }

  console.log(
    JSON.stringify(
      { level, msg: message, time: new Date().toISOString(), ...fields },
      replacer,
    ),
  );
}

export const logger = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
