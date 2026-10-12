# ADR-013: Analyze npm tarballs with npm's strip-one layout

- **Status:** proposed (awaiting maintainer approval; amends ADR-010)
- **Date:** 2026-10-12
- **Plan reference:** PLAN §3 (safe extraction, evasions), §4.2

## Context

ADR-010 required every archive entry to sit under `package/`, and the path
check rejected the trailing `/` of Directory entries. npm does neither: pacote
extracts with `strip: 1` from any top-level directory, and node-tar drops
top-level files. Real `@types/*` tarballs (root `node/`, explicit directory
entries) were therefore unanalyzable. An attacker could also root a malicious
version at `x/`: npm installs it and runs its hook, while capdelta reported it
unavailable and the default CRITICAL gate passed.

## Decision

Map every entry exactly as npm installs it, and keep every safety check:

- Validate the raw path before stripping: no NUL, backslash, absolute path, or
  empty, `.`, or `..` segment. Only a Directory entry may end in one `/`,
  removed before that check.
- Strip one leading component from every entry, whatever its name. Mixed roots
  merge into one tree in archive order, so a later file replaces an earlier one
  at the same installed path.
- Never write Directory headers, as pacote filters them out; node-tar creates
  parent directories for files. Otherwise a later `b/index.js/` header would
  replace an installed `index.js` and its code would go unanalyzed.
- Reject an entry whose stripped path is absolute or drive-qualified
  (`x/C:/package.json`), stricter than pacote's normalization.
- A bare root directory and a top-level file have no installed path: they are
  validated and counted against the caps, then never written. An archive with
  no installed files stays rejected as `invalid-layout`.
- Manifest-only extraction keeps every entry whose installed path is
  `package.json`, in archive order, so it reads the same final manifest as a
  full extraction. A top-level `package.json` is never the manifest.
- Links, unsupported entry types, the preflight-before-write boundary, and all
  resource caps are unchanged.

## Alternatives rejected

- **Keep the `package/` rule** — rejects archives npm installs, which turns a
  safety rule into a gate bypass.
- **Allow any single root, reject mixed roots** — npm accepts mixed roots, so
  the rejection would leave the same bypass with one more step.
- **Reject colliding installed paths** — npm accepts them (last wins), so this
  would also be a bypass.

## Consequences

- `@types/*` and other non-`package/` tarballs are analyzed, and the `x/`-rooted
  evasion fails the gate (test: `attack-reconstructions.test.ts`, layout
  evasion).
- Collision semantics were checked offline against pacote 21.5.1 with tar
  7.5.19 for ordinary files and for directory headers shadowing files; other
  conflicts are not claimed to be npm-equivalent.
- capdelta still rejects some archives npm tolerates (for example any link
  entry, over-cap archives). Those stay unavailable and pass the default gate
  unless `--strict` is set; that residual limit is documented in the README.
- Revisit if pacote or node-tar change their strip or filter behavior.
