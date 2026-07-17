import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type AnalysisDiagnostic,
  type Capability,
  type CapabilitySet,
  type CommandEntrypointCapability,
  type DependencyCapability,
  type InstallHookCapability,
  type PackageSubject,
  type RuntimeConstraintCapability,
} from "./contract/capability-set.js";

type ManifestCapability =
  | InstallHookCapability
  | CommandEntrypointCapability
  | DependencyCapability
  | RuntimeConstraintCapability;

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type CapabilityChange = "added" | "changed";

export interface CapabilityFinding {
  change: CapabilityChange;
  severity: FindingSeverity;
  /** New-side capability; its non-empty evidence is the finding evidence. */
  capability: Capability;
  /** Present only for changed slots; null for additions and new packages. */
  previous: Capability | null;
}

export interface CapabilityDiffDiagnostic {
  side: "old" | "new";
  diagnostic: AnalysisDiagnostic;
}

export interface CapabilityDiffResult {
  subject: PackageSubject;
  /** No baseline means every new-side capability is gained (PLAN §4.4). */
  newPackage: boolean;
  /** Severity-first, then semantic-slot order for deterministic reports. */
  findings: readonly CapabilityFinding[];
  /** Partial-analysis data is propagated, never silently discarded. */
  diagnostics: readonly CapabilityDiffDiagnostic[];
}

interface ManifestCapabilityFinding extends CapabilityFinding {
  capability: ManifestCapability;
  previous: ManifestCapability | null;
}

export class CapabilityDifferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The producer violated the capability-set contract or M1 feature boundary. */
export class CapabilityDifferContractError extends CapabilityDifferError {}

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

/**
 * Manifest-only M1 Differ (PLAN §4.3 layer 1, §4.4). Removed capabilities are
 * deliberately ignored; a null baseline receives a full capability report.
 */
export function diffManifestCapabilities(
  oldSet: CapabilitySet | null,
  newSet: CapabilitySet,
): CapabilityDiffResult {
  validateSet(newSet, "new");
  if (oldSet !== null) {
    validateSet(oldSet, "old");
    validateSubjects(oldSet.subject, newSet.subject);
  }

  const oldBySlot =
    oldSet === null ? new Map<string, ManifestCapability>() : indexSet(oldSet);
  const findings: ManifestCapabilityFinding[] = [];
  for (const current of manifestCapabilities(newSet)) {
    const previous = oldBySlot.get(semanticSlot(current));
    if (oldSet === null || previous === undefined) {
      findings.push({
        change: "added",
        severity: severityFor(current),
        capability: current,
        previous: null,
      });
    } else if (manifestCapabilityChanged(previous, current)) {
      findings.push({
        change: "changed",
        severity: severityFor(current),
        capability: current,
        previous,
      });
    }
  }
  findings.sort(compareFindings);

  const diagnostics: CapabilityDiffDiagnostic[] = [];
  if (oldSet !== null) {
    diagnostics.push(
      ...oldSet.diagnostics.map((diagnostic) => ({
        side: "old" as const,
        diagnostic,
      })),
    );
  }
  diagnostics.push(
    ...newSet.diagnostics.map((diagnostic) => ({
      side: "new" as const,
      diagnostic,
    })),
  );
  diagnostics.sort(compareDiagnostics);

  return {
    subject: newSet.subject,
    newPackage: oldSet === null,
    findings,
    diagnostics,
  };
}

function validateSet(set: CapabilitySet, side: "old" | "new"): void {
  const schemaVersion: unknown = set.schemaVersion;
  if (schemaVersion !== CAPABILITY_SET_SCHEMA_VERSION) {
    throw contractError(
      side,
      `unsupported capability-set schema ${String(schemaVersion)}`,
    );
  }
  if (
    set.subject.ecosystem.length === 0 ||
    set.subject.name.length === 0 ||
    set.subject.version.length === 0
  ) {
    throw contractError(side, "subject fields must be non-empty");
  }
  const expectedCompleteness =
    set.diagnostics.length === 0 ? "complete" : "partial";
  if (set.completeness !== expectedCompleteness) {
    throw contractError(
      side,
      `${set.completeness} set has ${String(set.diagnostics.length)} diagnostics`,
    );
  }
  for (const diagnostic of set.diagnostics) {
    if (diagnostic.evidence.length === 0) {
      throw contractError(side, "diagnostic has no evidence");
    }
  }

  const slots = new Set<string>();
  for (const capability of set.capabilities) {
    if (!isManifestCapability(capability)) {
      throw contractError(
        side,
        `M1 manifest Differ does not support ${capability.kind}`,
      );
    }
    if (capability.evidence.length === 0) {
      throw contractError(side, `${capability.kind} has no evidence`);
    }
    const slot = semanticSlot(capability);
    if (slots.has(slot)) {
      throw contractError(side, `duplicate semantic slot ${slot}`);
    }
    slots.add(slot);
  }
}

function validateSubjects(
  oldSubject: PackageSubject,
  newSubject: PackageSubject,
): void {
  if (
    oldSubject.ecosystem !== newSubject.ecosystem ||
    oldSubject.name !== newSubject.name
  ) {
    throw new CapabilityDifferContractError(
      "old and new capability sets must describe the same ecosystem and package",
    );
  }
}

function contractError(
  side: "old" | "new",
  detail: string,
): CapabilityDifferContractError {
  return new CapabilityDifferContractError(`${side} capability set: ${detail}`);
}

function manifestCapabilities(set: CapabilitySet): ManifestCapability[] {
  // validateSet establishes this M1 narrowing before the Differ runs.
  return set.capabilities.filter(isManifestCapability);
}

function isManifestCapability(
  capability: Capability,
): capability is ManifestCapability {
  return (
    capability.kind === "INSTALL_HOOK" ||
    capability.kind === "COMMAND_ENTRYPOINT" ||
    capability.kind === "DEPENDENCY" ||
    capability.kind === "RUNTIME_CONSTRAINT"
  );
}

function indexSet(set: CapabilitySet): Map<string, ManifestCapability> {
  return new Map(
    manifestCapabilities(set).map((capability) => [
      semanticSlot(capability),
      capability,
    ]),
  );
}

function semanticSlot(capability: ManifestCapability): string {
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return JSON.stringify([capability.kind, capability.location.hook]);
    case "COMMAND_ENTRYPOINT":
      return JSON.stringify([capability.kind, capability.command]);
    case "DEPENDENCY":
      return JSON.stringify([capability.kind, capability.name]);
    case "RUNTIME_CONSTRAINT":
      return JSON.stringify([capability.kind, capability.runtime]);
  }
}

function manifestCapabilityChanged(
  previous: ManifestCapability,
  current: ManifestCapability,
): boolean {
  switch (current.kind) {
    case "INSTALL_HOOK":
      return (
        previous.kind !== current.kind ||
        previous.location.applicability !== current.location.applicability ||
        previous.contentDigest.value !== current.contentDigest.value
      );
    case "COMMAND_ENTRYPOINT":
      return (
        previous.kind !== current.kind || previous.target !== current.target
      );
    case "DEPENDENCY":
      // PLAN §4.3 asks for dependency additions, not requirement changes.
      return false;
    case "RUNTIME_CONSTRAINT":
      return (
        previous.kind !== current.kind ||
        previous.requirement !== current.requirement
      );
  }
}

function severityFor(capability: ManifestCapability): FindingSeverity {
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return capability.location.applicability === "registry-install"
        ? "CRITICAL"
        : "INFO";
    case "COMMAND_ENTRYPOINT":
    case "DEPENDENCY":
      return "LOW";
    case "RUNTIME_CONSTRAINT":
      return "INFO";
  }
}

function compareFindings(
  left: ManifestCapabilityFinding,
  right: ManifestCapabilityFinding,
): number {
  const severity =
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severity !== 0) return severity;
  return compareText(
    semanticSlot(left.capability),
    semanticSlot(right.capability),
  );
}

function compareDiagnostics(
  left: CapabilityDiffDiagnostic,
  right: CapabilityDiffDiagnostic,
): number {
  if (left.side !== right.side) return left.side === "old" ? -1 : 1;
  const leftEvidence = left.diagnostic.evidence[0];
  const rightEvidence = right.diagnostic.evidence[0];
  const file = compareText(leftEvidence.file, rightEvidence.file);
  if (file !== 0) return file;
  const line = leftEvidence.line - rightEvidence.line;
  if (line !== 0) return line;
  return compareText(left.diagnostic.detail, right.diagnostic.detail);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
