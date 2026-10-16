# ADR-022: Release the Action from CI only, behind an approval, with signed provenance

- **Status:** accepted
- **Date:** 2026-10-16
- **Plan reference:** PLAN §10 ("Own supply chain: pinned lockfile, npm provenance attestations on release, releases from CI only")

## Context

capdelta is consumed as a GitHub Action, and users pin it by commit SHA. Nothing
ships today: there are no tags and no releases, and `package.json` is
`private`. A user who pins a SHA has no way to check that `dist/action/index.js`
at that commit was built by this repository's CI from the reviewed source and
not by a compromised laptop. capdelta exists to catch exactly that kind of
supply-chain attack, so its own releases must be verifiable.

## Decision

1. **Trigger.** A release starts only when a `v*` tag is pushed. The
   `release tags` ruleset lets only repository admins create `v*` tags and
   blocks moving or deleting them.
2. **Verify job, no secrets.** The `verify` job runs with `contents: read`
   only. It checks that the tagged commit is on `main`
   (`git merge-base --is-ancestor`). It runs the full verification, including
   `check:action`, so the committed bundle must match a clean rebuild of the
   tagged source.
3. **Approval gate.** The `release` job needs `verify` and runs in a GitHub
   environment named `release` with one required reviewer, the maintainer. That
   approval is the deploy step, and it happens on GitHub, not on a laptop.
4. **Provenance and SBOM.** The `release` job signs SLSA build provenance for
   `dist/action/index.js` with `actions/attest-build-provenance`. It creates a
   CycloneDX SBOM with `npm sbom` and attests it with `actions/attest-sbom`.
   Signing uses the job's OIDC token (`id-token: write`, `attestations: write`),
   so there is no long-lived signing key to steal.
5. **Release.** The job creates the GitHub release for the tag with the SBOM
   attached (`contents: write`, granted only to this job). Immutable releases
   are enabled in the repository settings, so a published release and its tag
   cannot change.
6. **User verification.** `docs/security-pipeline.md` documents
   `gh attestation verify dist/action/index.js -R Volkiaa/capdelta`, run
   against a checkout of the pinned SHA.
7. **Dogfood.** `capdelta.yml` pins the release commit with a version comment
   (`# v0.1.0`), so Dependabot's `github-actions` updates propose each new
   release as a normal PR.
8. **No npm publish yet.** `package.json` stays `private`. If capdelta is ever
   published to npm, the same `release` job adds `npm publish --provenance` with
   npm trusted publishing through OIDC, so no `NPM_TOKEN` secret exists.

## Alternatives rejected

- **Releasing from a laptop with `gh release create`.** Nothing proves the
  bundle came from the reviewed source, which is the attack capdelta detects.
- **Signing with a stored key (GPG or a cosign key in secrets).** A secret that
  signs releases is the most valuable thing to steal. OIDC-based signing
  leaves nothing to steal.
- **Moving major tags such as `v1`.** A moving tag is the mutable reference
  the README tells users not to pin. Immutable releases forbid it anyway.
- **Publishing to npm now.** Users consume the Action, not the npm package, so
  publishing would add a second artifact to protect without a user who needs
  it.

## Consequences

- Each release needs the maintainer's approval on GitHub. A compromised
  workflow change alone cannot publish, because merging it needs a PR and the
  release needs the approval.
- Users can verify any release commit with one `gh` command.
- An admin account compromise can still create a tag and approve the
  environment. Accepted: hardware-key 2FA on the account is the control, and
  it lives outside this repository.
- Revisit this ADR if capdelta is published to npm (point 8) or gains a second
  maintainer, who should become a required reviewer instead of the author.
