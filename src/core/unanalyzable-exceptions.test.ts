import { describe, expect, it } from "vitest";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
  UnavailablePackage,
} from "./capability-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { parseCapdeltaConfig } from "./capdelta-config.js";
import { applyUnanalyzableExceptions } from "./unanalyzable-exceptions.js";

// Two canonical sha512 SRI tokens (64 bytes each), matching the parser tests.
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
    // The failure survives untouched.
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

  it("matches an old-side failure with oldVersion and oldIntegrity", () => {
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
    expect(item.exception?.reason).toBe(
      "[version 1.0.0] reviewed old artifact",
    );
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
    // A matching entry for the analyzed package's name is irrelevant: the
    // post-pass only rewrites unavailable records.
    expect(unavailableItem.exception).toBeDefined();
  });
});
