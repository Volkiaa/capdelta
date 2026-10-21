# ADR-025: A parser worker that fails to start is a run-level failure

- **Status:** Accepted (agent)
- **Date:** 2026-10-21
- **Plan reference:** PLAN §2 (degrade loudly), CLAUDE.md "Autonomy", Tier 2

## Context

The JavaScript extractor parses each file in a worker thread
(`src/core/npm/javascript-capability-extractor.ts`, `ParserWorkerClient`).
When the worker emits `error`, the client turns it into a failed parse of the
file it was given, which becomes an `unparseable-source` diagnostic. That is
right when package bytes crash the worker. It is wrong when the worker never
started, for example because a built CLI or Action is missing
`javascript-parser-worker.js` or the file does not load. Then every
JavaScript file of every package becomes `unparseable-source`, the run
reports per-file findings that say nothing about the packages, and the real
cause is one line among hundreds.

## Decision

1. **The worker says when it is ready.** After its module loads and it has a
   parent port, the worker posts one `{ type: "ready" }` message before it
   handles any request.
2. **The client sends no request before ready.** Each time the client starts
   a worker, it waits for the ready message, then posts the request.
3. **A worker that fails before ready fails the run.** An `error` or `exit`
   event, or no ready message within the parse timeout, before ready throws
   `JavaScriptCapabilityExtractorConfigurationError` with the cause. The
   pipeline rethrows it, and the CLI and Action exit 1 as for any other
   operational failure (`src/cli/run-cli.ts:114`).
4. **After ready, nothing changes.** A worker that fails while parsing a file
   still turns into an `unparseable-source` diagnostic for that file, and the
   client starts a fresh worker for the next file.

No package bytes reach a worker before its ready message, so package content
cannot cause the run-level failure. An attacker who crashes the worker with a
file still gets the per-file diagnostic, as today.

## Consequences

- A broken build exits 1 with one message that names the worker, instead of
  reporting every file as unparseable.
- Each worker start waits for one extra message. Workers restart only after a
  crash or timeout, so this is one round trip per run in the common case.
- No report field, finding or `gateSeverity` changes when the worker starts.

## Evidence

Filled in by the PR: full verification, `replay compare` of main against the
branch, held-out corpus before and after, Codex review.

## Revert

Revert the PR. The protocol change is internal to the extractor and its
worker.
