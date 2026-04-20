import type { RecallPorts } from "../../../core/ports.js";
import type { RecallEvalSandboxContext } from "./ports.js";

/**
 * Wraps the recall ports with a telemetry-write gate so snapshot-copy
 * replays stay read-only-like at the telemetry layer unless the caller
 * explicitly opted in via `allowTelemetryWrites`.
 *
 * Fixture-only sandboxes return the unwrapped ports so the historical
 * behavior of letting normal telemetry run against the isolated
 * database is preserved. The shared helper is used by both the recall
 * eval runner and the before-turn eval runner so snapshot replays keep
 * identical telemetry semantics across both seams.
 *
 * @param ports - Recall ports produced by the sandbox.
 * @param sandbox - Sandbox context used to detect snapshot mode.
 * @returns Gated recall ports for snapshot replays, original ports otherwise.
 */
export function applyTelemetryWriteGate(ports: RecallPorts, sandbox: RecallEvalSandboxContext): RecallPorts {
  const snapshot = sandbox.snapshot;
  if (snapshot === undefined || snapshot.allowedTelemetryWrites) {
    return ports;
  }

  return {
    async embed(text: string): Promise<number[]> {
      return ports.embed(text);
    },
    async vectorSearch(params) {
      return ports.vectorSearch(params);
    },
    async ftsSearch(params) {
      return ports.ftsSearch(params);
    },
    ...(ports.expandNeighborhood
      ? {
          async expandNeighborhood(request) {
            return ports.expandNeighborhood!(request);
          },
        }
      : {}),
    ...(ports.crossEncoder
      ? {
          crossEncoder: ports.crossEncoder,
        }
      : {}),
    async hydrateEntries(ids: string[]) {
      return ports.hydrateEntries(ids);
    },
    async recordRecallEvents(): Promise<void> {
      return undefined;
    },
  };
}
