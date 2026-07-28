import type { Evidence } from "./contract/capability-set.js";
import type {
  CapabilityFinding,
  FindingSeverity,
} from "./capability-differ.js";
import type { CapabilityAnalysisRun } from "./manifest-analysis-pipeline.js";

export const SARIF_VERSION = "2.1.0" as const;
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: readonly unknown[];
  properties: Record<string, unknown>;
}

/** Deterministic SARIF 2.1.0 for package artifacts, never checkout source. */
export function renderSarifReport(run: CapabilityAnalysisRun): string {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();
  for (const item of run.packages) {
    if (item.status !== "analyzed") continue;
    const subject = item.diff.subject;
    for (const shape of item.diff.shapes ?? []) {
      const ruleId = `CAPDELTA-SHAPE-${shape.ruleId.toUpperCase()}`;
      ruleIds.add(ruleId);
      results.push(
        resultFor(
          ruleId,
          shape.severity,
          `Review this change: ${shape.ruleId} capability shape in ${subject.name}@${subject.version}.`,
          shape.capabilities.flatMap((capability) => capability.evidence),
          subject.name,
          subject.version,
          {
            kind: "shape",
            capabilities: shape.capabilities.map(
              (capability) => capability.kind,
            ),
          },
        ),
      );
    }
    const covered = new Set(
      (item.diff.shapes ?? []).flatMap((shape) => shape.capabilities),
    );
    for (const finding of item.diff.findings) {
      if (covered.has(finding.capability)) continue;
      const ruleId = fallbackRuleId(finding);
      ruleIds.add(ruleId);
      results.push(
        resultFor(
          ruleId,
          finding.severity,
          `Review this change: ${finding.capability.kind} capability ${finding.change} in ${subject.name}@${subject.version}.`,
          finding.capability.evidence,
          subject.name,
          subject.version,
          {
            kind: "capability",
            capability: finding.capability.kind,
            change: finding.change,
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
    help: {
      text: "Review the static capability delta and its bounded evidence. This result does not assert malware.",
    },
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
  return id.startsWith("CAPDELTA-SHAPE-")
    ? "Capability shape gained"
    : "Capability gained";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
