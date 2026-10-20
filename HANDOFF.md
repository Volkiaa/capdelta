# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-20 (evening).

## Where main stands

main includes #129, and CI is green on it. No PRs are open.

On 2026-10-20, after M5 became publication-ready (#123 to #125):

- **#127.** The PR comment row for the `install` hook read "changed install
  install hook". It now quotes the hook name, as the text report does:
  `changed "install" install hook`.
- **#128.** Running a golden or reconstruction test directly without
  `npm run build` now fails with a message naming the missing parser worker,
  instead of degrading to `unparseable-source` diagnostics.
- **#129.** Golden comparisons use vitest's `toMatchFileSnapshot` on the
  existing `expected-*` files. After an intended report change, run
  `npm run build && npx vitest run <golden test file> -u` and review the diff.
  Put `-u` after the path, because vitest 5 reads the next argument as the
  update type.

The blog is parked at the maintainer's request (2026-10-20). The draft stays
in `docs/blog/` and nothing is posted.

The run's plan, decision log and both design proposals are in `.scratch/next/`
(gitignored, main checkout).

## Next, in order

1. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **Noise reduction. The design waits for maintainer approval.**
   `.scratch/next/d1-noise-design.md` proposes the following:
   - A URL inside a string that also holds other text becomes LOW.
   - A URL that is the whole string stays HIGH.
   - A file that failed to parse keeps today's behaviour.

   In every reconstruction and golden case, the endpoint URL is a whole
   literal, and no gate depends on the endpoint finding
   (`.scratch/next/r3-endpoints.md`). The design also plans a new frozen
   corpus with a tuning half and a held-out half, because M5 had no held-out
   split. Two decisions are open: LOW or MEDIUM for embedded URLs, and the
   corpus size.

3. **New-side analysis. The design waits for maintainer approval.**
   `.scratch/next/d2-newside-design.md` addresses one case: the old side
   fails extraction or the manifest read, and the new side reads cleanly.
   Today that package gates and can't be excepted, because ADR-017 C.2 needs
   a new-side failure (`docs/adr/0017-reviewed-unanalyzable-exceptions.md:73-84,131-135`).
   The proposal analyzes the new side as a newly added package, so every
   capability shows as added and gates normally. The old failure is reported
   but doesn't gate. It needs ADR-023, and it lowers the gate in exactly that
   case, on purpose.
4. **Post the blog** once the maintainer un-parks it. PLAN §6 names tl;dr sec,
   Detection Engineering Weekly and r/netsec.

Small follow-ups, not started:

- If a built CLI or Action can't load its parser worker, the failure becomes
  per-file `unparseable-source` diagnostics
  (`src/core/npm/javascript-capability-extractor.ts:453`). That path can't
  tell a load failure from a parser crash on hostile input.
- The noise class with the most rows is zod's 86 `unparseable-file` MEDIUMs
  from published TypeScript (`docs/m5-2026-10-12/labels.json:35-40`). D1
  doesn't cover them.

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
  answer. Run reviews headless with `~/.claude/bin/codex-review --focus
"<what to check>" <worktree>`. It writes the diff without `dist/`, runs
  `codex exec -s read-only`, kills a run with no output for 600s, and prints
  `APPROVE` or `BLOCK` followed by at most 30 lines. It reviewed #128.
- **`~/.claude/bin/spawn-worker --name <task> --ticket <file> --method
tdd|bugs|none [--wait]`** creates the Orca worktree, runs
  `npm ci --ignore-scripts`, writes the brief and starts the DeepSeek
  terminal. With `--wait`, it returns `DONE`, `STALLED` or `TIMEOUT`.
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
