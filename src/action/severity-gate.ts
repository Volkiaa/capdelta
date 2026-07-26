import type { FindingSeverity } from "../core/capability-differ.js";
import type { JsonRunReport } from "../core/reporter.js";

export type FailOn = FindingSeverity | "none";

export interface SeverityAssessment {
  counts: Readonly<Record<FindingSeverity, number>>;
  highest: FindingSeverity | null;
}

export interface GateDecision extends SeverityAssessment {
  threshold: FailOn;
  matchingCount: number;
  fail: boolean;
  exitCode: 0 | 1;
}

const SEVERITIES: readonly FindingSeverity[] = [
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

/** Parse the Action input without silently accepting misspellings. */
export function parseFailOn(value: string): FailOn {
  const normalized = value.trim().toUpperCase();
  if (normalized === "NONE") return "none";
  if (SEVERITIES.some((severity) => severity === normalized)) {
    return normalized as FindingSeverity;
  }
  throw new SeverityGateConfigurationError(
    "fail-on must be CRITICAL, HIGH, MEDIUM, LOW, INFO, or none",
  );
}

/**
 * Assess only M1 signals whose severity is already specified by PLAN §4.4.
 * This is deliberately smaller than the M3 shape-based severity model.
 */
export function assessRunSeverity(report: JsonRunReport): SeverityAssessment {
  const counts: Record<FindingSeverity, number> = {
    ...report.summary.bySeverity,
  };

  for (const finding of report.lockfileFindings) {
    counts[
      finding.kind === "integrity-changed-version-same" ? "HIGH" : "INFO"
    ] += 1;
  }
  for (const item of report.packages) {
    const issues = item.status === "analyzed" ? item.issues : item.failures;
    for (const issue of issues) {
      if (issue.stage === "fetch" && issue.kind === "integrity-mismatch") {
        counts.CRITICAL += 1;
      }
    }
  }

  return {
    counts,
    highest: SEVERITIES.find((severity) => counts[severity] > 0) ?? null,
  };
}

/** Apply an inclusive severity threshold; defaulting happens at the Action input. */
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
  const matchingCount =
    threshold === "none"
      ? 0
      : SEVERITIES.slice(0, thresholdIndex + 1).reduce(
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
