import type {
  EvidenceList,
  SignalEndpointObservation,
  SignalFileObservation,
  SignalObfuscationObservation,
  SignalSet,
} from "./contract/capability-set.js";
import {
  ENTROPY_JUMP_MILLIBITS,
  HIGH_ENTROPY_MILLIBITS,
  MIN_ENTROPY_BYTES,
} from "./signal-extractor.js";

export type SignalFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM";
export type SignalFindingChange = "added" | "changed";

export type SignalFindingKind =
  | "new-external-endpoint"
  | "entropy-jump"
  | "unparseable-file"
  | "unparseable-bytes-growth"
  | "obfuscation-pattern-added";

export interface SignalFinding {
  kind: SignalFindingKind;
  severity: SignalFindingSeverity;
  change: SignalFindingChange;
  detail: string;
  evidence: EvidenceList;
  suppression?: { reason: string };
}

/** Additions-only signal diff; absent baselines are treated as empty sets. */
export function diffSignals(
  oldSet: SignalSet | null,
  newSet: SignalSet,
): SignalFinding[] {
  const oldEndpoints = new Set((oldSet?.endpoints ?? []).map(endpointKey));
  const oldPatterns = new Map(
    (oldSet?.obfuscationPatterns ?? []).map((pattern) => [
      patternKey(pattern),
      pattern,
    ]),
  );
  const oldFiles = new Map(
    (oldSet?.sourceFiles ?? []).map((file) => [file.file, file]),
  );
  const findings: SignalFinding[] = [];

  for (const endpoint of newSet.endpoints) {
    if (oldEndpoints.has(endpointKey(endpoint))) continue;
    findings.push({
      kind: "new-external-endpoint",
      severity: "HIGH",
      change: "added",
      detail: `new external ${endpoint.endpointType} ${endpoint.normalizedValue}`,
      evidence: endpoint.evidence,
    });
  }

  for (const pattern of newSet.obfuscationPatterns) {
    const previous = oldPatterns.get(patternKey(pattern));
    if (previous !== undefined && previous.elementCount >= pattern.elementCount)
      continue;
    findings.push({
      kind: "obfuscation-pattern-added",
      severity: "MEDIUM",
      change: previous === undefined ? "added" : "changed",
      detail:
        previous === undefined
          ? `${pattern.pattern} with ${String(pattern.elementCount)} elements added`
          : `${pattern.pattern} grew from ${String(previous.elementCount)} to ${String(pattern.elementCount)} elements`,
      evidence: pattern.evidence,
    });
  }

  for (const file of newSet.sourceFiles) {
    const previous = oldFiles.get(file.file);
    if (file.parseState !== "parsed" && isNewlyUnparseable(file, previous)) {
      findings.push({
        kind: "unparseable-file",
        severity: "MEDIUM",
        change: previous === undefined ? "added" : "changed",
        detail: `${file.file} is ${file.parseState} (${String(file.byteLength)} bytes)`,
        evidence: fileEvidence(file),
      });
    }

    if (
      previous?.entropyMilliBitsPerByte !== null &&
      previous?.entropyMilliBitsPerByte !== undefined &&
      file.entropyMilliBitsPerByte !== null &&
      file.byteLength >= MIN_ENTROPY_BYTES &&
      file.entropyMilliBitsPerByte >= HIGH_ENTROPY_MILLIBITS &&
      file.entropyMilliBitsPerByte - previous.entropyMilliBitsPerByte >=
        ENTROPY_JUMP_MILLIBITS
    ) {
      const delta =
        file.entropyMilliBitsPerByte - previous.entropyMilliBitsPerByte;
      findings.push({
        kind: "entropy-jump",
        severity: "MEDIUM",
        change: "changed",
        detail: `${file.file} entropy rose from ${String(previous.entropyMilliBitsPerByte)} to ${String(file.entropyMilliBitsPerByte)} millibits/byte (+${String(delta)})`,
        evidence: fileEvidence(file),
      });
    }
  }

  const oldUnparseableBytes = oldSet === null ? 0 : unparseableBytes(oldSet);
  const newUnparseableBytes = unparseableBytes(newSet);
  if (oldSet !== null && newUnparseableBytes > oldUnparseableBytes) {
    const evidence =
      newSet.sourceFiles.find((file) => file.parseState !== "parsed") ??
      newSet.sourceFiles[0];
    if (evidence !== undefined) {
      findings.push({
        kind: "unparseable-bytes-growth",
        severity: "MEDIUM",
        change: "changed",
        detail: `unparseable/unsupported source bytes grew from ${String(oldUnparseableBytes)} to ${String(newUnparseableBytes)} (+${String(newUnparseableBytes - oldUnparseableBytes)})`,
        evidence: fileEvidence(evidence),
      });
    }
  }

  findings.sort(compareFindings);
  return findings;
}

function isNewlyUnparseable(
  current: SignalFileObservation,
  previous: SignalFileObservation | undefined,
): boolean {
  return (
    previous === undefined ||
    previous.parseState === "parsed" ||
    previous.parseState !== current.parseState ||
    previous.byteLength !== current.byteLength
  );
}

function unparseableBytes(set: SignalSet): number {
  return set.sourceFiles.reduce(
    (total, file) =>
      total + (file.parseState === "parsed" ? 0 : file.byteLength),
    0,
  );
}

function endpointKey(endpoint: SignalEndpointObservation): string {
  return JSON.stringify([endpoint.endpointType, endpoint.normalizedValue]);
}

function patternKey(pattern: SignalObfuscationObservation): string {
  return JSON.stringify([pattern.file, pattern.pattern]);
}

function fileEvidence(file: SignalFileObservation): EvidenceList {
  return [{ file: file.file, line: 1, snippet: "" }];
}

function compareFindings(left: SignalFinding, right: SignalFinding): number {
  const severity = severityOrder(left.severity) - severityOrder(right.severity);
  if (severity !== 0) return severity;
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.detail, right.detail) ||
    compareText(JSON.stringify(left.evidence), JSON.stringify(right.evidence))
  );
}

function severityOrder(severity: SignalFindingSeverity): number {
  return severity === "CRITICAL" ? 0 : severity === "HIGH" ? 1 : 2;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
