import type { KnowledgeEntry, KnowledgeType } from "../types.js";

export interface AcceptableRange {
  min: number;
  max: number;
}

export interface ImportanceCeilingRule {
  max_allowed: number;
  reason?: string;
}

export interface MustExtractRule {
  type: KnowledgeType | (string & {});
  subject_contains: string;
  content_contains: string[];
  min_importance: number;
  max_importance?: number;
  reason: string;
}

export interface MustSkipRule {
  pattern: string;
  reason: string;
}

export interface BenchmarkRubric {
  session: string;
  description: string;
  must_extract: MustExtractRule[];
  must_skip: MustSkipRule[];
  acceptable_range: AcceptableRange;
  importance_ceiling?: number | ImportanceCeilingRule;
  notes?: string;
}

export interface MustExtractScore {
  rule: MustExtractRule;
  matched: boolean;
  partial_score: number;
  type_match: boolean;
  subject_match: boolean;
  content_match: number;
  importance_match: boolean;
  matched_entry?: KnowledgeEntry;
}

export interface MustSkipViolation {
  rule: MustSkipRule;
  violating_entry: KnowledgeEntry;
}

export interface SessionScore {
  session: string;
  description: string;
  recall: number;
  partial_recall: number;
  precision_proxy: number;
  count_in_range: boolean;
  ceiling_ok: boolean;
  composite_score: number;
  pass: boolean;
  total_entries: number;
  must_extract_scores: MustExtractScore[];
  must_skip_violations: MustSkipViolation[];
  importance_violations?: KnowledgeEntry[];
}

export interface SessionRunResult {
  session: string;
  runs: SessionScore[];
  mean_composite: number;
  min_composite: number;
  stdev_composite: number;
  mean_recall: number;
  mean_partial_recall: number;
  mean_precision: number;
  pass_rate: number;
}

export interface BenchmarkResult {
  model: string;
  temperature: number;
  runs: number;
  agenr_version: string;
  prompt_hash: string;
  fixture_hash: string;
  sessions: SessionRunResult[];
  overall: {
    pass_count: number;
    total_sessions: number;
    mean_composite: number;
    mean_recall: number;
    mean_partial_recall: number;
    mean_precision: number;
  };
}
