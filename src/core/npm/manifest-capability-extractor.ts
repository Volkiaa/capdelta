import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type AnalysisDiagnostic,
  type Capability,
  type CapabilitySet,
  type Evidence,
  type InstallHook,
  type PackageSubject,
} from "../contract/capability-set.js";
import type { ExtractedTarball } from "./safe-extractor.js";

const MANIFEST_FILE = "package.json";
const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EVIDENCE_SNIPPET_CHARS = 240;
const INSTALL_HOOKS: readonly InstallHook[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

export type ManifestCapabilityFailureKind =
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-too-large"
  | "manifest-invalid-json"
  | "manifest-invalid-root"
  | "identity-mismatch";

export interface ManifestCapabilityFailure {
  kind: ManifestCapabilityFailureKind;
  detail: string;
  /** null when there is no source location, such as a missing file. */
  evidence: Evidence | null;
}

export interface AnalyzedManifestCapabilities {
  status: "analyzed";
  set: CapabilitySet;
}

export interface UnavailableManifestCapabilities {
  status: "unavailable";
  failure: ManifestCapabilityFailure;
}

export type ManifestCapabilityResult =
  AnalyzedManifestCapabilities | UnavailableManifestCapabilities;

export interface ManifestCapabilityExtractorOptions {
  maxManifestBytes?: number;
}

export class ManifestCapabilityExtractorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Caller supplied an option that cannot enforce a meaningful cap. */
export class ManifestCapabilityExtractorConfigurationError extends ManifestCapabilityExtractorError {}

/** Caller broke the handoff contract from the differ or safe extractor. */
export class ManifestCapabilityExtractorContractError extends ManifestCapabilityExtractorError {}

interface PropertyNode {
  name: string;
  property: JsonNode;
  value: JsonNode;
}

interface SourceDocument {
  text: string;
  lineStarts: readonly number[];
}

interface ManifestReadSuccess {
  ok: true;
  text: string;
}

interface ManifestReadFailure {
  ok: false;
  failure: ManifestCapabilityFailure;
}

type ManifestReadResult = ManifestReadSuccess | ManifestReadFailure;

/**
 * Reads only package.json from a safely extracted npm tarball. It never imports,
 * resolves, or executes package code (PLAN §3, §4.3 layer 1).
 */
export async function extractNpmManifestCapabilities(
  extracted: Pick<ExtractedTarball, "root">,
  expected: PackageSubject,
  options: ManifestCapabilityExtractorOptions = {},
): Promise<ManifestCapabilityResult> {
  const maxManifestBytes = resolveMaxManifestBytes(options);
  validateContract(extracted, expected);

  const manifestPath = join(extracted.root, MANIFEST_FILE);
  const read = await readManifest(manifestPath, maxManifestBytes);
  if (!read.ok) return { status: "unavailable", failure: read.failure };

  const source = createSourceDocument(read.text);
  const errors: ParseError[] = [];
  const root = parseTree(read.text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (root === undefined || errors.length > 0) {
    const first = errors[0];
    return unavailable(
      "manifest-invalid-json",
      first === undefined
        ? "package.json is empty or could not be parsed"
        : `package.json is invalid JSON: ${printParseErrorCode(first.error)}`,
      first === undefined ? null : evidenceAt(source, first.offset),
    );
  }
  if (root.type !== "object") {
    return unavailable(
      "manifest-invalid-root",
      "package.json root must be an object",
      evidenceAt(source, root.offset),
    );
  }

  const duplicate = findDuplicateProperty(root);
  if (duplicate !== undefined) {
    return unavailable(
      "manifest-invalid-json",
      `package.json contains duplicate key ${JSON.stringify(duplicate.name)}`,
      evidenceAt(source, duplicate.property.offset),
    );
  }

  const identityFailure = validateManifestIdentity(root, expected, source);
  if (identityFailure !== null) {
    return { status: "unavailable", failure: identityFailure };
  }

  const capabilities: Capability[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  collectScripts(root, source, capabilities, diagnostics);
  collectBin(root, expected.name, source, capabilities, diagnostics);
  collectStringMap(
    root,
    "dependencies",
    source,
    diagnostics,
    (name, requirement, evidence) => {
      const targetName = npmAliasTarget(requirement);
      return {
        kind: "DEPENDENCY",
        location: { kind: "manifest" },
        name,
        requirement,
        ...(targetName === null ? {} : { targetName }),
        evidence: [evidence],
      };
    },
    capabilities,
  );
  collectStringMap(
    root,
    "engines",
    source,
    diagnostics,
    (runtime, requirement, evidence) => ({
      kind: "RUNTIME_CONSTRAINT",
      location: { kind: "manifest" },
      runtime,
      requirement,
      evidence: [evidence],
    }),
    capabilities,
  );

  capabilities.sort((left, right) =>
    compareText(capabilitySortKey(left), capabilitySortKey(right)),
  );
  diagnostics.sort(compareDiagnostics);

  return {
    status: "analyzed",
    set: {
      schemaVersion: CAPABILITY_SET_SCHEMA_VERSION,
      subject: expected,
      completeness: diagnostics.length === 0 ? "complete" : "partial",
      capabilities,
      diagnostics,
    },
  };
}

function resolveMaxManifestBytes(
  options: ManifestCapabilityExtractorOptions,
): number {
  const value = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ManifestCapabilityExtractorConfigurationError(
      "maxManifestBytes must be a positive safe integer",
    );
  }
  return value;
}

function validateContract(
  extracted: Pick<ExtractedTarball, "root">,
  expected: PackageSubject,
): void {
  if (extracted.root.length === 0 || !isAbsolute(extracted.root)) {
    throw new ManifestCapabilityExtractorContractError(
      "extracted.root must be a non-empty absolute path",
    );
  }
  if (
    expected.ecosystem !== "npm" ||
    expected.name.length === 0 ||
    expected.version.length === 0
  ) {
    throw new ManifestCapabilityExtractorContractError(
      "npm subject requires ecosystem=npm and non-empty name/version",
    );
  }
}

async function readManifest(
  path: string,
  maxManifestBytes: number,
): Promise<ManifestReadResult> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      return readFailure(
        "manifest-unreadable",
        "package.json is not a regular file",
      );
    }
    if (metadata.size > maxManifestBytes) {
      return readFailure(
        "manifest-too-large",
        `package.json exceeds ${String(maxManifestBytes)} bytes`,
      );
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxManifestBytes) {
      return readFailure(
        "manifest-too-large",
        `package.json exceeds ${String(maxManifestBytes)} bytes`,
      );
    }
    try {
      return {
        ok: true,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch (error: unknown) {
      return readFailure(
        "manifest-invalid-json",
        `package.json is not valid UTF-8: ${errorName(error)}`,
      );
    }
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return readFailure("manifest-missing", "package.json is missing");
    }
    return readFailure(
      "manifest-unreadable",
      `package.json could not be read: ${errorName(error)}`,
    );
  }
}

function readFailure(
  kind: ManifestCapabilityFailureKind,
  detail: string,
): ManifestReadFailure {
  return { ok: false, failure: { kind, detail, evidence: null } };
}

function unavailable(
  kind: ManifestCapabilityFailureKind,
  detail: string,
  evidence: Evidence | null,
): UnavailableManifestCapabilities {
  return { status: "unavailable", failure: { kind, detail, evidence } };
}

function validateManifestIdentity(
  root: JsonNode,
  expected: PackageSubject,
  source: SourceDocument,
): ManifestCapabilityFailure | null {
  for (const [field, wanted] of [
    ["name", expected.name],
    ["version", expected.version],
  ] as const) {
    const property = getProperty(root, field);
    if (property?.value.type !== "string") {
      return {
        kind: "identity-mismatch",
        detail: `package.json ${field} must equal ${JSON.stringify(wanted)}`,
        evidence: evidenceAt(source, property?.property.offset ?? root.offset),
      };
    }
    const actual = stringValue(property.value);
    if (actual !== wanted) {
      return {
        kind: "identity-mismatch",
        detail: `package.json ${field} ${JSON.stringify(actual)} does not match ${JSON.stringify(wanted)}`,
        evidence: evidenceAt(source, property.property.offset),
      };
    }
  }
  return null;
}

function collectScripts(
  root: JsonNode,
  source: SourceDocument,
  capabilities: Capability[],
  diagnostics: AnalysisDiagnostic[],
): void {
  const scripts = getProperty(root, "scripts");
  if (scripts === undefined) return;
  if (scripts.value.type !== "object") {
    diagnostics.push(
      malformedField(source, scripts, "scripts must be an object"),
    );
    return;
  }
  for (const hook of INSTALL_HOOKS) {
    const script = getProperty(scripts.value, hook);
    if (script === undefined) continue;
    if (script.value.type !== "string") {
      diagnostics.push(
        malformedField(source, script, `scripts.${hook} must be a string`),
      );
      continue;
    }
    const command = stringValue(script.value);
    capabilities.push({
      kind: "INSTALL_HOOK",
      location: {
        kind: "install-script",
        hook,
        applicability: hook === "prepare" ? "git-only" : "registry-install",
      },
      contentDigest: {
        algorithm: "sha256",
        value: createHash("sha256").update(command).digest("hex"),
      },
      evidence: [evidenceAt(source, script.property.offset)],
    });
  }
}

function collectBin(
  root: JsonNode,
  packageName: string,
  source: SourceDocument,
  capabilities: Capability[],
  diagnostics: AnalysisDiagnostic[],
): void {
  const bin = getProperty(root, "bin");
  if (bin === undefined) return;
  if (bin.value.type === "string") {
    capabilities.push({
      kind: "COMMAND_ENTRYPOINT",
      location: { kind: "runtime" },
      command: unscopedName(packageName),
      target: stringValue(bin.value),
      evidence: [evidenceAt(source, bin.property.offset)],
    });
    return;
  }
  if (bin.value.type !== "object") {
    diagnostics.push(
      malformedField(source, bin, "bin must be a string or object"),
    );
    return;
  }
  for (const entry of properties(bin.value)) {
    if (entry.value.type !== "string") {
      diagnostics.push(
        malformedField(source, entry, `bin.${entry.name} must be a string`),
      );
      continue;
    }
    capabilities.push({
      kind: "COMMAND_ENTRYPOINT",
      location: { kind: "runtime" },
      command: entry.name,
      target: stringValue(entry.value),
      evidence: [evidenceAt(source, entry.property.offset)],
    });
  }
}

function collectStringMap(
  root: JsonNode,
  field: "dependencies" | "engines",
  source: SourceDocument,
  diagnostics: AnalysisDiagnostic[],
  create: (name: string, value: string, evidence: Evidence) => Capability,
  capabilities: Capability[],
): void {
  const map = getProperty(root, field);
  if (map === undefined) return;
  if (map.value.type !== "object") {
    diagnostics.push(malformedField(source, map, `${field} must be an object`));
    return;
  }
  for (const entry of properties(map.value)) {
    if (entry.value.type !== "string") {
      diagnostics.push(
        malformedField(
          source,
          entry,
          `${field}.${entry.name} must be a string`,
        ),
      );
      continue;
    }
    capabilities.push(
      create(
        entry.name,
        stringValue(entry.value),
        evidenceAt(source, entry.property.offset),
      ),
    );
  }
}

function malformedField(
  source: SourceDocument,
  property: PropertyNode,
  detail: string,
): AnalysisDiagnostic {
  return {
    kind: "malformed-manifest-field",
    detail,
    evidence: [evidenceAt(source, property.property.offset)],
  };
}

function properties(node: JsonNode): PropertyNode[] {
  if (node.type !== "object") return [];
  const result: PropertyNode[] = [];
  for (const property of node.children ?? []) {
    if (property.type !== "property") continue;
    const key = property.children?.[0];
    const value = property.children?.[1];
    if (key === undefined || value === undefined) continue;
    const name = stringValue(key);
    result.push({ name, property, value });
  }
  return result;
}

function getProperty(node: JsonNode, name: string): PropertyNode | undefined {
  return properties(node).find((property) => property.name === name);
}

function stringValue(node: JsonNode): string {
  const value = node.value as unknown;
  return typeof value === "string" ? value : "";
}

function findDuplicateProperty(node: JsonNode): PropertyNode | undefined {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of properties(node)) {
      if (seen.has(property.name)) return property;
      seen.add(property.name);
      const nested = findDuplicateProperty(property.value);
      if (nested !== undefined) return nested;
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) {
      const nested = findDuplicateProperty(child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function createSourceDocument(text: string): SourceDocument {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return { text, lineStarts };
}

function evidenceAt(source: SourceDocument, offset: number): Evidence {
  let low = 0;
  let high = source.lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const start = source.lineStarts[middle];
    if (start !== undefined && start <= offset) low = middle + 1;
    else high = middle;
  }
  const lineIndex = Math.max(0, low - 1);
  const lineStart = source.lineStarts[lineIndex] ?? 0;
  const nextLineStart = source.lineStarts[lineIndex + 1] ?? source.text.length;
  const lineEnd =
    nextLineStart > lineStart && source.text[nextLineStart - 1] === "\n"
      ? nextLineStart - 1
      : nextLineStart;
  const rawLine = source.text.slice(lineStart, lineEnd).replace(/\r$/, "");
  return {
    file: MANIFEST_FILE,
    line: lineIndex + 1,
    snippet: boundedSnippet(rawLine, Math.max(0, offset - lineStart)),
  };
}

function boundedSnippet(line: string, targetOffset: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_EVIDENCE_SNIPPET_CHARS) return trimmed;

  const leadingWhitespace = line.length - line.trimStart().length;
  const target = Math.max(0, targetOffset - leadingWhitespace);
  const coreBudget = MAX_EVIDENCE_SNIPPET_CHARS - 2;
  const windowStart = Math.max(
    0,
    Math.min(trimmed.length - coreBudget, target - Math.floor(coreBudget / 2)),
  );
  const hasPrefix = windowStart > 0;
  const provisionalBudget = MAX_EVIDENCE_SNIPPET_CHARS - (hasPrefix ? 1 : 0);
  let windowEnd = Math.min(trimmed.length, windowStart + provisionalBudget);
  const hasSuffix = windowEnd < trimmed.length;
  if (hasSuffix) windowEnd -= 1;
  return `${hasPrefix ? "…" : ""}${trimmed.slice(windowStart, windowEnd)}${hasSuffix ? "…" : ""}`;
}

function capabilitySortKey(capability: Capability): string {
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
      return JSON.stringify([
        capability.kind,
        capability.location.kind,
        capability.evidence[0].file,
        capability.evidence[0].line,
      ]);
  }
}

function compareDiagnostics(
  left: AnalysisDiagnostic,
  right: AnalysisDiagnostic,
): number {
  const fileOrder = compareText(left.evidence[0].file, right.evidence[0].file);
  if (fileOrder !== 0) return fileOrder;
  const lineOrder = left.evidence[0].line - right.evidence[0].line;
  if (lineOrder !== 0) return lineOrder;
  return compareText(
    JSON.stringify([left.kind, left.detail]),
    JSON.stringify([right.kind, right.detail]),
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function unscopedName(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

function npmAliasTarget(requirement: string): string | null {
  const match = /^npm:(@[^/]+\/[^@]+|[^@]+)@/u.exec(requirement);
  return match?.[1] ?? null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
