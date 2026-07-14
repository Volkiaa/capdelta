# ADR-003: Analyze all changed packages — direct and transitive

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §2, §3

## Context

A lockfile bump changes resolved versions for direct and transitive
dependencies alike. The laundering attack shape: the bumped package adds no
suspicious code itself — it adds (or bumps) a dependency that carries the
capabilities. Analyzing only direct dependencies misses exactly the packages
attackers hide behind.

## Decision

Analyze every package whose resolved version changed in the lockfile, direct
and transitive, under concurrency caps (defaults: 8 concurrent fetches, 4
concurrent extractions, ~5 min wall-clock budget). Newly added packages get a
full capability report. If the budget is exceeded, degrade loudly: report
"analyzed X of Y changed packages," prioritized by install-scripts-first, then
smallest-download-first, then lockfile order.

## Alternatives rejected

- **Direct dependencies only** — misses capability laundering, the attack
  class transitive analysis exists to catch (PLAN §3).
- **`--deep` opt-in flag** — makes the secure behavior non-default; users who
  most need transitive coverage are the least likely to know to enable it.

## Consequences

- Big framework bumps can hit the wall-clock budget; partial analysis is
  acceptable only because it is loudly reported (and `--strict` lets teams
  fail CI on it, PLAN §4.5).
- Fetch/extract must be cache-friendly (keyed by integrity hash) to keep
  repeat runs cheap.
