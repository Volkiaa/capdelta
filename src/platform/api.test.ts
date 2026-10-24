import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "../core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../core/contract/lockfile-diff.js";
import { buildRunReport } from "../core/report-builder.js";
import { createApiServer, listenApi } from "./api.js";
import { JobQueue, type JobRecord } from "./job-queue.js";
import { JsonStore, encodeKey } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import {
  ReleaseStore,
  ReleaseStoreError,
  type ReleaseRecord,
} from "./release-store.js";

let base: string;
let json: JsonStore;
let releases: ReleaseStore;
let queue: JobQueue;
let server: Server | undefined;
let origin: string;
let errors: unknown[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-api-"));
  json = new JsonStore({ root: join(base, "root") });
  releases = new ReleaseStore(json);
  queue = new JobQueue(json);
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
  }
  await rm(base, { recursive: true, force: true });
});

async function start(): Promise<void> {
  errors = [];
  server = createApiServer({
    releases,
    queue,
    onError: (error) => {
      errors.push(error);
    },
  });
  const address = await listenApi(server, 0);
  origin = `http://${address.host}:${String(address.port)}`;
}

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, init);
}

function emptyRun(changed: ChangedPackage): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
    packages: [
      {
        status: "analyzed",
        changedPackage: changed,
        diff: {
          baseline: null,
          subject: {
            ecosystem: "npm",
            name: changed.name,
            version: changed.newVersion,
          },
          newPackage: true,
          findings: [],
          diagnostics: [],
        },
        issues: [],
        baselineFailures: [],
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

function makeRecord(
  name: string,
  version: string,
  digest: string,
): ReleaseRecord {
  const changed: ChangedPackage = {
    name,
    oldVersion: null,
    newVersion: version,
    oldIntegrity: null,
    newIntegrity: digest,
    oldResolvedUrl: null,
    resolvedUrl: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
  };
  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name,
    version,
    digest,
    previousVersion: null,
    previousDigest: null,
    analyzerVersion: "test-analyzer",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    status: "complete",
    incompleteReasons: [],
    report: buildRunReport(emptyRun(changed)),
  };
}

function candidate(
  name: string,
  version: string,
  digest: string,
): ReleaseCandidate {
  return {
    ecosystem: "npm",
    name,
    version,
    digest,
    tarballUrl: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
    previous: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function seedRelease(record: ReleaseRecord): Promise<void> {
  await releases.putIfAbsent(record);
}

async function claimOne(): Promise<JobRecord> {
  const job = await queue.claim();
  if (job === null) throw new Error("expected a pending job");
  return job;
}

interface JobsResponse {
  counts: { pending: number; running: number; done: number; failed: number };
  failed: {
    id: string;
    name: string;
    version: string;
    attempts: number;
    lastError: string | null;
  }[];
}

async function jobsBody(response: Response): Promise<JobsResponse> {
  return (await response.json()) as JobsResponse;
}

describe("GET /v1/jobs", () => {
  it("counts every state and lists the failed jobs", async () => {
    await start();
    await queue.enqueue(candidate("done-pkg", "1.0.0", "sha512-done"));
    await queue.complete((await claimOne()).id);
    await queue.enqueue(candidate("failed-pkg", "2.0.0", "sha512-failed"));
    const failedJob = await claimOne();
    await queue.fail(failedJob.id, "registry timeout", 1);
    await queue.enqueue(candidate("running-pkg", "3.0.0", "sha512-running"));
    await claimOne();
    await queue.enqueue(candidate("pending-pkg", "4.0.0", "sha512-pending"));

    const response = await get("/v1/jobs");

    expect(response.status).toBe(200);
    await expect(jobsBody(response)).resolves.toEqual({
      counts: { pending: 1, running: 1, done: 1, failed: 1 },
      failed: [
        {
          id: failedJob.id,
          name: "failed-pkg",
          version: "2.0.0",
          attempts: 1,
          lastError: "registry timeout",
        },
      ],
    });
  });

  it("caps the failed list at 100 entries", async () => {
    await start();
    for (let index = 0; index < 105; index += 1) {
      await queue.enqueue(
        candidate(`pkg-${String(index)}`, "1.0.0", `sha512-${String(index)}`),
      );
      await queue.fail((await claimOne()).id, "boom", 1);
    }

    const body = await jobsBody(await get("/v1/jobs"));

    expect(body.counts.failed).toBe(105);
    expect(body.failed).toHaveLength(100);
  });
});

describe("GET /v1/releases/npm/<name>/<version>", () => {
  it("returns the records stored for a version", async () => {
    await start();
    const record = makeRecord("alpha", "2.0.0", "sha512-alpha");
    await seedRelease(record);

    const response = await get("/v1/releases/npm/alpha/2.0.0");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ releases: [record] });
  });

  it("reads a scoped name through an encoded slash", async () => {
    await start();
    const record = makeRecord("@scope/pkg", "1.0.0", "sha512-scoped");
    await seedRelease(record);

    const response = await get(
      `/v1/releases/npm/${encodeURIComponent("@scope/pkg")}/1.0.0`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ releases: [record] });
  });

  it("returns not found when no record matches", async () => {
    await start();

    const response = await get("/v1/releases/npm/alpha/9.9.9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });
});

describe("GET /v1/artifacts/<digest>", () => {
  it("returns the records stored for a digest", async () => {
    await start();
    const digest = "sha512-abc/def+ghi==";
    const record = makeRecord("alpha", "2.0.0", digest);
    await seedRelease(record);

    const response = await get(`/v1/artifacts/${encodeURIComponent(digest)}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ releases: [record] });
  });

  it("returns not found when no record matches", async () => {
    await start();

    const response = await get("/v1/artifacts/sha512-absent");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });
});

describe("request validation", () => {
  it("rejects a method other than GET or HEAD with 405", async () => {
    await start();

    const response = await get("/v1/jobs", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns not found for an unknown route", async () => {
    await start();

    const response = await get("/v1/unknown");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it("rejects a URL longer than 2048 characters with 414", async () => {
    await start();

    const response = await get(`/${"a".repeat(3000)}`);

    expect(response.status).toBe(414);
  });

  it("rejects a path segment with a bad percent escape with 400", async () => {
    await start();

    const response = await get("/v1/releases/npm/%zz/1.0.0");

    expect(response.status).toBe(400);
  });

  it("rejects a name longer than 214 characters with 400", async () => {
    await start();

    const response = await get(`/v1/releases/npm/${"a".repeat(215)}/1.0.0`);

    expect(response.status).toBe(400);
  });

  it("rejects a version longer than 214 characters with 400", async () => {
    await start();

    const response = await get(`/v1/releases/npm/alpha/${"1".repeat(215)}`);

    expect(response.status).toBe(400);
  });

  it("rejects a control character in a name with 400", async () => {
    await start();

    const response = await get("/v1/releases/npm/a%00b/1.0.0");

    expect(response.status).toBe(400);
  });

  it("rejects a control character in a version with 400", async () => {
    await start();

    const response = await get("/v1/releases/npm/alpha/1.0.0%0A");

    expect(response.status).toBe(400);
  });
});

describe("internal errors", () => {
  it("answers a store failure with a generic 500 and reports the error", async () => {
    await start();
    await json.put("release-by-version", encodeKey("alpha@2.0.0"), {
      keys: "not-a-list",
    });

    const response = await get("/v1/releases/npm/alpha/2.0.0");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body) as unknown).toEqual({ error: "internal error" });
    expect(body).not.toContain("release-by-version");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ReleaseStoreError);
  });
});

describe("server limits", () => {
  it("bounds the header count and the request time", async () => {
    await start();

    expect(server?.requestTimeout).toBe(10_000);
    expect(server?.maxHeadersCount).toBe(50);
    expect(server?.headersTimeout).toBeGreaterThan(0);
    expect(server?.headersTimeout).toBeLessThanOrEqual(
      server?.requestTimeout ?? 0,
    );
  });
});

describe("GET /healthz", () => {
  it("reports that the service is up", async () => {
    await start();

    const response = await get("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("sets the JSON security headers on every response", async () => {
    await start();

    const response = await get("/healthz");

    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers HEAD with the headers and no body", async () => {
    await start();

    const response = await get("/healthz", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.text()).resolves.toBe("");
  });
});
