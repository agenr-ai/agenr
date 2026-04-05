# Claim-key threshold-only supported cohort audit

## Bottom line

For Surgeon run `717dda95-ea55-4b60-b571-df31417055cd`, the threshold-only supported cohort is real and cleanly surfaced, but it is **not yet cleanly separable into a safe new auto-apply lane**.

The 42-case cohort breaks into:

- **30** `trusted_family_grounded_alignment` cases
- **12** relaxed one-sibling `trusted_family_stable_slot` cases

Inside the 30 grounded-family cases, only **9** look like a plausible top-end stratum:

- `support_family_reuse_count >= 20`
- grounded-family ratio `support_grounded_family_reuse_count / support_family_reuse_count >= 0.70`

That 9-case slice is the only place where a future supported sub-lane might live. But even there, the evidence is still mostly:

- strong local lexical alignment to the target entry
- broad grounded reuse from the same entity family
- no template support
- no stable-slot support

The class itself does not prove that sibling entries actually reuse the same slot shape. In the concrete rows I inspected, sibling slot echo is often weak or generic (`session`, `project`, `agenr`) rather than truly deterministic reuse of the proposed attribute. Because of that, I do **not** recommend a new auto-apply rule yet.

## What I inspected

- Run and proposal rows in `surgeon_runs`, `surgeon_run_proposals`, and `surgeon_run_actions` for run `717dda95-ea55-4b60-b571-df31417055cd`
- Support-class and blocker serialization in `src/app/surgeon/claim-key-quality.ts`
- Representative target entries and supporting sibling entries from `entries`

Relevant code behavior:

- `trusted_family_grounded_alignment` fires when there is local grounding, at least one grounded family sibling, and strong entity-plus-attribute lexical alignment.
- It does **not** require `template_support` or `stable_slot_support`.
- Relaxed one-sibling `trusted_family_stable_slot` cases require one grounded sibling plus strong dual lexical alignment, but they still remain a single-sibling lane.

That distinction matters: the threshold-only cohort is not a hidden exact-reuse group waiting for a lower threshold. Most of it is still a model-led proposal lane with structured support, not deterministic reuse.

## Cohort summary

The 42 threshold-only supported cases are not one homogeneous pile.

They split into four evidence strata:

1. **High-density grounded-family alignment: 9**
   - Large grounded families with `family_reuse_count >= 20` and grounded ratio `>= 0.70`
   - Examples: `openclaw/continuity_doctrine`, `openclaw/session_start_context_flag`, `jim/project_value_prop_focus`
   - This is the only bucket that looks even plausibly promotable later

2. **Large but grounding-diluted grounded-family alignment: 6**
   - Large entity families, but grounded ratio `< 0.70`
   - Examples: `agenr/entry_types`, `openclaw/recall_validation_scope`, `agenr/public_demo_api_key`
   - These read like broad entity-family support, not narrow slot support

3. **Thin grounded-family alignment tail: 15**
   - Grounded-family alignment, but family reuse is small (`<= 5`)
   - Ten of these are exactly one grounded sibling
   - Examples: `recall_ranking_pipeline/specificity_signal`, `watcher/session_correlation_fallback`, `cli/destructive_command_arming_guardrail`

4. **Relaxed one-sibling stable-slot cases: 12**
   - All have `support_family_reuse_count = 1` and `support_grounded_family_reuse_count = 1`
   - Examples: `session_start_recall/query_seeding_strategy`, `documentation/docs_style_preference`, `recall_retrieval/query_shaping_strategy`
   - Structurally plausible, but still the most brittle supported lane

That gives the full 42:

- `9 + 6 + 15 + 12 = 42`

## Bucket details

### 1. High-density grounded-family alignment: 9

This is the strongest-looking stratum:

- family reuse counts run from **34 to 62**
- grounded-family counts run from **24 to 58**
- grounded ratio runs from **0.706 to 0.935**
- confidence runs from **0.70 to 0.78**

Representative rows:

- `openclaw/continuity_doctrine`
  - `family_reuse_count = 34`
  - `grounded_family_reuse_count = 26`
  - confidence `0.78`
  - supporting siblings include `openclaw/continuity_and_episode_summaries_are_separate_artifacts`

- `openclaw/session_start_context_flag`
  - `family_reuse_count = 34`
  - `grounded_family_reuse_count = 28`
  - confidence `0.74`
  - supporting siblings include several `openclaw/*session*` and `*context*` entries

- `jim/project_value_prop_focus`
  - `family_reuse_count = 62`
  - `grounded_family_reuse_count = 58`
  - confidence `0.74`

Why this bucket still does not justify auto-apply yet:

- These are still `trusted_family_grounded_alignment`, not template or stable-slot cases.
- The support class guarantees strong grounding to the target entry, but not sibling slot reuse.
- In the representative siblings I inspected, token echo was often broad or generic:
  - `project`
  - `session`
  - `agenr`
- Only a small minority looked like clearly same-slot semantic reinforcement rather than same-entity topical proximity.

Operationally, this bucket looks like a **manual-review shortlist**, not a deterministic mutation lane.

### 2. Large but grounding-diluted grounded-family alignment: 6

These are the clearest "still staged" cases among the large families.

Representative rows:

- `agenr/entry_types`
  - `family_reuse_count = 39`
  - `grounded_family_reuse_count = 5`
  - confidence `0.74`
  - supporting siblings were broad agenr entries such as `agenr/architecture_boundary` and `agenr/ingestion_eval_workflow`

- `openclaw/recall_validation_scope`
  - `family_reuse_count = 34`
  - `grounded_family_reuse_count = 6`
  - confidence `0.72`
  - supporting siblings were broad openclaw entries such as `openclaw/global_plugin_prefix_path` and `openclaw/memory_surface_contract`

- `agenr/public_demo_api_key`
  - `family_reuse_count = 39`
  - `grounded_family_reuse_count = 3`
  - confidence `0.78`

These cases are exactly what a narrow new rule should avoid:

- the entity family is strong
- the local wording is good
- but the grounded sibling set is too diluted to claim slot-level determinism

### 3. Thin grounded-family alignment tail: 15

This tail is materially weaker than the large-family bucket.

Breakdown:

- **10** cases with exactly one grounded family sibling
- **4** cases with family reuse `2-4`
- **1** case with family reuse `5`

Representative rows:

- `recall_ranking_pipeline/specificity_signal`
  - `family_reuse_count = 1`
  - `grounded_family_reuse_count = 1`
  - confidence `0.78`

- `watcher/session_correlation_fallback`
  - `family_reuse_count = 4`
  - `grounded_family_reuse_count = 4`
  - confidence `0.74`

- `cli/destructive_command_arming_guardrail`
  - `family_reuse_count = 1`
  - `grounded_family_reuse_count = 1`
  - confidence `0.72`

Even when these look semantically good, they are too thin to justify auto-apply. The signal is still mostly:

- one or a few grounded siblings
- strong wording in the target entry
- a good-looking model key

That is appropriate for staging, not blind repair.

### 4. Relaxed one-sibling stable-slot cases: 12

This bucket is the cleanest "do not promote yet" stratum.

Every row in this bucket has:

- `support_class = trusted_family_stable_slot`
- `support_relaxed_stable_slot_family_gate = true`
- `support_family_reuse_count = 1`
- `support_grounded_family_reuse_count = 1`

Representative rows:

- `session_start_recall/query_seeding_strategy`
  - only supporting sibling: `session_start_recall/budget_recommendation`

- `documentation/docs_style_preference`
  - only supporting sibling: `documentation/layering_strategy`

- `recall_retrieval/query_shaping_strategy`
  - only supporting sibling: `recall_retrieval/scope_aware_memory_source_selection`

These are exactly the cases the relaxed gate was meant to surface for review. They are structurally plausible, but still too brittle for auto-apply because:

- one sibling can establish family presence
- it does not establish slot canon

## Recommendation

**Recommendation: no new auto-apply rule yet.**

The strongest argument for promotion is the 9-case high-density grounded-family bucket. But that slice still fails the key safety test:

- it is not separated by exact reuse
- it is not separated by template support
- it is not separated by stable-slot support
- the sibling evidence is often same-entity topical support, not same-slot canonical support

So the evidence does **not** support a new supported-lane auto-apply rule today.

## Why no exact guard is justified yet

If a new rule were warranted, it would need to isolate a subset whose support is more deterministic than ordinary grounded-family alignment. The current serialized evidence does not cleanly do that.

The closest future candidate would be a shadow-only experimental filter like:

- `support_class = trusted_family_grounded_alignment`
- `support_family_reuse_count >= 20`
- grounded ratio `>= 0.70`
- confidence `>= 0.74`
- plus a new deterministic sibling-slot-resonance check that excludes generic token overlap

I do **not** recommend shipping that as auto-apply now because the missing piece is the important one:

- current artifacts do not encode a trustworthy "same-slot resonance" field
- the ad hoc overlap visible in the inspected rows is often too generic to stand in for stable slot reuse

So the right answer here is not "lower the supported threshold for the best-looking grounded cases." The right answer is "we still do not have a deterministic enough separator."

## Which cases should remain staged

These should remain staged and unresolved for this pass:

- all **12** relaxed one-sibling stable-slot cases
- all **15** thin grounded-family alignment cases
- all **6** large but grounding-diluted grounded-family cases
- the **9** high-density grounded-family cases as well, unless a stronger deterministic sibling-slot signal is added first

If a human wanted a manual-review shortlist, the 9 high-density grounded-family rows would be the right first pass. But they do not yet warrant blind mutation.

## Scope judgment

This result still fits cleanly inside a claim-key-quality pass.

Why:

- it is about whether a claim-key support lane is strong enough for automatic mutation
- it stays inside claim-key support evidence, compactness, and staged proposal review
- it does not require recall/ranking changes, store-time supersession changes, or collision-policy expansion

So the right scope judgment is:

- **still a claim-key-quality pass**
- **no Phase 2c or 2d widening implied**
- **no blanket threshold drop justified**
