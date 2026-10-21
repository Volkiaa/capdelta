# Session log

Newest session last. Each entry: completed work (with verified references),
resume points, ADRs produced, and open questions.

## 2026-07-14 — Bootstrap, M0, M1 LockfileDiffer, high-effort review + fixes

### 1. Completed

**Repo bootstrap.** CLAUDE.md working agreement committed;
`docs/capdelta-dev-plan.md` renamed to `docs/PLAN.md` after confirming it is
rev. 3 (PLAN.md:1). Git repo initialized, private GitHub repo created:
https://github.com/Volkiaa/capdelta.

**M0 — scaffolding ([PR #1](https://github.com/Volkiaa/capdelta/pull/1), merged).**

- Flat single package instead of the packages/core|cli|action monorepo —
  approved in-session; rationale recorded in ADR-004 "Alternatives rejected".
- TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, ESM
  NodeNext (tsconfig.json); ESLint flat config with typescript-eslint
  strictTypeChecked; Prettier; vitest.
- CI on Node 20 + 22, actions pinned by commit SHA
  (.github/workflows/ci.yml:24-25).
- Dependency-budget gate: scripts/check-dep-budget.mjs fails at ≥10 direct
  runtime deps; exit-1 path verified manually with a 10-dep manifest.
  Current count: 0 direct, 0 transitive.
- Apache-2.0 LICENSE (canonical text via GitHub licenses API); SECURITY.md
  (GitHub Private Vulnerability Reporting only, per user choice); ADR
  TEMPLATE + ADR-001…005.

**M1 component 1 — LockfileDiffer ([PR #2](https://github.com/Volkiaa/capdelta/pull/2), open, CI green).**
Design approved in prose before implementation, per the working agreement.

- Contract: src/core/contract/lockfile-diff.ts — `ChangedPackage` (with
  `oldResolvedUrl`, lockfile-diff.ts:26, per ADR-006), `LockfileFinding`
  (facts only, ADR-008), `SkippedPackage`, `firstRun`.
- Implementation: `diffNpmLockfiles` (src/core/npm/lockfile-differ.ts:46).
  Throw-vs-flag split: whole-lockfile problems throw typed errors
  (src/core/npm/errors.ts); per-entry problems flag and continue.
- Hand-rolled semver ordering (src/core/npm/semver.ts) — keeps runtime deps
  at zero.
- 15 handcrafted inert fixtures (test/fixtures/lockfiles/), one per PLAN §4.1
  edge case.
- ADR-004 boundary lint rule (eslint.config.js:45), verified empirically:
  a probe `import … from "../cli"` inside src/core fails lint.

**High-effort code review of PR #2, then all 10 findings fixed.**
8 finder angles + verification pass; 10 confirmed findings; fixes committed
(36bdc20, 1663ee7, 1b5e918) and summarized in a PR comment. Verified fixes:

- `sameArtifact` shared identity incl. resolved URL
  (src/core/npm/lockfile-differ.ts:215, used at :108 and in matchMoved :289) —
  closes the silent drop of re-pointed moved copies.
- Injective dedup key via JSON.stringify (lockfile-differ.ts:176) — the
  shipped separator was, embarrassingly, a literal invisible NUL byte; see
  "process lesson" below.
- Integrity-changed finding requires old integrity present
  (lockfile-differ.ts:119).
- Full-artifact distinctness in matchMoved — no order-dependent baseline.
- Malformed old-side entries flagged, not silently dropped
  (lockfile-differ.ts:74).
- Baseline analyzability + ADR-006: old-side fields null as a unit when the
  baseline is unfetchable (lockfile-differ.ts:158-159); invariant
  `oldResolvedUrl` non-null iff `oldVersion` non-null is tested.
- Budget script path rule aligned with the differ
  (scripts/check-dep-budget.mjs:33); dev-entry difference documented as
  intentional in both files.
- Tests: 40 passing (30 differ + 5 semver + 5 budget), including 7 review
  regression tests. CI green on Node 20 and 22.

**Process lesson (invisible-character hazard).** Twice this session an
intended visible `\u0000` escape was emitted as a literal NUL byte during
authoring — once into shipped code (the dedup join separator), once into a
test draft. It rendered invisibly in every reader, including review agents.
Mitigation now in repo: scratch sanitizer script converts literal NULs to
escapes; worth considering a CI grep for control characters in source files.

### 2. Half-done / where to resume

- **PR #2 awaits your review and merge.** Everything on branch
  `feat/lockfile-differ`; CI green.
- **M1 remaining (PLAN §6:151):** Fetcher (integrity verification + safe
  extraction are day-one requirements, not hardening), manifest layer,
  JSON/text report, no-op fast path, golden manifest-layer fixture pairs.
  **Resume point:** design proposal for the Fetcher — interface, types,
  error taxonomy in prose, wait for approval. Inputs are `ChangedPackage[]`;
  ADR-006 guarantees `oldResolvedUrl` so no URL reconstruction. See open
  question on change-set slicing below.
- **Retrieval component** (GitHub contents API for the base lockfile, CLI
  `git show` fallback — PLAN §4.1:72) not started; independent of the Fetcher.
- No other in-flight work: the working tree is clean apart from this
  close-out commit.

### 3. Decisions promoted to ADRs this session

- ADR-006 — ChangedPackage carries oldResolvedUrl; unfetchable baselines get
  newly-added treatment (drafted during review fixes).
- ADR-007 — moved-package matching rule (drafted at close-out; the in-session
  approved rule plus the full-artifact distinctness correction).
- ADR-008 — differ emits facts, severity model owns severity (drafted at
  close-out).
- ADR-009 — non-npmjs host = private in v0.1 (drafted at close-out).

### 4. Open questions for you

1. **Merge PR #2?** All review findings fixed; ADRs 006–009 ride on the same
   branch.
2. **Change-set slicing for the next milestone step:** PLAN M1 bundles
   "Fetcher + safe extraction" as day-one security, but the working agreement
   caps a change set at one component + tests. Two PRs (Fetcher, then
   Extractor) or one combined security-critical PR?
3. **Dev dependencies:** the differ analyzes dev entries (their install
   scripts run on `npm install`); the budget gate excludes them. Confirm this
   asymmetry is intended product behavior (it is documented in both files).
4. **ADR-009 stance OK?** Mirrors (npmmirror etc.) are skipped-and-flagged
   until allowlist config exists — acceptable for v0.1?
5. **Repo settings (yours to do):** enable GitHub Private Vulnerability
   Reporting (SECURITY.md links to it) and, optionally, branch protection
   requiring the CI check.
6. **Control-character CI check:** want a tiny grep-based CI step rejecting
   control characters in source, given the NUL incident?

## 2026-07-14 — M1 Fetcher and Safe Extractor

### 1. Completed and verified

- **M1 LockfileDiffer is on `main`:** PR #2 merged as `c8cb62a`. Its contract
  exposes both old and new tarball locations (`src/core/contract/lockfile-diff.ts:17-29`),
  allowing downstream code to fetch without reconstructing registry URLs.
- **M1 Fetcher is implemented:** `fetchChangedPackages` returns either verified
  inert bytes or a package-local, typed failure (`src/core/npm/fetcher.ts:13-28,
126-165`). It enforces declared and streamed tarball size caps
  (`src/core/npm/fetcher.ts:265-296,342-367`) and verifies SHA-512 SRI before
  returning bytes (`src/core/npm/fetcher.ts:298-308`). The targeted tests cover
  old/new fetching, integrity mismatch, timeout, size limits, cache recovery,
  and concurrency (`src/core/npm/fetcher.test.ts:36-331`). PR #3 merged into
  `feat/lockfile-differ` as `ae99043`.
- **M1 Safe Extractor is implemented:** `extractVerifiedTarball` returns an
  extracted private root with cleanup or a structured rejection
  (`src/core/npm/safe-extractor.ts:19-47,92-140`). It strictly preflights the
  opaque verified archive before extraction (`src/core/npm/safe-extractor.ts:143-193`),
  then extracts only the validated npm `package/` layout (`src/core/npm/safe-extractor.ts:195-216`).
  Unsafe paths, links, unsupported entry types, and resource limits are rejected
  (`src/core/npm/safe-extractor.ts:218-264`). Its inert handcrafted-archive
  tests exercise the success and attack paths (`src/core/npm/safe-extractor.test.ts:18-203`).
- **Dependency decision is implemented:** the approved `tar` runtime parser is
  the only direct runtime dependency (`package.json:29-31`), within PLAN §10's
  budget. The public barrel exposes all three completed components
  (`src/index.ts:2-40`).
- **Verification:** local `lint`, `format:check`, strict `typecheck`, `test`
  (63 tests), and `check:deps` passed using the scripts in `package.json:11-17`.
  PR #4 is currently open against `feat/lockfile-differ`, mergeable/clean, and
  its Node 20 and Node 22 CI checks passed. The extractor implementation is
  commit `95290ac`.

### 2. Half-done and exact resume point

- **Integration branch promotion is pending:** `main` contains PR #2 only.
  PR #3 was merged into `feat/lockfile-differ`; PR #4 is stacked on that same
  branch. Merge PR #4, then open or retarget a PR from `feat/lockfile-differ`
  to `main` so the Fetcher and Extractor reach the default branch together.
- **M1 remains incomplete:** the manifest-only capability extractor, old-vs-new
  manifest diff/reporting, no-op fast path, and golden fixtures are still
  required by PLAN §6. Resume with a design proposal for one component:
  `ManifestCapabilityExtractor`, taking an `ExtractedTarball` and returning
  normalized `package.json` behavior facts. Do not add orchestration or package
  retrieval in that change.
- The extractor has adversarial unit coverage, but has not yet been fuzzed;
  fuzzing belongs to the later quality/security work rather than this scoped M1
  component.

### 3. Decisions promoted to ADRs this session

- **ADR-010** records the preflight-before-extract boundary and rejection of all
  link entries, implementing PLAN §3's safe-extraction requirement.
- **ADR-011** records the initial entry, expanded-size, compression-ratio, and
  metadata limits, plus the package-local failure behavior.

### 4. Open questions for you

1. After PR #4 merges, should I open the promotion PR from
   `feat/lockfile-differ` to `main`, or do you prefer to manage that branch
   transition yourself?
2. Confirm the recommended next scoped chunk: a manifest-only capability
   extractor (no Fetcher/Extractor orchestration yet).
3. Do you want to enable GitHub Private Vulnerability Reporting and branch
   protection requiring the Node 20/22 checks? This requires repository-admin
   settings rather than a code change.
4. Should we add the previously noted control-character CI check before M1
   finishes, or keep it listed as an adjacent hardening task?

## 2026-07-29 — M3 completion and post-M3 handoff

### 1. Completed and verified

- **M1 is complete on `main`:** PR #8 merged the manifest capability contract,
  additions-only Differ, deterministic JSON/text reports, golden fixtures, CLI,
  and Action integration as `4230782`. The current orchestration entrypoint is
  `analyzeChangedPackages` (`src/core/capability-analysis-pipeline.ts:186`), and
  the report contract is schema v3 (`src/core/report-contract.ts:23`).
- **M2 is complete on `main`:** the Action retrieves the immutable base through
  the GitHub API, publishes a size-capped sticky comment or job-summary fallback,
  uploads the full JSON artifact, and gates by severity. The comment renderer
  and delivery boundary are at `src/action/action-comment-reporter.ts:85,113`;
  findings are sorted by severity before the ten-row cap
  (`src/action/action-comment-reporter.ts:263-289`). These components reached
  `main` through `4230782` and subsequent Action fixes through `1ba0c9c`.
- **M3 is complete on `main`:** PR #7 implemented Acorn taxonomy detection,
  bounded resolution, install-code attribution, shape-based severity, SARIF,
  new-dependency cross-linking, and the FP harness (`1377dad`, promoted through
  PR #8). The core Differ begins at `src/core/capability-differ.ts:89`; SARIF is
  explicitly 2.1.0 (`src/core/sarif-reporter.ts:8,20`); the harness accepts its
  bounded package/bump inputs at `scripts/fp-check.ts:139-164`.
- **Post-M3 hardening/refactors are complete:** terminology (`0dd3fe2`), pure
  severity classification (`b12a096`), one-pass AST traversal (`90142ff`), a
  unified execution policy (`70ea22d`), report decomposition (`d422c10`), and
  CLI/Git separation (`6e30222`). Defaults enforce a five-minute run deadline
  plus bounded fetch, extraction, manifest, and parser work
  (`src/core/analysis-execution-policy.ts:66-83`); Git resolves an immutable
  commit and reads its lockfile blob without a shell
  (`src/cli/git-lockfile-retriever.ts:32-45,103-146,149-178`).
- **Repository status:** the GitHub repository is now public; the npm package
  remains marked private and unpublished (`package.json:2-5`).

### 2. Half-done and exact resume point

- The implementation is at the mandatory post-M3 checkpoint in PLAN §6. The
  runner exists (`scripts/fp-check.ts:34-136`), but no representative
  multi-package corpus result or interpretation is committed. Resume by choosing
  the package list, running several adjacent legitimate bumps, and recording
  findings-per-bump and tuning observations before adding M4 detectors.
- M4 execution-policy work landed early, but M4 signal work has not started:
  URL-domain diffs, entropy/minified-blob signals, justified allowlists,
  extractor fuzzing, and benign-pattern suppression remain open (PLAN §4.3,
  §6). Keep the first implementation change to one signal component + tests.

### 3. ADR status

- ADR-012 records M3's Acorn and bounded-honesty decision
  (`docs/adr/0012-acorn-ast-parser.md:1-41`). No additional ADR is required for
  the recent responsibility refactors: they implement existing PLAN §2
  concurrency/degrade-loudly and PLAN §4 boundaries without changing product
  behavior.

### 4. Open questions

1. Which packages should form the first committed FP corpus? A useful mix needs
   small utilities, framework/runtime packages, native installers, and packages
   with legitimate install hooks.
2. GitHub's repository API reported Private Vulnerability Reporting disabled on
   2026-07-29. Should it be enabled now so `SECURITY.md` can offer a direct
   private disclosure button instead of the detail-free-contact fallback?
3. Should `main` require the Node 20/22 CI and capdelta dogfood checks before the
   first public npm release?

## 2026-07-29 — Post-M3 false-positive corpus checkpoint

### 1. Completed and verified

- Ran the existing static-only harness over 20 popular packages and three
  adjacent stable, nondeprecated bumps per package: 60/60 bumps analyzed, with
  zero unavailable bumps and zero package errors. The harness verifies SHA-512,
  safely extracts, and invokes the capability pipeline without installing or
  executing package code (`scripts/fp-check.ts:34-136`).
- Recorded the complete corpus and interpretation in
  `docs/fp-corpus-2026-07-29.md`: 54/60 bumps had no capability findings; the
  remaining six produced 16 findings, all LOW/INFO; no bump would fail the
  default CRITICAL gate. The run also produced 1,258 diagnostics, concentrated
  in declaration files and oversized JavaScript.
- Inspected every finding-positive bump. Dependency, filesystem, UNKNOWN, and
  runtime-engine facts were real additions or changes. No capability shape
  fired. Existing behavior did not re-alert, consistent with the additions-only
  Differ (`src/core/capability-differ.ts:85-120`).

### 2. Half-done and exact resume point

- M4 signal work has not started. Before adding a signal, propose one scoped
  JavaScript-extractor change: classify `.d.ts` declaration files as
  non-executable metadata instead of emitting one `unsupported-source`
  diagnostic per file. Preserve loud diagnostics for executable `.ts` and
  oversized `.js`, and implement only this change plus its unit tests after
  approval.
- Treat UNKNOWN provenance as a separate design discussion and change set.
  Preserve the PLAN §7.1 adversarial invariant that
  `require('child' + '_process')` resolves to UNKNOWN.

### 3. ADR status

- No ADR was added. The corpus record is empirical evidence and does not change
  the architecture. A future UNKNOWN-provenance design may require an ADR if it
  changes the bounded resolution-honesty tier in PLAN §4.3 / ADR-012.

### 4. Open questions

1. Approve the `.d.ts` design direction as the first pre-signal M4 change?
2. After that isolated change, should UNKNOWN retain originating-module
   provenance so local/vendored member chains can be distinguished from dynamic
   module loads without suppressing either?
3. Should dependency additions be aggregated only in the capped PR-comment
   table while preserving every fact in JSON/SARIF?

## 2026-07-29 — M4 completion

### 1. Completed and verified

- Added the plan-seeded routine install-script recognizer in
  `src/core/benign-install-script.ts`; `node-gyp rebuild`, `husky install`,
  and `patch-package` are conservative whole-command matches, represented by
  `InstallHookCapability.benignPattern` (`src/core/contract/capability-set.ts:55-67`).
  Routine registry hooks fall back to INFO and do not trigger the install-hook
  shape when the transition is routine (`src/core/capability-differ.ts:331-345,440-454`).
- Added malformed-input property tests for the safe extractor and Acorn layer
  using dev-only `fast-check` (`src/core/npm/safe-extractor.fuzz.test.ts`,
  `src/core/npm/javascript-capability-extractor.fuzz.test.ts`). The safe
  manifest preflight writes only `package.json` after validating the whole
  archive (`src/core/npm/safe-extractor.ts:133-144,216-225`).
- The scheduler now preflights manifests and prioritizes install-hook packages,
  then smaller verified downloads, then lockfile order while retaining report
  order (`src/core/capability-analysis-pipeline.ts:260-373,563-605`).
- Verification passed: `npm test` — 242 tests / 28 files; lint, typecheck,
  formatting, dependency budget, and Action bundle generation also passed.

### 2. Half-done and exact resume point

- M4 is complete. Resume at M5 formal validation and publication work in
  PLAN §6; the routine recognizer remains explicitly provisional until that
  corpus validates its false-positive behavior (`src/core/benign-install-script.ts:3-8`).
- Changes are intentionally uncommitted in this workspace; review the full
  dirty tree before selecting commits because earlier M4 work is also present.

### 3. ADR status

- No ADR was added. The recognizer names and conservative matching rules are
  explicitly required by PLAN §6; the manifest-only preflight implements the
  existing PLAN §2 scheduling heuristic without changing the ecosystem boundary.

### 4. Open questions

1. Should M5 promote any routine pattern from provisional to measured suppression
   only after a corpus run contains targeted hook additions?
2. Should the next M5 chunk be formal corpus measurement or publication/release
   evidence first?

## 2026-10-12 — Post-M4 verification, severity gate, golden rows

### 1. Completed and verified

- **Correction to the 2026-07-29 M4 entry.** It describes
  `src/core/benign-install-script.ts` and "242 tests / 28 files". Commit
  9da9afb on the PR #20 branch removed that recognizer and its tests before
  the squash-merge (57d3803), because the post-M3 corpus had no install-hook
  additions to justify suppression (PLAN §6, `docs/fp-corpus-2026-07-29.md`).
  `main` therefore had 230 tests / 27 files; running vitest at 153c097 (243)
  and 9da9afb (230) confirmed the drop comes from that removal. The README
  was already correct (README.md:298).
- **End-to-end check of `main`** with real registry tarballs (static only):
  no-op fast path, a benign `ms` bump, a new `esbuild` with a `postinstall`
  (5 CRITICAL), an integrity mismatch, and `--strict`. Two PLAN divergences
  were found: the CLI had no severity gate (PLAN §4.5), and integrity
  mismatches were CRITICAL only inside the Action gate (PLAN §4.2).
- **Stacked PRs, reviewed by a Codex session as design and code reviewer,**
  squash-merged to `main` in order (e345dc4, 6ca7126, 375d1f9, 527f0b2). After
  each rebase, GitHub started no CI run for the force-pushed head; each merged
  tree was confirmed identical to its CI-green reviewed tree and re-verified
  locally:
  - #29 `feat(core)`: shared severity classification in
    `src/core/run-severity.ts`; report schema v5 with `summary.gateSeverity`.
  - #30 `feat(cli)`: `--fail-on` (default CRITICAL); exit 0/1/2/64, with
    `--strict` exit 2 taking precedence.
  - #31 `feat(sarif)`: `CAPDELTA-INTEGRITY-MISMATCH` results located at the
    configured lockfile (GitHub does not display locationless results), with
    attacker text bounded like the JSON report.
  - #32 `test(core)`: one golden pair per PLAN §4.4 row (12 cases, shared
    inventory `test/fixtures/golden/cases.json`), meeting PLAN §7.2.

### 2. Half-done and exact resume point

- M5 (PLAN §6, §7.4): the true-positive reconstruction corpus and a
  formal FP measurement, then README numbers and publication.
- A live GitHub SARIF upload has not been checked to confirm that the
  file-located integrity results display.

### 3. ADR status

- No ADR. The gate, classification, and SARIF work implement existing PLAN
  §4.2/§4.5 behavior; goldens implement §7.2.

### 4. Open questions

1. Dependabot PRs never get a sticky comment: `run-action.ts:182-187` takes
   the read-only path for actor `dependabot[bot]` without checking the
   token's permissions, while the dogfood workflow requests
   `pull-requests: write`. PLAN §9 requires a real Dependabot PR comment as
   the demo. Choose permission-aware delivery, or amend §9 (README.md:317
   already cites PR #7's comment).
2. The URL-domain signal scans comments (`signal-extractor.ts:20`), so
   documentation links become HIGH findings. Measure in M5 before changing.
3. Existing capability/signal SARIF results use an undefined
   `CAPDELTA_PACKAGE_ROOT` base and synthetic paths, and their text is not
   truncated. Lockfile findings have no SARIF results.
4. Cosmetic: "capabilitys" in text reports; the per-package header still
   says "manifest capability report"; `npm run check:action` deletes
   `dist/action` before building, so a failed build leaves the tree dirty.

## 2026-10-12 (later) — Attack reconstructions, dogfood re-pin, layout evasion

### 1. Completed and verified

- **Attack reconstructions (#34, merged):** defanged, labeled reconstructions
  of the axios 2026 compromise and both Shai-Hulud waves run through lockfile
  diff → fetch → analysis → the default CRITICAL gate, with benign controls
  (`src/core/attack-reconstructions.test.ts`; sources and kept/omitted
  behavior in `test/fixtures/reconstructions/inventory.json`). Each attack
  fails the gate; a parser-limit variant still fails on the hook.
- **Dogfood re-pin (#35, merged):** the workflow pinned 89f87e0, a
  manifest-only build (report schema v1). It now pins 95e7ae3.
- **Dependabot:** #25 (tsx), #26 (typescript-eslint), and #28 (eslint) were
  merged after full capdelta analysis; their HIGH findings were documentation
  URLs in comments. `main` re-verified afterwards (325 tests, all checks).

### 2. Half-done and exact resume point

- **#36 awaits maintainer approval** (ADR-013, proposed; amends ADR-010). npm
  installs tarballs rooted at any directory; capdelta required `package/`, so
  real `@types/*` bumps were unavailable and an `x/`-rooted malicious version
  evaded the default gate. The layout-evasion test fails on `main`.
- **#24 (@types/node):** capdelta reports it unavailable because of that bug.
  Re-run (`@dependabot rebase`) after #36 merges, then decide.
- **#27 (vitest 4 → 5, major):** capdelta fails CRITICAL on the new native
  binary in `@rolldown/binding-android-arm-eabi` (vite 8 / rolldown). This is
  correct per PLAN §4.4. Merging needs a reviewed `.capdelta.yml` allowlist
  entry with a justification, or a decision to hold.

### 3. ADR status

- ADR-013 proposed (#36), not accepted.

### 4. Open questions

1. Accept ADR-013 and merge #36?
2. The runner forces the Action's `node20` runtime onto Node 24 (GitHub's
   deprecation). PLAN §4.6 says node20, so moving `action.yml` to node24 needs
   a PLAN amendment.
3. Dogfood evidence for M5 signal tuning: the vitest bump produced HIGH
   "domains" from comments and malformed hosts (`$addr`, `fs`,
   `underscorejs.org)`), and TypeScript sources as MEDIUM unparseable files.
4. Any rejected archive (links, caps) is still only unavailable, which fails
   only under `--strict`. A `hasInstallScript` lockfile fallback was discussed
   and needs its own policy design and ADR.

## 2026-10-12 (evening) — Decisions executed, policy trust fix, M5 measurement

### 1. Completed and verified

- Maintainer decisions executed: ADR-013 accepted (#36), Action on Node 24
  (ADR-014, #39), endpoint noise reduction (#40; 15 → 4 endpoint findings on
  the #27 tuning diff), version-scoped allowlist entries (#41), SARIF shape
  suppression visibility plus a Differ signal-lineage fix (#42).
- Security fix (ADR-015): allowlist policy is read from the selected base
  commit, never the PR head or working tree, for both the Action (#43) and the
  CLI (#45). Before this, a PR could add an exception suppressing its own
  findings once `config-path` was enabled.
- Dogfood: re-pinned to `8b216e9` with `config-path` and one exception scoped to
  `@rolldown/binding-android-arm-eabi@1.2.13` (#44); every Dependabot PR is
  merged (#24–#28), and #27 (vitest 5) passed the gate with the exception
  visible.
- M5 measurement (#46 tooling; record in `docs/m5-2026-10-12/`): the default
  gate failed on 2/90 assumed-benign bumps, both accurate install-hook changes
  (`bcrypt` 6.0.0, `sqlite3` 5.1.7); 1 HIGH, which was noise; 11/90 bumps
  strict-incomplete. Codex reviewed every design and diff, including the
  measurement record.

### 2. Half-done and exact resume point

- M5 publication and the demo (PLAN §6): a real-PR screenshot and the blog
  post. Dependabot PRs get only a job summary (actor-based fallback,
  `run-action.ts`), so the PLAN §9 comment demo still needs the permission-aware
  delivery decision.

### 3. ADR status

- ADR-013, ADR-014, ADR-015 accepted.

### 4. Open questions

1. Permission-aware comment delivery for Dependabot PRs, or amend PLAN §9?
2. Remaining noise found by the measurement: published TypeScript sources as
   MEDIUM, numeric matrices matching the charcode-array recognizer. Any change
   needs a new independent corpus.
3. A `hasInstallScript` lockfile fallback for packages the extractor cannot
   analyze (it needs its own ADR; the flag is attacker-controlled metadata).

## 2026-10-12 (night) — Fail-closed gate: unanalyzable packages, reviewed exceptions, fetch failures

### 1. Completed and verified

- **ADR-016 (#48, merged):** unanalyzable packages are CRITICAL. Every
  `(stage, kind)` pair is classified exhaustively in `run-severity.ts`; a
  package capdelta cannot inspect for a reason the artifact bytes or the
  lockfile entry decide fails the default gate. `buildRunReport` counts each
  unavailable package once, at its highest failure severity; `--strict` is
  unchanged. The axios-over-cap reconstruction now fails the default gate.
- **ADR-017 (#50, merged):** reviewed `unanalyzable:` exceptions in
  `.capdelta.yml`, read from the base commit (ADR-015). An entry binds the exact
  new-side version and sha512 integrity and a post-verification failure kind;
  fetch-stage kinds are rejected. Every severity-bearing failure must match, at
  least one on the new side, or the package still gates.
- **ADR-018 (this branch, `adr-018-fetch-fail-closed`):** bounded retries in
  `fetchArtifact` — three attempts, 250 ms then 1 s of backoff, with the sleep
  injectable so tests stay instant — retry `network-error`, `timeout`, and HTTP
  408/429/5xx. A retryable status that persists becomes the new additive
  `http-unavailable` kind; `http-status` and `invalid-response` are now CRITICAL
  and unanalyzable (decision 3). `hasOperationalFailure(run)` in
  `run-severity.ts` fails the CLI (exit 1) and the Action for an exhausted
  transient fetch, or an `aborted`/`deadline-exceeded`/`analysis-aborted` stop at
  any stage, even under `--fail-on none`; `--strict` exit 2 still takes
  precedence.

### 2. Half-done and exact resume point

- M5 publication and the demo (PLAN §6): a real-PR screenshot and the blog post.
  The permission-aware comment decision for Dependabot PRs is still open.
- ADR-018 leaves the `hasInstallScript` lockfile fallback undone (its own ADR).

### 3. ADR status

- ADR-016, ADR-017, ADR-018 accepted (ADR-018 pending its PR).

### 4. Open questions

1. Does registry flakiness now cause repeated operational failures in real CI,
   since an exhausted transient fetch fails the run? Revisit ADR-018 if so.
2. Remaining M5 noise: published TypeScript sources as MEDIUM and numeric
   matrices matching the charcode-array recognizer. Any change needs a new
   independent corpus.

## 2026-10-13 — Finding guidance: why it matters and what to check

### 1. Completed and verified

- **`src/core/finding-guidance.ts` (new).** Constant `whyItMatters` /
  `whatToCheck` guidance for every shape rule (`ShapeRuleId`), every capability
  kind (`Capability["kind"]`, the four manifest kinds plus `CodeCapabilityKind`),
  every signal kind (`SignalFindingKind`), and four analysis-issue classes
  (integrity mismatch, lockfile/registry fetch failure, unanalyzable per
  ADR-016, operational per ADR-018). The kind lookups are
  `Record<UnionType, Guidance>`, so a new kind fails to compile until it has
  guidance. `analysisIssueClass` derives the class from the `run-severity.ts`
  helpers (`analysisIssueSeverity`, `isUnanalyzableIssue`, the gate's own
  `isOperationalFailure`, and `FETCH_STAGE_CRITICAL_KINDS`): every fetch-stage
  critical kind other than `integrity-mismatch` is a lockfile/registry fetch
  failure, because ADR-017 forbids a reviewed exception for those kinds, while
  `unanalyzable` is now only a post-verification failure. The gate's array
  decides the set, so no fetch kind is hand-written. So guidance can never drift
  from the gate; the hand-written `ANALYSIS_ISSUE_KIND_CLASSES` table was
  deleted. It returns
  `null` for a severity-null, non-operational issue (for example
  `filesystem-error`, `manifest-unreadable`, `cleanup-failed`), and every
  caller handles the `null` explicitly. No package, lockfile, or registry data
  is interpolated into any string.
- **Wording.** Install hooks say they _could_ run during npm install unless
  install scripts are disabled, with no incident names or prevalence claims.
  Heuristic results (secret-exfiltration, FS_SENSITIVE, obfuscation, entropy)
  say what static analysis found or suggests. `DYNAMIC_CODE` says it _could_
  build and run code from strings. The fetch-failure check says a reviewed
  exception _cannot cover_ it (ADR-017), the unanalyzable check binds an
  exception to the verified bytes, and integrity mismatch asks to regenerate the
  lockfile from a trusted registry. The wording guard bans malware,
  malicious, detected, compromised, attack, attacker, backdoor, steal, and
  worm, case-insensitively, over every string in every table.
- **Text report (`src/core/reporter.ts`).** CRITICAL/HIGH findings, shapes,
  signals, and severity-bearing analysis issues print `Why:` / `Check:` lines;
  LOW and INFO lines are unchanged. JSON is unchanged (presentation only).
  `guidanceWarranted` is now one exported helper in `finding-guidance.ts`.
- **PR comment (`src/action/action-comment-reporter.ts`).** One deduplicated
  “What these mean” section. The cap first decides the rows exactly as the
  pre-guidance reporter did — the full row budget, reduced only when the body
  without guidance does not fit — and only then fits guidance into the space
  those rows leave, adding entries while they fit. The omission footer is added
  only if it also fits, and points at the SARIF rule help; it no longer names
  the JSON artifact, which carries no guidance. Guidance can never reduce the
  row count or make an otherwise-fittable comment throw.
  `MAX_GUIDANCE_CHARS` (512) leaves headroom over the longest escaped entry.
- **SARIF (`src/core/sarif-reporter.ts`).** Each rule's `help.text` is its
  class guidance plus the unchanged “does not assert malware” sentence;
  install-hook, install-time execution, integrity-mismatch, and unanalyzable
  rules have distinct help. The missing-guidance throw names the rule id.
  `dist/action/` was rebuilt.
- Goldens: `test/fixtures/golden/*/expected.txt` and
  `install-script-added/expected-run.txt` refreshed only for the changed
  Why/Check lines (packer `node scripts/generate-golden-fixtures.mjs` produced
  no archive changes); `gateSeverity` is unchanged.

### 2. Half-done and exact resume point

- Nothing half-done. Lockfile findings (for example
  `integrity-changed-version-same`) intentionally do not carry guidance yet;
  only findings, shapes, signals, and severity-bearing analysis issues do.

### 3. ADR status

- No new ADR: this is presentation-only and does not change the gate, the
  allowlist, or any severity.

### 4. Open questions

1. Should the PR comment's guidance derive from the rows actually displayed
   (after the row cap) rather than every CRITICAL/HIGH class in the report?
2. Should lockfile findings gain their own guidance class?

## 2026-10-13 (afternoon) — ADR-019: read what npm installs, fail on every unread package

### 1. Completed and verified

- **Finding guidance was merged** as four PRs, #52–#55. The earlier entry describes it.
- **ADR-019** (`docs/adr/0019-read-what-npm-installs.md`) came out of Codex's finding-guidance review. Codex
  design-reviewed and security-reviewed each part. It shipped as three PRs:
  - **#56, mode normalization.** Every extracted file is written with mode `0o600` from the tar `filter`, the same
    mechanism pacote's `#entryMode` uses.
    - Before, a mode-000 `package.json` or `.js` file could not be read by an unprivileged runner. npm installs those
      files readable anyway, so this was a detection evasion.
    - New reconstruction: `mode-evasion`. A negative control was verified as uid 1000: it fails with main's old
      extractor and passes with the fix.
  - **#57, the `manifest-not-regular` kind.** It is CRITICAL and can be covered by a reviewed exception bound to the
    exact bytes. It covers a `package.json` that is a directory, implied by a `package/package.json/child.js` entry.
    - New reconstruction: `manifest-directory`.
    - On the new side, the same layout yields `manifest-missing`, which is also CRITICAL, because of the manifest-only
      filter.
  - **#58, operational failures.** Residual `filesystem-error` (extraction and cleanup both failed) and
    `manifest-unreadable` now make the run exit 1, even with `--fail-on none`. They keep severity null, so
    `gateSeverity` doesn't move, and they can never be excepted.
    - The message drops "before the run ended".
    - ADR-018 gets a "superseded in part" note.
- Every PR was verified locally on its own commit, passed CI on Node 20, 22 and 24, and changed no existing
  `gateSeverity`. The final suite has 645 tests.
- New `HANDOFF.md` at the repo root: the entry point for the next session.

### 2. Half-done and exact resume point

- Nothing half-done. Next is the permission-aware Dependabot comment and SARIF demo (PLAN §9); see `HANDOFF.md`.

### 3. ADR status

- ADR-019 is accepted and fully implemented. It supersedes ADR-018's operational message, and adds a note to
  ADR-016's kind list.

### 4. Open questions

1. Should the new side also report `manifest-not-regular` instead of `manifest-missing`? Both are CRITICAL, and Codex
   judged it acceptable.
2. The open questions from the finding-guidance entry still stand.

## 2026-10-14, README restructure and ADR-020

### 1. Completed and verified

- **README restructure (#60).** The README went from 607 to 350 lines and is now a product overview. The reference
  material moved word for word to `docs/cli.md`, `docs/github-action.md`, `docs/resource-limits.md`, `docs/api.md`
  and `docs/development.md`. The pipeline diagram is `docs/diagrams/pipeline.svg`, with its source in
  `docs/diagrams/pipeline.html`. The status, roadmap and ADR index were brought up to date.
- **ADR-020 (#61), decide write access from the token.** The Action treated every `dependabot[bot]` PR as read-only,
  but GitHub now applies the workflow's `permissions:` block to Dependabot runs. Run 38258824396 had
  `PullRequests: write` and still skipped the comment, so Dependabot PRs #24, #27 and #28 got no capdelta comment.
  - Only a fork is skipped before any write.
  - A 403 "Resource not accessible by integration" on the comment or the SARIF upload warns with the missing
    permission and falls back to the job summary. Every other error still fails the run. The check lives in
    `src/action/permission-refusal.ts`.
  - The gate does not depend on delivery.
  - Verified locally on the worker's commit and in CI on Node 20, 22 and 24. The suite has 658 tests. No golden
    fixture or reconstruction changed.
- **Dogfood re-pin.** `.github/workflows/capdelta.yml` now pins the Action to `2535ee0`.

### 2. Half-done and exact resume point

- The PLAN §9 demo asset is still missing. The next Dependabot PR should show the sticky comment. See `HANDOFF.md`
  "Next" item 1.

### 3. ADR status

- ADR-020 is accepted and implemented. No Codex review: the change affects delivery only, never the gate.

### 4. Open questions

1. Should `docs/github-action.md:29-35` describe the token-denied fallback? It says only "when permissions permit".

## 2026-10-16, comment audit and pruning

### 1. What landed

- **Audit.** A new project agent, `.claude/agents/comment-audit.md` (untracked), ran a swarm of six DeepSeek readers
  over 84 files at b7313d2. They applied the `/no-comments` rules and returned 642 verdicts. The full plan is outside the repo, at
  `~/.claude/projects/-home-amsn-orca-capdelta/notes/comment-audit-plan-b7313d2.md`.
- **Deletes (#78, #79, #81, #82).** About 450 lines of comments that repeated the code are gone. In security-relevant
  files, #79 used 23 hand-picked rows instead of the audit's verdicts, and #82 kept seven comments the audit wanted
  gone because they state a security reason the code cannot show.
- **Refactors (#83 to #91).**
  - #83 renames the budget limit to `RUNTIME_DEPS_EXCLUSIVE_LIMIT`.
  - #84 moves the pipeline test rules into the test names.
  - #85 renames the guidance-free twin fixture.
  - #86 types the run-action mocks and drops the `unbound-method` disable.
  - #87 makes the golden fixture tar helper reject PAX and base-256 headers.
  - #88 adds `toStageKindPair`, a runtime-checked `(stage, kind)` pair that replaces the cast in `run-severity.ts`.
  - #89 names the lockfile parsing checks.
  - #90 adds ADR-021 and splits the sandbox script into named steps.
  - #91 adds a shared `httpStatusOf`.
- **Verification.** Every PR passed the full local verification and CI on Node 20, 22 and 24. Codex security-reviewed
  #88 to #91. It blocked #88 once, because a stage outside `STAGE_KINDS`, including `__proto__`, threw `TypeError`
  instead of `SeverityGateError`. `Object.hasOwn` fixed it, with tests. No golden fixture or reconstruction changed.

### 2. Half-done and exact resume point

- Nothing is half-done. The audit's themes T5 (fetcher trust-boundary notes) and T6 (differ identity helpers) were
  dropped by user decision, so their comments stay.

### 3. ADR status

- ADR-021 is accepted. It records the threat model of `scripts/package-action-sandboxed.sh`.

### 4. Lessons

- Audit verdicts need review before anyone applies them in security code. The swarm misread line numbers in places,
  marked the `# v7.0.0` tags beside pinned action SHAs (which Dependabot reads) for deletion, and trimmed security
  reasons down to a bare ADR number.
- A `git apply --unidiff-zero` restore can land at the wrong line. After restoring hunks, compare each restored
  block's neighbors with main.

## 2026-10-16, duplicate-code merges

### 1. What landed

- **Plan.** A token-window clone detector and a check of function names defined in more than one file found 11
  clusters of duplicated code in `src/` and `scripts/`. The plan, with every copy's file and line at f5a2aa0, is outside
  the repo, at `~/.claude/projects/-home-amsn-orca-capdelta/notes/dedupe-plan-f5a2aa0.md`.
- **Merges (#93, #95, #97 to #104, #106).**
  - #93 adds `NamedError`, the base for 17 error classes.
  - #95 shares `compareText` and `compareEvidence` in `src/core/compare.ts`.
  - #97 and #98 share `isRecord`, `errorName`, and the strict `isAbortSignal` in `src/core/guards.ts`. #98 also
    replaces the lockfile differ's `isPlainObject`.
  - #99 keeps one `truncate`, in `report-builder.ts`, and deletes `truncateCliMessage`.
  - #100 shares the CLI's `decodeUtf8` from `cli-errors.ts`.
  - #101 adds `src/core/line-index.ts` for both extractors' evidence line numbers.
  - #102 merges the signal extractor's two grouping functions and its two IP literal loops.
  - #103 adds `forEachInOrder` in `src/core/worker-pool.ts` for the fetcher's pool and the pipeline's two pools.
  - #104 shares the value check for `--base` and `--config`.
  - #106 moves the manifest extractor's signal check to the shared guard.
- **Behavior changes.** The user approved two, both for direct library callers only. #98 makes the safe extractor and
  the JavaScript capability extractor reject a signal-like object without `removeEventListener`. #106 does the same
  for the manifest extractor and turns its `TypeError` on a `null` signal into its configuration error.
- **Verification.** Before #93, twenty verify-capdelta CLI drives were recorded twice on main at 92c7100 and matched
  byte for byte. They cover text and JSON reports, gateSeverity, exit codes 0, 1, 2, and 64, first-run mode, the
  base-commit allowlist, `--config`, an invalid UTF-8 lockfile, and usage errors. Every PR matched that baseline, and
  main at b909787 matches it too. Golden fixtures and reconstructions did not change. Codex reviewed every PR that
  touched extraction, fetching, the gate, policy reading, or untrusted parsing, and approved each one.

### 2. Half-done and exact resume point

- Nothing is half-done. Rejected merges, with reasons, are in the plan's Appendix B. The largest is the two head
  lockfile readers in `src/action.ts` and `src/cli/run-cli.ts`, which would change the Action's error text.

### 3. ADR status

- No ADR changed.

### 4. Lessons

- Interactive Codex in an Orca terminal stopped at a hook-trust prompt that Orca would not let the orchestrator answer.
  Headless `codex exec -s read-only` worked for every review.
- Running `check:action` deletes and rebuilds `dist/action/`. A reviewer that reads the worktree during that window
  reports deleted files that are not deleted.

## 2026-10-17 to 2026-10-20, release workflow and lockfile findings in every output

### 1. What landed

- **Release and supply chain.** #116 adds the release workflow (ADR-022 and its Amendment A). Codex blocked the first
  version on two findings, both fixed. The release attests `dist/action/index.js` and
  `dist/action/javascript-parser-worker.js`. `@actions/artifact`, `@actions/core` and `@actions/github` moved to
  `dependencies` with the user's approval, so the SBOM lists them.
- **Dependency bumps.** #112 and #113 (undici 6.29.1, brace-expansion) rebuilt both bundles with
  `scripts/package-action-sandboxed.sh`. #114, #115 and #118 bump checkout, setup-node and scorecard-action, each pinned
  to the upstream tag commit.
- **Lockfile findings.** An `integrity-changed-version-same` finding is HIGH and counts toward `gateSeverity`, but the PR
  comment showed no row and SARIF had no result. #119 adds comment rows and `LOCKFILE_GUIDANCE`. #120 adds one SARIF rule
  and result per finding, located at `lockfilePath`, and text-report guidance. No gate change. Codex approved both.
- **Docs.** #117 rewrote HANDOFF.md.

### 2. Half-done and exact resume point

- Nothing is half-done. HANDOFF.md lists the next items. v0.1.0 waits for the maintainer.

### 3. ADR status

- ADR-022 and its Amendment A were accepted with #116.

### 4. Lessons

- The worker split a SARIF loop into a helper because `renderSarifReport` sits at ESLint's complexity limit. Check the
  lint rules before asking a worker to inline code.
- A copied script in a worktree's `.scratch/` fails `npm run lint`. Run such scripts after verification, then delete them.

## 2026-10-20, M5 publication-ready

### 1. What landed

- **README (#123).** An audit against the code, ADRs and the frozen M5 record found ten stale or wrong claims, now fixed.
  Among them are the dependency count (7, not 4), the `yargs` HIGH labeled noise, and a Quick start that builds capdelta
  first. #123 also adds a gate-failure screenshot from throwaway PR #122, which bumped `bcrypt` 5.1.1 to 6.0.0. #122 is
  closed and its branches deleted.
- **Blog draft (#124).** `docs/blog/2026-10-what-did-this-dependency-gain.md`, built only from measured numbers and the
  reconstructions. Nothing is posted.
- **No change to M5's `gateFail`.** ADR-019 decision 5 keeps it severity-only, and counting operational failures would
  change 0 of 90 entries.

### 2. Half-done and exact resume point

- Nothing is half-done. The maintainer cuts v0.1.0 and posts the blog. HANDOFF.md lists the rest.

### 3. ADR status

- No ADR changed.

### 4. Lessons

- Check a unit's premise against the ADRs before briefing it. The `gateFail` fix contradicted ADR-019, and a read-only
  DeepSeek pass found that before any code was written.
- `ship-pr` and `verify-quiet` (in `~/.claude/bin`) each shipped #123 and #124 in one background command, in place of separate push, PR, CI-wait, merge and cleanup steps.

## 2026-10-20, post-M5 follow-ups and two designs

### 1. What landed

- **#127.** The PR comment now quotes the install hook name, so the `install` hook no longer reads "changed install
  install hook".
- **#128.** Tests that need the built parser worker fail with a clear message when `dist/` is missing.
- **#129.** Golden `expected-*` files are vitest file snapshots. `npx vitest run <file> -u` rewrites them.
- **Designs, not merged.** `.scratch/next/d1-noise-design.md` (URLs mentioned in text) and
  `.scratch/next/d2-newside-design.md` (analyze the new side when the old side is unanalyzable) wait for approval.
- **Tooling outside the repo.** `~/.claude/bin/codex-review` and `~/.claude/bin/spawn-worker` share a stall watchdog,
  `~/.claude/bin/lib/stall-watch.sh`.

### 2. Half-done and exact resume point

- Nothing is half-done. D1 and D2 wait for the maintainer's approval, and the blog is parked.

### 3. ADR status

- No ADR changed. D2 would need ADR-023.

### 4. Lessons

- Check a design's premise against the ADR text, not the follow-up line alone. The first D2 draft assumed reviewed
  exceptions could release old-side failures. ADR-017 C.2 says they never can, and that is the real gap.
- Classify the attack fixtures before proposing a noise rule. R3 showed that every attack URL is a whole string literal.
  That made "URL embedded in text" a safe line to draw.
- Orca puts a new request id on every `terminal read`, so hashing the whole response never detects a stall. Hash
  `.result.terminal.tail` only.

## 2026-10-20 (night), D1 and D2 implementation run

### 1. What landed

- **#131.** ADR-023 (analyze the new version as newly added when only the old version is unanalyzable) and ADR-024
  (a new host seen only inside prose is LOW). Codex blocked ADR-024 once. The ADR had said a NET finding always
  covers a destination swap, which is false when the package already had NET. The ADR now records that boundary and
  that the URL regex already misses assembled URLs.
- **#132.** A frozen 30 x 3 corpus, split 15/15 by package, and its baseline (`docs/heldout-2026-10-20/`). There are
  no URL endpoint findings in 90 pairs.
- **#133, #134, #135.** ADR-023 end to end. #133 adds the `baselineFailures` report field, #134 adds the pipeline
  change, and #135 adds the docs. A real drive on `@tabler/icons-react` 3.48.0 -> 3.49.0 moved from CRITICAL 2 to 1.

### 2. Half-done and exact resume point

- D1b stopped after two consecutive Codex BLOCKs. The branch `Volkiaa/d1b-endpoint-context` is pushed without a PR, and its
  worktree is kept. `.scratch/next/d1b-stopped.md` has the cause and a proposed fix. D1c and D1d wait on it.

### 3. ADR status

- ADR-023 and ADR-024 are accepted. ADR-023's scope was narrowed in #134: an operational old-side failure keeps the
  package unavailable.

### 4. Lessons

- Read the runtime value, not the source text. Each D1b BLOCK was a new escape form where raw and cooked strings
  disagree.
- Check every exit path a new status touches. `operationalFailureCount` only counts unavailable packages, so moving a
  package to analyzed would have silently dropped ADR-018's exit 1 (`src/core/run-severity.ts:406-413`).
- A registry packument's `dist.fileCount` finds real packages that cross an extraction cap between versions. That gave
  D2c a real CLI proof without a hand-made registry.

## 2026-10-21 (early morning), D1 completion run

### 1. What landed

- **#137.** The PR comment caps its baseline-failure and reviewed-exception lists at `maxRows`. Before, many baseline
  failures could keep the comment over `maxCharacters` at every row count, so the fit threw. A hidden-exception count
  still renders at zero rows.
- **#138.** D1b, third attempt. The parser worker reports, per string range, whether the cooked value holds whitespace
  after WHATWG URL input normalization. A URL is `embedded-text` only when that value and the raw source both do.
  Codex approved. A 20-drive replay was byte-identical to main.
- **#139.** D1c. A new host seen only as `embedded-text` is LOW with `(mentioned in text)`. It adds the golden case
  `url-mentioned-in-text` and ADR-024's destination-swap boundary tests. In the real drive, husky's `typicode.github.io`
  moved from HIGH to LOW. Every `gateSeverity` in the replay is unchanged.
- **#140.** D1d. `scripts/m5-measure.ts contexts` dumps every new-side domain observation with its context. On the
  frozen corpus, finding counts are unchanged, and all 82 `embedded-text` observations are prose
  (`docs/heldout-2026-10-20/classifier-labels.json`).
- **#141.** The README and the blog draft describe ADR-024.

### 2. Half-done and exact resume point

- Nothing is half-done. v0.1.0 and the blog wait on the maintainer. Four designs wait on approval (HANDOFF "Next" 3).

### 3. ADR status

- No ADR changed. IPv6 context rules would need a new ADR or an ADR-024 amendment.

### 4. Lessons

- My predictions can be wrong in the conservative direction. I expected axios's `github.com` to drop to LOW. Its
  template element `" (https://github.com/"` holds only the URL once trimmed, so it stays `literal`. Record the
  prediction before the drive so the miss is visible.
- The first evidence snippet is not always the occurrence that decided a merged observation. pino's prose URL in
  `bin.js` shows as `unknown` because an unparsed `.ts` test file also names the host. Check the deciding file before
  calling a classification wrong.
- A one-line helper that resets a property can exist to stop TypeScript from narrowing that property across an
  `await`. Inlining it failed lint (`no-unnecessary-condition`). Read why a helper exists before you collapse it.
- The pipeline factory takes adapters, so a measurement script can wrap `diff` to see the new-side capability set
  without changing `src/`.

## 2026-10-21 (day), Autonomy tiers run

### 1. What landed

- **#143.** CLAUDE.md gains the Autonomy tiers, at the maintainer's request.
- **#144.** The `contexts` command spreads `DEFAULT_ADAPTERS` instead of copying them.
- **#145.** The 20-drive zero-change replay is committed as `verify-capdelta/bin/replay`.
- **#146.** ADR-025, Tier 2. A parser worker posts a ready message, and a failure before ready exits 1. With the
  worker file deleted, the CLI used to report every file as unparseable. Now it names the missing worker.
- **#149.** Tier 1. Signal evidence merges once per host. 20,000 repeated URL lines took 186 s.
- **#150.** ADR-024 amendment, Tier 2. A URL no longer runs across a template literal's `${` into the next element.
  On main, ``tag`See https://a.test/${0}https://evil.test/` `` reported only `a.test`, at LOW. New reconstruction
  `template-boundary`.
- **#151.** Tier 1. Signal extraction is linear: per-line snippets, per-range contexts, an authority-only URL regex
  with a forward stop cursor, and a backward punctuation trim. Codex needed six rounds. A differential fuzz against
  main showed 0 differences in 2,000,000 cases.
- **Drafts.** #147 (ADR-028, TypeScript, decision only), #148 (ADR-027, glued IPv6 LOW), #152 (ADR-026, cooked-value
  URLs).

### 2. Half-done and exact resume point

- Nothing is half-done. The three drafts wait on the maintainer (HANDOFF "Next" 1). v0.1.0 is delayed by the
  maintainer.

### 3. ADR status

- ADR-025 accepted (agent). ADR-024 amended (agent). ADR-026, ADR-027 and ADR-028 proposed.

### 4. Lessons

- Reviewing a draft found three problems on main: #149, #150 and #151. A draft's review is also a review of the code
  it touches, so land the fixes on main first, then rebase the draft.
- I added a quadratic path in #150, and Codex caught it one PR later. A fix that changes where scanning resumes needs a
  timing test at the size of the source limit.
- The first differential fuzz reported 0 differences because its LCG reused low bits with a short period. Testing it
  on a known-bad variant exposed that. Never trust a zero from a check that has not first found a planted
  difference.
- Two IPv6 blocks shared the premise that the regex match is the whole address. Judging the widened token fixed both.
