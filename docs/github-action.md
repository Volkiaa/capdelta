# GitHub Action reference

This page documents every input, output, and step of the capdelta GitHub Action. Back to the [README](../README.md).

## Action inputs

| Input           | Default               | Behavior                                                                    |
| --------------- | --------------------- | --------------------------------------------------------------------------- |
| `github-token`  | `${{ github.token }}` | Reads base contents, comments, and uploads reports                          |
| `lockfile-path` | `package-lock.json`   | One repository-relative npm lockfile                                        |
| `fail-on`       | `CRITICAL`            | Inclusive threshold: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`, or `none` |
| `base-ref`      | PR base SHA           | Optional base Git ref override                                              |
| `config-path`   | empty                 | Optional `.capdelta.yml` path, read from the base commit, not the PR head   |
| `strict`        | `false`               | Fails the Action when any changed content remains unanalyzed                |

Outputs are `status` (`no-op`, `passed`, or `failed`), `artifact-id`,
and `highest-severity`.

The Action:

1. takes the no-op path when the configured lockfile did not change;
2. retrieves the base lockfile through the GitHub Contents API at an immutable
   base commit;
3. uploads the complete schema-v5 JSON report as the `capdelta-report`
   artifact; `summary.gateSeverity` holds exactly what `fail-on` evaluates
   (unsuppressed findings, lockfile findings, and integrity mismatches), while
   `summary.bySeverity` keeps every capability and signal finding, suppressed
   ones included;
4. uploads SARIF 2.1.0 to code scanning when permissions permit; tarball
   integrity mismatches appear as `CAPDELTA-INTEGRITY-MISMATCH` results located
   at the configured `lockfile-path`, with no line, since the package itself
   was not analyzed;
5. creates or updates one 60,000-character-capped sticky summary comment; and
6. applies `fail-on` only after report delivery, and fails the job for an
   operational failure (ADR-018) even under `fail-on: none`.
