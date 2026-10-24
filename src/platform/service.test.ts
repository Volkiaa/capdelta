import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "../core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../core/contract/lockfile-diff.js";
import {
  analyzeOne,
  monitorOnce,
  openService,
  ServiceError,
  type ServiceConfig,
} from "./service.js";

const REGISTRY = "https://registry.npmjs.org";
const CHANGES = "https://replicate.npmjs.com/_changes";

let base: string;
let dataDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-service-"));
  dataDir = join(base, "data");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function packument(name: string, versions: readonly string[]): unknown {
  const doc: {
    name: string;
    versions: Record<string, unknown>;
    time: Record<string, string>;
  } = { name, versions: {}, time: { created: "2020-01-01T00:00:00.000Z" } };
  for (const [index, version] of versions.entries()) {
    doc.versions[version] = {
      name,
      version,
      dist: {
        integrity: `sha512-${name}-${version}`,
        tarball: `${REGISTRY}/${name}/-/${name}-${version}.tgz`,
      },
    };
    doc.time[version] = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
  }
  return doc;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function requestedUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Routes by URL and records every request. A miss fails loudly. */
function routedFetch(route: (url: string) => Response | undefined): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = requestedUrl(input);
    requested.push(url);
    const response = route(url);
    if (response === undefined) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(response);
  };
  return { fetchImpl, requested };
}

function analyzedRun(changed: ChangedPackage): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
    packages: [
      {
        status: "analyzed",
        changedPackage: changed,
        diff: {
          baseline:
            changed.oldVersion === null
              ? null
              : {
                  ecosystem: "npm",
                  name: changed.name,
                  version: changed.oldVersion,
                },
          subject: {
            ecosystem: "npm",
            name: changed.name,
            version: changed.newVersion,
          },
          newPackage: changed.oldVersion === null,
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

function fakeAnalyze(): {
  analyze: NonNullable<ServiceConfig["analyze"]>;
  calls: ChangedPackage[];
} {
  const calls: ChangedPackage[] = [];
  return {
    calls,
    analyze: (diff) => {
      const changed = diff.changed[0];
      if (changed === undefined) {
        throw new Error("fake analyze received no changed package");
      }
      calls.push(changed);
      return Promise.resolve(analyzedRun(changed));
    },
  };
}

function config(
  fetchImpl: typeof fetch,
  overrides: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    dataDir,
    collector: { fetchImpl },
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

function cursorValue(since: string): object {
  return { since };
}

describe("monitorOnce", () => {
  it("stores a cursor on the first cycle and enqueues nothing", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url === `${CHANGES}?since=now&limit=100`) {
        return jsonResponse({ results: [], last_seq: 100 });
      }
      return undefined;
    });

    const result = await monitorOnce(config(fetchImpl));

    expect(result).toEqual({
      enqueued: 0,
      skipped: 0,
      done: 0,
      failed: 0,
      cursor: "100",
    });
    const handles = openService(config(fetchImpl));
    await expect(handles.store.get("cursor", "npm-changes")).resolves.toEqual(
      cursorValue("100"),
    );
    await expect(handles.queue.list()).resolves.toEqual([]);
  });

  it("analyzes one new release and stores one record", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url === `${CHANGES}?since=now&limit=100`) {
        return jsonResponse({ results: [], last_seq: 100 });
      }
      if (url === `${CHANGES}?since=100&limit=100`) {
        return jsonResponse({
          results: [{ seq: 101, id: "alpha" }],
          last_seq: 101,
        });
      }
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse(packument("alpha", ["1.0.0"]));
      }
      return undefined;
    });
    const { analyze, calls } = fakeAnalyze();
    const service = config(fetchImpl, { analyze });

    await monitorOnce(service);
    const result = await monitorOnce(service);

    expect(result).toEqual({
      enqueued: 1,
      skipped: 0,
      done: 1,
      failed: 0,
      cursor: "101",
    });
    expect(calls).toHaveLength(1);
    const handles = openService(service);
    const jobs = await handles.queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "done", attempts: 1 });
    const records = await handles.releases.findByVersion("alpha", "1.0.0");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "alpha",
      version: "1.0.0",
      status: "complete",
    });
    await expect(handles.store.get("cursor", "npm-changes")).resolves.toEqual(
      cursorValue("101"),
    );
  });

  it("replays the same feed page without a duplicate job or record", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url.includes("since=now")) {
        return jsonResponse({ results: [], last_seq: 100 });
      }
      if (url.startsWith(`${CHANGES}?`)) {
        return jsonResponse({
          results: [{ seq: 101, id: "alpha" }],
          last_seq: 101,
        });
      }
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse(packument("alpha", ["1.0.0"]));
      }
      return undefined;
    });
    const { analyze, calls } = fakeAnalyze();
    const service = config(fetchImpl, { analyze });

    await monitorOnce(service);
    await monitorOnce(service);
    const result = await monitorOnce(service);

    expect(result).toMatchObject({ enqueued: 0, done: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    const handles = openService(service);
    await expect(handles.queue.list()).resolves.toHaveLength(1);
    await expect(handles.releases.listKeys()).resolves.toHaveLength(1);
  });

  it("replays a release that was enqueued before the cursor write", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url.includes("since=now")) {
        return jsonResponse({ results: [], last_seq: 100 });
      }
      if (url.startsWith(`${CHANGES}?`)) {
        return jsonResponse({
          results: [{ seq: 101, id: "alpha" }],
          last_seq: 101,
        });
      }
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse(packument("alpha", ["1.0.0"]));
      }
      return undefined;
    });
    const { analyze, calls } = fakeAnalyze();
    const service = config(fetchImpl, { analyze });

    await monitorOnce(config(fetchImpl));

    // Throwing from the progress callback leaves the job enqueued and the
    // cursor where it was, which is the state a crash in that window leaves.
    const crashing = config(fetchImpl, {
      analyze,
      onEvent: (message) => {
        if (message.startsWith("enqueued ")) {
          throw new Error("simulated crash after enqueue");
        }
      },
    });
    await expect(monitorOnce(crashing)).rejects.toThrow(
      "simulated crash after enqueue",
    );

    const crashed = openService(config(fetchImpl));
    await expect(crashed.queue.list("pending")).resolves.toHaveLength(1);
    await expect(crashed.releases.listKeys()).resolves.toHaveLength(0);

    const result = await monitorOnce(service);

    expect(result).toMatchObject({ enqueued: 0, done: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const handles = openService(service);
    await expect(handles.queue.list()).resolves.toHaveLength(1);
    await expect(handles.queue.list("done")).resolves.toHaveLength(1);
    await expect(handles.releases.listKeys()).resolves.toHaveLength(1);
  });

  it("rejects a feed cursor that is unsafe to store or request", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url.includes("since=now")) {
        return jsonResponse({ results: [], last_seq: "12\n34" });
      }
      return undefined;
    });

    await expect(monitorOnce(config(fetchImpl))).rejects.toBeInstanceOf(
      ServiceError,
    );
    const handles = openService(config(fetchImpl));
    await expect(
      handles.store.get("cursor", "npm-changes"),
    ).resolves.toBeNull();
  });

  it("passes every skipped package to onEvent", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url.includes("since=now")) {
        return jsonResponse({ results: [], last_seq: 100 });
      }
      if (url.startsWith(`${CHANGES}?`)) {
        return jsonResponse({
          results: [
            { seq: 101, id: "alpha" },
            { seq: 102, id: "beta" },
          ],
          last_seq: 102,
        });
      }
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse({ error: "boom" }, 500);
      }
      if (url === `${REGISTRY}/beta`) {
        return jsonResponse(packument("beta", ["2.0.0"]));
      }
      return undefined;
    });
    const { analyze } = fakeAnalyze();
    const events: string[] = [];
    const service = config(fetchImpl, {
      analyze,
      onEvent: (message) => events.push(message),
    });

    await monitorOnce(service);
    const result = await monitorOnce(service);

    expect(result).toMatchObject({ enqueued: 1, skipped: 1, done: 1 });
    const noisy = events.filter(
      (message) => message.includes("alpha") && message.includes("HTTP 500"),
    );
    expect(noisy).toHaveLength(1);
  });
});

describe("analyzeOne", () => {
  it("analyzes a named version with its predecessor", async () => {
    const { fetchImpl, requested } = routedFetch((url) => {
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse(packument("alpha", ["1.0.0", "1.1.0"]));
      }
      return undefined;
    });
    const { analyze, calls } = fakeAnalyze();

    const result = await analyzeOne(
      config(fetchImpl, { analyze }),
      "alpha",
      "1.1.0",
    );

    expect(result).toEqual({ done: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(requested).toEqual([`${REGISTRY}/alpha`]);
    const handles = openService(config(fetchImpl));
    const records = await handles.releases.findByVersion("alpha", "1.1.0");
    expect(records).toHaveLength(1);
    expect(records[0]?.previousVersion).toBe("1.0.0");
  });

  it("throws ServiceError for a version the registry does not publish", async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url === `${REGISTRY}/alpha`) {
        return jsonResponse(packument("alpha", ["1.0.0"]));
      }
      return undefined;
    });

    const attempt = analyzeOne(config(fetchImpl), "alpha", "9.9.9");

    await expect(attempt).rejects.toBeInstanceOf(ServiceError);
    await expect(attempt).rejects.toThrow(/alpha@9\.9\.9/u);
    const handles = openService(config(fetchImpl));
    await expect(handles.queue.list()).resolves.toEqual([]);
    await expect(handles.releases.listKeys()).resolves.toEqual([]);
  });
});
