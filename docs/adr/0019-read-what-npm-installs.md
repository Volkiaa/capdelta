# ADR-019: Read what npm installs, and fail on every unread package

- **Status:** accepted
- **Date:** 2026-10-13
- **Plan reference:** PLAN §2 (degrade loudly), §3 (safe extraction), §4.2; ADR-016, ADR-017, ADR-018

## Context

Codex's review of the finding-guidance PRs on 2026-10-13 found three related gaps. The source citations are at main
ed8f55e.

1. **Archive modes reach disk.** Extraction passes `chmod: false` (src/core/npm/safe-extractor.ts:297), but node-tar
   still creates each file with the archive entry's mode (node_modules/tar/dist/esm/unpack.js:401). A file stored
   with mode 000 cannot be read by an unprivileged runner, and GitHub Actions runners are unprivileged.
   - **Manifests:** an unreadable `package.json` becomes `manifest-unreadable`, which has severity `null`
     (src/core/npm/manifest-capability-extractor.ts:282-285, 305-314; src/core/run-severity.ts:255-258). The default
     gate passes.
   - **Source:** an unreadable `.js` file becomes an `unreadable` signal input (src/core/npm/
     javascript-capability-extractor.ts:148-160). At most that is a MEDIUM `unparseable-file` signal
     (src/core/signal-differ.ts:82). The code itself is never analyzed.
   - npm installs such files readable anyway. In its tar filter, pacote sets every entry's mode to
     `((mode | fmode) & ~umask) | exe | 0o600` (npm/pacote lib/fetcher.js, `#entryMode`, checked 2026-10-13). The
     hidden code therefore still runs after install. This is a detection evasion that the package's own bytes
     control.
2. **A non-regular `package.json`.** A regular entry `package/package.json/child.js` turns `package.json` into a
   directory. lstat rejects it as `manifest-unreadable` (manifest-capability-extractor.ts:267-274). The bytes decide
   this, but it has severity `null`.
   - This reaches the old side through full extraction (src/core/capability-analysis-pipeline.ts:800-808, 971-974).
   - On the new side, the manifest-only pass already yields CRITICAL `manifest-missing` (safe-extractor.ts:313-316).
3. **Residual environment failures pass.**
   - `filesystem-error` means an extraction failure followed by a failed cleanup (safe-extractor.ts:177-199). Ordinary
     OS errors already become CRITICAL `invalid-archive` (:415-431).
   - Together with any `manifest-unreadable` that survives (1) and (2), it leaves a package unavailable, yet a run
     without `--strict` exits 0 (src/cli/run-cli.ts:94-106). That is fail-open against PLAN §2.
   - ADR-018 listed only fetch exhaustion and stops.

## Decision

1. **Normalize file modes during extraction.**
   - Every extracted file entry requests mode `0o600`, whatever the archive declares. Directories stay as they are
     today, created by node-tar under the private 0o700 root.
   - It is done in the existing tar `filter`, before node-tar writes the entry, by setting `entry.mode`. This is the same mechanism pacote uses.
   - capdelta never executes package code, so no execute bit is needed. Setuid, setgid and sticky bits never reach
     disk.
   - Effect: archive-controlled unreadability and special bits are gone under normal runner permissions. The kernel still applies the process umask, and environmental permission failures (an owner-masking umask, ACLs, filesystem faults) remain possible; Decision 3 makes those fail the run. capdelta does not change `process.umask`.
2. **New CRITICAL manifest kind `manifest-not-regular`.**
   - It covers a `package.json` path that exists but is not a regular file, split out of `manifest-unreadable`.
   - It is a post-verification failure decided by the bytes, so ADR-017 reviewed exceptions can cover it, bound to the
     exact bytes. It joins `EXCEPTABLE_UNANALYZABLE_KINDS` (src/core/run-severity.ts:53-71).
   - It gets its own finding guidance through the existing `unanalyzable` class.
3. **Residual failures are operational.** `filesystem-error` at the extraction stages and `manifest-unreadable` at the
   manifest stages become operational in `isOperationalFailure` (src/core/run-severity.ts:314), through
   stage-specific branches. `isStopKind` keeps meaning deadline or cancellation only.
   - ADR-018's rules apply: exit 1 after the report is delivered, including with `--fail-on none`; `--strict` exit 2
     takes precedence; each package counts once.
   - Both kinds stay at severity `null` and are outside the exception mechanism. An exception may still cover a
     concurrent CRITICAL failure on the same package, but cannot suppress the operational exit 1.
4. **Message.** The shared operational message becomes `capdelta: N package(s) could not be fetched or analyzed`,
   dropping "before the run ended" (run-severity.ts:306).
   - README.md:188-189 is updated.
   - ADR-018 gets a "superseded in part by ADR-019" note on that line rather than a rewrite.
5. **Unchanged:**
   - `cleanup-failed` after a successful analysis stays a warning.
   - M5's `gateFail` stays severity-only (scripts/m5-measure.ts:104-111). Its docs say so, and the frozen
     docs/m5-2026-10-12/ is not edited.

## Alternatives rejected

- **Treat `manifest-unreadable` as CRITICAL.** An EACCES from an ACL or a broken runner is environmental. Charging it
  to the package would let a reviewer "accept" an environment fault. Normalizing modes removes the byte-decided case
  instead.
- **Fix only the manifest.** A mode-000 `.js` file hides code the same way, and normalizing modes fixes both at once.
- **Leave it `--strict`-only.** The default gate passes an uninspected package.

## Consequences

- Severity counts and `gateSeverity` change only for packages that hit `manifest-not-regular`, which were previously
  severity-null. Existing golden fixtures and reconstructions are checked rather than assumed unchanged.
- A new reconstruction, a defanged package with a mode-000 `package.json` and `.js` file, must fail the default gate
  on a non-root runner.
- A broken runner now fails runs instead of passing them.
  - Retrying can fix transient environment faults.
  - The finding guidance for these null-severity issues is not shown in text or comment output. Only the operational
    stderr message and exit 1 are.
- The Action bundle is rebuilt.
- Revisit if a `filesystem-error` cause turns out to be decided by the bytes. Map it to a dedicated CRITICAL
  extraction kind.

## Validation

- Mode-000 file and manifest, extracted on both sides and readable afterwards, with on-disk mode 0o600.
- Setuid and setgid are stripped.
- `package.json` as a directory → `manifest-not-regular`, CRITICAL, exceptable.
- Operational exit for `filesystem-error` and `manifest-unreadable` on both sides, including:
  - `--fail-on none`;
  - a mixed CRITICAL-plus-operational package;
  - a matching exception;
  - strict precedence;
  - one count per package;
  - a cleanup-only warning.
- Exact message consumers: run-severity.test.ts:380, run-cli.test.ts:472, run-action.test.ts:357.
- Finding-guidance null expectations: finding-guidance.test.ts:111-112, 247-251.

## Delivery

Three PRs, in order. Each is one component plus its tests, and each gets a Codex security review.

1. Mode normalization in safe-extractor.ts, plus the reconstruction (closes the evasion).
2. `manifest-not-regular`.
3. Operational classification and the message.
