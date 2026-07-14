# ADR-010: Preflight npm tarballs and reject all link entries

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §3 (safe extraction), §4.2

## Context

Downloaded tarballs are attacker-controlled input. PLAN §3 requires safe
extraction: reject traversal, absolute paths, and symlink escapes, enforce
resource limits, and never execute package code. The extractor must not write
archive-controlled paths before it has established that the archive is safe.

## Decision

Use the maintained `tar` library to parse npm tarballs. Write the already SRI-
verified bytes only as an opaque archive in a fresh private work directory;
run a strict listing preflight, then extract only after that succeeds.

Require every entry to be under the npm `package/` root. Reject every symbolic
and hard link (including an apparently internal link), all unsupported entry
types, and unsafe paths. Extract with strict parsing and without preserving
archive ownership, modes, or timestamps.

## Alternatives rejected

- **Custom tar parser** — unnecessarily reimplements a hostile-input parser
  when a mature maintained parser is available.
- **Extract then inspect** — writes archive-controlled filesystem paths before
  policy validation, violating the preflight safety boundary.
- **Allow internal links** — requires subtle link-target validation and offers
  no M1 capability-analysis benefit.

## Consequences

- `tar` is the first direct runtime dependency (`package.json:29-31`),
  explicitly approved because it is a hardened parser for attacker-controlled
  npm archives.
- Packages containing any link are rejected and reported rather than analyzed;
  this is intentionally loud and conservative.
- Revisit if real npm packages require link semantics for manifest analysis, or
  when the tool gains a separately reviewed link policy.
