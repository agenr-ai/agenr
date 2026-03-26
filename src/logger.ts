/**
 * Structured logger with a stable agenr namespace prefix.
 */
export interface Logger {
  /**
   * Writes an informational log line.
   *
   * @param message - Message text to emit.
   */
  info(message: string): void;
  /**
   * Writes a warning log line.
   *
   * @param message - Message text to emit.
   */
  warn(message: string): void;
  /**
   * Writes an error log line.
   *
   * @param message - Message text to emit.
   */
  error(message: string): void;
  /**
   * Writes a debug log line when verbose logging is enabled.
   *
   * @param message - Message text to emit.
   */
  debug(message: string): void;
}

let verboseEnabled = false;

/** Enables or disables verbose debug logging globally. */
export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

/** Returns whether verbose debug logging is currently enabled. */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/**
 * Creates a logger for a specific agenr namespace.
 *
 * @param prefix - Namespace suffix to include in log output.
 * @returns Structured logger bound to the supplied namespace.
 */
export function createLogger(prefix: string): Logger {
  const normalizedPrefix = prefix.trim();
  const tag = normalizedPrefix.length > 0 ? `[agenr:${normalizedPrefix}]` : "[agenr]";

  return {
    info(message: string): void {
      writeLine(tag, message);
    },
    warn(message: string): void {
      writeLine(tag, message);
    },
    error(message: string): void {
      writeLine(tag, message);
    },
    debug(message: string): void {
      if (verboseEnabled) {
        writeLine(tag, message);
      }
    },
  };
}

function writeLine(tag: string, message: string): void {
  process.stderr.write(`${timestamp()} ${tag} ${message}\n`);
}

function timestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `[${hours}:${minutes}:${seconds}]`;
}
