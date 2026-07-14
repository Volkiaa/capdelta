# ADR-002: Static analysis only — never execute package code

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §2, §3

## Context

capdelta downloads and analyzes tarballs published by an adversary with npm
publish rights (account takeover, malicious maintainer, build-pipeline
compromise). The tool runs inside its users' CI with repository credentials
nearby — it is itself an attack surface.

## Decision

v0.1 analysis is entirely static: manifest inspection, AST parsing, and
lexical signals. Analyzed package code is never executed, imported, or
evaluated — not in the tool, and not in tests (fixtures must be inert).
Tarballs are verified against the lockfile `integrity` hash before any
parsing, and extraction follows safe-extraction rules (no path traversal, no
absolute paths, no symlink escape, size/file-count caps, parse timeouts).

## Alternatives rejected

- **Dynamic (sandbox) analysis** — better signal in principle, but running
  attacker-selected code in users' CI inverts the security proposition, and
  sandbox engineering would dwarf the rest of the project. Roadmap item, not
  v0.1 (PLAN §2).

## Consequences

- Known, documented evasions: dynamic `require(variable)` is reported as
  `UNKNOWN`, never resolved; heavy obfuscation defeats AST analysis and is
  mitigated only by entropy/unparseable-blob signals, which are themselves
  findings (PLAN §3).
- Every unparseable file is a reported datum, never a silent skip — static
  analysis failing loudly is the product behaving correctly.
- Revisit trigger: a v0.2+ sandbox design that runs outside user CI (e.g.,
  hosted analysis) would need a new ADR; "static only" is about where and
  whether code runs, not a permanent verdict on dynamic analysis.
