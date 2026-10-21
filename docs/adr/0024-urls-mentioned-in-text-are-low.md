# ADR-024: Report a new host mentioned only inside text at LOW

- **Status:** accepted
- **Date:** 2026-10-20
- **Plan reference:** PLAN §4.4 ("New external domain in literals: HIGH"), §2 (degrade loudly), §7.4 (measurement)

## Context

capdelta finds endpoints with a regex over each file's raw text and skips only
comments in files that parsed (`src/core/signal-extractor.ts`). Every host new
on the new side is a HIGH `new-external-endpoint` finding, as PLAN §4.4 says.

Both recorded false positives are URLs mentioned inside longer text. In M5,
yargs 18.0.0 cites a Stack Overflow answer in a shell comment inside a string
(`docs/m5-2026-10-12/labels.json:23-28`), the only HIGH in that measurement.
vitest 5.0.4 writes a `CACHEDIR.TAG` text that cites its spec's URL. In every
attack reconstruction and golden case, the endpoint URL is a string literal
that holds only the URL, and no reconstruction's gate depends on the endpoint
finding: each one fails on a capability or a shape.

## Decision

1. **Classify each URL match by the string it sits in.** The parser worker
   returns the content ranges of every string literal and template element.

   | Where the URL is                                                   | `context`       | Severity of a new host |
   | ------------------------------------------------------------------ | --------------- | ---------------------- |
   | The whole content of a string literal or template element, trimmed | `literal`       | HIGH                   |
   | Inside a string literal or template element that holds other text  | `embedded-text` | LOW                    |
   | Not inside any string, or the file did not parse                   | `unknown`       | HIGH                   |

2. **Strongest context wins.** When a host appears more than once on the new
   side, its context is the strongest one seen: `literal`, then `unknown`,
   then `embedded-text`. The finding drops to LOW only when every occurrence
   is `embedded-text`. The LOW finding's detail says "(mentioned in text)".
3. **Degrade loudly.** A file the parser cannot read keeps HIGH, so breaking
   the parse never demotes a URL.
4. **Measure on a held-out corpus.** A new frozen corpus of 30 packages × 3
   adjacent pairs, disjoint from earlier corpora, is split by package into a
   tuning half and a held-out half (`docs/heldout-2026-10-20/`). The change
   must demote no endpoint labelled real, leave every reconstruction and
   golden `gateSeverity` unchanged, and reduce held-out endpoint HIGHs
   labelled noise.

This amends the PLAN §4.4 row for new external domains.

## Alternatives rejected

- **Drop the finding for URLs in text.** An attacker can cut a URL out of
  prose at run time, for example `"see https://evil.test now".split(" ")[1]`.
  Keeping a LOW finding keeps the host in the report.
- **MEDIUM instead of LOW.** In M5, 91 of 95 MEDIUM findings were noise, so
  MEDIUM would add to the noisiest tier without making the finding more
  useful.
- **Exclude shell or Markdown comments inside strings.** It needs a parser per
  embedded language and still misses prose.

## Consequences

- A host that an attacker hides inside prose shows at LOW, so `--fail-on high`
  no longer fails on it. This matters most when the package already has a
  network capability and the attacker only changes the destination: no new
  capability or shape fires, and the endpoint finding is the only signal.
- That signal is already easy to evade today. The URL regex
  (`URL_LITERAL_RE`, `src/core/signal-extractor.ts:22`) needs the scheme and
  host in one piece of text, so `"ht" + "tps://evil.test"`,
  `["https:", "", "evil.test"].join("/")` or a base64 string produce no
  endpoint finding at all. Moving the URL into prose gives an attacker
  nothing those forms don't, and it still leaves a LOW finding in the report.
  The endpoint finding is a hint for reviewers, not a gate guarantee. The
  gate's guarantees come from capabilities and shapes.
- When the package gains a network call, that call shows as a NET or PROCESS
  capability (HIGH) and, with secrets, as the CRITICAL exfiltration shape.
  Those findings don't depend on the endpoint finding.
- A URL in a string with trailing text, such as `"https://evil.test/c? x"`,
  is `embedded-text`. This is accepted for the reasons above.
- A test documents the destination-swap boundary: a package with an existing
  network call that switches to a host split out of prose gets one LOW
  endpoint finding and no HIGH.
- URLs in comments of TypeScript files and of files that failed to parse still
  fire at HIGH.
- Revisit if a reconstruction or a real attack relies on the endpoint finding
  alone and puts its URL inside text, or if the endpoint detector learns to
  resolve assembled URLs, which would make the text-embedding route the
  cheapest evasion left.

## Amendment 2026-10-21: template element boundaries

Status: Accepted (agent), Autonomy Tier 2.

`URL_LITERAL_RE` does not stop at `${`. So a URL at the end of one template
element ran through the expression into the next one and took the first
element's context. In ``tag`See https://a.test/${0}https://evil.test/` ``,
the second element's URL, which a tag function receives on its own, was
either reported LOW or not reported at all.

In a parsed file, a match that starts inside a string and runs past its end
now yields two observations. The part inside the string keeps that string's
context. The whole match is `unknown`, because at runtime the string can
still join across the expression, as in `` `https://a.test${x}@evil.test/` ``.
Scanning resumes at the end of the string, so the next element is scanned
on its own. This only adds observations and raises contexts. Strongest
context still wins, so no finding drops.

Evidence: reconstruction `template-boundary` fails on the previous code and
passes now. Full verification, `replay compare` against main, the held-out
corpus before and after, and the Codex reviews are listed in the PR.
