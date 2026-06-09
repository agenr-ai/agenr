import type { WebProposalBacklogQuery } from "../../../app/web/proposal-service.js";
import type { ValidationIssue } from "../../shared/validation.js";
import { WebApiError } from "../api-error.js";
import {
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  readEnumValue,
  readIntParam,
  readNumberParam,
  readOptionalStringArray,
  readStringParam,
  requireObject,
  throwIfIssues,
} from "./field-parsers.js";

/** Proposal review decisions accepted by the review endpoint. */
const REVIEW_DECISIONS = ["apply", "reject"] as const;

/** Manual proposal settlement choices accepted by settlement endpoints. */
const SETTLE_CHOICES = ["separate", "canonical", "retire"] as const;

/** Allowed body keys for a proposal settlement request. */
const SETTLE_KEYS = new Set<string>(["choice", "reason", "targetClaimKey", "retireDurableIds"]);

/**
 * Validated proposal-review decision.
 */
export interface ParsedReviewBody {
  decision: (typeof REVIEW_DECISIONS)[number];
  reason: string;
}

/**
 * Validated manual proposal settlement request.
 */
export interface ParsedSettleProposalBody {
  choice: (typeof SETTLE_CHOICES)[number];
  /** Operator note appended to the server-built settlement reason. */
  reason: string;
  targetClaimKey?: string;
  retireDurableIds?: string[];
}

/**
 * Parses the proposal backlog query from URL search parameters.
 *
 * @param params - Request URL search parameters.
 * @returns Structured backlog query.
 * @throws {WebApiError} 400 when any parameter is malformed.
 */
export function parseProposalBacklogQuery(params: URLSearchParams): WebProposalBacklogQuery {
  const issues: ValidationIssue[] = [];
  const includeIneligible = params.get("includeIneligible");
  const query: WebProposalBacklogQuery = {
    state: "open",
    ...readIntParam(params, "limit", issues, (value) => ({ limit: value })),
    ...readNumberParam(params, "minConfidence", issues, (value) => ({ minConfidence: value })),
    ...readStringParam(params, "createdSince", (value) => ({ createdSince: value })),
    ...readStringParam(params, "issueKind", (value) => ({ issueKind: value })),
    ...(includeIneligible === "true" ? {} : { eligibleOnly: true }),
  };
  throwIfIssues(issues);
  return query;
}

/**
 * Parses and validates a proposal-review request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated decision and reason.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseReviewBody(input: unknown): ParsedReviewBody {
  const { record, issues } = requireObject(input, new Set(["decision", "reason"]));
  const decision = readEnumValue(record.decision, "decision", REVIEW_DECISIONS, issues);
  const reason = parseRequiredTrimmedString(record.reason, "reason", issues) ?? "";
  throwIfIssues(issues);
  if (!decision) {
    throw WebApiError.invalid([{ path: "decision", message: `Expected one of: ${REVIEW_DECISIONS.join(", ")}.` }]);
  }

  return { decision, reason };
}

/**
 * Parses and validates a proposal settlement request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated settlement parameters.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseSettleProposalBody(input: unknown): ParsedSettleProposalBody {
  const { record, issues } = requireObject(input, SETTLE_KEYS);
  const choice = readEnumValue(record.choice, "choice", SETTLE_CHOICES, issues);
  const reason = parseRequiredTrimmedString(record.reason, "reason", issues) ?? "";
  const targetClaimKey = parseOptionalTrimmedString(record.targetClaimKey, "targetClaimKey", issues);
  const retireDurableIds = readOptionalStringArray(record.retireDurableIds, "retireDurableIds", issues);
  throwIfIssues(issues);
  if (!choice) {
    throw WebApiError.invalid([{ path: "choice", message: `Expected one of: ${SETTLE_CHOICES.join(", ")}.` }]);
  }

  return {
    choice,
    reason,
    ...(targetClaimKey ? { targetClaimKey } : {}),
    ...(retireDurableIds.length > 0 ? { retireDurableIds } : {}),
  };
}
