export {
  DEFAULT_INGEST_CONCURRENCY,
  ingestDiscoveredFiles,
  ingestPath,
  type ExtractionExecutionResult,
  type IngestPathOptions,
  type IngestPathResult,
  type IngestStageProgressEvent,
} from "./service.js";
export type { IngestFilePort, IngestPathPorts, IngestionLlmMetadata, IngestionLlmPort, UsageStats } from "./ports.js";
