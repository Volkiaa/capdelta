# ADR-047: Watch a ranked list of packages and skip the rest

- **Status:** Accepted (agent, 2026-10-26, Tier 1 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-26
- **Plan reference:** PLAN §1 (purpose), docs/platform.md, docs/v2-roadmap.md phase 1

## Context

The monitor analyzes every release on the npm change feed. Each feed id costs one packument fetch and, for a new release, one analysis. On the live VPS 1684 of 1690 analyzed releases were outside the 17,338 packages of the `npm-high-impact` list, and none were in its top 5,000. The product exists to catch compromises of established packages (axios, Shai-Hulud). The queue grows faster than a 2-core machine drains it, and most CRITICAL results come from brand-new packages whose previous version was an empty stub.

## Decision

`capdelta-platform monitor --watchlist <file>` analyzes only packages named in the file. The file has one package name per line, ordered by rank (the line number is the rank), with blank lines and `#` comments ignored. The collector checks each feed id against the list before it fetches the packument, so an unlisted id costs no network call. The monitor line reports how many ids it skipped as `unlisted <n>`.

- The reader rejects a file over 1 MiB or 100,000 lines, an invalid package name, and a duplicate name, each with an error that names the line. An empty list is an error. A watchlist that cannot be read stops the monitor; it never falls back to watching everything.
- Without `--watchlist` the monitor behaves as before.
- `analyze` ignores the watchlist: naming a release means the operator wants it.
- `scripts/fetch-watchlist.mjs --top <n> -o <file>` writes the list from the `npm-high-impact` package. It downloads the tarball with `npm pack --ignore-scripts`, reads `lib/top.js` as text, never executes it, and fails if it finds fewer than 1000 names.

A follow-up (priority by rank, and a capped lane for unlisted packages) is tracked in its own issue.

## Alternatives rejected

- **Filter after the packument fetch.** It still pays the fetch for every obscure package, which is most of the cost.
- **A downloads API for the ranking.** npm has no official top-N endpoint, and one request per package does not scale.
- **Lower the severity of stub-baseline releases instead.** An attacker can publish an empty stub first and the payload second. A watchlist changes what is watched, not how a finding is scored.

## Consequences

The monitor does not see brand-new or obscure packages, which is where most typosquats and fresh malware live. That is a deliberate narrowing to the product's purpose and is why the unlisted lane follows. The list ages, so refresh it with the script on a schedule. Revisit when the monitor keeps up with the full feed on its hardware, or when a miss on an unlisted package shows the cost of this choice.

Git: conventional commits, imperative mood, no Co-Authored-By trailer. Never run package code. No new runtime dependency. Every catch recovers or rethrows with context. Keep any comment that states a security reason.
