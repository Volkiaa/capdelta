# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-25.

## v2 platform, phases 1 to 3 (2026-10-24 to 25)

The v2 service is on main and works end to end. `docs/v2-roadmap.md` is the
goal, `docs/platform.md` is the operator guide, ADR-038 to ADR-041 are the
design. Merged: #169 to #190.

- **Phase 1.** `src/platform/` has the file store, npm collector, job queue,
  `analyzeRelease`, read API and the `capdelta-platform` CLI (`monitor`,
  `analyze`, `serve`, `reviewer-token`). Proven on the live registry: `monitor`
  bootstrapped from `update_seq`, then analyzed 136 real releases with 0
  failures.
- **Phase 2.** Reconstructions prove a new host with existing `NET` and a new
  sensitive read with existing `FS_READ` (#179). Reviewed baselines and a
  slow-roll test are in #180 (ADR-040). The evaluation is in
  `docs/eval/2026-10-24/`: 222 benign transitions, 2 false positives (0.9%),
  incomplete 10.9%.
- **Phase 3.** Findings keep severity, confidence and verdict apart (ADR-039).
  Only a reviewer token plus a validation reaches `confirmed-malicious`. The
  feed, OSV records and query routes exist. `--intel-url` and the Action input
  `intel-url` add a CRITICAL finding for a confirmed match (ADR-041, Tier 2,
  stricter only, held-out unchanged).

**Not met.** The roadmap asks for 25 real malicious releases. Only 2 are still
on the registry (faker 6.6.6, node-ipc 11.0.0). The roadmap line is unticked
and says why. Real recall is 0 of 2, and the default gate fires on 6 of 14
synthetic reconstructions. Nothing was tuned on the held-out entries.

**Decide first.**

1. The overnight drafts #161, #163 to #166 (ADR-032 to ADR-036) are still open
   and `main`'s old HANDOFF decision list below still applies to them. They
   predate this work.
2. Phase 4 (sandboxed dynamic analysis) and phase 5 are not started. The
   roadmap marks them post-MVP.
3. The platform has no TLS and no rate limiting by design. Put a reverse proxy
   in front before exposing it beyond localhost.
4. ADR-0043 (draft, Tier 3) adds a base-commit `registry-hosts` allowlist so a
   project can analyze an internal mirror instead of skipping it as
   `private-registry`. It narrows a detection and adds policy reading, so it
   needs your approval and has not been merged. Tests cover exact-host
   matching, base-commit reading in the CLI and Action, and SRI on a listed
   host. Measurement is in the ADR.

**Known gaps worth a ticket.** The lockfile differ analyzes only
`registry.npmjs.org` unless base policy lists more hosts under `registry-hosts`
(ADR-0043, draft), so unlisted mirrors are skipped as private. A feed event
queues the 3 newest versions of a package.
`JobQueue.claim` scans the whole job directory. The analyzer cannot yet
analyze a new package's dependency tree, which is why `node-ipc` 11.0.0 is
missed.

**Lessons.** Run the built tool on the real service before calling it done:
the live feed rejected `since=now`, which a fake registry had accepted, and
the first `serve` exited at once because the entry never passed a signal.
CodeQL gates PRs: path-building code needs a resolve-and-startsWith check it
recognizes, not only a regex. Codex blocks on theory unless the prompt states
the blocking bar, so each review prompt names it.

## Earlier state

## Where main stands

main includes #154, and CI is green on it. No draft PR is open. The decision
log for the last runs is `.scratch/next/decisions.tsv` (gitignored, main
checkout), from its `run4 start` row on.

- **#148** (ADR-027, accepted by the agent under the maintainer's grant): a
  bare IPv6 address glued to other text in a string is LOW.
- **#152** (ADR-026, same grant): URLs in the runtime value of escaped strings
  are found, on both sides of the diff.
- **#154** (ADR-028 option B, same grant): `.ts` files are stripped with
  amaro 1.1.11 and analyzed like JavaScript. capdelta now requires Node 22.
  CI and the `main` ruleset no longer run or require Node 20.
- Earlier today: the Autonomy tiers (#143), the replay helper (#145), the
  parser worker start failure (#146, ADR-025), and three fixes on main
  (#149, #150, #151).

## Next, in order

1. **Cut v0.1.0** when the maintainer chooses. It is a deploy. Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify` for both `dist/action/index.js` and
     `dist/action/javascript-parser-worker.js` on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases.
2. **Post the blog** once the maintainer un-parks it. PLAN §6 names tl;dr sec,
   Detection Engineering Weekly and r/netsec.

Small follow-ups, not started:

- The capdelta self-review on #154 failed once on an empty `HttpError` from
  the SARIF upload, and a rerun passed. If it happens again, log the HTTP
  status in `ActionRunnerOperationalError`.

Decided this run, not changed:

- The parser client keeps trusting the worker's messages after ready. The
  worker is capdelta's own bundled code, not package input, so a shape check
  there guards nothing an attacker controls.
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
  `run5-main154` is the latest main baseline (main at #154). It matches main
  at #152 on all 20 drives, none of which ships TypeScript.
- **Codex finds one class per round.** A security review of extraction code
  often blocks several rounds in a row, each on a new input. After the second
  block on the same kind of property (an output difference, a slowdown), build
  a check that searches for it, such as the differential fuzzer, and test that the check
  finds a known-bad variant before trusting a zero. For URL and IP detection
  that check is `npm run difffuzz -- --base origin/main`
  (`docs/development.md`).
- **Untracked:** `.claude/agents/comment-audit.md` in the main checkout is the
  comment-audit project agent.
