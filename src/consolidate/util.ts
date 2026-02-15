export interface ActiveEmbeddedEntry {
  id: string;
  type: string;
  subject: string;
  content: string;
  embedding: number[];
  confidence?: string;
  confirmations: number;
  recallCount: number;
  createdAt: string;
  mergedFrom?: number;
  consolidatedAt?: string;
}

export class UnionFind {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
    }
  }

  find(value: string): string {
    const current = this.parent.get(value) ?? value;
    if (current === value) {
      this.parent.set(value, value);
      return value;
    }
    const root = this.find(current);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootB, rootA);
    }
  }
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function averageEmbedding(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }

  const size = embeddings[0]?.length ?? 0;
  if (size === 0) {
    return [];
  }

  const sums = new Array<number>(size).fill(0);
  let count = 0;

  for (const embedding of embeddings) {
    if (embedding.length !== size) {
      continue;
    }
    for (let i = 0; i < size; i += 1) {
      sums[i] += embedding[i];
    }
    count += 1;
  }

  if (count === 0) {
    return [];
  }

  return sums.map((sum) => sum / count);
}

/**
 * Validate a cluster by checking pairwise similarity diameter.
 * Removes entries that violate the diameter floor until all pairs pass.
 * Enforces max cluster size by keeping the most-connected entries.
 */
export function validateCluster(
  group: ActiveEmbeddedEntry[],
  maxSize: number,
  diameterFloor: number,
): ActiveEmbeddedEntry[] {
  let current = [...group];

  if (current.length > maxSize) {
    const scored = current.map((entry) => {
      const avgSim =
        current
          .filter((other) => other.id !== entry.id)
          .reduce((sum, other) => sum + cosineSim(entry.embedding, other.embedding), 0) /
        (current.length - 1);
      return { entry, avgSim };
    });
    scored.sort((a, b) => b.avgSim - a.avgSim);
    current = scored.slice(0, maxSize).map((item) => item.entry);
  }

  let maxIterations = current.length;
  while (current.length >= 2 && maxIterations-- > 0) {
    let worstPairSim = 1;
    let worstEntryId: string | null = null;

    for (let i = 0; i < current.length; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        const sim = cosineSim(current[i].embedding, current[j].embedding);
        if (sim < worstPairSim) {
          worstPairSim = sim;
          const scoreI = current[i].confirmations + current[i].recallCount;
          const scoreJ = current[j].confirmations + current[j].recallCount;
          worstEntryId = scoreI <= scoreJ ? current[i].id : current[j].id;
        }
      }
    }

    if (worstPairSim >= diameterFloor) {
      break;
    }

    if (worstEntryId) {
      current = current.filter((entry) => entry.id !== worstEntryId);
    }
  }

  return current;
}
