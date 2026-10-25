# GitHub Action

`dist/action/index.js` is the bundle named by `action.yml`. The runner sets
`INPUT_*`, a pull_request event file, a workspace, a step summary file, and an
output file. The Action lists the PR files, reads the base lockfile through the
Contents API, analyzes the bump, uploads the JSON report as an artifact, uploads
SARIF when the token allows it, and publishes one sticky comment.

## Expected behavior

- When the token cannot write the PR comment, GitHub answers 403 with
  `Resource not accessible by integration`. The Action warns, names
  `pull-requests: write`, writes the same Markdown to the step summary, and
  leaves the gate in charge of the exit code.
- A `confirmed-malicious` intelligence finding for the changed package adds one
  CRITICAL `intel-confirmed-malicious` lockfile finding. With `fail-on` at
  `CRITICAL`, the job fails, `status` is `failed`, and the summary table names the
  kind. The failure annotation names the finding count and threshold, not the
  kind.
- A `retracted` finding adds nothing. The job passes and the report has no
  `intel-confirmed-malicious` entry.
- `status` is `passed` or `failed` in `GITHUB_OUTPUT`.

## Drive

Preconditions: `npm run build` and `npm run package:action` after any change
under `src/`, plus network access to `registry.npmjs.org`. The drive makes no
request to GitHub. It starts a local stand-in for the GitHub REST API and the
artifact service, and a real `capdelta-platform serve` with one seeded finding.

```sh
.claude/skills/verify-capdelta/bin/action-drive
```

It prints one line per case with the observed and expected exit code, `status`
output, summary presence, and intelligence finding kind, and exits 1 on any
mismatch. Evidence lands in `<evidence dir>/<run-id>/action/`:

- `<case>.stdout`, `.stderr`, `.exit`, `.output`, `.summary.md`, `.cmd`
- `<case>.artifact.json` is the JSON report the real bundle uploaded.
- `<case>.server.log` records every stand-in request and status. The comment
  write must show 403.
- `service.log` is the platform service log.

Cases: `summary-fallback`, `intel-confirmed`, `intel-retracted`.
`ACTION_DRIVE_PORT` changes the stand-in base port (default 18812) and
`ACTION_DRIVE_SERVICE_PORT` changes the platform port (default base + 10).

## What the stand-in does not prove

The stand-in answers with one changed file, the base lockfile, a 202 for SARIF,
a 403 for the comment write, and a fixed artifact ID. The real bundle runs
unmodified, so its exit code, annotations, outputs, and summary come from its
own code. The stand-in cannot prove that GitHub accepts the SARIF payload,
renders the comment, deduplicates the sticky comment, or stores the artifact.
Those checks need a hosted runner.

An empty `github-token` cannot reach the summary fallback. `core.getInput` fails
first and the bundle exits 1 with
`Input required and not supplied: github-token`. The drive proves the refusal
path a token without `pull-requests: write` takes.

The fork path (`headRepository != baseRepository`) is not driven. It calls the
same summary fallback with reason `fork` and skips SARIF.
