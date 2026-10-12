# M5 measurement, 2026-10-12

Scoped formal measurement for PLAN §7.4. It reports how often capdelta's
**default CRITICAL gate fails on assumed-benign package bumps**, and how the
labeled attack reconstructions behave, at a frozen policy. It is not an
ecosystem-wide false-positive rate and not a malware detection rate.

Raw data: [corpus.json](corpus.json) (frozen pairs),
[results.json](results.json) (every attempt and bounded report), and
[labels.json](labels.json) (adjudication).

## Frozen inputs

| Item                   | Value                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Detector and policy    | `src/` identical to `ab36f1ab2b563f62809c2c003e7e7b37ef919816`                      |
| Measurement run at     | `6ca67212abb13b30042d2dc4c876198e6db520dc` (corpus committed first; tree clean)     |
| Corpus selected        | 2026-10-12T14:06:27Z, committed before analysis                                     |
| Run                    | 2026-10-12T14:06:38Z to 14:09:28Z, Node v24.21.0, linux-x64                         |
| Gate                   | threshold CRITICAL, `--strict` off, no allowlist, default analysis limits           |
| Tooling                | `scripts/m5-measure.ts` (#46): production `buildRunReport` + `evaluateSeverityGate` |
| `corpus.json` SHA-256  | `d671a98fe870323cce212976956074789b01db860d9aea814f49611b25184bbc`                  |
| `results.json` SHA-256 | `083728c6a21ee50f1a888232702757a58dc90fb1609e2c386fef3df8c67ae09e`                  |

## Corpus

30 packages, pre-registered as a stratified convenience sample, then frozen to
exact pairs (tarball URL and SHA-512) before any analysis. It is not random or
representative, and the 3 bumps per package are correlated.

- network: `got`, `undici`, `ws`, `socket.io`, `superagent`
- frameworks and servers: `fastify`, `koa`, `hono`, `vue`, `svelte`
- build tooling: `rollup`, `webpack`, `@babel/core`, `prettier`, `terser`
- CLI and utilities: `chalk`, `yargs`, `uuid`, `dayjs`, `zod`
- install hooks and native code: `bcrypt`, `sqlite3`, `@swc/core`, `puppeteer`, `protobufjs`
- credential-adjacent SDKs: `@aws-sdk/client-s3`, `firebase-admin`, `stripe`, `@octokit/rest`, `pg`

It is disjoint from the 2026-07-29 corpus and from the #27 tuning sample.
`postcss` was in the tuning sample, so it was replaced by `terser` before
selection. Pairs are adjacent among the 4 highest eligible versions (plain
`x.y.z`, not deprecated, SHA-512 integrity), ordered by version number rather
than publish time. Each pair is diffed as a single package, not as a lockfile
tree, so transitive additions are outside this sample.

## Results

| Measure                                                  |                                            Result |
| -------------------------------------------------------- | ------------------------------------------------: |
| Pairs requested / selected / analyzed                    |                                      90 / 90 / 90 |
| Unavailable, selection failures, retries                 |                                           0, 0, 0 |
| **Default gate failures / analyzed bumps**               |                                        **2 / 90** |
| ...of which accurate, review-worthy changes              |                                                 2 |
| ...of which noise or detector bugs                       |                                                 0 |
| Bumps with any HIGH (all noise)                          |                                                 1 |
| Bumps with any MEDIUM                                    | 7 (95 findings, 89 from `zod` TypeScript sources) |
| `--strict` counterfactual: bumps with unanalyzed content |                                           11 / 90 |
| Analysis diagnostics                                     |                                             2,120 |

**Gate failures.** Both are real registry install-hook changes, which PLAN §4.4
makes CRITICAL on purpose:

- `bcrypt` 5.1.1 → 6.0.0: `install` changed from
  `node-pre-gyp install --fallback-to-build` to `node-gyp-build`.
- `sqlite3` 5.1.6 → 5.1.7: `install` changed from
  `node-pre-gyp install --fallback-to-build` to
  `prebuild-install -r napi || node-gyp rebuild`, in a patch release.

**MEDIUM findings.** 91 of 95 are noise from published TypeScript sources
(`zod`, 89) and numeric CSS matrices read as charcode arrays (`webpack`, 2).
The other 4 are real but non-gating and not adjudicated: an unparseable
example file in `bcrypt` 5.1.1 (2 signals), `ENV` in `bcrypt` 6.0.0's
published test code, and `FS_WRITE` in `sqlite3` 6.0.1's
`deps/extract.js`.

**Noise.** The one HIGH (`yargs` 18.0.0, `stackoverflow.com`) is a link
inside a shell-completion script stored as a string literal. Every CRITICAL and HIGH label, and the MEDIUM labels, are in
[labels.json](labels.json) with reasons.

**Incomplete analysis.** 11 bumps would fail `--strict`: TypeScript sources in
`fastify`, `zod`, and `puppeteer`, and one unparseable file in `bcrypt`.
They count as analyzed above, but not every file was parsed.

| Package              | Bumps | Gate failures | C / H / M / L / I  | Strict-incomplete | Diagnostics |
| -------------------- | ----: | ------------: | ------------------ | ----------------: | ----------: |
| `got`                |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `undici`             |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `ws`                 |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `socket.io`          |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `superagent`         |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `fastify`            |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 3 |         102 |
| `koa`                |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `hono`               |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `vue`                |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `svelte`             |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `rollup`             |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `webpack`            |     3 |             0 | 0 / 0 / 2 / 0 / 0  |                 0 |           0 |
| `@babel/core`        |     3 |             0 | 0 / 0 / 0 / 1 / 0  |                 0 |           0 |
| `prettier`           |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `terser`             |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `chalk`              |     3 |             0 | 0 / 0 / 0 / 0 / 1  |                 0 |           0 |
| `yargs`              |     3 |             0 | 0 / 1 / 0 / 0 / 1  |                 0 |           0 |
| `uuid`               |     3 |             0 | 0 / 0 / 0 / 0 / 2  |                 0 |           0 |
| `dayjs`              |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `zod`                |     3 |             0 | 0 / 0 / 89 / 0 / 0 |                 3 |        1992 |
| `bcrypt`             |     3 |             1 | 1 / 0 / 3 / 1 / 1  |                 2 |           2 |
| `sqlite3`            |     3 |             1 | 1 / 0 / 1 / 3 / 1  |                 0 |           0 |
| `@swc/core`          |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `puppeteer`          |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 3 |          24 |
| `protobufjs`         |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `@aws-sdk/client-s3` |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `firebase-admin`     |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |
| `stripe`             |     3 |             0 | 0 / 0 / 0 / 0 / 1  |                 0 |           0 |
| `@octokit/rest`      |     3 |             0 | 0 / 0 / 0 / 0 / 1  |                 0 |           0 |
| `pg`                 |     3 |             0 | 0 / 0 / 0 / 0 / 0  |                 0 |           0 |

## Attack reconstructions (same frozen policy)

Run with `npx vitest run src/core/attack-reconstructions.test.ts` at
`6ca6721` on 2026-10-12 (21 of 21 checks pass). Mechanism demonstrations, not
held-out detection: the fixtures were designed
alongside the detector, and the two Shai-Hulud waves are related.

| Scenario                                          | Default gate | Why                                                                                 |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| axios 2026 (laundering through `plain-crypto-js`) | fails        | CRITICAL `postinstall` in the new package; axios shows the dependency, cross-linked |
| axios benign control                              | passes       |                                                                                     |
| axios with the dropper over an extraction cap     | **passes**   | dropper unavailable; only `--strict` fails (documented limit)                       |
| Shai-Hulud 2025 (`postinstall` bundle)            | fails        | hook plus install-code NET/ENV/PROCESS and secret exfiltration                      |
| Shai-Hulud 2025, bundle over the parser limit     | fails        | the hook alone                                                                      |
| Shai-Hulud 2025 benign control                    | passes       |                                                                                     |
| Shai-Hulud 2.0 (`preinstall` loader)              | fails        | CRITICAL `preinstall`                                                               |
| Shai-Hulud 2.0 benign control                     | passes       |                                                                                     |
| Synthetic `x/`-rooted layout evasion (ADR-013)    | fails        | analyzed despite the non-`package/` root                                            |

Separately, the real #27 lockfile bump (vitest 5, 47 packages) is dogfood
evidence, not part of this corpus: its one CRITICAL, a new native binary, was
reviewed and shown as suppressed by a version-scoped exception.

## Limitations

- A selected, clustered sample with single-reviewer labels (Claude), assuming
  every release is legitimate; legitimacy is not attested.
- Single-package diffs, not lockfile trees.
- No original malware artifacts. Reconstructions are synthetic, so this is not
  a recall estimate.
- Any later detector change makes these numbers historical; tuning requires a
  new independent corpus.
