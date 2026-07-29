import type { CodeCapabilityKind } from "./contract/capability-set.js";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type { SignalFindingKind } from "./signal-differ.js";

/** A reviewed exception to the default severity gate (PLAN §4.4). */
export interface CapabilityAllowlistEntry {
  package: string;
  capability: AllowlistedCapability;
  justification: string;
}

export interface CapdeltaConfig {
  allowlist: readonly CapabilityAllowlistEntry[];
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

const EMPTY_CONFIG: CapdeltaConfig = { allowlist: [] };
const CAPABILITY_SET = new Set<string>(ALLOWLISTED_CAPABILITIES);

/**
 * Parse the deliberately small YAML subset used by `.capdelta.yml`.
 * Keeping this parser bounded avoids adding a runtime YAML dependency and
 * rejects YAML features that would make policy review ambiguous.
 */
export function parseCapdeltaConfig(text: string): CapdeltaConfig {
  if (text.length === 0) return EMPTY_CONFIG;
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const entries: Partial<CapabilityAllowlistEntry>[] = [];
  let inAllowlist = false;
  let inlineEmpty = false;
  let current: Partial<CapabilityAllowlistEntry> | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";
    if (raw.includes("\t")) failParse(lineNumber, "tabs are not supported");
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      if (trimmed === "allowlist: []") {
        if (inAllowlist) failParse(lineNumber, "duplicate allowlist key");
        inAllowlist = true;
        inlineEmpty = true;
        continue;
      }
      if (trimmed !== "allowlist:") {
        failParse(lineNumber, 'expected the top-level key "allowlist:"');
      }
      if (inAllowlist) failParse(lineNumber, "duplicate allowlist key");
      inAllowlist = true;
      continue;
    }
    if (inlineEmpty)
      failParse(lineNumber, "inline empty allowlist cannot contain entries");
    if (!inAllowlist) failParse(lineNumber, "content must follow allowlist:");
    if (indent === 2 && trimmed === "allowlist: []") {
      failParse(
        lineNumber,
        "inline empty allowlist must be written as allowlist: []",
      );
    }
    if (indent === 2 && trimmed.startsWith("- ")) {
      if (current !== null) entries.push(current);
      current = {};
      assignField(current, trimmed.slice(2), lineNumber);
      continue;
    }
    if (indent === 4 && current !== null) {
      assignField(current, trimmed, lineNumber);
      continue;
    }
    failParse(lineNumber, "expected a two-space list item or four-space field");
  }
  if (current !== null) entries.push(current);
  if (!inAllowlist) return EMPTY_CONFIG;

  const normalized = entries.map((entry, index) =>
    normalizeEntry(entry, index),
  );
  const seen = new Set<string>();
  for (const entry of normalized) {
    const key = `${entry.package}\0${entry.capability}`;
    if (seen.has(key)) {
      throw new CapdeltaConfigContractError(
        `duplicate allowlist entry for ${JSON.stringify(entry.package)} / ${entry.capability}`,
      );
    }
    seen.add(key);
  }
  return { allowlist: normalized };
}

function assignField(
  target: Partial<CapabilityAllowlistEntry>,
  expression: string,
  lineNumber: number,
): void {
  const separator = expression.indexOf(":");
  if (separator <= 0) failParse(lineNumber, "expected field: value");
  const key = expression.slice(0, separator).trim();
  const rawValue = expression.slice(separator + 1).trim();
  if (key !== "package" && key !== "capability" && key !== "justification") {
    failParse(lineNumber, `unknown allowlist field ${JSON.stringify(key)}`);
  }
  if (target[key] !== undefined)
    failParse(lineNumber, `duplicate field ${JSON.stringify(key)}`);
  if (rawValue.length === 0) failParse(lineNumber, `${key} requires a value`);
  const parsed = parseScalar(rawValue, lineNumber);
  switch (key) {
    case "package":
      target.package = parsed;
      return;
    case "capability":
      target.capability = parsed as AllowlistedCapability;
      return;
    case "justification":
      target.justification = parsed;
      return;
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
  return {
    package: entry.package,
    capability: entry.capability,
    justification: entry.justification,
  };
}

function failParse(lineNumber: number, detail: string): never {
  throw new CapdeltaConfigParseError(`line ${String(lineNumber)}: ${detail}`);
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
    if (entry.package === result.subject.name) {
      reasons.set(entry.capability, entry.justification);
    }
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
