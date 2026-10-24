import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import type { FindingSeverity } from "../src/core/capability-differ.js";
import type { JsonRunReport } from "../src/core/report-contract.js";
import { reportCorpus, runCorpus } from "./eval-corpus.js";
import type { EntryResult } from "./eval-metrics.js";
import type { Attempt } from "./m5-measure.js";

const pair: ChangedPackage = {
  name: "pkg",
  oldVersion: "1.0.0",
  newVersion: "1.0.1",
  oldIntegrity: "sha512-old",
  newIntegrity: "sha512-new",
  oldResolvedUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
  resolvedUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.1.tgz",
};

function corpus(entries: unknown[]): unknown {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-01T00:00:00Z",
    splitRule: "sha256(salt + id) below the fraction",
    entries,
  };
}

function realEntry(
  id: string,
  label: "malicious" | "benign" = "benign",
): unknown {
  return {
    id,
    label,
    source: "assumed benign: test fixture",
    provenance: "real-registry",
    heldOut: false,
    pair,
  };
}

function syntheticEntry(id: string): unknown {
  return {
    id,
    label: "malicious",
    source: "https://example.test/advisory",
    provenance: "synthetic-reconstruction",
    heldOut: true,
    resultOverride: {
      gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      incomplete: false,
    },
  };
}

function attempt(options: {
  status: "analyzed" | "unavailable";
  severity?: FindingSeverity;
  transient?: boolean;
  incomplete?: boolean;
}): Attempt {
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  if (options.severity !== undefined) bySeverity[options.severity] = 1;
  const report = {
    summary: {
      bySeverity,
      unavailablePackages: options.status === "unavailable" ? 1 : 0,
    },
    packages:
      options.status === "unavailable"
        ? [
            {
              status: "unavailable",
              failures: [{ stage: "fetch", kind: "network-error" }],
            },
          ]
        : [],
  } as unknown as JsonRunReport;
  return {
    startedAt: "2026-10-24T00:00:00Z",
    status: options.status,
    transient: options.transient ?? false,
    gateFail:
      options.status === "unavailable" || options.severity === "CRITICAL",
    strictIncomplete: options.incomplete ?? false,
    report,
  };
}

interface WrittenResults {
  results: { id: string; result: EntryResult; attempts: Attempt[] }[];
}

async function withTempDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "capdelta-eval-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("eval corpus run", () => {
  it("runs only real-registry entries and records the bounded attempt", async () => {
    await withTempDirectory(async (directory) => {
      const corpusPath = join(directory, "corpus.json");
      const resultsPath = join(directory, "results.json");
      await writeFile(
        corpusPath,
        JSON.stringify(
          corpus([
            realEntry("benign:pkg@1.0.0->1.0.1"),
            syntheticEntry("malicious:fixture@1->2"),
          ]),
        ),
        "utf8",
      );
      const analyzed: string[] = [];

      await runCorpus(corpusPath, resultsPath, (changed) => {
        analyzed.push(
          `${changed.name}@${String(changed.oldVersion)}->${changed.newVersion}`,
        );
        return Promise.resolve(
          attempt({ status: "analyzed", severity: "HIGH" }),
        );
      });

      expect(analyzed).toEqual(["pkg@1.0.0->1.0.1"]);
      const written = JSON.parse(
        await readFile(resultsPath, "utf8"),
      ) as WrittenResults;
      expect(written.results).toHaveLength(1);
      expect(written.results[0]?.id).toBe("benign:pkg@1.0.0->1.0.1");
      expect(written.results[0]?.result).toEqual({
        id: "benign:pkg@1.0.0->1.0.1",
        analyzed: true,
        gateCritical: false,
        maxSeverity: "HIGH",
        incomplete: false,
      });
      expect(written.results[0]?.attempts).toHaveLength(1);
      expect(written.results[0]?.attempts[0]?.report).toBeDefined();
    });
  });

  it("retries a transient fetch failure and keeps every attempt", async () => {
    await withTempDirectory(async (directory) => {
      const corpusPath = join(directory, "corpus.json");
      const resultsPath = join(directory, "results.json");
      await writeFile(
        corpusPath,
        JSON.stringify(corpus([realEntry("benign:pkg@1.0.0->1.0.1")])),
        "utf8",
      );
      let calls = 0;

      await runCorpus(corpusPath, resultsPath, () => {
        calls += 1;
        if (calls < 3)
          return Promise.resolve(
            attempt({ status: "unavailable", transient: true }),
          );
        return Promise.resolve(
          attempt({ status: "analyzed", severity: "LOW" }),
        );
      });

      const written = JSON.parse(
        await readFile(resultsPath, "utf8"),
      ) as WrittenResults;
      expect(calls).toBe(3);
      expect(written.results[0]?.attempts).toHaveLength(3);
      expect(written.results[0]?.result.analyzed).toBe(true);
      expect(written.results[0]?.result.maxSeverity).toBe("LOW");
    });
  });

  it("stops after a non-transient failure", async () => {
    await withTempDirectory(async (directory) => {
      const corpusPath = join(directory, "corpus.json");
      const resultsPath = join(directory, "results.json");
      await writeFile(
        corpusPath,
        JSON.stringify(corpus([realEntry("benign:pkg@1.0.0->1.0.1")])),
        "utf8",
      );
      let calls = 0;

      await runCorpus(corpusPath, resultsPath, () => {
        calls += 1;
        return Promise.resolve(
          attempt({ status: "unavailable", transient: false }),
        );
      });

      const written = JSON.parse(
        await readFile(resultsPath, "utf8"),
      ) as WrittenResults;
      expect(calls).toBe(1);
      expect(written.results[0]?.result).toEqual({
        id: "benign:pkg@1.0.0->1.0.1",
        analyzed: false,
        gateCritical: true,
        maxSeverity: "NONE",
        incomplete: false,
      });
    });
  });
});

describe("eval corpus report", () => {
  it("writes markdown from a recorded run", async () => {
    await withTempDirectory(async (directory) => {
      const corpusPath = join(directory, "corpus.json");
      const resultsPath = join(directory, "results.json");
      const out = join(directory, "report.md");
      await writeFile(
        corpusPath,
        JSON.stringify(corpus([realEntry("benign:pkg@1.0.0->1.0.1")])),
        "utf8",
      );
      await runCorpus(corpusPath, resultsPath, () =>
        Promise.resolve(attempt({ status: "analyzed", severity: "LOW" })),
      );

      await reportCorpus(corpusPath, resultsPath, out);

      const markdown = await readFile(out, "utf8");
      expect(markdown).toContain("# Labeled evaluation report");
      expect(markdown).toContain("## Limits");
      expect(markdown).toContain("| Measure | All | Held-out | Development |");
    });
  });

  it("accepts an INFO-only result", async () => {
    await withTempDirectory(async (directory) => {
      const corpusPath = join(directory, "corpus.json");
      const resultsPath = join(directory, "results.json");
      const out = join(directory, "report.md");
      await writeFile(
        corpusPath,
        JSON.stringify(corpus([realEntry("benign:pkg@1.0.0->1.0.1")])),
        "utf8",
      );
      await runCorpus(corpusPath, resultsPath, () =>
        Promise.resolve(attempt({ status: "analyzed", severity: "INFO" })),
      );

      await reportCorpus(corpusPath, resultsPath, out);

      const markdown = await readFile(out, "utf8");
      expect(markdown).toContain("0 of 1 (0.0%");
    });
  });
});
