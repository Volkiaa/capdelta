# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-26 (evening).

## VPS deployment and throughput (2026-10-26, evening)

The platform runs on the maintainer's VPS (`ssh vps`, Tailscale host
`hermes-vps.tailec084.ts.net`, 2 cores). It is reachable only on the tailnet:
`tailscale serve` gives https, nothing is public. `~/capdelta-platform` holds a
Dockerfile and `compose.yml` with `monitor` and `serve`. Redeploy by sending
`git archive HEAD` plus those two files and the watchlist, then
`docker compose up -d --build`. One reviewer (`e2e`) is in `reviewers.json`.
Grafana was removed from the host; `ntfy` stays. The status page is at `/`
(ADR-046, #220).

Merged this session: #218 (HANDOFF), #220 (status page and recent routes),
#222 (`--concurrency`), #225 (`--watchlist`, ADR-047), #227 (`--page-size` and
catch-up), #229 (ADR-048, single-digit arrays are not charcode arrays, Tier 3,
maintainer approved).

The VPS monitor runs `--concurrency 3 --page-size 1000` on a top-5,000 list
(`scripts/fetch-watchlist.mjs`). Measured: the feed produces about 266 events a
minute, the old monitor read 100 per cycle and lagged by 32,000 events. With
the watchlist and the catch-up loop it reached the live feed in two minutes.
Only 6 of 1690 releases analyzed before the watchlist were in the top 17,338.
Concurrency 3 gave about 1.5 to 1.8 times the throughput of 1 on 2 cores. The
benchmark was noisy because each window saw different releases.

**Decide.**

1. #224 (priority by watchlist rank and a capped lane for unlisted packages) is
   not started. Wait for a day of watchlist results before building it.
2. A stub previous version (`0.0.0-stage`) inflates a package's first real
   release to CRITICAL (xeorank, dsh-plugins-update and others). Do not lower
   severity for it: an attacker can publish a stub first. The proposed fix is
   triage context (package age, prior versions) that ranks the feed and moves
   no gate. It needs its own ADR.
3. Exempting `.invalid` hosts was rejected: the attack reconstructions use
   `example.invalid`. A different defanging convention would let it be
   reconsidered.
4. The Action has not run against the VPS from a real GitHub runner. That needs
   a public https URL with authentication in front. Not done.

Open bugs worth a ticket: a throwing `done` event handler can move a completed
job back to pending (worker.ts); a stored release without `summary.bySeverity`
makes the recent-releases route return 500; `previousVersion` follows publish
time, so a stable release can show a later nightly as its previous version.

## Triage 2026-10-26

Merged #211 (a release's newly declared dependencies are analyzed, which closes
the open ticket about walking a new package's tree) and #213 (`npm run verify`
runs the six CI checks in order, Tier 1, issue #212).

The maintainer closed the five overnight URL and IP evasion drafts: #161
(ADR-032), #163 (ADR-033), #164 (ADR-034), #165 (ADR-035), #166 (ADR-036).
Reason: each defends an exotic input form, Codex found one new case per round,
and all five conflict with main. The branches stay (`Volkiaa/f4-cooked-ip`,
`f1-scheme-forms`, `f2-userinfo`, `f5-feff`, `f7-unparseable-escapes`) and
hold the only copy of ADR-032 to ADR-036. Reopen one only when the live
monitor or the corpus shows a real case.

Draft #204 (ADR-043, Tier 3, registry-hosts allowlist) is parked. It conflicts
with main and CodeQL fails on it. No user has asked for mirror support.

Still open for the maintainer:

1. Whether to retag #157 to #159 (merged, established rules) as additive, or
   revert them. They can hide a new host behind an old spurious one (see
   ADR-037). Revert commits: 03a4696, 419a4b0, 6444fcb.
2. Cut v0.1.0 and un-park the blog (see Next, in order).
3. Deploy the platform behind TLS, then point the dogfood workflow at it.

The maintainer asked for a plain-language model of how a bump becomes a
verdict. Next session: trace one finding from report field to source line
(`run-severity.ts`, `capability-differ.ts`, `signal-extractor.ts`) and write
`docs/how-it-works.md`.

## Follow-up batch (2026-10-25, after phase 3)

Merged: #192 to #203 and #205. Draft: #204.

- **Tooling.** `bin/intel-drive` and `bin/action-drive` drive the CLI and the
  bundled Action against a real platform service. `replay` records the intel
  matrix. `check:deps` also runs `check-docs` (CLI flags in `docs/cli.md`,
  README dependency list) and `check-skill` (verify skill drift). A weekly
  workflow runs the live drives. `eval-incomplete` publishes the causes of
  incomplete analyses.
- **Platform.** `JobQueue.claim` no longer scans the job directory (#197).
- **Six new reconstructions** (#199, #200): event-stream, ua-parser-js,
  eslint-scope, coa and rc, colors, chalk and debug. They exposed two gaps, now
  closed by Tier 2 detections: colors 1.4.1 gets a MEDIUM
  `import-time-unbounded-loop` (ADR-042, #203) and chalk and debug get a
  CRITICAL `wallet-address-swap` shape (ADR-044, #205). Held-out corpus
  unchanged both times (45 pairs, 0 rows different). The `docs/eval` totals are
  not recomputed with the new reconstructions.
- **CodeQL** ignores `test/fixtures/reconstructions` only (#199), because the
  inert attack fixtures model the flows it reports.

**Decided 2026-10-26: parked.** Draft #204 (ADR-043, Tier 3) adds a base-commit `registry-hosts`
allowlist for internal mirrors. Held-out unchanged with no config, Codex APPROVE.
It is not measured on a repository that uses a mirror.

**Open tickets.** Hook detection (`window.fetch` assignment,
`XMLHttpRequest`) has false-positive risk and needs its own held-out run. The
dogfood workflow still pins a pre-v2 Action revision without `intel-url`. Deploy
the service behind TLS, then point the dogfood workflow at it.

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

1. The overnight drafts #161, #163 to #166 were closed on 2026-10-26 (see
   Triage).
2. Phase 4 (sandboxed dynamic analysis) and phase 5 are not started. The
   roadmap marks them post-MVP.
3. The platform has no TLS and no rate limiting by design. Put a reverse proxy
   in front before exposing it beyond localhost.

**Known gaps worth a ticket.** The lockfile differ accepts only
`registry.npmjs.org` unless draft #204 lands, so mirrors are skipped as
private. A feed event queues the 3 newest versions of a package. #211 added analysis
of newly declared dependencies; recheck whether `node-ipc` 11.0.0 is now caught.

**Lessons.** Run the built tool on the real service before calling it done:
the live feed rejected `since=now`, which a fake registry had accepted, and
the first `serve` exited at once because the entry never passed a signal.
CodeQL gates PRs: path-building code needs a resolve-and-startsWith check it
recognizes, not only a regex. Codex blocks on theory unless the prompt states
the blocking bar, so each review prompt names it.

## Earlier state

## Where main stands

main includes #154, and CI is green on it. The decision
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
