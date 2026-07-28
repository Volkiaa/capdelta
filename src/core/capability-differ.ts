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
  type CodeCapability,
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

type CapabilityGain = Omit<CapabilityFinding, "severity">;

export type ShapeRuleId =
  | "install-code-execution"
  | "secret-exfiltration"
  | "install-hook-change"
  | "dynamic-or-native-code";

export interface ShapeFinding {
  ruleId: ShapeRuleId;
  severity: "CRITICAL";
  /** Current-side gains that jointly satisfy the rule. */
  capabilities: readonly Capability[];
}

export interface CapabilityDiffDiagnostic {
  side: "old" | "new";
  diagnostic: AnalysisDiagnostic;
}

export interface CapabilityDiffResult {
  /** Baseline identity for report labels; null for a newly added package. */
  baseline: PackageSubject | null;
  subject: PackageSubject;
  /** No baseline means every new-side capability is gained (PLAN §4.4). */
  newPackage: boolean;
  /** Severity-first, then semantic-slot order for deterministic reports. */
  findings: readonly CapabilityFinding[];
  /** Shape matches are ordered by the PLAN §4.4 rule table. */
  shapes?: readonly ShapeFinding[];
  /** Partial-analysis data is propagated, never silently discarded. */
  diagnostics: readonly CapabilityDiffDiagnostic[];
}

export class CapabilityDifferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The producer violated the ecosystem-agnostic capability-set contract. */
export class CapabilityDifferContractError extends CapabilityDifferError {}

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

/**
 * Additions-only capability Differ (PLAN §4.4). Removed capabilities are
 * deliberately ignored; a null baseline receives a full capability report.
 */
export function diffCapabilities(
  oldSet: CapabilitySet | null,
  newSet: CapabilitySet,
): CapabilityDiffResult {
  validateSet(newSet, "new");
  if (oldSet !== null) {
    validateSet(oldSet, "old");
    validateSubjects(oldSet.subject, newSet.subject);
  }

  const oldBySlot =
    oldSet === null ? new Map<string, Capability>() : indexSet(oldSet);
  const gains: CapabilityGain[] = [];
  for (const current of manifestCapabilities(newSet)) {
    const previous = oldBySlot.get(semanticSlot(current));
    if (oldSet === null || previous === undefined) {
      gains.push({
        change: "added",
        capability: current,
        previous: null,
      });
    } else if (manifestCapabilityChanged(previous, current)) {
      gains.push({
        change: "changed",
        capability: current,
        previous,
      });
    }
  }
  const shapes = evaluateShapes(gains);
  const findings = classifyGains(gains, shapes);
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
    baseline: oldSet?.subject ?? null,
    subject: newSet.subject,
    newPackage: oldSet === null,
    findings,
    shapes,
    diagnostics,
  };
}

/** M1 compatibility alias; new callers should use diffCapabilities. */
export const diffManifestCapabilities = diffCapabilities;

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

function manifestCapabilities(set: CapabilitySet): Capability[] {
  return [...set.capabilities];
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

function indexSet(set: CapabilitySet): Map<string, Capability> {
  return new Map(
    manifestCapabilities(set).map((capability) => [
      semanticSlot(capability),
      capability,
    ]),
  );
}

function semanticSlot(capability: Capability): string {
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return JSON.stringify([capability.kind, capability.location.hook]);
    case "COMMAND_ENTRYPOINT":
      return JSON.stringify([capability.kind, capability.command]);
    case "DEPENDENCY":
      return JSON.stringify([capability.kind, capability.name]);
    case "RUNTIME_CONSTRAINT":
      return JSON.stringify([capability.kind, capability.runtime]);
    default:
      return JSON.stringify([capability.kind, capability.location]);
  }
}

function manifestCapabilityChanged(
  previous: Capability,
  current: Capability,
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
    default:
      return false;
  }
}

function fallbackSeverityFor(capability: Capability): FindingSeverity {
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
    case "NET":
    case "PROCESS":
    case "FS_SENSITIVE":
      return "HIGH";
    case "ENV":
    case "FS_WRITE":
      return "MEDIUM";
    case "FS_READ":
    case "UNKNOWN":
      return "LOW";
    case "DYNAMIC_CODE":
    case "NATIVE":
      return "CRITICAL";
  }
}

function evaluateShapes(gains: readonly CapabilityGain[]): ShapeFinding[] {
  const shapes: ShapeFinding[] = [];
  const installCodeKinds = new Set(["NET", "PROCESS", "ENV", "FS_SENSITIVE"]);
  for (const gain of gains) {
    const capability = gain.capability;
    if (
      isCodeCapability(capability) &&
      capability.location.kind === "install-script" &&
      installCodeKinds.has(capability.kind)
    ) {
      shapes.push({
        ruleId: "install-code-execution",
        severity: "CRITICAL",
        capabilities: [capability],
      });
    }
  }

  const network = gains.filter((gain) => gain.capability.kind === "NET");
  const secrets = gains.filter(
    (gain) =>
      gain.capability.kind === "ENV" || gain.capability.kind === "FS_SENSITIVE",
  );
  if (network.length > 0 && secrets.length > 0) {
    const participants = [...network, ...secrets];
    shapes.push({
      ruleId: "secret-exfiltration",
      severity: "CRITICAL",
      capabilities: participants.map((gain) => gain.capability),
    });
  }

  for (const gain of gains) {
    const capability = gain.capability;
    if (
      capability.kind === "INSTALL_HOOK" &&
      capability.location.applicability === "registry-install"
    ) {
      shapes.push({
        ruleId: "install-hook-change",
        severity: "CRITICAL",
        capabilities: [capability],
      });
    }
  }

  for (const gain of gains) {
    if (
      gain.capability.kind === "DYNAMIC_CODE" ||
      gain.capability.kind === "NATIVE"
    ) {
      shapes.push({
        ruleId: "dynamic-or-native-code",
        severity: "CRITICAL",
        capabilities: [gain.capability],
      });
    }
  }
  return shapes;
}

function classifyGains(
  gains: readonly CapabilityGain[],
  shapes: readonly ShapeFinding[],
): CapabilityFinding[] {
  const shapeSeverity = new Map<Capability, FindingSeverity>();
  for (const shape of shapes) {
    for (const capability of shape.capabilities) {
      const current = shapeSeverity.get(capability);
      if (
        current === undefined ||
        SEVERITY_ORDER[shape.severity] < SEVERITY_ORDER[current]
      ) {
        shapeSeverity.set(capability, shape.severity);
      }
    }
  }

  return gains.map((gain) => ({
    ...gain,
    severity: highestSeverity(
      fallbackSeverityFor(gain.capability),
      shapeSeverity.get(gain.capability),
    ),
  }));
}

function highestSeverity(
  fallback: FindingSeverity,
  shaped: FindingSeverity | undefined,
): FindingSeverity {
  if (shaped === undefined) return fallback;
  return SEVERITY_ORDER[shaped] < SEVERITY_ORDER[fallback] ? shaped : fallback;
}

function isCodeCapability(
  capability: Capability,
): capability is CodeCapability {
  return !isManifestCapability(capability);
}

function compareFindings(
  left: CapabilityFinding,
  right: CapabilityFinding,
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
