# ADR-020: Decide write access from the token, not from the PR author

- **Status:** accepted
- **Date:** 2026-10-14
- **Plan reference:** PLAN §2 (degrade loudly), §3 (fork PRs), §4.5, §9 (Dependabot demo)

## Context

The Action treats every PR opened by `dependabot[bot]` as read-only (src/action/run-action.ts:202-207 at cb39d2c). For
those PRs it skips the SARIF upload and the sticky comment and writes only the job summary. GitHub no longer gives
Dependabot runs a fixed read-only token. It applies the workflow's `permissions:` block instead. The capdelta run on
2026-10-12 for a Dependabot branch (run 38258824396) had `PullRequests: write` and `SecurityEvents: write`, yet printed
"dependabot PR cannot upload SARIF with the read-only token". As a result, Dependabot PRs #24, #27 and #28 have no
capdelta comment, and PLAN §9 needs one as the demo asset.

## Decision

1. **Forks are skipped before any write.** When the head repository differs from the base repository, the Action
   writes the job summary only, as today. GitHub always gives a fork PR a read-only token (PLAN §3).
2. **Every other PR attempts the writes.** The PR author no longer matters. The Action creates or updates the sticky
   comment and uploads SARIF.
3. **One refusal degrades to the job summary.** If GitHub answers a comment write or the SARIF upload with HTTP 403 and
   the message "Resource not accessible by integration", the Action warns, naming the missing permission
   (`pull-requests: write` or `security-events: write`), and keeps going. A refused comment write falls back to the
   job summary. A refused SARIF upload leaves the JSON artifact and the job summary.
4. **Every other failure fails the run, as today.** That includes other 403s (GitHub also uses 403 for secondary rate
   limits), 404, 5xx and network errors. The Action classifies the raw GitHub error before wrapping it.
5. **Types.** The read-only reason becomes `"fork" | "token-denied" | null`, and `"dependabot"` is removed from
   `CommentDelivery.readOnlyReason` and the `summary-only` result.

Delivery never affects the gate. The exit code still comes from `summary.gateSeverity`.

## Alternatives rejected

- **Keep the Dependabot rule and document a workaround.** No workflow setting can make it post, so PLAN §9 stays
  blocked.
- **Read the token's permissions before writing.** A step has no reliable API for its own `GITHUB_TOKEN` permissions.
  The log's permission block is not readable from the Action.
- **Fall back on any write error.** An outage or a bug would turn into a quiet summary-only run, which breaks
  "degrade loudly" (PLAN §2).

## Consequences

- Dependabot PRs get the sticky comment and SARIF whenever the workflow grants the permissions, which capdelta's own
  workflow does.
- A repository that sets a read-only token for Dependabot now spends one refused request per run and gets a warning
  that names the permission to add.
- The fallback depends on GitHub's error message text. If GitHub changes it, a refusal fails the run loudly instead of
  degrading. That fails closed, and the message check would need updating.
- Revisit if GitHub exposes a token's permissions to the step.
