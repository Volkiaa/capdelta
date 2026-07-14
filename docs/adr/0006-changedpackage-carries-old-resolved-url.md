# ADR-006: ChangedPackage carries the old resolved URL; unfetchable baselines get newly-added treatment

- **Status:** accepted
- **Date:** 2026-07-14
- **Plan reference:** PLAN §4.1 (contract), §4.2 (Fetcher)

## Context

PLAN §4.1 defines the contract tuple with only the new version's tarball URL,
but §4.2 requires the Fetcher to download old AND new tarballs. Review of the
LockfileDiffer found two depth problems: (1) the differ holds the old entry's
`resolved` URL and then drops it, forcing the Fetcher to reconstruct registry
URLs from name+version — fragile for scoped packages, aliases, and any
non-canonical URL; (2) analyzability was assessed for the new side only, so a
package whose old side was git/file/link/private could be emitted with an
oldVersion baseline the Fetcher cannot actually obtain.

## Decision

Two amendments to the §4.1 contract, implemented together:

- `ChangedPackage.oldResolvedUrl: string | null` is added. The Fetcher never
  reconstructs a URL.
- The baseline must itself be fetchable (registry-hosted, integrity and
  resolved present). When it is not, all old-side fields are null as a unit
  and the package receives the newly-added full-report treatment (§4.1) —
  over-reporting, never a baseline the Fetcher cannot honor. Invariant:
  `oldResolvedUrl` is non-null exactly when `oldVersion` is.

## Alternatives rejected

- **Reconstruct old tarball URLs in the Fetcher** — reintroduces a bug class
  (scoped-name paths, aliases) that passing the string through eliminates.
- **Emit unfetchable baselines and let the Fetcher skip them** — pushes a
  classification the differ already computes into a component with less
  information, and splits the §4.1 "newly added" decision across two layers.

## Consequences

- The contract deviates from the literal §4.1 tuple by one field; this ADR is
  the record required by the working agreement.
- A same-version package whose old entry merely lacked integrity is reported
  as newly added rather than as a delta — accepted over-report, consistent
  with the general rule above.
