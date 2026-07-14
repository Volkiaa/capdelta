# ADR-001: Implement capdelta in TypeScript

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §5

## Context

The core component is a JavaScript parser pipeline: capdelta must statically
analyze whatever npm packages actually contain (ESM, CJS, minified bundles).
The tool also ships as a GitHub Action and a CLI. Go fluency is a separate
personal goal and created real pressure to pick Go.

## Decision

TypeScript, strict mode, targeting Node 20+.

## Alternatives rejected

- **Go** — its JS-parsing story (cgo/tree-sitter bindings or an embedded JS
  engine) concentrates effort exactly in the project's hardest component.
  Deciding factor: finished beats impressive. Go fluency is pursued separately
  via a Stage-1 open-source contribution instead.
- **Plain JavaScript** — this tool parses attacker-controlled input; strict
  typing (`noUncheckedIndexedAccess` in particular) turns "field may be
  missing" from a runtime surprise into a compile error.

## Consequences

- Battle-tested JS parsing available as a library (acorn, or the TS compiler
  API); native node20 Action packaging; one ecosystem for tool, tests, and
  fixtures.
- The parser choice within TS (acorn vs TS compiler API) is deliberately
  deferred: prefer acorn for dependency-budget and speed reasons (PLAN §5,
  §10), record the final pick as an ADR at the M2/M3 boundary.
