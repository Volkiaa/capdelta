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
       kind: expanded-size-limit # one post-verification failure kind
       justification: "Ships 80 MB of prebuilt binaries; reviewed upstream release notes and provenance."
   ```

   - **(A) Only post-verification kinds can be excepted.** An exception can
     bind only to bytes that capdelta verified against the lockfile sha512.
     The extraction- and manifest-stage failures meet that bar. Fetch-stage
     failures (`size-limit-exceeded`, `invalid-url`, `unsupported-integrity`,
     `integrity-mismatch`) happen before or without verification, so they can
     never be excepted. `run-severity.ts` exports
     `EXCEPTABLE_UNANALYZABLE_KINDS`, the extraction- and manifest-stage kinds
     ADR-016 classifies as CRITICAL; a test derives it from
     `analysisIssueSeverity` over those stages. The config parser rejects
     every other kind with a contract error that says why: "fetch-stage
     failures occur before the artifact bytes are verified" or "not an
     unanalyzable failure".
   - **(B) Binding.** The entry fields stay the same: `package`, `version`,
     `integrity`, `kind` and `justification`, all required. An entry binds
     exactly those bytes.
   - `version` must be exact semver (`isExactSemver`).
   - `integrity` must be one or more canonical sha512 SRI tokens. Use the same
     check the fetcher applies; reuse it, don't reimplement it.
   - `kind` must be in `EXCEPTABLE_UNANALYZABLE_KINDS`. `unsupported-integrity`
     still means there is no usable sha512 to bind, so it is rejected at parse
     time with the fetch-stage reason; the fix is to correct the lockfile.
   - The same `(package, version, integrity, kind)` tuple may not appear twice.
   - Known cost: a tarball over the _download_ cap (`size-limit-exceeded`) is
     a fetch-stage failure and can no longer be excepted. The README records
     that, and that the CLI and the Action do not expose the fetch cap, so the
     fix is a code change to raise it.

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
   - **(C) The exception must bind the new subject.** A package receives
     `exception: { reason }` only when all of the following hold:
     1. every failure carrying a severity on the package is from the
        extraction or manifest stage, and each one matches an entry on its own
        side's version and integrity;
     2. at least one matched failure is on the **new** side;
     3. no failure is `integrity-mismatch` and no failure is from the fetch
        stage.
   - An old-side-only exception never releases the package, because the new
     artifact was never inspected or bound. `reason = "[version X] " +
justification`, where X is the matched new-side entry's version.
   - If any severity-bearing failure is unmatched, or any failure is a fetch
     failure or an integrity mismatch, the package keeps no exception and
     still gates.
   - Analyzed packages are never touched by this pass.

   To meet rule C.2 the pipeline still extracts the new artifact and reads its
   manifest after an old-side extraction or manifest failure, so the new
   side's failure, if any, is recorded too. The package stays `unavailable`.

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
- **Old-side-only exceptions release unreviewed new versions.** If the old
  artifact's failure is excepted, the new artifact may never be inspected or
  bound, so a PR could swap it for new bytes and inherit the exception. Rule
  C.2 requires a new-side match instead.
- **Fetch-stage failures happen before byte verification.** A download cap,
  an invalid URL, an unsupported integrity, or a mismatch all fail before
  capdelta has verified bytes against the lockfile, so no reviewed sha512
  exists to bind. They are rejected at parse time (amendment A).

## Consequences

- A legitimately oversized package can be released by an entry reviewed on
  the base branch. Each new version, and each new tarball, needs a new review.
- The config parser grows a second list. It is still a bounded YAML subset
  with no new dependency.
- The pipeline now extracts the new artifact after an old-side extraction or
  manifest failure. When the new side extracts and reads cleanly while the old
  side failed, the package stays unavailable with only the old failure: it
  gates and cannot be excepted. Known follow-up: analyze the new side as a new
  package when the old side is unanalyzable.
- A tarball over the _download_ cap (`size-limit-exceeded`) can no longer be
  excepted, because a fetch failure is decided before byte verification. The
  fix is to raise the fetch cap; neither the CLI nor the Action exposes it
  today, so that is a code change.
- Revisit if repositories need exceptions for skipped (non-registry) entries;
  those are outside ADR-016 and outside this ADR.
