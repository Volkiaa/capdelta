import { describe, expect, it } from "vitest";
import type { JsonRunReport } from "../core/reporter.js";
import {
  SeverityGateConfigurationError,
  assessRunSeverity,
  evaluateSeverityGate,
  parseFailOn,
} from "./severity-gate.js";

function report(): JsonRunReport {
  return {
    schemaVersion: 1,
    firstRun: false,
    summary: {
      changedPackages: 2,
      analyzedPackages: 1,
      unavailablePackages: 1,
      skippedLockfileEntries: 0,
      manifestFindings: 2,
      manifestDiagnostics: 0,
      analysisIssues: 2,
      lockfileFindings: 2,
      bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 1, LOW: 0, INFO: 0 },
    },
    packages: [
      {
        status: "analyzed",
        report: {
          schemaVersion: 1,
          package: {
            ecosystem: "npm",
            name: "safe-fixture",
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
            newPackage: false,
          },
          summary: {
            findings: 0,
            diagnostics: 0,
            bySeverity: {
              CRITICAL: 0,
              HIGH: 0,
              MEDIUM: 0,
              LOW: 0,
              INFO: 0,
            },
          },
          findings: [],
          diagnostics: [],
        },
        issues: [
          {
            stage: "new-cleanup",
            side: "new",
            kind: "cleanup-failed",
            detail: "reported but not a severity",
            url: null,
            evidence: null,
          },
        ],
      },
      {
        status: "unavailable",
        package: {
          ecosystem: "npm",
          name: "tampered-fixture",
          oldVersion: "1.0.0",
          newVersion: "1.0.1",
          newPackage: false,
        },
        failures: [
          {
            stage: "fetch",
            side: "new",
            kind: "integrity-mismatch",
            detail: "inert mismatch",
            url: "https://registry.npmjs.org/fixture.tgz",
            evidence: null,
          },
        ],
      },
    ],
    lockfileFindings: [
      {
        kind: "integrity-changed-version-same",
        name: "integrity-fixture",
        path: "node_modules/integrity-fixture",
        oldVersion: "1.0.0",
        newVersion: "1.0.0",
      },
      {
        kind: "version-downgrade",
        name: "downgrade-fixture",
        path: "node_modules/downgrade-fixture",
        oldVersion: "2.0.0",
        newVersion: "1.0.0",
      },
    ],
    skipped: [],
  };
}

describe("severity gate", () => {
  it("combines manifest, integrity, and lockfile severities", () => {
    expect(assessRunSeverity(report())).toEqual({
      counts: { CRITICAL: 2, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 1 },
      highest: "CRITICAL",
    });
  });

  it.each([
    ["CRITICAL", 2],
    ["HIGH", 3],
    ["MEDIUM", 4],
    ["LOW", 4],
    ["INFO", 5],
  ] as const)("fails inclusively at %s", (threshold, matchingCount) => {
    expect(evaluateSeverityGate(report(), threshold)).toMatchObject({
      threshold,
      fail: true,
      exitCode: 1,
      matchingCount,
      highest: "CRITICAL",
    });
  });

  it("supports an explicit non-gating mode", () => {
    expect(evaluateSeverityGate(report(), "none")).toMatchObject({
      fail: false,
      exitCode: 0,
      matchingCount: 0,
    });
  });

  it("does not fail an empty report", () => {
    const empty = report();
    empty.summary.bySeverity = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    };
    empty.packages = [];
    empty.lockfileFindings = [];
    expect(evaluateSeverityGate(empty, "CRITICAL")).toMatchObject({
      fail: false,
      highest: null,
    });
  });

  it("parses case-insensitive inputs and rejects mistakes", () => {
    expect(parseFailOn(" critical ")).toBe("CRITICAL");
    expect(parseFailOn("none")).toBe("none");
    expect(() => parseFailOn("urgent")).toThrow(SeverityGateConfigurationError);
  });
});
