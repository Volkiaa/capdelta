# Edge paths

Three CLI paths sit outside a normal comparison: an unchanged lockfile, a
first-run lockfile with no base, and invalid usage. Each has its own exit code
and output shape.

## Sub-features

- `edge-unchanged` exits 0 with no output and no network access.
- `edge-firstrun` treats an untracked new lockfile as first run.
- `edge-usage` exits 64 for invalid arguments.

## How to get to it (user POV)

- Run `node dist/cli.js --base <ref>` with a lockfile identical to the base.
- Add a lockfile the base commit does not have, or pass an invalid flag.

## Driving it with verify-capdelta

Preconditions: `bin/doctor` exits 0, and the `esbuild` scenario `$R` exists.

- **Unchanged lockfile.** Run `git -C "$R" checkout -- .`, then `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name edge-unchanged -- --base HEAD`. `<label>.exit` is `0` and `<label>.out` is empty.
- **First-run mode.** Run `R3="$(.claude/skills/verify-capdelta/bin/scenario --first-run esbuild 0.0.12 0.0.13)"`, then `.claude/skills/verify-capdelta/bin/drive --repo "$R3" --name edge-firstrun -- --base HEAD`. `<label>.out` holds `Mode: first run (aggregate text; full details are in JSON)`; `<label>.exit` is `1`.
- **Usage error.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name edge-usage -- --base HEAD --format xml`. `<label>.exit` is `64`; `<label>.err` holds `--format must be text or json` and the help text.

## Gotchas

- The unchanged fast path does no parsing, extraction, or network access. An
  empty report is the pass, not a failure.
- First-run mode sets `firstRun: true` in JSON; the base side has no lockfile.
- Usage errors are 64, not 1, including a missing `--base`.
- `drive` returns the CLI exit code, so read `<label>.exit` rather than the shell
  status alone.
