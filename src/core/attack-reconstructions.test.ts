import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
  type CapabilityAnalysisOptions,
  type CapabilityAnalysisRun,
} from "./capability-analysis-pipeline.js";
import { diffNpmLockfiles } from "./npm/lockfile-differ.js";
import { extractVerifiedTarball } from "./npm/safe-extractor.js";
import {
  buildRunReport,
  type JsonReport,
  type JsonRunReport,
} from "./reporter.js";
import { evaluateSeverityGate } from "./run-severity.js";

/**
 * PLAN §7.4 true-positive reconstructions: defanged synthetic pairs modeled on
 * documented incidents (see test/fixtures/reconstructions/inventory.json).
 * These prove capdelta flags the modeled dependency and lifecycle deltas; they
 * are not original artifacts and not a measured detection rate. Fixture code
 * is only extracted and parsed, never imported or executed.
 */

const ROOT = fileURLToPath(
  new URL("../../test/fixtures/reconstructions/", import.meta.url),
);

interface Incident {
  name: string;
  scenarios: Record<string, { base: string[]; head: string[] }>;
}

const INVENTORY = JSON.parse(
  await readFile(join(ROOT, "inventory.json"), "utf8"),
) as { incidents: Incident[] };

interface ScenarioResult {
  run: CapabilityAnalysisRun;
  report: JsonRunReport;
}

async function runScenario(
  incidentName: string,
  scenario: "attack" | "control",
  options: CapabilityAnalysisOptions = {},
): Promise<ScenarioResult> {
  const incident = INVENTORY.incidents.find(
    (item) => item.name === incidentName,
  );
  const sides = incident?.scenarios[scenario];
  if (sides === undefined) throw new Error(`no ${incidentName}/${scenario}`);
  const read = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(join(ROOT, incidentName, file), "utf8"));
  const [base, head] = await Promise.all([
    read(`${scenario}-base-lockfile.json`),
    read(`${scenario}-head-lockfile.json`),
  ]);

  // Serve exactly the committed archives, matched by their real SRI.
  const bytesByIntegrity = new Map<string, Uint8Array>();
  for (const id of [...sides.base, ...sides.head]) {
    const bytes = await readFile(
      join(ROOT, incidentName, "packages", `${id}.tgz`),
    );
    bytesByIntegrity.set(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      bytes,
    );
  }
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const lockfile of [base, head] as {
    packages: Record<string, { resolved?: string; integrity?: string }>;
  }[]) {
    for (const entry of Object.values(lockfile.packages)) {
      if (entry.resolved === undefined || entry.integrity === undefined) {
        continue;
      }
      const bytes = bytesByIntegrity.get(entry.integrity);
      if (bytes !== undefined) bytesByUrl.set(entry.resolved, bytes);
    }
  }
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const bytes = bytesByUrl.get(url);
    if (bytes === undefined) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  };

  const run = await analyzeChangedPackages(diffNpmLockfiles(base, head), {
    ...options,
    fetcher: { fetchImpl },
  });
  return { run, report: buildRunReport(run) };
}

function packageReport(report: JsonRunReport, name: string): JsonReport {
  const item = report.packages.find(
    (candidate) =>
      candidate.status === "analyzed" && candidate.report.package.name === name,
  );
  if (item?.status !== "analyzed") throw new Error(`${name} not analyzed`);
  return item.report;
}

function findingsOf(report: JsonReport, kind: string) {
  return report.findings.filter((finding) => finding.capability.kind === kind);
}

function expectAllAnalyzed(
  result: ScenarioResult,
  count: number,
  { complete = true }: { complete?: boolean } = {},
): void {
  // A passing gate caused by analysis failure must never read as "clean".
  expect(result.report.summary).toMatchObject({
    changedPackages: count,
    analyzedPackages: count,
    unavailablePackages: 0,
    skippedLockfileEntries: 0,
  });
  // Also no diagnostics, issues, or partial budget, unless a scenario
  // deliberately exercises a parser limit.
  if (complete) expect(hasUnanalyzedContent(result.run)).toBe(false);
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(relative(root, path));
  }
  return files.sort();
}

describe("reconstruction fixtures", () => {
  it.each(
    INVENTORY.incidents.flatMap((incident) =>
      [
        ...new Set(
          Object.values(incident.scenarios).flatMap((sides) => [
            ...sides.base,
            ...sides.head,
          ]),
        ),
      ].map((id) => [incident.name, id] as const),
    ),
  )(
    "%s/%s: committed archive matches its reviewed source",
    async (name, id) => {
      const packageRoot = join(ROOT, name, "packages", id);
      const extraction = await extractVerifiedTarball({
        integrity: "sha512-inert-reconstruction",
        bytes: await readFile(`${packageRoot}.tgz`),
      });
      if (extraction.status !== "extracted") {
        throw new Error(`${id} rejected: ${extraction.failure.detail}`);
      }
      try {
        // Reconstruction fixtures keep exactly one root (the packer enforces it).
        const roots = await readdir(packageRoot);
        expect(roots).toHaveLength(1);
        const [root] = roots;
        if (root === undefined) throw new Error(`${id} has no root directory`);
        const sourceRoot = join(packageRoot, root);
        const files = await listFiles(sourceRoot);
        expect(await listFiles(extraction.root)).toEqual(files);
        for (const file of files) {
          expect(await readFile(join(extraction.root, file))).toEqual(
            await readFile(join(sourceRoot, file)),
          );
        }
      } finally {
        await extraction.cleanup();
      }
    },
  );
});

describe("axios npm compromise (2026-03-31) reconstruction", () => {
  it("fails the default gate on the laundered dependency's install hook", async () => {
    const result = await runScenario("axios-2026", "attack");
    expectAllAnalyzed(result, 2);

    const dropper = packageReport(result.report, "plain-crypto-js");
    expect(dropper.package.newPackage).toBe(true);
    expect(findingsOf(dropper, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
          evidence: [
            expect.objectContaining({
              file: "package.json",
              snippet: '"postinstall": "node setup.js"',
            }),
          ],
        }) as unknown,
      }),
    ]);
    expect(dropper.shapes?.map((shape) => shape.ruleId)).toContain(
      "install-hook-change",
    );
    // Encoded require() targets stay UNKNOWN in install code; capdelta is not
    // a string-table deobfuscator (PLAN §4.3).
    expect(findingsOf(dropper, "UNKNOWN")).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({
          location: expect.objectContaining({
            kind: "install-script",
          }) as unknown,
        }) as unknown,
      }),
    ]);

    // axios itself only gains a dependency, cross-linked to the full report.
    const axios = packageReport(result.report, "axios");
    expect(axios.summary.bySeverity.CRITICAL).toBe(0);
    expect(findingsOf(axios, "DEPENDENCY")).toEqual([
      expect.objectContaining({
        severity: "LOW",
        relatedReportIds: [dropper.reportId],
      }),
    ]);

    expect(evaluateSeverityGate(result.report, "CRITICAL")).toMatchObject({
      fail: true,
      exitCode: 1,
      highest: "CRITICAL",
    });
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("axios-2026", "control");
    expectAllAnalyzed(result, 1);
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });

  it("documents the resource-limit boundary: an over-cap dropper is only unavailable", async () => {
    // Current behavior, recorded honestly: when the new artifact exceeds an
    // extraction cap, its manifest is never read, so no install-hook CRITICAL
    // exists. The run stays loud (unavailable + strict incompleteness) but the
    // default gate passes. Only plain-crypto-js (4 files) exceeds this cap.
    const result = await runScenario("axios-2026", "attack", {
      extractor: { maxFileCount: 3 },
    });
    expect(result.report.summary).toMatchObject({
      changedPackages: 2,
      analyzedPackages: 1,
      unavailablePackages: 1,
      skippedLockfileEntries: 0,
    });
    const dropper = result.report.packages.find(
      (item) => item.status === "unavailable",
    );
    expect(dropper).toEqual({
      status: "unavailable",
      package: expect.objectContaining({
        name: "plain-crypto-js",
        newVersion: "4.2.1",
      }) as unknown,
      failures: [
        expect.objectContaining({
          stage: "new-extraction",
          side: "new",
          kind: "file-count-limit",
          severity: null,
        }),
      ],
    });
    expect(packageReport(result.report, "axios").package.newVersion).toBe(
      "1.14.1",
    );
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });
});

describe("Shai-Hulud worm (2025-09) reconstruction", () => {
  it("fails the default gate on the postinstall bundle and its shapes", async () => {
    const result = await runScenario("shai-hulud-2025", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "@ctrl/tinycolor");

    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
        }) as unknown,
      }),
    ]);
    for (const kind of ["NET", "ENV", "PROCESS"]) {
      expect(findingsOf(report, kind)).toEqual([
        expect.objectContaining({
          severity: "CRITICAL",
          capability: expect.objectContaining({
            location: expect.objectContaining({
              kind: "install-script",
            }) as unknown,
            evidence: expect.arrayContaining([
              expect.objectContaining({ file: "bundle.js" }),
            ]) as unknown,
          }) as unknown,
        }),
      ]);
    }
    expect(report.shapes?.map((shape) => shape.ruleId)).toEqual(
      expect.arrayContaining([
        "install-hook-change",
        "install-code-execution",
        "secret-exfiltration",
      ]),
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });

  it("still fails on the hook in a parser-limit simulation on the reduced bundle", async () => {
    // The real bundle was multi-megabyte; capdelta skips AST parsing above
    // its byte limit. Lowering the limit below this reduced bundle (but above
    // index.js) exercises that branch without committing a large file.
    const bundle = await readFile(
      join(ROOT, "shai-hulud-2025/packages/tinycolor-4.1.1/package/bundle.js"),
    );
    const result = await runScenario("shai-hulud-2025", "attack", {
      astExtractor: { maxSourceBytes: bundle.byteLength - 1 },
    });
    expectAllAnalyzed(result, 1, { complete: false });
    const report = packageReport(result.report, "@ctrl/tinycolor");

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("bundle.js exceeds") as unknown,
      }),
    ]);
    // No AST capabilities from the unparsed bundle are claimed...
    for (const kind of ["NET", "ENV", "PROCESS"]) {
      expect(findingsOf(report, kind)).toEqual([]);
    }
    // ...but the manifest hook still gates, and the byte scan still sees the
    // exfiltration endpoint.
    expect(findingsOf(report, "INSTALL_HOOK")[0]?.severity).toBe("CRITICAL");
    expect(report.signalFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "new-external-endpoint",
          detail: expect.stringContaining("api.github.example.test") as unknown,
        }),
      ]),
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("shai-hulud-2025", "control");
    expectAllAnalyzed(result, 1);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("Shai-Hulud 2.0 (2025-11) reconstruction", () => {
  it("fails the default gate on the preinstall loader hook", async () => {
    const result = await runScenario("shai-hulud-2-2025", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "reconstructed-sh2-victim");

    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "preinstall",
          applicability: "registry-install",
          evidence: [
            expect.objectContaining({
              file: "package.json",
              snippet: '"preinstall": "node setup_bun.js"',
            }),
          ],
        }) as unknown,
      }),
    ]);
    expect(report.shapes?.map((shape) => shape.ruleId)).toContain(
      "install-hook-change",
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("shai-hulud-2-2025", "control");
    expectAllAnalyzed(result, 1);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("synthetic layout evasion (ADR-013)", () => {
  it("analyzes a hook in an archive rooted at x/ instead of reporting it unavailable", async () => {
    // npm installs any single-root tarball (strip one component), so a root
    // other than package/ must not hide the hook from the default gate.
    const result = await runScenario("layout-evasion", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-layout-evasion",
    );
    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
        }) as unknown,
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });
});
