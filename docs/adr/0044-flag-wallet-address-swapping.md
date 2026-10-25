# ADR-044: Flag wallet-provider address swapping as a CRITICAL shape with a NET gain

- **Status:** Accepted (agent, 2026-10-25, Tier 2 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-25
- **Plan reference:** PLAN §4.3 (signal layer), PLAN §4.4 (severity model), CLAUDE.md "Autonomy"

## Context

The September 2025 chalk and debug compromise adds a `browser.js` that wraps `window.fetch`, `XMLHttpRequest.open`, `XMLHttpRequest.send`, and the `request` method of `window.ethereum` and `window.solana`. Before a request leaves or a JSON response reaches the caller, the wrapper replaces every string that looks like a 20-byte EVM address with the attacker's address. A reviewer sees only the new runtime `NET` capability at HIGH. The taxonomy has no kind for wallet access, address substitution, or request tampering, so the report stops at the network access and the substitution is invisible.

## Decision

1. The signal extractor reads address-shaped text only from the parser's string literal and template element ranges. It scans at most 1024 characters of each string, keeps at most 32 distinct addresses per file, and records the first line where each value appears.
2. A value matches one of these shapes:
   - `evm`: `0x` followed by 40 hexadecimal digits.
   - `tron`: `T` followed by 33 base58 characters.
   - `bitcoin-base58`: `1` or `3` followed by 25 to 33 base58 characters.
   - `bitcoin-bech32`: `bc1` followed by 11 to 71 bech32 characters.
   - `solana`: 32 to 44 base58 characters.
     The most specific shape wins when spans overlap, so a Tron address is not also counted as Solana.
3. The same parsed file is checked for a wallet provider reference: `window.ethereum`, `.request`, `.send`, `.sendTransaction`, or `.enable`. The token must end at a non-identifier character, so `.enabled` and `.sender` do not match. A token inside a parser-reported comment does not count.
4. `SignalFileObservation` gains optional `walletProviderReference` and `walletAddresses` fields. `capability-differ` validates the boolean, the shape names, the positive lines, the value length, the uniqueness and the 32 cap, so a broken producer fails loudly.
5. `signal-differ` emits `wallet-address-swap` at HIGH when a new or changed file has a provider reference and at least one address value that the old version of that file did not have. A missing baseline file counts as no old addresses.
6. `evaluateShapes` adds shape `wallet-address-swap` at CRITICAL when that signal and a NET gain are both present for the package. The shape keeps the NET capabilities as participants, as `secret-exfiltration` does, so both the new address literal and the network access are named in the finding. The signal is raised to CRITICAL by the existing shape classification.
7. The kind joins the allowlist and the signal guidance. The JSON report, SARIF and the text reporter derive from the kind and need no other change.
8. This is Tier 2. It adds a detection and can only raise severity. No existing severity, match, allowlist policy, report field or gate is lowered, suppressed or narrowed.

## Evidence (Tier 2 checks)

- **Held-out corpus.** `scripts/m5-measure.ts run docs/heldout-2026-10-20/corpus-heldout.json` on main and on this branch, 2026-10-25. 45 pairs, 0 rows different, 0 new findings. New findings labelled: attack 0, noise 0, unknown 0. The three held-out chalk pairs stay clean.
- **Reconstructions and golden fixtures.** Full suite passes (1398 tests). Only chalk-debug-2025 moved: CRITICAL 0 to 4, HIGH 2 to 0 (the two NET findings become shape participants). Nothing moved down, no `expected-*` golden file changed. The axios fixture has two Solana-shaped strings but no provider reference, so it stays inert.
- **Real CLI drive.** Not possible for the attack case. The compromised chalk and debug releases are removed from the registry, and the CLI cannot fetch a fixture, so the reconstruction test drives the same pipeline and gate with a fake fetch. The 45 held-out pairs are real published bumps analyzed by the same code.
- **Codex security review.** APPROVE (2026-10-25).
- **Action bundle.** `npm run package:action` run and `dist/action/` committed.
- **Not covered.** Hook detection (`window.fetch` assignment, `XMLHttpRequest`) is a separate ticket because of its false-positive risk. A wallet drainer that does not embed address literals is not detected.

## Alternatives rejected

- Hook detection in `detectNetwork` for `XMLHttpRequest` or `window.fetch` assignment. That is a broader NET rule with a larger false-positive surface and is a separate ticket.
- A new `CodeCapabilityKind` for wallet access. The taxonomy is closed (PLAN §4.3).
- Reporting every address constant. Libraries such as ethers, viem, wagmi, web3, `@solana/web3.js` and tronweb ship address constants. Requiring a provider reference and a value that is new in that file keeps those constants quiet.
- HIGH without a NET gain. Address substitution alone does not show where the substituted value goes, and the shipped attack combines it with network access.
- Scanning raw source bytes. Unparsed or comment text would fire on documentation and on address examples, and the safe extraction rule keeps parsing as the gate for literal data.

## Consequences

The chalk and debug reconstruction moves from runtime NET at HIGH to a CRITICAL `wallet-address-swap` shape, and the default CRITICAL gate fails there. Packages that add an address literal and also use `.send` or `.request` outside a wallet context can reach HIGH, but only a package that also gains NET reaches CRITICAL. The cap and the string length bound keep the work linear in the size of the parsed strings.

To revert, remove the `wallet-address-swap` finding kind and its emission in `src/core/signal-differ.ts`, the shape rule and its evaluation in `src/core/capability-differ.ts`, the address and provider extraction in `src/core/signal-extractor.ts` with its observation fields and validation, the allowlist name, the guidance entry, and restore the chalk reconstruction expectation. No stored report or contract migration is needed because the observation fields are optional.
