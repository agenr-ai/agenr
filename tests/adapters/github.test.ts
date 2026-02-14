import { afterEach, describe, expect, test } from "vitest";

import GitHubAdapter, { manifest } from "../../data/adapters/github";
import { createMockContext } from "../helpers/mock-context";

const originalFetch = globalThis.fetch;

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

type ResponseFactory = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchQueue(queue: ResponseFactory[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const next = queue.shift();
    if (!next) {
      throw new Error("No mock response queued for fetch call");
    }
    return next(input, init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function createAdapter() {
  const ctx = createMockContext({
    platform: "github",
    manifest: { ...manifest, platform: "github" },
    credential: { token: "gh-test-token" },
  });

  return new GitHubAdapter(
    {
      id: "github",
      name: "GitHub",
      platform: "github",
    },
    ctx,
  );
}

describe("github adapter", () => {
  test("discover returns full service catalog and hints", async () => {
    const adapter = createAdapter();

    const result = (await adapter.discover()) as {
      business: { name: string };
      services: Array<{ id: string }>;
      hints: Record<string, unknown>;
    };

    expect(result.business.name).toBe("GitHub");
    expect(result.services).toHaveLength(10);
    expect(result.services.map((service) => service.id)).toEqual([
      "repos",
      "issues",
      "pulls",
      "search",
      "actions",
      "users",
      "repos_write",
      "issues_write",
      "pulls_write",
      "actions_write",
    ]);
    expect(result.hints).toHaveProperty("typicalFlow");
    expect(result.hints).toHaveProperty("queryParams");
    expect(result.hints).toHaveProperty("executeParams");
    expect(result.hints).toHaveProperty("confirmationFlow");
    expect(result.hints).toHaveProperty("rateLimits");
    expect(result.hints).toHaveProperty("commonParams");
  });

  test("query users/me returns user info and sends required headers", async () => {
    const calls = installFetchQueue([
      () =>
        jsonResponse({
          login: "octocat",
          id: 1,
          name: "Monalisa Octocat",
          email: "octocat@example.com",
          type: "User",
          html_url: "https://github.com/octocat",
          public_repos: 8,
          followers: 10,
          following: 2,
        }),
    ]);
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "users",
      options: { method: "me" },
    })) as {
      method: string;
      user: { login: string; public_repos: number };
    };

    expect(result.method).toBe("me");
    expect(result.user.login).toBe("octocat");
    expect(result.user.public_repos).toBe(8);

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://api.github.com/user");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer gh-test-token");
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  test("query repos/list returns lean mapped repository fields", async () => {
    installFetchQueue([
      () =>
        jsonResponse([
          {
            id: 123,
            name: "hello-world",
            full_name: "octocat/hello-world",
            description: "Test repo",
            private: false,
            html_url: "https://github.com/octocat/hello-world",
            default_branch: "main",
            updated_at: "2026-02-14T10:00:00Z",
            extra_field: "ignored",
          },
        ]),
    ]);
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "repos",
      options: { method: "list", perPage: 10, page: 1 },
    })) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(result.repos).toEqual([
      {
        name: "hello-world",
        full_name: "octocat/hello-world",
        description: "Test repo",
        private: false,
        html_url: "https://github.com/octocat/hello-world",
        default_branch: "main",
        updated_at: "2026-02-14T10:00:00Z",
      },
    ]);
  });

  test("query repos/contents decodes base64 file content", async () => {
    installFetchQueue([
      () =>
        jsonResponse({
          name: "README.md",
          path: "README.md",
          type: "file",
          size: 11,
          sha: "abc123",
          html_url: "https://github.com/octocat/hello-world/blob/main/README.md",
          download_url: "https://raw.githubusercontent.com/octocat/hello-world/main/README.md",
          encoding: "base64",
          content: Buffer.from("hello world", "utf8").toString("base64"),
        }),
    ]);
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "repos",
      options: {
        method: "contents",
        owner: "octocat",
        repo: "hello-world",
        path: "README.md",
      },
    })) as {
      entry: { decodedContent: string };
    };

    expect(result.entry.decodedContent).toBe("hello world");
  });

  test("query unknown service returns expected error", async () => {
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "missing-service",
    })) as {
      error: string;
    };

    expect(result.error).toBe("Unknown service: missing-service");
  });

  test("query surfaces rate limit error with retryAfterSeconds and resetAt", async () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 120;
    installFetchQueue([
      () =>
        jsonResponse(
          { message: "API rate limit exceeded" },
          403,
          {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(resetUnix),
          },
        ),
    ]);
    const adapter = createAdapter();

    const result = (await adapter.query({
      serviceId: "users",
      options: { method: "me" },
    })) as {
      error: string;
      retryAfterSeconds: number;
      resetAt: string;
    };

    expect(result.error).toBe("GitHub API rate limit exceeded");
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(120);
    expect(Number.isNaN(Date.parse(result.resetAt))).toBe(false);
  });

  test("execute issues_write/create returns completed status", async () => {
    const calls = installFetchQueue([
      (_input, init) => {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          number: 42,
          title: "Bug: something broke",
          state: "open",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          user: { login: "octocat" },
          labels: [{ name: "bug" }],
          assignees: [],
          comments: 0,
          created_at: "2026-02-14T10:00:00Z",
          updated_at: "2026-02-14T10:00:00Z",
          body: "Description of the bug",
        });
      },
    ]);
    const adapter = createAdapter();

    const result = (await adapter.execute(
      {
        serviceId: "issues_write",
        method: "create",
        owner: "octocat",
        repo: "hello-world",
        title: "Bug: something broke",
        body: "Description of the bug",
        labels: ["bug"],
      },
      {},
    )) as {
      status: string;
      issue: { number: number; title: string };
    };

    expect(result.status).toBe("completed");
    expect(result.issue.number).toBe(42);
    expect(result.issue.title).toBe("Bug: something broke");
    expect(String(calls[0]?.input)).toContain("/repos/octocat/hello-world/issues");
  });

  test("execute pulls_write/merge without confirmationToken returns pending_confirmation", async () => {
    installFetchQueue([
      () =>
        jsonResponse({
          number: 7,
          title: "Fix bug",
          head: { ref: "fix-branch" },
          base: { ref: "main" },
          mergeable: true,
        }),
    ]);
    const adapter = createAdapter();

    const result = (await adapter.execute(
      {
        serviceId: "pulls_write",
        method: "merge",
        owner: "octocat",
        repo: "hello-world",
        number: 7,
        merge_method: "squash",
      },
      {},
    )) as {
      status: string;
      confirmationToken: string;
      summary: { merge_method: string; head_branch: string; base_branch: string };
    };

    expect(result.status).toBe("pending_confirmation");
    expect(typeof result.confirmationToken).toBe("string");
    expect(result.confirmationToken.length > 0).toBe(true);
    expect(result.summary.merge_method).toBe("squash");
    expect(result.summary.head_branch).toBe("fix-branch");
    expect(result.summary.base_branch).toBe("main");
  });

  test("execute pulls_write/merge with confirmationToken returns completed", async () => {
    const calls = installFetchQueue([
      (_input, init) => {
        expect(init?.method).toBe("PUT");
        return jsonResponse({
          sha: "deadbeef",
          merged: true,
          message: "Pull Request successfully merged",
        });
      },
    ]);
    const adapter = createAdapter();
    const confirmationToken = Buffer.from(
      JSON.stringify({
        serviceId: "pulls_write",
        method: "merge",
        owner: "octocat",
        repo: "hello-world",
        number: 7,
        merge_method: "squash",
      }),
      "utf8",
    ).toString("base64");

    const result = (await adapter.execute(
      {
        serviceId: "pulls_write",
        method: "merge",
        confirmationToken,
      },
      {},
    )) as {
      status: string;
      merged: boolean;
      sha: string;
    };

    expect(result.status).toBe("completed");
    expect(result.merged).toBe(true);
    expect(result.sha).toBe("deadbeef");
    expect(String(calls[0]?.input)).toContain("/repos/octocat/hello-world/pulls/7/merge");
  });

  test("execute unknown service returns failed status", async () => {
    const adapter = createAdapter();

    const result = (await adapter.execute(
      {
        serviceId: "unknown",
        method: "nope",
      },
      {},
    )) as {
      status: string;
      error: string;
    };

    expect(result).toEqual({
      status: "failed",
      error: "Unknown service",
    });
  });
});
