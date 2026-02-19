import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTodoCommand, type TodoCommandDeps } from "../../src/commands/todo.js";
import { initDb } from "../../src/db/client.js";

const clients: Client[] = [];

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

async function seedTodo(client: Client, params: {
  id: string;
  subject: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  importance?: number;
}): Promise<void> {
  const createdAt = params.createdAt ?? "2026-02-15T10:00:00.000Z";
  const updatedAt = params.updatedAt ?? createdAt;
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at
      )
      VALUES (?, 'todo', ?, ?, ?, 'temporary', 'private', 'seed.jsonl', 'test', ?, ?)
    `,
    args: [params.id, params.subject, params.content, params.importance ?? 5, createdAt, updatedAt],
  });
}

function makeDeps(client: Client, overrides: Partial<TodoCommandDeps> = {}): TodoCommandDeps {
  return {
    getDbFn: overrides.getDbFn ?? (() => client),
    initDbFn: overrides.initDbFn ?? (async () => undefined),
    closeDbFn: overrides.closeDbFn ?? (() => undefined),
    introFn: overrides.introFn ?? vi.fn(),
    confirmFn: overrides.confirmFn ?? (vi.fn(async () => true) as unknown as TodoCommandDeps["confirmFn"]),
    selectFn: overrides.selectFn ?? (vi.fn(async () => "__cancel__") as unknown as TodoCommandDeps["selectFn"]),
    outroFn: overrides.outroFn ?? vi.fn(),
    logInfoFn: overrides.logInfoFn ?? vi.fn(),
  };
}

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  vi.restoreAllMocks();
});

describe("todo command", () => {
  it("wires CLI arguments into runTodoCommand", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    const todoCommand = program.commands.find((command) => command.name() === "todo");
    const actionMock = vi.fn(async (..._args: unknown[]) => undefined);
    todoCommand?.action(
      actionMock as unknown as (subcommand: string, subject: string, opts: { db?: string }) => Promise<void>,
    );

    await program.parseAsync(["node", "agenr", "todo", "done", "fix client test", "--db", "/tmp/knowledge.db"]);

    expect(actionMock).toHaveBeenCalledTimes(1);
    const firstCall = (actionMock.mock.calls as unknown[][])[0] as [string, string, { db?: string }] | undefined;
    expect(firstCall?.[0]).toBe("done");
    expect(firstCall?.[1]).toBe("fix client test");
    expect(firstCall?.[2].db).toBe("/tmp/knowledge.db");
  });

  it("done with exact match marks todo as superseded", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, {
      id: "todo-1",
      subject: "fix client test",
      content: "Fix flaky client integration test",
    });
    const deps = makeDeps(client);

    const result = await runTodoCommand("done", "fix client test", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(0);
    const row = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: ["todo-1"],
    });
    expect(String(row.rows[0]?.superseded_by)).toBe("todo-1");
  });

  it("done supports substring fuzzy matching", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, {
      id: "todo-1",
      subject: "fix client test",
      content: "Fix flaky client integration test",
    });
    const deps = makeDeps(client);

    const result = await runTodoCommand("done", "client", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(0);
    const row = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: ["todo-1"],
    });
    expect(String(row.rows[0]?.superseded_by)).toBe("todo-1");
  });

  it("done with no match returns exitCode 1 and prints error", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, {
      id: "todo-1",
      subject: "fix client test",
      content: "Fix flaky client integration test",
    });
    const outroFn = vi.fn();
    const deps = makeDeps(client, { outroFn });

    const result = await runTodoCommand("done", "totally different", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(1);
    expect(outroFn).toHaveBeenCalledWith("No active todo matching: totally different", { output: process.stderr });
  });

  it("done with multiple matches prompts selection and updates selected todo", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, { id: "todo-1", subject: "fix client test", content: "A", importance: 9 });
    await seedTodo(client, { id: "todo-2", subject: "fix client auth", content: "B", importance: 8 });
    await seedTodo(client, { id: "todo-3", subject: "client docs", content: "C", importance: 7 });

    const selectFn = vi.fn(async () => "todo-2") as unknown as TodoCommandDeps["selectFn"];
    const confirmFn = vi.fn(async () => true) as unknown as TodoCommandDeps["confirmFn"];
    const deps = makeDeps(client, { selectFn, confirmFn });

    const result = await runTodoCommand("done", "client", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(0);
    expect(selectFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).not.toHaveBeenCalled();

    const rows = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE id IN ('todo-1', 'todo-2', 'todo-3') ORDER BY id ASC",
      args: [],
    });
    const byId = new Map(rows.rows.map((row) => [String(row.id), row.superseded_by ? String(row.superseded_by) : null]));
    expect(byId.get("todo-1")).toBeNull();
    expect(byId.get("todo-2")).toBe("todo-2");
    expect(byId.get("todo-3")).toBeNull();
  });

  it("done with single match returns exitCode 1 when confirmation is cancelled", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, {
      id: "todo-1",
      subject: "fix client test",
      content: "Fix flaky client integration test",
    });
    const confirmFn = vi.fn(async () => Symbol.for("clack:cancel")) as unknown as TodoCommandDeps["confirmFn"];
    const outroFn = vi.fn();
    const deps = makeDeps(client, { confirmFn, outroFn });

    const result = await runTodoCommand("done", "fix client test", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(1);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(outroFn).toHaveBeenCalledWith("Cancelled.", { output: process.stderr });

    const row = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: ["todo-1"],
    });
    expect(row.rows[0]?.superseded_by).toBeNull();
  });

  it("done with multiple matches returns exitCode 1 when selection is cancelled", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, { id: "todo-1", subject: "fix client test", content: "A", importance: 9 });
    await seedTodo(client, { id: "todo-2", subject: "fix client auth", content: "B", importance: 8 });
    const selectFn = vi.fn(async () => "__cancel__") as unknown as TodoCommandDeps["selectFn"];
    const outroFn = vi.fn();
    const deps = makeDeps(client, { selectFn, outroFn });

    const result = await runTodoCommand("done", "client", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(1);
    expect(selectFn).toHaveBeenCalledTimes(1);
    expect(outroFn).toHaveBeenCalledWith("Cancelled.", { output: process.stderr });

    const rows = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE id IN ('todo-1', 'todo-2') ORDER BY id ASC",
      args: [],
    });
    expect(rows.rows[0]?.superseded_by).toBeNull();
    expect(rows.rows[1]?.superseded_by).toBeNull();
  });

  it("unknown subcommand returns exitCode 1", async () => {
    const client = makeClient();
    const introFn = vi.fn();
    const outroFn = vi.fn();
    const deps = makeDeps(client, { introFn, outroFn });

    const result = await runTodoCommand("list", "fix client test", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(1);
    expect(outroFn).toHaveBeenCalledWith("Unknown todo subcommand: list");
    expect(introFn).not.toHaveBeenCalled();
  });

  it("empty subject returns exitCode 1", async () => {
    const client = makeClient();
    const introFn = vi.fn();
    const outroFn = vi.fn();
    const deps = makeDeps(client, { introFn, outroFn });

    const result = await runTodoCommand("done", "   ", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(1);
    expect(outroFn).toHaveBeenCalledWith("Subject is required.");
    expect(introFn).not.toHaveBeenCalled();
  });

  it("done updates updated_at timestamp on the row", async () => {
    const client = makeClient();
    await initDb(client);
    await seedTodo(client, {
      id: "todo-1",
      subject: "fix client test",
      content: "Fix flaky client integration test",
      updatedAt: "2026-02-15T10:00:00.000Z",
    });
    const deps = makeDeps(client);

    const result = await runTodoCommand("done", "fix client test", { db: ":memory:" }, deps);

    expect(result.exitCode).toBe(0);
    const row = await client.execute({
      sql: "SELECT updated_at FROM entries WHERE id = ?",
      args: ["todo-1"],
    });
    expect(String(row.rows[0]?.updated_at)).not.toBe("2026-02-15T10:00:00.000Z");
  });
});
