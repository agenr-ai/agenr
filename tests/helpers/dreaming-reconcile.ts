import { createClient, type Client } from "@libsql/client";
import { createDreamPort } from "../../src/adapters/db/dreaming-port.js";
import type { DreamProgressEvent } from "../../src/app/dreaming/progress.js";
import { initSchema } from "../../src/adapters/db/schema.js";
import type { AgenrConfig } from "../../src/config.js";
import type { CostMeteredLlm } from "../../src/app/dreaming/ports.js";
import type { EmbeddingPort, LlmPort } from "../../src/core/ports.js";
import type { Durable } from "../../src/core/types.js";
import { runDream } from "../../src/app/dreaming/service.js";

export const TEST_NOW = new Date("2026-04-04T15:00:00.000Z");

/** Embedding dimension matching the durables `F32_BLOB(1024)` column. */
const TEST_EMBEDDING_DIMENSIONS = 1024;

/**
 * Builds a deterministic embedding port for dreaming tests.
 *
 * Returns a stable pseudo-random unit-ish vector per text so inserts populate
 * the vector column without any network call. Values are derived from the text
 * so identical content yields identical vectors.
 *
 * @returns Embedding port producing deterministic 1024-dim vectors.
 */
export function createDeterministicEmbedding(): EmbeddingPort {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map((text) => deterministicVector(text)),
  };
}

/** Derives a stable 1024-dim vector from a seed string. */
function deterministicVector(seed: string): number[] {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const vector = new Array<number>(TEST_EMBEDDING_DIMENSIONS);
  for (let index = 0; index < TEST_EMBEDDING_DIMENSIONS; index += 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822519);
    vector[index] = ((hash >>> 0) % 1000) / 1000;
  }
  return vector;
}

export async function runClaimKeyPass(
  client: Client,
  overrides: {
    apply?: boolean;
    verbose?: boolean;
    config?: AgenrConfig | null;
    createClaimExtractionLlm?: () => CostMeteredLlm;
    reportProgress?: (event: DreamProgressEvent) => void;
    includeShadowTelemetry?: boolean;
  } = {},
) {
  return runDream(
    {
      tier: "standard",
      apply: overrides.apply === true,
      verbose: overrides.verbose === true,
      json: false,
      includeShadowTelemetry: overrides.includeShadowTelemetry === true,
    },
    {
      port: createDreamPort(client),
      config: overrides.config ?? null,
      now: () => TEST_NOW,
      ...(overrides.createClaimExtractionLlm ? { createClaimExtractionLlm: overrides.createClaimExtractionLlm } : {}),
      ...(overrides.reportProgress ? { reportProgress: overrides.reportProgress } : {}),
    },
  );
}

export async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}

export async function insertDurable(client: Client, overrides: Partial<Durable> & Pick<Durable, "id" | "subject">): Promise<void> {
  const durable = buildDurable(overrides);
  await client.execute({
    sql: `
      INSERT INTO durables (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        tags,
        source_file,
        source_context,
        embedding,
        content_hash,
        norm_content_hash,
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        valid_from,
        valid_to,
        claim_key,
        claim_key_raw,
        claim_key_status,
        claim_key_source,
        claim_key_confidence,
        claim_key_rationale,
        claim_support_source_kind,
        claim_support_locator,
        claim_support_observed_at,
        claim_support_mode,
        supersession_kind,
        supersession_reason,
        cluster_id,
        user_id,
        project,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      durable.id,
      durable.type,
      durable.subject,
      durable.content,
      durable.importance,
      durable.expiry,
      JSON.stringify(durable.tags),
      durable.source_file ?? null,
      durable.source_context ?? null,
      null,
      durable.content_hash ?? null,
      durable.norm_content_hash ?? null,
      null,
      durable.quality_score,
      durable.recall_count,
      durable.last_recalled_at ?? null,
      durable.superseded_by ?? null,
      durable.valid_from ?? null,
      durable.valid_to ?? null,
      durable.claim_key ?? null,
      durable.claim_key_raw ?? null,
      durable.claim_key_status ?? null,
      durable.claim_key_source ?? null,
      durable.claim_key_confidence ?? null,
      durable.claim_key_rationale ?? null,
      durable.claim_support_source_kind ?? null,
      durable.claim_support_locator ?? null,
      durable.claim_support_observed_at ?? null,
      durable.claim_support_mode ?? null,
      durable.supersession_kind ?? null,
      durable.supersession_reason ?? null,
      durable.cluster_id ?? null,
      durable.user_id ?? null,
      durable.project ?? null,
      durable.retired ? 1 : 0,
      durable.retired_at ?? null,
      durable.retired_reason ?? null,
      durable.created_at,
      durable.updated_at,
    ],
  });
}

export function buildDurable(overrides: Partial<Durable> & Pick<Durable, "id" | "subject">): Durable {
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content ?? overrides.subject,
    importance: overrides.importance ?? 5,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: undefined,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
  };
}

export class MockClaimLlm implements LlmPort {
  public readonly metadata = {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    },
  };

  public constructor(private readonly responder: (callIndex: number, systemPrompt: string, userMessage: string) => unknown) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used in these tests.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const callIndex = this.metadata.usage.inputTokens;
    this.metadata.usage.inputTokens += 1;
    const response = this.responder(callIndex, systemPrompt, userMessage);
    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
}
