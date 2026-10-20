# What did this dependency gain?

_Draft for the capdelta M5 writeup. Every number below comes from the frozen
measurement in [docs/m5-2026-10-12](../m5-2026-10-12/README.md) or from the
attack reconstructions in the repository._

Most dependency scanners answer one question: is this version already known to
be bad? That question has a gap. A compromised release is not known to be bad
until someone notices, writes it up, and an advisory database picks it up. The
axios compromise in March 2026 and the Shai-Hulud worm in 2025 both spread in
that window.

capdelta asks a different question about every dependency bump in a pull
request: **what can the new version do that the old version could not?** It
compares the old and new tarballs from the npm registry and reports what was
gained. Examples are a new install script, a new process launch, a new network
client, a new read of secret files, or a new `eval`. It never runs package code.

## How it works

capdelta reads the lockfile on both sides of a pull request. For every package
whose resolved version changed, including transitive ones, it does these steps:

1. It downloads both tarballs and checks them against the lockfile's integrity
   hashes.
2. It extracts them with strict limits on size, file count, and paths.
3. It parses the JavaScript statically and records capabilities.
4. It diffs the two capability sets.

The result is a sticky PR comment, a SARIF upload, and an exit code. The
default gate fails only on CRITICAL findings, such as a registry install hook
that was added or changed, or network, process, or environment access inside
install code. Everything else is a review prompt, not a verdict.

## The attacks it was built for

The repository has defanged reconstructions of three documented npm
compromises. They run through the same lockfile, fetch, analysis, and gate path
as a real pull request.

- **axios, 2026.** `axios@1.14.1` only added a dependency. The new package,
  `plain-crypto-js@4.2.1`, carried a `postinstall` script with an encoded
  string table. capdelta gives a newly added package a full report, so the
  `postinstall` hook is CRITICAL and the axios bump links to it.
- **Shai-Hulud, 2025.** `@ctrl/tinycolor@4.1.1` added `postinstall: node
bundle.js`, and the bundle read tokens and posted them to a GitHub API.
  capdelta reports the CRITICAL hook plus network, environment, and process
  access in install code. When the bundle is too large to parse, the hook alone
  still fails the gate.
- **Shai-Hulud 2.0, 2025.** A `preinstall` loader plus an encoded payload.
  The CRITICAL `preinstall` hook fails the gate.

Each incident reconstruction also has a benign control bump that must pass.
These are modeled cases. They show that capdelta flags the modeled changes. They
are not a measured detection rate, and capdelta does not decode the encoded
payloads.

## Does it cry wolf?

A tool that blocks every other pull request gets turned off. So the question
for M5 was how often the default gate fails on ordinary updates.

On 2026-10-12, 30 popular packages were pre-registered and frozen before
analysis. Three bumps from each, 90 in all, were then analyzed. All
90 were analyzed successfully. The default gate failed on **2 of 90**:

- `bcrypt` 5.1.1 to 6.0.0 changed its registry install hook from
  `node-pre-gyp install --fallback-to-build` to `node-gyp-build`, in a major
  release.
- `sqlite3` 5.1.6 to 5.1.7 changed its install hook from
  `node-pre-gyp install --fallback-to-build` to
  `prebuild-install -r napi || node-gyp rebuild`, in a patch release.

Both are real changes to code that runs automatically on `npm install`. That is
exactly what capdelta is meant to make a human look at, so both were labeled
review-worthy, not noise. A changed install hook in a patch release is worth a
minute of anyone's time.

One bump, `yargs` 17.7.3 to 18.0.0, produced a HIGH finding for a new external
domain. The domain was a documentation link inside a string literal, so it was
labeled noise. HIGH does not fail the default gate, but it is the clearest
false positive in the sample. Eleven bumps would fail the optional `--strict`
mode, because they ship TypeScript sources or a file the parser could not read.

Here is what the `bcrypt` gate failure looks like as a PR comment, from a
throwaway demo pull request:

![capdelta's comment on a demo PR bumping bcrypt from 5.1.1 to 6.0.0](../images/demo-bcrypt-6.png)

## What these numbers do not say

- **This is not an ecosystem false-positive rate.** The sample is 90 bumps
  from 30 hand-picked packages, clustered by package. Labels come from a single
  reviewer, an AI model (Claude), as the frozen record states.
- **There is no measured detection rate.** The attack cases are
  reconstructions, not live malware.
- **capdelta reviews changes, not packages.** A package that was already
  malicious before the bump, or one that gains a capability slowly across
  several releases, shows no new delta. A committed baseline snapshot to cover
  slow-roll changes is planned for v0.2.
- **Static analysis is bounded.** capdelta resolves direct imports and one
  level of aliasing. Anything more dynamic is reported as `UNKNOWN`, and a
  signal layer catches some of the rest, such as large encoded blobs and new
  URLs.

The README lists every known evasion and limitation.

## Try it

capdelta is pre-release. The CLI and the GitHub Action work end to end, but
the package is not on npm yet. The README's Quick start shows how to build it
and run it against your own lockfile, and how to add the Action to a
repository. capdelta runs on its own repository, so every dependency update to
capdelta gets the same comment.

The next step is a signed v0.1.0 release. Since this draft was written,
capdelta analyzes the new side of a bump as a newly added package when only the
old side cannot be analyzed, and it reports a new host seen only inside prose
at LOW.
