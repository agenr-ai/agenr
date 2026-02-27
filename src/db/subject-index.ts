import type { Client } from "@libsql/client";

function parseSubjectKey(subjectKey: string): { entity: string; attribute: string } | null {
  const trimmed = subjectKey.trim();
  if (!trimmed) {
    return null;
  }

  const slashParts = trimmed.split("/", 2);
  if (slashParts.length === 2) {
    const entity = slashParts[0]?.trim().toLowerCase();
    const attribute = slashParts[1]?.trim().toLowerCase();
    if (entity && attribute) {
      return { entity, attribute };
    }
  }

  const legacyMatch = /^person:([^|]+)\|attr:(.+)$/i.exec(trimmed);
  if (!legacyMatch) {
    return null;
  }

  const entity = legacyMatch[1]?.trim().toLowerCase();
  const attribute = legacyMatch[2]?.trim().toLowerCase();
  if (!entity || !attribute) {
    return null;
  }

  return { entity, attribute };
}

function normalizeAttributeToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "change" || normalized === "changes" || normalized === "ownership") {
    return "";
  }

  if (normalized.endsWith("ary") && normalized.length > 3) {
    return normalized.slice(0, -3);
  }

  return normalized;
}

function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(
    a
      .split("_")
      .map((token) => normalizeAttributeToken(token))
      .filter((token) => token.length > 0),
  );
  const tokensB = new Set(
    b
      .split("_")
      .map((token) => normalizeAttributeToken(token))
      .filter((token) => token.length > 0),
  );
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

export class SubjectIndex {
  private index = new Map<string, Set<string>>();
  private initialized = false;

  /**
   * Rebuild the index from the database. Scans all active entries with
   * a non-null subject_key.
   */
  async rebuild(db: Client): Promise<void> {
    const newIndex = new Map<string, Set<string>>();
    const result = await db.execute(
      "SELECT id, subject_key FROM entries WHERE subject_key IS NOT NULL AND retired = 0 AND superseded_by IS NULL",
    );
    for (const row of result.rows) {
      const id = String((row as Record<string, unknown>).id ?? "");
      const key = String((row as Record<string, unknown>).subject_key ?? "");
      if (id && key) {
        let set = newIndex.get(key);
        if (!set) {
          set = new Set();
          newIndex.set(key, set);
        }
        set.add(id);
      }
    }
    this.index = newIndex;
    this.initialized = true;
  }

  /**
   * Lazily initialize - rebuild from DB on first use if not yet initialized.
   */
  async ensureInitialized(db: Client): Promise<void> {
    if (!this.initialized) {
      await this.rebuild(db);
    }
  }

  /**
   * Look up all active entry IDs for a given subject key.
   */
  lookup(subjectKey: string): string[] {
    const set = this.index.get(subjectKey);
    return set ? [...set] : [];
  }

  /**
   * Fuzzy lookup by subject key. Entity must match exactly, attribute uses token overlap.
   */
  fuzzyLookup(subjectKey: string, threshold = 0.6): string[] {
    const parsed = parseSubjectKey(subjectKey);
    if (!parsed) {
      return [];
    }

    const matches = new Set<string>();
    for (const [key, ids] of this.index.entries()) {
      const indexed = parseSubjectKey(key);
      if (!indexed || indexed.entity !== parsed.entity) {
        continue;
      }

      const score = tokenOverlap(parsed.attribute, indexed.attribute);
      if (score < threshold) {
        continue;
      }

      for (const id of ids) {
        matches.add(id);
      }
    }

    return [...matches];
  }

  /**
   * Lookup entries with the same attribute across different entities.
   */
  crossEntityLookup(subjectKey: string): string[] {
    const parsed = parseSubjectKey(subjectKey);
    if (!parsed) {
      return [];
    }

    const matches = new Set<string>();
    for (const [key, ids] of this.index.entries()) {
      const indexed = parseSubjectKey(key);
      if (!indexed) {
        continue;
      }
      if (indexed.attribute !== parsed.attribute || indexed.entity === parsed.entity) {
        continue;
      }

      for (const id of ids) {
        matches.add(id);
      }
    }

    return [...matches];
  }

  /**
   * Add an entry to the index.
   */
  add(subjectKey: string, entryId: string): void {
    let set = this.index.get(subjectKey);
    if (!set) {
      set = new Set();
      this.index.set(subjectKey, set);
    }
    set.add(entryId);
  }

  /**
   * Remove an entry from the index (on retirement or supersession).
   */
  remove(subjectKey: string, entryId: string): void {
    const set = this.index.get(subjectKey);
    if (set) {
      set.delete(entryId);
      if (set.size === 0) {
        this.index.delete(subjectKey);
      }
    }
  }

  /**
   * Get index statistics.
   */
  stats(): { keys: number; entries: number } {
    let entries = 0;
    for (const set of this.index.values()) {
      entries += set.size;
    }
    return { keys: this.index.size, entries };
  }

  /**
   * Clear the index and mark as uninitialized.
   */
  clear(): void {
    this.index.clear();
    this.initialized = false;
  }

  /**
   * Check if the index has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
