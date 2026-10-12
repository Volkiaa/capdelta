import type { Evidence } from "./contract/capability-set.js";
import type {
  CapabilityFinding,
  FindingSeverity,
} from "./capability-differ.js";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "./capability-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  ReporterContractError,
  truncate,
} from "./report-builder.js";
import { isNormalizedRelativePosixPath } from "./repository-path.js";
import { analysisIssueSeverity } from "./run-severity.js";

export const SARIF_VERSION = "2.1.0" as const;
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INTEGRITY_RULE_ID = "CAPDELTA-INTEGRITY-MISMATCH";

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
  for (const item of run.packages) {
    // Severity-bearing issues (PLAN §4.2 integrity mismatches) gate the run,
    // so they must reach code scanning even when the package is unavailable.
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
      );
      ruleIds.add(result.ruleId);
      results.push(result);
    }
    if (item.status !== "analyzed") continue;
    const subject = item.diff.subject;
    // Shape participants are the findings' own capability objects, so a
    // reviewed allowlist suppression can be carried onto the shape result.
    const memberSuppression = new Map(
      item.diff.findings.map((finding) => [
        finding.capability,
        finding.suppression?.reason,
      ]),
    );
    for (const shape of item.diff.shapes ?? []) {
      const ruleId = `CAPDELTA-SHAPE-${shape.ruleId.toUpperCase()}`;
      ruleIds.add(ruleId);
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
  results.sort((left, right) =>
    compareText(
      JSON.stringify([left.ruleId, left.message.text, left.locations]),
      JSON.stringify([right.ruleId, right.message.text, right.locations]),
    ),
  );
  const rules = [...ruleIds].sort(compareText).map((id) => ({
    id,
    shortDescription: { text: ruleDescription(id) },
    help: { text: ruleHelp(id) },
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

/**
 * An unavailable package has no analyzed file to point at. The result points
 * at the lockfile that pins the expected integrity, with no region: capdelta
 * does not track the entry's line and never fabricates one. Artifact
 * identity, side, and URL go in properties.
 */
function issueResult(
  changedPackage: ChangedPackage,
  issue: PackageAnalysisFailure,
  severity: FindingSeverity,
  lockfilePath: string | undefined,
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
  const result = resultFor(
    `CAPDELTA-${issue.failure.kind.toUpperCase()}`,
    severity,
    `Review this change: ${detail}${artifact} of ${name}@${boundedVersion}; capdelta did not analyze it.`,
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
    },
  );
  if (lockfilePath === undefined) return result;
  return {
    ...result,
    locations: [
      {
        // Repository-root-relative, so no uriBaseId; each segment is encoded
        // once so %, #, ? and spaces stay filename characters.
        physicalLocation: {
          artifactLocation: {
            uri: lockfilePath.split("/").map(encodeURIComponent).join("/"),
          },
        },
      },
    ],
  };
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

function ruleDescription(id: string): string {
  if (id === INTEGRITY_RULE_ID) {
    return "Downloaded artifact does not match lockfile integrity";
  }
  if (id.startsWith("CAPDELTA-SHAPE-")) return "Capability shape gained";
  if (id.startsWith("CAPDELTA-SIGNAL-")) return "Behavioral signal gained";
  return "Capability gained";
}

function ruleHelp(id: string): string {
  if (id === INTEGRITY_RULE_ID) {
    return "The downloaded bytes differ from the lockfile integrity hash, so capdelta did not analyze them. Review where this lockfile entry and its registry response came from. This result does not assert malware.";
  }
  return "Review the static capability delta and its bounded evidence. This result does not assert malware.";
}

/**
 * Labels a shape from its participants' reviewed suppressions, the same
 * per-member notion the gate counts. A partly suppressed shape is never
 * presented as reviewed: its unsuppressed participants still gate. The
 * alert level is unchanged; dismissing alerts is a separate decision.
 */
function shapeSuppression(reasons: readonly (string | undefined)[]): {
  text: string;
  properties: Record<string, unknown>;
} {
  const suppressed = reasons.filter(
    (reason): reason is string => reason !== undefined,
  );
  if (suppressed.length === 0) return { text: "", properties: {} };
  // Deduplicate the bounded display strings; participant counts still use
  // every suppressed participant.
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
