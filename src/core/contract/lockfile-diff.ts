/**
 * The ecosystem-agnostic lockfile-diff contract (PLAN §2, §4.1; ADR-004).
 * Ecosystem-specific differs (npm today, others later) produce these types;
 * the Fetcher, Differ, severity model, and Reporter consume them without
 * knowing the ecosystem.
 */

/** PLAN §4.1: one analyzable package whose resolved version changed. */
export interface ChangedPackage {
  /** Real registry name (alias-resolved). */
  name: string;
  /** null = newly added package → full capability report (PLAN §1, §4.1). */
  oldVersion: string | null;
  newVersion: string;
  oldIntegrity: string | null;
  newIntegrity: string;
  /** Tarball URL of the new version. */
  resolvedUrl: string;
}

/**
 * Facts observed while diffing, reported without severity: the severity
 * model (PLAN §4.4) owns the fact→severity mapping, so HIGH/INFO is never
 * hardcoded in two places.
 */
export type LockfileFindingKind =
  | "integrity-changed-version-same" // PLAN §4.1: "HIGH finding on its own"
  | "version-downgrade"; // PLAN §4.1: "INFO finding"

export interface LockfileFinding {
  kind: LockfileFindingKind;
  name: string;
  /** Lockfile position — evidence (PLAN §4.4: a finding without evidence is an assertion). */
  path: string;
  oldVersion: string | null;
  newVersion: string;
}

/** Why a changed package could not be queued for analysis. Never silent (PLAN §2). */
export type SkipReason =
  | "private-registry" // PLAN §2: skip and flag
  | "unanalyzable-source" // git/file/link deps (PLAN §4.1)
  | "missing-integrity" // fetcher requires SRI before parsing (PLAN §4.2)
  | "missing-resolved" // no tarball URL to fetch
  | "malformed-entry"; // entry failed structural validation

export interface SkippedPackage {
  /** Best-effort: path-derived when the entry itself is garbage. */
  name: string;
  path: string;
  reason: SkipReason;
  /** Human-readable specifics (offending host, missing field, …). May contain attacker-controlled strings — the reporter escapes (PLAN §3). */
  detail: string;
}

export interface LockfileDiffResult {
  /** Analyzable changes, deduplicated on full-tuple equality. */
  changed: ChangedPackage[];
  findings: LockfileFinding[];
  skipped: SkippedPackage[];
  /** Old lockfile absent (lockfile added in this PR) → aggregate-report mode (PLAN §4.1). */
  firstRun: boolean;
}
