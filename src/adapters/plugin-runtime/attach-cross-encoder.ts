import type { CrossEncoderPort, RecallPorts } from "../../core/ports.js";

/**
 * Merges an optional cross-encoder port into recall ports.
 *
 * Returns the ports unchanged when no port is supplied so existing
 * behavior (and the `not_configured` trace) is preserved. Uses explicit
 * method delegation because recall adapters can return class instances and
 * spreading would drop prototype-bound methods.
 *
 * @param ports - Recall ports produced by the runtime factory.
 * @param crossEncoder - Optional cross-encoder port resolved at startup.
 * @returns Recall ports with the cross-encoder merged in, or the originals when omitted.
 */
export function attachCrossEncoderPort(ports: RecallPorts, crossEncoder: CrossEncoderPort | undefined): RecallPorts {
  if (!crossEncoder) {
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
    crossEncoder,
    async hydrateDurables(ids: string[]) {
      return ports.hydrateDurables(ids);
    },
    async recordRecallEvents(params) {
      return ports.recordRecallEvents(params);
    },
  };
}
