import js from "@eslint/js";
import globals from "globals";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

const tsFiles = ["**/*.{ts,mts,cts}"];
const sourceFiles = ["**/*.{js,mjs,cjs,ts,mts,cts}"];
const tsRecommended = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: tsFiles,
}));

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "**/*.d.ts"],
  },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tsRecommended,
  {
    files: sourceFiles,
    rules: {
      "no-console": "off",
      "no-undef": "off",
    },
  },
  {
    files: tsFiles,
    plugins: { jsdoc },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          disallowTypeAnnotations: false,
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      // Require Google-style JSDoc on all functions, interfaces, and types (not just exported)
      // This helps coding agents (Codex, Claude Code) understand internal intent
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ExportNamedDeclaration > VariableDeclaration"],
        },
      ],
      "jsdoc/require-description": ["warn", { contexts: ["any"] }],
      "jsdoc/require-param": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/check-tag-names": ["warn", { typed: true }],
    },
  },
  // THE HEXAGONAL BOUNDARY RULE:
  // core/ must NEVER import from adapters/ or cli/
  {
    files: ["src/core/**/*.{ts,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/**", "**/cli/**"],
              message: "core/ must not import from adapters/ or cli/. Use port interfaces instead.",
            },
            {
              group: ["**/logger.js"],
              message: "core/ must not depend on process-global logging. Use core return values or an application-layer callback.",
            },
            {
              group: ["node:fs", "node:fs/promises"],
              message: "core/ must not perform filesystem IO. Move it behind a port or application-layer service.",
            },
          ],
        },
      ],
    },
  },
  // Recall eval adapter guardrails:
  // 1. Route handlers should stay thin and should not reach into core/ directly.
  // 2. Eval app orchestration should not depend on CLI modules.
  // 3. Keep artifact policy and filesystem behavior out of core/.
  {
    files: ["src/adapters/api/routes/**/*.{ts,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/**"],
              message: "API route handlers must stay thin. Call app services instead of importing core/ directly.",
            },
            {
              group: ["**/cli/**"],
              message: "API route handlers must not depend on CLI modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/evals/**/*.{ts,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli/**"],
              message: "Eval app services must not depend on CLI modules.",
            },
          ],
        },
      ],
    },
  },
);
