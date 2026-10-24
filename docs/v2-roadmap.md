# CapDelta — Future Evolution Handoff

## Vision

Evolve [CapDelta](https://github.com/Volkiaa/capdelta) from an npm dependency behavioral-diff tool into an **open-source software supply-chain threat intelligence platform**, inspired by Aikido Intel.

The platform should proactively detect suspicious and malicious package releases, publish evidence-backed intelligence, and protect projects through CI integrations and installation-time checks.

**Core principle:** CapDelta reports what changed and why it matters. Suspicious capabilities are not proof of malware.

## Current state

CapDelta already provides:

- Static npm package analysis, including direct and transitive dependencies.
- Capability diffs (filesystem, network, environment, processes, install hooks, dynamic code, etc.).
- SRI verification, safe extraction, and bounded analysis.
- GitHub Action, CLI, SARIF, JSON reporting, and configurable enforcement.
- Initial false-positive measurements and synthetic attack reconstructions.

Status: pre-release. The existing v0.1 release, security guarantees, and validation roadmap remain priorities.

## Planned evolution

### Phase 1 — Independent package analysis

**Goal:** Analyze npm releases proactively, independently of project lockfiles.

- Introduce `analyzeArtifact()` to inspect individual verified package versions.
- Preserve `diffCapabilities()` for historical comparisons.
- Monitor npm registry releases automatically.
- Store content-addressed capability snapshots and analysis results.
- Reuse analysis across projects.

**Success criteria:**

- [x] A package version can be analyzed without a lockfile or Git repository.
- [x] A newly published npm release automatically triggers analysis.
- [x] Two releases of the same package produce a behavioral diff.
- [x] Repeated events are idempotent; identical artifact bytes are not unnecessarily reanalyzed under the same analyzer version.
- [x] Reports persist across process restarts.
- [ ] Existing CLI/Action regression tests pass unchanged.
- [x] An end-to-end test demonstrates registry event → verification → analysis → stored report, including failure recovery.

`src/platform/e2e.test.ts` covers every criterion above except the CLI/Action regression one. The full `npm test` suite covers that criterion.

**Deliverable:** A working npm release monitoring and analysis service.

### Phase 2 — More precise behavioral detection

**Goal:** Detect suspicious behavioral changes even when capability classes remain unchanged.

- Detect new operations within existing capability classes.
- Track accessed paths, execution context, network targets and relevant operations.
- Introduce reviewed baseline snapshots.
- Investigate potential credential-exfiltration behavior using more precise relationships between operations.
- Expand independent malware and benign-package evaluation datasets.

**Success criteria:**

- [ ] Detect a newly added suspicious network operation even when the previous version already had `NET`.
- [ ] Detect new sensitive-file access when the previous version already had `FS_READ`.
- [ ] Detect a modeled slow-roll attack through a reviewed historical baseline.
- [ ] Every behavior finding includes reproducible source evidence.
- [ ] Build a labeled evaluation corpus containing at least 25 real malicious releases and 200 benign version transitions, with a held-out subset.
- [ ] Publish measured recall, false-positive rates, incomplete-analysis rates and known evasions.
- [ ] No regression in existing attack reconstruction tests.

**Deliverable:** A more granular, independently evaluated behavioral-detection engine.

### Phase 3 — Shared threat intelligence

**Goal:** Let one package analysis protect multiple projects.

- Store findings, evidence, affected versions, hashes and classifications.
- Separate severity, confidence and verdict.
- Support review, corrections and retractions.
- Expose a public API and machine-readable feed, with OSV compatibility where appropriate.
- Integrate intelligence into the existing CLI and GitHub Action.

**Success criteria:**

- [x] A public API can retrieve findings by ecosystem, package, version and artifact digest. (`src/platform/intel-e2e.test.ts` scenarios 1 and 6, `src/platform/api.test.ts`)
- [x] Every published finding has a stable ID, evidence, classification and analyzer version. (`src/platform/intel/finding.test.ts`, `src/platform/intel/publish.test.ts`)
- [x] Suspicious behavior cannot automatically become a confirmed-malicious verdict. (`src/platform/intel-e2e.test.ts` scenario 1, `src/platform/intel/finding.test.ts`)
- [x] Confirmed-malicious verdicts require an explicit validation step. (`src/platform/intel-e2e.test.ts` scenario 2, `src/platform/intel/finding.test.ts`)
- [x] Corrections and retractions propagate to consumers. (`src/platform/intel-e2e.test.ts` scenario 4, `src/platform/intel/finding-store.test.ts`)
- [x] Two independent repositories consuming the same affected package receive consistent intelligence. (`src/platform/intel-e2e.test.ts` scenario 3)
- [x] CLI and Action continue functioning when the intelligence API is unavailable. (`src/platform/intel-e2e.test.ts` scenario 5, `src/action/run-action.test.ts`)
- [x] The backend can be deployed locally using documented setup instructions. (`docs/platform.md`, `src/platform/platform-cli.test.ts`)

`src/platform/intel-e2e.test.ts` runs one service and two independent repositories through confirmation, retraction, an outage and a wrong-digest finding. It needs no network beyond `127.0.0.1`.

**Deliverable:** A self-hostable threat intelligence service with API and CI integration.

### Phase 4 — Advanced malware analysis

**Goal:** Improve detection through additional analysis methods.

- Integrate isolated dynamic execution, potentially using OpenSSF Package Analysis.
- Add YARA/Opengrep rules and optional LLM-assisted triage.
- Correlate behaviors across releases and packages.
- Introduce a validation workflow for publishing blocking malware verdicts.

**Success criteria:**

- [ ] Dynamic package execution runs exclusively inside disposable, isolated sandboxes.
- [ ] Sandbox workers enforce CPU, memory, execution-time, filesystem and network restrictions.
- [ ] The existing static analysis path never executes package code.
- [ ] Dynamic analysis produces evidence that static analysis could not observe in at least one documented malicious test case.
- [ ] LLM output cannot directly publish blocking verdicts.
- [ ] Reproduce detection results on a frozen evaluation corpus.
- [ ] Measure and publish detection improvements and false-positive changes relative to the static-only baseline.

**Deliverable:** A validated multi-method malware analysis pipeline.

### Phase 5 — Pre-CVE vulnerability discovery

**Goal:** Discover security fixes that lack published advisories.

- Monitor upstream Git commits, releases and changelogs.
- Identify potentially security-relevant patches.
- Use LLM-assisted analysis to explain suspected vulnerabilities.
- Validate findings and determine affected-version ranges.

**Success criteria:**

- [ ] Analyze upstream commit diffs independently of package capability analysis.
- [ ] Successfully flag at least 10 documented historical security-fix commits in a reproducible evaluation.
- [ ] Evaluate false positives against at least 20 benign bug-fix commits.
- [ ] Cross-check candidates against existing vulnerability databases.
- [ ] Every candidate includes the relevant commit, explanation and supporting evidence.
- [ ] Findings require validation before becoming published vulnerability advisories.
- [ ] Publish affected and fixed versions only when supported by evidence.

**Deliverable:** An experimental, evidence-backed vulnerability-discovery pipeline.

## Architectural direction

Keep the existing static analysis engine as the shared foundation.

Separate the platform into:

1. **Collectors:** Registry and repository monitoring.
2. **Analyzers:** Static capability analysis, behavioral analysis and optional sandboxing.
3. **Intelligence engine:** Correlation, classification and validation.
4. **Storage and API:** Versioned, reproducible findings and verdicts.
5. **Consumers:** CLI, GitHub Action, installation protection and external integrations.

Maintain ecosystem-neutral contracts so PyPI, Cargo, Go and other ecosystems can be added later.

## Non-negotiable principles

- Open source and self-hostable.
- Evidence-backed and reproducible findings.
- No automatic equivalence between CRITICAL capability and confirmed malware.
- Fail visibly on incomplete analysis.
- Preserve secure extraction, artifact integrity verification, resource limits and safe handling of untrusted input.
- Local protection remains functional without the hosted intelligence service.
- Measure false positives and detection effectiveness before aggressive blocking.
- New analysis capabilities must not weaken existing security guarantees.

## Definition of Done — Threat Intelligence MVP

The **first threat intelligence MVP is complete after Phases 1–3**, when all of the following are demonstrated:

- [x] New npm releases are automatically discovered and analyzed without project lockfiles. (`src/platform/e2e.test.ts`)
- [x] Package capabilities and changes are stored with evidence and artifact identities. (`src/platform/e2e.test.ts`, `src/platform/intel/publish.test.ts`)
- [x] Suspicious changes can be investigated through an API. (`src/platform/intel-e2e.test.ts` scenario 1, `src/platform/api.test.ts`)
- [x] Findings have explicit severity, confidence and verdict states. (`src/platform/intel/finding.test.ts`)
- [x] A validated malicious package can be published to a shared feed. (`src/platform/intel-e2e.test.ts` scenario 3, `src/platform/intel/finding-store.test.ts`)
- [x] The CapDelta Action can consume that feed and block a confirmed-malicious dependency. (`src/action/run-action.test.ts`)
- [x] Two different repositories can benefit from the same intelligence finding. (`src/platform/intel-e2e.test.ts` scenario 3)
- [x] The entire system can be self-hosted using documented instructions. (`docs/platform.md`, `src/platform/platform-cli.test.ts`)
- [x] End-to-end tests cover ingestion, analysis, publication, consumption, corrections and service outages. (`src/platform/e2e.test.ts`, `src/platform/intel-e2e.test.ts`)
- [x] Detection quality, false positives and analysis failures are measured and documented. (`docs/eval/2026-10-24/README.md`, `docs/fp-corpus-2026-07-29.md`)

**Dynamic analysis and pre-CVE discovery are post-MVP capabilities, not prerequisites for the first release.**

## Immediate next step

**Finish v0.1, then extract standalone artifact analysis as the first platform milestone.**

Do not start with a dashboard, LLM pipeline or multi-ecosystem support.

The first demonstrable prototype should:

1. Detect a newly published npm version.
2. Download and verify its tarball.
3. Analyze it using CapDelta's existing engine.
4. Compare it against the previous version.
5. Persist a versioned, evidence-backed report.
6. Make that report available through a simple API.

**Acceptance test:** Publish or simulate a new npm release, observe its automatic analysis, retrieve the persisted behavioral diff through the API, and repeat the event without duplicate processing.

This establishes the foundation for a shared, continuously updated open-source threat intelligence service without requiring a rewrite of CapDelta.
