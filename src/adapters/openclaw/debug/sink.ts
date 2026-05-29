import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { OpenClawPluginDebugSink } from "../../../app/openclaw/debug-sink.js";
import type { ResolvedAgenrOpenClawDebugConfig } from "../config.js";
import type { AgenrDebugEvent } from "./events.js";

/**
 * Adapter-owned JSONL debug sink used by live OpenClaw paths to emit
 * agenr-only structured events.
 *
 * The sink implementation is always present in the services bundle so
 * call sites never need to null-check. When debug logging is disabled,
 * the returned instance is a no-op.
 */
export interface AgenrDebugSink extends OpenClawPluginDebugSink {
  /** Narrow feature flag exposed for adapter call sites. */
  readonly enabled: boolean;
  /** Resolved event-level the sink is configured to accept. */
  readonly eventLevel: "basic" | "detailed";
  /** Resolved cap used when bounded candidate breakdowns are emitted. */
  readonly maxTopCandidates: number;
  /** Absolute log-file path when writable, otherwise `undefined`. */
  readonly logPath?: string;

  /**
   * Appends one structured JSONL event to the sink.
   *
   * Emission is fire-and-forget for most callers: the sink serializes
   * writes internally, so resolving the returned promise is only
   * needed for tests that assert on file contents.
   */
  emit(event: AgenrDebugEvent): Promise<void>;
  /** Flushes pending writes and prevents further emissions. */
  close(): Promise<void>;
}

/**
 * No-op sink returned when debug logging is disabled. Keeps call sites
 * free of conditional guards while guaranteeing zero filesystem work.
 */
const NOOP_SINK: AgenrDebugSink = {
  enabled: false,
  eventLevel: "basic",
  maxTopCandidates: 0,
  async emit(): Promise<void> {
    return;
  },
  async close(): Promise<void> {
    return;
  },
};

/**
 * Returns the shared no-op debug sink.
 *
 * @returns Sink instance that accepts events silently.
 */
export function createNoopAgenrDebugSink(): AgenrDebugSink {
  return NOOP_SINK;
}

/**
 * Builds a JSONL debug sink for the active runtime.
 *
 * The sink writes line-delimited JSON to the resolved `logPath` (or the
 * supplied default resolver). When `perSessionFiles` is enabled, the
 * sink appends a stable session suffix to the log-file basename.
 *
 * @param config - Resolved debug config including the log path.
 * @returns Active sink when enabled, otherwise a no-op.
 */
export function createAgenrDebugSink(config: ResolvedAgenrOpenClawDebugConfig): AgenrDebugSink {
  if (!config.enabled || !config.logPath) {
    return NOOP_SINK;
  }

  const basePath = config.logPath;
  const perSessionFiles = config.perSessionFiles;
  const eventLevel = config.eventLevel;
  const maxTopCandidates = config.maxTopCandidates;
  const directoriesEnsured = new Set<string>();
  let writeChain: Promise<void> = Promise.resolve();
  let closed = false;

  const ensureDirectoryOnce = async (filePath: string): Promise<void> => {
    const directory = path.dirname(filePath);
    if (directoriesEnsured.has(directory)) {
      return;
    }
    await mkdir(directory, { recursive: true });
    directoriesEnsured.add(directory);
  };

  const resolveFilePath = (event: AgenrDebugEvent): string => {
    if (!perSessionFiles) {
      return basePath;
    }

    const sessionSuffix = sanitizeSessionSuffix(event.sessionId) ?? sanitizeSessionSuffix(event.sessionKey);
    if (!sessionSuffix) {
      return basePath;
    }

    const directory = path.dirname(basePath);
    const extension = path.extname(basePath);
    const baseName = path.basename(basePath, extension);
    const suffixed = `${baseName}.${sessionSuffix}${extension || ".jsonl"}`;
    return path.join(directory, suffixed);
  };

  const writeLine = async (filePath: string, line: string): Promise<void> => {
    await ensureDirectoryOnce(filePath);
    await appendFile(filePath, `${line}\n`, "utf8");
  };

  return {
    enabled: true,
    eventLevel,
    maxTopCandidates,
    logPath: basePath,
    async emit(event: AgenrDebugEvent): Promise<void> {
      if (closed) {
        return;
      }

      const filePath = resolveFilePath(event);
      const line = formatEventLine(event);
      writeChain = writeChain.then(async () => {
        try {
          await writeLine(filePath, line);
        } catch {
          // Swallow write errors to keep the live runtime path resilient.
        }
      });
      await writeChain;
    },
    async close(): Promise<void> {
      closed = true;
      await writeChain;
    },
  };
}

/**
 * Serializes one debug event into the line format written to disk.
 *
 * The line prefixes a UTC timestamp and then spreads event fields into
 * the JSON payload. Unknown event fields are preserved as-is.
 *
 * @param event - Structured event supplied by the adapter.
 * @returns Single-line JSON payload.
 */
function formatEventLine(event: AgenrDebugEvent): string {
  const line = {
    ts: new Date().toISOString(),
    ...event,
  };
  return JSON.stringify(line);
}

/**
 * Converts an OpenClaw session identifier into a filesystem-safe suffix.
 *
 * @param value - Raw identifier supplied in the event payload.
 * @returns Sanitized suffix, or `undefined` when the id was unusable.
 */
function sanitizeSessionSuffix(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/gu, "_");
  if (sanitized.length === 0) {
    return undefined;
  }

  return sanitized.slice(0, 120);
}
