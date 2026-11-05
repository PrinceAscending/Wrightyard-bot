export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /token|secret|signature|authorization|cookie/i;

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : value;
  }
  return clean;
}

function stringify(fields: LogFields): string {
  try {
    return JSON.stringify(redact(fields), (_key, value: unknown) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });
  } catch {
    return '{"log":"fields could not be serialized"}';
  }
}

export class Logger {
  private readonly threshold: number;

  public constructor(private readonly scope = "bot") {
    this.threshold = process.env.NODE_ENV === "production" ? LEVEL_RANK.info : LEVEL_RANK.debug;
  }

  public child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  public debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < this.threshold) {
      return;
    }

    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}`;
    const suffix = Object.keys(fields).length > 0 ? ` ${stringify(fields)}` : "";

    if (level === "error") {
      console.error(`${line}${suffix}`);
    } else if (level === "warn") {
      console.warn(`${line}${suffix}`);
    } else {
      console.log(`${line}${suffix}`);
    }
  }
}

export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) {
      fields.stack = error.stack;
    }

    const candidate = error as Error & { code?: unknown; status?: unknown };
    if (typeof candidate.code === "string" || typeof candidate.code === "number") {
      fields.code = candidate.code;
    }
    if (typeof candidate.status === "number") {
      fields.status = candidate.status;
    }
    return fields;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return { message: "Unknown error" };
}
