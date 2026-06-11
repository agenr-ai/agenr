import type { WorkingScope } from "../../../app/working-memory/scope.js";
import type { AgenrOpenClawHookContext } from "../types.js";

const UNKNOWN_OPENCLAW_SESSION_ID = "unknown";

/** Hook context fields required to resolve an OpenClaw session scope. */
export type OpenClawSessionScopeContext = Pick<AgenrOpenClawHookContext, "sessionId" | "sessionKey" | "workspaceDir" | "agentId">;

/**
 * Resolved OpenClaw session scope used by session-memory lifecycle hooks.
 */
export interface AgenrOpenClawSessionScope {
  /** Host session id used for provenance and recall routing. */
  sessionId: string;
  /** Stable session key used by session-memory persistence. */
  sessionKey: string;
  /** OpenClaw workspace directory when known. */
  workspaceDir?: string;
  /** OpenClaw agent id when known. */
  agentId?: string;
  /** Host-neutral conversation identifier. Defaults to sessionId. */
  conversationKey?: string;
  /** Optional project label derived from the host context. */
  project?: string;
}

/**
 * Resolves the active OpenClaw session scope from hook context.
 *
 * @param ctx - Hook context with session identity fields.
 * @returns Scope facts used by session-memory trigger builders.
 */
export function resolveOpenClawSessionScope(ctx: OpenClawSessionScopeContext): AgenrOpenClawSessionScope {
  const sessionId = normalizeScopeField(ctx.sessionId) ?? normalizeScopeField(ctx.sessionKey) ?? UNKNOWN_OPENCLAW_SESSION_ID;
  const sessionKey = normalizeScopeField(ctx.sessionKey) ?? sessionId;

  return {
    sessionId,
    sessionKey,
    conversationKey: sessionId,
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId, project: ctx.agentId } : {}),
  };
}

/**
 * Reports whether scope resolution fell back to the unsafe unknown session id.
 *
 * @param scope - Resolved OpenClaw session scope.
 * @returns Whether the scope lacks host-provided session identity.
 */
export function isUnknownOpenClawSessionScope(scope: AgenrOpenClawSessionScope): boolean {
  return scope.sessionId === UNKNOWN_OPENCLAW_SESSION_ID && scope.sessionKey === UNKNOWN_OPENCLAW_SESSION_ID;
}

/**
 * Builds the diagnostic used when OpenClaw lacks a collision-safe session id.
 *
 * @param action - Human-readable action being refused.
 * @returns Clear warning or error message for host diagnostics.
 */
export function formatUnknownOpenClawSessionScopeMessage(action: string): string {
  return `OpenClaw session identity is unavailable; refusing to ${action} because the "${UNKNOWN_OPENCLAW_SESSION_ID}" fallback could collide across sessions.`;
}

/**
 * Maps an OpenClaw session scope into working-memory scope facts.
 *
 * @param scope - Resolved OpenClaw session scope.
 * @returns Partial working scope for checkpoint refresh triggers.
 */
export function toWorkingScopeFromOpenClawSession(scope: AgenrOpenClawSessionScope): Partial<WorkingScope> {
  return {
    sessionId: scope.sessionId,
    conversationKey: scope.conversationKey ?? scope.sessionId,
    ...(scope.workspaceDir ? { cwd: scope.workspaceDir } : {}),
    ...(scope.project ? { project: scope.project } : {}),
  };
}

/**
 * Maps one OpenClaw hook context into the scope fields used by lifecycle hooks.
 *
 * @param ctx - Hook context with session identity fields.
 * @returns Scope context for session-memory routing and compaction handlers.
 */
export function toOpenClawSessionScopeContext(ctx: AgenrOpenClawHookContext): OpenClawSessionScopeContext {
  return {
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
  };
}

/** Trims optional scope fields to non-empty strings. */
function normalizeScopeField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
