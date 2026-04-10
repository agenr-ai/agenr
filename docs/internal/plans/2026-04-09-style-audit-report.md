# Style Audit Report

- Generated at: 2026-04-10 02:01:41Z
- Repository: /Users/jmartin/Code/agenr
- Scope: src, tests, scripts, packages

This audit is a candidate finder for the coding-style rules in `AGENTS.md`.
Not every match is a bug. Some categories require manual review.

## TypeScript Suppressions

Review every TypeScript or ESLint suppression. The preferred fix is to remove the suppression by fixing the root cause.

- Match count: 14

```text
src/core/claim-key-entity-family.ts:1:/* eslint-disable jsdoc/require-jsdoc */
src/cli/commands/setup/stages.ts:46:// eslint-disable-next-line jsdoc/require-jsdoc
src/core/episode/summary-prompt.ts:28:// eslint-disable-next-line jsdoc/require-jsdoc
src/core/episode/transcript-render.ts:4:// eslint-disable-next-line jsdoc/require-jsdoc
src/core/episode/transcript-render.ts:10:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/session/transcript-files.ts:31:// eslint-disable-next-line jsdoc/require-jsdoc
src/core/claim-key-slot-resonance.ts:1:/* eslint-disable jsdoc/require-jsdoc */
src/app/surgeon/claim-key-quality.ts:1:/* eslint-disable jsdoc/require-jsdoc */
src/adapters/openclaw/tools/shared.ts:11:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/tools/shared.ts:18:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/tools/shared.ts:25:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/tools/shared.ts:31:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/tools/shared.ts:37:// eslint-disable-next-line jsdoc/require-jsdoc
src/adapters/openclaw/episode/episode-summary-prompt.ts:12:// eslint-disable-next-line jsdoc/require-jsdoc
```

## Explicit Any

Review explicit `any` usage. Some matches may be comments or identifiers, but most type-position matches should be removed.

- Match count: 0

_No matches found._

## Stringly Typed Control Flow

Review freeform string fields that may be acting as control-flow codes. Prefer closed unions or typed codes when practical.

- Match count: 16

```text
src/adapters/db/surgeon-run-log.ts:29:  error: string | null;
src/app/scenarios/claim-keys/deterministic-fixtures.ts:179:function isFixtureError(value: unknown): value is { __error: string } {
src/app/surgeon/service.ts:916:  error: string | null;
src/app/recall/types.ts:35:  reason: string;
src/app/surgeon/ports.ts:24:  error: string | null;
src/core/claim-key-entity-family.ts:818:): { score: number; reason: string | null } {
src/core/claim-key-entity-family.ts:825:  let reason: string | null = null;
src/adapters/openclaw/episode/episode-writer.ts:268:    reason: string;
src/adapters/openclaw/episode/episode-writer.ts:301:function logFailedEpisodeIngest(sessionContext: string, predecessorFile: string, error: string | undefined, episodeModel: string, logger: PluginLogger): void {
src/app/surgeon/claim-key-quality.ts:137:  error: string | null;
src/core/claim-key.ts:118:  reason: string | null;
src/core/claim-key.ts:463:function compactSourceOfTruthAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
src/core/claim-key.ts:495:function compactRelationAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
src/core/claim-key.ts:561:function compactTrailingObjectAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
src/core/surgeon/types.ts:133:    reason: string;
src/adapters/openclaw/tools/shared.ts:373:export function sanitizeRetireToolParams(params: { id: string | undefined; subject: string | undefined; reason: string | undefined }): Record<string, unknown> {
```

## Magic Zero Fallbacks

Review `?? 0` fallbacks. Many numeric aggregations are valid, but some may hide missing state or implicit semantics.

- Match count: 107

```text
tests/adapters/api/routes/internal-recall-eval.test.ts:406:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/api/routes/internal-recall-eval.test.ts:407:    recall_count: overrides.recall_count ?? 0,
tests/adapters/db/client.test.ts:843:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/db/client.test.ts:844:    recall_count: overrides.recall_count ?? 0,
src/adapters/db/surgeon-queries.ts:631:  if (Number.isFinite(query.minAgeDays) && (query.minAgeDays ?? 0) > 0) {
src/adapters/db/surgeon-queries.ts:637:  if (Number.isFinite(query.skipRecentlyEvaluatedDays) && (query.skipRecentlyEvaluatedDays ?? 0) > 0) {
src/adapters/db/surgeon-queries.ts:981:  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) {
src/adapters/db/surgeon-queries.ts:995:  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) {
src/adapters/db/surgeon-queries.ts:1009:  if (!Number.isFinite(offset) || (offset ?? 0) <= 0) {
tests/adapters/db/surgeon-queries.test.ts:669:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/db/surgeon-queries.test.ts:670:    recall_count: overrides.recall_count ?? 0,
tests/adapters/db/recall-adapter.test.ts:281:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/db/recall-adapter.test.ts:282:    recall_count: overrides.recall_count ?? 0,
tests/adapters/openclaw/before-prompt-build.test.ts:1982:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/openclaw/before-prompt-build.test.ts:1983:    recall_count: overrides.recall_count ?? 0,
tests/adapters/openclaw/tools.test.ts:996:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/openclaw/tools.test.ts:997:    recall_count: overrides.recall_count ?? 0,
tests/adapters/surgeon/tools/tools.test.ts:1569:    quality_score: overrides.quality_score ?? 0.5,
tests/adapters/surgeon/tools/tools.test.ts:1570:    recall_count: overrides.recall_count ?? 0,
src/app/scenarios/claim-keys/runtime.ts:343:      stored: totals.stored + (fileResult.storeResult?.stored ?? 0),
src/app/scenarios/claim-keys/runtime.ts:344:      skipped: totals.skipped + (fileResult.storeResult?.skipped ?? 0),
src/app/scenarios/claim-keys/runtime.ts:345:      rejected: totals.rejected + (fileResult.storeResult?.rejected ?? 0),
src/app/recall/unified.ts:392:  return Boolean(input.threshold !== undefined || (input.types?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0);
tests/app/surgeon/claim-key-quality.test.ts:2110:      const attempts = (attemptsBySubject.get(subject) ?? 0) + 1;
tests/app/surgeon/claim-key-quality.test.ts:2411:    quality_score: overrides.quality_score ?? 0.5,
tests/app/surgeon/claim-key-quality.test.ts:2412:    recall_count: overrides.recall_count ?? 0,
tests/app/surgeon/service.test.ts:771:    quality_score: overrides.quality_score ?? 0.5,
tests/app/surgeon/service.test.ts:772:    recall_count: overrides.recall_count ?? 0,
tests/core/store/pipeline.test.ts:1096:    quality_score: overrides.quality_score ?? 0.5,
tests/core/store/pipeline.test.ts:1097:    recall_count: overrides.recall_count ?? 0,
src/core/store/pipeline.ts:417:    const batchSiblingCount = preparedEntriesByClaimKey.get(claimKey)?.length ?? 0;
src/app/surgeon/service.ts:923:    inputTokens: input.usageTotals?.inputTokens ?? trackerTotals?.inputTokens ?? 0,
src/app/surgeon/service.ts:924:    outputTokens: input.usageTotals?.outputTokens ?? trackerTotals?.outputTokens ?? 0,
src/app/surgeon/service.ts:925:    costUsd: input.usageTotals?.estimatedCostUsd ?? trackerTotals?.costUsd ?? 0,
src/app/surgeon/service.ts:935:    actionsSkipped: input.completionState.summary?.entries_skipped.length ?? 0,
src/cli/commands/ingest.ts:705:      clack.log.step(`Store: indexes rebuilt (${formatDurationMs(event.durationMs ?? 0)}).`);
tests/app/recall/unified.test.ts:288:    quality_score: overrides.quality_score ?? 0.5,
tests/app/recall/unified.test.ts:289:    recall_count: overrides.recall_count ?? 0,
src/app/surgeon/completion-guard.ts:143:  const supersessionClaimKeyClusters = normalizeCount(input.supersessionClaimKeyClusters ?? 0);
src/app/surgeon/completion-guard.ts:144:  const supersessionSubjectClusters = normalizeCount(input.supersessionSubjectClusters ?? 0);
src/app/surgeon/completion-guard.ts:150:      retirementCandidates: normalizeCount(input.retirementCandidates ?? 0),
src/app/surgeon/budget.ts:71:      const input = Math.max(0, usage.input ?? 0);
src/app/surgeon/budget.ts:73:      outputTokens += Math.max(0, usage.output ?? 0);
src/app/surgeon/budget.ts:74:      costUsd += Math.max(0, usage.cost?.total ?? 0);
tests/app/evals/recall/run-recall-eval-case.test.ts:189:    expect(response.timings?.totalMs).toBeGreaterThanOrEqual(response.timings?.recallMs ?? 0);
src/cli/commands/ingest-episodes.ts:370:        input: client.metadata.model.cost?.input ?? 0,
src/cli/commands/ingest-episodes.ts:371:        output: client.metadata.model.cost?.output ?? 0,
src/cli/commands/ingest-episodes.ts:372:        cacheRead: client.metadata.model.cost?.cacheRead ?? 0,
src/cli/commands/ingest-episodes.ts:373:        cacheWrite: client.metadata.model.cost?.cacheWrite ?? 0,
src/app/evals/recall/provision-fixtures.ts:229:    indegree.set(fixture.entry.id, (indegree.get(fixture.entry.id) ?? 0) + 1);
src/app/evals/recall/provision-fixtures.ts:235:  const ready = fixtures.filter((fixture) => (indegree.get(fixture.entry.id) ?? 0) === 0).sort((left, right) => left.fixtureIndex - right.fixtureIndex);
src/app/evals/recall/provision-fixtures.ts:248:      const remaining = (indegree.get(dependent.entry.id) ?? 0) - 1;
src/app/surgeon/claim-key-quality.ts:1010:      confidence: metadataRepair ? 0.98 : (suggestionRecord.suggestion?.confidence ?? 0.5),
src/app/surgeon/claim-key-quality.ts:1452:      total.inputTokens += usage?.inputTokens ?? 0;
src/app/surgeon/claim-key-quality.ts:1453:      total.outputTokens += usage?.outputTokens ?? 0;
src/app/surgeon/claim-key-quality.ts:1454:      total.estimatedCostUsd += usage?.totalCost ?? 0;
src/app/surgeon/claim-key-quality.ts:1535:      const previewTotal = Math.max(0, options?.previewTotal ?? 0);
src/app/surgeon/claim-key-quality.ts:2049:    confidence: suggestionRecord.suggestion?.confidence ?? 0.5,
src/app/surgeon/claim-key-quality.ts:2317:  state.appliedByClaimKey.set(claimKey, (state.appliedByClaimKey.get(claimKey) ?? 0) + 1);
src/app/surgeon/claim-key-quality.ts:2319:  state.appliedByEntity.set(entity, (state.appliedByEntity.get(entity) ?? 0) + 1);
src/app/surgeon/claim-key-quality.ts:2404:    counts.set(claimKey, (counts.get(claimKey) ?? 0) + 1);
src/app/surgeon/claim-key-quality.ts:2627:    return `${label} ${bucketStats?.resonanceFiredCount ?? 0}/${bucketStats?.candidateCount ?? 0}`;
src/app/surgeon/claim-key-quality.ts:2880:      candidateCount: bucketStats?.candidateCount ?? 0,
src/app/surgeon/claim-key-quality.ts:2881:      resonanceApplicableCount: bucketStats?.resonanceApplicableCount ?? 0,
src/app/surgeon/claim-key-quality.ts:2882:      resonanceFiredCount: bucketStats?.resonanceFiredCount ?? 0,
src/app/surgeon/claim-key-quality.ts:2883:      shadowQualifiedCount: bucketStats?.shadowQualifiedCount ?? 0,
src/cli/commands/surgeon.ts:241:    budget: options.budget ?? 0,
src/cli/commands/surgeon.ts:501:        return `Working set loaded: ${event.workingSetSize ?? 0} entries.`;
src/cli/commands/surgeon.ts:505:        return `Pass context ready: ${event.workingSetSize ?? 0} entries in scope.`;
src/cli/commands/surgeon.ts:531:    const previewQueued = event.previewQueued ?? 0;
src/cli/commands/surgeon.ts:532:    const previewTotal = event.previewTotal ?? 0;
src/cli/commands/surgeon.ts:543:  const previewTotal = event.previewTotal ?? 0;
src/cli/commands/surgeon.ts:544:  const previewCompleted = event.previewCompleted ?? 0;
tests/core/recall/search.test.ts:417:    expect(results[0]?.scores.historicalLineage).toBeGreaterThan(results[2]?.scores.historicalLineage ?? 0);
tests/core/recall/search.test.ts:593:    expect(results[0]?.scores.recency).toBeGreaterThan(results[1]?.scores.recency ?? 0);
tests/core/recall/search.test.ts:702:    quality_score: overrides.quality_score ?? 0.5,
tests/core/recall/search.test.ts:703:    recall_count: overrides.recall_count ?? 0,
tests/core/recall/search.integration.test.ts:644:    quality_score: overrides.quality_score ?? 0.5,
tests/core/recall/search.integration.test.ts:645:    recall_count: overrides.recall_count ?? 0,
src/cli/commands/init/cost-estimator.ts:42:  const inputCostPerMillion = pricingModel?.cost?.input ?? 0;
src/cli/commands/init/cost-estimator.ts:43:  const outputCostPerMillion = pricingModel?.cost?.output ?? 0;
src/adapters/openclaw/session/continuity/index.ts:179:      `[agenr] before_prompt_build: read-time continuity summary generation skipped for ${sessionContext}: predecessor=${sessionFile} transcriptChars=${result.transcriptChars ?? 0} cleanedMessages=${result.messageCount ?? 0}`,
src/adapters/openclaw/session/continuity/index.ts:194:    `[agenr] before_prompt_build: read-time continuity summary generation failed for ${sessionContext}: predecessor=${sessionFile} durationMs=${result.durationMs ?? 0} transcriptChars=${result.transcriptChars ?? 0}`,
src/app/surgeon/tools/query.ts:96:  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
src/app/surgeon/tools/query.ts:110:  if (!Number.isFinite(value) || (value ?? 0) < 0) {
tests/core/claim-key-entity-family.test.ts:304:    quality_score: overrides.quality_score ?? 0.6,
tests/core/claim-key-entity-family.test.ts:305:    recall_count: overrides.recall_count ?? 0,
src/adapters/openclaw/session/continuity/predecessor-resolver.ts:309:    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
src/app/surgeon/tools/supersession-query.ts:115:  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
src/app/surgeon/tools/supersession-query.ts:129:  if (!Number.isFinite(value) || (value ?? 0) < 0) {
src/cli/commands/init/wizard.ts:353:    const storedEntries = Array.from(result.storeResults.values()).reduce((total, fileResult) => total + (fileResult.storeResult?.stored ?? 0), 0);
src/core/recall/search.ts:692:  const rank = trustedSlotRankById.get(entryId) ?? 0;
src/core/recall/search.ts:862:  return Math.min(1, Math.max(0, value ?? 0));
src/core/recall/search.ts:876:  return Math.max(0, value ?? 0);
src/core/recall/search.ts:886:  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
src/core/claim-key-slot-resonance.ts:66:  const familyGenericTokens = candidateTokens.filter((token) => (familyTokenFrequency.get(token) ?? 0) >= familyGenericCutoff);
src/core/claim-key-slot-resonance.ts:107:  const dominantShapeCount = dominantShapeEntry?.[1].siblingEntryIds.length ?? 0;
src/core/claim-key-slot-resonance.ts:171:      counts.set(token, (counts.get(token) ?? 0) + 1);
src/app/surgeon/tools/recall-sim.ts:121:  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
src/app/surgeon/tools/complete.ts:93:  const priorRejections = deps.completionGuards?.rejectionCounts.get(RETIREMENT_COMPLETION_KEY) ?? 0;
src/app/surgeon/tools/complete.ts:149:  const priorRejections = deps.completionGuards?.rejectionCounts.get(SUPERSESSION_COMPLETION_KEY) ?? 0;
src/app/surgeon/tools/complete.ts:262:  return (deps.completionGuards.rejectionCounts.get(key) ?? 0) >= SAFETY_VALVE_REJECTION_LIMIT;
tests/core/ingestion/pipeline.test.ts:898:    failedChunks: overrides.failedChunks ?? 0,
src/core/ingestion/dedup.ts:336:    const leftValue = left[index] ?? 0;
src/core/ingestion/dedup.ts:337:    const rightValue = right[index] ?? 0;
src/core/ingestion/dedup.ts:369:  const leftRank = ranks[leftRoot] ?? 0;
src/core/ingestion/dedup.ts:370:  const rightRank = ranks[rightRoot] ?? 0;
```

## Prototype Mutation

Review prototype mutation or prototype-level patching. Prefer composition, explicit inheritance, or per-instance test doubles.

- Match count: 0

_No matches found._

## Dynamic Imports In Production

Review production-path dynamic imports. If lazy loading is required, keep it behind a dedicated runtime boundary and avoid mixing static and dynamic imports for the same module.

- Match count: 0

_No matches found._

## Boundary Parsing Candidates

Review parsing and boundary-handling sites. External boundaries should use explicit validation or existing repo helpers where practical.

- Match count: 511

```text
src/config.ts:156:  const parsed = parseAgenrConfig(
src/config.ts:194:    const parsed = parseAgenrConfig(undefined, { defaultDbPath });
src/config.ts:205:    parsedJson = JSON.parse(raw) as unknown;
src/config.ts:213:  const parsed = parseAgenrConfig(parsedJson, { defaultDbPath });
src/cli/commands/scenarios.ts:228:function parseScenarioKind(value: string): ClaimKeyScenarioKind {
src/cli/commands/ingest.ts:765:function parseConcurrency(value: string): number {
src/cli/commands/ingest.ts:766:  return parseIntegerInRange(value, "Concurrency", MIN_INGEST_CONCURRENCY, MAX_INGEST_CONCURRENCY);
src/app/scenarios/claim-keys/fixture-loader.ts:216:  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
src/cli/commands/recall.ts:150:function parseEntryTypes(value: string): EntryType[] {
src/cli/commands/recall.ts:151:  const parsed = parseCsvList(value);
src/adapters/api/validation/recall-eval-request.ts:200:export function parseRecallEvalCaseRequest(input: unknown): RecallEvalCaseRequestDto {
src/adapters/api/validation/recall-eval-request.ts:217:  const parsedCaseId = parseRequiredTrimmedString(input.caseId, "caseId", issues);
src/adapters/api/validation/recall-eval-request.ts:218:  const description = parseOptionalTrimmedString(input.description, "description", issues);
src/adapters/api/validation/recall-eval-request.ts:219:  const recallPath = parseOptionalRecallPath(input.recallPath, "recallPath", issues);
src/adapters/api/validation/recall-eval-request.ts:220:  const sandbox = parseSandbox(input.sandbox, issues);
src/adapters/api/validation/recall-eval-request.ts:221:  const memoryPool = parseMemoryPool(input.memoryPool, issues);
src/adapters/api/validation/recall-eval-request.ts:222:  const recallRequest = parseRecallRequest(input.recallRequest, issues);
src/adapters/api/validation/recall-eval-request.ts:223:  const options = parseOptions(input.options, issues);
src/adapters/api/validation/recall-eval-request.ts:280:function parseSandbox(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalSandboxRequestDto | undefined {
src/adapters/api/validation/recall-eval-request.ts:285:  const sandbox = parseObject(value, "sandbox", issues);
src/adapters/api/validation/recall-eval-request.ts:293:    root: parseOptionalTrimmedString(sandbox.root, "sandbox.root", issues),
src/adapters/api/validation/recall-eval-request.ts:294:    preserve: parseOptionalBoolean(sandbox.preserve, "sandbox.preserve", issues),
src/adapters/api/validation/recall-eval-request.ts:305:function parseMemoryPool(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntryDto[] | undefined {
src/adapters/api/validation/recall-eval-request.ts:312:    const parsed = parseFixtureEntry(entry, index, issues);
src/adapters/api/validation/recall-eval-request.ts:325:function parseFixtureEntry(value: unknown, index: number, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntryDto | undefined {
src/adapters/api/validation/recall-eval-request.ts:327:  const fixture = parseObject(value, basePath, issues);
src/adapters/api/validation/recall-eval-request.ts:334:  const type = parseEntryType(fixture.type, `${basePath}.type`, issues);
src/adapters/api/validation/recall-eval-request.ts:335:  const subject = parseRequiredTrimmedString(fixture.subject, `${basePath}.subject`, issues);
src/adapters/api/validation/recall-eval-request.ts:336:  const content = parseRequiredTrimmedString(fixture.content, `${basePath}.content`, issues);
src/adapters/api/validation/recall-eval-request.ts:343:    id: parseOptionalTrimmedString(fixture.id, `${basePath}.id`, issues),
src/adapters/api/validation/recall-eval-request.ts:347:    importance: parseOptionalIntegerInRange(fixture.importance, `${basePath}.importance`, issues, {
src/adapters/api/validation/recall-eval-request.ts:351:    expiry: parseOptionalExpiry(fixture.expiry, `${basePath}.expiry`, issues),
src/adapters/api/validation/recall-eval-request.ts:352:    tags: parseOptionalStringArray(fixture.tags, `${basePath}.tags`, issues),
src/adapters/api/validation/recall-eval-request.ts:353:    source_file: parseOptionalTrimmedString(fixture.source_file, `${basePath}.source_file`, issues),
src/adapters/api/validation/recall-eval-request.ts:354:    source_context: parseOptionalTrimmedString(fixture.source_context, `${basePath}.source_context`, issues),
src/adapters/api/validation/recall-eval-request.ts:355:    created_at: parseOptionalTimestampString(fixture.created_at, `${basePath}.created_at`, issues),
src/adapters/api/validation/recall-eval-request.ts:356:    updated_at: parseOptionalTimestampString(fixture.updated_at, `${basePath}.updated_at`, issues),
src/adapters/api/validation/recall-eval-request.ts:357:    retired: parseOptionalBoolean(fixture.retired, `${basePath}.retired`, issues),
src/adapters/api/validation/recall-eval-request.ts:358:    retired_at: parseOptionalTimestampString(fixture.retired_at, `${basePath}.retired_at`, issues),
src/adapters/api/validation/recall-eval-request.ts:359:    retired_reason: parseOptionalTrimmedString(fixture.retired_reason, `${basePath}.retired_reason`, issues),
src/adapters/api/validation/recall-eval-request.ts:360:    superseded_by: parseOptionalTrimmedString(fixture.superseded_by, `${basePath}.superseded_by`, issues),
src/adapters/api/validation/recall-eval-request.ts:371:function parseRecallRequest(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequestDto | undefined {
src/adapters/api/validation/recall-eval-request.ts:372:  const recallRequest = parseObject(value, "recallRequest", issues);
src/adapters/api/validation/recall-eval-request.ts:379:  const text = parseRequiredTrimmedString(recallRequest.text, "recallRequest.text", issues);
src/adapters/api/validation/recall-eval-request.ts:386:    limit: parseOptionalIntegerInRange(recallRequest.limit, "recallRequest.limit", issues, {
src/adapters/api/validation/recall-eval-request.ts:389:    threshold: parseOptionalThreshold(recallRequest.threshold, "recallRequest.threshold", issues),
src/adapters/api/validation/recall-eval-request.ts:390:    budget: parseOptionalIntegerInRange(recallRequest.budget, "recallRequest.budget", issues, {
src/adapters/api/validation/recall-eval-request.ts:393:    types: parseOptionalEntryTypeArray(recallRequest.types, "recallRequest.types", issues),
src/adapters/api/validation/recall-eval-request.ts:394:    tags: parseOptionalStringArray(recallRequest.tags, "recallRequest.tags", issues),
src/adapters/api/validation/recall-eval-request.ts:395:    since: parseOptionalTrimmedString(recallRequest.since, "recallRequest.since", issues),
src/adapters/api/validation/recall-eval-request.ts:396:    until: parseOptionalTrimmedString(recallRequest.until, "recallRequest.until", issues),
src/adapters/api/validation/recall-eval-request.ts:397:    around: parseOptionalTrimmedString(recallRequest.around, "recallRequest.around", issues),
src/adapters/api/validation/recall-eval-request.ts:398:    aroundRadius: parseOptionalIntegerInRange(recallRequest.aroundRadius, "recallRequest.aroundRadius", issues, {
src/adapters/api/validation/recall-eval-request.ts:401:    rankingProfile: parseOptionalRankingProfile(recallRequest.rankingProfile, "recallRequest.rankingProfile", issues),
src/adapters/api/validation/recall-eval-request.ts:412:function parseOptions(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalCaseOptionsDto | undefined {
src/adapters/api/validation/recall-eval-request.ts:417:  const options = parseObject(value, "options", issues);
src/adapters/api/validation/recall-eval-request.ts:425:    includeDiagnostics: parseOptionalBoolean(options.includeDiagnostics, "options.includeDiagnostics", issues),
src/adapters/api/validation/recall-eval-request.ts:426:    includeCandidates: parseOptionalBoolean(options.includeCandidates, "options.includeCandidates", issues),
src/adapters/api/validation/recall-eval-request.ts:427:    includeTimings: parseOptionalBoolean(options.includeTimings, "options.includeTimings", issues),
src/adapters/api/validation/recall-eval-request.ts:439:function parseEntryType(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry["type"] | undefined {
src/adapters/api/validation/recall-eval-request.ts:456:function parseOptionalRecallPath(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalPath | undefined {
src/adapters/api/validation/recall-eval-request.ts:477:function parseOptionalRankingProfile(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest["rankingProfile"] | undefined {
src/adapters/api/validation/recall-eval-request.ts:498:function parseOptionalExpiry(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry["expiry"] | undefined {
src/adapters/api/validation/recall-eval-request.ts:519:function parseOptionalStringArray(value: unknown, path: string, issues: RecallEvalValidationIssue[]): string[] | undefined {
src/adapters/api/validation/recall-eval-request.ts:540:function parseOptionalEntryTypeArray(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest["types"] | undefined {
src/adapters/api/validation/recall-eval-request.ts:552:    const entryType = parseEntryType(item, `${path}[${index}]`, issues);
src/adapters/api/validation/recall-eval-request.ts:569:function parseOptionalThreshold(value: unknown, path: string, issues: RecallEvalValidationIssue[]): number | undefined {
src/adapters/api/validation/recall-eval-request.ts:590:function parseObject(value: unknown, path: string, issues: RecallEvalValidationIssue[]): Record<string, unknown> | undefined {
tests/adapters/api/validation/recall-eval-request.test.ts:7:    const result = parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:90:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:96:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:120:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:137:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:168:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:183:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:224:      parseRecallEvalCaseRequest({
tests/adapters/api/validation/recall-eval-request.test.ts:251:      parseRecallEvalCaseRequest({
src/adapters/api/routes/internal-recall-eval.ts:68:        validatedRequest = await parseValidatedRequest(request);
src/adapters/api/routes/internal-recall-eval.ts:119:  const payload = await parseJsonBody(request);
src/adapters/api/routes/internal-recall-eval.ts:120:  const requestDto = parseRecallEvalCaseRequest(payload);
src/app/episode-ingest/service/plan.ts:34:    const endedAt = parseCandidateEndedAt(candidate.endedAt);
src/app/episode-ingest/service/plan.ts:87:  const cutoff = parseRelativeDate(trimmedRecent, now ?? new Date());
tests/adapters/api/routes/internal-recall-eval.test.ts:422:    const body = JSON.parse(String(init?.body)) as { input: string[] };
src/app/episode-ingest/service/shared.ts:71:export function parseCandidateEndedAt(endedAt: string | undefined): Date | undefined {
src/app/scenarios/claim-keys/load-scenarios.ts:40:  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
src/cli/commands/surgeon.ts:174:function parseImplementedSurgeonPass(value: string): Extract<SurgeonPassType, "claim_key_quality" | "retirement" | "supersession"> {
src/cli/commands/surgeon.ts:193:function parseSurgeonRunPreset(value: string): SurgeonRunPreset {
src/app/episode-ingest/service/preflight.ts:145:  const parsedTranscript = await ports.transcript.parseFile(filePath);
src/adapters/db/surgeon-queries.ts:905:  const createdDelta = parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt);
src/adapters/db/surgeon-queries.ts:969:function parseTimestamp(value: string): number {
src/cli.ts:6:await program.parseAsync(process.argv);
src/internal-recall-eval-server.ts:89:  const parsed = Number.parseInt(trimmed, 10);
src/adapters/db/row-mapping.ts:130:    const parsed = JSON.parse(normalized) as unknown;
src/cli/commands/ingest-episodes.ts:605:    modelOverride: options.model ? parseModelRef(options.model) : undefined,
src/cli/commands/ingest-episodes.ts:613:function parseEpisodeIngestConcurrency(value: string): number {
src/cli/commands/ingest-episodes.ts:614:  return parseIntegerInRange(value, "Concurrency", MIN_EPISODE_INGEST_CONCURRENCY, MAX_EPISODE_INGEST_CONCURRENCY);
src/cli/commands/init/external-commands.ts:173:    const parsed = JSON.parse(raw) as unknown;
src/app/recall/unified.ts:59:  const parsedTimeWindow = parseTemporalWindow(input.text, now);
src/adapters/db/surgeon-run-log.ts:381:    config: parseJsonRecord(readOptionalString(row, "config_json")),
src/adapters/db/surgeon-run-log.ts:399:    details: parseJsonRecord(readOptionalString(row, "details_json")),
src/adapters/db/surgeon-run-log.ts:441:    const parsed = JSON.parse(raw) as unknown;
src/adapters/db/surgeon-run-log.ts:454:function parseJsonRecord(raw: string | undefined): Record<string, unknown> | null {
src/cli/shared/parse.ts:67:export function parseCsvList(value: string): string[] {
src/cli/shared/parse.ts:82:export function parsePositiveInteger(value: string): number {
src/cli/shared/parse.ts:83:  const parsed = Number.parseInt(value, 10);
src/cli/shared/parse.ts:97:export function parseNonNegativeInteger(value: string): number {
src/cli/shared/parse.ts:98:  const parsed = Number.parseInt(value, 10);
src/cli/shared/parse.ts:115:export function parseIntegerInRange(value: string, label: string, min: number, max: number): number {
src/cli/shared/parse.ts:116:  const parsed = Number.parseInt(value, 10);
src/cli/shared/parse.ts:134:export function parsePositiveNumber(value: string): number {
src/cli/shared/parse.ts:149:export function parseUnitInterval(value: string): number {
src/cli/shared/parse.ts:164:export function parseModelRef(value: string): ParsedModelRef {
src/adapters/db/recall-adapter.ts:413:  const parsed = parseClaimKeyStatus(value);
src/adapters/shared/validation.ts:71:export function parseRequiredTrimmedString(
src/adapters/shared/validation.ts:101:export function parseOptionalTrimmedString(
src/adapters/shared/validation.ts:135:export function parseOptionalBoolean(value: unknown, path: string, issues: ValidationIssue[], message = "Expected a boolean."): boolean | undefined {
src/adapters/shared/validation.ts:157:export function parseOptionalIntegerInRange(value: unknown, path: string, issues: ValidationIssue[], bounds: IntegerRangeBounds): number | undefined {
src/adapters/shared/validation.ts:189:export function parseOptionalTimestampString(
src/adapters/shared/validation.ts:195:  const timestamp = parseOptionalTrimmedString(value, path, issues);
tests/adapters/embeddings.test.ts:85:      const requestBody = JSON.parse(String(init?.body)) as { input: string[]; model: string; dimensions: number };
tests/adapters/embeddings.test.ts:132:      const requestBody = JSON.parse(String(init?.body)) as { input: string[] };
src/adapters/embeddings.ts:143:      return parseEmbeddingResponse(rawBody, texts.length);
src/adapters/embeddings.ts:158:function parseEmbeddingResponse(rawBody: string, expectedLength: number): number[][] {
src/adapters/embeddings.ts:161:    parsed = JSON.parse(rawBody) as OpenAIEmbeddingResponse;
src/adapters/embeddings.ts:243:    const parsed = JSON.parse(trimmed) as OpenAIEmbeddingResponse;
tests/adapters/shared/validation.test.ts:26:    expect(parseRequiredTrimmedString("  example  ", "field", issues)).toBe("example");
tests/adapters/shared/validation.test.ts:33:    expect(parseRequiredTrimmedString("", "blank", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:34:    expect(parseRequiredTrimmedString(42, "wrongType", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:50:    expect(parseOptionalTrimmedString(undefined, "missing", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:51:    expect(parseOptionalTrimmedString("  value  ", "field", issues)).toBe("value");
tests/adapters/shared/validation.test.ts:58:    expect(parseOptionalTrimmedString("   ", "blank", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:59:    expect(parseOptionalTrimmedString(false, "wrongType", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:75:    expect(parseOptionalBoolean(undefined, "missing", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:76:    expect(parseOptionalBoolean(false, "enabled", issues)).toBe(false);
tests/adapters/shared/validation.test.ts:83:    expect(parseOptionalBoolean("true", "enabled", issues)).toBeUndefined();
tests/adapters/shared/validation.test.ts:95:    expect(parseOptionalIntegerInRange(0, "limit", issues, { min: 0 })).toBe(0);
tests/adapters/shared/validation.test.ts:96:    expect(parseOptionalIntegerInRange(3, "radius", issues, { min: 1 })).toBe(3);
tests/adapters/shared/validation.test.ts:97:    expect(parseOptionalIntegerInRange(7, "importance", issues, { min: 1, max: 10 })).toBe(7);
tests/adapters/shared/validation.test.ts:104:    expect(parseOptionalIntegerInRange(-1, "limit", issues, { min: 0 })).toBeUndefined();
tests/adapters/shared/validation.test.ts:105:    expect(parseOptionalIntegerInRange(0, "radius", issues, { min: 1 })).toBeUndefined();
tests/adapters/shared/validation.test.ts:106:    expect(parseOptionalIntegerInRange(11, "importance", issues, { min: 1, max: 10 })).toBeUndefined();
tests/adapters/shared/validation.test.ts:107:    expect(parseOptionalIntegerInRange(1.5, "count", issues, {})).toBeUndefined();
tests/adapters/shared/validation.test.ts:131:    expect(parseOptionalTimestampString(" 2026-04-09T12:00:00.000Z ", "created_at", issues)).toBe("2026-04-09T12:00:00.000Z");
tests/adapters/shared/validation.test.ts:138:    expect(parseOptionalTimestampString("not-a-date", "created_at", issues)).toBeUndefined();
tests/adapters/config/parse-agenr-config.test.ts:21:    const result = parseAgenrConfig(
tests/adapters/config/parse-agenr-config.test.ts:65:    const result = parseAgenrConfig(
tests/adapters/config/parse-agenr-config.test.ts:101:    const result = parseAgenrConfig(
tests/adapters/config/parse-agenr-config.test.ts:150:    const parsed = parseAgenrConfig(
src/adapters/llm.ts:204:      return JSON.parse(stripCodeFence(text)) as T;
src/adapters/llm.ts:323:    return JSON.parse(raw) as unknown;
src/adapters/llm.ts:365:function parseCodexFromFile(env: NodeJS.ProcessEnv): CredentialCandidate | null {
src/adapters/llm.ts:392:function parseCodexFromKeychain(env: NodeJS.ProcessEnv): CredentialCandidate | null {
src/adapters/llm.ts:405:    const parsed = JSON.parse(raw) as Record<string, unknown>;
src/adapters/llm.ts:422:function parseClaudeCredentialRecord(parsed: unknown, source: string): CredentialCandidate | null {
src/adapters/llm.ts:441:function parseClaudeFromFiles(env: NodeJS.ProcessEnv): CredentialCandidate | null {
src/adapters/llm.ts:447:    const resolved = parseClaudeCredentialRecord(parsed, `file:${candidate}`);
src/adapters/llm.ts:457:function parseClaudeFromKeychain(): CredentialCandidate | null {
src/adapters/llm.ts:469:    return parseClaudeCredentialRecord(JSON.parse(raw), "keychain:Claude Code-credentials");
src/adapters/llm.ts:511:  return parseClaudeFromFiles(env) ?? parseClaudeFromKeychain();
src/adapters/llm.ts:516:  return parseCodexFromFile(env) ?? parseCodexFromKeychain(env);
src/app/surgeon/tools/supersession-validity.ts:4:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/supersession-validity.ts:10:const SET_VALIDITY_SCHEMA = Type.Object({
src/app/surgeon/tools/supersession-validity.ts:12:  valid_from: Type.Optional(Type.String({ description: "ISO 8601 UTC timestamp for when this fact became true." })),
src/app/surgeon/tools/supersession-validity.ts:13:  valid_to: Type.Optional(Type.String({ description: "ISO 8601 UTC timestamp for when this fact stopped being true." })),
src/app/surgeon/tools/update-entry.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/update-entry.ts:10:const UPDATE_ENTRY_SCHEMA = Type.Object({
src/app/surgeon/tools/update-entry.ts:12:  importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
src/app/surgeon/tools/update-entry.ts:13:  expiry: Type.Optional(
src/app/surgeon/tools/update-entry.ts:18:  claim_key: Type.Optional(Type.String({ minLength: 3, description: "Claim key in entity/attribute format." })),
src/app/surgeon/tools/update-entry.ts:19:  valid_from: Type.Optional(Type.String({ description: "ISO 8601 timestamp for when this fact became true." })),
src/app/surgeon/tools/update-entry.ts:20:  valid_to: Type.Optional(Type.String({ description: "ISO 8601 timestamp for when this fact stopped being true." })),
src/app/surgeon/tools/mutate.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/mutate.ts:8:const RETIRE_ENTRY_SCHEMA = Type.Object({
src/app/surgeon/tools/supersession-claim.ts:4:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/supersession-claim.ts:10:const ASSIGN_CLAIM_KEY_SCHEMA = Type.Object({
src/app/surgeon/tools/query.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/query.ts:7:const QUERY_CANDIDATES_SCHEMA = Type.Object({
src/app/surgeon/tools/query.ts:8:  scope: Type.Optional(
src/app/surgeon/tools/query.ts:13:  type: Type.Optional(Type.String()),
src/app/surgeon/tools/query.ts:14:  importance_max: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
src/app/surgeon/tools/query.ts:15:  min_age_days: Type.Optional(Type.Integer({ minimum: 0 })),
src/app/surgeon/tools/query.ts:16:  project: Type.Optional(Type.String()),
src/app/surgeon/tools/query.ts:17:  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
src/app/surgeon/tools/query.ts:18:  offset: Type.Optional(Type.Integer({ minimum: 0 })),
tests/adapters/openclaw/session/session-key-parser.test.ts:7:    expect(parseOpenClawSessionContinuityKey("agent:main:main")).toEqual({
tests/adapters/openclaw/session/session-key-parser.test.ts:18:      parseOpenClawSessionContinuityKey("agent:main:desk", {
tests/adapters/openclaw/session/session-key-parser.test.ts:30:      parseOpenClawSessionContinuityKey("agent:main:desk", {
tests/adapters/openclaw/session/session-key-parser.test.ts:43:    expect(parseOpenClawSessionContinuityKey("agent:main:tui-123e4567-e89b-12d3-a456-426614174000")).toEqual({
tests/adapters/openclaw/session/session-key-parser.test.ts:50:    expect(parseOpenClawSessionContinuityKey("agent:main:tui-1")).toEqual({
tests/adapters/openclaw/session/session-key-parser.test.ts:60:    expect(parseOpenClawSessionContinuityKey("agent:main:direct:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:66:    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:direct:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:72:    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:default:direct:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:81:    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:87:    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123:topic:42")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:93:    expect(parseOpenClawSessionContinuityKey("agent:main:discord:channel:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:99:    expect(parseOpenClawSessionContinuityKey("agent:main:discord:channel:123:thread:456")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:108:    expect(parseOpenClawSessionContinuityKey("agent:main:subagent:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:114:    expect(parseOpenClawSessionContinuityKey("agent:main:acp:123")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:123:    expect(parseOpenClawSessionContinuityKey("")).toEqual({
tests/adapters/openclaw/session/session-key-parser.test.ts:130:    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123:thread:42")).toMatchObject({
tests/adapters/openclaw/session/session-key-parser.test.ts:135:    expect(parseOpenClawSessionContinuityKey("agent:main:discord:slash:123")).toMatchObject({
src/app/surgeon/tools/inspect.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/inspect.ts:7:const INSPECT_ENTRY_SCHEMA = Type.Object({
tests/cli/commands/surgeon.test.ts:103:    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--apply"], { from: "user" });
tests/cli/commands/surgeon.test.ts:165:    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--verbose"], { from: "user" });
tests/cli/commands/surgeon.test.ts:191:    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--json"], { from: "user" });
tests/cli/commands/surgeon.test.ts:194:    expect(JSON.parse(stdout.join(""))).toEqual({
tests/cli/commands/surgeon.test.ts:221:    await program.parseAsync(["surgeon", "run", "--preset", "structural", "--project", "Agenr"], { from: "user" });
tests/cli/commands/surgeon.test.ts:237:    await program.parseAsync(
tests/cli/commands/surgeon.test.ts:300:    await program.parseAsync(["surgeon", "status"], { from: "user" });
src/app/surgeon/tools/complete.ts:4:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/complete.ts:11:const COMPLETE_PASS_SCHEMA = Type.Object({
src/app/surgeon/tools/complete.ts:13:  entries_skipped: Type.Array(
src/app/surgeon/tools/complete.ts:14:    Type.Object({
src/app/surgeon/tools/complete.ts:15:      entry_id: Type.Optional(Type.String()),
src/app/surgeon/tools/complete.ts:19:  observations: Type.Array(Type.String()),
src/app/surgeon/tools/complete.ts:20:  recommendations: Type.Array(Type.String()),
tests/app/evals/recall/run-recall-eval-case.test.ts:570:    const body = JSON.parse(String(init?.body)) as { input: string[] };
tests/app/scenarios/claim-keys/runtime.test.ts:119:    const ingestActual = JSON.parse(
tests/app/scenarios/claim-keys/runtime.test.ts:126:    const proposals = JSON.parse(
tests/app/scenarios/claim-keys/runtime.test.ts:132:    const surgeonSummary = JSON.parse(
tests/app/scenarios/claim-keys/runtime.test.ts:163:    const ingestActual = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.ingest.clear-slot-inferred", "actual.json"), "utf8")) as {
tests/app/scenarios/claim-keys/runtime.test.ts:173:    const trustedStoreResult = JSON.parse(
tests/app/scenarios/claim-keys/runtime.test.ts:180:    const repairActual = JSON.parse(
tests/app/scenarios/claim-keys/runtime.test.ts:266:    const actual = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "actual.json"), "utf8")) as {
tests/app/scenarios/claim-keys/runtime.test.ts:269:    const diff = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "diff.json"), "utf8")) as {
src/app/surgeon/tools/supersession-query.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/supersession-query.ts:7:const QUERY_SUPERSESSION_CANDIDATES_SCHEMA = Type.Object({
src/app/surgeon/tools/supersession-query.ts:8:  scope: Type.Optional(
src/app/surgeon/tools/supersession-query.ts:13:  type: Type.Optional(Type.String({ description: "Filter to a specific entry type." })),
src/app/surgeon/tools/supersession-query.ts:14:  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum clusters to return." })),
src/app/surgeon/tools/supersession-query.ts:15:  offset: Type.Optional(Type.Integer({ minimum: 0 })),
src/app/surgeon/tools/health.ts:2:import { Type } from "@sinclair/typebox";
src/app/surgeon/tools/health.ts:7:const GET_HEALTH_STATS_SCHEMA = Type.Object({});
tests/cli/commands/recall.test.ts:35:    await expect(recallCommand.parseAsync([], { from: "user" })).rejects.toMatchObject({
tests/cli/commands/recall.test.ts:49:    const parsed = recallCommand.parseOptions([
tests/cli/commands/recall.test.ts:126:    await program.parseAsync(["recall", "  hybrid retrieval  ", "--tags", " codex , workflow , codex ", "--since", " 7d ", "--around", " yesterday "], {
src/adapters/config/parse-agenr-config.ts:78:export function parseAgenrConfig(value: unknown, options: ParseAgenrConfigOptions): ParsedAgenrConfigResult {
src/adapters/config/parse-agenr-config.ts:187:  const auth = parseAuth(value.auth, "auth", issues);
src/adapters/config/parse-agenr-config.ts:188:  const provider = parseProvider(value.provider, "provider", issues);
src/adapters/config/parse-agenr-config.ts:189:  const model = parseOptionalTrimmedString(value.model, "model", issues);
src/adapters/config/parse-agenr-config.ts:190:  const credentials = parseCredentials(value.credentials, "credentials", issues);
src/adapters/config/parse-agenr-config.ts:191:  const embeddingModel = parseOptionalTrimmedString(value.embeddingModel, "embeddingModel", issues);
src/adapters/config/parse-agenr-config.ts:192:  const extractionContext = parseOptionalTrimmedString(value.extractionContext, "extractionContext", issues);
src/adapters/config/parse-agenr-config.ts:193:  const extractionModel = parseModelConfig(value.extractionModel, "extractionModel", issues);
src/adapters/config/parse-agenr-config.ts:194:  const dedupModel = parseModelConfig(value.dedupModel, "dedupModel", issues);
src/adapters/config/parse-agenr-config.ts:195:  const episodeModel = parseModelConfig(value.episodeModel, "episodeModel", issues);
src/adapters/config/parse-agenr-config.ts:196:  const claimExtraction = parseClaimExtractionConfig(value.claimExtraction, "claimExtraction", issues);
src/adapters/config/parse-agenr-config.ts:197:  const surgeon = parseSurgeonConfig(value.surgeon, "surgeon", issues);
src/adapters/config/parse-agenr-config.ts:198:  const dbPath = parseOptionalTrimmedString(value.dbPath, "dbPath", issues);
src/adapters/config/parse-agenr-config.ts:199:  const apiPort = parseOptionalIntegerInRange(value.apiPort, "apiPort", issues, {
src/adapters/config/parse-agenr-config.ts:295:function parseAuth(value: unknown, path: string, issues: ValidationIssue[]): ResolvedAgenrConfig["auth"] {
src/adapters/config/parse-agenr-config.ts:296:  const normalized = parseOptionalTrimmedString(value, path, issues);
src/adapters/config/parse-agenr-config.ts:317:function parseProvider(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
src/adapters/config/parse-agenr-config.ts:318:  const normalized = parseOptionalTrimmedString(value, path, issues);
src/adapters/config/parse-agenr-config.ts:339:function parseCredentials(value: unknown, path: string, issues: ValidationIssue[]): AgenrStoredCredentials | undefined {
src/adapters/config/parse-agenr-config.ts:352:  const openaiApiKey = parseOptionalTrimmedString(value.openaiApiKey, `${path}.openaiApiKey`, issues);
src/adapters/config/parse-agenr-config.ts:353:  const anthropicApiKey = parseOptionalTrimmedString(value.anthropicApiKey, `${path}.anthropicApiKey`, issues);
src/adapters/config/parse-agenr-config.ts:354:  const anthropicOauthToken = parseOptionalTrimmedString(value.anthropicOauthToken, `${path}.anthropicOauthToken`, issues);
src/adapters/config/parse-agenr-config.ts:377:function parseModelConfig(value: unknown, path: string, issues: ValidationIssue[]): ModelConfig | undefined {
src/adapters/config/parse-agenr-config.ts:390:  const provider = parseProvider(value.provider, `${path}.provider`, issues);
src/adapters/config/parse-agenr-config.ts:391:  const model = parseOptionalTrimmedString(value.model, `${path}.model`, issues);
src/adapters/config/parse-agenr-config.ts:415:function parseClaimExtractionConfig(
src/adapters/config/parse-agenr-config.ts:437:  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
src/adapters/config/parse-agenr-config.ts:438:  const confidenceThreshold = parseOptionalUnitInterval(value.confidenceThreshold, `${path}.confidenceThreshold`, issues);
src/adapters/config/parse-agenr-config.ts:439:  const eligibleTypes = parseEligibleTypes(value.eligibleTypes, `${path}.eligibleTypes`, issues);
src/adapters/config/parse-agenr-config.ts:440:  const concurrency = parseOptionalIntegerInRange(value.concurrency, `${path}.concurrency`, issues, {
src/adapters/config/parse-agenr-config.ts:443:  const model = parseModelConfig(value.model, `${path}.model`, issues);
src/adapters/config/parse-agenr-config.ts:479:function parseSurgeonConfig(value: unknown, path: string, issues: ValidationIssue[]): { input?: SurgeonConfig; resolved: ResolvedSurgeonConfig } {
src/adapters/config/parse-agenr-config.ts:497:  const model = parseModelConfig(value.model, `${path}.model`, issues);
src/adapters/config/parse-agenr-config.ts:498:  const costCap = parseOptionalPositiveNumber(value.costCap, `${path}.costCap`, issues);
src/adapters/config/parse-agenr-config.ts:499:  const dailyCostCap = parseOptionalNonNegativeNumber(value.dailyCostCap, `${path}.dailyCostCap`, issues);
src/adapters/config/parse-agenr-config.ts:500:  const contextLimit = parseOptionalIntegerInRange(value.contextLimit, `${path}.contextLimit`, issues, { min: 0 });
src/adapters/config/parse-agenr-config.ts:501:  const customInstructions = parseOptionalTrimmedString(value.customInstructions, `${path}.customInstructions`, issues);
src/adapters/config/parse-agenr-config.ts:502:  const retirement = parseRetirementPassConfig(value.passes, `${path}.passes`, issues);
src/adapters/config/parse-agenr-config.ts:548:function parseRetirementPassConfig(
src/adapters/config/parse-agenr-config.ts:589:  const protectRecalledDays = parseOptionalIntegerInRange(retirement.protectRecalledDays, `${path}.retirement.protectRecalledDays`, issues, {
src/adapters/config/parse-agenr-config.ts:592:  const protectMinImportance = parseOptionalIntegerInRange(retirement.protectMinImportance, `${path}.retirement.protectMinImportance`, issues, {
src/adapters/config/parse-agenr-config.ts:595:  const skipRecentlyEvaluatedDays = parseOptionalIntegerInRange(retirement.skipRecentlyEvaluatedDays, `${path}.retirement.skipRecentlyEvaluatedDays`, issues, {
src/adapters/config/parse-agenr-config.ts:629:function parseOptionalUnitInterval(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
src/adapters/config/parse-agenr-config.ts:650:function parseOptionalPositiveNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
src/adapters/config/parse-agenr-config.ts:671:function parseOptionalNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
src/adapters/config/parse-agenr-config.ts:692:function parseEligibleTypes(value: unknown, path: string, issues: ValidationIssue[]): EntryType[] | undefined {
src/core/store/claim-extraction.ts:1066:  const repaired = parsePossessiveClaim(entry.subject) ?? parsePossessiveStatement(entry.content);
src/core/store/claim-extraction.ts:1429:function parsePossessiveClaim(subject: string): { entity: string; attribute: string } | null {
src/core/store/claim-extraction.ts:1447:function parsePossessiveStatement(content: string): { entity: string; attribute: string } | null {
src/app/surgeon/tools/recall-sim.ts:2:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/recall-sim.ts:9:const SIMULATE_RECALL_SCHEMA = Type.Object({
src/app/surgeon/tools/recall-sim.ts:11:  exclude_entry_id: Type.Optional(
src/app/surgeon/tools/recall-sim.ts:16:  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
tests/adapters/openclaw/session/tui-lane.test.ts:7:    expect(parseTuiSessionKey("agent:main:tui-123e4567-e89b-12d3-a456-426614174000")).toEqual({
tests/adapters/openclaw/session/tui-lane.test.ts:15:    expect(parseTuiSessionKey("agent:main:tui-1")).toEqual({
tests/adapters/openclaw/session/tui-lane.test.ts:20:    expect(parseTuiSessionKey("agent:main:tui-myproject")).toEqual({
tests/adapters/openclaw/session/tui-lane.test.ts:28:    expect(parseTuiSessionKey("agent:main:main")).toBeNull();
tests/adapters/openclaw/session/tui-lane.test.ts:29:    expect(parseTuiSessionKey("agent:main:webchat:tab-a")).toBeNull();
tests/adapters/openclaw/session/tui-lane.test.ts:30:    expect(parseTuiSessionKey("agent:worker:subagent:123")).toBeNull();
tests/cli/commands/scenarios.test.ts:25:    const parsed = listCommand.parseOptions(["--kind", "store", "--tag", "trusted", "--tag", "manual", "--json"]);
tests/cli/commands/scenarios.test.ts:43:    const parsed = runCommand.parseOptions([
tests/cli/commands/scenarios.test.ts:95:    await program.parseAsync(["scenarios", "list"], { from: "user" });
tests/cli/commands/scenarios.test.ts:122:    await program.parseAsync(["scenarios", "list", "--json"], { from: "user" });
tests/cli/commands/scenarios.test.ts:124:    expect(JSON.parse(stdout.output)).toEqual([
tests/cli/commands/scenarios.test.ts:159:    await program.parseAsync(["scenarios", "run"], { from: "user" });
tests/cli/commands/scenarios.test.ts:196:    await program.parseAsync(["scenarios", "run", "--id", "claim-keys.store.manual-key-trusted", "--fail-fast", "--json"], { from: "user" });
tests/cli/commands/scenarios.test.ts:204:    expect(JSON.parse(stdout.output)).toEqual(
tests/cli/commands/scenarios.test.ts:244:    await program.parseAsync(
tests/cli/commands/scenarios.test.ts:279:    await program.parseAsync(["scenarios", "run"], { from: "user" });
tests/cli/commands/ingest.test.ts:37:    await expect(entriesCommand.parseAsync([], { from: "user" })).rejects.toMatchObject({
tests/cli/commands/ingest.test.ts:48:    const parsed = entriesCommand.parseOptions(["/tmp/session.jsonl", "--verbose", "--dry-run", "--whole-file", "force", "--skip-dedup", "--concurrency", "6"]);
tests/cli/commands/ingest.test.ts:68:    entriesCommand.parseOptions(["/tmp/session.jsonl", "--skip-dedup"]);
tests/cli/commands/ingest.test.ts:83:    entriesCommand.parseOptions(["/tmp/session.jsonl"]);
tests/cli/commands/ingest.test.ts:97:    const parsed = episodesCommand.parseOptions(["--embed-only"]);
tests/cli/commands/ingest.test.ts:113:    const parsed = episodesCommand.parseOptions([
tests/cli/commands/ingest.test.ts:148:    episodesCommand.parseOptions(["/tmp/sessions"]);
tests/cli/commands/ingest.test.ts:242:    await program.parseAsync(["node", "test", "ingest", "entries", "  /tmp/transcripts  "], {
src/core/store/validation.ts:265:  const parsed = parseClaimKeyStatus(value);
src/core/store/validation.ts:279:  const parsed = parseClaimKeySource(value);
src/core/store/validation.ts:301:  const parsed = parseClaimKeyConfidence(value);
src/core/store/validation.ts:312:  const parsed = parseClaimSupportMode(value);
tests/cli/commands/ingest-episodes.test.ts:115:    await program.parseAsync(["node", "test", "episodes", "--embed-only"], {
tests/cli/commands/ingest-episodes.test.ts:231:    await program.parseAsync(["node", "test", "episodes", "  /tmp/sessions  ", "--db", "  /tmp/knowledge.db  ", "--model", " anthropic/claude-sonnet-4-6 "], {
src/adapters/openclaw/session/session-registry.ts:99:  const tuiIdentity = parseTuiSessionKey(trimmedSessionKey);
src/adapters/openclaw/session/session-registry.ts:131:  if (parseTuiSessionKey(sessionKey ?? "")) {
tests/app/episode-ingest/service.test.ts:999:  public async parseFile(filePath: string): Promise<ParsedTranscript> {
tests/app/episode-ingest/service.test.ts:1175:    return JSON.parse(await this.complete(systemPrompt, userMessage)) as T;
tests/cli/commands/db.test.ts:26:    resetCommand.parseOptions(["--yes"]);
src/adapters/openclaw/session/sessions-store-reader.ts:131:    const parsed = JSON.parse(raw) as unknown;
src/adapters/openclaw/transcript/timestamps.ts:11:export function parseTimestampValue(value: unknown): string | undefined {
src/adapters/openclaw/transcript/timestamps.ts:38:    const parsed = parseTimestampValue(record[field]);
src/adapters/openclaw/transcript/timestamps.ts:51:    return parseTimestampValue(stat.mtime.toISOString());
src/adapters/openclaw/transcript/timestamps.ts:66:    const parsed = parseTimestampValue(candidate);
src/adapters/openclaw/transcript/timestamps.ts:95:    message.timestamp = parseTimestampValue(message.timestamp) ?? fallbackTimestamp;
src/core/claim-key-lifecycle.ts:154:export function parseClaimKeyStatus(value: unknown): ClaimKeyStatus | undefined {
src/core/claim-key-lifecycle.ts:155:  return parseStringEnum(value, CLAIM_KEY_STATUSES);
src/core/claim-key-lifecycle.ts:164:export function parseClaimKeySource(value: unknown): ClaimKeySource | undefined {
src/core/claim-key-lifecycle.ts:165:  return parseStringEnum(value, CLAIM_KEY_SOURCES);
src/core/claim-key-lifecycle.ts:174:export function parseClaimSupportMode(value: unknown): ClaimSupportMode | undefined {
src/core/claim-key-lifecycle.ts:175:  return parseStringEnum(value, CLAIM_SUPPORT_MODES);
src/core/claim-key-lifecycle.ts:184:export function parseClaimKeyConfidence(value: unknown): number | undefined {
src/core/claim-key-lifecycle.ts:196:  const parsed = parseClaimKeyStatus(value);
src/core/claim-key-lifecycle.ts:212:  const parsed = parseClaimKeySource(value);
src/core/claim-key-lifecycle.ts:228:  const parsed = parseClaimSupportMode(value);
src/core/claim-key-lifecycle.ts:375:  const status = parseClaimKeyStatus(input.claim_key_status);
src/core/claim-key-lifecycle.ts:376:  const source = parseClaimKeySource(input.claim_key_source);
src/core/claim-key-lifecycle.ts:377:  const confidence = parseClaimKeyConfidence(input.claim_key_confidence);
src/core/claim-key-lifecycle.ts:379:  const supportMode = parseClaimSupportMode(input.claim_support_mode);
src/core/claim-key-lifecycle.ts:741:  return parseClaimKeySource(source);
src/core/claim-key-lifecycle.ts:991:  const parsed = parseClaimKeyConfidence(value);
tests/adapters/openclaw/session/continuity/continuity-summary-generator.test.ts:264:      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
tests/core/claim-key-lifecycle.test.ts:275:    expect(parseClaimKeyStatus("trusted")).toBe("trusted");
tests/core/claim-key-lifecycle.test.ts:276:    expect(parseClaimKeyStatus("legacy")).toBeUndefined();
tests/core/claim-key-lifecycle.test.ts:277:    expect(parseClaimKeySource("surgeon_compaction")).toBe("surgeon_compaction");
tests/core/claim-key-lifecycle.test.ts:278:    expect(parseClaimKeySource("handwritten")).toBeUndefined();
tests/core/claim-key-lifecycle.test.ts:279:    expect(parseClaimKeyConfidence(0.75)).toBe(0.75);
tests/core/claim-key-lifecycle.test.ts:280:    expect(parseClaimKeyConfidence(1.2)).toBeUndefined();
tests/core/claim-key-lifecycle.test.ts:281:    expect(parseClaimSupportMode("explicit")).toBe("explicit");
tests/core/claim-key-lifecycle.test.ts:282:    expect(parseClaimSupportMode("copied")).toBeUndefined();
src/adapters/openclaw/llm/openclaw-llm-client.ts:71:      return JSON.parse(stripCodeFence(text)) as T;
tests/cli/commands/init/external-commands.test.ts:28:    const parsed = JSON.parse(await readFile(openclawConfigPath, "utf8")) as {
tests/cli/commands/init/external-commands.test.ts:63:    const parsed = JSON.parse(await readFile(path.join(stateDir, "openclaw.json"), "utf8")) as {
src/app/surgeon/tools/supersession-link.ts:4:import { Type, type Static } from "@sinclair/typebox";
src/app/surgeon/tools/supersession-link.ts:11:const LINK_SUPERSESSION_SCHEMA = Type.Object({
src/adapters/openclaw/transcript/parser.ts:389:      const parsed = JSON.parse(jsonLines.join("\n").trim());
src/adapters/openclaw/transcript/parser.ts:658:  async parseFile(filePath: string, options?: { verbose?: boolean }): Promise<ParsedTranscript> {
src/adapters/openclaw/transcript/parser.ts:665:    const jsonlResult = parseJsonlLines(raw, (record, lineNumber) => {
src/core/ports.ts:158:  parseFile(filePath: string, options?: { verbose?: boolean }): Promise<import("./types.js").ParsedTranscript>;
src/adapters/openclaw/session/session-key-parser.ts:50:export function parseOpenClawSessionContinuityKey(
src/adapters/openclaw/session/session-key-parser.ts:62:  const tuiIdentity = parseTuiSessionKey(normalizedSessionKey);
tests/adapters/openclaw/transcript/parser.test.ts:62:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:140:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:191:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:236:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:265:    const transcript = await parser.parseFile(filePath, { verbose: true });
tests/adapters/openclaw/transcript/parser.test.ts:298:    const transcript = await parser.parseFile(filePath, { verbose: true });
tests/adapters/openclaw/transcript/parser.test.ts:338:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:439:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:460:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:487:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:516:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:543:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:564:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:586:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:612:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:644:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:683:    const firstTranscript = await parser.parseFile(firstFile);
tests/adapters/openclaw/transcript/parser.test.ts:684:    const secondTranscript = await parser.parseFile(secondFile);
tests/adapters/openclaw/transcript/parser.test.ts:707:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:733:    const transcript = await parser.parseFile(filePath);
tests/adapters/openclaw/transcript/parser.test.ts:744:    await expect(parser.parseFile(missingPath)).rejects.toMatchObject<Partial<OpenClawTranscriptParseError>>({
tests/adapters/openclaw/transcript/parser.test.ts:755:    await expect(parser.parseFile(directory)).rejects.toMatchObject<Partial<OpenClawTranscriptParseError>>({
src/adapters/openclaw/transcript/message-content.ts:218:        const parsed = JSON.parse(candidate);
tests/cli/shared/parse.test.ts:33:    expect(parseCsvList(" alpha, beta ,alpha ")).toEqual(["alpha", "beta"]);
tests/cli/shared/parse.test.ts:37:    expect(parsePositiveInteger("7")).toBe(7);
tests/cli/shared/parse.test.ts:38:    expect(() => parsePositiveInteger("0")).toThrow("Value must be a positive integer.");
tests/cli/shared/parse.test.ts:42:    expect(parseNonNegativeInteger("0")).toBe(0);
tests/cli/shared/parse.test.ts:43:    expect(() => parseNonNegativeInteger("-1")).toThrow("Value must be a non-negative integer.");
tests/cli/shared/parse.test.ts:47:    expect(parseIntegerInRange("10", "Concurrency", 1, 50)).toBe(10);
tests/cli/shared/parse.test.ts:48:    expect(() => parseIntegerInRange("100", "Concurrency", 1, 50)).toThrow("Concurrency must be between 1 and 50.");
tests/cli/shared/parse.test.ts:52:    expect(parsePositiveNumber("0.5")).toBe(0.5);
tests/cli/shared/parse.test.ts:53:    expect(() => parsePositiveNumber("0")).toThrow("Value must be a positive number.");
tests/cli/shared/parse.test.ts:57:    expect(parseUnitInterval("1")).toBe(1);
tests/cli/shared/parse.test.ts:58:    expect(() => parseUnitInterval("1.1")).toThrow("Value must be between 0 and 1.");
tests/cli/shared/parse.test.ts:62:    expect(parseModelRef(" anthropic/claude-sonnet-4-6 ")).toEqual({
tests/cli/shared/parse.test.ts:66:    expect(parseModelRef(" gpt-5.4-mini ")).toEqual({
tests/cli/shared/parse.test.ts:69:    expect(() => parseModelRef("openai/")).toThrow('Model reference must look like "provider/model" or "model".');
tests/adapters/openclaw/runtime.test.ts:115:      requestBodies.push(JSON.parse(String(init?.body)) as { model: string; input: string[] });
src/adapters/openclaw/transcript/jsonl.ts:54:export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
src/adapters/openclaw/transcript/jsonl.ts:55:  return parseJsonObjectLineWithDiagnostics(line).record;
src/adapters/openclaw/transcript/jsonl.ts:65:export function parseJsonObjectLineWithDiagnostics(line: string, lineNumber = 1): JsonObjectLineParseResult {
src/adapters/openclaw/transcript/jsonl.ts:73:    const parsed = JSON.parse(line);
src/adapters/openclaw/transcript/jsonl.ts:107:export function parseJsonlLines(raw: string, onRecord: (record: Record<string, unknown>, lineNumber: number) => void): JsonlLinesParseResult {
src/adapters/openclaw/transcript/jsonl.ts:117:    const parsed = parseJsonObjectLineWithDiagnostics(line, index + 1);
src/adapters/openclaw/tools/update.ts:79:        const expiry = parseExpiry(readStringParam(params, "expiry"));
tests/app/ingestion/service.test.ts:695:  public async parseFile(filePath: string): Promise<ParsedTranscript> {
src/adapters/openclaw/session/tui-lane.ts:34:export function parseTuiSessionKey(sessionKey: string): TuiLaneIdentity | null {
tests/core/recall/temporal.test.ts:57:    expect(toIsoDate(parseRelativeDate("7d", NOW))).toBe("2026-03-19");
tests/core/recall/temporal.test.ts:61:    expect(toIsoDate(parseRelativeDate("30d", NOW))).toBe("2026-02-24");
tests/core/recall/temporal.test.ts:65:    expect(parseRelativeDate("2026-02-01T12:00:00.000Z", NOW)?.toISOString()).toBe("2026-02-01T12:00:00.000Z");
tests/core/recall/temporal.test.ts:69:    expect(parseRelativeDate("tomorrow-ish", NOW)).toBeNull();
src/adapters/openclaw/config.ts:120:export function createAgenrOpenClawPluginConfigSchema(): OpenClawPluginConfigSchema {
src/adapters/openclaw/config.ts:122:    validate(value) {
tests/adapters/openclaw/episode/episode-writer.test.ts:677:      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
src/adapters/openclaw/tools/store.ts:99:        const type = parseEntryType(readStringParam(params, "type", { required: true, label: "type" }));
src/adapters/openclaw/tools/store.ts:103:        const expiry = parseExpiry(readStringParam(params, "expiry"));
tests/adapters/openclaw/package-metadata.test.ts:99:  return JSON.parse(await readFile(filePath, "utf8")) as TValue;
tests/adapters/openclaw/config.test.ts:5:  createAgenrOpenClawPluginConfigSchema,
tests/adapters/openclaw/config.test.ts:114:    const schema = createAgenrOpenClawPluginConfigSchema();
tests/adapters/openclaw/config.test.ts:116:    expect(schema.validate({})).toEqual({
src/adapters/openclaw/index.ts:4:import { coerceAgenrOpenClawPluginConfig, createAgenrOpenClawPluginConfigSchema, resolveStoreNudgeConfig } from "./config.js";
src/adapters/openclaw/index.ts:19:  configSchema: createAgenrOpenClawPluginConfigSchema(),
tests/adapters/openclaw/before-prompt-build.test.ts:1871:      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
src/adapters/openclaw/session/continuity/recent-session.ts:17:    const transcript = await openClawTranscriptParser.parseFile(sessionFile);
src/core/recall/temporal.ts:75:export function parseRelativeDate(input: string, now: Date = new Date()): Date | null {
src/adapters/openclaw/embedded-agent/task-runner.ts:73:    const parsedModelRef = parseModelRef(params.modelOverride, DEFAULT_PROVIDER);
src/adapters/openclaw/embedded-agent/task-runner.ts:89:  const parsedModelRef = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
src/core/recall/search.ts:42:  const aroundDate = query.around !== undefined ? parseAroundDate(query.around) : inferAroundDate(text);
src/core/recall/search.ts:43:  const since = query.since ? parseRelativeDate(query.since) : null;
src/core/recall/search.ts:44:  const until = query.until ? parseRelativeDate(query.until) : null;
src/core/recall/search.ts:833:function parseAroundDate(value: string): Date | null {
src/core/recall/search.ts:834:  return parseRelativeDate(value) ?? inferAroundDate(value);
tests/core/episode/summary-generator.test.ts:10:      parseEpisodeSummaryResponse(
tests/core/episode/summary-generator.test.ts:32:      parseEpisodeSummaryResponse(
tests/core/episode/summary-generator.test.ts:53:    expect(parseEpisodeSummaryResponse('{"tags":["oops"]}')).toBeNull();
tests/core/episode/summary-generator.test.ts:54:    expect(parseEpisodeSummaryResponse("not json")).toBeNull();
src/core/ingestion/dedup.ts:218:    const parsed = parseDedupDecision(rawResponse);
src/core/ingestion/dedup.ts:423:function parseDedupDecision(rawResponse: string): DedupDecision {
src/core/ingestion/dedup.ts:424:  const candidate = JSON.parse(extractJsonObject(stripCodeFence(rawResponse))) as Partial<DedupDecision>;
src/core/episode/summary-prompt.ts:70:export function parseEpisodeSummaryResponse(value: string): EpisodeSummaryOutput | null {
src/core/episode/summary-prompt.ts:71:  const parsed = parseJsonObject(value);
src/core/episode/summary-prompt.ts:164:function parseJsonObject(value: string): unknown | null {
src/core/episode/summary-prompt.ts:168:      return JSON.parse(candidate) as unknown;
src/adapters/openclaw/tools/shared.ts:117:export function parseEntryTypes(values: string[] | undefined): EntryType[] {
src/adapters/openclaw/tools/shared.ts:118:  return normalizeStringArray(values).map((value) => parseEntryType(value));
src/adapters/openclaw/tools/shared.ts:127:export function parseRecallMode(value: string | undefined): UnifiedRecallMode | undefined {
src/adapters/openclaw/tools/shared.ts:145:export function parseEntryType(value: string): EntryType {
src/adapters/openclaw/tools/shared.ts:159:export function parseExpiry(value: string | undefined): Expiry | undefined {
src/adapters/openclaw/session/continuity/continuity-summary-generator.ts:67:  const parsedTranscript = await openClawTranscriptParser.parseFile(sessionFile);
src/adapters/openclaw/session/continuity/predecessor-resolver.ts:49:  const currentIdentity = parseOpenClawSessionContinuityKey(ctx.sessionKey ?? "", {
src/adapters/openclaw/session/continuity/predecessor-resolver.ts:257:    const candidateIdentity = parseOpenClawSessionContinuityKey(entry.sessionKey, { mainKey });
src/adapters/openclaw/session/continuity/predecessor-resolver.ts:379:  const candidateIdentity = parseOpenClawSessionContinuityKey(entry.sessionKey, { mainKey });
src/adapters/openclaw/tools/recall.ts:86:        const mode = parseRecallMode(readStringParam(params, "mode"));
src/adapters/openclaw/tools/recall.ts:90:        const types = parseEntryTypes(readStringArrayParam(params, "types"));
src/core/ingestion/pipeline.ts:238:    const transcript = await ports.transcript.parseFile(filePath, { verbose: options.verbose });
tests/core/episode/temporal-window.test.ts:10:    const resolved = parseTemporalWindow("what happened yesterday", NOW);
tests/core/episode/temporal-window.test.ts:19:    const resolved = parseTemporalWindow("summarize last week", NOW);
tests/core/episode/temporal-window.test.ts:29:    const resolved = parseTemporalWindow("what were we doing last month", NOW);
tests/core/episode/temporal-window.test.ts:36:    const resolved = parseTemporalWindow("what happened 2 weeks ago", NOW);
tests/core/episode/temporal-window.test.ts:44:    expect(parseTemporalWindow("what happened on March 30", NOW)?.resolvedFrom).toBe("March 30");
tests/core/episode/temporal-window.test.ts:45:    expect(formatLocalDate(parseTemporalWindow("what happened on March 30", NOW)?.bounds.start)).toBe("2026-03-30");
tests/core/episode/temporal-window.test.ts:46:    expect(formatLocalDate(parseTemporalWindow("March 27 sessions", NOW)?.bounds.start)).toBe("2026-03-27");
tests/core/episode/temporal-window.test.ts:47:    expect(formatLocalDate(parseTemporalWindow("december 25", NOW)?.bounds.start)).toBe("2025-12-25");
tests/core/episode/temporal-window.test.ts:48:    expect(formatLocalDate(parseTemporalWindow("february 18", NOW)?.bounds.start)).toBe("2026-02-18");
tests/core/episode/temporal-window.test.ts:49:    expect(formatLocalDate(parseTemporalWindow("on march 1", NOW)?.bounds.start)).toBe("2026-03-01");
tests/core/episode/temporal-window.test.ts:50:    expect(parseTemporalWindow("February 30", NOW)).toBeNull();
tests/core/episode/temporal-window.test.ts:54:    expect(parseTemporalWindow("last friday", WEDNESDAY_NOW)?.resolvedFrom).toBe("last friday");
tests/core/episode/temporal-window.test.ts:55:    expect(formatLocalDate(parseTemporalWindow("last friday", WEDNESDAY_NOW)?.bounds.start)).toBe("2026-03-27");
tests/core/episode/temporal-window.test.ts:56:    expect(formatLocalDate(parseTemporalWindow("last monday", WEDNESDAY_NOW)?.bounds.start)).toBe("2026-03-30");
tests/core/episode/temporal-window.test.ts:57:    expect(formatLocalDate(parseTemporalWindow("last wednesday", WEDNESDAY_NOW)?.bounds.start)).toBe("2026-03-25");
tests/core/episode/temporal-window.test.ts:58:    expect(formatLocalDate(parseTemporalWindow("last sunday", WEDNESDAY_NOW)?.bounds.start)).toBe("2026-03-29");
tests/core/episode/temporal-window.test.ts:59:    expect(formatLocalDate(parseTemporalWindow("last Monday's sessions", WEDNESDAY_NOW)?.bounds.start)).toBe("2026-03-30");
tests/core/episode/temporal-window.test.ts:63:    const resolved = parseTemporalWindow("what happened in March", NOW);
tests/core/episode/temporal-window.test.ts:70:    const resolved = parseTemporalWindow("what happened on 2026-03-15 for the release", NOW);
tests/core/episode/temporal-window.test.ts:78:    const resolved = parseTemporalWindow("last friday on March 30", NOW);
tests/core/episode/temporal-window.test.ts:85:    expect(parseTemporalWindow("what did we do recently", NOW)).toBeNull();
src/core/episode/scoring.ts:23:  const episodeStart = parseEpisodeDate(episode.startedAt);
src/core/episode/scoring.ts:24:  const episodeEnd = parseEpisodeDate(episode.endedAt ?? episode.startedAt);
src/core/episode/scoring.ts:155:function parseEpisodeDate(value: string): Date {
src/core/ingestion/extract.ts:185:      return parseExtractionResponse(raw);
src/core/episode/temporal-window.ts:37:export function parseTemporalWindow(text: string, now: Date = new Date()): ResolvedTemporalWindow | null {
src/core/episode/temporal-window.ts:243:    const targetDate = parseIsoDateLocal(isoDateMatch[1]);
src/core/episode/temporal-window.ts:454:function parseIsoDateLocal(value: string): Date | null {
src/core/ingestion/parser.ts:71:export function parseExtractionResponse(raw: unknown): ExtractionResponse {
src/core/ingestion/parser.ts:91:    const entry = parseEntry(value, index, warnings);
src/core/ingestion/parser.ts:104:      const parsed = JSON.parse(stripCodeFence(raw)) as unknown;
src/core/ingestion/parser.ts:121:function parseEntry(value: unknown, index: number, warnings: string[]): StoreEntryInput | null {
tests/core/ingestion/parser.test.ts:7:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:41:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:74:    expect(parseExtractionResponse({ entries: [] })).toEqual({
tests/core/ingestion/parser.test.ts:81:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:111:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:128:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:158:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:181:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:204:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:221:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:238:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:255:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:272:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:289:    const result = parseExtractionResponse({
tests/core/ingestion/parser.test.ts:313:    const result = parseExtractionResponse({
src/core/episode/summary-generator.ts:14:  return parseEpisodeSummaryResponse(response);
tests/core/ingestion/pipeline.test.ts:832:  public async parseFile(filePath: string): Promise<ParsedTranscript> {
```

## Non-American Spellings

Review comments, docs strings, and identifiers for non-American spellings.

- Match count: 1

```text
docs/internal/sub-agents/episodic-memory/prior-art-research.md:406:- Nature Human Behaviour example on hippocampal coding of episodic memories: https://www.nature.com/articles/s41562-023-01706-6
```

