import type { DreamClaimKeyContextDurable } from "../../core/dreaming/claim-key-context.js";
import { normalizeClaimKey, normalizeClaimKeySegment } from "../../core/claim-key.js";
import type { DreamPort } from "./ports.js";

/** Maximum active keyed durables loaded for one extract classification lookup. */
export const CLAIM_KEY_CLASSIFICATION_CONTEXT_LIMIT = 16;

const MIN_ATTRIBUTE_OVERLAP_TOKENS = 2;
const MIN_CONTENT_OVERLAP_TOKENS = 4;
const STRONG_ATTRIBUTE_OVERLAP = 0.6;
const STRONG_CONTENT_OVERLAP = 0.72;
const CONTEXT_TOKEN_STOPWORDS = new Set([
  "about",
  "again",
  "already",
  "during",
  "from",
  "have",
  "into",
  "that",
  "their",
  "there",
  "this",
  "used",
  "user",
  "where",
  "with",
]);

/** Minimal candidate shape used by claim-key context matching during extract classification. */
export interface ClaimKeyContextCandidate {
  claimKey: string | null;
  project?: string;
  subject: string;
  content: string;
}

/**
 * Finds an active same-family durable that a near-miss extract candidate should refine.
 *
 * @param candidate - Mined candidate under classification.
 * @param port - Dream persistence port.
 * @param contextByEntity - Cache of entity-prefix context rows.
 * @param contextByProject - Cache of project-scoped context rows.
 * @returns Matching active durable, when one is found.
 */
export async function findLikelyClaimKeyContextMatch(
  candidate: ClaimKeyContextCandidate,
  port: DreamPort,
  contextByEntity: Map<string, DreamClaimKeyContextDurable[]>,
  contextByProject: Map<string, DreamClaimKeyContextDurable[]>,
): Promise<DreamClaimKeyContextDurable | null> {
  const claimKeyEntity = candidate.claimKey ? readClaimKeyEntity(candidate.claimKey) : null;
  const entityContext = claimKeyEntity ? await loadClaimKeyEntityContext(claimKeyEntity, port, contextByEntity) : [];
  const projectContext = entityContext.length === 0 && candidate.project ? await loadClaimKeyProjectContext(candidate.project, port, contextByProject) : [];
  const context = entityContext.length > 0 ? entityContext : projectContext;

  for (const durable of context) {
    if (isLikelyClaimKeyContextMatch(candidate, durable)) {
      return durable;
    }
  }

  return null;
}

/** Loads active keyed durables for a single claim-key entity prefix. */
async function loadClaimKeyEntityContext(
  entityPrefix: string,
  port: DreamPort,
  cache: Map<string, DreamClaimKeyContextDurable[]>,
): Promise<DreamClaimKeyContextDurable[]> {
  const cached = cache.get(entityPrefix);
  if (cached) {
    return cached;
  }

  const context = await port.listActiveClaimKeyContext({
    entityPrefixes: [entityPrefix],
    limit: CLAIM_KEY_CLASSIFICATION_CONTEXT_LIMIT,
  });
  cache.set(entityPrefix, context);
  return context;
}

/** Loads active keyed durables for a project-scoped no-key candidate. */
async function loadClaimKeyProjectContext(
  project: string,
  port: DreamPort,
  cache: Map<string, DreamClaimKeyContextDurable[]>,
): Promise<DreamClaimKeyContextDurable[]> {
  const normalizedProject = normalizeClaimKeySegment(project);
  if (!normalizedProject) {
    return [];
  }

  const cached = cache.get(normalizedProject);
  if (cached) {
    return cached;
  }

  const context = await port.listActiveClaimKeyContext({
    project: normalizedProject,
    entityPrefixes: [normalizedProject],
    limit: CLAIM_KEY_CLASSIFICATION_CONTEXT_LIMIT,
  });
  cache.set(normalizedProject, context);
  return context;
}

/** Returns whether an extracted candidate is a near miss for an active keyed durable. */
function isLikelyClaimKeyContextMatch(candidate: ClaimKeyContextCandidate, durable: DreamClaimKeyContextDurable): boolean {
  if (!durable.claimKey) {
    return false;
  }

  if (candidate.claimKey && hasStrongClaimKeyAttributeOverlap(candidate.claimKey, durable.claimKey)) {
    return true;
  }

  return hasStrongTextOverlap(`${candidate.subject} ${candidate.content}`, `${durable.subject} ${durable.content}`);
}

/** Detects same-entity sibling slots whose attributes overlap strongly enough to treat as one family. */
function hasStrongClaimKeyAttributeOverlap(leftClaimKey: string, rightClaimKey: string): boolean {
  const left = normalizeClaimKey(leftClaimKey);
  const right = normalizeClaimKey(rightClaimKey);
  if (!left.ok || !right.ok || left.value.entity !== right.value.entity) {
    return false;
  }

  const leftTokens = tokenizeClaimKeyAttribute(left.value.attribute);
  const rightTokens = tokenizeClaimKeyAttribute(right.value.attribute);
  const overlap = calculateOverlap(leftTokens, rightTokens);
  return overlap.commonCount >= MIN_ATTRIBUTE_OVERLAP_TOKENS && overlap.coefficient >= STRONG_ATTRIBUTE_OVERLAP;
}

/** Detects strongly overlapping subject/content text for candidates without a useful exact key. */
function hasStrongTextOverlap(left: string, right: string): boolean {
  const leftTokens = tokenizeExtractContextText(left);
  const rightTokens = tokenizeExtractContextText(right);
  const overlap = calculateOverlap(leftTokens, rightTokens);
  return overlap.commonCount >= MIN_CONTENT_OVERLAP_TOKENS && overlap.coefficient >= STRONG_CONTENT_OVERLAP;
}

/** Reads the normalized entity prefix from a canonical claim key. */
function readClaimKeyEntity(claimKey: string): string | null {
  const normalized = normalizeClaimKey(claimKey);
  return normalized.ok ? normalized.value.entity : null;
}

/** Tokenizes claim-key attributes for sibling-slot overlap checks. */
function tokenizeClaimKeyAttribute(attribute: string): Set<string> {
  return new Set(attribute.split("_").filter((token) => token.length >= 3 && !CONTEXT_TOKEN_STOPWORDS.has(token)));
}

/** Tokenizes prompt or durable text for conservative lexical overlap checks. */
export function tokenizeExtractContextText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !CONTEXT_TOKEN_STOPWORDS.has(token)),
  );
}

/** Calculates overlap coefficient for two token sets. */
function calculateOverlap(left: Set<string>, right: Set<string>): { commonCount: number; coefficient: number } {
  if (left.size === 0 || right.size === 0) {
    return { commonCount: 0, coefficient: 0 };
  }

  let commonCount = 0;
  for (const token of left) {
    if (right.has(token)) {
      commonCount += 1;
    }
  }

  return { commonCount, coefficient: commonCount / Math.min(left.size, right.size) };
}
