# ADR-011: Bound npm tarball extraction resources

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §3 (size/file-count caps), §4.2

## Context

An SRI-verified archive can still be a decompression bomb or contain an
excessive number of files. PLAN §3 requires extraction limits, but leaves the
initial thresholds to the implementation.

## Decision

Default safe extraction limits are 10,000 entries, 250 MiB expanded bytes, a
100:1 expanded-to-compressed ratio, and 64 KiB of tar metadata. Exceeding any
limit rejects only that package with a structured failure; it does not abort
the overall analysis run.

## Alternatives rejected

- **No default limits** — leaves a CI process vulnerable to resource
  exhaustion from a validly compressed, verified archive.
- **Fail the entire run on one archive** — loses the PLAN §2 degrade-loudly
  property by preventing analysis of unaffected packages.

## Consequences

- The defaults are explicit in `src/core/npm/safe-extractor.ts:71-76` and can
  be overridden through its options for controlled use cases.
- A legitimate unusually large package is skipped-and-flagged rather than
  analyzed until its limit is raised deliberately.
- Revisit after a representative package corpus or fuzzing demonstrates that a
  threshold is impractical or insufficiently protective.
