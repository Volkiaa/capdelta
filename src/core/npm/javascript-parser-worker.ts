import { parentPort } from "node:worker_threads";
import { parse, type Node } from "acorn";
import { fullAncestor } from "acorn-walk";
import type {
  ParserDetection,
  ParserRequest,
  ParserResponse,
} from "./javascript-parser-protocol.js";

type LocatedNode = Node & { start: number };

function analyze(request: ParserRequest): ParserResponse {
  try {
    const ast = parseSource(request);
    const detections: ParserDetection[] = [];
    fullAncestor(ast, (node) => {
      if (!isDynamicModuleLoad(node)) return;
      detections.push(evidence("UNKNOWN", node, request.source));
    });
    fullAncestor(ast, (node) => {
      const moduleName = literalModuleLoad(node);
      if (moduleName !== null && moduleName === "child_process") {
        detections.push(evidence("PROCESS", node, request.source));
      }
    });
    return { ok: true, detections };
  } catch (error: unknown) {
    const located = error as { loc?: { line?: unknown }; pos?: unknown };
    const line =
      typeof located.loc?.line === "number" && located.loc.line > 0
        ? located.loc.line
        : 1;
    return {
      ok: false,
      detail: `JavaScript parse failed: ${errorName(error)}`,
      line,
      snippet: sourceLine(request.source, line),
    };
  }
}

function literalModuleLoad(node: Node): string | null {
  const record = node as unknown as Record<string, unknown>;
  if (node.type === "ImportDeclaration") {
    return normalizedModule(stringLiteral(record.source));
  }
  if (node.type === "ImportExpression") {
    return normalizedModule(stringLiteral(record.source));
  }
  if (node.type !== "CallExpression") return null;
  const callee = asRecord(record.callee);
  const args = record.arguments;
  if (
    callee?.type !== "Identifier" ||
    callee.name !== "require" ||
    !Array.isArray(args)
  ) {
    return null;
  }
  return normalizedModule(stringLiteral(args[0]));
}

function normalizedModule(value: string | null): string | null {
  return value?.startsWith("node:") === true ? value.slice(5) : value;
}

function stringLiteral(value: unknown): string | null {
  const record = asRecord(value);
  return record?.type === "Literal" && typeof record.value === "string"
    ? record.value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseSource(request: ParserRequest): Node {
  const options = {
    ecmaVersion: "latest" as const,
    allowHashBang: true,
    locations: true,
  };
  if (request.sourceType !== "either") {
    return parse(request.source, {
      ...options,
      sourceType: request.sourceType,
    });
  }
  try {
    return parse(request.source, { ...options, sourceType: "module" });
  } catch {
    return parse(request.source, { ...options, sourceType: "script" });
  }
}

function isDynamicModuleLoad(node: Node): boolean {
  const record = node as unknown as Record<string, unknown>;
  if (node.type === "ImportExpression") return !isStringLiteral(record.source);
  if (node.type !== "CallExpression") return false;
  const callee = record.callee as Record<string, unknown> | undefined;
  const args = record.arguments;
  return (
    callee?.type === "Identifier" &&
    callee.name === "require" &&
    Array.isArray(args) &&
    !isStringLiteral(args[0])
  );
}

function isStringLiteral(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "Literal" && typeof record.value === "string";
}

function evidence(
  kind: ParserDetection["kind"],
  node: LocatedNode,
  source: string,
): ParserDetection {
  const line = node.loc?.start.line ?? 1;
  return { kind, line, snippet: sourceLine(source, line) };
}

function sourceLine(source: string, line: number): string {
  const value = source.split(/\r?\n/u)[line - 1] ?? "";
  return value.trim().slice(0, 240);
}

function errorName(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}

const port = parentPort;
if (port === null) throw new Error("parser worker requires a parent port");
port.once("message", (request: ParserRequest) => {
  port.postMessage(analyze(request));
});
