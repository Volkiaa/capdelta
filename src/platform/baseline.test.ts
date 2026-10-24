import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChangedPackages } from "../core/capability-analysis-pipeline.js";
import type { JsonReport, JsonRunReport } from "../core/report-contract.js";
import { MAX_IDENTITY_CHARS, MAX_VALUE_CHARS } from "../core/report-builder.js";
import { assessRunSeverity } from "../core/run-severity.js";
import { analyzeRelease, type AnalyzeReleaseDeps } from "./analyze-release.js";
import {
  analyzeAgainstBaseline,
  BaselineError,
  BaselineStore,
  type BaselineRecord,
} from "./baseline.js";
import { encodeKey, JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import { ReleaseStore } from "./release-store.js";

const ANALYZER = "test-analyzer";
const PACKAGE = "slow-roll";

const SOURCES: Record<string, string> = {
  "1.0.0": `function add(a, b) { return a + b; }
module.exports = { add };
`,
  "1.1.0": `function add(a, b) { return a + b; }
function token() { return process.env.NPM_TOKEN; }
module.exports = { add, token };
`,
  "1.2.0": `const https = require("https");
function add(a, b) { return a + b; }
function token() { return process.env.NPM_TOKEN; }
function ping() { https.get("https://telemetry.example.test/collect"); }
module.exports = { add, token, ping };
`,
  "1.3.0": `const fs = require("fs");
const https = require("https");
function add(a, b) { return a + b; }
function token() { return process.env.NPM_TOKEN; }
function ping() { https.get("https://telemetry.example.test/collect"); }
function readConfig() { return fs.readFileSync("/home/user/.npmrc", "utf8"); }
module.exports = { add, token, ping, readConfig };
`,
};

interface BuiltArtifact {
  version: string;
  url: string;
  bytes: Uint8Array;
  digest: string;
}

let base: string;
let json: JsonStore;
let releases: ReleaseStore;
let baselines: BaselineStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-baseline-"));
  json = new JsonStore({ root: base });
  releases = new ReleaseStore(json);
  baselines = new BaselineStore(json);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function record(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name: PACKAGE,
    version: "1.0.0",
    digest: "sha512-reviewed",
    tarballUrl: "https://registry.npmjs.org/slow-roll/-/slow-roll-1.0.0.tgz",
    reviewedBy: "reviewer@example.test",
    reviewedAt: "2026-10-24T09:00:00.000Z",
    note: "first review",
    ...overrides,
  };
}

async function buildArtifact(
  work: string,
  version: string,
  source: string,
): Promise<BuiltArtifact> {
  const directory = join(work, `${PACKAGE}-${version}`);
  await mkdir(join(directory, "package"), { recursive: true });
  await writeFile(
    join(directory, "package", "package.json"),
    `${JSON.stringify({ name: PACKAGE, version, main: "index.js" })}\n`,
    "utf8",
  );
  await writeFile(join(directory, "package", "index.js"), source, "utf8");

  const archive = join(directory, `${PACKAGE}-${version}.tgz`);
  await tar.c(
    {
      cwd: directory,
      file: archive,
      gzip: true,
      portable: true,
      mtime: new Date(0),
    },
    ["package"],
  );
  const bytes = await readFile(archive);
  return {
    version,
    url: `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`,
    bytes,
    digest: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function source(version: string): string {
  const value = SOURCES[version];
  if (value === undefined) throw new Error(`no source for ${version}`);
  return value;
}

function fakeFetch(artifacts: readonly BuiltArtifact[]): typeof fetch {
  const byUrl = new Map(artifacts.map((item) => [item.url, item.bytes]));
  return (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const bytes = byUrl.get(url);
    if (bytes === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  };
}

function candidate(
  artifacts: ReadonlyMap<string, BuiltArtifact>,
  version: string,
  previousVersion: string | null,
): ReleaseCandidate {
  const current = artifacts.get(version);
  if (current === undefined) throw new Error(`no artifact for ${version}`);
  const previous =
    previousVersion === null ? undefined : artifacts.get(previousVersion);
  if (previousVersion !== null && previous === undefined) {
    throw new Error(`no artifact for ${previousVersion}`);
  }
  return {
    ecosystem: "npm",
    name: PACKAGE,
    version,
    digest: current.digest,
    tarballUrl: current.url,
    previous:
      previous === undefined
        ? null
        : {
            version: previous.version,
            digest: previous.digest,
            tarballUrl: previous.url,
          },
    publishedAt: "2026-10-24T00:00:00.000Z",
  };
}

function plainCandidate(
  version: string,
  previousVersion: string | null,
): ReleaseCandidate {
  return {
    ecosystem: "npm",
    name: PACKAGE,
    version,
    digest: `sha512-${version}`,
    tarballUrl: `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`,
    previous:
      previousVersion === null
        ? null
        : {
            version: previousVersion,
            digest: `sha512-${previousVersion}`,
            tarballUrl: `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${previousVersion}.tgz`,
          },
    publishedAt: "2026-10-24T00:00:00.000Z",
  };
}

function deps(
  fetchImpl: typeof fetch,
  analyze: NonNullable<AnalyzeReleaseDeps["analyze"]> = analyzeChangedPackages,
): AnalyzeReleaseDeps {
  return {
    store: releases,
    analyze,
    analyzeOptions: { fetcher: { fetchImpl } },
    analyzerVersion: ANALYZER,
  };
}

function onlyReport(report: JsonRunReport): JsonReport {
  const item = report.packages[0];
  if (item?.status !== "analyzed") {
    throw new Error("expected one analyzed package");
  }
  return item.report;
}

function highest(
  report: JsonRunReport,
): ReturnType<typeof assessRunSeverity>["highest"] {
  return assessRunSeverity(report).highest;
}

describe("BaselineStore", () => {
  it("stores a baseline that can be read back with its history", async () => {
    const first = record();

    await baselines.set(first);

    await expect(baselines.get(PACKAGE)).resolves.toEqual(first);
    await expect(baselines.history(PACKAGE)).resolves.toEqual([first]);
  });

  it("keeps every replaced baseline in oldest-first history", async () => {
    const first = record();
    const second = record({
      version: "1.1.0",
      digest: "sha512-second",
      reviewedAt: "2026-10-24T10:00:00.000Z",
      note: "second review",
    });

    await baselines.set(first);
    await baselines.set(second);

    await expect(baselines.get(PACKAGE)).resolves.toEqual(second);
    await expect(baselines.history(PACKAGE)).resolves.toEqual([first, second]);
  });

  it("orders history by review time even when reviews arrive out of order", async () => {
    const later = record({ reviewedAt: "2026-10-24T12:00:00.000Z" });
    const earlier = record({
      version: "0.9.0",
      digest: "sha512-earlier",
      reviewedAt: "2026-10-24T08:00:00.000Z",
    });

    await baselines.set(later);
    await baselines.set(earlier);

    await expect(baselines.history(PACKAGE)).resolves.toEqual([earlier, later]);
  });

  it("throws BaselineError for a stored record with the wrong shape", async () => {
    await json.put("baseline", encodeKey(PACKAGE), {
      schemaVersion: 1,
      ecosystem: "pypi",
      name: PACKAGE,
      version: "1.0.0",
      digest: "sha512-reviewed",
      tarballUrl: "https://registry.npmjs.org/slow-roll/-/slow-roll-1.0.0.tgz",
      reviewedBy: "reviewer@example.test",
      reviewedAt: "2026-10-24T09:00:00.000Z",
      note: "wrong ecosystem",
    });

    await expect(baselines.get(PACKAGE)).rejects.toBeInstanceOf(BaselineError);
  });

  it("throws BaselineError for a corrupt history entry", async () => {
    await json.put("baseline-history", encodeKey("entry"), {
      schemaVersion: 1,
      ecosystem: "npm",
      name: PACKAGE,
      version: "1.0.0",
    });

    await expect(baselines.history(PACKAGE)).rejects.toBeInstanceOf(
      BaselineError,
    );
  });

  it("rejects a malformed record before writing it", async () => {
    const malformed = {
      ...record(),
      ecosystem: "pypi",
    } as unknown as BaselineRecord;

    await expect(baselines.set(malformed)).rejects.toBeInstanceOf(
      BaselineError,
    );
    await expect(baselines.get(PACKAGE)).resolves.toBeNull();
    await expect(baselines.history(PACKAGE)).resolves.toEqual([]);
  });

  it("truncates the reviewer identity and note before storing them", async () => {
    const longIdentity = "i".repeat(400);
    const longNote = "n".repeat(400);

    await baselines.set(record({ reviewedBy: longIdentity, note: longNote }));

    const stored = await baselines.get(PACKAGE);
    expect(stored?.reviewedBy).toHaveLength(MAX_IDENTITY_CHARS);
    expect(stored?.note).toHaveLength(MAX_VALUE_CHARS);
  });
});

describe("analyzeAgainstBaseline", () => {
  it("returns null when the package has no baseline", async () => {
    let calls = 0;
    const result = await analyzeAgainstBaseline(
      plainCandidate("1.1.0", "1.0.0"),
      baselines,
      deps(() => {
        calls += 1;
        return Promise.reject(new Error("must not fetch without a baseline"));
      }),
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns null when the candidate is the baseline version", async () => {
    await baselines.set(record());
    let calls = 0;

    const result = await analyzeAgainstBaseline(
      plainCandidate("1.0.0", null),
      baselines,
      deps(() => {
        calls += 1;
        return Promise.reject(new Error("must not re-analyze the baseline"));
      }),
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("stores one cumulative record when called twice with the same release", async () => {
    const work = await mkdtemp(join(tmpdir(), "capdelta-baseline-artifacts-"));
    try {
      const artifact = await buildArtifact(work, "1.1.0", source("1.1.0"));
      const artifacts = new Map([["1.1.0", artifact]]);
      await baselines.set(
        record({ digest: artifact.digest, tarballUrl: artifact.url }),
      );
      let calls = 0;
      const analyze: NonNullable<AnalyzeReleaseDeps["analyze"]> = (
        diff,
        options,
      ) => {
        calls += 1;
        return analyzeChangedPackages(diff, options);
      };

      const first = await analyzeAgainstBaseline(
        candidate(artifacts, "1.1.0", null),
        baselines,
        deps(fakeFetch([artifact]), analyze),
      );
      const second = await analyzeAgainstBaseline(
        candidate(artifacts, "1.1.0", null),
        baselines,
        deps(fakeFetch([artifact]), analyze),
      );

      expect(first?.created).toBe(true);
      expect(second?.created).toBe(false);
      expect(second?.record).toEqual(first?.record);
      expect(calls).toBe(1);
      await expect(releases.listKeys()).resolves.toHaveLength(1);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("shows the cumulative drift that every single step hides", async () => {
    const work = await mkdtemp(join(tmpdir(), "capdelta-baseline-artifacts-"));
    try {
      const artifacts = new Map<string, BuiltArtifact>();
      for (const [version, source] of Object.entries(SOURCES)) {
        artifacts.set(version, await buildArtifact(work, version, source));
      }
      const fetchImpl = fakeFetch([...artifacts.values()]);
      const reviewed = artifacts.get("1.0.0");
      if (reviewed === undefined) throw new Error("missing 1.0.0 artifact");
      await baselines.set(
        record({ digest: reviewed.digest, tarballUrl: reviewed.url }),
      );

      const steps = [
        ["1.1.0", "1.0.0"],
        ["1.2.0", "1.1.0"],
        ["1.3.0", "1.2.0"],
      ] as const;
      const stepwise: JsonRunReport[] = [];
      for (const [version, previousVersion] of steps) {
        const { record: release } = await analyzeRelease(
          candidate(artifacts, version, previousVersion),
          deps(fetchImpl),
        );
        stepwise.push(release.report);
      }

      // Observed stepwise severities: an env read, a network call, then a
      // sensitive file read. None of them alone reaches CRITICAL.
      expect(stepwise.map((report) => report.summary.gateSeverity)).toEqual([
        { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0, INFO: 0 },
        { CRITICAL: 0, HIGH: 2, MEDIUM: 0, LOW: 0, INFO: 0 },
        { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1, INFO: 0 },
      ]);
      expect(stepwise.map((report) => highest(report))).toEqual([
        "MEDIUM",
        "HIGH",
        "HIGH",
      ]);

      const cumulative = await analyzeAgainstBaseline(
        candidate(artifacts, "1.3.0", "1.2.0"),
        baselines,
        deps(fetchImpl),
      );
      expect(cumulative).not.toBeNull();
      if (cumulative === null) throw new Error("missing cumulative record");

      expect(cumulative.created).toBe(true);
      expect(cumulative.record.previousVersion).toBe("1.0.0");
      expect(cumulative.record.previousDigest).toBe(reviewed.digest);
      expect(highest(cumulative.record.report)).toBe("CRITICAL");
      expect(cumulative.record.report.summary.gateSeverity.CRITICAL).toBe(3);

      const cumulativeShapes =
        onlyReport(cumulative.record.report).shapes ?? [];
      expect(cumulativeShapes).toContainEqual(
        expect.objectContaining({ ruleId: "secret-exfiltration" }),
      );
      for (const report of stepwise) {
        const shapes = onlyReport(report).shapes ?? [];
        expect(shapes.map((shape) => shape.ruleId)).not.toContain(
          "secret-exfiltration",
        );
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);
});
