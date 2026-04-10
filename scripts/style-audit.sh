#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_PATH=""

while (($# > 0)); do
  case "$1" in
    --write)
      if (($# < 2)); then
        echo "Missing path for --write" >&2
        exit 1
      fi
      OUTPUT_PATH="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

TARGETS=(
  "src"
  "tests"
  "scripts"
  "packages"
)

IGNORE_GLOBS=(
  "--glob"
  "!scripts/style-audit.sh"
  "--glob"
  "!docs/internal/plans/*style-audit*"
  "--glob"
  "!docs/internal/prompts/*style-audit*"
)

append() {
  printf "%s\n" "$1"
}

run_section() {
  local heading="$1"
  local description="$2"
  local pattern="$3"
  shift 3
  local target_args=("$@")
  local matches=""
  local count="0"

  if ((${#target_args[@]} == 0)); then
    target_args=("${TARGETS[@]}")
  fi

  matches="$(rg -n -S "${IGNORE_GLOBS[@]}" "$pattern" "${target_args[@]}" || true)"

  if [[ -n "$matches" ]]; then
    count="$(printf "%s\n" "$matches" | sed '/^$/d' | wc -l | tr -d ' ')"
  fi

  append "## $heading"
  append ""
  append "$description"
  append ""
  append "- Match count: $count"
  append ""

  if [[ -n "$matches" ]]; then
    append '```text'
    printf "%s\n" "$matches"
    append '```'
  else
    append "_No matches found._"
  fi

  append ""
}

emit_report() {
  append "# Style Audit Report"
  append ""
  append "- Generated at: $(date -u +"%Y-%m-%d %H:%M:%SZ")"
  append "- Repository: $ROOT_DIR"
  append "- Scope: src, tests, scripts, packages"
  append ""
  append "This audit is a candidate finder for the coding-style rules in \`AGENTS.md\`."
  append "Not every match is a bug. Some categories require manual review."
  append ""

  run_section \
    "TypeScript Suppressions" \
    "Review every TypeScript or ESLint suppression. The preferred fix is to remove the suppression by fixing the root cause." \
    '(@ts-(ignore|expect-error|nocheck))|(eslint-disable(-next-line)?)'

  run_section \
    "Explicit Any" \
    "Review explicit \`any\` usage. Some matches may be comments or identifiers, but most type-position matches should be removed." \
    '(\bas any\b)|(:[[:space:]]*any\b)|(<any>)|(\bArray<any>\b)|(\bPromise<any>\b)|(\bRecord<[^>]*\bany\b)'

  run_section \
    "Stringly Typed Control Flow" \
    "Review freeform string fields that may be acting as control-flow codes. Prefer closed unions or typed codes when practical." \
    '(\b(reason|error):[[:space:]]*string(\s*\|\s*null)?)|(__error:[[:space:]]*string)'

  run_section \
    "Magic Zero Fallbacks" \
    "Review \`?? 0\` fallbacks. Many numeric aggregations are valid, but some may hide missing state or implicit semantics." \
    '\?\?[[:space:]]*0'

  run_section \
    "Prototype Mutation" \
    "Review prototype mutation or prototype-level patching. Prefer composition, explicit inheritance, or per-instance test doubles." \
    'prototype\.|Object\.defineProperty\([^)]*\.prototype'

  run_section \
    "Dynamic Imports In Production" \
    "Review production-path dynamic imports. If lazy loading is required, keep it behind a dedicated runtime boundary and avoid mixing static and dynamic imports for the same module." \
    'await import\(' \
    src packages

  run_section \
    "Boundary Parsing Candidates" \
    "Review parsing and boundary-handling sites. External boundaries should use explicit validation or existing repo helpers where practical." \
    'JSON\.parse\(|validate\(|parse[A-Z][A-Za-z0-9]*\(|create[A-Z][A-Za-z0-9]*Schema|Type\.(Object|Array|Union|Optional)|@sinclair/typebox'

  run_section \
    "Non-American Spellings" \
    "Review comments, docs strings, and identifiers for non-American spellings." \
    '\b(colour|behaviour|analyse|optimise|optimised|favour|favourite|normalise|organise|organisation|catalogue)\b' \
    src tests scripts packages docs
}

if [[ -n "$OUTPUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  emit_report >"$OUTPUT_PATH"
  echo "Wrote style audit report to $OUTPUT_PATH"
else
  emit_report
fi
