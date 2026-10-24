import { createHash } from "node:crypto";
import { NamedError } from "../../core/named-error.js";
import {
  MAX_EVIDENCE_FILE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../../core/report-builder.js";

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Confidence = "low" | "medium" | "high";
export type Verdict =
  "suspected" | "under-review" | "confirmed-malicious" | "benign" | "retracted";

export interface EvidenceRef {
  file: string;
  line: number;
  excerpt: string;
}

export interface Validation {
  reviewer: string;
  method: string;
  evidenceRefs: number[];
}

export interface Transition {
  at: string;
  actor: string;
  from: Verdict;
  to: Verdict;
  reason: string;
  validation?: Validation;
}

export interface IntelFinding {
  schemaVersion: 1;
  id: string;
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  analyzerVersion: string;
  ruleKey: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  verdict: Verdict;
  evidence: EvidenceRef[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  history: Transition[];
}

export interface NewFindingInput {
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  analyzerVersion: string;
  ruleKey: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  evidence: EvidenceRef[];
}

export interface TransitionRequest {
  to: Verdict;
  actor: string;
  reason: string;
  validation?: Validation;
}

export class IntelModelError extends NamedError {}

const MAX_EVIDENCE_REFS = 20;
const ANALYZER = "analyzer";
const SEVERITIES: readonly Severity[] = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
const VERDICTS: readonly Verdict[] = [
  "suspected",
  "under-review",
  "confirmed-malicious",
  "benign",
  "retracted",
];

// A verdict read from a hand-edited record may be unknown, so index by string
// and let the transition check reject it instead of trusting the type.
const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly Verdict[]>> = {
  suspected: ["under-review", "benign"],
  "under-review": ["confirmed-malicious", "benign"],
  "confirmed-malicious": ["retracted"],
  benign: ["under-review"],
  retracted: ["under-review"],
};

export function findingId(input: {
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  ruleKey: string;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        input.ecosystem,
        input.name,
        input.version,
        input.digest,
        input.ruleKey,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  return `CDI-${hash.slice(0, 20)}`;
}

export function createFinding(
  source: NewFindingInput,
  now: Date,
): IntelFinding {
  requireEcosystem(source.ecosystem);
  const id = findingId(source);
  const at = isoTime(now, id);
  const severity = requireMember(source.severity, SEVERITIES, "severity", id);
  const confidence = requireMember(
    source.confidence,
    CONFIDENCES,
    "confidence",
    id,
  );

  return {
    schemaVersion: 1,
    id,
    ecosystem: "npm",
    name: boundIdentity(source.name, "name", id),
    version: boundIdentity(source.version, "version", id),
    digest: boundIdentity(source.digest, "digest", id),
    analyzerVersion: boundIdentity(
      source.analyzerVersion,
      "analyzerVersion",
      id,
    ),
    ruleKey: boundIdentity(source.ruleKey, "ruleKey", id),
    summary: boundText(source.summary, "summary", id),
    severity,
    confidence,
    verdict: "suspected",
    evidence: boundEvidence(source.evidence, id),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

export function applyTransition(
  finding: IntelFinding,
  request: TransitionRequest,
  now: Date,
): IntelFinding {
  const id = finding.id;
  const to = requireMember(request.to, VERDICTS, "verdict", id);
  const from = finding.verdict;
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IntelModelError(
      `finding ${quote(id)} cannot move from ${from} to ${to}`,
    );
  }

  const actor = requireActor(request.actor, id);
  const reason = boundText(request.reason, "reason", id);
  let validation: Validation | undefined;
  if (to === "confirmed-malicious") {
    validation = requireValidation(
      request.validation,
      actor,
      finding.evidence.length,
      id,
    );
  } else {
    rejectUnexpectedValidation(request.validation, id);
  }
  const at = isoTime(now, id);

  const entry: Transition = { at, actor, from, to, reason };
  if (validation !== undefined) entry.validation = validation;

  return {
    ...finding,
    verdict: to,
    revision: finding.revision + 1,
    updatedAt: at,
    evidence: finding.evidence.map((ref) => ({ ...ref })),
    history: [...finding.history, entry],
  };
}

function requireActor(value: string, id: string): string {
  const actor = requireNonEmpty(value, "actor", id);
  if (Array.from(actor).length > MAX_IDENTITY_CHARS) {
    throw new IntelModelError(
      `finding ${quote(id)} has an actor longer than ${String(MAX_IDENTITY_CHARS)} characters`,
    );
  }
  if (actor.toLowerCase() === ANALYZER) {
    throw new IntelModelError(
      `finding ${quote(id)} cannot be transitioned by the analyzer`,
    );
  }
  return actor;
}

function requireValidation(
  value: Validation | undefined,
  actor: string,
  evidenceCount: number,
  id: string,
): Validation {
  if (value === undefined) {
    throw new IntelModelError(
      `finding ${quote(id)} requires a validation to become confirmed-malicious`,
    );
  }
  const reviewer = requireNonEmpty(value.reviewer, "validation reviewer", id);
  if (Array.from(reviewer).length > MAX_IDENTITY_CHARS) {
    throw new IntelModelError(
      `finding ${quote(id)} has a reviewer longer than ${String(MAX_IDENTITY_CHARS)} characters`,
    );
  }
  if (reviewer.toLowerCase() === ANALYZER) {
    throw new IntelModelError(
      `finding ${quote(id)} cannot be confirmed by the analyzer`,
    );
  }
  if (reviewer !== actor) {
    throw new IntelModelError(
      `finding ${quote(id)} has a reviewer that does not match the actor ${quote(actor)}`,
    );
  }
  const method = boundText(value.method, "validation method", id);

  const refs = value.evidenceRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new IntelModelError(
      `finding ${quote(id)} requires at least one evidence reference to confirm`,
    );
  }
  const evidenceRefs = refs.map((index) => {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= evidenceCount
    ) {
      throw new IntelModelError(
        `finding ${quote(id)} has an evidence reference outside its ${String(evidenceCount)} evidence items`,
      );
    }
    return index;
  });

  return { reviewer, method, evidenceRefs };
}

function rejectUnexpectedValidation(
  value: Validation | undefined,
  id: string,
): void {
  if (value !== undefined) {
    throw new IntelModelError(
      `finding ${quote(id)} carries a validation on a transition that is not a confirmation`,
    );
  }
}

function boundEvidence(value: unknown, id: string): EvidenceRef[] {
  if (!Array.isArray(value)) {
    throw new IntelModelError(
      `finding ${quote(id)} requires an evidence array`,
    );
  }
  const items: readonly unknown[] = value;
  if (items.length > MAX_EVIDENCE_REFS) {
    throw new IntelModelError(
      `finding ${quote(id)} has ${String(items.length)} evidence references; at most ${String(MAX_EVIDENCE_REFS)} are allowed`,
    );
  }
  return items.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new IntelModelError(
        `finding ${quote(id)} has a non-object evidence item at index ${String(index)}`,
      );
    }
    const line = item.line;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw new IntelModelError(
        `finding ${quote(id)} has an evidence line that is not a positive integer at index ${String(index)}`,
      );
    }
    return {
      file: truncate(
        requireString(item.file, "evidence file", id),
        MAX_EVIDENCE_FILE_CHARS,
      ),
      line,
      excerpt: truncate(
        requireString(item.excerpt, "evidence excerpt", id),
        MAX_VALUE_CHARS,
      ),
    };
  });
}

function boundIdentity(value: string, field: string, id: string): string {
  return truncate(requireString(value, field, id), MAX_IDENTITY_CHARS);
}

function boundText(value: string, field: string, id: string): string {
  return truncate(requireNonEmpty(value, field, id), MAX_VALUE_CHARS);
}

function requireEcosystem(value: string): "npm" {
  if (value !== "npm") {
    throw new IntelModelError(
      `cannot create a finding for ecosystem ${quote(value)}: only "npm" is supported`,
    );
  }
  return "npm";
}

function requireString(value: unknown, field: string, id: string): string {
  if (typeof value !== "string") {
    throw new IntelModelError(
      `finding ${quote(id)} requires ${field} to be a string`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: string, field: string, id: string): string {
  const text = requireString(value, field, id).trim();
  if (text.length === 0) {
    throw new IntelModelError(
      `finding ${quote(id)} requires a non-empty ${field}`,
    );
  }
  return text;
}

function requireMember<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string,
  id: string,
): T {
  if (!allowed.includes(value)) {
    throw new IntelModelError(
      `finding ${quote(id)} has an invalid ${field} ${quote(value)}`,
    );
  }
  return value;
}

function isoTime(now: Date, id: string): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IntelModelError(`finding ${quote(id)} got an invalid timestamp`);
  }
  return now.toISOString();
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}
