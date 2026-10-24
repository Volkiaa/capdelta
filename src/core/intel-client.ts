import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { isRecord } from "./guards.js";
import type { IntelFindingView } from "./intel-match.js";
import { NamedError } from "./named-error.js";
import { MAX_VALUE_CHARS, truncate } from "./report-builder.js";
import { forEachInOrder } from "./worker-pool.js";

export interface IntelClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Whole-lookup deadline, including queued requests. */
  totalTimeoutMs?: number;
  /** Cap applied while streaming the response body. */
  maxResponseBytes?: number;
  concurrency?: number;
  maxPackages?: number;
}

export interface IntelLookup {
  findings: IntelFindingView[];
  warnings: string[];
}

export class IntelClientConfigurationError extends NamedError {}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_PACKAGES = 500;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_TIMEOUT_ABORT = Symbol("capdelta intel request timeout");
const TOTAL_TIMEOUT_ABORT = Symbol("capdelta intel total timeout");

type FailureKind =
  | "network-error"
  | "timeout"
  | "http-status"
  | "oversize-body"
  | "invalid-json"
  | "invalid-shape";

interface LookupOutcome {
  findings: IntelFindingView[];
  failure?: FailureKind;
  invalidEntries: number;
}

interface ResolvedClientOptions {
  baseUrl: URL;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
  concurrency: number;
  maxPackages: number;
}

/**
 * ADR-039 item 8: the feed URL is operator configuration, so a typo must be
 * loud. Plain http is allowed only on loopback, where the optional local
 * service runs.
 */
export function validateIntelUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new IntelClientConfigurationError(
      "intel URL is not a valid absolute URL",
      { cause: error },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new IntelClientConfigurationError(
      "intel URL must not contain credentials",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new IntelClientConfigurationError(
      "intel URL must use https, or http only on localhost, 127.0.0.1 or [::1]",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new IntelClientConfigurationError(
      "intel URL must not contain a query or fragment",
    );
  }
  return url;
}

/**
 * ADR-039 item 8: a service problem never fails the run and never weakens
 * local analysis. Every failure becomes one bounded warning, and the caller
 * keeps the findings it did receive.
 */
export async function lookupIntel(
  changed: readonly ChangedPackage[],
  options: IntelClientOptions,
): Promise<IntelLookup> {
  const resolved = resolveOptions(options);
  const digests = distinctDigests(changed);
  if (digests.length === 0) return { findings: [], warnings: [] };

  const warnings: string[] = [];
  const checked = digests.slice(0, resolved.maxPackages);
  const skipped = digests.length - checked.length;
  if (skipped > 0) {
    warnings.push(
      truncate(
        `intelligence service skipped ${String(skipped)} of ${String(digests.length)} package digests beyond the ${String(resolved.maxPackages)} limit; continuing with local analysis only`,
        MAX_VALUE_CHARS,
      ),
    );
  }

  const outcomes = new Array<LookupOutcome | undefined>(checked.length);
  const total = new AbortController();
  const totalTimer = setTimeout(() => {
    total.abort(TOTAL_TIMEOUT_ABORT);
  }, resolved.totalTimeoutMs);
  try {
    await forEachInOrder(
      checked.map((_digest, index) => index),
      resolved.concurrency,
      async (index) => {
        const digest = checked[index];
        if (digest === undefined) return;
        outcomes[index] = await lookupDigest(digest, resolved, total.signal);
      },
    );
  } finally {
    clearTimeout(totalTimer);
  }

  const findings: IntelFindingView[] = [];
  const failures = new Map<FailureKind, number>();
  let invalidEntries = 0;
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    findings.push(...outcome.findings);
    invalidEntries += outcome.invalidEntries;
    if (outcome.failure !== undefined) {
      failures.set(outcome.failure, (failures.get(outcome.failure) ?? 0) + 1);
    }
  }
  for (const kind of failures.keys()) {
    warnings.push(
      truncate(
        `intelligence service unavailable (${kind}); continuing with local analysis only`,
        MAX_VALUE_CHARS,
      ),
    );
  }
  if (invalidEntries > 0) {
    warnings.push(
      truncate(
        `intelligence service returned ${String(invalidEntries)} invalid ${invalidEntries === 1 ? "finding" : "findings"}; continuing with local analysis only`,
        MAX_VALUE_CHARS,
      ),
    );
  }
  return { findings, warnings };
}

function distinctDigests(changed: readonly ChangedPackage[]): string[] {
  const seen = new Set<string>();
  const digests: string[] = [];
  for (const changedPackage of changed) {
    if (seen.has(changedPackage.newIntegrity)) continue;
    seen.add(changedPackage.newIntegrity);
    digests.push(changedPackage.newIntegrity);
  }
  return digests;
}

async function lookupDigest(
  digest: string,
  options: ResolvedClientOptions,
  totalSignal: AbortSignal,
): Promise<LookupOutcome> {
  if (totalSignal.aborted) return failed("timeout");

  const request = new AbortController();
  const abortFromTotal = (): void => {
    if (!request.signal.aborted) request.abort(TOTAL_TIMEOUT_ABORT);
  };
  totalSignal.addEventListener("abort", abortFromTotal, { once: true });
  const requestTimer = setTimeout(() => {
    request.abort(REQUEST_TIMEOUT_ABORT);
  }, options.requestTimeoutMs);

  try {
    const response = await options.fetchImpl(
      findingsUrl(options.baseUrl, digest),
      {
        redirect: "error",
        signal: request.signal,
      },
    );
    if (!response.ok) {
      // The body of a rejected response cannot change the outcome; cancelling
      // it keeps a pooled connection from lingering.
      void response.body?.cancel().catch(() => undefined);
      return failed("http-status");
    }
    const body = await readCappedBody(
      response,
      options.maxResponseBytes,
      request,
    );
    if (body.status === "invalid") return failed("invalid-shape");
    if (body.status === "oversize") return failed("oversize-body");

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return failed("invalid-json");
    }
    return parseFindings(parsed);
  } catch {
    if (
      request.signal.reason === REQUEST_TIMEOUT_ABORT ||
      isAborted(totalSignal)
    ) {
      return failed("timeout");
    }
    // Recovery is structured: the caller warns once per cause and keeps the
    // findings from every request that succeeded.
    return failed("network-error");
  } finally {
    clearTimeout(requestTimer);
    totalSignal.removeEventListener("abort", abortFromTotal);
  }
}

function findingsUrl(base: URL, digest: string): URL {
  const root = base.href.endsWith("/") ? base.href.slice(0, -1) : base.href;
  const url = new URL(`${root}/v1/findings`);
  url.searchParams.set("ecosystem", "npm");
  url.searchParams.set("digest", digest);
  return url;
}

function failed(failure: FailureKind): LookupOutcome {
  return { findings: [], failure, invalidEntries: 0 };
}

function parseFindings(value: unknown): LookupOutcome {
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    return failed("invalid-shape");
  }
  const findings: IntelFindingView[] = [];
  let invalidEntries = 0;
  for (const entry of value.findings) {
    if (!isIntelFindingView(entry)) {
      invalidEntries += 1;
      continue;
    }
    findings.push(entry);
  }
  return { findings, invalidEntries };
}

function isIntelFindingView(value: unknown): value is IntelFindingView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.ecosystem === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.digest === "string" &&
    typeof value.verdict === "string"
  );
}

type CappedBody =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "oversize" }
  | { status: "invalid" };

async function readCappedBody(
  response: Response,
  maxBytes: number,
  request: AbortController,
): Promise<CappedBody> {
  const declared = response.headers.get("content-length");
  if (declared !== null && isOverLimit(declared, maxBytes)) {
    request.abort(REQUEST_TIMEOUT_ABORT);
    return { status: "oversize" };
  }
  if (response.body === null) return { status: "invalid" };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  // Node's global Response body is typed as an unparameterized ReadableStream.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      request.abort(REQUEST_TIMEOUT_ABORT);
      return { status: "oversize" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", bytes };
}

function isOverLimit(value: string, maxBytes: number): boolean {
  if (!/^\d+$/u.test(value)) return false;
  const size = Number(value);
  return Number.isSafeInteger(size) && size > maxBytes;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function resolveOptions(options: IntelClientOptions): ResolvedClientOptions {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPackages = options.maxPackages ?? DEFAULT_MAX_PACKAGES;
  for (const [name, value] of [
    ["requestTimeoutMs", requestTimeoutMs],
    ["totalTimeoutMs", totalTimeoutMs],
    ["maxResponseBytes", maxResponseBytes],
    ["concurrency", concurrency],
    ["maxPackages", maxPackages],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new IntelClientConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  return {
    baseUrl: validateIntelUrl(options.baseUrl),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    requestTimeoutMs,
    totalTimeoutMs,
    maxResponseBytes,
    concurrency,
    maxPackages,
  };
}
