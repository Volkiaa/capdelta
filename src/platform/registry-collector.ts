import type { ReadableStreamReadResult } from "node:stream/web";
import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import {
  MAX_CHILDREN_PER_RELEASE,
  resolveVersion,
  selectNewDependencies,
  specifierKind,
  unsupportedSpecifierReason,
  type DeclaredDependency,
} from "./dependency-children.js";
import type {
  ReleaseArtifact,
  ReleaseCandidate,
  UnresolvedReleaseChild,
} from "./release-candidate.js";

/** A registry read failed in a way the caller must see: the cursor stays put. */
const MAX_SKIPPED_PER_PACKAGE = 100;
const MAX_CANDIDATES_PER_PACKAGE = 3;

export class CollectorError extends NamedError {}

export interface CollectorOptions {
  /** Default `https://registry.npmjs.org`. Only https, or http to a loopback host. */
  registryUrl?: string;
  /** Default `https://replicate.npmjs.com/_changes`. */
  changesUrl?: string;
  /** Injected only so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, default 30 seconds. */
  timeoutMs?: number;
  /** Streaming cap for one packument, default 20 MiB. */
  maxPackumentBytes?: number;
  /** `_changes` page size, default 100. */
  limit?: number;
}

export interface CollectorSkipped {
  name: string;
  reason: string;
}

export interface CandidatesResult {
  candidates: ReleaseCandidate[];
  /** Loud accounting for versions or packages the collector could not use. */
  skipped: CollectorSkipped[];
}

export interface CollectResult extends CandidatesResult {
  /** The cursor to persist after the candidates are queued. */
  nextSince: string;
}

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_CHANGES_URL = "https://replicate.npmjs.com/_changes";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PACKUMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_PACKAGE_NAME_CHARS = 214;
const MAX_VERSION_CHARS = 128;
const MAX_URL_CHARS = 2048;
/** A rejected name has no identity; the truncated text belongs in the reason. */
const INVALID_NAME_IDENTITY = "<invalid-name>";
/** A dependency name the queue would refuse gets a bounded placeholder; the reason keeps the original. */
const INVALID_DEPENDENCY_NAME = "invalid-dependency-name";
/** npm accepts semver only; a packument key is never a path or a free-form label. */
const STRICT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u;
/** A `_changes` page holds ids only; 1 MiB fits any allowed page size. */
const MAX_CHANGE_FEED_BYTES = 1024 * 1024;

interface ResolvedOptions {
  registryUrl: string;
  registryOrigin: string;
  changesUrl: URL;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxPackumentBytes: number;
  limit: number;
}

interface VersionEntry {
  version: string;
  digest: string;
  tarballUrl: string;
  publishedAt: string;
  publishedMs: number;
}

export async function collectReleases(
  since: string,
  options: CollectorOptions,
): Promise<CollectResult> {
  const resolved = resolveOptions(options);
  const feedUrl = new URL(resolved.changesUrl);
  feedUrl.searchParams.set("since", since);
  feedUrl.searchParams.set("limit", String(resolved.limit));
  const feed = changeFeed(
    await fetchJson(
      feedUrl.href,
      resolved,
      "change feed",
      MAX_CHANGE_FEED_BYTES,
    ),
  );

  const candidates: ReleaseCandidate[] = [];
  const skipped: CollectorSkipped[] = [];
  for (const name of feed.ids) {
    const result = await candidatesForPackage(name, options);
    // Loops, not spread: a packument with 100k versions would overflow the call stack.
    for (const candidate of result.candidates) candidates.push(candidate);
    for (const entry of result.skipped) skipped.push(entry);
  }
  return {
    candidates,
    nextSince: String(feed.lastSeq),
    skipped,
  };
}

export async function candidatesForPackage(
  name: string,
  options: CollectorOptions,
  onlyVersions?: ReadonlySet<string>,
): Promise<CandidatesResult> {
  const resolved = resolveOptions(options);
  const problem = nameProblem(name);
  if (problem !== null) {
    return {
      candidates: [],
      skipped: [
        {
          name: INVALID_NAME_IDENTITY,
          reason: truncate(
            `${problem}: ${JSON.stringify(truncate(name, MAX_IDENTITY_CHARS))}`,
            MAX_VALUE_CHARS,
          ),
        },
      ],
    };
  }
  const url = `${resolved.registryUrl}/${encodePackageName(name)}`;
  let packument: unknown;
  try {
    packument = await fetchJson(
      url,
      resolved,
      `packument for ${truncate(name, MAX_IDENTITY_CHARS)}`,
      resolved.maxPackumentBytes,
    );
  } catch (error: unknown) {
    // Recovery is loud: this package is reported instead of silently dropped.
    if (error instanceof CollectorError) {
      return {
        candidates: [],
        skipped: [
          {
            name,
            reason: truncate(error.message, MAX_VALUE_CHARS),
          },
        ],
      };
    }
    throw error;
  }
  const result = readPackument(name, packument, resolved, onlyVersions);
  await attachChildren(result.candidates, packument, resolved);
  return result;
}

/**
 * ADR-045: expand only names the new version newly declares, depth 1. Every
 * unresolved or over-cap child is recorded so the release record turns
 * incomplete instead of silently missing it.
 */
async function attachChildren(
  candidates: readonly ReleaseCandidate[],
  packument: unknown,
  resolved: ResolvedOptions,
): Promise<void> {
  if (!isRecord(packument) || !isRecord(packument.versions)) return;
  const versions = packument.versions;
  for (const candidate of candidates) {
    if (candidate.previous === null) continue;
    const previous = versions[candidate.previous.version];
    if (previous === undefined) continue;
    const selection = selectNewDependencies(
      versions[candidate.version],
      previous,
    );
    if (selection.selected.length === 0 && selection.overflow.length === 0) {
      continue;
    }
    candidate.children = [];
    candidate.unresolvedChildren = capReasons(selection.overflow);
    for (const dependency of selection.selected) {
      const resolution = await resolveChild(dependency, resolved);
      if ("artifact" in resolution) {
        candidate.children.push({
          name: dependency.name,
          artifact: resolution.artifact,
        });
      } else {
        candidate.unresolvedChildren.push({
          name: unresolvedChildName(dependency.name),
          reason: truncate(resolution.reason, MAX_VALUE_CHARS),
        });
      }
    }
  }
}

/**
 * The queue stores the unresolved name verbatim, so a name its validation
 * rejects must not reach it. The reason already carries the truncated original.
 */
function unresolvedChildName(name: string): string {
  if (nameProblem(name) !== null) return INVALID_DEPENDENCY_NAME;
  return truncate(name, MAX_IDENTITY_CHARS);
}

function capReasons(
  overflow: readonly DeclaredDependency[],
): UnresolvedReleaseChild[] {
  const reasons: UnresolvedReleaseChild[] = [];
  const named = overflow.slice(0, MAX_CHILDREN_PER_RELEASE);
  for (const dependency of named) {
    reasons.push({
      name: truncate(dependency.name, MAX_IDENTITY_CHARS),
      reason: `over the ${String(MAX_CHILDREN_PER_RELEASE)}-child cap; not analyzed`,
    });
  }
  const unnamed = overflow.length - named.length;
  if (unnamed > 0) {
    reasons.push({
      name: truncate(overflow[0]?.name ?? "<cap>", MAX_IDENTITY_CHARS),
      reason: `${String(unnamed)} more new dependencies are over the ${String(MAX_CHILDREN_PER_RELEASE)}-child cap; not analyzed`,
    });
  }
  return reasons;
}

type ChildResolution = { artifact: ReleaseArtifact } | { reason: string };

async function resolveChild(
  dependency: DeclaredDependency,
  resolved: ResolvedOptions,
): Promise<ChildResolution> {
  const invalid = nameProblem(dependency.name);
  if (invalid !== null) {
    return {
      reason: `${invalid}: ${JSON.stringify(truncate(dependency.name, MAX_IDENTITY_CHARS))}`,
    };
  }
  const kind = specifierKind(dependency.specifier);
  if (kind !== "range" && kind !== "tag") {
    return { reason: unsupportedSpecifierReason(kind) };
  }

  let packument: unknown;
  try {
    // Recovery is loud: a child registry failure becomes an incomplete record.
    packument = await fetchJson(
      `${resolved.registryUrl}/${encodePackageName(dependency.name)}`,
      resolved,
      `packument for ${truncate(dependency.name, MAX_IDENTITY_CHARS)}`,
      resolved.maxPackumentBytes,
    );
  } catch (error: unknown) {
    if (error instanceof CollectorError) return { reason: error.message };
    throw error;
  }
  const resolution = resolveVersion(
    dependency.specifier,
    publishedVersionKeys(packument),
    isRecord(packument) ? readDistTags(packument) : new Map<string, string>(),
  );
  if ("reason" in resolution) return { reason: resolution.reason };
  const selected = selectedVersion(
    packument,
    resolution.version,
    resolved.registryOrigin,
  );
  if ("reason" in selected) {
    return {
      reason: `${truncate(dependency.name, MAX_IDENTITY_CHARS)}: ${selected.reason}`,
    };
  }
  return { artifact: artifact(selected.entry) };
}

/**
 * Every strict semver key the packument publishes, before any metadata check.
 * The resolver chooses among these so a version missing dist metadata is
 * reported instead of silently skipped in favor of a lower one.
 */
function publishedVersionKeys(packument: unknown): string[] {
  if (!isRecord(packument) || !isRecord(packument.versions)) return [];
  return Object.keys(packument.versions).filter(
    (version) => versionProblem(version) === null,
  );
}

function selectedVersion(
  packument: unknown,
  version: string,
  registryOrigin: string,
): ParsedVersion {
  if (!isRecord(packument) || !isRecord(packument.versions)) {
    return { reason: "the packument has no version metadata" };
  }
  const times = isRecord(packument.time) ? packument.time : {};
  return parseVersion(
    version,
    packument.versions[version],
    times[version],
    registryOrigin,
  );
}

function readDistTags(
  packument: Record<string, unknown>,
): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  const raw = packument["dist-tags"];
  if (!isRecord(raw)) return tags;
  for (const [tag, value] of Object.entries(raw)) {
    if (typeof value === "string") tags.set(tag, value);
  }
  return tags;
}

function readPackument(
  name: string,
  packument: unknown,
  resolved: ResolvedOptions,
  onlyVersions: ReadonlySet<string> | undefined,
): CandidatesResult {
  const skipped: CollectorSkipped[] = [];
  let omitted = 0;
  const skip = (reason: string): void => {
    if (skipped.length >= MAX_SKIPPED_PER_PACKAGE) {
      omitted += 1;
      return;
    }
    skipped.push({
      name,
      reason: truncate(reason, MAX_VALUE_CHARS),
    });
  };
  if (!isRecord(packument)) {
    skip("malformed packument");
    return { candidates: [], skipped };
  }
  const versions = packument.versions;
  const times = packument.time;
  if (!isRecord(versions) || Object.keys(versions).length === 0) {
    skip("packument has no versions");
    return { candidates: [], skipped };
  }
  if (!isRecord(times)) {
    skip("packument has no publish times");
    return { candidates: [], skipped };
  }

  const entries: VersionEntry[] = [];
  for (const version of Object.keys(versions)) {
    const invalid = versionProblem(version);
    if (invalid !== null) {
      skip(invalid);
      continue;
    }
    const parsed = parseVersion(
      version,
      versions[version],
      times[version],
      resolved.registryOrigin,
    );
    if ("reason" in parsed) skip(parsed.reason);
    else entries.push(parsed.entry);
  }

  entries.sort(
    (left, right) =>
      left.publishedMs - right.publishedMs ||
      left.version.localeCompare(right.version),
  );
  const candidates: ReleaseCandidate[] = [];
  let previous: VersionEntry | null = null;
  for (const [index, entry] of entries.entries()) {
    const prior = entries[index - 1];
    if (prior !== undefined && prior.publishedMs < entry.publishedMs) {
      previous = prior;
    }
    if (onlyVersions !== undefined && !onlyVersions.has(entry.version)) {
      continue;
    }
    candidates.push({
      ecosystem: "npm",
      name,
      version: entry.version,
      digest: entry.digest,
      tarballUrl: entry.tarballUrl,
      previous: previous === null ? null : artifact(previous),
      publishedAt: entry.publishedAt,
    });
  }
  // A feed event concerns the newest releases; an older one is reachable with onlyVersions.
  const tooOld = candidates.length - MAX_CANDIDATES_PER_PACKAGE;
  const kept = tooOld > 0 ? candidates.slice(tooOld) : candidates;
  if (tooOld > 0) {
    skipped.push({
      name,
      reason: `${String(tooOld)} older versions not queued`,
    });
  }
  if (omitted > 0) {
    skipped.push({
      name,
      reason: `${String(omitted)} more skipped entries not listed`,
    });
  }
  return { candidates: kept, skipped };
}

type ParsedVersion = { entry: VersionEntry } | { reason: string };

function versionProblem(version: string): string | null {
  const label = JSON.stringify(truncate(version, MAX_IDENTITY_CHARS));
  if (version.length === 0) return `version key ${label} is empty`;
  if (version.length > MAX_VERSION_CHARS) {
    return `version key ${label} exceeds ${String(MAX_VERSION_CHARS)} characters`;
  }
  if (!isWellFormed(version)) {
    return `version key ${label} is not well-formed Unicode`;
  }
  if (!STRICT_SEMVER.test(version)) {
    return `version key ${label} is not strict semver`;
  }
  return null;
}

function parseVersion(
  version: string,
  value: unknown,
  publishedAt: unknown,
  registryOrigin: string,
): ParsedVersion {
  const label = truncate(version, MAX_IDENTITY_CHARS);
  const fail = (detail: string): ParsedVersion => ({
    reason: `version ${label} has ${detail}`,
  });
  if (!isRecord(value) || !isRecord(value.dist)) {
    return fail("no dist metadata");
  }
  const { integrity, tarball } = value.dist;
  if (typeof integrity !== "string" || integrity.length === 0) {
    return fail("no dist.integrity");
  }
  if (!integrity.startsWith("sha512-")) {
    return fail("non-sha512 dist.integrity");
  }
  if (integrity.length > MAX_VALUE_CHARS) {
    return fail("an oversized dist.integrity");
  }
  if (typeof tarball !== "string" || tarball.length === 0) {
    return fail("no dist.tarball");
  }
  if (tarball.length > MAX_URL_CHARS) {
    return fail(`a dist.tarball over ${String(MAX_URL_CHARS)} characters`);
  }
  const parsedTarball = parseUrl(tarball);
  if (parsedTarball === null) {
    return fail("an invalid dist.tarball");
  }
  if (parsedTarball.username !== "" || parsedTarball.password !== "") {
    return fail("a dist.tarball with credentials");
  }
  if (parsedTarball.origin !== registryOrigin) {
    return fail("a dist.tarball on another origin");
  }
  if (typeof publishedAt !== "string") {
    return fail("no publish time");
  }
  const publishedMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedMs)) {
    return fail("an invalid publish time");
  }
  return {
    entry: {
      version,
      digest: integrity,
      tarballUrl: tarball,
      publishedAt: truncate(publishedAt, MAX_VALUE_CHARS),
      publishedMs,
    },
  };
}

function artifact(entry: VersionEntry): ReleaseArtifact {
  return {
    version: entry.version,
    digest: entry.digest,
    tarballUrl: entry.tarballUrl,
  };
}

interface ChangeFeed {
  ids: string[];
  lastSeq: number | string;
}

function changeFeed(feed: unknown): ChangeFeed {
  if (!isRecord(feed) || !Array.isArray(feed.results)) {
    throw new CollectorError("change feed is malformed");
  }
  const { last_seq: lastSeq } = feed;
  if (typeof lastSeq !== "number" && typeof lastSeq !== "string") {
    throw new CollectorError("change feed has no last_seq");
  }
  const ids = new Set<string>();
  for (const item of feed.results) {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new CollectorError("change feed entry is malformed");
    }
    if (item.id.startsWith("_design/")) continue;
    ids.add(item.id);
  }
  return { ids: [...ids], lastSeq };
}

/**
 * The database's current sequence. The live feed rejects `since=now` with HTTP
 * 400, so a first run starts from the number the database root reports.
 */
export async function currentFeedSequence(
  options: CollectorOptions,
): Promise<string> {
  const resolved = resolveOptions(options);
  const root = new URL("./", resolved.changesUrl);
  const info = await fetchJson(
    root.href,
    resolved,
    "change feed database info",
    MAX_CHANGE_FEED_BYTES,
  );
  const sequence = isRecord(info) ? info.update_seq : undefined;
  if (
    (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) &&
    (typeof sequence !== "string" || !/^\d{1,20}$/u.test(sequence))
  ) {
    throw new CollectorError("change feed database info has no update_seq");
  }
  return String(sequence);
}

async function fetchJson(
  url: string,
  resolved: ResolvedOptions,
  purpose: string,
  maxBytes: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await resolved.fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(resolved.timeoutMs),
    });
  } catch (error: unknown) {
    throw new CollectorError(`${purpose} request failed`, { cause: error });
  }
  if (response.status !== 200) {
    await discardBody(response, purpose, response.status);
    throw new CollectorError(
      `${purpose} returned HTTP ${String(response.status)}`,
    );
  }
  const text = await readCappedText(response, maxBytes, purpose);
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new CollectorError(`${purpose} body is not JSON`, { cause: error });
  }
}

async function readCappedText(
  response: Response,
  maxBytes: number,
  purpose: string,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await readChunk(reader, purpose);
    if (result.done) break;
    const chunk = result.value;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await cancelReader(reader, purpose);
      throw new CollectorError(`${purpose} exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  purpose: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error: unknown) {
    throw new CollectorError(`${purpose} body could not be read`, {
      cause: error,
    });
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  purpose: string,
): Promise<void> {
  try {
    await reader.cancel();
  } catch (error: unknown) {
    throw new CollectorError(`${purpose} body could not be cancelled`, {
      cause: error,
    });
  }
}

async function discardBody(
  response: Response,
  purpose: string,
  status: number,
): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch (error: unknown) {
    throw new CollectorError(
      `${purpose} returned HTTP ${String(status)} and its body could not be cancelled`,
      { cause: error },
    );
  }
}

function resolveOptions(options: CollectorOptions): ResolvedOptions {
  const registry = parseEndpoint(
    options.registryUrl ?? DEFAULT_REGISTRY_URL,
    "registryUrl",
  );
  const changes = parseEndpoint(
    options.changesUrl ?? DEFAULT_CHANGES_URL,
    "changesUrl",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPackumentBytes =
    options.maxPackumentBytes ?? DEFAULT_MAX_PACKUMENT_BYTES;
  const limit = options.limit ?? DEFAULT_LIMIT;
  requirePositiveInteger(timeoutMs, "timeoutMs");
  requirePositiveInteger(maxPackumentBytes, "maxPackumentBytes");
  requirePositiveInteger(limit, "limit");
  return {
    registryUrl: registry.href.replace(/\/+$/u, ""),
    registryOrigin: registry.origin,
    changesUrl: changes,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs,
    maxPackumentBytes,
    limit,
  };
}

function parseEndpoint(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new CollectorError(`${name} is not a valid URL`, { cause: error });
    }
    throw error;
  }
  requireAllowedProtocol(url, name);
  return url;
}

function requireAllowedProtocol(url: URL, name: string): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) {
    return;
  }
  throw new CollectorError(
    `${name} must be https (http is allowed only for 127.0.0.1 or localhost)`,
  );
}

function requirePositiveInteger(value: number, name: string): void {
  if (Number.isInteger(value) && value > 0) return;
  throw new CollectorError(`${name} must be a positive integer`);
}

/** npm's registry path keeps `@` and encodes the scope separator as `%2f`. */
function encodePackageName(name: string): string {
  return name
    .split("/")
    .map((part) =>
      part.startsWith("@")
        ? `@${encodeURIComponent(part.slice(1))}`
        : encodeURIComponent(part),
    )
    .join("%2f");
}

function nameProblem(name: string): string | null {
  if (name.length === 0) return "package name is empty";
  if (Array.from(name).length > MAX_PACKAGE_NAME_CHARS) {
    return `package name exceeds ${String(MAX_PACKAGE_NAME_CHARS)} characters`;
  }
  if (name.includes("..")) return "package name contains '..'";
  // A lone surrogate passes every other check but makes encodeURIComponent
  // throw a URIError, which would abort the whole change-feed page.
  if (!isWellFormed(name)) return "package name is not well-formed Unicode";
  if (hasControlCharacters(name)) {
    return "package name contains control characters";
  }
  if (/\s/u.test(name)) return "package name contains whitespace";
  return null;
}

/** ES2023's lib predates `String.prototype.isWellFormed`, which Node 22 ships. */
function isWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
