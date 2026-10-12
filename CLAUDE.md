# capdelta — Working Agreement

You are helping build capdelta, an npm dependency behavioral-diff security tool.
Its purpose: catch supply-chain attacks such as the axios (2026) and
Shai-Hulud (2025) npm compromises by diffing what a dependency bump can do.

The authoritative spec is docs/PLAN.md (rev. 3). When the plan and your instincts
conflict, the plan wins; if you believe the plan is wrong, say so and stop —
deviations require my approval and an ADR in docs/adr/.

## Rules

- Design before code. For any new component, propose the interface, data types,
  and error-handling strategy first, in prose. Wait for my approval before
  implementing.
- Small increments. No change set larger than one component + its tests.
- Explicit error handling. No silent failures, no bare try-catch. Every catch
  either recovers meaningfully or rethrows with context. "Degrade loudly" is a
  core product principle (PLAN §2) and applies to the code itself.
- Tests accompany code. Every component lands with its unit tests. Golden
  fixtures per PLAN §7. If something is hard to test, that's a design smell —
  raise it.
- Dependency budget: <10 runtime dependencies total (PLAN §10). Adding any
  runtime dependency requires my explicit approval and a one-line justification
  in the PR description.
- Security posture: this tool parses attacker-controlled input. Safe extraction
  rules (PLAN §3) are non-negotiable. Never execute package code, not even in
  tests. Test fixtures must be inert.
- Explain non-obvious constructs you introduce (TS generics tricks, Node API
  subtleties) in one or two sentences in the PR description — I am using this
  project to learn.
- Scope discipline: solve the stated task. If you notice an adjacent issue,
  list it at the end under "Noticed, not touched" instead of fixing it.
- Git: conventional commits, imperative mood. Do not add yourself as co-author.
- No timeline estimates.
- When you verify a fact from the plan or from code, cite it (file:line or
  PLAN §). Future sessions depend on this.

## Commands

- Install: `npm ci --ignore-scripts` (never run dependency install scripts).
- Full verification. Run all of it before every PR; CI runs it on Node 20, 22,
  and 24:
  `npm run typecheck && npm run lint && npm run format:check && npm test && npm run check:deps && npm run check:action`
- One test file: `npx vitest run src/core/run-severity.test.ts`. `npm test`
  builds first.
- After changing anything the Action bundles, run `npm run package:action` and
  commit `dist/action/`; `check:action` fails if it is stale.
- Golden fixtures: `node scripts/generate-golden-fixtures.mjs`. Regenerate only
  when a case is meant to change, and explain the change in the commit message.

## Map

- `src/core/`: the pipeline.
  - `npm/` holds the lockfile differ, fetcher, safe extractor, and manifest
    extractor.
  - `capability-analysis-pipeline.ts` orchestrates them.
  - `capability-differ.ts` and `signal-*` hold the rules.
  - `run-severity.ts` is the single severity and gate policy.
  - `report-builder.ts` holds the JSON report and `summary.gateSeverity`, the
    only thing the gate counts.
  - `reporter.ts` and `sarif-reporter.ts` handle text and SARIF output.
  - `capdelta-config.ts` holds `.capdelta.yml` parsing and the allowlist.
- `src/cli/` and `src/action/`: the two entry points. Both read policy from
  the base commit (ADR-015).
- `test/fixtures/reconstructions/` holds defanged attack reconstructions, and
  `src/core/attack-reconstructions.test.ts` is their end-to-end proof. Any
  change to detection or the gate must keep these passing. A new evasion gets a
  reconstruction here.
- `docs/adr/` holds the decisions. `docs/SESSIONS.md` is the session handoff
  log; append an entry when you finish a milestone.
- `docs/m5-2026-10-12/` is a frozen historical measurement. Never edit it.

## Gotchas

- Without `node_modules`, `check:action` deletes `dist/action/`. Restore it
  with `git checkout -- dist/action`, then install.
- Changing a report field's meaning, or a severity, can move the gate. Check
  `gateSeverity` in the golden fixtures and the reconstructions, not only the
  unit tests.
- Never close and reopen PRs to retrigger CI. A force-pushed branch may get no
  CI run; verify locally and say so instead.
- Every string that comes from a package, lockfile, or registry is
  attacker-controlled. Bound it with `truncate` and the `MAX_*` limits in
  report-builder.ts, and never render it as a link (PLAN §3).

## Multi-agent workflow

The global routing in ~/.claude/CLAUDE.md applies: DeepSeek through OpenCode
implements in a worktree, and Claude orchestrates and reviews. Codex reviews
security for any change to the severity gate, allowlist or exception policy,
extraction, fetching, or base-commit policy reading.
