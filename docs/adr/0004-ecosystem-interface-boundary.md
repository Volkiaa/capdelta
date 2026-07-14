# ADR-004: Ecosystem-specific implementations behind an ecosystem-agnostic contract

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §2, §4.1

## Context

v0.1 is npm-only, but the concept (capability delta on a dependency bump)
applies to PyPI, Go, cargo, and others. Hardcoding npm assumptions through the
core would make every future ecosystem a refactor of everything.

## Decision

`LockfileDiffer` and `CapabilityExtractor` are ecosystem-specific
implementations behind a common, ecosystem-agnostic contract. The contract
types are the seam:

- `ChangedPackage[]` — `{ name, oldVersion | null, newVersion,
oldIntegrity | null, newIntegrity, resolvedUrl }` (PLAN §4.1)
- Capability sets — the closed taxonomy plus signal data (PLAN §4.3), which
  the Differ, severity model, and Reporter consume without knowing the
  ecosystem.

Adding PyPI later means adding implementations, not refactoring the core.

Layout note (M0): this is a contract boundary, not a package boundary. The
repo is a single flat package — `src/core/` holds the contract and
implementations; a lint-enforced import restriction (core must not import
cli/action) lands with `src/core/` at M1. Extracting a published library
package later is mechanical if v0.2+ needs one.

## Alternatives rejected

- **npm-hardcoded core, generalize later** — "later" means refactoring the
  Differ/Reporter under pressure; the contract is cheap to state now.
- **npm workspaces monorepo (packages/core|cli|action) at M0** — no external
  consumer of core exists in v0.1; a single package.json keeps the <10
  runtime-dependency gate (PLAN §10) trivial; the node20 Action is bundled
  regardless of layout, so a workspace buys nothing it needs.

## Consequences

- The contract must stay honest: anything npm-specific that leaks into
  `ChangedPackage` or the capability set is a design bug to raise in review.
- Slight ceremony in v0.1 (interfaces with a single implementation) — accepted
  as the price of the seam.
