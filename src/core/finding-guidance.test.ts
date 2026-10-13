import { describe, expect, it } from "vitest";
import { ALLOWLISTED_CAPABILITIES } from "./capdelta-config.js";
import type { PackageAnalysisFailure } from "./capability-analysis-pipeline.js";
import {
  ANALYSIS_ISSUE_CLASSES,
  ANALYSIS_ISSUE_GUIDANCE,
  CAPABILITY_GUIDANCE,
  SHAPE_GUIDANCE,
  SHAPE_RULE_IDS,
  SIGNAL_GUIDANCE,
  analysisIssueClass,
  analysisIssueGuidance,
  capabilityGuidance,
  guidanceWarranted,
  shapeGuidance,
  signalGuidance,
  type AnalysisIssueClass,
  type CapabilityGuidanceKind,
  type Guidance,
} from "./finding-guidance.js";
import type {
  JsonReportAnalysisIssue,
  ReportAnalysisIssueKind,
} from "./report-contract.js";
import {
  FETCH_STAGE_CRITICAL_KINDS,
  SeverityGateError,
  analysisIssueSeverity,
  isOperationalFailure,
  isUnanalyzableIssue,
} from "./run-severity.js";
import type { SignalFindingKind } from "./signal-differ.js";

function expectGuidance(guidance: Guidance | null): void {
  if (guidance === null) throw new Error("expected guidance, got null");
  expect(guidance.whyItMatters.length).toBeGreaterThan(0);
  expect(guidance.whatToCheck.length).toBeGreaterThan(0);
}

function operationalProbe(issue: {
  stage: JsonReportAnalysisIssue["stage"];
  kind: ReportAnalysisIssueKind;
}): PackageAnalysisFailure {
  return {
    stage: issue.stage,
    failure: { kind: issue.kind },
  } as PackageAnalysisFailure;
}

/**
 * Every class a (stage, kind) pair can map to, with the gate helpers' verdict
 * beside it, so a change to either side fails here. `null` means the issue is
 * severity-null and not operational: no guidance.
 */
const CLASS_CASES: {
  stage: JsonReportAnalysisIssue["stage"];
  kind: ReportAnalysisIssueKind;
  expected: AnalysisIssueClass | null;
}[] = [
  {
    stage: "fetch",
    kind: "integrity-mismatch",
    expected: "integrity-mismatch",
  },
  {
    stage: "fetch",
    kind: "http-status",
    expected: "lockfile-or-registry-fetch-failure",
  },
  {
    stage: "fetch",
    kind: "invalid-response",
    expected: "lockfile-or-registry-fetch-failure",
  },
  {
    stage: "fetch",
    kind: "size-limit-exceeded",
    expected: "lockfile-or-registry-fetch-failure",
  },
  {
    stage: "fetch",
    kind: "invalid-url",
    expected: "lockfile-or-registry-fetch-failure",
  },
  {
    stage: "fetch",
    kind: "unsupported-integrity",
    expected: "lockfile-or-registry-fetch-failure",
  },
  {
    stage: "new-extraction",
    kind: "expanded-size-limit",
    expected: "unanalyzable",
  },
  { stage: "new-manifest", kind: "manifest-missing", expected: "unanalyzable" },
  // ADR-019: a non-regular manifest is CRITICAL, so it reaches `unanalyzable`.
  {
    stage: "old-manifest",
    kind: "manifest-not-regular",
    expected: "unanalyzable",
  },
  { stage: "fetch", kind: "network-error", expected: "operational" },
  { stage: "fetch", kind: "timeout", expected: "operational" },
  { stage: "fetch", kind: "http-unavailable", expected: "operational" },
  { stage: "fetch", kind: "aborted", expected: "operational" },
  { stage: "analysis", kind: "deadline-exceeded", expected: "operational" },
  {
    stage: "old-extraction",
    kind: "deadline-exceeded",
    expected: "operational",
  },
  {
    stage: "new-manifest",
    kind: "analysis-aborted",
    expected: "operational",
  },
  { stage: "new-extraction", kind: "filesystem-error", expected: null },
  { stage: "new-manifest", kind: "manifest-unreadable", expected: null },
  { stage: "new-cleanup", kind: "cleanup-failed", expected: null },
];

const BANNED_WORDS =
  /malware|malicious|detected|compromised|attack|attacker|backdoor|steal|worm/iu;

describe("finding guidance", () => {
  it("covers every shape rule, capability kind, and signal kind with guidance", () => {
    // The Record<Union, Guidance> declarations are the compile-time check; this
    // iterates the exported kind lists the config layer already owns.
    expect(Object.keys(SHAPE_GUIDANCE).sort()).toEqual(
      [...SHAPE_RULE_IDS].sort(),
    );
    for (const ruleId of SHAPE_RULE_IDS) expectGuidance(shapeGuidance(ruleId));

    const capabilityKinds = new Set<string>(Object.keys(CAPABILITY_GUIDANCE));
    const signalKinds = new Set<string>(Object.keys(SIGNAL_GUIDANCE));
    for (const capability of ALLOWLISTED_CAPABILITIES) {
      if (capabilityKinds.has(capability)) {
        expectGuidance(
          capabilityGuidance(capability as CapabilityGuidanceKind),
        );
      } else {
        expect(signalKinds.has(capability)).toBe(true);
        expectGuidance(signalGuidance(capability as SignalFindingKind));
      }
    }
    expect([...capabilityKinds, ...signalKinds].sort()).toEqual(
      [...ALLOWLISTED_CAPABILITIES].sort(),
    );
  });

  it("covers every analysis-issue class with guidance", () => {
    expect(Object.keys(ANALYSIS_ISSUE_GUIDANCE).sort()).toEqual(
      [...ANALYSIS_ISSUE_CLASSES].sort(),
    );
    for (const issueClass of ANALYSIS_ISSUE_CLASSES) {
      expectGuidance(ANALYSIS_ISSUE_GUIDANCE[issueClass]);
    }
  });

  it("classifies every (stage, kind) pair in agreement with the gate helpers", () => {
    for (const { stage, kind, expected } of CLASS_CASES) {
      const issue = { stage, kind };
      const severity = analysisIssueSeverity(issue);
      const unanalyzable = isUnanalyzableIssue(issue);
      const operational = isOperationalFailure(operationalProbe(issue));
      expect(analysisIssueClass(issue)).toBe(expected);
      // The gate helpers must agree with the class the classifier picked.
      if (expected === "operational") {
        expect(operational).toBe(true);
        expect(severity).toBeNull();
        expect(unanalyzable).toBe(false);
      } else if (expected === null) {
        expect(severity).toBeNull();
        expect(operational).toBe(false);
        expect(unanalyzable).toBe(false);
      } else if (expected === "integrity-mismatch") {
        expect(severity).toBe("CRITICAL");
        expect(unanalyzable).toBe(false);
        expect(operational).toBe(false);
      } else if (expected === "lockfile-or-registry-fetch-failure") {
        expect(severity).toBe("CRITICAL");
        // These are CRITICAL and unanalyzable, but the fetch-failure class is
        // more specific, so it wins in `analysisIssueClass`.
        expect(unanalyzable).toBe(true);
        expect(operational).toBe(false);
      } else {
        expect(severity).toBe("CRITICAL");
        expect(unanalyzable).toBe(true);
        expect(operational).toBe(false);
      }
    }
  });

  it("covers every class with a reachable case", () => {
    const seen = new Set(CLASS_CASES.map((item) => item.expected));
    for (const issueClass of ANALYSIS_ISSUE_CLASSES) {
      expect(seen.has(issueClass)).toBe(true);
    }
    // Non-operational, severity-null issues are the only null-guidance case.
    expect(seen.has(null)).toBe(true);
  });

  it("maps every fetch-stage critical kind except integrity-mismatch to a fetch failure", () => {
    for (const kind of FETCH_STAGE_CRITICAL_KINDS) {
      const issue = { stage: "fetch" as const, kind };
      if (kind === "integrity-mismatch") {
        expect(analysisIssueClass(issue)).toBe("integrity-mismatch");
        expect(analysisIssueGuidance(issue)).toBe(
          ANALYSIS_ISSUE_GUIDANCE["integrity-mismatch"],
        );
        continue;
      }
      expect(analysisIssueClass(issue)).toBe(
        "lockfile-or-registry-fetch-failure",
      );
      const guidance = analysisIssueGuidance(issue);
      if (guidance === null) {
        throw new Error(`expected guidance for fetch/${kind}`);
      }
      expect(guidance).toBe(
        ANALYSIS_ISSUE_GUIDANCE["lockfile-or-registry-fetch-failure"],
      );
      // The only permitted use of "exception" is to say it cannot cover this.
      const withoutAllowed =
        `${guidance.whyItMatters} ${guidance.whatToCheck}`.replace(
          "A reviewed exception cannot cover this failure.",
          "",
        );
      expect(withoutAllowed).not.toContain("exception");
      // A size-limit failure is one of the fetch critical kinds this class
      // covers, so the guidance must name the download-size limit.
      expect(guidance.whatToCheck).toContain("download-size limit");
    }
  });

  it("never returns unanalyzable guidance for a fetch-stage issue", () => {
    const fetchKinds = [
      ...FETCH_STAGE_CRITICAL_KINDS,
      "http-unavailable",
      "timeout",
      "aborted",
      "network-error",
    ] as const;
    for (const kind of fetchKinds) {
      const issue = { stage: "fetch" as const, kind };
      expect(analysisIssueClass(issue)).not.toBe("unanalyzable");
      expect(analysisIssueGuidance(issue)).not.toBe(
        ANALYSIS_ISSUE_GUIDANCE.unanalyzable,
      );
    }
  });

  it("returns null guidance for a severity-null, non-operational issue", () => {
    expect(
      analysisIssueGuidance({
        stage: "new-extraction",
        kind: "filesystem-error",
      }),
    ).toBeNull();
    expect(
      analysisIssueGuidance({ stage: "new-cleanup", kind: "cleanup-failed" }),
    ).toBeNull();
  });

  it("warrants guidance only for CRITICAL and HIGH", () => {
    expect(guidanceWarranted("CRITICAL")).toBe(true);
    expect(guidanceWarranted("HIGH")).toBe(true);
    expect(guidanceWarranted("MEDIUM")).toBe(false);
    expect(guidanceWarranted("LOW")).toBe(false);
    expect(guidanceWarranted("INFO")).toBe(false);
  });

  it("never lets an impossible (stage, kind) pair fall through silently", () => {
    expect(() =>
      analysisIssueClass({ stage: "fetch", kind: "manifest-missing" }),
    ).toThrow(SeverityGateError);
    expect(() =>
      analysisIssueClass({ stage: "new-manifest", kind: "network-error" }),
    ).toThrow(SeverityGateError);
  });

  it("keeps every guidance string free of malware claims", () => {
    const strings = [
      ...Object.values(SHAPE_GUIDANCE),
      ...Object.values(CAPABILITY_GUIDANCE),
      ...Object.values(SIGNAL_GUIDANCE),
      ...Object.values(ANALYSIS_ISSUE_GUIDANCE),
    ].flatMap((guidance) => [guidance.whyItMatters, guidance.whatToCheck]);
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      expect(text).not.toMatch(BANNED_WORDS);
    }
  });
});
