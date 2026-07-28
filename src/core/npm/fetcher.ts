import { createHash, timingSafeEqual } from "node:crypto";
import { analysisStopDetail } from "../analysis-execution-policy.js";
import type { ChangedPackage } from "../contract/lockfile-diff.js";

/** Verified, inert tarball bytes. Safe extraction is a separate M1 component. */
export interface VerifiedTarball {
  /** The canonical sha512 SRI token that matched these bytes. */
  integrity: string;
  bytes: Uint8Array;
}

export type TarballSide = "old" | "new";

export type FetchFailureKind =
  | "invalid-url"
  | "unsupported-integrity"
  | "http-status"
  | "timeout"
  | "aborted"
  | "network-error"
  | "size-limit-exceeded"
  | "invalid-response"
  | "integrity-mismatch";

/** A package-local failure. The caller reports it; Fetcher never hides it. */
export interface FetchFailure {
  side: TarballSide;
  kind: FetchFailureKind;
  detail: string;
  /** Attacker-controlled until Reporter escapes it (PLAN §3). */
  url: string;
}

export type FetchPackageResult =
  | {
      status: "verified";
      changedPackage: ChangedPackage;
      oldTarball: VerifiedTarball | null;
      newTarball: VerifiedTarball;
    }
  | {
      status: "unavailable";
      changedPackage: ChangedPackage;
      failure: FetchFailure;
    };

/**
 * Memory-only cache used within one invocation. It is keyed by a verified SRI
 * token, so a future Action-cache adapter can use the same key without making
 * Fetcher reconstruct package URLs (PLAN §4.2; ADR-006).
 */
export class MemoryTarballCache {
  readonly #entries = new Map<string, Uint8Array>();

  get(integrity: string): Uint8Array | undefined {
    return this.#entries.get(integrity)?.slice();
  }

  set(integrity: string, bytes: Uint8Array): void {
    this.#entries.set(integrity, bytes.slice());
  }

  delete(integrity: string): void {
    this.#entries.delete(integrity);
  }
}

export interface FetcherOptions {
  /** Node 20 global fetch by default; injectable only to keep network tests inert. */
  fetchImpl?: typeof fetch;
  /** PLAN §4.2 default: 50 MiB. Enforced while streaming, not after buffering. */
  maxTarballBytes?: number;
  /** Per-request timeout. Proposed default: 30 seconds. */
  timeoutMs?: number;
  /** PLAN §2 default: at most eight concurrent downloads. */
  concurrency?: number;
  /** Whole-analysis cooperative cancellation propagated by the pipeline. */
  signal?: AbortSignal;
  cache?: MemoryTarballCache;
}

export class FetcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid caller configuration: continuing would make the security limits meaningless. */
export class FetcherConfigurationError extends FetcherError {}

/** A caller violated the ChangedPackage invariant established by ADR-006. */
export class FetcherContractError extends FetcherError {}

interface ResolvedOptions {
  fetchImpl: typeof fetch;
  maxTarballBytes: number;
  timeoutMs: number;
  concurrency: number;
  signal?: AbortSignal;
  cache: MemoryTarballCache;
}

interface ArtifactSuccess {
  ok: true;
  tarball: VerifiedTarball;
}

interface ArtifactFailure {
  ok: false;
  kind: FetchFailureKind;
  detail: string;
  url: string;
}

type ArtifactResult = ArtifactSuccess | ArtifactFailure;

const DEFAULT_MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;
const SHA512_BYTES = 64;
const SRI_TOKEN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const TIMEOUT_ABORT = Symbol("capdelta fetch timeout");
const SIZE_LIMIT_ABORT = Symbol("capdelta tarball size limit");
const PARENT_ABORT = Symbol("capdelta parent analysis abort");

/**
 * Downloads and verifies every changed package. A failure aborts only that
 * package's analysis; other packages continue so degradation is visible rather
 * than silent (PLAN §2, §4.2).
 */
export async function fetchChangedPackages(
  packages: readonly ChangedPackage[],
  options: FetcherOptions = {},
): Promise<FetchPackageResult[]> {
  const resolved = resolveOptions(options);
  for (const changedPackage of packages) {
    assertChangedPackageInvariant(changedPackage);
  }

  const results = new Array<FetchPackageResult>(packages.length);
  let nextIndex = 0;
  const workerCount = Math.min(resolved.concurrency, packages.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const changedPackage = packages[index];
        if (changedPackage === undefined) return;
        results[index] =
          resolved.signal?.aborted === true
            ? abortedPackage(changedPackage, resolved.signal)
            : await fetchPackage(changedPackage, resolved);
      }
    }),
  );

  return results;
}

function abortedPackage(
  changedPackage: ChangedPackage,
  signal: AbortSignal,
): FetchPackageResult {
  const oldSide = changedPackage.oldResolvedUrl !== null;
  return {
    status: "unavailable",
    changedPackage,
    failure: {
      side: oldSide ? "old" : "new",
      kind: "aborted",
      detail: analysisStopDetail(signal),
      url: oldSide
        ? (changedPackage.oldResolvedUrl ?? changedPackage.resolvedUrl)
        : changedPackage.resolvedUrl,
    },
  };
}

async function fetchPackage(
  changedPackage: ChangedPackage,
  options: ResolvedOptions,
): Promise<FetchPackageResult> {
  let oldTarball: VerifiedTarball | null = null;
  if (changedPackage.oldResolvedUrl !== null) {
    const old = await fetchArtifact(
      changedPackage.oldResolvedUrl,
      changedPackage.oldIntegrity,
      options,
    );
    if (!old.ok) return unavailable(changedPackage, "old", old);
    oldTarball = old.tarball;
  }

  const newest = await fetchArtifact(
    changedPackage.resolvedUrl,
    changedPackage.newIntegrity,
    options,
  );
  if (!newest.ok) return unavailable(changedPackage, "new", newest);

  return {
    status: "verified",
    changedPackage,
    oldTarball,
    newTarball: newest.tarball,
  };
}

function unavailable(
  changedPackage: ChangedPackage,
  side: TarballSide,
  failure: ArtifactFailure,
): FetchPackageResult {
  return {
    status: "unavailable",
    changedPackage,
    failure: {
      side,
      kind: failure.kind,
      detail: failure.detail,
      url: failure.url,
    },
  };
}

async function fetchArtifact(
  url: string,
  integrity: string | null,
  options: ResolvedOptions,
): Promise<ArtifactResult> {
  const parentSignal = options.signal;
  if (parentSignal?.aborted === true) {
    return {
      ok: false,
      kind: "aborted",
      detail: analysisStopDetail(parentSignal),
      url,
    };
  }
  if (!isHttpsUrl(url)) {
    return {
      ok: false,
      kind: "invalid-url",
      detail: "tarball URL must be HTTPS",
      url,
    };
  }
  if (integrity === null) {
    return {
      ok: false,
      kind: "unsupported-integrity",
      detail: "tarball has no sha512 integrity",
      url,
    };
  }
  const expected = parseSha512Integrity(integrity);
  if (expected.length === 0) {
    return {
      ok: false,
      kind: "unsupported-integrity",
      detail: "integrity must contain canonical sha512 SRI token(s)",
      url,
    };
  }

  for (const token of expected) {
    const cached = options.cache.get(token);
    if (cached === undefined) continue;
    if (matchesAnyIntegrity(cached, expected)) {
      return {
        ok: true,
        tarball: {
          integrity: matchingIntegrity(cached, expected),
          bytes: cached,
        },
      };
    }
    // A cache is an optimization, never a trust boundary. Discard corrupt
    // bytes and retrieve a fresh, still-verified copy rather than parsing them.
    options.cache.delete(token);
  }

  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (!controller.signal.aborted) controller.abort(PARENT_ABORT);
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (isAborted(parentSignal)) abortFromParent();
  const timeout = setTimeout(() => {
    controller.abort(TIMEOUT_ABORT);
  }, options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        kind: "http-status",
        detail: `tarball request returned HTTP ${String(response.status)}`,
        url,
      };
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      isLengthOverLimit(declaredLength, options.maxTarballBytes)
    ) {
      return {
        ok: false,
        kind: "size-limit-exceeded",
        detail: `declared tarball size exceeds ${String(options.maxTarballBytes)} bytes`,
        url,
      };
    }
    if (response.body === null) {
      return {
        ok: false,
        kind: "invalid-response",
        detail: "response has no body",
        url,
      };
    }
    const bytes = await readCappedBody(
      response.body,
      options.maxTarballBytes,
      controller,
    );
    if (bytes === null) {
      return {
        ok: false,
        kind: "size-limit-exceeded",
        detail: `tarball exceeds ${String(options.maxTarballBytes)} bytes while streaming`,
        url,
      };
    }
    if (!matchesAnyIntegrity(bytes, expected)) {
      return {
        ok: false,
        kind: "integrity-mismatch",
        detail: "downloaded bytes do not match lockfile sha512 integrity",
        url,
      };
    }
    const matched = matchingIntegrity(bytes, expected);
    options.cache.set(matched, bytes);
    return { ok: true, tarball: { integrity: matched, bytes } };
  } catch (error: unknown) {
    if (controller.signal.reason === TIMEOUT_ABORT) {
      return {
        ok: false,
        kind: "timeout",
        detail: "tarball request timed out",
        url,
      };
    }
    if (controller.signal.reason === SIZE_LIMIT_ABORT) {
      return {
        ok: false,
        kind: "size-limit-exceeded",
        detail: `tarball exceeds ${String(options.maxTarballBytes)} bytes while streaming`,
        url,
      };
    }
    if (controller.signal.reason === PARENT_ABORT) {
      return {
        ok: false,
        kind: "aborted",
        detail:
          parentSignal === undefined
            ? "analysis aborted"
            : analysisStopDetail(parentSignal),
        url,
      };
    }
    // Recovery is structured failure, not a swallowed error: this package is
    // excluded from extraction and the caller receives the reason to report.
    return {
      ok: false,
      kind: "network-error",
      detail:
        error instanceof Error
          ? `tarball request failed: ${error.name}`
          : "tarball request failed",
      url,
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  maxTarballBytes: number,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxTarballBytes) {
      controller.abort(SIZE_LIMIT_ABORT);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function resolveOptions(options: FetcherOptions): ResolvedOptions {
  const maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  for (const [name, value] of [
    ["maxTarballBytes", maxTarballBytes],
    ["timeoutMs", timeoutMs],
    ["concurrency", concurrency],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FetcherConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new FetcherConfigurationError("signal must implement AbortSignal");
  }
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    maxTarballBytes,
    timeoutMs,
    concurrency,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    cache: options.cache ?? new MemoryTarballCache(),
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

function assertChangedPackageInvariant(changedPackage: ChangedPackage): void {
  const oldPresent = changedPackage.oldVersion !== null;
  const oldFieldsPresent =
    changedPackage.oldIntegrity !== null &&
    changedPackage.oldResolvedUrl !== null;
  if (oldPresent !== oldFieldsPresent) {
    throw new FetcherContractError(
      `ChangedPackage ${JSON.stringify(changedPackage.name)} violates ADR-006 old-side invariant`,
    );
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseSha512Integrity(integrity: string): string[] {
  const tokens = integrity.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") return [];
  const canonical: string[] = [];
  for (const token of tokens) {
    const match = SRI_TOKEN.exec(token);
    if (match?.[1] === undefined) return [];
    const decoded = Buffer.from(match[1], "base64");
    if (
      decoded.byteLength !== SHA512_BYTES ||
      decoded.toString("base64") !== match[1]
    ) {
      return [];
    }
    canonical.push(token);
  }
  return canonical;
}

function matchesAnyIntegrity(
  bytes: Uint8Array,
  expected: readonly string[],
): boolean {
  return expected.some((token) => matchesIntegrity(bytes, token));
}

function matchingIntegrity(
  bytes: Uint8Array,
  expected: readonly string[],
): string {
  const token = expected.find((candidate) =>
    matchesIntegrity(bytes, candidate),
  );
  if (token === undefined) {
    throw new FetcherError("matchingIntegrity called without a matching token");
  }
  return token;
}

function matchesIntegrity(bytes: Uint8Array, token: string): boolean {
  const match = SRI_TOKEN.exec(token);
  if (match?.[1] === undefined) return false;
  const expectedDigest = Buffer.from(match[1], "base64");
  const actualDigest = createHash("sha512").update(bytes).digest();
  return (
    expectedDigest.byteLength === actualDigest.byteLength &&
    timingSafeEqual(expectedDigest, actualDigest)
  );
}

function isLengthOverLimit(value: string, maxTarballBytes: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const size = Number(value);
  return Number.isSafeInteger(size) && size > maxTarballBytes;
}
