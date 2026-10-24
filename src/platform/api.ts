import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import type { FindingStore } from "./intel/finding-store.js";
import {
  IntelModelError,
  type TransitionRequest,
  type Verdict,
} from "./intel/finding.js";
import { toOsv } from "./intel/osv.js";
import type { Reviewers } from "./intel/reviewers.js";
import type { JobQueue } from "./job-queue.js";
import type { ReleaseRecord, ReleaseStore } from "./release-store.js";

export interface ApiDeps {
  releases: ReleaseStore;
  findings: FindingStore;
  queue: JobQueue;
  reviewers?: Reviewers;
  onError?: (error: unknown) => void;
}

export class ApiError extends NamedError {}

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_URL_CHARS = 2048;
const MAX_NAME_OR_VERSION_CHARS = 214;
const MAX_FAILED_JOBS = 100;
const MAX_HEADERS_COUNT = 50;
const MAX_QUERY_FINDINGS = 200;
const DEFAULT_FEED_LIMIT = 100;
const MAX_FEED_LIMIT = 500;
const MAX_TRANSITION_BODY_BYTES = 16 * 1024;
const FINDING_ID_PATTERN = /^CDI-[0-9a-f]{20}$/u;
const BEARER_PATTERN = /^Bearer +(\S+)$/iu;
const VERDICTS: readonly Verdict[] = [
  "suspected",
  "under-review",
  "confirmed-malicious",
  "benign",
  "retracted",
];
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTER = /\p{Cc}/u;

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function createApiServer(deps: ApiDeps): Server {
  const onError = deps.onError ?? logError;
  const server = createServer((request, response) => {
    void respond(deps, onError, request, response);
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  return server;
}

export function listenApi(
  server: Server,
  port: number,
  host = "127.0.0.1",
): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new ApiError(
            `the server reported ${JSON.stringify(address)} instead of a TCP address`,
          ),
        );
        return;
      }
      resolve({ port: address.port, host });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function respond(
  deps: ApiDeps,
  onError: (error: unknown) => void,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const reply = await dispatch(deps, request);
    write(request, response, reply);
  } catch (error) {
    onError(error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    write(request, response, {
      status: 500,
      body: { error: "internal error" },
    });
  }
}

async function dispatch(
  deps: ApiDeps,
  request: IncomingMessage,
): Promise<Reply> {
  const rawUrl = request.url ?? "";
  if (rawUrl.length > MAX_URL_CHARS) {
    request.resume();
    return { status: 414, body: { error: "url too long" } };
  }
  const method = request.method;
  if (method === "GET" || method === "HEAD") return route(deps, rawUrl);

  if (method === "POST") {
    const target = parseTarget(rawUrl);
    if (target === null) return badRequest();
    const id = transitionsId(target.segments);
    if (id !== null) {
      // Without a reviewers file there is no write route to answer.
      if (deps.reviewers === undefined) {
        request.resume();
        return notFound();
      }
      return transitionRoute(deps, deps.reviewers, id, request);
    }
  }

  // Drain the body so a keep-alive connection does not stall on it.
  request.resume();
  return {
    status: 405,
    body: { error: "method not allowed" },
    headers: { allow: "GET, HEAD" },
  };
}

async function route(deps: ApiDeps, rawUrl: string): Promise<Reply> {
  const target = parseTarget(rawUrl);
  if (target === null) {
    return { status: 400, body: { error: "bad request" } };
  }
  const [root, section, ...rest] = target.segments;
  if (root !== "") return notFound();
  if (section === "healthz" && rest.length === 0) {
    return { status: 200, body: { ok: true } };
  }
  if (section === "v1") return routeV1(deps, rest, target.query);
  return notFound();
}

async function routeV1(
  deps: ApiDeps,
  segments: string[],
  query: URLSearchParams,
): Promise<Reply> {
  const [resource, ...rest] = segments;
  if (resource === "releases") return releasesByVersion(deps.releases, rest);
  if (resource === "artifacts") return artifactsByDigest(deps.releases, rest);
  if (resource === "jobs") return jobsSummary(deps.queue, rest);
  if (resource === "findings") {
    return findingsRoute(deps.findings, rest, query);
  }
  if (resource === "feed") return feedRoute(deps.findings, rest, query);
  if (resource === "osv") return osvRoute(deps.findings, rest);
  return notFound();
}

async function releasesByVersion(
  store: ReleaseStore,
  segments: string[],
): Promise<Reply> {
  const [ecosystem, name, version] = segments;
  if (
    segments.length !== 3 ||
    ecosystem !== "npm" ||
    name === undefined ||
    version === undefined
  ) {
    return notFound();
  }
  if (!isBoundedIdentity(name) || !isBoundedIdentity(version)) {
    return { status: 400, body: { error: "bad request" } };
  }
  return releaseList(await store.findByVersion(name, version));
}

async function artifactsByDigest(
  store: ReleaseStore,
  segments: string[],
): Promise<Reply> {
  const [digest] = segments;
  if (segments.length !== 1 || digest === undefined) return notFound();
  return releaseList(await store.findByDigest(digest));
}

interface FailedJob {
  id: string;
  name: string;
  version: string;
  attempts: number;
  lastError: string | null;
}

async function jobsSummary(
  queue: JobQueue,
  segments: string[],
): Promise<Reply> {
  if (segments.length !== 0) return notFound();
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  const failed: FailedJob[] = [];
  for (const job of await queue.list()) {
    counts[job.state] += 1;
    if (job.state !== "failed" || failed.length >= MAX_FAILED_JOBS) continue;
    failed.push({
      id: truncate(job.id, MAX_IDENTITY_CHARS),
      name: truncate(job.candidate.name, MAX_IDENTITY_CHARS),
      version: truncate(job.candidate.version, MAX_IDENTITY_CHARS),
      attempts: job.attempts,
      lastError:
        job.lastError === null
          ? null
          : truncate(job.lastError, MAX_VALUE_CHARS),
    });
  }
  return { status: 200, body: { counts, failed } };
}

async function findingsRoute(
  store: FindingStore,
  segments: string[],
  query: URLSearchParams,
): Promise<Reply> {
  if (segments.length === 0) return findingsQuery(store, query);
  const [id] = segments;
  if (segments.length !== 1 || id === undefined) return notFound();
  if (!FINDING_ID_PATTERN.test(id)) return badRequest();
  const finding = await store.get(id);
  if (finding === null) return notFound();
  return { status: 200, body: finding };
}

async function findingsQuery(
  store: FindingStore,
  query: URLSearchParams,
): Promise<Reply> {
  if (query.get("ecosystem") !== "npm") return badRequest();
  const name = selector(query.get("name"));
  const digest = selector(query.get("digest"));
  const version = selector(query.get("version"));
  if (name === false || digest === false || version === false) {
    return badRequest();
  }

  if (name !== null) {
    if (digest !== null) return badRequest();
    const matches = await store.findByPackage(name, version ?? undefined);
    return {
      status: 200,
      body: { findings: matches.slice(0, MAX_QUERY_FINDINGS) },
    };
  }
  if (digest !== null) {
    if (version !== null) return badRequest();
    const matches = await store.findByDigest(digest);
    return {
      status: 200,
      body: { findings: matches.slice(0, MAX_QUERY_FINDINGS) },
    };
  }
  return badRequest();
}

async function feedRoute(
  store: FindingStore,
  segments: string[],
  query: URLSearchParams,
): Promise<Reply> {
  if (segments.length !== 0) return notFound();
  const since = count(query.get("since"), 0);
  const limit = count(query.get("limit"), DEFAULT_FEED_LIMIT);
  if (since === null || limit === null || limit > MAX_FEED_LIMIT) {
    return badRequest();
  }
  // An empty page tells the caller to retry later without moving the cursor.
  if (limit === 0) {
    return { status: 200, body: { entries: [], lastSequence: since } };
  }
  return { status: 200, body: await store.feedSince(since, limit) };
}

async function osvRoute(
  store: FindingStore,
  segments: string[],
): Promise<Reply> {
  const [id] = segments;
  if (segments.length !== 1 || id === undefined) return notFound();
  if (!FINDING_ID_PATTERN.test(id)) return badRequest();
  const finding = await store.get(id);
  if (finding === null) return notFound();
  if (
    finding.verdict !== "confirmed-malicious" &&
    finding.verdict !== "retracted"
  ) {
    return notFound();
  }
  return { status: 200, body: toOsv(finding) };
}

interface TransitionBody {
  to: Verdict;
  reason: string;
  validation?: { method: string; evidenceRefs: number[] };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reply: Reply };

async function transitionRoute(
  deps: ApiDeps,
  reviewers: Reviewers,
  id: string,
  request: IncomingMessage,
): Promise<Reply> {
  if (!FINDING_ID_PATTERN.test(id)) return badRequest();
  const reviewer = authenticate(reviewers, request.headers.authorization);
  if (reviewer === null) {
    request.resume();
    return {
      status: 401,
      body: { error: "unauthorized" },
      headers: { "www-authenticate": "Bearer" },
    };
  }

  const read = await readTransitionBody(request);
  if (!read.ok) return read.reply;
  const parsed = parseTransitionBody(read.value);
  if (!parsed.ok) return parsed.reply;

  // A missing record is a 404; the store reports it as a generic error.
  if ((await deps.findings.get(id)) === null) return notFound();

  const transition: TransitionRequest = {
    to: parsed.value.to,
    actor: reviewer,
    reason: parsed.value.reason,
  };
  if (parsed.value.validation !== undefined) {
    transition.validation = {
      reviewer,
      method: parsed.value.validation.method,
      evidenceRefs: parsed.value.validation.evidenceRefs,
    };
  }

  try {
    const finding = await deps.findings.transition(id, transition, new Date());
    return { status: 200, body: { finding } };
  } catch (error) {
    if (error instanceof IntelModelError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

function authenticate(
  reviewers: Reviewers,
  header: string | undefined,
): string | null {
  if (header === undefined) return null;
  const token = BEARER_PATTERN.exec(header)?.[1];
  if (token === undefined) return null;
  return reviewers.authenticate(token);
}

function parseTransitionBody(value: unknown): Parsed<TransitionBody> {
  if (!isPlainObject(value)) return { ok: false, reply: badRequest() };
  const unknown = firstUnknownField(value, ["to", "reason", "validation"]);
  if (unknown !== null) return { ok: false, reply: unknownField(unknown) };

  const to = verdict(value.to);
  if (to === null) return { ok: false, reply: invalidField("to") };
  const reason = value.reason;
  if (typeof reason !== "string")
    return { ok: false, reply: invalidField("reason") };

  let validation: TransitionBody["validation"];
  if (value.validation !== undefined) {
    const parsed = parseValidation(value.validation);
    if (!parsed.ok) return parsed;
    validation = parsed.value;
  }

  const body: TransitionBody = { to, reason };
  if (validation !== undefined) body.validation = validation;
  return { ok: true, value: body };
}

function parseValidation(
  value: unknown,
): Parsed<{ method: string; evidenceRefs: number[] }> {
  if (!isPlainObject(value)) {
    return { ok: false, reply: invalidField("validation") };
  }
  const unknown = firstUnknownField(value, ["method", "evidenceRefs"]);
  if (unknown !== null) {
    return { ok: false, reply: unknownField(`validation.${unknown}`) };
  }
  const method = value.method;
  if (typeof method !== "string") {
    return { ok: false, reply: invalidField("validation.method") };
  }
  const refs: unknown = value.evidenceRefs;
  if (!Array.isArray(refs) || !refs.every(isInteger)) {
    return { ok: false, reply: invalidField("validation.evidenceRefs") };
  }
  return { ok: true, value: { method, evidenceRefs: refs } };
}

function readTransitionBody(request: IncomingMessage): Promise<BodyRead> {
  if (!isJsonContentType(request.headers["content-type"])) {
    request.resume();
    return Promise.resolve({ ok: false, reply: badRequest() });
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_TRANSITION_BODY_BYTES) {
    request.resume();
    return Promise.resolve({ ok: false, reply: tooLarge() });
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= MAX_TRANSITION_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      // Discard the rest instead of buffering a body we will not read.
      request.resume();
      resolve({ ok: false, reply: tooLarge() });
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          resolve({ ok: false, reply: badRequest() });
          return;
        }
        reject(
          new ApiError("the request body JSON could not be parsed", {
            cause: error,
          }),
        );
        return;
      }
      resolve({ ok: true, value });
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ApiError("the request body could not be read", { cause: error }),
      );
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

type BodyRead = { ok: true; value: unknown } | { ok: false; reply: Reply };

function transitionsId(segments: readonly string[]): string | null {
  if (
    segments.length !== 5 ||
    segments[0] !== "" ||
    segments[1] !== "v1" ||
    segments[2] !== "findings" ||
    segments[4] !== "transitions"
  ) {
    return null;
  }
  return segments[3] ?? null;
}

function verdict(value: unknown): Verdict | null {
  if (typeof value !== "string") return null;
  return VERDICTS.find((allowed) => allowed === value) ?? null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function firstUnknownField(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const [type] = value.split(";");
  return type?.trim().toLowerCase() === "application/json";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** null for an absent selector, false for one that cannot be a package or digest. */
function selector(value: string | null): string | null | false {
  if (value === null) return null;
  if (value.length === 0 || !isBoundedIdentity(value)) return false;
  return value;
}

/** The fallback for an absent count, or null for anything but a non-negative integer. */
function count(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function badRequest(detail?: string): Reply {
  return { status: 400, body: { error: detail ?? "bad request" } };
}

function unknownField(name: string): Reply {
  return badRequest(`unknown field ${quoteField(name)}`);
}

function invalidField(name: string): Reply {
  return badRequest(`invalid field ${quoteField(name)}`);
}

function tooLarge(): Reply {
  return { status: 413, body: { error: "payload too large" } };
}

function quoteField(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}

function releaseList(records: ReleaseRecord[]): Reply {
  if (records.length === 0) return notFound();
  return { status: 200, body: { releases: records } };
}

function isBoundedIdentity(value: string): boolean {
  return (
    Array.from(value).length <= MAX_NAME_OR_VERSION_CHARS &&
    !CONTROL_CHARACTER.test(value)
  );
}

interface ParsedTarget {
  segments: string[];
  query: URLSearchParams;
}

/** Splits the request target, then decodes each segment so `%2F` stays inside one. */
function parseTarget(rawUrl: string): ParsedTarget | null {
  const queryAt = rawUrl.indexOf("?");
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const queryText = queryAt === -1 ? "" : rawUrl.slice(queryAt + 1);
  const decoded: string[] = [];
  for (const segment of path.split("/")) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  return { segments: decoded, query: new URLSearchParams(queryText) };
}

function notFound(): Reply {
  return { status: 404, body: { error: "not found" } };
}

function write(
  request: IncomingMessage,
  response: ServerResponse,
  reply: Reply,
): void {
  const body = JSON.stringify(reply.body);
  response.writeHead(reply.status, {
    "content-type": JSON_TYPE,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8"),
    ...reply.headers,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function logError(error: unknown): void {
  console.error("capdelta api: request failed", error);
}
