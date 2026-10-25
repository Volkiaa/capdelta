# CLI reference

This page documents every capdelta CLI flag, exit code, and allowlist or unanalyzable exception, with worked examples. Back to the [README](../README.md).

Machine-readable output:

```bash
node dist/cli.js --base main --format json
```

The intended published interface is:

```bash
npx capdelta --base main
```

The npm package is still marked private and has not been published, so use the
built entrypoint during development.

## CLI behavior

```text
Usage: capdelta --base <ref> [--format text|json] [--config path] [--fail-on severity] [--strict] [--intel-url url]
```

- The base ref is resolved to an immutable commit. Git is invoked with argument
  arrays and no shell; the validated base blob is read by object ID.
- If `package-lock.json` is unchanged, capdelta exits `0` with no output and
  performs no lockfile parsing, extraction, or network access.
- An untracked, newly added lockfile enters first-run mode. Text stays
  aggregate-only; JSON retains every package report.
- Expected package-local failures and partial-analysis diagnostics remain in
  the report instead of disappearing.
- When analysis runs, the full report is written before the exit code is
  decided. Invalid usage, operational failures, and the unchanged-lockfile
  fast path produce no report.

`--fail-on` sets an inclusive severity threshold: `CRITICAL` (default), `HIGH`,
`MEDIUM`, `LOW`, `INFO`, or `none` for report-only use. It evaluates the
report's `summary.gateSeverity`: unsuppressed capability and signal findings,
lockfile findings, and severity-bearing analysis issues. Tarball integrity
mismatches, and packages capdelta cannot analyze for a reason decided by the
artifact bytes or the lockfile entry, are CRITICAL, so the default gate fails
until a person reviews them (ADR-016, ADR-018). That includes an integrity
mismatch, a tarball over a cap, a non-retryable HTTP status such as 404, and an
invalid response. Allowlisted findings stay in the report as suppressed but
never fail the gate.

`--strict` returns exit `2` when a package is unavailable, a lockfile entry is
skipped, diagnostics remain, or cancellation/deadline leaves work incomplete.
Without it, other environmental incompleteness still remains loud in the report
but does not fail the run; severity-bearing issues such as integrity mismatches
and unanalyzable packages go through `--fail-on`. A transient fetch failure that
outlives its retries, a deadline/cancellation stop, or a residual
filesystem/manifest-read failure (ADR-019) is different: it is an operational
failure (ADR-018, ADR-019) and exits `1` even under `--fail-on none`.

capdelta retries a transient fetch failure — `network-error`, `timeout`, and
HTTP 408, 429, or 5xx — up to three attempts, with 250 ms and then 1 s of
backoff. A retryable status that persists becomes `http-unavailable`. A
`timeout`, `network-error`, or `http-unavailable` after the final attempt, a
residual `filesystem-error` during extraction or an unreadable `package.json`
(`manifest-unreadable`), and any package the deadline or cancellation left
unanalyzed, fail the run operationally: the CLI prints `capdelta: N package(s)
could not be fetched or analyzed` to stderr and exits `1`.

| Exit | Meaning                                                                                                     |
| ---: | ----------------------------------------------------------------------------------------------------------- |
|  `0` | Nothing reached the `--fail-on` threshold and no package failed operationally, or the lockfile is unchanged |
|  `1` | A finding reached the threshold, or an operational failure; see stderr, unless `--strict` selects exit 2    |
|  `2` | `--strict` found unanalyzed content; takes precedence over severity and operational failure                 |
| `64` | Invalid usage, including a malformed `--intel-url`                                                          |

`--intel-url` asks a capdelta platform service whether a reviewer confirmed a changed artifact as malicious. It sends only the artifact digest. A confirmed match adds a CRITICAL lockfile finding, and an unreachable service becomes a warning. Setup, privacy and failure behavior are in [platform.md](platform.md#consumers). The setting is never read from `.capdelta.yml` (ADR-015, ADR-041).

Allowlist exceptions live in `.capdelta.yml` and require a justification. The
GitHub Action reads this file from the selected base commit (the PR base, or
`base-ref`), never from the PR head, so a pull request cannot add an exception
that suppresses its own findings. Normally you merge a reviewed exception
first, then re-run the dependency PR (ADR-015).
The CLI likewise reads `--config` (default `.capdelta.yml`, relative to the
current directory) from the `--base` commit and only reports working-tree
changes to it.

Example:

```yaml
allowlist:
  - package: example-package
    capability: NET
    justification: "documented telemetry endpoint"
```

The finding remains visible as `suppressed ("documented telemetry endpoint")`
and is excluded from the severity gate. The parser intentionally supports only
this small, reviewable YAML subset and adds no runtime dependency.

Prefer scoping an exception to the exact version you reviewed:

```yaml
allowlist:
  - package: example-binding
    capability: NATIVE
    version: 1.2.13
    justification: "prebuilt binding reviewed for 1.2.13"
```

`version` must be one exact semver (no ranges, tags, or `v` prefix) and is
compared literally, build metadata included. The reason then reads `[version
1.2.13] …`. Other versions do not match the exception, so capabilities they
newly gain gate normally (capdelta reports additions, so a later release that
adds nothing new produces no finding either way). A scoped entry still applies
to every matching finding of that version until removed, and it trusts npm's
immutable `name@version` rather than pinning reviewed bytes. Entries without
`version` apply to every version, so a later malicious change of the same kind
in that package would also be suppressed. Several exact versions may be listed
for one package and capability, but scoped and unscoped entries for the same
pair cannot be mixed.

A package capdelta cannot analyze at all — an oversized tarball, a refused
entry, or a missing manifest — fails the default gate (ADR-016). Release a
reviewed one with a top-level `unanalyzable:` exception, bound to the exact
bytes that were reviewed:

```yaml
unanalyzable:
  - package: big-native-pkg
    version: 2.3.4
    integrity: "sha512-…" # exact lockfile integrity of the reviewed artifact
    kind: expanded-size-limit # one unanalyzable failure kind
    justification: "Ships 80 MB of prebuilt binaries; reviewed upstream release notes and provenance."
```

Every field is required. Get `integrity` by copying the `integrity` field of
that package and version's `node_modules/...` entry in `package-lock.json`.
`version` must be one exact semver, and `integrity` must be one or more
canonical sha512 SRI tokens. `kind` must be a post-verification failure kind —
one of the extraction- or manifest-stage kinds ADR-016 classifies as CRITICAL,
such as `expanded-size-limit`, `file-count-limit`, `link-entry`,
`manifest-missing`, or `manifest-not-regular`. Fetch-stage kinds (`size-limit-exceeded`, `invalid-url`,
`unsupported-integrity`, `integrity-mismatch`) happen before or without byte
verification, so they can never be excepted and are rejected. The same
`(package, version, integrity, kind)` tuple may not appear twice.

The entry must bind the **new** artifact, not just the old one. A package is
released only when every severity-bearing failure is a post-verification
failure that matches an entry on its own side's version and integrity, and at
least one match is on the new side. An old-side-only exception never releases a
package, because the new bytes were never inspected. The exception then releases
only those exact bytes from the severity gate; every new version and every
swapped tarball needs a fresh review, and `--strict` still returns exit `2`
because the package remains unanalyzed.

An exception for the old side alone is no longer needed when the new side reads
cleanly. capdelta analyzes the package as newly added (ADR-023), reports every
capability of the new version as added, gates them normally, and still shows the
old failure as a baseline failure. `--strict` still returns exit 2.

Known cost: a tarball over the _download_ cap fails at fetch time with
`size-limit-exceeded`, so it can no longer be excepted. Raising the fetch cap is
the fix, but neither the CLI nor the GitHub Action exposes it today, so that is
a code change rather than a configuration one.

Example excerpt:

```text
capdelta capability analysis report
Mode: comparison
Packages: 1 changed; 1 analyzed; 0 unavailable; 0 lockfile skips.
Signals: 1 capability finding (CRITICAL: 1); 0 lockfile findings; 0 analysis issues; 0 analysis diagnostics.

Findings:
- [CRITICAL] "postinstall" registry install hook added
  Evidence: "package.json":5 — "\"postinstall\": \"echo test\""
```
