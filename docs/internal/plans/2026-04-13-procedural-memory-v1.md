# Procedural Memory v1

## Objective

Make agenr the canonical source for reusable agent know-how so an agent can answer `how do I do X?` with a durable, structured, reviewable procedure instead of reconstructing method from scattered facts, lessons, and episodes.

This plan intentionally separates procedural memory from semantic and episodic memory:

- semantic memory answers what is true
- episodic memory answers what happened
- procedural memory answers how to do something

The v1 goal is authoritative procedural recall, not execution orchestration.

## Why a Separate Subsystem

Procedural memory should not be another `EntryType`.

The existing `entries` system is optimized for declarative durable knowledge with claim-key lifecycle and hybrid semantic recall. That is the right fit for facts, decisions, preferences, and lessons. It is not the right fit for durable stepwise method.

The test for a first-class subsystem is now met:

- procedures need a different stored shape than semantic entries
- procedures need different read-side ranking than semantic recall
- procedures should become the primary answer to `how do I do X?`
- procedures need their own lifecycle and revision story
- future harness projections should map from procedures, not from ad hoc mixtures of entries and docs

## Scope

v1 includes:

- repo-authored procedures in YAML
- canonical normalized JSON persistence in a dedicated `procedures` table
- a small structured action vocabulary
- a small declarative condition vocabulary
- dedicated procedure recall
- unified recall routing across `entries`, `episodes`, and `procedures`
- seed procedures for real repo workflows

v1 does not include:

- procedure composition such as `use_procedure`
- playbooks or multi-procedure orchestration
- loops, arbitrary expressions, or general workflow programming
- automatic procedure synthesis from episodes
- stored first-class capabilities
- harness wrapper replacement or direct procedure execution

## Core Design

### Source of authority

The runtime answer may be stitched from multiple memory sources, but it should resolve to one canonical stored procedure revision.

That means:

- YAML is the authoring source
- normalized JSON is the runtime canonical form
- the database is the durable procedural-memory store
- entries, episodes, docs, and skills are supporting provenance, not the primary answer

### Repo first

Procedures should live in the repo so they are reviewable and intentional.

Proposed source layout:

```text
procedures/
  agenr-release.yaml
  surgeon-review.yaml
  sandbox-validation.yaml
  claim-key-scenario-run.yaml
  openclaw-local-plugin-check.yaml
```

Each file is curated source material. agenr compiles these files into normalized procedure records for durable recall.

### Authoring versus runtime format

Use:

- YAML for authoring
- JSON for canonical normalized storage and tool/runtime use

Rationale:

- YAML is easier for humans to read and review
- JSON is easier to validate, hash, diff semantically, query, and pass through agent-tool boundaries
- one normalized JSON shape avoids runtime ambiguity

## Procedure Model

Each procedure should have:

- stable identity: `id`, `procedure_key`, `title`
- intent: `goal`, `when_to_use`, `when_not_to_use`
- requirements: `prerequisites`
- method: ordered `steps`
- completion: `verification`
- safety: `failure_modes`
- provenance: `sources`
- lifecycle: `retired`, `retired_reason`, `superseded_by`, timestamps, revision hash

### Canonical JSON shape

```json
{
  "procedure_key": "agenr/release",
  "title": "Release agenr and publish packages",
  "goal": "Cut a release and publish packages safely.",
  "when_to_use": [
    "You need to ship a new agenr release."
  ],
  "when_not_to_use": [
    "You only need a local build or dry-run validation."
  ],
  "prerequisites": [
    "Local master is available.",
    "Publish credentials are configured."
  ],
  "steps": [
    {
      "id": "read-release-skill",
      "kind": "read_reference",
      "instruction": "Read the local agenr release workflow before editing release files.",
      "ref": {
        "kind": "skill",
        "path": "/Users/jmartin/.codex/skills/agenr-release/SKILL.md"
      }
    },
    {
      "id": "run-checks",
      "kind": "run_command",
      "instruction": "Run the required repo validation command before release work.",
      "command": "pnpm check"
    }
  ],
  "verification": [
    "Published package versions match the intended release.",
    "master was fast-forwarded."
  ],
  "failure_modes": [
    "Validation fails before publish.",
    "Publish partially succeeds."
  ],
  "sources": [
    {
      "kind": "skill",
      "path": "/Users/jmartin/.codex/skills/agenr-release/SKILL.md"
    }
  ]
}
```

## YAML Authoring Shape

The author-facing YAML should map directly onto the canonical JSON shape.

Example:

```yaml
procedure_key: agenr/release
title: Release agenr and publish packages
goal: Cut a release and publish packages safely.
when_to_use:
  - You need to ship a new agenr release.
when_not_to_use:
  - You only need a local build or dry-run validation.
prerequisites:
  - Local master is available.
  - Publish credentials are configured.
steps:
  - id: read-release-skill
    kind: read_reference
    instruction: Read the local agenr release workflow before editing release files.
    ref:
      kind: skill
      path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md
  - id: run-checks
    kind: run_command
    instruction: Run the required repo validation command before release work.
    command: pnpm check
verification:
  - Published package versions match the intended release.
  - master was fast-forwarded.
failure_modes:
  - Validation fails before publish.
  - Publish partially succeeds.
sources:
  - kind: skill
    path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md
```

The loader should reject unknown fields and produce a deterministic normalized JSON payload.

## Step Model

v1 procedures should use a small structured action vocabulary.

Supported step kinds:

- `run_command`
- `read_reference`
- `inspect_state`
- `edit_file`
- `ask_user`
- `invoke_tool`
- `verify`

Each step should include:

- `id`
- `kind`
- `instruction`

And then kind-specific fields as needed, for example:

- `command` for `run_command`
- `ref` for `read_reference`
- `target` or `query` for `inspect_state`
- `path` plus edit intent for `edit_file`
- `prompt` for `ask_user`
- `tool` and arguments for `invoke_tool`
- `checks` for `verify`

v1 should stay descriptive. These step kinds exist to make procedures readable, recallable, and future-projectable into harness-specific skills. They are not a commitment that agenr itself will execute procedures in v1.

## Conditions

v1 supports conditions, but only in a tightly bounded declarative form.

Allowed condition kinds:

- `harness_is`
- `tool_available`
- `file_exists`
- `path_exists`
- `env_flag`
- `repo_state`
- `user_confirmed`

Supported usage:

- per-step `conditions`
- optional `stop_if` for safety checks

Not supported in v1:

- loops
- nested branching trees
- arbitrary boolean expressions
- freeform script evaluation
- retries or backoff semantics

### Example

```yaml
steps:
  - id: publish-from-codex
    kind: invoke_tool
    instruction: Publish through the Codex-specific publish path when available.
    tool: codex.publish
    conditions:
      - kind: harness_is
        value: codex

  - id: publish-manual
    kind: run_command
    instruction: Publish with the manual CLI path when no harness-specific publish tool exists.
    command: pnpm publish -r
    conditions:
      - kind: harness_is
        value: cli
```

The condition model should remain simple enough that procedures stay reviewable and portable.

## Storage Model

Procedures should be stored in a dedicated table, not mixed into `entries`.

Proposed table shape:

```sql
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  procedure_key TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  body_json TEXT NOT NULL,
  recall_text TEXT NOT NULL,
  tags TEXT,
  revision_hash TEXT NOT NULL,
  source_file TEXT,
  source_hash TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT,
  retired_reason TEXT,
  superseded_by TEXT REFERENCES procedures(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

v1 should also add:

- a unique index on active `procedure_key`
- FTS over `title` and `recall_text`
- optional vector search on `recall_text`

`body_json` is the canonical normalized procedure object. `recall_text` is a deterministic flattened representation used for embedding and recall ranking.

## Ingest and Compilation Pipeline

The write path for v1 should be repo-driven rather than agent-authored.

Proposed flow:

1. discover YAML procedure files in `procedures/`
2. parse YAML
3. validate against the procedure schema
4. normalize into canonical JSON
5. generate deterministic `recall_text`
6. compute revision and source hashes
7. embed `recall_text`
8. upsert into the `procedures` table
9. supersede prior active revision for the same `procedure_key` when needed

This should be implemented as a dedicated app-layer workflow. Do not overload the durable `entries` store pipeline with procedure compilation.

## Recall Model

Procedures need their own recall behavior.

Procedure recall should optimize for:

- `how do I do X`
- `what steps should I take`
- `how should I release/publish/run/review X`
- `runbook` and `procedure` phrasing
- stable reusable method over recent session narrative

That means:

- procedure recall is a separate backend
- unified recall routes procedural queries to `procedures` first
- entries and episodes remain supporting context, not the primary procedural answer

### Unified recall changes

Current unified recall routes across `entries` and `episodes`. v1 should extend that to `entries`, `episodes`, and `procedures`.

Add:

- a new queried backend: `procedures`
- a new procedural-intent detector for phrases such as `how do I`, `what steps`, `how should I`, `runbook`, `procedure`, `release`, and `publish`
- procedure-first result shaping when a canonical procedure is found

The OpenClaw recall tool should return a procedure answer as a compact structured response containing:

- procedure title
- goal
- applicability
- prerequisites
- ordered steps
- verification
- warnings or failure modes

It should not flatten a procedure into a generic semantic-memory snippet.

## Relationship to Skills and Harnesses

The long-term direction is for agenr to become the canonical brain for reusable agent know-how while harnesses keep their runtime-specific wrappers.

Split of responsibility:

- agenr owns canonical procedures
- Codex, Claude, OpenClaw, and other harnesses own wrapper and execution semantics
- future capability views are derived from procedures plus harness availability facts

v1 should not replace harness skills. It should make future harness projection possible.

That is why the step model and condition model should be structured from day one.

## Provenance

Every procedure should preserve source links so authors and future tooling can answer:

- where did this procedure come from
- what docs or skills informed it
- what changed between revisions

Source kinds may include:

- `skill`
- `doc`
- `entry`
- `episode`
- `repo_file`
- `manual`

v1 does not need automated provenance extraction, but it should preserve explicitly authored provenance in the schema.

## Evaluation

Procedural memory should ship with explicit retrieval evals.

Success criteria should be framed around authoritative answers, not loose relevance.

Examples:

- query: `how do I do an agenr release`
- expected primary answer: `agenr/release`

- query: `what steps do I take to review surgeon proposals`
- expected primary answer: the surgeon review procedure

- query: `how do I rerun the claim-key scenario harness`
- expected primary answer: the claim-key scenario procedure

The existing internal recall-eval seam should expand to support procedure fixtures and unified-path procedural cases.

## Seed Procedures

Seed v1 with a small curated set of real procedures:

- `agenr/release`
- `agenr/surgeon-review`
- `agenr/sandbox-validation`
- `agenr/claim-key-scenario-run`
- `agenr/openclaw-local-plugin-check`

The seed set should pressure-test:

- command-heavy procedures
- review/checklist procedures
- harness-conditional steps
- repo reference links
- verification and failure modes

## Implementation Order

1. Define the procedure schema and normalization rules.
2. Add repo YAML source files and a loader.
3. Add `Procedure` types and `ProcedureDatabasePort`.
4. Add schema support and a libSQL persistence adapter.
5. Add a compilation workflow from repo YAML into the DB.
6. Add dedicated procedure recall.
7. Extend unified recall routing and result shaping.
8. Add OpenClaw formatting for procedure answers.
9. Seed the initial procedure corpus.
10. Add retrieval evals for procedural queries.

## Open Questions Deferred to v2

- procedure composition such as `use_procedure`
- playbooks that orchestrate multiple procedures
- generated harness skill wrappers
- capability read models
- automatic promotion from episodes into procedures
- direct procedure execution or workflow-engine semantics

## Recommendation

Ship procedural memory v1 as a separate first-class subsystem with repo-authored YAML, canonical JSON storage, dedicated recall, a small action vocabulary, and bounded declarative conditions.

That is the smallest design that:

- preserves a clean memory taxonomy
- answers `how do I do X` reliably
- keeps harness-specific execution details out of agenr
- leaves a clean path toward future skill and capability projection
