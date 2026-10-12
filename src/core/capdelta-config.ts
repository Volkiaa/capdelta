import type { CodeCapabilityKind } from "./contract/capability-set.js";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type { SignalFindingKind } from "./signal-differ.js";
import { isExactSemver } from "./npm/semver.js";
import { parseSha512Integrity } from "./npm/fetcher.js";
import {
  EXCEPTABLE_UNANALYZABLE_KINDS,
  FETCH_STAGE_CRITICAL_KINDS,
  type ExceptableUnanalyzableKind,
} from "./run-severity.js";

/** A reviewed exception to the default severity gate (PLAN §4.4). */
export interface CapabilityAllowlistEntry {
  package: string;
  capability: AllowlistedCapability;
  justification: string;
  /**
   * Exact target version this exception was reviewed for. When set, the
   * entry suppresses findings only for that version. Unset keeps the legacy
   * all-versions behavior.
   */
  version?: string;
}

/**
 * ADR-017: a reviewed exception for a package capdelta could not analyze.
 * Bound to the exact reviewed bytes, so it names the lockfile integrity. Only
 * post-verification failure kinds can be excepted (amendment A).
 */
export interface UnanalyzableExceptionEntry {
  package: string;
  version: string;
  integrity: string;
  kind: ExceptableUnanalyzableKind;
  justification: string;
}

export interface CapdeltaConfig {
  allowlist: readonly CapabilityAllowlistEntry[];
  unanalyzable: readonly UnanalyzableExceptionEntry[];
}

export type AllowlistedCapability =
  | "INSTALL_HOOK"
  | "COMMAND_ENTRYPOINT"
  | "DEPENDENCY"
  | "RUNTIME_CONSTRAINT"
  | CodeCapabilityKind
  | SignalFindingKind;

export const ALLOWLISTED_CAPABILITIES: readonly AllowlistedCapability[] = [
  "INSTALL_HOOK",
  "COMMAND_ENTRYPOINT",
  "DEPENDENCY",
  "RUNTIME_CONSTRAINT",
  "PROCESS",
  "NET",
  "FS_READ",
  "FS_WRITE",
  "FS_SENSITIVE",
  "ENV",
  "DYNAMIC_CODE",
  "NATIVE",
  "UNKNOWN",
  "new-external-endpoint",
  "entropy-jump",
  "unparseable-file",
  "unparseable-bytes-growth",
  "obfuscation-pattern-added",
];

export class CapdeltaConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CapdeltaConfigParseError extends CapdeltaConfigError {}
export class CapdeltaConfigContractError extends CapdeltaConfigError {}

const EMPTY_CONFIG: CapdeltaConfig = { allowlist: [], unanalyzable: [] };
const CAPABILITY_SET = new Set<string>(ALLOWLISTED_CAPABILITIES);
const EXCEPTABLE_UNANALYZABLE_KIND_SET = new Set<string>(
  EXCEPTABLE_UNANALYZABLE_KINDS,
);
const FETCH_STAGE_CRITICAL_KIND_SET = new Set<string>(
  FETCH_STAGE_CRITICAL_KINDS,
);

type ConfigSection = "allowlist" | "unanalyzable";

type AllowlistField = "package" | "capability" | "justification" | "version";

type UnanalyzableField =
  "package" | "version" | "integrity" | "kind" | "justification";

type PendingEntry = Partial<CapabilityAllowlistEntry> &
  Partial<UnanalyzableExceptionEntry>;

/**
 * Parse the deliberately small YAML subset used by `.capdelta.yml`.
 * Keeping this parser bounded avoids adding a runtime YAML dependency and
 * rejects YAML features that would make policy review ambiguous. The top-level
 * `allowlist:` and `unanalyzable:` keys (ADR-017) may each appear once, in
 * either order.
 */
export function parseCapdeltaConfig(text: string): CapdeltaConfig {
  if (text.length === 0) return EMPTY_CONFIG;
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const entries: Record<ConfigSection, PendingEntry[]> = {
    allowlist: [],
    unanalyzable: [],
  };
  const seen = new Set<ConfigSection>();
  let section: ConfigSection | null = null;
  let inlineEmpty = false;
  let current: PendingEntry | null = null;
  const commit = (): void => {
    if (current === null || section === null) return;
    entries[section].push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";
    if (raw.includes("\t")) failParse(lineNumber, "tabs are not supported");
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      const name = topLevelSection(trimmed, lineNumber);
      if (seen.has(name)) failParse(lineNumber, `duplicate ${name} key`);
      commit();
      seen.add(name);
      section = name;
      inlineEmpty = trimmed === `${name}: []`;
      continue;
    }
    if (section === null) {
      failParse(
        lineNumber,
        'content must follow the "allowlist:" or "unanalyzable:" key',
      );
    }
    if (inlineEmpty) {
      failParse(lineNumber, `inline empty ${section} cannot contain entries`);
    }
    if (indent === 2 && trimmed === `${section}: []`) {
      failParse(
        lineNumber,
        `inline empty ${section} must be written as ${section}: []`,
      );
    }
    if (indent === 2 && trimmed.startsWith("- ")) {
      commit();
      current = {};
      assignField(section, current, trimmed.slice(2), lineNumber);
      continue;
    }
    if (indent === 4 && current !== null) {
      assignField(section, current, trimmed, lineNumber);
      continue;
    }
    failParse(lineNumber, "expected a two-space list item or four-space field");
  }
  commit();
  if (section === null) return EMPTY_CONFIG;

  const allowlist = entries.allowlist.map((entry, index) =>
    normalizeEntry(entry, index),
  );
  // Order-independent: several exact versions may coexist for one
  // package/capability, but a repeated tuple or a scoped/unscoped mixture
  // (which would make one entry silently override the other) is rejected.
  const scopes = new Map<string, Set<string | undefined>>();
  for (const entry of allowlist) {
    const pair = `${entry.package}\0${entry.capability}`;
    const label = `${JSON.stringify(entry.package)} / ${entry.capability}`;
    const versions = scopes.get(pair) ?? new Set<string | undefined>();
    if (versions.has(entry.version)) {
      throw new CapdeltaConfigContractError(
        `duplicate allowlist entry for ${label}${entry.version === undefined ? "" : ` version ${entry.version}`}`,
      );
    }
    if (
      versions.size > 0 &&
      (entry.version === undefined || versions.has(undefined))
    ) {
      throw new CapdeltaConfigContractError(
        `allowlist entries for ${label} mix version-scoped and unscoped exceptions`,
      );
    }
    versions.add(entry.version);
    scopes.set(pair, versions);
  }

  const unanalyzable = entries.unanalyzable.map((entry, index) =>
    normalizeUnanalyzableEntry(entry, index),
  );
  const tuples = new Set<string>();
  for (const entry of unanalyzable) {
    // SRI base64 is case-sensitive, so the tuple keeps `integrity` (and the
    // exact semver `version`) byte-for-byte; only the always-lowercase package
    // and kind fields are folded. Folding the whole key would treat two
    // distinct integrities that differ only by case as one duplicate.
    const tuple = [
      entry.package.toLowerCase(),
      entry.version,
      entry.integrity,
      entry.kind,
    ].join("\0");
    if (tuples.has(tuple)) {
      throw new CapdeltaConfigContractError(
        `duplicate unanalyzable entry for ${JSON.stringify(entry.package)} version ${entry.version} kind ${entry.kind}`,
      );
    }
    tuples.add(tuple);
  }
  return { allowlist, unanalyzable };
}

function topLevelSection(trimmed: string, lineNumber: number): ConfigSection {
  if (trimmed === "allowlist:" || trimmed === "allowlist: []") {
    return "allowlist";
  }
  if (trimmed === "unanalyzable:" || trimmed === "unanalyzable: []") {
    return "unanalyzable";
  }
  return failParse(
    lineNumber,
    'expected the top-level key "allowlist:" or "unanalyzable:"',
  );
}

function assignField(
  section: ConfigSection,
  target: PendingEntry,
  expression: string,
  lineNumber: number,
): void {
  const separator = expression.indexOf(":");
  if (separator <= 0) failParse(lineNumber, "expected field: value");
  const key = expression.slice(0, separator).trim();
  const rawValue = expression.slice(separator + 1).trim();
  const allowed: readonly string[] =
    section === "allowlist"
      ? ["package", "capability", "justification", "version"]
      : ["package", "version", "integrity", "kind", "justification"];
  if (!allowed.includes(key)) {
    failParse(lineNumber, `unknown ${section} field ${JSON.stringify(key)}`);
  }
  const field = key as AllowlistField | UnanalyzableField;
  if ((target as Record<string, unknown>)[field] !== undefined) {
    failParse(lineNumber, `duplicate field ${JSON.stringify(field)}`);
  }
  if (rawValue.length === 0) failParse(lineNumber, `${field} requires a value`);
  const parsed = parseScalar(rawValue, lineNumber);
  switch (field) {
    case "package":
      target.package = parsed;
      return;
    case "capability":
      target.capability = parsed as AllowlistedCapability;
      return;
    case "justification":
      target.justification = parsed;
      return;
    case "version":
      if (!isExactSemver(parsed)) {
        failParse(
          lineNumber,
          `version must be one exact semver, not a range or tag: ${JSON.stringify(parsed)}`,
        );
      }
      target.version = parsed;
      return;
    case "integrity":
      target.integrity = parsed;
      return;
    case "kind":
      target.kind = parsed as ExceptableUnanalyzableKind;
      return;
    default: {
      // Exhaustiveness: every allowed key is handled above.
      const unhandled: never = field;
      throw new CapdeltaConfigParseError(
        `line ${String(lineNumber)}: unhandled field ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

function parseScalar(value: string, lineNumber: number): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string" || parsed.length === 0)
        throw new Error("not a string");
      return parsed;
    } catch (error: unknown) {
      throw new CapdeltaConfigParseError(
        `line ${String(lineNumber)} has an invalid quoted value`,
        { cause: error },
      );
    }
  }
  if (value.startsWith("'") || value.includes("\n")) {
    failParse(
      lineNumber,
      "only JSON double-quoted or plain scalar values are supported",
    );
  }
  const comment = value.indexOf(" #");
  const scalar = (comment < 0 ? value : value.slice(0, comment)).trim();
  if (scalar.length === 0) failParse(lineNumber, "value must not be empty");
  return scalar;
}

function normalizeEntry(
  entry: Partial<CapabilityAllowlistEntry>,
  index: number,
): CapabilityAllowlistEntry {
  if (typeof entry.package !== "string" || entry.package.length === 0) {
    throw new CapdeltaConfigContractError(
      `allowlist entry ${String(index + 1)} requires package`,
    );
  }
  if (
    typeof entry.capability !== "string" ||
    !CAPABILITY_SET.has(entry.capability)
  ) {
    throw new CapdeltaConfigContractError(
      `allowlist entry ${String(index + 1)} has unsupported capability ${JSON.stringify(entry.capability ?? "")}`,
    );
  }
  if (
    typeof entry.justification !== "string" ||
    entry.justification.trim().length === 0
  ) {
    throw new CapdeltaConfigContractError(
      `allowlist entry ${String(index + 1)} requires a non-empty justification`,
    );
  }
  if (entry.version !== undefined && !isExactSemver(entry.version)) {
    throw new CapdeltaConfigContractError(
      `allowlist entry ${String(index + 1)} version must be one exact semver`,
    );
  }
  return {
    package: entry.package,
    capability: entry.capability,
    justification: entry.justification,
    ...(entry.version === undefined ? {} : { version: entry.version }),
  };
}

function failParse(lineNumber: number, detail: string): never {
  throw new CapdeltaConfigParseError(`line ${String(lineNumber)}: ${detail}`);
}

function normalizeUnanalyzableEntry(
  entry: Partial<UnanalyzableExceptionEntry>,
  index: number,
): UnanalyzableExceptionEntry {
  const label = `unanalyzable entry ${String(index + 1)}`;
  if (typeof entry.package !== "string" || entry.package.length === 0) {
    throw new CapdeltaConfigContractError(`${label} requires package`);
  }
  if (typeof entry.version !== "string" || !isExactSemver(entry.version)) {
    throw new CapdeltaConfigContractError(
      `${label} version must be one exact semver`,
    );
  }
  if (
    typeof entry.integrity !== "string" ||
    parseSha512Integrity(entry.integrity).length === 0
  ) {
    throw new CapdeltaConfigContractError(
      `${label} integrity must contain canonical sha512 SRI token(s)`,
    );
  }
  if (typeof entry.kind !== "string") {
    throw new CapdeltaConfigContractError(`${label} requires kind`);
  }
  if (FETCH_STAGE_CRITICAL_KIND_SET.has(entry.kind)) {
    // ADR-017 amendment A: fetch-stage failures are decided before or without
    // byte verification, so there are no reviewed bytes to bind.
    throw new CapdeltaConfigContractError(
      `${label} kind ${JSON.stringify(entry.kind)} cannot be excepted: fetch-stage failures occur before the artifact bytes are verified`,
    );
  }
  if (!EXCEPTABLE_UNANALYZABLE_KIND_SET.has(entry.kind)) {
    throw new CapdeltaConfigContractError(
      `${label} has unsupported kind ${JSON.stringify(entry.kind)}: not an unanalyzable failure`,
    );
  }
  if (
    typeof entry.justification !== "string" ||
    entry.justification.trim().length === 0
  ) {
    throw new CapdeltaConfigContractError(
      `${label} requires a non-empty justification`,
    );
  }
  return {
    package: entry.package,
    version: entry.version,
    integrity: entry.integrity,
    kind: entry.kind,
    justification: entry.justification,
  };
}

export interface FindingSuppression {
  reason: string;
}

/** Apply policy after fact extraction; no capability fact is deleted. */
export function applyCapabilityAllowlist(
  result: CapabilityDiffResult,
  config: CapdeltaConfig,
): CapabilityDiffResult {
  const reasons = new Map<string, string>();
  for (const entry of config.allowlist) {
    if (entry.package !== result.subject.name) continue;
    if (
      entry.version !== undefined &&
      entry.version !== result.subject.version
    ) {
      continue;
    }
    // The scope leads the reason so report truncation can never hide it.
    reasons.set(
      entry.capability,
      entry.version === undefined
        ? entry.justification
        : `[version ${entry.version}] ${entry.justification}`,
    );
  }
  if (reasons.size === 0) return result;
  const signalFindings = result.signalFindings;
  const mappedSignals = new Map<
    NonNullable<CapabilityDiffResult["signalFindings"]>[number],
    NonNullable<CapabilityDiffResult["signalFindings"]>[number]
  >();
  const updatedSignals = signalFindings?.map((finding) => {
    const reason = reasons.get(finding.kind);
    const updated =
      reason === undefined ? finding : { ...finding, suppression: { reason } };
    mappedSignals.set(finding, updated);
    return updated;
  });
  return {
    ...result,
    findings: result.findings.map((finding) => {
      const reason = reasons.get(finding.capability.kind);
      return reason === undefined
        ? finding
        : { ...finding, suppression: { reason } };
    }),
    ...(updatedSignals === undefined ? {} : { signalFindings: updatedSignals }),
    ...(result.shapes === undefined
      ? {}
      : {
          shapes: result.shapes.map((shape) =>
            shape.signals === undefined
              ? shape
              : {
                  ...shape,
                  signals: shape.signals.map(
                    (finding) => mappedSignals.get(finding) ?? finding,
                  ),
                },
          ),
        }),
  };
}

export function emptyCapdeltaConfig(): CapdeltaConfig {
  return EMPTY_CONFIG;
}
