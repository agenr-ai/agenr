# Consolidation in agenr

Consolidation keeps memory quality high as the database grows. Without it, near-duplicates accumulate, stale temporary entries keep surfacing, and recall quality degrades over time. agenr’s consolidation pipeline improves signal-to-noise while preserving provenance.

## Why Consolidation Matters

- Knowledge hygiene: removes low-value decay and duplicate clutter.
- Recall quality: better ranking outcomes from cleaner candidate sets.
- Storage efficiency: fewer redundant active entries and tags/relations.
- Safety: merge decisions are verified and reversible.

## Two-Tier Architecture

```text
+--------------------------+
| Tier 1: Rules-based      |
| expire + dedup + cleanup |
+------------+-------------+
             |
             v
+------------+-------------+
| Tier 2: LLM-assisted     |
| cluster + merge + verify |
+------------+-------------+
             |
             v
+------------+-------------+
| Active canonical memory  |
| + flagged review queue   |
+--------------------------+
```

Command entrypoint:
- `src/commands/consolidate.ts`

## Tier 1: Rules-Based Cleanup

Source:
- `src/consolidate/rules.ts`

### 1) Expired entry pruning

- Applies to active entries with expiry `session-only` or `temporary`.
- Computes recency score using `recency()` from `src/db/recall.ts`.
- Marks entry as expired when score drops below `0.05` (`EXPIRE_THRESHOLD`).
- Expiration is non-destructive: `superseded_by = 'EXPIRED'` sentinel.

### 2) Near-exact duplicate merge

- Candidate match threshold: cosine `> 0.95` (`MERGE_SIMILARITY_THRESHOLD`).
- Merge only when both entries have same `type` and normalized `subject`.
- Uses union-find grouping + `validateCluster()` to prevent chain-merges:
- max cluster size `12`
- diameter floor `0.93` (`0.95 - 0.02`)
- Keeper selection prefers higher `confirmations + recall_count`, then newer `created_at`.

### 3) Orphaned relations cleanup

- Removes non-`supersedes` relations that reference entries already superseded.

## Tier 2: LLM-Assisted Batch Consolidation

Sources:
- `src/consolidate/cluster.ts`
- `src/consolidate/merge.ts`
- `src/consolidate/verify.ts`

### Clustering

- Union-find based clustering over active embedded entries.
- Default thresholds:
- same-type threshold: `0.85` (`DEFAULT_SIMILARITY_THRESHOLD`)
- cross-type same-subject threshold: `0.89` (`CROSS_TYPE_SUBJECT_THRESHOLD`)
- max entries per validated cluster: `12` (`DEFAULT_MAX_CLUSTER_SIZE`)
- Additional idempotency guard:
- skips recently consolidated merged entries for `7` days by default (`DEFAULT_IDEMPOTENCY_DAYS`)

### Merging

- For each cluster, model is prompted to call tool `merge_entries` with one canonical entry.
- Merge payload includes canonical `content`, `subject`, `type`, `confidence`, `expiry`, `tags`, and notes.
- Type is forced to dominant source-cluster type (`chooseDominantType`) to reduce ontology drift.

### Verification

Semantic verification is embedding-based before commit:
- per-source check: merged embedding cosine must be `>= 0.65` to every source embedding
- centroid check: merged embedding cosine must be `>= 0.75` to cluster centroid

If verification fails:
- merge is flagged (not committed)
- record is written to review queue:
- `~/.agenr/review-queue.json`

Review queue command:
- `agenr consolidate --show-flagged`

## Non-Destructive Guarantees

All source entries are preserved:
- source entries are marked via `superseded_by`
- canonical merged entry is inserted as a new row
- `supersedes` relations are created from canonical -> source

No source content is hard-deleted by Tier 2 merge.

## Reversibility and Provenance

Source snapshot data is stored in `entry_sources`:
- `original_confirmations`
- `original_recall_count`

This allows rollback/audit logic to reconstruct original support metrics for merged entries.

## CLI Usage

```bash
# Full two-tier consolidation
pnpm exec agenr consolidate

# Tier 1 only
pnpm exec agenr consolidate --rules-only

# Preview changes without writing
pnpm exec agenr consolidate --dry-run

# Inspect flagged merges
pnpm exec agenr consolidate --show-flagged
```

Useful advanced flags:
- `--min-cluster <n>`
- `--sim-threshold <n>`
- `--type <type>`
- `--idempotency-days <n>`
- `--json`

## Calibration Data

Prior calibration run data used during development:
- dataset size: `2,968` entries
- clusters: `30`
- consolidation result: `108 -> 30` entries
- flagged merges: `0`

Provenance note:
- These values are historical run artifacts from prompt/spec materials (`docs/prompts/v0.4.0-docs-suite.md` and related consolidation prompt files), not a deterministic fixture in the automated test suite.
