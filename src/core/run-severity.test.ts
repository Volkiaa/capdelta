import { describe, expect, it } from "vitest";
import type { FindingSeverity } from "./capability-differ.js";
import type { JsonRunReport, SeverityCounts } from "./reporter.js";
import type { JsonReportAnalysisIssue } from "./report-contract.js";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import type { PackageAnalysisFailure } from "./capability-analysis-pipeline.js";
import type { FetchFailureKind } from "./npm/fetcher.js";
import {
  EXCEPTABLE_UNANALYZABLE_KINDS,
  FETCH_STAGE_CRITICAL_KINDS,
  SeverityGateConfigurationError,
  SeverityGateError,
  analysisIssueSeverity,
  assessRunSeverity,
  evaluateSeverityGate,
  hasOperationalFailure,
  isOperationalFailure,
  isUnanalyzableIssue,
  lockfileFindingSeverity,
  operationalFailureCount,
  operationalFailureMessage,
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

function runWithPackages(
  packages: CapabilityAnalysisRun["packages"],
): CapabilityAnalysisRun {
  const unavailable = packages.filter(
    (item) => item.status === "unavailable",
  ).length;
  return {
    firstRun: false,
    summary: {
      changed: packages.length,
      analyzed: packages.length - unavailable,
      unavailable,
      skipped: 0,
    },
    packages,
    lockfileFindings: [],
    skipped: [],
  };
}

function unavailablePackage(
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
  name = "fixture",
): CapabilityAnalysisRun["packages"][number] {
  return {
    status: "unavailable",
    changedPackage: {
      name,
      oldVersion: null,
      newVersion: "2.0.0",
      oldIntegrity: null,
      newIntegrity: "sha512-inert",
      oldResolvedUrl: null,
      resolvedUrl: `https://registry.npmjs.org/${name}/new.tgz`,
    },
    failures,
  };
}

function fetchIssue(kind: FetchFailureKind): PackageAnalysisFailure {
  return {
    stage: "fetch",
    failure: {
      side: "new",
      kind,
      detail: `failure ${kind}`,
      url: "https://registry.npmjs.org/fixture/new.tgz",
    },
  };
}

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
    // ADR-018: a non-retryable HTTP status and an invalid response are decided
    // by the lockfile entry or the registry, so they are CRITICAL too.
    "http-status",
    "invalid-response",
  ] as const;
  const FETCH_NULL = [
    "timeout",
    "aborted",
    "network-error",
    "http-unavailable",
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
    // ADR-019: a package.json that exists but is not a regular file is decided
    // by the archive bytes, so it is CRITICAL and exceptable like the rest.
    "manifest-not-regular",
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

  // ADR-017 amendment A: the exported exception set must be exactly the kinds
  // the ADR-016 classification marks CRITICAL in the extraction and manifest
  // stages. Derived here over the same exhaustive (stage, kind) table, so a new
  // kind or a reclassification cannot silently drift from the exception
  // allow-set.
  it("derives EXCEPTABLE_UNANALYZABLE_KINDS from the extraction and manifest stages", () => {
    const derived = new Set<string>();
    for (const [stage, kind, severity] of ISSUE_CASES) {
      if (
        severity === "CRITICAL" &&
        (stage === "old-extraction" ||
          stage === "new-extraction" ||
          stage === "old-manifest" ||
          stage === "new-manifest")
      ) {
        derived.add(kind);
      }
    }
    expect(derived).toEqual(new Set<string>(EXCEPTABLE_UNANALYZABLE_KINDS));
  });

  // ADR-017 amendment A: fetch-stage CRITICAL kinds can never be excepted, so
  // the parser rejects them with a distinct reason. Derived from the same table.
  it("derives FETCH_STAGE_CRITICAL_KINDS from the fetch stage", () => {
    const derived = new Set<string>();
    for (const [stage, kind, severity] of ISSUE_CASES) {
      if (stage === "fetch" && severity === "CRITICAL") derived.add(kind);
    }
    expect(derived).toEqual(new Set<string>(FETCH_STAGE_CRITICAL_KINDS));
  });
});

describe("operational failure (ADR-018)", () => {
  it("treats an exhausted transient fetch failure as operational", () => {
    for (const kind of [
      "timeout",
      "network-error",
      "http-unavailable",
      "aborted",
    ] as const) {
      expect(isOperationalFailure(fetchIssue(kind))).toBe(true);
    }
  });

  it("treats deterministic fetch failures as severities, not operational", () => {
    for (const kind of [
      "integrity-mismatch",
      "size-limit-exceeded",
      "invalid-url",
      "unsupported-integrity",
      "http-status",
      "invalid-response",
    ] as const) {
      expect(isOperationalFailure(fetchIssue(kind))).toBe(false);
    }
  });

  it("treats a deadline or cancellation stop at any stage as operational", () => {
    const stops: PackageAnalysisFailure[] = [
      {
        stage: "analysis",
        failure: { kind: "deadline-exceeded", detail: "stop" },
      },
      {
        stage: "analysis",
        failure: { kind: "analysis-aborted", detail: "stop" },
      },
      {
        stage: "new-extraction",
        failure: { kind: "deadline-exceeded", detail: "stop" },
      },
      {
        stage: "old-extraction",
        failure: { kind: "analysis-aborted", detail: "stop" },
      },
      {
        stage: "new-manifest",
        failure: { kind: "deadline-exceeded", detail: "stop", evidence: null },
      },
      {
        stage: "old-manifest",
        failure: { kind: "analysis-aborted", detail: "stop", evidence: null },
      },
    ];
    for (const issue of stops) expect(isOperationalFailure(issue)).toBe(true);
  });

  it("does not count environmental or cleanup failures as operational", () => {
    const issues: PackageAnalysisFailure[] = [
      {
        stage: "old-extraction",
        failure: { kind: "filesystem-error", detail: "input/output error" },
      },
      {
        stage: "new-manifest",
        failure: {
          kind: "manifest-unreadable",
          detail: "input/output error",
          evidence: null,
        },
      },
      {
        stage: "old-manifest",
        failure: {
          kind: "manifest-not-regular",
          detail: "package.json is not a regular file",
          evidence: null,
        },
      },
      {
        stage: "old-cleanup",
        failure: { kind: "cleanup-failed", detail: "cleanup failed" },
      },
    ];
    for (const issue of issues) expect(isOperationalFailure(issue)).toBe(false);
  });

  it("counts each package once, however many failures it has", () => {
    const run = runWithPackages([
      unavailablePackage([
        fetchIssue("timeout"),
        fetchIssue("http-unavailable"),
      ]),
      unavailablePackage([fetchIssue("integrity-mismatch")], "mismatch"),
      unavailablePackage(
        [
          {
            stage: "analysis",
            failure: { kind: "deadline-exceeded", detail: "stop" },
          },
        ],
        "stopped",
      ),
    ]);
    expect(operationalFailureCount(run)).toBe(2);
    expect(hasOperationalFailure(run)).toBe(true);
  });

  it("is false when every unavailable package failed deterministically", () => {
    const run = runWithPackages([
      unavailablePackage([fetchIssue("http-status")]),
      unavailablePackage([fetchIssue("integrity-mismatch")], "mismatch"),
    ]);
    expect(operationalFailureCount(run)).toBe(0);
    expect(hasOperationalFailure(run)).toBe(false);
    expect(hasOperationalFailure(runWithPackages([]))).toBe(false);
  });

  it("renders the shared CLI and Action message", () => {
    expect(operationalFailureMessage(2)).toBe(
      "capdelta: 2 package(s) could not be fetched or analyzed before the run ended",
    );
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
