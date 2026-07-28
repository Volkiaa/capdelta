import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AnalysisDiagnostic,
  CapabilityLocation,
  CapabilitySet,
  CodeCapability,
  CodeCapabilityKind,
  Evidence,
  InstallHookCapability,
} from "../contract/capability-set.js";
import type { ExtractedTarball } from "./safe-extractor.js";
import type {
  ParserRequest,
  ParserResponse,
} from "./javascript-parser-protocol.js";

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PARSE_TIMEOUT_MS = 5_000;
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export interface AstExtractionOptions {
  maxSourceBytes?: number;
  parseTimeoutMs?: number;
}

export interface JavaScriptCapabilityLayerResult {
  capabilities: readonly CodeCapability[];
  diagnostics: readonly AnalysisDiagnostic[];
}

export function mergeJavaScriptCapabilityLayer(
  manifestSet: CapabilitySet,
  layer: JavaScriptCapabilityLayerResult,
): CapabilitySet {
  const capabilities = [...manifestSet.capabilities, ...layer.capabilities];
  capabilities.sort((left, right) =>
    compareText(JSON.stringify(left), JSON.stringify(right)),
  );
  const diagnostics = [...manifestSet.diagnostics, ...layer.diagnostics];
  diagnostics.sort((left, right) =>
    compareEvidence(left.evidence[0], right.evidence[0]),
  );
  return {
    schemaVersion: manifestSet.schemaVersion,
    subject: manifestSet.subject,
    completeness: diagnostics.length === 0 ? "complete" : "partial",
    capabilities,
    diagnostics,
  };
}

export class JavaScriptCapabilityExtractorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class JavaScriptCapabilityExtractorConfigurationError extends JavaScriptCapabilityExtractorError {}
export class JavaScriptCapabilityExtractorContractError extends JavaScriptCapabilityExtractorError {}

interface ResolvedOptions {
  maxSourceBytes: number;
  parseTimeoutMs: number;
}

export async function extractNpmJavaScriptCapabilities(
  extracted: Pick<ExtractedTarball, "root">,
  manifestSet: CapabilitySet,
  options: AstExtractionOptions = {},
): Promise<JavaScriptCapabilityLayerResult> {
  const resolvedOptions = resolveOptions(options);
  validateContract(extracted, manifestSet);
  const installFiles = await discoverInstallFiles(extracted.root, manifestSet);
  const files = await enumerateFiles(extracted.root);
  const grouped = new Map<
    string,
    {
      kind: CodeCapabilityKind;
      location: CapabilityLocation;
      evidence: Evidence[];
    }
  >();
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const file of files) {
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    if (
      extension === ".node" ||
      file.toLowerCase().endsWith("/binding.gyp") ||
      file.toLowerCase() === "binding.gyp"
    ) {
      addGrouped(
        grouped,
        "NATIVE",
        { kind: "runtime" },
        {
          file,
          line: 1,
          snippet:
            extension === ".node" ? `<native binary: ${file}>` : "binding.gyp",
        },
      );
      continue;
    }
    if (extension === ".ts") {
      diagnostics.push(
        diagnostic(
          "unsupported-source",
          `${file} is TypeScript source; v0.1 parses JavaScript only`,
          file,
        ),
      );
      continue;
    }
    if (!JAVASCRIPT_EXTENSIONS.has(extension)) continue;
    const absolute = resolveInside(extracted.root, file);
    let source: string;
    try {
      const bytes = await readFile(absolute);
      if (bytes.byteLength > resolvedOptions.maxSourceBytes) {
        diagnostics.push(
          diagnostic(
            "unparseable-source",
            `${file} exceeds the ${String(resolvedOptions.maxSourceBytes)} byte parser limit`,
            file,
          ),
        );
        continue;
      }
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      diagnostics.push(
        diagnostic(
          "unparseable-source",
          `${file} could not be read as UTF-8: ${errorName(error)}`,
          file,
        ),
      );
      continue;
    }
    const response = await parseInWorker(
      {
        source,
        file,
        sourceType:
          extension === ".mjs"
            ? "module"
            : extension === ".cjs"
              ? "script"
              : "either",
      },
      resolvedOptions.parseTimeoutMs,
    );
    if (!response.ok) {
      diagnostics.push({
        kind: "unparseable-source",
        detail: response.detail,
        evidence: [{ file, line: response.line, snippet: response.snippet }],
      });
      continue;
    }
    const locations = installFiles.get(file) ?? [{ kind: "runtime" } as const];
    for (const detection of response.detections) {
      for (const location of locations) {
        const evidence = {
          file,
          line: detection.line,
          snippet: detection.snippet,
        };
        addGrouped(grouped, detection.kind, location, evidence);
      }
    }
  }

  const capabilities = [...grouped.values()].map(
    ({ kind, location, evidence }) => ({
      kind,
      location,
      evidence: evidence.sort(compareEvidence) as [Evidence, ...Evidence[]],
    }),
  );
  capabilities.sort((left, right) =>
    compareText(
      JSON.stringify([left.kind, left.location]),
      JSON.stringify([right.kind, right.location]),
    ),
  );
  diagnostics.sort((left, right) =>
    compareEvidence(left.evidence[0], right.evidence[0]),
  );
  return { capabilities, diagnostics };
}

function addGrouped(
  grouped: Map<
    string,
    {
      kind: CodeCapabilityKind;
      location: CapabilityLocation;
      evidence: Evidence[];
    }
  >,
  kind: CodeCapabilityKind,
  location: CapabilityLocation,
  evidence: Evidence,
): void {
  const key = JSON.stringify([kind, location]);
  const existing = grouped.get(key);
  if (existing === undefined)
    grouped.set(key, { kind, location, evidence: [evidence] });
  else if (
    !existing.evidence.some((item) => compareEvidence(item, evidence) === 0)
  )
    existing.evidence.push(evidence);
}

function resolveOptions(options: AstExtractionOptions): ResolvedOptions {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const parseTimeoutMs = options.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  for (const [name, value] of [
    ["maxSourceBytes", maxSourceBytes],
    ["parseTimeoutMs", parseTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new JavaScriptCapabilityExtractorConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  return { maxSourceBytes, parseTimeoutMs };
}

function validateContract(
  extracted: Pick<ExtractedTarball, "root">,
  manifestSet: CapabilitySet,
): void {
  if (!isAbsolute(extracted.root) || extracted.root.length === 0)
    throw new JavaScriptCapabilityExtractorContractError(
      "extracted.root must be an absolute path",
    );
  if (manifestSet.subject.ecosystem !== "npm")
    throw new JavaScriptCapabilityExtractorContractError(
      "manifestSet must describe an npm package",
    );
}

async function enumerateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile())
        files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  try {
    await visit(root);
  } catch (error: unknown) {
    throw new JavaScriptCapabilityExtractorError(
      `cannot enumerate extracted package: ${errorName(error)}`,
    );
  }
  return files;
}

async function discoverInstallFiles(
  root: string,
  manifestSet: CapabilitySet,
): Promise<Map<string, CapabilityLocation[]>> {
  const hooks = manifestSet.capabilities.filter(
    (capability): capability is InstallHookCapability =>
      capability.kind === "INSTALL_HOOK",
  );
  if (hooks.length === 0) return new Map();
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error: unknown) {
    throw new JavaScriptCapabilityExtractorContractError(
      `validated package.json cannot be reread: ${errorName(error)}`,
    );
  }
  const scripts =
    isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  const result = new Map<string, CapabilityLocation[]>();
  for (const capability of hooks) {
    const command = scripts[capability.location.hook];
    if (typeof command !== "string") continue;
    const file = literalNodeEntrypoint(command);
    if (file === null) continue;
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//u, "");
    resolveInside(root, normalized);
    const locations = result.get(normalized) ?? [];
    locations.push(capability.location);
    result.set(normalized, locations);
  }
  return result;
}

function literalNodeEntrypoint(command: string): string | null {
  const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  if (tokens[0] !== "node") return null;
  const candidate = tokens.find(
    (token, index) => index > 0 && !token.startsWith("-"),
  );
  if (candidate === undefined || /[$*?`]/u.test(candidate)) return null;
  return candidate.replace(/^(?:"|')|(?:"|')$/gu, "");
}

function resolveInside(root: string, file: string): string {
  const absolute = resolve(root, file);
  const prefix = `${resolve(root)}${sep}`;
  if (absolute !== resolve(root) && !absolute.startsWith(prefix))
    throw new JavaScriptCapabilityExtractorContractError(
      `path escapes extracted root: ${file}`,
    );
  return absolute;
}

async function parseInWorker(
  request: ParserRequest,
  timeoutMs: number,
): Promise<ParserResponse> {
  const worker = new Worker(workerUrl());
  return await new Promise((resolveResponse) => {
    const timeout = setTimeout(() => {
      void worker.terminate();
      resolveResponse({
        ok: false,
        detail: `JavaScript parse exceeded ${String(timeoutMs)} ms`,
        line: 1,
        snippet: request.source.split(/\r?\n/u)[0]?.trim().slice(0, 240) ?? "",
      });
    }, timeoutMs);
    worker.once("message", (response: ParserResponse) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolveResponse(response);
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      resolveResponse({
        ok: false,
        detail: `JavaScript parser worker failed: ${errorName(error)}`,
        line: 1,
        snippet: "",
      });
    });
    worker.postMessage(request);
  });
}

function workerUrl(): URL {
  if (import.meta.url.endsWith(".ts"))
    return pathToFileURL(resolve("dist/core/npm/javascript-parser-worker.js"));
  // Keep ncc from copying TypeScript as a hashed raw asset. The Action
  // packaging script builds this stable worker entry as JavaScript itself.
  const workerFile = ["javascript", "parser", "worker.js"].join("-");
  return new URL(workerFile, import.meta.url);
}

function diagnostic(
  kind: AnalysisDiagnostic["kind"],
  detail: string,
  file: string,
): AnalysisDiagnostic {
  return { kind, detail, evidence: [{ file, line: 1, snippet: "" }] };
}

function compareEvidence(left: Evidence, right: Evidence): number {
  return compareText(
    JSON.stringify([left.file, left.line, left.snippet]),
    JSON.stringify([right.file, right.line, right.snippet]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
