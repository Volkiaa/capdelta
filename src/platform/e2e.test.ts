import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonReport, JsonRunReport } from "../core/report-contract.js";
import { createApiServer, listenApi } from "./api.js";
import type { JobRecord } from "./job-queue.js";
import type { ReleaseRecord } from "./release-store.js";
import {
  analyzeOne,
  monitorOnce,
  openService,
  type ServiceConfig,
} from "./service.js";
import { createFakeRegistry, REGISTRY_ORIGIN } from "./test-registry.js";

interface ReleaseBody {
  releases: ReleaseRecord[];
}

interface FailedJob {
  id: string;
  name: string;
  version: string;
  attempts: number;
  lastError: string | null;
}

interface JobsBody {
  counts: { pending: number; running: number; done: number; failed: number };
  failed: FailedJob[];
}

let base: string;
let dataDir: string;
let server: Server | undefined;
let origin: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-e2e-"));
  dataDir = join(base, "data");
  server = undefined;
  origin = "";
});

afterEach(async () => {
  await stopApi();
  await rm(base, { recursive: true, force: true });
});

function serviceConfig(
  registry: ReturnType<typeof createFakeRegistry>,
  overrides: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    dataDir,
    collector: {
      fetchImpl: registry.fetchImpl,
      registryUrl: REGISTRY_ORIGIN,
      changesUrl: `${REGISTRY_ORIGIN}/_changes`,
    },
    analyzeOptions: {
      fetcher: {
        fetchImpl: registry.fetchImpl,
        sleep: () => Promise.resolve(),
      },
    },
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function startApi(): Promise<void> {
  const handles = openService({ dataDir, collector: {} });
  server = createApiServer({
    releases: handles.releases,
    findings: handles.findings,
    queue: handles.queue,
  });
  const address = await listenApi(server, 0);
  origin = `http://${address.host}:${String(address.port)}`;
}

async function stopApi(): Promise<void> {
  const current = server;
  if (current === undefined) return;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    current.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function get(path: string): Promise<Response> {
  return fetch(`${origin}${path}`);
}

async function releasesAt(
  name: string,
  version: string,
): Promise<{ status: number; body: ReleaseBody }> {
  const response = await get(
    `/v1/releases/npm/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  return {
    status: response.status,
    body: (await response.json()) as ReleaseBody,
  };
}

function onlyRelease(records: readonly ReleaseRecord[]): ReleaseRecord {
  const [record, ...rest] = records;
  if (record === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one release, got ${String(records.length)}`,
    );
  }
  return record;
}

function onlyJob(jobs: readonly JobRecord[]): JobRecord {
  const [job, ...rest] = jobs;
  if (job === undefined || rest.length > 0) {
    throw new Error(`expected exactly one job, got ${String(jobs.length)}`);
  }
  return job;
}

function analyzedReport(run: JsonRunReport): JsonReport {
  for (const item of run.packages) {
    if (item.status === "analyzed") return item.report;
  }
  throw new Error("expected an analyzed package in the run report");
}

describe("platform end to end", () => {
  it("analyzes a published release against its predecessor and serves the report", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);

    const first = await monitorOnce(service);
    expect(first).toMatchObject({
      enqueued: 0,
      done: 0,
      failed: 0,
      cursor: "100",
    });

    registry.publish("pkg", "1.0.0");
    registry.publish("pkg", "1.1.0", {
      scripts: { postinstall: "node index.js" },
      indexJs: 'fetch("https://example.com");\n',
    });

    const cycle = await monitorOnce(service);

    expect(cycle).toMatchObject({ enqueued: 2, done: 2, failed: 0 });
    await startApi();
    const { status, body } = await releasesAt("pkg", "1.1.0");
    expect(status).toBe(200);
    const record = onlyRelease(body.releases);
    expect(record).toMatchObject({
      name: "pkg",
      version: "1.1.0",
      previousVersion: "1.0.0",
      status: "complete",
    });
    const gate = record.report.summary.gateSeverity;
    expect(gate.HIGH + gate.CRITICAL).toBeGreaterThan(0);

    const report = analyzedReport(record.report);
    expect(report.package).toMatchObject({
      oldVersion: "1.0.0",
      newVersion: "1.1.0",
      newPackage: false,
    });
    expect(report.shapes?.map((shape) => shape.ruleId)).toContain(
      "install-hook-change",
    );
    const hook = report.findings.find(
      (finding) => finding.capability.kind === "INSTALL_HOOK",
    );
    expect(hook).toMatchObject({
      severity: "CRITICAL",
      change: "added",
      capability: {
        kind: "INSTALL_HOOK",
        hook: "postinstall",
        applicability: "registry-install",
      },
    });
  });

  it("analyzes several releases with the configured concurrency", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry, { concurrency: 2 });
    await monitorOnce(service);
    for (const name of ["one", "two", "three"]) {
      registry.publish(name, "1.0.0");
    }

    const cycle = await monitorOnce(service);

    expect(cycle).toMatchObject({ enqueued: 3, done: 3, failed: 0 });
    const handles = openService(service);
    for (const name of ["one", "two", "three"]) {
      await expect(
        handles.releases.findByVersion(name, "1.0.0"),
      ).resolves.toHaveLength(1);
    }
    await expect(handles.queue.list("done")).resolves.toHaveLength(3);
  });

  it("analyzes a dependency the new release newly declares", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    await monitorOnce(service);
    registry.publish("wrapper", "1.0.0");
    registry.publish("wrapper", "1.1.0", {
      dependencies: { helper: "^1.0.0" },
    });
    registry.publish("helper", "1.0.0", {
      scripts: { postinstall: "node index.js" },
    });

    const cycle = await monitorOnce(service);

    expect(cycle).toMatchObject({ enqueued: 3, done: 3, failed: 0 });
    const handles = openService(service);
    const record = onlyRelease(
      await handles.releases.findByVersion("wrapper", "1.1.0"),
    );
    expect(record.status).toBe("complete");
    expect(record.report.packages).toHaveLength(2);
    const reports = record.report.packages.flatMap((item) =>
      item.status === "analyzed" ? [item.report] : [],
    );
    const parent = reports.find((item) => item.package.name === "wrapper");
    const child = reports.find((item) => item.package.name === "helper");
    const installHook = child?.findings.find(
      (finding) => finding.capability.kind === "INSTALL_HOOK",
    );
    expect(installHook).toMatchObject({
      severity: "CRITICAL",
      capability: { kind: "INSTALL_HOOK" },
    });
    const dependency = parent?.findings.find(
      (finding) => finding.capability.kind === "DEPENDENCY",
    );
    expect(dependency?.relatedReportIds).toEqual([child?.reportId]);
  });

  it("does not analyze a replayed feed page twice", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    const first = await monitorOnce(service);
    registry.publish("solo", "1.0.0");
    await monitorOnce(service);

    const handles = openService(service);
    const tarballsBefore = registry.tarballRequestCount();
    await handles.store.put("cursor", "npm-changes", { since: first.cursor });

    const replay = await monitorOnce(service);

    expect(replay).toMatchObject({ enqueued: 0, done: 0, failed: 0 });
    expect(registry.tarballRequestCount()).toBe(tarballsBefore);
    await expect(handles.queue.list()).resolves.toHaveLength(1);
    await expect(handles.releases.listKeys()).resolves.toHaveLength(1);
  });

  it("serves the same record after a restart", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    await monitorOnce(service);
    registry.publish("restart", "1.0.0");
    await monitorOnce(service);

    await startApi();
    const first = await releasesAt("restart", "1.0.0");
    expect(first.status).toBe(200);
    expect(onlyRelease(first.body.releases).version).toBe("1.0.0");
    await stopApi();

    await startApi();
    const second = await releasesAt("restart", "1.0.0");
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("retries a transient tarball failure and stores a complete record", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    await monitorOnce(service);
    registry.publish("flaky", "1.0.0");
    registry.failNextTarballRequests(1);

    const cycle = await monitorOnce(service);

    expect(cycle).toMatchObject({ enqueued: 1, done: 1, failed: 0 });
    const handles = openService(service);
    expect(onlyJob(await handles.queue.list())).toMatchObject({
      state: "done",
      attempts: 1,
    });
    const record = onlyRelease(
      await handles.releases.findByVersion("flaky", "1.0.0"),
    );
    expect(record.status).toBe("complete");
    expect(registry.tarballRequestCount()).toBe(2);
  });

  it("fails a job after repeated tarball failures and recovers after a manual re-enqueue", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry, { maxAttempts: 2 });
    await monitorOnce(service);
    registry.publish("broken", "1.0.0");
    registry.failNextTarballRequests(6);

    const cycle = await monitorOnce(service);

    expect(cycle).toMatchObject({ enqueued: 1, done: 0, failed: 1 });
    const handles = openService(service);
    const job = onlyJob(await handles.queue.list());
    expect(job).toMatchObject({ state: "failed", attempts: 2 });
    expect(job.lastError).not.toBeNull();
    expect(registry.tarballRequestCount()).toBe(6);
    await expect(
      handles.releases.findByVersion("broken", "1.0.0"),
    ).resolves.toEqual([]);

    await startApi();
    const jobs = (await (await get("/v1/jobs")).json()) as JobsBody;
    expect(jobs.counts.failed).toBe(1);
    expect(jobs.failed).toHaveLength(1);
    expect(jobs.failed[0]).toMatchObject({
      id: job.id,
      name: "broken",
      version: "1.0.0",
      attempts: 2,
    });
    await stopApi();

    // docs/platform.md documents this manual step: remove the failed job, then
    // analyze the version again. The monitor cursor already passed the event.
    await handles.store.delete("job", job.id);
    const recovered = await analyzeOne(service, "broken", "1.0.0");
    expect(recovered).toEqual({ done: 1, failed: 0 });
    const record = onlyRelease(
      await handles.releases.findByVersion("broken", "1.0.0"),
    );
    expect(record.status).toBe("complete");
    expect(registry.tarballRequestCount()).toBe(7);
  });

  it("stores a first release with no previous version", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    await monitorOnce(service);
    registry.publish("brand-new", "1.0.0");

    await monitorOnce(service);

    const handles = openService(service);
    const record = onlyRelease(
      await handles.releases.findByVersion("brand-new", "1.0.0"),
    );
    expect(record).toMatchObject({
      previousVersion: null,
      previousDigest: null,
      status: "complete",
    });
    const report = analyzedReport(record.report);
    expect(report.package).toMatchObject({
      oldVersion: null,
      newVersion: "1.0.0",
      newPackage: true,
    });
    await startApi();
    const { status, body } = await releasesAt("brand-new", "1.0.0");
    expect(status).toBe(200);
    expect(onlyRelease(body.releases).previousVersion).toBeNull();
  });

  it("publishes findings for the new release and a replay creates none", async () => {
    const registry = createFakeRegistry();
    const service = serviceConfig(registry);
    const first = await monitorOnce(service);
    registry.publish("intel", "1.0.0");
    registry.publish("intel", "1.1.0", {
      scripts: { postinstall: "node index.js" },
      indexJs: 'fetch("https://example.com");\n',
    });

    await monitorOnce(service);

    const handles = openService(service);
    const published = await handles.findings.findByPackage("intel", "1.1.0");
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((finding) => finding.verdict === "suspected")).toBe(
      true,
    );

    const jobs = await handles.queue.list();
    for (const job of jobs) await handles.store.delete("job", job.id);
    await handles.store.put("cursor", "npm-changes", { since: first.cursor });

    const replay = await monitorOnce(service);

    expect(replay).toMatchObject({ enqueued: 2, done: 2, failed: 0 });
    await expect(
      handles.findings.findByPackage("intel", "1.1.0"),
    ).resolves.toHaveLength(published.length);
  });
});
