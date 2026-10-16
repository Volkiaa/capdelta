# Diff a lockfile bump and read the text report

When `package-lock.json` differs from a base revision, capdelta fetches the
changed packages' tarballs, compares what their code can do, and prints a text
report before it picks an exit code.

## Sub-features

- `bump-changed` detects that the working-tree lockfile differs from `--base`.
- `bump-report` names each changed package and its added capabilities.
- `bump-exit` exits 1 when a finding reaches the default `--fail-on CRITICAL`.

## How to get to it (user POV)

- Change a dependency and run `npm install --package-lock-only` so only the
  lockfile moves.
- Run `node dist/cli.js --base <ref>` from the directory holding
  `package-lock.json`.

## Driving it with verify-capdelta

Preconditions: `bin/doctor` exits 0, and `CAPDELTA_VERIFY_RUN_ID` is set.

- **Create the bump.** Run `R="$(.claude/skills/verify-capdelta/bin/scenario esbuild 0.0.12 0.0.13)"`. The printed repo has `esbuild` 0.0.13 in the working tree and 0.0.12 at `HEAD`.
- **Diff it.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name diff-default -- --base HEAD`. `<label>.out` contains `Package: "esbuild" ("npm") "0.0.12" -> "0.0.13"` and `[CRITICAL] "postinstall" registry install hook added`; `<label>.exit` is `1`.
- **Read the gate line.** `<label>.err` contains `capdelta: 2 finding(s) at or above CRITICAL (highest: CRITICAL)`.

## Gotchas

- `esbuild@0.0.13` adds `postinstall: node install.js`, so the report has a
  CRITICAL finding. Observed against the real registry on 2026-10-16.
- capdelta fetches only from `registry.npmjs.org`; a non-npmjs host is skipped
  without network access.
- The report is written before the exit code, so a failing gate still leaves a
  full report.
