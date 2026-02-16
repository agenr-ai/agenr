import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAdapter } from "../../src/adapters/registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(fileName: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-adapter-registry-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("adapter registry", () => {
  it("detects OpenClaw JSONL", async () => {
    const filePath = await makeTempFile("session.jsonl", '{"type":"session","timestamp":"2026-02-06T12:32:50.848Z"}\n');
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("openclaw");
  });

  it("detects Claude Code JSONL", async () => {
    const filePath = await makeTempFile(
      "session.jsonl",
      '{"type":"user","timestamp":"2026-01-25T18:50:15.457Z","message":{"role":"user","content":"hello"},"uuid":"u1"}\n',
    );
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("claude-code");
  });

  it("detects Codex JSONL", async () => {
    const filePath = await makeTempFile(
      "session.jsonl",
      '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"s1","cwd":"/tmp","model_provider":"openai"}}\n',
    );
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("codex");
  });

  it("falls back to generic JSONL adapter", async () => {
    const filePath = await makeTempFile("session.jsonl", '{"role":"user","content":"hello"}\n');
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("jsonl-generic");
  });

  it("selects Plaud adapter by markdown filename pattern", async () => {
    const filePath = await makeTempFile("2026-02-06 1108 - Marty Review - Summary.md", "# Meeting\n");
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("plaud");
  });

  it("keeps extension-led selection for .txt files", async () => {
    const filePath = await makeTempFile("session.txt", '{"role":"user","content":"hello"}\n');
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("text");
  });

  it("routes .vscdb to cursor adapter when path indicates Cursor", async () => {
    const filePath = await makeTempFile(path.join("Cursor", "state.vscdb"), "");
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("cursor");
  });

  it("routes .vscdb to vscode adapter otherwise", async () => {
    const filePath = await makeTempFile("state.vscdb", "");
    const adapter = await detectAdapter(filePath);
    expect(adapter.name).toBe("vscode-copilot");
  });
});
