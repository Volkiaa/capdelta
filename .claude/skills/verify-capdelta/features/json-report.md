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
- `gateSeverity` counts only unsuppressed severity-bearing findings, so an
  allowlist can zero it while the finding stays in the report.
- Use `--fail-on none` when you want the JSON even though the gate would fail.
