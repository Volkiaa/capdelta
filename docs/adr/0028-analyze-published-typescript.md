# ADR-028: Analyze published TypeScript by stripping its types

- **Status:** Accepted (agent, 2026-10-21, under the maintainer's grant to decide the open drafts)
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

## Decision

Option B, with `engines` raised to `>=22` and Node 20 dropped from the CI
matrix and from the `main` ruleset's required checks. Node 20 reached end of
life on 2026-04-30, and the Action already runs on node24 (ADR-014).

1. A `.ts` file (not `.d.ts`) is stripped in the parser worker with amaro's
   `transformSync(source, { mode: "strip-only" })`, then parsed and analyzed
   like a `.js` file with `sourceType` `either`.
2. If amaro throws, or the stripped code's length differs from the source's,
   the file stays `unsupported-source`, as before, so its bytes still count as
   unanalyzed (degrade loudly). A JavaScript syntax error after stripping is
   `unparseable-source`, like any `.js` file.
3. Comment and string ranges come from the stripped code, which has the same
   offsets as the source the signal scan reads. A string in a type position
   (`type A = "https://..."`) is blank in the stripped code, so a URL there
   keeps context `unknown`, the stricter side.
4. Nothing changes for `.js`, `.mjs` and `.cjs`.

amaro is pinned to 1.1.11, the version Node 24.21 vendors for its own type
stripping. It was published on 2026-07-16 and has no dependencies. 1.2.2 was
one day old when this landed, too new for a security tool to trust.

Option A was rejected because its results would depend on the user's Node
version and the API is still experimental. Option C was rejected because Bun
and Deno run `.ts` files, so dropping them to INFO opens a blind spot.

## Evidence

- Full verification passes (872 tests). No golden fixture or attack
  reconstruction changed. `check:deps` reports 8 of 10 direct runtime
  dependencies. The parser worker bundle grows from 2.2 MB to 3.9 MB.
- `replay compare` against main: MATCH on all 20 drives (none of them ships
  TypeScript).
- Held-out corpus, both halves, against main at #152. 81 of 90 pair reports
  are unchanged. No pair changes its gate pass or fail, and no finding is
  added. 30 MEDIUM gate findings go away: `unparseable-file` and
  `unparseable-bytes-growth` on openai (3 pairs, diagnostics 877 to 2) and
  pino (3 pairs, 32 to 4). karma's 3 pairs change only the wording of their
  unsupported-source diagnostics: its `config.tpl.ts` is a template with
  placeholders, which amaro rejects as a syntax error. All removed findings were noise: each was a
  `.ts` file that now parses and shows no new capability.
- CLI drive, openai 7.38.0 -> 7.39.0: main reports 10 MEDIUM findings and 879
  diagnostics, this change reports no finding and 2 diagnostics. Those two are
  `src/core/api-promise.ts`, which uses a parameter property.

- Codex security review: APPROVE on the first round. After it, only the
  wording of the strip failure diagnostic changed.

## How to revert

Restore the `unsupported-source` branch for `.ts` in
`javascript-capability-extractor.ts`, remove `stripTypeScript` from the parser
worker and the `language` and `reason` protocol fields, and drop `amaro` from
`package.json`. Node 20 support can come back separately.
