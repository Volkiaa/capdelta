# ADR-007: Moved-package matching rule for re-hoisted lockfile entries

- **Status:** accepted (approved in-session 2026-07-14)
- **Date:** 2026-07-14
- **Plan reference:** PLAN §4.1 (position-independent diffing; not spec'd there)

## Context

npm lockfiles key packages by tree position, and dependency bumps routinely
re-hoist packages without changing them. A strict position-keyed diff would
report every re-hoisted package as removed-plus-newly-added, flooding reports
with false full-report noise on big bumps. PLAN §4.1 diffs positions
independently but does not say what to do when a position exists only in the
new lockfile.

## Decision

For a path present only in the new lockfile, match against the old tree by
package name:

1. An identical artifact — same version, integrity, AND resolved URL
   (`sameArtifact`, src/core/npm/lockfile-differ.ts:215) — existed anywhere in
   the old tree → pure re-hoisting, ignored.
2. Exactly one distinct old artifact of that name → treated as a version
   change from it.
3. Ambiguous (multiple distinct old artifacts) or unknown name → newly-added
   treatment, full report.

Distinctness in rule 2 is on the full artifact tuple, not version alone: two
old copies of one version with different integrities must not produce an
iteration-order-dependent baseline (review finding, fixed in PR #2).

## Alternatives rejected

- **Strict position-only diff** — simpler, but every re-hoist becomes a false
  "newly added" full report; FP noise is the top risk in the register (PLAN §8).
- **Version-only identity for rule 1** (the first implementation) — silently
  dropped a copy whose tarball URL was re-pointed; rejected by review.

## Consequences

- Every ambiguity resolves toward over-reporting, never suppression.
- Regression tests pin all three rules (src/core/npm/lockfile-differ.test.ts,
  "moved packages" and "review regressions" suites).
