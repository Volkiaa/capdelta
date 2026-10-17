# HANDOFF

Start here, then read CLAUDE.md. `docs/SESSIONS.md` has the history and
docs/PLAN.md (rev. 3) is the spec. Last updated 2026-10-16.

## Where main stands

main is at 4d9bbdb. Three programs finished on 2026-10-16. Each is logged in
`docs/SESSIONS.md`.

- **Comment audit (#78 to #92).** About 450 lines of redundant comments are
  gone, and eight refactors replaced the ones that explained surprising code.
- **Duplicate-code program (#93 to #107).** Eleven clusters of copied helpers
  now have one definition each, in `src/core/guards.ts`, `compare.ts`,
  `named-error.ts`, `line-index.ts` and `worker-pool.ts`. The CLI, the Action,
  golden fixtures and reconstructions are byte-identical.
- **CI/CD security (#105, #109 to #111).**
  - Rulesets protect `main` (PR, Node 20/22/24 CI, linear history) and `v*`
    tags (admins create, nobody moves or deletes).
  - Secret scanning with push protection, Dependabot security updates, and
    immutable releases are on.
  - zizmor, CodeQL, dependency review and OpenSSF Scorecard run in CI. The
    first Scorecard score was 6.7.
  - An ESLint complexity gate (limit 20, with a per-file baseline in
    `eslint.config.js` that may only shrink) is in place.
  - ADR-022 (accepted) designs the release pipeline.

The verify-capdelta skill was audited after the refactors (#108). Every recipe
was driven live, and three feature-map claims were corrected.

## In flight

- **#116, the release workflow (ADR-022).** It adds `release.yml`,
  `docs/security-pipeline.md` and the Scorecard badge. CI was green. Its Codex
  security review has not run: the interactive Codex session stopped at a
  hook-trust prompt. The `release` environment (required reviewer, `v*` tags
  only) already exists.
- **Dependabot:** #112 (undici, security), #113 (brace-expansion, security),
  #114 (actions/checkout 7.0.1), #115 (actions/setup-node 7.1.0).
- **Worktrees:** `release-workflow` holds #116's branch.
  `handoff-dedupe` holds an unpushed HANDOFF commit that this file supersedes,
  so remove it.

## Next, in order

1. **Land #116 after a Codex review.** Run it headless, from a worktree at
   main:
   `codex exec -s read-only -C <worktree> "Security review of git diff origin/main...origin/Volkiaa/release-workflow: injection, PR code reaching the release job or its token, cache or artifact poisoning, releasing a tag not on main, attesting the wrong file, excess permissions. First line APPROVE or BLOCK, then blocking findings with file:line, at most 30 lines."`
   Merge on APPROVE. On BLOCK, fix the findings and review again.
2. **Cut v0.1.0. This is a deploy, so the maintainer starts it.** Push the tag
   from main, then approve the run in the `release` environment. Afterwards:
   - check `gh attestation verify dist/action/index.js -R Volkiaa/capdelta`
     on a checkout of the tag;
   - repin `.github/workflows/capdelta.yml` to the release commit with a
     `# v0.1.0` comment, so Dependabot proposes later releases. This clears
     zizmor's `stale-action-refs` note and Scorecard's Signed-Releases gap.
3. **Dependabot PRs.** If a bump changes `dist/action/`, rebuild the bundle only
   with `scripts/package-action-sandboxed.sh` (ADR-021, "Updating bundled
   dependencies" in `docs/development.md`). Never run `npm ci` or the
   verification on the host for such a branch. Check whether #112 (undici)
   reaches the bundle before merging it. The action bumps (#114, #115) must
   also move the pins in `release.yml`.
4. **M5 publication.** M5's `gateFail` is severity-only and does not count
   operational exit 1 (`scripts/m5-measure.ts:110`). Never edit
   `docs/m5-2026-10-12/`.
5. **Noise reduction on a new held-out corpus.** A known false positive is a
   URL inside a string literal. vitest 5.0.4's `CACHEDIR.TAG` text produced a
   HIGH `new-external-endpoint` for `bford.info` (#77).
6. **Analyze the new side as a new package when the old side is
   unanalyzable.**

## Open questions for the user

- `scripts/m5-measure.ts` cites `docs/m5-measurement-2026-10-12.md`, which does
  not exist. The measurement lives in `docs/m5-2026-10-12/`.
- Should the PR comment's guidance follow only the rows shown after the row
  cap? Today it covers every CRITICAL/HIGH class.
- Should lockfile findings (`integrity-changed-version-same`, HIGH) get
  guidance?
- A non-regular `package.json` reports `manifest-not-regular` on the old side
  but `manifest-missing` on the new side. Both are CRITICAL. Unify it only if
  it confuses exception authors.

## Gotchas

- **Codex in Orca** can stop at a hook-trust prompt the orchestrator cannot
  answer. Run reviews headless with
  `codex exec -s read-only -C <worktree> "<prompt>"`.
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
