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
