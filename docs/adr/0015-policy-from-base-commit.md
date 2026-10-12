# ADR-015: Read allowlist policy from the base commit

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §3, §4.4, §4.6

## Context

The Action read `config-path` from the checkout, and workflows check out the
PR head. A pull request could therefore add a `.capdelta.yml` exception that
suppresses its own CRITICAL findings and passes the gate it is meant to face.

## Decision

The Action and the CLI read the allowlist from the selected immutable base
commit, the same one used for the base lockfile, and never parse head content.
The Action uses the PR base SHA or the resolved `base-ref` and reads through the
Contents API; the CLI uses the resolved `--base` commit and reads the Git
object. Both cap the file at 256 KiB:

- Absent at base: no exceptions apply, with a warning.
- Changed by the PR: a warning that those changes do not apply to this run.
- Invalid at base, or any API failure: the run fails; it never falls back to
  an empty or head policy.

Reviewed exceptions are merged first; the dependency PR is then re-run.

## Alternatives rejected

- **Read head config** — lets a PR self-approve its exception.
- **Fail when the base has no config** — would block the PR that introduces
  the first config, and absence cannot weaken the gate.

## Consequences

- The Contents API dereferences a symlink that targets a regular file. The
  base-commit pin, not the entry type, is what keeps the policy trusted.
- The workflow, Action pin, `config-path`, base selection, and threshold must
  themselves be trusted; a PR-controlled workflow is out of scope.
- The CLI follows the same rule: it reads `--config` at the resolved `--base`
  commit (one regular Git blob, literal pathspec, read by object ID) and only
  reports working-tree changes. `--config` is now a cwd-relative repository
  path; absolute and out-of-repository paths are rejected.
