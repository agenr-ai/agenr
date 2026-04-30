import type { MemoryRepository } from "../../app/memory/ports.js";
import type { DatabasePort, EpisodeDatabasePort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";

/**
 * Configuration accepted by the Skeln memory provider factory.
 */
export interface AgenrSkelnMemoryProviderOptions {
  /** Optional path to an agenr config file. */
  configPath?: string;
  /** Optional database path override. */
  databasePath?: string;
  /** Optional tool enablement switches. */
  tools?: {
    /** Enables the recall tool. Defaults to true. */
    recall?: boolean;
    /** Enables the update tool. Defaults to true. */
    update?: boolean;
  };
  /** Optional host logger. */
  logger?: AgenrSkelnLogger;
}

/**
 * Minimal logger shape accepted from Skeln or another host.
 */
export interface AgenrSkelnLogger {
  /** Emits debug-level diagnostics. */
  debug?(message: string, meta?: unknown): void;
  /** Emits info-level diagnostics. */
  info?(message: string, meta?: unknown): void;
  /** Emits warning-level diagnostics. */
  warn?(message: string, meta?: unknown): void;
  /** Emits error-level diagnostics. */
  error?(message: string, meta?: unknown): void;
}

/**
 * Structural memory provider shape consumed by Skeln.
 */
export interface SkelnMemoryProviderLike {
  /** Stable provider identifier. */
  id: "agenr";
  /** Human-readable provider label. */
  label: string;
  /** Runtime capabilities required by the provider. */
  requiredCapabilities?: string[];
  /** Builds optional session-start memory context. */
  buildSessionStartContext(context: SkelnMemoryContextLike): Promise<string | undefined>;
  /** Builds optional before-turn memory context. */
  buildBeforeTurnContext(context: SkelnMemoryContextLike): Promise<string | undefined>;
  /** Returns memory tools bound to the current tool context. */
  tools?(context: SkelnToolContextLike): SkelnToolLike[];
  /** Reports provider readiness. */
  status?(): Promise<SkelnProviderStatusLike>;
  /** Releases provider-owned resources. */
  dispose?(): void | Promise<void>;
}

/**
 * Structural provider status returned to Skeln.
 */
export interface SkelnProviderStatusLike {
  /** Current provider state. */
  state: "ready" | "disabled" | "error";
  /** Optional status detail. */
  message?: string;
}

/**
 * Structural memory context accepted by no-op hooks.
 */
export interface SkelnMemoryContextLike {
  /** Current Skeln session id. */
  sessionId?: string;
  /** Optional stable memory session key. */
  sessionKey?: string;
}

/**
 * Structural tool context used by the recall tool.
 */
export interface SkelnToolContextLike {
  /** Current Skeln session id. */
  sessionId?: string;
  /** Optional stable memory session key. */
  sessionKey?: string;
}

/**
 * JSON-schema-compatible tool parameter schema.
 */
export type SkelnToolParametersLike = Record<string, unknown>;

/**
 * Structural Skeln tool result content item.
 */
export interface SkelnToolTextContentLike {
  /** Content item discriminator. */
  type: "text";
  /** Text payload. */
  text: string;
}

/**
 * Structural Skeln-compatible tool result.
 */
export interface SkelnToolResultLike<TDetails = unknown> {
  /** Result content blocks. */
  content: SkelnToolTextContentLike[];
  /** Structured details for host renderers and tests. */
  details: TDetails;
}

/**
 * User-facing subject Skeln can display in approval requests.
 */
export interface SkelnApprovalTargetLike {
  /** Optional human-readable target or subject. */
  target?: string;
  /** Optional command-like action text. */
  command?: string;
}

/**
 * Extracts approval request metadata from untrusted tool arguments.
 */
export type SkelnApprovalTargetExtractorLike = (args: unknown) => SkelnApprovalTargetLike | undefined;

/**
 * Structural Skeln tool shape.
 */
export interface SkelnToolLike<TDetails = unknown> {
  /** Tool name. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Tool description. */
  description: string;
  /** Tool category. */
  category: string;
  /** Tool risk label. */
  risk: "read" | "write" | "destructive" | "external";
  /** Tool-provided default approval policy. Skeln config can override this. */
  approval: "never" | "manual" | "always";
  /**
   * Extracts the user-facing approval subject from tool args.
   *
   * Skeln needs this even when the final approval level is configured on the
   * Skeln side.
   */
  approvalTarget?: SkelnApprovalTargetExtractorLike;
  /** JSON-schema-compatible parameter contract. */
  parameters: SkelnToolParametersLike;
  /** Optional per-tool execution mode override. */
  executionMode?: "sequential" | "parallel";
  /** Executes the tool. */
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<SkelnToolResultLike<TDetails>>;
}

/**
 * Public embedding status surfaced by the Skeln runtime builder.
 */
export interface AgenrSkelnEmbeddingStatus {
  /** Whether query embeddings are configured. */
  available: boolean;
  /** Effective embedding provider label. */
  provider?: string;
  /** Requested provider label. */
  requestedProvider?: string;
  /** Effective embedding model. */
  model?: string;
  /** Human-readable configuration error when unavailable. */
  error?: string;
}

/**
 * Shared services owned by the Skeln provider instance.
 */
export interface AgenrSkelnServices {
  /** Resolved agenr database path. */
  dbPath: string;
  /** DB-backed entry write and direct lookup port. */
  entries: DatabasePort;
  /** DB-backed episode port. */
  episodes: EpisodeDatabasePort;
  /** DB-backed procedure port. */
  procedures: ProcedureDatabasePort;
  /** DB-backed memory read-model repository. */
  memory: MemoryRepository;
  /** DB-backed entry recall ports. */
  recall: RecallPorts;
  /** Embedding availability facts. */
  embeddingStatus: AgenrSkelnEmbeddingStatus;
  /** Query embedding helper used when embeddings are configured. */
  embedQuery?: (text: string) => Promise<number[]>;
  /** Closes underlying resources. */
  close(): Promise<void>;
}
