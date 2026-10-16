import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const COMPLEXITY_LIMIT = 20;

// Files that already exceed COMPLEXITY_LIMIT, at their current highest score.
// Lower a file's number when you split its functions, and delete the entry
// once the file is at or under the limit. Never raise a number or add a file.
const COMPLEXITY_BASELINE = {
  "src/core/analysis-execution-policy.ts": 29,
  "src/core/capability-analysis-pipeline.ts": 38,
  "src/core/capdelta-config.ts": 27,
  "src/core/npm/javascript-capability-extractor.ts": 23,
  "src/core/npm/javascript-parser-worker.ts": 28,
  "src/core/npm/lockfile-differ.ts": 32,
  "src/core/report-builder.ts": 23,
  "src/core/sarif-reporter.ts": 29,
  "src/core/signal-differ.ts": 31,
  "src/core/signal-extractor.ts": 30,
};

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "test/fixtures/golden/*/source-*/",
      "test/fixtures/reconstructions/*/packages/",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain-JS repo tooling (scripts/, this config file): type-aware rules
    // need a tsconfig project, which these files are deliberately outside of.
    files: ["**/*.{js,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node globals for the same plain-JS tooling files (core no-undef applies
    // there; in TS files the compiler owns undefined-name checking instead).
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    // ADR-004
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Bare "**/cli" is required in addition to "**/cli/**":
              // gitignore-style matching does not let "**/cli/**" match a
              // barrel import like "../../cli" (review finding).
              group: ["**/cli", "**/cli/**", "**/action", "**/action/**"],
              message: "src/core must not import from cli or action (ADR-004).",
            },
          ],
        },
      ],
    },
  },
  { rules: { complexity: ["error", COMPLEXITY_LIMIT] } },
  ...Object.entries(COMPLEXITY_BASELINE).map(([file, max]) => ({
    files: [file],
    rules: { complexity: ["error", max] },
  })),
  prettier,
);
