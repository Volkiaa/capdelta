import { describe, expect, it } from "vitest";
import type { JsonRunReport, SeverityCounts } from "./reporter.js";
import {
  SeverityGateConfigurationError,
  analysisIssueSeverity,
  assessRunSeverity,
  evaluateSeverityGate,
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

  it("classifies only integrity mismatches as severity-bearing issues", () => {
    expect(
      analysisIssueSeverity({ stage: "fetch", kind: "integrity-mismatch" }),
    ).toBe("CRITICAL");
    expect(
      analysisIssueSeverity({ stage: "fetch", kind: "http-status" }),
    ).toBeNull();
    expect(
      analysisIssueSeverity({ stage: "new-cleanup", kind: "cleanup-failed" }),
    ).toBeNull();
    expect(
      analysisIssueSeverity({ stage: "analysis", kind: "deadline-exceeded" }),
    ).toBeNull();
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
