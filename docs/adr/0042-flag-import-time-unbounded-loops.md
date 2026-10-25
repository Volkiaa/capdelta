# ADR-042: Flag an import-time unbounded loop as a MEDIUM signal

- **Status:** Accepted (agent, 2026-10-25, Tier 2 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-25
- **Plan reference:** PLAN §4.3 (signal layer), PLAN §4.4 (severity model), CLAUDE.md "Autonomy"

## Context

The colors 1.4.1 sabotage (2022) adds only a module-scope `for (;;) { console.log(...) }` and keeps its exports unchanged. The capability taxonomy is closed and holds no kind for control flow, `console.*` is not a sink, and the differ reports additions to `(kind, location)` slots only. Every lane stayed empty, so the colors reconstruction produced no finding and the hang was invisible.

An import-time hang is availability sabotage. It is not install-time execution, network access with secrets, obfuscated execution, a registry hook, or dynamic or native code, so none of the shape rules in PLAN §4.4 applies.

## Decision

1. The parser worker records one module-scope loop as `topLevelLoop: { line }` on `ParserSuccess`. A loop matches when all of these hold:
   - its node is `ForStatement`, `WhileStatement` or `DoWhileStatement`;
   - no function node is among its ancestors;
   - its test is absent or constant true (`true`, a nonzero number, a non-empty string, or a negation of a constant false value);
   - no `break` leaves that loop. A `break` inside a nested loop, a `switch`, or a labelled statement other than this loop does not leave it, and a labelled break that names this loop does leave it.
2. The flag travels through `SignalSourceInput` to `SignalFileObservation`. `capability-differ` rejects a line that is not a positive safe integer, so a broken producer fails loudly.
3. `signal-differ` emits `import-time-unbounded-loop` at MEDIUM when the new file carries the flag and the old file did not. The detail names the file and line, and the evidence points at that line. Console output is not required: deleting the print leaves the hang.
4. The kind joins the allowlist and the signal guidance. The JSON report, SARIF and the text reporter derive from the kind and need no other change.
5. Severity is MEDIUM. This is a structural signal like entropy and unparseable growth, not a shape. The default gate threshold stays CRITICAL, so the default run still passes and `--fail-on MEDIUM` fails. This is a Tier 2 change because it only adds a detection. No existing severity, match, allowlist policy, report field or gate is lowered, suppressed or narrowed.

## Evidence (Tier 2 checks)

To be filled by the orchestrator after the held-out run.

## Alternatives rejected

- A new `CodeCapabilityKind`. The taxonomy is closed (PLAN §4.3), and a loop is control flow, not a capability.
- CRITICAL, or a new shape rule. PLAN §4.4 reserves CRITICAL for execution, exfiltration, obfuscation with execution, registry hooks, and dynamic or native code.
- Requiring `console` output. Removing the print would evade the detection while the hang remains.
- Evaluating the loop test as an expression. Constant folding beyond literals needs dataflow, and the fixture shape is `for (;;)`.

## Consequences

The colors reconstruction moves from an all-zero `gateSeverity` to `MEDIUM: 1`, and `--fail-on MEDIUM` fails there. Ordinary packages keep loops inside functions, bound them with a non-literal test, or break out, so they do not match. The residual false-positive risk is a bin or REPL entry that deliberately spins at module scope. MEDIUM keeps it out of the default CRITICAL gate.

To revert, remove the `import-time-unbounded-loop` kind and its emission in `src/core/signal-differ.ts`, the allowlist name and the guidance entry. The parser flag and the observation field can stay unused, or be removed with it.
