# ADR-009: Any non-registry.npmjs.org host is treated as private in v0.1

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §2 (private packages: skip and flag), §4.1

## Context

PLAN §2 decides private-registry packages are skipped and flagged, but does
not define "private". Lockfile `resolved` URLs can point at corporate
registries, GitHub Packages, and public mirrors (npmmirror et al.).

## Decision

v0.1 rule: a resolved URL whose host is not exactly `registry.npmjs.org` is
private → skip and flag with the host named
(src/core/npm/lockfile-differ.ts:332, detail includes the host). Note that
`new URL().host` normalizes default ports, so an explicit `:443` still
matches; a non-default port does not, and is skipped-and-flagged.

## Alternatives rejected

- **Built-in mirror allowlist** — guessing which mirrors are trustworthy is a
  security decision capdelta should not make silently for its users; a
  user-visible skip is honest, and a configurable allowlist can come with
  `.capdelta.yml` (PLAN §4.4) driven by real demand.

## Consequences

- Users on mirrors see "N packages not analyzed" until allowlist config
  exists — loud, not wrong.
- Revisit trigger: first real user report of mirror noise, or the M4
  allowlist work.
