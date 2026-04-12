export { extractFromTranscript, chunkTranscript, type ExtractionOptions, type ExtractionResult } from "./extract.js";
export {
  dedupBatch,
  getDefaultDedupConcurrency,
  getDefaultDedupSimilarityThreshold,
  type DedupClusterDetail,
  type DedupOptions,
  type DedupProgressEvent,
  type DedupResult,
} from "./dedup.js";
export { parseExtractionResponse, type ExtractionResponse } from "./parser.js";
export {
  extractFile,
  ingestFile,
  storeExtractedResults,
  type ExtractedFileResult,
  type IngestFileOptions,
  type IngestFileResult,
  type IngestSource,
  type StoreExtractedResultsProgressEvent,
  type StoreExtractedResultsOptions,
} from "./pipeline.js";
export { annotateExplicitClaimKeyEntry, restoreExplicitClaimKeysAfterDedup, type ExplicitClaimKeySupportContext } from "./claim-key-preservation.js";
export { buildExtractionSystemPrompt, buildChunkPrompt } from "./prompts.js";
export { isSnapshotStyleSourceFile, resolveStableTranscriptSourceFile, resolveTranscriptProject, resolveTranscriptUserId } from "./source-metadata.js";
export {
  summarizeIngestClaimKeyHealth,
  type IngestClaimKeyHealthRow,
  type IngestClaimKeyHealthSupportCoverage,
  type IngestClaimKeyHealthSummary,
  type IngestClaimKeyHealthTypeCoverage,
} from "./claim-key-health.js";
