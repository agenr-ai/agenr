type LogLevel = "info" | "warn" | "error";

interface LogEntry extends Record<string, unknown> {
  level: LogLevel;
  event: string;
  timestamp: string;
}

function serializeLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    return value;
  });
}

function write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const message = serializeLogEntry(entry);

  if (level === "error") {
    console.error(message);
    return;
  }

  console.log(message);
}

export const logger = {
  info(event: string, data?: Record<string, unknown>): void {
    write("info", event, data);
  },
  warn(event: string, data?: Record<string, unknown>): void {
    write("warn", event, data);
  },
  error(event: string, data?: Record<string, unknown>): void {
    write("error", event, data);
  },
};
