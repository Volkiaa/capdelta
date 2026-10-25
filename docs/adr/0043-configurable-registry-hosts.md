# ADR-0043: Let projects name extra registry hosts

- **Status:** Proposed
- **Date:** 2026-10-25
- **Plan reference:** PLAN §2, §4.1, §4.4

## Context

ADR-009 makes the differ treat every `resolved` host other than
`registry.npmjs.org` as private: it skips the package, reports the host, and
analyzes nothing. A team that installs through an internal mirror therefore
gets most of a dependency bump skipped, and `--strict` fails on content the
tool could have fetched. ADR-009 left an allowlist for later, driven by real
demand. This is that change, taken as a Tier 3 draft because it narrows what
the `private-registry` detection matches and reads a new allowlist from base
policy.

## Decision

Add one top-level key to `.capdelta.yml`:

```yaml
registry-hosts:
  - npm.corp.example.com
```

Each entry is one exact DNS host. The parser lowercases the value and accepts
it only when all of these hold:

- it has no scheme, port, credentials, path, query, fragment or wildcard;
- it contains only lowercase letters, digits, dots and inner hyphens;
- `new URL("https://" + value).host === value`, so an IDN spelling that
  normalizes to punycode is rejected;
- it does not embed `registry.npmjs.org` unless it is exactly
  `registry.npmjs.org`.

The list is capped at 32 entries. `registry.npmjs.org` is always in the
resulting set, even when the config lists no hosts or lists another host only.
Duplicate entries fail the parse. As with the allowlist, an invalid base config
fails the run rather than falling back.

`diffNpmLockfiles` takes an optional `{ registryHosts }` and replaces the
`host !== "registry.npmjs.org"` test with a membership test in the configured
set. A two-argument call keeps the old behavior. The CLI passes
`config.registryHosts` to the differ. The Action passes the same set to the
analysis diff and to its separate intelligence diff, so a package cannot be
matched by intel while being skipped by analysis. Both read the config from the
selected base commit under ADR-015.

## Security argument

Origin pinning is kept. The allowlist changes which hosts the differ accepts,
and it matches the exact `new URL(resolved).host` string. There is no suffix,
prefix or wildcard rule, so `registry.npmjs.org.evil.com` is a different host
and stays skipped unless it is named literally, which the config validator
refuses as a look-alike. Base policy cannot drop npmjs because the differ adds
`registry.npmjs.org` to every set it builds.

SRI is kept. An allowlisted host goes through the existing fetcher unchanged:
HTTPS is required and the download must match a canonical sha512 SRI token from
the lockfile. A tampered tarball is an `integrity-mismatch`, which stays
CRITICAL. The allowlist also does not bypass extraction caps or the manifest
checks.

Policy comes from the base commit per ADR-015. A pull request cannot add its
own mirror to make capdelta fetch from an attacker-controlled host, just as it
cannot add its own exception. The Action reads the file through the Contents
API at the base SHA, the CLI through the Git object at the resolved `--base`
commit, and both cap it at 256 KiB.

The additive rule means the change can never reduce the set of hosts analyzed
relative to base policy that does not mention it. With no config the behavior
is the ADR-009 behavior.

Known gap, unchanged: `fetch` follows redirects because the fetcher passes only
`signal`, so host pinning covers the initial URL, not a redirect target.
Adding `redirect: "error"` is a separate, stricter change for all hosts.

## Alternatives rejected

- **Fail every non-npmjs skip as a CRITICAL unanalyzable issue.** Stricter only,
  so it would be Tier 2, but it does not let mirror users analyze anything. It
  turns a loud skip into a blocking failure for every mirror in use, and the
  ADR-016 exception path cannot release a host capdelta never tried to fetch.
- **Match by suffix or wildcard (`*.corp.example`).** A suffix rule widens what
  the detection matches and makes the trust decision depend on DNS labels the
  config does not name. Exact hosts keep each entry reviewable.
- **Read `registry-hosts` from the PR head.** A pull request could point
  capdelta at a host it controls. ADR-015 already rejects this for policy.
- **A built-in list of public mirrors.** Trusting a mirror is a security
  decision for the project that uses it, not one capdelta makes silently. This
  is the reason ADR-009 gave for deferring the allowlist.

## What to measure

- With no config, the held-out corpus and every golden fixture must keep the
  same `gateSeverity`. Run `scripts/m5-measure.ts run <corpus> <out>` before and
  after; the default path is expected to be identical because the set is still
  exactly `registry.npmjs.org`.
- On a repository that adopts a mirror, count packages that move from
  `skippedLockfileEntries` to `analyzedPackages`, new findings by severity, and
  new gate failures. The cost to watch is ordinary capability findings for
  mirror packages, not host matching.
- Track fetch volume and wall time for a mirror adoption, since more packages
  are downloaded and extracted.
- Track the rate of invalid configs after rollout. A rejected host fails the
  run, so a missed normalization during migration is a build break, not a
  silent skip.

## Evidence (2026-10-25)

- Held-out corpus, `docs/heldout-2026-10-20/corpus-heldout.json`, main versus this branch with no config: 45 pairs, 0 rows different, 0 pairs failing the default gate.
- Full verification passes (1391 tests, check:deps, check:action). The Action bundle is rebuilt.
- Codex security review: APPROVE.
- Not measured: a repository that adopts a mirror. No mirror was available.

## Consequences

- Teams behind a mirror can analyze those packages. The `private-registry` flag
  stays for every host they do not list.
- Mirrors that use a non-default port or a path-based registry API cannot be
  listed. Those entries still skip and still need `--strict` to fail the run.
- A malicious lockfile can still name a permitted host with a valid SRI for
  attacker bytes. The allowlist does not defend against a compromised mirror,
  only against widening which origins are contacted.
- The setting is another base-commit policy file surface to review. It is
  documented in `docs/cli.md` and `docs/github-action.md`.

## Revert

Revert the commits that add `registryHosts` to `CapdeltaConfig`, the
`registry-hosts` parser section, the differ option and the two Action call
sites. The default path does not depend on the new code, so reverting restores
ADR-009 exactly. After a revert, a config that still contains `registry-hosts:`
fails to parse. Announce the removal before deploying it to repositories that
adopted the key.
