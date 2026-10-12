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

export const REPORT_SCHEMA_VERSION = 5 as const;

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
  /** Non-null only for issues that are severities themselves (PLAN §4.2). */
  severity: FindingSeverity | null;
}

export interface JsonReportLockfileFinding {
  kind: LockfileFindingKind;
  name: string;
  path: string;
  oldVersion: string | null;
  newVersion: string;
  severity: FindingSeverity;
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
      /**
       * ADR-017: present when every severity-bearing failure is a reviewed
       * exception. The failures keep their severity and stay in the report;
       * the package adds nothing to `gateSeverity`.
       */
      exception?: { reason: string };
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
    /**
     * Capability and signal findings of analyzed packages, including
     * suppressed ones; excludes lockfile findings and analysis issues.
     */
    bySeverity: SeverityCounts;
    /**
     * What the severity gate evaluates: unsuppressed capability and signal
     * findings, lockfile findings, and severity-bearing analysis issues. An
     * unavailable package contributes one count, at the highest severity among
     * its failures (ADR-016); analyzed issues count individually. A package
     * with a reviewed `exception` (ADR-017) contributes nothing.
     */
    gateSeverity: SeverityCounts;
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
