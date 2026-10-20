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
