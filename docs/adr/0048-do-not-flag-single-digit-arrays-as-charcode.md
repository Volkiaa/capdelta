# ADR-048: Do not flag an array of single digits as a charcode array

- **Status:** Accepted (maintainer approved, 2026-10-26, Tier 3 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-26
- **Plan reference:** PLAN §4.3 (signal layer), CLAUDE.md "Autonomy"

## Context

`arrayPattern` in `src/core/signal-extractor.ts` reports a `charcode-array` OBFUSCATION_PATTERN for any bracketed list of at least 8 elements that are all decimal numbers from 0 to 255. On the live feed, miniflare 5.20261023.0-beta shipped `sum += bit ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][value] : value;`, the digit-doubling table of a Luhn checksum. The finding is CRITICAL, and together with a new `child_process` import it also produces the CRITICAL `obfuscated-execution` shape. Neither reflects an attack.

## Decision

`arrayPattern` does not return `charcode-array` when every element is a single decimal digit (`0` to `9`). Every other array that matched before still matches: all elements 0 to 255, at least 8 elements, and at least one element of two or three digits. `hex-byte-array` is unchanged.

Reason: `String.fromCharCode` of a value below 10 is a control character, so an array of only single digits cannot spell readable text. A payload encoded this way needs values from 32 upward for letters.

## Alternatives rejected

- **Require printable ASCII (32 to 126).** An XOR or offset encoding moves text outside that range, so it drops real obfuscation.
- **Exempt reserved TLDs (`.invalid`, `.test`) from endpoint findings.** Raised in the same triage and rejected: the attack reconstructions in `test/fixtures/reconstructions` use `example.invalid` hosts as their defanged attacker domains, so the exemption would turn those gates off.

## Consequences

An attacker who encodes a payload as an array of single digits (for example one digit per base-10 character code, split across elements) is no longer reported by this rule. Decoding such an array still needs code that the other rules see, and the cost of the evasion is a much longer array. Revert by restoring the old condition in `arrayPattern`. Revisit if a reconstruction shows a digit-only encoding.

Git: conventional commits, imperative mood, no Co-Authored-By trailer. Never run package code. No new runtime dependency. Every catch recovers or rethrows with context. Keep any comment that states a security reason.
