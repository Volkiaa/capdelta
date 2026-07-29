import type {
  Capability,
  Evidence,
  PackageSubject,
} from "./contract/capability-set.js";
import type {
  CapabilityDiffDiagnostic,
  CapabilityDiffResult,
  FindingSeverity,
} from "./capability-differ.js";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "./capability-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import {
  REPORT_SCHEMA_VERSION,
  type JsonReport,
  type JsonReportAnalysisIssue,
  type JsonReportDiagnostic,
  type JsonRunPackage,
  type JsonRunReport,
  type ReportCapability,
  type ReportEvidence,
  type ReportPackage,
  type SeverityCounts,
} from "./report-contract.js";
import { createHash } from "node:crypto";

const MAX_IDENTITY_CHARS = 160;
const MAX_VALUE_CHARS = 240;
const MAX_EVIDENCE_FILE_CHARS = 200;
const MAX_EVIDENCE_SNIPPET_CHARS = 240;
const SEVERITIES: readonly FindingSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];

export class ReporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Differ result violates the Reporter contract. */
export class ReporterContractError extends ReporterError {}

export function buildRunReport(run: CapabilityAnalysisRun): JsonRunReport {
  validateRun(run);
  const bySeverity = emptySeverityCounts();
  let capabilityFindings = 0;
  let analysisDiagnostics = 0;
  let analysisIssues = 0;
  const packages = run.packages.map((item): JsonRunPackage => {
    if (item.status === "analyzed") {
      const report = buildReport(item.diff);
      capabilityFindings += report.summary.findings;
      analysisDiagnostics += report.summary.diagnostics;
      for (const severity of SEVERITIES) {
        bySeverity[severity] += report.summary.bySeverity[severity];
      }
      const issues = item.issues.map(reportAnalysisIssue);
      analysisIssues += issues.length;
      return { status: "analyzed", report, issues };
    }

    const failures = reportAnalysisFailures(item.failures);
    analysisIssues += failures.length;
    return {
      status: "unavailable",
      package: reportChangedPackage(item.changedPackage),
      failures,
    };
  });
  crossLinkDependencies(packages);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    firstRun: run.firstRun,
    summary: {
      changedPackages: run.summary.changed,
      analyzedPackages: run.summary.analyzed,
      unavailablePackages: run.summary.unavailable,
      skippedLockfileEntries: run.summary.skipped,
      capabilityFindings,
      analysisDiagnostics,
      analysisIssues,
      lockfileFindings: run.lockfileFindings.length,
      bySeverity,
    },
    packages,
    lockfileFindings: run.lockfileFindings.map((finding) => ({
      kind: finding.kind,
      name: truncate(finding.name, MAX_IDENTITY_CHARS),
      path: truncate(finding.path, MAX_EVIDENCE_FILE_CHARS),
      oldVersion:
        finding.oldVersion === null
          ? null
          : truncate(finding.oldVersion, MAX_IDENTITY_CHARS),
      newVersion: truncate(finding.newVersion, MAX_IDENTITY_CHARS),
    })),
    skipped: run.skipped.map((skipped) => ({
      name: truncate(skipped.name, MAX_IDENTITY_CHARS),
      path: truncate(skipped.path, MAX_EVIDENCE_FILE_CHARS),
      reason: skipped.reason,
      detail: truncate(skipped.detail, MAX_VALUE_CHARS),
    })),
  };
}

function validateRun(run: CapabilityAnalysisRun): void {
  const analyzed = run.packages.filter(
    (item) => item.status === "analyzed",
  ).length;
  const unavailable = run.packages.length - analyzed;
  if (
    run.summary.changed !== run.packages.length ||
    run.summary.analyzed !== analyzed ||
    run.summary.unavailable !== unavailable ||
    run.summary.skipped !== run.skipped.length
  ) {
    throw new ReporterContractError(
      "analysis-run summary does not match its package and skip records",
    );
  }

  for (const item of run.packages) {
    validateChangedPackage(item.changedPackage);
    if (item.status === "unavailable") continue;
    const expected = item.changedPackage;
    if (
      item.diff.subject.ecosystem !== "npm" ||
      item.diff.subject.name !== expected.name ||
      item.diff.subject.version !== expected.newVersion ||
      item.diff.newPackage !== (expected.oldVersion === null) ||
      (expected.oldVersion === null
        ? item.diff.baseline !== null
        : item.diff.baseline?.version !== expected.oldVersion)
    ) {
      throw new ReporterContractError(
        "analyzed package identity does not match its capability diff",
      );
    }
  }
}

function validateChangedPackage(changedPackage: ChangedPackage): void {
  if (
    changedPackage.name.length === 0 ||
    changedPackage.newVersion.length === 0 ||
    changedPackage.newIntegrity.length === 0 ||
    changedPackage.resolvedUrl.length === 0
  ) {
    throw new ReporterContractError(
      "changed package requires non-empty new-side fields",
    );
  }
  const oldFields = [
    changedPackage.oldVersion,
    changedPackage.oldIntegrity,
    changedPackage.oldResolvedUrl,
  ];
  const nullOldFields = oldFields.filter((field) => field === null).length;
  if (nullOldFields !== 0 && nullOldFields !== oldFields.length) {
    throw new ReporterContractError(
      "changed package old-side fields must be null as a unit",
    );
  }
}

function reportChangedPackage(changedPackage: ChangedPackage): ReportPackage {
  return {
    ecosystem: "npm",
    name: truncate(changedPackage.name, MAX_IDENTITY_CHARS),
    oldVersion:
      changedPackage.oldVersion === null
        ? null
        : truncate(changedPackage.oldVersion, MAX_IDENTITY_CHARS),
    newVersion: truncate(changedPackage.newVersion, MAX_IDENTITY_CHARS),
    newPackage: changedPackage.oldVersion === null,
  };
}

function reportAnalysisFailures(
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
): [JsonReportAnalysisIssue, ...JsonReportAnalysisIssue[]] {
  const [first, ...rest] = failures;
  return [reportAnalysisIssue(first), ...rest.map(reportAnalysisIssue)];
}

function reportAnalysisIssue(
  issue: PackageAnalysisFailure,
): JsonReportAnalysisIssue {
  if (issue.stage === "analysis") {
    return {
      stage: issue.stage,
      side: null,
      kind: issue.failure.kind,
      detail: truncate(issue.failure.detail, MAX_VALUE_CHARS),
      url: null,
      evidence: null,
    };
  }
  const side = issue.stage === "fetch" ? issue.failure.side : stageSide(issue);
  if (issue.stage === "fetch") {
    return {
      stage: issue.stage,
      side,
      kind: issue.failure.kind,
      detail: truncate(issue.failure.detail, MAX_VALUE_CHARS),
      url: truncate(issue.failure.url, MAX_VALUE_CHARS),
      evidence: null,
    };
  }
  if (issue.stage === "old-manifest" || issue.stage === "new-manifest") {
    return {
      stage: issue.stage,
      side,
      kind: issue.failure.kind,
      detail: truncate(issue.failure.detail, MAX_VALUE_CHARS),
      url: null,
      evidence:
        issue.failure.evidence === null
          ? null
          : reportEvidence(issue.failure.evidence),
    };
  }
  return {
    stage: issue.stage,
    side,
    kind: issue.failure.kind,
    detail: truncate(issue.failure.detail, MAX_VALUE_CHARS),
    url: null,
    evidence: null,
  };
}

function stageSide(
  issue: Exclude<
    PackageAnalysisFailure,
    { stage: "fetch" } | { stage: "analysis" }
  >,
): "old" | "new" {
  return issue.stage.startsWith("old-") ? "old" : "new";
}

export function buildReport(result: CapabilityDiffResult): JsonReport {
  validateResult(result);
  const findings = result.findings.map((finding) => ({
    severity: finding.severity,
    change: finding.change,
    capability: reportCapability(finding.capability),
    previous:
      finding.previous === null ? null : reportCapability(finding.previous),
  }));
  const diagnostics = result.diagnostics.map(reportDiagnostic);
  const shapes = (result.shapes ?? []).map((shape) => ({
    ruleId: shape.ruleId,
    severity: shape.severity,
    capabilities: shape.capabilities.map(reportCapability),
  }));
  const bySeverity = emptySeverityCounts();
  for (const finding of findings) bySeverity[finding.severity] += 1;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    package: {
      ecosystem: truncate(result.subject.ecosystem, MAX_IDENTITY_CHARS),
      name: truncate(result.subject.name, MAX_IDENTITY_CHARS),
      oldVersion:
        result.baseline === null
          ? null
          : truncate(result.baseline.version, MAX_IDENTITY_CHARS),
      newVersion: truncate(result.subject.version, MAX_IDENTITY_CHARS),
      newPackage: result.newPackage,
    },
    reportId: reportId(result.subject),
    summary: {
      findings: findings.length,
      diagnostics: diagnostics.length,
      bySeverity,
    },
    findings,
    shapes,
    diagnostics,
  };
}

function validateResult(result: CapabilityDiffResult): void {
  if (result.newPackage !== (result.baseline === null)) {
    throw new ReporterContractError(
      "newPackage must be true exactly when baseline is null",
    );
  }
  if (
    result.subject.ecosystem.length === 0 ||
    result.subject.name.length === 0 ||
    result.subject.version.length === 0
  ) {
    throw new ReporterContractError("report subject fields must be non-empty");
  }
  if (
    result.baseline !== null &&
    (result.baseline.ecosystem !== result.subject.ecosystem ||
      result.baseline.name !== result.subject.name)
  ) {
    throw new ReporterContractError(
      "report baseline and subject must identify the same package",
    );
  }
  for (const finding of result.findings) {
    if (
      (finding.change === "added" && finding.previous !== null) ||
      (finding.change === "changed" && finding.previous === null)
    ) {
      throw new ReporterContractError(
        `${finding.change} finding has inconsistent previous capability`,
      );
    }
    validateCapability(finding.capability);
    if (finding.previous !== null) validateCapability(finding.previous);
  }
  for (const diagnostic of result.diagnostics) {
    validateEvidence(diagnostic.diagnostic.evidence);
  }
  for (const shape of result.shapes ?? []) {
    if (shape.capabilities.length === 0) {
      throw new ReporterContractError("shape finding has no capabilities");
    }
    for (const capability of shape.capabilities) validateCapability(capability);
  }
}

function validateCapability(capability: Capability): void {
  switch (capability.kind) {
    case "INSTALL_HOOK":
    case "COMMAND_ENTRYPOINT":
    case "DEPENDENCY":
    case "RUNTIME_CONSTRAINT":
      validateEvidence(capability.evidence);
      return;
    default:
      validateEvidence(capability.evidence);
      return;
  }
}

function validateEvidence(evidence: readonly Evidence[]): void {
  if (evidence.length === 0) {
    throw new ReporterContractError("report item has no evidence");
  }
  for (const item of evidence) {
    if (!Number.isSafeInteger(item.line) || item.line <= 0) {
      throw new ReporterContractError(
        "evidence line must be a positive integer",
      );
    }
  }
}

function reportCapability(capability: Capability): ReportCapability {
  const evidence = capability.evidence.map(reportEvidence);
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return {
        kind: capability.kind,
        hook: capability.location.hook,
        applicability: capability.location.applicability,
        contentDigest: {
          algorithm: capability.contentDigest.algorithm,
          value: truncate(capability.contentDigest.value, 128),
        },
        evidence,
      };
    case "COMMAND_ENTRYPOINT":
      return {
        kind: capability.kind,
        command: truncate(capability.command, MAX_IDENTITY_CHARS),
        target: truncate(capability.target, MAX_VALUE_CHARS),
        evidence,
      };
    case "DEPENDENCY":
      return {
        kind: capability.kind,
        name: truncate(capability.name, MAX_IDENTITY_CHARS),
        requirement: truncate(capability.requirement, MAX_VALUE_CHARS),
        ...(capability.targetName === undefined
          ? {}
          : {
              targetName: truncate(capability.targetName, MAX_IDENTITY_CHARS),
            }),
        evidence,
      };
    case "RUNTIME_CONSTRAINT":
      return {
        kind: capability.kind,
        runtime: truncate(capability.runtime, MAX_IDENTITY_CHARS),
        requirement: truncate(capability.requirement, MAX_VALUE_CHARS),
        evidence,
      };
    default:
      return {
        kind: capability.kind,
        location: capability.location,
        evidence,
      };
  }
}

function reportEvidence(evidence: Evidence): ReportEvidence {
  return {
    file: truncate(evidence.file, MAX_EVIDENCE_FILE_CHARS),
    line: evidence.line,
    snippet: truncate(evidence.snippet, MAX_EVIDENCE_SNIPPET_CHARS),
  };
}

function reportDiagnostic(
  diagnostic: CapabilityDiffDiagnostic,
): JsonReportDiagnostic {
  return {
    side: diagnostic.side,
    kind: diagnostic.diagnostic.kind,
    detail: truncate(diagnostic.diagnostic.detail, MAX_VALUE_CHARS),
    evidence: diagnostic.diagnostic.evidence.map(reportEvidence),
  };
}

function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
}

function reportId(subject: PackageSubject): string {
  const digest = createHash("sha256")
    .update(`${subject.ecosystem}\0${subject.name}\0${subject.version}`)
    .digest("hex")
    .slice(0, 20);
  return `capdelta-${digest}`;
}

function crossLinkDependencies(packages: readonly JsonRunPackage[]): void {
  const byName = new Map<string, string[]>();
  for (const item of packages) {
    if (item.status !== "analyzed" || item.report.reportId === undefined)
      continue;
    const ids = byName.get(item.report.package.name) ?? [];
    ids.push(item.report.reportId);
    byName.set(item.report.package.name, ids);
  }
  for (const ids of byName.values()) ids.sort();
  for (const item of packages) {
    if (item.status !== "analyzed") continue;
    for (const finding of item.report.findings) {
      if (finding.capability.kind !== "DEPENDENCY") continue;
      const target = finding.capability.targetName ?? finding.capability.name;
      const related = byName.get(target);
      if (related !== undefined) finding.relatedReportIds = [...related];
    }
  }
}

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join("")}\u2026`;
}
