# ADR-031: Normalize a hex or octal part in a bare dotted IPv4 host

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4, CLAUDE.md "Autonomy", Tier 2

## Context

The IPv4 row of `IP_LITERAL_ROWS` matches `\b(?:\d{1,3}\.){3}\d{1,3}\b` and
keeps a match only when `net.isIP(value) === 4`
(`src/core/signal-extractor.ts:56-61`). A host that is not a canonical IP
reaches getaddrinfo, which parses it with inet_aton rules. Node passes
`93.0xb8.216.34`, `0135.0270.0330.042` and `93.184.216.034` to that parser, and
each one reaches `93.184.216.34`, `93.184.216.34` and `93.184.216.28`.
`net.isIP` rejects all three, so the extractor reports no endpoint.

The first fix capped every part at four characters. That cap was itself a
bypass: `93.184.216.0000034`, `93.184.216.00000000000000000042`,
`0x0000005d.184.216.34` and `93.184.216.0x00022` all reach an address through
getaddrinfo (`93.184.216.28`, `93.184.216.34`, `93.184.216.34` and
`93.184.216.34`), and the capped pattern matched none of them.

## Decision

1. Add a second IPv4 row with a four-part dotted pattern
   (`src/core/signal-extractor.ts:45-75`). A part is hex (`0x` or `0X`, any
   run of zeros, then at most two significant hex digits whose first is not
   zero), octal (one or more zeros, then at most three significant octal
   digits whose first is `1` to `7`), or decimal (`1` to `9`, then at most two
   more digits). A lone `0` is the octal form. The run of leading zeros has no
   bound, so a part may carry any number of them.
2. The significant digits are capped because a part must fit in one byte: two
   hex digits or three octal digits cover every accepted value. The first
   significant digit is not zero, so the leading-zero run and the significant
   digits cannot consume the same character. Each form also starts with a
   different character, so no part can match the same text two ways and a long
   zero run cannot make the match backtrack past it.
3. Normalize a match to dotted decimal by parsing each part as inet_aton does
   (`src/core/signal-extractor.ts:802-838`). A part that starts with `0x` is
   hex. A part longer than one character that starts with `0` is octal, and a
   digit outside `0` to `7` makes it invalid. The parser reads the whole run of
   leading zeros, so its length does not matter. Every parsed part must be at
   most 255.
4. A match with no hex and no octal part returns null, so the canonical row
   keeps reporting canonical dotted decimal exactly as before.
5. The normalized value goes through the existing `isIP`, `isExternalHost`,
   comment exclusion and context path (`src/core/signal-extractor.ts:282-306`).
   Evidence keeps the match's source line. A bare match keeps context
   `unknown`, so it stays HIGH like a canonical IPv4 literal.

## Alternatives rejected

- Reuse `dns.lookup` to normalize. It can contact a resolver for a non-numeric
  host and it makes the extractor asynchronous, which the byte scan is not.
- Keep the four-digit cap per part. `93.184.216.0000034` is a valid inet_aton
  spelling, so the cap is itself a bypass.
- Spell a part as `0*[0-9a-fA-F]{1,2}`. After a run of zeros, a significant
  digit that is itself zero lets both parts consume it, so alternatives
  overlap and a long zero run makes the match retry each split.
- Match any width of significant digits and range-check later. An unbounded
  digit run lets an attacker make each candidate expensive, and three octal or
  two hex significant digits already cover every accepted value.
- Parse inet_aton semantics inside the URL path too. `new URL` already
  normalizes `http://93.0xb8.216.34/` to `93.184.216.34`, so the URL path needs
  no change.

## Consequences

- A bare host written with a hex or octal part is now reported at the same
  severity as its canonical form, so the evasion no longer hides a new
  endpoint. A URL that holds the same host yields one merged endpoint with the
  canonical value, not two.
- Known limit, out of scope on purpose: a single decimal or hex number
  (`1572395042`, `0x5db8d822`) and two- or three-part forms such as `1.2.3`.
  They would match timestamps, 4-byte hex selectors such as `0xa9059cbb`, and
  version strings, and the ticket does not ask for them.
- A part whose value is over 255 still yields nothing, even when its significant
  digits could be read as a smaller number: `93.184.216.0400` is octal 256 and
  `93.184.216.0x100` is hex 256.
- Revisit if a held-out package shows false positives from version-like or
  timestamp-like runs of four dotted parts.

## Evidence

The orchestrator fills in the verification and corpus evidence.
