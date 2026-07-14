# ADR-008: The LockfileDiffer emits facts; the severity model owns severity

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §4.1 (findings), §4.4 (severity model)

## Context

PLAN §4.1 says "version unchanged but integrity changed → HIGH finding" and
"version downgrade → INFO finding", while §4.4's severity tables also map
these facts. Encoding HIGH/INFO in the differ would duplicate the fact→severity
mapping in two components that would then drift.

## Decision

`LockfileFinding` carries a typed fact kind
(`integrity-changed-version-same`, `version-downgrade` —
src/core/contract/lockfile-diff.ts) and never a severity. The §4.4 severity
model is the single place facts become HIGH/INFO/etc. The §4.1 severity
annotations are read as documentation of the eventual mapping, not as differ
requirements.

## Alternatives rejected

- **Severity on the finding at emission time** — hardcodes the mapping in two
  places; corpus validation (PLAN §7.4) is expected to adjust severities, and
  that adjustment must not require touching the differ.

## Consequences

- The severity model (M3) must map every `LockfileFindingKind`; adding a kind
  without a mapping should fail loudly there.
- Findings are emitted even for packages later skipped (a downgraded private
  package is still a reported downgrade — src/core/npm/lockfile-differ.ts:110).
