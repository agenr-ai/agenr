import path from "node:path";

import type { StoreDurableInput } from "../types.js";

const IGNORED_PROJECT_DIRECTORY_NAMES = new Set(["", ".", "..", "users", "user", "home", "tmp", "var"]);

/** Durable fields consulted when deciding whether workspace context applies. */
export type DurableProjectScopeFields = Pick<StoreDurableInput, "project" | "subject" | "content" | "tags" | "source_context" | "claim_key">;

/** Session context that may hint at workspace scope but never applies by default. */
export interface DurableProjectScopeContext {
  /** Host session or episode workspace label, such as a repo or product slug. */
  sessionWorkspace?: string | null;
  /** Working directory path when the host supplies one. */
  workingDirectory?: string | null;
}

/**
 * Resolves whether a durable row should carry a `project` tag.
 *
 * `project` means the knowledge is about a specific workspace or product,
 * not merely that the conversation happened inside one. Personal, family, and
 * other cross-workspace facts stay unscoped unless the durable itself signals
 * otherwise.
 *
 * Resolution order:
 * 1. Explicit per-durable `project` from tool output or extract JSON.
 * 2. Claim-key entity prefix that matches the session workspace.
 * 3. Session workspace when subject or source_context visibly reference it.
 * 4. Working-directory basename when subject or source_context visibly reference it.
 *
 * @param durable - Candidate durable fields from store, ingest, or dreaming extract.
 * @param context - Optional session workspace and working-directory hints.
 * @returns Project slug to persist, or `undefined` when knowledge stays global.
 */
export function resolveDurableProjectScope(durable: DurableProjectScopeFields, context: DurableProjectScopeContext = {}): string | undefined {
  const durableProject = normalizeOptionalString(durable.project);
  if (durableProject) {
    return durableProject;
  }

  const sessionWorkspace = normalizeOptionalString(context.sessionWorkspace ?? undefined);
  if (sessionWorkspace) {
    if (claimKeySuggestsProjectScope(durable.claim_key, sessionWorkspace) || durableContainsProjectSignal(durable, sessionWorkspace)) {
      return sessionWorkspace;
    }
  }

  const workingDirectoryProject = deriveWorkingDirectoryProject(context.workingDirectory);
  if (workingDirectoryProject && durableContainsProjectSignal(durable, workingDirectoryProject)) {
    return workingDirectoryProject;
  }

  return undefined;
}

/** Returns whether a claim-key entity prefix names the candidate workspace. */
function claimKeySuggestsProjectScope(claimKey: string | undefined, project: string): boolean {
  const entity = normalizeMetadataIdentifier(claimKey?.split("/")[0]);
  const normalizedProject = normalizeMetadataIdentifier(project);
  if (!entity || !normalizedProject) {
    return false;
  }

  return entity === normalizedProject;
}

/** Derives a conservative project identifier from a working-directory path. */
function deriveWorkingDirectoryProject(workingDirectory?: string | null): string | undefined {
  const normalizedWorkingDirectory = normalizeOptionalString(workingDirectory ?? undefined);
  if (!normalizedWorkingDirectory) {
    return undefined;
  }

  const candidate = normalizeMetadataIdentifier(path.basename(normalizedWorkingDirectory));
  if (!candidate || IGNORED_PROJECT_DIRECTORY_NAMES.has(candidate)) {
    return undefined;
  }

  return candidate;
}

/** Returns whether one durable visibly references the candidate project identifier. */
function durableContainsProjectSignal(durable: Pick<DurableProjectScopeFields, "subject" | "content" | "tags" | "source_context">, project: string): boolean {
  const projectTokens = project.split("_").filter((token) => token.length > 0);
  if (projectTokens.length === 0) {
    return false;
  }

  return [durable.subject, durable.source_context, ...(durable.tags ?? [])].some((value) => {
    const tokens = tokenizeText(value);
    return projectTokens.every((token) => tokens.has(token));
  });
}

/** Normalizes one identifier into lowercase snake_case for metadata matching. */
function normalizeMetadataIdentifier(value?: string): string | undefined {
  const normalized = normalizeOptionalString(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Tokenizes free text into lowercase alphanumeric words for conservative matching. */
function tokenizeText(value?: string): Set<string> {
  return new Set(
    (value ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

/** Trims one optional string and drops the empty result. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
