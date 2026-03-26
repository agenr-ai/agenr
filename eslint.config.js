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
      // Require Google-style JSDoc on all exported functions, interfaces, and types
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: true,
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
          ],
        },
      ],
    },
  },
);
