# ADR-040: Compare releases against a reviewed baseline

- **Status:** Accepted (agent, 2026-10-24, maintainer v2 grant)
- **Date:** 2026-10-24
- **Plan reference:** PLAN §2 (v0.2 baseline snapshot), §3 (slow-roll attacks), §10 (dependency budget)

## Context

A slow-roll attack adds one small capability per release. Each version-to-version
diff stays below the gate, while the drift since the last version a person
inspected is large. PLAN §3 names this gap and PLAN §2 schedules a baseline
snapshot for v0.2. The platform already stores one release record per
`(analyzerVersion, name, version, digest, previous digest)`
(`src/platform/release-store.ts:29`), and `analyzeRelease` compares a candidate
with the immediately previous artifact (`src/platform/analyze-release.ts:40`).

## Decision

1. **A baseline is a reviewed artifact.** `BaselineRecord` holds the package
   name, version, sha512 integrity digest, tarball URL, the reviewer identity,
   the review time, and a note. It is a separate record from any analysis.
2. **Only a person sets a baseline.** `BaselineStore.set` is the only write
   path. `analyzeRelease` and `analyzeAgainstBaseline` never call it, so a
   release cannot move its own reference forward.
3. **Storage.** The current baseline lives under kind `baseline` with key
   `encodeKey(name)`. Every replacement also appends a record under kind
   `baseline-history` with key `encodeKey(name + "\n" + reviewedAt + "\n" +
digest)`. `history` returns the records for one package oldest first. Reads
   validate the record shape and throw `BaselineError` on a bad record.
4. **Comparison adds a record, it does not replace one.** When a baseline
   exists and its version differs from the candidate, `analyzeAgainstBaseline`
   calls `analyzeRelease` with `previous` set to the baseline artifact. The
   existing release key includes the previous digest, so the cumulative record
   is distinct from the version-to-version record and a second call returns the
   stored result without analyzing again. With no baseline, or with a candidate
   at the baseline version, it returns null.
5. **`ReleaseRecord` does not change.** Its `previousVersion` and
   `previousDigest` already record what the analysis was compared with, and the
   baseline lookup in `BaselineStore` records why. Adding a duplicate field
   would let the two disagree.
6. **A baseline never lowers a finding.** Every release still gets its
   version-to-version record through `analyzeRelease`, and the gate still reads
   that report. Setting a baseline adds a second report over a longer range; it
   does not remove, suppress, or re-score the stepwise report. A caller that
   sees a clean cumulative report can still inspect the stepwise record.
7. **Bounded strings.** Reviewer identity is truncated to
   `MAX_IDENTITY_CHARS` and the note to `MAX_VALUE_CHARS`. The artifact fields
   are written from collector output, which already bounds the package name,
   version, integrity, and URL; the store validates their shape on every read.

## Alternatives rejected

- **Let the analyzer choose the last analyzed release as the baseline.** The
  attacker's previous release then becomes the reference, so each step still
  hides the next one.
- **A reviewed flag on `ReleaseRecord`.** Review belongs to an artifact, not to
  one analysis result. A new analyzer version would lose the flag even though
  the artifact was already reviewed.
- **Overwrite the version-to-version record with the cumulative one.** That
  discards the stepwise evidence and changes what the gate reads. It would make
  the tool less honest, not stricter.
- **Sign the baseline.** There is no key management or reviewer key store yet.
  The reviewer identity is free text and is not an authentication claim.

## Consequences

Every reviewed release can produce a second stored record, so storage grows with
both releases and reviews. History is append-only and has no pruning, and a
`history` read scans the history kind and filters by package. A baseline pins the
tarball URL and digest, so re-analysis needs that artifact to remain fetchable.
A person must set a new baseline after accepting a release; nothing advances it
automatically. The default gate is unchanged. Phase 3 can serve the cumulative
record beside the stepwise record because both use the same release schema.
