import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnalysisBudgetSummary,
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "../core/capability-analysis-pipeline.js";
import type {
  ChangedPackage,
  LockfileDiffResult,
} from "../core/contract/lockfile-diff.js";
import { REPORT_SCHEMA_VERSION } from "../core/report-contract.js";
import {
  analyzeArtifact,
  analyzeRelease,
  TransientAnalysisError,
  type AnalyzeReleaseDeps,
} from "./analyze-release.js";
import { ANALYZER_VERSION } from "./analyzer-version.js";
import { JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import { ReleaseStore } from "./release-store.js";

const CANDIDATE: ReleaseCandidate = {
  ecosystem: "npm",
  name: "alpha",
  version: "2.0.0",
  digest: "sha512-new",
  tarballUrl: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
  previous: {
    version: "1.0.0",
    digest: "sha512-old",
    tarballUrl: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
  },
  publishedAt: "2026-01-01T00:00:00.000Z",
};

let base: string;
let store: ReleaseStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-analyze-release-"));
  store = new ReleaseStore(new JsonStore({ root: base }));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function only(diff: LockfileDiffResult): ChangedPackage {
  const changed = diff.changed[0];
  if (changed === undefined) {
    throw new Error("fake analyze received no changed package");
  }
  return changed;
}

function analyzedRun(
  changed: ChangedPackage,
  budget?: AnalysisBudgetSummary,
): CapabilityAnalysisRun {
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
    ...(budget === undefined ? {} : { budget }),
  };
}

function unavailableRun(
  changed: ChangedPackage,
  failure: PackageAnalysisFailure,
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
    packages: [
      {
        status: "unavailable",
        changedPackage: changed,
        failures: [failure],
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

function fakeAnalyze(
  build: (changed: ChangedPackage) => CapabilityAnalysisRun,
): {
  analyze: NonNullable<AnalyzeReleaseDeps["analyze"]>;
  calls: LockfileDiffResult[];
} {
  const calls: LockfileDiffResult[] = [];
  return {
    calls,
    analyze: (diff) => {
      calls.push(diff);
      return Promise.resolve(build(only(diff)));
    },
  };
}

function at(iso: string): () => Date {
  return () => new Date(iso);
}

describe("analyzeRelease", () => {
  it("stores a complete record for one release", async () => {
    const { analyze, calls } = fakeAnalyze(analyzedRun);

    const result = await analyzeRelease(CANDIDATE, {
      store,
      analyze,
      now: at("2026-02-03T04:05:06.000Z"),
    });

    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: 1,
      ecosystem: "npm",
      name: "alpha",
      version: "2.0.0",
      digest: "sha512-new",
      previousVersion: "1.0.0",
      previousDigest: "sha512-old",
      analyzerVersion: ANALYZER_VERSION,
      analyzedAt: "2026-02-03T04:05:06.000Z",
      status: "complete",
      incompleteReasons: [],
    });
    expect(result.record.report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      firstRun: false,
      findings: [],
      skipped: [],
    });
    expect(calls[0]?.changed).toEqual([
      {
        name: "alpha",
        oldVersion: "1.0.0",
        newVersion: "2.0.0",
        oldIntegrity: "sha512-old",
        newIntegrity: "sha512-new",
        oldResolvedUrl: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
        resolvedUrl: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
      },
    ]);
    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toEqual([
      result.record,
    ]);
  });

  it("returns the stored record on a second call without analyzing again", async () => {
    const { analyze, calls } = fakeAnalyze(analyzedRun);

    const first = await analyzeRelease(CANDIDATE, {
      store,
      analyze,
      now: at("2026-01-01T00:00:00.000Z"),
    });
    const second = await analyzeRelease(CANDIDATE, {
      store,
      analyze,
      now: at("2026-06-01T00:00:00.000Z"),
    });

    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(calls).toHaveLength(1);
    await expect(store.listKeys()).resolves.toHaveLength(1);
  });

  it("stores a second record under a different analyzer version", async () => {
    const { analyze, calls } = fakeAnalyze(analyzedRun);

    const first = await analyzeRelease(CANDIDATE, { store, analyze });
    const second = await analyzeRelease(CANDIDATE, {
      store,
      analyze,
      analyzerVersion: "capdelta-engine-2",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.record.analyzerVersion).toBe("capdelta-engine-2");
    expect(calls).toHaveLength(2);
    await expect(store.listKeys()).resolves.toHaveLength(2);
    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toHaveLength(
      2,
    );
  });

  it("stores an unavailable package as incomplete and keeps the failure in the report", async () => {
    const failure: PackageAnalysisFailure = {
      stage: "new-extraction",
      failure: {
        kind: "invalid-archive",
        detail: "archive is not a gzip file",
      },
    };
    const { analyze } = fakeAnalyze((changed) =>
      unavailableRun(changed, failure),
    );

    const { record } = await analyzeRelease(CANDIDATE, { store, analyze });

    expect(record.status).toBe("incomplete");
    expect(record.incompleteReasons).toEqual([
      "new-extraction: invalid-archive",
    ]);
    const [item] = record.report.packages;
    expect(item?.status).toBe("unavailable");
    if (item?.status !== "unavailable") {
      throw new Error("expected an unavailable package in the report");
    }
    expect(item.failures[0]).toMatchObject({
      stage: "new-extraction",
      kind: "invalid-archive",
      severity: "CRITICAL",
    });
  });

  it("throws TransientAnalysisError and stores nothing on an operational failure", async () => {
    const failure: PackageAnalysisFailure = {
      stage: "fetch",
      failure: {
        side: "new",
        kind: "timeout",
        detail: "fetch timed out",
        url: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
      },
    };
    const { analyze } = fakeAnalyze((changed) =>
      unavailableRun(changed, failure),
    );

    await expect(
      analyzeRelease(CANDIDATE, { store, analyze }),
    ).rejects.toBeInstanceOf(TransientAnalysisError);
    await expect(store.listKeys()).resolves.toEqual([]);
  });

  it("stores exactly one record when two calls analyze concurrently", async () => {
    const { analyze, calls } = fakeAnalyze(analyzedRun);

    const results = await Promise.all([
      analyzeRelease(CANDIDATE, { store, analyze }),
      analyzeRelease(CANDIDATE, { store, analyze }),
    ]);

    expect(calls.length).toBeLessThanOrEqual(2);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    await expect(store.listKeys()).resolves.toHaveLength(1);
    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toHaveLength(
      1,
    );
    await expect(store.findByDigest("sha512-new")).resolves.toHaveLength(1);
  });
});

describe("analyzeArtifact", () => {
  it("analyzes a first release as a full capability snapshot", async () => {
    const { analyze, calls } = fakeAnalyze(analyzedRun);

    const { record, created } = await analyzeArtifact(CANDIDATE, {
      store,
      analyze,
    });

    expect(created).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.changed).toEqual([
      {
        name: "alpha",
        oldVersion: null,
        newVersion: "2.0.0",
        oldIntegrity: null,
        newIntegrity: "sha512-new",
        oldResolvedUrl: null,
        resolvedUrl: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
      },
    ]);
    expect(record.previousVersion).toBeNull();
    expect(record.previousDigest).toBeNull();
    expect(CANDIDATE.previous).not.toBeNull();
    await expect(store.findByDigest("sha512-new")).resolves.toHaveLength(1);
  });
});
