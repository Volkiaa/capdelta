import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeChangedPackages,
  type CapabilityAnalysisRun,
} from "./capability-analysis-pipeline.js";
import {
  diffManifestCapabilities,
  type CapabilityDiffResult,
} from "./capability-differ.js";
import {
  extractNpmJavaScriptCapabilities,
  mergeJavaScriptCapabilityLayer,
} from "./npm/javascript-capability-extractor.js";
import { diffNpmLockfiles } from "./npm/lockfile-differ.js";
import { extractNpmManifestCapabilities } from "./npm/manifest-capability-extractor.js";
import {
  extractVerifiedTarball,
  type ExtractedTarball,
} from "./npm/safe-extractor.js";
import {
  renderJsonReport,
  renderJsonRunReport,
  renderTextReport,
  renderTextRunReport,
  type JsonReport,
  type JsonRunReport,
} from "./reporter.js";

const GOLDEN_ROOT = fileURLToPath(
  new URL("../../test/fixtures/golden/", import.meta.url),
);

// PLAN §4.4, §7.2
interface GoldenCase {
  name: string;
  row: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  mode: "package" | "lockfile";
  packageName: string;
  oldVersion: string;
  newVersion: string;
  oldResolvedUrl?: string;
  newResolvedUrl?: string;
}

const CASES = JSON.parse(
  await readFile(join(GOLDEN_ROOT, "cases.json"), "utf8"),
) as GoldenCase[];
const PACKAGE_CASES = CASES.filter((item) => item.mode === "package");
const LOCKFILE_CASES = CASES.filter((item) => item.mode === "lockfile");

function caseFile(goldenCase: GoldenCase, file: string): string {
  return join(GOLDEN_ROOT, goldenCase.name, file);
}

async function extract(
  goldenCase: GoldenCase,
  side: "v1" | "v2",
): Promise<ExtractedTarball> {
  const extraction = await extractVerifiedTarball({
    integrity: `sha512-inert-golden-${side}`,
    bytes: await readFile(caseFile(goldenCase, `${side}.tgz`)),
  });
  if (extraction.status !== "extracted") {
    throw new Error(
      `${goldenCase.name} ${side} rejected: ${extraction.failure.detail}`,
    );
  }
  return extraction;
}

async function analyze(
  goldenCase: GoldenCase,
  extraction: ExtractedTarball,
  version: string,
) {
  const manifest = await extractNpmManifestCapabilities(extraction, {
    ecosystem: "npm",
    name: goldenCase.packageName,
    version,
  });
  if (manifest.status !== "analyzed") {
    throw new Error(
      `${goldenCase.name} ${version} manifest unavailable: ${manifest.failure.detail}`,
    );
  }
  const javaScript = await extractNpmJavaScriptCapabilities(
    extraction,
    manifest.set,
  );
  return mergeJavaScriptCapabilityLayer(manifest.set, javaScript);
}

async function diffCase(goldenCase: GoldenCase): Promise<CapabilityDiffResult> {
  const oldExtraction = await extract(goldenCase, "v1");
  try {
    const newExtraction = await extract(goldenCase, "v2");
    try {
      return diffManifestCapabilities(
        await analyze(goldenCase, oldExtraction, goldenCase.oldVersion),
        await analyze(goldenCase, newExtraction, goldenCase.newVersion),
      );
    } finally {
      await newExtraction.cleanup();
    }
  } finally {
    await oldExtraction.cleanup();
  }
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

type Finding = JsonReport["findings"][number];

function codeFinding(report: JsonReport, kind: string): Finding {
  const finding = report.findings.find((item) => item.capability.kind === kind);
  if (finding === undefined) throw new Error(`no ${kind} finding`);
  return finding;
}

function shapeIds(report: JsonReport): string[] {
  return (report.shapes ?? []).map((shape) => shape.ruleId);
}

function signal(report: JsonReport, kind: string) {
  const finding = (report.signalFindings ?? []).find(
    (item) => item.kind === kind,
  );
  if (finding === undefined) throw new Error(`no ${kind} signal`);
  return finding;
}

const ROW_ASSERTIONS: Record<string, (report: JsonReport) => void> = {
  "install-code-network": (report) => {
    expect(shapeIds(report)).toEqual(["install-code-execution"]);
    expect(codeFinding(report, "NET")).toMatchObject({
      severity: "CRITICAL",
      capability: { location: { kind: "install-script" } },
    });
    expect(
      report.findings.some((item) => item.capability.kind === "INSTALL_HOOK"),
    ).toBe(false);
  },
  "secret-exfiltration": (report) => {
    expect(shapeIds(report)).toContain("secret-exfiltration");
    expect(codeFinding(report, "NET").severity).toBe("CRITICAL");
    expect(codeFinding(report, "ENV").severity).toBe("CRITICAL");
  },
  "obfuscated-execution": (report) => {
    const shape = (report.shapes ?? []).find(
      (item) => item.ruleId === "obfuscated-execution",
    );
    expect(shape?.signals?.map((item) => item.kind)).toContain(
      "obfuscation-pattern-added",
    );
    expect(codeFinding(report, "PROCESS").severity).toBe("CRITICAL");
  },
  "install-script-added": (report) => {
    expect(shapeIds(report)).toEqual(["install-hook-change"]);
    expect(codeFinding(report, "INSTALL_HOOK").severity).toBe("CRITICAL");
  },
  "dynamic-code": (report) => {
    expect(shapeIds(report)).toEqual(["dynamic-or-native-code"]);
    expect(codeFinding(report, "DYNAMIC_CODE").severity).toBe("CRITICAL");
  },
  "runtime-process": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(codeFinding(report, "PROCESS").severity).toBe("HIGH");
  },
  "new-external-domain": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(signal(report, "new-external-endpoint").severity).toBe("HIGH");
  },
  "runtime-env": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(codeFinding(report, "ENV").severity).toBe("MEDIUM");
  },
  "entropy-jump": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(signal(report, "entropy-jump").severity).toBe("MEDIUM");
  },
  "fs-read-unknown": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(codeFinding(report, "FS_READ").severity).toBe("LOW");
    // PLAN §7.1
    expect(codeFinding(report, "UNKNOWN").severity).toBe("LOW");
    for (const kind of ["FS_SENSITIVE", "PROCESS"]) {
      expect(report.findings.map((item) => item.capability.kind)).not.toContain(
        kind,
      );
    }
  },
  "dependency-added": (report) => {
    expect(shapeIds(report)).toEqual([]);
    expect(codeFinding(report, "DEPENDENCY").severity).toBe("LOW");
  },
};

describe("golden pairs, one per PLAN §4.4 severity row", () => {
  it("keeps one distinct case per PLAN §4.4 row", () => {
    expect(CASES).toHaveLength(12);
    expect(new Set(CASES.map((item) => item.row)).size).toBe(12);
    expect(new Set(CASES.map((item) => item.name)).size).toBe(12);
  });

  it("covers every case in the shared inventory", () => {
    expect(Object.keys(ROW_ASSERTIONS).sort()).toEqual(
      PACKAGE_CASES.map((item) => item.name).sort(),
    );
    expect(LOCKFILE_CASES.map((item) => item.name)).toEqual([
      "integrity-changed-version-same",
    ]);
  });

  it.each(CASES.map((item) => [item.name, item] as const))(
    "%s: committed archives match their reviewed sources",
    async (_name, goldenCase) => {
      for (const side of ["v1", "v2"] as const) {
        const extraction = await extract(goldenCase, side);
        try {
          const sourceRoot = caseFile(goldenCase, `source-${side}/package`);
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
      }
    },
  );

  it.each(PACKAGE_CASES.map((item) => [item.name, item.row, item] as const))(
    "%s (%s)",
    async (_name, _row, goldenCase) => {
      const diff = await diffCase(goldenCase);
      const json = renderJsonReport(diff);
      await expect(json).toMatchFileSnapshot(
        caseFile(goldenCase, "expected.json"),
      );
      await expect(renderTextReport(diff)).toMatchFileSnapshot(
        caseFile(goldenCase, "expected.txt"),
      );
      const report = JSON.parse(json) as JsonReport;
      expect(report.diagnostics).toEqual([]);
      expect(
        [...report.findings, ...(report.signalFindings ?? [])].some(
          (finding) => finding.severity === goldenCase.severity,
        ),
      ).toBe(true);
      const assertRow = ROW_ASSERTIONS[goldenCase.name];
      if (assertRow === undefined) throw new Error("missing row assertion");
      assertRow(report);
    },
  );

  it("install-script-added also renders the exact run report", async () => {
    const goldenCase = PACKAGE_CASES.find(
      (item) => item.name === "install-script-added",
    );
    if (goldenCase === undefined) throw new Error("inventory drift");
    const diff = await diffCase(goldenCase);
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: {
            name: "golden-fixture",
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
            oldIntegrity: "sha512-inert-golden-v1",
            newIntegrity: "sha512-inert-golden-v2",
            oldResolvedUrl:
              "https://registry.npmjs.org/golden-fixture/-/golden-fixture-1.0.0.tgz",
            resolvedUrl:
              "https://registry.npmjs.org/golden-fixture/-/golden-fixture-2.0.0.tgz",
          },
          diff,
          issues: [],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    await expect(renderJsonRunReport(run)).toMatchFileSnapshot(
      caseFile(goldenCase, "expected-run.json"),
    );
    await expect(renderTextRunReport(run)).toMatchFileSnapshot(
      caseFile(goldenCase, "expected-run.txt"),
    );
  });

  it.each(LOCKFILE_CASES.map((item) => [item.name, item.row, item] as const))(
    "%s (%s) through the lockfile differ and pipeline",
    async (_name, _row, goldenCase) => {
      const [oldLockfile, newLockfile, oldBytes, newBytes] = await Promise.all([
        readFile(caseFile(goldenCase, "old-lockfile.json"), "utf8"),
        readFile(caseFile(goldenCase, "new-lockfile.json"), "utf8"),
        readFile(caseFile(goldenCase, "v1.tgz")),
        readFile(caseFile(goldenCase, "v2.tgz")),
      ]);
      const responses = new Map<string | undefined, Uint8Array>([
        [goldenCase.oldResolvedUrl, oldBytes],
        [goldenCase.newResolvedUrl, newBytes],
      ]);
      const fetchImpl: typeof fetch = (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        const bytes = responses.get(url);
        if (bytes === undefined) {
          throw new Error(`unexpected golden fetch ${url}`);
        }
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.length) },
          }),
        );
      };
      const run = await analyzeChangedPackages(
        diffNpmLockfiles(JSON.parse(oldLockfile), JSON.parse(newLockfile)),
        { fetcher: { fetchImpl } },
      );
      const json = renderJsonRunReport(run);
      await expect(json).toMatchFileSnapshot(
        caseFile(goldenCase, "expected-run.json"),
      );
      await expect(renderTextRunReport(run)).toMatchFileSnapshot(
        caseFile(goldenCase, "expected-run.txt"),
      );
      const report = JSON.parse(json) as JsonRunReport;
      expect(report.lockfileFindings).toEqual([
        expect.objectContaining({
          kind: "integrity-changed-version-same",
          severity: "HIGH",
        }),
      ]);
      expect(report.summary.gateSeverity.HIGH).toBe(1);
      expect(report.packages).toEqual([
        expect.objectContaining({ status: "analyzed", issues: [] }),
      ]);
    },
  );
});
