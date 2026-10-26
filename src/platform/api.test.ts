import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "../core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../core/contract/lockfile-diff.js";
import { buildRunReport } from "../core/report-builder.js";
import { createApiServer, listenApi } from "./api.js";
import {
  createFinding,
  type IntelFinding,
  type NewFindingInput,
} from "./intel/finding.js";
import { FindingStore } from "./intel/finding-store.js";
import {
  createReviewers,
  hashToken,
  type Reviewers,
} from "./intel/reviewers.js";
import { JobQueue, type JobRecord } from "./job-queue.js";
import { JsonStore, encodeKey } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import {
  ReleaseStore,
  ReleaseStoreError,
  type ReleaseRecord,
} from "./release-store.js";
import {
  STATUS_PAGE_HTML,
  STATUS_PAGE_SCRIPT,
  STATUS_PAGE_STYLE,
} from "./ui-page.js";

const FINDING_TIME = new Date("2026-10-01T00:00:00.000Z");

let base: string;
let json: JsonStore;
let releases: ReleaseStore;
let findings: FindingStore;
let queue: JobQueue;
let server: Server | undefined;
let origin: string;
let errors: unknown[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-api-"));
  json = new JsonStore({ root: join(base, "root") });
  releases = new ReleaseStore(json);
  findings = new FindingStore(json);
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

async function start(reviewers?: Reviewers): Promise<void> {
  errors = [];
  server = createApiServer({
    releases,
    findings,
    queue,
    ...(reviewers === undefined ? {} : { reviewers }),
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

function baseFinding(overrides: Partial<NewFindingInput> = {}): IntelFinding {
  return createFinding(
    {
      ecosystem: "npm",
      name: "alpha",
      version: "2.0.0",
      digest: "sha512-alpha",
      analyzerVersion: "test-analyzer",
      ruleKey: "capability:NET:added",
      summary: "adds network access",
      severity: "HIGH",
      confidence: "medium",
      evidence: [
        { file: "index.js", line: 1, excerpt: 'fetch("https://example.test")' },
      ],
      ...overrides,
    },
    FINDING_TIME,
  );
}

async function seedFinding(
  overrides: Partial<NewFindingInput> = {},
): Promise<IntelFinding> {
  const finding = baseFinding(overrides);
  await findings.putIfAbsent(finding);
  return finding;
}

async function confirm(id: string): Promise<IntelFinding> {
  await findings.transition(
    id,
    { to: "under-review", actor: "alice", reason: "triage" },
    FINDING_TIME,
  );
  return findings.transition(
    id,
    {
      to: "confirmed-malicious",
      actor: "alice",
      reason: "reviewed the evidence",
      validation: {
        reviewer: "alice",
        method: "manual review",
        evidenceRefs: [0],
      },
    },
    FINDING_TIME,
  );
}

function retract(id: string): Promise<IntelFinding> {
  return findings.transition(
    id,
    { to: "retracted", actor: "alice", reason: "false positive" },
    FINDING_TIME,
  );
}

const ALICE_TOKEN = "alice-token";
const BOB_TOKEN = "bob-token";

function reviewersConfig(): Reviewers {
  return createReviewers({
    [hashToken(ALICE_TOKEN)]: "alice",
    [hashToken(BOB_TOKEN)]: "bob",
  });
}

function transitionRequest(
  id: string,
  body: string,
  options: { authorization?: string; contentType?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }
  return get(`/v1/findings/${id}/transitions`, {
    method: "POST",
    headers,
    body,
  });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function findingBody(response: Response): Promise<IntelFinding> {
  const body = (await response.json()) as { finding: IntelFinding };
  return body.finding;
}

async function errorBody(response: Response): Promise<string> {
  const body = (await response.json()) as { error: string };
  return body.error;
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

interface FeedBody {
  entries: { sequence: number; finding: IntelFinding }[];
  lastSequence: number;
}

interface FindingsBody {
  findings: IntelFinding[];
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

interface RecentReleaseRow {
  name: string;
  version: string;
  previousVersion: string | null;
  digest: string;
  analyzedAt: string;
  status: "complete" | "incomplete";
  incompleteReasons: number;
  bySeverity: {
    CRITICAL: number;
    HIGH: number;
    MEDIUM: number;
    LOW: number;
    INFO: number;
  };
}

interface RecentReleasesBody {
  releases: RecentReleaseRow[];
}

interface RecentFindingsBody {
  findings: IntelFinding[];
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
    // Each claim scans the job directory, so seeding 105 jobs is quadratic and slow under load.
  }, 60_000);
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

describe("GET /v1/recent/releases", () => {
  it("returns compact rows ordered by analyzedAt", async () => {
    await start();
    const newer: ReleaseRecord = {
      ...makeRecord("beta", "2.0.0", "sha512-beta"),
      previousVersion: "1.0.0",
      previousDigest: "sha512-old",
      analyzedAt: "2026-02-01T00:00:00.000Z",
      status: "incomplete",
      incompleteReasons: ["dependency analysis failed", "child skipped"],
    };
    const older: ReleaseRecord = {
      ...makeRecord("alpha", "1.0.0", "sha512-alpha"),
      analyzedAt: "2026-01-01T00:00:00.000Z",
    };
    // The older analysis is written last, so mtime alone would pick it first.
    await seedRelease(newer);
    await seedRelease(older);

    const response = await get("/v1/recent/releases");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      releases: [
        {
          name: "beta",
          version: "2.0.0",
          previousVersion: "1.0.0",
          digest: "sha512-beta",
          analyzedAt: "2026-02-01T00:00:00.000Z",
          status: "incomplete",
          incompleteReasons: 2,
          bySeverity: {
            CRITICAL: 0,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 0,
          },
        },
        {
          name: "alpha",
          version: "1.0.0",
          previousVersion: null,
          digest: "sha512-alpha",
          analyzedAt: "2026-01-01T00:00:00.000Z",
          status: "complete",
          incompleteReasons: 0,
          bySeverity: {
            CRITICAL: 0,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 0,
          },
        },
      ],
    });
  });

  it("honors limit and returns an empty list when there are no releases", async () => {
    await start();
    await seedRelease({
      ...makeRecord("alpha", "1.0.0", "sha512-a"),
      analyzedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedRelease({
      ...makeRecord("beta", "2.0.0", "sha512-b"),
      analyzedAt: "2026-02-01T00:00:00.000Z",
    });

    const limited = (await (
      await get("/v1/recent/releases?limit=1")
    ).json()) as RecentReleasesBody;
    expect(limited.releases.map((row) => row.name)).toEqual(["beta"]);
    expect((await get("/v1/recent/releases?limit=200")).status).toBe(200);

    await rm(join(base, "root", "release"), { recursive: true, force: true });
    const empty = (await (
      await get("/v1/recent/releases")
    ).json()) as RecentReleasesBody;
    expect(empty).toEqual({ releases: [] });
  });

  it("rejects a limit that is not an integer from 1 to 200", async () => {
    await start();

    for (const limit of [
      "0",
      "201",
      "-1",
      "1.5",
      "abc",
      "1e2",
      "99999999999999999999",
    ]) {
      const response = await get(`/v1/recent/releases?limit=${limit}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad request" });
    }
  });

  it("returns not found for an unknown recent resource", async () => {
    await start();

    expect((await get("/v1/recent")).status).toBe(404);
    expect((await get("/v1/recent/unknown")).status).toBe(404);
    expect((await get("/v1/recent/releases/extra")).status).toBe(404);
  });
});

describe("GET /v1/recent/findings", () => {
  it("returns the stored findings with evidence and history, newest updated first", async () => {
    await start();
    const older = await seedFinding();
    const newer = await seedFinding({ name: "beta", digest: "sha512-beta" });
    const transitioned = await findings.transition(
      newer.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      new Date("2026-10-02T00:00:00.000Z"),
    );

    const response = await get("/v1/recent/findings");

    expect(response.status).toBe(200);
    const body = (await response.json()) as RecentFindingsBody;
    expect(body.findings.map((finding) => finding.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(body.findings[0]).toEqual(transitioned);
    expect(body.findings[1]).toEqual(older);
    expect(body.findings[0]?.evidence).toEqual(newer.evidence);
    expect(body.findings[0]?.history).toHaveLength(1);
  });

  it("filters by verdict and honors limit", async () => {
    await start();
    const suspected = await seedFinding();
    const reviewed = await seedFinding({
      name: "beta",
      digest: "sha512-beta",
    });
    await findings.transition(
      reviewed.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      new Date("2026-10-02T00:00:00.000Z"),
    );

    const underReview = (await (
      await get("/v1/recent/findings?verdict=under-review")
    ).json()) as RecentFindingsBody;
    expect(underReview.findings.map((finding) => finding.id)).toEqual([
      reviewed.id,
    ]);

    const onlySuspected = (await (
      await get("/v1/recent/findings?verdict=suspected&limit=1")
    ).json()) as RecentFindingsBody;
    expect(onlySuspected.findings.map((finding) => finding.id)).toEqual([
      suspected.id,
    ]);

    const every = (await (
      await get("/v1/recent/findings?limit=200")
    ).json()) as RecentFindingsBody;
    expect(every.findings).toHaveLength(2);
  });

  it("rejects an unknown verdict or an out-of-range limit", async () => {
    await start();

    for (const query of [
      "verdict=exploded",
      "verdict=",
      "limit=0",
      "limit=201",
      "limit=abc",
    ]) {
      const response = await get(`/v1/recent/findings?${query}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad request" });
    }
  });

  it("reads only the 1000 newest record files by modification time", async () => {
    await start();
    const directory = join(base, "root", "finding");
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 1001; index += 1) {
      const id = `CDI-${String(index).padStart(20, "0")}`;
      const record: IntelFinding = {
        ...baseFinding(),
        id,
        name: `pkg-${String(index)}`,
        updatedAt:
          index === 0 ? "2030-01-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
        verdict: index === 0 ? "benign" : "suspected",
      };
      const path = join(directory, `${id}.json`);
      await writeFile(path, `${JSON.stringify(record)}\n`);
      const time = new Date(
        index === 0 ? "1999-01-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      );
      await utimes(path, time, time);
    }

    const excluded = await get("/v1/recent/findings?verdict=benign&limit=1");
    expect(excluded.status).toBe(200);
    await expect(excluded.json()).resolves.toEqual({ findings: [] });

    const included = (await (
      await get("/v1/recent/findings?verdict=suspected&limit=1")
    ).json()) as RecentFindingsBody;
    expect(included.findings).toHaveLength(1);
  }, 30_000);
});

describe("GET /", () => {
  it("serves the page with a CSP whose hashes cover the served bytes and no cookie", async () => {
    await start();

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    expect(body).toBe(STATUS_PAGE_HTML);
    const script = /<script>([\s\S]*)<\/script>/u.exec(body)?.[1];
    const style = /<style>([\s\S]*)<\/style>/u.exec(body)?.[1];
    expect(script).toBe(STATUS_PAGE_SCRIPT);
    expect(style).toBe(STATUS_PAGE_STYLE);
    expect(response.headers.get("content-security-policy")).toBe(
      `default-src 'none'; script-src 'sha256-${sha256(script ?? "")}'; style-src 'sha256-${sha256(style ?? "")}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    );
  });

  it("answers HEAD with the page headers and no body", async () => {
    await start();

    const response = await get("/", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });

  it("serves HTML at no other path", async () => {
    await start();

    for (const path of ["/index.html", "/status", "//"]) {
      const response = await get(path);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
    }

    expect((await get("/v1/recent/releases")).headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("keeps attacker-controlled names, versions and evidence out of the page", async () => {
    await start();
    const image = "<img src=x onerror=alert(1)>";
    const closing = "</script>";
    const name = image + closing;
    const version = `1.0.0${closing}${image}`;
    const release: ReleaseRecord = {
      ...makeRecord(name, version, "sha512-xss"),
      previousVersion: name,
      previousDigest: "sha512-previous",
    };
    await seedRelease(release);
    const finding = await seedFinding({
      name: image,
      version: closing,
      digest: "sha512-xss",
      summary: image + closing,
      evidence: [{ file: image, line: 9, excerpt: closing + image }],
    });

    const releasesText = await (await get("/v1/recent/releases")).text();
    const findingsText = await (await get("/v1/recent/findings")).text();

    // JSON is not HTML: the bytes stay as the store returned them.
    expect(releasesText).toContain(image);
    expect(releasesText).toContain(closing);
    expect(findingsText).toContain(image);
    expect(findingsText).toContain(closing);
    const releaseBody = JSON.parse(releasesText) as RecentReleasesBody;
    expect(releaseBody.releases[0]?.name).toBe(name);
    expect(releaseBody.releases[0]?.version).toBe(version);
    const findingBody = JSON.parse(findingsText) as RecentFindingsBody;
    expect(findingBody.findings[0]?.name).toBe(image);
    expect(findingBody.findings[0]?.summary).toBe(image + closing);
    expect(findingBody.findings[0]?.evidence[0]?.file).toBe(image);
    expect(findingBody.findings[0]?.evidence[0]?.excerpt).toBe(closing + image);

    const page = await (await get("/")).text();
    expect(page).not.toContain(image);
    expect(page).not.toContain(name);
    expect(page).not.toContain(version);
    expect(page).not.toContain(closing + image);
    // The only closing script tag is the page's own.
    expect(page.split(closing)).toHaveLength(2);
    expect(page).not.toContain(finding.id);
    expect(STATUS_PAGE_HTML).not.toContain(image);
    expect(STATUS_PAGE_HTML).not.toContain(name);
    expect(STATUS_PAGE_HTML).not.toContain(version);
    expect(STATUS_PAGE_HTML).not.toContain(closing + image);
    expect(STATUS_PAGE_HTML.split(closing)).toHaveLength(2);
    // The page ships empty mount points, not a server-side row template.
    expect(STATUS_PAGE_HTML).toContain('<tbody id="releases-body"></tbody>');
    expect(STATUS_PAGE_HTML).toContain('<tbody id="findings-body"></tbody>');
    expect(STATUS_PAGE_HTML).toContain('<ol id="feed-list" class="feed"></ol>');
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

describe("GET /v1/findings", () => {
  it("returns the findings stored for a package and version", async () => {
    await start();
    const finding = await seedFinding();
    await seedFinding({ version: "1.0.0", digest: "sha512-old" });
    await seedFinding({ name: "beta", digest: "sha512-beta" });

    const response = await get(
      "/v1/findings?ecosystem=npm&name=alpha&version=2.0.0",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      findings: [finding],
    });
  });

  it("returns the findings stored for a digest", async () => {
    await start();
    const digest = "sha512-abc/def+ghi==";
    const finding = await seedFinding({ digest });
    await seedFinding({ digest: "sha512-other" });

    const response = await get(
      `/v1/findings?ecosystem=npm&digest=${encodeURIComponent(digest)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      findings: [finding],
    });
  });

  it("returns an empty list when nothing matches", async () => {
    await start();

    const response = await get("/v1/findings?ecosystem=npm&name=absent");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ findings: [] });
  });

  it("shows a suspected finding with its verdict", async () => {
    await start();
    await seedFinding();

    const response = await get("/v1/findings?ecosystem=npm&name=alpha");
    const body = (await response.json()) as FindingsBody;

    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]?.verdict).toBe("suspected");
  });

  it("rejects an ecosystem other than npm", async () => {
    await start();

    const response = await get("/v1/findings?ecosystem=pypi&name=alpha");

    expect(response.status).toBe(400);
  });

  it("rejects a request without a name or digest", async () => {
    await start();

    const response = await get("/v1/findings?ecosystem=npm");

    expect(response.status).toBe(400);
  });

  it("returns one finding by id and not found for an unused id", async () => {
    await start();
    const finding = await seedFinding();

    const response = await get(`/v1/findings/${finding.id}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(finding);

    const absent = await get("/v1/findings/CDI-00000000000000000000");
    expect(absent.status).toBe(404);
  });

  it("rejects a malformed finding id", async () => {
    await start();

    const response = await get("/v1/findings/CDI-not-hex");

    expect(response.status).toBe(400);
  });
});

describe("GET /v1/feed", () => {
  it("hides a suspected finding and shows its confirmation and retraction", async () => {
    await start();
    const finding = await seedFinding();

    const suspected = (await (await get("/v1/feed")).json()) as FeedBody;
    expect(suspected).toEqual({ entries: [], lastSequence: 0 });

    await confirm(finding.id);
    const confirmed = (await (await get("/v1/feed")).json()) as FeedBody;
    expect(confirmed.entries).toHaveLength(1);
    expect(confirmed.entries[0]?.sequence).toBe(1);
    expect(confirmed.entries[0]?.finding.verdict).toBe("confirmed-malicious");
    expect(confirmed.lastSequence).toBe(1);

    await retract(finding.id);
    const retracted = (await (await get("/v1/feed")).json()) as FeedBody;
    expect(retracted.entries).toHaveLength(1);
    expect(retracted.entries[0]?.sequence).toBe(2);
    expect(retracted.entries[0]?.finding.verdict).toBe("retracted");
    expect(retracted.lastSequence).toBe(2);
  });

  it("honors since and limit", async () => {
    await start();
    const first = await seedFinding();
    const second = await seedFinding({
      name: "beta",
      digest: "sha512-beta",
    });
    await confirm(first.id);
    await confirm(second.id);

    const page = (await (
      await get("/v1/feed?since=0&limit=1")
    ).json()) as FeedBody;
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.sequence).toBe(1);
    expect(page.lastSequence).toBe(1);

    const next = (await (
      await get(`/v1/feed?since=${String(page.lastSequence)}&limit=1`)
    ).json()) as FeedBody;
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.sequence).toBe(2);
    expect(next.lastSequence).toBe(2);
  });

  it("rejects a negative since or a limit above the maximum", async () => {
    await start();

    expect((await get("/v1/feed?since=-1")).status).toBe(400);
    expect((await get("/v1/feed?since=abc")).status).toBe(400);
    expect((await get("/v1/feed?limit=-1")).status).toBe(400);
    expect((await get("/v1/feed?limit=501")).status).toBe(400);
  });
});

describe("GET /v1/osv/<id>", () => {
  it("returns not found for a suspected finding", async () => {
    await start();
    const finding = await seedFinding();

    const response = await get(`/v1/osv/${finding.id}`);

    expect(response.status).toBe(404);
  });

  it("returns the OSV record after confirmation and on retraction", async () => {
    await start();
    const finding = await seedFinding();
    const confirmed = await confirm(finding.id);

    const response = await get(`/v1/osv/${finding.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      schema_version: string;
      id: string;
      modified: string;
      published: string;
      withdrawn?: string;
    };
    expect(body).toMatchObject({
      schema_version: "1.6.0",
      id: finding.id,
      modified: confirmed.updatedAt,
      published: finding.createdAt,
    });

    const retracted = await retract(finding.id);
    const after = await get(`/v1/osv/${finding.id}`);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { withdrawn?: string };
    expect(afterBody.withdrawn).toBe(retracted.updatedAt);
  });

  it("rejects a malformed id", async () => {
    await start();

    expect((await get("/v1/osv/CDI-nope")).status).toBe(400);
  });
});

describe("POST /v1/findings/<id>/transitions", () => {
  const triage = JSON.stringify({ to: "under-review", reason: "triage" });

  it("does not exist without a reviewers file", async () => {
    await start();
    const finding = await seedFinding();

    const response = await transitionRequest(
      finding.id,
      triage,
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it("still rejects a POST to another path with 405", async () => {
    await start(reviewersConfig());

    const response = await get("/v1/jobs", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("answers 401 for a missing header, a wrong scheme or an unknown token", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    const attempts: { authorization?: string }[] = [
      {},
      { authorization: "Basic abc" },
      bearer("wrong-token"),
      { authorization: "Bearer" },
    ];

    for (const options of attempts) {
      const response = await transitionRequest(finding.id, triage, options);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("moves a finding to under-review and records the reviewer from the token", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();

    const response = await transitionRequest(
      finding.id,
      triage,
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(200);
    const updated = await findingBody(response);
    expect(updated.verdict).toBe("under-review");
    expect(updated.revision).toBe(2);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]).toMatchObject({
      actor: "alice",
      from: "suspected",
      to: "under-review",
      reason: "triage",
    });
    expect(updated.history[0]?.at).toEqual(expect.any(String));
    await expect(findings.get(finding.id)).resolves.toMatchObject({
      verdict: "under-review",
    });
  });

  it("rejects a confirmation without a validation", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    await findings.transition(
      finding.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      FINDING_TIME,
    );

    const response = await transitionRequest(
      finding.id,
      JSON.stringify({ to: "confirmed-malicious", reason: "reviewed" }),
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(409);
    expect(await errorBody(response)).toContain("requires a validation");
  });

  it("confirms with a validation whose reviewer comes from the token", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    await findings.transition(
      finding.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      FINDING_TIME,
    );

    const response = await transitionRequest(
      finding.id,
      JSON.stringify({
        to: "confirmed-malicious",
        reason: "reviewed the evidence",
        validation: { method: "manual review", evidenceRefs: [0] },
      }),
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(200);
    const updated = await findingBody(response);
    expect(updated.verdict).toBe("confirmed-malicious");
    expect(updated.history.at(-1)?.validation).toEqual({
      reviewer: "alice",
      method: "manual review",
      evidenceRefs: [0],
    });
  });

  it("rejects a body that names its own actor or validation reviewer", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    const attempts: { payload: unknown; field: string }[] = [
      {
        payload: { to: "under-review", reason: "triage", actor: "bob" },
        field: "actor",
      },
      {
        payload: {
          to: "confirmed-malicious",
          reason: "reviewed",
          validation: {
            reviewer: "bob",
            method: "manual review",
            evidenceRefs: [0],
          },
        },
        field: "validation.reviewer",
      },
    ];

    for (const { payload, field } of attempts) {
      const response = await transitionRequest(
        finding.id,
        JSON.stringify(payload),
        bearer(ALICE_TOKEN),
      );

      expect(response.status).toBe(400);
      expect(await errorBody(response)).toContain(field);
    }
    await expect(findings.get(finding.id)).resolves.toMatchObject({
      verdict: "suspected",
      revision: 1,
    });
  });

  it("records the token's reviewer when two reviewers send the same body", async () => {
    await start(reviewersConfig());
    const first = await seedFinding();
    const second = await seedFinding({ name: "beta", digest: "sha512-beta" });

    const alice = await transitionRequest(
      first.id,
      triage,
      bearer(ALICE_TOKEN),
    );
    const bob = await transitionRequest(second.id, triage, bearer(BOB_TOKEN));

    expect((await findingBody(alice)).history[0]?.actor).toBe("alice");
    expect((await findingBody(bob)).history[0]?.actor).toBe("bob");
  });

  it("rejects an illegal transition with 409", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();

    const response = await transitionRequest(
      finding.id,
      JSON.stringify({ to: "retracted", reason: "skip ahead" }),
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(409);
    expect(await errorBody(response)).toContain(
      "cannot move from suspected to retracted",
    );
  });

  it("returns 404 for an unknown finding and 400 for a malformed id", async () => {
    await start(reviewersConfig());

    const absent = await transitionRequest(
      `CDI-${"0".repeat(20)}`,
      triage,
      bearer(ALICE_TOKEN),
    );
    expect(absent.status).toBe(404);
    await expect(absent.json()).resolves.toEqual({ error: "not found" });

    const malformed = await transitionRequest(
      "CDI-nope",
      triage,
      bearer(ALICE_TOKEN),
    );
    expect(malformed.status).toBe(400);
  });

  it("rejects a body over 16 KiB with 413", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    const payload = JSON.stringify({
      to: "under-review",
      reason: "a".repeat(17 * 1024),
    });

    const response = await transitionRequest(
      finding.id,
      payload,
      bearer(ALICE_TOKEN),
    );

    expect(response.status).toBe(413);
  });

  it("rejects a missing or non-JSON content type with 400", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();

    for (const contentType of [
      null,
      "text/plain",
      "application/x-www-form-urlencoded",
    ]) {
      const response = await transitionRequest(finding.id, triage, {
        ...bearer(ALICE_TOKEN),
        contentType,
      });

      expect(response.status).toBe(400);
    }
  });

  it("rejects a body that is not a JSON object or breaks the field rules", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    const payloads = [
      "{",
      "[]",
      JSON.stringify({ reason: "triage" }),
      JSON.stringify({ to: "exploded", reason: "triage" }),
      JSON.stringify({ to: "under-review" }),
      JSON.stringify({ to: "under-review", reason: 7 }),
      JSON.stringify({
        to: "under-review",
        reason: "triage",
        validation: { method: "manual" },
      }),
      JSON.stringify({
        to: "under-review",
        reason: "triage",
        validation: { method: "manual", evidenceRefs: ["0"] },
      }),
    ];

    for (const payload of payloads) {
      const response = await transitionRequest(
        finding.id,
        payload,
        bearer(ALICE_TOKEN),
      );

      expect(response.status).toBe(400);
    }
  });

  it("never puts the token in a response, a 500 body or the error hook", async () => {
    await start(reviewersConfig());
    const finding = await seedFinding();
    const success = await transitionRequest(
      finding.id,
      triage,
      bearer(ALICE_TOKEN),
    );
    const unauthorized = await transitionRequest(
      finding.id,
      triage,
      bearer("wrong-token"),
    );

    expect(await success.text()).not.toContain(ALICE_TOKEN);
    expect(await unauthorized.text()).not.toContain("wrong-token");

    const corrupt = baseFinding({ name: "beta", digest: "sha512-beta" });
    await json.put("finding", corrupt.id, "not-a-record");
    const failure = await transitionRequest(
      corrupt.id,
      triage,
      bearer(ALICE_TOKEN),
    );

    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain(ALICE_TOKEN);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(ALICE_TOKEN);
  });
});
