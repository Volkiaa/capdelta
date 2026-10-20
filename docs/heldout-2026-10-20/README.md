# Held-out corpus for D1, 2026-10-20

This directory measures ADR-024 (a new host mentioned only inside text is LOW).
M5 had no held-out split, so this corpus has one.

## Frozen inputs

| Item             | Value                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages         | 30, chosen because they ship CLIs, docs or templates                                                                                                                                                           |
| Pairs            | 3 adjacent pairs per package, 90 in total, selected by `scripts/m5-measure.ts select` with the M5 rule                                                                                                         |
| Disjoint from    | M5 (`docs/m5-2026-10-12/corpus.json`), the 2026-07-29 corpus (`docs/fp-corpus-2026-07-29.md`), and every package in this repository's `package-lock.json` (a superset of the #27 tuning sample) plus `postcss` |
| Split            | by package, before any run: the 15 names with the lowest SHA-256 of the name are the tuning half, the other 15 are held out                                                                                    |
| Corpus committed | `b5b208e64784aaab11dea186229eef64b684585d`, before any analysis                                                                                                                                                |
| Baseline run     | detector and policy identical to main at `2acf621`, Node v24.21.0, linux-x64                                                                                                                                   |

Tuning half (`corpus-tuning.json`): nunjucks, ora, boxen, serve, markdown-it,
mocha, jest, mongoose, @nestjs/cli, karma, http-server, handlebars, openai,
release-it, lerna.

Held-out half (`corpus-heldout.json`): ejs, typedoc, highlight.js, pino,
nodemon, jsdoc, browserslist, inquirer, ava, npm-check-updates,
update-notifier, marked, concurrently, @sentry/node, winston.

## Baseline (before ADR-024)

| Measure                                           |          Tuning | Held out |
| ------------------------------------------------- | --------------: | -------: |
| Pairs analyzed                                    |         45 / 45 |  45 / 45 |
| Default gate failures                             |               1 |        0 |
| `new-external-endpoint` findings from URLs        |               0 |        0 |
| `new-external-endpoint` findings from IP literals | 2 (HIGH, noise) |        0 |

Labels are in `baseline-labels.json`. Raw results are in
`baseline-tuning.json` and `baseline-heldout.json`.

No pair in either half adds a new host through a URL. Adjacent releases rarely
add hosts: M5 had one such finding in 90 pairs. So the finding counts cannot
show ADR-024 lowering noise on this corpus. The held-out check therefore also
measures the classifier itself, on every URL the new versions contain, not
only on new hosts. That run and its write-up come after the change lands.

The tuning gate failure is http-server 13.1.0 -> 14.0.0, a
`secret-exfiltration` shape from `lib/shims/https-server-shim.js`, which
reads `process.env.NODE_HTTP_SERVER_SSL_PASSPHRASE` in a file that requires
`https`. It is outside ADR-024 and is not labelled here.

The two IPv6 findings come from the IP-literal pattern matching characters in
minified data. ADR-024 does not cover IP literals.

## After ADR-024

ADR-024 landed in two steps. #138 records each URL's context (`literal`,
`embedded-text` or `unknown`), and #139 reports a new host seen only as
`embedded-text` at LOW. Both runs below used Node v24.21.0 on linux-x64.

### Finding counts

`after-tuning.json` and `after-heldout.json` come from
`scripts/m5-measure.ts run` with the detector and policy identical to main at
`57b24a8` (#139). The recorded commit `ffd6b27` is the measurement branch,
which adds only the script.

| Measure                                           | Tuning, before | Tuning, after | Held out, before | Held out, after |
| ------------------------------------------------- | -------------: | ------------: | ---------------: | --------------: |
| Pairs analyzed                                    |        45 / 45 |       45 / 45 |          45 / 45 |         45 / 45 |
| Default gate failures                             |              1 |             1 |                0 |               0 |
| `new-external-endpoint` findings from URLs        |              0 |             0 |                0 |               0 |
| `new-external-endpoint` findings from IP literals |       2 (HIGH) |      2 (HIGH) |                0 |               0 |

The summed `gateSeverity` of every pair is also identical before and after
(tuning CRITICAL 2, HIGH 2, MEDIUM 23, LOW 6, INFO 5; held out MEDIUM 12,
LOW 2, INFO 1). As predicted above, this corpus cannot show a change in
finding counts.

### Classifier

`contexts-tuning.json` and `contexts-heldout.json` come from
`scripts/m5-measure.ts contexts`. It runs the same analysis, records the new
side's capability set, and lists every domain observation with its context.
The detector was identical to main at `3f42d80` (#138). The recorded commit
`41f754b` is the measurement branch. #139 changes severity only, not context.

| Context         | Tuning | Held out |
| --------------- | -----: | -------: |
| `literal`       |     94 |       48 |
| `embedded-text` |     47 |       35 |
| `unknown`       |     78 |        3 |

The question that matters for security is whether any `embedded-text`
observation is really a request target, which ADR-024 would then hide at LOW.
`classifier-labels.json` labels each distinct package, host and evidence file
(26 tuning rows, 14 held-out rows). Every row is prose: log and error
messages, CLI help text, markdown, test expectations of npm error output, and
a cache-directory tag file. No single-URL value was demoted.

Limits of this measurement:

- Each label is judged from the observation's first evidence snippet.
  `embedded-text` is the weakest context, so every other occurrence of that
  host on that side is also inside text.
- The first snippet does not always show the occurrence that decided the
  context. One observation merges every file on a side, and `unknown`
  outranks `embedded-text`. pino's `bin.js` holds github.com inside prose, but
  `pino.d.ts` also names it. capdelta does not parse `.d.ts` files, so the
  host is `unknown`. Most tuning `unknown` rows (66 of 78) are openai's
  published TypeScript sources.
- `literal` still covers documentation links printed alone, such as
  `console.warn("https://github.com/highlightjs/highlight.js/wiki/security")`
  in highlight.js and the ejs and browserslist error links. ADR-024 keeps
  those HIGH on purpose, because a string holding only a URL looks the same
  as a request target.
