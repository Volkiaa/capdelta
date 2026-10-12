# ADR-018: Fetch failures fail the run instead of passing it

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §2 (degrade loudly), §4.2, §4.6; ADR-016, ADR-017

## Context

ADR-016 left `http-status`, `invalid-response`, `timeout`, and
`network-error` at severity `null`, so they only fail with `--strict`
(`src/core/run-severity.ts`). Codex's review of #48 showed this is fail-open.
A PR can point a package's `resolved` URL at a registry path that does not
exist. The fetch then returns HTTP 404, the package is reported as unavailable,
and the default gate passes (`src/core/npm/fetcher.ts:300-307`). A transient
registry outage passes silently in the same way. The fetcher never retries.

## Decision

1. **Bounded retries in `fetchArtifact`.** Up to 3 attempts in total, with
   backoff of 250 ms and then 1 s. The sleep is injectable so tests stay
   instant.
   - Retried: `network-error`, `timeout`, and HTTP 408, 429, and 5xx.
   - Not retried: other 4xx, `invalid-response`, `aborted` (deadline or
     cancellation), size limits, and integrity mismatches.
   - Every attempt honors the run's abort signal and deadline.
2. **Status classes split into kinds.** `http-status` now means a
   non-retryable HTTP status. A new kind, `http-unavailable`, records a
   retryable status that persisted after the last attempt. The detail text
   keeps the numeric status. The kind is additive, so the report schema stays
   at 5; consumers must treat kinds as an open set.
3. **Severity (`analysisIssueSeverity`):**
   - `http-status` and `invalid-response` become CRITICAL and unanalyzable.
     The lockfile entry or the registry decides them deterministically.
   - Both happen at the fetch stage, so ADR-017 exceptions can never release
     them.
   - `timeout`, `network-error`, and `http-unavailable` stay `null`; they are
     not severities.
4. **Operational failure for exhausted transient errors and incomplete runs.**
   After the report has been delivered, the run is an operational failure if
   any package is unavailable for one of these reasons:
   - a `timeout`, `network-error`, or `http-unavailable` failure after the
     final attempt;
   - an `aborted`, `deadline-exceeded`, or `analysis-aborted` stop at any
     stage, whether it came from the run deadline or from caller cancellation.

   Why stops are included (Codex review): a URL selected by the PR that
   stalls until the whole-run deadline surfaces as an abort or deadline stop,
   not as `timeout`. Leaving stops out would let that stall through, along
   with every package the deadline left unanalyzed. The pipeline must keep
   the stop reason through its stop conversion, so a transient failure
   followed by an abort during backoff still counts.
   - **CLI:** prints `capdelta: N package(s) could not be fetched or analyzed
before the run ended` to stderr and exits 1.
   - **Action:** fails the job with the same message.
   - **Exit-code precedence:** `--strict` exit 2 first, then exit 1 for the
     gate or an operational failure.
   - **Report-only mode:** with `--fail-on none`, an operational failure still
     exits 1. Report-only skips the severity gate, not the incompleteness of
     the analysis.
   - **Shared predicate:** `hasOperationalFailure(run)` lives in
     `run-severity.ts`, and both entry points use it. Each package counts
     once, however many sides or attempts failed.

5. **Retry bounds.** Retries never extend the run past its deadline.
   - The run abort signal, which fires at the run deadline, ends any in-flight attempt; an attempt never outlives the deadline even if its own timeout is longer (Codex review: acceptable because the production fetch honors abort).
   - Backoff sleeps can be aborted.
   - A failed response body is cancelled before the next attempt.
   - The run's abort signal bounds the whole artifact operation, every attempt
     included.
6. **Exhaustive classification.** `run-severity.ts` classifies the new kinds
   exhaustively. ADR-017 rejects them as exception kinds, because they happen
   at the fetch stage.
7. **Unchanged:** skipped non-registry entries. PLAN §2's "analyzed X of Y"
   report stays, but a run that stops early now fails with exit 1 instead of
   passing.

**Required regressions:**

- a stalled response that runs into the run deadline;
- a network failure followed by an abort during backoff;
- the deadline expiring before the final attempt;
- CLI and Action runs with both a gate failure and an operational failure;
- `--strict` precedence;
- `--fail-on none`.

## Alternatives rejected

- **Make every fetch failure CRITICAL.** A registry outage would read as
  "review this package" and train people to ignore CRITICAL.
- **Keep transient failures as `--strict` only.** That keeps the default gate
  fail-open whenever the network fails.
- **Retry 4xx.** A 404 is deterministic; retrying it only adds latency.

## Consequences

- A tampered `resolved` URL now fails the default gate.
- A real registry outage now fails CI, with exit 1 and a clear message,
  instead of passing.
- An old version that was unpublished from the registry (old-side 404) now
  gates as CRITICAL. That is rare and deliberate, since the new side cannot be
  diffed.
- Runs get slower when a registry is flaky. Each artifact can add up to about
  1.25 s of backoff plus three per-attempt timeouts, always within the run
  deadline.
- A run that exceeds its analysis budget now fails with exit 1. This amends
  PLAN §2: the run still degrades loudly, but now fails instead of passing.
- Revisit this ADR if registry flakiness causes repeated operational failures
  in real CI.
