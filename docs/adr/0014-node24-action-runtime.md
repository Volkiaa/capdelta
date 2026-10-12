# ADR-014: Run the GitHub Action on Node 24

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §4.6

## Context

PLAN §4.6 specified a node20 JavaScript Action. GitHub deprecated the Node 20
Actions runtime, made Node 24 the default on 2026-06-16, and scheduled Node 20
removal for 2026-09-23. Dogfood runs already log that the Action is forced onto
Node 24.

## Decision

Declare `using: node24` in `action.yml` and amend PLAN §4.6 accordingly. Add
Node 24 to the CI matrix so the suite runs on the Action's runtime. The CLI and
library keep `engines.node >=20`; that is a separate support decision.

## Alternatives rejected

- **Stay on node20** — it relies on GitHub forcing a runtime the metadata does
  not declare, and Node 20 has been removed from Actions runners.
- **Raise the CLI engine floor too** — nothing requires it, and it would drop
  supported users without cause.

## Consequences

- The Action metadata matches the runtime that actually executes it.
- CI covers Node 20, 22, and 24. Revisit the CLI floor when Node 20 leaves
  maintenance for downstream users or a dependency requires a newer runtime.

Source: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
