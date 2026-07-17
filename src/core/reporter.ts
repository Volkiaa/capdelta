import type {
  Capability,
  ContentDigest,
  Evidence,
  InstallHook,
} from "./contract/capability-set.js";
import type {
  CapabilityChange,
  CapabilityDiffDiagnostic,
  CapabilityDiffResult,
  FindingSeverity,
} from "./capability-differ.js";

export const REPORT_SCHEMA_VERSION = 1 as const;

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

export interface ReportPackage {
  ecosystem: string;
  name: string;
  oldVersion: string | null;
  newVersion: string;
  newPackage: boolean;
}

export interface ReportEvidence {
  file: string;
  line: number;
  snippet: string;
}

interface ReportCapabilityBase {
  evidence: readonly ReportEvidence[];
}

export interface ReportInstallHookCapability extends ReportCapabilityBase {
  kind: "INSTALL_HOOK";
  hook: InstallHook;
  applicability: "registry-install" | "git-only";
  contentDigest: ContentDigest;
}

export interface ReportCommandEntrypointCapability extends ReportCapabilityBase {
  kind: "COMMAND_ENTRYPOINT";
  command: string;
  target: string;
}

export interface ReportDependencyCapability extends ReportCapabilityBase {
  kind: "DEPENDENCY";
  name: string;
  requirement: string;
}

export interface ReportRuntimeConstraintCapability extends ReportCapabilityBase {
  kind: "RUNTIME_CONSTRAINT";
  runtime: string;
  requirement: string;
}

export type ReportCapability =
  | ReportInstallHookCapability
  | ReportCommandEntrypointCapability
  | ReportDependencyCapability
  | ReportRuntimeConstraintCapability;

export interface JsonReportFinding {
  severity: FindingSeverity;
  change: CapabilityChange;
  capability: ReportCapability;
  previous: ReportCapability | null;
}

export interface JsonReportDiagnostic {
  side: "old" | "new";
  kind: CapabilityDiffDiagnostic["diagnostic"]["kind"];
  detail: string;
  evidence: readonly ReportEvidence[];
}

export interface SeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

export interface JsonReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  package: ReportPackage;
  summary: {
    findings: number;
    diagnostics: number;
    bySeverity: SeverityCounts;
  };
  findings: readonly JsonReportFinding[];
  diagnostics: readonly JsonReportDiagnostic[];
}

export class ReporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Differ result violates the M1 Reporter contract. */
export class ReporterContractError extends ReporterError {}

/** Stable machine-readable report. JSON.stringify performs JSON escaping. */
export function renderJsonReport(result: CapabilityDiffResult): string {
  return `${JSON.stringify(buildReport(result), null, 2)}\n`;
}

/** Escaped deterministic terminal text; no colors, timestamps, or links. */
export function renderTextReport(result: CapabilityDiffResult): string {
  const report = buildReport(result);
  const baseline =
    report.package.oldVersion === null
      ? "<new package>"
      : quote(report.package.oldVersion);
  const lines = [
    "capdelta manifest capability report",
    `Package: ${quote(report.package.name)} (${quote(report.package.ecosystem)}) ${baseline} -> ${quote(report.package.newVersion)}`,
    summaryLine(report),
  ];

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

  return `${lines.join("\n")}\n`;
}

function buildReport(result: CapabilityDiffResult): JsonReport {
  validateResult(result);
  const findings = result.findings.map((finding) => ({
    severity: finding.severity,
    change: finding.change,
    capability: reportCapability(finding.capability),
    previous:
      finding.previous === null ? null : reportCapability(finding.previous),
  }));
  const diagnostics = result.diagnostics.map(reportDiagnostic);
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
    summary: {
      findings: findings.length,
      diagnostics: diagnostics.length,
      bySeverity,
    },
    findings,
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
      throw new ReporterContractError(
        `M1 manifest Reporter does not support ${capability.kind}`,
      );
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
      throw new ReporterContractError(
        `M1 manifest Reporter does not support ${capability.kind}`,
      );
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

function summaryLine(report: JsonReport): string {
  if (report.findings.length === 0) {
    return `Review this change: no manifest capability additions; ${count(report.diagnostics.length, "diagnostic")}.`;
  }
  const severitySummary = SEVERITIES.filter(
    (severity) => report.summary.bySeverity[severity] > 0,
  )
    .map(
      (severity) =>
        `${severity}: ${String(report.summary.bySeverity[severity])}`,
    )
    .join(", ");
  return `Review this change: ${count(report.findings.length, "finding")} (${severitySummary}); ${count(report.diagnostics.length, "diagnostic")}.`;
}

function findingDescription(finding: JsonReportFinding): string {
  const capability = finding.capability;
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return `${quote(capability.hook)} ${capability.applicability === "registry-install" ? "registry install" : "git-only"} hook ${finding.change}`;
    case "COMMAND_ENTRYPOINT":
      return `command ${quote(capability.command)} entrypoint ${finding.change}: ${quote(capability.target)}`;
    case "DEPENDENCY":
      return `dependency ${quote(capability.name)} ${finding.change}: ${quote(capability.requirement)}`;
    case "RUNTIME_CONSTRAINT":
      return `runtime ${quote(capability.runtime)} constraint ${finding.change}: ${quote(capability.requirement)}`;
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

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}
