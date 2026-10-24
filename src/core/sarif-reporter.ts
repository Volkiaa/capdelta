import type { Evidence } from "./contract/capability-set.js";
import type {
  CapabilityFinding,
  FindingSeverity,
} from "./capability-differ.js";
import type {
  AnalyzedPackage,
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "./capability-analysis-pipeline.js";
import type {
  ChangedPackage,
  LockfileFinding,
} from "./contract/lockfile-diff.js";
import {
  MAX_EVIDENCE_FILE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  ReporterContractError,
  truncate,
} from "./report-builder.js";
import {
  analysisIssueGuidance,
  capabilityGuidance,
  lockfileGuidance,
  shapeGuidance,
  signalGuidance,
  type Guidance,
} from "./finding-guidance.js";
import { isNormalizedRelativePosixPath } from "./repository-path.js";
import { compareText } from "./compare.js";
import {
  isUnanalyzableIssue,
  analysisIssueSeverity,
  lockfileFindingSeverity,
} from "./run-severity.js";

export const SARIF_VERSION = "2.1.0" as const;
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INTEGRITY_RULE_ID = "CAPDELTA-INTEGRITY-MISMATCH";
const INTEL_RULE_ID = "CAPDELTA-LOCKFILE-INTEL-CONFIRMED-MALICIOUS";
const BASELINE_GUIDANCE: Guidance = {
  whyItMatters:
    "The old version could not be analyzed, so capdelta reports every capability of the new version as added.",
  whatToCheck:
    "Treat the additions as unreviewed and inspect the old version manually if the comparison matters.",
};

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: readonly unknown[];
  properties: Record<string, unknown>;
}

export interface SarifReportOptions {
  /**
   * Repository-relative path of the analyzed lockfile. Integrity-mismatch
   * results point at it; without it they have no location, and GitHub code
   * scanning does not display results without a location; the SARIF data still
   * carries them.
   */
  lockfilePath?: string;
}

/**
 * Deterministic SARIF 2.1.0. Capability and signal results point into package
 * artifacts; only integrity-mismatch results reference a checkout file, the
 * caller-supplied lockfile.
 */
export function renderSarifReport(
  run: CapabilityAnalysisRun,
  options: SarifReportOptions = {},
): string {
  const lockfilePath = options.lockfilePath;
  if (
    lockfilePath !== undefined &&
    !isNormalizedRelativePosixPath(lockfilePath)
  ) {
    throw new ReporterContractError(
      "SARIF lockfilePath must be a normalized relative POSIX path",
    );
  }
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();
  // PLAN §4.5
  const ruleGuidance = new Map<string, Guidance>();
  // ADR-016
  const unanalyzableRuleIds = new Set<string>();
  for (const item of run.packages) {
    // ADR-017
    const exceptionReason =
      item.status === "unavailable" ? item.exception?.reason : undefined;
    // PLAN §4.2
    for (const issue of item.status === "analyzed"
      ? item.issues
      : item.failures) {
      const severity = analysisIssueSeverity({
        stage: issue.stage,
        kind: issue.failure.kind,
      });
      if (severity === null) continue;
      const result = issueResult(
        item.changedPackage,
        issue,
        severity,
        lockfilePath,
        exceptionReason,
      );
      ruleIds.add(result.ruleId);
      const guidance = analysisIssueGuidance({
        stage: issue.stage,
        kind: issue.failure.kind,
      });
      if (guidance === null) {
        throw new ReporterContractError(
          `SARIF rule ${result.ruleId} has no reviewer guidance for ${issue.stage}/${issue.failure.kind}`,
        );
      }
      ruleGuidance.set(result.ruleId, guidance);
      if (
        isUnanalyzableIssue({
          stage: issue.stage,
          kind: issue.failure.kind,
        })
      ) {
        unanalyzableRuleIds.add(result.ruleId);
      }
      results.push(result);
    }
    if (item.status !== "analyzed") continue;
    appendBaselineResults(item, results, ruleIds, ruleGuidance);
    const subject = item.diff.subject;
    const memberSuppression = new Map(
      item.diff.findings.map((finding) => [
        finding.capability,
        finding.suppression?.reason,
      ]),
    );
    for (const shape of item.diff.shapes ?? []) {
      const ruleId = `CAPDELTA-SHAPE-${shape.ruleId.toUpperCase()}`;
      ruleIds.add(ruleId);
      ruleGuidance.set(ruleId, shapeGuidance(shape.ruleId));
      const suppression = shapeSuppression([
        ...shape.capabilities.map((capability) =>
          memberSuppression.get(capability),
        ),
        ...(shape.signals ?? []).map((finding) => finding.suppression?.reason),
      ]);
      results.push(
        resultFor(
          ruleId,
          shape.severity,
          `Review this change: ${shape.ruleId} capability shape in ${subject.name}@${subject.version}.${suppression.text}`,
          [
            ...shape.capabilities.flatMap((capability) => capability.evidence),
            ...(shape.signals ?? []).flatMap((finding) => finding.evidence),
          ],
          subject.name,
          subject.version,
          {
            kind: "shape",
            capabilities: shape.capabilities.map(
              (capability) => capability.kind,
            ),
            signals: (shape.signals ?? []).map((finding) => finding.kind),
            ...suppression.properties,
          },
        ),
      );
    }
    const covered = new Set(
      (item.diff.shapes ?? []).flatMap((shape) => shape.capabilities),
    );
    const coveredSignals = new Set(
      (item.diff.shapes ?? []).flatMap((shape) => shape.signals ?? []),
    );
    for (const finding of item.diff.findings) {
      if (covered.has(finding.capability)) continue;
      const ruleId = fallbackRuleId(finding);
      ruleIds.add(ruleId);
      ruleGuidance.set(ruleId, capabilityGuidance(finding.capability.kind));
      results.push(
        resultFor(
          ruleId,
          finding.severity,
          `Review this change: ${finding.capability.kind} capability ${finding.change} in ${subject.name}@${subject.version}.${suppressionText(finding.suppression?.reason)}`,
          finding.capability.evidence,
          subject.name,
          subject.version,
          {
            kind: "capability",
            capability: finding.capability.kind,
            change: finding.change,
            ...(finding.suppression === undefined
              ? {}
              : { suppression: finding.suppression.reason }),
          },
        ),
      );
    }
    for (const finding of item.diff.signalFindings ?? []) {
      if (coveredSignals.has(finding)) continue;
      const ruleId = `CAPDELTA-SIGNAL-${finding.kind.toUpperCase()}`;
      ruleIds.add(ruleId);
      ruleGuidance.set(ruleId, signalGuidance(finding.kind));
      results.push(
        resultFor(
          ruleId,
          finding.severity,
          `Review this change: ${finding.detail} in ${subject.name}@${subject.version}.${suppressionText(finding.suppression?.reason)}`,
          finding.evidence,
          subject.name,
          subject.version,
          {
            kind: "signal",
            signal: finding.kind,
            change: finding.change,
            ...(finding.suppression === undefined
              ? {}
              : { suppression: finding.suppression.reason }),
          },
        ),
      );
    }
  }
  appendLockfileResults(
    run.lockfileFindings,
    lockfilePath,
    results,
    ruleIds,
    ruleGuidance,
  );
  results.sort((left, right) =>
    compareText(
      JSON.stringify([left.ruleId, left.message.text, left.locations]),
      JSON.stringify([right.ruleId, right.message.text, right.locations]),
    ),
  );
  const rules = [...ruleIds].sort(compareText).map((id) => ({
    id,
    shortDescription: {
      text: ruleDescription(id, unanalyzableRuleIds.has(id)),
    },
    help: { text: ruleHelp(id, ruleGuidance.get(id)) },
  }));
  return `${JSON.stringify(
    {
      $schema: SARIF_SCHEMA,
      version: SARIF_VERSION,
      runs: [
        {
          tool: {
            driver: {
              name: "capdelta",
              informationUri: "https://github.com/Volkiaa/capdelta",
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function resultFor(
  ruleId: string,
  severity: FindingSeverity,
  message: string,
  evidence: readonly Evidence[],
  packageName: string,
  version: string,
  properties: Record<string, unknown>,
): SarifResult {
  const first = evidence[0];
  const locations =
    first === undefined
      ? []
      : [
          {
            physicalLocation: {
              artifactLocation: {
                uri: syntheticUri(packageName, version, first.file),
                uriBaseId: "CAPDELTA_PACKAGE_ROOT",
              },
              region: {
                startLine: first.line,
                snippet: { text: first.snippet },
              },
            },
          },
        ];
  return {
    ruleId,
    level: sarifLevel(severity),
    message: { text: message },
    locations,
    properties: {
      ...properties,
      severity,
      package: packageName,
      version,
      evidence: evidence.map((item) => ({
        file: item.file,
        line: item.line,
        snippet: item.snippet,
      })),
    },
  };
}

function issueResult(
  changedPackage: ChangedPackage,
  issue: PackageAnalysisFailure,
  severity: FindingSeverity,
  lockfilePath: string | undefined,
  exceptionReason: string | undefined,
): SarifResult {
  const side =
    issue.stage === "fetch"
      ? issue.failure.side
      : issue.stage.startsWith("old-")
        ? "old"
        : issue.stage.startsWith("new-")
          ? "new"
          : null;
  if (side === "old" && changedPackage.oldVersion === null) {
    throw new ReporterContractError(
      `old-side ${issue.failure.kind} issue for new package ${JSON.stringify(changedPackage.name)}`,
    );
  }
  const version =
    side === "old" && changedPackage.oldVersion !== null
      ? changedPackage.oldVersion
      : changedPackage.newVersion;
  const artifact = side === null ? "" : ` for the ${side} artifact`;
  // Name, version, detail, and URL come from the lockfile or registry: bound
  // them exactly as the JSON report does (PLAN §3 output injection).
  const name = truncate(changedPackage.name, MAX_IDENTITY_CHARS);
  const boundedVersion = truncate(version, MAX_IDENTITY_CHARS);
  const detail = truncate(issue.failure.detail, MAX_VALUE_CHARS);
  const reason =
    exceptionReason === undefined
      ? undefined
      : truncate(exceptionReason, MAX_VALUE_CHARS);
  const result = resultFor(
    `CAPDELTA-${issue.failure.kind.toUpperCase()}`,
    severity,
    `Review this change: ${detail}${artifact} of ${name}@${boundedVersion}; capdelta did not analyze it.${suppressionText(reason)}`,
    [],
    name,
    boundedVersion,
    {
      kind: "analysis-issue",
      stage: issue.stage,
      issue: issue.failure.kind,
      side,
      url:
        issue.stage === "fetch"
          ? truncate(issue.failure.url, MAX_VALUE_CHARS)
          : null,
      ...(reason === undefined ? {} : { suppression: reason }),
    },
  );
  if (lockfilePath === undefined) return result;
  return {
    ...result,
    locations: lockfileLocation(lockfilePath),
  };
}

function appendBaselineResults(
  item: AnalyzedPackage,
  results: SarifResult[],
  ruleIds: Set<string>,
  ruleGuidance: Map<string, Guidance>,
): void {
  for (const issue of item.baselineFailures) {
    const ruleId = `CAPDELTA-BASELINE-${issue.failure.kind.toUpperCase()}`;
    ruleIds.add(ruleId);
    ruleGuidance.set(ruleId, BASELINE_GUIDANCE);
    results.push(baselineFailureResult(item.changedPackage, issue));
  }
}

function baselineFailureResult(
  changedPackage: ChangedPackage,
  issue: PackageAnalysisFailure,
): SarifResult {
  // The kind is a fixed taxonomy, but bound it like every other report string.
  const kind = truncate(issue.failure.kind, MAX_IDENTITY_CHARS);
  return {
    ruleId: `CAPDELTA-BASELINE-${issue.failure.kind.toUpperCase()}`,
    level: "note",
    message: {
      text: `Old version could not be analyzed (${kind}); every capability of the new version is reported as added.`,
    },
    locations: [],
    properties: {
      kind: "baseline-failure",
      stage: issue.stage,
      issue: issue.failure.kind,
      side: "old",
      severity: analysisIssueSeverity({
        stage: issue.stage,
        kind: issue.failure.kind,
      }),
      package: truncate(changedPackage.name, MAX_IDENTITY_CHARS),
      version: truncate(changedPackage.newVersion, MAX_IDENTITY_CHARS),
      evidence: [],
    },
  };
}

function appendLockfileResults(
  findings: readonly LockfileFinding[],
  lockfilePath: string | undefined,
  results: SarifResult[],
  ruleIds: Set<string>,
  ruleGuidance: Map<string, Guidance>,
): void {
  for (const finding of findings) {
    const result = lockfileResult(finding, lockfilePath);
    ruleIds.add(result.ruleId);
    ruleGuidance.set(result.ruleId, lockfileGuidance(finding.kind));
    results.push(result);
  }
}

function lockfileResult(
  finding: LockfileFinding,
  lockfilePath: string | undefined,
): SarifResult {
  const ruleId = `CAPDELTA-LOCKFILE-${finding.kind.toUpperCase()}`;
  // Lockfile name, path, and versions are attacker-controlled: bound them
  // exactly as the JSON report does (report-builder.ts:117-126, PLAN §3).
  const name = truncate(finding.name, MAX_IDENTITY_CHARS);
  const path = truncate(finding.path, MAX_EVIDENCE_FILE_CHARS);
  const oldVersion =
    finding.oldVersion === null
      ? null
      : truncate(finding.oldVersion, MAX_IDENTITY_CHARS);
  const newVersion = truncate(finding.newVersion, MAX_IDENTITY_CHARS);
  const intelId =
    finding.intelId === undefined
      ? undefined
      : truncate(finding.intelId, MAX_IDENTITY_CHARS);
  const result = resultFor(
    ruleId,
    lockfileFindingSeverity(finding.kind),
    `Review this change: ${finding.kind} for ${name} at ${path}: ${oldVersion ?? "<new package>"} -> ${newVersion}.${intelId === undefined ? "" : ` Intel ID ${intelId}.`}`,
    [],
    name,
    newVersion,
    {
      kind: "lockfile",
      lockfileFinding: finding.kind,
      path,
      oldVersion,
      newVersion,
      ...(intelId === undefined ? {} : { intelId }),
    },
  );
  if (lockfilePath === undefined) return result;
  return { ...result, locations: lockfileLocation(lockfilePath) };
}

function lockfileLocation(lockfilePath: string): readonly unknown[] {
  return [
    {
      // Repository-root-relative, so no uriBaseId; each segment is encoded
      // once so %, #, ? and spaces stay filename characters.
      physicalLocation: {
        artifactLocation: {
          uri: lockfilePath.split("/").map(encodeURIComponent).join("/"),
        },
      },
    },
  ];
}

function syntheticUri(
  packageName: string,
  version: string,
  file: string,
): string {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `npm/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/${encodedFile}`;
}

function fallbackRuleId(finding: CapabilityFinding): string {
  return `CAPDELTA-CAPABILITY-${finding.capability.kind}`;
}

function sarifLevel(severity: FindingSeverity): "error" | "warning" | "note" {
  if (severity === "CRITICAL" || severity === "HIGH") return "error";
  if (severity === "MEDIUM") return "warning";
  return "note";
}

function ruleDescription(id: string, unanalyzable: boolean): string {
  if (unanalyzable) {
    return "Package could not be analyzed";
  }
  if (id === INTEGRITY_RULE_ID) {
    return "Downloaded artifact does not match lockfile integrity";
  }
  if (id === INTEL_RULE_ID) {
    return "Artifact confirmed malicious by shared intelligence";
  }
  if (id.startsWith("CAPDELTA-LOCKFILE-")) return "Lockfile entry changed";
  if (id.startsWith("CAPDELTA-BASELINE-"))
    return "Old version could not be analyzed";
  if (id.startsWith("CAPDELTA-SHAPE-")) return "Capability shape gained";
  if (id.startsWith("CAPDELTA-SIGNAL-")) return "Behavioral signal gained";
  return "Capability gained";
}

function ruleHelp(ruleId: string, guidance: Guidance | undefined): string {
  if (guidance === undefined) {
    throw new ReporterContractError(
      `SARIF rule ${ruleId} is missing its reviewer guidance`,
    );
  }
  // A confirmed intel match is a reviewer's verdict, so the local-analysis
  // disclaimer would contradict the rule itself.
  const disclaimer =
    ruleId === INTEL_RULE_ID
      ? "This result comes from a reviewer's confirmed verdict in shared intelligence."
      : "This result does not assert malware.";
  return `${guidance.whyItMatters} ${guidance.whatToCheck} ${disclaimer}`;
}

function shapeSuppression(reasons: readonly (string | undefined)[]): {
  text: string;
  properties: Record<string, unknown>;
} {
  const suppressed = reasons.filter(
    (reason): reason is string => reason !== undefined,
  );
  if (suppressed.length === 0) return { text: "", properties: {} };
  const unique = [
    ...new Set(suppressed.map((reason) => truncate(reason, MAX_VALUE_CHARS))),
  ];
  const status = suppressed.length === reasons.length ? "all" : "partial";
  return {
    text:
      status === "all"
        ? ` Suppressed (${unique.join("; ")})`
        : ` ${String(suppressed.length)} of ${String(reasons.length)} participants suppressed (${unique.join("; ")}); the others still gate.`,
    properties: { suppression: { status, reasons: unique } },
  };
}

function suppressionText(reason: string | undefined): string {
  return reason === undefined ? "" : ` Suppressed (${reason})`;
}
