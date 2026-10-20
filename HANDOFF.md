# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-20 (night).

## Where main stands

main includes #135, and CI is green on it. No PRs are open.

On the night of 2026-10-20 the maintainer approved both designs and a
DeepSeek-worker run implemented them. Plan, tickets and decision log:
`.scratch/next/` (gitignored, main checkout), `decisions.tsv` from its
second `start` row on.

- **D2, new-side analysis: shipped.**
  - #131 adds ADR-023.
  - #133 adds `baselineFailures` to analyzed packages in the JSON report,
    text, PR comment and SARIF (level `note`).
  - #134 makes the pipeline fill it. The old version may fail extraction or
    the manifest read with a CRITICAL failure while the new version reads
    cleanly. The package is then analyzed as newly added, and the old
    failure is reported but not gated. An operational old failure keeps the
    package unavailable, so exit 1 still holds. This lowers `gateSeverity`
    on purpose. A real drive on `@tabler/icons-react` 3.48.0 -> 3.49.0 moved
    from CRITICAL 2 to CRITICAL 1. The old version is over the
    10,000-entry cap, and its dependency `@tabler/icons` still fails on its
    new side.
  - #135 documents it in the README and `docs/cli.md`.
- **D1, URLs mentioned in text: half done, stopped.**
  - #131 adds ADR-024 (a new host seen only inside prose becomes LOW).
  - #132 freezes a 30 x 3 corpus split 15/15 by package
    (`docs/heldout-2026-10-20/`) and records its baseline. No pair adds a
    host through a URL, so finding counts can't show the change. D1d also
    plans to measure the classifier on every URL the new versions contain.
  - D1b (classify each URL by its string) stopped after two consecutive
    Codex BLOCKs. Both found strings whose runtime value is a single URL
    while the raw source looks like prose (a backslash-newline continuation,
    then escaped whitespace at the ends). The branch `Volkiaa/d1b-endpoint-context`
    is pushed (no PR), and its worktree is kept.
    `.scratch/next/d1b-stopped.md` gives the root cause, which is classifying
    raw text instead of the cooked value, and proposes a fix.

The blog is still parked. The draft stays in `docs/blog/`.

## Next, in order

1. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **D1b, third attempt. It needs the maintainer's go-ahead** because the same
   unit failed twice. Read `.scratch/next/d1b-stopped.md`. The proposal is to
   classify the cooked string value (`Literal.value`,
   `TemplateElement.value.cooked`), normalized the way the WHATWG URL parser
   normalizes input. A URL becomes `embedded-text` only when both the cooked
   value and the raw text hold whitespace. Then D1c (severity, golden case,
   destination-swap boundary test, `.scratch/next/tickets/d1c.md`) and D1d
   (held-out run and write-up).
3. **Post the blog** once the maintainer un-parks it. PLAN §6 names tl;dr sec,
   Detection Engineering Weekly and r/netsec. `docs/blog/` still lists
   new-side analysis as a next step. Update that line before posting.

Small follow-ups, not started:

- If a built CLI or Action can't load its parser worker, the failure becomes
  per-file `unparseable-source` diagnostics
  (`src/core/npm/javascript-capability-extractor.ts:453`). That path can't
  tell a load failure from a parser crash on hostile input.
- The noise class with the most rows is zod's 86 `unparseable-file` MEDIUMs
  from published TypeScript (`docs/m5-2026-10-12/labels.json:35-40`). D1
  doesn't cover them.
- In the D1 tuning baseline, http-server 13.1.0 -> 14.0.0 fails the default
  gate with a `secret-exfiltration` shape. The shape comes from a TLS
  passphrase environment variable read in a file that requires `https`. It
  is not labelled yet.
- The IPv6 literal pattern matches characters in minified data (`c::9bb` in
  markdown-it 15.0.3). ADR-024 does not cover IP literals.
- The PR comment's baseline-failure section is not capped by `maxRows`. The
  reviewed-exceptions section works the same way.

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
