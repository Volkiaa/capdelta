# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-21 (early morning).

## Where main stands

main includes #141, and CI is green on it. No PRs are open. Plan, tickets and
decision log for the last three runs: `.scratch/next/` (gitignored, main
checkout), `decisions.tsv` from its third `start` row on for this run.

- **D2, new-side analysis (ADR-023): shipped** in #131 and #133-#135.
- **D1, URLs mentioned in text (ADR-024): shipped.**
  - #138 records each URL's context: `literal`, `embedded-text` or `unknown`.
    The third attempt classifies the cooked string value as well as the raw
    source. A URL is `embedded-text` only when both hold whitespace. Codex
    approved it after blocking the two raw-text-only versions.
  - #139 reports a new host seen only as `embedded-text` at LOW with
    `(mentioned in text)`. A real drive moved husky 5.0.9 -> 5.1.0's
    `typicode.github.io` from HIGH to LOW, so `--fail-on HIGH` without an
    allowlist now exits 0 instead of 1. axios 0.27.2 -> 1.0.0 stays at HIGH 12.
  - #140 measures it on the frozen corpus (`docs/heldout-2026-10-20/README.md`,
    "After ADR-024"). Finding counts are unchanged, as predicted. All 82
    `embedded-text` observations are prose.
  - #141 documents it in the README and refreshes the blog draft's next-steps
    paragraph.
- **#137** caps the PR comment's baseline-failure and reviewed-exception
  lists at `maxRows`, with a count of hidden exceptions.

The blog is still parked. The draft in `docs/blog/` is current.

## Next, in order

1. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **Post the blog** once the maintainer un-parks it. PLAN §6 names tl;dr sec,
   Detection Engineering Weekly and r/netsec.
3. **Designs that need the maintainer's approval.** None is started.
   - IPv6 literals in minified data. markdown-it 15.0.3 matches `=C::9bb~` in
     its entity trie. That is valid IPv6 syntax, so a tighter regex or `isIP`
     cannot reject it. A fix needs a context rule for IP literals, such as
     "only a whole string literal or a URL host counts". ADR-024 excludes IP
     literals, so this needs an ADR.
   - Parser worker load failure. If a built CLI or Action can't load its
     parser worker, every file becomes an `unparseable-source` diagnostic
     (`src/core/npm/javascript-capability-extractor.ts:453`). Proposal: a
     worker `error` before its first message ever is a run-level operational
     failure (exit 1), not a per-file parse result. This changes report
     semantics.
   - Published TypeScript. zod's 86 `unparseable-file` MEDIUMs
     (`docs/m5-2026-10-12/labels.json:35-40`) are the largest noise class.
     The same root makes URLs in `.ts` files `unknown`, including URLs in
     their comments, so they keep HIGH (66 of 78 tuning `unknown` rows,
     openai).
   - The endpoint regex's leading `\b` finds no URL glued to an escape tail,
     as in `"\x20https://evil.test/x"`. Concatenation (`"ht" + "tps://..."`)
     already evades it, and #139 has a boundary test documenting that.
     Scanning cooked string values would close both gaps. That is a detection
     change.

Small follow-ups, not started:

- In the D1 tuning half, http-server 13.1.0 -> 14.0.0 fails the default gate
  with a `secret-exfiltration` shape from a TLS passphrase environment
  variable read in a file that requires `https`. It is not labelled yet.
- `collectGuidance` ignores baseline failures, so they add no "What these
  mean" row in the PR comment.
- `renderActionComment` rebuilds the comment once per candidate guidance row.
- `scripts/m5-measure.ts contexts` builds a full run report only to reuse
  `isTransient`.
- `contexts` copies the pipeline's five default adapters by hand. No test
  checks that they still match `DEFAULT_ADAPTERS`.
- The URL regex misses `"\x20https://..."` entirely (see Next 3), so #138's
  test uses `"\x20 https://..."` for that escape.

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
- **Zero-change and before/after drives:** `.scratch/dedupe/record.sh <checkout> <label>`
  replays 20 fixed verify-capdelta drives, and `compare.sh <base> <head>` diffs
  them byte for byte and prints `gateSeverity`. Build the checkout first.
  `dedupe-main-703901e` is the latest main baseline (before #138).
- **Untracked:** `.claude/agents/comment-audit.md` in the main checkout is the
  comment-audit project agent.
