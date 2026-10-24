import { NamedError } from "../../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../../core/report-builder.js";
import type {
  Confidence,
  IntelFinding,
  Severity,
  Transition,
  Verdict,
} from "./finding.js";

export class OsvError extends NamedError {}

export interface OsvRecord {
  schema_version: "1.6.0";
  id: string;
  modified: string;
  published: string;
  withdrawn?: string;
  summary: string;
  details: string;
  affected: {
    package: { ecosystem: "npm"; name: string };
    versions: string[];
  }[];
  database_specific: {
    digest: string;
    revision: number;
    verdict: Verdict;
    severity: Severity;
    confidence: Confidence;
    analyzerVersion: string;
    ruleKey: string;
  };
}

export const OSV_SCHEMA_VERSION = "1.6.0";

// A summary and a review reason are each bounded; the joined details needs
// room for both without becoming an unbounded field.
const MAX_DETAILS_CHARS = MAX_VALUE_CHARS * 2;

export function toOsv(finding: IntelFinding): OsvRecord {
  const record: OsvRecord = {
    schema_version: OSV_SCHEMA_VERSION,
    id: truncate(finding.id, MAX_IDENTITY_CHARS),
    modified: truncate(finding.updatedAt, MAX_IDENTITY_CHARS),
    published: truncate(finding.createdAt, MAX_IDENTITY_CHARS),
    summary: truncate(finding.summary, MAX_VALUE_CHARS),
    details: details(finding),
    affected: [
      {
        package: {
          ecosystem: "npm",
          name: truncate(finding.name, MAX_IDENTITY_CHARS),
        },
        versions: [truncate(finding.version, MAX_IDENTITY_CHARS)],
      },
    ],
    database_specific: {
      digest: truncate(finding.digest, MAX_IDENTITY_CHARS),
      revision: finding.revision,
      verdict: finding.verdict,
      severity: finding.severity,
      confidence: finding.confidence,
      analyzerVersion: truncate(finding.analyzerVersion, MAX_IDENTITY_CHARS),
      ruleKey: truncate(finding.ruleKey, MAX_IDENTITY_CHARS),
    },
  };

  if (finding.verdict === "retracted") {
    record.withdrawn = truncate(retraction(finding).at, MAX_IDENTITY_CHARS);
  }
  return record;
}

function details(finding: IntelFinding): string {
  const last = finding.history.at(-1);
  if (last === undefined) return truncate(finding.summary, MAX_DETAILS_CHARS);
  return truncate(
    `${finding.summary}\n\nReview: ${last.reason}`,
    MAX_DETAILS_CHARS,
  );
}

function retraction(finding: IntelFinding): Transition {
  const last = finding.history.at(-1);
  if (last?.to !== "retracted") {
    throw new OsvError(
      `finding ${JSON.stringify(truncate(finding.id, MAX_IDENTITY_CHARS))} is retracted but has no retraction transition`,
    );
  }
  return last;
}
