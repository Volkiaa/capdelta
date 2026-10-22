# ADR-034: Find the host after userinfo stop characters

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external domain: HIGH), §2 (degrade loudly)

## Context

`URL_LITERAL_RE` and `URL_STOP_RE` (`src/core/signal-extractor.ts`) stop the
authority at whitespace, `"`, `'`, backtick, `<`, `>` and `\`. The WHATWG URL
parser accepts those characters in userinfo and percent-encodes them. It ends
the authority only at `/`, `?`, `#` or `\`, and the host is the part after the
authority's last `@`.

So `fetch("https://cdn example@exfil.example.test/c")` currently matches only
`https://cdn`. The single-label host `cdn` is not reported, and a package that
already calls `fetch` can switch destination with no finding. The same gap
covers a quote, backtick, `<` and `>`, whether written literally or through an
escape in a parsed string's cooked value.

ADR-024 also classifies a string as `embedded-text` whenever its runtime value
holds whitespace. For a URL whose whitespace is userinfo, that would demote the
finding to LOW even though the whole string is one URL.

## Decision

For a URL match that starts at the first content offset of a parsed string
literal or template element, take the string's runtime value (the cooked value
when the parser supplies one, otherwise the raw content). When that value,
trimmed, is one URL the WHATWG parser accepts and its userinfo holds one of
whitespace, `"`, `'`, backtick, `<` or `>`, also report the host the parser
returns. Keep the existing truncated observation, so no host or context is
removed. The added observation uses the match's evidence and `urlEndpoint`.
The same rule applies to the cooked-value scan, where the runtime value is
already available.

A string whose whole value is such a URL is `literal`, even though its value
holds whitespace. A string that holds prose, a path or a query with whitespace
keeps today's context, because `new URL` rejects the prose or the whitespace is
outside userinfo.

Files the parser cannot read keep today's byte scan. Without string boundaries
and cooked values, a whitespace before an `@` cannot be told apart from prose.

## Alternatives rejected

- **Extend the authority scan to every stop character inside any parsed
  string.** A prose string such as `"see https://a.test now b@c.test"` would
  report `c.test`, which the runtime fetch rejects, and a path or query could
  swallow a second URL. Requiring the whole runtime value to be one accepted
  URL limits the extension to the case where the parser's host is the host a
  fetch uses.
- **Apply the change to the unparseable-file byte scan.** That scan has no
  string ranges or cooked values, so it cannot distinguish a userinfo space
  from a sentence boundary.
- **Replace the truncated match instead of adding to it.** It would remove an
  existing finding when the userinfo's local part itself looks like a public
  domain. Adding the parser host keeps every existing result and raises the
  context at most.
- **Lower the context to `embedded-text` and keep only severity LOW.** The
  destination is the whole string's URL, so the attacker gains a HIGH endpoint
  finding by adding a space, not by hiding the URL in prose.

## Consequences

- A package that changes only the userinfo and host of an existing fetch now
  reports a HIGH `new-external-endpoint` for the new host.
- The whole-string check costs one `new URL` per string range that holds a URL
  and has a stop character in userinfo. Each range is parsed once and the scan
  stays linear in the source length.
- A string with an escaped userinfo space, such as
  `"https://a\x20b@exfil.example.test"`, is covered when the parser supplies
  the cooked value.
- Known gap: a URL assembled at run time (`"https://" + user + "@" + host`)
  still produces no endpoint, as ADR-024 records for other assembled forms.
- The cooked scan keeps its own truncated observation as well. A string such as
  `"h\u0074tps://a.test b@evil.test/x"` reports `a.test` and `evil.test`; an
  implementation that replaced the first with the second would silently drop a
  host the raw-value scan never sees.
- Revisit if a reconstruction or a real attack hides the host behind a
  character outside this set, or if the endpoint detector starts resolving
  assembled URLs.

## Round 3 amendment

Remove ASCII tab, LF and CR from the runtime value before checking its initial
scheme and userinfo. The WHATWG parser ignores these characters throughout
its input. A scheme such as `h\nttps` therefore still has a runtime destination.
The existing cooked scan uses the same removal, so retain its observations
and add only the host of the whole runtime value.

Append cooked observations one at a time. Passing an input-sized array as
function arguments exceeds the engine's argument limit on large strings.
The regression tests cover 130,000 repeated URLs and all three ignored
characters. The `userinfo-ignored-scheme` reconstruction proves the LF case
through the package analysis pipeline with inert fixture code.

The edge normalization removes only ASCII C0 controls and space, as the URL
parser does. JavaScript `trim` also removes Unicode whitespace such as NBSP
and U+2028. Removing those can turn an invalid hostname into a valid one and
create an old-side endpoint that hides a real new-side finding. Negative
regressions preserve these characters and retain the observations from main.

## Round 4 amendment

Match HTTP, HTTPS, WS and WSS schemes without regard to ASCII case in both
URL discovery and the whole-value userinfo check. The URL parser accepts
`HTTPS://a.test b@evil.test/x` and mixed-case variants with `evil.test` as
the destination. Raw and cooked regressions require the runtime host at literal context.
The added pass does not report `a.test`, which is userinfo, not the runtime
host. Main reports no host for these uppercase schemes.

Keep the original lowercase scan as an independent pass. The added pass
handles only matches whose scheme contains uppercase letters and adds only
the host of an accepted whole-value userinfo URL. Otherwise an
uppercase URL could consume a lowercase URL in its path that main reports.
The two passes retain the original scan's cursors and string boundaries.

## Provenance (ADR-037)

Every observation this branch's widened rule or added scan produces is tagged
`provenance: "additive"`. That covers the host after a stop character in a
parsed string's userinfo, the host the case-insensitive scheme pass adds, and
the `literal` copy of an established host when the whole-value URL check
promotes its context.

The original lowercase raw scan, the cooked-value scan and the IP literal rows
produce `"established"` observations with main's value, confidence and
context. `diffSignals` ranks established above additive, so an old version that
reports a host only from this branch's rule cannot hide a new version that
fetches it. With main's observations unchanged, every bump this branch reports
is also a bump main reports, plus the hosts this rule adds. The branch only
adds findings.
