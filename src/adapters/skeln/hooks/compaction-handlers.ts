import type { ExtensionContext } from "../skeln-types.js";

import { scheduleGuardedEpisodeWrite } from "../../shared/pre-compaction-episode.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { resolveCompactionPromptContext } from "../../shared/compaction-prompt-context.js";
import type { CompactionPromptTracker } from "../../shared/compaction-prompt-tracker.js";
import { writeSkelnPreCompactionEpisode } from "../episode/episode-writer.js";
import { resolveSkelnSessionEpisodeTarget } from "../episode/bounded-session-episode.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { buildSkelnSessionBeforeCompactTriggerEvent, type SkelnSessionBeforeCompactEvent } from "./session-memory.js";
import { routeSkelnSessionMemoryTrigger } from "./session-memory-routing.js";

/**
 * Handles Skeln `session_before_compact`: routes session-memory intake and
 * best-effort captures a pre-compaction episode from the live transcript snapshot.
 *
 * @param event - Skeln before-compaction payload.
 * @param context - Active extension context with session branch access.
 * @param servicesPromise - Shared services promise for the plugin process.
 * @param resolveScope - Resolves the active Skeln session scope.
 */
export async function handleSkelnSessionBeforeCompact(
  event: SkelnSessionBeforeCompactEvent,
  context: ExtensionContext,
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): Promise<void> {
  await routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeCompactTriggerEvent(scope, event));
  await scheduleSkelnPreCompactionEpisodeWrite(event, context, servicesPromise);
}

/**
 * Resolves compaction checkpoint context for Skeln before-agent-start injection.
 *
 * @param scope - Resolved session scope.
 * @param services - Shared Skeln runtime services.
 * @param tracker - Per-process compaction prompt dedupe tracker.
 * @returns Markdown block for hidden user injection, or undefined when nothing should inject.
 */
export async function resolveSkelnCompactionPromptContext(
  scope: AgenrSkelnSessionScope,
  services: Awaited<ReturnType<typeof createAgenrSkelnServices>>,
  tracker: CompactionPromptTracker,
): Promise<string | undefined> {
  return resolveCompactionPromptContext({
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    features: {
      ...services.agenrConfig.features,
      ...services.skelnConfig.featureFlags,
    },
    sessionMemoryRepository: services.sessionMemoryRepository,
    tracker,
  });
}

/** Schedules one bounded pre-compaction episode write when enabled and transcript path is known. */
async function scheduleSkelnPreCompactionEpisodeWrite(
  event: SkelnSessionBeforeCompactEvent,
  context: ExtensionContext,
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
): Promise<void> {
  const target = resolveSkelnSessionEpisodeTarget(context);
  if (!target.sessionFile) {
    return;
  }

  try {
    const services = await servicesPromise;
    if (!isPluginEpisodeWriteEnabled(services.skelnConfig.memoryPolicy)) {
      return;
    }

    const messageCount = resolveSkelnPreCompactionMessageCount(context, event);
    scheduleGuardedEpisodeWrite({
      dreaming: services.dreaming,
      dbPath: services.config.dbPath,
      write: async () =>
        writeSkelnPreCompactionEpisode({
          target,
          messageCount,
          services,
        }),
      onFailure: (error) => {
        console.warn(`[agenr] skeln pre-compaction episode write failed for session=${target.sessionId}: ${formatErrorMessage(error)}`);
      },
    });
  } catch (error) {
    console.warn(`[agenr] skeln pre-compaction episode write skipped: ${formatErrorMessage(error)}`);
  }
}

/** Resolves the message count used for pre-compaction episode provenance. */
function resolveSkelnPreCompactionMessageCount(context: ExtensionContext, event: SkelnSessionBeforeCompactEvent): number {
  if (typeof event.messageCount === "number" && Number.isFinite(event.messageCount)) {
    return event.messageCount;
  }

  try {
    return context.sessionManager.getBranch().length;
  } catch {
    return 0;
  }
}
