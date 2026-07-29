import type {
  CapabilityLocation,
  CodeCapabilityKind,
  ContentDigest,
  InstallHook,
} from "./contract/capability-set.js";
import type {
  CapabilityChange,
  CapabilityDiffDiagnostic,
  FindingSeverity,
  ShapeRuleId,
} from "./capability-differ.js";
import type { SignalFindingKind } from "./signal-differ.js";
import type { PackageAnalysisFailure } from "./capability-analysis-pipeline.js";
import type { AnalysisBudgetSummary } from "./capability-analysis-pipeline.js";
import type { AnalysisStopKind } from "./analysis-execution-policy.js";
import type {
  LockfileFindingKind,
  SkipReason,
} from "./contract/lockfile-diff.js";
import type { FetchFailureKind } from "./npm/fetcher.js";
import type { ManifestCapabilityFailureKind } from "./npm/manifest-capability-extractor.js";
import type { ExtractionFailureKind } from "./npm/safe-extractor.js";

export const REPORT_SCHEMA_VERSION = 4 as const;

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
  benignPattern?: "node-gyp-rebuild" | "husky-install" | "patch-package";
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
  targetName?: string;
}

export interface ReportRuntimeConstraintCapability extends ReportCapabilityBase {
  kind: "RUNTIME_CONSTRAINT";
  runtime: string;
  requirement: string;
}

export interface ReportCodeCapability extends ReportCapabilityBase {
  kind: CodeCapabilityKind;
  location: CapabilityLocation;
}

export type ReportCapability =
  | ReportInstallHookCapability
  | ReportCommandEntrypointCapability
  | ReportDependencyCapability
  | ReportRuntimeConstraintCapability
  | ReportCodeCapability;

export interface JsonReportShapeFinding {
  ruleId: ShapeRuleId;
  severity: "CRITICAL";
  capabilities: readonly ReportCapability[];
  signals?: readonly JsonReportSignalFinding[];
}

export interface JsonReportSignalFinding {
  kind: SignalFindingKind;
  severity: FindingSeverity;
  change: CapabilityChange;
  detail: string;
  evidence: readonly ReportEvidence[];
  suppression?: { reason: string };
}

export interface JsonReportFinding {
  severity: FindingSeverity;
  change: CapabilityChange;
  capability: ReportCapability;
  previous: ReportCapability | null;
  relatedReportIds?: readonly string[];
  suppression?: { reason: string };
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

export type ReportAnalysisIssueKind =
  | FetchFailureKind
  | ExtractionFailureKind
  | ManifestCapabilityFailureKind
  | AnalysisStopKind
  | "cleanup-failed";

export interface JsonReportAnalysisIssue {
  stage: PackageAnalysisFailure["stage"];
  side: "old" | "new" | null;
  kind: ReportAnalysisIssueKind;
  detail: string;
  url: string | null;
  evidence: ReportEvidence | null;
}

export interface JsonReportLockfileFinding {
  kind: LockfileFindingKind;
  name: string;
  path: string;
  oldVersion: string | null;
  newVersion: string;
}

export interface JsonReportSkippedPackage {
  name: string;
  path: string;
  reason: SkipReason;
  detail: string;
}

export type JsonRunPackage =
  | {
      status: "analyzed";
      report: JsonReport;
      issues: readonly JsonReportAnalysisIssue[];
    }
  | {
      status: "unavailable";
      package: ReportPackage;
      failures: readonly [
        JsonReportAnalysisIssue,
        ...JsonReportAnalysisIssue[],
      ];
    };

export interface JsonRunReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  firstRun: boolean;
  summary: {
    changedPackages: number;
    analyzedPackages: number;
    unavailablePackages: number;
    skippedLockfileEntries: number;
    capabilityFindings: number;
    signalFindings?: number;
    analysisDiagnostics: number;
    analysisIssues: number;
    lockfileFindings: number;
    bySeverity: SeverityCounts;
  };
  packages: readonly JsonRunPackage[];
  lockfileFindings: readonly JsonReportLockfileFinding[];
  skipped: readonly JsonReportSkippedPackage[];
  budget?: AnalysisBudgetSummary;
}

export interface JsonReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  package: ReportPackage;
  reportId?: string;
  summary: {
    findings: number;
    capabilityFindings?: number;
    signalFindings?: number;
    diagnostics: number;
    bySeverity: SeverityCounts;
  };
  findings: readonly JsonReportFinding[];
  signalFindings?: readonly JsonReportSignalFinding[];
  shapes?: readonly JsonReportShapeFinding[];
  diagnostics: readonly JsonReportDiagnostic[];
}
