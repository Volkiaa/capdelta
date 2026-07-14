# ADR-005: Shape-based severity, adopted from capdiff prior art

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §4.4 (prior art: telcharr/capdiff, cargo)

## Context

Single capabilities are weak signals: `NET` added to an HTTP client is
routine; `NET` added to install-script code is the attack itself. capdiff
(the cargo-ecosystem capability-diff tool, studied as prior art and credited)
field-tested the idea that severity should come from capability
_combinations_ and _context_, not individual capabilities.

## Decision

Severity is assigned by shape rules first, evaluated against the gained
capability set (full set for new packages); per-capability fallback applies
only when no shape matches. CRITICAL shapes (PLAN §4.4): any of
`NET`/`PROCESS`/`ENV`/`FS_SENSITIVE` located in install-script code;
`NET` + (`ENV` or `FS_SENSITIVE`) in the same package (exfiltration shape);
obfuscation signal + (`PROCESS` or `DYNAMIC_CODE`) (smuggled-loader shape);
install script added or changed; `DYNAMIC_CODE` or `NATIVE` added.

Every finding carries evidence — `file:line` plus a short escaped/truncated
snippet (also adopted from capdiff). A finding without evidence is an
assertion.

## Alternatives rejected

- **Flat per-capability severity** — either drowns reviewers in HIGHs
  (`NET` alone is everywhere) or under-rates the deadly combinations;
  capdiff's field experience says shapes carry the signal.

## Consequences

- The extractor must record location context (install-script code vs runtime
  code) for every capability — a requirement on M1/M3 design, not a
  reporting afterthought (PLAN §4.3).
- The mapping is provisional judgment plus capdiff's field-tested shapes until
  the corpus validation (PLAN §7.4) measures it; post-M3 FP data is the
  revisit trigger.
