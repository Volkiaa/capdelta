import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCli } from "../cli/run-cli.js";
import type {
  JsonReportLockfileFinding,
  JsonRunReport,
} from "../core/report-contract.js";
import { createApiServer, listenApi } from "./api.js";
import { createFinding, type IntelFinding } from "./intel/finding.js";
import { parseReviewersFile, hashToken } from "./intel/reviewers.js";
import {
  monitorOnce,
  openService,
  type ServiceConfig,
  type ServiceHandles,
} from "./service.js";
import {
  createFakeRegistry,
  REGISTRY_ORIGIN,
  type FakeRegistry,
} from "./test-registry.js";

const execFileAsync = promisify(execFile);

const EVIL = "evil-pkg";
const CLEAN_VERSION = "1.0.0";
const BAD_VERSION = "1.0.1";
const INTEL_FINDING = "intel-confirmed-malicious";
const ALICE_TOKEN = "alice-token";
const BOB_TOKEN = "bob-token";
const NOW = new Date("2026-02-01T00:00:00.000Z");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FindingsBody {
  findings: IntelFinding[];
}

interface FeedBody {
  entries: { sequence: number; finding: IntelFinding }[];
  lastSequence: number;
}

let base: string;
let dataDir: string;
let registry: FakeRegistry;
let handles: ServiceHandles;
let server: Server | undefined;
let origin: string;
let reviewersFile: string;
let repoA: string;
let repoB: string;
let intelId: string;
let badDigest: string;
let localBaseline: unknown;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-intel-e2e-"));
  dataDir = join(base, "data");
  reviewersFile = join(base, "reviewers.json");
  repoA = join(base, "repo-a");
  repoB = join(base, "repo-b");
  server = undefined;
  origin = "";

  await writeFile(
    reviewersFile,
    `${JSON.stringify({
      [hashToken(ALICE_TOKEN)]: "alice",
      [hashToken(BOB_TOKEN)]: "bob",
    })}\n`,
    "utf8",
  );

  registry = createFakeRegistry();
  // The first cycle stores the feed position, so the two publishes below are
  // what the second cycle sees.
  await monitorOnce(serviceConfig());
  registry.publish(EVIL, CLEAN_VERSION);
  registry.publish(EVIL, BAD_VERSION, {
    scripts: { postinstall: "node index.js" },
    indexJs: 'fetch("https://collect.example.test/x");\n',
  });
  const cycle = await monitorOnce(serviceConfig());
  expect(cycle).toMatchObject({ enqueued: 2, done: 2, failed: 0 });

  handles = openService({ dataDir, collector: {} });
  await startApi();

  const cleanIntegrity = await publishedIntegrity(CLEAN_VERSION);
  badDigest = await publishedIntegrity(BAD_VERSION);
  await createRepository(repoA, lockfile(CLEAN_VERSION, cleanIntegrity));
  await createRepository(repoB, lockfile(CLEAN_VERSION, cleanIntegrity));
  await writeLockfile(repoA, lockfile(BAD_VERSION, badDigest));
  await writeLockfile(repoB, lockfile(BAD_VERSION, badDigest));
}, 60_000);

afterAll(async () => {
  await stopApi();
  await rm(base, { recursive: true, force: true });
});

describe("shared intelligence end to end", () => {
  it("keeps an analyzer finding suspected and gates only on local analysis", async () => {
    const { status, body } = await requestJson(findingsQuery(), asFindings);
    expect(status).toBe(200);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(
      body.findings.every((finding) => finding.verdict === "suspected"),
    ).toBe(true);

    await expect(requestJson("/v1/feed", asFeed)).resolves.toMatchObject({
      status: 200,
      body: { entries: [], lastSequence: 0 },
    });

    for (const repo of [repoA, repoB]) {
      const result = await runCli(repo, origin);
      const report = runOf(result);
      expect(result.exitCode).toBe(1);
      expect(report.summary.lockfileFindings).toBe(0);
      expect(report.summary.gateSeverity.CRITICAL).toBeGreaterThan(0);
      expect(intelFindings(report)).toEqual([]);
    }
    localBaseline = localEvidence(runOf(await runCli(repoA, origin)));
  }, 30_000);

  it("needs a reviewer token and a validation to confirm malicious", async () => {
    const { body } = await requestJson(findingsQuery(), asFindings);
    const target = body.findings[0];
    if (target === undefined) throw new Error("expected a suspected finding");
    const path = `/v1/findings/${target.id}/transitions`;
    const confirmation = {
      to: "confirmed-malicious",
      reason: "reviewed the evidence",
    };

    await expect(postJson(path, confirmation)).resolves.toMatchObject({
      status: 401,
      body: { error: "unauthorized" },
    });
    await expect(
      postJson(path, confirmation, ALICE_TOKEN),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      postJson(
        path,
        { to: "under-review", reason: "triage", actor: "alice" },
        ALICE_TOKEN,
      ),
    ).resolves.toMatchObject({ status: 400 });

    const reviewed = await postJson(
      path,
      { to: "under-review", reason: "triage" },
      ALICE_TOKEN,
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.finding).toMatchObject({ verdict: "under-review" });
    expect(reviewed.body.finding?.history.at(-1)?.actor).toBe("alice");

    const unvalidated = await postJson(path, confirmation, ALICE_TOKEN);
    expect(unvalidated.status).toBe(409);
    expect(unvalidated.body.error).toContain("requires a validation");

    const confirmed = await postJson(
      path,
      {
        ...confirmation,
        validation: { method: "manual review", evidenceRefs: [0] },
      },
      ALICE_TOKEN,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.finding).toMatchObject({
      verdict: "confirmed-malicious",
      revision: 3,
    });
    expect(confirmed.body.finding?.history.at(-1)).toMatchObject({
      actor: "alice",
      from: "under-review",
      to: "confirmed-malicious",
      validation: { reviewer: "alice", evidenceRefs: [0] },
    });
    intelId = target.id;
  }, 30_000);

  it("gives two repositories the same confirmed intelligence", async () => {
    const results = [await runCli(repoA, origin), await runCli(repoB, origin)];
    const seen: string[] = [];

    for (const result of results) {
      const report = runOf(result);
      expect(result.exitCode).toBe(1);
      expect(report.summary.lockfileFindings).toBe(1);
      const intel = onlyIntel(report);
      expect(intel).toMatchObject({
        name: EVIL,
        newVersion: BAD_VERSION,
        intelId,
      });
      seen.push(intel.intelId);
    }
    expect(seen).toEqual([intelId, intelId]);

    const osv = await requestJson(`/v1/osv/${intelId}`, asOsv);
    expect(osv.status).toBe(200);
    expect(osv.body).toMatchObject({
      id: intelId,
      schema_version: "1.6.0",
      affected: [
        {
          package: { ecosystem: "npm", name: EVIL },
          versions: [BAD_VERSION],
        },
      ],
      database_specific: { digest: badDigest, verdict: "confirmed-malicious" },
    });

    const feed = await requestJson("/v1/feed", asFeed);
    expect(feed.body.entries).toHaveLength(1);
    expect(feed.body.entries[0]).toMatchObject({
      sequence: 1,
      finding: { id: intelId, verdict: "confirmed-malicious" },
    });
  }, 30_000);

  it("propagates a retraction to both consumers", async () => {
    const retracted = await postJson(
      `/v1/findings/${intelId}/transitions`,
      { to: "retracted", reason: "false positive" },
      BOB_TOKEN,
    );
    expect(retracted.status).toBe(200);
    expect(retracted.body.finding).toMatchObject({ verdict: "retracted" });
    expect(retracted.body.finding?.history.at(-1)?.actor).toBe("bob");

    const results = [await runCli(repoA, origin), await runCli(repoB, origin)];
    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(intelFindings(runOf(result))).toEqual([]);
    }
    const first = results[0];
    if (first === undefined) throw new Error("expected a repo A run");
    expect(localEvidence(runOf(first))).toEqual(localBaseline);

    const feed = await requestJson("/v1/feed?since=1", asFeed);
    expect(feed.body.lastSequence).toBeGreaterThan(1);
    expect(feed.body.entries).toHaveLength(1);
    expect(feed.body.entries[0]).toMatchObject({
      finding: { id: intelId, verdict: "retracted" },
    });
    expect(feed.body.entries[0]?.sequence).toBe(feed.body.lastSequence);
  }, 30_000);

  it("keeps local protection when the service is down", async () => {
    await stopApi();

    for (const repo of [repoA, repoB]) {
      const withIntel = await runCli(repo, origin);
      const withoutIntel = await runCli(repo, null);

      expect(withIntel.stderr).toContain("intelligence service unavailable");
      expect(withIntel.stdout).toBe(withoutIntel.stdout);
      expect(withIntel.exitCode).toBe(withoutIntel.exitCode);
    }
  }, 30_000);

  it("never matches a confirmed finding for a different digest", async () => {
    await startApi();
    const decoy = createFinding(
      {
        ecosystem: "npm",
        name: EVIL,
        version: BAD_VERSION,
        digest: "sha512-inert-decoy-digest-not-the-published-tarball",
        analyzerVersion: "test-analyzer",
        ruleKey: "capability:INSTALL_HOOK:added:inert",
        summary: "inert decoy finding",
        severity: "CRITICAL",
        confidence: "medium",
        evidence: [{ file: "index.js", line: 1, excerpt: "inert" }],
      },
      NOW,
    );
    await handles.findings.putIfAbsent(decoy);
    await handles.findings.transition(
      decoy.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      NOW,
    );
    const confirmed = await handles.findings.transition(
      decoy.id,
      {
        to: "confirmed-malicious",
        actor: "alice",
        reason: "reviewed the inert evidence",
        validation: {
          reviewer: "alice",
          method: "manual review",
          evidenceRefs: [0],
        },
      },
      NOW,
    );
    expect(confirmed.verdict).toBe("confirmed-malicious");

    const decoyFindings = await requestJson(
      `/v1/findings?ecosystem=npm&digest=${encodeURIComponent(decoy.digest)}`,
      asFindings,
    );
    expect(decoyFindings.body.findings).toHaveLength(1);

    for (const repo of [repoA, repoB]) {
      const result = await runCli(repo, origin);
      expect(result.exitCode).toBe(1);
      expect(intelFindings(runOf(result))).toEqual([]);
    }
  }, 30_000);
});

function serviceConfig(): ServiceConfig {
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
    now: () => NOW,
  };
}

/**
 * The lockfile differ accepts only the npmjs host, so the test's fetch boundary
 * serves tarballs from the fake registry and forwards everything else to the
 * real fetch, which the intel client uses to reach the local API.
 */
function fetchImpl(): typeof fetch {
  const npmjsTarball =
    /^https:\/\/registry\.npmjs\.org\/([^/]+)\/-\/\1-(.+)\.tgz$/u;
  return (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith(`${REGISTRY_ORIGIN}/`)) {
      return registry.fetchImpl(url, init);
    }
    const tarball = npmjsTarball.exec(url);
    if (tarball?.[1] !== undefined && tarball[2] !== undefined) {
      return registry.fetchImpl(
        `${REGISTRY_ORIGIN}/tarballs/${tarball[1]}-${tarball[2]}.tgz`,
        init,
      );
    }
    return fetch(input, init);
  };
}

async function runCli(
  cwd: string,
  intelUrl: string | null,
): Promise<CliResult> {
  const argv = ["--base", "HEAD", "--format", "json", "--fail-on", "CRITICAL"];
  if (intelUrl !== null) argv.push("--intel-url", intelUrl);
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(argv, {
    cwd,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    fetchImpl: fetchImpl(),
  });
  return { exitCode, stdout, stderr };
}

function runOf(result: CliResult): JsonRunReport {
  return JSON.parse(result.stdout) as JsonRunReport;
}

function intelFindings(run: JsonRunReport): JsonReportLockfileFinding[] {
  return run.lockfileFindings.filter(
    (finding) => finding.kind === INTEL_FINDING,
  );
}

function onlyIntel(
  run: JsonRunReport,
): JsonReportLockfileFinding & { intelId: string } {
  const matches = intelFindings(run);
  const [first] = matches;
  if (first?.intelId === undefined || matches.length !== 1) {
    throw new Error(
      `expected exactly one intel finding, got ${String(matches.length)}`,
    );
  }
  return { ...first, intelId: first.intelId };
}

/** The local analysis only, so a run with and without intelligence compares equal. */
function localEvidence(run: JsonRunReport): unknown {
  return {
    packages: run.packages,
    lockfileFindings: run.lockfileFindings.filter(
      (finding) => finding.kind !== INTEL_FINDING,
    ),
    skipped: run.skipped,
  };
}

async function publishedIntegrity(version: string): Promise<string> {
  const response = await registry.fetchImpl(`${REGISTRY_ORIGIN}/${EVIL}`);
  if (!response.ok) {
    throw new Error(`the fake registry answered ${String(response.status)}`);
  }
  const body = (await response.json()) as {
    versions: Record<string, { dist: { integrity: string } }>;
  };
  const entry = body.versions[version];
  if (entry === undefined) {
    throw new Error(`the fake registry does not publish ${EVIL}@${version}`);
  }
  return entry.dist.integrity;
}

const npmjsTarball = (version: string): string =>
  `https://registry.npmjs.org/${EVIL}/-/${EVIL}-${version}.tgz`;

function lockfile(
  version: string,
  integrity: string,
): Readonly<Record<string, unknown>> {
  return {
    name: "consumer-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "consumer-fixture", version: "1.0.0" },
      [`node_modules/${EVIL}`]: {
        version,
        resolved: npmjsTarball(version),
        integrity,
      },
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

async function createRepository(
  cwd: string,
  baseLockfile: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "--quiet");
  await git(cwd, "config", "user.email", "inert-fixture@example.invalid");
  await git(cwd, "config", "user.name", "Capdelta inert fixture");
  await writeLockfile(cwd, baseLockfile);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "test: add inert baseline");
}

async function writeLockfile(cwd: string, value: unknown): Promise<void> {
  await writeFile(
    join(cwd, "package-lock.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function requestJson<T>(
  path: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, init);
  return { status: response.status, body: parse(await response.json()) };
}

const asFindings = (value: unknown): FindingsBody => value as FindingsBody;
const asFeed = (value: unknown): FeedBody => value as FeedBody;
const asOsv = (value: unknown): OsvBody => value as OsvBody;
const asTransition = (value: unknown): TransitionReply =>
  value as TransitionReply;

interface OsvBody {
  id: string;
  schema_version: string;
  affected: {
    package: { ecosystem: string; name: string };
    versions: string[];
  }[];
  database_specific: { digest: string; verdict: string };
}

interface TransitionRequest {
  to: string;
  reason: string;
  actor?: string;
  validation?: { method: string; evidenceRefs: number[] };
}

interface TransitionReply {
  finding?: IntelFinding;
  error?: string;
}

function postJson(
  path: string,
  body: TransitionRequest,
  token?: string,
): Promise<{ status: number; body: TransitionReply }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return requestJson(path, asTransition, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const findingsQuery = (): string =>
  `/v1/findings?ecosystem=npm&name=${EVIL}&version=${BAD_VERSION}`;

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

async function startApi(): Promise<void> {
  const reviewers = parseReviewersFile(await readFile(reviewersFile, "utf8"));
  server = createApiServer({
    releases: handles.releases,
    findings: handles.findings,
    queue: handles.queue,
    reviewers,
  });
  const address = await listenApi(server, 0);
  origin = `http://${address.host}:${String(address.port)}`;
}
