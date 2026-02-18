#!/usr/bin/env bash
# gen-coderabbit-prompt.sh
# Generates a Codex prompt from the latest CodeRabbit review on a PR.
#
# Usage:
#   ./scripts/gen-coderabbit-prompt.sh <pr-number>
#   ./scripts/gen-coderabbit-prompt.sh <pr-number> --output /path/to/output.md
#
# Output: docs/internal/prompts/codex-pr<N>-coderabbit.md (default)
#
# Requirements:
#   - gh CLI (https://cli.github.com) authenticated
#   - Run from the repo root

set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" ]]; then
  echo "Usage: $0 <pr-number> [--output <file>]" >&2
  exit 1
fi

# Optional --output flag
OUTPUT_FILE=""
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Must be run from a git repo root
if ! git rev-parse --show-toplevel &>/dev/null; then
  echo "Error: must be run from inside a git repository" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Detect package manager
if [[ -f "pnpm-lock.yaml" ]]; then
  TEST_CMD="pnpm test"
elif [[ -f "yarn.lock" ]]; then
  TEST_CMD="yarn test"
elif [[ -f "bun.lockb" ]]; then
  TEST_CMD="bun test"
else
  TEST_CMD="npm test"
fi

# Default output path
if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_DIR="docs/internal/prompts"
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_FILE="${OUTPUT_DIR}/codex-pr${PR}-coderabbit.md"
fi

echo "Fetching PR #${PR} details..." >&2

# Pull PR metadata
PR_META="$(gh pr view "$PR" --json title,headRefName,baseRefName)"
PR_TITLE="$(echo "$PR_META" | jq -r '.title')"
PR_BRANCH="$(echo "$PR_META" | jq -r '.headRefName')"

echo "Fetching latest CodeRabbit review..." >&2

# Pull latest CodeRabbit review - handles both 'coderabbitai' and 'coderabbitai[bot]'
REVIEW_BODY="$(gh pr view "$PR" --json reviews --jq '
  .reviews
  | map(select(.author.login | test("coderabbitai"; "i")))
  | last
  | .body
  // empty
')"

if [[ -z "$REVIEW_BODY" ]]; then
  echo "Error: no CodeRabbit review found on PR #${PR}" >&2
  exit 1
fi

cat > "$OUTPUT_FILE" <<EOF
# Codex Task: Fix CodeRabbit feedback on PR #${PR}

**PR:** #${PR} - ${PR_TITLE}
**Branch:** ${PR_BRANCH}
**Repo:** ${REPO_ROOT}

## Instructions

Read every comment in the CodeRabbit review below and fix all of them.
CodeRabbit specifies the exact file, line range, and change needed for each issue.

After fixing:
1. Run: ${TEST_CMD}
2. All tests must pass - fix any failures before committing
3. Commit and push:
   git add -A
   git commit -m "fix: address CodeRabbit review findings on PR #${PR}"
   git push

## CodeRabbit Review

${REVIEW_BODY}
EOF

echo "Generated: ${OUTPUT_FILE}" >&2
echo "$OUTPUT_FILE"
