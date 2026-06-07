import type { MemoryRepository } from "../../app/memory/ports.js";
import type { DatabasePort } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";

/** Database and memory ports used to resolve id/subject tool targets. */
export interface DurableMemoryResolverServices {
  durables: Pick<DatabasePort, "getDurable">;
  memory: Pick<MemoryRepository, "findDurableBySubject" | "getDurableTrace">;
}

/**
 * Builds durable lookup ports for shared store-side memory tools.
 *
 * @param services - Durable database and memory repository services.
 * @returns Host-neutral resolver ports.
 */
export function buildDurableMemoryResolverPorts(services: DurableMemoryResolverServices): DurableResolverPorts {
  return {
    getDurableById: async (durableId) => (await services.durables.getDurable(durableId)) ?? (await services.memory.getDurableTrace(durableId))?.durable ?? null,
    findDurableBySubject: async (subject) => services.memory.findDurableBySubject(subject),
  };
}

/**
 * Ports needed to resolve a user-facing durable selector into a stored durable.
 */
export interface DurableResolverPorts {
  /** Finds a durable by canonical id. */
  getDurableById(id: string): Promise<Durable | null>;
  /** Finds the newest durable matching a subject. */
  findDurableBySubject(subject: string): Promise<Durable | null>;
}

/**
 * Resolves exactly one tool target selector into a concrete agenr durable.
 *
 * @param ports - Host-neutral durable lookup ports.
 * @param params - Raw tool parameters.
 * @returns Matching agenr durable.
 */
export async function resolveTargetDurable(ports: DurableResolverPorts, params: Record<string, unknown>): Promise<Durable> {
  const id = readOptionalStringParam(params, "id");
  const subject = readOptionalStringParam(params, "subject");
  const selectorCount = (id ? 1 : 0) + (subject ? 1 : 0);

  if (selectorCount !== 1) {
    throw new Error("Provide exactly one target selector: id or subject.");
  }

  if (id) {
    const durable = await ports.getDurableById(id);
    if (!durable) {
      throw new Error(`No agenr durable found for id ${id}.`);
    }
    return durable;
  }

  const durable = await ports.findDurableBySubject(subject ?? "");
  if (!durable) {
    throw new Error(`No agenr durable found for subject "${subject}".`);
  }

  return durable;
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
