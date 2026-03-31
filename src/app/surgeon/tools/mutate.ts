import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { isProtectedFromRetirement } from "../../../core/surgeon/domain/protection-rules.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const RETIRE_ENTRY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

/** Validated parameter payload for the retire tool. */
type RetireEntryParams = Static<typeof RETIRE_ENTRY_SCHEMA>;

/**
 * Creates the retirement mutation tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that retires one entry after hard protection checks.
 */
export function createRetireEntryTool(deps: SurgeonToolDeps): AgentTool<typeof RETIRE_ENTRY_SCHEMA> {
  return {
    name: "retire_entry",
    label: "Retire entry",
    description: "Retire a single entry after checking hard retirement protections. Respects dry-run mode.",
    parameters: RETIRE_ENTRY_SCHEMA,
    async execute(_toolCallId, params: RetireEntryParams) {
      const entry = await deps.port.getEntry(params.entry_id);
      if (!entry) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Entry not found.",
        });
      }

      const protection = isProtectedFromRetirement(
        {
          expiry: entry.expiry,
          importance: entry.importance,
          lastRecalledAt: entry.last_recalled_at,
        },
        {
          now: deps.now(),
          protectRecalledDays: deps.protection.protectRecalledDays,
          protectMinImportance: deps.protection.protectMinImportance,
        },
      );

      if (protection.protected) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: entry.id,
          protected: true,
          reason: protection.reason,
        });
      }

      if (!deps.apply) {
        return toolResult({
          success: true,
          dryRun: true,
          entryId: entry.id,
          wouldRetire: true,
          reason: params.reason.trim(),
        });
      }

      const retired = await deps.port.retireEntry(entry.id, params.reason.trim());
      return toolResult({
        success: retired,
        dryRun: false,
        entryId: entry.id,
        retired,
        retiredCount: retired ? 1 : 0,
        reason: params.reason.trim(),
      });
    },
  };
}
