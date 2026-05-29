/**
 * Stable event detail levels accepted by OpenClaw plugin debug sinks.
 */
export type OpenClawPluginDebugEventLevel = "basic" | "detailed";

/**
 * Minimal debug sink contract composed into {@link AgenrOpenClawServices}.
 *
 * Adapter implementations may accept narrower event payloads than `unknown`.
 */
export interface OpenClawPluginDebugSink {
  /** Narrow feature flag exposed for adapter call sites. */
  readonly enabled: boolean;
  /** Resolved event-level the sink is configured to accept. */
  readonly eventLevel: OpenClawPluginDebugEventLevel;
  /** Resolved cap used when bounded candidate breakdowns are emitted. */
  readonly maxTopCandidates: number;
  /** Absolute log-file path when writable, otherwise `undefined`. */
  readonly logPath?: string;
  /**
   * Appends one structured debug event.
   *
   * @param event - Adapter-specific JSON-serializable event payload.
   */
  emit(event: unknown): Promise<void>;
  /** Flushes pending writes and prevents further emissions. */
  close(): Promise<void>;
}
