# ADR-021: Rebuild the Action bundle in a credential-free sandbox

- **Status:** Accepted
- **Date:** 2026-10-16
- **Plan reference:** none (build tooling, outside PLAN)

## Context

The Action bundle in `dist/action` is committed and shipped. A dependency bump
that changes the bundle leaves it stale, so `check:action` fails and someone has
to rebuild it. Running `npm ci`, the build, and the tests on the host runs the
updated dependency code with the developer's credentials, where that code can
read the checkout, an npmrc or an SSH key. `scripts/package-action-sandboxed.sh`
rebuilds the bundle in a Docker container that holds no credentials and never
sees the checkout. This ADR records that threat model.

## Decision

1. **A container with no credentials and no mount.** The rebuild runs in a
   Docker container that holds no credentials and never sees the checkout. No
   host path is mounted and no host environment variable is passed, so the named
   volume is the only writable place the container sees. The container gets a
   `git archive HEAD` stream, not a mount of the working tree.
2. **What the container cannot do.** It cannot read an ignored secret such as
   `.env` or `.git/config`, plant a file under `node_modules/` or `dist/` that
   the host runs later, overwrite an existing ignored file such as `.envrc`, or
   leave a file behind. The host checkout stays untouched until `import_bundle`
   validates the archive and replaces only `dist/action`.
3. **The import checks an allowlist, not a name rule.** `import_bundle` takes
   the expected file set from the files tracked under `dist/action` in the
   destination repository, then accepts a member only if it is a regular file on
   that list or a directory that leads to one. A rule based on names alone would
   let a bundle carry `dist/action/HEAD` and `dist/action/config`, which turns
   the directory into a bare repository whose config (`core.pager`, `alias.*`)
   would run the next time git is used inside it. The tracked names are compared
   as literal strings, never as patterns.
4. **The bundle is capped at 50 MiB.** The rebuilt tree is a few hundred KiB, so
   the cap only stops a runaway or hostile container from filling the host disk.
   The stream is cut off one byte past the cap and rejected before any parsing.
5. **Cleanup runs on every exit path.** The named volume and the temp directory
   are removed on success and on failure, so a planted volume or bundle never
   outlives the run.
6. **The image is the full `node:22-bookworm`, pinned by digest.** The slim
   variant has no git, and the test suite runs real git in throwaway
   repositories, so the full image lets the script install nothing at run time.
7. **The script never commits or pushes.** It prints the `dist/action` diff, and
   a person reviews it, then commits and pushes by hand.

## Alternatives rejected

- **Rebuild on the host.** The updated dependency code runs with the
  developer's credentials.
- **Mount the checkout into the container.** The container could read ignored
  secrets and write files the host later runs.
- **Accept members by name alone.** A `dist/action/HEAD` and `dist/action/config`
  pair makes the directory a bare repository whose config git would run later.
- **Leave the bundle uncapped.** A runaway container fills the host disk.

## Consequences

- The updated dependency code runs only in the container, so it cannot reach a
  host token, npmrc or SSH key.
- The checkout changes only under `dist/action`, and only after `import_bundle`
  validates the bundle. A rejected bundle leaves the checkout unchanged.
- A dependency bump that adds or removes a file under `dist/action` is rejected,
  and a person rebuilds that case by hand.
- The install step needs the network. The rebuild and the checks run with no
  network.
- Revisit when the pinned image digest needs updating, or when the allowlist
  rule has to accept a different bundle layout.
