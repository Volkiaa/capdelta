import { parentPort } from "node:worker_threads";
import { type Node } from "acorn";
import { fullAncestor } from "acorn-walk";
import { transformSync } from "amaro";
import { parseSource, stringContent } from "./javascript-parse.js";
import type {
  ParserDetection,
  ParserFailure,
  ParserReadyMessage,
  ParserRequest,
  ParserResponse,
  StringRange,
} from "./javascript-parser-protocol.js";

type LocatedNode = Node & { start: number };

function analyze(request: ParserRequest): ParserResponse {
  const stripped = stripTypeScript(request);
  if (!stripped.ok) return stripped.failure;
  try {
    const { ast, comments } = parseSource(stripped.source, request.sourceType);
    const resolver = new BindingResolver(ast, stripped.source);
    return {
      ok: true,
      detections: detectCapabilities(resolver, request.source),
      comments,
      stringRanges: resolver.stringRanges,
      cookedStrings: resolver.cookedStrings,
      ...(resolver.topLevelLoop === undefined
        ? {}
        : { topLevelLoop: resolver.topLevelLoop }),
    };
  } catch (error: unknown) {
    const located = error as { loc?: { line?: unknown }; pos?: unknown };
    const line =
      typeof located.loc?.line === "number" && located.loc.line > 0
        ? located.loc.line
        : 1;
    return {
      ok: false,
      reason: "syntax",
      detail: `JavaScript parse failed: ${errorName(error)}`,
      line,
      snippet: sourceLine(request.source, line),
    };
  }
}

type StrippedSource =
  { ok: true; source: string } | { ok: false; failure: ParserFailure };

/**
 * Strip-only mode replaces each type with whitespace, so the stripped code has
 * the same length and line breaks as the source. A different length would move
 * every later offset, so it is rejected rather than parsed.
 */
function stripTypeScript(request: ParserRequest): StrippedSource {
  if (request.language !== "typescript") {
    return { ok: true, source: request.source };
  }
  let stripped: string;
  try {
    stripped = transformSync(request.source, { mode: "strip-only" }).code;
  } catch (error: unknown) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "unsupported-typescript",
        detail: stripErrorDetail(error),
        line: 1,
        snippet: sourceLine(request.source, 1),
      },
    };
  }
  if (stripped.length !== request.source.length) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "unsupported-typescript",
        detail: `stripping changed the source length from ${String(request.source.length)} to ${String(stripped.length)}`,
        line: 1,
        snippet: sourceLine(request.source, 1),
      },
    };
  }
  return { ok: true, source: stripped };
}

interface NodeVisit {
  node: Node;
  scope: Scope | null;
}

interface DetectionBuckets {
  dynamicModule: ParserDetection[];
  process: ParserDetection[];
  network: ParserDetection[];
  native: ParserDetection[];
  dynamicCode: ParserDetection[];
  environment: ParserDetection[];
  filesystem: ParserDetection[];
}

function detectCapabilities(
  resolver: BindingResolver,
  source: string,
): ParserDetection[] {
  const buckets: DetectionBuckets = {
    dynamicModule: [],
    process: [],
    network: [],
    native: [],
    dynamicCode: [],
    environment: [],
    filesystem: [],
  };
  for (const visit of resolver.visits) {
    detectDynamicModule(visit.node, source, buckets.dynamicModule);
    detectProcess(visit.node, source, buckets.process);
    detectNetwork(visit, resolver, source, buckets.network);
    detectNative(visit, resolver, source, buckets.native);
    detectDynamicCode(visit, resolver, source, buckets.dynamicCode);
    detectEnvironment(visit, resolver, source, buckets.environment);
    detectFilesystem(visit, resolver, source, buckets.filesystem);
  }
  return [
    ...buckets.dynamicModule,
    ...buckets.process,
    ...buckets.network,
    ...buckets.native,
    ...buckets.dynamicCode,
    ...buckets.environment,
    ...buckets.filesystem,
  ];
}

function detectDynamicModule(
  node: Node,
  source: string,
  output: ParserDetection[],
): void {
  if (isDynamicModuleLoad(node)) output.push(evidence("UNKNOWN", node, source));
}

function detectProcess(
  node: Node,
  source: string,
  output: ParserDetection[],
): void {
  if (literalModuleLoad(node) === "child_process") {
    output.push(evidence("PROCESS", node, source));
  }
}

function detectNetwork(
  visit: NodeVisit,
  resolver: BindingResolver,
  source: string,
  output: ParserDetection[],
): void {
  const { node, scope } = visit;
  const moduleName = literalModuleLoad(node);
  if (moduleName !== null && NETWORK_MODULES.has(moduleName)) {
    output.push(evidence("NET", node, source));
    return;
  }
  const record = asRecord(node);
  if (node.type === "CallExpression") {
    const callee = asRecord(record?.callee);
    if (
      callee?.type === "Identifier" &&
      callee.name === "fetch" &&
      resolver.lookup("fetch", scope) === undefined
    ) {
      output.push(evidence("NET", node, source));
    }
  }
  if (node.type === "NewExpression") {
    const callee = asRecord(record?.callee);
    if (
      callee?.type === "Identifier" &&
      callee.name === "WebSocket" &&
      resolver.lookup("WebSocket", scope) === undefined
    ) {
      output.push(evidence("NET", node, source));
    }
  }
}

function detectNative(
  visit: NodeVisit,
  resolver: BindingResolver,
  source: string,
  output: ParserDetection[],
): void {
  const { node, scope } = visit;
  const moduleName = literalModuleLoad(node);
  if (moduleName?.endsWith(".node") === true) {
    output.push(evidence("NATIVE", node, source));
    return;
  }
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
  const callee = asRecord(asRecord(node)?.callee);
  if (callee?.type !== "MemberExpression") return;
  const object = asRecord(callee.object);
  const member = memberName(callee);
  if (
    object?.type === "Identifier" &&
    object.name === "WebAssembly" &&
    resolver.lookup("WebAssembly", scope) === undefined
  ) {
    output.push(evidence("NATIVE", node, source));
  } else if (
    object?.type === "Identifier" &&
    object.name === "process" &&
    member === "dlopen" &&
    resolver.lookup("process", scope) === undefined
  ) {
    output.push(evidence("NATIVE", node, source));
  }
}

function detectDynamicCode(
  visit: NodeVisit,
  resolver: BindingResolver,
  source: string,
  output: ParserDetection[],
): void {
  const { node, scope } = visit;
  if (literalModuleLoad(node) === "vm") {
    output.push(evidence("DYNAMIC_CODE", node, source));
    return;
  }
  const record = asRecord(node);
  if (node.type === "CallExpression") {
    const callee = asRecord(record?.callee);
    if (
      callee?.type === "Identifier" &&
      callee.name === "eval" &&
      resolver.lookup("eval", scope) === undefined
    ) {
      output.push(evidence("DYNAMIC_CODE", node, source));
    }
  }
  if (node.type === "NewExpression") {
    const callee = asRecord(record?.callee);
    if (
      callee?.type === "Identifier" &&
      callee.name === "Function" &&
      resolver.lookup("Function", scope) === undefined
    ) {
      output.push(evidence("DYNAMIC_CODE", node, source));
    }
  }
}

function detectEnvironment(
  visit: NodeVisit,
  resolver: BindingResolver,
  source: string,
  output: ParserDetection[],
): void {
  const { node, scope } = visit;
  if (node.type !== "MemberExpression") return;
  const record = asRecord(node);
  const object = asRecord(record?.object);
  const property = memberName(record);
  if (
    object?.type === "Identifier" &&
    object.name === "process" &&
    property === "env" &&
    resolver.lookup("process", scope) === undefined
  ) {
    output.push(evidence("ENV", node, source));
  }
}

function detectFilesystem(
  visit: NodeVisit,
  resolver: BindingResolver,
  source: string,
  output: ParserDetection[],
): void {
  const { node, scope } = visit;
  if (node.type !== "CallExpression") return;
  const binding = resolver.resolveExpression(asRecord(node)?.callee, scope);
  if (
    isResolved(binding) &&
    binding.module === "fs" &&
    binding.member !== null &&
    FS_READ_MEMBERS.has(binding.member)
  ) {
    output.push(evidence("FS_READ", node, source));
    if (hasSensitivePath(node))
      output.push(evidence("FS_SENSITIVE", node, source));
  } else if (
    isResolved(binding) &&
    binding.module === "fs" &&
    binding.member !== null &&
    FS_WRITE_MEMBERS.has(binding.member)
  ) {
    output.push(evidence("FS_WRITE", node, source));
    if (hasSensitivePath(node))
      output.push(evidence("FS_SENSITIVE", node, source));
  } else if (isUnknownBinding(binding)) {
    output.push(evidence("UNKNOWN", node, source));
  }
}

const NETWORK_MODULES = new Set(["http", "https", "net", "tls", "dgram"]);
const FS_READ_MEMBERS = new Set([
  "access",
  "accessSync",
  "createReadStream",
  "existsSync",
  "lstat",
  "lstatSync",
  "read",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "stat",
  "statSync",
]);
const FS_WRITE_MEMBERS = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "mkdir",
  "mkdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
]);

interface ResolvedBinding {
  module: string;
  member: string | null;
  depth: 0 | 1;
}

interface UnknownBinding {
  unknownFromKnownApi: true;
}

type Binding = ResolvedBinding | UnknownBinding | null;

interface Scope {
  node: Node;
  parent: Scope | null;
  bindings: Map<string, Binding>;
}

interface AliasTask {
  node: Node;
  scope: Scope | null;
}

class BindingResolver {
  readonly scopes = new Map<Node, Scope>();
  readonly visits: NodeVisit[] = [];
  readonly stringRanges: StringRange[] = [];
  readonly cookedStrings: (readonly [start: number, value: string])[] = [];
  readonly topLevelLoop: { line: number } | undefined;

  constructor(ast: Node, source: string) {
    const aliases: AliasTask[] = [];
    const loopCandidates: Node[] = [];
    const brokenLoops = new Set<Node>();
    fullAncestor(ast, (node, _state, ancestors) => {
      const scope = this.ensureScopes(ancestors);
      this.collectDeclaration(node, ancestors, scope);
      this.visits.push({ node, scope });
      // Push one item at a time. Spreading an array sized by the input throws
      // RangeError on a package with enough strings.
      const content = stringContent(node, source);
      if (content !== null) {
        this.stringRanges.push(content.range);
        if (content.cooked !== null) this.cookedStrings.push(content.cooked);
      }
      if (isAliasCandidate(node, ancestors)) aliases.push({ node, scope });
      if (isUnboundedModuleLoop(node, ancestors)) loopCandidates.push(node);
      const target = breakTarget(node, ancestors);
      if (target !== null) brokenLoops.add(target);
    });

    const firstLoop = loopCandidates.find((loop) => !brokenLoops.has(loop));
    this.topLevelLoop =
      firstLoop === undefined
        ? undefined
        : { line: firstLoop.loc?.start.line ?? 1 };
    this.stringRanges.sort((left, right) => left[0] - right[0]);
    this.cookedStrings.sort((left, right) => left[0] - right[0]);
    for (const alias of aliases) this.collectAlias(alias.node, alias.scope);
  }

  lookup(name: string, initialScope: Scope | null): Binding | undefined {
    let current = initialScope;
    while (current !== null) {
      if (current.bindings.has(name)) return current.bindings.get(name);
      current = current.parent;
    }
    return undefined;
  }

  resolveExpression(value: unknown, scope: Scope | null): Binding | undefined {
    const node = asRecord(value);
    if (node?.type === "Identifier" && typeof node.name === "string") {
      return this.lookup(node.name, scope);
    }
    const direct = directModuleExpression(value);
    if (direct !== null) return direct;
    if (node?.type !== "MemberExpression" || node.computed === true) {
      return undefined;
    }
    const object = this.resolveExpression(node.object, scope);
    const property = identifierName(node.property);
    if (isResolved(object) && object.member === null && property !== null) {
      return { module: object.module, member: property, depth: object.depth };
    }
    return isKnownBinding(object) ? { unknownFromKnownApi: true } : undefined;
  }

  private collectDeclaration(
    node: Node,
    ancestors: readonly Node[],
    scope: Scope | null,
  ): void {
    const record = asRecord(node);
    if (node.type === "ImportDeclaration") {
      const moduleName = normalizedModule(stringLiteral(record?.source));
      const specifiers = record?.specifiers;
      if (scope === null || moduleName === null || !Array.isArray(specifiers))
        return;
      for (const item of specifiers) {
        const specifier = asRecord(item);
        const local = identifierName(specifier?.local);
        if (local === null) continue;
        const imported =
          specifier?.type === "ImportSpecifier"
            ? identifierName(specifier.imported)
            : null;
        scope.bindings.set(local, {
          module: moduleName,
          member: imported,
          depth: 0,
        });
      }
      return;
    }
    if (node.type === "VariableDeclarator") {
      const declaration = [...ancestors]
        .reverse()
        .map(asRecord)
        .find((item) => item?.type === "VariableDeclaration");
      if (scope === null) return;
      const direct =
        declaration?.kind === "const"
          ? directModuleExpression(record?.init)
          : null;
      declarePattern(scope, record?.id, direct);
      return;
    }
    if (isFunctionNode(node)) {
      const functionScope = this.scopes.get(node);
      const params = record?.params;
      if (functionScope !== undefined && Array.isArray(params)) {
        for (const parameter of params)
          declarePattern(functionScope, parameter, null);
      }
      if (node.type === "FunctionDeclaration") {
        const name = identifierName(record?.id);
        if (name !== null) functionScope?.parent?.bindings.set(name, null);
      }
    }
  }

  private collectAlias(node: Node, scope: Scope | null): void {
    if (node.type !== "VariableDeclarator") return;
    const record = asRecord(node);
    if (scope === null || directModuleExpression(record?.init) !== null) return;
    const source = this.resolveExpression(record?.init, scope);
    const alias = isResolved(source)
      ? source.depth === 0
        ? { ...source, depth: 1 as const }
        : { unknownFromKnownApi: true as const }
      : isKnownBinding(source)
        ? { unknownFromKnownApi: true as const }
        : null;
    declarePattern(scope, record?.id, alias);
  }

  private ensureScopes(ancestors: readonly Node[]): Scope | null {
    let parent: Scope | null = null;
    for (const node of ancestors) {
      if (!isScopeNode(node)) continue;
      let scope = this.scopes.get(node);
      if (scope === undefined) {
        scope = { node, parent, bindings: new Map() };
        this.scopes.set(node, scope);
      }
      parent = scope;
    }
    return parent;
  }
}

function isAliasCandidate(node: Node, ancestors: readonly Node[]): boolean {
  if (node.type !== "VariableDeclarator") return false;
  const declaration = [...ancestors]
    .reverse()
    .map(asRecord)
    .find((ancestor) => ancestor?.type === "VariableDeclaration");
  return declaration?.kind === "const";
}

function directModuleExpression(value: unknown): ResolvedBinding | null {
  const node = asRecord(value);
  if (node === null) return null;
  const awaited = node.type === "AwaitExpression" ? node.argument : value;
  const awaitedRecord = asRecord(awaited);
  if (awaitedRecord?.type === "ImportExpression") {
    const moduleName = normalizedModule(stringLiteral(awaitedRecord.source));
    return moduleName === null
      ? null
      : { module: moduleName, member: null, depth: 0 };
  }
  if (awaitedRecord?.type === "CallExpression") {
    const callee = asRecord(awaitedRecord.callee);
    const args = awaitedRecord.arguments;
    if (
      callee?.type === "Identifier" &&
      callee.name === "require" &&
      Array.isArray(args)
    ) {
      const moduleName = normalizedModule(stringLiteral(args[0]));
      return moduleName === null
        ? null
        : { module: moduleName, member: null, depth: 0 };
    }
  }
  if (node.type === "MemberExpression" && node.computed !== true) {
    const object = directModuleExpression(node.object);
    const member = identifierName(node.property);
    if (object !== null && member !== null)
      return { module: object.module, member, depth: 0 };
  }
  return null;
}

function declarePattern(scope: Scope, value: unknown, binding: Binding): void {
  const pattern = asRecord(value);
  if (pattern?.type === "Identifier" && typeof pattern.name === "string") {
    scope.bindings.set(pattern.name, binding);
    return;
  }
  if (pattern?.type !== "ObjectPattern" || !Array.isArray(pattern.properties))
    return;
  for (const item of pattern.properties) {
    const property = asRecord(item);
    const name = identifierName(property?.value);
    const member = identifierName(property?.key);
    if (name === null) continue;
    scope.bindings.set(
      name,
      isResolved(binding) && member !== null
        ? { module: binding.module, member, depth: binding.depth }
        : binding,
    );
  }
}

function isScopeNode(node: Node): boolean {
  return (
    node.type === "Program" ||
    node.type === "BlockStatement" ||
    node.type === "CatchClause" ||
    isFunctionNode(node)
  );
}

function isFunctionNode(node: Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/**
 * A loop that runs at import time with no exit condition: For, While or
 * DoWhile outside every function, with an absent or constant-true test, and no
 * break that leaves the loop itself. A break inside a nested loop, switch, or a
 * labelled outer statement does not count for this loop.
 */
function isUnboundedModuleLoop(
  node: Node,
  ancestors: readonly Node[],
): boolean {
  if (!isLoopNode(node)) return false;
  if (ancestors.some((ancestor) => isFunctionNode(ancestor))) return false;
  const test = asRecord(node)?.test;
  return test === null || test === undefined || constantTruthy(test) === true;
}

function isLoopNode(node: Node): boolean {
  return (
    node.type === "ForStatement" ||
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement"
  );
}

function isBreakableNode(node: Node): boolean {
  return (
    isLoopNode(node) ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "SwitchStatement"
  );
}

/** The loop, switch or labelled statement a break leaves, if it has one. */
function breakTarget(node: Node, ancestors: readonly Node[]): Node | null {
  if (node.type !== "BreakStatement") return null;
  const label = identifierName(asRecord(node)?.label);
  for (let index = ancestors.length - 2; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined) continue;
    if (label !== null) {
      if (
        ancestor.type === "LabeledStatement" &&
        identifierName(asRecord(ancestor)?.label) === label
      ) {
        return nodeValue(asRecord(ancestor)?.body);
      }
      continue;
    }
    if (isBreakableNode(ancestor)) return ancestor;
  }
  return null;
}

/** True or false for a literal or a negation of one, null otherwise. */
function constantTruthy(value: unknown): boolean | null {
  const node = asRecord(value);
  if (node === null) return null;
  if (node.type === "Literal") return Boolean(node.value);
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const argument = constantTruthy(node.argument);
    return argument === null ? null : !argument;
  }
  return null;
}

function nodeValue(value: unknown): Node | null {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).type === "string"
    ? (value as Node)
    : null;
}

function isResolved(binding: Binding | undefined): binding is ResolvedBinding {
  return binding !== null && binding !== undefined && "module" in binding;
}

function isKnownBinding(binding: Binding | undefined): boolean {
  return (
    isResolved(binding) ||
    (binding !== null &&
      binding !== undefined &&
      "unknownFromKnownApi" in binding)
  );
}

function isUnknownBinding(
  binding: Binding | undefined,
): binding is UnknownBinding {
  return (
    binding !== null &&
    binding !== undefined &&
    "unknownFromKnownApi" in binding
  );
}

function identifierName(value: unknown): string | null {
  const record = asRecord(value);
  return record?.type === "Identifier" && typeof record.name === "string"
    ? record.name
    : null;
}

function memberName(member: Record<string, unknown> | null): string | null {
  if (member === null) return null;
  return member.computed === true
    ? stringLiteral(member.property)
    : identifierName(member.property);
}

function hasSensitivePath(node: Node): boolean {
  const args = asRecord(node)?.arguments;
  if (!Array.isArray(args)) return false;
  return literalFragments(args[0]).some(isSensitivePathFragment);
}

function literalFragments(value: unknown): string[] {
  const node = asRecord(value);
  if (node === null) return [];
  const literal = stringLiteral(node);
  if (literal !== null) return [literal];
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis)
  ) {
    return node.quasis.flatMap((quasi) => {
      const cooked = asRecord(asRecord(quasi)?.value)?.cooked;
      return typeof cooked === "string" ? [cooked] : [];
    });
  }
  if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
    return node.arguments.flatMap(literalFragments);
  }
  return [];
}

function isSensitivePathFragment(value: string): boolean {
  const path = value.replaceAll("\\", "/").toLowerCase();
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.includes(".npmrc") || segments.includes(".ssh")) return true;
  if (path.includes(".aws/credentials") || path.includes(".config/gh"))
    return true;
  if (
    path.includes("library/keychains") ||
    path.includes(".local/share/keyrings") ||
    path.includes("microsoft/credentials") ||
    path.includes("microsoft/vault") ||
    segments.some((segment) => segment.startsWith("login.keychain"))
  ) {
    return true;
  }
  return segments.some(
    (segment) =>
      (segment === ".env" || segment.startsWith(".env.")) &&
      ![".env.example", ".env.sample", ".env.template"].includes(segment),
  );
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

/** Amaro's wasm errors carry a message but do not extend Error. */
function stripErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = asRecord(error)?.message;
  return typeof message === "string" ? message : errorName(error);
}

const port = parentPort;
if (port === null) throw new Error("parser worker requires a parent port");
port.on("message", (request: ParserRequest) => {
  port.postMessage(analyze(request));
});
const ready: ParserReadyMessage = { type: "ready" };
port.postMessage(ready);
