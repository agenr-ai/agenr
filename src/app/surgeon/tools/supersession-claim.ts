import { randomUUID } from "node:crypto";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const ASSIGN_CLAIM_KEY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
  claim_key: Type.String({ minLength: 3, description: "Claim key in entity/attribute format (for example, 'jim/home_city')." }),
  reasoning: Type.String({ minLength: 1, description: "Why this claim key fits this entry." }),
});

/** Validated parameter payload for the claim-key assignment tool. */
type AssignClaimKeyParams = Static<typeof ASSIGN_CLAIM_KEY_SCHEMA>;

/**
 * Creates the claim-key assignment tool used by the supersession pass.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that assigns or normalizes claim keys on active entries.
 */
export function createAssignClaimKeyTool(deps: SurgeonToolDeps): AgentTool<typeof ASSIGN_CLAIM_KEY_SCHEMA> {
  return {
    name: "assign_claim_key",
    label: "Assign claim key",
    description: "Assign or normalize an active entry's claim_key using entity/attribute format.",
    parameters: ASSIGN_CLAIM_KEY_SCHEMA,
    async execute(_toolCallId, params: AssignClaimKeyParams) {
      const reasoning = params.reasoning.trim();
      const normalizedClaimKey = normalizeClaimKey(params.claim_key);

      if (reasoning.length === 0) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Reasoning is required.",
        });
      }

      if (!normalizedClaimKey) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Claim key must contain exactly one '/' with non-empty entity and attribute parts.",
        });
      }

      const entry = await deps.port.getEntry(params.entry_id.trim());
      if (!entry || entry.retired) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id.trim(),
          reason: "Entry not found or is no longer active.",
        });
      }

      const changes =
        entry.claim_key === normalizedClaimKey
          ? {}
          : {
              claim_key: {
                from: entry.claim_key ?? null,
                to: normalizedClaimKey,
              },
            };

      if (Object.keys(changes).length === 0) {
        return toolResult({
          success: true,
          dryRun: !deps.apply,
          entryId: entry.id,
          updated: false,
          changes,
        });
      }

      if (!deps.apply) {
        return toolResult({
          success: true,
          dryRun: true,
          entryId: entry.id,
          updated: false,
          wouldUpdate: true,
          changes,
        });
      }

      const updated = await deps.port.updateEntry(entry.id, {
        claim_key: normalizedClaimKey,
      });

      if (updated) {
        await deps.recordRunAction({
          id: randomUUID(),
          runId: deps.runId,
          actionType: "update_entry",
          entryIds: [entry.id],
          reasoning,
          recallDelta: null,
          createdAt: deps.now().toISOString(),
        });
      }

      return toolResult({
        success: updated,
        dryRun: false,
        entryId: entry.id,
        updated,
        changes,
      });
    },
  };
}

/**
 * Normalizes and validates a claim key in `entity/attribute` format.
 *
 * @param value - Raw claim key input.
 * @returns Normalized claim key, or null when invalid.
 */
function normalizeClaimKey(value: string): string | null {
  const parts = value
    .trim()
    .split("/")
    .map((part) => part.trim());

  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    return null;
  }

  return `${parts[0]}/${parts[1]}`;
}
