# Security of capdelta's own pipeline

capdelta checks other packages for supply-chain attacks, so its own build and
release must resist the same attacks. This page lists each control, what it
stops, and how to check it yourself. The release design is ADR-022.

## Verify a release

Every release bundle carries SLSA build provenance and a CycloneDX SBOM, both
signed through Sigstore with the release job's OIDC identity. To check the
commit you pin:

```bash
git clone https://github.com/Volkiaa/capdelta && cd capdelta
git checkout <the SHA you pin>
gh attestation verify dist/action/index.js -R Volkiaa/capdelta
gh attestation verify dist/action/javascript-parser-worker.js -R Volkiaa/capdelta
```

The Action bundle is two executable files, and both are attested. `index.js`
starts `javascript-parser-worker.js` as a worker thread, so verify both. A pass
means GitHub Actions built and attested that exact file in this repository's
`release.yml` workflow from a `v*` tag. A failure means the file did not come
from a capdelta release. Do not use it.

## Controls

| Stage            | Control                                                                                                   | What it stops                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Repository       | `main` ruleset: PR required, CI on Node 20, 22 and 24 required, linear history, no force push or deletion | Unreviewed or untested code reaching `main`                                        |
| Repository       | `release tags` ruleset: only admins create `v*` tags, nobody moves or deletes them                        | Re-pointing a released version at other code                                       |
| Repository       | Secret scanning with push protection                                                                      | A pushed credential                                                                |
| Repository       | Immutable releases                                                                                        | Swapping a published release's assets                                              |
| Pull request     | Every workflow defaults to `permissions: {}`, and each job asks only for the scopes it uses               | A compromised step using a write token it never needed                             |
| Pull request     | Actions pinned by commit SHA, and Dependabot proposes updates only after a 7-day cooldown                 | A hijacked action tag, or a malicious release pulled before it is caught           |
| Pull request     | `npm ci --ignore-scripts`, and `persist-credentials: false` on every checkout                             | Install scripts running, and later steps reading the checkout token                |
| Pull request     | zizmor on every workflow change                                                                           | Template injection, excessive permissions, unpinned actions, cache poisoning       |
| Pull request     | CodeQL `security-extended` and dependency review                                                          | Known vulnerability patterns in the source, and dependencies with known advisories |
| Pull request     | capdelta reviews its own lockfile changes                                                                 | New capabilities in a dependency bump (the tool's purpose)                         |
| Dependency bumps | The Action bundle is rebuilt in a credential-free container (ADR-021)                                     | Updated dependency code running where credentials live                             |
| Release          | A secret-free verify job checks that the tag is on `main` and that the bundle matches a clean rebuild     | Releasing a commit or a bundle nobody reviewed                                     |
| Release          | The `release` environment requires the maintainer's approval, and only `v*` tags may deploy               | A workflow change publishing on its own                                            |
| Release          | Provenance and SBOM attestations signed with OIDC, with no stored signing key                             | A forged release, and a signing key to steal                                       |

OpenSSF Scorecard scores these practices weekly and on every push to `main`.
See the badge in the README.

## Known gaps

- One maintainer means no second reviewer. The `main` ruleset requires a PR
  but zero approvals, and the release approval comes from the same person.
- An admin account compromise can create a tag and approve the release.
  Hardware-key 2FA on that account is the control, outside this repository.
