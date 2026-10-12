# ADR-015: Read allowlist policy from the base commit

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan reference:** PLAN §3, §4.4, §4.6

## Context

The Action read `config-path` from the checkout, and workflows check out the
PR head. A pull request could therefore add a `.capdelta.yml` exception that
suppresses its own CRITICAL findings and passes the gate it is meant to face.

## Decision

The Action reads the allowlist from the same immutable base commit as the base
lockfile (the PR base SHA, or the resolved `base-ref`), through the Contents
API with a 256 KiB cap. It never reads or parses head content:

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
- The CLI still reads the working tree; moving it to the base commit is the
  next increment.
