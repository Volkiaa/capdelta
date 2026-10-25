import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ReleaseArtifact } from "./release-candidate.js";

/** Test-only fake registry. Production code must never import this file. */
export const REGISTRY_ORIGIN = "https://registry.test";

const DEFAULT_INDEX_JS = "module.exports = 1;\n";
const FIRST_SEQ = 100;
const BLOCK_SIZE = 512;

export interface FakePublishOptions {
  scripts?: Readonly<Record<string, string>>;
  indexJs?: string;
  publishedAt?: string;
  dependencies?: Readonly<Record<string, string>>;
}

export interface FakeRegistry {
  fetchImpl: typeof fetch;
  publish(
    name: string,
    version: string,
    options?: FakePublishOptions,
  ): ReleaseArtifact;
  requestCount(url: string): number;
  tarballRequestCount(): number;
  failNextTarballRequests(count: number): void;
}

interface FakeVersion {
  publishedAt: string;
  integrity: string;
  fileName: string;
  dependencies?: Readonly<Record<string, string>>;
}

interface FakePackage {
  name: string;
  latest: string;
  versions: Map<string, FakeVersion>;
}

export function createFakeRegistry(): FakeRegistry {
  const packages = new Map<string, FakePackage>();
  const changes: { seq: number; id: string }[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const requests = new Map<string, number>();
  let lastSeq = FIRST_SEQ;
  let publishCount = 0;
  let failures = 0;

  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    requests.set(url, (requests.get(url) ?? 0) + 1);
    return Promise.resolve(respond(url));
  };

  function respond(url: string): Response {
    const parsed = registryUrl(url);
    if (parsed.pathname === "/_changes") return changesPage(parsed);
    if (parsed.pathname === "/") return json({ update_seq: lastSeq });
    if (parsed.pathname.startsWith("/tarballs/")) {
      return tarball(parsed.pathname.slice("/tarballs/".length));
    }
    return packumentPage(decodePathSegment(parsed.pathname.slice(1)));
  }

  function changesPage(url: URL): Response {
    const sinceText = url.searchParams.get("since") ?? "0";
    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) return badRequest("invalid limit");
    const since = parseSince(sinceText);
    if (since === null) return badRequest("invalid since");
    const page = changes.filter((entry) => entry.seq > since).slice(0, limit);
    return json({
      results: page,
      last_seq: page.at(-1)?.seq ?? lastSeq,
    });
  }

  function packumentPage(name: string): Response {
    const pkg = packages.get(name);
    if (pkg === undefined) return notFound();
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    for (const [version, entry] of pkg.versions) {
      versions[version] = {
        name,
        version,
        ...(entry.dependencies === undefined
          ? {}
          : { dependencies: entry.dependencies }),
        dist: {
          integrity: entry.integrity,
          tarball: `${REGISTRY_ORIGIN}/tarballs/${entry.fileName}`,
        },
      };
      time[version] = entry.publishedAt;
    }
    return json({
      name,
      versions,
      time,
      "dist-tags": { latest: pkg.latest },
    });
  }

  function tarball(fileName: string): Response {
    if (failures > 0) {
      failures -= 1;
      return new Response("registry unavailable", { status: 500 });
    }
    const bytes = tarballs.get(fileName);
    if (bytes === undefined) return notFound();
    return new Response(bytes, { status: 200 });
  }

  return {
    fetchImpl,
    publish(name, version, options = {}) {
      publishCount += 1;
      const publishedAt =
        options.publishedAt ??
        new Date(Date.UTC(2026, 0, 1) + publishCount * 60_000).toISOString();
      const bytes = buildTarball(name, version, options);
      const fileName = `${name}-${version}.tgz`;
      tarballs.set(fileName, bytes);
      const integrity = `sha512-${createHash("sha512")
        .update(bytes)
        .digest("base64")}`;
      let pkg = packages.get(name);
      if (pkg === undefined) {
        pkg = { name, latest: version, versions: new Map() };
        packages.set(name, pkg);
      }
      pkg.versions.set(version, {
        publishedAt,
        integrity,
        fileName,
        ...(options.dependencies === undefined
          ? {}
          : { dependencies: options.dependencies }),
      });
      pkg.latest = version;
      lastSeq += 1;
      changes.push({ seq: lastSeq, id: name });
      return {
        version,
        digest: integrity,
        tarballUrl: `${REGISTRY_ORIGIN}/tarballs/${fileName}`,
      };
    },
    requestCount(url) {
      return requests.get(url) ?? 0;
    },
    tarballRequestCount() {
      let total = 0;
      for (const [url, count] of requests) {
        if (url.startsWith(`${REGISTRY_ORIGIN}/tarballs/`)) total += count;
      }
      return total;
    },
    failNextTarballRequests(count) {
      failures += count;
    },
  };
}

function registryUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.origin !== REGISTRY_ORIGIN) {
    throw new Error(`unexpected registry request: ${value}`);
  }
  return parsed;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    // A malformed escape cannot name a published package.
    if (error instanceof URIError) return value;
    throw error;
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null) return 100;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function parseSince(value: string): number | null {
  const since = Number(value);
  return Number.isSafeInteger(since) && since >= 0 ? since : null;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(detail: string): Response {
  return new Response(JSON.stringify({ error: detail }), { status: 400 });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

function buildTarball(
  name: string,
  version: string,
  options: FakePublishOptions,
): Uint8Array {
  const manifest: Record<string, unknown> = {
    name,
    version,
    main: "index.js",
  };
  if (options.scripts !== undefined) manifest.scripts = options.scripts;
  if (options.dependencies !== undefined) {
    manifest.dependencies = options.dependencies;
  }
  const entries = [
    {
      path: "package/package.json",
      body: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    { path: "package/index.js", body: options.indexJs ?? DEFAULT_INDEX_JS },
  ];
  const blocks = entries.flatMap(tarEntry);
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));
  return gzipSync(concatenate(blocks));
}

function tarEntry(entry: { path: string; body: string }): Uint8Array[] {
  const body = new TextEncoder().encode(entry.body);
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, entry.path, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, body.byteLength, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);
  writeChecksum(header);
  return [header, body, new Uint8Array(padding(body.byteLength))];
}

function writeString(
  target: Uint8Array,
  value: string,
  offset: number,
  length: number,
): void {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.slice(0, length), offset);
}

function writeOctal(
  target: Uint8Array,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeString(target, encoded, offset, length);
}

function writeChecksum(header: Uint8Array): void {
  const checksum = header.reduce((total, value) => total + value, 0);
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, encoded, 148, 8);
}

function padding(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
