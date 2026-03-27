import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../src/adapters/embeddings.js";
import { readConfig } from "../src/config.js";
import { composeEmbeddingText } from "../src/core/store/embedding-text.js";
import type { StoreEntryInput } from "../src/core/types.js";

const config = readConfig();
const client = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));

const entries: StoreEntryInput[] = [
  {
    type: "preference",
    subject: "architecture priority",
    content: "Jim wants architecture to be treated as a first-class concern, with correctness prioritized over rushing implementation.",
    importance: 8,
    expiry: "permanent",
    tags: ["architecture"],
  },
  {
    type: "preference",
    subject: "architecture first preference",
    content: "Jim prefers major pipeline unification and architecture cleanup to happen before feature work when those changes affect system foundations.",
    importance: 8,
    expiry: "permanent",
    tags: ["architecture"],
  },
  {
    type: "preference",
    subject: "architecture-first approach",
    content:
      "Jim prefers architecture and boundary changes to happen before feature work, because clean foundations should shape later implementation details.",
    importance: 8,
    expiry: "permanent",
    tags: ["architecture"],
  },
  {
    type: "lesson",
    subject: "ingest pipeline decomposition",
    content: "The ingest workflow function centralizes session lifecycle, pipeline orchestration, bulk-mode teardown, and error aggregation in one place.",
    importance: 8,
    expiry: "permanent",
    tags: ["ingest"],
  },
  {
    type: "lesson",
    subject: "cleanup phase ordering",
    content: "Cleanup stages that still need the session or database must run before session close.",
    importance: 6,
    expiry: "permanent",
    tags: ["cleanup"],
  },
  {
    type: "decision",
    subject: "desktop agent memory integration",
    content: "The planned desktop agent app should use agenr as its default durable memory layer.",
    importance: 8,
    expiry: "permanent",
    tags: ["desktop"],
  },
];

const texts = entries.map((e) => composeEmbeddingText(e));
const vectors = await client.embed(texts);

/**
 * Computes cosine similarity for two embedding vectors.
 *
 * @param a First vector.
 * @param b Second vector.
 * @returns Similarity score in the unit interval.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

console.log("\nAll pairwise similarities:");
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const sim = cosine(vectors[i]!, vectors[j]!);
    console.log(`  [${sim.toFixed(4)}] "${entries[i]!.subject}" <-> "${entries[j]!.subject}"`);
  }
}
