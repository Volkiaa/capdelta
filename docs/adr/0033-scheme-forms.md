# ADR-033: Find endpoints whose scheme is written in a form the URL parser accepts

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external domain in literals)

## Context

`URL_LITERAL_RE` (`src/core/signal-extractor.ts:31`) requires a lower-case
scheme followed by two slashes. The WHATWG URL parser, which `fetch`,
`new URL`, `http.request(url)` and `WebSocket` use, reads `http`, `https`, `ws`
and `wss` case-insensitively and accepts any run of `/` or `\` after the colon.
`HTTPS://exfil.example.test/x`, `https:exfil.example.test/x`,
`https:/exfil.example.test/x` and the raw source `"HTTPS:\\\\exfil.example.test"`
all parse to `https://exfil.example.test/...`, but the extractor found no
endpoint. A package that already calls `fetch` could change its destination to
one of these forms with no finding.

A first attempt widened `URL_LITERAL_RE` itself. That changed the main scan's
span and cursor, so a raw match containing a backslash could consume a later
URL (`https:\\https://evil.test/x` lost `evil.test`), a suppressed match in one
template element could consume the next element's scheme, and a slashless match
could run to the end of the file, making repeated template elements quadratic.

## Decision

1. `URL_LITERAL_RE` stays exactly as it is on main: lower-case scheme, two
   literal slashes, the same span and cursor rules. The raw and cooked loops
   keep their existing boundary and template-element handling.
2. A second regex, `SCHEME_FORM_RE`, adds the forms main cannot see: an `i`
   flag and any run of `/` or `\` after the colon. It has its own cursor and
   never moves or shortens the main scan's cursor. A match is skipped only
   when the sticky main pattern handles the full authority. A shorter main prefix does not suppress separators followed by
   a runtime host. The additive cursor then advances to the lexical delimiter
   so a path or query cannot become another endpoint. Backslashes inside
   that span are URL path separators or query text, not lexical delimiters.
   This cursor never moves the main scan.
3. Each match goes through `urlEndpoint`, so `publicStyleDomain` and
   `isExternalHost` keep their current treatment.
4. The raw scan of the new forms reads one string or template element at a
   time. A match cannot run into the next element, and each character is read
   once, so repeated `https:a${x}` elements stay linear. Without parser ranges
   the scan reads the whole source once.
5. A cooked value is scanned once, bounded by its own length.
6. In the new raw scan, a match that contains a backslash is skipped when its
   string has a cooked value (ADR-026). Reading a raw escape as a separator
   could report a host the runtime cannot reach. The cooked scan reads the
   runtime text instead. Main's scan is unaffected because it cannot match a
   backslash form.
7. ADR-024 context classification is unchanged. `valueHasWords` already judges
   the runtime value without looking at the scheme, so `"HTTPS://host/x"` is
   `literal` like `"https://host/x"`.
8. A reconstruction, `scheme-forms`, swaps a destination using an upper-case
   scheme and backslash separators and expects a HIGH
   `new-external-endpoint` for the new host.

## Alternatives rejected

- **Widen the main regex.** It changes the span and cursor of every main match,
  and the three blocked inputs above show that a wider match can consume a URL
  main reports.
- **Normalize case and backslashes in the source before scanning.** It changes
  offsets used by string ranges, comment ranges and evidence, and two source
  characters can cook to one runtime character.
- **Decode JavaScript escapes in the extractor.** The parser already produces
  cooked values (ADR-026); a second decoder would disagree with it and would
  not cover non-JavaScript files.
- **Scan only cooked values.** Files the parser rejects have none, and byte
  scanning is the fallback there.

## Consequences

- More endpoints are found on both sides. Every finding this adds is a new
  observation, not a change to an existing one; the golden fixtures and
  reconstructions keep their `gateSeverity`.
- A host main already reports keeps its observation. A form main cannot match
  adds a host with the same string context and confidence rules.
- A host the old version already held only in one of these forms is now found
  on both sides, so the diff no longer reports it as new. That is accurate: the
  baseline already reached the host.
- Assembled URLs (`"ht" + "tps://host"`) remain out of scope, as ADR-024 and
  ADR-026 already record.

## How to revert

Delete `SCHEME_FORM_RE`, `URL_LITERAL_AT_RE`, `eachSchemeFormMatch` and the two
`collectSchemeForms` calls. The `scheme-forms` and `scheme-authority`
reconstructions then fail, which shows the evasion is open again.
