# ADR-027: Report a bare IPv6 match glued to other characters at LOW

- **Status:** Accepted (agent, 2026-10-21, under the maintainer's grant to decide the open drafts)
- **Date:** 2026-10-21
- **Plan reference:** PLAN §4.4, ADR-024, CLAUDE.md "Autonomy", Tier 3

## Context

The IPv6 row of `IP_LITERAL_ROWS` (`src/core/signal-extractor.ts:33`) is
`(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}`, gated by `isIP(value) === 6`. Every
match gets context `unknown` (`:206-207`), so a new one is HIGH. On the
2026-10-20 tuning half, markdown-it 15.0.3 gets two HIGH findings,
`c::9bb` and `c::a`, from its minified entity data, where the text reads
`=C::9bb~` (`docs/heldout-2026-10-20/baseline-labels.json:10-22`). Both are
valid IPv6 syntax, so no tighter pattern or `isIP` check can reject them. No
attack reconstruction uses an IP literal.

## Decision

1. **Look at the characters around the whole address.** In a file that
   parsed, when the match lies inside a string literal or template element
   whose raw content holds no backslash, first widen it to the run of hex
   digits, `:` and `.` around it. The pattern can stop inside an address Node
   accepts, as in `"2001:4860:4860::127.0.0.1"`, so the match alone is never
   judged. If that run is not a valid IPv6 address, or a `%` (a zone ID, as in
   `"2001:4860:4860::8888%eth0"`) follows it, the match keeps `unknown`.
   Otherwise the address is "glued" when the character right before it or
   right after it, within that string, is none of: the string's edge,
   whitespace, `,`, `;`, `[`, `]`, `(`, `)`, `/`, `@`, `"`, `'`, `=`, `&`,
   `?`, `#`, `|`, `<`, `>`. The last seven bound values in key-value and
   query strings. A template element ends at `${`, so an address next to an
   expression has the element's edge on that side and keeps `unknown`.
2. **A glued match is `embedded-text`.** Every other bare IPv6 match keeps
   `unknown`: outside any string, in a string with a backslash, in a file that
   did not parse, or with separators on both sides.
3. **Severity and wording.** The ADR-024 rules apply unchanged. Strongest
   context wins per host, and a new host whose every occurrence is
   `embedded-text` is LOW. For `ipv6`, the detail says "(inside a longer
   string)" instead of "(mentioned in text)".
4. **URLs and IPv4 do not change.** A bracketed host in a URL goes through the
   URL path. The IPv4 row has no recorded false positive.

## Risks

- An address glued into a longer string and cut out at runtime, as in
  `"x2001:db8::1".slice(1)`, drops to LOW. ADR-024 accepts the same risk for
  URLs split out of prose. Concatenated address pieces were never detected.
- A list such as `"2001:db8::1,2001:db8::2"` keeps HIGH, because `,` is a
  separator.
- A string with any backslash keeps HIGH, so an escape can't lower a match
  (the lesson of ADR-024's first two attempts).

## Evidence

- Full verification passes (824 tests). No golden fixture or attack
  reconstruction changed.
- `replay compare` of main against this branch: MATCH on all 20 drives.
- Held-out corpus, both halves. 89 of 90 pair reports are unchanged. The only
  change is markdown-it 15.0.2 -> 15.0.3, where `c::9bb` and `c::a` go from
  HIGH to LOW "(inside a longer string)". Both are labelled noise. That
  pair's `gateSeverity` goes from HIGH 2 to LOW 2.
- Codex security review, three rounds. Round 1 blocked because a zone ID
  (`"2001:4860:4860::8888%eth0"`) counted as glued text. Round 2 blocked
  because the pattern stops at `::127` in `"2001:4860:4860::127.0.0.1"`, so
  the `.` counted as glued. Both came from judging the regex match instead
  of the whole address, which decision 1 now does. Round 3: APPROVE.

## Why it was accepted

The lowering opens no evasion that is not already free. To use a glued
address, the code must cut it out of its string at runtime. Splitting the
address across two strings costs an attacker the same effort and was never
detected at all, because neither half is a valid address. A glued match
still reports, at LOW. The alternative, an allowlist entry for markdown-it,
would leave every other package with minified tables to the same noise.

## How to revert

Return `"unknown"` for every IP row in `detectEndpoints` and delete
`ipv6ContextAt` and `ipv6GluedContext`. The "(inside a longer string)" wording
in `signal-differ.ts` then never fires and can go too.
