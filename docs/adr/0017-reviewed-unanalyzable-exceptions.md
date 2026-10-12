# ADR-017: Reviewed exceptions for unanalyzable packages

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §4.4 (allowlist), §4.6 (exit code); ADR-015, ADR-016

## Context

ADR-016 made unanalyzable packages CRITICAL by default. A benign package that
is legitimately oversized or ships a link now blocks the gate, and the
existing allowlist cannot release it. The allowlist suppresses capability and
signal findings matched by `(package, capability[, version])`. An unavailable
package has no capabilities to match, and the release has to stay tied to the
exact bytes someone reviewed. A version alone is not enough, because the
lockfile, and therefore `resolved` and `integrity`, is part of the PR under
review.

## Decision

1. **New top-level key `unanalyzable:` in `.capdelta.yml`.**
   - It sits alongside `allowlist:`. Each key may appear at most once, in
     either order. Either key may be absent, and `unanalyzable: []` is
     allowed.
   - The file is still read from the base commit (ADR-015).
   - Every field of an entry is required:

   ```yaml
   unanalyzable:
     - package: big-native-pkg
       version: 2.3.4
       integrity: "sha512-…" # exact lockfile integrity string of the reviewed artifact
       kind: expanded-size-limit # one unanalyzable failure kind
       justification: "Ships 80 MB of prebuilt binaries; reviewed upstream release notes and provenance."
   ```

   - `version` must be exact semver (`isExactSemver`).
   - `integrity` must be one or more canonical sha512 SRI tokens. Use the same
     check the fetcher applies; reuse it, don't reimplement it.
   - `kind` must be in `UNANALYZABLE_FAILURE_KINDS`, which `run-severity.ts`
     exports and derives from the ADR-016 classification.
   - `integrity-mismatch` and every kind classified `null` are rejected with a
     contract error.
   - The same `(package, version, integrity, kind)` tuple may not appear twice.
   - Exceptions bind to sha512 bytes. So `unsupported-integrity`, which means
     there is no usable sha512 to bind, can never be excepted and is rejected
     at parse time. The fix is to correct the lockfile.

2. **Matching (pure post-pass, `applyUnanalyzableExceptions(run, config)`).**
   - The post-pass runs on every unavailable package before
     `analyzeChangedPackages` returns.
   - A failure matches an entry when all of these hold:
     - the package name is the same;
     - the failure `kind` is the same;
     - the version on the failure's side equals `version` (old side:
       `oldVersion`; new side: `newVersion`);
     - that side's lockfile integrity equals `integrity` exactly (old side:
       `oldIntegrity`; new side: `newIntegrity`).
   - The package receives `exception: { reason }`, with
     `reason = "[version X] " + justification`, only when **every**
     severity-bearing failure of that package has a matching entry. If any
     CRITICAL failure is unmatched, or any failure is an integrity mismatch,
     the package keeps no exception and still gates.
   - Analyzed packages are never touched by this pass.

3. **Effect.**
   - An excepted unavailable package adds 0 to `gateSeverity`. Its failures
     keep their `severity` and stay in the report.
   - `--strict` is unchanged. The package is still unanalyzed, so strict still
     exits 2.
   - JSON: the unavailable package object gets an optional
     `exception: { reason }`. This is an additive optional field, so the
     schema stays 5.
   - Text and PR comment show `reviewed exception: <reason>` next to the
     package.
   - SARIF results for its failures carry `properties.suppression = reason`
     and the same message suffix as suppressed capability findings. Their
     level is unchanged.

## Alternatives rejected

- **Reuse `allowlist` with a pseudo-capability.** Allowlist matching never
  checks bytes, so a PR could swap `resolved`/`integrity` for its own tarball
  that triggers the same failure kind and inherit the exception.
- **Match per issue, without the all-failures rule.** A package with one
  excepted failure and one new failure would pass the gate.
- **Allow integrity-mismatch exceptions.** PLAN §4.2 treats a mismatch as
  evidence of tampering, so there is nothing to review.

## Consequences

- A legitimately oversized package can be released by an entry reviewed on
  the base branch. Each new version, and each new tarball, needs a new review.
- The config parser grows a second list. It is still a bounded YAML subset
  with no new dependency.
- Revisit if repositories need exceptions for skipped (non-registry) entries;
  those are outside ADR-016 and outside this ADR.
