import { loadWebProposalBacklog, loadWebProposalDetail, reviewWebProposal } from "../../../app/web/proposal-service.js";
import type { DreamProposal, ProposalBacklogItem, ProposalDetail } from "../../../web-api/types.js";
import { WebApiError } from "../api-error.js";
import type { JsonRouteResult, WebRequestContext, WebRoute } from "../router.js";
import { parseProposalBacklogQuery, parseReviewBody } from "../validation/requests.js";
import { requireInstanceScope } from "./instance-scope.js";

/**
 * Builds the proposal backlog, detail, and review routes.
 *
 * @returns Proposal route definitions.
 */
export function buildProposalRoutes(): WebRoute[] {
  return [
    { kind: "json", method: "GET", pattern: "/api/web/proposals", handler: backlogHandler },
    { kind: "json", method: "GET", pattern: "/api/web/proposals/:id", handler: detailHandler },
    { kind: "json", method: "POST", pattern: "/api/web/proposals/:id/review", handler: reviewHandler },
  ];
}

/** Returns the filtered proposal backlog for the selected instance. */
async function backlogHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ backlog: ProposalBacklogItem[] }>> {
  const scope = await requireInstanceScope(ctx);
  const query = parseProposalBacklogQuery(ctx.url.searchParams);
  const backlog = await loadWebProposalBacklog({ ...query, context: scope.context, env: ctx.env });
  return { status: 200, body: { backlog } };
}

/** Returns one proposal with its affected durables hydrated. */
async function detailHandler(ctx: WebRequestContext): Promise<JsonRouteResult<ProposalDetail>> {
  const scope = await requireInstanceScope(ctx);
  const detail = await loadWebProposalDetail({ proposalId: ctx.params.id, context: scope.context, env: ctx.env });
  if (!detail) {
    throw WebApiError.notFound(`Unknown proposal: ${ctx.params.id}.`);
  }

  return { status: 200, body: detail };
}

/** Applies or rejects one open proposal. */
async function reviewHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ proposal: DreamProposal }>> {
  const scope = await requireInstanceScope(ctx);
  const body = parseReviewBody(await ctx.readJson());

  try {
    const result = await reviewWebProposal({
      proposalId: ctx.params.id,
      decision: body.decision,
      reason: body.reason,
      context: scope.context,
      env: ctx.env,
    });
    return { status: 200, body: result };
  } catch (error) {
    throw new WebApiError(409, "conflict", error instanceof Error ? error.message : String(error));
  }
}
