# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-21 (afternoon).

## Where main stands

main includes #151, and CI is green on it. Three draft PRs wait on the
maintainer. Plan, tickets and decision log for the last runs: `.scratch/next/`
and `.scratch/run4/` (gitignored, main checkout). `decisions.tsv` from its
`run4 start` row on covers this run.

- **#143** adds the Autonomy tiers to CLAUDE.md. Tier 1 (no gate change) and
  Tier 2 (stricter or louder gate) merge on their checks. Tier 3 (anything
  that lowers or drops a finding, new dependencies, policy rules, PLAN
  deviations, releases) stops at a draft PR.
- **#145** commits the zero-change replay as
  `.claude/skills/verify-capdelta/bin/replay` (`setup`, `record`, `compare`).
- **#146** (ADR-025, Tier 2): a parser worker that fails to start now fails
  the run with exit 1, instead of turning every file into
  `unparseable-source`.
- **#150** (ADR-024 amendment, Tier 2) fixes an evasion. A URL ran across a
  template literal's `${` and took the prose context of the element before
  it, or swallowed the next element's URL. The `template-boundary`
  reconstruction proves the fix.
- **#149 and #151** (Tier 1) make signal extraction linear. Before them, a
  package could stall a scan with repeated URLs: 20,000 lines took 186 s, and
  64,000 URLs on one line took 10.6 s. A differential fuzz against main shows
  no output change (`.scratch/run4/difffuzz.mjs`).
- **#144** removes the `contexts` command's hand-copied adapters.

## Next, in order

1. **Decide the three drafts.** Each has a Proposed ADR, held-out numbers and
   a Codex APPROVE:
   - #148, ADR-027: a bare IPv6 match glued to other characters is LOW. On
     the held-out corpus only markdown-it's two noise findings change. The
     alternative is to allowlist markdown-it.
   - #152, ADR-026: find URLs in the runtime value of escaped strings. All 90
     held-out reports are unchanged. The open choice is both sides (can drop
     a finding) or new side only.
   - #147, ADR-028: analyze published TypeScript. Pick option A, B or C, and
     decide on Node 20. The ADR recommends `amaro` with `engines >=22`.
     Strip-only stripping parses 307 of 332 zod files and 439 of 440 openai
     files. The implementation comes after the choice.
     #148 and #152 both edit `src/core/signal-extractor.ts`, so the one landed
     second needs a rebase.
2. **Cut v0.1.0** when the maintainer chooses. It is a deploy. Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
3. **Post the blog** once the maintainer un-parks it. PLAN §6 names tl;dr sec,
   Detection Engineering Weekly and r/netsec.

Small follow-ups, not started:

- The IP-literal rows can run across `${` like URLs did before #150. IP
  context is always `unknown` on main, so severity cannot drop today. Fix it
  before landing #148, which gives IPv6 a context.
- After ready, the parser client trusts any worker message as a
  `ParserResponse` without checking its shape (noticed in #146).
- `difffuzz.mjs` lives in `.scratch/`. A committed version would need a pinned
  copy of the old implementation to compare against.

Decided this run, not changed:

- No guidance row for baseline failures. ADR-023 already gives each one its
  own sentence, and they never gate.
- `renderActionComment` keeps rebuilding the comment per guidance row. The
  row count is bounded by the number of finding classes.
- http-server 13.1.0 -> 14.0.0's `secret-exfiltration` gate failure is
  labelled noise (`docs/heldout-2026-10-20/README.md`).

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
- **Zero-change and before/after drives:** `.claude/skills/verify-capdelta/bin/replay`
  (`setup` once, then `record <label>` per build and `compare <base> <head>`).
  `dedupe-run4-main` is the latest main baseline (main at #145). Every PR since
  matched it.
- **Codex finds one class per round.** A security review of extraction code
  often blocks several rounds in a row, each on a new input. After the second
  block on the same kind of property (an output difference, a slowdown), build
  a check that searches for it, such as `difffuzz.mjs`, and test that the check
  finds a known-bad variant before trusting a zero.
- **Untracked:** `.claude/agents/comment-audit.md` in the main checkout is the
  comment-audit project agent.
