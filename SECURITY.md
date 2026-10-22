# Security Policy

capdelta analyzes attacker-controlled npm lockfiles, manifests, tarballs,
JavaScript source, package identities, URLs, and report evidence by design.
Vulnerabilities in capdelta itself—unsafe extraction, parser or resource-limit
bypasses, output injection into Markdown/JSON/SARIF, child-process leaks, or
anything that causes package code to execute—are exactly the bugs this project
cares most about.

## Reporting a vulnerability

Report a vulnerability privately through GitHub Private Vulnerability
Reporting at <https://github.com/Volkiaa/capdelta/security/advisories/new>, or
with the **Report a vulnerability** button on the repository's Security tab.
Do not open a public issue or pull request containing security details.

Include the affected commit or version, impact, reproduction steps, and any
suggested mitigation. Inert proof-of-concept inputs are preferred; never submit
a fixture that executes meaningful package code.

## Scope notes

- The threat model and accepted evasions are documented in
  [README.md](README.md#known-limitations-and-evasions) and
  [PLAN §3](docs/PLAN.md#3-threat-model-published-in-the-readme-decisions-recorded-as-adrs).
  A documented limitation is not itself a vulnerability, but a silent bypass
  that should have degraded loudly is in scope.
- capdelta never executes analyzed package code. Any attacker-controlled input
  that achieves code execution is a critical vulnerability.
- Crashes, hangs, unbounded resource use, leaked child processes or temporary
  files, dropped diagnostics, integrity-verification bypasses, and active
  Markdown/HTML/SARIF injection are in scope.

## Verifying a release

Every release carries signed build provenance and an SBOM. See
[docs/security-pipeline.md](docs/security-pipeline.md) for the `gh attestation
verify` command and the controls that protect capdelta's own pipeline.

## Supported versions

The npm package has not been published. Security fixes currently target the
latest commit on `main`. After the first pre-1.0 release, only the newest
published version will receive fixes unless an advisory says otherwise.
