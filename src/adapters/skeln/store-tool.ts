import { storeEntriesDetailed, type StoreEntriesDetailedResult } from "../../core/store/pipeline.js";
import { ENTRY_TYPES, type EntryType } from "../../core/types.js";
import { buildSessionSourceFile, buildToolCallClaimSupport } from "../shared/claim-support.js";
import { EXPIRY_DESCRIPTION, asRecord, formatErrorMessage, parseExpiry } from "../shared/entry-tools.js";
import type { AgenrSkelnServices, SkelnApprovalTargetLike, SkelnToolContextLike, SkelnToolLike, SkelnToolResultLike } from "./types.js";

const ENTRY_TYPE_DESCRIPTION =
  "Knowledge type to store. Use fact for durable truth about a person, system, place, or how something works. Use decision for a standing rule, constraint, policy, or chosen approach future sessions should follow - not a progress update or completed action. Use preference for what someone likes, wants, values, or wants avoided. Use lesson for a non-obvious takeaway learned from experience that should change future behavior. Use milestone for a rare one-time event with durable future significance - not ordinary execution progress. Use relationship for a meaningful durable connection between people, groups, or systems.";

const STORE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [...ENTRY_TYPES],
      description: ENTRY_TYPE_DESCRIPTION,
    },
    subject: {
      type: "string",
      description: "Short subject line future recall can match. Name the durable takeaway, person, system, rule, relationship, or milestone directly.",
    },
    content: {
      type: "string",
      description: "What a fresh session should remember. Store the durable takeaway, not the activity log, canonical record, or transient progress snapshot.",
    },
    importance: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Importance from 1 to 10. Use 7 for normal durable memory, 9 for critical constraints, and 10 only rarely.",
    },
    expiry: {
      type: "string",
      enum: ["core", "permanent", "temporary"],
      description: EXPIRY_DESCRIPTION,
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags for entities, systems, teams, or themes that should improve later recall.",
    },
    sourceContext: {
      type: "string",
      description: "Optional provenance note explaining why this memory was stored or what situation produced it.",
    },
    supersedes: {
      type: "string",
      description: "ID of an entry this replaces. The old entry will be marked as superseded.",
    },
    claimKey: {
      type: "string",
      description:
        'Slot key identifying the specific knowledge slot (entity/attribute format, e.g., "project_name/deploy_strategy" or "postgres/max_connections"). Entries with the same claim key are candidates for supersession.',
    },
    validFrom: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact became true in the world.",
    },
    validTo: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact stopped being true.",
    },
  },
  required: ["type", "subject", "content"],
} as const;

/**
 * Structured details returned by `agenr_store`.
 */
export interface AgenrSkelnStoreDetails {
  /** Result status. */
  status: "stored" | "skipped";
  /** Stored or skipped entry subject. */
  subject: string;
  /** Matching entry id when it can be resolved after the store attempt. */
  entryId?: string;
  /** Stable Skeln memory session key when present. */
  sessionKey?: string;
  /** Detailed core store-pipeline result. */
  result: StoreEntriesDetailedResult;
}

/**
 * Creates the write-capable agenr store tool for a Skeln tool context.
 *
 * @param context - Skeln-like tool context.
 * @param services - Lazily resolves agenr services.
 * @returns Skeln-compatible store tool.
 */
export function createAgenrStoreTool(context: SkelnToolContextLike, services: () => Promise<AgenrSkelnServices>): SkelnToolLike<AgenrSkelnStoreDetails> {
  return {
    name: "agenr_store",
    label: "Agenr Store",
    category: "memory",
    risk: "write",
    approval: "manual",
    approvalTarget: storeApprovalTarget,
    description:
      "Store a new durable memory entry in agenr. Apply the future-session test first: will a fresh future session make a better decision because this was stored, or are you just logging that something happened?\n\nIf another system is already the canonical record - such as version control, a task or ticket tracker, a calendar, a signed document, a chat or email thread, or a database/CRM - usually do not store that record here. Store only the durable takeaway: the standing implication, rule, lesson, preference, risk, or relationship.\n\nType guide: fact = durable truth about a person, system, place, or how something works. decision = a standing rule, constraint, policy, or chosen approach future sessions should follow. preference = what someone likes, wants, values, or wants avoided. lesson = a non-obvious takeaway learned from experience that should change future behavior. milestone = a rare one-time event with durable future significance, not ordinary execution progress. relationship = a meaningful durable connection between people, groups, or systems.\n\nUsually do not store: 'I merged PR #123.', 'I filed a ticket with support.', 'We had a meeting at 3 PM.', 'I sent the contract for signature.', 'We spent two hours debugging the outage.' Do store the takeaway instead: 'Always use the structured export path because raw sync corrupts timestamps.' 'Jim prefers text-first updates and dislikes surprise calls.' 'Service restarts fail unless config Y is enabled.' 'The office Wi-Fi name is Acorn-5G.'\n\nDo not use decision as a catch-all for important activity updates. Do not store plans, checklists, speculative future state, progress snapshots, session narration, or rephrased recalled material.\n\nWhen replacing an existing fact, pass `supersedes` with the old entry's ID. When storing a slot-like fact (for example, a library version or a rollout strategy), pass `claimKey` to enable future supersession detection.\n\nDo not ask before storing - but do ask whether future-you actually needs it.",
    parameters: STORE_TOOL_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId: string, rawParams: unknown): Promise<SkelnToolResultLike<AgenrSkelnStoreDetails>> {
      try {
        const params = asRecord(rawParams);
        const type = parseEntryType(readRequiredString(params, "type"));
        const subject = readRequiredString(params, "subject");
        const content = readRequiredString(params, "content");
        const importance = readOptionalIntegerInRange(params, "importance", 1, 10);
        const expiry = parseExpiry(readOptionalString(params, "expiry"));
        const tags = normalizeStringArray(readOptionalStringArray(params, "tags"));
        const sourceContext = readOptionalString(params, "sourceContext");
        const supersedes = readOptionalString(params, "supersedes");
        const claimKey = readOptionalString(params, "claimKey", { trim: false });
        const validFrom = readOptionalString(params, "validFrom");
        const validTo = readOptionalString(params, "validTo");
        const claimSupportObservedAt = new Date().toISOString();
        const resolvedServices = await services();
        const result = await storeEntriesDetailed(
          [
            {
              type,
              subject,
              content,
              ...(importance !== undefined ? { importance } : {}),
              ...(expiry !== undefined ? { expiry } : {}),
              ...(tags.length > 0 ? { tags } : {}),
              ...(supersedes ? { supersedes } : {}),
              ...(claimKey
                ? {
                    claim_key: claimKey,
                    claim_key_raw: claimKey,
                    ...buildToolCallClaimSupport(context, "skeln-session", "agenr_store", claimSupportObservedAt),
                  }
                : {}),
              ...(validFrom ? { valid_from: validFrom } : {}),
              ...(validTo ? { valid_to: validTo } : {}),
              source_file: buildSessionSourceFile(context, "skeln-session"),
              source_context: sourceContext ?? "Stored via agenr_store from Skeln.",
            },
          ],
          resolvedServices.entries,
          resolvedServices.embedding,
          {
            ...(resolvedServices.claimExtraction
              ? {
                  claimExtraction: {
                    llm: resolvedServices.claimExtraction.llm,
                    db: resolvedServices.entries,
                    config: resolvedServices.claimExtraction.config,
                  },
                }
              : {}),
          },
        );
        const storedEntry = await resolvedServices.memory.findEntryBySubject(subject);

        if (result.stored > 0) {
          return textResult(`Stored "${subject}".`, {
            status: "stored",
            subject,
            ...(storedEntry?.id ? { entryId: storedEntry.id } : {}),
            ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
            result,
          });
        }

        if (result.skipped > 0) {
          return textResult(`Skipped "${subject}" because an active duplicate already exists.`, {
            status: "skipped",
            subject,
            ...(storedEntry?.id ? { entryId: storedEntry.id } : {}),
            ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
            result,
          });
        }

        throw new Error(`Rejected "${subject}". Check the supplied type, content, and metadata.`);
      } catch (error) {
        throw new Error(`agenr_store failed: ${formatErrorMessage(error)}`, { cause: error });
      }
    },
  };
}

/**
 * Extracts the store subject Skeln can display for approval.
 */
function storeApprovalTarget(args: unknown): SkelnApprovalTargetLike {
  try {
    const params = asRecord(args);
    return { target: readOptionalString(params, "subject") ?? "agenr store" };
  } catch {
    return { target: "agenr store" };
  }
}

/**
 * Creates a text tool result.
 */
function textResult<TDetails>(text: string, details: TDetails): SkelnToolResultLike<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/**
 * Reads one required string parameter.
 */
function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = readOptionalString(params, key);
  if (!value) {
    throw new Error(`Parameter "${key}" is required.`);
  }
  return value;
}

/**
 * Reads one optional string parameter.
 */
function readOptionalString(params: Record<string, unknown>, key: string, options: { trim?: boolean } = {}): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Parameter "${key}" must be a string.`);
  }
  const normalized = options.trim === false ? value : value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Reads one optional string-array parameter.
 */
function readOptionalStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Parameter "${key}" must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Parameter "${key}" item ${index + 1} must be a string.`);
    }
    return item;
  });
}

/**
 * Reads one optional bounded integer parameter.
 */
function readOptionalIntegerInRange(params: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Parameter "${key}" must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

/**
 * Parses one entry type string into the agenr domain union.
 */
function parseEntryType(value: string): EntryType {
  if (ENTRY_TYPES.includes(value as EntryType)) {
    return value as EntryType;
  }

  throw new Error(`Unsupported entry type "${value}".`);
}

/**
 * Normalizes string array parameters and removes duplicates.
 */
function normalizeStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (item.length > 0 && !seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  return normalized;
}
