import type { FindingSeverity } from "./capability-differ.js";
import type { LockfileFindingKind } from "./contract/lockfile-diff.js";
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
 * PLAN §4.2: an integrity mismatch is CRITICAL even though analysis aborts.
 * Every other analysis issue is incompleteness, not a severity; `--strict`
 * governs those.
 */
export function analysisIssueSeverity(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): FindingSeverity | null {
  return issue.stage === "fetch" && issue.kind === "integrity-mismatch"
    ? "CRITICAL"
    : null;
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
