# ADR-0012: Acorn AST parser with a bounded honesty tier

- **Status:** accepted
- **Date:** 2026-07-28
- **Plan reference:** PLAN §3, §4.3, §5

## Context

M3 must identify JavaScript capabilities without executing package code. Inputs
are attacker-controlled, parsing must be resource-bounded, and the analyzer must
not claim resolution it did not perform. Published npm packages primarily ship
JavaScript; TypeScript source support is not required for v0.1.

## Decision

Use `acorn` plus `acorn-walk` for `.js`, `.mjs`, and `.cjs`. Parsing runs in a
worker that the parent can terminate at a per-file deadline. The resolver accepts
literal ESM/CommonJS imports and one immutable `const` alias hop, including a
member alias. It performs no constant folding: non-literal `require`/`import`, a
second alias hop, and dynamic access to a known API become `UNKNOWN`.

Every syntax error, unsupported TypeScript source, timeout, and file-read failure
is an explicit diagnostic. Package code is never imported or executed.

## Alternatives rejected

- **TypeScript compiler API:** broader syntax support, but materially larger than
  Acorn and unnecessary for the v0.1 published-JavaScript scope.
- **Regex-only detection:** cannot provide scope-aware aliases or distinguish code
  structure reliably.
- **Unbounded in-process parsing:** a synchronous parser cannot be interrupted by
  a promise timeout, violating the attacker-input resource boundary.
- **Deeper dataflow:** creates false confidence; intra-package re-export resolution
  remains a v0.2 concern and general JavaScript dataflow is out of scope.

## Consequences

Two runtime dependencies are added, keeping the project below the PLAN §10
budget. The Action bundle must include the parser worker. Some resolvable-looking
expressions intentionally report `UNKNOWN`; this is an honesty feature rather
than a parser limitation to hide.
