# ADR-039: Keep severity, confidence and verdict apart in shared intelligence

- **Status:** Accepted (agent, 2026-10-24, under the maintainer's v2 grant; the consumer part is Tier 2)
- **Date:** 2026-10-24
- **Plan reference:** PLAN §2 (degrade loudly), ADR-038, `docs/v2-roadmap.md` phase 3

## Context

Phase 1 stores one analysis record per release. Phase 3 lets one analysis
protect many projects, so a finding needs an identity, a lifecycle and a
reviewer. A CRITICAL capability change is not proof of malware (roadmap
"Non-negotiable principles"). A feed that blocks installs on analyzer output
alone would turn every false positive into an outage for every consumer.

## Decision

1. **Three fields.** A finding has `severity` (what the behavior can do, from
   the analyzer), `confidence` (`low`, `medium`, `high`, from the analyzer or a
   reviewer) and `verdict` (what a person decided). They never derive from one
   another.
2. **Verdict states.** `suspected`, `under-review`, `confirmed-malicious`,
   `benign`, `retracted`. The analyzer creates findings as `suspected` and can
   never set another state.
3. **Allowed transitions.** `suspected` to `under-review` or `benign`.
   `under-review` to `confirmed-malicious` or `benign`. `confirmed-malicious`
   to `retracted`. `benign` to `under-review`. `retracted` to `under-review`.
   Every other transition is rejected.
4. **Validation gate.** Only a transition to `confirmed-malicious` carries a
   validation: a reviewer identity other than `analyzer`, a method string, and
   at least one evidence reference that exists in the finding's evidence list.
   A transition without it is rejected by the model, not by the API layer.
5. **Stable identity.** `id` is `CDI-` plus the first 20 hex characters of the
   sha256 of `ecosystem`, `name`, `version`, `digest` and `ruleKey`. The same
   behavior in the same artifact under any analyzer run gets the same id.
   `revision` counts changes. Each change appends one history entry with the
   actor, the time and the reason, and history is never rewritten.
6. **Publication.** The feed lists only findings whose verdict is
   `confirmed-malicious` or `retracted`. A retraction stays in the feed so a
   consumer that saw the confirmation learns of the correction. A `suspected`
   finding is readable through the query API with its verdict visible, and
   never enters the feed.
7. **Writes need a reviewer token.** The service has no write route unless it
   starts with a reviewers file mapping the sha256 of a token to a reviewer
   name. The reviewer identity in a transition comes from the token, never
   from the request body.
8. **Consumer rule (Tier 2, stricter only).** The CLI and Action match a
   lockfile change against feed entries by ecosystem, name, version and
   artifact digest. A `confirmed-malicious` match adds one CRITICAL finding. A
   `retracted` entry adds nothing. Without a feed URL nothing changes. An
   unreachable, slow or malformed feed adds a loud warning and local analysis
   decides, because local protection must work without the service.
9. **OSV shape.** The feed offers each confirmed finding as an OSV record
   (`id`, `modified`, `summary`, `affected` with the exact version, `database_specific`
   with the digest and `revision`). Ids carry the `CDI-` prefix, not `MAL-`,
   which the OpenSSF malicious-packages repository owns.

## Alternatives rejected

- One `risk` score. It hides which part came from the analyzer and which from a
  person, which is the distinction the roadmap requires.
- Analyzer sets `confirmed-malicious` above a score. This is the automatic
  equivalence the roadmap forbids.
- Delete a retracted entry from the feed. A consumer that cached the
  confirmation would never learn of the correction.
- Author in the request body. A client could claim any reviewer.

## Consequences

Consumers gain a block that only a person can trigger, and that a person can
undo. Review throughput bounds how fast malware reaches the feed, which is
intended. The model rejects bad transitions in one place, so the API and any
future tool inherit the rule. To revert, delete `src/platform/intel/`, the
write routes, and the consumer option. Revisit when a second reviewer needs
approval workflows (two-person rule), which this ADR does not provide.
