import type { EpisodeDatabasePort, TranscriptPort } from "../../core/ports.js";

/**
 * Metadata provenance used during episode-ingest preflight.
 */
export type SessionMetaSource = "registry" | "reconstructed" | "none";

/**
 * Session metadata consumed by the episode-ingest preflight service.
 */
export interface SessionMeta {
  /**
   * Stable OpenClaw session identifier.
   */
  sessionId: string;
  /**
   * Stable source reference for later episode writes.
   */
  sourceRef: string;
  /**
   * Owning OpenClaw agent identifier when known.
   */
  agentId: string | null;
  /**
   * Surface identifier when known.
   */
  surface: string | null;
  /**
   * Provider identifier when known.
   */
  provider: string | null;
  /**
   * OpenClaw chat type when known.
   */
  chatType: string | null;
  /**
   * Provenance for the metadata.
   */
  metadataSource: SessionMetaSource;
}

/**
 * Filesystem contract for episode-ingest transcript discovery.
 */
export interface EpisodeIngestFilePort {
  /**
   * Discovers transcript files from the provided target path.
   *
   * @param targetPath - File or directory to inspect.
   * @returns Sorted absolute transcript file paths.
   */
  discoverFiles(targetPath: string): Promise<string[]>;
}

/**
 * Registry lookup contract for active OpenClaw session metadata.
 */
export interface SessionRegistryPort {
  /**
   * Looks up one session by its stable identifier.
   *
   * @param sessionId - Stable OpenClaw session identifier.
   * @returns Matching session metadata, or `undefined`.
   */
  getSessionMeta(sessionId: string): Promise<SessionMeta | undefined>;

  /**
   * Lists all known registry-backed sessions.
   *
   * @returns Session metadata values in stable order.
   */
  listSessions(): Promise<SessionMeta[]>;
}

/**
 * Raw transcript inspection contract for metadata reconstruction.
 */
export interface SessionMetaInspectorPort {
  /**
   * Reconstructs best-effort metadata from one transcript file.
   *
   * @param filePath - Transcript file to inspect.
   * @returns Reconstructed metadata fields.
   */
  inspectFile(filePath: string): Promise<Pick<SessionMeta, "surface" | "metadataSource">>;
}

/**
 * Ports required by the Stage 1 episode-ingest preflight service.
 */
export interface EpisodeIngestPorts {
  /**
   * File discovery adapter used to enumerate transcript candidates.
   */
  files: EpisodeIngestFilePort;
  /**
   * Transcript parser used for normalized message extraction.
   */
  transcript: TranscriptPort;
  /**
   * Episode database used for idempotence checks.
   */
  episodes: EpisodeDatabasePort;
  /**
   * Optional active-session registry used for authoritative metadata.
   */
  sessionRegistry?: SessionRegistryPort;
  /**
   * Optional raw transcript inspector for rotated-file metadata reconstruction.
   */
  sessionMetaInspector?: SessionMetaInspectorPort;
}
