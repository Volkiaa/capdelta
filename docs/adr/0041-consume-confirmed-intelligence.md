# ADR-041: Let a confirmed intelligence verdict add a CRITICAL finding

- **Status:** Accepted (agent, 2026-10-25, Tier 2 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-25
- **Plan reference:** PLAN §2 (degrade loudly), ADR-015, ADR-038, ADR-039 item 8

## Context

ADR-039 lets a reviewer mark one artifact `confirmed-malicious` in a shared
service. The CLI and the Action need to act on that verdict, and local
protection must keep working when the service is down.

## Decision

1. `--intel-url` (CLI) and the `intel-url` input (Action) turn the lookup on.
   Without them nothing changes. The setting is not read from `.capdelta.yml`,
   which comes from the base commit (ADR-015): a pull request that could set it
   would point the check at a service that never matches. The CLI argument and
   the workflow input are the maintainers' own.
2. For each distinct `newIntegrity` of the changed packages the client sends
   `GET /v1/findings?ecosystem=npm&digest=<sha512>`. It sends no package name,
   no lockfile and no credential, follows no redirect, and accepts only an
   https URL, or http for `localhost`, `127.0.0.1` and `[::1]`.
3. `intelMatches` (`src/core/intel-match.ts`) adds one `intel-confirmed-malicious`
   lockfile finding, severity CRITICAL, only when ecosystem, name, version and
   digest all match and the verdict is `confirmed-malicious`. Every other
   verdict adds nothing. The finding only adds to the gate, so the change is
   stricter-only.
4. The client keeps only entries for the digest it asked about, at most 20 per
   digest, and reports the rest as invalid findings in one warning. Responses
   are capped at 1 MiB, each request at 5 s and the whole lookup at 20 s.
5. Any service problem (network error, timeout, non-200, oversize, bad JSON,
   wrong shape) becomes one aggregated warning per cause and local analysis
   decides. A malformed `--intel-url` is a configuration error (exit 64, or a
   failed Action step), because the operator typed it.
6. The CLI and the Action query the findings route, not the feed. The finding's
   current verdict carries a retraction at once. The feed serves mirrors.

## Evidence (Tier 2 checks)

- **Held-out corpus.** `scripts/m5-measure.ts run` on
  `docs/heldout-2026-10-20/corpus-heldout.json` before (main) and after (this
  change): 45 pairs each, 0 gate failures each, and every row (status,
  `gateFail`, `gateSeverity`) identical.
- **Reconstructions and goldens.** The full suite passes with no golden file
  changed and every attack reconstruction at the same `gateSeverity`.
- **Real CLI drive.** The built CLI ran on the published bump `is-odd`
  3.0.0 to 3.0.1 against the platform service. No flag: exit 0. Suspected:
  exit 0, no intel finding. Confirmed: exit 1, one CRITICAL
  `intel-confirmed-malicious` finding. Retracted: exit 0. Service down: exit 0
  with `intelligence service unavailable (network-error)` on stderr. Bad URL
  (`ftp://x`): exit 64.
- **Codex security review.** Round 1 blocked on one real defect, spreading an
  unbounded match list into `push`, which a hostile service could use to throw
  before local analysis. Fixed by the digest filter, the 20 entry cap and loop
  appends, with a regression test.

## Alternatives rejected

- Read the setting from `.capdelta.yml`. A pull request controls the head
  copy, and the base copy would make a new setting hard to roll out.
- Send package names. The digest is enough to match and reveals less.
- Fail the run when the service is down. Local protection must not depend on
  it, and the roadmap forbids it.

## Consequences

A reviewer can now stop an install in every consuming repository, and can undo
it. The service operator learns which artifact digests a repository bumps. To
revert, remove the option, `src/core/intel-client.ts`, `src/core/intel-match.ts`
and the finding kind. Nothing else depends on them.
