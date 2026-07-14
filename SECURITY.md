# Security Policy

capdelta analyzes attacker-controlled input (npm tarballs, lockfiles, package
manifests) by design. Vulnerabilities in capdelta itself — path traversal in
extraction, output injection into PR comments or SARIF, denial of service via
crafted archives, anything that causes package code to execute — are exactly
the bugs this project cares most about. Reports are welcome.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Private Vulnerability Reporting](../../security/advisories/new)
("Report a vulnerability" on this repository's Security tab).

Please do not open public issues for security reports.

## Scope notes

- The threat model, including known evasions capdelta accepts by design
  (no-delta attacks, slow-roll attacks), is documented in the README and
  `docs/PLAN.md` §3. A report that a documented evasion works is expected
  behavior, not a vulnerability — but a way to _silently_ bypass analysis that
  should have degraded loudly is very much in scope.
- capdelta never executes analyzed package code. Any input that achieves code
  execution is a critical vulnerability.

## Supported versions

Pre-1.0: only the latest release receives fixes.
