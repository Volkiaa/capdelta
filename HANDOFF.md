# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-17.

## Where main stands

main is at 63be2f8, and CI, CodeQL, zizmor and Scorecard are green on it. No
PRs are open. The only branches besides `main` are `Volkiaa/lockfile-comment`
(local, see In flight).

Merged on 2026-10-17:

- **#117.** HANDOFF rewrite.
- **#112, #113.** Security bumps of undici (6.29.1) and brace-expansion. Both
  bundles were rebuilt with `scripts/package-action-sandboxed.sh`, and the
  token-level bundle diffs held only the libraries' own fixes.
- **#116.** The release workflow (ADR-022 and its Amendment A). Codex blocked
  the first version on two findings, and both are fixed. The release attests
  `dist/action/index.js` and `dist/action/javascript-parser-worker.js`.
  `@actions/artifact`, `@actions/core` and `@actions/github` moved to
  `dependencies` (user-approved), so the SBOM lists them. Direct runtime
  dependencies are now 7 of fewer than 10. The transitive runtime count that
  `check:deps` reports went from 9 to 160.
- **#114, #115.** checkout v7.0.1 and setup-node v7.1.0. All pins, including
  `release.yml`, match the upstream tag SHAs.
- 28 merged or superseded branches were deleted, locally and on GitHub. Each
  tip matched its merged PR head, or had no commits outside main.

Programs finished on 2026-10-16 (logged in `docs/SESSIONS.md`): the comment
audit (#78 to #92), the duplicate-code program (#93 to #107), and CI/CD
security (#105, #109 to #111).

## In flight

**Lockfile findings are invisible in the PR comment and SARIF.** An
`integrity-changed-version-same` finding (HIGH) counts toward `gateSeverity`
(`src/core/report-builder.ts:126-128`) and fails the check. But the comment
shows `High: 1` and then `Showing 0 of 0 findings`, with no row and no
guidance, and SARIF has zero rules and results. Proof: `npx --no-install tsx
.scratch/lockfile-render/render.ts` (gitignored, main checkout) renders the
golden case `test/fixtures/golden/integrity-changed-version-same` through the
real pipeline into `.scratch/lockfile-render/comment.md` and `sarif.json`.

The user approved this design on 2026-10-17:

- Lockfile findings become rows in the comment's findings table. They share
  the 10-row cap and the `Showing N of M` count, sorted by severity with the
  other findings. Every lockfile string is escaped and truncated.
- `finding-guidance.ts` gets `Record<LockfileFindingKind, Guidance>`, used by
  the comment, the text report and SARIF rule help.
- SARIF gets one rule per lockfile kind, with results located at
  `lockfilePath`.
- No gate change. Codex reviews both PRs, because the comment renders
  attacker-controlled lockfile strings.

It is split into two tickets so each stays under 350 lines:

1. **Part 1, comment rows and guidance.** Worktree
   `b3021892-328f-4c45-8995-d16a6b7ab73c::/home/amsn/orca/workspaces/capdelta/lockfile-comment`,
   branch `Volkiaa/lockfile-comment`, one commit `c3e9250`, not pushed, tree
   clean. The DeepSeek worker finished and wrote `NOTES.md` (722 tests pass,
   per the worker). **Not reviewed yet.** Known gap: the ticket asked
   `src/core/reporter.golden.test.ts` to compare `renderActionComment` with
   `expected-comment.md`, but the commit leaves that test unchanged, so
   nothing asserts the new golden file. Also check why `.prettierignore`
   changed, and the dist/action diff. The ticket is in the worktree's
   `.task.md`.
2. **Part 2, SARIF and text report.** Not started. Note that
   `sarif-reporter.ts` throws when a rule has no guidance (`ruleHelp`), so
   SARIF results need part 1's guidance first.

## Next, in order

1. **Finish part 1.** Branch is based on fd008e3, so merge main first. Review
   the diff, wire the golden comment assertion, run the full verification
   yourself, rerun `.scratch/lockfile-render/render.ts` to see the row, get a
   headless Codex review, then open the PR and merge on APPROVE.
2. **Part 2** as above, then rerun the render script and confirm SARIF has
   the rule and result.
3. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
4. **M5 publication.** M5's `gateFail` is severity-only and does not count
   operational exit 1 (`scripts/m5-measure.ts:110`). Fix its dead reference to
   `docs/m5-measurement-2026-10-12.md` (the data lives in
   `docs/m5-2026-10-12/`). Never edit `docs/m5-2026-10-12/`.
5. **Noise reduction on a new held-out corpus.** A known false positive is a
   URL inside a string literal. vitest 5.0.4's `CACHEDIR.TAG` text produced a
   HIGH `new-external-endpoint` for `bford.info` (#77).
6. **Analyze the new side as a new package when the old side is
   unanalyzable.**

## Decisions from 2026-10-17

- PR-comment guidance keeps covering every CRITICAL/HIGH class, not only the
  rows shown after the cap. It is per class and bounded, and the comment
  already points to SARIF when guidance is dropped.
- `manifest-not-regular` versus `manifest-missing` stays as is. Both are
  CRITICAL, and unifying them means touching the extraction filter. One
  sentence in the exception docs is enough if it ever confuses someone.

## Gotchas

- **Dependabot bundle bumps:** rebuild only with
  `scripts/package-action-sandboxed.sh`, never `npm ci` on the host for that
  branch. Review minified bundle diffs with
  `git diff --word-diff=porcelain --word-diff-regex='[A-Za-z0-9_$]+|[^[:space:]]'`;
  Python `difflib` on the minified lines hangs.
- **Moving a package from dev to runtime** makes dependency review treat its
  whole tree as newly added, so pending advisories in that tree fail the PR.
  Land the security bumps first.
- **No `Co-Authored-By` trailer** on capdelta commits (CLAUDE.md), even when
  the harness asks. For a branch commit that already has one, pass `--body`
  to `gh pr merge --squash`.
- **zsh does not split unquoted variables.** Pass lists to `git push --delete`
  or `git branch -D` through `xargs`.
- **Codex in Orca** can stop at a hook-trust prompt the orchestrator cannot
  answer. Run reviews headless with
  `codex exec -s read-only -C <worktree> -o <answer-file> "<prompt>"`.
- **`check:action` rewrites `dist/action/`** while it runs. Run reviewers after
  verification.
- **zizmor in CI scans the whole repo**, including `dependabot.yml` and
  `action.yml`. Run it locally on `.` as well:
  `nix run nixpkgs#zizmor -- --no-online-audits .`
- **Mutation testing was dropped.** StrykerJS 10 with vitest 5 never activated
  a mutant here.
- **Stacked PRs:** never `--delete-branch` a branch others are based on.
  Prefer independent PRs merged one at a time.
- **Zero-change refactors:** `.scratch/dedupe/` (gitignored) has scripts that
  replay 20 verify-capdelta drives and diff them byte for byte. Record a fresh
  baseline before reusing them.
- **Untracked:** `.claude/agents/comment-audit.md` in the main checkout is the
  comment-audit project agent.
