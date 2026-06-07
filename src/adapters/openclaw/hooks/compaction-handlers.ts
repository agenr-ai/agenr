import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { scheduleGuardedEpisodeWrite } from "../../shared/pre-compaction-episode.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { writeOpenClawPreCompactionEpisode } from "../episode/episode-writer.js";
import { resolveCompactionPromptContext } from "../../shared/compaction-prompt-context.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { readLatestOpenClawCompactionEntry } from "../session/compaction-transcript.js";
import type { CompactionPromptTracker } from "../../shared/compaction-prompt-tracker.js";
import { resolveOpenClawSessionScope, type OpenClawSessionScopeContext } from "../session/scope.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices } from "../types.js";
import {
  buildOpenClawSessionBeforeCompactTriggerEvent,
  buildOpenClawSessionCompactTriggerEvent,
  type OpenClawAfterCompactionEvent,
  type OpenClawBeforeCompactionEvent,
} from "./session-memory.js";
import { routeOpenClawSessionMemoryTrigger } from "./session-memory-routing.js";

/**
 * Handles OpenClaw `before_compaction`: routes session-memory intake and
 * best-effort captures a pre-compaction episode from the full transcript snapshot.
 *
 * @param event - OpenClaw before-compaction payload.
 * @param ctx - Hook context with session identity fields.
 * @param params - Shared services, logger, and optional prompt tracker.
 */
export async function handleOpenClawBeforeCompaction(
  event: OpenClawBeforeCompactionEvent,
  ctx: OpenClawSessionScopeContext,
  params: {
    logger: PluginLogger;
    servicesPromise: Promise<AgenrOpenClawServices>;
  },
): Promise<void> {
  await routeOpenClawSessionMemoryTrigger(params.servicesPromise, ctx, (scope) => buildOpenClawSessionBeforeCompactTriggerEvent(scope, event));
  await scheduleOpenClawPreCompactionEpisodeWrite(event, ctx, params);
}

/**
 * Handles OpenClaw `after_compaction`: enriches intake with the real compaction
 * summary from the transcript and routes a checkpoint artifact.
 *
 * @param event - OpenClaw after-compaction payload.
 * @param ctx - Hook context with session identity fields.
 * @param params - Shared services and logger.
 */
export async function handleOpenClawAfterCompaction(
  event: OpenClawAfterCompactionEvent,
  ctx: OpenClawSessionScopeContext,
  params: {
    logger: PluginLogger;
    servicesPromise: Promise<AgenrOpenClawServices>;
  },
): Promise<void> {
  const compactionEntry = await readLatestOpenClawCompactionEntry(event.sessionFile);
  await routeOpenClawSessionMemoryTrigger(params.servicesPromise, ctx, (scope) => buildOpenClawSessionCompactTriggerEvent(scope, event, compactionEntry));
}

/**
 * Resolves compaction checkpoint context for prompt injection after compaction.
 *
 * @param ctx - Hook context with session identity fields.
 * @param services - Shared OpenClaw runtime services.
 * @param tracker - Per-process compaction prompt dedupe tracker.
 * @returns Markdown block for `prependContext`, or undefined when nothing should inject.
 */
export async function resolveOpenClawCompactionPromptContext(
  ctx: AgenrOpenClawHookContext,
  services: AgenrOpenClawServices,
  tracker: CompactionPromptTracker,
): Promise<string | undefined> {
  const scope = resolveOpenClawSessionScope(ctx);
  return resolveCompactionPromptContext({
    sessionId: ctx.sessionId,
    sessionKey: scope.sessionKey,
    features: services.agenrConfig.features,
    sessionMemoryRepository: services.sessionMemoryRepository,
    tracker,
  });
}

/** Schedules one bounded pre-compaction episode write when enabled and transcript path is known. */
async function scheduleOpenClawPreCompactionEpisodeWrite(
  event: OpenClawBeforeCompactionEvent,
  ctx: OpenClawSessionScopeContext,
  params: {
    logger: PluginLogger;
    servicesPromise: Promise<AgenrOpenClawServices>;
  },
): Promise<void> {
  const sessionFile = event.sessionFile?.trim();
  const sessionId = ctx.sessionId?.trim();
  if (!sessionFile || !sessionId) {
    return;
  }

  try {
    const services = await params.servicesPromise;
    if (!isPluginEpisodeWriteEnabled(services.pluginConfig.memoryPolicy)) {
      return;
    }

    const hookContext: AgenrOpenClawHookContext = {
      sessionId,
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    };

    void scheduleGuardedEpisodeWrite({
      dreaming: services.dreaming,
      dbPath: services.config.dbPath,
      write: async () =>
        writeOpenClawPreCompactionEpisode({
          ctx: hookContext,
          sessionId,
          sessionFile,
          messageCount: event.messageCount,
          services,
          logger: params.logger,
        }),
      onFailure: (error) => {
        params.logger.warn(`[agenr] pre-compaction episode write failed for ${formatSessionContext(sessionId, ctx.sessionKey)}: ${formatErrorMessage(error)}`);
      },
    });
  } catch (error) {
    params.logger.warn(`[agenr] pre-compaction episode write skipped: ${formatErrorMessage(error)}`);
  }
}
