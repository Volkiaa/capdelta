import type { FindingSeverity } from "./capability-differ.js";
import type { LockfileFindingKind } from "./contract/lockfile-diff.js";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "./capability-analysis-pipeline.js";
import type { AnalysisStopKind } from "./analysis-execution-policy.js";
import type { FetchFailureKind } from "./npm/fetcher.js";
import type { ExtractionFailureKind } from "./npm/safe-extractor.js";
import type { ManifestCapabilityFailureKind } from "./npm/manifest-capability-extractor.js";
import type {
  JsonReportAnalysisIssue,
  JsonRunReport,
  SeverityCounts,
} from "./report-contract.js";

/**
 * Run-level severity policy shared by every consumer (CLI, Action, reporters).
 * Severities of capability/signal findings come from the Differ (PLAN §4.4,
 * ADR-008); this module classifies the remaining facts exactly once.
 */

export type FailOn = FindingSeverity | "none";

export interface SeverityAssessment {
  counts: Readonly<SeverityCounts>;
  highest: FindingSeverity | null;
}

export interface GateDecision extends SeverityAssessment {
  threshold: FailOn;
  matchingCount: number;
  fail: boolean;
  exitCode: 0 | 1;
}

export const SEVERITIES: readonly FindingSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];

/**
 * ADR-017 amendment A: the extraction- and manifest-stage failure kinds ADR-016
 * classifies as CRITICAL. These failures are decided after the fetcher verified
 * the artifact bytes against the lockfile sha512, so a reviewed exception can
 * bind to them. Fetch-stage failures are excluded because they occur before or
 * without verification. `run-severity.test.ts` re-derives this set from
 * `analysisIssueSeverity` over the extraction and manifest stages.
 */
export type ExceptableUnanalyzableKind =
  ExtractionFailureKind | ManifestCapabilityFailureKind;

export const EXCEPTABLE_UNANALYZABLE_KINDS: readonly ExceptableUnanalyzableKind[] =
  [
    "invalid-archive",
    "invalid-layout",
    "unsafe-path",
    "link-entry",
    "unsupported-entry",
    "file-count-limit",
    "expanded-size-limit",
    "decompression-ratio-limit",
    "manifest-missing",
    "manifest-too-large",
    "manifest-invalid-json",
    "manifest-invalid-root",
    "identity-mismatch",
  ];

/**
 * ADR-017 amendment A: the fetch-stage failure kinds ADR-016 classifies as
 * CRITICAL. They are decided before or without byte verification, so they can
 * never carry a reviewed exception. The config parser rejects them with that
 * reason. `run-severity.test.ts` re-derives this set from the fetch stage.
 */
export const FETCH_STAGE_CRITICAL_KINDS: readonly FetchFailureKind[] = [
  "size-limit-exceeded",
  "invalid-url",
  "unsupported-integrity",
  "integrity-mismatch",
  // ADR-018: a non-retryable HTTP status and an invalid response are decided
  // deterministically by the lockfile or the registry, so they are CRITICAL and
  // unanalyzable too.
  "http-status",
  "invalid-response",
];

export class SeverityGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SeverityGateConfigurationError extends SeverityGateError {}

export function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
}

/** PLAN §4.1: same-version integrity change is HIGH; downgrade is INFO. */
export function lockfileFindingSeverity(
  kind: LockfileFindingKind,
): FindingSeverity {
  switch (kind) {
    case "integrity-changed-version-same":
      return "HIGH";
    case "version-downgrade":
      return "INFO";
    default: {
      // Compile-time exhaustiveness: a new kind must be classified here.
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified lockfile finding kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

/**
 * The `(stage, kind)` pair of one analysis issue, correlated the way the
 * pipeline produces it. The JSON report flattens the pipeline's discriminated
 * `PackageAnalysisFailure` into independent `stage` and `kind` fields; this
 * type restores the correlation so classification can be exhaustive per stage
 * (ADR-016).
 */
type AnalysisFailureKind<Failure> = Failure extends { kind: infer Kind }
  ? Kind
  : never;
type StageKindPair<Failure> = Failure extends {
  stage: infer Stage;
  failure: infer Detail;
}
  ? Stage extends string
    ? { stage: Stage; kind: AnalysisFailureKind<Detail> }
    : never
  : never;
type AnalysisIssueClassification = StageKindPair<PackageAnalysisFailure>;

/**
 * ADR-016: a failure decided by the artifact bytes or by the lockfile entry is
 * unanalyzable and CRITICAL; a transient, environmental, or budget failure
 * stays `null` and `--strict` governs it. An integrity mismatch is CRITICAL
 * even though it is not "unanalyzable" (PLAN §4.2).
 */
export function analysisIssueSeverity(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): FindingSeverity | null {
  // JSON reports flatten the pipeline's discriminated failure, so restore the
  // stage→kind mapping for the exhaustive switches below. A pair the pipeline
  // cannot produce falls through to a `never` guard, which throws.
  const classified = issue as AnalysisIssueClassification;
  switch (classified.stage) {
    case "fetch":
      return fetchFailureSeverity(classified.kind);
    case "old-extraction":
    case "new-extraction":
      return extractionFailureSeverity(classified.kind);
    case "old-manifest":
    case "new-manifest":
      return manifestFailureSeverity(classified.kind);
    case "analysis":
      return analysisStopSeverity(classified.kind);
    case "old-cleanup":
    case "new-cleanup":
      return null;
    default: {
      // Compile-time exhaustiveness: a new stage must be classified here.
      const unclassified: never = classified;
      throw new SeverityGateError(
        `unclassified analysis issue stage ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

/**
 * ADR-016: true exactly when capdelta could not inspect the artifact or the
 * lockfile entry for a reason decided by that input, so a person must review
 * it. Integrity mismatches are CRITICAL in their own right and stay excluded.
 */
export function isUnanalyzableIssue(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): boolean {
  return (
    issue.kind !== "integrity-mismatch" &&
    analysisIssueSeverity(issue) === "CRITICAL"
  );
}

function fetchFailureSeverity(kind: FetchFailureKind): FindingSeverity | null {
  switch (kind) {
    // ADR-018: a non-retryable HTTP status and an invalid response are decided
    // by the lockfile entry or the registry, so they are CRITICAL too.
    case "integrity-mismatch":
    case "size-limit-exceeded":
    case "invalid-url":
    case "unsupported-integrity":
    case "http-status":
    case "invalid-response":
      return "CRITICAL";
    case "timeout":
    case "network-error":
    case "http-unavailable":
    case "aborted":
      return null;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified fetch failure kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

function extractionFailureSeverity(
  kind: ExtractionFailureKind,
): FindingSeverity | null {
  switch (kind) {
    case "invalid-archive":
    case "invalid-layout":
    case "unsafe-path":
    case "link-entry":
    case "unsupported-entry":
    case "file-count-limit":
    case "expanded-size-limit":
    case "decompression-ratio-limit":
      return "CRITICAL";
    case "filesystem-error":
    case "deadline-exceeded":
    case "analysis-aborted":
      return null;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified extraction failure kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

function manifestFailureSeverity(
  kind: ManifestCapabilityFailureKind,
): FindingSeverity | null {
  switch (kind) {
    case "manifest-missing":
    case "manifest-too-large":
    case "manifest-invalid-json":
    case "manifest-invalid-root":
    case "identity-mismatch":
      return "CRITICAL";
    case "manifest-unreadable":
    case "deadline-exceeded":
    case "analysis-aborted":
      return null;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified manifest failure kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

function analysisStopSeverity(kind: AnalysisStopKind): FindingSeverity | null {
  switch (kind) {
    case "deadline-exceeded":
    case "analysis-aborted":
      return null;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified analysis stop kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

/**
 * ADR-018: true when a run is an operational failure. A package is operational
 * when it is unavailable because of an exhausted transient fetch failure
 * (`timeout`, `network-error`, or `http-unavailable` after the final attempt)
 * or a deadline/cancellation stop (`aborted`, `deadline-exceeded`, or
 * `analysis-aborted`) at any stage. Report-only mode still fails on this.
 */
export function hasOperationalFailure(run: CapabilityAnalysisRun): boolean {
  return operationalFailureCount(run) > 0;
}

/**
 * ADR-018: how many packages are operational failures. Each package counts
 * once, however many sides, stages, or attempts failed.
 */
export function operationalFailureCount(run: CapabilityAnalysisRun): number {
  return run.packages.filter(
    (item) =>
      item.status === "unavailable" && item.failures.some(isOperationalFailure),
  ).length;
}

/** ADR-018: the shared CLI and Action message for an operational failure. */
export function operationalFailureMessage(count: number): string {
  return `capdelta: ${String(count)} package(s) could not be fetched or analyzed before the run ended`;
}

/**
 * ADR-018: an exhausted transient fetch failure or a stop at any stage. A
 * deterministic fetch failure (a 404, a size cap, an integrity mismatch) is a
 * severity issue, never an operational one.
 */
export function isOperationalFailure(issue: PackageAnalysisFailure): boolean {
  switch (issue.stage) {
    case "fetch":
      return isOperationalFetchKind(issue.failure.kind);
    case "analysis":
      return isStopKind(issue.failure.kind);
    case "old-extraction":
    case "new-extraction":
      return isStopKind(issue.failure.kind);
    case "old-manifest":
    case "new-manifest":
      return isStopKind(issue.failure.kind);
    case "old-cleanup":
    case "new-cleanup":
      return false;
    default: {
      const unclassified: never = issue;
      throw new SeverityGateError(
        `unclassified analysis failure ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

function isOperationalFetchKind(kind: FetchFailureKind): boolean {
  switch (kind) {
    case "timeout":
    case "network-error":
    case "http-unavailable":
    case "aborted":
      return true;
    case "invalid-url":
    case "unsupported-integrity":
    case "http-status":
    case "invalid-response":
    case "size-limit-exceeded":
    case "integrity-mismatch":
      return false;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified fetch failure kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

function isStopKind(
  kind:
    AnalysisStopKind | ExtractionFailureKind | ManifestCapabilityFailureKind,
): boolean {
  switch (kind) {
    case "deadline-exceeded":
    case "analysis-aborted":
      return true;
    case "invalid-archive":
    case "invalid-layout":
    case "unsafe-path":
    case "link-entry":
    case "unsupported-entry":
    case "file-count-limit":
    case "expanded-size-limit":
    case "decompression-ratio-limit":
    case "filesystem-error":
    case "manifest-missing":
    case "manifest-too-large":
    case "manifest-invalid-json":
    case "manifest-invalid-root":
    case "identity-mismatch":
    case "manifest-unreadable":
      return false;
    default: {
      const unclassified: never = kind;
      throw new SeverityGateError(
        `unclassified stop-bearing failure kind ${JSON.stringify(unclassified)}`,
      );
    }
  }
}

/** Parse a threshold without silently accepting misspellings. */
export function parseFailOn(value: string): FailOn {
  const normalized = value.trim().toUpperCase();
  if (normalized === "NONE") return "none";
  const severity = SEVERITIES.find((candidate) => candidate === normalized);
  if (severity !== undefined) return severity;
  throw new SeverityGateConfigurationError(
    "fail-on must be CRITICAL, HIGH, MEDIUM, LOW, INFO, or none",
  );
}

/** Reads the report's single counting authority, `summary.gateSeverity`. */
export function assessRunSeverity(report: JsonRunReport): SeverityAssessment {
  const counts = { ...report.summary.gateSeverity };
  return {
    counts,
    highest: SEVERITIES.find((severity) => counts[severity] > 0) ?? null,
  };
}

/** Apply an inclusive severity threshold; callers choose the default. */
export function evaluateSeverityGate(
  report: JsonRunReport,
  threshold: FailOn,
): GateDecision {
  const assessment = assessRunSeverity(report);
  const thresholdIndex =
    threshold === "none" ? -1 : SEVERITIES.indexOf(threshold);
  if (threshold !== "none" && thresholdIndex < 0) {
    throw new SeverityGateConfigurationError("invalid fail-on threshold");
  }
  const matchingCount = SEVERITIES.slice(0, thresholdIndex + 1).reduce(
    (sum, severity) => sum + assessment.counts[severity],
    0,
  );
  const fail = matchingCount > 0;
  return {
    ...assessment,
    threshold,
    matchingCount,
    fail,
    exitCode: fail ? 1 : 0,
  };
}
