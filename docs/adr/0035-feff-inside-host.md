# ADR-035: Treat U+FEFF as part of a URL authority

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external domain in literals), CLAUDE.md "Autonomy", Tier 2

## Context

JavaScript's `\s` matches U+FEFF (ZERO WIDTH NO-BREAK SPACE). `URL_STOP_RE`
and `URL_LITERAL_RE` (`src/core/signal-extractor.ts:28`) stopped the authority
at `\s`, and `valueHasWords` (`src/core/npm/url-value-words.ts:10`) counted
U+FEFF as a word separator. The WHATWG URL parser drops U+FEFF from a host
under UTS-46, so `new URL("https://exfil\uFEFF.example.test/x").hostname` is
`exfil.example.test`. A fetch to that URL was reported as no endpoint: the match
stopped at `https://exfil`, a single label that the domain heuristic drops.
Fixing only the scan would have classified the host as `embedded-text`, which
reports LOW.

Of U+FEFF, U+200B, U+180E, U+2060, U+00AD, U+034F, only U+FEFF matches `/\s/u`
while the URL parser ignores it in a host. A BOM at the start of a file is
already stripped by the decoder, and that stays.

## Decision

`URL_LITERAL_RE` keeps matching as it does on main, so a U+FEFF still ends
its match. When that match ends at U+FEFF, `continueAuthority` walks the text
after it with the same authority stop set, allows U+FEFF, and emits the longer
span as a second observation. The URL parser then drops U+FEFF from the host.
The continuation stops before a U+FEFF that starts another URL scheme, so
`https://a.test\uFEFFhttps://b.test/` keeps `a.test` and still reports
`b.test`. A template element boundary applies to the longer span as it does
to a raw match. `valueHasWords` and the raw-string context check exclude
U+FEFF from the word separators, so a host that contains one keeps `literal`
context. The scans stay linear: the stop cursor is monotonic and each
continuation walks text the next match no longer includes.

## Alternatives rejected

Change only the URL regex so it allows U+FEFF in the authority. Rejected
because a host whose text continues after U+FEFF would then replace the
truncated host main reports instead of adding the longer one.
Change only `URL_LITERAL_RE` and leave `valueHasWords`. Rejected because a
raw U+FEFF would land at LOW `embedded-text`.
Normalize U+FEFF out of the source before matching. Rejected because it moves
every offset after the first U+FEFF, breaking evidence lines, string ranges
and comments.
Remove U+FEFF from `\s` by writing the rest of the class explicitly. The stop
set keeps `\s` because its lexical span must not move. The two word checks use
the complement class `[^\S\uFEFF]`, which states the same rule without
duplicating the list.

## Consequences

A host hidden behind U+FEFF now produces `new-external-endpoint` at HIGH, so
the gate gets louder. The change can add observations and promote a context,
never drop or shorten one. The `feff-host` reconstruction proves the HIGH
finding end to end. A U+FEFF after a complete host still yields the same
hostname, because the parser drops it there too. Revisit if the held-out
corpus shows real packages fetching hosts that contain U+FEFF.

## Provenance (ADR-037)

The spans that `extendedUrlCandidates` emits are additive. Each one walks past
a U+FEFF, which main's rules never do: the extended authority, and the cut span
a template element boundary leaves. The raw match and the cooked delimited
match stay established. When a widened span reaches the same host as one of
those, `buildSignalSet` merges the observations by key and keeps established.

`buildSignalSet` merges an additive observation with an established one for
the same key to established. `diffSignals` then lets an old-side endpoint hide
a new-side one only when the old side ranks at least as high, so an
additive-only old host never hides an established new one.

This branch now only adds findings. For any key main reports as a new endpoint
in a bump, the new side has it as established and the old side has it at most
as additive, so this branch reports it too. A host that both sides reach only
through the widened rule stays suppressed on both sides, so the change adds no
repeated noise.
