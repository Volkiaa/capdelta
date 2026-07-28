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
    const resolver = new BindingResolver(ast);
    return {
      ok: true,
      detections: detectCapabilities(resolver, request.source),
    };
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

  constructor(ast: Node) {
    const aliases: AliasTask[] = [];
    // This is the worker's only tree walk. Scope pointers keep the retained
    // visit index linear in AST size; aliases resolve after all direct bindings.
    fullAncestor(ast, (node, _state, ancestors) => {
      const scope = this.ensureScopes(ancestors);
      this.collectDeclaration(node, ancestors, scope);
      this.visits.push({ node, scope });
      if (isAliasCandidate(node, ancestors)) aliases.push({ node, scope });
    });

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
port.on("message", (request: ParserRequest) => {
  port.postMessage(analyze(request));
});
