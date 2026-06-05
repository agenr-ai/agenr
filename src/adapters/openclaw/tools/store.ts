import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { STORE_TOOL_PARAMETERS, parseStoreToolParams, runStoreMemoryTool, sanitizeStoreToolParams } from "../../shared/memory-tools.js";
import type { AgenrOpenClawServices } from "../types.js";
import { formatErrorMessage } from "../logging.js";
import { OPENCLAW_PARAM_READER, logToolCall, logToolFailure, toOpenClawToolResult, toolFailureResult } from "./shared.js";

/**
 * Creates the agenr store tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_store`.
 */
export function createAgenrStoreTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_store",
    label: "Agenr Store",
    description:
      "Store a new durable memory entry in agenr. Apply the future-session test first: will a fresh future session make a better decision because this was stored, or are you just logging that something happened?\n\nIf another system is already the canonical record - such as version control, a task or ticket tracker, a calendar, a signed document, a chat or email thread, or a database/CRM - usually do not store that record here. Store only the durable takeaway: the standing implication, rule, lesson, preference, risk, or relationship.\n\nType guide: fact = durable truth about a person, system, place, or how something works. decision = a standing rule, constraint, policy, or chosen approach future sessions should follow. preference = what someone likes, wants, values, or wants avoided. lesson = a non-obvious takeaway learned from experience that should change future behavior. milestone = a rare one-time event with durable future significance, not ordinary execution progress. relationship = a meaningful durable connection between people, groups, or systems.\n\nUsually do not store: 'I merged PR #123.', 'I filed a ticket with support.', 'We had a meeting at 3 PM.', 'I sent the contract for signature.', 'We spent two hours debugging the outage.' Do store the takeaway instead: 'Always use the structured export path because raw sync corrupts timestamps.' 'Jim prefers text-first updates and dislikes surprise calls.' 'Service restarts fail unless config Y is enabled.' 'The office Wi-Fi name is Acorn-5G.'\n\nDo not use decision as a catch-all for important activity updates. Do not store plans, checklists, speculative future state, progress snapshots, session narration, or rephrased recalled material.\n\nWhen replacing an existing fact, pass `supersedes` with the old entry's ID. When storing a slot-like fact (for example, a library version or a rollout strategy), pass `claimKey` to enable future supersession detection.\n\nDo not ask before storing - but do ask whether future-you actually needs it.",
    parameters: STORE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = parseStoreToolParams(rawParams, OPENCLAW_PARAM_READER);
        logToolCall(logger, "agenr_store", ctx, `store 1 entry subject=${JSON.stringify(params.subject)} type=${params.type}`, sanitizeStoreToolParams(params));

        const services = await servicesPromise;
        const outcome = await runStoreMemoryTool(params, services, {
          session: ctx,
          sourcePrefix: "openclaw-session",
          defaultSourceContext: "Stored via agenr_store from OpenClaw.",
          onWarning: (warning) => logger.warn(`[agenr] tool=agenr_store session=${ctx.sessionId ?? "unknown"} warning: ${warning}`),
        });
        triggerOpenClawImportanceLightDream(services, logger, outcome.details.status);
        return toOpenClawToolResult(outcome);
      } catch (error) {
        logToolFailure(logger, "agenr_store", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

/** Triggers an OpenClaw light dream after an important store result. */
function triggerOpenClawImportanceLightDream(services: AgenrOpenClawServices, logger: PluginLogger, status: unknown): void {
  if (status !== "stored") {
    return;
  }

  void maybeRunLightDream(
    { trigger: "importance" },
    {
      port: services.dreaming,
      dbPath: services.config.dbPath,
      config: services.agenrConfig,
      embedding: services.embedding,
      ...(services.claimExtraction ? { createClaimExtractionLlm: () => services.claimExtraction!.llm } : {}),
    },
  )
    .then((result) => {
      if (result.status === "ran") {
        logger.info(`[agenr] importance light dream completed run=${result.result.runId}`);
      } else if (result.reason === "run_in_progress" || result.reason === "episode_write_in_progress") {
        logger.info(`[agenr] importance light dream skipped reason=${result.reason}`);
      } else {
        logger.debug?.(`[agenr] importance light dream skipped reason=${result.reason}`);
      }
    })
    .catch((error: unknown) => {
      logger.warn(`[agenr] importance light dream failed: ${formatErrorMessage(error)}`);
    });
}
