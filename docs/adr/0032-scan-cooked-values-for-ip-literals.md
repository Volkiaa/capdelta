# ADR-032: Scan the cooked value of escaped strings for bare IP literals

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external endpoint in literals), ADR-026, ADR-027, CLAUDE.md "Autonomy", Tier 3

## Context

ADR-026 scans the runtime value of a string whose raw content holds a
backslash, a tab, a CR or an LF, but only with `URL_LITERAL_RE`. The
`IP_LITERAL_ROWS` loop in `src/core/signal-extractor.ts` scans the raw source
only. An escape in a bare IP host therefore hides the address from the raw
scan:

- `net.connect(443, "93.184.216\x2e34")` runs with `93.184.216.34`.
- `net.connect(443, "2606\x3a4700\x3a\x3a1111")` runs with
  `2606:4700::1111`.

The unescaped string gives a HIGH new external IP finding today, so the escaped
form is a free evasion.

## Decision

1. **Run the shared IP rows over each cooked value.** Extract the row loop
   from `detectEndpoints` into `ipLiteralEndpoints` and call it for the raw
   source and for every cooked string. Both calls apply the same `isIP` family
   check, `isExternalHost` check and lowercasing for IPv6.
2. **Report a cooked match at the string's start offset.** The evidence line
   and snippet are the string's, as ADR-026 already does for cooked URLs.
3. **Compute ADR-027 on the cooked text.** A cooked IPv6 match is
   `embedded-text` when the cooked value shows a glued address, and `unknown`
   otherwise. The raw rule stays as it is: a raw string with a backslash keeps
   `unknown`, so an escape never lowers a raw match.
4. **Let the existing aggregation merge raw and cooked observations.** A host
   found by both scans stays one endpoint, and the strongest context wins.
5. **Skip the comment check for cooked values.** A cooked value comes from a
   string literal or template element, never from a comment.
6. **Append matches to one accumulator, one at a time.** A spread call
   (`found.push(...matches)`) exceeds Node's argument limit on a valid file
   with enough matches and throws `RangeError`, which suppresses every
   observation from that file. Passing the caller's array into
   `ipLiteralEndpoints` keeps the scan linear and bounded by memory, not by
   the engine's argument count.

The work stays linear. `cookedLookup` rejects a cooked value longer than its
raw range, so the cooked scans read at most one source length in total. The
glue scan around a match is bounded by `MAX_IPV6_ADDRESS_LENGTH`.

## Alternatives rejected

- **Copy the row loop into the cooked scan.** Two copies of the family,
  external-host and lowercasing rules drift apart, and one can lose a check
  without the other.
- **Scan only the new side.** That never drops a finding, so it would be Tier
  2, but every escaped address on an unchanged line would look new. ADR-026
  already rejected the same split for URLs.
- **Strip tab, LF and CR before the IP scan, as the URL scan does.** The WHATWG
  URL parser removes those characters, but `net.connect` and `isIP` do not, so
  a value split by one is not an address at runtime.

## Consequences

- An escaped public address now reports at HIGH, and the `escaped-ip`
  reconstruction proves it. An escaped private or link-local address still
  reports nothing because `isExternalHost` rejects it.
- A string that holds both the raw address and an escape still gives one
  endpoint with one evidence line.
- An IPv6 address glued to other text after cooking reports at LOW, matching
  ADR-027's rule for unescaped strings.
- Both sides scan cooked values, so an address that only the old version held
  in escaped form stops counting as new. That is the same dropped-finding
  trade ADR-026 makes, and it is why this ADR is Tier 3.
- Revisit if a package shows noise from addresses assembled by escapes in
  minified tables. The row pattern and `isExternalHost` would then need
  narrowing, not this scan.

## Evidence

- Runtime: `net.isIP("93.184.216\x2e34")` is 4 and
  `net.isIP("2606\x3a4700\x3a\x3a1111")` is 6; each cooked value is the
  whole host passed to `net.connect`.
- Reconstruction `escaped-ip`: with `src/core` at main the bump gets no
  finding; on this branch it gets HIGH `new external ipv4 93.184.216.34`.
- `npm run difffuzz -- --base origin/main` (cooked values since #160): 184
  of 500000, and 10 with `--narrow`. `.scratch/evasion/dropfuzz.ts`
  classifies all 194 as additions with 0 drops on the new side; the same
  tool flags 122 drops with base and head swapped, so it does detect drops.
- Held-out corpus (45 pairs): 0 default-gate failures, no finding beyond
  main's.
- CLI replay (20 drives): byte-identical to `run5-main154`.
- Codex security review: BLOCK on round 1 (stack overflow from an argument
  spread of a 130000-address match list), APPROVE on rounds 2 and 3 (round 3
  covers the merge with ADR-031's normalize step).

## How to revert

Revert the squash commit. The raw scan returns to its own row loop; remove
the `escaped-ip` reconstruction and its test with it.
