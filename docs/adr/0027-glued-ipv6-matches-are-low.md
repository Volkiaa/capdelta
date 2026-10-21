# ADR-027: Report a bare IPv6 match glued to other characters at LOW

- **Status:** Proposed
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

1. **Look at the characters around a bare IPv6 match inside a string.** In a
   file that parsed, when the match lies inside a string literal or template
   element whose raw content holds no backslash, the match is "glued" when the
   character right before it or right after it, within that string, is none
   of: the string's edge, whitespace, `,`, `;`, `[`, `]`, `(`, `)`, `/`, `@`,
   `"`, `'`.
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

Filled in by the PR: tests, held-out corpus before and after with every
changed finding listed.
