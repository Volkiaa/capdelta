# ADR-023: Analyze the new version as newly added when only the old version is unanalyzable

- **Status:** accepted
- **Date:** 2026-10-20
- **Plan reference:** PLAN §1 and §4 (a newly added package gets a full capability report), §2 (degrade loudly), §4.6 (`--strict`)

## Context

ADR-016 makes an extraction or manifest failure CRITICAL on either side
(ADR-016 §2, "Both sides count"). ADR-017 lets a reviewed exception release
such a package only when a matched failure is on the new side (rule C.2).

So when the old version fails extraction or the manifest read and the new
version reads cleanly, the package stays `unavailable` with only the old
failure. It gates CRITICAL, and no exception can release it. A repository
whose installed version of a package ships, for example, a link entry is
blocked on every later bump of that package. ADR-017 names this follow-up in
its consequences. The pipeline already extracts and reads the new side on this
path and then drops the result.

## Decision

1. **Scope.** The old side has at least one failure from the extraction or
   manifest stage, the old side has no fetch-stage failure, and the new side
   extracts and reads its manifest with no failure.
   Every old failure must be unanalyzable in the ADR-016 sense. If any old
   failure is operational (ADR-018, ADR-019: `filesystem-error`,
   `deadline-exceeded`, `analysis-aborted`, `manifest-unreadable`), the
   package stays `unavailable`, so the run still fails with exit 1.
2. **Analyze as newly added.** The package becomes `analyzed` with
   `diff = diffCapabilities(null, newSet)`, the same path a newly added
   package takes. Every capability of the new version is reported as added
   and gates at its normal severity. A registry install hook or an attack
   shape is still CRITICAL.
3. **Keep the old failures as `baselineFailures`.**
   - The analyzed package in the JSON report gets
     `baselineFailures: JsonReportAnalysisIssue[]`. It is `[]` unless the old
     side failed. This is an additive field, so the schema version stays.
   - Each baseline failure keeps its own `severity` and counts in the
     analysis-issue totals. None of them adds to `summary.gateSeverity`.
   - `validateRun` checks
     `diff.newPackage === (oldVersion === null || baselineFailures.length > 0)`,
     and rejects a package with `oldVersion === null` and a baseline failure.
4. **Rendering.** Text and PR-comment output print one line per baseline
   failure: "Old version could not be analyzed (<kind>); every capability of
   the new version is reported as added." SARIF emits one `note`-level result
   per baseline failure with the same message, because it never gates.
   Attacker-controlled strings keep the existing `truncate` and `MAX_*` bounds.
5. **`--strict` still exits 2.** The old version was not analyzed, and strict
   mode promises that everything was.
6. **Unchanged.**
   - An old-side fetch failure stays as ADR-018 decides. The new side is never
     fetched after it, so there is nothing to analyze.
   - When both sides fail, the package stays `unavailable`, and ADR-017
     exceptions apply as before.
   - ADR-017 exceptions still apply only to unavailable packages.

This amends ADR-016 §2 for this one case and replaces the follow-up named in
ADR-017's consequences.

## Why the gate may drop here

The old version is only a baseline. It hides capabilities the package already
had. Without it, capdelta reports every capability of the new version, which
is a superset of what a diff would report. Nothing the new version adds can
hide. The attacker controls the new version, not the version already
installed on the base branch, so an old-side failure gives them nothing to
hide behind (PLAN §3 threat model).

## Alternatives rejected

- **Keep the block and let a reviewed old-side-only exception release the
  package once the new side is analyzed.** Every bump of the package would
  still need a human review of the old version, which is the cost this ADR
  removes.
- **Count the baseline failure at MEDIUM.** It would fail only stricter gates,
  but it describes the version already installed, not the change under
  review. `--strict` already covers users who want any unanalyzed content to
  fail.
- **Drop the old failures from the report.** That hides a fact the reviewer
  should see, against PLAN §2.

## Consequences

- The default gate passes a package whose old version is unanalyzable when its
  full new-version report has no finding at the threshold. Before, it failed.
  This is the only case where `gateSeverity` drops.
- The report for such a package is noisier, because capabilities the old
  version already had show up as added.
- The `manifest-directory` reconstruction and the pipeline tests for this path
  change their expectations on purpose.
- Revisit if an old-side failure kind appears that says something about the
  new version, for example a failure caused by the lockfile entry rather than
  the old bytes.
