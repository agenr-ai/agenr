import type { AgenrWorkAction } from "./constants.js";
import { createWorkingContextFullProjection } from "./projection-render.js";
import type { WorkingSetRecord } from "./records.js";

/**
 * Non-persistent projection returned to host adapters for model-visible context.
 */
export interface WorkingContextProjection {
  /** Projection discriminator used by host adapters. */
  kind: "working_set";
  /** Rendering depth selected by agenr. */
  renderMode: "stub" | "full";
  /** Fully rendered context block or conservative stub. */
  content: string;
  /** Working set that produced the projection when one was selected. */
  workingSetId?: string;
  /** Snapshot revision represented by the projection. */
  revision?: number;
  /** Stable provenance pointer for audits and debugging. */
  sourceRef: string;
  /** UTF-8 byte length of `content`. */
  byteLength: number;
}

/**
 * Compact audit pointer a host may persist outside replay text.
 */
export interface WorkingContextAuditPointer {
  /** Pointer source discriminator. */
  source: "agenr_work";
  /** Working set that produced the rendered projection. */
  workingSetId: string;
  /** Snapshot revision represented by the projection. */
  revision: number;
  /** Stable provenance pointer for audits and debugging. */
  sourceRef: string;
  /** UTF-8 byte length of the rendered projection. */
  bytes: number;
  /** Optional compact summary safe for audit views. */
  summary?: string;
}

/**
 * Builds a full projection for successful `agenr_work` tool responses.
 *
 * @param workingSet - Working set returned by the mutation.
 * @param action - Tool action that produced the projection.
 * @param timestamp - ISO timestamp used in the provenance pointer.
 * @returns Rendered transient working-context projection.
 */
export function createToolSuccessProjection(
  workingSet: WorkingSetRecord,
  action: Extract<AgenrWorkAction, "get" | "create" | "update">,
  timestamp: string,
): WorkingContextProjection {
  return createWorkingContextFullProjection(workingSet, `agenr_work:${action}:${timestamp}`);
}

/**
 * Returns whether one projection should be injected into model context.
 *
 * @param projection - Rendered working-context projection.
 * @returns True when a full active-set projection should be injected.
 */
export function shouldInjectWorkingContext(projection: WorkingContextProjection): boolean {
  return projection.renderMode === "full" && projection.content.trim().length > 0;
}

/**
 * Builds a compact audit pointer from one rendered projection.
 *
 * @param projection - Rendered working-context projection.
 * @returns Audit pointer when provenance is complete, otherwise undefined.
 */
export function toWorkingContextAuditPointer(projection: WorkingContextProjection): WorkingContextAuditPointer | undefined {
  if (projection.workingSetId === undefined || projection.revision === undefined) {
    return undefined;
  }

  return {
    source: "agenr_work",
    workingSetId: projection.workingSetId,
    revision: projection.revision,
    sourceRef: projection.sourceRef,
    bytes: projection.byteLength,
    summary:
      projection.renderMode === "full" ? `Working set ${projection.workingSetId} rev ${projection.revision}` : `Working memory stub (${projection.sourceRef})`,
  };
}
