import type {
  CapabilityDiffResult,
  FindingSeverity,
} from "./capability-differ.js";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import { buildReport, buildRunReport } from "./report-builder.js";
import type {
  JsonReport,
  JsonReportAnalysisIssue,
  JsonReportFinding,
  ReportEvidence,
  ReportPackage,
  SeverityCounts,
} from "./report-contract.js";

export { ReporterContractError, ReporterError } from "./report-builder.js";
export { REPORT_SCHEMA_VERSION } from "./report-contract.js";
export type {
  JsonReport,
  JsonReportAnalysisIssue,
  JsonReportDiagnostic,
  JsonReportFinding,
  JsonReportLockfileFinding,
  JsonReportShapeFinding,
  JsonReportSkippedPackage,
  JsonRunPackage,
  JsonRunReport,
  ReportAnalysisIssueKind,
  ReportCapability,
  ReportCodeCapability,
  ReportCommandEntrypointCapability,
  ReportDependencyCapability,
  ReportEvidence,
  ReportInstallHookCapability,
  ReportPackage,
  ReportRuntimeConstraintCapability,
  SeverityCounts,
} from "./report-contract.js";

const SEVERITIES: readonly FindingSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];

/** Stable machine-readable report. JSON.stringify performs JSON escaping. */
export function renderJsonReport(result: CapabilityDiffResult): string {
  return `${JSON.stringify(buildReport(result), null, 2)}\n`;
}

/** Escaped deterministic terminal text; no colors, timestamps, or links. */
export function renderTextReport(result: CapabilityDiffResult): string {
  const report = buildReport(result);
  return `${renderTextReportFromBuilt(report).join("\n")}\n`;
}

function renderTextReportFromBuilt(report: JsonReport): string[] {
  const baseline =
    report.package.oldVersion === null
      ? "<new package>"
      : quote(report.package.oldVersion);
  const lines = [
    "capdelta manifest capability report",
    `Package: ${quote(report.package.name)} (${quote(report.package.ecosystem)}) ${baseline} -> ${quote(report.package.newVersion)}`,
    summaryLine(report),
  ];

  if ((report.shapes?.length ?? 0) > 0) {
    lines.push("", "Capability shapes:");
    for (const shape of report.shapes ?? []) {
      lines.push(
        `- [${shape.severity}] ${quote(shape.ruleId)} (${count(shape.capabilities.length, "capability")})`,
      );
    }
  }

  if (report.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      lines.push(
        `- [${finding.severity}] ${findingDescription(finding)}`,
        ...finding.capability.evidence.map(
          (evidence) => `  Evidence: ${evidenceText(evidence)}`,
        ),
      );
    }
  }

  if (report.diagnostics.length > 0) {
    lines.push("", "Unanalyzed data:");
    for (const diagnostic of report.diagnostics) {
      lines.push(
        `- [${diagnostic.side}] ${quote(diagnostic.detail)}`,
        ...diagnostic.evidence.map(
          (evidence) => `  Evidence: ${evidenceText(evidence)}`,
        ),
      );
    }
  }

  return lines;
}

/** Stable machine-readable report for one complete capability-analysis run. */
export function renderJsonRunReport(run: CapabilityAnalysisRun): string {
  return `${JSON.stringify(buildRunReport(run), null, 2)}\n`;
}

/**
 * Deterministic terminal report. First-run mode stays aggregate-only in text;
 * JSON retains every package detail (PLAN §4.1).
 */
export function renderTextRunReport(run: CapabilityAnalysisRun): string {
  const report = buildRunReport(run);
  const severitySummary = severityCountsText(report.summary.bySeverity);
  const lines = [
    "capdelta capability analysis report",
    report.firstRun
      ? "Mode: first run (aggregate text; full details are in JSON)"
      : "Mode: comparison",
    `Packages: ${String(report.summary.changedPackages)} changed; ${String(report.summary.analyzedPackages)} analyzed; ${String(report.summary.unavailablePackages)} unavailable; ${count(report.summary.skippedLockfileEntries, "lockfile skip")}.`,
    `Signals: ${count(report.summary.capabilityFindings, "capability finding")}${severitySummary.length === 0 ? "" : ` (${severitySummary})`}; ${count(report.summary.lockfileFindings, "lockfile finding")}; ${count(report.summary.analysisIssues, "analysis issue")}; ${count(report.summary.analysisDiagnostics, "analysis diagnostic")}.`,
  ];

  if (report.firstRun) return `${lines.join("\n")}\n`;

  for (const item of report.packages) {
    if (item.status === "analyzed") {
      lines.push("", ...renderTextReportFromBuilt(item.report));
      if (item.issues.length > 0) {
        lines.push(
          "Analysis issues:",
          ...item.issues.map((issue) => `- ${analysisIssueText(issue)}`),
        );
      }
      continue;
    }

    lines.push(
      "",
      `Unavailable package: ${reportPackageIdentity(item.package)}`,
      ...item.failures.map((failure) => `- ${analysisIssueText(failure)}`),
    );
  }

  if (report.lockfileFindings.length > 0) {
    lines.push(
      "",
      "Lockfile findings:",
      ...report.lockfileFindings.map(
        (finding) =>
          `- [${finding.kind}] ${quote(finding.name)} at ${quote(finding.path)}: ${finding.oldVersion === null ? "<new package>" : quote(finding.oldVersion)} -> ${quote(finding.newVersion)}`,
      ),
    );
  }

  if (report.skipped.length > 0) {
    lines.push(
      "",
      "Skipped lockfile entries:",
      ...report.skipped.map(
        (skipped) =>
          `- [${skipped.reason}] ${quote(skipped.name)} at ${quote(skipped.path)}: ${quote(skipped.detail)}`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function summaryLine(report: JsonReport): string {
  if (report.findings.length === 0) {
    return `Review this change: no manifest capability additions; ${count(report.diagnostics.length, "diagnostic")}.`;
  }
  const severitySummary = severityCountsText(report.summary.bySeverity);
  return `Review this change: ${count(report.findings.length, "finding")} (${severitySummary}); ${count(report.diagnostics.length, "diagnostic")}.`;
}

function severityCountsText(bySeverity: SeverityCounts): string {
  return SEVERITIES.filter((severity) => bySeverity[severity] > 0)
    .map((severity) => `${severity}: ${String(bySeverity[severity])}`)
    .join(", ");
}

function reportPackageIdentity(reportPackage: ReportPackage): string {
  const baseline =
    reportPackage.oldVersion === null
      ? "<new package>"
      : quote(reportPackage.oldVersion);
  return `${quote(reportPackage.name)} (${quote(reportPackage.ecosystem)}) ${baseline} -> ${quote(reportPackage.newVersion)}`;
}

function analysisIssueText(issue: JsonReportAnalysisIssue): string {
  const context = [
    issue.url === null ? null : `URL ${quote(issue.url)}`,
    issue.evidence === null ? null : `Evidence ${evidenceText(issue.evidence)}`,
  ].filter((item): item is string => item !== null);
  return `[${issue.stage}/${issue.kind}] ${quote(issue.detail)}${context.length === 0 ? "" : `; ${context.join("; ")}`}`;
}

function findingDescription(finding: JsonReportFinding): string {
  const capability = finding.capability;
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return `${quote(capability.hook)} ${capability.applicability === "registry-install" ? "registry install" : "git-only"} hook ${finding.change}`;
    case "COMMAND_ENTRYPOINT":
      return `command ${quote(capability.command)} entrypoint ${finding.change}: ${quote(capability.target)}`;
    case "DEPENDENCY":
      return `dependency ${quote(capability.name)} ${finding.change}: ${quote(capability.requirement)}${finding.relatedReportIds === undefined || finding.relatedReportIds.length === 0 ? "" : ` -> see ${finding.relatedReportIds.map(quote).join(", ")}`}`;
    case "RUNTIME_CONSTRAINT":
      return `runtime ${quote(capability.runtime)} constraint ${finding.change}: ${quote(capability.requirement)}`;
    default:
      return `${quote(capability.kind)} capability ${finding.change} in ${quote(capability.location.kind)} code`;
  }
}

function evidenceText(evidence: ReportEvidence): string {
  return `${quote(evidence.file)}:${String(evidence.line)} — ${quote(evidence.snippet)}`;
}

function count(value: number, singular: string): string {
  return `${String(value)} ${singular}${value === 1 ? "" : "s"}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
