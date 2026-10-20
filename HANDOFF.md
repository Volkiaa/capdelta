# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-20.

## Where main stands

main is at a0402ab, and CI is green on it. No PRs are open, and the only
branch besides `main` is the one carrying this handoff.

Merged on 2026-10-20:

- **#119.** Lockfile findings become rows in the PR comment's findings table.
  They share the row cap, the severity order and the `Showing N of M` count.
  `finding-guidance.ts` has `LOCKFILE_GUIDANCE`, and the golden
  `test/fixtures/golden/integrity-changed-version-same/expected-comment.md` is
  asserted in `src/action/action-comment-reporter.test.ts` (core may not
  import action, so the assertion cannot live in `reporter.golden.test.ts`).
- **#120.** SARIF emits one `CAPDELTA-LOCKFILE-<KIND>` rule and one result
  per lockfile finding, located at `lockfilePath`. The text report prints
  guidance under HIGH lockfile findings.
- **#118.** scorecard-action v2.5.0. The pin matches the upstream tag commit.

Codex approved #119 and #120. The golden case rendered through the real
pipeline now shows the HIGH row and its guidance in the comment, and a rule
plus a located `error` result in SARIF. Before, the comment had no row and
SARIF had zero results. The render script is
`.scratch/lockfile-render/render.ts` (gitignored, main checkout). Copy it
into a worktree's `.scratch/` to run it there, and delete the copy before
`npm run lint`, which otherwise fails on it.

The 2026-10-17 merges (#112 to #117) are logged in `docs/SESSIONS.md`.

## Next, in order

1. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **M5 publication.** M5's `gateFail` is severity-only and does not count
   operational exit 1 (`scripts/m5-measure.ts:110`). Fix its dead reference to
   `docs/m5-measurement-2026-10-12.md` (the data lives in
   `docs/m5-2026-10-12/`). Never edit `docs/m5-2026-10-12/`. Ask the
   maintainer what "publication" covers before starting.
3. **Noise reduction on a new held-out corpus.** Needs a design. A known false
   positive is a URL inside a string literal. vitest 5.0.4's `CACHEDIR.TAG`
   text produced a HIGH `new-external-endpoint` for `bford.info` (#77).
4. **Analyze the new side as a new package when the old side is
   unanalyzable.** Needs a design.

Small follow-ups found on 2026-10-20, not started:

- A targeted `npx vitest run` of the golden or reconstruction tests without a
  prior `npm run build` degrades to unparseable-source diagnostics instead of
  failing loudly.
- `scripts/generate-golden-fixtures.mjs` writes only tarballs and lockfiles.
  The `expected-*` files in golden cases are maintained by hand.

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
