# The gate

The gate turns a report into an exit code. `--fail-on` sets the inclusive
severity threshold, `--strict` returns exit 2 when anything was left unanalyzed,
and the exit codes are 0, 1, and 2.

## Sub-features

- `gate-threshold` fails at or above `--fail-on` (default `CRITICAL`).
- `gate-none` never fails the gate, but operational failures still exit 1.
- `gate-strict` returns exit 2 for unanalyzed content.

## How to get to it (user POV)

- Run `node dist/cli.js --base <ref> [--fail-on severity] [--strict]`.
- Read stdout for the report and the exit code for the verdict.

## Driving it with verify-capdelta

Preconditions: `bin/doctor` exits 0, and the `esbuild` scenario `$R` exists.

- **Exit 1 at the default.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name gate-critical -- --base HEAD`. `<label>.exit` is `1`.
- **Exit 1 at a lower threshold.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name gate-high -- --base HEAD --fail-on HIGH`. `<label>.exit` is `1`.
- **Exit 0 by raising it.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name gate-none -- --base HEAD --fail-on none`. `<label>.exit` is `0`.
- **Exit 2 with unanalyzed content.** Run `R2="$(.claude/skills/verify-capdelta/bin/scenario --offline corp-pkg 1.0.0 2.0.0)"`, then `.claude/skills/verify-capdelta/bin/drive --repo "$R2" --name gate-strict -- --base HEAD --strict`. `<label>.exit` is `2`; `<label>.err` holds `capdelta: strict mode found unanalyzed content`; `<label>.out` holds `[private-registry] "corp-pkg"`.
- **Exit 0 without strict.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R2" --name gate-skip -- --base HEAD`. `<label>.exit` is `0`; the skip stays in the report.

## Gotchas

- The default threshold is `CRITICAL`, so a HIGH-only finding passes by default.
- `--strict` takes precedence over `--fail-on` and over an operational failure,
  and prints its reason to stderr, not to a report section.
- Invalid usage exits 64, not 1. See [Edge paths](./edge-paths.md).
