import type { Client } from "@libsql/client";

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
