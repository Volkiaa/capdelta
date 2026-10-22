# ADR-037: An endpoint seen only by a widened rule never hides an established finding

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4, CLAUDE.md "Autonomy"

## Context

`diffSignals` reports a new endpoint when its `[endpointType,
normalizedValue]` key is absent from the old version's endpoints
(`src/core/signal-differ.ts:35-55`). Both versions go through the same
extractor. So a rule that finds more endpoints also finds more of them in the
old version. When it finds a host there that the code never reaches at
runtime, the new version's real use of that host stops counting as new.
main reported that bump. The widened branch reports nothing.

Codex security review blocked four widening branches on this one pattern
during the 2026-10-21/22 run: F1 rounds 2 and 3 (scheme forms), F5 (U+FEFF
in a host) and F7 (escaped endpoints in unparseable files). Each fix narrowed
the widened rule to avoid one spurious old-side host, and the next review found
another. The single-version drop check (`.scratch/evasion/dropfuzz.ts`) cannot
see this, because nothing is dropped from either version on its own.

It is also why widenings land as Tier 3 under CLAUDE.md "Autonomy". A
widening can lower the findings of a bump, and passing the reconstructions
cannot show that it opens no new evasion.

## Decision

1. `SignalEndpointObservation` gets a required field `provenance:
"established" | "additive"`. Every rule on main today produces
   `"established"`. A future rule that widens what the extractor matches
   produces `"additive"` for observations that main's rules would not make.
2. `buildSignalSet` merges a key's observations to `"established"` when any of
   them is established, otherwise `"additive"`.
3. `diffSignals` ranks `established` above `additive`. An old-side endpoint
   suppresses a new-side endpoint with the same key only when the old side's
   provenance ranks at least as high as the new side's. An additive-only old
   host never hides an established new one.

## Consequences

- With this change alone, every observation is established, so every report,
  golden fixture and reconstruction is unchanged. This is a Tier 1 change.
- For a later widening whose established observations equal main's on every
  input, the findings of any bump are a superset of main's findings.
  For a key main reports as new, the new side has it as established and the
  old side has it at most as additive, so the head reports it too. Such a
  widening then only adds findings, which is Tier 2 by construction.
- Noise is unchanged for additive-only hosts. Old additive suppresses new
  additive, so a package that keeps a host in a widened form across a bump
  gets no repeated finding.
- Rules already merged before this ADR (ADR-029, ADR-030, ADR-031) stay
  established. Retagging them is a separate decision.
- The field is part of the exported `SignalSet` type (`src/index.ts`). Code
  that builds a `SignalSet` by hand must set it.

## Revert

Revert the commit. The differ goes back to suppressing on key alone.
