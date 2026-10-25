# ADR-045: Analyze the dependencies a release newly declares

- **Status:** Accepted (agent, 2026-10-25, Tier 2 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-25
- **Plan reference:** PLAN §2 (degrade loudly), PLAN §4.3 (dependency additions), docs/platform.md

## Context

`analyzeRelease` analyzes one `ChangedPackage`. The lockfile path already analyzes every package present in the head lockfile, so a new dependency becomes its own report and the parent's LOW `DEPENDENCY` finding cross-links to it. The release path does not. When node-ipc 11.0.0 declared `peacenotwar`, the stored record held one package and a LOW `DEPENDENCY` finding with no cross-link, and the child's install hook was never seen.

## Decision

1. The collector reads the declared dependencies of the new and previous packument entries. Declared means the keys of `dependencies` plus `optionalDependencies`; `peerDependencies` and `devDependencies` are ignored.
2. A child is a name the new version declares and the previous version does not. A name that was already declared is never expanded, even when its range changed, because the package was already vetted. With no previous version, the collector expands nothing.
3. The collector selects at most 8 children per release, sorted by name. It fetches each child's packument with the same fetch, host and size rules as the candidate packument, and resolves the declared range against that packument.
4. `src/platform/dependency-children.ts` holds the selection and a small resolver. It handles an exact version, `^`, `~`, `*`, x-ranges, `latest` and other dist-tags. It picks the highest non-prerelease version. Aliases (`npm:`), URLs, git and file specifiers are not fetched and never resolve. No semver library and no new runtime dependency.
5. A resolved child becomes a `ChangedPackage` with `oldVersion: null`, appended after the parent. The existing single `analyzeChangedPackages` call analyzes the parent and its children together, so the scheduler, caps and gate treat them the same way. The report builder's existing cross-link then points the parent's `DEPENDENCY` finding at the child's report.
6. An unresolvable child, a registry failure for a child, and every child over the cap are recorded on the candidate. `analyzeRelease` turns each into an `incompleteReasons` entry that names the child and sets the record status to `incomplete`. Nothing is dropped silently.
7. `ANALYZER_VERSION` moves to `capdelta-engine-2` because the report for an already stored release can now contain new packages. Records made under `capdelta-engine-1` are not reused.

Limits, accepted on purpose:

- A first release expands nothing, because there is no previous declaration set to diff against.
- Depth is 1. A child's own new dependencies are not expanded.
- At most 8 children per release. The rest make the record incomplete.
- Peer dependencies are ignored. A peer is not installed by the package that declares it.
- A prerelease version is never selected, even when a tag points at one.

## Alternatives rejected

- Expand every declared dependency on every release. That re-analyzes vetted packages and trips the false-positive trap on bumps such as esbuild, sharp and bcrypt.
- Recursive expansion. The scheduler would grow without a fixed bound, and the release record would no longer fit one stored report.
- Expand a name whose range changed. The lockfile path already analyzes the resolved version, and a range change on an already declared package is not a new arrival.
- Add a semver dependency. The runtime budget is 8 of fewer than 10, and the supported forms are a bounded subset.
- Treat an unresolvable child as a normal skipped entry in the report. The record status exists precisely to say that the analysis did not cover everything.

## Consequences

A release record can now hold more than one package report, and `summary.changedPackages` counts the children. A parent's `DEPENDENCY` finding gains `relatedReportIds` when its child resolves. A release with an unresolvable child is `incomplete` and names the child, so a reviewer can see the gap instead of reading a clean record.

The collector makes one extra packument request per newly declared child, at most 8 per release. The analysis run performs the same fetches it would for any changed package.

To revert, remove `children` and `unresolvedChildren` from `ReleaseCandidate`, the child selection and resolver in `dependency-children.ts`, the attachment in `registry-collector.ts`, the child append and incomplete handling in `analyze-release.ts`, and restore `ANALYZER_VERSION` to `capdelta-engine-1`. No stored report or schema migration is needed. New records simply stop containing children.

## Evidence

- Live drive on the built `capdelta-platform analyze` against registry.npmjs.org. `node-ipc` 10.1.0 to 11.0.0 stores a complete record with two analyzed packages. `peacenotwar` 9.1.7 is analyzed as a new package (1 MEDIUM, 1 LOW, 2 INFO) and the parent's LOW `DEPENDENCY` finding links to its report (`relatedReportIds`). Before this change the record held one package. The range `^9.1.3` resolves to 9.1.7, the current published version, not the version published during the 2022 incident, so the child gate stays below CRITICAL.
- Control: `acorn` 8.18.0 to 8.19.0 declares no new dependency and still stores one package.
- Held-out corpus (`scripts/m5-measure.ts run`, 45 pairs): 0 rows differ before and after, ignoring timing fields. That path analyzes pairs directly and does not reach `analyzeRelease`, so the run shows the lockfile gate did not move, not that the release path is unchanged. No new finding to label as attack, noise or unknown.
- Tests: 1437 pass, including selection, resolver, collector, `analyzeRelease`, queue round trip and end-to-end cases.
- Codex security review: BLOCK on rounds 1 to 3, then APPROVE on round 4. Fixed along the way: `optionalDependencies` overrides `dependencies`, a child version with unusable metadata is unresolved instead of silently replaced by a lower one, `x` and `X` are wildcards before dist-tags, and an invalid dependency name no longer aborts a monitor cycle.
- Not covered here: tarball redirects are followed by the shared fetcher for every package (#207).
