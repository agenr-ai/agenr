import {
  type AgpAdapter,
  type BusinessProfile,
  type ExecuteOptions,
  type AdapterContext,
  defineManifest,
} from "agenr:adapter-api";

// -- Manifest ---------------------------------------------------------------

export const manifest = defineManifest({
  name: "GitHub",
  version: "1.0.0",
  description:
    "Interact with GitHub repositories, issues, pull requests, actions, " +
    "and more via the GitHub REST API.",
  auth: { type: "api_key", strategy: "bearer" },
  authenticatedDomains: ["api.github.com"],
  allowedDomains: [],
});

// -- Constants --------------------------------------------------------------

const API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

// -- Types ------------------------------------------------------------------

interface MergeConfirmationToken {
  serviceId: "pulls_write";
  method: "merge";
  owner: string;
  repo: string;
  number: number;
  merge_method: "merge" | "squash" | "rebase";
  commit_title?: string;
  commit_message?: string;
}

// -- Helpers ----------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toPositiveInt(v: unknown, fallback: number): number {
  const direct = num(v);
  if (direct !== undefined && direct > 0) {
    return Math.floor(direct);
  }

  const parsed = Number.parseInt(str(v), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function toBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  const raw = str(v).trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function requireString(v: unknown, field: string): string {
  const value = str(v).trim();
  if (!value) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requireNumber(v: unknown, field: string): number {
  const direct = num(v);
  if (direct !== undefined && direct > 0) {
    return Math.floor(direct);
  }

  const parsed = Number.parseInt(str(v), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${field} must be a positive number`);
}

function stringList(v: unknown): string[] {
  return arr(v).map((item) => str(item)).filter(Boolean);
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(path.startsWith("http") ? path : `${API}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const valueString = str(value);
      if (!valueString) continue;
      url.searchParams.set(key, valueString);
    }
  }
  return url.toString();
}

function parseGitHubErrorMessage(bodyText: string): string {
  if (!bodyText) {
    return "Unknown validation error";
  }

  try {
    const parsed = rec(JSON.parse(bodyText));
    const message = str(parsed.message);
    const details = arr(parsed.errors)
      .map((item) => {
        const detail = rec(item);
        return str(detail.message) || str(detail.code) || str(detail.resource);
      })
      .filter(Boolean);

    if (details.length > 0) {
      return message ? `${message} (${details.join(", ")})` : details.join(", ");
    }

    if (message) return message;
  } catch {
    // fall through
  }

  return bodyText.slice(0, 300);
}

async function ghFetch(
  ctx: AdapterContext,
  path: string,
  init?: RequestInit,
  query?: Record<string, unknown>,
): Promise<unknown> {
  const url = buildUrl(path, query);
  const headers = new Headers(init?.headers);
  headers.set("Accept", GH_HEADERS.Accept);
  headers.set("X-GitHub-Api-Version", GH_HEADERS["X-GitHub-Api-Version"]);

  const response = await ctx.fetch(url, {
    ...init,
    headers,
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");

    if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const parsedReset = Number.parseInt(response.headers.get("X-RateLimit-Reset") ?? "", 10);
      const resetUnix = Number.isFinite(parsedReset) && parsedReset > 0 ? parsedReset : nowSeconds;
      const retryAfterSeconds = Math.max(0, resetUnix - nowSeconds);

      throw {
        error: "GitHub API rate limit exceeded",
        retryAfterSeconds,
        resetAt: new Date(resetUnix * 1000).toISOString(),
      };
    }

    if (response.status === 404) {
      throw { error: `Not found: ${url}` };
    }

    if (response.status === 422) {
      throw { error: `Validation failed: ${parseGitHubErrorMessage(bodyText)}` };
    }

    const snippet = bodyText ? bodyText.slice(0, 300) : response.statusText || "Unknown error";
    throw { error: `GitHub API error ${response.status}: ${snippet}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asErrorPayload(error: unknown): Record<string, unknown> {
  const structured = rec(error);
  const errorMessage = str(structured.error);
  if (errorMessage) {
    return { ...structured, error: errorMessage };
  }

  if (error instanceof Error && error.message) {
    return { error: error.message };
  }

  return { error: "Unknown error" };
}

function asExecuteErrorPayload(error: unknown): Record<string, unknown> {
  return { status: "failed", ...asErrorPayload(error) };
}

function mapRepo(repo: Record<string, unknown>) {
  return {
    name: str(repo.name),
    full_name: str(repo.full_name),
    description: str(repo.description) || null,
    private: repo.private === true,
    html_url: str(repo.html_url),
    default_branch: str(repo.default_branch),
    updated_at: str(repo.updated_at),
  };
}

function mapRepoDetails(repo: Record<string, unknown>) {
  return {
    ...mapRepo(repo),
    id: num(repo.id),
    owner: str(rec(repo.owner).login),
    language: str(repo.language) || null,
    archived: repo.archived === true,
    disabled: repo.disabled === true,
    forks_count: num(repo.forks_count) ?? 0,
    stargazers_count: num(repo.stargazers_count) ?? 0,
    open_issues_count: num(repo.open_issues_count) ?? 0,
    visibility: str(repo.visibility) || null,
  };
}

function mapIssue(issue: Record<string, unknown>) {
  return {
    number: num(issue.number),
    title: str(issue.title),
    state: str(issue.state),
    html_url: str(issue.html_url),
    user: str(rec(issue.user).login),
    labels: arr(issue.labels)
      .map((label) => {
        if (typeof label === "string") return label;
        return str(rec(label).name);
      })
      .filter(Boolean),
    assignees: arr(issue.assignees)
      .map((assignee) => str(rec(assignee).login))
      .filter(Boolean),
    comments: num(issue.comments) ?? 0,
    created_at: str(issue.created_at),
    updated_at: str(issue.updated_at),
    body: str(issue.body) || null,
    is_pull_request: Boolean(rec(issue.pull_request).url),
  };
}

function mapPull(pull: Record<string, unknown>) {
  return {
    number: num(pull.number),
    title: str(pull.title),
    state: str(pull.state),
    draft: pull.draft === true,
    html_url: str(pull.html_url),
    user: str(rec(pull.user).login),
    head: str(rec(rec(pull.head).repo).full_name) || str(rec(pull.head).ref),
    head_branch: str(rec(pull.head).ref),
    base: str(rec(rec(pull.base).repo).full_name) || str(rec(pull.base).ref),
    base_branch: str(rec(pull.base).ref),
    mergeable: pull.mergeable === null ? "unknown" : pull.mergeable === true,
    merged_at: str(pull.merged_at) || null,
    created_at: str(pull.created_at),
    updated_at: str(pull.updated_at),
  };
}

function mapRun(run: Record<string, unknown>) {
  return {
    id: num(run.id),
    name: str(run.name),
    run_number: num(run.run_number),
    event: str(run.event),
    status: str(run.status),
    conclusion: str(run.conclusion) || null,
    head_branch: str(run.head_branch),
    html_url: str(run.html_url),
    created_at: str(run.created_at),
    updated_at: str(run.updated_at),
  };
}

function mapUser(user: Record<string, unknown>) {
  return {
    login: str(user.login),
    id: num(user.id),
    name: str(user.name) || null,
    email: str(user.email) || null,
    type: str(user.type),
    html_url: str(user.html_url),
    public_repos: num(user.public_repos) ?? 0,
    followers: num(user.followers) ?? 0,
    following: num(user.following) ?? 0,
  };
}

// -- Adapter ----------------------------------------------------------------

export default class GitHubAdapter implements AgpAdapter {
  private readonly ctx: AdapterContext;

  constructor(_business: BusinessProfile, ctx: AdapterContext) {
    this.ctx = ctx;
  }

  // -- discover -------------------------------------------------------------

  async discover() {
    return {
      business: {
        name: "GitHub",
        description: "GitHub REST API -- manage repos, issues, PRs, actions, and more.",
      },
      services: [
        {
          id: "repos",
          name: "Repositories",
          description: "List, get, browse branches and file contents of repositories.",
        },
        {
          id: "issues",
          name: "Issues",
          description: "List, get, and read comments on issues.",
        },
        {
          id: "pulls",
          name: "Pull Requests",
          description: "List, get, view files/reviews for pull requests.",
        },
        {
          id: "search",
          name: "Search",
          description: "Search issues, code, and repositories across GitHub.",
        },
        {
          id: "actions",
          name: "Actions",
          description: "View GitHub Actions workflow runs and job details.",
        },
        {
          id: "users",
          name: "Users",
          description: "Get authenticated user profile or look up other users.",
        },
        {
          id: "repos_write",
          name: "Repository Management",
          description: "Create repos, branches, and commit files.",
        },
        {
          id: "issues_write",
          name: "Issue Management",
          description: "Create issues, update them, and add comments.",
        },
        {
          id: "pulls_write",
          name: "Pull Request Management",
          description: "Create PRs, update them, and merge.",
          requiresConfirmation: true,
        },
        {
          id: "actions_write",
          name: "Actions Management",
          description: "Re-run workflow runs.",
        },
      ],
      hints: {
        typicalFlow:
          "1. users/me (who am I) -> 2. repos/list (my repos) -> " +
          "3. issues/list or pulls/list (what needs attention) -> " +
          "4. search (find anything) -> 5. write operations as needed",
        queryParams: {
          repos_list: {
            serviceId: "repos",
            options: { method: "list", perPage: 10 },
          },
          repos_get: {
            serviceId: "repos",
            options: { method: "get", owner: "octocat", repo: "hello-world" },
          },
          repos_contents: {
            serviceId: "repos",
            options: {
              method: "contents",
              owner: "octocat",
              repo: "hello-world",
              path: "README.md",
            },
          },
          issues_list: {
            serviceId: "issues",
            options: {
              method: "list",
              owner: "octocat",
              repo: "hello-world",
              state: "open",
            },
          },
          pulls_list: {
            serviceId: "pulls",
            options: {
              method: "list",
              owner: "octocat",
              repo: "hello-world",
            },
          },
          search_issues: {
            serviceId: "search",
            options: { method: "issues", q: "is:open label:bug" },
          },
          search_code: {
            serviceId: "search",
            options: { method: "code", q: "filename:package.json express" },
          },
          actions_runs: {
            serviceId: "actions",
            options: { method: "runs", owner: "octocat", repo: "hello-world" },
          },
          users_me: {
            serviceId: "users",
            options: { method: "me" },
          },
        },
        executeParams: {
          create_issue: {
            serviceId: "issues_write",
            method: "create",
            owner: "octocat",
            repo: "hello-world",
            title: "Bug: something broke",
            body: "Description of the bug",
            labels: ["bug"],
          },
          create_pr: {
            serviceId: "pulls_write",
            method: "create",
            owner: "octocat",
            repo: "hello-world",
            title: "Fix the bug",
            body: "This PR fixes #1",
            head: "fix-branch",
            base: "main",
          },
          merge_pr: {
            serviceId: "pulls_write",
            method: "merge",
            owner: "octocat",
            repo: "hello-world",
            number: 1,
            merge_method: "squash",
          },
          add_comment: {
            serviceId: "issues_write",
            method: "comment",
            owner: "octocat",
            repo: "hello-world",
            number: 1,
            body: "Looks good to me!",
          },
          create_branch: {
            serviceId: "repos_write",
            method: "create_branch",
            owner: "octocat",
            repo: "hello-world",
            branch: "feature-x",
            from_branch: "main",
          },
          rerun_workflow: {
            serviceId: "actions_write",
            method: "rerun",
            owner: "octocat",
            repo: "hello-world",
            run_id: 12345,
          },
        },
        confirmationFlow:
          "Only merge_pr requires confirmation. First call returns " +
          "pending_confirmation with PR summary. User approves, then " +
          "call again with confirmationToken to complete the merge.",
        rateLimits:
          "GitHub allows 5,000 authenticated requests/hour and 30 " +
          "search requests/minute. If you hit a rate limit, the error " +
          "will include retryAfterSeconds.",
        commonParams:
          "Most endpoints need owner and repo. For the authenticated " +
          "user's repos, use repos/list. For search, pass q with GitHub " +
          "search syntax (e.g. 'is:open label:bug repo:owner/name').",
      },
    };
  }

  // -- query ----------------------------------------------------------------

  async query(params: Record<string, unknown>) {
    const serviceId = str(params.serviceId);
    const options = rec(params.options);

    try {
      switch (serviceId) {
        case "repos":
          return await this.queryRepos(options);
        case "issues":
          return await this.queryIssues(options);
        case "pulls":
          return await this.queryPulls(options);
        case "search":
          return await this.querySearch(options);
        case "actions":
          return await this.queryActions(options);
        case "users":
          return await this.queryUsers(options);
        default:
          return { error: `Unknown service: ${serviceId}` };
      }
    } catch (error) {
      return asErrorPayload(error);
    }
  }

  private async queryRepos(options: Record<string, unknown>) {
    const method = str(options.method) || "list";
    const perPage = toPositiveInt(options.perPage, 30);
    const page = toPositiveInt(options.page, 1);

    switch (method) {
      case "list": {
        const repos = arr(await ghFetch(this.ctx, "/user/repos", { method: "GET" }, {
          sort: "updated",
          per_page: perPage,
          page,
        }));
        return {
          method,
          perPage,
          page,
          repos: repos.map((repo) => mapRepo(rec(repo))),
        };
      }
      case "get": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const result = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          { method: "GET" },
        ));
        return {
          method,
          repo: mapRepoDetails(result),
        };
      }
      case "branches": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const branches = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
          { method: "GET" },
          { per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          perPage,
          page,
          branches: branches.map((branch) => {
            const item = rec(branch);
            const commit = rec(item.commit);
            return {
              name: str(item.name),
              protected: item.protected === true,
              commit: {
                sha: str(commit.sha),
                url: str(commit.url),
              },
            };
          }),
        };
      }
      case "contents": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const path = str(options.path).replace(/^\/+/, "");
        const ref = str(options.ref);
        const encoded = encodePath(path);
        const endpoint = encoded
          ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}`
          : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
        const result = await ghFetch(this.ctx, endpoint, { method: "GET" }, {
          ref: ref || undefined,
        });

        if (Array.isArray(result)) {
          return {
            method,
            owner,
            repo,
            path,
            ref: ref || null,
            entries: result.map((entry) => {
              const item = rec(entry);
              return {
                name: str(item.name),
                path: str(item.path),
                type: str(item.type),
                size: num(item.size) ?? 0,
                sha: str(item.sha),
                html_url: str(item.html_url),
                download_url: str(item.download_url) || null,
              };
            }),
          };
        }

        const item = rec(result);
        let decodedContent: string | null = null;
        if (str(item.type) === "file" && str(item.encoding) === "base64" && str(item.content)) {
          decodedContent = Buffer.from(str(item.content).replace(/\n/g, ""), "base64").toString("utf8");
        }

        return {
          method,
          owner,
          repo,
          path,
          ref: ref || null,
          entry: {
            name: str(item.name),
            path: str(item.path),
            type: str(item.type),
            size: num(item.size) ?? 0,
            sha: str(item.sha),
            html_url: str(item.html_url),
            download_url: str(item.download_url) || null,
            decodedContent,
          },
        };
      }
      default:
        throw new Error(`Unknown repos method: ${method}`);
    }
  }

  private async queryIssues(options: Record<string, unknown>) {
    const method = str(options.method) || "list";
    const perPage = toPositiveInt(options.perPage, 30);
    const page = toPositiveInt(options.page, 1);

    switch (method) {
      case "list": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const state = str(options.state) || "open";
        const issues = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          { method: "GET" },
          { state, per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          state,
          perPage,
          page,
          issues: issues.map((issue) => mapIssue(rec(issue))),
        };
      }
      case "get": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const number = requireNumber(options.number, "number");
        const issue = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
          { method: "GET" },
        ));
        return {
          method,
          issue: mapIssue(issue),
        };
      }
      case "comments": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const number = requireNumber(options.number, "number");
        const comments = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
          { method: "GET" },
          { per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          number,
          perPage,
          page,
          comments: comments.map((comment) => {
            const item = rec(comment);
            return {
              id: num(item.id),
              user: str(rec(item.user).login),
              body: str(item.body),
              html_url: str(item.html_url),
              created_at: str(item.created_at),
              updated_at: str(item.updated_at),
            };
          }),
        };
      }
      default:
        throw new Error(`Unknown issues method: ${method}`);
    }
  }

  private async queryPulls(options: Record<string, unknown>) {
    const method = str(options.method) || "list";
    const perPage = toPositiveInt(options.perPage, 30);
    const page = toPositiveInt(options.page, 1);

    switch (method) {
      case "list": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const state = str(options.state) || "open";
        const pulls = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          { method: "GET" },
          { state, per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          state,
          perPage,
          page,
          pulls: pulls.map((pull) => mapPull(rec(pull))),
        };
      }
      case "get": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const number = requireNumber(options.number, "number");
        const pull = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
          { method: "GET" },
        ));
        return {
          method,
          pull: mapPull(pull),
        };
      }
      case "reviews": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const number = requireNumber(options.number, "number");
        const reviews = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
          { method: "GET" },
          { per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          number,
          perPage,
          page,
          reviews: reviews.map((review) => {
            const item = rec(review);
            return {
              id: num(item.id),
              user: str(rec(item.user).login),
              state: str(item.state),
              body: str(item.body) || null,
              submitted_at: str(item.submitted_at),
              commit_id: str(item.commit_id),
            };
          }),
        };
      }
      case "files": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const number = requireNumber(options.number, "number");
        const files = arr(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`,
          { method: "GET" },
          { per_page: perPage, page },
        ));
        return {
          method,
          owner,
          repo,
          number,
          perPage,
          page,
          files: files.map((file) => {
            const item = rec(file);
            return {
              sha: str(item.sha),
              filename: str(item.filename),
              status: str(item.status),
              additions: num(item.additions) ?? 0,
              deletions: num(item.deletions) ?? 0,
              changes: num(item.changes) ?? 0,
              blob_url: str(item.blob_url),
              raw_url: str(item.raw_url),
            };
          }),
        };
      }
      default:
        throw new Error(`Unknown pulls method: ${method}`);
    }
  }

  private async querySearch(options: Record<string, unknown>) {
    const method = requireString(options.method, "method");
    const q = requireString(options.q, "q");
    const perPage = toPositiveInt(options.perPage, 30);
    const page = toPositiveInt(options.page, 1);

    switch (method) {
      case "issues": {
        const result = rec(await ghFetch(this.ctx, "/search/issues", { method: "GET" }, {
          q,
          per_page: perPage,
          page,
        }));
        const items = arr(result.items).map((issue) => mapIssue(rec(issue)));
        return {
          method,
          q,
          perPage,
          page,
          total_count: num(result.total_count) ?? items.length,
          incomplete_results: result.incomplete_results === true,
          items,
        };
      }
      case "code": {
        const result = rec(await ghFetch(this.ctx, "/search/code", { method: "GET" }, {
          q,
          per_page: perPage,
          page,
        }));
        const items = arr(result.items).map((file) => {
          const item = rec(file);
          return {
            name: str(item.name),
            path: str(item.path),
            sha: str(item.sha),
            html_url: str(item.html_url),
            repository: str(rec(item.repository).full_name),
          };
        });
        return {
          method,
          q,
          perPage,
          page,
          total_count: num(result.total_count) ?? items.length,
          incomplete_results: result.incomplete_results === true,
          items,
        };
      }
      case "repos": {
        const result = rec(await ghFetch(this.ctx, "/search/repositories", { method: "GET" }, {
          q,
          per_page: perPage,
          page,
        }));
        const items = arr(result.items).map((repo) => mapRepo(rec(repo)));
        return {
          method,
          q,
          perPage,
          page,
          total_count: num(result.total_count) ?? items.length,
          incomplete_results: result.incomplete_results === true,
          items,
        };
      }
      default:
        throw new Error(`Unknown search method: ${method}`);
    }
  }

  private async queryActions(options: Record<string, unknown>) {
    const method = str(options.method) || "runs";
    const perPage = toPositiveInt(options.perPage, 30);
    const page = toPositiveInt(options.page, 1);

    switch (method) {
      case "runs": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const result = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`,
          { method: "GET" },
          { per_page: perPage, page },
        ));
        const runs = arr(result.workflow_runs).map((run) => mapRun(rec(run)));
        return {
          method,
          owner,
          repo,
          perPage,
          page,
          total_count: num(result.total_count) ?? runs.length,
          runs,
        };
      }
      case "get_run": {
        const owner = requireString(options.owner, "owner");
        const repo = requireString(options.repo, "repo");
        const runId = requireNumber(options.run_id, "run_id");
        const run = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`,
          { method: "GET" },
        ));
        return {
          method,
          run: {
            ...mapRun(run),
            jobs_url: str(run.jobs_url),
            logs_url: str(run.logs_url),
          },
        };
      }
      default:
        throw new Error(`Unknown actions method: ${method}`);
    }
  }

  private async queryUsers(options: Record<string, unknown>) {
    const method = str(options.method) || "me";

    switch (method) {
      case "me": {
        const user = rec(await ghFetch(this.ctx, "/user", { method: "GET" }));
        return { method, user: mapUser(user) };
      }
      case "get": {
        const username = requireString(options.username, "username");
        const user = rec(await ghFetch(this.ctx, `/users/${encodeURIComponent(username)}`, { method: "GET" }));
        return { method, user: mapUser(user) };
      }
      default:
        throw new Error(`Unknown users method: ${method}`);
    }
  }

  // -- execute --------------------------------------------------------------

  async execute(params: Record<string, unknown>, _options: ExecuteOptions | undefined) {
    const serviceId = str(params.serviceId);

    try {
      switch (serviceId) {
        case "repos_write":
          return await this.executeReposWrite(params);
        case "issues_write":
          return await this.executeIssuesWrite(params);
        case "pulls_write":
          return await this.executePullsWrite(params);
        case "actions_write":
          return await this.executeActionsWrite(params);
        default:
          return { status: "failed", error: "Unknown service" };
      }
    } catch (error) {
      return asExecuteErrorPayload(error);
    }
  }

  private async executeReposWrite(params: Record<string, unknown>) {
    const method = requireString(params.method, "method");

    switch (method) {
      case "create_repo": {
        const name = requireString(params.name, "name");
        const description = str(params.description);
        const payload = {
          name,
          description: description || undefined,
          private: toBoolean(params.private, false),
          auto_init: toBoolean(params.auto_init, false),
        };

        const repo = rec(await ghFetch(this.ctx, "/user/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }));

        return {
          status: "completed",
          serviceId: "repos_write",
          method,
          repo: mapRepoDetails(repo),
        };
      }
      case "create_branch": {
        const owner = requireString(params.owner, "owner");
        const repo = requireString(params.repo, "repo");
        const branch = requireString(params.branch, "branch");
        let fromBranch = str(params.from_branch);

        if (!fromBranch) {
          const repoDetails = rec(await ghFetch(
            this.ctx,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            { method: "GET" },
          ));
          fromBranch = requireString(repoDetails.default_branch, "from_branch");
        }

        const ref = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
          { method: "GET" },
        ));
        const sha = requireString(rec(ref.object).sha, "source branch sha");

        const created = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha,
            }),
          },
        ));

        return {
          status: "completed",
          serviceId: "repos_write",
          method,
          owner,
          repo,
          branch: {
            name: branch,
            from_branch: fromBranch,
            ref: str(created.ref),
            sha: str(rec(created.object).sha) || sha,
          },
        };
      }
      case "create_or_update_file": {
        const owner = requireString(params.owner, "owner");
        const repo = requireString(params.repo, "repo");
        const path = requireString(params.path, "path");
        const message = requireString(params.message, "message");
        const content = requireString(params.content, "content");
        const branch = str(params.branch);
        const sha = str(params.sha);

        const result = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message,
              content,
              branch: branch || undefined,
              sha: sha || undefined,
            }),
          },
        ));

        const commit = rec(result.commit);
        const file = rec(result.content);
        return {
          status: "completed",
          serviceId: "repos_write",
          method,
          commit: {
            sha: str(commit.sha),
            message: str(commit.message),
            html_url: str(commit.html_url),
          },
          content: {
            name: str(file.name),
            path: str(file.path),
            sha: str(file.sha),
            html_url: str(file.html_url),
          },
        };
      }
      default:
        throw new Error(`Unknown repos_write method: ${method}`);
    }
  }

  private async executeIssuesWrite(params: Record<string, unknown>) {
    const method = requireString(params.method, "method");
    const owner = requireString(params.owner, "owner");
    const repo = requireString(params.repo, "repo");

    switch (method) {
      case "create": {
        const title = requireString(params.title, "title");
        const body = str(params.body);
        const issue = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              body: body || undefined,
              labels: stringList(params.labels),
              assignees: stringList(params.assignees),
            }),
          },
        ));

        return {
          status: "completed",
          serviceId: "issues_write",
          method,
          issue: mapIssue(issue),
        };
      }
      case "update": {
        const number = requireNumber(params.number, "number");
        const issue = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: str(params.title) || undefined,
              body: str(params.body) || undefined,
              state: str(params.state) || undefined,
              labels: arr(params.labels).length > 0 ? stringList(params.labels) : undefined,
              assignees: arr(params.assignees).length > 0 ? stringList(params.assignees) : undefined,
            }),
          },
        ));

        return {
          status: "completed",
          serviceId: "issues_write",
          method,
          issue: mapIssue(issue),
        };
      }
      case "comment": {
        const number = requireNumber(params.number, "number");
        const body = requireString(params.body, "body");
        const comment = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          },
        ));

        return {
          status: "completed",
          serviceId: "issues_write",
          method,
          comment: {
            id: num(comment.id),
            html_url: str(comment.html_url),
            body: str(comment.body),
            user: str(rec(comment.user).login),
            created_at: str(comment.created_at),
          },
        };
      }
      default:
        throw new Error(`Unknown issues_write method: ${method}`);
    }
  }

  private async executePullsWrite(params: Record<string, unknown>) {
    const method = requireString(params.method, "method");

    switch (method) {
      case "create": {
        const owner = requireString(params.owner, "owner");
        const repo = requireString(params.repo, "repo");
        const title = requireString(params.title, "title");
        const head = requireString(params.head, "head");
        const base = requireString(params.base, "base");
        const pull = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              body: str(params.body) || undefined,
              head,
              base,
              draft: toBoolean(params.draft, false),
            }),
          },
        ));

        return {
          status: "completed",
          serviceId: "pulls_write",
          method,
          pull: mapPull(pull),
        };
      }
      case "update": {
        const owner = requireString(params.owner, "owner");
        const repo = requireString(params.repo, "repo");
        const number = requireNumber(params.number, "number");
        const pull = rec(await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: str(params.title) || undefined,
              body: str(params.body) || undefined,
              state: str(params.state) || undefined,
              base: str(params.base) || undefined,
            }),
          },
        ));

        return {
          status: "completed",
          serviceId: "pulls_write",
          method,
          pull: mapPull(pull),
        };
      }
      case "merge":
        return this.executePullMerge(params);
      default:
        throw new Error(`Unknown pulls_write method: ${method}`);
    }
  }

  private async executePullMerge(params: Record<string, unknown>) {
    const token = str(params.confirmationToken);

    if (!token) {
      const owner = requireString(params.owner, "owner");
      const repo = requireString(params.repo, "repo");
      const number = requireNumber(params.number, "number");
      const mergeMethodRaw = str(params.merge_method) || "merge";
      const mergeMethod = (["merge", "squash", "rebase"].includes(mergeMethodRaw)
        ? mergeMethodRaw
        : "merge") as MergeConfirmationToken["merge_method"];
      const commitTitle = str(params.commit_title) || undefined;
      const commitMessage = str(params.commit_message) || undefined;

      const pull = rec(await ghFetch(
        this.ctx,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
        { method: "GET" },
      ));

      const confirmationPayload: MergeConfirmationToken = {
        serviceId: "pulls_write",
        method: "merge",
        owner,
        repo,
        number,
        merge_method: mergeMethod,
        commit_title: commitTitle,
        commit_message: commitMessage,
      };
      const confirmationToken = Buffer.from(JSON.stringify(confirmationPayload), "utf8").toString("base64");

      return {
        status: "pending_confirmation",
        confirmationToken,
        summary: {
          title: str(pull.title),
          number: num(pull.number) ?? number,
          head_branch: str(rec(pull.head).ref),
          base_branch: str(rec(pull.base).ref),
          merge_method: mergeMethod,
          mergeable: pull.mergeable === null ? "unknown" : pull.mergeable === true,
        },
        message: "Please confirm this pull request merge. Pass confirmationToken back to execute to complete.",
      };
    }

    let decoded: MergeConfirmationToken;
    try {
      const raw = Buffer.from(token, "base64").toString("utf8");
      const parsed = rec(JSON.parse(raw));
      decoded = {
        serviceId: parsed.serviceId === "pulls_write" ? "pulls_write" : "pulls_write",
        method: parsed.method === "merge" ? "merge" : "merge",
        owner: requireString(parsed.owner, "owner"),
        repo: requireString(parsed.repo, "repo"),
        number: requireNumber(parsed.number, "number"),
        merge_method: (["merge", "squash", "rebase"].includes(str(parsed.merge_method))
          ? str(parsed.merge_method)
          : "merge") as MergeConfirmationToken["merge_method"],
        commit_title: str(parsed.commit_title) || undefined,
        commit_message: str(parsed.commit_message) || undefined,
      };
    } catch {
      return {
        status: "failed",
        error: "Invalid confirmation token",
      };
    }

    if (decoded.serviceId !== "pulls_write" || decoded.method !== "merge") {
      return {
        status: "failed",
        error: "Invalid confirmation token",
      };
    }

    const mergeResult = rec(await ghFetch(
      this.ctx,
      `/repos/${encodeURIComponent(decoded.owner)}/${encodeURIComponent(decoded.repo)}/pulls/${decoded.number}/merge`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merge_method: decoded.merge_method,
          commit_title: decoded.commit_title,
          commit_message: decoded.commit_message,
        }),
      },
    ));

    return {
      status: "completed",
      serviceId: "pulls_write",
      method: "merge",
      owner: decoded.owner,
      repo: decoded.repo,
      number: decoded.number,
      merge_method: decoded.merge_method,
      merged: mergeResult.merged === true,
      sha: str(mergeResult.sha),
      message: str(mergeResult.message),
    };
  }

  private async executeActionsWrite(params: Record<string, unknown>) {
    const method = requireString(params.method, "method");

    switch (method) {
      case "rerun": {
        const owner = requireString(params.owner, "owner");
        const repo = requireString(params.repo, "repo");
        const runId = requireNumber(params.run_id, "run_id");
        const result = await ghFetch(
          this.ctx,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
        );

        return {
          status: "completed",
          serviceId: "actions_write",
          method,
          owner,
          repo,
          run_id: runId,
          result,
        };
      }
      default:
        throw new Error(`Unknown actions_write method: ${method}`);
    }
  }
}
