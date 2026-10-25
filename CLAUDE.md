# capdelta working agreement

You are helping build capdelta, an npm dependency behavioral-diff security tool.
Its purpose: catch supply-chain attacks such as the axios (2026) and
Shai-Hulud (2025) npm compromises by diffing what a dependency bump can do.

The authoritative spec is docs/PLAN.md (rev. 3). When the plan and your instincts
conflict, the plan wins; if you believe the plan is wrong, say so and stop.
Deviations require my approval and an ADR in docs/adr/, except where the
Autonomy section lets you decide.

## Rules

- Design before code. For any new component, write the interface, data types,
  and error-handling strategy first, in prose or an ADR. Wait for my approval
  before implementing, unless the Autonomy section lets you decide.
- A refactor that changes no exported type and no `gateSeverity` or report field needs no design approval, as long as the existing tests and reconstructions pass unchanged. State in the PR description that it meets this condition.
- Small increments. No change set larger than one component + its tests.
- Explicit error handling. No silent failures, no bare try-catch. Every catch
  either recovers meaningfully or rethrows with context. "Degrade loudly" is a
  core product principle (PLAN §2) and applies to the code itself.
- A ticket that adds user-facing behavior commits its drive script under `.claude/skills/verify-capdelta/bin/` in the same PR, so the proof outlives the session.
- Tests accompany code. Every component lands with its unit tests. Golden
  fixtures per PLAN §7. If something is hard to test, that's a design smell.
  Raise it.
- Dependency budget: <10 runtime dependencies total (PLAN §10). Adding any
  runtime dependency requires my explicit approval and a one-line justification
  in the PR description.
- Security posture: this tool parses attacker-controlled input. Safe extraction
  rules (PLAN §3) are non-negotiable. Never execute package code, not even in
  tests. Test fixtures must be inert.
- Explain non-obvious constructs you introduce (TS generics tricks, Node API
  subtleties) in one or two sentences in the PR description. I am using this
  project to learn.
- Scope discipline: solve the stated task. If you notice an adjacent issue,
  list it at the end under "Noticed, not touched" instead of fixing it in the
  same PR. In an autonomous run, a noticed item may become its own ticket and PR.
- Git: conventional commits, imperative mood. Do not add yourself as co-author.
- No timeline estimates.
- Keep a comment that states a security reason for a gate, policy, extraction or fetch rule. Comment audits and `/correct` passes must not delete or shorten it.
- When you verify a fact from the plan or from code, cite it (file:line or
  PLAN §). Future sessions depend on this.

## Autonomy

You may approve your own design and merge it when the change fits a tier below
and passes every check that tier lists. When a change fits two tiers, the
higher tier applies. Log the decision and its evidence in the PR description.

Tier 1 is a change that moves no gate. It covers refactors, report wording,
tooling, docs and small follow-ups. Merge it after full verification, green
CI, and a Codex review where Multi-agent workflow requires one. Show that no
`gateSeverity` moved in the attack reconstructions and golden fixtures.

Tier 2 is a change that only makes the gate stricter or louder: a new
detection, a raised severity, or a silent failure turned into a loud one
(PLAN §2). Before merging:

- Write the ADR with status `Accepted (agent)`, the evidence below, and how to
  revert it.
- Full verification passes. Every attack reconstruction and golden fixture
  keeps its `gateSeverity` or moves it up, never down.
- Run the held-out corpus with `scripts/m5-measure.ts run` before and after.
  Label each new finding in the ADR as attack, noise or unknown. If a held-out
  pair that passed the default gate now fails it, stop. That is new noise for
  users, and I decide whether it is worth it.
- Drive the real CLI with `/verify-capdelta` on a bump that shows the change.
- The Codex security review returns APPROVE.

Tier 3 still needs my approval:

- A change that lowers a severity, drops or suppresses a finding, or narrows
  what a detection matches. The reconstructions cover only known attacks, so
  passing them cannot show that a lowering opens no new evasion, and the agent
  that designs the lowering also writes its tests.
- A new runtime dependency.
- A change to the safe extraction rules (PLAN §3), the allowlist or exception
  policy, or base-commit policy reading (ADR-015).
- Any other deviation from PLAN.md.
- Releases, tags, and anything else irreversible.

In an autonomous run, take a Tier 3 change as far as a draft PR: an ADR with
status `Proposed`, the implementation, the held-out measurement, and a Codex
review. Then list it in HANDOFF.md for me.

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
- After an intended report change, run `npx vitest run <golden test file> -u` to
  rewrite the `expected-*` files, then review the diff. Put `-u` after the test
  file path because vitest reads the next argument as the update type.
- A change to detection, severity, the gate, report output, or a report
  field's meaning can move the gate. It must keep the attack reconstructions
  and golden fixtures passing. Check `gateSeverity` in
  both, not only the unit tests. Then run `/verify-capdelta`
  (`.claude/skills/verify-capdelta/SKILL.md`) and cite its evidence in the PR.

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
  `src/core/attack-reconstructions.test.ts` is their end-to-end proof. A new
  evasion gets a reconstruction here.
- `docs/adr/` holds the decisions. `HANDOFF.md` is the starting point for the
  next session; update it at every handoff. `docs/SESSIONS.md` is the full
  session log; append an entry when you finish a milestone.
- `docs/m5-2026-10-12/` is a frozen historical measurement. Never edit it.

## Gotchas

- Without `node_modules`, `check:action` deletes `dist/action/`. Restore it
  with `git checkout -- dist/action`, then install.
- Never close and reopen PRs to retrigger CI. A force-pushed branch may get no
  CI run; verify locally and say so instead.
- Every string that comes from a package, lockfile, or registry is
  attacker-controlled. Bound it with `truncate` and the `MAX_*` limits in
  report-builder.ts, and never render it as a link (PLAN §3).

## Multi-agent workflow

Codex reviews security for any change to the severity gate, allowlist or exception policy,
extraction, fetching, or base-commit policy reading.
