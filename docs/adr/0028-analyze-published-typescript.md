# ADR-028: Analyze published TypeScript by stripping its types

- **Status:** Proposed
- **Date:** 2026-10-21
- **Plan reference:** PLAN §4 (capability extraction), §10 (dependency budget), CLAUDE.md "Autonomy", Tier 3

## Context

The JavaScript extractor skips `.d.ts` files and marks every other `.ts` file
`unsupported-source` without parsing it
(`src/core/npm/javascript-capability-extractor.ts:134-198`). Two things follow:

- Noise. zod ships its TypeScript sources, so each bump reports MEDIUM
  `unparseable-file` findings. That is 86 in M5, the largest noise class
  (`docs/m5-2026-10-12/labels.json:35-40`).
- Blind spots. No capability is extracted from a `.ts` file, and every URL in
  one gets context `unknown`, including URLs in comments. That is 66 of 78
  tuning `unknown` rows, all from openai.

Node does not strip types inside `node_modules`, so plain Node does not run
these files. Bun, Deno and loaders such as `tsx` do.

## Options

| Option                                                      | New runtime dependency                                    | Node support                                                                     | What changes                                          |
| ----------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A. Node's `module.stripTypeScriptTypes`                     | none                                                      | needs Node 22.13 or later, and is still experimental on 24.21 (prints a warning) | results differ by Node version unless `engines` rises |
| B. `amaro`, the package Node itself uses for type stripping | 1 (7 to 8, budget under 10), MIT, no dependencies, 3.5 MB | `engines` `>=22`                                                                 | parse `.ts` like `.js`                                |
| C. Treat `.ts` in a package as not runtime code             | none                                                      | unchanged                                                                        | `.ts` drops to INFO and stays unanalyzed              |

## Measurement (prototype, 2026-10-21)

Strip-only type stripping, then `acorn.parse` with capdelta's settings, on
every non-`.d.ts` `.ts` file. Options A and B gave identical results.

| Package       | `.ts` files | Parse after stripping | Line count unchanged |
| ------------- | ----------- | --------------------- | -------------------- |
| zod 4.6.6     | 332         | 307                   | 307 of 307           |
| openai 7.39.0 | 440         | 439                   | 439 of 439           |

The failures use syntax that strip-only mode rejects: namespaces, enums and
parameter properties. Stripping swaps types for spaces, so lines and offsets
stay the same, and evidence locations and string ranges need no mapping.

## Proposal

Option B, with `engines` raised to `>=22` and Node 20 dropped from the CI
matrix. Node 20 reached end of life on 2026-04-30, and the Action already runs
on node24 (ADR-014).

1. A `.ts` file (not `.d.ts`) is stripped in the parser worker, then parsed
   and analyzed like a `.js` file with `sourceType` `module`.
2. A file that strip-only mode rejects stays `unsupported-source`, as today,
   so its bytes still count as unanalyzed (degrade loudly).
3. Nothing else changes for `.js`, `.mjs` and `.cjs`.

## Why this is Tier 3

- It adds a runtime dependency and drops a Node version, which is a PLAN
  deviation.
- It lowers findings. The `unparseable-file` MEDIUMs go away for files that now
  parse, and URLs in parsed `.ts` files can drop to LOW under ADR-024.
- It also raises findings. Capabilities in `.ts` files become visible, so
  dependencies that ship TypeScript sources may report new capability
  findings. Only a held-out run can show how many.

## Decision needed

Choose A, B or C, and decide on Node 20. The implementation and its held-out
measurement come after that choice.
