import type { MemoryRepository } from "../../app/memory/ports.js";
import type { DatabasePort } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";

/** Database and memory ports used to resolve id/subject tool targets. */
export interface EntryMemoryResolverServices {
  entries: Pick<DatabasePort, "getDurable">;
  memory: Pick<MemoryRepository, "findEntryBySubject" | "getEntryTrace">;
}

/**
 * Builds entry lookup ports for shared store-side memory tools.
 *
 * @param services - Entry database and memory repository services.
 * @returns Host-neutral resolver ports.
 */
export function buildEntryMemoryResolverPorts(services: EntryMemoryResolverServices): EntryResolverPorts {
  return {
    getDurableById: async (entryId) => (await services.entries.getDurable(entryId)) ?? (await services.memory.getEntryTrace(entryId))?.entry ?? null,
    findEntryBySubject: async (subject) => services.memory.findEntryBySubject(subject),
  };
}

/**
 * Ports needed to resolve a user-facing entry selector into a stored entry.
 */
export interface EntryResolverPorts {
  /** Finds an entry by canonical id. */
  getDurableById(id: string): Promise<Durable | null>;
  /** Finds the newest entry matching a subject. */
  findEntryBySubject(subject: string): Promise<Durable | null>;
}

/**
 * Resolves exactly one tool target selector into a concrete agenr entry.
 *
 * @param ports - Host-neutral entry lookup ports.
 * @param params - Raw tool parameters.
 * @returns Matching agenr entry.
 */
export async function resolveTargetDurable(ports: EntryResolverPorts, params: Record<string, unknown>): Promise<Durable> {
  const id = readOptionalStringParam(params, "id");
  const subject = readOptionalStringParam(params, "subject");
  const selectorCount = (id ? 1 : 0) + (subject ? 1 : 0);

  if (selectorCount !== 1) {
    throw new Error("Provide exactly one target selector: id or subject.");
  }

  if (id) {
    const entry = await ports.getDurableById(id);
    if (!entry) {
      throw new Error(`No agenr entry found for id ${id}.`);
    }
    return entry;
  }

  const entry = await ports.findEntryBySubject(subject ?? "");
  if (!entry) {
    throw new Error(`No agenr entry found for subject "${subject}".`);
  }

  return entry;
}

/**
 * Parses an optional string selector from tool params.
 */
function readOptionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
