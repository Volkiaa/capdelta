# ADR-016: Fail the default gate on packages capdelta cannot analyze

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §2 (degrade loudly), §3 (safe extraction limits), §4.2, §4.6 (exit code and `--strict`)

## Context

PLAN §4.6 makes an unanalyzed package an `--strict` concern only, so the
default CRITICAL gate passes it. Our attack reconstructions show what that
allows (`src/core/attack-reconstructions.test.ts`, "documents the
resource-limit boundary"; `docs/m5-2026-10-12/README.md`, "axios with the
dropper over an extraction cap"). If an attacker pads the axios dropper past an
extraction cap, or adds a link entry or an invalid layout, the package is
reported as "unavailable" and the default gate passes it. Every safe-extraction
limit therefore doubles as a way to hide from the default gate.

## Decision

1. **Unanalyzable failures are CRITICAL.**
   - `analysisIssueSeverity` (`src/core/run-severity.ts`) classifies every
     `(stage, kind)` pair exhaustively.
   - A failure whose cause is decided by the artifact bytes or by the lockfile
     entry is **unanalyzable** and gets CRITICAL. The table below lists these
     causes.
   - An unanalyzable result does not claim the package is malicious. It means
     capdelta could not check the package, so a person has to review it. The
     report wording says exactly that.
   - Every other failure keeps severity `null`: environment problems, transient
     network errors and analysis budget stops. These stay `--strict` only for
     now. Making transient fetch failures operational errors (bounded retries,
     then exit 1) is a separate follow-up increment.

   | Stage                     | Kind                                                                                                                                                          | Severity                                          |
   | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
   | fetch                     | `integrity-mismatch`                                                                                                                                          | CRITICAL (unchanged, PLAN §4.2)                   |
   | fetch                     | `size-limit-exceeded`, `invalid-url`, `unsupported-integrity`                                                                                                 | CRITICAL (unanalyzable)                           |
   | fetch                     | `http-status`, `timeout`, `aborted`, `network-error`, `invalid-response`                                                                                      | null (transient or registry; follow-up increment) |
   | old/new-extraction        | `invalid-archive`, `invalid-layout`, `unsafe-path`, `link-entry`, `unsupported-entry`, `file-count-limit`, `expanded-size-limit`, `decompression-ratio-limit` | CRITICAL (unanalyzable)                           |
   | old/new-extraction        | `filesystem-error`, `deadline-exceeded`, `analysis-aborted`                                                                                                   | null                                              |
   | old/new-manifest          | `manifest-missing`, `manifest-too-large`, `manifest-invalid-json`, `manifest-invalid-root`, `identity-mismatch`                                               | CRITICAL (unanalyzable)                           |
   | old/new-manifest          | `manifest-unreadable`, `deadline-exceeded`, `analysis-aborted`                                                                                                | null                                              |
   | old/new-cleanup, analysis | any                                                                                                                                                           | null                                              |

   ADR-019 adds `manifest-not-regular` (a `package.json` that exists but is not a
   regular file) as a further CRITICAL, exceptable manifest kind.

2. **Both sides count.** A failure on the old artifact also prevents the diff,
   so it hides the new version just as well.

3. **One gate count per unavailable package.**
   - `buildRunReport` adds the single highest non-null issue severity of an
     unavailable package to `gateSeverity`, not one count per issue. This way,
     an integrity mismatch together with another failure on the same package
     counts once.
   - Issues of analyzed packages keep their per-issue counting.
   - Every issue keeps its own `severity` field.

4. **Unchanged.**
   - Report schema 5. The `severity` field already means "this issue is a
     severity in its own right" (`src/core/report-contract.ts`).
   - Report-before-exit.
   - `--strict` exit 2 still takes precedence.
   - `--fail-on`.
   - Allowlist entries never suppress analysis issues.

5. **Reporters.**
   - SARIF already emits `CAPDELTA-<KIND>` for every severity-bearing issue.
     Unanalyzable rules get the description "Package could not be analyzed"
     and help text saying capdelta did not inspect the artifact, why the run
     fails, and that the result does not assert malware.
   - Text and PR-comment output label these issues `could not analyze`, which
     keeps them distinct from capability findings.

6. **No escape hatch in this increment.**
   - A benign package that is legitimately oversized, or that ships links, now
     fails the default gate until it is reviewed. The only workarounds for now
     are `--fail-on none` or a skipped run.
   - A follow-up increment adds a reviewed, exact-version exception for
     unanalyzable issues. It is read from the base commit (ADR-015) and has its
     own schema and matching rules. It will never apply to
     `integrity-mismatch`.

## Alternatives rejected

- **Keep it `--strict` only.** Nobody can rely on a default gate that a padded
  tarball bypasses.
- **Fall back to the lockfile's `hasInstallScript`.** The flag is influenced by
  the lockfile and the attacker, and it misses payloads that run on `require`.
- **Raise the caps.** Any finite cap leaves the same bypass, and the caps exist
  for PLAN §3 safety.
- **One CRITICAL per issue.** It double-counts a single package (Codex review,
  2026-10-12).

## Consequences

- The axios-over-cap reconstruction now fails the default gate.
- Benign oversized packages, or packages that ship links, block the gate until
  someone reviews them. M5 found 0 unavailable packages in 90 bumps, but that
  hand-picked corpus doesn't measure this cost (the selection is in
  `docs/m5-2026-10-12/`).
- Lockfile entries with only sha1 integrity, or with non-HTTPS `resolved`
  URLs (old packages, plain-HTTP private registries), now fail the gate. This
  is intended: a PR can produce either one to dodge verification.
- Entries the LockfileDiffer skips (git, file, link, and similar) are
  unchanged by this ADR. They stay in `skipped` and need a separate decision.
- Revisit this ADR if the follow-up exception mechanism does not land, or if
  real repositories hit these failures often.
