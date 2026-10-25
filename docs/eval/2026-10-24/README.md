# Labeled evaluation, 2026-10-24

This is the phase 2 corpus from `docs/v2-roadmap.md`: labeled malicious releases and assumed-benign version transitions, a held-out split, and measured recall, false-positive rate and incomplete-analysis rate. It is not an ecosystem-wide estimate and not a benchmark of the detector against unknown malware.

Raw data: [corpus.json](corpus.json) (238 entries with pairs and overrides), [results.json](results.json) (every attempt and the bounded report), and this file. The run used commit `2cef30b`, Node v24.21.0, from 2026-10-24T21:48:05Z to 21:59:07Z.

## How the corpus was built

**Benign.** 90 transitions are the pairs in the frozen m5 corpus (`docs/m5-2026-10-12/corpus.json`), with source `assumed benign: popular package adjacent bump (m5 frozen corpus)`. 132 more come from 44 widely used packages that are not in the m5 list, three adjacent bumps each. The selection uses `recentVersions` and `changedPackage` with the m5 rule: stable `x.y.z` only, not deprecated, sha512 integrity, adjacent pairs among the four highest eligible releases ordered by version number. 45 packages were tried. `node-sass` had zero eligible releases because every release is deprecated, so it contributed nothing. The total is 222 benign transitions (90 + 132). These releases are assumed benign. Nobody verified that each one is legitimate, and a compromise inside this set would be scored as a false positive.

**Malicious, real artifacts.** 16 candidate releases from 10 packages were probed against the registry. Two were still downloadable with sha512 integrity and a clean predecessor: `faker@6.6.6` and `node-ipc@11.0.0`. The other 14 are no longer in the registry metadata, so there is no integrity value to pin and no artifact to analyze. The table below records every candidate.

`faker@6.6.6` is the sabotage release that removed functional code. Its named predecessor `6.6.5` is also unpublished, so the old side is `5.5.3`, the highest remaining release, and the pair is a major-version jump. `node-ipc@11.0.0` is protestware: it adds a dependency that writes a message to the user's desktop. It is not a credential stealer. The `10.1.x` releases, which overwrote files, are all unpublished.

**Malicious, synthetic.** All 14 `attack` scenarios in `test/fixtures/reconstructions/inventory.json` are entries with provenance `synthetic-reconstruction`. `scripts/eval-build-corpus.ts` computes each `resultOverride` by loading the fixture tarballs into memory and running them through `analyzeChangedPackages`, `buildRunReport` and `evaluateSeverityGate`, which is the production report path. Nothing is installed or executed. These fixtures are defanged reconstructions modeled on public analyses, not the original artifacts, and they were designed alongside the detector. Their recall is not held-out evidence of detection.

**Split.** `assignHeldOut` with fraction 0.3 and salt `capdelta-eval-2026-10-24` over all 238 entries produced 75 held-out entries (31.5%) and 163 development entries. No detection or severity code changed for this ticket. The held-out entries were not used to tune any detection; the only held-out malicious entry is a synthetic reconstruction.

## Corpus counts

| Label     | Provenance               | Entries | Held out | In development |
| --------- | ------------------------ | ------: | -------: | -------------: |
| benign    | real-registry            |     222 |       74 |            148 |
| malicious | real-registry            |       2 |        0 |              2 |
| malicious | synthetic-reconstruction |      14 |        1 |             13 |
| all       | both                     |     238 |       75 |            163 |

The 222 benign transitions are 90 from the m5 corpus and 132 from the fresh selection. The two real malicious transitions are `faker` 5.5.3 to 6.6.6 and `node-ipc` 10.1.0 to 11.0.0.

## Results by label and provenance

| Group                | Entries | Analyzed | Incomplete | Detected (HIGH or CRITICAL) | Default gate fails |
| -------------------- | ------: | -------: | ---------: | --------------------------: | -----------------: |
| benign, real         |     222 |      222 |         24 |                    2 (0.9%) |                  2 |
| malicious, real      |       2 |        2 |          1 |                           0 |                  0 |
| malicious, synthetic |      14 |       14 |          2 |                          13 |                  6 |
| all                  |     238 |      238 | 26 (10.9%) |          13 of 16 malicious |  6 of 16 malicious |

Real-registry recall is 0 of 2 at HIGH or CRITICAL and 0 of 2 at the default gate. The 25-release target for real malicious releases was missed by 23. Compromised releases are removed from the registry, so there is no integrity-pinned artifact left to download, and storing live malware samples in this repository is not acceptable. The synthetic recall of 13 of 14 measures the reconstruction suite, not the registry.

The table below is generated by `npm run eval -- report`. Its recall row pools the 2 real malicious entries with the 14 synthetic ones. Read the table above for the split.

## Metrics

| Measure                             |                                         All |                                    Held-out |                                 Development |
| ----------------------------------- | ------------------------------------------: | ------------------------------------------: | ------------------------------------------: |
| Entries                             |                                         238 |                                          75 |                                         163 |
| Analyzed                            |                                         238 |                                          75 |                                         163 |
| Incomplete or unavailable           |                                       10.9% |                                       10.7% |                                       11.0% |
| Recall (HIGH or CRITICAL)           | 13 of 16 (81.3%, Wilson 95% 57.0% to 93.4%) | 1 of 1 (100.0%, Wilson 95% 20.7% to 100.0%) | 12 of 15 (80.0%, Wilson 95% 54.8% to 93.0%) |
| Recall at the default gate          |  6 of 16 (37.5%, Wilson 95% 18.5% to 61.4%) | 1 of 1 (100.0%, Wilson 95% 20.7% to 100.0%) |  5 of 15 (33.3%, Wilson 95% 15.2% to 58.3%) |
| False positives (HIGH or CRITICAL)  |    2 of 222 (0.9%, Wilson 95% 0.2% to 3.2%) |     1 of 74 (1.4%, Wilson 95% 0.2% to 7.3%) |    1 of 148 (0.7%, Wilson 95% 0.1% to 3.7%) |
| False positives at the default gate |    2 of 222 (0.9%, Wilson 95% 0.2% to 3.2%) |     1 of 74 (1.4%, Wilson 95% 0.2% to 7.3%) |    1 of 148 (0.7%, Wilson 95% 0.1% to 3.7%) |

## Missed malicious entries

- `malicious:faker:5.5.3->6.6.6`: the release deletes the library and leaves a 3.8 KB stub. A capability diff sees removals, not new behavior, so no finding is raised. The old side also has two unparseable files, so the entry counts as incomplete.
- `malicious:node-ipc:10.1.0->11.0.0`: the protestware message ships in a new transitive dependency, `peacenotwar`. A single-package diff reports the dependency addition at LOW and does not analyze the new package's code, so the default CRITICAL gate does not fire.
- `malicious:synthetic:manifest-directory/attack`: the CRITICAL `manifest-not-regular` failure is on the old side and stays a baseline failure that never gates (ADR-023). The new side is analyzed as a newly added package and has no findings. Strict mode marks the entry incomplete.

## False positives

| Pair                             | Adjudication                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benign:m5:bcrypt:5.1.1->6.0.0`  | Accurate install-hook change. The registry `install` script changed from `node-pre-gyp install --fallback-to-build` to `node-gyp-build`. CRITICAL is the intended policy for a changed registry install hook.                |
| `benign:m5:sqlite3:5.1.6->5.1.7` | Accurate install-hook change. The registry `install` script changed from `node-pre-gyp install --fallback-to-build` to `prebuild-install -r napi \|\| node-gyp rebuild` in a patch release. CRITICAL is the intended policy. |

Both flags are real changes, not detector noise. They are scored as false positives because the corpus labels these popular releases benign, and the default policy treats any changed registry install hook as CRITICAL.

## Incomplete analysis

26 of 238 entries are incomplete or unavailable. All 238 were analyzed; none was unavailable. The 24 real incomplete transitions are 21 from published TypeScript sources (`fastify`, `zod`, `cheerio`, `ajv`, `rxjs`, `immer`, `pino`, three each), 2 from `bcrypt`, and 1 from `faker`, whose old-side `dist/faker.js` exceeds the parser limit. The two synthetic incomplete entries are `manifest-directory` and `old-side-unanalyzable`. The causes across the 24 real-registry entries, grouped by message class with one example release each, are in [incomplete-causes.md](incomplete-causes.md).

## Malicious candidate decisions

| Package                    | Version | Decision                                                                                                                 |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| colors                     | 1.4.1   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| colors                     | 1.4.2   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| faker                      | 6.6.6   | Included, old side 5.5.3. 6.6.5 is unpublished.                                                                          |
| node-ipc                   | 10.1.1  | Excluded. Absent from registry metadata, unpublished.                                                                    |
| node-ipc                   | 10.1.2  | Excluded. Absent from registry metadata, unpublished.                                                                    |
| node-ipc                   | 10.1.3  | Excluded. Absent from registry metadata, unpublished.                                                                    |
| node-ipc                   | 11.0.0  | Included, old side 10.1.0. Protestware, still downloadable.                                                              |
| event-stream               | 3.3.6   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| ua-parser-js               | 0.7.29  | Excluded. Absent from registry metadata, unpublished.                                                                    |
| ua-parser-js               | 0.8.0   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| ua-parser-js               | 1.0.0   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| coa                        | 2.0.3   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| rc                         | 1.2.9   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| @ctrl/tinycolor            | 4.1.1   | Excluded. Absent from registry metadata, unpublished.                                                                    |
| @lottiefiles/lottie-player | 2.0.7   | Excluded. The advisory lists 2.0.5 to 2.0.7; all three are absent. The registry now serves 2.0.8, which is not affected. |
| @solana/web3.js            | 1.95.6  | Excluded. Absent from registry metadata, unpublished.                                                                    |

No candidate failed for a missing integrity value. No malicious version was replaced in place by a security placeholder; every excluded version is simply absent from the current metadata. The sources for each probe are advisory URLs in `scripts/eval-build-corpus.ts`, and every included entry carries one in `corpus.json`.

## Synthetic reconstruction results

- `malicious:synthetic:axios-2026/attack`: max severity CRITICAL, gate fails yes, incomplete no.
- `malicious:synthetic:shai-hulud-2025/attack`: max severity CRITICAL, gate fails yes, incomplete no.
- `malicious:synthetic:shai-hulud-2-2025/attack`: max severity CRITICAL, gate fails yes, incomplete no.
- `malicious:synthetic:layout-evasion/attack`: max severity CRITICAL, gate fails yes, incomplete no.
- `malicious:synthetic:mode-evasion/attack`: max severity CRITICAL, gate fails yes, incomplete no.
- `malicious:synthetic:manifest-directory/attack`: max severity NONE, gate fails no, incomplete yes.
- `malicious:synthetic:old-side-unanalyzable/attack`: max severity CRITICAL, gate fails yes, incomplete yes.
- `malicious:synthetic:template-boundary/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:escaped-url/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:underscore-label/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:file-kinds/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:ipv4-octal-hex/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:net-existing/attack`: max severity HIGH, gate fails no, incomplete no.
- `malicious:synthetic:fs-read-existing/attack`: max severity HIGH, gate fails no, incomplete no.

A HIGH result is a detection in this report, but the default gate waits for CRITICAL. Six of the 14 synthetic attacks fail the default gate.

## Limits

- The benign label is an assumption, not an audit. Popular releases were not reviewed for legitimacy.
- The 222 benign transitions come from 74 packages with three correlated bumps each. This is a convenience sample, not a random one.
- The real malicious sample is 2 releases, one of them protestware. Recall 0 of 2 and the 23-release shortfall mean this run does not estimate malware detection in the registry.
- Synthetic reconstructions were written alongside the detector. Their 13 of 14 recall shows the fixtures still behave, not that the detector generalizes.
- Any detector change makes these numbers historical.
