import { describe, expect, it } from "vitest";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import {
  EvalCorpusError,
  EvalMetricsError,
  assignHeldOut,
  computeMetrics,
  parseCorpus,
  renderReport,
  wilsonInterval,
  type EntryResult,
  type EvalCorpus,
  type EvalEntry,
  type ResultOverride,
} from "./eval-metrics.js";

const pair: ChangedPackage = {
  name: "pkg",
  oldVersion: "1.0.0",
  newVersion: "1.0.1",
  oldIntegrity: "sha512-old",
  newIntegrity: "sha512-new",
  oldResolvedUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
  resolvedUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.1.tgz",
};

function realEntry(
  id: string,
  label: "malicious" | "benign",
  heldOut: boolean,
): EvalEntry {
  return {
    id,
    label,
    source: "assumed benign: test fixture",
    provenance: "real-registry",
    heldOut,
    pair,
  };
}

function override(
  counts: Partial<Record<keyof ResultOverride["gateSeverity"], number>>,
  incomplete = false,
): ResultOverride {
  return {
    gateSeverity: {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
      ...counts,
    },
    incomplete,
  };
}

function syntheticEntry(
  id: string,
  label: "malicious" | "benign",
  heldOut: boolean,
  resultOverride: ResultOverride,
): EvalEntry {
  return {
    id,
    label,
    source: "https://example.test/advisory",
    provenance: "synthetic-reconstruction",
    heldOut,
    resultOverride,
  };
}

function result(
  id: string,
  analyzed: boolean,
  gateCritical: boolean,
  maxSeverity: EntryResult["maxSeverity"],
  incomplete = false,
): EntryResult {
  return { id, analyzed, gateCritical, maxSeverity, incomplete };
}

function rawCorpus(entries: unknown[]): unknown {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-01T00:00:00Z",
    splitRule: "sha256(salt + id) below the fraction",
    entries,
  };
}

function rawRealEntry(id: string): unknown {
  return {
    id,
    label: "benign",
    source: "assumed benign: test fixture",
    provenance: "real-registry",
    heldOut: false,
    pair,
  };
}

describe("parseCorpus", () => {
  it("accepts a real pair and a synthetic override", () => {
    const corpus = parseCorpus(
      rawCorpus([
        rawRealEntry("benign:pkg@1.0.0->1.0.1"),
        {
          id: "malicious:fixture@1->2",
          label: "malicious",
          source: "https://example.test/advisory",
          provenance: "synthetic-reconstruction",
          heldOut: true,
          resultOverride: override({ CRITICAL: 1 }),
        },
      ]),
    );

    expect(corpus.entries).toHaveLength(2);
    expect(corpus.entries[0]?.pair).toEqual(pair);
    expect(corpus.entries[1]?.pair).toBeUndefined();
    expect(corpus.entries[1]?.resultOverride?.gateSeverity.CRITICAL).toBe(1);
  });

  it("rejects a duplicate id and names the entry", () => {
    const corpus = rawCorpus([
      rawRealEntry("benign:pkg@1.0.0->1.0.1"),
      rawRealEntry("benign:pkg@1.0.0->1.0.1"),
    ]);

    expect(() => parseCorpus(corpus)).toThrow(EvalCorpusError);
    expect(() => parseCorpus(corpus)).toThrow(/benign:pkg@1\.0\.0->1\.0\.1/u);
    expect(() => parseCorpus(corpus)).toThrow(/duplicate id/u);
  });

  it("rejects a real-registry entry without a pair", () => {
    const corpus = rawCorpus([
      {
        id: "benign:no-pair@1->2",
        label: "benign",
        source: "assumed benign: test fixture",
        provenance: "real-registry",
        heldOut: false,
      },
    ]);

    expect(() => parseCorpus(corpus)).toThrow(
      /real-registry entry needs a pair/u,
    );
  });

  it("rejects an unknown label", () => {
    const corpus = rawCorpus([
      {
        ...(rawRealEntry("benign:bad-label@1->2") as object),
        label: "suspicious",
      },
    ]);

    expect(() => parseCorpus(corpus)).toThrow(
      /label must be "malicious" or "benign"/u,
    );
  });

  it("accepts a synthetic entry without a pair or override", () => {
    const corpus = parseCorpus(
      rawCorpus([
        {
          id: "malicious:no-override@1->2",
          label: "malicious",
          source: "https://example.test/advisory",
          provenance: "synthetic-reconstruction",
          heldOut: true,
        },
      ]),
    );

    expect(corpus.entries[0]?.pair).toBeUndefined();
    expect(corpus.entries[0]?.resultOverride).toBeUndefined();
  });
});

describe("assignHeldOut", () => {
  const base = Array.from({ length: 1000 }, (_, index) => ({
    id: `entry-${String(index)}`,
    label: "benign" as const,
    source: "assumed benign: test fixture",
    provenance: "real-registry" as const,
    pair,
  }));

  it("is deterministic for the same salt and fraction", () => {
    const first = assignHeldOut(base, { fraction: 0.2, salt: "salt-a" });
    const second = assignHeldOut(base, { fraction: 0.2, salt: "salt-a" });

    expect(first.map((entry) => entry.heldOut)).toEqual(
      second.map((entry) => entry.heldOut),
    );
  });

  it("keeps the held-out fraction within five percent on 1000 ids", () => {
    const assigned = assignHeldOut(base, { fraction: 0.2, salt: "salt-a" });
    const heldOut = assigned.filter((entry) => entry.heldOut).length;

    expect(heldOut).toBeGreaterThan(150);
    expect(heldOut).toBeLessThan(250);
  });

  it("changes the split when the salt changes", () => {
    const first = assignHeldOut(base, { fraction: 0.2, salt: "salt-a" });
    const second = assignHeldOut(base, { fraction: 0.2, salt: "salt-b" });

    expect(second.map((entry) => entry.heldOut)).not.toEqual(
      first.map((entry) => entry.heldOut),
    );
  });
});

describe("computeMetrics", () => {
  const entries: EvalEntry[] = [
    realEntry("malicious:a@1->2", "malicious", false),
    realEntry("malicious:b@1->2", "malicious", true),
    realEntry("benign:c@1->2", "benign", false),
    syntheticEntry("benign:d@1->2", "benign", true, override({ CRITICAL: 1 })),
    syntheticEntry("malicious:e@1->2", "malicious", false, override({}, true)),
    realEntry("benign:f@1->2", "benign", true),
  ];
  const results: EntryResult[] = [
    result("malicious:a@1->2", true, true, "CRITICAL"),
    result("malicious:b@1->2", true, false, "LOW"),
    result("benign:c@1->2", true, false, "HIGH"),
    result("benign:d@1->2", true, true, "CRITICAL"),
    result("malicious:e@1->2", true, false, "NONE", true),
    result("benign:f@1->2", false, true, "NONE", true),
  ];

  it("counts recall, gate recall and false positives over analyzed entries", () => {
    const metrics = computeMetrics(entries, results);

    expect(metrics.all).toEqual({
      total: 6,
      analyzed: 5,
      incompleteRate: 2 / 6,
      recall: { detected: 1, of: 3, rate: 1 / 3 },
      recallAtGate: { detected: 1, of: 3, rate: 1 / 3 },
      falsePositive: { flagged: 2, of: 2, rate: 1 },
      falsePositiveAtGate: { flagged: 1, of: 2, rate: 0.5 },
      missed: ["malicious:b@1->2", "malicious:e@1->2"],
      falsePositiveIds: ["benign:c@1->2", "benign:d@1->2"],
    });
    expect(metrics.heldOut).toMatchObject({
      total: 3,
      analyzed: 2,
      recall: { detected: 0, of: 1, rate: 0 },
      falsePositive: { flagged: 1, of: 1, rate: 1 },
      missed: ["malicious:b@1->2"],
      falsePositiveIds: ["benign:d@1->2"],
    });
    expect(metrics.development).toMatchObject({
      total: 3,
      analyzed: 3,
      recall: { detected: 1, of: 2, rate: 0.5 },
      falsePositive: { flagged: 1, of: 1, rate: 1 },
    });
    expect(metrics.byProvenance["real-registry"]?.total).toBe(4);
    expect(metrics.byProvenance["synthetic-reconstruction"]?.total).toBe(2);
  });

  it("reports a null rate when the denominator is zero", () => {
    const metrics = computeMetrics(
      [realEntry("benign:only@1->2", "benign", false)],
      [result("benign:only@1->2", true, false, "NONE")],
    );

    expect(metrics.all.recall).toEqual({ detected: 0, of: 0, rate: null });
    expect(metrics.all.recallAtGate.rate).toBeNull();
  });

  it("throws when an entry has neither a result nor an override", () => {
    expect(() =>
      computeMetrics(
        [realEntry("malicious:missing@1->2", "malicious", false)],
        [],
      ),
    ).toThrow(EvalMetricsError);
  });
});

describe("wilsonInterval", () => {
  it("brackets 8 of 10 between 0.49 and 0.94", () => {
    const interval = wilsonInterval(8, 10);

    expect(interval).not.toBeNull();
    expect(interval?.low).toBeCloseTo(0.49, 2);
    expect(interval?.high).toBeCloseTo(0.94, 2);
  });

  it("returns null for an empty denominator and stays inside [0, 1]", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(0, 10)?.low).toBe(0);
    expect(wilsonInterval(10, 10)?.high).toBeCloseTo(1, 10);
  });
});

describe("renderReport", () => {
  const corpus: EvalCorpus = {
    schemaVersion: 1,
    createdAt: "2026-10-01T00:00:00Z",
    splitRule: "sha256(salt + id) below the fraction",
    entries: [
      realEntry("malicious:a@1->2", "malicious", false),
      realEntry("malicious:b@1->2", "malicious", true),
      realEntry("benign:c@1->2", "benign", false),
      syntheticEntry(
        "benign:d@1->2",
        "benign",
        true,
        override({ CRITICAL: 1 }),
      ),
    ],
  };
  const results: EntryResult[] = [
    result("malicious:a@1->2", true, true, "CRITICAL"),
    result("malicious:b@1->2", true, false, "LOW"),
    result("benign:c@1->2", true, false, "HIGH"),
  ];

  it("shows the held-out table, the missed list, the false positives and the limits", () => {
    const markdown = renderReport(corpus, results, {
      generatedAt: "2026-10-24T00:00:00Z",
      commit: "abc123",
    });

    expect(markdown).toContain("| Measure | All | Held-out | Development |");
    expect(markdown).toContain("malicious:b@1->2");
    expect(markdown).toContain("benign:c@1->2");
    expect(markdown).toContain("benign:d@1->2");
    expect(markdown).toContain("synthetic-reconstruction");
    expect(markdown).toContain("## Limits");
    expect(markdown).toContain("must not be used to tune detections");
    expect(markdown).toContain("denominator is zero");
  });
});
