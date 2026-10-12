import type { FindingSeverity } from "./capability-differ.js";
import type { LockfileFindingKind } from "./contract/lockfile-diff.js";
import type { PackageAnalysisFailure } from "./capability-analysis-pipeline.js";
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
    case "integrity-mismatch":
    case "size-limit-exceeded":
    case "invalid-url":
    case "unsupported-integrity":
      return "CRITICAL";
    case "http-status":
    case "timeout":
    case "aborted":
    case "network-error":
    case "invalid-response":
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
