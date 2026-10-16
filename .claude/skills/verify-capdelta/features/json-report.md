# JSON report

`--format json` prints the machine-readable report, including
`summary.gateSeverity`, the per-severity counts the gate reads.

## Sub-features

- `json-summary` counts changed, analyzed, unavailable, and skipped packages.
- `json-gate` reports `summary.gateSeverity` per severity.
- `json-firstrun` keeps every package report in first-run mode.

## How to get to it (user POV)

- Run `node dist/cli.js --base <ref> --format json` from the lockfile directory.
- Pipe the output to a JSON parser for assertions.

## Driving it with verify-capdelta

Preconditions: `bin/doctor` exits 0, and the `esbuild` scenario from
[Diff a lockfile bump](./diff-lockfile-bump.md) exists.

- **Emit JSON.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name json-default -- --base HEAD --format json`. `<label>.exit` is `1`.
- **Check the gate counts.** Parse `<label>.out`: `summary.gateSeverity` is `{"CRITICAL":2,"HIGH":0,"MEDIUM":1,"LOW":1,"INFO":0}` and `summary.capabilityFindings` is `4`.
- **Report only.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name json-none -- --base HEAD --format json --fail-on none`. `<label>.exit` is `0` with the same report.

## Gotchas

- Text output truncates evidence; use `--format json` for assertions.
- `gateSeverity` counts unsuppressed severity-bearing findings, lockfile
  findings, severity-bearing analysis issues, and each unavailable package once
  at its highest severity. An allowlist can zero a finding's count while the
  finding stays in the report.
- The JSON is printed even when the gate fails. `--fail-on none` changes only
  the exit code, from 1 to 0.
