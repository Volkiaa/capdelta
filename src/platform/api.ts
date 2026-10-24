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
import type { JobQueue } from "./job-queue.js";
import type { ReleaseRecord, ReleaseStore } from "./release-store.js";

export interface ApiDeps {
  releases: ReleaseStore;
  queue: JobQueue;
  onError?: (error: unknown) => void;
}

export class ApiError extends NamedError {}

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_URL_CHARS = 2048;
const MAX_NAME_OR_VERSION_CHARS = 214;
const MAX_FAILED_JOBS = 100;
const MAX_HEADERS_COUNT = 50;
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Drain the body so a keep-alive connection does not stall on it.
    request.resume();
    write(request, response, {
      status: 405,
      body: { error: "method not allowed" },
      headers: { allow: "GET, HEAD" },
    });
    return;
  }

  try {
    const reply = await route(deps, request.url ?? "");
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

async function route(deps: ApiDeps, rawUrl: string): Promise<Reply> {
  if (rawUrl.length > MAX_URL_CHARS) {
    return { status: 414, body: { error: "url too long" } };
  }
  const segments = decodePath(rawUrl);
  if (segments === null) {
    return { status: 400, body: { error: "bad request" } };
  }
  const [root, section, ...rest] = segments;
  if (root !== "") return notFound();
  if (section === "healthz" && rest.length === 0) {
    return { status: 200, body: { ok: true } };
  }
  if (section === "v1") return routeV1(deps, rest);
  return notFound();
}

async function routeV1(deps: ApiDeps, segments: string[]): Promise<Reply> {
  const [resource, ...rest] = segments;
  if (resource === "releases") return releasesByVersion(deps.releases, rest);
  if (resource === "artifacts") return artifactsByDigest(deps.releases, rest);
  if (resource === "jobs") return jobsSummary(deps.queue, rest);
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

/** Splits the request target, then decodes each segment so `%2F` stays inside one. */
function decodePath(rawUrl: string): string[] | null {
  const queryAt = rawUrl.indexOf("?");
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const decoded: string[] = [];
  for (const segment of path.split("/")) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  return decoded;
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
