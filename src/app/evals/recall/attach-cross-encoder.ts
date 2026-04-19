import type { CrossEncoderPort, RecallPorts } from "../../../core/ports.js";

/**
 * Merges an optional cross-encoder port into the recall ports returned
 * from the sandbox.
 *
 * Returns the ports unchanged when no port is supplied so existing
 * behavior (and the `not_configured` trace) is preserved. Uses explicit
 * method delegation because the sandbox returns a class instance and
 * spreading would drop the prototype-bound methods.
 *
 * Shared by the recall and before-turn eval runners so both flows
 * exercise phase-4 rerank through the same wiring seam.
 *
 * @param ports - Recall ports produced by the eval sandbox.
 * @param crossEncoder - Optional cross-encoder port resolved at server startup.
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
    async hydrateEntries(ids: string[]) {
      return ports.hydrateEntries(ids);
    },
    async recordRecallEvents(params) {
      return ports.recordRecallEvents(params);
    },
  };
}
