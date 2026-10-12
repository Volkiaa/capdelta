import { describe, expect, it } from "vitest";
import type { FindingSeverity } from "./capability-differ.js";
import type { JsonRunReport, SeverityCounts } from "./reporter.js";
import type { JsonReportAnalysisIssue } from "./report-contract.js";
import {
  SeverityGateConfigurationError,
  SeverityGateError,
  analysisIssueSeverity,
  assessRunSeverity,
  evaluateSeverityGate,
  isUnanalyzableIssue,
  lockfileFindingSeverity,
  parseFailOn,
} from "./run-severity.js";

// Threshold policy only reads summary.gateSeverity; how records are counted
// into it is covered against real runs in reporter.test.ts.
function report(gateSeverity: SeverityCounts): JsonRunReport {
  return {
    schemaVersion: 5,
    firstRun: false,
    summary: {
      changedPackages: 0,
      analyzedPackages: 0,
      unavailablePackages: 0,
      skippedLockfileEntries: 0,
      capabilityFindings: 0,
      analysisDiagnostics: 0,
      analysisIssues: 0,
      lockfileFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      gateSeverity,
    },
    packages: [],
    lockfileFindings: [],
    skipped: [],
  };
}

const MIXED: SeverityCounts = {
  CRITICAL: 2,
  HIGH: 1,
  MEDIUM: 1,
  LOW: 0,
  INFO: 1,
};

describe("run severity classification", () => {
  it("classifies lockfile findings per PLAN §4.1", () => {
    expect(lockfileFindingSeverity("integrity-changed-version-same")).toBe(
      "HIGH",
    );
    expect(lockfileFindingSeverity("version-downgrade")).toBe("INFO");
  });

  // ADR-016 table, expanded to every (stage, kind) pair. Both old- and
  // new-side extraction and manifest stages share their kind sets.
  const FETCH_UNANALYZABLE = [
    "size-limit-exceeded",
    "invalid-url",
    "unsupported-integrity",
  ] as const;
  const FETCH_NULL = [
    "http-status",
    "timeout",
    "aborted",
    "network-error",
    "invalid-response",
  ] as const;
  const EXTRACTION_UNANALYZABLE = [
    "invalid-archive",
    "invalid-layout",
    "unsafe-path",
    "link-entry",
    "unsupported-entry",
    "file-count-limit",
    "expanded-size-limit",
    "decompression-ratio-limit",
  ] as const;
  const EXTRACTION_NULL = [
    "filesystem-error",
    "deadline-exceeded",
    "analysis-aborted",
  ] as const;
  const MANIFEST_UNANALYZABLE = [
    "manifest-missing",
    "manifest-too-large",
    "manifest-invalid-json",
    "manifest-invalid-root",
    "identity-mismatch",
  ] as const;
  const MANIFEST_NULL = [
    "manifest-unreadable",
    "deadline-exceeded",
    "analysis-aborted",
  ] as const;

  type IssueCase = [
    stage: JsonReportAnalysisIssue["stage"],
    kind: JsonReportAnalysisIssue["kind"],
    severity: FindingSeverity | null,
    unanalyzable: boolean,
  ];

  const ISSUE_CASES: IssueCase[] = [
    ["fetch", "integrity-mismatch", "CRITICAL", false],
    ...FETCH_UNANALYZABLE.map((kind): IssueCase => [
      "fetch",
      kind,
      "CRITICAL",
      true,
    ]),
    ...FETCH_NULL.map((kind): IssueCase => ["fetch", kind, null, false]),
    ...(["old-extraction", "new-extraction"] as const).flatMap(
      (stage): IssueCase[] => [
        ...EXTRACTION_UNANALYZABLE.map((kind): IssueCase => [
          stage,
          kind,
          "CRITICAL",
          true,
        ]),
        ...EXTRACTION_NULL.map((kind): IssueCase => [stage, kind, null, false]),
      ],
    ),
    ...(["old-manifest", "new-manifest"] as const).flatMap(
      (stage): IssueCase[] => [
        ...MANIFEST_UNANALYZABLE.map((kind): IssueCase => [
          stage,
          kind,
          "CRITICAL",
          true,
        ]),
        ...MANIFEST_NULL.map((kind): IssueCase => [stage, kind, null, false]),
      ],
    ),
    ...(["old-cleanup", "new-cleanup"] as const).map((stage): IssueCase => [
      stage,
      "cleanup-failed",
      null,
      false,
    ]),
    ...(["deadline-exceeded", "analysis-aborted"] as const).map(
      (kind): IssueCase => ["analysis", kind, null, false],
    ),
  ];

  it.each(ISSUE_CASES)(
    "classifies %s/%s as %s (unanalyzable: %s)",
    (stage, kind, severity, unanalyzable) => {
      const issue = { stage, kind };
      expect(analysisIssueSeverity(issue)).toBe(severity);
      expect(isUnanalyzableIssue(issue)).toBe(unanalyzable);
    },
  );

  it("only integrity mismatches are CRITICAL without being unanalyzable", () => {
    for (const [, kind, severity, unanalyzable] of ISSUE_CASES) {
      if (severity === "CRITICAL") {
        expect(unanalyzable).toBe(kind !== "integrity-mismatch");
      }
    }
  });

  it("throws on a stage/kind pair the pipeline cannot produce", () => {
    // The JSON contract flattens stage and kind, so the classifier guards the
    // restored correlation at runtime as well as at compile time.
    expect(() =>
      analysisIssueSeverity({
        stage: "fetch",
        kind: "manifest-missing",
      }),
    ).toThrow(SeverityGateError);
  });
});

describe("severity gate", () => {
  it("assesses the report's gate counts and highest severity", () => {
    expect(assessRunSeverity(report(MIXED))).toEqual({
      counts: MIXED,
      highest: "CRITICAL",
    });
  });

  it("returns a copy that cannot mutate the report summary", () => {
    const original = report({ ...MIXED });
    const assessment = assessRunSeverity(original);
    (assessment.counts as SeverityCounts).CRITICAL = 99;
    expect(original.summary.gateSeverity.CRITICAL).toBe(2);
  });

  it.each([
    ["CRITICAL", 2],
    ["HIGH", 3],
    ["MEDIUM", 4],
    ["LOW", 4],
    ["INFO", 5],
  ] as const)("fails inclusively at %s", (threshold, matchingCount) => {
    expect(evaluateSeverityGate(report(MIXED), threshold)).toMatchObject({
      threshold,
      fail: true,
      exitCode: 1,
      matchingCount,
      highest: "CRITICAL",
    });
  });

  it("passes when nothing reaches the threshold", () => {
    const lowOnly = report({
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 3,
      INFO: 0,
    });
    expect(evaluateSeverityGate(lowOnly, "MEDIUM")).toMatchObject({
      fail: false,
      exitCode: 0,
      matchingCount: 0,
      highest: "LOW",
    });
  });

  it("supports an explicit non-gating mode", () => {
    expect(evaluateSeverityGate(report(MIXED), "none")).toMatchObject({
      fail: false,
      exitCode: 0,
      matchingCount: 0,
      highest: "CRITICAL",
    });
  });

  it("does not fail an empty report", () => {
    const empty = report({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
    expect(evaluateSeverityGate(empty, "INFO")).toMatchObject({
      fail: false,
      highest: null,
    });
  });

  it("parses case-insensitive inputs and rejects mistakes", () => {
    expect(parseFailOn(" critical ")).toBe("CRITICAL");
    expect(parseFailOn("none")).toBe("none");
    expect(parseFailOn("NONE")).toBe("none");
    expect(() => parseFailOn("urgent")).toThrow(SeverityGateConfigurationError);
    expect(() => parseFailOn("")).toThrow(SeverityGateConfigurationError);
  });
});
