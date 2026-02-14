# GitHub MCP Server vs Agenr Adapter -- Research

Date: 2026-02-14

## Part 1: The GitHub MCP Server

### What exists

1. **Official**: github/github-mcp-server (by GitHub)
   - Remote hosted version at https://api.githubcopilot.com/mcp/
   - Local version via Docker (ghcr.io/github/github-mcp-server)
   - Written in **Go**
   - Uses stdio or streamable HTTP transport

2. **Community**: Various on awesome-mcp-servers list, but the official one dominates.

### Toolsets (18 groups)

- context (default) -- user context
- actions -- GitHub Actions / CI/CD
- code_security -- code scanning alerts
- dependabot -- Dependabot alerts
- discussions -- GitHub Discussions
- gists -- Gist CRUD
- git -- low-level Git API (trees, blobs, refs)
- issues (default) -- issue CRUD
- labels -- label management
- notifications -- notification management
- orgs -- organization tools
- projects -- GitHub Projects (v2)
- pull_requests (default) -- PR CRUD
- repos (default) -- repository tools
- secret_protection -- secret scanning
- security_advisories -- security advisories
- stargazers -- star-related tools
- users (default) -- user profile tools

Remote-only additional toolsets: copilot, copilot_spaces, github_support_docs_search

### Tool count

The remote MCP server exposes **51 tools** as of June 2025. The local server
has a comparable number across all 18 toolsets. Default toolsets (context,
repos, issues, pull_requests, users) expose roughly 20-25 tools.

Known tool names from the gist and README:
- add_issue_comment
- add_pull_request_review_comment_to_pending_review
- assign_copilot_to_issue
- create_and_submit_pull_request_review
- create_branch
- create_issue
- create_or_update_file
- create_pending_pull_request_review
- create_pull_request
- create_repository
- delete_file
- delete_pending_pull_request_review
- dismiss_notification
- fork_repository
- get_code_scanning_alert
- get_commit
- get_file_contents
- get_issue
- get_issue_comments
- get_me
- get_pull_request
- get_pull_request_diff
- get_pull_request_files
- get_pull_request_reviews
- get_pull_request_comments
- issue_read (alias)
- list_branches
- list_commits
- list_issues
- list_notifications
- list_pull_requests
- list_workflow_runs
- merge_pull_request
- search_code
- search_issues
- search_repositories
- search_users
- update_issue
- update_pull_request
- actions_get
- actions_list
- actions_run
- actions_cancel_run
- actions_rerun
- actions_get_workflow_run_logs
- get_gist
- list_gists
- create_gist
- get_discussion
- list_discussions
(~51 total)

### Estimated token count for all tool schemas

Each tool schema (name + description + inputSchema JSON) averages ~150-300
tokens. With 51 tools: **~10,000-15,000 tokens** just for tool definitions.
The gist JSON alone is ~14KB of text which tokenizes to roughly 4,000-5,000
tokens for the raw JSON, but when formatted as MCP tool definitions with
descriptions it balloons further.

### Runtime

- Go binary, distributed as Docker image
- Local: runs as stdio subprocess
- Remote: hosted by GitHub at api.githubcopilot.com/mcp/

### Known issues

- Context bloat: 51 tools with full schemas is significant. GitHub added
  toolset filtering and dynamic toolsets specifically to address this.
- The README explicitly says: "Enabling only the toolsets that you need can
  help the LLM with tool choice and reduce the context size."
- Docker dependency for local usage adds friction.
- Each tool has its own individual schema -- no batching or grouping at the
  protocol level.

---

## Part 2: GitHub REST API Key Endpoints

Base URL: https://api.github.com

### Repos
- GET /user/repos -- list authenticated user's repos
- GET /repos/{owner}/{repo} -- get repo
- POST /user/repos -- create repo

### Issues
- GET /repos/{owner}/{repo}/issues -- list issues
- GET /repos/{owner}/{repo}/issues/{number} -- get issue
- POST /repos/{owner}/{repo}/issues -- create issue
- PATCH /repos/{owner}/{repo}/issues/{number} -- update issue
- POST /repos/{owner}/{repo}/issues/{number}/comments -- add comment
- GET /repos/{owner}/{repo}/issues/{number}/comments -- list comments

### Pull Requests
- GET /repos/{owner}/{repo}/pulls -- list PRs
- GET /repos/{owner}/{repo}/pulls/{number} -- get PR
- POST /repos/{owner}/{repo}/pulls -- create PR
- PATCH /repos/{owner}/{repo}/pulls/{number} -- update PR
- GET /repos/{owner}/{repo}/pulls/{number}/reviews -- list reviews
- PUT /repos/{owner}/{repo}/pulls/{number}/merge -- merge PR

### Search
- GET /search/issues?q= -- search issues/PRs
- GET /search/code?q= -- search code
- GET /search/repositories?q= -- search repos

### Actions / Workflows
- GET /repos/{owner}/{repo}/actions/runs -- list workflow runs
- GET /repos/{owner}/{repo}/actions/runs/{id} -- get run
- POST /repos/{owner}/{repo}/actions/runs/{id}/rerun -- re-run

### Users
- GET /user -- authenticated user
- GET /users/{username} -- user profile

### Branches
- GET /repos/{owner}/{repo}/branches -- list branches
- POST /repos/{owner}/{repo}/git/refs -- create branch (via ref)

### Files
- GET /repos/{owner}/{repo}/contents/{path} -- get file contents
- PUT /repos/{owner}/{repo}/contents/{path} -- create/update file

### Authentication
- Personal access tokens (classic or fine-grained)
- OAuth apps
- GitHub Apps (JWT + installation tokens)
- For our adapter: PAT with Bearer token is simplest

### Rate Limits
- Authenticated: 5,000 requests/hour
- Search API: 30 requests/minute
- GraphQL: 5,000 points/hour
- Response headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
- When exceeded: 403 with X-RateLimit-Remaining: 0

---

## Part 3: Adapter Design

### Service grouping

QUERY services (read-only):
- repos -- list repos, get repo, list branches, get file contents
- issues -- list issues, get issue, list comments
- pulls -- list PRs, get PR, get PR diff/files, list reviews
- search -- search issues, search code, search repos
- actions -- list workflow runs, get run
- users -- get me, get user profile

EXECUTE services (write/mutate):
- repos_write -- create repo, create branch, create/update file
- issues_write -- create issue, update issue, add comment
- pulls_write -- create PR, update PR, merge PR
- actions_write -- re-run workflow

### Auth

Strategy: "bearer"
authenticatedDomains: ["api.github.com"]
The user provides a GitHub PAT which gets stored as a credential.

### Token comparison

GitHub MCP Server (all 51 tools): ~10,000-15,000 tokens
Agenr adapter discover response: ~1,500-2,000 tokens (estimated)
Savings: ~80-85% reduction in initial context

### Confirmation flow

These execute operations should require confirmation:
- merge_pr (destructive, merges code)
- delete_branch (if we add it)
- create_repo (creates a permanent resource)

These can proceed without confirmation:
- create_issue, update_issue, add_comment (low risk, reversible)
- create_pr (creates draft-able, reversible)
- create/update file (commits are reversible via git)
- rerun_workflow (re-runs existing workflow)

### Rate limit handling

On any response with status 403, check:
- X-RateLimit-Remaining header
- If 0, parse X-RateLimit-Reset for retry-after timestamp
- Return structured error with retryAfterSeconds

---

## Part 4: Reference Files

Reviewed on MacBook at ~/Code/agenr/:
- data/adapters/dominos.ts -- full production adapter with discover/query/execute/confirmation flow
- data/adapters/echo.ts -- simple test adapter showing the pattern
- src/adapters/adapter.ts -- AgpAdapter interface (discover, query, execute)
- src/adapters/context.ts -- AdapterContext with ctx.fetch() for authenticated requests
- src/adapters/manifest.ts -- defineManifest, AuthStrategy types
