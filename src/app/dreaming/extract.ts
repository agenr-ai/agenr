import { randomUUID } from "node:crypto";

import { extractFromTranscript } from "../../core/ingestion/extract.js";
import { normalizeClaimKey } from "../../core/claim-key.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { composeEmbeddingText } from "../../core/store/embedding-text.js";
import { computeContentHash, computeNormContentHash } from "../../core/store/hashing.js";
import type { DreamCandidate, DreamCandidateDisposition, DreamEvidenceRef, DreamExtractSummary } from "../../core/dreaming/types.js";
import type { Durable, ParsedTranscript, StoreDurableInput } from "../../core/types.js";
import { throwIfAborted } from "./abort.js";
import type { CostMeteredLlm, DreamEpisodeEvidence, DreamPort } from "./ports.js";

/** Terminal status reported by the extract stage. */
export type DreamExtractStatus = "completed" | "cost_capped";

/** Token and cost usage accumulated across one extract stage run. */
export interface DreamExtractUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Options accepted by the extract stage.
 */
export interface DreamExtractOptions {
  now(): Date;
  project?: string;
  fullBacklog?: boolean;
  maxEpisodes: number;
  contextLookupEnabled: boolean;
  /** Remaining LLM budget for the run; mining stops once it is exhausted. */
  costCapUsd: number;
  signal?: AbortSignal;
}

/**
 * Dependencies required by the extract stage.
 */
export interface DreamExtractDeps {
  port: DreamPort;
  /** Factory for the claim-mining LLM. Absent in deterministic-only runs. */
  createExtractLlm?: () => CostMeteredLlm;
}

/**
 * Aggregate outcome of one extract stage run.
 */
export interface DreamExtractResult {
  status: DreamExtractStatus;
  candidates: DreamCandidate[];
  summary: DreamExtractSummary;
  usage: DreamExtractUsage;
  warnings: string[];
}

const DEFAULT_CANDIDATE_IMPORTANCE = 5;

/**
 * Mines durable candidates from recent episode evidence and classifies each
 * candidate against the active corpus with a context-lookup dedup step.
 *
 * The stage never writes durable rows. It returns classified candidates so the
 * apply path can insert `new` candidates and the temporalize stage can revise
 * `refines` candidates. `known` candidates are dropped to avoid redundant
 * writes and embeddings.
 *
 * @param options - Scope, budget, and clock controls for the run.
 * @param deps - Persistence port and optional mining LLM factory.
 * @returns Classified candidates plus usage and summary counters.
 */
export async function runExtractStage(options: DreamExtractOptions, deps: DreamExtractDeps): Promise<DreamExtractResult> {
  const emptyUsage: DreamExtractUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const emptySummary: DreamExtractSummary = {
    episodesScanned: 0,
    candidatesEmitted: 0,
    newCandidates: 0,
    refineCandidates: 0,
    knownCandidates: 0,
    durablesInserted: 0,
  };

  if (!deps.createExtractLlm) {
    return { status: "completed", candidates: [], summary: emptySummary, usage: emptyUsage, warnings: [] };
  }

  const since = await resolveExtractSince(deps.port, options.fullBacklog === true);
  const episodes = await deps.port.listEpisodeEvidenceSince(since, {
    ...(options.project ? { project: options.project } : {}),
    limit: options.maxEpisodes,
  });

  if (episodes.length === 0) {
    return { status: "completed", candidates: [], summary: emptySummary, usage: emptyUsage, warnings: [] };
  }

  const llm = deps.createExtractLlm();
  const mined: MinedCandidate[] = [];
  const warnings: string[] = [];
  let episodesScanned = 0;
  let status: DreamExtractStatus = "completed";

  for (const episode of episodes) {
    throwIfAborted(options.signal);
    if (readUsage(llm).estimatedCostUsd >= options.costCapUsd) {
      status = "cost_capped";
      break;
    }

    const transcript = buildEpisodeTranscript(episode);
    const extraction = await extractFromTranscript(transcript, llm, { wholeFile: "force", interChunkDelayMs: 0 });
    episodesScanned += 1;
    warnings.push(...extraction.warnings.map((warning) => `Episode ${episode.id}: ${warning}`));
    if (readUsage(llm).estimatedCostUsd >= options.costCapUsd) {
      status = "cost_capped";
    }

    for (const entry of extraction.entries) {
      mined.push(toMinedCandidate(entry, episode));
    }

    if (status === "cost_capped") {
      break;
    }
  }

  const candidates = await classifyCandidates(mined, {
    port: deps.port,
    contextLookupEnabled: options.contextLookupEnabled,
  });

  const summary: DreamExtractSummary = {
    episodesScanned,
    candidatesEmitted: candidates.length,
    newCandidates: candidates.filter((candidate) => candidate.disposition === "new").length,
    refineCandidates: candidates.filter((candidate) => candidate.disposition === "refines").length,
    knownCandidates: candidates.filter((candidate) => candidate.disposition === "known").length,
    durablesInserted: 0,
  };

  return { status, candidates, summary, usage: readUsage(llm), warnings };
}

/**
 * Inserts every `new` extract candidate as a fresh, embedded durable row and
 * records one audit action per insert. Refine and known candidates are ignored
 * here; the temporalize stage owns revisions and known candidates are
 * intentionally dropped.
 *
 * Content is embedded before the write so dreamed durables are recallable by
 * vector search like any other durable. All inserts plus their audit rows commit
 * in a single transaction so a mid-batch failure never leaves partial state.
 *
 * @param input - Run identifier, classified candidates, and clock.
 * @param deps - Persistence port and embedding provider for vector generation.
 * @returns Number of durable rows inserted.
 */
export async function applyExtractedDurables(
  input: { runId: string; candidates: DreamCandidate[]; now(): Date },
  deps: { port: DreamPort; embedding: EmbeddingPort },
): Promise<{ inserted: number }> {
  const createdAt = input.now().toISOString();
  const prepared = input.candidates
    .filter((candidate) => candidate.disposition === "new")
    .map((candidate) => ({
      candidate,
      durable: buildDurableFromCandidate(candidate, {
        claimKeySource: "dreaming_extract",
        claimKeyStatus: "tentative",
        claimKeyConfidence: 0.5,
        claimKeyRationale: "Mined from episode evidence during dreaming extract.",
        createdAt,
      }),
    }));

  if (prepared.length === 0) {
    return { inserted: 0 };
  }

  const embeddings = await deps.embedding.embed(prepared.map(({ durable }) => composeEmbeddingText(durable)));

  await deps.port.withTransaction(async (tx) => {
    for (const [index, { candidate, durable }] of prepared.entries()) {
      const contentHash = durable.content_hash ?? computeContentHash(durable.content);
      await tx.insertDurable(durable, embeddings[index] ?? [], contentHash);
      await tx.logRunAction({
        id: randomUUID(),
        runId: input.runId,
        actionType: "insert_durable",
        durableIds: [durable.id],
        reasoning: "Inserted durable mined from episode evidence.",
        recallDelta: null,
        details: {
          claim_key: candidate.claimKey,
          evidence_refs: candidate.evidenceRefs.map((ref) => `${ref.kind}:${ref.locator}`),
        },
        createdAt,
      });
    }
  });

  return { inserted: prepared.length };
}

/** Raw mined candidate before context-lookup classification. */
interface MinedCandidate {
  type: Durable["type"];
  subject: string;
  content: string;
  importance: number;
  expiry: Durable["expiry"];
  tags: string[];
  directivePolarity?: Durable["directive_polarity"];
  directiveTrigger?: Durable["directive_trigger"];
  claimKey: string | null;
  evidenceRefs: DreamEvidenceRef[];
}

/**
 * Classifies mined candidates as `known`, `refines`, or `new`.
 *
 * Content-hash equality against the active corpus marks a candidate `known`.
 * When context-lookup is enabled and a candidate carries a claim key, an active
 * family member marks it `refines`. Everything else is `new`.
 *
 * Candidates are also deduplicated within the batch: once a normalized content
 * hash has been emitted as `new` or `refines`, any later candidate with the same
 * content is marked `known` so one run never inserts the same fact twice.
 *
 * @param mined - Raw mined candidates from episode evidence.
 * @param deps - Port plus context-lookup toggle.
 * @returns Classified dreaming candidates.
 */
export async function classifyCandidates(mined: MinedCandidate[], deps: { port: DreamPort; contextLookupEnabled: boolean }): Promise<DreamCandidate[]> {
  if (mined.length === 0) {
    return [];
  }

  const normHashByIndex = mined.map((candidate) => computeNormContentHash(candidate.content));
  const existingNormHashes = await deps.port.findExistingNormContentHashes(normHashByIndex);
  const seenNormHashes = new Set<string>(existingNormHashes);

  const candidates: DreamCandidate[] = [];
  for (const [index, candidate] of mined.entries()) {
    const normHash = normHashByIndex[index] ?? computeNormContentHash(candidate.content);
    let disposition: DreamCandidateDisposition = "new";
    let refinesDurableId: string | null = null;

    if (seenNormHashes.has(normHash)) {
      disposition = "known";
    } else if (deps.contextLookupEnabled && candidate.claimKey) {
      const family = await deps.port.findActiveDurablesByClaimKey(candidate.claimKey);
      const active = family[0];
      if (active) {
        disposition = "refines";
        refinesDurableId = active.id;
      }
    }

    // Claim the hash so a later same-content candidate in this batch is `known`.
    if (disposition !== "known") {
      seenNormHashes.add(normHash);
    }

    candidates.push({
      id: randomUUID(),
      type: candidate.type,
      subject: candidate.subject,
      content: candidate.content,
      importance: candidate.importance,
      expiry: candidate.expiry,
      tags: candidate.tags,
      ...(candidate.directivePolarity ? { directivePolarity: candidate.directivePolarity } : {}),
      ...(candidate.directiveTrigger ? { directiveTrigger: candidate.directiveTrigger } : {}),
      claimKey: candidate.claimKey,
      trust: "tentative",
      disposition,
      refinesDurableId,
      evidenceRefs: candidate.evidenceRefs,
    });
  }

  return candidates;
}

/**
 * Builds a durable row from one extract candidate and lifecycle metadata.
 *
 * @param candidate - Classified candidate to materialize.
 * @param lifecycle - Claim-key provenance and timestamps for the new row.
 * @returns Durable ready for insertion.
 */
export function buildDurableFromCandidate(
  candidate: DreamCandidate,
  lifecycle: {
    claimKeySource: Durable["claim_key_source"];
    claimKeyStatus: Durable["claim_key_status"];
    claimKeyConfidence: number;
    claimKeyRationale: string;
    createdAt: string;
    validFrom?: string;
    id?: string;
    claimKeyOverride?: string | null;
  },
): Durable {
  const contentHash = computeContentHash(candidate.content);
  const normContentHash = computeNormContentHash(candidate.content);
  const claimKey = lifecycle.claimKeyOverride !== undefined ? lifecycle.claimKeyOverride : candidate.claimKey;
  const primaryEvidence = candidate.evidenceRefs[0];

  const durable: Durable = {
    id: lifecycle.id ?? candidate.id,
    type: candidate.type,
    subject: candidate.subject,
    content: candidate.content,
    importance: candidate.importance,
    expiry: candidate.expiry,
    tags: candidate.tags,
    directive_polarity: candidate.directivePolarity,
    directive_trigger: candidate.directiveTrigger,
    quality_score: 0.5,
    recall_count: 0,
    content_hash: contentHash,
    norm_content_hash: normContentHash,
    retired: false,
    created_at: lifecycle.createdAt,
    updated_at: lifecycle.createdAt,
  };

  if (lifecycle.validFrom) {
    durable.valid_from = lifecycle.validFrom;
  }

  if (claimKey) {
    durable.claim_key = claimKey;
    durable.claim_key_raw = claimKey;
    durable.claim_key_status = lifecycle.claimKeyStatus;
    durable.claim_key_source = lifecycle.claimKeySource;
    durable.claim_key_confidence = lifecycle.claimKeyConfidence;
    durable.claim_key_rationale = lifecycle.claimKeyRationale;
    durable.claim_support_source_kind = primaryEvidence?.kind ?? "episode";
    if (primaryEvidence?.locator) {
      durable.claim_support_locator = primaryEvidence.locator;
    }
    if (primaryEvidence?.observedAt) {
      durable.claim_support_observed_at = primaryEvidence.observedAt;
    }
    durable.claim_support_mode = "inferred";
  }

  return durable;
}

/** Resolves the evidence lower bound from the last completed dreaming run. */
async function resolveExtractSince(port: DreamPort, fullBacklog: boolean): Promise<string> {
  if (fullBacklog) {
    return "1970-01-01T00:00:00.000Z";
  }

  const lastRun = await port.getLastRun();
  const lastSuccessfulAt = lastRun?.status === "completed" ? lastRun.completedAt : null;
  return lastSuccessfulAt ?? "1970-01-01T00:00:00.000Z";
}

/** Wraps one episode summary in a single-message transcript for mining. */
function buildEpisodeTranscript(episode: DreamEpisodeEvidence): ParsedTranscript {
  return {
    messages: [
      {
        index: 0,
        role: "assistant",
        text: episode.summary,
        timestamp: episode.endedAt ?? episode.startedAt,
      },
    ],
    metadata: {
      messageCount: 1,
      transcriptHash: episode.id,
      startedAt: episode.startedAt,
      ...(episode.endedAt ? { endedAt: episode.endedAt } : {}),
      ...(episode.sessionId ? { sessionId: episode.sessionId } : {}),
      ...(episode.project ? { project: episode.project } : {}),
    },
    warnings: [],
  };
}

/** Converts one extracted entry into a mined candidate with episode provenance. */
function toMinedCandidate(entry: StoreDurableInput, episode: DreamEpisodeEvidence): MinedCandidate {
  return {
    type: entry.type,
    subject: entry.subject,
    content: entry.content,
    importance: typeof entry.importance === "number" ? entry.importance : DEFAULT_CANDIDATE_IMPORTANCE,
    expiry: entry.expiry ?? "permanent",
    tags: entry.tags ?? [],
    directivePolarity: entry.directive_polarity,
    directiveTrigger: entry.directive_trigger,
    claimKey: normalizeCandidateClaimKey(entry.claim_key),
    evidenceRefs: [
      {
        kind: "episode",
        locator: episode.id,
        observedAt: episode.endedAt ?? episode.startedAt,
      },
    ],
  };
}

/** Canonicalizes one optional candidate claim key, dropping invalid values. */
function normalizeCandidateClaimKey(rawClaimKey: string | undefined): string | null {
  if (!rawClaimKey) {
    return null;
  }

  const normalized = normalizeClaimKey(rawClaimKey);
  return normalized.ok ? normalized.value.claimKey : null;
}

/** Reads accumulated cost usage from the mining LLM wrapper. */
function readUsage(llm: CostMeteredLlm): DreamExtractUsage {
  const usage = llm.metadata?.usage;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    estimatedCostUsd: usage?.totalCost ?? 0,
  };
}
