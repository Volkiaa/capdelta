import { describe, expect, it } from "vitest";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
  UnavailablePackage,
} from "./capability-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { parseCapdeltaConfig } from "./capdelta-config.js";
import { buildRunReport } from "./reporter.js";
import { evaluateSeverityGate } from "./run-severity.js";
import { applyUnanalyzableExceptions } from "./unanalyzable-exceptions.js";

const SRI_A =
  "sha512-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==";
const SRI_B =
  "sha512-CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==";

function changedPackage(
  overrides: Partial<ChangedPackage> = {},
): ChangedPackage {
  return {
    name: "big-native-pkg",
    oldVersion: "1.0.0",
    newVersion: "2.3.4",
    oldIntegrity: SRI_B,
    newIntegrity: SRI_A,
    oldResolvedUrl:
      "https://registry.npmjs.org/big-native-pkg/-/big-native-pkg-1.0.0.tgz",
    resolvedUrl:
      "https://registry.npmjs.org/big-native-pkg/-/big-native-pkg-2.3.4.tgz",
    ...overrides,
  };
}

function unavailable(
  failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
  pkg: ChangedPackage = changedPackage(),
): UnavailablePackage {
  return { status: "unavailable", changedPackage: pkg, failures };
}

function runWith(
  packages: CapabilityAnalysisRun["packages"],
): CapabilityAnalysisRun {
  const analyzed = packages.filter((item) => item.status === "analyzed").length;
  return {
    firstRun: false,
    summary: {
      changed: packages.length,
      analyzed,
      unavailable: packages.length - analyzed,
      skipped: 0,
    },
    packages,
    lockfileFindings: [],
    skipped: [],
  };
}

function config(entries: string): ReturnType<typeof parseCapdeltaConfig> {
  return parseCapdeltaConfig(`unanalyzable:\n${entries}`);
}

const MATCHING_ENTRY =
  "  - package: big-native-pkg\n" +
  "    version: 2.3.4\n" +
  `    integrity: ${SRI_A}\n` +
  "    kind: file-count-limit\n" +
  '    justification: "reviewed oversized fixture"\n';

const NEW_FILE_COUNT: PackageAnalysisFailure = {
  stage: "new-extraction",
  failure: { kind: "file-count-limit", detail: "too many files" },
};

describe("applyUnanalyzableExceptions", () => {
  it("releases a package whose severity-bearing failure matches exactly", () => {
    const run = runWith([unavailable([NEW_FILE_COUNT])]);
    const applied = applyUnanalyzableExceptions(run, config(MATCHING_ENTRY));
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toEqual({
      reason: "[version 2.3.4] reviewed oversized fixture",
    });
    expect(item.failures).toHaveLength(1);
  });

  it("returns the same run when no entries are configured", () => {
    const run = runWith([unavailable([NEW_FILE_COUNT])]);
    expect(applyUnanalyzableExceptions(run, parseCapdeltaConfig(""))).toBe(run);
  });

  it.each([
    [
      "wrong version",
      "  - package: big-native-pkg\n" +
        "    version: 9.9.9\n" +
        `    integrity: ${SRI_A}\n` +
        "    kind: file-count-limit\n" +
        '    justification: "reviewed"\n',
    ],
    [
      "wrong integrity",
      "  - package: big-native-pkg\n" +
        "    version: 2.3.4\n" +
        `    integrity: ${SRI_B}\n` +
        "    kind: file-count-limit\n" +
        '    justification: "reviewed"\n',
    ],
    [
      "wrong kind",
      "  - package: big-native-pkg\n" +
        "    version: 2.3.4\n" +
        `    integrity: ${SRI_A}\n` +
        "    kind: link-entry\n" +
        '    justification: "reviewed"\n',
    ],
    [
      "wrong package",
      "  - package: other-pkg\n" +
        "    version: 2.3.4\n" +
        `    integrity: ${SRI_A}\n` +
        "    kind: file-count-limit\n" +
        '    justification: "reviewed"\n',
    ],
  ])("does not release on %s", (_label, entry) => {
    const run = runWith([unavailable([NEW_FILE_COUNT])]);
    const applied = applyUnanalyzableExceptions(run, config(entry));
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("does not release on an old-side-only exception (rule C.2)", () => {
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-extraction",
      failure: { kind: "invalid-archive", detail: "old artifact invalid" },
    };
    const entry =
      "  - package: big-native-pkg\n" +
      "    version: 1.0.0\n" +
      `    integrity: ${SRI_B}\n` +
      "    kind: invalid-archive\n" +
      '    justification: "reviewed old artifact"\n';
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure])]),
      config(entry),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("releases when both sides are excepted on their own version and integrity", () => {
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-extraction",
      failure: { kind: "expanded-size-limit", detail: "old too big" },
    };
    const entries =
      "  - package: big-native-pkg\n" +
      "    version: 1.0.0\n" +
      `    integrity: ${SRI_B}\n` +
      "    kind: expanded-size-limit\n" +
      '    justification: "reviewed old artifact"\n' +
      "  - package: big-native-pkg\n" +
      "    version: 2.3.4\n" +
      `    integrity: ${SRI_A}\n` +
      "    kind: file-count-limit\n" +
      '    justification: "reviewed new artifact"\n';
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure, NEW_FILE_COUNT])]),
      config(entries),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toEqual({
      reason: "[version 2.3.4] reviewed new artifact",
    });
    const report = buildRunReport(applied);
    expect(report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(report.summary.analysisIssues).toBe(2);
    expect(evaluateSeverityGate(report, "CRITICAL").fail).toBe(false);
  });

  it("excepts manifest-not-regular when both sides match their exact bytes (ADR-019)", () => {
    // ADR-019
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-manifest",
      failure: {
        kind: "manifest-not-regular",
        detail: "package.json is not a regular file",
        evidence: null,
      },
    };
    const newFailure: PackageAnalysisFailure = {
      stage: "new-manifest",
      failure: {
        kind: "manifest-not-regular",
        detail: "package.json is not a regular file",
        evidence: null,
      },
    };
    const entries =
      "  - package: big-native-pkg\n" +
      "    version: 1.0.0\n" +
      `    integrity: ${SRI_B}\n` +
      "    kind: manifest-not-regular\n" +
      '    justification: "reviewed non-regular old manifest"\n' +
      "  - package: big-native-pkg\n" +
      "    version: 2.3.4\n" +
      `    integrity: ${SRI_A}\n` +
      "    kind: manifest-not-regular\n" +
      '    justification: "reviewed non-regular new manifest"\n';
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure, newFailure])]),
      config(entries),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toEqual({
      reason: "[version 2.3.4] reviewed non-regular new manifest",
    });
    const report = buildRunReport(applied);
    expect(report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(report, "CRITICAL").fail).toBe(false);
  });

  it("does not release when only the old side is excepted (rule C.2)", () => {
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-extraction",
      failure: { kind: "expanded-size-limit", detail: "old too big" },
    };
    const entries =
      "  - package: big-native-pkg\n" +
      "    version: 1.0.0\n" +
      `    integrity: ${SRI_B}\n` +
      "    kind: expanded-size-limit\n" +
      '    justification: "reviewed old artifact"\n';
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure, NEW_FILE_COUNT])]),
      config(entries),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
    const report = buildRunReport(applied);
    expect(report.summary.gateSeverity.CRITICAL).toBe(1);
    expect(evaluateSeverityGate(report, "CRITICAL").fail).toBe(true);
  });

  it("does not release when the entries are swapped across sides", () => {
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-extraction",
      failure: { kind: "invalid-archive", detail: "old artifact invalid" },
    };
    const entries =
      "  - package: big-native-pkg\n" +
      "    version: 2.3.4\n" +
      `    integrity: ${SRI_A}\n` +
      "    kind: invalid-archive\n" +
      '    justification: "swapped"\n' +
      "  - package: big-native-pkg\n" +
      "    version: 1.0.0\n" +
      `    integrity: ${SRI_B}\n` +
      "    kind: file-count-limit\n" +
      '    justification: "swapped"\n';
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure, NEW_FILE_COUNT])]),
      config(entries),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("keeps gating when a non-mismatch fetch failure accompanies a matched new-side failure (rule C.3)", () => {
    const overSize: PackageAnalysisFailure = {
      stage: "fetch",
      failure: {
        side: "old",
        kind: "size-limit-exceeded",
        detail: "old tarball over the download cap",
        url: "https://registry.npmjs.org/big-native-pkg/-/big-native-pkg-1.0.0.tgz",
      },
    };
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([NEW_FILE_COUNT, overSize])]),
      config(MATCHING_ENTRY),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
    const report = buildRunReport(applied);
    expect(report.summary.gateSeverity.CRITICAL).toBe(1);
    expect(evaluateSeverityGate(report, "CRITICAL").fail).toBe(true);
  });

  it("keeps gating when a matched new-side failure has an unmatched old-side failure", () => {
    const oldFailure: PackageAnalysisFailure = {
      stage: "old-extraction",
      failure: { kind: "invalid-archive", detail: "old artifact invalid" },
    };
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([oldFailure, NEW_FILE_COUNT])]),
      config(MATCHING_ENTRY),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("keeps the package gating when only one of two CRITICAL failures matches", () => {
    const second: PackageAnalysisFailure = {
      stage: "new-manifest",
      failure: {
        kind: "manifest-missing",
        detail: "no package.json",
        evidence: null,
      },
    };
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([NEW_FILE_COUNT, second])]),
      config(MATCHING_ENTRY),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("keeps the package gating when it also has an integrity mismatch", () => {
    const mismatch: PackageAnalysisFailure = {
      stage: "fetch",
      failure: {
        side: "new",
        kind: "integrity-mismatch",
        detail: "downloaded bytes do not match lockfile sha512 integrity",
        url: "https://registry.npmjs.org/big-native-pkg/-/big-native-pkg-2.3.4.tgz",
      },
    };
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([NEW_FILE_COUNT, mismatch])]),
      config(MATCHING_ENTRY),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("never releases a package with no severity-bearing failure", () => {
    const transient: PackageAnalysisFailure = {
      stage: "fetch",
      failure: {
        side: "new",
        kind: "network-error",
        detail: "connection reset",
        url: "https://registry.npmjs.org/big-native-pkg/-/big-native-pkg-2.3.4.tgz",
      },
    };
    const applied = applyUnanalyzableExceptions(
      runWith([unavailable([transient])]),
      config(MATCHING_ENTRY),
    );
    const item = applied.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toBeUndefined();
  });

  it("never touches analyzed packages", () => {
    const analyzed: CapabilityAnalysisRun["packages"][number] = {
      status: "analyzed",
      changedPackage: changedPackage({ name: "reviewed-pkg" }),
      diff: {
        baseline: { ecosystem: "npm", name: "reviewed-pkg", version: "1.0.0" },
        subject: { ecosystem: "npm", name: "reviewed-pkg", version: "2.3.4" },
        newPackage: false,
        findings: [],
        diagnostics: [],
      },
      issues: [],
      baselineFailures: [],
    };
    const applied = applyUnanalyzableExceptions(
      runWith([analyzed, unavailable([NEW_FILE_COUNT])]),
      config(MATCHING_ENTRY),
    );
    expect(applied.packages[0]).toBe(analyzed);
    const unavailableItem = applied.packages[1];
    if (unavailableItem?.status !== "unavailable") {
      throw new Error("fixture drift");
    }
    expect(unavailableItem.exception).toBeDefined();
  });
});
