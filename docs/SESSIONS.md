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
