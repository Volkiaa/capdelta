import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisResult,
} from "../core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../core/contract/lockfile-diff.js";
import { buildRunReport } from "../core/report-builder.js";
import { encodeKey, JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import {
  ReleaseStore,
  ReleaseStoreError,
  releaseKey,
  type ReleaseRecord,
} from "./release-store.js";

const ANALYZER = "test-analyzer";

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
let json: JsonStore;
let store: ReleaseStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-release-store-"));
  json = new JsonStore({ root: base });
  store = new ReleaseStore(json);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function changedPackage(): ChangedPackage {
  return {
    name: CANDIDATE.name,
    oldVersion: CANDIDATE.previous?.version ?? null,
    newVersion: CANDIDATE.version,
    oldIntegrity: CANDIDATE.previous?.digest ?? null,
    newIntegrity: CANDIDATE.digest,
    oldResolvedUrl: CANDIDATE.previous?.tarballUrl ?? null,
    resolvedUrl: CANDIDATE.tarballUrl,
  };
}

function analyzedRun(): CapabilityAnalysisRun {
  const changed = changedPackage();
  const item: PackageAnalysisResult = {
    status: "analyzed",
    changedPackage: changed,
    diff: {
      baseline: { ecosystem: "npm", name: changed.name, version: "1.0.0" },
      subject: {
        ecosystem: "npm",
        name: changed.name,
        version: changed.newVersion,
      },
      newPackage: false,
      findings: [],
      diagnostics: [],
    },
    issues: [],
    baselineFailures: [],
  };
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
    packages: [item],
    lockfileFindings: [],
    skipped: [],
  };
}

function makeRecord(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name: CANDIDATE.name,
    version: CANDIDATE.version,
    digest: CANDIDATE.digest,
    previousVersion: CANDIDATE.previous?.version ?? null,
    previousDigest: CANDIDATE.previous?.digest ?? null,
    analyzerVersion: ANALYZER,
    analyzedAt: "2026-01-01T00:00:00.000Z",
    status: "complete",
    incompleteReasons: [],
    report: buildRunReport(analyzedRun()),
    ...overrides,
  };
}

const RECORD_KEY = releaseKey(CANDIDATE, ANALYZER);

describe("releaseKey", () => {
  it("is stable for the same identity and changes with any identity field", () => {
    expect(releaseKey(CANDIDATE, ANALYZER)).toBe(RECORD_KEY);
    expect(releaseKey({ ...CANDIDATE }, ANALYZER)).toBe(RECORD_KEY);
    expect(releaseKey(CANDIDATE, "another-analyzer")).not.toBe(RECORD_KEY);
    expect(
      releaseKey({ ...CANDIDATE, digest: "sha512-other" }, ANALYZER),
    ).not.toBe(RECORD_KEY);
    expect(releaseKey({ ...CANDIDATE, previous: null }, ANALYZER)).not.toBe(
      RECORD_KEY,
    );
    expect(
      releaseKey(
        {
          ...CANDIDATE,
          previous:
            CANDIDATE.previous === null
              ? null
              : { ...CANDIDATE.previous, digest: "sha512-previous-other" },
        },
        ANALYZER,
      ),
    ).not.toBe(RECORD_KEY);
  });
});

describe("ReleaseStore", () => {
  it("returns the record it stored", async () => {
    const record = makeRecord();

    await expect(store.putIfAbsent(record)).resolves.toBe(true);
    await expect(store.get(RECORD_KEY)).resolves.toEqual(record);
    await expect(store.listKeys()).resolves.toEqual([RECORD_KEY]);
  });

  it("returns null for a missing record", async () => {
    await expect(store.get("absent")).resolves.toBeNull();
  });

  it("keeps the first record when the same key is stored twice", async () => {
    const first = makeRecord({ analyzedAt: "2026-01-01T00:00:00.000Z" });
    const second = makeRecord({ analyzedAt: "2026-02-02T00:00:00.000Z" });

    await expect(store.putIfAbsent(first)).resolves.toBe(true);
    await expect(store.putIfAbsent(second)).resolves.toBe(false);
    await expect(store.get(RECORD_KEY)).resolves.toEqual(first);
  });

  it("finds a record by version and by digest", async () => {
    const record = makeRecord();
    await store.putIfAbsent(record);

    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toEqual([
      record,
    ]);
    await expect(store.findByDigest("sha512-new")).resolves.toEqual([record]);
    await expect(store.findByVersion("alpha", "9.9.9")).resolves.toEqual([]);
    await expect(store.findByDigest("sha512-absent")).resolves.toEqual([]);
  });

  it("repairs both index entries when the record already exists", async () => {
    const record = makeRecord();
    await json.put("release", RECORD_KEY, record);

    await expect(store.putIfAbsent(record)).resolves.toBe(false);
    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toEqual([
      record,
    ]);
    await expect(store.findByDigest("sha512-new")).resolves.toEqual([record]);
  });

  it("skips an index entry whose record is missing", async () => {
    await json.put("release-by-version", encodeKey("alpha@2.0.0"), {
      keys: ["missing-record", RECORD_KEY],
    });
    const record = makeRecord();
    await json.put("release", RECORD_KEY, record);

    await expect(store.findByVersion("alpha", "2.0.0")).resolves.toEqual([
      record,
    ]);
  });

  it.each([
    ["a wrong schema version", { schemaVersion: 2 }],
    ["an unknown status", { status: "partial" }],
    ["a non-string name", { name: 7 }],
    ["a missing report schema", { report: {} }],
    ["a previous digest without a previous version", { previousVersion: null }],
  ])("raises ReleaseStoreError for %s", async (_label, patch) => {
    await json.put("release", RECORD_KEY, { ...makeRecord(), ...patch });

    const failure = await store
      .get(RECORD_KEY)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReleaseStoreError);
    expect(String(failure)).toContain(RECORD_KEY);
  });

  it("raises ReleaseStoreError for a corrupt index", async () => {
    await json.put("release-by-digest", encodeKey("sha512-new"), {
      keys: "not-a-list",
    });

    await expect(store.findByDigest("sha512-new")).rejects.toBeInstanceOf(
      ReleaseStoreError,
    );
  });
});
