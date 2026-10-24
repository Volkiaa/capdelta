import { createHash } from "node:crypto";
import { NamedError } from "../../core/named-error.js";
import type {
  JsonReport,
  JsonReportFinding,
  JsonReportShapeFinding,
  JsonReportSignalFinding,
  ReportEvidence,
} from "../../core/report-contract.js";
import type { FindingSeverity } from "../../core/capability-differ.js";
import {
  MAX_EVIDENCE_FILE_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../../core/report-builder.js";
import type { ReleaseRecord } from "../release-store.js";
import {
  createFinding,
  type EvidenceRef,
  type NewFindingInput,
  type Severity,
} from "./finding.js";
import type { FindingStore } from "./finding-store.js";

export class PublishError extends NamedError {}

export interface PublishCounts {
  created: number;
  existing: number;
}

/** Matches the bound FindingStore enforces on one evidence list. */
const MAX_EVIDENCE_REFS = 20;
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/**
 * Turns the analyzed package of a release record into suspected findings.
 * Republishing the same record is a no-op because the id derives from the
 * artifact identity and the rule key.
 */
export async function publishFindings(
  record: ReleaseRecord,
  store: FindingStore,
  now: () => Date,
): Promise<PublishCounts> {
  const report = analyzedReport(record);
  if (report === null) return { created: 0, existing: 0 };

  const at = now();
  const counts: PublishCounts = { created: 0, existing: 0 };
  for (const pending of pendingFindings(report)) {
    const input: NewFindingInput = {
      ecosystem: "npm",
      name: record.name,
      version: record.version,
      digest: record.digest,
      analyzerVersion: record.analyzerVersion,
      ruleKey: pending.ruleKey,
      summary: pending.summary,
      severity: pending.severity,
      confidence: "medium",
      evidence: evidenceRefs(pending.evidence),
    };
    const result = await store.putIfAbsent(createFinding(input, at));
    if (result.created) counts.created += 1;
    else counts.existing += 1;
  }
  return counts;
}

interface PendingFinding {
  ruleKey: string;
  summary: string;
  severity: Severity;
  evidence: readonly ReportEvidence[];
}

function analyzedReport(record: ReleaseRecord): JsonReport | null {
  const analyzed = record.report.packages.filter(
    (item) => item.status === "analyzed",
  );
  if (analyzed.length === 0) return null;
  for (const item of analyzed) {
    if (
      item.report.package.name === record.name &&
      item.report.package.newVersion === record.version
    ) {
      return item.report;
    }
  }
  throw new PublishError(
    `release record for ${record.name}@${record.version} has no analyzed package with that identity`,
  );
}

function pendingFindings(report: JsonReport): PendingFinding[] {
  const pending: PendingFinding[] = [];
  for (const finding of report.findings) {
    if (!publishable(finding.severity)) continue;
    if (finding.suppression !== undefined) continue;
    pending.push(capabilityPending(finding));
  }
  for (const finding of report.signalFindings ?? []) {
    if (!publishable(finding.severity)) continue;
    if (finding.suppression !== undefined) continue;
    pending.push(signalPending(finding));
  }
  for (const shape of report.shapes ?? []) {
    if (!publishable(shape.severity)) continue;
    pending.push(shapePending(shape));
  }
  return pending;
}

/** Two findings of one kind in one release (two hosts) must not share an id. */
function discriminated(base: string, summary: string): string {
  const hash = createHash("sha256").update(summary, "utf8").digest("hex");
  return `${base}:${hash.slice(0, 8)}`;
}

function capabilityPending(finding: JsonReportFinding): PendingFinding {
  const summary = capabilitySummary(finding);
  return {
    ruleKey: discriminated(
      `capability:${finding.capability.kind}:${finding.change}`,
      summary,
    ),
    summary,
    severity: finding.severity,
    evidence: finding.capability.evidence,
  };
}

function signalPending(finding: JsonReportSignalFinding): PendingFinding {
  const summary = nonEmpty(finding.detail, `signal ${finding.kind}`);
  return {
    ruleKey: discriminated(`signal:${finding.kind}`, summary),
    summary,
    severity: finding.severity,
    evidence: finding.evidence,
  };
}

function shapePending(shape: JsonReportShapeFinding): PendingFinding {
  return {
    ruleKey: `shape:${shape.ruleId}`,
    summary: truncate(`capability shape ${shape.ruleId}`, MAX_VALUE_CHARS),
    severity: shape.severity,
    evidence: shape.capabilities.flatMap((capability) => capability.evidence),
  };
}

function capabilitySummary(finding: JsonReportFinding): string {
  const capability = finding.capability;
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return nonEmpty(
        `${capability.hook} install hook ${finding.change}`,
        "install hook change",
      );
    case "COMMAND_ENTRYPOINT":
      return nonEmpty(
        `command entrypoint ${finding.change}: ${capability.target}`,
        "command entrypoint change",
      );
    case "DEPENDENCY":
      return nonEmpty(
        `dependency ${capability.name} ${finding.change}: ${capability.requirement}`,
        "dependency change",
      );
    case "RUNTIME_CONSTRAINT":
      return nonEmpty(
        `runtime ${capability.runtime} constraint ${finding.change}: ${capability.requirement}`,
        "runtime constraint change",
      );
    default:
      return nonEmpty(
        `${capability.kind} capability ${finding.change}`,
        "capability change",
      );
  }
}

function evidenceRefs(items: readonly ReportEvidence[]): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.line) || item.line < 1) continue;
    refs.push({
      file: truncate(item.file, MAX_EVIDENCE_FILE_CHARS),
      line: item.line,
      excerpt: truncate(item.snippet, MAX_VALUE_CHARS),
    });
    if (refs.length === MAX_EVIDENCE_REFS) break;
  }
  return refs;
}

function publishable(severity: FindingSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK.MEDIUM;
}

function nonEmpty(value: string, fallback: string): string {
  const text = truncate(value, MAX_VALUE_CHARS);
  return text.trim().length === 0 ? truncate(fallback, MAX_VALUE_CHARS) : text;
}
