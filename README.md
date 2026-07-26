# capdelta

**Review what an npm dependency gained between two lockfiles.**

Traditional vulnerability scanners answer “is this version already known to
be vulnerable?” capdelta asks a different question: **what can the new version
do that the old version could not?** A newly added install script, command
entrypoint, dependency, or runtime constraint is review-worthy even before a
CVE exists.

> **Development status:** private, unpublished, and at the M1 manifest-only CLI
> milestone. It is suitable for development and evaluation, not production
> enforcement. The GitHub Action, SARIF output, policy thresholds, and runtime
> source analysis are later milestones.

## What M1 detects

For every direct and transitive npm package whose resolved version changed,
capdelta compares `package.json` behavior and reports additions or changes to:

- `preinstall`, `install`, `postinstall`, and `prepare` scripts;
- command entrypoints from `bin`;
- dependencies; and
- runtime constraints from `engines`.

New packages receive a full manifest capability report. Removed packages are
ignored. The current implementation accepts one npm `package-lock.json` v2 or
v3 in the current working directory of a Git checkout.

M1 does **not** inspect JavaScript source for network, filesystem, process,
environment, native-code, or dynamic-code behavior. Those AST and signal
layers are roadmap work, not hidden heuristics in the current release.

## Try it locally

Requirements: Node.js 20 or newer, npm, and Git.

Run capdelta from the directory containing the lockfile to compare.

```bash
npm ci
npm run build
node dist/cli.js --base main
```

Select machine-readable output with:

```bash
node dist/cli.js --base main --format json
```

The intended published interface is:

```bash
npx capdelta --base main
```

The npm package is not published while the repository remains private, so use
the built entrypoint during development.

### CLI behavior

```text
Usage: capdelta --base <ref> [--format text|json]
```

- If `package-lock.json` did not change relative to the base commit, capdelta
  exits `0` with no output and performs no analysis.
- Text is the default format. JSON contains full structured detail.
- A newly added lockfile enters first-run mode: text stays aggregate-only while
  JSON retains every package report.
- Expected package-local failures are reported instead of disappearing.
- Exit `0` means the M1 analysis completed, even when findings were reported.
  Exit `1` means an operational failure; exit `64` means invalid CLI usage.
  Exit `2` remains reserved for future `--strict` incomplete-analysis results
  per PLAN §4.5. Finding-based failure thresholds belong to M2.

Example text finding:

```text
capdelta manifest analysis report
Mode: comparison
Packages: 1 changed; 1 analyzed; 0 unavailable; 0 lockfile skips.
Signals: 1 manifest finding (CRITICAL: 1); 0 lockfile findings; 0 analysis issues; 0 manifest diagnostics.

Findings:
- [CRITICAL] "postinstall" registry install hook added
  Evidence: "package.json":5 — "\"postinstall\": \"echo test\""
```

All evidence includes `file:line` and an escaped, length-bounded snippet.
Report wording asks reviewers to inspect a change; it does not claim malware
was detected.

## How it works

```mermaid
flowchart LR
    A[Git base and head lockfiles] --> B[LockfileDiffer]
    B --> C[Fetch changed tarballs]
    C --> D[Verify lockfile SHA-512 integrity]
    D --> E[Safe static extraction]
    E --> F[Extract package.json capabilities]
    F --> G[Additions-only Differ]
    G --> H[Text or JSON report]
```

The no-op check happens before lockfile parsing or network access. Changed
packages are fetched with bounded concurrency, verified against their lockfile
SRI before parsing, extracted under resource limits, and analyzed without
executing package code. Package-local failures remain visible in the final
summary (“degrade loudly”).

The npm-specific lockfile and manifest implementations sit behind core
contracts so future ecosystems can add adapters without rewriting the Differ
or Reporter.

## Security model

### Adversary

capdelta assumes an attacker can publish a new version of a legitimate npm
package through account takeover, a malicious maintainer, or a compromised
release pipeline. Lockfiles, manifests, tarballs, package names, URLs, and
report snippets are treated as attacker-controlled input.

### Safety controls present in M1

- package code is never imported, evaluated, or executed—not even in tests;
- tarballs are verified against lockfile SHA-512 integrity before parsing;
- extraction rejects absolute paths, traversal, links, unsupported entries,
  invalid npm archive layouts, and resource-limit violations;
- defaults cap tarballs at 50 MiB, extracted entries at 10,000, expanded data
  at 250 MiB, and decompression ratio at 100:1;
- fetching defaults to eight concurrent downloads with a 30-second per-request
  timeout; extraction defaults to four packages concurrently;
- head lockfile symlinks are rejected and lockfile reads are capped at 50 MiB;
- Git is invoked with argument arrays, never through a shell;
- report and terminal strings are escaped and truncated; and
- malformed or unavailable data is reported rather than silently skipped.

Private registries are not authenticated in M1. Non-`registry.npmjs.org`
packages are skipped and flagged.

### Known limitations and evasions

- **No-delta attacks:** behavior that was already present in the baseline is
  not newly reported.
- **Slow-roll attacks:** capabilities can be introduced across several
  apparently modest releases. A committed reviewed baseline is planned later.
- **Manifest-only visibility:** M1 does not detect runtime source behavior,
  obfuscation, dynamic imports, network calls, or filesystem/process access.
- **Script semantics:** M1 reports install-script presence and content changes;
  it does not execute or interpret the command.
- **Registry scope:** private registries, mirrors, git, file, and link
  dependencies are skipped and surfaced as unanalyzed.
- **Single ecosystem and lockfile:** npm v2/v3 only, with one
  current-directory `package-lock.json` per invocation.

These are product limits, not claims that the corresponding attacks are safe.
Please report silent bypasses or unsafe parsing privately through
[SECURITY.md](SECURITY.md).

## Permissions and network access

The M1 CLI needs:

- read access to the checkout, `.git`, and current-directory
  `package-lock.json`;
- temporary-directory write access for bounded extraction; and
- outbound HTTPS access to `registry.npmjs.org`.

It does not need a GitHub token. A GitHub Action is not implemented yet. M2
will document and request only `contents: read` and `pull-requests: write`;
`security-events: write` will not be requested until SARIF exists.

Never work around fork-PR permissions with `pull_request_target` while checking
out untrusted PR code.

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run check:deps
```

Tests use inert handcrafted lockfiles and tarballs. The golden M1 pair changes
from a benign manifest to `"postinstall": "echo test"`; package code is never
run. CI executes the suite on Node.js 20 and 22.

The runtime dependency budget is fewer than 10 direct dependencies. M1 uses
two: `tar` for bounded archive parsing and `jsonc-parser` for exact manifest
evidence locations. The repository CI enforces the direct-dependency budget.

No true-positive/false-positive corpus measurements have been published yet.
The golden fixture verifies end-to-end behavior, not detection accuracy.
Measured and labeled validation is planned before public release.

## Architecture decisions

- [ADR-001: TypeScript](docs/adr/0001-typescript.md)
- [ADR-002: Static-only analysis](docs/adr/0002-static-only-analysis.md)
- [ADR-003: Analyze all changed packages](docs/adr/0003-transitive-all-packages.md)
- [ADR-004: Ecosystem interface boundary](docs/adr/0004-ecosystem-interface-boundary.md)
- [ADR-005: Shape-based severity](docs/adr/0005-shape-based-severity-from-capdiff.md)
- [ADR-006: Preserve old resolved URLs](docs/adr/0006-changedpackage-carries-old-resolved-url.md)
- [ADR-007: Moved-package matching](docs/adr/0007-moved-package-matching-rule.md)
- [ADR-008: Differ emits facts](docs/adr/0008-differ-emits-facts-not-severities.md)
- [ADR-009: Non-npmjs hosts are private](docs/adr/0009-non-npmjs-host-is-private.md)
- [ADR-010: Preflight extraction and reject links](docs/adr/0010-preflight-and-reject-links-in-npm-tarballs.md)
- [ADR-011: Bound extraction resources](docs/adr/0011-bound-npm-tarball-extraction-resources.md)

The authoritative architecture and roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Roadmap

- **M2:** GitHub Action, sticky summary, exit-code policy, adversarial report
  rendering tests, and dogfooding.
- **M3:** JavaScript AST capability analysis and SARIF.
- **M4:** lexical/entropy signals, allowlists, wall-clock budgeting, and fuzzing.
- **M5:** measured validation, publication evidence, and public release work.

## License

Apache-2.0. See [LICENSE](LICENSE).
