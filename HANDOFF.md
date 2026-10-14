# HANDOFF

The starting point for the next capdelta session. Read this first, then CLAUDE.md. `docs/SESSIONS.md` has the full
history, and docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-14.

## Where main stands

main is at 2535ee0, plus the dogfood re-pin PR that carries this update. Finding guidance (#52-#55) and ADR-019
(#56-#58) are merged. The README restructure (#60) moved the reference material to `docs/cli.md`,
`docs/github-action.md`, `docs/resource-limits.md`, `docs/api.md` and `docs/development.md`. ADR-020 (#61) makes the
Action post the comment and SARIF on Dependabot PRs. Every way a changed package can end up unanalyzed now fails a default run:

| Failure                                                                                            | Outcome                                   | Exceptable (ADR-017)                                             |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Extraction/manifest failure decided by verified bytes (incl. new `manifest-not-regular`)           | CRITICAL gate                             | yes, bound to the exact bytes; needs a new-side match (rule C.2) |
| Fetch-stage deterministic failure (404, size cap, integrity, invalid URL)                          | CRITICAL gate                             | never                                                            |
| Transient fetch exhausted, deadline/abort stop, residual `filesystem-error`, `manifest-unreadable` | operational exit 1, even `--fail-on none` | never                                                            |
| `cleanup-failed` after a successful analysis                                                       | warning only                              | n/a                                                              |

- **Mode normalization:** extracted files are written with mode `0o600`, as pacote does (ADR-019 Decision 1). capdelta
  therefore reads every byte npm installs; a mode-000 file can no longer hide code.
- **Finding guidance:** every finding class carries static "why it matters / what to check" text. It appears in the
  text report (CRITICAL/HIGH), the PR comment (deduplicated, never displacing rows) and SARIF rule help. Source:
  `src/core/finding-guidance.ts`.
- **Reconstructions** (`test/fixtures/reconstructions/`): axios-2026, shai-hulud-2025, shai-hulud-2-2025,
  layout-evasion, mode-evasion and manifest-directory. All must keep passing.

## Next, in order

1. **Dependabot PRs that change the Action bundle fail CI.** A bump of a bundled package (`@actions/*`, `acorn`,
   `@vercel/ncc`) leaves `dist/action/` stale, so `check:action` fails on Node 20, 22 and 24. On 2026-10-14 the bundle
   was rebuilt by hand on #63, #64 and #66. Decide whether a workflow should rebuild it; that needs a design and the
   user's approval. The PLAN §9 demo is done: the README shows capdelta's comment on Dependabot PR #63.
2. **M5 publication.** Note that M5's `gateFail` is severity-only and does not count operational exit 1
   (`scripts/m5-measure.ts:110`). Never edit `docs/m5-2026-10-12/`.
3. **Noise reduction on a new held-out corpus.**
4. **Analyzing the new side as a new package when the old side is unanalyzable.**

## Open questions for the user

- Should the PR comment's guidance follow only the rows shown after the row cap? Today it covers every CRITICAL/HIGH
  class.
- Should lockfile findings (`integrity-changed-version-same`, HIGH) get guidance?
- A non-regular `package.json` reports `manifest-not-regular` on the old side but `manifest-missing` on the new side,
  because of the manifest-only filter. Both are CRITICAL. Codex judged it acceptable; unify it only if it confuses
  exception authors.

## How to work (lessons from 2026-10-13)

- **Routing** (~/.claude/CLAUDE.md):
  - DeepSeek implements from a `.task.md` brief in an Orca worktree.
  - Codex security-reviews anything touching the gate, exceptions, extraction or fetching, plus a design review of
    each ADR. Every Codex review this session found something real.
  - Opus writes briefs and ADRs and decides.
- **Before briefing, check for in-flight work:** `git worktree list` and `orca terminal list --json`. A prior session's
  worker had already built finding guidance; one was briefed twice.
- **Worker terminals:** launch them as `--command '... ; exit'`, otherwise `terminal wait --for exit` never returns,
  because the shell stays open.
- **Prettier:** `format:check` covers untracked files in the worktree root. Run `npx --no-install prettier --write` on
  `.task*.md` and `NOTES.md`, or verification fails.
- **Verify every commit yourself:** check out each commit and run the full verification. A worker's "PASS" is not
  evidence.
- **Negative control** for an evasion fix: restore the old file, show the reconstruction fails, then restore the fix.
- **Stacked PRs:**
  - Never `gh pr merge --delete-branch` on a branch other PRs are based on; GitHub closes the dependent PR.
  - Squash-merge without deleting, then `git rebase --onto origin/main <old parent>` the next branch.
  - Check that its tree equals the verified commit (`git rev-parse <c>^{tree}`), push, retarget, merge.
  - If GitHub shows a stale CONFLICTING, toggle the base away and back.
  - Prefer independent PRs, merged one at a time, over stacks.
- **Briefs can be wrong:** ADR-017 rule C.2 (an exception needs a matched new-side failure) overrode a brief, and the
  worker was right to follow the code. Ask workers to report conflicts in NOTES rather than force the brief.

## Housekeeping

- No open worktrees or PRs after this session; the Codex terminal can be closed.
- Check spend with `npx --no-install codeburn models -p today`, run from a scratch directory.
