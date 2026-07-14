import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
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
    // ADR-004: src/core is the ecosystem-agnostic library; it must never
    // depend on the CLI or Action layers.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli/**", "**/action/**"],
              message: "src/core must not import from cli or action (ADR-004).",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
