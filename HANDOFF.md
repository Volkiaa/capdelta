# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-20.

## Where main stands

main is at 08e0f72, and CI is green on it. No PRs are open, and the only
branch besides `main` is the one carrying this handoff.

M5 is publication-ready as of 2026-10-20. Nothing has been posted.

- **#123.** README corrections from an audit against the code, the ADRs and
  the frozen M5 record. The dependency count is now 7, the `yargs` HIGH is
  named as noise, and the Quick start says to build capdelta first. There
  were ten fixes in all. It also adds a gate-failure demo screenshot,
  `docs/images/demo-bcrypt-6.png`. That comes from throwaway PR #122, which
  bumped `bcrypt` 5.1.1 to 6.0.0 against a throwaway base branch. #122 is
  closed and both of its branches are deleted.
- **#124.** Blog draft, `docs/blog/2026-10-what-did-this-dependency-gain.md`.
  Every number comes from `docs/m5-2026-10-12/`.
- **#119, #120.** Lockfile findings in the PR comment, SARIF and the text
  report. Codex approved both.
- M5's `gateFail` stays severity-only, as ADR-019 decision 5 says
  (`docs/adr/0019-read-what-npm-installs.md:64-65`). Counting operational
  failures would change 0 of the 90 entries, because all 90 were analyzed.

The run's plan and decision log are in `.scratch/m5/` (gitignored, main
checkout).

## Next, in order

1. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **Publish M5. The maintainer edits and posts the blog draft.** PLAN §6
   names tl;dr sec, Detection Engineering Weekly and r/netsec. Link the post
   from the README's Roadmap once it is live.
3. **Noise reduction on a new held-out corpus.** Needs a design. Known false
   positives are URLs inside string literals: `yargs` 18.0.0's documentation
   link (M5) and vitest 5.0.4's `CACHEDIR.TAG` text (#77).
4. **Analyze the new side as a new package when the old side is
   unanalyzable.** Needs a design.

Small follow-ups, not started:

- The install-hook finding reads "changed install install hook" in the PR
  comment (seen on #122). The finding text repeats the hook name and the word
  "install".
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
- **`~/.claude/bin/ship-pr` and `~/.claude/bin/verify-quiet`** push, wait for
  CI, merge and clean up a worktree, and run the full verification with a
  one-line result. Both ran for real on #123 and #124.
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
