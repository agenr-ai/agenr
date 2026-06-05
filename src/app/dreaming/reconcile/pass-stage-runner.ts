import type { ReconcileProgressStage } from "../progress.js";
import type { ReconcilePassContext } from "./pass-context.js";
import { markAbortedIfSignalled } from "./helpers/effects.js";

/**
 * Options for one deterministic reconcile stage loop.
 */
export interface ReconcileStageOptions<T> {
  stage: ReconcileProgressStage;
  items: T[];
  unitLabel: "durables" | "groups";
  preview?: {
    items: T[];
    concurrency?: number;
  };
  preload?: (ctx: ReconcilePassContext, previewItems: T[]) => Promise<void>;
  process: (ctx: ReconcilePassContext, item: T) => Promise<void>;
  afterItem?: (ctx: ReconcilePassContext, item: T) => void;
}

/**
 * Runs one reconcile stage with shared abort, progress, and breaker handling.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param options - Stage metadata and per-item handler.
 */
export async function runReconcileStage<T>(ctx: ReconcilePassContext, options: ReconcileStageOptions<T>): Promise<void> {
  ctx.progressTracker.startStage(options.stage, options.items.length, options.unitLabel, {
    previewTotal: options.preview?.items.length ?? 0,
    previewConcurrency: options.preview?.concurrency,
  });

  if (options.preload && options.preview) {
    await options.preload(ctx, options.preview.items);
  }

  for (const item of options.items) {
    if (markAbortedIfSignalled(ctx)) {
      break;
    }

    await options.process(ctx, item);
    options.afterItem?.(ctx, item);
    ctx.progressTracker.advanceStage();

    if (ctx.telemetry.terminalStatus !== "completed" || ctx.telemetry.circuitBreaker) {
      break;
    }
  }
}

/**
 * Returns whether the pass can continue into another reconcile stage.
 *
 * @param ctx - Mutable reconcile pass context.
 * @returns True when no breaker trip or terminal status has stopped the pass.
 */
export function canContinueReconcilePass(ctx: ReconcilePassContext): boolean {
  return !ctx.telemetry.circuitBreaker && ctx.telemetry.terminalStatus === "completed";
}
