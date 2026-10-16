# Allowlist and config

A `.capdelta.yml` allowlist suppresses a reviewed finding so it stops failing the
gate. capdelta reads it from the base commit, never from the working tree, so a
change under review cannot approve its own exception.

## Sub-features

- `allow-match` suppresses a finding by package and capability.
- `allow-visible` keeps the finding in the report, marked `suppressed`.
- `allow-base` reads policy from the `--base` commit, not the working tree.

## How to get to it (user POV)

- Add an `allowlist:` entry to `.capdelta.yml` with a justification, and merge it.
- Run `node dist/cli.js --base <ref>` on the dependency change.
- Point at another path with `--config <path>`.

## Driving it with verify-capdelta

Preconditions: `bin/doctor` exits 0. The base commit carries the allowlist and
the old lockfile. Write the allowlist file into the evidence directory, so the policy used stays with the proof:

```sh
A="${CAPDELTA_VERIFY_EVIDENCE:-$HOME/.local/state/capdelta-verify}/$CAPDELTA_VERIFY_RUN_ID/husky-allow.yml"
mkdir -p "$(dirname "$A")"
cat > "$A" <<'YML'
allowlist:
  - package: husky
    capability: new-external-endpoint
    justification: "docs link verified"
YML
```

- **Build the bump.** Run `R="$(.claude/skills/verify-capdelta/bin/scenario --base-config "$A" .capdelta.yml husky 5.0.9 5.1.0)"`.
- **See it suppressed.** Run `.claude/skills/verify-capdelta/bin/drive --repo "$R" --name allow-default -- --base HEAD --fail-on HIGH`. `<label>.exit` is `0`; `<label>.out` holds `"new external domain typicode.github.io" (suppressed ("docs link verified"))`.
- **Reach it with `--config`.** Build a second scenario with `--base-config "$A" cfg/policy.yml husky 5.0.9 5.1.0` and run `drive --name allow-config -- --base HEAD --fail-on HIGH --config cfg/policy.yml`. Same suppression, exit `0`.
- **Prove base-commit reading.** Edit `.capdelta.yml` in the working tree only. The run warns that the file differs from base and uses the base version, so suppression does not change.

## Gotchas

- `husky@5.1.0` adds a HIGH `new-external-endpoint` finding (`typicode.github.io`), which the allowlist can suppress. Observed 2026-10-16.
- The capability must be an allowlisted name such as `INSTALL_HOOK`, `NET`, or a
  signal kind like `new-external-endpoint`.
- An absent allowlist at base means no exceptions, with a warning. An invalid one
  at base fails the run. Neither falls back to head policy.
