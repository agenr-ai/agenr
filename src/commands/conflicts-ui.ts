import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import {
  getConflictStats,
  getPendingConflicts,
  resolveConflictLog,
} from "../db/conflict-log.js";
import { toNumber, toStringValue } from "../utils/entry-utils.js";
import { resolveDbPathFromOptions } from "./shared.js";

export interface ConflictsUiOptions {
  port?: number;
  db?: string;
  open?: boolean;
}

export interface ConflictWithEntries {
  id: string;
  entryA: {
    id: string;
    type: string;
    subject: string;
    content: string;
    importance: number;
    subjectKey: string | null;
    createdAt: string;
  };
  entryB: {
    id: string;
    type: string;
    subject: string;
    content: string;
    importance: number;
    subjectKey: string | null;
    createdAt: string;
  };
  relation: string;
  confidence: number;
  resolution: string;
  createdAt: string;
}

interface ConflictLogRow {
  id: string;
  newEntryId: string;
  existingEntryId: string;
  relation: string;
  confidence: number;
  resolution: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface ConflictHistoryItem extends ConflictWithEntries {
  resolvedAt: string | null;
}

interface ConflictEntryRow {
  id: string;
  type: string;
  subject: string;
  content: string;
  importance: number;
  subjectKey: string | null;
  createdAt: string;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type ConflictResolution = "keep-new" | "keep-old" | "keep-both";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

class ConflictAlreadyResolvedError extends Error {
  constructor() {
    super("Conflict already resolved");
    this.name = "ConflictAlreadyResolvedError";
  }
}

function resolveDefaultDbPath(dbOption: string | undefined): string {
  const config = readConfig(process.env);
  return resolveDbPathFromOptions(dbOption, config?.db?.path);
}

function normalizePort(port: number | undefined): number {
  const resolved = port ?? 4242;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65_535) {
    throw new Error(`Invalid --port value: ${String(port)}. Expected an integer between 1 and 65535.`);
  }
  return resolved;
}

function buildJsonResponse(status: number, payload: unknown): HttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function buildHtmlResponse(html: string): HttpResponse {
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body: html,
  };
}

function toConflictLogRow(row: Record<string, unknown>): ConflictLogRow {
  const confidence = toNumber(row.confidence);
  return {
    id: toStringValue(row.id),
    newEntryId: toStringValue(row.entry_a),
    existingEntryId: toStringValue(row.entry_b),
    relation: toStringValue(row.relation),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    resolution: toStringValue(row.resolution),
    createdAt: toStringValue(row.created_at),
    resolvedAt: toStringValue(row.resolved_at) || null,
  };
}

function toConflictEntry(row: Record<string, unknown>): ConflictEntryRow {
  const importance = toNumber(row.importance);
  return {
    id: toStringValue(row.id),
    type: toStringValue(row.type),
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    importance: Number.isFinite(importance) ? importance : 0,
    subjectKey: toStringValue(row.subject_key) || null,
    createdAt: toStringValue(row.created_at),
  };
}

async function getEntriesByIds(db: Client, entryIds: string[]): Promise<Map<string, ConflictEntryRow>> {
  const uniqueIds = Array.from(new Set(entryIds));
  if (uniqueIds.length === 0) {
    return new Map();
  }
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT id, type, subject, content, importance, subject_key, created_at
      FROM entries
      WHERE id IN (${placeholders})
    `,
    args: uniqueIds,
  });
  return new Map(
    result.rows.map((row) => {
      const entry = toConflictEntry(row as Record<string, unknown>);
      return [entry.id, entry] as const;
    }),
  );
}

async function buildConflictWithEntries(
  db: Client,
  rows: ConflictLogRow[],
): Promise<ConflictWithEntries[]> {
  const entryById = await getEntriesByIds(
    db,
    rows.flatMap((row) => [row.newEntryId, row.existingEntryId]),
  );
  const conflicts: ConflictWithEntries[] = [];
  for (const row of rows) {
    const newEntry = entryById.get(row.newEntryId);
    const existingEntry = entryById.get(row.existingEntryId);
    if (!newEntry || !existingEntry) {
      continue;
    }
    conflicts.push({
      id: row.id,
      entryA: newEntry,
      entryB: existingEntry,
      relation: row.relation,
      confidence: row.confidence,
      resolution: row.resolution,
      createdAt: row.createdAt,
    });
  }
  return conflicts;
}

async function getResolvedConflictHistory(db: Client): Promise<ConflictHistoryItem[]> {
  const result = await db.execute({
    sql: `
      SELECT id, entry_a, entry_b, relation, confidence, resolution, created_at, resolved_at
      FROM conflict_log
      WHERE resolution != 'pending'
      ORDER BY resolved_at DESC
      LIMIT 50
    `,
  });

  const rows = result.rows.map((row) => toConflictLogRow(row as Record<string, unknown>));
  const withEntries = await buildConflictWithEntries(db, rows);
  const byId = new Map(rows.map((row) => [row.id, row]));

  return withEntries.map((conflict) => ({
    ...conflict,
    resolvedAt: byId.get(conflict.id)?.resolvedAt ?? null,
  }));
}

async function getConflictById(db: Client, conflictId: string): Promise<ConflictLogRow | null> {
  const result = await db.execute({
    sql: `
      SELECT id, entry_a, entry_b, relation, confidence, resolution, created_at, resolved_at
      FROM conflict_log
      WHERE id = ?
      LIMIT 1
    `,
    args: [conflictId],
  });
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return toConflictLogRow(row as Record<string, unknown>);
}

function parseResolution(value: unknown): ConflictResolution | null {
  if (value === "keep-new" || value === "keep-old" || value === "keep-both") {
    return value;
  }
  return null;
}

async function applyConflictResolution(
  db: Client,
  conflict: ConflictLogRow,
  resolution: ConflictResolution,
): Promise<void> {
  await db.execute("BEGIN IMMEDIATE");
  try {
    const recheck = await db.execute({
      sql: "SELECT resolution FROM conflict_log WHERE id = ?",
      args: [conflict.id],
    });
    const currentResolution = toStringValue(
      (recheck.rows[0] as Record<string, unknown> | undefined)?.resolution,
    );
    if (currentResolution && currentResolution !== "pending") {
      await db.execute("ROLLBACK");
      throw new ConflictAlreadyResolvedError();
    }

    if (resolution === "keep-new") {
      await db.execute({
        sql: "UPDATE entries SET retired = 1 WHERE id = ?",
        args: [conflict.existingEntryId],
      });
    } else if (resolution === "keep-old") {
      await db.execute({
        sql: "UPDATE entries SET retired = 1 WHERE id = ?",
        args: [conflict.newEntryId],
      });
    }
    // SubjectIndex is process-scoped to the store pipeline and not shared with this UI process.
    // Conflict UI mutations use direct DB queries, so no subject index updates are required here.

    await resolveConflictLog(db, conflict.id, resolution);
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

function getPathname(requestPath: string): string {
  try {
    return new URL(requestPath, "http://127.0.0.1").pathname;
  } catch {
    return requestPath;
  }
}

function renderPage(authToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agenr - Conflict Review</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #212138;
      --border: #2d2d44;
      --text: #e0e0e0;
      --muted: #a4a8bf;
      --supersedes: #3cb371;
      --contradicts: #ff6b6b;
      --coexists: #6ca0ff;
      --keep-new: #2e8b57;
      --keep-old: #3560d4;
      --keep-both: #5f667a;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "SF Pro Text", "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    .container {
      width: min(1100px, 96vw);
      margin: 0 auto;
      padding: 1.25rem 0 3rem;
    }

    h1, h2 {
      margin: 0;
    }

    .header {
      border: 1px solid var(--border);
      background: linear-gradient(150deg, rgba(108, 160, 255, 0.12), rgba(33, 33, 56, 0.9));
      border-radius: 12px;
      padding: 1rem 1.15rem;
      margin-bottom: 1rem;
    }

    .subtitle {
      margin-top: 0.3rem;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .stats {
      margin-top: 0.95rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
      gap: 0.55rem;
    }

    .stat {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
      padding: 0.55rem 0.65rem;
    }

    .stat-label {
      color: var(--muted);
      display: block;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .stat-value {
      font-size: 1.35rem;
      font-weight: 600;
    }

    .conflicts {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.9rem;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      padding: 0.85rem;
      transition: opacity 220ms ease, transform 220ms ease;
    }

    .card.fade-out {
      opacity: 0;
      transform: translateY(-8px);
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.65rem;
      margin-bottom: 0.65rem;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 0.16rem 0.6rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #fff;
    }

    .badge.supersedes {
      background: var(--supersedes);
    }

    .badge.contradicts {
      background: var(--contradicts);
    }

    .badge.coexists {
      background: var(--coexists);
    }

    .confidence {
      color: var(--muted);
      font-size: 0.86rem;
    }

    .entry-grid {
      display: grid;
      gap: 0.7rem;
      grid-template-columns: 1fr;
      margin-bottom: 0.75rem;
    }

    .entry {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
      padding: 0.6rem 0.7rem;
    }

    .entry-title {
      margin: 0 0 0.22rem;
      font-size: 0.96rem;
      font-weight: 600;
    }

    .entry-meta {
      margin: 0 0 0.3rem;
      font-size: 0.8rem;
      color: var(--muted);
    }

    .entry-content {
      margin: 0;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.88rem;
      border-top: 1px solid var(--border);
      padding-top: 0.38rem;
      word-break: break-word;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    button {
      border: 0;
      border-radius: 8px;
      color: #fff;
      padding: 0.45rem 0.72rem;
      font-size: 0.85rem;
      cursor: pointer;
      transition: opacity 120ms ease;
    }

    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    button.keep-new {
      background: var(--keep-new);
    }

    button.keep-old {
      background: var(--keep-old);
    }

    button.keep-both {
      background: var(--keep-both);
    }

    .empty {
      margin-top: 1rem;
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 1rem;
      color: var(--muted);
      text-align: center;
    }

    details {
      margin-top: 1rem;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
      padding: 0.7rem 0.85rem;
    }

    summary {
      cursor: pointer;
      font-weight: 600;
    }

    .history-list {
      display: grid;
      gap: 0.45rem;
      margin-top: 0.55rem;
    }

    .history-item {
      border-top: 1px solid var(--border);
      padding-top: 0.45rem;
      font-size: 0.84rem;
      color: var(--muted);
    }

    .history-item strong {
      color: var(--text);
      font-weight: 600;
    }

    @media (min-width: 860px) {
      .entry-grid {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="container">
    <section class="header">
      <h1>agenr - Conflict Review</h1>
      <p class="subtitle">Resolve pending contradictions in your local knowledge DB.</p>
      <div class="stats" id="stats"></div>
    </section>

    <section>
      <h2>Pending Conflicts</h2>
      <div id="conflicts" class="conflicts"></div>
      <div id="empty" class="empty" hidden>No pending conflicts. The brain is consistent.</div>
    </section>

    <details>
      <summary>Resolution History</summary>
      <div id="history" class="history-list"></div>
    </details>
  </main>

  <script>
    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function relationClass(relation) {
      if (relation === "supersedes") return "supersedes";
      if (relation === "contradicts") return "contradicts";
      return "coexists";
    }

    function formatDate(value) {
      if (!value) return "-";
      const dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return value;
      return dt.toLocaleString();
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) {
        const message = typeof data?.error === "string" ? data.error : "Request failed";
        throw new Error(message);
      }
      return data;
    }

    function setStats(stats) {
      const el = document.getElementById("stats");
      el.innerHTML = [
        ["Total", stats.total],
        ["Pending", stats.pending],
        ["Auto-resolved", stats.autoResolved],
        ["User-resolved", stats.userResolved],
      ].map(([label, value]) => {
        return "<div class='stat'><span class='stat-label'>" + label + "</span><div class='stat-value'>" + value + "</div></div>";
      }).join("");
    }

    function entryHtml(entry, label) {
      const type = escapeHtml(entry.type);
      const subject = escapeHtml(entry.subject);
      const content = escapeHtml(entry.content);
      const key = entry.subjectKey ? " | key: " + escapeHtml(entry.subjectKey) : "";
      return (
        "<article class='entry'>" +
          "<h3 class='entry-title'>" + label + "</h3>" +
          "<p class='entry-meta'>" +
            type + " | " + subject +
            " | importance " + entry.importance +
            key +
          "</p>" +
          "<p class='entry-meta'>Created: " + escapeHtml(formatDate(entry.createdAt)) + "</p>" +
          "<p class='entry-content'>" + content + "</p>" +
        "</article>"
      );
    }

    function renderConflicts(conflicts) {
      const list = document.getElementById("conflicts");
      const empty = document.getElementById("empty");
      if (!Array.isArray(conflicts) || conflicts.length === 0) {
        list.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;

      list.innerHTML = conflicts.map((conflict) => {
        const relation = escapeHtml(conflict.relation);
        const confidence = Number(conflict.confidence || 0).toFixed(2);
        const relationCss = relationClass(conflict.relation);
        return (
          "<article class='card' data-id='" + escapeHtml(conflict.id) + "'>" +
            "<div class='card-top'>" +
              "<span class='badge " + relationCss + "'>" + relation + "</span>" +
              "<span class='confidence'>confidence " + confidence + "</span>" +
            "</div>" +
            "<div class='entry-grid'>" +
              entryHtml(conflict.entryA, "Entry A (newer)") +
              entryHtml(conflict.entryB, "Entry B (older/existing)") +
            "</div>" +
            "<div class='actions'>" +
              "<button class='keep-new' data-resolution='keep-new'>Keep New</button>" +
              "<button class='keep-old' data-resolution='keep-old'>Keep Old</button>" +
              "<button class='keep-both' data-resolution='keep-both'>Keep Both</button>" +
            "</div>" +
          "</article>"
        );
      }).join("");
    }

    function renderHistory(items) {
      const container = document.getElementById("history");
      if (!Array.isArray(items) || items.length === 0) {
        container.innerHTML = "<div class='history-item'>No resolved conflicts yet.</div>";
        return;
      }

      container.innerHTML = items.map((item) => {
        return (
          "<div class='history-item'>" +
            "<strong>" + escapeHtml(item.relation) + "</strong>" +
            " - " + escapeHtml(item.resolution) +
            " - resolved " + escapeHtml(formatDate(item.resolvedAt)) +
            "<br>" +
            escapeHtml(item.entryA.subject) +
            " vs " +
            escapeHtml(item.entryB.subject) +
          "</div>"
        );
      }).join("");
    }

    async function refreshStats() {
      const stats = await fetchJson("/api/stats");
      setStats(stats);
    }

    async function refreshConflicts() {
      const conflicts = await fetchJson("/api/conflicts");
      renderConflicts(conflicts);
    }

    async function refreshHistory() {
      const history = await fetchJson("/api/history");
      renderHistory(history);
    }

    async function resolveConflict(conflictId, resolution, button) {
      const card = button.closest(".card");
      if (!card) return;

      const buttons = card.querySelectorAll("button");
      buttons.forEach((btn) => {
        btn.disabled = true;
      });

      try {
        await fetchJson("/api/conflicts/" + encodeURIComponent(conflictId) + "/resolve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer ${authToken}",
          },
          body: JSON.stringify({ resolution }),
        });
      } catch (error) {
        buttons.forEach((btn) => {
          btn.disabled = false;
        });
        alert(error instanceof Error ? error.message : String(error));
        return;
      }

      card.classList.add("fade-out");
      setTimeout(() => {
        card.remove();
        if (!document.querySelector(".card")) {
          document.getElementById("empty").hidden = false;
        }
      }, 220);

      await Promise.all([refreshStats(), refreshHistory()]);
    }

    document.getElementById("conflicts").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const resolution = target.dataset.resolution;
      if (!resolution) return;
      const card = target.closest(".card");
      if (!card) return;
      const conflictId = card.dataset.id;
      if (!conflictId) return;
      await resolveConflict(conflictId, resolution, target);
    });

    async function boot() {
      try {
        await Promise.all([refreshStats(), refreshConflicts(), refreshHistory()]);
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      }
      setInterval(() => {
        refreshStats().catch(() => undefined);
      }, 30000);
    }

    void boot();
  </script>
</body>
</html>`;
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      const bufferChunk = Buffer.from(chunk);
      totalBytes += bufferChunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(bufferChunk);
      continue;
    }
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toApiNotFound(): HttpResponse {
  return buildJsonResponse(404, { error: "Not found" });
}

export async function handleConflictsUiRequest(
  db: Client,
  method: string,
  requestPath: string,
  rawBody?: string,
  authHeader?: string,
  authToken?: string,
): Promise<HttpResponse> {
  const normalizedMethod = method.toUpperCase();
  const pathname = getPathname(requestPath);

  if (normalizedMethod === "GET" && pathname === "/") {
    return buildHtmlResponse(renderPage(authToken ?? ""));
  }

  if (normalizedMethod === "GET" && pathname === "/api/conflicts") {
    const pending = await getPendingConflicts(db);
    const rows = pending.map((row) => ({
      id: row.id,
      newEntryId: row.entryA,
      existingEntryId: row.entryB,
      relation: row.relation,
      confidence: row.confidence,
      resolution: row.resolution,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    }));
    const conflicts = await buildConflictWithEntries(db, rows);
    return buildJsonResponse(200, conflicts);
  }

  if (normalizedMethod === "GET" && pathname === "/api/stats") {
    const stats = await getConflictStats(db);
    return buildJsonResponse(200, stats);
  }

  if (normalizedMethod === "GET" && pathname === "/api/history") {
    const history = await getResolvedConflictHistory(db);
    return buildJsonResponse(200, history);
  }

  const resolveMatch = pathname.match(/^\/api\/conflicts\/([^/]+)\/resolve$/);
  if (resolveMatch) {
    if (normalizedMethod !== "POST") {
      return buildJsonResponse(405, { error: "Method not allowed" });
    }
    if (!authToken) {
      return buildJsonResponse(401, { error: "Unauthorized" });
    }
    if (authHeader !== `Bearer ${authToken}`) {
      return buildJsonResponse(401, { error: "Unauthorized" });
    }
    if (rawBody && Buffer.byteLength(rawBody, "utf8") > DEFAULT_MAX_REQUEST_BODY_BYTES) {
      return buildJsonResponse(413, { error: "Request body too large" });
    }

    const conflictId = decodeURIComponent(resolveMatch[1] ?? "");
    const conflict = await getConflictById(db, conflictId);
    if (!conflict) {
      return buildJsonResponse(404, { error: "Conflict not found" });
    }
    if (conflict.resolution !== "pending") {
      return buildJsonResponse(409, { error: "Conflict is already resolved" });
    }

    let body: unknown = {};
    if (rawBody && rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        return buildJsonResponse(400, { error: "Invalid JSON body" });
      }
    }
    const resolution = parseResolution((body as { resolution?: unknown }).resolution);
    if (!resolution) {
      return buildJsonResponse(400, {
        error: "resolution must be one of: keep-new, keep-old, keep-both",
      });
    }

    try {
      await applyConflictResolution(db, conflict, resolution);
    } catch (error) {
      if (error instanceof ConflictAlreadyResolvedError) {
        return buildJsonResponse(409, { error: "Conflict is already resolved" });
      }
      throw error;
    }
    return buildJsonResponse(200, { ok: true });
  }

  if (pathname.startsWith("/api/")) {
    return toApiNotFound();
  }

  return {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not found",
  };
}

function openBrowser(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(url)) {
    process.stderr.write("[conflicts] Could not open browser automatically: invalid local URL\n");
    return;
  }

  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  execFile(command, args, (error) => {
    if (error) {
      process.stderr.write(
        `[conflicts] Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
}

function waitForShutdown(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;

    const cleanup = (): void => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      server.off("error", handleError);
    };

    const finish = (error?: Error): void => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const handleSignal = (): void => {
      server.close((error) => {
        finish(error ?? undefined);
      });
    };

    const handleError = (error: Error): void => {
      finish(error);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    server.once("error", handleError);
  });
}

async function startServer(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function runConflictsUiCommand(
  opts: ConflictsUiOptions,
): Promise<{ exitCode: number }> {
  const port = normalizePort(opts.port);
  const dbPath = resolveDefaultDbPath(opts.db);
  const db = getDb(dbPath);
  await initDb(db);
  const authToken = randomBytes(16).toString("hex");

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const requestPath = req.url ?? "/";
      const rawBody =
        method === "POST" ? await readRequestBody(req, DEFAULT_MAX_REQUEST_BODY_BYTES) : undefined;
      const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const response = await handleConflictsUiRequest(
        db,
        method,
        requestPath,
        rawBody,
        authHeader,
        authToken,
      );
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        res.writeHead(413, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      const body = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(body);
    }
  });

  try {
    await startServer(server, port);
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`[conflicts] UI running at ${url}\n`);
    process.stdout.write(`[conflicts] Auth token (POST endpoints): ${authToken}\n`);
    if (opts.open !== false) {
      openBrowser(url);
    }
    await waitForShutdown(server);
    return { exitCode: 0 };
  } finally {
    closeDb(db);
  }
}
