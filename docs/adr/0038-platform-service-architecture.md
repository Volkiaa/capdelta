# ADR-038: Build the v2 platform as a dependency-free service beside the CLI

- **Status:** Accepted (agent, 2026-10-24, under the maintainer's v2 grant: "full autonomy", phases 1 to 3 of `docs/v2-roadmap.md`)
- **Date:** 2026-10-24
- **Plan reference:** PLAN §2 (degrade loudly), §3 (safe extraction), §10 (dependency budget), CLAUDE.md "Autonomy"

## Context

`docs/v2-roadmap.md` asks for a service that watches the npm registry,
analyzes each new release without a lockfile, stores the evidence, serves it
over an API (phase 1), then publishes reviewed findings as a feed that the CLI
and Action consume (phase 3). The engine already analyzes one old and new
tarball pair: `analyzeChangedPackages` takes a `ChangedPackage`
(`src/core/contract/lockfile-diff.ts:12-24`) and `buildRunReport` renders the
result (`src/core/report-builder.ts:47`). A `ChangedPackage` with
`oldVersion: null` already yields a full capability report
(`src/core/contract/lockfile-diff.ts:15`).

Constraints: fewer than 10 runtime dependencies (PLAN §10), the safe
extraction and fetch rules stay untouched, and the CLI and Action must keep
working without the service.

## Decision

1. **New tree `src/platform/`.** It imports from `src/core/` and nothing in
   `src/core/` imports it. The CLI and Action keep their current code paths.
2. **No new runtime dependency.** HTTP uses `node:http`, storage uses files,
   hashing uses `node:crypto`.
3. **Artifact identity.** An artifact is `{ecosystem, name, version,
digest}`, where `digest` is the registry's sha512 integrity string after
   the fetcher verified the bytes. The record key is `digest` plus
   `analyzerVersion`. Ecosystem is a field from day one (`"npm"` only now), so
   another ecosystem adds an implementation and no schema change.
4. **`analyzeArtifact` and `analyzeRelease` wrap the existing pipeline.**
   `analyzeArtifact` runs `analyzeChangedPackages` with `oldVersion: null` and
   stores the capability snapshot. `analyzeRelease` runs it with the previous
   version and stores the diff report. Neither changes `src/core/`, so no
   `gateSeverity` moves. `diffCapabilities` stays as is.
5. **Store.** A `Store` interface with one file implementation. Records are
   JSON files under `<root>/<kind>/<key>.json`, written to a temp file and
   renamed, so a crash leaves either the old or the new record. Reads
   validate the shape and fail loudly on a corrupt file. A record that exists
   for the same key is returned and never recomputed (idempotency).
6. **Queue.** A persisted job file per `(name, version)` with states
   `pending`, `running`, `done`, `failed`. A job left `running` after a crash
   returns to `pending` at startup. A transient failure retries with a bound,
   then becomes `failed` and stays visible through the API. An incomplete
   analysis is stored as an incomplete record, never as a clean one (PLAN §2).
7. **Collector.** It reads the registry change feed and each packument over an
   injected `fetch`. Only the configured registry host is contacted, and the
   tarball URL must belong to it. The collector never executes package code.
   A cursor file makes restarts resume.
8. **API.** Read-only `GET` routes on `node:http`, bound to `127.0.0.1` by
   default. Every value that came from a package or the registry passes
   through `truncate` and the `MAX_*` limits before it is stored or served.
   Write routes (phase 3) require a bearer token and are off without one.
9. **Phase 3 intelligence model (ADR-039)** keeps severity, confidence and
   verdict as three fields. Only a validation record signed by a reviewer
   identity can set verdict `confirmed-malicious`. The analyzer can set at
   most `suspected`.
10. **Consumers fail open on outage and closed on a confirmed verdict.** The
    CLI and Action read the feed with a timeout. An unreachable feed prints a
    loud warning and the local analysis decides. A confirmed-malicious match
    adds a CRITICAL finding, so the change only makes the gate stricter
    (CLAUDE.md Tier 2).

## Alternatives rejected

- SQLite through `node:sqlite`. It is experimental on Node 22 and prints a
  warning. Files meet the volume of a self-hosted MVP and need no dependency.
- Extending `ChangedPackage` and the pipeline for single artifacts. A one-sided
  `ChangedPackage` already exists, so a new pipeline would duplicate the safe
  path.
- An HTTP framework. `node:http` covers a handful of read routes.
- Reading the registry from the CLI's lockfile path. The collector has no
  lockfile.

## Consequences

Phase 1 and 3 ship without touching the gate except through ADR-039's
stricter-only feed match. The file store does not scale past one host. The
`Store` interface is the swap point. Revisit this ADR if record count passes
what a directory listing handles. To revert, delete `src/platform/` and the
platform entry in `package.json`. Nothing in `src/core/` depends on it.
