import {
  loadProcedureWorkspace,
  previewProcedureSync,
  readProcedureDocument,
  saveProcedureDocument,
  validateProcedureContent,
} from "../../../app/web/procedure-editor-service.js";
import type { ProcedureDocument, ProcedureSaveResult, ProcedureSyncPlan, ProcedureValidation, ProcedureWorkspace } from "../../../web-api/types.js";
import { WebApiError } from "../api-error.js";
import type { JsonRouteResult, WebRequestContext, WebRoute } from "../router.js";
import { parseProcedureSaveBody, parseProcedureValidateBody } from "../validation/requests.js";
import { requireInstanceScope } from "./instance-scope.js";

/**
 * Builds the procedure-editor routes for the selected instance.
 *
 * @returns Procedure editor route definitions.
 */
export function buildProcedureRoutes(): WebRoute[] {
  return [
    { kind: "json", method: "GET", pattern: "/api/web/procedure-files", handler: workspaceHandler },
    { kind: "json", method: "GET", pattern: "/api/web/procedure-files/content", handler: readDocumentHandler },
    { kind: "json", method: "POST", pattern: "/api/web/procedure-files/validate", handler: validateHandler },
    { kind: "json", method: "PUT", pattern: "/api/web/procedure-files", handler: saveHandler },
    { kind: "json", method: "GET", pattern: "/api/web/procedure-sync/preview", handler: previewHandler },
  ];
}

/** Lists procedure files and worktree status for the editor. */
async function workspaceHandler(ctx: WebRequestContext): Promise<JsonRouteResult<ProcedureWorkspace>> {
  const scope = await requireInstanceScope(ctx, { database: false, proceduresDir: true });
  const workspace = await loadProcedureWorkspace({ proceduresDir: scope.proceduresDir! });
  return { status: 200, body: workspace };
}

/** Reads and validates one procedure document by relative path. */
async function readDocumentHandler(ctx: WebRequestContext): Promise<JsonRouteResult<ProcedureDocument>> {
  const scope = await requireInstanceScope(ctx, { database: false, proceduresDir: true });
  const relativePath = ctx.url.searchParams.get("path")?.trim();
  if (!relativePath) {
    throw WebApiError.invalid([{ path: "path", message: "A procedure file path is required." }]);
  }

  try {
    const document = await readProcedureDocument({ proceduresDir: scope.proceduresDir!, relativePath });
    return { status: 200, body: document };
  } catch (error) {
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Validates posted YAML content without writing it to disk. */
async function validateHandler(ctx: WebRequestContext): Promise<JsonRouteResult<ProcedureValidation>> {
  const scope = await requireInstanceScope(ctx, { database: false, proceduresDir: true });
  const body = parseProcedureValidateBody(await ctx.readJson());
  const validation = validateProcedureContent(body.content, `${scope.proceduresDir}/${body.relativePath}`);
  return { status: 200, body: validation };
}

/** Saves a procedure document and synchronizes it into the database. */
async function saveHandler(ctx: WebRequestContext): Promise<JsonRouteResult<ProcedureSaveResult>> {
  const scope = await requireInstanceScope(ctx, { proceduresDir: true, embedding: true });
  const body = parseProcedureSaveBody(await ctx.readJson());

  try {
    const result = await saveProcedureDocument({
      proceduresDir: scope.proceduresDir!,
      relativePath: body.relativePath,
      content: body.content,
      dbPath: scope.dbPath,
      embedding: scope.embedding!,
    });
    return { status: 200, body: result };
  } catch (error) {
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Computes a dry-run sync plan for the procedures directory. */
async function previewHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ plan: ProcedureSyncPlan; git: ProcedureWorkspace["git"] }>> {
  const scope = await requireInstanceScope(ctx, { proceduresDir: true });
  const preview = await previewProcedureSync({ proceduresDir: scope.proceduresDir!, dbPath: scope.dbPath });
  return { status: 200, body: preview };
}
