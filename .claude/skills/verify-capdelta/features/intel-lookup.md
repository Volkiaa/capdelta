# Intelligence lookup

`--intel-url` (and the Action input `intel-url`) asks a platform service whether a
reviewer confirmed a changed artifact as malicious. ADR-041 is the design and
`docs/platform.md` ("Consumers") is the operator view.

## Expected behavior

- Only the sha512 digest leaves the machine. Names, versions and the lockfile do not.
- A `confirmed-malicious` finding for the exact ecosystem, name, version and digest
  adds one CRITICAL `intel-confirmed-malicious` lockfile finding. With `--fail-on
CRITICAL` the exit code is `1`.
- `suspected`, `under-review`, `benign` and `retracted` findings add nothing.
- An unreachable, slow or malformed service prints a warning on stderr and gives the
  same report and exit code as a run without the flag. The gate never gets looser.
- A malformed URL exits `64`. Plain http is accepted only for localhost, 127.0.0.1
  and `[::1]`.
- The setting is not read from `.capdelta.yml` (ADR-015).

## Drive

One command runs the whole matrix against a real `capdelta-platform serve`, with
is-odd 3.0.0 to 3.0.1 as the bump. It needs the network and a fresh `npm run build`.

```sh
.claude/skills/verify-capdelta/bin/intel-drive
```

It prints one line per state (no flag, suspected, confirmed, retracted, service down,
bad URL) with the observed and expected exit code and finding kinds, and exits 1 on
any mismatch. Evidence lands in `<evidence dir>/<run-id>/intel/`, including
`service.log`. `INTEL_DRIVE_PORT` changes the port (default 18811).

## Not covered

The Action path. `src/action/run-action.ts` has unit tests for the same wiring, and
`dist/action/` must be rebuilt (`npm run package:action`) after any core change.
