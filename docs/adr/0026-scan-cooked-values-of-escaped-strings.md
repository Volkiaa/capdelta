# ADR-026: Find endpoint URLs in the runtime value of escaped strings

- **Status:** Accepted (agent, 2026-10-21, under the maintainer's grant to decide the open drafts)
- **Date:** 2026-10-21
- **Plan reference:** PLAN §4.4 (new external domain in literals), CLAUDE.md "Autonomy", Tier 3

## Context

`URL_LITERAL_RE` (`src/core/signal-extractor.ts:24`) runs over each file's raw
text. It starts with `\b` and stops at a backslash. So a string escape hides a
URL from it in two ways:

- An escape glued to the scheme, as in `"\x20https://evil.test/x"`. The raw
  text has `0h`, which is no word boundary, so nothing matches.
- An escape inside the URL, as in `"https://evil\x2etest/x"`. The match stops
  at the backslash, so the host is `evil`, not `evil.test`.

At runtime both strings hold a plain URL. ADR-024 already classifies a string
by its runtime ("cooked") value, so the parser worker computes those values.

HANDOFF.md said scanning cooked values would also catch concatenation
(`"ht" + "tps://..."`). It would not: each literal's cooked value holds half
a URL. Concatenation stays out of scope.

## Decision

1. **The worker returns the cooked value of each escaped string.** For every
   string literal and template element whose raw content holds a backslash,
   the parse response carries its cooked value next to its range. A cooked
   value is never longer than its raw content, so the response stays bounded
   by the source size.
2. **The extractor scans those values with the same regex.** Each match gets
   the location of the string's start, and its context comes from the same
   ADR-024 rule applied to that string's range.
3. **Matches merge with the raw scan.** Cooked and raw matches go through the
   same per-host aggregation, so the strongest context wins (ADR-024). Evidence
   that is identical for the same file and line is kept once.
4. **Both sides are scanned the same way.**

## Why this is Tier 3

Point 4 can drop a finding. If the old version held a host only in escaped
form and the new version holds it plainly, the host is no longer new, so the
HIGH `new-external-endpoint` goes away. That diff is more accurate, but it is
a dropped finding, so the maintainer decides.

The alternative is to scan cooked values on the new side only. That never
drops a finding, so it would be Tier 2. But it makes every escaped host on an
unchanged line look new, which is noise.

## Evidence

- Full verification passes. A new reconstruction, `escaped-url`, reports the
  host behind `"\x20https://exfil.example.test/c"` at HIGH.
- Held-out corpus, both halves: all 90 pair reports are unchanged. No added
  and no dropped finding, so decision 4 changed nothing there.
- `replay compare` against main: every `gateSeverity` and exit code is equal.
  The only difference is one more evidence line for husky's
  `typicode.github.io`. Its multi-line template string now also goes through
  the cooked scan, which locates a match at the string's opening line (18).
- Codex security review, four rounds. Round 1 found a same-line dedupe that
  dropped a HIGH observation, URLs hidden by tabs and newlines, and quadratic
  evidence merging. Round 2 found a raw-text skip that dropped a stronger
  context. Round 3 found quadratic snippet building. Two of those were
  pre-existing problems on main, which #149 and #151 fixed, along with a
  template-boundary evasion (#150). Round 4: APPROVE.

## Why both sides

The dropped finding needs the old version to hold the host already, in
escaped form. The old version is the baseline the user already runs, and an
attacker who publishes the new version cannot edit it. A host the baseline
already reaches is not a new endpoint, so the drop is the correct diff. New
side only would report every escaped host on an unchanged line as new, which
is noise without a security reason.

## How to revert

Stop sending cooked values from the parser worker and delete the cooked scan
in `observeSignalSource`. The `escaped-url` reconstruction then fails, which
shows the evasion is open again.
